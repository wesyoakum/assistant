// Batter's box calibration overlay — constrained camera model.
//
// Interaction:
//   - Drag anywhere = translate the whole template
//   - Drag the ROTATION handle (line extending toward 2B from origin) = rotate
//   - Drag the SCALE handle (line extending toward 1B from origin) = scale
//
// Assumes: camera level (no roll), ground flat, Z vertical.

import React, { useCallback, useMemo, useRef, useState, useImperativeHandle, forwardRef } from "react";
import { View, StyleSheet, PanResponder } from "react-native";
import Svg, { Polygon, Line, Circle } from "react-native-svg";
import {
  allEightCorners,
  outerCorners,
  solveFromOuterCorners,
  type CameraPose,
} from "../field/batterBox";
import { homePlateCorners } from "../field/homePlateGeometry";
import { fieldLandmarks, type GroundPoint } from "../field/fieldTemplate";

export interface BatterBoxOverlayProps {
  imageWidth: number;
  imageHeight: number;
  vp: { scale: number; tx: number; ty: number };
  canvas: { width: number; height: number };
  canvasPageOffset: { x: number; y: number };
}

export interface TemplateParams {
  cx: number; cy: number;
  angleDeg: number;
  scale: number;
  /** Perspective strength. 0 = orthographic, higher = more foreshortening.
   *  Typical range 0–0.05. Controls how much far-away points shrink. */
  perspective: number;
}

export interface BatterBoxOverlayHandle {
  getParams: () => TemplateParams;
  setParams: (p: Partial<TemplateParams>) => void;
  reset: () => void;
  /** Solve the camera pose by projecting known field points through the
   *  current template transform to get image correspondences, then fitting
   *  a homography. */
  solve: () => CameraPose | null;
}

const BOX_COLOR = "rgba(0,200,255,0.9)";
const BOX_FILL = "rgba(0,200,255,0.06)";
const PLATE_COLOR = "rgba(255,255,255,0.8)";
const BASE_COLOR = "rgba(255,255,255,0.9)";
const BASE_FILL = "rgba(255,255,255,0.3)";
const HANDLE_COLOR = "rgba(255,100,100,0.9)";
const SCALE_HANDLE_COLOR = "rgba(100,255,100,0.9)";
const HANDLE_RADIUS = 14;

// Rotation handle: along the Y axis (toward 2B = along the home→2B diagonal).
// In internal field coords, toward 2B = (1,1)/√2 direction.
const ROT_HANDLE_FIELD: GroundPoint = { x: 30, z: 30 };
// Scale handle: along the X axis (parallel to front edge of plate, toward 1B side).
// In internal field coords, this is the (1,0,-1)/√2 direction = perpendicular to the diagonal.
const SCALE_HANDLE_FIELD: GroundPoint = { x: 15, z: -15 };

const DEFAULT_PARAMS: TemplateParams = { cx: 0.5, cy: 0.62, angleDeg: 0, scale: 0.25, perspective: 0.015 };

function getGroundGeometry() {
  const boxes = allEightCorners();
  const plate = homePlateCorners();
  const landmarks = fieldLandmarks("littleLeague");
  const BASE_HALF_FT = (15 / 12) / 2;
  const baseIds = ["first_base", "second_base", "third_base"] as const;
  const bases = baseIds.map((id) => {
    const c = landmarks[id];
    return [
      { x: c.x + BASE_HALF_FT, z: c.z },
      { x: c.x, z: c.z + BASE_HALF_FT },
      { x: c.x - BASE_HALF_FT, z: c.z },
      { x: c.x, z: c.z - BASE_HALF_FT },
    ];
  });
  return { leftBox: boxes.left, rightBox: boxes.right, plate, bases };
}

function fieldToNorm(pt: GroundPoint, p: TemplateParams, aspect: number): { nx: number; ny: number } {
  const rad = p.angleDeg * (Math.PI / 180);
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const rx = cos * pt.x - sin * pt.z;
  const ry = sin * pt.x + cos * pt.z;
  // Perspective: points further away (larger ry = toward pitcher) shrink.
  // divisor > 1 for positive ry, making far points smaller.
  const pDiv = 1 + ry * p.perspective;
  const pScale = pDiv > 0.1 ? 1 / pDiv : 1 / 0.1; // clamp to avoid inversion
  return {
    nx: p.cx + rx * p.scale * pScale,
    ny: p.cy - ry * p.scale * pScale * (1 / aspect),
  };
}

const geo = getGroundGeometry();

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export const BatterBoxOverlay = forwardRef<BatterBoxOverlayHandle, BatterBoxOverlayProps>(
  function BatterBoxOverlay({ imageWidth, imageHeight, vp, canvas, canvasPageOffset }, ref) {
    const [params, setParams] = useState<TemplateParams>({ ...DEFAULT_PARAMS });
    const paramsRef = useRef(params);
    paramsRef.current = params;

    const aspect = imageWidth / imageHeight;

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
        return { nx: ix / canvas.width, ny: iy / canvas.height };
      },
      [canvas, vp],
    );

    // Project all geometry + handles.
    const projected = useMemo(() => {
      const p = params;
      const project = (pt: GroundPoint) => {
        const n = fieldToNorm(pt, p, aspect);
        return imageToScreen(n.nx, n.ny);
      };
      const origin = project({ x: 0, z: 0 });
      const rotHandle = project(ROT_HANDLE_FIELD);
      const scaleHandle = project(SCALE_HANDLE_FIELD);
      const leftBox = geo.leftBox.map(project);
      const rightBox = geo.rightBox.map(project);
      const plate = geo.plate.map(project);
      const bases = geo.bases.map((b) => b.map(project));
      return { origin, rotHandle, scaleHandle, leftBox, rightBox, plate, bases };
    }, [params, aspect, imageToScreen]);

    const projectedRef = useRef(projected);
    projectedRef.current = projected;

    const toPoly = (pts: { x: number; y: number }[]) => pts.map((p) => `${p.x},${p.y}`).join(" ");

    // ── Unified responder: detect handle proximity on grant ──────────
    type DragMode =
      | { type: "translate"; startParams: TemplateParams; startImg: { nx: number; ny: number } }
      | { type: "rotate"; startAngle: number; startTouchAngle: number; startPerspective: number; startHandleDist: number }
      | { type: "scale"; startScale: number; startDist: number };
    const dragRef = useRef<DragMode | null>(null);

    const unifiedResponder = useMemo(() =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => true,
        onPanResponderGrant: (_, gs) => {
          const localX = gs.x0 - canvasPageOffset.x;
          const localY = gs.y0 - canvasPageOffset.y;
          const p = projectedRef.current;
          const touchPt = { x: localX, y: localY };

          // Check rotation handle — angle controls rotation, distance controls perspective.
          if (dist(touchPt, p.rotHandle) < 30) {
            const dx = localX - p.origin.x;
            const dy = localY - p.origin.y;
            const touchAngle = Math.atan2(dx, -dy) * (180 / Math.PI);
            const handleDist = dist(touchPt, p.origin);
            dragRef.current = {
              type: "rotate",
              startAngle: paramsRef.current.angleDeg,
              startTouchAngle: touchAngle,
              startPerspective: paramsRef.current.perspective,
              startHandleDist: Math.max(1, handleDist),
            };
            return;
          }

          // Check scale handle.
          if (dist(touchPt, p.scaleHandle) < 30) {
            const d = dist(touchPt, p.origin);
            dragRef.current = { type: "scale", startScale: paramsRef.current.scale, startDist: Math.max(1, d) };
            return;
          }

          // Default: translate.
          const img = screenToImage(localX, localY);
          dragRef.current = { type: "translate", startParams: { ...paramsRef.current }, startImg: img };
        },
        onPanResponderMove: (_, gs) => {
          const drag = dragRef.current;
          if (!drag) return;
          const localX = gs.moveX - canvasPageOffset.x;
          const localY = gs.moveY - canvasPageOffset.y;

          if (drag.type === "rotate") {
            const p = projectedRef.current;
            const dx = localX - p.origin.x;
            const dy = localY - p.origin.y;
            // Angle controls rotation.
            const curAngle = Math.atan2(dx, -dy) * (180 / Math.PI);
            const angleDelta = curAngle - drag.startTouchAngle;
            // Distance from origin controls perspective: closer = more, farther = less.
            const curDist = Math.max(1, Math.hypot(dx, dy));
            const distRatio = drag.startHandleDist / curDist; // closer → ratio > 1
            const newPerspective = Math.max(0, Math.min(0.08, drag.startPerspective * distRatio));
            setParams((prev) => ({ ...prev, angleDeg: drag.startAngle + angleDelta, perspective: newPerspective }));
            return;
          }

          if (drag.type === "scale") {
            const p = projectedRef.current;
            const d = dist({ x: localX, y: localY }, p.origin);
            const ratio = d / drag.startDist;
            setParams((prev) => ({ ...prev, scale: Math.max(0.01, drag.startScale * ratio) }));
            return;
          }

          if (drag.type === "translate") {
            const curImg = screenToImage(localX, localY);
            setParams({
              ...drag.startParams,
              cx: drag.startParams.cx + (curImg.nx - drag.startImg.nx),
              cy: drag.startParams.cy + (curImg.ny - drag.startImg.ny),
            });
          }
        },
        onPanResponderRelease: () => { dragRef.current = null; },
        onPanResponderTerminate: () => { dragRef.current = null; },
      }),
    [canvasPageOffset, screenToImage]);

    useImperativeHandle(ref, () => ({
      getParams: () => ({ ...params }),
      setParams: (p) => setParams((prev) => ({ ...prev, ...p })),
      reset: () => setParams({ ...DEFAULT_PARAMS }),
      solve: () => {
        // Project the 4 outer batter's box corners through the template
        // transform to get image pixel coordinates, then solve the homography.
        const oc = outerCorners();
        const pts = [oc.leftFrontOut, oc.rightFrontOut, oc.rightBackOut, oc.leftBackOut];
        const imageCorners = pts.map((pt) => {
          const n = fieldToNorm(pt, params, aspect);
          return { u: n.nx * imageWidth, v: n.ny * imageHeight };
        }) as [{ u: number; v: number }, { u: number; v: number }, { u: number; v: number }, { u: number; v: number }];
        return solveFromOuterCorners(imageCorners);
      },
    }), [params, aspect, imageWidth, imageHeight]);

    return (
      <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
        <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
          {/* Batter's boxes */}
          <Polygon points={toPoly(projected.leftBox)} fill={BOX_FILL} stroke={BOX_COLOR} strokeWidth={2} />
          <Polygon points={toPoly(projected.rightBox)} fill={BOX_FILL} stroke={BOX_COLOR} strokeWidth={2} />
          {/* Inner edges */}
          <Line x1={projected.leftBox[0]!.x} y1={projected.leftBox[0]!.y} x2={projected.leftBox[3]!.x} y2={projected.leftBox[3]!.y} stroke={BOX_COLOR} strokeWidth={1} />
          <Line x1={projected.rightBox[0]!.x} y1={projected.rightBox[0]!.y} x2={projected.rightBox[3]!.x} y2={projected.rightBox[3]!.y} stroke={BOX_COLOR} strokeWidth={1} />
          {/* Home plate */}
          <Polygon points={toPoly(projected.plate)} fill="rgba(255,255,255,0.1)" stroke={PLATE_COLOR} strokeWidth={1.5} />
          {/* Bases */}
          {projected.bases.map((b, i) => (
            <Polygon key={`base-${i}`} points={toPoly(b)} fill={BASE_FILL} stroke={BASE_COLOR} strokeWidth={1.5} />
          ))}
          {/* Rotation handle: line from origin toward 2B */}
          <Line x1={projected.origin.x} y1={projected.origin.y} x2={projected.rotHandle.x} y2={projected.rotHandle.y}
            stroke={HANDLE_COLOR} strokeWidth={1.5} strokeDasharray="6,4" />
          <Circle cx={projected.rotHandle.x} cy={projected.rotHandle.y} r={HANDLE_RADIUS}
            fill="rgba(255,100,100,0.3)" stroke={HANDLE_COLOR} strokeWidth={2} />
          {/* Scale handle: line from origin toward 1B */}
          <Line x1={projected.origin.x} y1={projected.origin.y} x2={projected.scaleHandle.x} y2={projected.scaleHandle.y}
            stroke={SCALE_HANDLE_COLOR} strokeWidth={1.5} strokeDasharray="6,4" />
          <Circle cx={projected.scaleHandle.x} cy={projected.scaleHandle.y} r={HANDLE_RADIUS}
            fill="rgba(100,255,100,0.3)" stroke={SCALE_HANDLE_COLOR} strokeWidth={2} />
          {/* Origin dot */}
          <Circle cx={projected.origin.x} cy={projected.origin.y} r={4} fill="white" />
        </Svg>

        {/* Touch area */}
        <View {...unifiedResponder.panHandlers} style={StyleSheet.absoluteFill} />
      </View>
    );
  },
);
