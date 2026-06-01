// Batter's box corner-drag overlay for camera pose calibration.
//
// Renders BOTH batter's box wireframes over the video frame with 8 draggable
// corner handles (4 per box). The user adjusts corners until they match the
// visible chalk lines. Controls (Reset, Set Pose) live in the parent — this
// component only renders the overlay on top of the image.

import React, { useCallback, useMemo, useRef, useState, useImperativeHandle, forwardRef } from "react";
import { View, Text, StyleSheet, PanResponder } from "react-native";
import Svg, { Polygon } from "react-native-svg";
import { solveFromBothBoxes, type CameraPose } from "../field/batterBox";

export interface BatterBoxOverlayProps {
  imageWidth: number;
  imageHeight: number;
  vp: { scale: number; tx: number; ty: number };
  canvas: { width: number; height: number };
  canvasPageOffset: { x: number; y: number };
}

export interface BatterBoxOverlayHandle {
  /** Solve the homography from the current corner positions. */
  solve: () => CameraPose | null;
  /** Reset corners to defaults. */
  reset: () => void;
  /** Get error message from last solve attempt. */
  getError: () => string | null;
}

type Corner = { nx: number; ny: number };
type FourCorners = [Corner, Corner, Corner, Corner];

const HANDLE_RADIUS = 14;

const LEFT_COLOR = "rgba(0,200,255,0.9)";
const RIGHT_COLOR = "rgba(255,150,0,0.9)";
const LEFT_FILL = "rgba(0,200,255,0.08)";
const RIGHT_FILL = "rgba(255,150,0,0.08)";

const CORNER_LABELS_L = ["L Front In", "L Front Out", "L Back Out", "L Back In"] as const;
const CORNER_LABELS_R = ["R Front In", "R Front Out", "R Back Out", "R Back In"] as const;

/** Default left box: first-base side, slightly left of center. */
function defaultLeftCorners(): FourCorners {
  return [
    { nx: 0.35, ny: 0.55 },
    { nx: 0.48, ny: 0.55 },
    { nx: 0.49, ny: 0.80 },
    { nx: 0.33, ny: 0.80 },
  ];
}

/** Default right box: third-base side, slightly right of center. */
function defaultRightCorners(): FourCorners {
  return [
    { nx: 0.52, ny: 0.55 },
    { nx: 0.65, ny: 0.55 },
    { nx: 0.67, ny: 0.80 },
    { nx: 0.51, ny: 0.80 },
  ];
}

export const BatterBoxOverlay = forwardRef<BatterBoxOverlayHandle, BatterBoxOverlayProps>(
  function BatterBoxOverlay({ imageWidth, imageHeight, vp, canvas, canvasPageOffset }, ref) {
    const [leftCorners, setLeftCorners] = useState<FourCorners>(defaultLeftCorners);
    const [rightCorners, setRightCorners] = useState<FourCorners>(defaultRightCorners);
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

    // All 8 corners: [left0..3, right0..3]
    const allCorners = useMemo(
      () => [...leftCorners, ...rightCorners],
      [leftCorners, rightCorners],
    );
    const allScreenCorners = useMemo(
      () => allCorners.map((c) => imageToScreen(c.nx, c.ny)),
      [allCorners, imageToScreen],
    );

    const leftPolyPoints = useMemo(
      () => allScreenCorners.slice(0, 4).map((p) => `${p.x},${p.y}`).join(" "),
      [allScreenCorners],
    );
    const rightPolyPoints = useMemo(
      () => allScreenCorners.slice(4, 8).map((p) => `${p.x},${p.y}`).join(" "),
      [allScreenCorners],
    );

    // 8 PanResponders (one per handle).
    const responders = useMemo(() => {
      return Array.from({ length: 8 }, (_, idx) =>
        PanResponder.create({
          onStartShouldSetPanResponder: () => true,
          onMoveShouldSetPanResponder: () => true,
          onStartShouldSetPanResponderCapture: () => true,
          onMoveShouldSetPanResponderCapture: () => true,
          onPanResponderTerminationRequest: () => false,
          onPanResponderGrant: () => setActiveHandle(idx),
          onPanResponderMove: (_, gs) => {
            const localX = gs.moveX - canvasPageOffset.x;
            const localY = gs.moveY - canvasPageOffset.y;
            const img = screenToImage(localX, localY);
            if (idx < 4) {
              setLeftCorners((prev) => {
                const next = [...prev] as FourCorners;
                next[idx] = img;
                return next;
              });
            } else {
              setRightCorners((prev) => {
                const next = [...prev] as FourCorners;
                next[idx - 4] = img;
                return next;
              });
            }
          },
          onPanResponderRelease: () => setActiveHandle(null),
          onPanResponderTerminate: () => setActiveHandle(null),
        }),
      );
    }, [canvasPageOffset, screenToImage]);

    useImperativeHandle(ref, () => ({
      solve: () => {
        setErr(null);
        const lc = leftCorners.map((c) => ({ u: c.nx * imageWidth, v: c.ny * imageHeight })) as
          [{ u: number; v: number }, { u: number; v: number }, { u: number; v: number }, { u: number; v: number }];
        const rc = rightCorners.map((c) => ({ u: c.nx * imageWidth, v: c.ny * imageHeight })) as
          [{ u: number; v: number }, { u: number; v: number }, { u: number; v: number }, { u: number; v: number }];
        const pose = solveFromBothBoxes(lc, rc);
        if (!pose) {
          setErr("Could not solve pose — try adjusting the corners");
          return null;
        }
        if (pose.fit.rmsPx > 5) {
          setErr(`High reprojection error (${pose.fit.rmsPx.toFixed(1)}px) — corners may need adjustment`);
        }
        return pose;
      },
      reset: () => {
        setLeftCorners(defaultLeftCorners());
        setRightCorners(defaultRightCorners());
        setErr(null);
      },
      getError: () => err,
    }), [leftCorners, rightCorners, imageWidth, imageHeight, err]);

    const labels = [...CORNER_LABELS_L, ...CORNER_LABELS_R];

    return (
      <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
        {/* Wireframe quads */}
        <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
          <Polygon points={leftPolyPoints} fill={LEFT_FILL} stroke={LEFT_COLOR} strokeWidth={2} strokeDasharray="6,4" />
          <Polygon points={rightPolyPoints} fill={RIGHT_FILL} stroke={RIGHT_COLOR} strokeWidth={2} strokeDasharray="6,4" />
        </Svg>

        {/* Corner labels */}
        {allScreenCorners.map((p, i) => {
          const isLeft = i < 4;
          const localIdx = i % 4;
          return (
            <View
              key={`label-${i}`}
              pointerEvents="none"
              style={{
                position: "absolute",
                left: p.x + (localIdx <= 1 ? 12 : -70),
                top: p.y + (localIdx <= 1 ? -18 : 6),
              }}
            >
              <Text style={{ color: isLeft ? LEFT_COLOR : RIGHT_COLOR, fontSize: 8, fontWeight: "600" }}>
                {labels[i]}
              </Text>
            </View>
          );
        })}

        {/* Draggable corner handles */}
        {allScreenCorners.map((p, i) => {
          const isLeft = i < 4;
          const color = isLeft ? LEFT_COLOR : RIGHT_COLOR;
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
                backgroundColor: activeHandle === i ? (isLeft ? "rgba(0,200,255,0.5)" : "rgba(255,150,0,0.5)") : "transparent",
                borderWidth: 2,
                borderColor: color,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: "#fff" }} />
            </View>
          );
        })}

        {/* Error display */}
        {err && (
          <View style={{ position: "absolute", top: 8, left: 8, right: 8, backgroundColor: "rgba(180,30,30,0.85)", paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6 }}>
            <Text style={{ color: "#fff", fontSize: 11 }}>{err}</Text>
          </View>
        )}
      </View>
    );
  },
);
