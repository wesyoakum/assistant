// Batter's box calibration overlay — progressive anchoring with coupled motion.
//
// All non-anchored handles move together based on the current constraint level:
//   0 anchors + drag: translate all
//   1 anchor  + drag: similarity (rotate + scale) around the anchor
//   2 anchors + drag: affine transform (3D-like rotation about anchor axis)
//   3 anchors + drag: full homography (perspective)
//   4+ anchors: homography auto-solves
//
// Drag any handle → anchors on release (green). Tap anchored → unanchor.
// Active handle highlights yellow. Delta-based dragging.

import React, { useCallback, useMemo, useRef, useState, useImperativeHandle, forwardRef } from "react";
import { View, StyleSheet, PanResponder } from "react-native";
import Svg, { Polygon, Line, Circle, Text as SvgText } from "react-native-svg";
import { allEightCorners, outerCorners, type CameraPose } from "../field/batterBox";
import { fitHomography, fieldToImage, type Correspondence, type HomographyFit } from "../field/videoHomography";
import { homePlateCorners } from "../field/homePlateGeometry";
import { fieldLandmarks, type GroundPoint } from "../field/fieldTemplate";

export interface BatterBoxOverlayProps {
  imageWidth: number;
  imageHeight: number;
  vp: { scale: number; tx: number; ty: number };
  canvas: { width: number; height: number };
  canvasPageOffset: { x: number; y: number };
}

export interface BatterBoxOverlayHandle {
  solve: () => CameraPose | null;
  reset: () => void;
  anchoredCount: () => number;
  getState: () => { positions: Record<string, { nx: number; ny: number }>; anchored: Record<string, boolean> };
  setState: (s: { positions: Record<string, { nx: number; ny: number }>; anchored: Record<string, boolean> }) => void;
}

const BOX_COLOR = "rgba(0,200,255,0.9)";
const BOX_FILL = "rgba(0,200,255,0.06)";
const PLATE_COLOR = "rgba(255,120,180,0.9)";
const BASEPATH_COLOR = "rgba(255,120,180,0.7)";
const BASE_COLOR = "rgba(255,220,0,0.95)";
const BASE_FILL = "rgba(255,220,0,0.35)";
const ANCHORED_COLOR = "rgba(0,255,100,0.95)";
const ANCHORED_FILL = "rgba(0,255,100,0.25)";
const ACTIVE_COLOR = "rgba(255,220,0,0.95)";
const ACTIVE_FILL = "rgba(255,220,0,0.35)";
const FREE_COLOR = "rgba(255,255,255,0.6)";
const LINE_COLOR = "rgba(0,200,255,0.5)";
const HANDLE_R = 8;

interface Landmark { id: string; label: string; field: GroundPoint; }

function buildLandmarks(): Landmark[] {
  const oc = outerCorners();
  const boxes = allEightCorners();
  const lm = fieldLandmarks(60);
  return [
    { id: "apex", label: "Apex", field: { x: 0, z: 0 } },
    { id: "lfo", label: "LF-Out", field: oc.leftFrontOut },
    { id: "rfo", label: "RF-Out", field: oc.rightFrontOut },
    { id: "rbo", label: "RB-Out", field: oc.rightBackOut },
    { id: "lbo", label: "LB-Out", field: oc.leftBackOut },
    { id: "lfi", label: "LF-In", field: boxes.left[0] },
    { id: "lbi", label: "LB-In", field: boxes.left[3] },
    { id: "rfi", label: "RF-In", field: boxes.right[0] },
    { id: "rbi", label: "RB-In", field: boxes.right[3] },
    { id: "1b", label: "1B", field: lm.first_base },
    { id: "2b", label: "2B", field: lm.second_base },
    { id: "3b", label: "3B", field: lm.third_base },
  ];
}
const LANDMARKS = buildLandmarks();
const FIELD_BY_ID: Record<string, GroundPoint> = {};
for (const lm of LANDMARKS) FIELD_BY_ID[lm.id] = lm.field;

// Box edge connections for drawing lines.
const BOX_EDGES: [string, string][] = [
  ["lfo","rfo"],["rfo","rbo"],["rbo","lbo"],["lbo","lfo"], // outer
  ["lfi","rfi"],["rfi","rbi"],["rbi","lbi"],["lbi","lfi"], // inner
  ["lfo","lfi"],["rfo","rfi"],["lbo","lbi"],["rbo","rbi"], // cross
];
// Basepath square: apex → 1B → 2B → 3B → apex
const BASEPATH_EDGES: [string, string][] = [
  ["apex","1b"],["1b","2b"],["2b","3b"],["3b","apex"],
];

// Geometry for rendering polygons once homography is available.
const geo = (() => {
  const boxes = allEightCorners();
  const plate = homePlateCorners();
  const lm = fieldLandmarks(60);
  const BH = (15 / 12) / 2 * 0.3048; // half base size in meters
  const bases = (["first_base", "second_base", "third_base"] as const).map((id) => {
    const c = lm[id];
    return [{ x: c.x + BH, y: c.y }, { x: c.x, y: c.y + BH }, { x: c.x - BH, y: c.y }, { x: c.x, y: c.y - BH }];
  });
  return { leftBox: boxes.left, rightBox: boxes.right, plate, bases };
})();

/** Compute default handle positions by projecting from a virtual camera at (4,-4,2)m. */
function defaultPositions(): Record<string, { nx: number; ny: number }> {
  // Virtual camera in user coords (meters): on 1B side, behind plate, elevated.
  const cam = { x: 2, y: -10, z: 3 };
  const focus = { x: 0, y: 8, z: 0 };
  const hFov = 69;
  // Simplified projection: build view matrix and project each landmark.
  const fwd = [focus.x - cam.x, focus.y - cam.y, focus.z - cam.z];
  const fLen = Math.hypot(fwd[0]!, fwd[1]!, fwd[2]!);
  fwd[0]! /= fLen; fwd[1]! /= fLen; fwd[2]! /= fLen;
  const up = [0, 0, 1];
  const right = [fwd[1]!*up[2]!-fwd[2]!*up[1]!, fwd[2]!*up[0]!-fwd[0]!*up[2]!, fwd[0]!*up[1]!-fwd[1]!*up[0]!];
  const rLen = Math.hypot(right[0]!, right[1]!, right[2]!);
  right[0]! /= rLen; right[1]! /= rLen; right[2]! /= rLen;
  const camUp = [right[1]!*fwd[2]!-right[2]!*fwd[1]!, right[2]!*fwd[0]!-right[0]!*fwd[2]!, right[0]!*fwd[1]!-right[1]!*fwd[0]!];
  const fx = (1 / 2) / Math.tan((hFov * Math.PI / 180) / 2); // normalized focal length

  function projectPt(pt: GroundPoint): { nx: number; ny: number } {
    const dx = pt.x - cam.x, dy = pt.y - cam.y, dz = 0 - cam.z;
    const cx = right[0]! * dx + right[1]! * dy + right[2]! * dz;
    const cy = camUp[0]! * dx + camUp[1]! * dy + camUp[2]! * dz;
    const cz = -(fwd[0]! * dx + fwd[1]! * dy + fwd[2]! * dz); // -fwd = camera Z
    if (cz < 0.01) return { nx: 0.5, ny: 0.5 }; // behind camera
    return { nx: 0.5 + fx * (cx / cz), ny: 0.5 - fx * (cy / cz) };
  }

  const result: Record<string, { nx: number; ny: number }> = {};
  for (const lm of LANDMARKS) {
    result[lm.id] = projectPt(lm.field);
  }
  return result;
}

function screenDist(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// ── Transform solvers ──────────────────────────────────────────────────

/** Compute positions of all landmarks given N correspondences.
 *  Returns normalized image positions for every landmark. */
function projectAll(
  correspondences: { id: string; nx: number; ny: number }[],
  imageWidth: number,
  imageHeight: number,
): Record<string, { nx: number; ny: number }> | null {
  const n = correspondences.length;
  if (n === 0) return null;

  if (n === 1) {
    // Translation only: offset all field positions.
    // Use a default scale derived from the initial default positions.
    return null; // handled by translate mode in the drag handler
  }

  if (n >= 4) {
    // Full homography.
    const corr: Correspondence[] = correspondences.map((c) => ({
      field: FIELD_BY_ID[c.id]!,
      image: { u: c.nx * imageWidth, v: c.ny * imageHeight },
    }));
    const fit = fitHomography(corr);
    if (!fit) return null;

    // Validate: 2B should project with finite coords and the field shouldn't flip.
    // Check that the apex and 2B project to different locations.
    const apexImg = fieldToImage(fit.H, { x: 0, z: 0 });
    const secImg = fieldToImage(fit.H, FIELD_BY_ID["2b"]!);
    if (!apexImg || !secImg) return null;
    // If they're nearly the same, the homography is degenerate.
    if (Math.hypot(apexImg.x - secImg.x, apexImg.y - secImg.y) < 1) return null;

    const result: Record<string, { nx: number; ny: number }> = {};
    for (const lm of LANDMARKS) {
      const img = fieldToImage(fit.H, lm.field);
      if (img) result[lm.id] = { nx: img.x / imageWidth, ny: img.y / imageHeight };
    }
    return result;
  }

  if (n === 2 || n === 3) {
    // Similarity (n=2) or affine (n=3).
    // Build linear system: for each correspondence (field_x, field_z) → (u, v)
    // Similarity: u = a*x - b*z + tx, v = b*x + a*z + ty  (4 unknowns)
    // Affine:     u = a*x + b*z + tx, v = c*x + d*z + ty  (6 unknowns)

    if (n === 2) {
      // Solve a full 2×2 + translation affine from 2 point pairs (4 equations, 4 unknowns).
      // [nx] = [a  b] [field_x] + [tx]
      // [ny]   [c  d] [field_y]   [ty]
      // With 2 points we have 4 equations and 4 unknowns (a,b,tx for nx; c,d,ty for ny)
      // but that's 6 unknowns. So use a similarity: a=d, b=-c (4 unknowns, 4 equations).
      // BUT allow reflection by solving a general 2×2 per axis pair.
      //
      // Actually simplest: solve each output dimension independently as linear in (field_x, field_y).
      // nx = a1 * field_x + b1 * field_y + tx1  — 3 unknowns but only 2 equations.
      // Underdetermined. So use the direct mapping:
      //
      // Express each landmark as: field_pt = f0 + alpha * (f1 - f0) + beta * perp(f1 - f0)
      // Map to: image_pt = c0 + alpha * (c1 - c0) + beta * perp_image(c1 - c0)
      //
      // The key question: which direction is perp_image?
      // We don't know from 2 points alone. But we know the camera looks DOWN at the field,
      // so the image is a top-down-ish view. The handedness depends on camera orientation.
      // Use a heuristic: check if the default positions are closer to CW or CCW perpendicular.

      const [c0, c1] = correspondences;
      const f0 = FIELD_BY_ID[c0!.id]!, f1 = FIELD_BY_ID[c1!.id]!;

      const fdx = f1.x - f0.x, fdy = f1.y - f0.y;
      const fLen2 = fdx * fdx + fdy * fdy;
      if (fLen2 < 1e-6) return null;

      // Field perpendicular (CCW)
      const fpx = -fdy, fpy = fdx;

      const idu = c1!.nx - c0!.nx, idv = c1!.ny - c0!.ny;

      // Try both CW and CCW image perpendicular, pick the one that keeps
      // a known third point (apex or 2B) closer to its default position.
      const testId = c0!.id === "apex" || c1!.id === "apex" ? "2b" : "apex";
      const testField = FIELD_BY_ID[testId]!;
      const testDefault = defaultPositions()[testId]!;
      const tfx = testField.x - f0.x, tfy = testField.y - f0.y;
      const tAlong = (tfx * fdx + tfy * fdy) / fLen2;
      const tPerp = (tfx * fpx + tfy * fpy) / fLen2;

      // CW: ipu = idv, ipv = -idu.  CCW: ipu = -idv, ipv = idu.
      const cwNx = c0!.nx + tAlong * idu + tPerp * idv;
      const cwNy = c0!.ny + tAlong * idv + tPerp * (-idu);
      const ccwNx = c0!.nx + tAlong * idu + tPerp * (-idv);
      const ccwNy = c0!.ny + tAlong * idv + tPerp * idu;

      const cwDist = Math.hypot(cwNx - testDefault.nx, cwNy - testDefault.ny);
      const ccwDist = Math.hypot(ccwNx - testDefault.nx, ccwNy - testDefault.ny);
      const useCW = cwDist < ccwDist;
      const ipu = useCW ? idv : -idv;
      const ipv = useCW ? -idu : idu;

      const result: Record<string, { nx: number; ny: number }> = {};
      for (const lm of LANDMARKS) {
        const fx = lm.field.x - f0.x, fy = lm.field.y - f0.y;
        const along = (fx * fdx + fy * fdy) / fLen2;
        const perp = (fx * fpx + fy * fpy) / fLen2;
        result[lm.id] = {
          nx: c0!.nx + along * idu + perp * ipu,
          ny: c0!.ny + along * idv + perp * ipv,
        };
      }
      return result;
    }

    // n === 3: Affine transform.
    // u = a*x + b*z + tx
    // v = c*x + d*z + ty
    // 6 unknowns, 6 equations.
    const pts = correspondences.map((c) => ({ f: FIELD_BY_ID[c.id]!, u: c.nx, v: c.ny }));
    // Solve two 3x3 systems.
    const A = [
      [pts[0]!.f.x, pts[0]!.f.y, 1],
      [pts[1]!.f.x, pts[1]!.f.y, 1],
      [pts[2]!.f.x, pts[2]!.f.y, 1],
    ];
    const bu = [pts[0]!.u, pts[1]!.u, pts[2]!.u];
    const bv = [pts[0]!.v, pts[1]!.v, pts[2]!.v];
    const solU = solve3x3(A, bu);
    const solV = solve3x3(A, bv);
    if (!solU || !solV) return null;

    // Removed affine determinant check — it was rejecting valid
    // configurations from certain camera angles (e.g., 1B side).

    const result: Record<string, { nx: number; ny: number }> = {};
    for (const lm of LANDMARKS) {
      const fx = lm.field.x, fy = lm.field.y;
      result[lm.id] = {
        nx: solU[0] * fx + solU[1] * fy + solU[2],
        ny: solV[0] * fx + solV[1] * fy + solV[2],
      };
    }
    return result;
  }

  return null;
}

function solve3x3(A: number[][], b: number[]): number[] | null {
  const [[a,bb,c],[d,e,f],[g,h,ii]] = A as [[number,number,number],[number,number,number],[number,number,number]];
  const det = a*(e*ii - f*h) - bb*(d*ii - f*g) + c*(d*h - e*g);
  if (Math.abs(det) < 1e-12) return null;
  const id = 1/det;
  return [
    ((e*ii-f*h)*b[0]! - (bb*ii-c*h)*b[1]! + (bb*f-c*e)*b[2]!) * id,
    (-(d*ii-f*g)*b[0]! + (a*ii-c*g)*b[1]! - (a*f-c*d)*b[2]!) * id,
    ((d*h-e*g)*b[0]! - (a*h-bb*g)*b[1]! + (a*e-bb*d)*b[2]!) * id,
  ];
}

// ── Component ──────────────────────────────────────────────────────────

export const BatterBoxOverlay = forwardRef<BatterBoxOverlayHandle, BatterBoxOverlayProps>(
  function BatterBoxOverlay({ imageWidth, imageHeight, vp, canvas, canvasPageOffset }, ref) {
    const [positions, setPositions] = useState<Record<string, { nx: number; ny: number }>>(defaultPositions);
    const [anchored, setAnchored] = useState<Record<string, boolean>>({});
    const [activeId, setActiveId] = useState<string | null>(null);

    const posRef = useRef(positions);
    posRef.current = positions;
    const anchoredRef = useRef(anchored);
    anchoredRef.current = anchored;

    const imageToScreen = useCallback((nx: number, ny: number) => {
      const cx = canvas.width / 2, cy = canvas.height / 2;
      return { x: (nx * canvas.width - cx) * vp.scale + cx + vp.tx, y: (ny * canvas.height - cy) * vp.scale + cy + vp.ty };
    }, [canvas, vp]);

    const screenToImage = useCallback((sx: number, sy: number) => {
      const cx = canvas.width / 2, cy = canvas.height / 2;
      const ix = (sx - cx - vp.tx) / vp.scale + cx, iy = (sy - cy - vp.ty) / vp.scale + cy;
      return { nx: Math.max(0, Math.min(1, ix / canvas.width)), ny: Math.max(0, Math.min(1, iy / canvas.height)) };
    }, [canvas, vp]);

    const anchoredIds = useMemo(() => LANDMARKS.filter((lm) => anchored[lm.id]).map((lm) => lm.id), [anchored]);
    const anchorCount = anchoredIds.length;

    // Homography from anchored points.
    const homography = useMemo((): HomographyFit | null => {
      if (anchorCount < 4) return null;
      const corr: Correspondence[] = anchoredIds.map((id) => ({
        field: FIELD_BY_ID[id]!,
        image: { u: positions[id]!.nx * imageWidth, v: positions[id]!.ny * imageHeight },
      }));
      return fitHomography(corr);
    }, [anchored, positions, anchorCount, anchoredIds, imageWidth, imageHeight]);

    // Screen positions for all handles.
    const screenHandles = useMemo(() => {
      const result: Record<string, { x: number; y: number }> = {};
      for (const lm of LANDMARKS) {
        const pos = positions[lm.id] ?? { nx: 0.5, ny: 0.5 };
        result[lm.id] = imageToScreen(pos.nx, pos.ny);
      }
      return result;
    }, [positions, imageToScreen]);

    const screenHandlesRef = useRef(screenHandles);
    screenHandlesRef.current = screenHandles;

    // Projected geometry (when homography is solved).
    const projGeo = useMemo(() => {
      if (!homography) return null;
      const proj = (pt: GroundPoint) => {
        const img = fieldToImage(homography.H, pt);
        if (!img) return null;
        return imageToScreen(img.x / imageWidth, img.y / imageHeight);
      };
      const lb = geo.leftBox.map(proj), rb = geo.rightBox.map(proj);
      const pl = geo.plate.map(proj), bs = geo.bases.map((b) => b.map(proj));
      // Basepath square: apex → 1B → 2B → 3B → apex
      const lm = fieldLandmarks(60);
      const bpPts = [{ x: 0, y: 0 }, lm.first_base, lm.second_base, lm.third_base].map(proj);
      if ([...lb, ...rb, ...pl, ...bs.flat(), ...bpPts].some((p) => !p)) return null;
      return { lb: lb as {x:number;y:number}[], rb: rb as {x:number;y:number}[], pl: pl as {x:number;y:number}[], bs: bs as {x:number;y:number}[][], bp: bpPts as {x:number;y:number}[] };
    }, [homography, imageWidth, imageHeight, imageToScreen]);

    const poly = (pts: {x:number;y:number}[]) => pts.map((p) => `${p.x},${p.y}`).join(" ");

    // ── Touch ──────────────────────────────────────────────────────────
    type Drag = { id: string; offset: { dnx: number; dny: number } };
    const dragRef = useRef<Drag | null>(null);
    const didMoveRef = useRef(false);

    /** Recompute all free handle positions given the current anchored set + the dragged point.
     *  Apex is always implicitly anchored at its current position. */
    function recomputeFreePositions(draggedId: string, draggedPos: { nx: number; ny: number }) {
      const corr: { id: string; nx: number; ny: number }[] = [];

      // Always include apex as an implicit anchor (unless it's the one being dragged).
      if (draggedId !== "apex" && !anchoredRef.current["apex"]) {
        const apexPos = posRef.current["apex"];
        if (apexPos) corr.push({ id: "apex", ...apexPos });
      }

      // Add all explicitly anchored (except the dragged one).
      for (const id of anchoredIds) {
        if (id === draggedId || id === "apex") continue; // apex already added above
        const pos = posRef.current[id];
        if (pos) corr.push({ id, ...pos });
      }
      // Add anchored apex if it was explicitly anchored.
      if (anchoredRef.current["apex"] && draggedId !== "apex") {
        const pos = posRef.current["apex"];
        if (pos && !corr.some((c) => c.id === "apex")) corr.push({ id: "apex", ...pos });
      }

      // Add the dragged point.
      corr.push({ id: draggedId, ...draggedPos });

      const projected = projectAll(corr, imageWidth, imageHeight);
      if (!projected) {
        // Fallback: just move the dragged handle.
        setPositions((prev) => ({ ...prev, [draggedId]: draggedPos }));
        return;
      }

      setPositions((prev) => {
        const next = { ...prev, [draggedId]: draggedPos };
        for (const lm of LANDMARKS) {
          if (anchoredRef.current[lm.id] || lm.id === draggedId) continue;
          const p = projected[lm.id];
          if (p) next[lm.id] = p;
        }
        // Keep anchored positions unchanged.
        for (const id of anchoredIds) {
          if (id !== draggedId) next[id] = prev[id]!;
        }
        return next;
      });
    }

    const responder = useMemo(() =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => true,
        onPanResponderGrant: (_, gs) => {
          didMoveRef.current = false;
          const lx = gs.x0 - canvasPageOffset.x, ly = gs.y0 - canvasPageOffset.y;
          const touchImg = screenToImage(lx, ly);
          const sh = screenHandlesRef.current;

          // Find nearest handle.
          let nearId = LANDMARKS[0]!.id, nearDist = Infinity;
          for (const lm of LANDMARKS) {
            const h = sh[lm.id];
            if (!h) continue;
            const d = screenDist({ x: lx, y: ly }, h);
            if (d < nearDist) { nearDist = d; nearId = lm.id; }
          }

          const handlePos = posRef.current[nearId] ?? { nx: 0.5, ny: 0.5 };
          dragRef.current = { id: nearId, offset: { dnx: handlePos.nx - touchImg.nx, dny: handlePos.ny - touchImg.ny } };
          setActiveId(nearId);
        },
        onPanResponderMove: (_, gs) => {
          const drag = dragRef.current;
          if (!drag) return;
          if (Math.hypot(gs.dx, gs.dy) > 3) didMoveRef.current = true;
          const lx = gs.moveX - canvasPageOffset.x, ly = gs.moveY - canvasPageOffset.y;
          const curImg = screenToImage(lx, ly);
          const newPos = { nx: curImg.nx + drag.offset.dnx, ny: curImg.ny + drag.offset.dny };

          recomputeFreePositions(drag.id, newPos);
        },
        onPanResponderRelease: () => {
          const drag = dragRef.current;
          if (drag) {
            if (!didMoveRef.current && anchoredRef.current[drag.id]) {
              setAnchored((prev) => { const n = { ...prev }; delete n[drag.id]; return n; });
            } else if (didMoveRef.current) {
              setAnchored((prev) => {
                const count = Object.values(prev).filter(Boolean).length;
                if (count >= 4 && !prev[drag.id]) return prev;
                return { ...prev, [drag.id]: true };
              });
            }
          }
          setActiveId(null);
          dragRef.current = null;
        },
        onPanResponderTerminate: () => { setActiveId(null); dragRef.current = null; },
      }),
    [canvasPageOffset, screenToImage, anchoredIds, imageWidth, imageHeight]);

    useImperativeHandle(ref, () => ({
      solve: (): CameraPose | null => homography ? { fit: homography, sides: ["left", "right"] } : null,
      reset: () => { setPositions(defaultPositions()); setAnchored({}); setActiveId(null); },
      anchoredCount: () => anchorCount,
      getState: () => ({ positions, anchored }),
      setState: (s: { positions: Record<string, { nx: number; ny: number }>; anchored: Record<string, boolean> }) => {
        setPositions(s.positions);
        setAnchored(s.anchored);
      },
    }), [homography, anchorCount, positions, anchored]);

    return (
      <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
        <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
          {/* Projected filled geometry (≥4 anchors) — plate + base diamonds */}
          {projGeo && (
            <>
              <Polygon points={poly(projGeo.lb)} fill={BOX_FILL} stroke={BOX_COLOR} strokeWidth={2.5} />
              <Polygon points={poly(projGeo.rb)} fill={BOX_FILL} stroke={BOX_COLOR} strokeWidth={2.5} />
              <Line x1={projGeo.lb[0]!.x} y1={projGeo.lb[0]!.y} x2={projGeo.lb[3]!.x} y2={projGeo.lb[3]!.y} stroke={BOX_COLOR} strokeWidth={1.5} />
              <Line x1={projGeo.rb[0]!.x} y1={projGeo.rb[0]!.y} x2={projGeo.rb[3]!.x} y2={projGeo.rb[3]!.y} stroke={BOX_COLOR} strokeWidth={1.5} />
              {/* Plate */}
              <Polygon points={poly(projGeo.pl)} fill="rgba(255,120,180,0.1)" stroke={PLATE_COLOR} strokeWidth={2} />
              {/* Base diamonds */}
              {projGeo.bs.map((b, i) => <Polygon key={`bfill-${i}`} points={poly(b)} fill={BASE_FILL} stroke={BASE_COLOR} strokeWidth={2} />)}
            </>
          )}

          {/* Basepath lines (always visible from handle positions) */}
          {BASEPATH_EDGES.map(([a, b]) => {
            const sa = screenHandles[a], sb = screenHandles[b];
            if (!sa || !sb) return null;
            return <Line key={`bp-${a}-${b}`} x1={sa.x} y1={sa.y} x2={sb.x} y2={sb.y} stroke={BASEPATH_COLOR} strokeWidth={2} />;
          })}

          {/* Box edge lines (always visible from handle positions) */}
          {BOX_EDGES.map(([a, b]) => {
            const sa = screenHandles[a], sb = screenHandles[b];
            if (!sa || !sb) return null;
            return <Line key={`e-${a}-${b}`} x1={sa.x} y1={sa.y} x2={sb.x} y2={sb.y} stroke={LINE_COLOR} strokeWidth={2} />;
          })}

          {/* Handles */}
          {LANDMARKS.map((lm) => {
            const s = screenHandles[lm.id];
            if (!s) return null;
            const isA = !!anchored[lm.id];
            const isAct = activeId === lm.id;
            const color = isAct ? ACTIVE_COLOR : isA ? ANCHORED_COLOR : FREE_COLOR;
            const fill = isAct ? ACTIVE_FILL : isA ? ANCHORED_FILL : "rgba(255,255,255,0.08)";
            return (
              <React.Fragment key={lm.id}>
                <Circle cx={s.x} cy={s.y} r={HANDLE_R} fill={fill} stroke={color} strokeWidth={isA || isAct ? 2 : 1} />
                <SvgText x={s.x} y={s.y - HANDLE_R - 2} fill={color} fontSize={7} fontWeight="600" textAnchor="middle">
                  {lm.label}
                </SvgText>
              </React.Fragment>
            );
          })}

          {/* Status */}
          <SvgText x={10} y={20} fill={anchorCount >= 4 ? ANCHORED_COLOR : "rgba(255,200,0,0.9)"} fontSize={11} fontWeight="600">
            {anchorCount >= 4 && homography
              ? `${anchorCount} anchored · RMS ${homography.rmsPx.toFixed(1)}px`
              : `${anchorCount}/4 anchored`}
          </SvgText>
        </Svg>
        <View {...responder.panHandlers} style={StyleSheet.absoluteFill} />
      </View>
    );
  },
);
