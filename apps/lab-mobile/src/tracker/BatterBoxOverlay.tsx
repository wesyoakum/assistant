// Batter's box calibration overlay — constrained camera model.
//
// Assumes: camera is level (no roll), ground is flat, Z is vertical.
// Template is adjusted by: translate (drag), rotate about Z, uniform scale.
// All field geometry (boxes, plate, strike zone, bases) renders through
// a single constrained projection.
//
// The user drags to position, uses sliders for rotation and scale.
// Controls (sliders, Reset, Set Pose) live in the parent TrackerTab.

import React, { useCallback, useMemo, useRef, useState, useImperativeHandle, forwardRef } from "react";
import { View, Text, StyleSheet, PanResponder } from "react-native";
import Svg, { Polygon, Line } from "react-native-svg";
import { allEightCorners } from "../field/batterBox";
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
  /** Get the current transform parameters. */
  getParams: () => TemplateParams;
  /** Set transform parameters (e.g. from sliders). */
  setParams: (p: Partial<TemplateParams>) => void;
  reset: () => void;
}

export interface TemplateParams {
  /** Center of the template in normalized image coords (0–1). */
  cx: number;
  cy: number;
  /** Rotation about Z axis in degrees (0 = no rotation). */
  angleDeg: number;
  /** Uniform scale factor (1 = default size). */
  scale: number;
}

const BOX_COLOR = "rgba(0,200,255,0.9)";
const BOX_FILL = "rgba(0,200,255,0.06)";
const PLATE_COLOR = "rgba(255,255,255,0.8)";
const SZ_COLOR = "rgba(255,204,0,0.8)";
const SZ_FILL = "rgba(255,204,0,0.15)";
const BASE_COLOR = "rgba(255,255,255,0.9)";
const BASE_FILL = "rgba(255,255,255,0.3)";

const DEFAULT_PARAMS: TemplateParams = { cx: 0.5, cy: 0.62, angleDeg: 0, scale: 0.25 };

// Collect all ground-plane geometry (field coords, feet).
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

/** Transform a field ground point (x,z) to normalized image coords via rotate+scale+translate. */
function fieldToNorm(
  pt: GroundPoint,
  p: TemplateParams,
  aspect: number, // imageWidth / imageHeight
): { nx: number; ny: number } {
  const rad = p.angleDeg * (Math.PI / 180);
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  // Rotate field point about origin, scale, then translate.
  // Field x maps to screen horizontal, field z maps to screen vertical (inverted: +z = toward 3B = left on screen from behind).
  // We want the template centered on (cx, cy) with uniform scale.
  // Field coords: x toward 1B, z toward 3B. From behind the plate:
  //   field +x = screen right, field +z = screen left
  //   field "toward pitcher" (diagonal) = screen up
  // So we map: screen_x = -(field_z) [3B is left], screen_y = -(field_x + field_z)/sqrt2 [toward pitcher is up]
  // Actually, simpler: just rotate the field (x,z) by angle, scale, and offset.
  // "Up" in the image (smaller ny) should be "toward the pitcher" (larger field x+z).
  const fx = pt.x;
  const fz = pt.z;
  const rx = cos * fx - sin * fz;
  const ry = sin * fx + cos * fz;
  // Map to image: rx controls horizontal, ry controls vertical.
  // Negate ry so that larger ry (toward pitcher) goes up (smaller ny).
  const nx = p.cx + rx * p.scale;
  const ny = p.cy - ry * p.scale * (1 / aspect); // correct for aspect ratio
  return { nx, ny };
}

const geo = getGroundGeometry();

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

    // Project all geometry to screen coords.
    const projected = useMemo(() => {
      const p = params;
      const project = (pt: GroundPoint) => {
        const n = fieldToNorm(pt, p, aspect);
        return imageToScreen(n.nx, n.ny);
      };

      const leftBox = geo.leftBox.map(project);
      const rightBox = geo.rightBox.map(project);
      const plate = geo.plate.map(project);
      const bases = geo.bases.map((b) => b.map(project));

      return { leftBox, rightBox, plate, bases };
    }, [params, aspect, imageToScreen]);

    const toPoly = (pts: { x: number; y: number }[]) => pts.map((p) => `${p.x},${p.y}`).join(" ");

    // Drag to translate.
    const dragStartRef = useRef<{ params: TemplateParams; startImg: { nx: number; ny: number } } | null>(null);

    const bodyResponder = useMemo(() =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => true,
        onPanResponderGrant: (_, gs) => {
          const localX = gs.x0 - canvasPageOffset.x;
          const localY = gs.y0 - canvasPageOffset.y;
          dragStartRef.current = {
            params: { ...paramsRef.current },
            startImg: screenToImage(localX, localY),
          };
        },
        onPanResponderMove: (_, gs) => {
          const drag = dragStartRef.current;
          if (!drag) return;
          const localX = gs.moveX - canvasPageOffset.x;
          const localY = gs.moveY - canvasPageOffset.y;
          const curImg = screenToImage(localX, localY);
          setParams((prev) => ({
            ...prev,
            cx: drag.params.cx + (curImg.nx - drag.startImg.nx),
            cy: drag.params.cy + (curImg.ny - drag.startImg.ny),
          }));
        },
        onPanResponderRelease: () => { dragStartRef.current = null; },
        onPanResponderTerminate: () => { dragStartRef.current = null; },
      }),
    [canvasPageOffset, screenToImage]);

    useImperativeHandle(ref, () => ({
      getParams: () => ({ ...params }),
      setParams: (p) => setParams((prev) => ({ ...prev, ...p })),
      reset: () => setParams({ ...DEFAULT_PARAMS }),
    }), [params]);

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
        </Svg>

        {/* Drag area */}
        <View {...bodyResponder.panHandlers} style={StyleSheet.absoluteFill} />
      </View>
    );
  },
);
