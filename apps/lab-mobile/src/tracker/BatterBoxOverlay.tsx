// Batter's box calibration overlay.
//
// Shows both batter's boxes as wireframes with 4 outer corner handles.
// Single responder for all touch interaction:
//   - Touch INSIDE the quad → drag the whole template
//   - Touch OUTSIDE the quad → grab the nearest corner handle
//   - 2-finger pinch → scale the template around its center
// Controls (Reset, Set Pose) live in the parent TrackerTab.

import React, { useCallback, useMemo, useRef, useState, useImperativeHandle, forwardRef } from "react";
import { View, Text, StyleSheet, PanResponder } from "react-native";
import Svg, { Polygon, Line, Circle } from "react-native-svg";
import {
  solveFromOuterCorners,
  allEightCorners,
  type CameraPose,
} from "../field/batterBox";
import { applyHomography } from "../field/videoHomography";
import { homePlateCorners } from "../field/homePlateGeometry";

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
  getError: () => string | null;
}

type Corner = { nx: number; ny: number };
type FourCorners = [Corner, Corner, Corner, Corner];

const HANDLE_RADIUS = 18;
const BOX_COLOR = "rgba(0,200,255,0.9)";
const BOX_FILL = "rgba(0,200,255,0.06)";
const HANDLE_LABELS = ["L Front", "R Front", "R Back", "L Back"] as const;

function defaultCorners(): FourCorners {
  return [
    { nx: 0.25, ny: 0.50 },
    { nx: 0.75, ny: 0.50 },
    { nx: 0.80, ny: 0.82 },
    { nx: 0.20, ny: 0.82 },
  ];
}

/** Is point (px,py) inside the polygon defined by pts? (ray casting) */
function pointInQuad(px: number, py: number, pts: { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i]!.x, yi = pts[i]!.y;
    const xj = pts[j]!.x, yj = pts[j]!.y;
    if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

/** Distance between two points. */
function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Find index of the nearest corner handle to a screen point. */
function nearestHandle(sx: number, sy: number, handles: { x: number; y: number }[]): number {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < handles.length; i++) {
    const d = dist({ x: sx, y: sy }, handles[i]!);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

export const BatterBoxOverlay = forwardRef<BatterBoxOverlayHandle, BatterBoxOverlayProps>(
  function BatterBoxOverlay({ imageWidth, imageHeight, vp, canvas, canvasPageOffset }, ref) {
    const [corners, setCorners] = useState<FourCorners>(defaultCorners);
    const [activeHandle, setActiveHandle] = useState<number | null>(null);
    const [err, setErr] = useState<string | null>(null);

    const cornersRef = useRef(corners);
    cornersRef.current = corners;

    const imageToScreen = useCallback(
      (nx: number, ny: number) => {
        const cx = canvas.width / 2;
        const cy = canvas.height / 2;
        return {
          x: (nx * canvas.width - cx) * vp.scale + cx + vp.tx,
          y: (ny * canvas.height - cy) * vp.scale + cy + vp.ty,
        };
      },
      [canvas, vp],
    );

    const screenToImage = useCallback(
      (sx: number, sy: number) => {
        const cx = canvas.width / 2;
        const cy = canvas.height / 2;
        const ix = (sx - cx - vp.tx) / vp.scale + cx;
        const iy = (sy - cy - vp.ty) / vp.scale + cy;
        return {
          nx: Math.max(0, Math.min(1, ix / canvas.width)),
          ny: Math.max(0, Math.min(1, iy / canvas.height)),
        };
      },
      [canvas, vp],
    );

    const screenHandles = useMemo(
      () => corners.map((c) => imageToScreen(c.nx, c.ny)),
      [corners, imageToScreen],
    );
    const screenHandlesRef = useRef(screenHandles);
    screenHandlesRef.current = screenHandles;

    // Live homography projection for inner edges.
    const liveProjection = useMemo(() => {
      const imgCorners = corners.map((c) => ({
        u: c.nx * imageWidth,
        v: c.ny * imageHeight,
      })) as [{ u: number; v: number }, { u: number; v: number }, { u: number; v: number }, { u: number; v: number }];
      const pose = solveFromOuterCorners(imgCorners);
      if (!pose) return null;
      const all = allEightCorners();
      const projectCorner = (pt: { x: number; z: number }) => {
        const img = applyHomography(pose.fit.H, pt.x, pt.z);
        if (!img) return null;
        return imageToScreen(img.x / imageWidth, img.y / imageHeight);
      };
      const leftScreen = all.left.map((p) => projectCorner(p));
      const rightScreen = all.right.map((p) => projectCorner(p));
      if (leftScreen.some((p) => !p) || rightScreen.some((p) => !p)) return null;

      const plateScreen = homePlateCorners().map((p) => projectCorner(p));
      const plateValid = plateScreen.every((p) => p != null);

      return {
        left: leftScreen as { x: number; y: number }[],
        right: rightScreen as { x: number; y: number }[],
        plate: plateValid ? (plateScreen as { x: number; y: number }[]) : null,
      };
    }, [corners, imageWidth, imageHeight, imageToScreen]);

    const leftPoly = liveProjection ? liveProjection.left.map((p) => `${p.x},${p.y}`).join(" ") : null;
    const rightPoly = liveProjection ? liveProjection.right.map((p) => `${p.x},${p.y}`).join(" ") : null;
    const outerPoly = screenHandles.map((p) => `${p.x},${p.y}`).join(" ");

    // ── Single unified responder ────────────────────────────────────────
    // On grant: inside quad → body drag, outside quad → nearest corner.
    // Both use delta-based movement so the handle doesn't snap under the finger.

    type DragMode =
      | { type: "corner"; idx: number; startCorners: FourCorners; startImg: Corner }
      | { type: "body"; startCorners: FourCorners; startImg: Corner };
    const dragRef = useRef<DragMode | null>(null);

    const unifiedResponder = useMemo(() =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => true,
        onPanResponderGrant: (_, gs) => {
          const localX = gs.x0 - canvasPageOffset.x;
          const localY = gs.y0 - canvasPageOffset.y;
          const handles = screenHandlesRef.current;
          const startImg = screenToImage(localX, localY);

          if (pointInQuad(localX, localY, handles)) {
            dragRef.current = { type: "body", startCorners: [...cornersRef.current] as FourCorners, startImg };
            setActiveHandle(-1);
          } else {
            const idx = nearestHandle(localX, localY, handles);
            dragRef.current = { type: "corner", idx, startCorners: [...cornersRef.current] as FourCorners, startImg };
            setActiveHandle(idx);
          }
        },
        onPanResponderMove: (_, gs) => {
          const drag = dragRef.current;
          if (!drag) return;

          const localX = gs.moveX - canvasPageOffset.x;
          const localY = gs.moveY - canvasPageOffset.y;
          const curImg = screenToImage(localX, localY);
          const dx = curImg.nx - drag.startImg.nx;
          const dy = curImg.ny - drag.startImg.ny;

          if (drag.type === "corner") {
            // Move only the selected corner by the drag delta.
            setCorners(drag.startCorners.map((c, i) => {
              if (i !== drag.idx) return c;
              return {
                nx: Math.max(0, Math.min(1, c.nx + dx)),
                ny: Math.max(0, Math.min(1, c.ny + dy)),
              };
            }) as FourCorners);
            return;
          }

          if (drag.type === "body") {
            setCorners(drag.startCorners.map((c) => ({
              nx: Math.max(0, Math.min(1, c.nx + dx)),
              ny: Math.max(0, Math.min(1, c.ny + dy)),
            })) as FourCorners);
          }
        },
        onPanResponderRelease: () => { dragRef.current = null; setActiveHandle(null); },
        onPanResponderTerminate: () => { dragRef.current = null; setActiveHandle(null); },
      }),
    [canvasPageOffset, screenToImage]);

    useImperativeHandle(ref, () => ({
      solve: () => {
        setErr(null);
        const imgCorners = corners.map((c) => ({
          u: c.nx * imageWidth,
          v: c.ny * imageHeight,
        })) as [{ u: number; v: number }, { u: number; v: number }, { u: number; v: number }, { u: number; v: number }];
        const pose = solveFromOuterCorners(imgCorners);
        if (!pose) { setErr("Could not solve pose — try adjusting the corners"); return null; }
        if (pose.fit.rmsPx > 5) { setErr(`High reprojection error (${pose.fit.rmsPx.toFixed(1)}px)`); }
        return pose;
      },
      reset: () => { setCorners(defaultCorners()); setErr(null); },
      getError: () => err,
    }), [corners, imageWidth, imageHeight, err]);

    return (
      <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
        {/* SVG wireframes */}
        <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
          {liveProjection ? (
            <>
              <Polygon points={leftPoly!} fill={BOX_FILL} stroke={BOX_COLOR} strokeWidth={2} />
              <Polygon points={rightPoly!} fill={BOX_FILL} stroke={BOX_COLOR} strokeWidth={2} />
              {liveProjection.plate && (
                <Polygon
                  points={liveProjection.plate.map((p) => `${p.x},${p.y}`).join(" ")}
                  fill="rgba(255,255,255,0.1)"
                  stroke="rgba(255,255,255,0.8)"
                  strokeWidth={1.5}
                />
              )}
              <Line x1={liveProjection.left[0]!.x} y1={liveProjection.left[0]!.y} x2={liveProjection.left[3]!.x} y2={liveProjection.left[3]!.y} stroke={BOX_COLOR} strokeWidth={1} />
              <Line x1={liveProjection.right[0]!.x} y1={liveProjection.right[0]!.y} x2={liveProjection.right[3]!.x} y2={liveProjection.right[3]!.y} stroke={BOX_COLOR} strokeWidth={1} />
            </>
          ) : (
            <Polygon points={outerPoly} fill="rgba(0,200,255,0.05)" stroke={BOX_COLOR} strokeWidth={1.5} />
          )}
          {/* Corner dots */}
          {screenHandles.map((p, i) => (
            <Circle key={i} cx={p.x} cy={p.y} r={activeHandle === i ? HANDLE_RADIUS : 8}
              fill={activeHandle === i ? "rgba(0,200,255,0.4)" : "rgba(0,200,255,0.2)"}
              stroke={BOX_COLOR} strokeWidth={2} />
          ))}
        </Svg>

        {/* Single touch area — covers the full canvas */}
        <View {...unifiedResponder.panHandlers} style={StyleSheet.absoluteFill} />

        {/* Corner labels */}
        {screenHandles.map((p, i) => (
          <View key={`label-${i}`} pointerEvents="none"
            style={{ position: "absolute", left: p.x + (i === 0 || i === 3 ? -55 : 12), top: p.y - 16 }}>
            <Text style={{ color: BOX_COLOR, fontSize: 9, fontWeight: "600" }}>{HANDLE_LABELS[i]}</Text>
          </View>
        ))}

        {err && (
          <View style={{ position: "absolute", top: 8, left: 8, right: 8, backgroundColor: "rgba(180,30,30,0.85)", paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6 }}>
            <Text style={{ color: "#fff", fontSize: 11 }}>{err}</Text>
          </View>
        )}
      </View>
    );
  },
);
