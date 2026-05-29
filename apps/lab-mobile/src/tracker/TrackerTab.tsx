import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  Pressable,
  Image,
  StyleSheet,
  ScrollView,
  PanResponder,
  ActivityIndicator,
  type LayoutChangeEvent,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import { VisionTracker, type NormalizedBox, type TrackedFrame, type FirstFrameResult } from "expo-vision-tracker";
import { useTheme } from "../theme";

interface ViewState {
  scale: number;
  tx: number;
  ty: number;
}

const MIN_SCALE = 1;
const MAX_SCALE = 8;

export function TrackerTab() {
  const theme = useTheme();
  const [videoUri, setVideoUri] = useState<string | null>(null);
  const [firstFrame, setFirstFrame] = useState<FirstFrameResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [box, setBox] = useState<NormalizedBox | null>(null);
  const [result, setResult] = useState<{ frames: TrackedFrame[]; elapsedMs: number; videoWidth: number; videoHeight: number; frameRate: number } | null>(null);
  const [reviewIdx, setReviewIdx] = useState(0);

  // Viewport (the user pans + zooms this; box drawing happens in image
  // coordinates, transformed through this).
  const [vp, setVp] = useState<ViewState>({ scale: 1, tx: 0, ty: 0 });
  const vpRef = useRef(vp);
  useEffect(() => { vpRef.current = vp; }, [vp]);

  const [canvas, setCanvas] = useState({ width: 1, height: 1 });
  const canvasRef = useRef(canvas);
  useEffect(() => { canvasRef.current = canvas; }, [canvas]);

  // Gesture state.
  const gestureBase = useRef({ vp, pinchD: 0, pinchMid: { x: 0, y: 0 }, isPinch: false });
  // Drawing state, in screen coords.
  const drawStart = useRef<{ x: number; y: number } | null>(null);
  const [drawingBoxScreen, setDrawingBoxScreen] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  const pickVideo = async () => {
    setErr(null);
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { setErr("Photo library access denied"); return; }
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions?.Videos ?? ("videos" as any),
      videoQuality: 1,
      allowsEditing: false,
      quality: 1,
    });
    if (res.canceled || !res.assets?.length) return;
    const asset = res.assets[0]!;
    setVideoUri(asset.uri);
    setFirstFrame(null);
    setBox(null);
    setResult(null);
    setVp({ scale: 1, tx: 0, ty: 0 });
    setBusy("loading first frame…");
    try {
      const ff = await VisionTracker.firstFrame(asset.uri, 0.85);
      setFirstFrame(ff);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  // Convert a screen-coord point inside the canvas to normalized image coords.
  const screenToImage = (sx: number, sy: number, c = canvasRef.current, v = vpRef.current) => {
    // Image is rendered to fit the canvas at scale 1 with translate (0, 0).
    // After zoom, transform is: translate(tx, ty) scale(s).
    // Inverse: imageNorm = ((screen - canvasCenter - tx) / s + canvasCenter) / canvasSize
    const cx = c.width / 2;
    const cy = c.height / 2;
    const ix = (sx - cx - v.tx) / v.scale + cx;
    const iy = (sy - cy - v.ty) / v.scale + cy;
    return { nx: Math.max(0, Math.min(1, ix / c.width)), ny: Math.max(0, Math.min(1, iy / c.height)) };
  };

  const onCanvasLayout = (e: LayoutChangeEvent) => {
    setCanvas({ width: e.nativeEvent.layout.width || 1, height: e.nativeEvent.layout.height || 1 });
  };

  // Single PanResponder: 1 finger draws a box, 2 fingers pinch+pan.
  const responder = useMemo(() =>
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e, g) => {
        gestureBase.current.vp = vpRef.current;
        const touches = e.nativeEvent.touches;
        if (touches.length >= 2) {
          const t0 = touches[0]!, t1 = touches[1]!;
          gestureBase.current.isPinch = true;
          gestureBase.current.pinchD = Math.max(1, distance(t0.pageX, t0.pageY, t1.pageX, t1.pageY));
          gestureBase.current.pinchMid = { x: (t0.pageX + t1.pageX) / 2, y: (t0.pageY + t1.pageY) / 2 };
          drawStart.current = null;
          setDrawingBoxScreen(null);
        } else {
          gestureBase.current.isPinch = false;
          // 1 finger: start drawing a box. locationX/Y are within the canvas.
          drawStart.current = { x: g.x0 - (e.nativeEvent.touches[0]?.pageX ?? g.x0) + (e.nativeEvent.locationX ?? 0), y: 0 };
          drawStart.current = { x: e.nativeEvent.locationX ?? 0, y: e.nativeEvent.locationY ?? 0 };
          setDrawingBoxScreen({ x: drawStart.current.x, y: drawStart.current.y, w: 0, h: 0 });
        }
      },
      onPanResponderMove: (e, g) => {
        const touches = e.nativeEvent.touches;

        // Promote to pinch if a second finger lands mid-drag.
        if (touches.length >= 2 && !gestureBase.current.isPinch) {
          gestureBase.current.isPinch = true;
          gestureBase.current.vp = vpRef.current;
          const t0 = touches[0]!, t1 = touches[1]!;
          gestureBase.current.pinchD = Math.max(1, distance(t0.pageX, t0.pageY, t1.pageX, t1.pageY));
          gestureBase.current.pinchMid = { x: (t0.pageX + t1.pageX) / 2, y: (t0.pageY + t1.pageY) / 2 };
          drawStart.current = null;
          setDrawingBoxScreen(null);
          return;
        }

        if (gestureBase.current.isPinch && touches.length >= 2) {
          const t0 = touches[0]!, t1 = touches[1]!;
          const curD = Math.max(1, distance(t0.pageX, t0.pageY, t1.pageX, t1.pageY));
          const curMid = { x: (t0.pageX + t1.pageX) / 2, y: (t0.pageY + t1.pageY) / 2 };
          const base = gestureBase.current;
          const newScale = clamp(base.vp.scale * (curD / base.pinchD), MIN_SCALE, MAX_SCALE);
          const newTx = base.vp.tx + (curMid.x - base.pinchMid.x);
          const newTy = base.vp.ty + (curMid.y - base.pinchMid.y);
          setVp({ scale: newScale, tx: newTx, ty: newTy });
          return;
        }

        // 1-finger: drawing box. dx/dy are relative to grant; use locationX/Y on this event.
        if (drawStart.current) {
          const lx = e.nativeEvent.locationX ?? drawStart.current.x;
          const ly = e.nativeEvent.locationY ?? drawStart.current.y;
          const x0 = drawStart.current.x;
          const y0 = drawStart.current.y;
          setDrawingBoxScreen({
            x: Math.min(x0, lx),
            y: Math.min(y0, ly),
            w: Math.abs(lx - x0),
            h: Math.abs(ly - y0),
          });
        }
      },
      onPanResponderRelease: () => {
        if (gestureBase.current.isPinch) {
          // Snap viewport to ensure image stays within reasonable bounds.
          setVp((v) => clampViewport(v, canvasRef.current));
          gestureBase.current.isPinch = false;
          return;
        }
        const bs = drawingBoxScreen;
        if (bs && bs.w > 6 && bs.h > 6) {
          // Convert the screen box into normalized image coords.
          const topLeft = screenToImage(bs.x, bs.y);
          const bottomRight = screenToImage(bs.x + bs.w, bs.y + bs.h);
          const nb: NormalizedBox = {
            x: topLeft.nx,
            y: topLeft.ny,
            width: Math.max(0.005, bottomRight.nx - topLeft.nx),
            height: Math.max(0.005, bottomRight.ny - topLeft.ny),
          };
          setBox(nb);
        }
        setDrawingBoxScreen(null);
        drawStart.current = null;
      },
    }),
  []);

  // Render the committed box on the canvas in screen coords.
  const committedBoxScreen = useMemo(() => {
    if (!box) return null;
    const c = canvas;
    const v = vp;
    const cx = c.width / 2;
    const cy = c.height / 2;
    const toScreen = (nx: number, ny: number) => ({
      x: (nx * c.width - cx) * v.scale + cx + v.tx,
      y: (ny * c.height - cy) * v.scale + cy + v.ty,
    });
    const p0 = toScreen(box.x, box.y);
    const p1 = toScreen(box.x + box.width, box.y + box.height);
    return { x: p0.x, y: p0.y, w: p1.x - p0.x, h: p1.y - p0.y };
  }, [box, vp, canvas]);

  const runTracker = async () => {
    if (!videoUri || !box) return;
    setBusy("tracking…");
    setErr(null);
    try {
      const r = await VisionTracker.trackInVideo(videoUri, box, { sampleStride: 1, maxFrames: 0, confidenceCutoff: 0.05 });
      setResult({ frames: r.frames, elapsedMs: r.elapsedMs, videoWidth: r.videoWidth, videoHeight: r.videoHeight, frameRate: r.frameRate });
      setReviewIdx(0);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const resetViewport = () => setVp({ scale: 1, tx: 0, ty: 0 });

  const reviewedFrame = result?.frames[reviewIdx] ?? null;

  if (!VisionTracker.available()) {
    return (
      <View style={{ padding: 16 }}>
        <Text style={{ color: theme.text }}>expo-vision-tracker native module is not in this build. Rebuild required.</Text>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 12 }}>
      <Text style={{ fontSize: 18, fontWeight: "700", color: theme.text, marginBottom: 6 }}>Vision tracker</Text>
      <Text style={{ fontSize: 12, color: theme.textSubtle, marginBottom: 12 }}>
        Pick a video, draw a box on the object you want to follow, run the tracker. Pinch with two fingers to zoom + pan; one-finger drag draws/replaces the box.
      </Text>

      <View style={{ flexDirection: "row", gap: 8, marginBottom: 8 }}>
        <Pressable onPress={pickVideo} disabled={!!busy} style={[styles.btn, { backgroundColor: theme.primary, opacity: busy ? 0.5 : 1 }]}>
          <Text style={styles.btnText}>{videoUri ? "Pick another video" : "Pick video"}</Text>
        </Pressable>
        {firstFrame && (
          <Pressable onPress={resetViewport} style={[styles.btn, { backgroundColor: theme.surfaceAlt }]}>
            <Text style={[styles.btnText, { color: theme.text }]}>Reset zoom</Text>
          </Pressable>
        )}
      </View>

      {err && (
        <View style={{ padding: 10, backgroundColor: theme.destructive, borderRadius: 8, marginBottom: 8 }}>
          <Text style={{ color: "#fff" }}>{err}</Text>
        </View>
      )}

      {firstFrame && (
        <View
          {...responder.panHandlers}
          onLayout={onCanvasLayout}
          style={{
            aspectRatio: firstFrame.imageWidth / firstFrame.imageHeight,
            backgroundColor: "#000",
            borderRadius: 8,
            overflow: "hidden",
            marginBottom: 8,
          }}
        >
          <Image
            source={{ uri: `data:image/jpeg;base64,${firstFrame.imageBase64}` }}
            style={{
              width: "100%",
              height: "100%",
              transform: [{ translateX: vp.tx }, { translateY: vp.ty }, { scale: vp.scale }],
            }}
            resizeMode="cover"
            fadeDuration={0}
          />
          {/* Committed box */}
          {committedBoxScreen && !drawingBoxScreen && (
            <View
              pointerEvents="none"
              style={{
                position: "absolute",
                left: committedBoxScreen.x,
                top: committedBoxScreen.y,
                width: committedBoxScreen.w,
                height: committedBoxScreen.h,
                borderWidth: 2,
                borderColor: "#FF3B30",
              }}
            />
          )}
          {/* In-progress drawing */}
          {drawingBoxScreen && (
            <View
              pointerEvents="none"
              style={{
                position: "absolute",
                left: drawingBoxScreen.x,
                top: drawingBoxScreen.y,
                width: drawingBoxScreen.w,
                height: drawingBoxScreen.h,
                borderWidth: 2,
                borderColor: "#FFCC00",
              }}
            />
          )}
          {/* Zoom indicator */}
          {vp.scale > 1.01 && (
            <View style={{ position: "absolute", top: 6, left: 8, backgroundColor: "rgba(0,0,0,0.6)", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 }}>
              <Text style={{ color: "#fff", fontSize: 11 }}>{vp.scale.toFixed(1)}×</Text>
            </View>
          )}
        </View>
      )}

      {firstFrame && (
        <View style={{ flexDirection: "row", gap: 8, marginBottom: 8 }}>
          <Pressable
            onPress={runTracker}
            disabled={!box || !!busy}
            style={[styles.btn, { backgroundColor: theme.highlight, opacity: !box || busy ? 0.4 : 1 }]}
          >
            <Text style={styles.btnText}>{busy === "tracking…" ? "Tracking…" : "Run tracker"}</Text>
          </Pressable>
          <Pressable
            onPress={() => { setBox(null); setResult(null); }}
            disabled={!box}
            style={[styles.btn, { backgroundColor: theme.surfaceAlt, opacity: !box ? 0.4 : 1 }]}
          >
            <Text style={[styles.btnText, { color: theme.text }]}>Clear box</Text>
          </Pressable>
        </View>
      )}

      {busy && (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <ActivityIndicator color={theme.primary} />
          <Text style={{ color: theme.textSubtle }}>{busy}</Text>
        </View>
      )}

      {result && (
        <View style={{ marginTop: 6 }}>
          <Text style={{ color: theme.text, fontWeight: "600", marginBottom: 6 }}>
            Tracked {result.frames.length} frames in {result.elapsedMs} ms
            {"  ·  "}
            {result.frameRate > 0 ? `${result.frameRate.toFixed(1)} fps source` : "?"}
          </Text>
          {reviewedFrame && (
            <View style={{ aspectRatio: result.videoWidth / result.videoHeight, backgroundColor: "#111", borderRadius: 8, overflow: "hidden", marginBottom: 8, position: "relative" }}>
              {firstFrame && (
                <Image source={{ uri: `data:image/jpeg;base64,${firstFrame.imageBase64}` }} style={{ width: "100%", height: "100%" }} fadeDuration={0} resizeMode="cover" />
              )}
              {reviewedFrame.box && (
                <View
                  pointerEvents="none"
                  style={{
                    position: "absolute",
                    left: `${reviewedFrame.box.x * 100}%`,
                    top: `${reviewedFrame.box.y * 100}%`,
                    width: `${reviewedFrame.box.width * 100}%`,
                    height: `${reviewedFrame.box.height * 100}%`,
                    borderWidth: 2,
                    borderColor: reviewedFrame.lost ? "#FF3B30" : "#34C759",
                  }}
                />
              )}
              <View style={{ position: "absolute", bottom: 8, left: 8, backgroundColor: "rgba(0,0,0,0.6)", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 }}>
                <Text style={{ color: "#fff", fontSize: 11 }}>
                  frame {reviewIdx + 1}/{result.frames.length}
                  {"  ·  t="}
                  {reviewedFrame.timeSec.toFixed(2)}s
                  {"  ·  conf "}
                  {reviewedFrame.confidence.toFixed(2)}
                </Text>
              </View>
            </View>
          )}
          <View style={{ flexDirection: "row", gap: 6 }}>
            <Pressable onPress={() => setReviewIdx((i) => Math.max(0, i - 1))} disabled={reviewIdx === 0} style={[styles.btn, { backgroundColor: theme.surfaceAlt, flex: 1, opacity: reviewIdx === 0 ? 0.4 : 1 }]}>
              <Text style={[styles.btnText, { color: theme.text }]}>‹ Prev</Text>
            </Pressable>
            <Pressable onPress={() => setReviewIdx((i) => Math.min(result.frames.length - 1, i + 1))} disabled={reviewIdx >= result.frames.length - 1} style={[styles.btn, { backgroundColor: theme.surfaceAlt, flex: 1, opacity: reviewIdx >= result.frames.length - 1 ? 0.4 : 1 }]}>
              <Text style={[styles.btnText, { color: theme.text }]}>Next ›</Text>
            </Pressable>
          </View>
        </View>
      )}
    </ScrollView>
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

function distance(x1: number, y1: number, x2: number, y2: number) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  return Math.sqrt(dx * dx + dy * dy);
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function clampViewport(v: ViewState, c: { width: number; height: number }): ViewState {
  // Keep the image visible: don't let the translate push it entirely off-screen.
  const maxOffsetX = (c.width * (v.scale - 1)) / 2;
  const maxOffsetY = (c.height * (v.scale - 1)) / 2;
  return {
    scale: v.scale,
    tx: clamp(v.tx, -maxOffsetX, maxOffsetX),
    ty: clamp(v.ty, -maxOffsetY, maxOffsetY),
  };
}
