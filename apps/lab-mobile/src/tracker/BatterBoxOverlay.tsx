// Batter's box calibration overlay.
//
// Shows both batter's boxes as wireframes with only 4 draggable corner
// handles (the outer corners of the pair). The inner edges and plate gap
// are computed from the homography since all geometry is known. The user
// drags 4 points → both boxes move together correctly.
//
// Controls (Reset, Set Pose) live in the parent TrackerTab, not here.

import React, { useCallback, useMemo, useRef, useState, useImperativeHandle, forwardRef } from "react";
import { View, Text, StyleSheet, PanResponder } from "react-native";
import Svg, { Polygon, Line } from "react-native-svg";
import {
  solveFromOuterCorners,
  allEightCorners,
  type CameraPose,
} from "../field/batterBox";
import { applyHomography } from "../field/videoHomography";
// Note: Metro resolves without .ts extension; node tests use .ts in the field/ files.

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

const HANDLE_RADIUS = 16;

const BOX_COLOR = "rgba(0,200,255,0.9)";
const BOX_FILL = "rgba(0,200,255,0.06)";

const HANDLE_LABELS = ["L Front", "R Front", "R Back", "L Back"] as const;

/** Default outer corners — a rough trapezoidal pair in center-bottom of frame. */
function defaultCorners(): FourCorners {
  return [
    { nx: 0.25, ny: 0.50 }, // left front-outside
    { nx: 0.75, ny: 0.50 }, // right front-outside
    { nx: 0.80, ny: 0.82 }, // right back-outside
    { nx: 0.20, ny: 0.82 }, // left back-outside
  ];
}

export const BatterBoxOverlay = forwardRef<BatterBoxOverlayHandle, BatterBoxOverlayProps>(
  function BatterBoxOverlay({ imageWidth, imageHeight, vp, canvas, canvasPageOffset }, ref) {
    const [corners, setCorners] = useState<FourCorners>(defaultCorners);
    const [activeHandle, setActiveHandle] = useState<number | null>(null);
    const [err, setErr] = useState<string | null>(null);

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

    // Screen positions of the 4 drag handles.
    const screenHandles = useMemo(
      () => corners.map((c) => imageToScreen(c.nx, c.ny)),
      [corners, imageToScreen],
    );

    // Try to solve the homography live so we can project the inner edges.
    const liveProjection = useMemo(() => {
      const imgCorners = corners.map((c) => ({
        u: c.nx * imageWidth,
        v: c.ny * imageHeight,
      })) as [{ u: number; v: number }, { u: number; v: number }, { u: number; v: number }, { u: number; v: number }];

      const pose = solveFromOuterCorners(imgCorners);
      if (!pose) return null;

      // Project all 8 corners to image coords, then to screen coords.
      const all = allEightCorners();
      const projectCorner = (pt: { x: number; z: number }) => {
        const img = applyHomography(pose.fit.H, pt.x, pt.z);
        if (!img) return null;
        return imageToScreen(img.x / imageWidth, img.y / imageHeight);
      };

      const leftScreen = all.left.map((p) => projectCorner(p));
      const rightScreen = all.right.map((p) => projectCorner(p));
      if (leftScreen.some((p) => !p) || rightScreen.some((p) => !p)) return null;

      return {
        left: leftScreen as { x: number; y: number }[],
        right: rightScreen as { x: number; y: number }[],
      };
    }, [corners, imageWidth, imageHeight, imageToScreen]);

    // SVG polygon points.
    const leftPoly = liveProjection
      ? liveProjection.left.map((p) => `${p.x},${p.y}`).join(" ")
      : null;
    const rightPoly = liveProjection
      ? liveProjection.right.map((p) => `${p.x},${p.y}`).join(" ")
      : null;

    // Fallback: just draw lines between the 4 outer handles if homography fails.
    const outerPoly = screenHandles.map((p) => `${p.x},${p.y}`).join(" ");

    // Ref so the body-drag responder can read corners without re-creating.
    const cornersRef = useRef(corners);
    cornersRef.current = corners;

    // 4 corner PanResponders + 1 body-drag responder.
    const responders = useMemo(() => {
      return [0, 1, 2, 3].map((idx) =>
        PanResponder.create({
          onStartShouldSetPanResponder: (e) => (e.nativeEvent.touches?.length ?? 1) < 2,
          onMoveShouldSetPanResponder: (e) => (e.nativeEvent.touches?.length ?? 1) < 2,
          onStartShouldSetPanResponderCapture: (e) => (e.nativeEvent.touches?.length ?? 1) < 2,
          onMoveShouldSetPanResponderCapture: (e) => (e.nativeEvent.touches?.length ?? 1) < 2,
          onPanResponderTerminationRequest: () => true,
          onPanResponderGrant: () => setActiveHandle(idx),
          onPanResponderMove: (_, gs) => {
            const localX = gs.moveX - canvasPageOffset.x;
            const localY = gs.moveY - canvasPageOffset.y;
            const img = screenToImage(localX, localY);
            setCorners((prev) => {
              const next = [...prev] as FourCorners;
              next[idx] = img;
              return next;
            });
          },
          onPanResponderRelease: () => setActiveHandle(null),
          onPanResponderTerminate: () => setActiveHandle(null),
        }),
      );
    }, [canvasPageOffset, screenToImage]);

    const dragStartRef = useRef<{ corners: FourCorners; startImg: Corner } | null>(null);

    const bodyResponder = useMemo(() =>
      PanResponder.create({
        // Only claim single-finger touches; let 2-finger pinch pass to the
        // canvas responder for zoom/pan.
        onStartShouldSetPanResponder: (e) => (e.nativeEvent.touches?.length ?? 1) < 2,
        onMoveShouldSetPanResponder: (e) => (e.nativeEvent.touches?.length ?? 1) < 2,
        onPanResponderTerminationRequest: () => true,
        onPanResponderGrant: (_, gs) => {
          setActiveHandle(-1);
          const localX = gs.x0 - canvasPageOffset.x;
          const localY = gs.y0 - canvasPageOffset.y;
          const startImg = screenToImage(localX, localY);
          dragStartRef.current = {
            corners: [...cornersRef.current] as FourCorners,
            startImg,
          };
        },
        onPanResponderMove: (_, gs) => {
          const drag = dragStartRef.current;
          if (!drag) return;
          const localX = gs.moveX - canvasPageOffset.x;
          const localY = gs.moveY - canvasPageOffset.y;
          const curImg = screenToImage(localX, localY);
          const dx = curImg.nx - drag.startImg.nx;
          const dy = curImg.ny - drag.startImg.ny;
          setCorners(drag.corners.map((c) => ({
            nx: Math.max(0, Math.min(1, c.nx + dx)),
            ny: Math.max(0, Math.min(1, c.ny + dy)),
          })) as FourCorners);
        },
        onPanResponderRelease: () => { setActiveHandle(null); dragStartRef.current = null; },
        onPanResponderTerminate: () => { setActiveHandle(null); dragStartRef.current = null; },
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
        if (!pose) {
          setErr("Could not solve pose — try adjusting the corners");
          return null;
        }
        if (pose.fit.rmsPx > 5) {
          setErr(`High reprojection error (${pose.fit.rmsPx.toFixed(1)}px)`);
        }
        return pose;
      },
      reset: () => {
        setCorners(defaultCorners());
        setErr(null);
      },
      getError: () => err,
    }), [corners, imageWidth, imageHeight, err]);

    return (
      <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
        <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
          {liveProjection ? (
            <>
              <Polygon points={leftPoly!} fill={BOX_FILL} stroke={BOX_COLOR} strokeWidth={2} />
              <Polygon points={rightPoly!} fill={BOX_FILL} stroke={BOX_COLOR} strokeWidth={2} />
              <Line
                x1={liveProjection.left[0]!.x} y1={liveProjection.left[0]!.y}
                x2={liveProjection.left[3]!.x} y2={liveProjection.left[3]!.y}
                stroke={BOX_COLOR} strokeWidth={1}
              />
              <Line
                x1={liveProjection.right[0]!.x} y1={liveProjection.right[0]!.y}
                x2={liveProjection.right[3]!.x} y2={liveProjection.right[3]!.y}
                stroke={BOX_COLOR} strokeWidth={1}
              />
            </>
          ) : (
            <Polygon points={outerPoly} fill="rgba(0,200,255,0.05)" stroke={BOX_COLOR} strokeWidth={1.5} />
          )}
        </Svg>

        {/* Body drag area — tap+drag anywhere not on a corner to move all */}
        <View
          {...bodyResponder.panHandlers}
          style={StyleSheet.absoluteFill}
        />

        {/* Handle labels */}
        {screenHandles.map((p, i) => (
          <View
            key={`label-${i}`}
            pointerEvents="none"
            style={{
              position: "absolute",
              left: p.x + (i === 0 || i === 3 ? -60 : 14),
              top: p.y + (i <= 1 ? -18 : 6),
            }}
          >
            <Text style={{ color: BOX_COLOR, fontSize: 9, fontWeight: "600" }}>
              {HANDLE_LABELS[i]}
            </Text>
          </View>
        ))}

        {/* 4 draggable corner handles */}
        {screenHandles.map((p, i) => {
          return (
            <View
              key={`handle-${i}`}
              {...responders[i]!.panHandlers}
              style={{
                position: "absolute",
                left: p.x - HANDLE_RADIUS,
                top: p.y - HANDLE_RADIUS,
                width: HANDLE_RADIUS * 2,
                height: HANDLE_RADIUS * 2,
                borderRadius: HANDLE_RADIUS,
                backgroundColor: activeHandle === i ? "rgba(0,200,255,0.5)" : "transparent",
                borderWidth: 2,
                borderColor: BOX_COLOR,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: "#fff" }} />
            </View>
          );
        })}

        {/* Error */}
        {err && (
          <View style={{ position: "absolute", top: 8, left: 8, right: 8, backgroundColor: "rgba(180,30,30,0.85)", paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6 }}>
            <Text style={{ color: "#fff", fontSize: 11 }}>{err}</Text>
          </View>
        )}
      </View>
    );
  },
);
