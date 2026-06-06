// Two-pass quadratic outlier rejection for ball detections.
//
// Pass 1 — RANSAC: sample 3 points, fit quadratic, find consensus set.
// Pass 2 — Refit: least-squares on inliers, reclassify all points.
//
// Pure math, no native deps → unit-testable.

import { gaussSolve3, solveVandermonde3, lsqQuadratic, computeR2, sample3 } from "./polyFit";

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

