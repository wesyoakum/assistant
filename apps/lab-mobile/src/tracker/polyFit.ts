// Pure math helpers for polynomial fitting.
// Extracted from outlierRejection.ts so motionModel.ts can reuse them.

/** 3×3 Gaussian elimination with partial pivoting. */
export function gaussSolve3(A: number[][], b: number[]): number[] | null {
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

/** Solve 3×3 Vandermonde: fit quadratic through 3 points exactly. */
export function solveVandermonde3(
  t1: number, t2: number, t3: number,
  v1: number, v2: number, v3: number,
): number[] | null {
  return gaussSolve3(
    [[t1 * t1, t1, 1], [t2 * t2, t2, 1], [t3 * t3, t3, 1]],
    [v1, v2, v3],
  );
}

/** Least-squares quadratic fit: y = a*t² + b*t + c. Returns [a, b, c]. */
export function lsqQuadratic(ts: number[], vs: number[]): number[] {
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

/** R² goodness-of-fit for a 2D quadratic trajectory. */
export function computeR2(
  pts: Array<{ tn: number; cx: number; cy: number }>,
  fitX: number[],
  fitY: number[],
): number {
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

/** Pick 3 distinct random indices from [0, n). */
export function sample3(n: number): [number, number, number] {
  const a = Math.floor(Math.random() * n);
  let b = a;
  while (b === a) b = Math.floor(Math.random() * n);
  let c = a;
  while (c === a || c === b) c = Math.floor(Math.random() * n);
  return [a, b, c];
}
