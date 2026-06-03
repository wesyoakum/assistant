// 3D Camera Pose calibration overlay.
//
// The user positions a virtual camera in 3D space until the projected
// field overlay matches the video frame. Two sub-modes:
//   Focus mode: drag to move the look-at point
//   Camera mode: drag to orbit the camera around the focus point
//
// Outputs the same CameraPose interface as BatterBoxOverlay.

import React, { useCallback, useMemo, useRef, useState, useImperativeHandle, forwardRef } from "react";
import { View, Text, Pressable, StyleSheet, PanResponder } from "react-native";
import Svg, { Polygon, Line, Circle, G } from "react-native-svg";
import { type CameraPose } from "../field/batterBox";
import { buildHomographyFromCamera, projectGroundPoint } from "../field/cameraToHomography";
import { allEightCorners } from "../field/batterBox";
import { homePlateCorners } from "../field/homePlateGeometry";
import { fieldLandmarks, type GroundPoint } from "../field/fieldTemplate";
import type { BatterBoxOverlayHandle } from "./BatterBoxOverlay";
import { useTrackerSettings } from "../state/trackerSettings";

export interface ThreeDPoseOverlayProps {
  imageWidth: number;
  imageHeight: number;
  vp: { scale: number; tx: number; ty: number };
  canvas: { width: number; height: number };
  canvasPageOffset: { x: number; y: number };
}

const BOX_COLOR = "rgba(0,200,255,0.9)";
const PLATE_COLOR = "rgba(255,120,180,0.9)";
const BASEPATH_COLOR = "rgba(255,120,180,0.7)";
const BASE_COLOR = "rgba(255,220,0,0.95)";

type SubMode = "camera" | "focus";

// Field geometry (precomputed once)
const geo = (() => {
  const boxes = allEightCorners();
  const plate = homePlateCorners();
  const lm = fieldLandmarks("littleLeague"); // basepath from settings applied dynamically
  const BH = (15 / 12) / 2;
  const bases = (["first_base", "second_base", "third_base"] as const).map((id) => {
    const c = lm[id];
    return [{ x: c.x + BH, z: c.z }, { x: c.x, z: c.z + BH }, { x: c.x - BH, z: c.z }, { x: c.x, z: c.z - BH }];
  });
  return { leftBox: boxes.left, rightBox: boxes.right, plate, bases };
})();

// Edges to draw
const BOX_EDGES: [number, number][] = [[0,1],[1,2],[2,3],[3,0]];

export const ThreeDPoseOverlay = forwardRef<BatterBoxOverlayHandle, ThreeDPoseOverlayProps>(
  function ThreeDPoseOverlay({ imageWidth, imageHeight, vp, canvas, canvasPageOffset }, ref) {
    const [camPos, setCamPos] = useState({ x: 5, y: -5, z: 2 });
    const [focusPos, setFocusPos] = useState({ x: 0, y: 4, z: 0 });
    const [subMode, setSubMode] = useState<SubMode>("camera");
    const { basepathFt } = useTrackerSettings();

    const camRef = useRef(camPos);
    camRef.current = camPos;
    const focusRef = useRef(focusPos);
    focusRef.current = focusPos;

    const imageToScreen = useCallback(
      (nx: number, ny: number) => {
        const cx = canvas.width / 2, cy = canvas.height / 2;
        return { x: (nx * canvas.width - cx) * vp.scale + cx + vp.tx, y: (ny * canvas.height - cy) * vp.scale + cy + vp.ty };
      },
      [canvas, vp],
    );

    // Build homography and project all field geometry.
    const projected = useMemo(() => {
      const result = buildHomographyFromCamera(camPos, focusPos, 69, imageWidth, imageHeight);
      if (!result) return null;

      const proj = (pt: GroundPoint) => {
        const img = projectGroundPoint(result.H, pt.x, pt.z);
        if (!img) return null;
        return imageToScreen(img.u / imageWidth, img.v / imageHeight);
      };

      const lm = fieldLandmarks("littleLeague"); // TODO: use basepathFt dynamically
      const foulEnd = basepathFt + 2.5 * basepathFt;

      const lb = geo.leftBox.map(proj);
      const rb = geo.rightBox.map(proj);
      const pl = geo.plate.map(proj);
      const bs = geo.bases.map((b) => b.map(proj));
      const bp = [{ x: 0, z: 0 }, lm.first_base, lm.second_base, lm.third_base, { x: 0, z: 0 }].map(proj);
      const foul1 = [{ x: 0, z: 0 }, { x: foulEnd, z: 0 }].map(proj);
      const foul3 = [{ x: 0, z: 0 }, { x: 0, z: foulEnd }].map(proj);

      // Project focus target with axis guide lines.
      // Focus is in user coords (x,y,z meters). Convert to internal field (x,z feet).
      const DIAG = Math.SQRT1_2;
      const M_FT = 1 / 0.3048;
      const fSum = focusPos.y * M_FT / DIAG;
      const fDiff = focusPos.x * M_FT / DIAG;
      const focusFieldX = (fSum + fDiff) / 2;
      const focusFieldZ = (fSum - fDiff) / 2;
      const focusField = { x: focusFieldX, z: focusFieldZ };
      const focusScreen = proj(focusField);

      // Axis guide lines: trace from origin along Y, then X, then Z to the focus point.
      // Step 1: Origin (0,0,0) → (0, focusY, 0) along Y axis on the ground
      const focusGuideY = [proj({ x: 0, z: 0 }), proj(focusField)]; // apex to focus on ground
      // Step 2: (0,0,0) → (focusX, 0, 0) along the user X direction on the ground
      // User X in field = (1,-1)/√2, so field point at user X=focusPos.x is:
      const xOnlyField = { x: focusPos.x * M_FT / DIAG / 2, z: -focusPos.x * M_FT / DIAG / 2 };
      // Guide: origin → along Y to (0, focusY) → along X to (focusX, focusY)
      const yEndField = { x: focusPos.y * M_FT * DIAG, z: focusPos.y * M_FT * DIAG }; // point at (0, focusY, 0) in user
      const guidePtOrigin = proj({ x: 0, z: 0 });
      const guidePtY = proj(yEndField);
      const guidePtXY = proj(focusField); // (focusX, focusY, 0) on ground

      // For Z axis: vertical line from ground focus to elevated focus
      // We can't project 3D height with ground homography, so show a marker
      const focusZLabel = focusPos.z;

      const allPts = [...lb, ...rb, ...pl, ...bs.flat(), ...bp, ...foul1, ...foul3];
      if (allPts.some((p) => !p)) return null;

      return {
        H: result.H, Hinv: result.Hinv,
        focusScreen,
        guidePtOrigin, guidePtY, guidePtXY, focusZLabel,
        lb: lb as { x: number; y: number }[],
        rb: rb as { x: number; y: number }[],
        pl: pl as { x: number; y: number }[],
        bs: bs as { x: number; y: number }[][],
        bp: bp as { x: number; y: number }[],
        foul1: foul1 as { x: number; y: number }[],
        foul3: foul3 as { x: number; y: number }[],
      };
    }, [camPos, focusPos, imageWidth, imageHeight, imageToScreen, basepathFt]);

    const poly = (pts: { x: number; y: number }[]) => pts.map((p) => `${p.x},${p.y}`).join(" ");

    // ── Touch handling ──────────────────────────────────────────────
    const dragStart = useRef<{ cam: typeof camPos; focus: typeof focusPos; pageX: number; pageY: number; pinchDist?: number } | null>(null);

    const responder = useMemo(() =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onStartShouldSetPanResponderCapture: () => true,
        onMoveShouldSetPanResponderCapture: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (e, gs) => {
          const touches = e.nativeEvent.touches;
          const start: any = { cam: { ...camRef.current }, focus: { ...focusRef.current }, pageX: gs.x0, pageY: gs.y0 };
          if (touches && touches.length >= 2) {
            const t0 = touches[0]!, t1 = touches[1]!;
            start.pinchDist = Math.hypot(t0.pageX - t1.pageX, t0.pageY - t1.pageY);
          }
          dragStart.current = start;
        },
        onPanResponderMove: (e, gs) => {
          const drag = dragStart.current;
          if (!drag) return;
          const touches = e.nativeEvent.touches;

          // 2-finger pinch → zoom (change camera distance from focus)
          if (touches && touches.length >= 2 && drag.pinchDist) {
            const t0 = touches[0]!, t1 = touches[1]!;
            const curDist = Math.hypot(t0.pageX - t1.pageX, t0.pageY - t1.pageY);
            const ratio = drag.pinchDist / Math.max(1, curDist); // closer fingers = zoom in
            const dx = drag.cam.x - drag.focus.x;
            const dy = drag.cam.y - drag.focus.y;
            const dz = drag.cam.z - drag.focus.z;
            setCamPos({
              x: drag.focus.x + dx * ratio,
              y: drag.focus.y + dy * ratio,
              z: Math.max(0.5, drag.focus.z + dz * ratio),
            });
            return;
          }

          // Sensitivity
          const sensitivity = 0.01;
          const deltaX = (gs.moveX - drag.pageX) * sensitivity;
          const deltaY = (gs.moveY - drag.pageY) * sensitivity;

          if (subMode === "focus") {
            // Move focus point: left/right → X, up/down → Y
            setFocusPos({
              x: drag.focus.x - deltaX * 2,
              y: drag.focus.y + deltaY * 2,
              z: drag.focus.z,
            });
          } else {
            // Orbit camera around focus point
            const dx = drag.cam.x - drag.focus.x;
            const dy = drag.cam.y - drag.focus.y;
            const dist = Math.hypot(dx, dy);
            const angle = Math.atan2(dy, dx);
            const newAngle = angle - deltaX;
            const elevDelta = deltaY;
            setCamPos({
              x: drag.focus.x + Math.cos(newAngle) * dist,
              y: drag.focus.y + Math.sin(newAngle) * dist,
              z: Math.max(0.5, drag.cam.z + elevDelta * 2),
            });
          }
        },
        onPanResponderRelease: () => { dragStart.current = null; },
        onPanResponderTerminate: () => { dragStart.current = null; },
      }),
    [subMode]);

    useImperativeHandle(ref, () => ({
      solve: (): CameraPose | null => {
        if (!projected) return null;
        return { fit: { H: projected.H, Hinv: projected.Hinv, rmsPx: 0, count: 0 }, sides: ["left", "right"] as any };
      },
      reset: () => {
        setCamPos({ x: 5, y: -5, z: 2 });
        setFocusPos({ x: 0, y: 4, z: 0 });
      },
      anchoredCount: () => projected ? 4 : 0,
      getState: () => ({ positions: { camPos, focusPos } as any, anchored: {} }),
      setState: (s: any) => {
        if (s.positions?.camPos) setCamPos(s.positions.camPos);
        if (s.positions?.focusPos) setFocusPos(s.positions.focusPos);
      },
    }), [projected, camPos, focusPos]);

    return (
      <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
        <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
          {projected && (
            <>
              {/* Foul lines */}
              <Line x1={projected.foul1[0]!.x} y1={projected.foul1[0]!.y} x2={projected.foul1[1]!.x} y2={projected.foul1[1]!.y} stroke={BASEPATH_COLOR} strokeWidth={2} />
              <Line x1={projected.foul3[0]!.x} y1={projected.foul3[0]!.y} x2={projected.foul3[1]!.x} y2={projected.foul3[1]!.y} stroke={BASEPATH_COLOR} strokeWidth={2} />
              {/* Basepaths */}
              <Polygon points={poly(projected.bp)} fill="none" stroke={BASEPATH_COLOR} strokeWidth={2} />
              {/* Batter's boxes */}
              <Polygon points={poly(projected.lb)} fill="rgba(0,200,255,0.06)" stroke={BOX_COLOR} strokeWidth={2} />
              <Polygon points={poly(projected.rb)} fill="rgba(0,200,255,0.06)" stroke={BOX_COLOR} strokeWidth={2} />
              {/* Inner edges */}
              <Line x1={projected.lb[0]!.x} y1={projected.lb[0]!.y} x2={projected.lb[3]!.x} y2={projected.lb[3]!.y} stroke={BOX_COLOR} strokeWidth={1} />
              <Line x1={projected.rb[0]!.x} y1={projected.rb[0]!.y} x2={projected.rb[3]!.x} y2={projected.rb[3]!.y} stroke={BOX_COLOR} strokeWidth={1} />
              {/* Plate */}
              <Polygon points={poly(projected.pl)} fill="rgba(255,120,180,0.1)" stroke={PLATE_COLOR} strokeWidth={2} />
              {/* Bases */}
              {projected.bs.map((b, i) => (
                <Polygon key={i} points={poly(b)} fill="rgba(255,220,0,0.35)" stroke={BASE_COLOR} strokeWidth={2} />
              ))}
              {/* Focus guide lines from origin to ground-shadow of focus */}
              {projected.guidePtOrigin && projected.guidePtY && (
                <Line x1={projected.guidePtOrigin.x} y1={projected.guidePtOrigin.y}
                      x2={projected.guidePtY.x} y2={projected.guidePtY.y}
                      stroke="rgba(0,255,0,0.5)" strokeWidth={1.5} strokeDasharray="6,4" />
              )}
              {projected.guidePtY && projected.guidePtXY && (
                <Line x1={projected.guidePtY.x} y1={projected.guidePtY.y}
                      x2={projected.guidePtXY.x} y2={projected.guidePtXY.y}
                      stroke="rgba(255,0,0,0.5)" strokeWidth={1.5} strokeDasharray="6,4" />
              )}
              {/* Ground shadow of focus (where it projects on the ground) */}
              {projected.guidePtXY && (
                <Circle cx={projected.guidePtXY.x} cy={projected.guidePtXY.y} r={4} fill="none" stroke="rgba(255,255,0,0.5)" strokeWidth={1} strokeDasharray="3,2" />
              )}
              {/* Z indicator: blue dashed line from ground shadow up toward viewport center */}
              {projected.guidePtXY && projected.focusZLabel !== 0 && (() => {
                const cx = canvas.width / 2, cy = canvas.height / 2;
                const screenCx = (cx - canvas.width/2) * vp.scale + canvas.width/2 + vp.tx;
                const screenCy = (cy - canvas.height/2) * vp.scale + canvas.height/2 + vp.ty;
                return <Line x1={projected.guidePtXY.x} y1={projected.guidePtXY.y}
                             x2={screenCx} y2={screenCy}
                             stroke="rgba(100,100,255,0.6)" strokeWidth={1.5} strokeDasharray="4,3" />;
              })()}
              {/* Focus crosshair at viewport center */}
              {(() => {
                const screenCx = canvas.width / 2 + vp.tx;
                const screenCy = canvas.height / 2 + vp.ty;
                return <>
                  <Circle cx={screenCx} cy={screenCy} r={8} fill="none" stroke="rgba(255,255,0,0.8)" strokeWidth={1.5} />
                  <Line x1={screenCx - 12} y1={screenCy} x2={screenCx - 4} y2={screenCy} stroke="rgba(255,255,0,0.8)" strokeWidth={1.5} />
                  <Line x1={screenCx + 4} y1={screenCy} x2={screenCx + 12} y2={screenCy} stroke="rgba(255,255,0,0.8)" strokeWidth={1.5} />
                  <Line x1={screenCx} y1={screenCy - 12} x2={screenCx} y2={screenCy - 4} stroke="rgba(255,255,0,0.8)" strokeWidth={1.5} />
                  <Line x1={screenCx} y1={screenCy + 4} x2={screenCx} y2={screenCy + 12} stroke="rgba(255,255,0,0.8)" strokeWidth={1.5} />
                </>;
              })()}
            </>
          )}
        </Svg>

        {/* Touch area */}
        <View {...responder.panHandlers} style={StyleSheet.absoluteFill} />

        {/* Controls */}
        <View style={{ position: "absolute", top: 8, left: 8, right: 8, flexDirection: "row", gap: 6 }}>
          <Pressable
            onPress={() => setSubMode("camera")}
            style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6, backgroundColor: subMode === "camera" ? "rgba(0,200,255,0.8)" : "rgba(0,0,0,0.5)" }}
          >
            <Text style={{ color: "#fff", fontSize: 11, fontWeight: "600" }}>Camera</Text>
          </Pressable>
          <Pressable
            onPress={() => setSubMode("focus")}
            style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6, backgroundColor: subMode === "focus" ? "rgba(0,200,255,0.8)" : "rgba(0,0,0,0.5)" }}
          >
            <Text style={{ color: "#fff", fontSize: 11, fontWeight: "600" }}>Focus</Text>
          </Pressable>
          <View style={{ flexDirection: "row", gap: 2, alignItems: "center" }}>
            <Text style={{ color: "rgba(255,255,0,0.8)", fontSize: 9 }}>Z</Text>
            <Pressable onPress={() => setFocusPos((p) => ({ ...p, z: p.z - 0.25 }))}
              style={{ paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, backgroundColor: "rgba(0,0,0,0.5)" }}>
              <Text style={{ color: "#fff", fontSize: 11 }}>−</Text>
            </Pressable>
            <Text style={{ color: "rgba(255,255,0,0.8)", fontSize: 9, minWidth: 28, textAlign: "center" }}>{focusPos.z.toFixed(1)}</Text>
            <Pressable onPress={() => setFocusPos((p) => ({ ...p, z: p.z + 0.25 }))}
              style={{ paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, backgroundColor: "rgba(0,0,0,0.5)" }}>
              <Text style={{ color: "#fff", fontSize: 11 }}>+</Text>
            </Pressable>
          </View>
          <View style={{ flex: 1 }} />
          <View style={{ backgroundColor: "rgba(0,0,0,0.6)", paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6 }}>
            <Text style={{ color: "#fff", fontSize: 9 }}>
              cam ({camPos.x.toFixed(1)}, {camPos.y.toFixed(1)}, {camPos.z.toFixed(1)})
              {" → "}
              ({focusPos.x.toFixed(1)}, {focusPos.y.toFixed(1)}, {focusPos.z.toFixed(1)})
            </Text>
          </View>
        </View>

        {!projected && (
          <View style={{ position: "absolute", top: 40, left: 8, backgroundColor: "rgba(180,30,30,0.85)", padding: 6, borderRadius: 6 }}>
            <Text style={{ color: "#fff", fontSize: 10 }}>Camera behind field — orbit to see</Text>
          </View>
        )}
      </View>
    );
  },
);
