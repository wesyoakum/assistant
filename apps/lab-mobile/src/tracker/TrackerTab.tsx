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
  Modal,
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
import { BatterBoxOverlay, type BatterBoxOverlayHandle } from "./BatterBoxOverlay";
import { ThreeDPoseOverlay } from "./ThreeDPoseOverlay";
import { RoiOverlay, type RoiOverlayHandle } from "./RoiOverlay";
import { type CameraPose } from "../field/batterBox";
import { decomposeCameraPose, intrinsicsFromFov, type CameraIntrinsics } from "../field/cameraPoseDecompose";
import { fieldToUser, formatXYZ } from "../field/userCoords";
import { computeBallDirection, type BallDirection } from "../field/ballAngles";
import { apiFetch } from "../api/client";
import type { TrackerSession } from "./session";
import { rejectOutliers } from "./outlierRejection";
import { useTrackerSettings } from "../state/trackerSettings";
import { computeRayInfo, type RayInfo } from "../field/rayTrace";
import { listSavedVideos, saveVideo, deleteSavedVideo, type SavedVideo } from "./savedVideos";
import { useOrientation } from "../hooks/useOrientation";
import { useNavigation } from "expo-router";
import { useTheme } from "../theme";

type TrackerMode = "vision" | "template" | "tracknet" | "blob" | "yolo" | "yolo-s" | "yolo-m" | "yolo-l" | "yolo-x" | "baseball";

// Modes that detect the ball themselves (no user-drawn box required).
const DETECTOR_MODES: TrackerMode[] = ["tracknet", "blob", "yolo", "yolo-s", "yolo-m", "yolo-l", "yolo-x", "baseball"];

const MODE_LABEL: Record<TrackerMode, string> = {
  template: "Template",
  vision: "Apple Vision",
  tracknet: "TrackNet",
  blob: "Blob",
  yolo: "YOLO26n",
  "yolo-s": "YOLO26s",
  "yolo-m": "YOLO26m",
  "yolo-l": "YOLO26l",
  "yolo-x": "YOLO26x",
  baseball: "Baseball",
};

const YOLO_MODEL_NAME: Record<string, string> = {
  "yolo": "YOLO26n",
  "yolo-s": "YOLO26s",
  "yolo-m": "YOLO26m",
  "yolo-l": "YOLO26l",
  "yolo-x": "YOLO26x",
};

// All modes available for selection.
const ALL_MODES: TrackerMode[] = ["yolo", "yolo-s", "yolo-m", "yolo-l", "yolo-x", "baseball", "blob", "tracknet", "vision", "template"];
const BOX_COLOR_TEXT = "rgba(0,200,255,1)";

interface ViewState {
  scale: number;
  tx: number;
  ty: number;
}

const MIN_SCALE = 1;
const MAX_SCALE = 8;

/** Displays a preprocessed (grayscale + contrast) version of a frame. */
function ProcessedImage({ base64 }: { base64: string }) {
  const { contrastLevel } = useTrackerSettings();
  const [processed, setProcessed] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    VisionTracker.preprocessFrame(base64, contrastLevel, 0.85)
      .then((p) => { if (!cancelled) setProcessed(p); })
      .catch(() => { if (!cancelled) setProcessed(null); });
    return () => { cancelled = true; };
  }, [base64, contrastLevel]);
  if (!processed) return null;
  return (
    <Image
      source={{ uri: `data:image/jpeg;base64,${processed}` }}
      style={{ width: "100%", height: "100%" }}
      fadeDuration={0}
      resizeMode="cover"
    />
  );
}

export function TrackerTab() {
  const theme = useTheme();
  const orientation = useOrientation();
  const navigation = useNavigation();
  const isLandscape = orientation === "landscape";

  // In landscape, hide header + tab bar for more screen space.
  useEffect(() => {
    const parent = navigation.getParent();
    if (isLandscape) {
      navigation.setOptions({ headerShown: false });
      parent?.setOptions({ tabBarStyle: { display: "none" } });
    } else {
      navigation.setOptions({ headerShown: true });
      parent?.setOptions({ tabBarStyle: undefined });
    }
  }, [isLandscape, navigation]);
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
  const [savedVideos, setSavedVideos] = useState<SavedVideo[]>([]);
  const [isSaved, setIsSaved] = useState(false);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [savedViewUrl, setSavedViewUrl] = useState<string | null>(null);
  const [showProcessed, setShowProcessed] = useState(false);
  const { preprocessBW, contrastLevel, outlierRejection, outlierThreshold, basepathFt, calibrationMode } = useTrackerSettings();
  const [showPoseOverlay, setShowPoseOverlay] = useState(false);
  const [cameraPose, setCameraPose] = useState<CameraPose | null>(null);
  const [cameraXYZ, setCameraXYZ] = useState<{ x: number; y: number; z: number } | null>(null);
  const [cameraAngles, setCameraAngles] = useState<{ panDeg: number; tiltDeg: number; rollDeg: number } | null>(null);
  const [showRoiOverlay, setShowRoiOverlay] = useState(false);
  const [startTimeSec, setStartTimeSec] = useState<number | null>(null);
  const [endTimeSec, setEndTimeSec] = useState<number | null>(null);
  const poseOverlayRef = useRef<BatterBoxOverlayHandle>(null);
  const landmarkRef = useRef<BatterBoxOverlayHandle>(null);
  const camera3dRef = useRef<BatterBoxOverlayHandle>(null);
  const prevCalibMode = useRef(calibrationMode);
  const roiOverlayRef = useRef<RoiOverlayHandle>(null);
  // Refs so the PanResponder (memoized) can read overlay state without re-creating.
  const showPoseOverlayRef = useRef(false);
  const showRoiOverlayRef = useRef(false);
  useEffect(() => { showPoseOverlayRef.current = showPoseOverlay; }, [showPoseOverlay]);

  // Transfer calibration state when switching modes.
  useEffect(() => {
    if (prevCalibMode.current === calibrationMode) return;
    const from = prevCalibMode.current;
    prevCalibMode.current = calibrationMode;

    if (!cameraPose || !frame) return;

    // Give the new overlay time to mount before transferring state.
    setTimeout(() => {
      if (from === "camera3d" && calibrationMode === "landmarks") {
        // 3D Camera → Landmarks: project all landmarks through H to set handle positions.
        const { fieldToImage } = require("../field/videoHomography");
        const LANDMARKS = require("./BatterBoxOverlay").default?.LANDMARKS;
        // Use fieldToImage to project each landmark
        const positions: Record<string, { nx: number; ny: number }> = {};
        const anchored: Record<string, boolean> = {};
        const allIds = ["apex", "lfo", "rfo", "rbo", "lbo", "lfi", "lbi", "rfi", "rbi", "1b", "2b", "3b"];
        const { allEightCorners, outerCorners } = require("../field/batterBox");
        const { fieldLandmarks } = require("../field/fieldTemplate");
        const oc = outerCorners();
        const boxes = allEightCorners();
        const lm = fieldLandmarks("littleLeague");
        const fieldPts: Record<string, { x: number; z: number }> = {
          apex: { x: 0, z: 0 }, lfo: oc.leftFrontOut, rfo: oc.rightFrontOut,
          rbo: oc.rightBackOut, lbo: oc.leftBackOut,
          lfi: boxes.left[0], lbi: boxes.left[3], rfi: boxes.right[0], rbi: boxes.right[3],
          "1b": lm.first_base, "2b": lm.second_base, "3b": lm.third_base,
        };
        for (const id of allIds) {
          const fp = fieldPts[id];
          if (!fp) continue;
          const img = fieldToImage(cameraPose.fit.H, fp);
          if (img) {
            positions[id] = { nx: img.x / frame.imageWidth, ny: img.y / frame.imageHeight };
          }
        }
        // Anchor the 4 outer corners
        anchored["lfo"] = true; anchored["rfo"] = true; anchored["rbo"] = true; anchored["lbo"] = true;
        landmarkRef.current?.setState?.({ positions, anchored });
      } else if (from === "landmarks" && calibrationMode === "camera3d") {
        // Landmarks → 3D Camera: decompose H to get camera position.
        if (cameraXYZ) {
          const focusY = Math.abs(cameraXYZ.y) * 0.4; // focus partway toward 2B
          camera3dRef.current?.setState?.({
            positions: {
              camPos: { x: cameraXYZ.x, y: cameraXYZ.y, z: cameraXYZ.z },
              focusPos: { x: 0, y: Math.max(2, focusY), z: 0 },
            } as any,
            anchored: {},
          });
        }
      }
    }, 150);
  }, [calibrationMode, cameraPose, cameraXYZ, frame]);
  useEffect(() => { showRoiOverlayRef.current = showRoiOverlay; }, [showRoiOverlay]);

  // Load saved videos on mount.
  useEffect(() => { listSavedVideos().then(setSavedVideos).catch(() => {}); }, []);

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
    loadVideo(asset.uri);
  };

  const loadVideo = async (uri: string) => {
    setVideoUri(uri);
    setFrame(null);
    setFrameTimeSec(0);
    setBox(null);
    setIsSaved(savedVideos.some((v) => v.uri === uri));
    setResult(null);
    setVp({ scale: 1, tx: 0, ty: 0 });
    await loadFrame(uri, 0);
  };

  const restoreSession = async (s: TrackerSession) => {
    // Restore settings
    const ts = useTrackerSettings.getState();
    ts.setPreprocessBW(s.settings.preprocessBW);
    ts.setContrastLevel(s.settings.contrastLevel);
    ts.setOutlierRejection(s.settings.outlierRejection);
    ts.setOutlierThreshold(s.settings.outlierThreshold);
    ts.setRoiSize(s.settings.roiSize);
    ts.setBasepathFt(s.settings.basepathFt);

    // Restore tracker state
    setTrackerMode(s.trackerMode as TrackerMode);
    setStartTimeSec(s.startTimeSec);
    setEndTimeSec(s.endTimeSec);
    setBox(s.roi);

    // Restore calibration
    if (s.cameraPose) {
      setCameraPose({ fit: s.cameraPose.fit as any, sides: s.cameraPose.sides as any });
    } else {
      setCameraPose(null);
    }
    setCameraXYZ(s.cameraXYZ);
    setCameraAngles(s.cameraAngles);

    // Restore overlay positions (deferred — overlay may not be mounted yet)
    if (s.overlayPositions && s.overlayAnchored) {
      setShowPoseOverlay(true);
      setTimeout(() => {
        poseOverlayRef.current?.setState?.({ positions: s.overlayPositions!, anchored: s.overlayAnchored! });
      }, 100);
    }

    // Restore results
    if (s.result) {
      setResult(s.result as any);
      setReviewIdx(s.reviewIdx);
    }

    // Load the video last (triggers frame load)
    if (s.videoUri) {
      setVideoUri(s.videoUri);
      setIsSaved(true);
      setFrameTimeSec(s.frameTimeSec);
      try {
        const f = await VisionTracker.firstFrame(s.videoUri, 0.85);
        setFrame(f);
        if (s.frameTimeSec > 0) {
          const f2 = await VisionTracker.frameAtTime(s.videoUri, s.frameTimeSec, 0.85);
          setFrame(f2);
        }
      } catch (e) {
        setErr(`Video not available: ${(e as Error).message}`);
      }
    }
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
      // When overlays are active: only claim 2-finger (pinch) gestures so
      // single-finger drags go to the overlay's corner/body handlers.
      // When no overlay: claim everything (pinch + single-finger pan).
      onStartShouldSetPanResponderCapture: (e) => {
        return e.nativeEvent.touches.length >= 2;
      },
      onMoveShouldSetPanResponderCapture: (e) => {
        return e.nativeEvent.touches.length >= 2;
      },
      onStartShouldSetPanResponder: (e) => {
        if (showPoseOverlayRef.current || showRoiOverlayRef.current) return e.nativeEvent.touches.length >= 2;
        return true;
      },
      onMoveShouldSetPanResponder: (e) => {
        if (showPoseOverlayRef.current || showRoiOverlayRef.current) return e.nativeEvent.touches.length >= 2;
        return true;
      },
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
          // 1-finger: use as pan anchor (no box drawing).
          const t0 = touches[0]!;
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
        // 1-finger: pan (useful when zoomed in).
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

  // Separate responder for the result canvas: pan + pinch only (no box
  // drawing). Reuses the same vp/canvas/gestureBase state and refs since
  // only one of the two canvases is rendered at a time.
  const resultResponder = useMemo(() =>
    PanResponder.create({
      // Only capture 2-finger pinch; let 1-finger scroll pass to ScrollView.
      onStartShouldSetPanResponderCapture: (e) => (e.nativeEvent.touches?.length ?? 1) >= 2,
      onMoveShouldSetPanResponderCapture: (e) => (e.nativeEvent.touches?.length ?? 1) >= 2,
      onStartShouldSetPanResponder: (e) => (e.nativeEvent.touches?.length ?? 1) >= 2,
      onMoveShouldSetPanResponder: (e) => (e.nativeEvent.touches?.length ?? 1) >= 2,
      onPanResponderTerminationRequest: () => true,
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
      } else if (trackerMode.startsWith("yolo") || trackerMode === "baseball") {
        // Switch YOLO model if needed.
        const yoloModelName = YOLO_MODEL_NAME[trackerMode];
        if (yoloModelName) {
          const current = Yolo.currentModel();
          if (current && current !== yoloModelName) {
            setBusy(`loading ${yoloModelName}…`);
            const ok = await Yolo.switchModel(yoloModelName).catch(() => false);
            if (!ok) { setErr(`Failed to load ${yoloModelName} — model may not be bundled`); setBusy(null); return; }
          }
        }
        const isYolo = trackerMode.startsWith("yolo");
        const roi = box ?? undefined;
        const detect = async (uri: string): Promise<RawDetection[]> => {
          let detectUri = uri;
          if (preprocessBW) {
            try {
              const raw = uri.replace(/^data:image\/\w+;base64,/, "");
              const processed = await VisionTracker.preprocessFrame(raw, contrastLevel, 0.85);
              detectUri = `data:image/jpeg;base64,${processed}`;
            } catch {}
          }
          const res = isYolo
            ? await Yolo.detect(detectUri, { minConfidence: 0.10, roi })
            : await Baseball.detect(detectUri, { minConfidence: 0.10 });
          return res.detections.map((d) => ({ label: d.label, confidence: d.confidence, box: d.box }));
        };
        const fps = frame && frame.frameRate > 0 ? frame.frameRate : 30;
        const walkStart = startTimeSec ?? frameTimeSec;
        const walkEnd = endTimeSec ?? frame?.durationSec ?? 9999;
        r = await detectorWalk(
          (t, q) => VisionTracker.frameAtTime(videoUri, t, q).then((f) => ({
            imageBase64: f.imageBase64, imageWidth: f.imageWidth, imageHeight: f.imageHeight, frameRate: f.frameRate ?? 0,
          })),
          detect,
          {
            startTimeSec: walkStart,
            stepSec: 1 / fps,
            durationSec: walkEnd,
            maxFrames: 0,
            // Keep walking the whole clip even through long miss streaks —
            // gaps get filled by interpolation downstream, and we don't want
            // to truncate the result early.
            maxMisses: Number.POSITIVE_INFINITY,
            labelFilter: isYolo ? (l) => l === "sports ball" : undefined,
          },
        );
      } else {
        r = await TemplateTracker.trackInVideo(videoUri, box!, {
          sampleStride: 1, maxFrames: 0, startTimeSec: frameTimeSec,
          confidenceCutoff: 0.15, searchPadding: 3, downsample: 2,
        });
      }
      // Outlier rejection (two-pass RANSAC + refit).
      let rejectedCount = 0;
      if (outlierRejection) {
        const rej = rejectOutliers(r.frames, { inlierThreshold: outlierThreshold });
        if (rej.applied) {
          for (const label of rej.labels) {
            if (!label.inlier && label.residual !== null) {
              const f = r.frames[label.frameIndex] as any;
              if (f && f.box) {
                f.rejectedBox = { ...f.box };
                f.box = null;
                f.lost = true;
                f.rejected = true;
                rejectedCount++;
              }
            }
          }
        }
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
      schema: "whyapp.tracker.trace/v3",
      capturedAt: new Date().toISOString(),
      mode: result.mode,
      videoWidth: result.videoWidth,
      videoHeight: result.videoHeight,
      frameRate: result.frameRate,
      elapsedMs: result.elapsedMs,
      startTimeSec: frameTimeSec,
      initialBox: box,
      cameraPose: cameraPose ? { sides: cameraPose.sides, rmsPx: cameraPose.fit.rmsPx, H: cameraPose.fit.H } : null,
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

  // Ball direction for the current review frame (when pose is set).
  const currentBallDir = useMemo((): BallDirection | null => {
    if (!cameraPose || !result || !interpolated || !frame) return null;
    const ip = interpolated[reviewIdx];
    if (!ip?.box) return null;
    const cx = ip.box.x + ip.box.width / 2;
    const cy = ip.box.y + ip.box.height / 2;
    const K = intrinsicsFromFov(result.videoWidth, result.videoHeight, frame.hFovDeg ?? 0);
    return computeBallDirection(cx, cy, result.videoWidth, result.videoHeight, K, ip.interpolated);
  }, [cameraPose, result, interpolated, reviewIdx, frame]);

  // Ray info for all tracked frames (when pose is set).
  const allRayInfo = useMemo((): RayInfo[] | null => {
    if (!cameraPose || !cameraXYZ || !result || !interpolated || !frame) return null;
    const K = intrinsicsFromFov(result.videoWidth, result.videoHeight, frame.hFovDeg ?? 0);
    const rays: RayInfo[] = [];
    for (let i = 0; i < result.frames.length; i++) {
      const ip = interpolated[i];
      if (!ip?.box) continue;
      const cx = ip.box.x + ip.box.width / 2;
      const cy = ip.box.y + ip.box.height / 2;
      const r = computeRayInfo(cx, cy, result.videoWidth, result.videoHeight, K, cameraPose.fit.Hinv, cameraXYZ, ip.interpolated, i, result.frames[i]!.timeSec);
      if (r) rays.push(r);
    }
    return rays.length > 0 ? rays : null;
  }, [cameraPose, cameraXYZ, result, interpolated, frame]);

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

  // ── Controls block (reused in both portrait and landscape) ──────────
  const controlsBlock = !result && frame ? (
    <View style={{ gap: 6, flex: isLandscape ? 1 : undefined }}>
      {/* Frame step + zoom */}
      <View style={{ flexDirection: "row", gap: 6 }}>
        <Pressable onPress={() => frameStep(-1)} disabled={!!busy} style={[styles.btn, { backgroundColor: theme.surfaceAlt, flex: 1 }]}>
          <Text style={[styles.btnText, { color: theme.text }]}>«1s</Text>
        </Pressable>
        <Pressable onPress={() => frameStep(-frameStepSec)} disabled={!!busy} style={[styles.btn, { backgroundColor: theme.surfaceAlt, flex: 1 }]}>
          <Text style={[styles.btnText, { color: theme.text }]}>‹</Text>
        </Pressable>
        <Pressable onPress={() => frameStep(frameStepSec)} disabled={!!busy} style={[styles.btn, { backgroundColor: theme.surfaceAlt, flex: 1 }]}>
          <Text style={[styles.btnText, { color: theme.text }]}>›</Text>
        </Pressable>
        <Pressable onPress={() => frameStep(1)} disabled={!!busy} style={[styles.btn, { backgroundColor: theme.surfaceAlt, flex: 1 }]}>
          <Text style={[styles.btnText, { color: theme.text }]}>1s»</Text>
        </Pressable>
        <Pressable onPress={() => zoomBy(1 / 1.5)} style={[styles.btn, { backgroundColor: theme.surfaceAlt }]}>
          <Text style={[styles.btnText, { color: theme.text }]}>−</Text>
        </Pressable>
        <Pressable onPress={resetViewport} style={[styles.btn, { backgroundColor: theme.surfaceAlt }]}>
          <Text style={[styles.btnText, { color: theme.text, fontSize: 10 }]}>{vp.scale > 1.01 ? `${vp.scale.toFixed(1)}×` : "1×"}</Text>
        </Pressable>
        <Pressable onPress={() => zoomBy(1.5)} style={[styles.btn, { backgroundColor: theme.surfaceAlt }]}>
          <Text style={[styles.btnText, { color: theme.text }]}>+</Text>
        </Pressable>
      </View>

      {/* Setup row: Calibrate / ROI / Start / End */}
      <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
        <Pressable
          onPress={() => {
            setShowPoseOverlay((v) => !v); if (!showPoseOverlay) setShowRoiOverlay(false);
          }}
          disabled={!!busy}
          style={[styles.btn, { backgroundColor: showPoseOverlay ? theme.primary : cameraPose ? theme.primary : theme.surfaceAlt, flex: 1, minWidth: "22%" }]}
        >
          <Text style={[styles.btnText, { color: showPoseOverlay || cameraPose ? "#fff" : theme.text, fontSize: 11 }]}>
            {showPoseOverlay ? "Hide" : cameraPose ? "Pose ✓" : "Calibrate"}
          </Text>
        </Pressable>
        <Pressable
          onPress={() => {
            if (box && !showRoiOverlay) { setBox(null); }
            else { setShowRoiOverlay((v) => !v); setShowPoseOverlay(false); }
          }}
          disabled={!!busy}
          style={[styles.btn, { backgroundColor: showRoiOverlay ? "#FF3B30" : box ? "#FF3B30" : theme.surfaceAlt, flex: 1, minWidth: "22%" }]}
        >
          <Text style={[styles.btnText, { color: showRoiOverlay || box ? "#fff" : theme.text, fontSize: 11 }]}>
            {box ? "ROI ✓" : showRoiOverlay ? "ROI…" : "ROI"}
          </Text>
        </Pressable>
        <Pressable
          onPress={() => { startTimeSec != null ? setStartTimeSec(null) : setStartTimeSec(frameTimeSec); }}
          disabled={!!busy}
          style={[styles.btn, { backgroundColor: startTimeSec != null ? theme.primary : theme.surfaceAlt, flex: 1, minWidth: "22%" }]}
        >
          <Text style={[styles.btnText, { color: startTimeSec != null ? "#fff" : theme.text, fontSize: 11 }]}>
            {startTimeSec != null ? `S:${startTimeSec.toFixed(1)}` : "Start"}
          </Text>
        </Pressable>
        <Pressable
          onPress={() => { endTimeSec != null ? setEndTimeSec(null) : setEndTimeSec(frameTimeSec); }}
          disabled={!!busy}
          style={[styles.btn, { backgroundColor: endTimeSec != null ? theme.primary : theme.surfaceAlt, flex: 1, minWidth: "22%" }]}
        >
          <Text style={[styles.btnText, { color: endTimeSec != null ? "#fff" : theme.text, fontSize: 11 }]}>
            {endTimeSec != null ? `E:${endTimeSec.toFixed(1)}` : "End"}
          </Text>
        </Pressable>
      </View>

      {/* Pose overlay controls */}
      {showPoseOverlay && (
        <View style={{ gap: 6 }}>
          <View style={{ flexDirection: "row", gap: 6 }}>
            <Pressable
              onPress={() => useTrackerSettings.getState().setCalibrationMode(calibrationMode === "landmarks" ? "camera3d" : "landmarks")}
              style={[styles.btn, { backgroundColor: theme.surfaceAlt }]}
            >
              <Text style={[styles.btnText, { color: theme.text, fontSize: 10 }]}>{calibrationMode === "landmarks" ? "→ 3D" : "→ Pts"}</Text>
            </Pressable>
            <Pressable onPress={() => poseOverlayRef.current?.reset()} style={[styles.btn, { backgroundColor: theme.surfaceAlt, flex: 1 }]}>
              <Text style={[styles.btnText, { color: theme.text }]}>Reset</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                const pose = poseOverlayRef.current?.solve();
                if (pose && frame) {
                  setCameraPose(pose);
                  const K = intrinsicsFromFov(frame.imageWidth, frame.imageHeight, frame.hFovDeg ?? 0);
                  const decomp = decomposeCameraPose(pose.fit.H, K);
                  if (decomp) {
                    setCameraXYZ(fieldToUser(decomp.position));
                    setCameraAngles({ panDeg: decomp.panDeg, tiltDeg: decomp.tiltDeg, rollDeg: decomp.rollDeg });
                  }
                }
              }}
              style={[styles.btn, { backgroundColor: theme.highlight, flex: 2 }]}
            >
              <Text style={styles.btnText}>Set Pose</Text>
            </Pressable>
          </View>
          <View style={{ flexDirection: "row", gap: 6 }}>
            <Pressable
              onPress={async () => {
                const state = poseOverlayRef.current?.getState?.();
                if (!state) return;
                setBusy("saving calibration…");
                try {
                  const pose = poseOverlayRef.current?.solve();
                  const payload = {
                    name: new Date().toLocaleString(),
                    positions: state.positions,
                    anchored: state.anchored,
                    cameraPose: pose ? { H: pose.fit.H, Hinv: pose.fit.Hinv, rmsPx: pose.fit.rmsPx, count: pose.fit.count } : null,
                    cameraXYZ,
                    cameraAngles,
                    basepathFt,
                  };
                  await apiFetch("/tracking/calibrations", { method: "POST", body: JSON.stringify(payload) });
                  setCopyHint("Calibration saved");
                  setTimeout(() => setCopyHint(null), 3000);
                } catch (e) { setErr((e as Error).message); }
                finally { setBusy(null); }
              }}
              disabled={!!busy}
              style={[styles.btn, { backgroundColor: theme.surfaceAlt, flex: 1, opacity: busy ? 0.5 : 1 }]}
            >
              <Text style={[styles.btnText, { color: theme.text, fontSize: 11 }]}>Save Cal</Text>
            </Pressable>
            <Pressable
              onPress={async () => {
                setBusy("loading calibrations…");
                try {
                  const res = await apiFetch<{ calibrations: { id: string; uploaded: string }[] }>("/tracking/calibrations");
                  if (!res.calibrations.length) { setErr("No saved calibrations"); setBusy(null); return; }
                  const latest = res.calibrations[0]!;
                  setBusy(`loading ${latest.id}…`);
                  const cal = await apiFetch<any>(`/tracking/calibrations/${latest.id}`);
                  // Restore overlay state
                  if (cal.positions && cal.anchored) {
                    poseOverlayRef.current?.setState?.({ positions: cal.positions, anchored: cal.anchored });
                  }
                  // Restore camera pose
                  if (cal.cameraPose) {
                    setCameraPose({ fit: cal.cameraPose as any, sides: ["left", "right"] });
                  }
                  if (cal.cameraXYZ) setCameraXYZ(cal.cameraXYZ);
                  if (cal.cameraAngles) setCameraAngles(cal.cameraAngles);
                  if (cal.basepathFt) useTrackerSettings.getState().setBasepathFt(cal.basepathFt);
                  setCopyHint("Calibration loaded");
                  setTimeout(() => setCopyHint(null), 3000);
                } catch (e) { setErr((e as Error).message); }
                finally { setBusy(null); }
              }}
              disabled={!!busy}
              style={[styles.btn, { backgroundColor: theme.surfaceAlt, flex: 1, opacity: busy ? 0.5 : 1 }]}
            >
              <Text style={[styles.btnText, { color: theme.text, fontSize: 11 }]}>Load Cal</Text>
            </Pressable>
          </View>
        </View>
      )}

      {/* ROI overlay controls */}
      {showRoiOverlay && (
        <View style={{ flexDirection: "row", gap: 6 }}>
          <Pressable onPress={() => roiOverlayRef.current?.reset()} style={[styles.btn, { backgroundColor: theme.surfaceAlt, flex: 1 }]}>
            <Text style={[styles.btnText, { color: theme.text }]}>Reset</Text>
          </Pressable>
          <Pressable
            onPress={() => { const roi = roiOverlayRef.current?.getBox(); if (roi) { setBox(roi); setShowRoiOverlay(false); } }}
            style={[styles.btn, { backgroundColor: "#FF3B30", flex: 2 }]}
          >
            <Text style={styles.btnText}>Set ROI</Text>
          </Pressable>
        </View>
      )}

      {/* Model selector + Preprocess + Run / Clear */}
      <View style={{ flexDirection: "row", gap: 6 }}>
        <Pressable
          onPress={() => setShowModelPicker(true)}
          style={[styles.btn, { backgroundColor: theme.surfaceAlt, flex: 1 }]}
        >
          <Text style={[styles.btnText, { color: theme.text, fontSize: 11 }]}>{MODE_LABEL[trackerMode]} ▾</Text>
        </Pressable>
        <View style={[styles.btn, { backgroundColor: preprocessBW ? theme.primary : theme.surfaceAlt }]}>
          <Text style={[styles.btnText, { color: preprocessBW ? "#fff" : theme.text, fontSize: 10 }]}>
            {preprocessBW ? `B&W ${contrastLevel.toFixed(1)}×` : "Color"}
          </Text>
        </View>
        <View style={[styles.btn, { backgroundColor: outlierRejection ? theme.primary : theme.surfaceAlt }]}>
          <Text style={[styles.btnText, { color: outlierRejection ? "#fff" : theme.text, fontSize: 10 }]}>
            {outlierRejection ? "Filter" : "No filter"}
          </Text>
        </View>
        <Pressable
          onPress={runTracker}
          disabled={(!box && !DETECTOR_MODES.includes(trackerMode)) || !!busy}
          style={[styles.btn, { backgroundColor: theme.highlight, flex: 2, opacity: (!box && !DETECTOR_MODES.includes(trackerMode)) || busy ? 0.4 : 1 }]}
        >
          <Text style={styles.btnText}>{busy?.startsWith("tracking") ? "Tracking…" : "Run"}</Text>
        </Pressable>
        <Pressable
          onPress={() => { setBox(null); setResult(null); setCameraPose(null); setCameraXYZ(null); setCameraAngles(null); setShowPoseOverlay(false); setShowRoiOverlay(false); setStartTimeSec(null); setEndTimeSec(null); }}
          disabled={!box}
          style={[styles.btn, { backgroundColor: theme.surfaceAlt, opacity: !box ? 0.4 : 1 }]}
        >
          <Text style={[styles.btnText, { color: theme.text }]}>Clear</Text>
        </Pressable>
      </View>

      {busy && (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <ActivityIndicator color={theme.primary} />
          <Text style={{ color: theme.textSubtle, fontSize: 12 }}>{busy}</Text>
        </View>
      )}

      {cameraXYZ && (
        <View style={{ backgroundColor: "rgba(0,200,255,0.08)", borderRadius: 6, padding: 6, marginTop: 4 }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 2 }}>
            <Text style={{ color: theme.text, fontSize: 10, fontWeight: "700" }}>Camera Pose</Text>
            <Pressable
              onPress={async () => {
                const lines = [
                  `pos  x=${cameraXYZ.x.toFixed(3)}  y=${cameraXYZ.y.toFixed(3)}  z=${cameraXYZ.z.toFixed(3)} m`,
                  cameraAngles ? `rot  rx=${cameraAngles.tiltDeg.toFixed(1)}  ry=${cameraAngles.rollDeg.toFixed(1)}  rz=${cameraAngles.panDeg.toFixed(1)} deg` : "",
                ].filter(Boolean).join("\n");
                await Clipboard.setStringAsync(lines);
                setCopyHint("Copied camera pose");
                setTimeout(() => setCopyHint(null), 3000);
              }}
              style={[styles.btn, { backgroundColor: theme.surfaceAlt, paddingVertical: 4, paddingHorizontal: 8 }]}
            >
              <Text style={[styles.btnText, { color: theme.text, fontSize: 9 }]}>Copy</Text>
            </Pressable>
          </View>
          <Text style={{ color: theme.text, fontSize: 9, fontFamily: "monospace" }}>
            pos  x={cameraXYZ.x.toFixed(3)}  y={cameraXYZ.y.toFixed(3)}  z={cameraXYZ.z.toFixed(3)} m
          </Text>
          {cameraAngles && (
            <Text style={{ color: theme.text, fontSize: 9, fontFamily: "monospace" }}>
              rot  rx={cameraAngles.tiltDeg.toFixed(1)}°  ry={cameraAngles.rollDeg.toFixed(1)}°  rz={cameraAngles.panDeg.toFixed(1)}°
            </Text>
          )}
          <Text style={{ color: theme.textSubtle, fontSize: 8 }}>
            X ∥ front edge · Y → 2B · Z ↑ · foul lines ±45° from Y
          </Text>
        </View>
      )}

      {allRayInfo && (
        <View style={{ backgroundColor: "rgba(0,200,255,0.08)", borderRadius: 6, padding: 6, marginTop: 4 }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 2 }}>
            <Text style={{ color: theme.text, fontSize: 10, fontWeight: "700" }}>
              Detections ({allRayInfo.length} frames)
            </Text>
            <Pressable
              onPress={async () => {
                const lines = [
                  `Camera Pose`,
                  `pos  x=${cameraXYZ!.x.toFixed(3)}  y=${cameraXYZ!.y.toFixed(3)}  z=${cameraXYZ!.z.toFixed(3)} m`,
                  cameraAngles ? `rot  rx=${cameraAngles.tiltDeg.toFixed(1)}  ry=${cameraAngles.rollDeg.toFixed(1)}  rz=${cameraAngles.panDeg.toFixed(1)} deg` : "",
                  "",
                  "frame\ttime\ttype\tpixel_x\tpixel_y\tyz_y\tyz_z\tray_dir_x\tray_dir_y\tray_dir_z",
                  ...allRayInfo.map((r) =>
                    `${r.frameIndex}\t${r.timeSec.toFixed(4)}\t${r.interpolated ? "interp" : "detect"}\t${r.pixelX.toFixed(1)}\t${(result!.videoHeight - r.pixelY).toFixed(1)}\t${r.yzY.toFixed(4)}\t${r.yzZ.toFixed(4)}\t${r.rayDirX.toFixed(5)}\t${r.rayDirY.toFixed(5)}\t${r.rayDirZ.toFixed(5)}`
                  ),
                ].filter(Boolean).join("\n");
                await Clipboard.setStringAsync(lines);
                setCopyHint("Copied position data");
                setTimeout(() => setCopyHint(null), 3000);
              }}
              style={[styles.btn, { backgroundColor: theme.surfaceAlt, paddingVertical: 4, paddingHorizontal: 8 }]}
            >
              <Text style={[styles.btnText, { color: theme.text, fontSize: 9 }]}>Copy</Text>
            </Pressable>
          </View>
          <ScrollView style={{ maxHeight: 200 }} nestedScrollEnabled>
            {allRayInfo.map((r, i) => (
              <View key={i} style={{ marginBottom: 4, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border, paddingBottom: 3 }}>
                <Text style={{ color: r.interpolated ? "#FF9500" : "#34C759", fontSize: 8, fontWeight: "600" }}>
                  f{r.frameIndex} t={r.timeSec.toFixed(3)}s {r.interpolated ? "INTERP" : "DETECT"}
                </Text>
                <Text style={{ color: theme.text, fontSize: 8, fontFamily: "monospace" }}>
                  pixel  x={r.pixelX.toFixed(1)}  y={(result!.videoHeight - r.pixelY).toFixed(1)}
                    </Text>
                    <Text style={{ color: theme.text, fontSize: 8, fontFamily: "monospace" }}>
                  YZ plane  y={r.yzY.toFixed(3)}  z={r.yzZ.toFixed(3)} m
                </Text>
                <Text style={{ color: theme.text, fontSize: 8, fontFamily: "monospace" }}>
                  YZ plane  y={r.yzY.toFixed(3)}  z={r.yzZ.toFixed(3)} m
                </Text>
                <Text style={{ color: theme.textSubtle, fontSize: 7, fontFamily: "monospace" }}>
                  {r.rayEquation}
                </Text>
              </View>
            ))}
          </ScrollView>
        </View>
      )}
    </View>
  ) : null;

  // ── Video canvas block ─────────────────────────────────────────────
  const videoCanvas = !result && frame ? (
    <View
      ref={canvasRef2}
      {...responder.panHandlers}
      onLayout={onCanvasLayout}
      style={{
        aspectRatio: frame.imageWidth / frame.imageHeight,
        backgroundColor: "#000",
        borderRadius: 8,
        overflow: "hidden",
        flex: isLandscape ? 2 : undefined,
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
      {committedBoxScreen && (
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
            borderStyle: "dashed",
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
      {showRoiOverlay && (
        <RoiOverlay
          ref={roiOverlayRef}
          imageWidth={frame.imageWidth}
          imageHeight={frame.imageHeight}
          vp={vp}
          canvas={canvas}
          canvasPageOffset={canvasPageOffsetRef.current}
        />
      )}
      {showPoseOverlay && calibrationMode === "landmarks" && (
        <BatterBoxOverlay
          ref={(r) => { landmarkRef.current = r; poseOverlayRef.current = r; }}
          imageWidth={frame.imageWidth}
          imageHeight={frame.imageHeight}
          vp={vp}
          canvas={canvas}
          canvasPageOffset={canvasPageOffsetRef.current}
        />
      )}
      {showPoseOverlay && calibrationMode === "camera3d" && (
        <ThreeDPoseOverlay
          ref={(r) => { camera3dRef.current = r; poseOverlayRef.current = r; }}
          imageWidth={frame.imageWidth}
          imageHeight={frame.imageHeight}
          vp={vp}
          canvas={canvas}
          canvasPageOffset={canvasPageOffsetRef.current}
        />
      )}
    </View>
  ) : null;

  return (
    <>
    <ScrollView contentContainerStyle={{ padding: isLandscape ? 8 : 12 }} scrollEnabled={scrollEnabled && !showPoseOverlay && !showRoiOverlay}>
      {!isLandscape && (
        <>
          <Text style={{ fontSize: 18, fontWeight: "700", color: theme.text, marginBottom: 6 }}>Vision tracker</Text>
          <Text style={{ fontSize: 12, color: theme.textSubtle, marginBottom: 12 }}>
            Pick a video, calibrate the batter's boxes, set ROI and frame range, run the tracker.
          </Text>
        </>
      )}

      <View style={{ flexDirection: "row", gap: 8, marginBottom: 8 }}>
        <Pressable onPress={pickVideo} disabled={!!busy} style={[styles.btn, { backgroundColor: theme.primary, opacity: busy ? 0.5 : 1 }]}>
          <Text style={styles.btnText}>{videoUri ? "Pick another" : "Pick video"}</Text>
        </Pressable>
        <Pressable
          onPress={async () => {
            setBusy("loading sessions…");
            try {
              const res = await apiFetch<{ sessions: { id: string; uploaded: string }[] }>("/tracking");
              if (!res.sessions.length) { setErr("No saved sessions"); setBusy(null); return; }
              // Load the most recent session
              const latest = res.sessions[0]!;
              setBusy(`loading ${latest.id}…`);
              const data = await apiFetch<any>(`/tracking/${latest.id}`);
              if (data.session) {
                await restoreSession(data.session);
                setCopyHint(`Loaded session ${latest.id}`);
                setTimeout(() => setCopyHint(null), 3000);
              } else {
                setErr("Session data not found in saved payload");
              }
            } catch (e) { setErr((e as Error).message); }
            finally { setBusy(null); }
          }}
          disabled={!!busy}
          style={[styles.btn, { backgroundColor: theme.surfaceAlt, opacity: busy ? 0.5 : 1 }]}
        >
          <Text style={[styles.btnText, { color: theme.text }]}>Load</Text>
        </Pressable>
        {videoUri && !isSaved && (
          <Pressable
            onPress={async () => {
              if (!videoUri) return;
              setBusy("saving…");
              try {
                const saved = await saveVideo(videoUri);
                loadVideo(saved.uri);
                setSavedVideos(await listSavedVideos());
                setIsSaved(true);
              } catch (e) { setErr((e as Error).message); }
              finally { setBusy(null); }
            }}
            disabled={!!busy}
            style={[styles.btn, { backgroundColor: theme.highlight, opacity: busy ? 0.5 : 1 }]}
          >
            <Text style={styles.btnText}>Save</Text>
          </Pressable>
        )}
        {videoUri && isSaved && (
          <View style={[styles.btn, { backgroundColor: theme.surfaceAlt }]}>
            <Text style={[styles.btnText, { color: theme.textSubtle }]}>Saved ✓</Text>
          </View>
        )}
        {frame && (
          <Pressable onPress={resetViewport} style={[styles.btn, { backgroundColor: theme.surfaceAlt }]}>
            <Text style={[styles.btnText, { color: theme.text }]}>Reset zoom</Text>
          </Pressable>
        )}
      </View>

      {!videoUri && savedVideos.length > 0 && (
        <View style={{ marginBottom: 8 }}>
          <Text style={{ color: theme.textSubtle, fontSize: 12, marginBottom: 4 }}>Saved videos:</Text>
          {savedVideos.map((v) => (
            <View key={v.id} style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 4 }}>
              <Pressable
                onPress={() => loadVideo(v.uri)}
                style={[styles.btn, { backgroundColor: theme.surfaceAlt, flex: 1, paddingVertical: 8 }]}
              >
                <Text style={[styles.btnText, { color: theme.text, fontSize: 12 }]} numberOfLines={1}>{v.name}</Text>
              </Pressable>
              <Pressable
                onPress={async () => {
                  await deleteSavedVideo(v.id);
                  setSavedVideos(await listSavedVideos());
                }}
                style={[styles.btn, { backgroundColor: theme.surfaceAlt, paddingVertical: 8, paddingHorizontal: 8 }]}
              >
                <Text style={{ color: theme.destructive, fontSize: 12, fontWeight: "600" }}>X</Text>
              </Pressable>
            </View>
          ))}
        </View>
      )}

      {err && (
        <View style={{ padding: 10, backgroundColor: theme.destructive, borderRadius: 8, marginBottom: 8 }}>
          <Text style={{ color: "#fff" }}>{err}</Text>
        </View>
      )}

      {/* Video + Controls: side-by-side in landscape, stacked in portrait */}
      {videoCanvas && controlsBlock && isLandscape ? (
        <View style={{ flexDirection: "row", gap: 8, marginBottom: 8, height: canvas.height || 300 }}>
          <View style={{ flex: 2 }}>{videoCanvas}</View>
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 6 }} nestedScrollEnabled>
            {controlsBlock}
          </ScrollView>
        </View>
      ) : (
        <>
          {videoCanvas && <View style={{ marginBottom: 8 }}>{videoCanvas}</View>}
          {controlsBlock}
        </>
      )}

      {result && (
        <View style={{ marginTop: 6 }}>
          {reviewedFrame && (
            <View
              ref={canvasRef2}
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
                {reviewImage && showProcessed && (
                  <ProcessedImage base64={reviewImage.base64} />
                )}
                {reviewImage && !showProcessed && (
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
                  const t = i / denom; // 0 = oldest, 1 = newest
                  const alpha = 0.25 + t * 0.7;
                  // Size: shrink from full size (newest) to half (oldest).
                  const sizeFactor = 0.5 + t * 0.5;
                  if (p.interpolated) {
                    const sz = 6 * sizeFactor;
                    return (
                      <View
                        key={`trail-${i}`}
                        pointerEvents="none"
                        style={{
                          position: "absolute",
                          left: `${cx * 100}%`,
                          top: `${cy * 100}%`,
                          width: sz,
                          height: sz,
                          marginLeft: -sz / 2,
                          marginTop: -sz / 2,
                          borderRadius: sz / 2,
                          borderWidth: 1,
                          borderColor: `rgba(255,204,0,${alpha})`,
                          backgroundColor: "transparent",
                        }}
                      />
                    );
                  }
                  const sz = 8 * sizeFactor;
                  return (
                    <View
                      key={`trail-${i}`}
                      pointerEvents="none"
                      style={{
                        position: "absolute",
                        left: `${cx * 100}%`,
                        top: `${cy * 100}%`,
                        width: sz,
                        height: sz,
                        marginLeft: -sz / 2,
                        marginTop: -sz / 2,
                        borderRadius: sz / 2,
                        backgroundColor: `rgba(255,204,0,${alpha})`,
                      }}
                    />
                  );
                })}
                {/* Rejected points (red hollow circles) */}
                {result.frames.slice(0, reviewIdx + 1).map((f: any, i) => {
                  if (!f.rejected || !f.rejectedBox) return null;
                  const cx = f.rejectedBox.x + f.rejectedBox.width / 2;
                  const cy = f.rejectedBox.y + f.rejectedBox.height / 2;
                  return (
                    <View
                      key={`rej-${i}`}
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
                        borderWidth: 1.5,
                        borderColor: "rgba(255,59,48,0.7)",
                        backgroundColor: "transparent",
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
              <View style={{ position: "absolute", bottom: 8, left: 8, right: 8, gap: 2 }}>
                <View style={{ backgroundColor: "rgba(0,0,0,0.6)", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, alignSelf: "flex-start" }}>
                  <Text style={{ color: "#fff", fontSize: 11 }}>
                    frame {reviewIdx + 1}/{result.frames.length}
                    {"  ·  t="}
                    {reviewedFrame.timeSec.toFixed(2)}s
                    {"  ·  conf "}
                    {reviewedFrame.confidence.toFixed(2)}
                  </Text>
                </View>
                {currentBallDir && (
                  <View style={{ backgroundColor: "rgba(0,0,0,0.6)", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, alignSelf: "flex-start" }}>
                    <Text style={{ color: currentBallDir.interpolated ? "#FF9500" : "#34C759", fontSize: 10 }}>
                      {currentBallDir.interpolated ? "interp" : "detect"}
                      {"  ·  az "}
                      {currentBallDir.azimuthDeg.toFixed(1)}°
                      {"  ·  el "}
                      {currentBallDir.elevationDeg.toFixed(1)}°
                    </Text>
                  </View>
                )}
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
              onPress={() => setShowProcessed((v) => !v)}
              style={[styles.btn, { backgroundColor: showProcessed ? theme.primary : theme.surfaceAlt }]}
            >
              <Text style={[styles.btnText, { color: showProcessed ? "#fff" : theme.text, fontSize: 10 }]}>B&W</Text>
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

          {/* Tracking stats */}
          <View style={{ backgroundColor: "rgba(0,200,255,0.08)", borderRadius: 6, padding: 6, marginTop: 8 }}>
            <Text style={{ color: theme.text, fontSize: 10, fontWeight: "600" }}>
              {MODE_LABEL[result.mode]}  ·  {result.frames.length} frames  ·  {result.frames.filter((f) => f.box && !f.lost).length} detected  ·  {result.frames.filter((f: any) => f.rejected).length > 0 ? `${result.frames.filter((f: any) => f.rejected).length} rejected  ·  ` : ""}{result.elapsedMs}ms  ·  {result.frameRate > 0 ? `${result.frameRate.toFixed(1)} fps` : "?"}
            </Text>
          </View>

          {/* Camera pose + detection data (visible during review) */}
          {cameraXYZ && (
            <View style={{ backgroundColor: "rgba(0,200,255,0.08)", borderRadius: 6, padding: 6, marginTop: 8 }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 2 }}>
                <Text style={{ color: theme.text, fontSize: 10, fontWeight: "700" }}>Camera Pose</Text>
                <Pressable
                  onPress={async () => {
                    const lines = [
                      `pos  x=${cameraXYZ.x.toFixed(3)}  y=${cameraXYZ.y.toFixed(3)}  z=${cameraXYZ.z.toFixed(3)} m`,
                      cameraAngles ? `rot  rx=${cameraAngles.tiltDeg.toFixed(1)}  ry=${cameraAngles.rollDeg.toFixed(1)}  rz=${cameraAngles.panDeg.toFixed(1)} deg` : "",
                    ].filter(Boolean).join("\n");
                    await Clipboard.setStringAsync(lines);
                    setCopyHint("Copied camera pose");
                    setTimeout(() => setCopyHint(null), 3000);
                  }}
                  style={[styles.btn, { backgroundColor: theme.surfaceAlt, paddingVertical: 4, paddingHorizontal: 8 }]}
                >
                  <Text style={[styles.btnText, { color: theme.text, fontSize: 9 }]}>Copy</Text>
                </Pressable>
              </View>
              <Text style={{ color: theme.text, fontSize: 9, fontFamily: "monospace" }}>
                pos  x={cameraXYZ.x.toFixed(3)}  y={cameraXYZ.y.toFixed(3)}  z={cameraXYZ.z.toFixed(3)} m
              </Text>
              {cameraAngles && (
                <Text style={{ color: theme.text, fontSize: 9, fontFamily: "monospace" }}>
                  rot  rx={cameraAngles.tiltDeg.toFixed(1)}°  ry={cameraAngles.rollDeg.toFixed(1)}°  rz={cameraAngles.panDeg.toFixed(1)}°
                </Text>
              )}
            </View>
          )}

          {allRayInfo && (
            <View style={{ backgroundColor: "rgba(0,200,255,0.08)", borderRadius: 6, padding: 6, marginTop: 4 }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 2 }}>
                <Text style={{ color: theme.text, fontSize: 10, fontWeight: "700" }}>
                  Detections ({allRayInfo.length} frames)
                </Text>
                <Pressable
                  onPress={async () => {
                    const lines = [
                      `Camera Pose`,
                      `pos  x=${cameraXYZ!.x.toFixed(3)}  y=${cameraXYZ!.y.toFixed(3)}  z=${cameraXYZ!.z.toFixed(3)} m`,
                      cameraAngles ? `rot  rx=${cameraAngles.tiltDeg.toFixed(1)}  ry=${cameraAngles.rollDeg.toFixed(1)}  rz=${cameraAngles.panDeg.toFixed(1)} deg` : "",
                      "",
                      "frame\ttime\ttype\tpixel_x\tpixel_y\tyz_y\tyz_z\tray_dir_x\tray_dir_y\tray_dir_z",
                      ...allRayInfo.map((r) =>
                        `${r.frameIndex}\t${r.timeSec.toFixed(4)}\t${r.interpolated ? "interp" : "detect"}\t${r.pixelX.toFixed(1)}\t${(result!.videoHeight - r.pixelY).toFixed(1)}\t${r.yzY.toFixed(4)}\t${r.yzZ.toFixed(4)}\t${r.rayDirX.toFixed(5)}\t${r.rayDirY.toFixed(5)}\t${r.rayDirZ.toFixed(5)}`
                      ),
                    ].filter(Boolean).join("\n");
                    await Clipboard.setStringAsync(lines);
                    setCopyHint("Copied position data");
                    setTimeout(() => setCopyHint(null), 3000);
                  }}
                  style={[styles.btn, { backgroundColor: theme.surfaceAlt, paddingVertical: 4, paddingHorizontal: 8 }]}
                >
                  <Text style={[styles.btnText, { color: theme.text, fontSize: 9 }]}>Copy</Text>
                </Pressable>
              </View>
              <ScrollView style={{ maxHeight: 200 }} nestedScrollEnabled>
                {allRayInfo.map((r, i) => (
                  <View key={i} style={{ marginBottom: 4, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border, paddingBottom: 3 }}>
                    <Text style={{ color: r.interpolated ? "#FF9500" : "#34C759", fontSize: 8, fontWeight: "600" }}>
                      f{r.frameIndex} t={r.timeSec.toFixed(3)}s {r.interpolated ? "INTERP" : "DETECT"}
                    </Text>
                    <Text style={{ color: theme.text, fontSize: 8, fontFamily: "monospace" }}>
                      pixel  x={r.pixelX.toFixed(1)}  y={(result!.videoHeight - r.pixelY).toFixed(1)}
                    </Text>
                    <Text style={{ color: theme.text, fontSize: 8, fontFamily: "monospace" }}>
                  YZ plane  y={r.yzY.toFixed(3)}  z={r.yzZ.toFixed(3)} m
                    </Text>
                    <Text style={{ color: theme.text, fontSize: 8, fontFamily: "monospace" }}>
                      YZ plane  y={r.yzY.toFixed(3)}  z={r.yzZ.toFixed(3)} m
                    </Text>
                    <Text style={{ color: theme.textSubtle, fontSize: 7, fontFamily: "monospace" }}>
                      {r.rayEquation}
                    </Text>
                  </View>
                ))}
              </ScrollView>
            </View>
          )}

          {/* Save full session to whyapp.us */}
          <Pressable
            onPress={async () => {
              setBusy("saving session…");
              try {
                // Build detection data for the viewer
                const ip = interpolated ?? [];
                const detections = result ? result.frames.map((f, i) => {
                  const p = ip[i];
                  const bx = p?.box ?? f.box;
                  if (!bx) return null;
                  const cx = bx.x + bx.width / 2, cy = bx.y + bx.height / 2;
                  const ri = allRayInfo?.find((r) => r.frameIndex === i);
                  return {
                    frame: i, time: Number(f.timeSec.toFixed(4)),
                    type: f.lost ? (p?.interpolated ? "interp" : "lost") : "detect",
                    pixel: { x: Number((cx * result.videoWidth).toFixed(1)), y: Number(((1 - cy) * result.videoHeight).toFixed(1)) },
                    yzPlane: ri ? { y: Number(ri.yzY.toFixed(4)), z: Number(ri.yzZ.toFixed(4)) } : null,
                    ray: ri ? { dx: Number(ri.rayDirX.toFixed(5)), dy: Number(ri.rayDirY.toFixed(5)), dz: Number(ri.rayDirZ.toFixed(5)) } : null,
                  };
                }).filter(Boolean) : [];

                // Full session for restore
                const overlayState = poseOverlayRef.current?.getState?.() ?? null;
                const session: TrackerSession = {
                  version: 2,
                  savedAt: new Date().toISOString(),
                  videoUri,
                  frameTimeSec,
                  trackerMode,
                  startTimeSec,
                  endTimeSec,
                  roi: box,
                  cameraPose: cameraPose ? { fit: { H: cameraPose.fit.H, Hinv: cameraPose.fit.Hinv, rmsPx: cameraPose.fit.rmsPx, count: cameraPose.fit.count }, sides: cameraPose.sides } : null,
                  cameraXYZ,
                  cameraAngles,
                  overlayPositions: overlayState?.positions ?? null,
                  overlayAnchored: overlayState?.anchored ?? null,
                  result: result ? { frames: result.frames, elapsedMs: result.elapsedMs, videoWidth: result.videoWidth, videoHeight: result.videoHeight, frameRate: result.frameRate, mode: result.mode } : null,
                  reviewIdx,
                  settings: { preprocessBW, contrastLevel, outlierRejection, outlierThreshold, roiSize: useTrackerSettings.getState().roiSize, basepathFt },
                };

                // Also include viewer data in the payload
                const payload = {
                  session,
                  cameraPose: cameraXYZ ? { position: cameraXYZ, rotation: cameraAngles } : null,
                  homography: cameraPose ? { H: cameraPose.fit.H, Hinv: cameraPose.fit.Hinv, rmsPx: cameraPose.fit.rmsPx } : null,
                  imageSize: result ? { width: result.videoWidth, height: result.videoHeight } : null,
                  frameRate: result?.frameRate ?? 0,
                  trackerMode,
                  basepathFt,
                  detections,
                };
                const res = await apiFetch<{ id: string }>("/tracking", { method: "POST", body: JSON.stringify(payload) });
                const viewUrl = `https://api.whyapp.us/tracking/${res.id}/view`;
                setSavedViewUrl(viewUrl);
                setCopyHint("Saved!");
                setTimeout(() => setCopyHint(null), 3000);
              } catch (e) {
                setCopyHint(`Save failed: ${(e as Error).message}`);
                setTimeout(() => setCopyHint(null), 5000);
              } finally {
                setBusy(null);
              }
            }}
            disabled={!!busy}
            style={[styles.btn, { backgroundColor: theme.highlight, marginTop: 8, opacity: busy ? 0.5 : 1 }]}
          >
            <Text style={styles.btnText}>Save Session</Text>
          </Pressable>
          {savedViewUrl && (
            <Pressable onPress={() => { import("expo-linking").then((L) => L.openURL(savedViewUrl!)).catch(() => {}); }} style={{ marginTop: 4 }}>
              <Text style={{ color: "rgba(0,200,255,1)", fontSize: 11, textDecorationLine: "underline" }}>{savedViewUrl}</Text>
            </Pressable>
          )}
        </View>
      )}
    </ScrollView>

    {/* Model picker modal */}
    <Modal visible={showModelPicker} transparent animationType="fade" onRequestClose={() => setShowModelPicker(false)}>
      <Pressable style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "center", alignItems: "center" }} onPress={() => setShowModelPicker(false)}>
        <View style={{ backgroundColor: theme.background, borderRadius: 12, padding: 16, width: 300, maxHeight: "80%" }}>
          <Text style={{ color: theme.text, fontWeight: "700", fontSize: 15, marginBottom: 12 }}>Tracker Model</Text>
          <ScrollView>
            {ALL_MODES.map((m) => (
              <Pressable
                key={m}
                onPress={() => { setTrackerMode(m); setShowModelPicker(false); }}
                style={{ paddingVertical: 10, paddingHorizontal: 12, borderRadius: 8, marginBottom: 4, backgroundColor: trackerMode === m ? theme.primary : "transparent" }}
              >
                <Text style={{ color: trackerMode === m ? "#fff" : theme.text, fontWeight: trackerMode === m ? "700" : "400", fontSize: 14 }}>
                  {MODE_LABEL[m]}
                </Text>
                <Text style={{ color: trackerMode === m ? "rgba(255,255,255,0.7)" : theme.textSubtle, fontSize: 11 }}>
                  {m === "yolo" ? "Nano — fastest, ~6MB (bundled)" :
                   m === "yolo-s" ? "Small — better accuracy, ~22MB" :
                   m === "yolo-m" ? "Medium — balanced, ~52MB" :
                   m === "yolo-l" ? "Large — high accuracy, ~90MB" :
                   m === "yolo-x" ? "Extra-large — best accuracy, ~130MB" :
                   m === "baseball" ? "Custom baseball detector" :
                   m === "blob" ? "Classical bright-blob detector (no model)" :
                   m === "tracknet" ? "TrackNet ML ball tracker" :
                   m === "vision" ? "Apple Vision object tracker (needs box)" :
                   "Template matching tracker (needs box)"}
                </Text>
              </Pressable>
            ))}

            {/* Download from server */}
            <View style={{ borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border, marginTop: 8, paddingTop: 8 }}>
              <Text style={{ color: theme.textSubtle, fontSize: 11, marginBottom: 6 }}>Download from whyapp.us:</Text>
              <Pressable
                onPress={async () => {
                  try {
                    setBusy("fetching model list…");
                    setShowModelPicker(false);
                    const res = await apiFetch<{ models: { name: string; size: number }[] }>("/tracking/models");
                    if (!res.models.length) { setErr("No models on server"); setBusy(null); return; }
                    // Download the first one not already available.
                    const local = Yolo.availableModels();
                    const toDownload = res.models.find((m) => !local.includes(m.name));
                    if (!toDownload) { setCopyHint("All server models already downloaded"); setBusy(null); setTimeout(() => setCopyHint(null), 3000); return; }
                    setBusy(`downloading ${toDownload.name} (${(toDownload.size / 1024 / 1024).toFixed(1)}MB)…`);
                    await Yolo.downloadModel(`https://api.whyapp.us/tracking/models/${toDownload.name}`, toDownload.name);
                    setCopyHint(`Downloaded ${toDownload.name}`);
                    setTimeout(() => setCopyHint(null), 3000);
                  } catch (e) { setErr((e as Error).message); }
                  finally { setBusy(null); }
                }}
                style={[styles.btn, { backgroundColor: theme.surfaceAlt }]}
              >
                <Text style={[styles.btnText, { color: theme.text, fontSize: 12 }]}>Check for models</Text>
              </Pressable>
              <Text style={{ color: theme.textSubtle, fontSize: 9, marginTop: 4 }}>
                Available: {Yolo.availableModels().join(", ") || "loading…"}
              </Text>
            </View>
          </ScrollView>
        </View>
      </Pressable>
    </Modal>
    </>
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
