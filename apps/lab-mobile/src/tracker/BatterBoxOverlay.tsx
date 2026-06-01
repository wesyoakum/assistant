// Batter's box corner-drag overlay for camera pose calibration.
//
// Renders a quadrilateral wireframe over the video frame with 4 draggable
// corner handles. The user adjusts the corners until the overlay matches the
// visible batter's box chalk lines, then taps "Set Pose" to solve the
// ground-plane homography. The parent receives the solved CameraPose.
//
// Corner positions are stored in normalized image coordinates (0–1) so they
// survive layout changes and zoom/pan transforms.

import React, { useCallback, useMemo, useRef, useState } from "react";
import { View, Text, Pressable, StyleSheet, PanResponder, type LayoutChangeEvent } from "react-native";
import Svg, { Polygon, Circle } from "react-native-svg";
import { batterBoxCorners, solveFromBatterBox, type BoxSide, type CameraPose } from "../field/batterBox";

export interface BatterBoxOverlayProps {
  /** Image dimensions in pixels (for aspect ratio and solve). */
  imageWidth: number;
  imageHeight: number;
  /** Current zoom/pan viewport. */
  vp: { scale: number; tx: number; ty: number };
  /** Canvas dimensions in screen coords. */
  canvas: { width: number; height: number };
  /** Page-space offset of the canvas. */
  canvasPageOffset: { x: number; y: number };
  /** Called when the user confirms the pose. */
  onPoseSet: (pose: CameraPose) => void;
  /** Theme colors. */
  theme: { primary: string; text: string; textSubtle: string; surfaceAlt: string; destructive: string; highlight: string; border: string };
}

const HANDLE_RADIUS = 14;
const CORNER_LABELS = ["Front Inside", "Front Outside", "Back Outside", "Back Inside"] as const;

/**
 * Generate sensible default corner positions for the overlay. We place a
 * roughly perspective-foreshortened quadrilateral in the center-bottom area
 * of the frame where a batter's box would typically appear.
 */
function defaultCorners(): [{ nx: number; ny: number }, { nx: number; ny: number }, { nx: number; ny: number }, { nx: number; ny: number }] {
  return [
    { nx: 0.40, ny: 0.55 }, // front inside (closer to plate, toward pitcher)
    { nx: 0.60, ny: 0.55 }, // front outside
    { nx: 0.65, ny: 0.80 }, // back outside (closer to catcher)
    { nx: 0.35, ny: 0.80 }, // back inside
  ];
}

export function BatterBoxOverlay({
  imageWidth,
  imageHeight,
  vp,
  canvas,
  canvasPageOffset,
  onPoseSet,
  theme,
}: BatterBoxOverlayProps) {
  const [corners, setCorners] = useState(defaultCorners);
  const [side, setSide] = useState<BoxSide>("left");
  const [err, setErr] = useState<string | null>(null);
  const [activeCorner, setActiveCorner] = useState<number | null>(null);
  const cornersRef = useRef(corners);
  cornersRef.current = corners;

  // Convert normalized image coord → screen position within the canvas.
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

  // Convert screen position → normalized image coord.
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

  // Screen positions of the 4 corners.
  const screenCorners = useMemo(
    () => corners.map((c) => imageToScreen(c.nx, c.ny)),
    [corners, imageToScreen],
  );

  // SVG polygon points string.
  const polyPoints = useMemo(
    () => screenCorners.map((p) => `${p.x},${p.y}`).join(" "),
    [screenCorners],
  );

  // One PanResponder per corner handle.
  const responders = useMemo(() => {
    return [0, 1, 2, 3].map((idx) =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onStartShouldSetPanResponderCapture: () => true,
        onMoveShouldSetPanResponderCapture: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => {
          setActiveCorner(idx);
        },
        onPanResponderMove: (_, gs) => {
          // gs.moveX/moveY are page coordinates. Convert to canvas-local,
          // then to normalized image coords.
          const localX = gs.moveX - canvasPageOffset.x;
          const localY = gs.moveY - canvasPageOffset.y;
          const img = screenToImage(localX, localY);
          setCorners((prev) => {
            const next = [...prev] as typeof prev;
            next[idx] = img;
            return next;
          });
        },
        onPanResponderRelease: () => setActiveCorner(null),
        onPanResponderTerminate: () => setActiveCorner(null),
      }),
    );
  }, [canvasPageOffset, screenToImage]);

  const solve = () => {
    setErr(null);
    // Convert normalized corners to pixel coordinates for the solver.
    const imageCorners = corners.map((c) => ({
      u: c.nx * imageWidth,
      v: c.ny * imageHeight,
    })) as [{ u: number; v: number }, { u: number; v: number }, { u: number; v: number }, { u: number; v: number }];

    const pose = solveFromBatterBox(imageCorners, side);
    if (!pose) {
      setErr("Could not solve pose — try adjusting the corners");
      return;
    }
    if (pose.fit.rmsPx > 5) {
      setErr(`Warning: high reprojection error (${pose.fit.rmsPx.toFixed(1)}px). Corners may not form a valid perspective rectangle.`);
    }
    onPoseSet(pose);
  };

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {/* Wireframe quadrilateral */}
      <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
        <Polygon
          points={polyPoints}
          fill="rgba(0,200,255,0.08)"
          stroke="rgba(0,200,255,0.9)"
          strokeWidth={2}
          strokeDasharray="6,4"
        />
      </Svg>

      {/* Corner labels (small text near each corner) */}
      {screenCorners.map((p, i) => (
        <View
          key={`label-${i}`}
          pointerEvents="none"
          style={{
            position: "absolute",
            left: p.x + (i <= 1 ? 12 : -80),
            top: p.y + (i <= 1 ? -22 : 8),
          }}
        >
          <Text style={{ color: "rgba(0,200,255,0.9)", fontSize: 9, fontWeight: "600" }}>
            {CORNER_LABELS[i]}
          </Text>
        </View>
      ))}

      {/* Draggable corner handles */}
      {screenCorners.map((p, i) => (
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
            backgroundColor: activeCorner === i ? "rgba(0,200,255,0.5)" : "rgba(0,200,255,0.25)",
            borderWidth: 2,
            borderColor: "rgba(0,200,255,0.9)",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <View
            style={{
              width: 6,
              height: 6,
              borderRadius: 3,
              backgroundColor: "#fff",
            }}
          />
        </View>
      ))}

      {/* Controls at the bottom */}
      <View style={{ position: "absolute", bottom: 8, left: 8, right: 8, gap: 6 }}>
        {err && (
          <View style={{ backgroundColor: "rgba(180,30,30,0.85)", paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6 }}>
            <Text style={{ color: "#fff", fontSize: 11 }}>{err}</Text>
          </View>
        )}
        <View style={{ flexDirection: "row", gap: 6 }}>
          <Pressable
            onPress={() => setSide((s) => (s === "left" ? "right" : "left"))}
            style={[styles.btn, { backgroundColor: theme.surfaceAlt, flex: 1 }]}
          >
            <Text style={[styles.btnText, { color: theme.text }]}>
              {side === "left" ? "Left Box (1B side)" : "Right Box (3B side)"}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setCorners(defaultCorners())}
            style={[styles.btn, { backgroundColor: theme.surfaceAlt }]}
          >
            <Text style={[styles.btnText, { color: theme.text }]}>Reset</Text>
          </Pressable>
        </View>
        <Pressable onPress={solve} style={[styles.btn, { backgroundColor: theme.highlight }]}>
          <Text style={styles.btnText}>Set Pose</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  btn: {
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 8,
    alignItems: "center",
  },
  btnText: {
    color: "#fff",
    fontWeight: "600",
    fontSize: 13,
  },
});
