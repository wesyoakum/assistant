import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import * as Clipboard from "expo-clipboard";
import Svg, { Path } from "react-native-svg";
import { VisionTracker, type NormalizedBox, type TrackedFrame, type FirstFrameResult } from "expo-vision-tracker";
import { TemplateTracker } from "expo-template-tracker";
import { TrackNet } from "expo-tracknet";
import { Yolo } from "expo-yolo";
import { Baseball } from "expo-baseball";
import { detectorWalk, type RawDetection } from "./detectorWalk";
import { useTheme } from "../theme";

type TrackerMode = "vision" | "template" | "tracknet" | "blob" | "yolo" | "baseball";

// Modes that detect the ball themselves (no user-drawn box required).
const DETECTOR_MODES: TrackerMode[] = ["tracknet", "blob", "yolo", "baseball"];

const MODE_LABEL: Record<TrackerMode, string> = {
  template: "Template",
  vision: "Apple Vision",
  tracknet: "TrackNet",
  blob: "Blob",
  yolo: "YOLO ball",
  baseball: "Baseball",
};

// Modes shown in the UI. The others stay implemented (and selectable in code)
// but hidden — YOLO ball was the only one that tracked real footage reliably.
// Re-add any here to bring it back; all remain wired in runTracker.
const VISIBLE_MODES: TrackerMode[] = ["yolo"];

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
  const [frame, setFrame] = useState<FirstFrameResult | null>(null);
  const [frameTimeSec, setFrameTimeSec] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [box, setBox] = useState<NormalizedBox | null>(null);
  const [result, setResult] = useState<{ frames: TrackedFrame[]; elapsedMs: number; videoWidth: number; videoHeight: number; frameRate: number; mode: TrackerMode } | null>(null);
  const [reviewIdx, setReviewIdx] = useState(0);
  const [trackerMode, setTrackerMode] = useState<TrackerMode>("yolo");
  const [copyHint, setCopyHint] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playSpeed, setPlaySpeed] = useState<1 | 0.5 | 0.25 | 0.125>(1);

  // Disable parent ScrollView's pan while the user is gesturing on the canvas.
  const [scrollEnabled, setScrollEnabled] = useState(true);

  // Viewport (user-controlled via 2-finger pinch + pan).
  const [vp, setVp] = useState<ViewState>({ scale: 1, tx: 0, ty: 0 });
  const vpRef = useRef(vp);
  useEffect(() => { vpRef.current = vp; }, [vp]);

  // Canvas dimensions in screen coords (after onLayout fires).
  const [canvas, setCanvas] = useState({ width: 1, height: 1 });
  const canvasRef = useRef(canvas);
  useEffect(() => { canvasRef.current = canvas; }, [canvas]);

  // Page-space offset of the canvas. We measure on layout so we can convert
  // PanResponder touch.pageX/Y → canvas-local coords reliably (locationX/Y is
  // unreliable across some gesture transitions).
  const canvasRef2 = useRef<View>(null);
  const canvasPageOffsetRef = useRef({ x: 0, y: 0 });

  // Box-drawing screen-coord rect during a drag.
  const drawStart = useRef<{ x: number; y: number } | null>(null);
  const [drawingBoxScreen, setDrawingBoxScreen] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  const gestureBase = useRef({ vp, pinchD: 0, pinchMid: { x: 0, y: 0 }, isPinch: false });

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
    setFrame(null);
    setFrameTimeSec(0);
    setBox(null);
    setResult(null);
    setVp({ scale: 1, tx: 0, ty: 0 });
    await loadFrame(asset.uri, 0);
  };

  const loadFrame = async (uri: string, timeSec: number) => {
    setBusy("loading frame…");
    setErr(null);
    try {
      const f = timeSec === 0 ? await VisionTracker.firstFrame(uri, 0.85) : await VisionTracker.frameAtTime(uri, timeSec, 0.85);
      setFrame(f);
      setFrameTimeSec(timeSec);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const frameStep = (deltaSec: number) => {
    if (!videoUri || !frame) return;
    const max = Math.max(0, frame.durationSec - (frame.frameRate > 0 ? 1 / frame.frameRate : 0.001));
    const next = Math.max(0, Math.min(max, frameTimeSec + deltaSec));
    // Clear the box: it was drawn relative to the old frame's content, so it
    // would visually stick to that pixel region while a different image loads
    // underneath. Forcing a re-draw on the new frame keeps the user honest.
    setBox(null);
    loadFrame(videoUri, next);
  };

  const frameStepSec = useMemo(() => {
    if (!frame || frame.frameRate <= 0) return 1 / 30;
    return 1 / frame.frameRate;
  }, [frame]);

  // Convert a page-coord point into the canvas's local (0,0)-(width,height) coord
  // space. The PanResponder gives us pageX/pageY consistently; locationX/Y is
  // unreliable when the gesture crosses through other views.
  const pageToLocal = useCallback((pageX: number, pageY: number) => {
    return {
      x: pageX - canvasPageOffsetRef.current.x,
      y: pageY - canvasPageOffsetRef.current.y,
    };
  }, []);

  // Local screen coord → normalized image coord (in the underlying image,
  // accounting for the current zoom + pan).
  const localToImage = useCallback((lx: number, ly: number) => {
    const c = canvasRef.current;
    const v = vpRef.current;
    const cx = c.width / 2;
    const cy = c.height / 2;
    const ix = (lx - cx - v.tx) / v.scale + cx;
    const iy = (ly - cy - v.ty) / v.scale + cy;
    return { nx: Math.max(0, Math.min(1, ix / c.width)), ny: Math.max(0, Math.min(1, iy / c.height)) };
  }, []);

  const onCanvasLayout = (e: LayoutChangeEvent) => {
    setCanvas({ width: e.nativeEvent.layout.width || 1, height: e.nativeEvent.layout.height || 1 });
    // Refresh measureInWindow so the page-offset is accurate. This also fires
    // again whenever the layout changes (scroll position changes don't, so
    // we re-measure on gesture grant too).
    canvasRef2.current?.measureInWindow((x, y) => {
      canvasPageOffsetRef.current = { x, y };
    });
  };

  const remeasure = useCallback(() => {
    canvasRef2.current?.measureInWindow((x, y) => {
      canvasPageOffsetRef.current = { x, y };
    });
  }, []);

  const responder = useMemo(() =>
    PanResponder.create({
      // CRITICAL: capture-phase wins over the parent ScrollView so it doesn't
      // steal the touch and start scrolling.
      onStartShouldSetPanResponderCapture: () => true,
      onMoveShouldSetPanResponderCapture: () => true,
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e) => {
        // Re-measure since scroll position may have changed.
        remeasure();
        // Disable the ScrollView so it doesn't fight us.
        setScrollEnabled(false);

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
          const t0 = touches[0]!;
          const local = pageToLocal(t0.pageX, t0.pageY);
          drawStart.current = { x: local.x, y: local.y };
          setDrawingBoxScreen({ x: local.x, y: local.y, w: 0, h: 0 });
        }
      },
      onPanResponderMove: (e) => {
        const touches = e.nativeEvent.touches;

        // Mid-gesture: a second finger landed → promote to pinch.
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

        // 1-finger drag: extend the drawing box.
        if (drawStart.current && touches.length >= 1) {
          const t0 = touches[0]!;
          const local = pageToLocal(t0.pageX, t0.pageY);
          const x0 = drawStart.current.x;
          const y0 = drawStart.current.y;
          setDrawingBoxScreen({
            x: Math.min(x0, local.x),
            y: Math.min(y0, local.y),
            w: Math.abs(local.x - x0),
            h: Math.abs(local.y - y0),
          });
        }
      },
      onPanResponderRelease: () => {
        setScrollEnabled(true);
        if (gestureBase.current.isPinch) {
          setVp((v) => clampViewport(v, canvasRef.current));
          gestureBase.current.isPinch = false;
          drawStart.current = null;
          return;
        }
        const bs = drawingBoxScreen;
        if (bs && bs.w > 4 && bs.h > 4) {
          const topLeft = localToImage(bs.x, bs.y);
          const bottomRight = localToImage(bs.x + bs.w, bs.y + bs.h);
          const nb: NormalizedBox = {
            x: topLeft.nx,
            y: topLeft.ny,
            width: Math.max(0.003, bottomRight.nx - topLeft.nx),
            height: Math.max(0.003, bottomRight.ny - topLeft.ny),
          };
          setBox(nb);
        }
        setDrawingBoxScreen(null);
        drawStart.current = null;
      },
      onPanResponderTerminate: () => {
        setScrollEnabled(true);
        gestureBase.current.isPinch = false;
        drawStart.current = null;
        setDrawingBoxScreen(null);
      },
    }),
    [remeasure, pageToLocal, localToImage, drawingBoxScreen],
  );

  // Separate responder for the result canvas: pan + pinch only (no box
  // drawing). Reuses the same vp/canvas/gestureBase state and refs since
  // only one of the two canvases is rendered at a time.
  const resultResponder = useMemo(() =>
    PanResponder.create({
      onStartShouldSetPanResponderCapture: () => true,
      onMoveShouldSetPanResponderCapture: () => true,
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e) => {
        remeasure();
        setScrollEnabled(false);
        gestureBase.current.vp = vpRef.current;
        const touches = e.nativeEvent.touches;
        if (touches.length >= 2) {
          const t0 = touches[0]!, t1 = touches[1]!;
          gestureBase.current.isPinch = true;
          gestureBase.current.pinchD = Math.max(1, distance(t0.pageX, t0.pageY, t1.pageX, t1.pageY));
          gestureBase.current.pinchMid = { x: (t0.pageX + t1.pageX) / 2, y: (t0.pageY + t1.pageY) / 2 };
        } else {
          gestureBase.current.isPinch = false;
          const t0 = touches[0]!;
          // Reuse pinchMid as the 1-finger drag anchor for simplicity.
          gestureBase.current.pinchMid = { x: t0.pageX, y: t0.pageY };
        }
      },
      onPanResponderMove: (e) => {
        const touches = e.nativeEvent.touches;
        if (touches.length >= 2 && !gestureBase.current.isPinch) {
          gestureBase.current.isPinch = true;
          gestureBase.current.vp = vpRef.current;
          const t0 = touches[0]!, t1 = touches[1]!;
          gestureBase.current.pinchD = Math.max(1, distance(t0.pageX, t0.pageY, t1.pageX, t1.pageY));
          gestureBase.current.pinchMid = { x: (t0.pageX + t1.pageX) / 2, y: (t0.pageY + t1.pageY) / 2 };
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
        // 1-finger drag → pan (most useful when zoomed in).
        if (touches.length >= 1) {
          const t0 = touches[0]!;
          const base = gestureBase.current;
          setVp({
            scale: base.vp.scale,
            tx: base.vp.tx + (t0.pageX - base.pinchMid.x),
            ty: base.vp.ty + (t0.pageY - base.pinchMid.y),
          });
        }
      },
      onPanResponderRelease: () => {
        setScrollEnabled(true);
        setVp((v) => clampViewport(v, canvasRef.current));
        gestureBase.current.isPinch = false;
      },
      onPanResponderTerminate: () => {
        setScrollEnabled(true);
        gestureBase.current.isPinch = false;
      },
    }),
    [remeasure],
  );

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
    if (!videoUri) return;
    // Detector modes (TrackNet/Blob/YOLO/Baseball) find the ball themselves — no
    // initial box required. Template/Vision need a user-drawn box.
    if (!box && !DETECTOR_MODES.includes(trackerMode)) return;
    setBusy(`tracking (${trackerMode})…`);
    setErr(null);
    try {
      let r: { frames: TrackedFrame[]; videoWidth: number; videoHeight: number; frameRate: number; elapsedMs: number };
      if (trackerMode === "vision") {
        r = await VisionTracker.trackInVideo(videoUri, box!, {
          sampleStride: 1, maxFrames: 0, confidenceCutoff: 0.05, startTimeSec: frameTimeSec,
        });
      } else if (trackerMode === "tracknet") {
        r = await TrackNet.trackInVideo(videoUri, {
          sampleStride: 1, maxFrames: 0, startTimeSec: frameTimeSec, confidenceCutoff: 0.10,
        });
      } else if (trackerMode === "blob") {
        r = await VisionTracker.trackBlobInVideo(videoUri, {
          sampleStride: 1, maxFrames: 0, startTimeSec: frameTimeSec, downsample: 2,
        });
      } else if (trackerMode === "yolo" || trackerMode === "baseball") {
        // JS frame-walk: run the object detector on each frame's JPEG. COCO YOLO
        // is filtered to the ball class; the baseball model emits only baseballs.
        // When the user drew a box, pass it as a region-of-interest to YOLO so
        // Vision crops to that rectangle before running the model — improves
        // small-ball detection (the crop gets upscaled to 640×640) and
        // eliminates false positives outside the box. The returned detections
        // are still in full-image coordinates.
        const roi = box ?? undefined;
        const detect = async (uri: string): Promise<RawDetection[]> => {
          const res = trackerMode === "yolo"
            ? await Yolo.detect(uri, { minConfidence: 0.10, roi })
            : await Baseball.detect(uri, { minConfidence: 0.10 });
          return res.detections.map((d) => ({ label: d.label, confidence: d.confidence, box: d.box }));
        };
        const fps = frame && frame.frameRate > 0 ? frame.frameRate : 30;
        r = await detectorWalk(
          (t, q) => VisionTracker.frameAtTime(videoUri, t, q).then((f) => ({
            imageBase64: f.imageBase64, imageWidth: f.imageWidth, imageHeight: f.imageHeight, frameRate: f.frameRate ?? 0,
          })),
          detect,
          {
            startTimeSec: frameTimeSec,
            stepSec: 1 / fps,
            durationSec: frame?.durationSec ?? 9999,
            maxFrames: 0,
            // Keep walking the whole clip even through long miss streaks —
            // gaps get filled by interpolation downstream, and we don't want
            // to truncate the result early.
            maxMisses: Number.POSITIVE_INFINITY,
            labelFilter: trackerMode === "yolo" ? (l) => l === "sports ball" : undefined,
          },
        );
      } else {
        r = await TemplateTracker.trackInVideo(videoUri, box!, {
          sampleStride: 1, maxFrames: 0, startTimeSec: frameTimeSec,
          confidenceCutoff: 0.15, searchPadding: 3, downsample: 2,
        });
      }
      setResult({ frames: r.frames, elapsedMs: r.elapsedMs, videoWidth: r.videoWidth, videoHeight: r.videoHeight, frameRate: r.frameRate, mode: trackerMode });
      setReviewIdx(0);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const resetViewport = () => setVp({ scale: 1, tx: 0, ty: 0 });
  const zoomBy = (factor: number) =>
    setVp((v) => {
      const newScale = clamp(v.scale * factor, MIN_SCALE, MAX_SCALE);
      // Keep the current pan but rescale it proportionally so the same point
      // stays under the center of the canvas across the zoom step.
      const k = v.scale === 0 ? 1 : newScale / v.scale;
      return clampViewport({ scale: newScale, tx: v.tx * k, ty: v.ty * k }, canvasRef.current);
    });

  // Per-frame box with gaps (lost or null) filled by linear interpolation in
  // time between the nearest real detections. Edges (before the first / after
  // the last real detection) stay null since we have nothing to interpolate
  // against. Aligned 1:1 with result.frames.
  const interpolated = useMemo(() => {
    if (!result) return null;
    return interpolateBoxes(result.frames);
  }, [result]);

  // Smooth Catmull-Rom path through every real detection center, up to and
  // including the current frame. Drawn over the image so the user sees a
  // curve, not just a chain of dots. Interpolated frames are skipped here —
  // the spline already smooths between real detections, which is what the
  // interpolation was approximating anyway.
  const splinePath = useMemo(() => {
    if (!result || !interpolated) return "";
    const pts: Array<{ x: number; y: number }> = [];
    for (let i = 0; i <= reviewIdx && i < result.frames.length; i++) {
      const f = result.frames[i]!;
      if (!f.box || f.lost) continue;
      pts.push({
        x: f.box.x + f.box.width / 2,
        y: f.box.y + f.box.height / 2,
      });
    }
    return catmullRomPath(pts);
  }, [result, interpolated, reviewIdx]);

  // Playback: advance reviewIdx on a timer. Interval is one source-frame
  // duration divided by the current playSpeed (1x = real-time; 1/8x = 8x slower).
  // Frame fetches (frameAtTime) may not keep up at higher speeds — the timer
  // still fires, the image just lags behind. Best-effort; the trail still
  // advances synchronously with the index.
  useEffect(() => {
    if (!isPlaying || !result) return;
    const sourceFrameMs = result.frameRate > 0 ? 1000 / result.frameRate : 33;
    const intervalMs = Math.max(16, sourceFrameMs / playSpeed);
    const id = setInterval(() => {
      setReviewIdx((i) => {
        if (i + 1 >= result.frames.length) {
          setIsPlaying(false);
          return i;
        }
        return i + 1;
      });
    }, intervalMs);
    return () => clearInterval(id);
  }, [isPlaying, playSpeed, result]);

  const copyTrace = async () => {
    if (!result) return;
    const interp = interpolated ?? [];
    const trace = {
      schema: "whyapp.tracker.trace/v2",
      capturedAt: new Date().toISOString(),
      mode: result.mode,
      videoWidth: result.videoWidth,
      videoHeight: result.videoHeight,
      frameRate: result.frameRate,
      elapsedMs: result.elapsedMs,
      startTimeSec: frameTimeSec,
      initialBox: box,
      frames: result.frames.map((f, i) => {
        const ip = interp[i];
        const interpBox = ip?.interpolated && ip.box ? ip.box : null;
        return {
          t: Number(f.timeSec.toFixed(4)),
          box: f.box
            ? {
                x: Number(f.box.x.toFixed(5)),
                y: Number(f.box.y.toFixed(5)),
                w: Number(f.box.width.toFixed(5)),
                h: Number(f.box.height.toFixed(5)),
              }
            : null,
          c: Number(f.confidence.toFixed(3)),
          lost: !!f.lost,
          ...(interpBox && {
            ibox: {
              x: Number(interpBox.x.toFixed(5)),
              y: Number(interpBox.y.toFixed(5)),
              w: Number(interpBox.width.toFixed(5)),
              h: Number(interpBox.height.toFixed(5)),
            },
          }),
        };
      }),
    };
    const json = JSON.stringify(trace);
    await Clipboard.setStringAsync(json);
    setCopyHint(`Copied ${(json.length / 1024).toFixed(1)} KB — paste into chat`);
    setTimeout(() => setCopyHint(null), 3000);
  };

  const reviewedFrame = result?.frames[reviewIdx] ?? null;

  // Review section: load the actual frame at the reviewed timestamp instead
  // of showing the initial still under every tracker result.
  const [reviewImage, setReviewImage] = useState<{ base64: string; timeSec: number } | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  useEffect(() => {
    if (!result || !videoUri || !reviewedFrame) {
      setReviewImage(null);
      setReviewError(null);
      return;
    }
    const t = reviewedFrame.timeSec;
    let cancelled = false;
    setReviewLoading(true);
    setReviewError(null);
    VisionTracker.frameAtTime(videoUri, t, 0.75)
      .then((f) => {
        if (cancelled) return;
        setReviewImage({ base64: f.imageBase64, timeSec: t });
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setReviewError(`frameAtTime(${t.toFixed(3)}s) failed: ${e.message}`);
      })
      .finally(() => {
        if (!cancelled) setReviewLoading(false);
      });
    return () => { cancelled = true; };
  }, [reviewIdx, result, videoUri, reviewedFrame?.timeSec]);

  if (!VisionTracker.available()) {
    return (
      <View style={{ padding: 16 }}>
        <Text style={{ color: theme.text }}>expo-vision-tracker native module is not in this build. Rebuild required.</Text>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 12 }} scrollEnabled={scrollEnabled}>
      <Text style={{ fontSize: 18, fontWeight: "700", color: theme.text, marginBottom: 6 }}>Vision tracker</Text>
      <Text style={{ fontSize: 12, color: theme.textSubtle, marginBottom: 12 }}>
        Pick a video, step to a frame where the ball is visible, pinch + pan to zoom, drag with one finger to draw the initial box, run the tracker.
      </Text>

      <View style={{ flexDirection: "row", gap: 8, marginBottom: 8 }}>
        <Pressable onPress={pickVideo} disabled={!!busy} style={[styles.btn, { backgroundColor: theme.primary, opacity: busy ? 0.5 : 1 }]}>
          <Text style={styles.btnText}>{videoUri ? "Pick another video" : "Pick video"}</Text>
        </Pressable>
        {frame && (
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

      {!result && frame && (
        <View
          ref={canvasRef2}
          {...responder.panHandlers}
          onLayout={onCanvasLayout}
          style={{
            aspectRatio: frame.imageWidth / frame.imageHeight,
            backgroundColor: "#000",
            borderRadius: 8,
            overflow: "hidden",
            marginBottom: 8,
          }}
        >
          <Image
            source={{ uri: `data:image/jpeg;base64,${frame.imageBase64}` }}
            style={{
              width: "100%",
              height: "100%",
              transform: [{ translateX: vp.tx }, { translateY: vp.ty }, { scale: vp.scale }],
            }}
            resizeMode="cover"
            fadeDuration={0}
          />
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
          {vp.scale > 1.01 && (
            <View style={{ position: "absolute", top: 6, left: 8, backgroundColor: "rgba(0,0,0,0.6)", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 }}>
              <Text style={{ color: "#fff", fontSize: 11 }}>{vp.scale.toFixed(1)}×</Text>
            </View>
          )}
          <View style={{ position: "absolute", bottom: 6, left: 8, backgroundColor: "rgba(0,0,0,0.6)", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 }}>
            <Text style={{ color: "#fff", fontSize: 11 }}>
              {frameTimeSec.toFixed(3)}s / {frame.durationSec.toFixed(2)}s
              {frame.frameRate > 0 ? `  ·  ${frame.frameRate.toFixed(1)} fps` : ""}
            </Text>
          </View>
        </View>
      )}

      {!result && frame && (
        <View style={{ flexDirection: "row", gap: 6, marginBottom: 8 }}>
          <Pressable onPress={() => frameStep(-1)} disabled={!!busy} style={[styles.btn, { backgroundColor: theme.surfaceAlt, flex: 1 }]}>
            <Text style={[styles.btnText, { color: theme.text }]}>«1s</Text>
          </Pressable>
          <Pressable onPress={() => frameStep(-frameStepSec)} disabled={!!busy} style={[styles.btn, { backgroundColor: theme.surfaceAlt, flex: 1 }]}>
            <Text style={[styles.btnText, { color: theme.text }]}>‹ frame</Text>
          </Pressable>
          <Pressable onPress={() => frameStep(frameStepSec)} disabled={!!busy} style={[styles.btn, { backgroundColor: theme.surfaceAlt, flex: 1 }]}>
            <Text style={[styles.btnText, { color: theme.text }]}>frame ›</Text>
          </Pressable>
          <Pressable onPress={() => frameStep(1)} disabled={!!busy} style={[styles.btn, { backgroundColor: theme.surfaceAlt, flex: 1 }]}>
            <Text style={[styles.btnText, { color: theme.text }]}>1s»</Text>
          </Pressable>
        </View>
      )}

      {!result && frame && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 6 }}>
          {VISIBLE_MODES.map((m) => (
            <Pressable
              key={m}
              onPress={() => setTrackerMode(m)}
              style={[
                styles.btn,
                {
                  minWidth: "31%",
                  flexGrow: 1,
                  backgroundColor: trackerMode === m ? theme.primary : theme.surfaceAlt,
                  borderWidth: trackerMode === m ? 0 : StyleSheet.hairlineWidth,
                  borderColor: theme.border,
                },
              ]}
            >
              <Text style={[styles.btnText, { color: trackerMode === m ? "#fff" : theme.text }]}>
                {MODE_LABEL[m]}
              </Text>
            </Pressable>
          ))}
        </View>
      )}

      {!result && frame && (
        <View style={{ flexDirection: "row", gap: 8, marginBottom: 8 }}>
          <Pressable
            onPress={runTracker}
            disabled={(!box && !DETECTOR_MODES.includes(trackerMode)) || !!busy}
            style={[styles.btn, { backgroundColor: theme.highlight, opacity: (!box && !DETECTOR_MODES.includes(trackerMode)) || busy ? 0.4 : 1 }]}
          >
            <Text style={styles.btnText}>{busy?.startsWith("tracking") ? "Tracking…" : `Run ${MODE_LABEL[trackerMode]}`}</Text>
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
            [{MODE_LABEL[result.mode]}] tracked {result.frames.length} frames in {result.elapsedMs} ms
            {"  ·  "}
            {result.frameRate > 0 ? `${result.frameRate.toFixed(1)} fps source` : "?"}
          </Text>
          {reviewedFrame && (
            <View
              ref={canvasRef2}
              {...resultResponder.panHandlers}
              onLayout={onCanvasLayout}
              style={{ aspectRatio: result.videoWidth / result.videoHeight, backgroundColor: "#111", borderRadius: 8, overflow: "hidden", marginBottom: 8, position: "relative" }}
            >
              {/* Image + overlays are wrapped in a transformed View so they
                  pan and zoom together. Stroke width of the spline stays
                  constant via vectorEffect="non-scaling-stroke". */}
              <View
                pointerEvents="none"
                style={{
                  position: "absolute",
                  left: 0,
                  top: 0,
                  right: 0,
                  bottom: 0,
                  transform: [{ translateX: vp.tx }, { translateY: vp.ty }, { scale: vp.scale }],
                }}
              >
                {reviewImage && (
                  <Image
                    source={{ uri: `data:image/jpeg;base64,${reviewImage.base64}` }}
                    style={{ width: "100%", height: "100%" }}
                    fadeDuration={0}
                    resizeMode="cover"
                  />
                )}
                {splinePath !== "" && (
                  <Svg
                    style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0 }}
                    viewBox="0 0 1 1"
                    preserveAspectRatio="none"
                  >
                    <Path
                      d={splinePath}
                      stroke="rgba(0,200,255,0.95)"
                      strokeWidth={2}
                      fill="none"
                      vectorEffect="non-scaling-stroke"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </Svg>
                )}
                {interpolated?.slice(0, reviewIdx).map((p, i) => {
                  if (!p.box) return null;
                  const cx = p.box.x + p.box.width / 2;
                  const cy = p.box.y + p.box.height / 2;
                  const denom = Math.max(1, reviewIdx - 1);
                  const alpha = 0.25 + (i / denom) * 0.7;
                  if (p.interpolated) {
                    return (
                      <View
                        key={`trail-${i}`}
                        pointerEvents="none"
                        style={{
                          position: "absolute",
                          left: `${cx * 100}%`,
                          top: `${cy * 100}%`,
                          width: 6,
                          height: 6,
                          marginLeft: -3,
                          marginTop: -3,
                          borderRadius: 3,
                          borderWidth: 1,
                          borderColor: `rgba(255,204,0,${alpha})`,
                          backgroundColor: "transparent",
                        }}
                      />
                    );
                  }
                  return (
                    <View
                      key={`trail-${i}`}
                      pointerEvents="none"
                      style={{
                        position: "absolute",
                        left: `${cx * 100}%`,
                        top: `${cy * 100}%`,
                        width: 8,
                        height: 8,
                        marginLeft: -4,
                        marginTop: -4,
                        borderRadius: 4,
                        backgroundColor: `rgba(255,204,0,${alpha})`,
                      }}
                    />
                  );
                })}
                {(() => {
                  const cur = interpolated?.[reviewIdx];
                  if (!cur?.box) return null;
                  const isInterp = cur.interpolated;
                  return (
                    <View
                      pointerEvents="none"
                      style={{
                        position: "absolute",
                        left: `${cur.box.x * 100}%`,
                        top: `${cur.box.y * 100}%`,
                        width: `${cur.box.width * 100}%`,
                        height: `${cur.box.height * 100}%`,
                        borderWidth: 2,
                        borderColor: isInterp ? "#FF9500" : "#34C759",
                        borderStyle: isInterp ? "dashed" : "solid",
                      }}
                    />
                  );
                })()}
              </View>
              {/* Overlays OUTSIDE the transformed wrapper — stay readable
                  regardless of zoom level. */}
              {reviewLoading && (
                <View style={{ position: "absolute", top: 8, right: 8, backgroundColor: "rgba(0,0,0,0.55)", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 }}>
                  <Text style={{ color: "#fff", fontSize: 10 }}>
                    loading t={reviewedFrame?.timeSec.toFixed(3)}s
                  </Text>
                </View>
              )}
              {reviewError && (
                <View style={{ position: "absolute", top: 8, left: 8, right: 8, backgroundColor: "rgba(180,30,30,0.85)", paddingHorizontal: 8, paddingVertical: 6, borderRadius: 6 }}>
                  <Text style={{ color: "#fff", fontSize: 10 }} numberOfLines={3}>{reviewError}</Text>
                </View>
              )}
              {!reviewImage && !reviewLoading && !reviewError && reviewedFrame && (
                <View style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center" }}>
                  <Text style={{ color: "#bbb", fontSize: 11 }}>(loading frame…)</Text>
                </View>
              )}
              {vp.scale > 1.01 && (
                <View style={{ position: "absolute", top: 6, left: 8, backgroundColor: "rgba(0,0,0,0.6)", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 }}>
                  <Text style={{ color: "#fff", fontSize: 11 }}>{vp.scale.toFixed(1)}×</Text>
                </View>
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
          <View style={{ flexDirection: "row", gap: 6, marginBottom: 6 }}>
            <Pressable
              onPress={() => setReviewIdx(0)}
              disabled={reviewIdx === 0}
              style={[styles.btn, { backgroundColor: theme.surfaceAlt, flex: 1, opacity: reviewIdx === 0 ? 0.4 : 1 }]}
            >
              <Text style={[styles.btnText, { color: theme.text }]}>⏮ Start</Text>
            </Pressable>
            <Pressable
              onPress={() => { setIsPlaying(false); setReviewIdx((i) => Math.max(0, i - 1)); }}
              disabled={reviewIdx === 0}
              style={[styles.btn, { backgroundColor: theme.surfaceAlt, flex: 1, opacity: reviewIdx === 0 ? 0.4 : 1 }]}
            >
              <Text style={[styles.btnText, { color: theme.text }]}>‹ Frame</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                if (reviewIdx >= result.frames.length - 1) {
                  setReviewIdx(0);
                }
                setIsPlaying((p) => !p);
              }}
              style={[styles.btn, { backgroundColor: theme.primary, flex: 1.4 }]}
            >
              <Text style={styles.btnText}>{isPlaying ? "⏸ Pause" : "▶ Play"}</Text>
            </Pressable>
            <Pressable
              onPress={() => { setIsPlaying(false); setReviewIdx((i) => Math.min(result.frames.length - 1, i + 1)); }}
              disabled={reviewIdx >= result.frames.length - 1}
              style={[styles.btn, { backgroundColor: theme.surfaceAlt, flex: 1, opacity: reviewIdx >= result.frames.length - 1 ? 0.4 : 1 }]}
            >
              <Text style={[styles.btnText, { color: theme.text }]}>Frame ›</Text>
            </Pressable>
          </View>
          <View style={{ flexDirection: "row", gap: 6, marginBottom: 6 }}>
            {([1, 0.5, 0.25, 0.125] as const).map((s) => (
              <Pressable
                key={s}
                onPress={() => setPlaySpeed(s)}
                style={[
                  styles.btn,
                  {
                    flex: 1,
                    backgroundColor: playSpeed === s ? theme.primary : theme.surfaceAlt,
                    borderWidth: playSpeed === s ? 0 : StyleSheet.hairlineWidth,
                    borderColor: theme.border,
                  },
                ]}
              >
                <Text style={[styles.btnText, { color: playSpeed === s ? "#fff" : theme.text }]}>
                  {s === 1 ? "1×" : s === 0.5 ? "½×" : s === 0.25 ? "¼×" : "⅛×"}
                </Text>
              </Pressable>
            ))}
          </View>
          <View style={{ flexDirection: "row", gap: 6, marginBottom: 6 }}>
            <Pressable
              onPress={() => zoomBy(1 / 1.5)}
              disabled={vp.scale <= MIN_SCALE + 0.001}
              style={[styles.btn, { backgroundColor: theme.surfaceAlt, flex: 1, opacity: vp.scale <= MIN_SCALE + 0.001 ? 0.4 : 1 }]}
            >
              <Text style={[styles.btnText, { color: theme.text }]}>− Zoom</Text>
            </Pressable>
            <Pressable
              onPress={resetViewport}
              disabled={vp.scale <= MIN_SCALE + 0.001 && vp.tx === 0 && vp.ty === 0}
              style={[styles.btn, { backgroundColor: theme.surfaceAlt, flex: 1, opacity: vp.scale <= MIN_SCALE + 0.001 && vp.tx === 0 && vp.ty === 0 ? 0.4 : 1 }]}
            >
              <Text style={[styles.btnText, { color: theme.text }]}>Reset zoom</Text>
            </Pressable>
            <Pressable
              onPress={() => zoomBy(1.5)}
              disabled={vp.scale >= MAX_SCALE - 0.001}
              style={[styles.btn, { backgroundColor: theme.surfaceAlt, flex: 1, opacity: vp.scale >= MAX_SCALE - 0.001 ? 0.4 : 1 }]}
            >
              <Text style={[styles.btnText, { color: theme.text }]}>+ Zoom</Text>
            </Pressable>
          </View>
          <View style={{ flexDirection: "row", gap: 6 }}>
            <Pressable onPress={copyTrace} style={[styles.btn, { backgroundColor: theme.surfaceAlt, flex: 1 }]}>
              <Text style={[styles.btnText, { color: theme.text }]}>Copy trace</Text>
            </Pressable>
            <Pressable
              onPress={() => { setIsPlaying(false); setResult(null); setReviewIdx(0); setVp({ scale: 1, tx: 0, ty: 0 }); }}
              style={[styles.btn, { backgroundColor: theme.surfaceAlt, flex: 1 }]}
            >
              <Text style={[styles.btnText, { color: theme.text }]}>New tracking</Text>
            </Pressable>
          </View>
          {copyHint && (
            <Text style={{ color: theme.textSubtle, fontSize: 11, marginTop: 6, textAlign: "center" }}>{copyHint}</Text>
          )}
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
  const maxOffsetX = (c.width * (v.scale - 1)) / 2;
  const maxOffsetY = (c.height * (v.scale - 1)) / 2;
  return {
    scale: v.scale,
    tx: clamp(v.tx, -maxOffsetX, maxOffsetX),
    ty: clamp(v.ty, -maxOffsetY, maxOffsetY),
  };
}

// Build an SVG path d-string from a Catmull-Rom spline through the given
// points, converted to cubic-bezier segments. Endpoints are duplicated so
// the curve passes through the first and last points cleanly. Output uses
// the same coordinate system as the input (the caller picks the viewBox).
function catmullRomPath(points: Array<{ x: number; y: number }>): string {
  if (points.length === 0) return "";
  if (points.length === 1) {
    // A degenerate "path" — a tiny dot via M then a zero-length line.
    return `M ${points[0]!.x} ${points[0]!.y}`;
  }
  let d = `M ${points[0]!.x} ${points[0]!.y}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[Math.min(points.length - 1, i + 2)]!;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2.x} ${p2.y}`;
  }
  return d;
}

// For each frame, return either the real detection (cloned) or, when the
// detection is missing/lost, a linearly-interpolated box between the nearest
// real detections on either side. Edges (no detection before/after) return
// null. The `interpolated` flag distinguishes filled gaps from real boxes.
function interpolateBoxes(
  frames: TrackedFrame[],
): Array<{ box: NormalizedBox | null; interpolated: boolean }> {
  const out: Array<{ box: NormalizedBox | null; interpolated: boolean }> = frames.map((f) => ({
    box: f.box && !f.lost ? { ...f.box } : null,
    interpolated: false,
  }));
  let i = 0;
  while (i < out.length) {
    if (out[i]!.box) { i++; continue; }
    let prev = i - 1;
    while (prev >= 0 && !out[prev]!.box) prev--;
    let next = i;
    while (next < out.length && !out[next]!.box) next++;
    if (prev < 0 || next >= out.length) {
      // Can't bracket this gap — leave null and skip past it.
      i = next;
      continue;
    }
    const bPrev = out[prev]!.box!;
    const bNext = out[next]!.box!;
    const tPrev = frames[prev]!.timeSec;
    const tNext = frames[next]!.timeSec;
    const dt = tNext - tPrev;
    for (let k = prev + 1; k < next; k++) {
      const u = dt > 0 ? (frames[k]!.timeSec - tPrev) / dt : (k - prev) / (next - prev);
      out[k] = {
        box: {
          x: bPrev.x + (bNext.x - bPrev.x) * u,
          y: bPrev.y + (bNext.y - bPrev.y) * u,
          width: bPrev.width + (bNext.width - bPrev.width) * u,
          height: bPrev.height + (bNext.height - bPrev.height) * u,
        },
        interpolated: true,
      };
    }
    i = next;
  }
  return out;
}
