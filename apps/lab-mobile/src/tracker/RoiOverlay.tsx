// Region-of-Interest overlay for constraining YOLO detection area.
//
// Renders a draggable rectangle over the video frame with 4 corner handles.
// Starts as a square sized to 640px of the video (or fitting the frame if
// the video is smaller). The user drags corners to adjust, then taps
// "Set ROI" to commit.

import React, { useCallback, useMemo, useRef, useState } from "react";
import { View, Text, Pressable, StyleSheet, PanResponder } from "react-native";
import Svg, { Rect } from "react-native-svg";
import type { NormalizedBox } from "expo-vision-tracker";

export interface RoiOverlayProps {
  imageWidth: number;
  imageHeight: number;
  vp: { scale: number; tx: number; ty: number };
  canvas: { width: number; height: number };
  canvasPageOffset: { x: number; y: number };
  onRoiSet: (box: NormalizedBox) => void;
  theme: { primary: string; text: string; textSubtle: string; surfaceAlt: string; highlight: string; border: string };
}

const HANDLE_SIZE = 24;

/** Initial ROI: a centered square covering 640/imageWidth of the frame. */
function defaultBox(imageWidth: number, imageHeight: number): { nx: number; ny: number; nw: number; nh: number } {
  const side = Math.min(640 / imageWidth, 1);
  const sideY = (side * imageWidth) / imageHeight; // keep it square in pixel space
  const nw = Math.min(side, 1);
  const nh = Math.min(sideY, 1);
  return {
    nx: Math.max(0, (1 - nw) / 2),
    ny: Math.max(0, (1 - nh) / 2),
    nw,
    nh,
  };
}

export function RoiOverlay({
  imageWidth,
  imageHeight,
  vp,
  canvas,
  canvasPageOffset,
  onRoiSet,
  theme,
}: RoiOverlayProps) {
  const [box, setBox] = useState(() => defaultBox(imageWidth, imageHeight));
  const boxRef = useRef(box);
  boxRef.current = box;

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

  // Screen-space rectangle
  const screenBox = useMemo(() => {
    const tl = imageToScreen(box.nx, box.ny);
    const br = imageToScreen(box.nx + box.nw, box.ny + box.nh);
    return { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y };
  }, [box, imageToScreen]);

  // Corner positions: [TL, TR, BR, BL]
  const cornerScreenPositions = useMemo(() => [
    { x: screenBox.x, y: screenBox.y },
    { x: screenBox.x + screenBox.w, y: screenBox.y },
    { x: screenBox.x + screenBox.w, y: screenBox.y + screenBox.h },
    { x: screenBox.x, y: screenBox.y + screenBox.h },
  ], [screenBox]);

  // Drag state: which corner (0-3) or body (-1)
  const dragRef = useRef<{ corner: number; startBox: typeof box; startPage: { x: number; y: number } } | null>(null);

  const responders = useMemo(() => {
    // 4 corners + 1 body dragger = 5 responders
    return [0, 1, 2, 3, -1].map((corner) =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onStartShouldSetPanResponderCapture: () => true,
        onMoveShouldSetPanResponderCapture: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (_, gs) => {
          dragRef.current = {
            corner,
            startBox: { ...boxRef.current },
            startPage: { x: gs.x0, y: gs.y0 },
          };
        },
        onPanResponderMove: (_, gs) => {
          const drag = dragRef.current;
          if (!drag) return;
          const sb = drag.startBox;

          if (corner === -1) {
            // Body drag: translate the whole box
            const startLocal = {
              x: drag.startPage.x - canvasPageOffset.x,
              y: drag.startPage.y - canvasPageOffset.y,
            };
            const curLocal = {
              x: gs.moveX - canvasPageOffset.x,
              y: gs.moveY - canvasPageOffset.y,
            };
            const startImg = screenToImage(startLocal.x, startLocal.y);
            const curImg = screenToImage(curLocal.x, curLocal.y);
            const dx = curImg.nx - startImg.nx;
            const dy = curImg.ny - startImg.ny;
            const nx = Math.max(0, Math.min(1 - sb.nw, sb.nx + dx));
            const ny = Math.max(0, Math.min(1 - sb.nh, sb.ny + dy));
            setBox({ nx, ny, nw: sb.nw, nh: sb.nh });
            return;
          }

          // Corner drag: resize the box
          const localX = gs.moveX - canvasPageOffset.x;
          const localY = gs.moveY - canvasPageOffset.y;
          const img = screenToImage(localX, localY);

          let nx = sb.nx, ny = sb.ny, nw = sb.nw, nh = sb.nh;
          const right = sb.nx + sb.nw;
          const bottom = sb.ny + sb.nh;

          if (corner === 0) { // TL
            nx = Math.min(img.nx, right - 0.02);
            ny = Math.min(img.ny, bottom - 0.02);
            nw = right - nx;
            nh = bottom - ny;
          } else if (corner === 1) { // TR
            nw = Math.max(0.02, img.nx - sb.nx);
            ny = Math.min(img.ny, bottom - 0.02);
            nh = bottom - ny;
          } else if (corner === 2) { // BR
            nw = Math.max(0.02, img.nx - sb.nx);
            nh = Math.max(0.02, img.ny - sb.ny);
          } else if (corner === 3) { // BL
            nx = Math.min(img.nx, right - 0.02);
            nw = right - nx;
            nh = Math.max(0.02, img.ny - sb.ny);
          }

          setBox({
            nx: Math.max(0, nx),
            ny: Math.max(0, ny),
            nw: Math.min(1 - Math.max(0, nx), nw),
            nh: Math.min(1 - Math.max(0, ny), nh),
          });
        },
        onPanResponderRelease: () => { dragRef.current = null; },
        onPanResponderTerminate: () => { dragRef.current = null; },
      }),
    );
  }, [canvasPageOffset, screenToImage]);

  // Pixel dimensions of the ROI for display
  const roiPixelW = Math.round(box.nw * imageWidth);
  const roiPixelH = Math.round(box.nh * imageHeight);

  const submit = () => {
    onRoiSet({ x: box.nx, y: box.ny, width: box.nw, height: box.nh });
  };

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {/* Dimmed area outside ROI */}
      <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
        <Rect x={0} y={0} width="100%" height="100%" fill="rgba(0,0,0,0.4)" />
        <Rect
          x={screenBox.x}
          y={screenBox.y}
          width={screenBox.w}
          height={screenBox.h}
          fill="rgba(0,0,0,0)"
          stroke="#FF3B30"
          strokeWidth={2}
          strokeDasharray="8,4"
        />
      </Svg>

      {/* Clear window (punch through the dimming) */}
      <View
        pointerEvents="none"
        style={{
          position: "absolute",
          left: screenBox.x,
          top: screenBox.y,
          width: screenBox.w,
          height: screenBox.h,
          backgroundColor: "transparent",
        }}
      />

      {/* Body drag area */}
      <View
        {...responders[4]!.panHandlers}
        style={{
          position: "absolute",
          left: screenBox.x + HANDLE_SIZE / 2,
          top: screenBox.y + HANDLE_SIZE / 2,
          width: Math.max(0, screenBox.w - HANDLE_SIZE),
          height: Math.max(0, screenBox.h - HANDLE_SIZE),
        }}
      />

      {/* Corner handles */}
      {cornerScreenPositions.map((p, i) => (
        <View
          key={`roi-handle-${i}`}
          {...responders[i]!.panHandlers}
          style={{
            position: "absolute",
            left: p.x - HANDLE_SIZE / 2,
            top: p.y - HANDLE_SIZE / 2,
            width: HANDLE_SIZE,
            height: HANDLE_SIZE,
            borderRadius: HANDLE_SIZE / 2,
            backgroundColor: "rgba(255,59,48,0.3)",
            borderWidth: 2,
            borderColor: "#FF3B30",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: "#fff" }} />
        </View>
      ))}

      {/* Size label */}
      <View
        pointerEvents="none"
        style={{
          position: "absolute",
          left: screenBox.x,
          top: screenBox.y - 20,
          backgroundColor: "rgba(0,0,0,0.7)",
          paddingHorizontal: 6,
          paddingVertical: 2,
          borderRadius: 4,
        }}
      >
        <Text style={{ color: "#FF3B30", fontSize: 10, fontWeight: "600" }}>
          {roiPixelW}×{roiPixelH}px
        </Text>
      </View>

      {/* Controls */}
      <View style={{ position: "absolute", bottom: 8, left: 8, right: 8, gap: 6 }}>
        <View style={{ flexDirection: "row", gap: 6 }}>
          <Pressable
            onPress={() => setBox(defaultBox(imageWidth, imageHeight))}
            style={[styles.btn, { backgroundColor: theme.surfaceAlt, flex: 1 }]}
          >
            <Text style={[styles.btnText, { color: theme.text }]}>Reset</Text>
          </Pressable>
          <Pressable onPress={submit} style={[styles.btn, { backgroundColor: "#FF3B30", flex: 2 }]}>
            <Text style={styles.btnText}>Set ROI</Text>
          </Pressable>
        </View>
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
