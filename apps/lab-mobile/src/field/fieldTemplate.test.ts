// Run: node --experimental-strip-types --test src/field/fieldTemplate.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { FIELD_SPECS, buildFieldLandmarks, fieldLandmarks } from "./fieldTemplate.ts";

const dist = (a: { x: number; z: number }, b: { x: number; z: number }) =>
  Math.hypot(a.x - b.x, a.z - b.z);

test("apex is the origin", () => {
  const L = fieldLandmarks("highSchool");
  assert.deepEqual(L.apex, { x: 0, z: 0 });
});

test("base paths match the spec (apex→1B, apex→3B, 1B→2B, 3B→2B)", () => {
  const spec = FIELD_SPECS.highSchool!;
  const L = buildFieldLandmarks(spec);
  assert.ok(Math.abs(dist(L.apex, L.first_base) - spec.basePath) < 1e-9);
  assert.ok(Math.abs(dist(L.apex, L.third_base) - spec.basePath) < 1e-9);
  assert.ok(Math.abs(dist(L.first_base, L.second_base) - spec.basePath) < 1e-9);
  assert.ok(Math.abs(dist(L.third_base, L.second_base) - spec.basePath) < 1e-9);
});

test("foul lines lie on the +x (1B) and +z (3B) axes", () => {
  const L = fieldLandmarks("highSchool");
  assert.equal(L.first_base.z, 0, "1B on +x axis");
  assert.equal(L.third_base.x, 0, "3B on +z axis");
  assert.equal(L.foul_pole_first.z, 0, "1B pole on +x axis");
  assert.equal(L.foul_pole_third.x, 0, "3B pole on +z axis");
});

test("rubber is on the home→2B diagonal at the pitching distance", () => {
  const spec = FIELD_SPECS.littleLeague!;
  const L = buildFieldLandmarks(spec);
  assert.ok(Math.abs(dist(L.apex, L.rubber) - spec.pitchingDistance) < 1e-9, "apex→rubber = pitching distance");
  // On the diagonal → x ≈ z.
  assert.ok(Math.abs(L.rubber.x - L.rubber.z) < 1e-9);
});

test("second base is on the diagonal at basePath·√2 from the apex", () => {
  const spec = FIELD_SPECS.highSchool!;
  const L = buildFieldLandmarks(spec);
  assert.ok(Math.abs(dist(L.apex, L.second_base) - spec.basePath * Math.SQRT2) < 1e-9);
});

test("different specs scale the field (LL smaller than HS)", () => {
  const ll = buildFieldLandmarks(FIELD_SPECS.littleLeague!);
  const hs = buildFieldLandmarks(FIELD_SPECS.highSchool!);
  assert.ok(dist(ll.apex, ll.first_base) < dist(hs.apex, hs.first_base));
});

test("plate_front is just toward the pitcher from the apex (~1.4ft on the diagonal)", () => {
  const L = fieldLandmarks();
  const d = Math.hypot(L.plate_front.x, L.plate_front.z);
  assert.ok(d > 1.3 && d < 1.5, `plate depth ${d}`);
  assert.ok(L.plate_front.x > 0 && L.plate_front.z > 0, "toward the field");
});
