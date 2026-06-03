// User coordinate utilities.
//
// Everything is now in user coordinates natively:
//   X→1B (parallel to front edge), Y→2B (along diagonal), Z→up.
//   Units: meters.

/** Format a 3D point for display. */
export function formatXYZ(pt: { x: number; y: number; z: number }): string {
  return `X=${pt.x.toFixed(2)}m  Y=${pt.y.toFixed(2)}m  Z=${pt.z.toFixed(2)}m`;
}
