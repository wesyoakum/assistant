/**
 * Ray-casting point-in-polygon test.
 * polygon is an array of [x, z] pairs forming a closed polygon.
 * Returns true if (px, pz) is inside.
 */
export function pointInPolygon(
  px: number,
  pz: number,
  polygon: [number, number][]
): boolean {
  let inside = false;
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i][0], zi = polygon[i][1];
    const xj = polygon[j][0], zj = polygon[j][1];
    if ((zi > pz) !== (zj > pz) &&
        px < (xj - xi) * (pz - zi) / (zj - zi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}
