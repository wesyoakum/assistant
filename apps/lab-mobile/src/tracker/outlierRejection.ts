// Two-pass quadratic outlier rejection for ball detections.
//
// Pass 1 — RANSAC: sample 3 points, fit quadratic, find consensus set.
// Pass 2 — Refit: least-squares on inliers, reclassify all points.
//
// Pure math, no native deps → unit-testable.

export interface TrackedFrameLike {
  frameIndex: number;
  timeSec: number;
  box: { x: number; y: number; width: number; height: number } | null;
  lost: boolean;
}

export interface OutlierResult {
  frameIndex: number;
  inlier: boolean;
  residual: number | null;
}

export interface OutlierRejectionOptions {
  inlierThreshold?: number;  // default 0.03 (normalized coords)
  maxIterations?: number;    // default 100
  minInliers?: number;       // default max(5, 30% of detections)
}

export interface OutlierRejectionResult {
  labels: OutlierResult[];
  fitX: [number, number, number] | null;
  fitY: [number, number, number] | null;
  r2: number;
  inlierCount: number;
  outlierCount: number;
  applied: boolean;
}

interface DetectedPoint {
  idx: number; // index into original frames
  t: number;   // original time
  tn: number;  // normalized time (t - tMin)
  cx: number;
  cy: number;
}

export function rejectOutliers(
  frames: TrackedFrameLike[],
  options?: OutlierRejectionOptions,
): OutlierRejectionResult {
  const threshold = options?.inlierThreshold ?? 0.03;
  const maxIter = options?.maxIterations ?? 100;

  // Extract detected points.
  const detected: DetectedPoint[] = [];
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]!;
    if (!f.box || f.lost) continue;
    detected.push({
      idx: i,
      t: f.timeSec,
      tn: 0, // set after tMin is known
      cx: f.box.x + f.box.width / 2,
      cy: f.box.y + f.box.height / 2,
    });
  }

  const noopLabels = (): OutlierResult[] =>
    frames.map((f, i) => ({ frameIndex: i, inlier: !!(f.box && !f.lost), residual: null }));

  if (detected.length < 3) {
    return { labels: noopLabels(), fitX: null, fitY: null, r2: 0, inlierCount: detected.length, outlierCount: 0, applied: false };
  }

  const minInliers = options?.minInliers ?? Math.max(5, Math.floor(detected.length * 0.3));

  // Normalize time.
  const tMin = detected.reduce((m, p) => Math.min(m, p.t), Infinity);
  const tRange = detected.reduce((m, p) => Math.max(m, p.t), -Infinity) - tMin || 1;
  for (const p of detected) p.tn = p.t - tMin;
  const pts = detected;

  // ── Pass 1: RANSAC ──
  let bestInlierIdx: number[] = [];
  let bestCount = 0;

  for (let iter = 0; iter < maxIter; iter++) {
    // Sample 3 distinct indices.
    const s = sample3(pts.length);
    const p0 = pts[s[0]]!, p1 = pts[s[1]]!, p2 = pts[s[2]]!;

    // Temporal spread check.
    const ts = [p0.tn, p1.tn, p2.tn];
    if (Math.max(...ts) - Math.min(...ts) < 0.1 * tRange) continue;

    // Fit quadratic through 3 points.
    const fX = solveVandermonde3(p0.tn, p1.tn, p2.tn, p0.cx, p1.cx, p2.cx);
    const fY = solveVandermonde3(p0.tn, p1.tn, p2.tn, p0.cy, p1.cy, p2.cy);
    if (!fX || !fY) continue;

    // Count inliers.
    const inliers: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]!;
      const px = fX[0] * p.tn * p.tn + fX[1] * p.tn + fX[2];
      const py = fY[0] * p.tn * p.tn + fY[1] * p.tn + fY[2];
      if (Math.hypot(p.cx - px, p.cy - py) < threshold) inliers.push(i);
    }
    if (inliers.length > bestCount) {
      bestCount = inliers.length;
      bestInlierIdx = inliers;
    }
  }

  if (bestCount < minInliers) {
    return { labels: noopLabels(), fitX: null, fitY: null, r2: 0, inlierCount: detected.length, outlierCount: 0, applied: false };
  }

  // ── Pass 2: Refit on inliers ──
  const inlierPts = bestInlierIdx.map((i) => pts[i]!);
  const fitX = lsqQuadratic(inlierPts.map((p) => p.tn), inlierPts.map((p) => p.cx));
  const fitY = lsqQuadratic(inlierPts.map((p) => p.tn), inlierPts.map((p) => p.cy));

  // Reclassify all detected points against the refined fit.
  const inlierSet = new Set<number>(); // indices into original frames
  const residuals = new Map<number, number>();
  for (const p of pts) {
    const px = fitX[0] * p.tn * p.tn + fitX[1] * p.tn + fitX[2];
    const py = fitY[0] * p.tn * p.tn + fitY[1] * p.tn + fitY[2];
    const r = Math.hypot(p.cx - px, p.cy - py);
    residuals.set(p.idx, r);
    if (r < threshold) inlierSet.add(p.idx);
  }

  // Compute R².
  const r2 = computeR2(pts.filter((p) => inlierSet.has(p.idx)), fitX, fitY);

  // Build labels.
  const labels: OutlierResult[] = frames.map((f, i) => {
    if (!f.box || f.lost) return { frameIndex: i, inlier: false, residual: null };
    const r = residuals.get(i) ?? null;
    return { frameIndex: i, inlier: inlierSet.has(i), residual: r };
  });

  const inlierCount = inlierSet.size;
  const outlierCount = detected.length - inlierCount;

  return {
    labels,
    fitX: fitX as [number, number, number],
    fitY: fitY as [number, number, number],
    r2,
    inlierCount,
    outlierCount,
    applied: true,
  };
}

// ── Math helpers ──

function sample3(n: number): [number, number, number] {
  const a = Math.floor(Math.random() * n);
  let b = a;
  while (b === a) b = Math.floor(Math.random() * n);
  let c = a;
  while (c === a || c === b) c = Math.floor(Math.random() * n);
  return [a, b, c];
}

/** Solve 3x3 Vandermonde: [t²,t,1] * [a,b,c]ᵀ = [v1,v2,v3] */
function solveVandermonde3(
  t1: number, t2: number, t3: number,
  v1: number, v2: number, v3: number,
): number[] | null {
  const A = [
    [t1 * t1, t1, 1],
    [t2 * t2, t2, 1],
    [t3 * t3, t3, 1],
  ];
  return gaussSolve3(A, [v1, v2, v3]);
}

function gaussSolve3(A: number[][], b: number[]): number[] | null {
  const a = A.map((r) => [...r]);
  const B = [...b];
  for (let i = 0; i < 3; i++) {
    let mx = i;
    for (let j = i + 1; j < 3; j++) if (Math.abs(a[j]![i]!) > Math.abs(a[mx]![i]!)) mx = j;
    [a[i], a[mx]] = [a[mx]!, a[i]!];
    [B[i], B[mx]] = [B[mx]!, B[i]!];
    if (Math.abs(a[i]![i]!) < 1e-12) return null;
    for (let j = i + 1; j < 3; j++) {
      const f = a[j]![i]! / a[i]![i]!;
      for (let k = i; k < 3; k++) a[j]![k]! -= f * a[i]![k]!;
      B[j]! -= f * B[i]!;
    }
  }
  const x = [0, 0, 0];
  for (let i = 2; i >= 0; i--) {
    let s = B[i]!;
    for (let j = i + 1; j < 3; j++) s -= a[i]![j]! * x[j]!;
    x[i] = s / a[i]![i]!;
  }
  return x;
}

function lsqQuadratic(ts: number[], vs: number[]): number[] {
  const n = ts.length;
  let sx = 0, sx2 = 0, sx3 = 0, sx4 = 0, sy = 0, sxy = 0, sx2y = 0;
  for (let i = 0; i < n; i++) {
    const x = ts[i]!, y = vs[i]!;
    sx += x; sx2 += x * x; sx3 += x * x * x; sx4 += x * x * x * x;
    sy += y; sxy += x * y; sx2y += x * x * y;
  }
  return gaussSolve3(
    [[sx4, sx3, sx2], [sx3, sx2, sx], [sx2, sx, n]],
    [sx2y, sxy, sy],
  ) || [0, 0, 0];
}

function computeR2(pts: DetectedPoint[], fitX: number[], fitY: number[]): number {
  if (pts.length < 2) return 0;
  const meanX = pts.reduce((s, p) => s + p.cx, 0) / pts.length;
  const meanY = pts.reduce((s, p) => s + p.cy, 0) / pts.length;
  let ssRes = 0, ssTot = 0;
  for (const p of pts) {
    const px = fitX[0]! * p.tn * p.tn + fitX[1]! * p.tn + fitX[2]!;
    const py = fitY[0]! * p.tn * p.tn + fitY[1]! * p.tn + fitY[2]!;
    ssRes += (p.cx - px) ** 2 + (p.cy - py) ** 2;
    ssTot += (p.cx - meanX) ** 2 + (p.cy - meanY) ** 2;
  }
  return ssTot > 0 ? 1 - ssRes / ssTot : 0;
}
