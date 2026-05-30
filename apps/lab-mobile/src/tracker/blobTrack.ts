// Classical "bright moving blob" ball detector (Tracker mode: Blob).
//
// A pitched baseball in these clips is a small, bright, roughly-round region
// that MOVES between consecutive frames against a darker, mostly-static
// background. That's three cheap, independent cues we can combine without any
// model:
//   • brightness — the ball is near-white,
//   • motion     — it's the thing that changed vs the previous frame,
//   • shape/size — small and roughly circular (reject big bright regions like
//                  jerseys, bases, the sky).
//
// This runs on a downscaled grayscale frame (+ the previous one) entirely in JS,
// so it's unit-tested in blobTrack.test.ts. The native side only has to hand us
// decoded pixels (we already get a JPEG per frame via frameAtTime).

export interface GrayFrame {
  /** Row-major grayscale, 0..255, length = width*height. */
  data: Uint8Array | number[];
  width: number;
  height: number;
}

export interface BlobBox {
  /** Top-left, normalized 0..1 over the frame. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BlobDetection {
  box: BlobBox | null;
  /** 0..1 score (combined brightness/motion/roundness). */
  confidence: number;
  /** Centroid in normalized coords (for debugging / smoothing), or null. */
  cx: number | null;
  cy: number | null;
}

export interface BlobOptions {
  /** Pixel must be at least this bright (0..255) to be ball-candidate. Default 170. */
  brightness?: number;
  /** AND must have brightened vs the previous frame by at least this. Default 25. */
  motionDelta?: number;
  /** Connected-component size bounds as a fraction of total pixels. */
  minAreaFrac?: number; // default 0.00002
  maxAreaFrac?: number; // default 0.02
  /** Minimum fill ratio (area / bbox area) — round-ish blobs are ~0.6+. Default 0.45. */
  minFill?: number;
}

/**
 * Detect the most ball-like bright-moving blob. `prev` may be null (first
 * frame) — then we fall back to pure brightness+shape with reduced confidence,
 * since there's no motion cue yet.
 */
export function detectBlob(
  cur: GrayFrame,
  prev: GrayFrame | null,
  opts: BlobOptions = {},
): BlobDetection {
  const W = cur.width, H = cur.height;
  const N = W * H;
  if (N === 0 || (prev && (prev.width !== W || prev.height !== H))) {
    return { box: null, confidence: 0, cx: null, cy: null };
  }
  const bright = opts.brightness ?? 170;
  const motionDelta = opts.motionDelta ?? 25;
  const minArea = Math.max(2, Math.floor((opts.minAreaFrac ?? 0.00002) * N));
  const maxArea = Math.max(minArea + 1, Math.floor((opts.maxAreaFrac ?? 0.02) * N));
  const minFill = opts.minFill ?? 0.45;

  const cd = cur.data;
  const pd = prev?.data ?? null;

  // Binary candidate mask: bright AND (no prev OR brightened vs prev).
  const mask = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const v = cd[i]!;
    if (v < bright) continue;
    if (pd) {
      if (v - pd[i]! < motionDelta) continue;
    }
    mask[i] = 1;
  }

  // Connected components (4-neighbour flood fill via an explicit stack).
  let best: { area: number; minx: number; miny: number; maxx: number; maxy: number; sx: number; sy: number; sumBright: number } | null = null;
  const stack: number[] = [];
  for (let start = 0; start < N; start++) {
    if (mask[start] !== 1) continue;
    // BFS/DFS this component.
    let area = 0, minx = W, miny = H, maxx = 0, maxy = 0, sx = 0, sy = 0, sumBright = 0;
    mask[start] = 2;
    stack.push(start);
    while (stack.length) {
      const idx = stack.pop()!;
      const x = idx % W, y = (idx - x) / W;
      area++;
      sx += x; sy += y; sumBright += cd[idx]!;
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (y < miny) miny = y; if (y > maxy) maxy = y;
      // 4-neighbours
      if (x > 0 && mask[idx - 1] === 1) { mask[idx - 1] = 2; stack.push(idx - 1); }
      if (x < W - 1 && mask[idx + 1] === 1) { mask[idx + 1] = 2; stack.push(idx + 1); }
      if (y > 0 && mask[idx - W] === 1) { mask[idx - W] = 2; stack.push(idx - W); }
      if (y < H - 1 && mask[idx + W] === 1) { mask[idx + W] = 2; stack.push(idx + W); }
    }
    if (area < minArea || area > maxArea) continue;
    const bw = maxx - minx + 1, bh = maxy - miny + 1;
    const fill = area / (bw * bh);
    if (fill < minFill) continue;
    // Aspect-ratio guard: a ball's bounding box is roughly square. Reject
    // streaks/lines (a thin bright line has fill≈1 but extreme aspect).
    const aspect = Math.max(bw, bh) / Math.min(bw, bh);
    if (aspect > 2.5) continue;
    // Prefer larger, rounder, brighter — but among valid blobs the biggest valid
    // one is usually the ball. Track the largest-area valid candidate.
    if (!best || area > best.area) {
      best = { area, minx, miny, maxx, maxy, sx, sy, sumBright };
    }
  }

  if (!best) return { box: null, confidence: 0, cx: null, cy: null };

  const bw = best.maxx - best.minx + 1, bh = best.maxy - best.miny + 1;
  const fill = best.area / (bw * bh);
  const avgBright = best.sumBright / best.area; // 0..255
  // Confidence: blend mean brightness (vs the 'bright' floor) and roundness.
  const brightScore = clamp01((avgBright - bright) / (255 - bright) + 0.4);
  const roundScore = clamp01((fill - minFill) / (1 - minFill) + 0.3);
  const motionBonus = pd ? 1 : 0.6; // first frame has no motion cue
  const confidence = clamp01(0.5 * brightScore + 0.5 * roundScore) * motionBonus;

  const cx = (best.sx / best.area) / W;
  const cy = (best.sy / best.area) / H;
  // Pad the box slightly so it visibly encloses the ball.
  const pad = 0.4;
  const nx = best.minx / W - (bw * pad) / W / 2;
  const ny = best.miny / H - (bh * pad) / H / 2;
  return {
    box: {
      x: clamp01(nx),
      y: clamp01(ny),
      width: Math.min(1, (bw * (1 + pad)) / W),
      height: Math.min(1, (bh * (1 + pad)) / H),
    },
    confidence,
    cx,
    cy,
  };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
