// Batter's box calibration overlay — progressive anchoring.
//
// 0 anchors: drag = translate the whole overlay
// 1 anchor:  drag = pivot (rotate+scale) around the anchored point
// 2+ anchors: drag = move individual handle, anchor on release
// ≥4 anchors: homography auto-solves, geometry projects correctly
// Tap an anchored point to unanchor it.
// Nearest handle is always selected (delta-based, doesn't snap under finger).

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
}

const BOX_COLOR = "rgba(0,200,255,0.9)";
const BOX_FILL = "rgba(0,200,255,0.06)";
const PLATE_COLOR = "rgba(255,255,255,0.8)";
const BASE_COLOR = "rgba(255,255,255,0.9)";
const BASE_FILL = "rgba(255,255,255,0.3)";
const ANCHORED_COLOR = "rgba(0,255,100,0.95)";
const ANCHORED_FILL = "rgba(0,255,100,0.25)";
const ACTIVE_COLOR = "rgba(255,220,0,0.95)";
const ACTIVE_FILL = "rgba(255,220,0,0.35)";
const FREE_COLOR = "rgba(255,255,255,0.5)";
const HANDLE_R = 8;

interface Landmark {
  id: string;
  label: string;
  field: GroundPoint;
}

function buildLandmarks(): Landmark[] {
  const oc = outerCorners();
  const boxes = allEightCorners();
  const lm = fieldLandmarks("littleLeague");
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

// Geometry for rendering polygons.
const geo = (() => {
  const boxes = allEightCorners();
  const plate = homePlateCorners();
  const lm = fieldLandmarks("littleLeague");
  const BH = (15 / 12) / 2;
  const bases = (["first_base", "second_base", "third_base"] as const).map((id) => {
    const c = lm[id];
    return [{ x: c.x + BH, z: c.z }, { x: c.x, z: c.z + BH }, { x: c.x - BH, z: c.z }, { x: c.x, z: c.z - BH }];
  });
  return { leftBox: boxes.left, rightBox: boxes.right, plate, bases };
})();

function defaultPositions(): Record<string, { nx: number; ny: number }> {
  return {
    apex: { nx: 0.50, ny: 0.70 },
    lfo: { nx: 0.30, ny: 0.50 }, rfo: { nx: 0.70, ny: 0.50 },
    rbo: { nx: 0.72, ny: 0.75 }, lbo: { nx: 0.28, ny: 0.75 },
    lfi: { nx: 0.42, ny: 0.50 }, lbi: { nx: 0.40, ny: 0.75 },
    rfi: { nx: 0.58, ny: 0.50 }, rbi: { nx: 0.60, ny: 0.75 },
    "1b": { nx: 0.85, ny: 0.35 }, "2b": { nx: 0.50, ny: 0.15 }, "3b": { nx: 0.15, ny: 0.35 },
  };
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export const BatterBoxOverlay = forwardRef<BatterBoxOverlayHandle, BatterBoxOverlayProps>(
  function BatterBoxOverlay({ imageWidth, imageHeight, vp, canvas, canvasPageOffset }, ref) {
    const [positions, setPositions] = useState<Record<string, { nx: number; ny: number }>>(defaultPositions);
    const [anchored, setAnchored] = useState<Record<string, boolean>>({});

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
      const ix = (sx - cx - vp.tx) / vp.scale + cx;
      const iy = (sy - cy - vp.ty) / vp.scale + cy;
      return { nx: Math.max(0, Math.min(1, ix / canvas.width)), ny: Math.max(0, Math.min(1, iy / canvas.height)) };
    }, [canvas, vp]);

    const anchoredIds = useMemo(() => LANDMARKS.filter((lm) => anchored[lm.id]).map((lm) => lm.id), [anchored]);
    const anchorCount = anchoredIds.length;

    // Homography from anchored correspondences.
    const homography = useMemo((): HomographyFit | null => {
      if (anchorCount < 4) return null;
      const corr: Correspondence[] = [];
      for (const lm of LANDMARKS) {
        if (!anchored[lm.id]) continue;
        const pos = positions[lm.id];
        if (!pos) continue;
        corr.push({ field: { x: lm.field.x, z: lm.field.z }, image: { u: pos.nx * imageWidth, v: pos.ny * imageHeight } });
      }
      return fitHomography(corr);
    }, [anchored, positions, anchorCount, imageWidth, imageHeight]);

    // Screen positions for all handles.
    const screenHandles = useMemo(() => {
      const result: Record<string, { x: number; y: number }> = {};
      for (const lm of LANDMARKS) {
        if (anchored[lm.id] || !homography) {
          const pos = positions[lm.id] ?? { nx: 0.5, ny: 0.5 };
          result[lm.id] = imageToScreen(pos.nx, pos.ny);
        } else {
          const img = fieldToImage(homography.H, lm.field);
          if (img) {
            result[lm.id] = imageToScreen(img.x / imageWidth, img.y / imageHeight);
          } else {
            const pos = positions[lm.id] ?? { nx: 0.5, ny: 0.5 };
            result[lm.id] = imageToScreen(pos.nx, pos.ny);
          }
        }
      }
      return result;
    }, [anchored, positions, homography, imageWidth, imageHeight, imageToScreen]);

    const screenHandlesRef = useRef(screenHandles);
    screenHandlesRef.current = screenHandles;

    // Projected geometry.
    const projGeo = useMemo(() => {
      if (!homography) return null;
      const proj = (pt: GroundPoint) => {
        const img = fieldToImage(homography.H, pt);
        if (!img) return null;
        return imageToScreen(img.x / imageWidth, img.y / imageHeight);
      };
      const lb = geo.leftBox.map(proj), rb = geo.rightBox.map(proj);
      const pl = geo.plate.map(proj), bs = geo.bases.map((b) => b.map(proj));
      if ([...lb, ...rb, ...pl, ...bs.flat()].some((p) => !p)) return null;
      return { lb: lb as { x: number; y: number }[], rb: rb as { x: number; y: number }[], pl: pl as { x: number; y: number }[], bs: bs as { x: number; y: number }[][] };
    }, [homography, imageWidth, imageHeight, imageToScreen]);

    const poly = (pts: { x: number; y: number }[]) => pts.map((p) => `${p.x},${p.y}`).join(" ");

    // ── Touch ────────────────────────────────────────────────────────────
    // - Drag any handle: moves it (delta-based), anchors on release.
    //   Anchored handles are unaffected by other handles moving.
    // - 0 anchors: translate all unanchored handles.
    // - 1 anchor: pivot unanchored handles around the anchor.
    // - 2+ anchors: move only the selected handle.
    // - Tap an anchored handle to unanchor it.

    const [activeId, setActiveId] = useState<string | null>(null);

    type Drag =
      | { mode: "translate"; id: string; startPositions: Record<string, { nx: number; ny: number }>; startImg: { nx: number; ny: number } }
      | { mode: "pivot"; id: string; anchorId: string; anchorPos: { nx: number; ny: number }; startAngle: number; startDist: number; startPositions: Record<string, { nx: number; ny: number }> }
      | { mode: "individual"; id: string; offset: { dnx: number; dny: number } };
    const dragRef = useRef<Drag | null>(null);
    const didMoveRef = useRef(false);

    const responder = useMemo(() =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => true,
        onPanResponderGrant: (_, gs) => {
          didMoveRef.current = false;
          const lx = gs.x0 - canvasPageOffset.x, ly = gs.y0 - canvasPageOffset.y;
          const touchImg = screenToImage(lx, ly);

          // Find nearest handle.
          const sh = screenHandlesRef.current;
          let nearId = LANDMARKS[0]!.id, nearDist = Infinity;
          for (const lm of LANDMARKS) {
            const h = sh[lm.id];
            if (!h) continue;
            const d = dist({ x: lx, y: ly }, h);
            if (d < nearDist) { nearDist = d; nearId = lm.id; }
          }
          setActiveId(nearId);

          const anch = anchoredRef.current;
          const aIds = LANDMARKS.filter((l) => anch[l.id]).map((l) => l.id);
          const aCount = aIds.length;

          // Delta offset so handle doesn't snap under finger.
          const handlePos = posRef.current[nearId] ?? { nx: 0.5, ny: 0.5 };
          const offset = { dnx: handlePos.nx - touchImg.nx, dny: handlePos.ny - touchImg.ny };

          if (anch[nearId]) {
            // Re-dragging an anchored handle: move it individually.
            dragRef.current = { mode: "individual", id: nearId, offset };
          } else if (aCount === 0) {
            dragRef.current = { mode: "translate", id: nearId, startPositions: { ...posRef.current }, startImg: touchImg };
          } else if (aCount === 1) {
            const aId = aIds[0]!;
            const aPos = posRef.current[aId]!;
            const aScreen = sh[aId]!;
            const dx = lx - aScreen.x, dy = ly - aScreen.y;
            dragRef.current = {
              mode: "pivot", id: nearId, anchorId: aId, anchorPos: aPos,
              startAngle: Math.atan2(dx, -dy), startDist: Math.max(1, Math.hypot(dx, dy)),
              startPositions: { ...posRef.current },
            };
          } else {
            dragRef.current = { mode: "individual", id: nearId, offset };
          }
        },
        onPanResponderMove: (_, gs) => {
          const drag = dragRef.current;
          if (!drag) return;
          if (Math.hypot(gs.dx, gs.dy) > 3) didMoveRef.current = true;
          const lx = gs.moveX - canvasPageOffset.x, ly = gs.moveY - canvasPageOffset.y;
          const curImg = screenToImage(lx, ly);

          if (drag.mode === "translate") {
            const dx = curImg.nx - drag.startImg.nx, dy = curImg.ny - drag.startImg.ny;
            setPositions((prev) => {
              const next = { ...prev };
              for (const lm of LANDMARKS) {
                if (anchoredRef.current[lm.id]) continue; // skip anchored
                const sp = drag.startPositions[lm.id];
                if (sp) next[lm.id] = { nx: sp.nx + dx, ny: sp.ny + dy };
              }
              return next;
            });
            return;
          }

          if (drag.mode === "pivot") {
            const aScreen = screenHandlesRef.current[drag.anchorId];
            if (!aScreen) return;
            const dx = lx - aScreen.x, dy = ly - aScreen.y;
            const curAngle = Math.atan2(dx, -dy);
            const curDist = Math.max(1, Math.hypot(dx, dy));
            const dAngle = curAngle - drag.startAngle;
            const dScale = curDist / drag.startDist;
            const cos = Math.cos(dAngle), sin = Math.sin(dAngle);
            setPositions((prev) => {
              const next = { ...prev };
              for (const lm of LANDMARKS) {
                if (anchoredRef.current[lm.id]) continue; // skip anchored
                const sp = drag.startPositions[lm.id];
                if (!sp) continue;
                const rx = sp.nx - drag.anchorPos.nx, ry = sp.ny - drag.anchorPos.ny;
                next[lm.id] = {
                  nx: drag.anchorPos.nx + (cos * rx - sin * ry) * dScale,
                  ny: drag.anchorPos.ny + (sin * rx + cos * ry) * dScale,
                };
              }
              return next;
            });
            return;
          }

          if (drag.mode === "individual") {
            setPositions((prev) => ({
              ...prev,
              [drag.id]: { nx: curImg.nx + drag.offset.dnx, ny: curImg.ny + drag.offset.dny },
            }));
          }
        },
        onPanResponderRelease: () => {
          const drag = dragRef.current;
          if (!drag) { setActiveId(null); dragRef.current = null; return; }

          if (!didMoveRef.current && anchoredRef.current[drag.id]) {
            // Tap on anchored → unanchor.
            setAnchored((prev) => { const n = { ...prev }; delete n[drag.id]; return n; });
          } else if (didMoveRef.current) {
            // Dragged → anchor.
            setAnchored((prev) => ({ ...prev, [drag.id]: true }));
          }
          setActiveId(null);
          dragRef.current = null;
        },
        onPanResponderTerminate: () => { setActiveId(null); dragRef.current = null; },
      }),
    [canvasPageOffset, screenToImage]);

    useImperativeHandle(ref, () => ({
      solve: (): CameraPose | null => homography ? { fit: homography, sides: ["left", "right"] } : null,
      reset: () => { setPositions(defaultPositions()); setAnchored({}); },
      anchoredCount: () => anchorCount,
    }), [homography, anchorCount]);

    return (
      <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
        <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
          {projGeo && (
            <>
              <Polygon points={poly(projGeo.lb)} fill={BOX_FILL} stroke={BOX_COLOR} strokeWidth={2} />
              <Polygon points={poly(projGeo.rb)} fill={BOX_FILL} stroke={BOX_COLOR} strokeWidth={2} />
              <Line x1={projGeo.lb[0]!.x} y1={projGeo.lb[0]!.y} x2={projGeo.lb[3]!.x} y2={projGeo.lb[3]!.y} stroke={BOX_COLOR} strokeWidth={1} />
              <Line x1={projGeo.rb[0]!.x} y1={projGeo.rb[0]!.y} x2={projGeo.rb[3]!.x} y2={projGeo.rb[3]!.y} stroke={BOX_COLOR} strokeWidth={1} />
              <Polygon points={poly(projGeo.pl)} fill="rgba(255,255,255,0.1)" stroke={PLATE_COLOR} strokeWidth={1.5} />
              {projGeo.bs.map((b, i) => <Polygon key={i} points={poly(b)} fill={BASE_FILL} stroke={BASE_COLOR} strokeWidth={1.5} />)}
            </>
          )}
          {/* Lines connecting box corners (always visible) */}
          {!projGeo && (() => {
            const s = screenHandles;
            const line = (a: string, b: string) => {
              const sa = s[a], sb = s[b];
              if (!sa || !sb) return null;
              return <Line key={`${a}-${b}`} x1={sa.x} y1={sa.y} x2={sb.x} y2={sb.y} stroke={BOX_COLOR} strokeWidth={1} opacity={0.4} />;
            };
            return (
              <>
                {line("lfo","rfo")}{line("rfo","rbo")}{line("rbo","lbo")}{line("lbo","lfo")}
                {line("lfi","rfi")}{line("rfi","rbi")}{line("rbi","lbi")}{line("lbi","lfi")}
                {line("lfo","lfi")}{line("rfo","rfi")}{line("lbo","lbi")}{line("rbo","rbi")}
              </>
            );
          })()}

          {/* Handles */}
          {LANDMARKS.map((lm) => {
            const s = screenHandles[lm.id];
            if (!s) return null;
            const isA = !!anchored[lm.id];
            const isActive = activeId === lm.id;
            const color = isActive ? ACTIVE_COLOR : isA ? ANCHORED_COLOR : FREE_COLOR;
            const fill = isActive ? ACTIVE_FILL : isA ? ANCHORED_FILL : "rgba(255,255,255,0.08)";
            return (
              <React.Fragment key={lm.id}>
                <Circle cx={s.x} cy={s.y} r={HANDLE_R}
                  fill={fill} stroke={color} strokeWidth={isA || isActive ? 2 : 1} />
                <SvgText x={s.x} y={s.y - HANDLE_R - 2}
                  fill={color} fontSize={7} fontWeight="600" textAnchor="middle">
                  {lm.label}
                </SvgText>
              </React.Fragment>
            );
          })}
          <SvgText x={10} y={20} fill={anchorCount >= 4 ? "rgba(0,255,100,0.9)" : "rgba(255,200,0,0.9)"} fontSize={11} fontWeight="600">
            {anchorCount >= 4 && homography
              ? `${anchorCount} anchored · RMS ${homography.rmsPx.toFixed(1)}px`
              : `${anchorCount}/4 anchored${anchorCount === 0 ? " · drag to position" : anchorCount === 1 ? " · drag to pivot" : " · drag handles"}`}
          </SvgText>
        </Svg>
        <View {...responder.panHandlers} style={StyleSheet.absoluteFill} />
      </View>
    );
  },
);
