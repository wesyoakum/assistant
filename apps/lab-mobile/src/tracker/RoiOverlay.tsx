// Region-of-Interest overlay for constraining YOLO detection area.
//
// Renders a draggable rectangle over the video frame with 4 corner handles.
// Controls (Reset, Set ROI) live in the parent TrackerTab.

import React, { useCallback, useMemo, useRef, useState, useImperativeHandle, forwardRef } from "react";
import { View, Text, StyleSheet, PanResponder } from "react-native";
import Svg, { Rect } from "react-native-svg";
import type { NormalizedBox } from "expo-vision-tracker";
import { useTrackerSettings } from "../state/trackerSettings";

export interface RoiOverlayProps {
  imageWidth: number;
  imageHeight: number;
  vp: { scale: number; tx: number; ty: number };
  canvas: { width: number; height: number };
  canvasPageOffset: { x: number; y: number };
}

export interface RoiOverlayHandle {
  getBox: () => NormalizedBox;
  reset: () => void;
}

const HANDLE_SIZE = 24;

function defaultBox(imageWidth: number, imageHeight: number, roiPx: number): { nx: number; ny: number; nw: number; nh: number } {
  const side = Math.min(roiPx / imageWidth, 1);
  const sideY = (side * imageWidth) / imageHeight;
  const nw = Math.min(side, 1);
  const nh = Math.min(sideY, 1);
  return {
    nx: Math.max(0, (1 - nw) / 2),
    ny: Math.max(0, (1 - nh) / 2),
    nw,
    nh,
  };
}

export const RoiOverlay = forwardRef<RoiOverlayHandle, RoiOverlayProps>(
  function RoiOverlay({ imageWidth, imageHeight, vp, canvas, canvasPageOffset }, ref) {
    const { roiSize } = useTrackerSettings();
    const [box, setBox] = useState(() => defaultBox(imageWidth, imageHeight, roiSize));
    const boxRef = useRef(box);
    boxRef.current = box;

    // Compute the actual image display area within the canvas, accounting for
    // aspect ratio mismatch (letterboxing or pillarboxing with resizeMode cover/stretch).
    const imageArea = useMemo(() => {
      const canvasAR = canvas.width / canvas.height;
      const imageAR = imageWidth / imageHeight;
      let w = canvas.width, h = canvas.height, ox = 0, oy = 0;
      if (Math.abs(canvasAR - imageAR) > 0.01) {
        // Canvas doesn't match image AR — compute fitted area.
        if (imageAR > canvasAR) {
          // Image is wider: full width, letterbox top/bottom.
          w = canvas.width;
          h = canvas.width / imageAR;
          oy = (canvas.height - h) / 2;
        } else {
          // Image is taller: full height, pillarbox left/right.
          h = canvas.height;
          w = canvas.height * imageAR;
          ox = (canvas.width - w) / 2;
        }
      }
      return { w, h, ox, oy };
    }, [canvas, imageWidth, imageHeight]);

    const imageToScreen = useCallback(
      (nx: number, ny: number) => {
        const { w, h, ox, oy } = imageArea;
        const cx = canvas.width / 2;
        const cy = canvas.height / 2;
        const px = ox + nx * w;
        const py = oy + ny * h;
        return {
          x: (px - cx) * vp.scale + cx + vp.tx,
          y: (py - cy) * vp.scale + cy + vp.ty,
        };
      },
      [canvas, imageArea, vp],
    );

    const screenToImage = useCallback(
      (sx: number, sy: number) => {
        const { w, h, ox, oy } = imageArea;
        const cx = canvas.width / 2;
        const cy = canvas.height / 2;
        const ix = (sx - cx - vp.tx) / vp.scale + cx;
        const iy = (sy - cy - vp.ty) / vp.scale + cy;
        return {
          nx: Math.max(0, Math.min(1, (ix - ox) / w)),
          ny: Math.max(0, Math.min(1, (iy - oy) / h)),
        };
      },
      [canvas, imageArea, vp],
    );

    const screenBox = useMemo(() => {
      const tl = imageToScreen(box.nx, box.ny);
      const br = imageToScreen(box.nx + box.nw, box.ny + box.nh);
      return { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y };
    }, [box, imageToScreen]);

    const cornerScreenPositions = useMemo(() => [
      { x: screenBox.x, y: screenBox.y },
      { x: screenBox.x + screenBox.w, y: screenBox.y },
      { x: screenBox.x + screenBox.w, y: screenBox.y + screenBox.h },
      { x: screenBox.x, y: screenBox.y + screenBox.h },
    ], [screenBox]);

    const dragRef = useRef<{ corner: number; startBox: typeof box; startPage: { x: number; y: number } } | null>(null);

    const responders = useMemo(() => {
      return [0, 1, 2, 3, -1].map((corner) =>
        PanResponder.create({
          onStartShouldSetPanResponder: () => true,
          onMoveShouldSetPanResponder: () => true,
          onStartShouldSetPanResponderCapture: () => true,
          onMoveShouldSetPanResponderCapture: () => true,
          onPanResponderTerminationRequest: () => true,
          onPanResponderGrant: (_, gs) => {
            dragRef.current = { corner, startBox: { ...boxRef.current }, startPage: { x: gs.x0, y: gs.y0 } };
          },
          onPanResponderMove: (_, gs) => {
            const drag = dragRef.current;
            if (!drag) return;
            const sb = drag.startBox;

            if (corner === -1) {
              const startLocal = { x: drag.startPage.x - canvasPageOffset.x, y: drag.startPage.y - canvasPageOffset.y };
              const curLocal = { x: gs.moveX - canvasPageOffset.x, y: gs.moveY - canvasPageOffset.y };
              const startImg = screenToImage(startLocal.x, startLocal.y);
              const curImg = screenToImage(curLocal.x, curLocal.y);
              const dx = curImg.nx - startImg.nx;
              const dy = curImg.ny - startImg.ny;
              setBox({ nx: Math.max(0, Math.min(1 - sb.nw, sb.nx + dx)), ny: Math.max(0, Math.min(1 - sb.nh, sb.ny + dy)), nw: sb.nw, nh: sb.nh });
              return;
            }

            const localX = gs.moveX - canvasPageOffset.x;
            const localY = gs.moveY - canvasPageOffset.y;
            const img = screenToImage(localX, localY);

            let nx = sb.nx, ny = sb.ny, nw = sb.nw, nh = sb.nh;
            const right = sb.nx + sb.nw;
            const bottom = sb.ny + sb.nh;

            if (corner === 0) { nx = Math.min(img.nx, right - 0.02); ny = Math.min(img.ny, bottom - 0.02); nw = right - nx; nh = bottom - ny; }
            else if (corner === 1) { nw = Math.max(0.02, img.nx - sb.nx); ny = Math.min(img.ny, bottom - 0.02); nh = bottom - ny; }
            else if (corner === 2) { nw = Math.max(0.02, img.nx - sb.nx); nh = Math.max(0.02, img.ny - sb.ny); }
            else if (corner === 3) { nx = Math.min(img.nx, right - 0.02); nw = right - nx; nh = Math.max(0.02, img.ny - sb.ny); }

            setBox({ nx: Math.max(0, nx), ny: Math.max(0, ny), nw: Math.min(1 - Math.max(0, nx), nw), nh: Math.min(1 - Math.max(0, ny), nh) });
          },
          onPanResponderRelease: () => { dragRef.current = null; },
          onPanResponderTerminate: () => { dragRef.current = null; },
        }),
      );
    }, [canvasPageOffset, screenToImage]);

    const roiPixelW = Math.round(box.nw * imageWidth);
    const roiPixelH = Math.round(box.nh * imageHeight);

    useImperativeHandle(ref, () => ({
      getBox: () => ({ x: box.nx, y: box.ny, width: box.nw, height: box.nh }),
      reset: () => setBox(defaultBox(imageWidth, imageHeight, roiSize)),
    }), [box, imageWidth, imageHeight]);

    return (
      <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
        <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
          <Rect x={0} y={0} width="100%" height="100%" fill="rgba(0,0,0,0.4)" />
          <Rect x={screenBox.x} y={screenBox.y} width={screenBox.w} height={screenBox.h}
            fill="rgba(0,0,0,0)" stroke="#FF3B30" strokeWidth={2} />
        </Svg>

        {/* Body drag area */}
        <View {...responders[4]!.panHandlers}
          style={{ position: "absolute", left: screenBox.x + HANDLE_SIZE / 2, top: screenBox.y + HANDLE_SIZE / 2,
            width: Math.max(0, screenBox.w - HANDLE_SIZE), height: Math.max(0, screenBox.h - HANDLE_SIZE) }} />

        {/* Corner handles */}
        {cornerScreenPositions.map((p, i) => (
          <View key={`roi-handle-${i}`} {...responders[i]!.panHandlers}
            style={{ position: "absolute", left: p.x - HANDLE_SIZE / 2, top: p.y - HANDLE_SIZE / 2,
              width: HANDLE_SIZE, height: HANDLE_SIZE, borderRadius: HANDLE_SIZE / 2,
              backgroundColor: "rgba(255,59,48,0.3)", borderWidth: 2, borderColor: "#FF3B30",
              alignItems: "center", justifyContent: "center" }}>
            <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: "#fff" }} />
          </View>
        ))}

        {/* Size label */}
        <View pointerEvents="none"
          style={{ position: "absolute", left: screenBox.x, top: screenBox.y - 20,
            backgroundColor: "rgba(0,0,0,0.7)", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 }}>
          <Text style={{ color: "#FF3B30", fontSize: 10, fontWeight: "600" }}>{roiPixelW}×{roiPixelH}px</Text>
        </View>
      </View>
    );
  },
);
