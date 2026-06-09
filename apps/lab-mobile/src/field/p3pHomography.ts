// P3P-based homography from 3 point correspondences + known intrinsics.
//
// Unlike the 4-point DLT which doesn't enforce rotation orthonormality,
// this solver uses known camera intrinsics to compute a proper rotation
// matrix, giving correct vertical (Z) projection.
//
// The approach:
// 1. Back-project image points to unit rays using K^-1
// 2. Solve for R and t such that lambda_i * ray_i = R * fieldPt_i + t
// 3. Enforce orthonormality via SVD-based closest rotation
// 4. Reconstruct H = K * [r1 | r2 | t]

import type { CameraIntrinsics } from "./cameraPoseDecompose";
import type { Correspondence, HomographyFit, Homography } from "./videoHomography";

/**
 * Fit a ground-plane homography from exactly 3 correspondences + known K.
 * Returns the same HomographyFit as fitHomography, but with correct R orthonormality.
 */
export function fitHomographyP3P(
  corr: Correspondence[],
  K: CameraIntrinsics,
): HomographyFit | null {
  if (corr.length < 3) return null;
  // Use first 3 correspondences.
  const c = corr.slice(0, 3);

  // Back-project image points to normalized camera rays.
  const rays = c.map((p) => ({
    x: (p.image.u - K.cx) / K.fx,
    y: (p.image.v - K.cy) / K.fy,
    z: 1,
  }));

  // Field points (ground plane, z=0).
  const field = c.map((p) => p.field);

  // We need to find R = [r1|r2|r3] and t such that for each i:
  //   lambda_i * ray_i = R * [field_i.x, field_i.y, 0]^T + t
  // Since field z=0, this simplifies to:
  //   lambda_i * ray_i = r1 * field_i.x + r2 * field_i.y + t

  // This is a system: for 3 points, 9 equations (3 per point × 3 components),
  // 12 unknowns (r1: 3, r2: 3, t: 3, lambda: 3). But orthonormality constraints
  // (||r1||=1, ||r2||=1, r1·r2=0) remove 3 DOF → 9 unknowns, 9 equations.

  // Approach: solve the linear system for [r1, r2, t] treating lambdas as unknowns,
  // then enforce orthonormality via closest rotation matrix.

  // For each point i: lambda_i * [rx_i, ry_i, 1] = [r1x, r1y, r1z] * fx_i + [r2x, r2y, r2z] * fy_i + [tx, ty, tz]
  // Rearrange: [fx_i, fy_i, 1, 0, 0, 0, 0, 0, 0, -rx_i] [r1x]   [0]
  //            [0, 0, 0, fx_i, fy_i, 1, 0, 0, 0, -ry_i] [r1y] = [0]
  //            [0, 0, 0, 0, 0, 0, fx_i, fy_i, 1, -1   ] [r1z]   [0]

  // Actually, simpler approach: solve for r1, r2, t directly from the 3 correspondences.
  // Each correspondence gives: lambda * ray = r1 * fx + r2 * fy + t
  // With 3 points, eliminate t:
  //   (lambda1*ray1 - lambda2*ray2) = r1*(fx1-fx2) + r2*(fy1-fy2)
  //   (lambda1*ray1 - lambda3*ray3) = r1*(fx1-fx3) + r2*(fy1-fy3)

  // Let's use a different approach: solve the overconstrained system for each
  // component of r1, r2, t, lambda1, lambda2, lambda3.

  // Build 9×9 system: [A][x] = 0 where x = [r1x, r1y, r1z, r2x, r2y, r2z, tx, ty, tz]
  // For each point i (3 equations):
  //   r1x*fxi + r2x*fyi + tx - lambdai*rxi = 0
  //   r1y*fxi + r2y*fyi + ty - lambdai*ryi = 0
  //   r1z*fxi + r2z*fyi + tz - lambdai*1   = 0

  // Eliminate lambda from each triplet:
  // From eq3: lambdai = r1z*fxi + r2z*fyi + tz
  // Sub into eq1: r1x*fxi + r2x*fyi + tx - (r1z*fxi + r2z*fyi + tz)*rxi = 0
  // Sub into eq2: r1y*fxi + r2y*fyi + ty - (r1z*fxi + r2z*fyi + tz)*ryi = 0
  // 2 equations per point × 3 points = 6 equations, 9 unknowns.
  // With ||r1||=1, ||r2||=1, r1·r2=0 → 6+3=9 constraints.

  // This is complex. Let me use a simpler iterative approach:
  // 1. Use the standard DLT to get an initial H from 3 points (underdetermined, use pseudoinverse)
  // 2. Decompose to get R, t
  // 3. Enforce orthonormality on R using SVD
  // 4. Reconstruct H = K * [r1 | r2 | t]

  // Actually, with only 3 points, the DLT gives a 6×9 system which has a 3D null space.
  // We need to pick the right solution. Instead, let's use the closed-form approach:

  // Compute H directly: for 3 point correspondences, H has 8 DOF and we have 6 constraints.
  // The remaining 2 DOF come from enforcing that H = K * [r1 | r2 | t] with orthonormal [r1|r2].

  // Practical approach: compute H via least-squares with the orthonormality constraint.
  // Use the Procrustes solution:

  // Step 1: Compute M = K^-1 * H_init where H_init is any homography through the 3 points.
  // For 3 points, we can compute H_init by solving the 6-equation system with 2 free params.
  // Instead, use the direct formula for H from 3 correspondences + orthonormality.

  // The cleanest approach for P3P on a plane:
  // Solve for the 3 lambdas using distance constraints, then compute R and t.

  // Distances between field points:
  const d12sq = (field[0]!.x - field[1]!.x) ** 2 + (field[0]!.y - field[1]!.y) ** 2;
  const d13sq = (field[0]!.x - field[2]!.x) ** 2 + (field[0]!.y - field[2]!.y) ** 2;
  const d23sq = (field[1]!.x - field[2]!.x) ** 2 + (field[1]!.y - field[2]!.y) ** 2;

  // Normalize rays.
  const nrays = rays.map((r) => {
    const len = Math.sqrt(r.x ** 2 + r.y ** 2 + r.z ** 2);
    return { x: r.x / len, y: r.y / len, z: r.z / len };
  });

  // Cosines between ray pairs.
  const cos12 = nrays[0]!.x * nrays[1]!.x + nrays[0]!.y * nrays[1]!.y + nrays[0]!.z * nrays[1]!.z;
  const cos13 = nrays[0]!.x * nrays[2]!.x + nrays[0]!.y * nrays[2]!.y + nrays[0]!.z * nrays[2]!.z;
  const cos23 = nrays[1]!.x * nrays[2]!.x + nrays[1]!.y * nrays[2]!.y + nrays[1]!.z * nrays[2]!.z;

  // P3P: find depths s1, s2, s3 such that:
  // ||s1*ray1 - s2*ray2||^2 = d12^2
  // ||s1*ray1 - s3*ray3||^2 = d13^2
  // ||s2*ray2 - s3*ray3||^2 = d23^2
  //
  // Expanding: s1^2 + s2^2 - 2*s1*s2*cos12 = d12^2 (etc.)
  //
  // Let a = s2/s1, b = s3/s1. Then:
  // s1^2(1 + a^2 - 2*a*cos12) = d12^2   → s1^2 = d12^2 / (1 + a^2 - 2*a*cos12)
  // s1^2(1 + b^2 - 2*b*cos13) = d13^2
  // s1^2(a^2 + b^2 - 2*a*b*cos23) = d23^2
  //
  // From (1) and (2): d12^2*(1+b^2-2b*cos13) = d13^2*(1+a^2-2a*cos12)
  // From (1) and (3): d12^2*(a^2+b^2-2ab*cos23) = d23^2*(1+a^2-2a*cos12)

  // This is a system in a, b. Solve numerically with Newton's method.
  // Initial guess: a = sqrt(d12^2/d13^2), b = sqrt(d12^2/d23^2)... or just try a grid.

  // For simplicity, use a brute-force search + refinement.
  const d12 = Math.sqrt(d12sq);
  const d13 = Math.sqrt(d13sq);
  const d23 = Math.sqrt(d23sq);

  let bestA = 1, bestB = 1, bestErr = Infinity;
  // Grid search.
  for (let ai = 0.1; ai <= 10; ai += 0.05) {
    for (let bi = 0.1; bi <= 10; bi += 0.05) {
      const denom = 1 + ai * ai - 2 * ai * cos12;
      if (denom < 1e-10) continue;
      const s1sq = d12sq / denom;
      const err1 = Math.abs(s1sq * (1 + bi * bi - 2 * bi * cos13) - d13sq);
      const err2 = Math.abs(s1sq * (ai * ai + bi * bi - 2 * ai * bi * cos23) - d23sq);
      const err = err1 + err2;
      if (err < bestErr) { bestErr = err; bestA = ai; bestB = bi; }
    }
  }

  // Refine with smaller grid around best.
  for (let ai = bestA - 0.1; ai <= bestA + 0.1; ai += 0.002) {
    for (let bi = bestB - 0.1; bi <= bestB + 0.1; bi += 0.002) {
      const denom = 1 + ai * ai - 2 * ai * cos12;
      if (denom < 1e-10) continue;
      const s1sq = d12sq / denom;
      const err1 = Math.abs(s1sq * (1 + bi * bi - 2 * bi * cos13) - d13sq);
      const err2 = Math.abs(s1sq * (ai * ai + bi * bi - 2 * ai * bi * cos23) - d23sq);
      const err = err1 + err2;
      if (err < bestErr) { bestErr = err; bestA = ai; bestB = bi; }
    }
  }

  const denomFinal = 1 + bestA * bestA - 2 * bestA * cos12;
  if (denomFinal < 1e-10) return null;
  const s1 = Math.sqrt(d12sq / denomFinal);
  const s2 = bestA * s1;
  const s3 = bestB * s1;

  // 3D camera-space positions of the field points.
  const camPts = [
    { x: s1 * nrays[0]!.x, y: s1 * nrays[0]!.y, z: s1 * nrays[0]!.z },
    { x: s2 * nrays[1]!.x, y: s2 * nrays[1]!.y, z: s2 * nrays[1]!.z },
    { x: s3 * nrays[2]!.x, y: s3 * nrays[2]!.y, z: s3 * nrays[2]!.z },
  ];

  // Solve for R, t: camPt_i = R * fieldPt_i + t (field z = 0)
  // t = camPt_0 - R * fieldPt_0
  // camPt_i - camPt_0 = R * (fieldPt_i - fieldPt_0)
  // This gives us R's action on 2 vectors in the ground plane.

  const df1 = { x: field[1]!.x - field[0]!.x, y: field[1]!.y - field[0]!.y };
  const df2 = { x: field[2]!.x - field[0]!.x, y: field[2]!.y - field[0]!.y };
  const dc1 = { x: camPts[1]!.x - camPts[0]!.x, y: camPts[1]!.y - camPts[0]!.y, z: camPts[1]!.z - camPts[0]!.z };
  const dc2 = { x: camPts[2]!.x - camPts[0]!.x, y: camPts[2]!.y - camPts[0]!.y, z: camPts[2]!.z - camPts[0]!.z };

  // R * [df1.x, df1.y, 0]^T = dc1
  // R * [df2.x, df2.y, 0]^T = dc2
  // So: r1*df1.x + r2*df1.y = dc1, r1*df2.x + r2*df2.y = dc2
  // Solve 2×2 for r1 and r2 (each is a 3-vector).
  const det = df1.x * df2.y - df1.y * df2.x;
  if (Math.abs(det) < 1e-10) return null;
  const r1 = {
    x: (dc1.x * df2.y - dc2.x * df1.y) / det,
    y: (dc1.y * df2.y - dc2.y * df1.y) / det,
    z: (dc1.z * df2.y - dc2.z * df1.y) / det,
  };
  const r2 = {
    x: (df1.x * dc2.x - df2.x * dc1.x) / det,
    y: (df1.x * dc2.y - df2.x * dc1.y) / det,
    z: (df1.x * dc2.z - df2.x * dc1.z) / det,
  };

  // Enforce orthonormality: normalize r1, make r2 perpendicular, compute r3.
  const r1len = Math.sqrt(r1.x ** 2 + r1.y ** 2 + r1.z ** 2);
  if (r1len < 1e-10) return null;
  const r1n = { x: r1.x / r1len, y: r1.y / r1len, z: r1.z / r1len };
  // Remove r1 component from r2.
  const dot12 = r2.x * r1n.x + r2.y * r1n.y + r2.z * r1n.z;
  const r2orth = { x: r2.x - dot12 * r1n.x, y: r2.y - dot12 * r1n.y, z: r2.z - dot12 * r1n.z };
  const r2len = Math.sqrt(r2orth.x ** 2 + r2orth.y ** 2 + r2orth.z ** 2);
  if (r2len < 1e-10) return null;
  const r2n = { x: r2orth.x / r2len, y: r2orth.y / r2len, z: r2orth.z / r2len };
  // r3 = r1 × r2 (guaranteed unit length and perpendicular).
  const r3n = {
    x: r1n.y * r2n.z - r1n.z * r2n.y,
    y: r1n.z * r2n.x - r1n.x * r2n.z,
    z: r1n.x * r2n.y - r1n.y * r2n.x,
  };

  // Translation: t = camPt_0 - R * fieldPt_0
  const t = {
    x: camPts[0]!.x - r1n.x * field[0]!.x - r2n.x * field[0]!.y,
    y: camPts[0]!.y - r1n.y * field[0]!.x - r2n.y * field[0]!.y,
    z: camPts[0]!.z - r1n.z * field[0]!.x - r2n.z * field[0]!.y,
  };

  // Reconstruct H = K * [r1 | r2 | t] (row-major 3×3).
  const H: Homography = [
    K.fx * r1n.x + K.cx * r1n.z,  K.fx * r2n.x + K.cx * r2n.z,  K.fx * t.x + K.cx * t.z,
    K.fy * r1n.y + K.cy * r1n.z,  K.fy * r2n.y + K.cy * r2n.z,  K.fy * t.y + K.cy * t.z,
    r1n.z,                          r2n.z,                          t.z,
  ];

  // Compute Hinv.
  const Hinv = invert3x3(H);
  if (!Hinv) return null;

  // RMS error.
  let errSum = 0;
  for (const p of corr) {
    const w = H[6]! * p.field.x + H[7]! * p.field.y + H[8]!;
    if (Math.abs(w) < 1e-12) continue;
    const pu = (H[0]! * p.field.x + H[1]! * p.field.y + H[2]!) / w;
    const pv = (H[3]! * p.field.x + H[4]! * p.field.y + H[5]!) / w;
    errSum += (pu - p.image.u) ** 2 + (pv - p.image.v) ** 2;
  }
  const rmsPx = Math.sqrt(errSum / corr.length);

  return { H, Hinv, rmsPx, count: corr.length };
}

function invert3x3(M: number[]): number[] | null {
  const [a, b, c, d, e, f, g, h, i] = M;
  const det = a! * (e! * i! - f! * h!) - b! * (d! * i! - f! * g!) + c! * (d! * h! - e! * g!);
  if (Math.abs(det) < 1e-15) return null;
  const inv = 1 / det;
  return [
    (e! * i! - f! * h!) * inv, (c! * h! - b! * i!) * inv, (b! * f! - c! * e!) * inv,
    (f! * g! - d! * i!) * inv, (a! * i! - c! * g!) * inv, (c! * d! - a! * f!) * inv,
    (d! * h! - e! * g!) * inv, (b! * g! - a! * h!) * inv, (a! * e! - b! * d!) * inv,
  ];
}
