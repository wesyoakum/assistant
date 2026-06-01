// Batter's box calibration overlay — point correspondence approach.
//
// The user drags known field landmarks onto their image positions.
// Each dragged landmark becomes "locked" (a known correspondence).
// With ≥4 locked points, the homography is solved and all unlocked
// points auto-project to their correct positions.
// Tap a locked point to unlock it.

import React, { useCallback, useMemo, useRef, useState, useImperativeHandle, forwardRef } from "react";
import { View, StyleSheet, PanResponder } from "react-native";
import Svg, { Polygon, Line, Circle, Text as SvgText } from "react-native-svg";
import {
  allEightCorners,
  outerCorners,
  type CameraPose,
} from "../field/batterBox";
import {
  fitHomography,
  fieldToImage,
  type Correspondence,
  type HomographyFit,
} from "../field/videoHomography";
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
  lockedCount: () => number;
}

const BOX_COLOR = "rgba(0,200,255,0.9)";
const BOX_FILL = "rgba(0,200,255,0.06)";
const PLATE_COLOR = "rgba(255,255,255,0.8)";
const BASE_COLOR = "rgba(255,255,255,0.9)";
const BASE_FILL = "rgba(255,255,255,0.3)";
const LOCKED_COLOR = "rgba(0,255,100,0.9)";
const UNLOCKED_COLOR = "rgba(255,255,255,0.5)";
const HANDLE_RADIUS = 16;

// ── Known field landmarks ────────────────────────────────────────────

interface Landmark {
  id: string;
  label: string;
  field: GroundPoint; // known world position (internal field coords, feet)
}

function buildLandmarks(): Landmark[] {
  const oc = outerCorners();
  const boxes = allEightCorners();
  const lm = fieldLandmarks("littleLeague");

  return [
    { id: "apex", label: "Apex", field: { x: 0, z: 0 } },
    { id: "lfo", label: "L-Out-F", field: oc.leftFrontOut },
    { id: "rfo", label: "R-Out-F", field: oc.rightFrontOut },
    { id: "rbo", label: "R-Out-B", field: oc.rightBackOut },
    { id: "lbo", label: "L-Out-B", field: oc.leftBackOut },
    { id: "lfi", label: "L-In-F", field: boxes.left[0] },
    { id: "lbi", label: "L-In-B", field: boxes.left[3] },
    { id: "rfi", label: "R-In-F", field: boxes.right[0] },
    { id: "rbi", label: "R-In-B", field: boxes.right[3] },
    { id: "1b", label: "1B", field: lm.first_base },
    { id: "2b", label: "2B", field: lm.second_base },
    { id: "3b", label: "3B", field: lm.third_base },
  ];
}

const LANDMARKS = buildLandmarks();

// Geometry for rendering (unchanged by locks).
const geo = (() => {
  const boxes = allEightCorners();
  const plate = homePlateCorners();
  const lm = fieldLandmarks("littleLeague");
  const BASE_HALF = (15 / 12) / 2;
  const bases = (["first_base", "second_base", "third_base"] as const).map((id) => {
    const c = lm[id];
    return [
      { x: c.x + BASE_HALF, z: c.z },
      { x: c.x, z: c.z + BASE_HALF },
      { x: c.x - BASE_HALF, z: c.z },
      { x: c.x, z: c.z - BASE_HALF },
    ];
  });
  return { leftBox: boxes.left, rightBox: boxes.right, plate, bases };
})();

// ── Default image positions (spread out so the user can see them) ────

function defaultPositions(): Record<string, { nx: number; ny: number }> {
  return {
    apex: { nx: 0.50, ny: 0.70 },
    lfo: { nx: 0.30, ny: 0.50 },
    rfo: { nx: 0.70, ny: 0.50 },
    rbo: { nx: 0.72, ny: 0.75 },
    lbo: { nx: 0.28, ny: 0.75 },
    lfi: { nx: 0.42, ny: 0.50 },
    lbi: { nx: 0.40, ny: 0.75 },
    rfi: { nx: 0.58, ny: 0.50 },
    rbi: { nx: 0.60, ny: 0.75 },
    "1b": { nx: 0.85, ny: 0.35 },
    "2b": { nx: 0.50, ny: 0.15 },
    "3b": { nx: 0.15, ny: 0.35 },
  };
}

export const BatterBoxOverlay = forwardRef<BatterBoxOverlayHandle, BatterBoxOverlayProps>(
  function BatterBoxOverlay({ imageWidth, imageHeight, vp, canvas, canvasPageOffset }, ref) {
    // Image positions of each landmark (normalized 0–1).
    const [positions, setPositions] = useState<Record<string, { nx: number; ny: number }>>(defaultPositions);
    // Which landmarks are locked (user has placed them).
    const [locked, setLocked] = useState<Record<string, boolean>>({});

    const positionsRef = useRef(positions);
    positionsRef.current = positions;

    const imageToScreen = useCallback(
      (nx: number, ny: number) => {
        const cxs = canvas.width / 2;
        const cys = canvas.height / 2;
        return {
          x: (nx * canvas.width - cxs) * vp.scale + cxs + vp.tx,
          y: (ny * canvas.height - cys) * vp.scale + cys + vp.ty,
        };
      },
      [canvas, vp],
    );

    const screenToImage = useCallback(
      (sx: number, sy: number) => {
        const cxs = canvas.width / 2;
        const cys = canvas.height / 2;
        const ix = (sx - cxs - vp.tx) / vp.scale + cxs;
        const iy = (sy - cys - vp.ty) / vp.scale + cys;
        return { nx: Math.max(0, Math.min(1, ix / canvas.width)), ny: Math.max(0, Math.min(1, iy / canvas.height)) };
      },
      [canvas, vp],
    );

    // Solve homography from locked correspondences.
    const lockedCount = Object.values(locked).filter(Boolean).length;

    const homography = useMemo((): HomographyFit | null => {
      if (lockedCount < 4) return null;
      const corr: Correspondence[] = [];
      for (const lm of LANDMARKS) {
        if (!locked[lm.id]) continue;
        const pos = positions[lm.id];
        if (!pos) continue;
        corr.push({
          field: { x: lm.field.x, z: lm.field.z },
          image: { u: pos.nx * imageWidth, v: pos.ny * imageHeight },
        });
      }
      return fitHomography(corr);
    }, [locked, positions, lockedCount, imageWidth, imageHeight]);

    // Screen positions: locked points use their set position,
    // unlocked points project through the homography (if available).
    const screenPoints = useMemo(() => {
      const result: Record<string, { screen: { x: number; y: number }; isLocked: boolean }> = {};
      for (const lm of LANDMARKS) {
        const isLocked = !!locked[lm.id];
        if (isLocked || !homography) {
          const pos = positions[lm.id] ?? { nx: 0.5, ny: 0.5 };
          result[lm.id] = { screen: imageToScreen(pos.nx, pos.ny), isLocked };
        } else {
          // Project through homography.
          const img = fieldToImage(homography.H, lm.field);
          if (img) {
            const nx = img.x / imageWidth;
            const ny = img.y / imageHeight;
            result[lm.id] = { screen: imageToScreen(nx, ny), isLocked: false };
          } else {
            const pos = positions[lm.id] ?? { nx: 0.5, ny: 0.5 };
            result[lm.id] = { screen: imageToScreen(pos.nx, pos.ny), isLocked: false };
          }
        }
      }
      return result;
    }, [locked, positions, homography, imageWidth, imageHeight, imageToScreen]);

    // Project geometry through homography for rendering lines/polygons.
    const projectedGeo = useMemo(() => {
      if (!homography) return null;
      const project = (pt: GroundPoint) => {
        const img = fieldToImage(homography.H, pt);
        if (!img) return null;
        return imageToScreen(img.x / imageWidth, img.y / imageHeight);
      };
      const leftBox = geo.leftBox.map(project);
      const rightBox = geo.rightBox.map(project);
      const plate = geo.plate.map(project);
      const bases = geo.bases.map((b) => b.map(project));
      if ([...leftBox, ...rightBox, ...plate, ...bases.flat()].some((p) => !p)) return null;
      return {
        leftBox: leftBox as { x: number; y: number }[],
        rightBox: rightBox as { x: number; y: number }[],
        plate: plate as { x: number; y: number }[],
        bases: bases as { x: number; y: number }[][],
      };
    }, [homography, imageWidth, imageHeight, imageToScreen]);

    const toPoly = (pts: { x: number; y: number }[]) => pts.map((p) => `${p.x},${p.y}`).join(" ");

    // ── Touch handling ──────────────────────────────────────────────────
    const screenPointsRef = useRef(screenPoints);
    screenPointsRef.current = screenPoints;

    type DragMode = { type: "drag"; id: string; startImg: { nx: number; ny: number } };
    const dragRef = useRef<DragMode | null>(null);

    const responder = useMemo(() =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => true,
        onPanResponderGrant: (_, gs) => {
          const localX = gs.x0 - canvasPageOffset.x;
          const localY = gs.y0 - canvasPageOffset.y;
          const touchPt = { x: localX, y: localY };

          // Find nearest landmark handle.
          let nearestId = "";
          let nearestDist = Infinity;
          const sp = screenPointsRef.current;
          for (const lm of LANDMARKS) {
            const pt = sp[lm.id];
            if (!pt) continue;
            const d = Math.hypot(touchPt.x - pt.screen.x, touchPt.y - pt.screen.y);
            if (d < nearestDist) { nearestDist = d; nearestId = lm.id; }
          }

          if (nearestDist < 35) {
            // If it's locked, check for a tap (will unlock on release if no drag).
            const img = screenToImage(localX, localY);
            dragRef.current = { type: "drag", id: nearestId, startImg: img };
          }
        },
        onPanResponderMove: (_, gs) => {
          const drag = dragRef.current;
          if (!drag) return;
          const localX = gs.moveX - canvasPageOffset.x;
          const localY = gs.moveY - canvasPageOffset.y;
          const img = screenToImage(localX, localY);
          setPositions((prev) => ({ ...prev, [drag.id]: img }));
          // Lock it as soon as it's dragged.
          setLocked((prev) => ({ ...prev, [drag.id]: true }));
        },
        onPanResponderRelease: (_, gs) => {
          const drag = dragRef.current;
          if (!drag) { dragRef.current = null; return; }
          // If barely moved (tap), toggle lock.
          const moved = Math.hypot(gs.dx, gs.dy);
          if (moved < 5 && locked[drag.id]) {
            setLocked((prev) => ({ ...prev, [drag.id]: false }));
          }
          dragRef.current = null;
        },
        onPanResponderTerminate: () => { dragRef.current = null; },
      }),
    [canvasPageOffset, screenToImage, locked]);

    useImperativeHandle(ref, () => ({
      solve: (): CameraPose | null => {
        if (!homography) return null;
        return { fit: homography, sides: ["left", "right"] };
      },
      reset: () => { setPositions(defaultPositions()); setLocked({}); },
      lockedCount: () => lockedCount,
    }), [homography, lockedCount]);

    return (
      <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
        <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
          {/* Projected geometry (when homography is available) */}
          {projectedGeo && (
            <>
              <Polygon points={toPoly(projectedGeo.leftBox)} fill={BOX_FILL} stroke={BOX_COLOR} strokeWidth={2} />
              <Polygon points={toPoly(projectedGeo.rightBox)} fill={BOX_FILL} stroke={BOX_COLOR} strokeWidth={2} />
              <Line x1={projectedGeo.leftBox[0]!.x} y1={projectedGeo.leftBox[0]!.y} x2={projectedGeo.leftBox[3]!.x} y2={projectedGeo.leftBox[3]!.y} stroke={BOX_COLOR} strokeWidth={1} />
              <Line x1={projectedGeo.rightBox[0]!.x} y1={projectedGeo.rightBox[0]!.y} x2={projectedGeo.rightBox[3]!.x} y2={projectedGeo.rightBox[3]!.y} stroke={BOX_COLOR} strokeWidth={1} />
              <Polygon points={toPoly(projectedGeo.plate)} fill="rgba(255,255,255,0.1)" stroke={PLATE_COLOR} strokeWidth={1.5} />
              {projectedGeo.bases.map((b, i) => (
                <Polygon key={`base-${i}`} points={toPoly(b)} fill={BASE_FILL} stroke={BASE_COLOR} strokeWidth={1.5} />
              ))}
            </>
          )}

          {/* Landmark handles */}
          {LANDMARKS.map((lm) => {
            const pt = screenPoints[lm.id];
            if (!pt) return null;
            const isLocked = pt.isLocked;
            const color = isLocked ? LOCKED_COLOR : UNLOCKED_COLOR;
            return (
              <React.Fragment key={lm.id}>
                <Circle cx={pt.screen.x} cy={pt.screen.y} r={HANDLE_RADIUS}
                  fill={isLocked ? "rgba(0,255,100,0.25)" : "rgba(255,255,255,0.1)"}
                  stroke={color} strokeWidth={isLocked ? 2.5 : 1.5} />
                <SvgText x={pt.screen.x} y={pt.screen.y - HANDLE_RADIUS - 3}
                  fill={color} fontSize={8} fontWeight="600" textAnchor="middle">
                  {lm.label}
                </SvgText>
              </React.Fragment>
            );
          })}

          {/* Lock count indicator */}
          {lockedCount > 0 && lockedCount < 4 && (
            <SvgText x={10} y={20} fill="rgba(255,200,0,0.9)" fontSize={11} fontWeight="600">
              {lockedCount}/4 points locked (need 4 to solve)
            </SvgText>
          )}
          {lockedCount >= 4 && homography && (
            <SvgText x={10} y={20} fill={LOCKED_COLOR} fontSize={11} fontWeight="600">
              {lockedCount} locked · RMS {homography.rmsPx.toFixed(1)}px
            </SvgText>
          )}
        </Svg>

        {/* Touch area */}
        <View {...responder.panHandlers} style={StyleSheet.absoluteFill} />
      </View>
    );
  },
);
