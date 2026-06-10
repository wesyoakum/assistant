import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  Pressable,
  Image,
  StyleSheet,
  ScrollView,
  SafeAreaView,
  PanResponder,
  ActivityIndicator,
  Modal,
  type LayoutChangeEvent,
  TextInput,
  Alert,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import * as Clipboard from "expo-clipboard";
import Svg, { Path } from "react-native-svg";
import { VisionTracker, type NormalizedBox, type TrackedFrame, type FirstFrameResult } from "expo-vision-tracker";
import { TemplateTracker } from "expo-template-tracker";
import { TrackNet } from "expo-tracknet";
import { Yolo } from "expo-yolo";
import { Baseball } from "expo-baseball";
import { Video, ResizeMode, type AVPlaybackStatus } from "expo-av";
import { detectorWalk, type RawDetection } from "./detectorWalk";
import { CameraCapture, type CameraCaptureHandle } from "./CameraCapture";
import type { FieldModelOverlayHandle } from "../field/FieldModelOverlay";
const FieldModelOverlay = React.lazy(() =>
  import("../field/FieldModelOverlay").then((m) => ({ default: m.FieldModelOverlay })),
);
import { RoiOverlay, type RoiOverlayHandle } from "./RoiOverlay";
import { type CameraPose } from "../field/batterBox";
import { decomposeCameraPose, intrinsicsFromFov, type CameraIntrinsics } from "../field/cameraPoseDecompose";
import { formatXYZ } from "../field/userCoords";
import { computeBallDirection, type BallDirection } from "../field/ballAngles";
import { apiFetch } from "../api/client";
import type { TrackerSession } from "./session";
import { rejectOutliers } from "./outlierRejection";
import { lsqQuadratic, computeR2 } from "./polyFit";
import { BallisticTracker } from "./ballisticTracker";
import { FieldLinesOverlay } from "../field/FieldLinesOverlay";
const FieldModelView = React.lazy(() =>
  import("../field/FieldModelView").then((m) => ({ default: m.FieldModelView })),
);
import { useTrackerSettings } from "../state/trackerSettings";
import { computeRayInfo, type RayInfo } from "../field/rayTrace";
import { listSavedVideos, saveVideo, deleteSavedVideo, type SavedVideo } from "./savedVideos";
import { listCalibrations, saveCalibration, deleteCalibration, renameCalibration, type SavedCalibration } from "./savedCalibrations";
import { listRois, saveRoi, deleteRoi, renameRoi, type SavedRoi } from "./savedRois";
import { useOrientation } from "../hooks/useOrientation";
import { useNavigation } from "expo-router";
import { useTheme } from "../theme";

type TrackerMode = "yolo";
const DETECTOR_MODES: TrackerMode[] = ["yolo"];
const MODE_LABEL: Record<TrackerMode, string> = { yolo: "YOLO26n" };
const OTA_TIMESTAMP = "2026-06-09e";

/** Draggable number input — drag horizontally to change value, like Blender. */
function DragNumber({ value, onChange, min, max, label, suffix = "" }: {
  value: number; onChange: (v: number) => void; min: number; max: number; label: string; suffix?: string;
}) {
  const startRef = React.useRef({ x: 0, val: 0 });
  const responder = React.useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (_, gs) => { startRef.current = { x: gs.x0, val: value }; },
    onPanResponderMove: (_, gs) => {
      const delta = (gs.moveX - startRef.current.x) * 0.3;
      const newVal = Math.round(Math.max(min, Math.min(max, startRef.current.val + delta)));
      if (newVal !== value) onChange(newVal);
    },
  }), [value, onChange, min, max]);
  return (
    <View {...responder.panHandlers} style={{ backgroundColor: "rgba(0,0,0,0.6)", paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6, borderWidth: 1, borderColor: "rgba(255,255,255,0.2)" }}>
      <Text style={{ color: "#fff", fontSize: 11, fontWeight: "600" }}>{label} {value}{suffix}</Text>
    </View>
  );
}
const BOX_COLOR_TEXT = "rgba(0,200,255,1)";

interface ViewState {
  scale: number;
  tx: number;
  ty: number;
}

const MIN_SCALE = 0.3;
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
  const [showSettings, setShowSettings] = useState(false);
  const [showCalPicker, setShowCalPicker] = useState(false);
  const [savedCals, setSavedCals] = useState<SavedCalibration[]>([]);
  const [renamingCalId, setRenamingCalId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");
  const [showRoiPicker, setShowRoiPicker] = useState(false);
  const [savedRois, setSavedRois] = useState<SavedRoi[]>([]);
  const [renamingRoiId, setRenamingRoiId] = useState<string | null>(null);
  const [renameRoiText, setRenameRoiText] = useState("");
  const [savedViewUrl, setSavedViewUrl] = useState<string | null>(null);
  const [showProcessed, setShowProcessed] = useState(false);
  const [showAllDetections, setShowAllDetections] = useState(false);
  const [isDetecting, setIsDetecting] = useState(false);
  const streamingFramesRef = useRef<TrackedFrame[]>([]);
  const streamingMetaRef = useRef<{ videoWidth: number; videoHeight: number; frameRate: number } | null>(null);
  const detectionSubRef = useRef<{ remove: () => void } | null>(null);
  const [fullScreen, setFullScreen] = useState(false);
  const { preprocessBW, contrastLevel, outlierRejection, outlierThreshold, basepathFt, trackR2Threshold, cameraFovDeg } = useTrackerSettings();
  const [showPoseOverlay, setShowPoseOverlay] = useState(false);
  const [cameraPose, setCameraPose] = useState<CameraPose | null>(null);
  const [cameraXYZ, setCameraXYZ] = useState<{ x: number; y: number; z: number } | null>(null);
  const [cameraAngles, setCameraAngles] = useState<{ panDeg: number; tiltDeg: number; rollDeg: number } | null>(null);
  const [showRoiOverlay, setShowRoiOverlay] = useState(false);
  const [showFieldLines, setShowFieldLines] = useState(true);
  const [showStrikeZone, setShowStrikeZone] = useState(true);
  const [startTimeSec, setStartTimeSec] = useState<number | null>(null);
  const [endTimeSec, setEndTimeSec] = useState<number | null>(null);
  const videoRef = useRef<Video>(null);
  const poseOverlayRef = useRef<FieldModelOverlayHandle>(null);
  const roiOverlayRef = useRef<RoiOverlayHandle>(null);
  // Refs so the PanResponder (memoized) can read overlay state without re-creating.
  const showPoseOverlayRef = useRef(false);
  const showRoiOverlayRef = useRef(false);
  useEffect(() => { showPoseOverlayRef.current = showPoseOverlay; }, [showPoseOverlay]);

  useEffect(() => { showRoiOverlayRef.current = showRoiOverlay; }, [showRoiOverlay]);

  // Load saved videos and calibrations on mount.
  useEffect(() => { listSavedVideos().then(setSavedVideos).catch(() => {}); }, []);
  useEffect(() => { listCalibrations().then(setSavedCals).catch(() => {}); }, []);

  // Prune expired live dots every 100ms (visible for 2s, fade over 1s, gone at 3s).
  useEffect(() => {
    if (!liveRecording && liveDots.length === 0) return;
    const id = setInterval(() => {
      const now = Date.now();
      setLiveDots((prev) => prev.filter((d) => now - d.t < 3000));
    }, 100);
    return () => clearInterval(id);
  }, [liveRecording, liveDots.length > 0]);
  useEffect(() => { listRois().then(setSavedRois).catch(() => {}); }, []);

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

  const [showSourcePicker, setShowSourcePicker] = useState(false);
  const [showCamera, setShowCamera] = useState(false);
  const [liveMode, setLiveMode] = useState(false);
  const [liveSnapshot, setLiveSnapshot] = useState<{ base64: string; width: number; height: number } | null>(null);
  const [liveRecording, setLiveRecording] = useState(false);
  const [liveSegmentCount, setLiveSegmentCount] = useState(0);
  const liveCameraRef = useRef<CameraCaptureHandle>(null);
  const liveFrameOffsetRef = useRef(0);
  const liveProcessingChainRef = useRef<Promise<void>>(Promise.resolve());
  const [liveDots, setLiveDots] = useState<{ nx: number; ny: number; t: number; label: string; box?: { x: number; y: number; w: number; h: number } }[]>([]);

  const pickFromLibrary = async () => {
    setShowSourcePicker(false);
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

  const pickVideo = () => setShowSourcePicker(true);

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

  // Accumulated detections in step-by-step mode.
  const [detections, setDetections] = useState<Map<number, TrackedFrame>>(new Map());
  const [detectMode, setDetectMode] = useState(false);
  const [validatedFrames, setValidatedFrames] = useState<Set<number>>(new Set());
  const ballisticRef = useRef<BallisticTracker | null>(null);

  // Detect a single frame at the given timestamp using the native pipeline.
  const detectSingleFrame = useCallback(async (timeSec: number, frameIdx: number) => {
    if (!videoUri || !frame) return;
    const roi = box ?? undefined;
    const fps = frame.frameRate > 0 ? frame.frameRate : 30;
    try {
      const r = await Yolo.detectInVideo(videoUri, {
        startTimeSec: timeSec,
        endTimeSec: timeSec + 1 / Math.min(fps, 30) + 0.001,
        stepSec: 1 / Math.min(fps, 30),
        maxFrames: 1,
        maxMisses: 1,
        minConfidence: 0.10,
        labelFilter: ["sports ball"],
        roi,
        preprocess: preprocessBW ? { grayscale: true, contrast: contrastLevel } : undefined,
      });
      if (r.frames.length > 0) {
        const det = r.frames[0]!;
        det.timeSec = timeSec;
        det.frameIndex = frameIdx;
        setDetections((prev) => {
          const next = new Map(prev);
          next.set(frameIdx, det);
          return next;
        });
      }
    } catch (e) {
      // Detection failed for this frame — skip.
    }
  }, [videoUri, frame, box, preprocessBW, contrastLevel]);

  // Enter detection mode — detect current frame and switch to results view.
  const runTracker = async () => {
    if (!videoUri || !frame) return;
    setDetectMode(true);
    setDetections(new Map());
    setValidatedFrames(new Set());
    ballisticRef.current = new BallisticTracker({
      frameRate: Math.min(frame.frameRate > 0 ? frame.frameRate : 30, 30),
      r2Threshold: trackR2Threshold,
    });

    // Build initial result from just the current frame.
    const fps = frame.frameRate > 0 ? frame.frameRate : 30;
    const totalFrames = Math.ceil(frame.durationSec * Math.min(fps, 30));
    const emptyFrames: TrackedFrame[] = Array.from({ length: totalFrames }, (_, i) => ({
      frameIndex: i,
      timeSec: i / Math.min(fps, 30),
      box: null,
      confidence: 0,
      lost: true,
    }));

    setResult({
      frames: emptyFrames,
      elapsedMs: 0,
      videoWidth: frame.imageWidth,
      videoHeight: frame.imageHeight,
      frameRate: fps,
      mode: "yolo" as TrackerMode,
    });
    setReviewIdx(0);

    // Detect the current frame.
    await detectSingleFrame(frameTimeSec, Math.round(frameTimeSec * Math.min(fps, 30)));
  };

  // Update result frames and run ballistic validation when detections change.
  useEffect(() => {
    if (!detectMode || !result) return;
    const updated = result.frames.map((f) => {
      const det = detections.get(f.frameIndex);
      if (det) return { ...f, box: det.box, confidence: det.confidence, lost: det.lost };
      return f;
    });
    setResult((prev) => prev ? { ...prev, frames: updated } : prev);

    // Feed new detections to ballistic tracker.
    const bt = ballisticRef.current;
    if (!bt || !cameraPose || !cameraXYZ || !frame) return;
    const K = intrinsicsFromFov(result.videoWidth, result.videoHeight, cameraFovDeg || 72);
    // Process all detections in order.
    const sorted = [...detections.entries()].sort((a, b) => a[0] - b[0]);
    // Reset and replay (tracker is stateful, replaying is safe since it's fast).
    bt.constructor.prototype.constructor.call(bt); // can't reset easily, just rebuild
    const freshBt = new BallisticTracker({
      frameRate: result.frameRate,
      r2Threshold: trackR2Threshold,
    });
    for (const [fi, det] of sorted) {
      if (!det.box || det.lost) { freshBt.tick(fi); continue; }
      const cx = det.box.x + det.box.width / 2;
      const cy = det.box.y + det.box.height / 2;
      const ray = computeRayInfo(cx, cy, result.videoWidth, result.videoHeight, K, cameraPose.fit.Hinv, cameraXYZ, false, fi, det.timeSec);
      if (ray && ray.yzY != null && ray.yzZ != null) {
        freshBt.addObservation({
          frameIndex: fi, timeSec: det.timeSec,
          yzY: ray.yzY, yzZ: ray.yzZ,
          pixelX: cx, pixelY: cy,
          confidence: det.confidence,
          rayDir: { x: ray.rayDirX, y: ray.rayDirY, z: ray.rayDirZ },
        });
      } else {
        freshBt.tick(fi);
      }
    }
    ballisticRef.current = freshBt;
    setValidatedFrames(freshBt.getFilteredFrameIndices());
  }, [detections, detectMode]);

  // Detect on frame change in detect mode.
  useEffect(() => {
    if (!detectMode || !result || !videoUri || !frame) return;
    const fps = Math.min(frame.frameRate > 0 ? frame.frameRate : 30, 30);
    const reviewedF = result.frames[reviewIdx];
    if (!reviewedF) return;
    // Skip if already detected this frame.
    if (detections.has(reviewedF.frameIndex)) return;
    detectSingleFrame(reviewedF.timeSec, reviewedF.frameIndex);
  }, [reviewIdx, detectMode, result, detections, detectSingleFrame]);

  const resetViewport = () => setVp({ scale: 1, tx: 0, ty: 0 });
  const zoomBy = (factor: number) =>
    setVp((v) => {
      const newScale = clamp(v.scale * factor, MIN_SCALE, MAX_SCALE);
      // Keep the current pan but rescale it proportionally so the same point
      // stays under the center of the canvas across the zoom step.
      const k = v.scale === 0 ? 1 : newScale / v.scale;
      return clampViewport({ scale: newScale, tx: v.tx * k, ty: v.ty * k }, canvasRef.current);
    });

  // Per-frame box with gaps filled by linear interpolation.
  const interpolated = useMemo(() => {
    if (!result) return null;
    return interpolateBoxes(result.frames, box);
  }, [result, box]);

  // Polynomial fit path through validated detections (detect mode only).
  const polyFitPath = useMemo(() => {
    if (!detectMode || validatedFrames.size < 3 || !result) return "";
    // Get validated detections sorted by time.
    const pts = [...detections.entries()]
      .filter(([fi]) => validatedFrames.has(fi))
      .map(([_, d]) => ({ t: d.timeSec, cx: d.box!.x + d.box!.width / 2, cy: d.box!.y + d.box!.height / 2 }))
      .filter((p) => p.cx != null)
      .sort((a, b) => a.t - b.t);
    if (pts.length < 3) return "";
    const ts = pts.map((p) => p.t);
    const fX = lsqQuadratic(ts, pts.map((p) => p.cx));
    const fY = lsqQuadratic(ts, pts.map((p) => p.cy));
    // Sample the polynomial across the time range + a bit of extrapolation.
    const tMin = ts[0]!, tMax = ts[ts.length - 1]!;
    const extend = (tMax - tMin) * 0.15;
    const steps = 40;
    const pathPts: string[] = [];
    for (let i = 0; i <= steps; i++) {
      const t = (tMin - extend) + (i / steps) * (tMax - tMin + 2 * extend);
      const x = fX[0]! * t * t + fX[1]! * t + fX[2]!;
      const y = fY[0]! * t * t + fY[1]! * t + fY[2]!;
      if (x < -0.1 || x > 1.1 || y < -0.1 || y > 1.1) continue;
      pathPts.push(`${i === 0 || pathPts.length === 0 ? "M" : "L"} ${x} ${y}`);
    }
    return pathPts.join(" ");
  }, [detectMode, validatedFrames, detections, result]);

  // Smooth Catmull-Rom path through every real detection center (hidden in detect mode).
  const splinePath = useMemo(() => {
    if (!result || !interpolated || detectMode) return "";
    const pts: Array<{ x: number; y: number }> = [];
    const end = showAllDetections ? result.frames.length - 1 : reviewIdx;
    for (let i = 0; i <= end && i < result.frames.length; i++) {
      const f = result.frames[i]!;
      if (!f.box || f.lost) continue;
      pts.push({
        x: f.box.x + f.box.width / 2,
        y: f.box.y + f.box.height / 2,
      });
    }
    return catmullRomPath(pts);
  }, [result, interpolated, reviewIdx, showAllDetections]);

  // While detection is streaming, copy accumulated frames to state.
  useEffect(() => {
    if (!isDetecting) return;
    const id = setInterval(() => {
      const frames = streamingFramesRef.current;
      const meta = streamingMetaRef.current;
      if (!frames.length || !meta) return;
      setResult({
        frames: [...frames],
        elapsedMs: 0,
        videoWidth: meta.videoWidth,
        videoHeight: meta.videoHeight,
        frameRate: meta.frameRate,
        mode: trackerMode as TrackerMode,
      });
    }, 50);
    return () => clearInterval(id);
  }, [isDetecting, trackerMode]);

  const isDetectingRef = useRef(false);
  useEffect(() => { isDetectingRef.current = isDetecting; }, [isDetecting]);

  // Map video playback position → reviewIdx for overlay sync.
  const detectModeRef = useRef(detectMode);
  useEffect(() => { detectModeRef.current = detectMode; }, [detectMode]);

  const onPlaybackStatus = useCallback((status: AVPlaybackStatus) => {
    if (!status.isLoaded || !result) return;
    // In detect mode, transport buttons control reviewIdx — don't let the video override it.
    if (detectModeRef.current) {
      if (status.didJustFinish) setIsPlaying(false);
      return;
    }
    const posSec = status.positionMillis / 1000;
    const frames = result.frames;
    let idx = 0;
    for (let i = 0; i < frames.length; i++) {
      if (frames[i].timeSec <= posSec) idx = i;
      else break;
    }
    setReviewIdx(idx);
    if (status.didJustFinish && !isDetectingRef.current) setIsPlaying(false);
  }, [result]);

  // Seek video when result first appears (non-detect mode only).
  const resultRef = useRef(result);
  useEffect(() => {
    if (!result || !videoRef.current || detectMode) return;
    if (resultRef.current !== result) {
      resultRef.current = result;
      const startMs = (result.frames[reviewIdx]?.timeSec ?? result.frames[0]?.timeSec ?? 0) * 1000;
      videoRef.current.setPositionAsync(startMs);
    }
  }, [result, reviewIdx, detectMode]);

  // Sync playback speed to video player.
  useEffect(() => {
    videoRef.current?.setRateAsync(playSpeed, false);
  }, [playSpeed]);

  // Seek the video to a specific frame index.
  const seekToFrame = useCallback(async (idx: number) => {
    if (!result || !videoRef.current) return;
    const ms = (result.frames[idx]?.timeSec ?? 0) * 1000;
    // Use setStatusAsync to atomically set position + pause in one call.
    await videoRef.current.setStatusAsync({
      positionMillis: ms,
      shouldPlay: !detectModeRef.current,
    });
  }, [result]);

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
    if (!cameraPose || !cameraXYZ || !result || !interpolated || !frame || !result.frames) return null;
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

  // Speed (mph) at the current review frame, computed from consecutive MPI points.
  const currentSpeedMph = useMemo((): number | null => {
    if (!allRayInfo) return null;
    const cur = allRayInfo.find((r) => r.frameIndex === reviewIdx);
    if (!cur || cur.yzY == null || cur.yzZ == null) return null;
    // Find previous frame with valid MPI
    for (let j = allRayInfo.length - 1; j >= 0; j--) {
      const prev = allRayInfo[j]!;
      if (prev.frameIndex >= reviewIdx) continue;
      if (prev.yzY == null || prev.yzZ == null) continue;
      const dd = cur.yzY - prev.yzY;
      const dz = cur.yzZ - prev.yzZ;
      const dist = Math.sqrt(dd * dd + dz * dz);
      const dt = cur.timeSec - prev.timeSec;
      if (dt <= 0) return null;
      return (dist / dt) * 2.23694; // m/s → mph
    }
    return null;
  }, [allRayInfo, reviewIdx]);

  // Frame image: use frameAtTime for B&W mode OR detect mode (frame-accurate).
  const [reviewImage, setReviewImage] = useState<{ base64: string; timeSec: number } | null>(null);
  useEffect(() => {
    const needImage = showProcessed || detectMode;
    if (!needImage || !result || !videoUri || !reviewedFrame) {
      setReviewImage(null);
      return;
    }
    const t = reviewedFrame.timeSec;
    let cancelled = false;
    VisionTracker.frameAtTime(videoUri, t, 0.85)
      .then((f) => { if (!cancelled) setReviewImage({ base64: f.imageBase64, timeSec: t }); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [showProcessed, detectMode, reviewIdx, result, videoUri, reviewedFrame?.timeSec]);

  if (!VisionTracker.available()) {
    return (
      <View style={{ padding: 16 }}>
        <Text style={{ color: theme.text }}>expo-vision-tracker native module is not in this build. Rebuild required.</Text>
      </View>
    );
  }

  // ── Extracted handlers (used by pill buttons) ─────────────────────────

  const handleLoadSession = async () => {
    setBusy("loading sessions…");
    try {
      const res = await apiFetch<{ sessions: { id: string; uploaded: string }[] }>("/tracking");
      if (!res.sessions.length) { setErr("No saved sessions"); setBusy(null); return; }
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
  };

  const handleSaveVideoLocal = async () => {
    if (!videoUri) return;
    setBusy("saving…");
    try {
      const saved = await saveVideo(videoUri);
      loadVideo(saved.uri);
      setSavedVideos(await listSavedVideos());
      setIsSaved(true);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(null); }
  };

  const handleSetPose = () => {
    const pose = poseOverlayRef.current?.solve();
    if (pose && frame) {
      setCameraPose(pose);
      const K = intrinsicsFromFov(frame.imageWidth, frame.imageHeight, frame.hFovDeg ?? 0);
      const decomp = decomposeCameraPose(pose.fit.H, K);
      if (decomp) {
        setCameraXYZ(decomp.position);
        setCameraAngles({ panDeg: decomp.panDeg, tiltDeg: decomp.tiltDeg, rollDeg: decomp.rollDeg });
      }
    }
  };

  const handleSaveCal = async () => {
    const state = poseOverlayRef.current?.getState?.();
    if (!state) return;
    setBusy("saving calibration…");
    try {
      const pose = poseOverlayRef.current?.solve();
      await saveCalibration({
        name: new Date().toLocaleString(),
        positions: state.positions,
        anchored: state.anchored,
        cameraPose: pose ? { H: pose.fit.H, Hinv: pose.fit.Hinv, rmsPx: pose.fit.rmsPx, count: pose.fit.count } : null,
        cameraXYZ,
        cameraAngles,
        basepathFt,
        fovDeg: cameraFovDeg,
      });
      setSavedCals(await listCalibrations());
      setCopyHint("Calibration saved");
      setTimeout(() => setCopyHint(null), 3000);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(null); }
  };

  const handleLoadCal = () => {
    listCalibrations().then((cals) => {
      setSavedCals(cals);
      if (!cals.length) { setErr("No saved calibrations"); return; }
      setShowCalPicker(true);
    }).catch(() => setErr("Failed to load calibrations"));
  };

  const applyCalibration = (cal: SavedCalibration) => {
    if (cal.positions && cal.anchored) {
      poseOverlayRef.current?.setState?.({ positions: cal.positions, anchored: cal.anchored });
    }
    if (cal.cameraPose) setCameraPose({ fit: cal.cameraPose as any, sides: ["left", "right"] });
    if (cal.cameraXYZ) setCameraXYZ(cal.cameraXYZ);
    if (cal.cameraAngles) setCameraAngles(cal.cameraAngles);
    if (cal.basepathFt) useTrackerSettings.getState().setBasepathFt(cal.basepathFt);
    if (cal.fovDeg) useTrackerSettings.getState().setCameraFovDeg(cal.fovDeg);
    setShowCalPicker(false);
    setCopyHint(`Loaded: ${cal.name}`);
    setTimeout(() => setCopyHint(null), 3000);
  };

  const handleDeleteCal = (id: string, name: string) => {
    Alert.alert("Delete Calibration", `Delete "${name}"?`, [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: async () => {
        await deleteCalibration(id);
        setSavedCals(await listCalibrations());
      }},
    ]);
  };

  const handleRenameCal = async (id: string) => {
    if (!renameText.trim()) return;
    await renameCalibration(id, renameText.trim());
    setSavedCals(await listCalibrations());
    setRenamingCalId(null);
    setRenameText("");
  };

  const handleSaveRoi = async () => {
    const roi = roiOverlayRef.current?.getBox() ?? box;
    if (!roi) return;
    try {
      await saveRoi({ name: new Date().toLocaleString(), box: roi });
      setSavedRois(await listRois());
      setCopyHint("ROI saved");
      setTimeout(() => setCopyHint(null), 3000);
    } catch (e) { setErr((e as Error).message); }
  };

  const handleLoadRoi = () => {
    listRois().then((rois) => {
      setSavedRois(rois);
      if (!rois.length) { setErr("No saved ROIs"); return; }
      setShowRoiPicker(true);
    }).catch(() => setErr("Failed to load ROIs"));
  };

  const applyRoi = (roi: SavedRoi) => {
    setBox(roi.box);
    setShowRoiPicker(false);
    setShowRoiOverlay(false);
    setCopyHint(`Loaded: ${roi.name}`);
    setTimeout(() => setCopyHint(null), 3000);
  };

  const handleDeleteRoi = (id: string, name: string) => {
    Alert.alert("Delete ROI", `Delete "${name}"?`, [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: async () => {
        await deleteRoi(id);
        setSavedRois(await listRois());
      }},
    ]);
  };

  const handleRenameRoi = async (id: string) => {
    if (!renameRoiText.trim()) return;
    await renameRoi(id, renameRoiText.trim());
    setSavedRois(await listRois());
    setRenamingRoiId(null);
    setRenameRoiText("");
  };

  // ── Live detection ──────────────────────────────────────────────────

  const handleLiveSnap = async () => {
    const snap = await liveCameraRef.current?.takeSnapshot();
    if (snap) setLiveSnapshot(snap);
  };

  const processLiveSegment = useCallback(async (segmentUri: string) => {
    const fps = 30;
    const segDuration = 1.0;
    liveFrameOffsetRef.current += Math.round(fps * segDuration);
    const detectOpts = {
      startTimeSec: 0,
      endTimeSec: segDuration,
      stepSec: 1 / fps,
      minConfidence: 0.10,
      roi: box ?? undefined,
      preprocess: preprocessBW ? { grayscale: true, contrast: contrastLevel } : undefined,
    };
    // Run ball detection (feeds streamingFramesRef via onDetection subscription).
    try {
      await Yolo.detectInVideo(segmentUri, { ...detectOpts, labelFilter: ["sports ball"] });
    } catch {}
    // Run person detection (separate pass — results go to liveDots only, not streamingFrames).
    try {
      const personResult = await Yolo.detectInVideo(segmentUri, { ...detectOpts, labelFilter: ["person"], minConfidence: 0.25 });
      const now = Date.now();
      const newDots = personResult.frames
        .filter((f) => f.box && !f.lost)
        .map((f) => ({
          nx: f.box!.x + f.box!.width / 2,
          ny: f.box!.y + f.box!.height / 2,
          t: now,
          label: "person",
          box: { x: f.box!.x, y: f.box!.y, w: f.box!.width, h: f.box!.height },
        }));
      if (newDots.length > 0) setLiveDots((prev) => [...prev, ...newDots]);
    } catch {}
  }, [box, preprocessBW, contrastLevel]);

  const onLiveSegmentReady = useCallback((uri: string) => {
    setLiveSegmentCount((c) => c + 1);
    // Queue sequential processing so segments are detected in order.
    liveProcessingChainRef.current = liveProcessingChainRef.current.then(() => processLiveSegment(uri));
  }, [processLiveSegment]);

  const startLiveDetection = useCallback(() => {
    // Use snapshot dimensions if available, otherwise default to 1080p.
    const w = liveSnapshot?.width ?? 1920;
    const h = liveSnapshot?.height ?? 1080;
    // Reset state.
    liveFrameOffsetRef.current = 0;
    liveProcessingChainRef.current = Promise.resolve();
    setLiveSegmentCount(0);
    streamingFramesRef.current = [];
    streamingMetaRef.current = {
      videoWidth: w,
      videoHeight: h,
      frameRate: 30,
    };
    setResult(null);
    setDetections(new Map());
    setValidatedFrames(new Set());
    ballisticRef.current = new BallisticTracker({
      frameRate: 30,
      r2Threshold: trackR2Threshold,
    });

    // Subscribe to detection events.
    detectionSubRef.current?.remove();
    const baseOffsetRef = liveFrameOffsetRef; // capture ref
    detectionSubRef.current = Yolo.onDetection((frame) => {
      streamingFramesRef.current.push({
        ...frame,
        frameIndex: streamingFramesRef.current.length,
        timeSec: streamingFramesRef.current.length / 30,
      });
      // Push dot for live overlay (only if detected).
      if (frame.box && !frame.lost) {
        const cx = frame.box.x + frame.box.width / 2;
        const cy = frame.box.y + frame.box.height / 2;
        setLiveDots((prev) => [...prev, { nx: cx, ny: cy, t: Date.now(), label: "ball" }]);
      }
    });

    setLiveDots([]);
    setIsDetecting(true);
    setLiveRecording(true);
    setLiveSnapshot(null); // Switch back to camera preview while recording.

    // Start camera buffer recording.
    liveCameraRef.current?.startBuffering();
  }, [liveSnapshot, trackR2Threshold]);

  const stopLiveDetection = useCallback(() => {
    // Stop camera recording.
    liveCameraRef.current?.stopBuffering();
    setLiveRecording(false);

    // Wait for processing to finish, then finalize.
    liveProcessingChainRef.current.then(() => {
      detectionSubRef.current?.remove();
      detectionSubRef.current = null;
      setIsDetecting(false);

      // Flush final results.
      const frames = [...streamingFramesRef.current];
      const meta = streamingMetaRef.current;
      if (frames.length > 0 && meta) {
        setResult({
          frames,
          elapsedMs: 0,
          videoWidth: meta.videoWidth,
          videoHeight: meta.videoHeight,
          frameRate: meta.frameRate,
          mode: "yolo" as TrackerMode,
        });
        setReviewIdx(0);
      }
      setLiveMode(false);
    });
  }, []);

  const exitLiveMode = useCallback(() => {
    if (liveRecording) stopLiveDetection();
    setLiveMode(false);
    setLiveSnapshot(null);
    setLiveRecording(false);
    setLiveSegmentCount(0);
  }, [liveRecording, stopLiveDetection]);

  const handleSaveSession = async () => {
    if (!result) return;
    setBusy("saving session…");
    try {
      const ip = interpolated ?? [];
      const detections = result.frames.map((f, i) => {
        const p = ip[i];
        const bx = p?.box ?? f.box;
        if (!bx) return null;
        const cx = bx.x + bx.width / 2, cy = bx.y + bx.height / 2;
        const ri = allRayInfo?.find((r) => r.frameIndex === i);
        return {
          frame: i, time: Number(f.timeSec.toFixed(4)),
          type: f.lost ? (p?.interpolated ? "interp" : "lost") : "detect",
          pixel: { x: Number((cx * result.videoWidth).toFixed(1)), y: Number(((1 - cy) * result.videoHeight).toFixed(1)) },
          yzPlane: ri && ri.yzY != null && ri.yzZ != null ? { y: Number(ri.yzY.toFixed(4)), z: Number(ri.yzZ.toFixed(4)) } : null,
          ray: ri ? { dx: Number(ri.rayDirX.toFixed(5)), dy: Number(ri.rayDirY.toFixed(5)), dz: Number(ri.rayDirZ.toFixed(5)) } : null,
        };
      }).filter(Boolean);
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
        settings: { preprocessBW, contrastLevel, outlierRejection, outlierThreshold, roiSize: useTrackerSettings.getState().roiSize, basepathFt, trackR2Threshold },
      };
      const payload = {
        session,
        cameraPose: cameraXYZ ? { position: cameraXYZ, rotation: cameraAngles ? { rx: cameraAngles.tiltDeg, ry: cameraAngles.rollDeg, rz: cameraAngles.panDeg } : null } : null,
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
  };

  const handleExportVideo = async () => {
    if (!result || !videoUri || !interpolated) return;
    setBusy("exporting video…");
    try {
      // Build detection list: all frames with a box (real or interpolated),
      // excluding rejected. Interpolated drawn same as real.
      const dets: Array<{ timeSec: number; cx: number; cy: number }> = [];
      for (let i = 0; i < result.frames.length; i++) {
        const f = result.frames[i]!;
        if ((f as any).rejected) continue;
        const ip = interpolated[i];
        const b = ip?.box ?? f.box;
        if (!b) continue;
        dets.push({
          timeSec: f.timeSec,
          cx: b.x + b.width / 2,
          cy: b.y + b.height / 2,
        });
      }
      const res = await VisionTracker.exportVideo(videoUri, dets, 4, [1, 0.8, 0]);
      // Save to camera roll.
      const MediaLibrary = await import("expo-media-library");
      const perm = await MediaLibrary.requestPermissionsAsync();
      if (perm.granted) {
        await MediaLibrary.saveToLibraryAsync(res.uri);
        setCopyHint(`Exported ${res.frames} frames to camera roll`);
      } else {
        setCopyHint(`Exported to ${res.uri}`);
      }
      setTimeout(() => setCopyHint(null), 5000);
    } catch (e) {
      setErr(`Export failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const handleSaveDetections = async () => {
    if (!result || !interpolated) return;
    setBusy("saving detections…");
    try {
      const ip = interpolated;
      const dets = result.frames.map((f, i) => {
        const p = ip[i];
        const b = p?.box ?? f.box;
        if (!b) return null;
        return {
          frame: i, time: Number(f.timeSec.toFixed(4)),
          type: f.lost ? (p?.interpolated ? "interp" : "lost") : "detect",
          cx: Number((b.x + b.width / 2).toFixed(5)),
          cy: Number((b.y + b.height / 2).toFixed(5)),
          rejected: !!(f as any).rejected,
        };
      }).filter(Boolean);
      await apiFetch("/tracking/detections", { method: "POST", body: JSON.stringify({
        trackerMode, videoWidth: result.videoWidth, videoHeight: result.videoHeight,
        frameRate: result.frameRate, frameCount: result.frames.length, detections: dets,
      }) });
      setCopyHint("Detections saved");
      setTimeout(() => setCopyHint(null), 3000);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(null); }
  };

  const handleLoadDetections = async () => {
    setBusy("loading detections…");
    try {
      const res = await apiFetch<{ detections: { id: string; uploaded: string }[] }>("/tracking/detections");
      if (!res.detections.length) { setErr("No saved detections"); setBusy(null); return; }
      const latest = res.detections[0]!;
      const data = await apiFetch<any>(`/tracking/detections/${latest.id}`);
      setCopyHint(`Loaded detections ${latest.id}`);
      setTimeout(() => setCopyHint(null), 3000);
      // The detections are available but we'd need the video+result to display them.
      // For now, copy the detection JSON to clipboard.
      await Clipboard.setStringAsync(JSON.stringify(data.detections || [], null, 2));
      setCopyHint(`Loaded ${(data.detections || []).length} detections to clipboard`);
      setTimeout(() => setCopyHint(null), 3000);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(null); }
  };

  const handleCopyPose = async () => {
    if (!cameraXYZ) return;
    const lines = [
      `pos  x=${cameraXYZ.x.toFixed(3)}  y=${cameraXYZ.y.toFixed(3)}  z=${cameraXYZ.z.toFixed(3)} m`,
      cameraAngles ? `rot  rx=${cameraAngles.tiltDeg.toFixed(1)}  ry=${cameraAngles.rollDeg.toFixed(1)}  rz=${cameraAngles.panDeg.toFixed(1)} deg` : "",
    ].filter(Boolean).join("\n");
    await Clipboard.setStringAsync(lines);
    setCopyHint("Copied camera pose");
    setTimeout(() => setCopyHint(null), 3000);
  };

  const handleCopyDetections = async () => {
    if (!allRayInfo || !cameraXYZ) return;
    const lines = [
      `Camera Pose`,
      `pos  x=${cameraXYZ.x.toFixed(3)}  y=${cameraXYZ.y.toFixed(3)}  z=${cameraXYZ.z.toFixed(3)} m`,
      cameraAngles ? `rot  rx=${cameraAngles.tiltDeg.toFixed(1)}  ry=${cameraAngles.rollDeg.toFixed(1)}  rz=${cameraAngles.panDeg.toFixed(1)} deg` : "",
      "",
      "frame\ttime\ttype\tpixel_x\tpixel_y\tmid_d\tmid_z\tray_dir_x\tray_dir_y\tray_dir_z",
      ...allRayInfo.map((r) =>
        `${r.frameIndex}\t${r.timeSec.toFixed(4)}\t${r.interpolated ? "interp" : "detect"}\t${r.pixelX.toFixed(1)}\t${(result!.videoHeight - r.pixelY).toFixed(1)}\t${r.yzY?.toFixed(4) ?? ""}\t${r.yzZ?.toFixed(4) ?? ""}\t${r.rayDirX.toFixed(5)}\t${r.rayDirY.toFixed(5)}\t${r.rayDirZ.toFixed(5)}`
      ),
    ].filter(Boolean).join("\n");
    await Clipboard.setStringAsync(lines);
    setCopyHint("Copied position data");
    setTimeout(() => setCopyHint(null), 3000);
  };

  const handleClearAll = () => {
    setBox(null); setResult(null); setCameraPose(null); setCameraXYZ(null);
    setCameraAngles(null); setShowPoseOverlay(false); setShowRoiOverlay(false);
    setStartTimeSec(null); setEndTimeSec(null);
  };


  return (
    <>
    {/* ── Live detection mode ──────────────────────────────────────── */}
    {liveMode && !result && (
      <View style={{ flex: 1, backgroundColor: "#000" }}>
        {/* Camera preview or frozen snapshot */}
        {liveSnapshot && !liveRecording ? (
          /* Frozen snapshot for calibration / ROI setup */
          <View style={{ flex: 1 }}>
            <Image
              source={{ uri: `data:image/jpeg;base64,${liveSnapshot.base64}` }}
              style={StyleSheet.absoluteFill}
              resizeMode="contain"
            />
            {showPoseOverlay && (
              <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
                <React.Suspense fallback={null}>
                  <FieldModelOverlay
                    ref={poseOverlayRef}
                    imageWidth={liveSnapshot.width}
                    imageHeight={liveSnapshot.height}
                    vp={{ scale: 1, tx: 0, ty: 0 }}
                    canvas={{ width: liveSnapshot.width, height: liveSnapshot.height }}
                    canvasPageOffset={{ x: 0, y: 0 }}
                    fovDeg={cameraFovDeg}
                  />
                </React.Suspense>
              </View>
            )}
            {/* Controls overlay */}
            <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, justifyContent: "space-between" }} pointerEvents="box-none">
              <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 4, paddingTop: 50, paddingHorizontal: 8 }}>
                {showPoseOverlay && (
                  <>
                    <Pill label="Reset" onPress={() => poseOverlayRef.current?.reset()} small />
                    <Pill label="Save" onPress={handleSaveCal} disabled={!!busy} small />
                    <Pill label="Load" onPress={handleLoadCal} disabled={!!busy} small />
                    <Pill label="Set Pose" active onPress={handleSetPose} small />
                    <Pill label="Back" onPress={() => setShowPoseOverlay(false)} small />
                    <DragNumber value={cameraFovDeg} onChange={(v) => useTrackerSettings.getState().setCameraFovDeg(v)} min={20} max={120} label="FOV" suffix="°" />
                  </>
                )}
                {!showPoseOverlay && (
                  <>
                    <Pill label={cameraPose ? "Cal ✓" : "Cal"} active={!!cameraPose} onPress={() => setShowPoseOverlay(true)} small />
                    <Pill label={box ? "ROI ✓" : "ROI"} active={!!box} onPress={handleLoadRoi} small />
                    <Pill label="Load Cal" onPress={handleLoadCal} small />
                    <Pill label="Load ROI" onPress={handleLoadRoi} small />
                  </>
                )}
              </View>
              {!showPoseOverlay && (
                <View style={{ flexDirection: "row", justifyContent: "center", gap: 8, paddingBottom: 50 }}>
                  <Pill label="Re-snap" onPress={() => setLiveSnapshot(null)} />
                  <Pill label="Go" active onPress={startLiveDetection} />
                  <Pill label="Exit" onPress={exitLiveMode} />
                </View>
              )}
            </View>
          </View>
        ) : (
          /* Live camera preview (or recording) */
          <View style={{ flex: 1 }}>
            <CameraCapture
              ref={liveCameraRef}
              inline
              onCapture={() => {}}
              onCancel={() => {}}
              onSegmentReady={onLiveSegmentReady}
            />
            {/* Live detection overlay: dots for ball, boxes for person */}
            {liveDots.length > 0 && (
              <View style={StyleSheet.absoluteFill} pointerEvents="none">
                {liveDots.map((d, i) => {
                  const age = (Date.now() - d.t) / 1000;
                  const opacity = age < 2 ? 1 : Math.max(0, 1 - (age - 2));
                  if (d.label === "person" && d.box) {
                    return (
                      <View
                        key={`${d.t}-${i}`}
                        style={{
                          position: "absolute",
                          left: `${d.box.x * 100}%`,
                          top: `${d.box.y * 100}%`,
                          width: `${d.box.w * 100}%`,
                          height: `${d.box.h * 100}%`,
                          borderWidth: 1.5,
                          borderColor: `rgba(80,160,255,${opacity})`,
                          borderRadius: 3,
                        }}
                      />
                    );
                  }
                  return (
                    <View
                      key={`${d.t}-${i}`}
                      style={{
                        position: "absolute",
                        left: `${d.nx * 100}%`,
                        top: `${d.ny * 100}%`,
                        width: 8,
                        height: 8,
                        borderRadius: 4,
                        backgroundColor: `rgba(0,255,100,${opacity})`,
                        marginLeft: -4,
                        marginTop: -4,
                      }}
                    />
                  );
                })}
              </View>
            )}
            {/* Status + controls overlay */}
            <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, justifyContent: "space-between" }} pointerEvents="box-none">
              <View style={{ alignItems: "center", paddingTop: 50 }}>
                {liveRecording && (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: "rgba(255,0,0,0.7)", paddingHorizontal: 12, paddingVertical: 4, borderRadius: 8 }}>
                    <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: "#fff" }} />
                    <Text style={{ color: "#fff", fontSize: 12, fontWeight: "600" }}>
                      LIVE · {liveSegmentCount}s · {streamingFramesRef.current.length} frames
                    </Text>
                  </View>
                )}
                {cameraPose && !liveRecording && (
                  <View style={{ backgroundColor: "rgba(0,0,0,0.6)", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 }}>
                    <Text style={{ color: "#0f0", fontSize: 11 }}>Cal ✓{box ? "  ·  ROI ✓" : ""}</Text>
                  </View>
                )}
              </View>
              <View style={{ flexDirection: "row", justifyContent: "center", gap: 8, paddingBottom: 50 }}>
                {liveRecording ? (
                  <Pill label="Stop" active color="#FF3B30" onPress={stopLiveDetection} />
                ) : (
                  <>
                    <Pill label="Snap" onPress={handleLiveSnap} />
                    <Pill label="Load Cal" onPress={handleLoadCal} />
                    <Pill label="Load ROI" onPress={handleLoadRoi} />
                    {cameraPose && <Pill label="Go" active onPress={startLiveDetection} />}
                    <Pill label="Exit" onPress={exitLiveMode} />
                  </>
                )}
              </View>
            </View>
          </View>
        )}
      </View>
    )}

    {/* ── Empty state: no video loaded ───────────────────────────────── */}
    {!frame && !liveMode && (
      <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: "center", padding: 24, backgroundColor: theme.background }}>
        <Text style={{ fontSize: 18, fontWeight: "700", color: theme.text, textAlign: "center", marginBottom: 6 }}>Home</Text>
        <Text style={{ fontSize: 11, color: theme.textSubtle, textAlign: "center", marginBottom: 12 }}>v{require("../../app.json").expo.version} · {OTA_TIMESTAMP}</Text>
        <Text style={{ fontSize: 12, color: theme.textSubtle, textAlign: "center", marginBottom: 20 }}>
          Pick a video, calibrate the field, set ROI and frame range, run the tracker.
        </Text>

        <View style={{ flexDirection: "row", gap: 8, justifyContent: "center", marginBottom: 16 }}>
          <Pressable onPress={pickVideo} disabled={!!busy} style={[styles.btn, { backgroundColor: theme.primary, opacity: busy ? 0.5 : 1 }]}>
            <Text style={styles.btnText}>Track</Text>
          </Pressable>
          <Pressable onPress={handleLoadSession} disabled={!!busy} style={[styles.btn, { backgroundColor: theme.surfaceAlt, opacity: busy ? 0.5 : 1 }]}>
            <Text style={[styles.btnText, { color: theme.text }]}>Load</Text>
          </Pressable>
        </View>

        {savedVideos.length > 0 && (
          <View style={{ marginBottom: 8 }}>
            <Text style={{ color: theme.textSubtle, fontSize: 12, marginBottom: 4, textAlign: "center" }}>Saved videos:</Text>
            {savedVideos.map((v) => (
              <View key={v.id} style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 4 }}>
                <Pressable onPress={() => loadVideo(v.uri)} style={[styles.btn, { backgroundColor: theme.surfaceAlt, flex: 1, paddingVertical: 8 }]}>
                  <Text style={[styles.btnText, { color: theme.text, fontSize: 12 }]} numberOfLines={1}>{v.name}</Text>
                </Pressable>
                <Pressable onPress={async () => { await deleteSavedVideo(v.id); setSavedVideos(await listSavedVideos()); }} style={[styles.btn, { backgroundColor: theme.surfaceAlt, paddingVertical: 8, paddingHorizontal: 8 }]}>
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
        {busy && (
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, marginTop: 8 }}>
            <ActivityIndicator color={theme.primary} />
            <Text style={{ color: theme.textSubtle, fontSize: 12 }}>{busy}</Text>
          </View>
        )}
        {copyHint && (
          <Text style={{ color: theme.textSubtle, fontSize: 11, marginTop: 6, textAlign: "center" }}>{copyHint}</Text>
        )}
      </ScrollView>
    )}

    {/* ── Video loaded, tracking setup: full-screen ──────────────────── */}
    {frame && !result && (
      <View style={{ flex: 1, backgroundColor: "#000", }}>
        <Text style={{ color: "#fff", fontSize: 12, fontWeight: "600", textAlign: "center", paddingVertical: 4, backgroundColor: "rgba(0,0,0,0.9)" }}>Setup</Text>
        {/* Video fills available space, maintaining aspect ratio */}
        <View style={{ flex: 1, justifyContent: "center", alignItems: "center", }}>
          <View
            ref={canvasRef2}
            {...responder.panHandlers}
            onLayout={onCanvasLayout}
            style={{
              aspectRatio: frame.imageWidth / frame.imageHeight,
              width: "100%",
              maxHeight: "100%",
              overflow: "hidden",
            }}
          >
            <Image
              source={{ uri: `data:image/jpeg;base64,${frame.imageBase64}` }}
              style={{ width: "100%", height: "100%", transform: [{ translateX: vp.tx }, { translateY: vp.ty }, { scale: vp.scale }] }}
              resizeMode="stretch"
              fadeDuration={0}
            />
            {committedBoxScreen && (
              <View pointerEvents="none" style={{ position: "absolute", left: committedBoxScreen.x, top: committedBoxScreen.y, width: committedBoxScreen.w, height: committedBoxScreen.h, borderWidth: 2, borderColor: "#FF3B30", borderStyle: "dashed" }} />
            )}
            {showRoiOverlay && (
              <RoiOverlay ref={roiOverlayRef} imageWidth={frame.imageWidth} imageHeight={frame.imageHeight} vp={vp} canvas={canvas} canvasPageOffset={canvasPageOffsetRef.current} />
            )}
            {showPoseOverlay && (
              <React.Suspense fallback={<View style={StyleSheet.absoluteFill}><Text style={{ color: "#fff", padding: 10 }}>Loading 3D overlay…</Text></View>}>
                <FieldModelOverlay ref={poseOverlayRef} imageWidth={frame.imageWidth} imageHeight={frame.imageHeight} vp={vp} canvas={canvas} canvasPageOffset={canvasPageOffsetRef.current} fovDeg={cameraFovDeg} />
              </React.Suspense>
            )}
            {cameraPose && !showPoseOverlay && showFieldLines && canvas.width > 10 && (
              <React.Suspense fallback={null}>
                <FieldModelView
                  key={`fmv-${Math.round(canvas.width)}-${Math.round(canvas.height)}`}
                  H={cameraPose.fit.H}
                  K={intrinsicsFromFov(frame.imageWidth, frame.imageHeight, cameraFovDeg || 72)}
                  imageWidth={frame.imageWidth}
                  imageHeight={frame.imageHeight}
                  canvasWidth={canvas.width}
                  canvasHeight={canvas.height}
                  opacity={0.5}
                />
              </React.Suspense>
            )}
          </View>
          {/* Transport bar — inside centering container, just below canvas (portrait only) */}
          {!showPoseOverlay && !showRoiOverlay && !isLandscape && (
            <View style={{ flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 1, paddingVertical: 4, paddingHorizontal: 6, }}>
              <Pressable onPress={() => { if (frame) loadFrame(videoUri!, 0); }} disabled={!!busy} style={styles.transportBtn}><Text style={styles.transportTxt}>{"|<<"}</Text></Pressable>
              <Pressable onPress={() => frameStep(-30 * frameStepSec)} disabled={!!busy} style={styles.transportBtn}><Text style={styles.transportTxt}>{"<<"+"<"}</Text></Pressable>
              <Pressable onPress={() => frameStep(-15 * frameStepSec)} disabled={!!busy} style={styles.transportBtn}><Text style={styles.transportTxt}>{"<<"}</Text></Pressable>
              <Pressable onPress={() => frameStep(-frameStepSec)} disabled={!!busy} style={styles.transportBtn}><Text style={styles.transportTxt}>{"<"}</Text></Pressable>
              <Pressable onPress={() => frameStep(frameStepSec)} disabled={!!busy} style={[styles.transportBtn, { paddingHorizontal: 14 }]}><Text style={[styles.transportTxt, { fontSize: 15 }]}>{">"}</Text></Pressable>
              <Pressable onPress={() => frameStep(15 * frameStepSec)} disabled={!!busy} style={styles.transportBtn}><Text style={styles.transportTxt}>{">>"}</Text></Pressable>
              <Pressable onPress={() => frameStep(30 * frameStepSec)} disabled={!!busy} style={styles.transportBtn}><Text style={styles.transportTxt}>{">>"+">"}</Text></Pressable>
              <Pressable onPress={() => { if (frame) loadFrame(videoUri!, frame.durationSec - frameStepSec); }} disabled={!!busy} style={styles.transportBtn}><Text style={styles.transportTxt}>{">>"+"|"}</Text></Pressable>
            </View>
          )}
        </View>

        {/* Pill overlay */}
        <SafeAreaView style={StyleSheet.absoluteFill} pointerEvents="box-none">
          {isLandscape ? (
            /* ── Landscape: top row + side columns ── */
            <View style={{ flex: 1 }} pointerEvents="box-none">
              {/* Top row */}
              <View pointerEvents="box-none" style={{ flexDirection: "row", justifyContent: showPoseOverlay || showRoiOverlay ? "flex-end" : "center", flexWrap: "wrap", gap: 4, paddingTop: 4, paddingHorizontal: 8 }}>
                <View style={{ backgroundColor: "rgba(0,0,0,0.6)", paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6, marginRight: showPoseOverlay || showRoiOverlay ? "auto" : 0 }}>
                  <Text style={{ color: "#fff", fontSize: 9, fontVariant: ["tabular-nums"] }}>
                    {frameTimeSec.toFixed(3)}s / {frame.durationSec.toFixed(2)}s
                    {frame.frameRate > 0 ? `  ·  ${frame.frameRate.toFixed(1)} fps` : ""}
                    {vp.scale > 1.01 ? `  ·  ${vp.scale.toFixed(1)}×` : ""}
                  </Text>
                </View>
                {showPoseOverlay && (
                  <>
                    <Pill label="Reset" onPress={() => poseOverlayRef.current?.reset()} small />
                    <Pill label="Save" onPress={handleSaveCal} disabled={!!busy} small />
                    <Pill label="Load" onPress={handleLoadCal} disabled={!!busy} small />
                    <Pill label="Back" onPress={() => setShowPoseOverlay(false)} small />
                    <Pill label="Set Pose" active onPress={handleSetPose} small />
                    <DragNumber value={cameraFovDeg} onChange={(v) => useTrackerSettings.getState().setCameraFovDeg(v)} min={20} max={120} label="FOV" suffix="°" />
                    <Pill label="1:1" onPress={() => setVp({ scale: 1, tx: 0, ty: 0 })} small />
                  </>
                )}
                {showRoiOverlay && (
                  <>
                    <Pill label="Reset" onPress={() => roiOverlayRef.current?.reset()} small />
                    <Pill label="Save" onPress={handleSaveRoi} small />
                    <Pill label="Load" onPress={handleLoadRoi} small />
                    <Pill label="Set ROI" active onPress={() => { const roi = roiOverlayRef.current?.getBox(); if (roi) { setBox(roi); setShowRoiOverlay(false); } }} small />
                    <Pill label="Back" onPress={() => setShowRoiOverlay(false)} small />
                  </>
                )}
                {!showPoseOverlay && !showRoiOverlay && null}
                {err && <View style={{ backgroundColor: "rgba(180,30,30,0.85)", paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6 }}><Text style={{ color: "#fff", fontSize: 9 }} numberOfLines={1}>{err}</Text></View>}
                {busy && <View style={{ flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: "rgba(0,0,0,0.6)", paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6 }}><ActivityIndicator color="#fff" size="small" /><Text style={{ color: "#fff", fontSize: 9 }}>{busy}</Text></View>}
                {copyHint && <View style={{ backgroundColor: "rgba(0,0,0,0.6)", paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6 }}><Text style={{ color: "#fff", fontSize: 9 }}>{copyHint}</Text></View>}
              </View>
              {/* Right column: actions */}
              {!showPoseOverlay && !showRoiOverlay && (
                <View pointerEvents="box-none" style={{ position: "absolute", right: 6, top: "50%", transform: [{ translateY: -80 }], gap: 4, alignItems: "center" }}>
                  <Pill label={cameraPose ? "Cal ✓" : "Cal"} active={!!cameraPose} onPress={() => { setShowPoseOverlay(true); setShowRoiOverlay(false); }} disabled={!!busy} small />
                  <Pill label={box ? "ROI ✓" : "ROI"} active={!!box} onPress={() => { if (box && !showRoiOverlay) setBox(null); else { setShowRoiOverlay(true); setShowPoseOverlay(false); } }} disabled={!!busy} small />
                  <Pill label={busy?.startsWith("tracking") ? "…" : "Run"} active onPress={runTracker} disabled={!!busy} small />
                  <Pill label="Back" onPress={pickVideo} disabled={!!busy} small />
                  {videoUri && !isSaved && <Pill label="Save" onPress={handleSaveVideoLocal} disabled={!!busy} small />}
                  {isSaved && <Pill label="✓" onPress={() => {}} disabled small />}
                  <Pill label="⚙" onPress={() => setShowSettings(true)} small />
                </View>
              )}
              {/* Bottom: transport bar */}
              {!showPoseOverlay && !showRoiOverlay && (
                <View pointerEvents="box-none" style={{ position: "absolute", bottom: 4, left: 0, right: 0, alignItems: "center" }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 1, paddingVertical: 3, paddingHorizontal: 6, backgroundColor: "rgba(0,0,0,0.75)", borderRadius: 8 }}>
                    <Pressable onPress={() => { if (frame) loadFrame(videoUri!, 0); }} disabled={!!busy} style={styles.transportBtn}><Text style={styles.transportTxt}>{"|<<"}</Text></Pressable>
                    <Pressable onPress={() => frameStep(-30 * frameStepSec)} disabled={!!busy} style={styles.transportBtn}><Text style={styles.transportTxt}>{"<<"+"<"}</Text></Pressable>
                    <Pressable onPress={() => frameStep(-15 * frameStepSec)} disabled={!!busy} style={styles.transportBtn}><Text style={styles.transportTxt}>{"<<"}</Text></Pressable>
                    <Pressable onPress={() => frameStep(-frameStepSec)} disabled={!!busy} style={styles.transportBtn}><Text style={styles.transportTxt}>{"<"}</Text></Pressable>
                    <Pressable onPress={() => frameStep(frameStepSec)} disabled={!!busy} style={[styles.transportBtn, { paddingHorizontal: 14 }]}><Text style={[styles.transportTxt, { fontSize: 15 }]}>{">"}</Text></Pressable>
                    <Pressable onPress={() => frameStep(15 * frameStepSec)} disabled={!!busy} style={styles.transportBtn}><Text style={styles.transportTxt}>{">>"}</Text></Pressable>
                    <Pressable onPress={() => frameStep(30 * frameStepSec)} disabled={!!busy} style={styles.transportBtn}><Text style={styles.transportTxt}>{">>"+">"}</Text></Pressable>
                    <Pressable onPress={() => { if (frame) loadFrame(videoUri!, frame.durationSec - frameStepSec); }} disabled={!!busy} style={styles.transportBtn}><Text style={styles.transportTxt}>{">>"+"|"}</Text></Pressable>
                  </View>
                </View>
              )}
            </View>
          ) : (
            /* ── Portrait: top status + bottom pill rows ── */
            <View style={{ flex: 1, justifyContent: "space-between" }} pointerEvents="box-none">
              {/* Top: status indicators + calibration controls */}
              <View pointerEvents="box-none" style={{ alignItems: "center", paddingTop: 8, gap: 4 }}>
                <View style={{ backgroundColor: "rgba(0,0,0,0.6)", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 }}>
                  <Text style={{ color: "#fff", fontSize: 11, fontVariant: ["tabular-nums"] }}>
                    {frameTimeSec.toFixed(3)}s / {frame.durationSec.toFixed(2)}s
                    {frame.frameRate > 0 ? `  ·  ${frame.frameRate.toFixed(1)} fps` : ""}
                    {vp.scale > 1.01 ? `  ·  ${vp.scale.toFixed(1)}×` : ""}
                  </Text>
                </View>
                {showPoseOverlay && (
                  <View style={[styles.pillRow, { justifyContent: "flex-end", paddingRight: 4, flexWrap: "wrap" }]}>
                    <Pill label="Reset" onPress={() => poseOverlayRef.current?.reset()} small />
                    <Pill label="Save" onPress={handleSaveCal} disabled={!!busy} small />
                    <Pill label="Load" onPress={handleLoadCal} disabled={!!busy} small />
                    <Pill label="Back" onPress={() => setShowPoseOverlay(false)} small />
                    <Pill label="Set Pose" active onPress={handleSetPose} small />
                    <DragNumber value={cameraFovDeg} onChange={(v) => useTrackerSettings.getState().setCameraFovDeg(v)} min={20} max={120} label="FOV" suffix="°" />
                    <Pill label="1:1" onPress={() => setVp({ scale: 1, tx: 0, ty: 0 })} small />
                  </View>
                )}
                {err && (
                  <View style={{ backgroundColor: "rgba(180,30,30,0.85)", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8, marginHorizontal: 16 }}>
                    <Text style={{ color: "#fff", fontSize: 11 }} numberOfLines={2}>{err}</Text>
                  </View>
                )}
                {busy && (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: "rgba(0,0,0,0.6)", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 }}>
                    <ActivityIndicator color="#fff" size="small" />
                    <Text style={{ color: "#fff", fontSize: 11 }}>{busy}</Text>
                  </View>
                )}
                {copyHint && (
                  <View style={{ backgroundColor: "rgba(0,0,0,0.6)", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 }}>
                    <Text style={{ color: "#fff", fontSize: 11 }}>{copyHint}</Text>
                  </View>
                )}
                {cameraXYZ && (
                  <Pressable onPress={handleCopyPose} style={{ backgroundColor: "rgba(0,200,255,0.15)", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8, borderWidth: 1, borderColor: "rgba(0,200,255,0.3)" }}>
                    <Text style={{ color: "rgba(0,200,255,1)", fontSize: 9, fontFamily: "monospace" }}>
                      pos {cameraXYZ.x.toFixed(2)} {cameraXYZ.y.toFixed(2)} {cameraXYZ.z.toFixed(2)}m
                      {cameraAngles ? `  rot ${cameraAngles.tiltDeg.toFixed(0)}° ${cameraAngles.rollDeg.toFixed(0)}° ${cameraAngles.panDeg.toFixed(0)}°` : ""}
                    </Text>
                  </Pressable>
                )}
              </View>

              {/* Bottom: pill controls (hidden during calibration — FieldModelOverlay owns the bottom) */}
              {showPoseOverlay ? null : <View style={{ gap: 6, paddingHorizontal: 10, paddingBottom: 16 }}>
                {showRoiOverlay ? (
                  <View style={styles.pillRow}>
                    <Pill label="Reset" onPress={() => roiOverlayRef.current?.reset()} />
                    <Pill label="Save" onPress={handleSaveRoi} />
                    <Pill label="Load" onPress={handleLoadRoi} />
                    <Pill label="Set ROI" active onPress={() => { const roi = roiOverlayRef.current?.getBox(); if (roi) { setBox(roi); setShowRoiOverlay(false); } }} />
                    <Pill label="Back" onPress={() => setShowRoiOverlay(false)} />
                  </View>
                ) : (
                  <>
                    <View style={styles.pillRow}>
                      <Pill label={cameraPose ? "Cal ✓" : "Cal"} active={!!cameraPose} onPress={() => { setShowPoseOverlay(true); setShowRoiOverlay(false); }} disabled={!!busy} />
                      <Pill label={box ? "ROI ✓" : "ROI"} active={!!box} onPress={() => { if (box && !showRoiOverlay) setBox(null); else { setShowRoiOverlay(true); setShowPoseOverlay(false); } }} disabled={!!busy} />
                      <Pill label={busy?.startsWith("tracking") ? "Tracking…" : "Run"} active onPress={runTracker} disabled={!!busy} />
                    </View>
                    <View style={styles.pillRow}>
                      <Pill label="Back" onPress={pickVideo} disabled={!!busy} />
                      {videoUri && !isSaved && <Pill label="Save" onPress={handleSaveVideoLocal} disabled={!!busy} />}
                      {isSaved && <Pill label="Saved ✓" onPress={() => {}} disabled />}
                      <Pill label="⚙" onPress={() => setShowSettings(true)} />
                    </View>
                  </>
                )}
              </View>}
            </View>
          )}
        </SafeAreaView>
      </View>
    )}

    {/* ── Result review: full-screen ─────────────────────────────────── */}
    {result && (
      <View style={{ flex: 1, backgroundColor: "#000", }}>
        <Text style={{ color: "#fff", fontSize: 12, fontWeight: "600", textAlign: "center", paddingVertical: 4, backgroundColor: "rgba(0,0,0,0.9)" }}>Results</Text>
        {/* Review canvas fills available space */}
        <View style={{ flex: 1, justifyContent: "center", alignItems: "center", }}>
          {reviewedFrame && (
            <View
              ref={canvasRef2}
              onLayout={onCanvasLayout}
              {...resultResponder.panHandlers}
              style={{
                aspectRatio: result.videoWidth / result.videoHeight,
                width: "100%",
                maxHeight: "100%",
                backgroundColor: "#111",
                overflow: "hidden",
                position: "relative",
                }}
            >
              {/* Transformed image + overlays */}
              <View
                pointerEvents="none"
                style={{
                  position: "absolute", left: 0, top: 0, right: 0, bottom: 0,
                  transform: [{ translateX: vp.tx }, { translateY: vp.ty }, { scale: vp.scale }],
                }}
              >
                {showProcessed && reviewImage ? (
                  <ProcessedImage base64={reviewImage.base64} />
                ) : detectMode && reviewImage ? (
                  <Image
                    source={{ uri: `data:image/jpeg;base64,${reviewImage.base64}` }}
                    style={{ width: "100%", height: "100%" }}
                    resizeMode="stretch"
                    fadeDuration={0}
                  />
                ) : (
                  <Video
                    ref={videoRef}
                    source={{ uri: videoUri! }}
                    style={{ width: "100%", height: "100%" }}
                    resizeMode={ResizeMode.COVER}
                    shouldPlay={isPlaying && !showProcessed}
                    rate={playSpeed}
                    isMuted
                    progressUpdateIntervalMillis={33}
                    onPlaybackStatusUpdate={onPlaybackStatus}
                  />
                )}
                {splinePath !== "" && (
                  <Svg style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0 }} viewBox="0 0 1 1" preserveAspectRatio="none">
                    <Path d={splinePath} stroke="rgba(0,200,255,0.95)" strokeWidth={2} fill="none" vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
                  </Svg>
                )}
                {polyFitPath !== "" && (
                  <Svg style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0 }} viewBox="0 0 1 1" preserveAspectRatio="none">
                    <Path d={polyFitPath} stroke="rgba(0,200,255,0.7)" strokeWidth={1} fill="none" vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
                  </Svg>
                )}
                {(showAllDetections ? interpolated : interpolated?.slice(0, reviewIdx))?.map((p, i) => {
                  if (!p.box) return null;
                  const cx = p.box.x + p.box.width / 2;
                  const cy = p.box.y + p.box.height / 2;
                  const denom = Math.max(1, reviewIdx - 1);
                  const t = i / denom;
                  const alpha = 0.25 + t * 0.7;
                  const sizeFactor = 0.5 + t * 0.5;
                  // In detect mode: red = unvalidated, yellow = validated.
                  const isValidated = detectMode && validatedFrames.has(i);
                  const dotColor = detectMode
                    ? (isValidated ? `rgba(255,204,0,${alpha})` : `rgba(255,59,48,${alpha})`)
                    : `rgba(255,204,0,${alpha})`;
                  const borderColor = dotColor;
                  if (p.interpolated) {
                    const sz = 3 * sizeFactor;
                    return (
                      <View key={`trail-${i}`} pointerEvents="none" style={{ position: "absolute", left: `${cx * 100}%`, top: `${cy * 100}%`, width: sz, height: sz, marginLeft: -sz / 2, marginTop: -sz / 2, borderRadius: sz / 2, borderWidth: 1, borderColor, backgroundColor: "transparent" }} />
                    );
                  }
                  const sz = 4 * sizeFactor;
                  return (
                    <View key={`trail-${i}`} pointerEvents="none" style={{ position: "absolute", left: `${cx * 100}%`, top: `${cy * 100}%`, width: sz, height: sz, marginLeft: -sz / 2, marginTop: -sz / 2, borderRadius: sz / 2, backgroundColor: dotColor }} />
                  );
                })}
                {(showAllDetections ? result.frames : result.frames.slice(0, reviewIdx + 1)).map((f: any, i) => {
                  if (!f.rejected || !f.rejectedBox) return null;
                  const cx = f.rejectedBox.x + f.rejectedBox.width / 2;
                  const cy = f.rejectedBox.y + f.rejectedBox.height / 2;
                  return (
                    <View key={`rej-${i}`} pointerEvents="none" style={{ position: "absolute", left: `${cx * 100}%`, top: `${cy * 100}%`, width: 8, height: 8, marginLeft: -4, marginTop: -4, borderRadius: 4, borderWidth: 1.5, borderColor: "rgba(255,59,48,0.7)", backgroundColor: "transparent" }} />
                  );
                })}
                {(() => {
                  const cur = interpolated?.[reviewIdx];
                  if (!cur?.box) return null;
                  const isInterp = cur.interpolated;
                  return (
                    <View pointerEvents="none" style={{ position: "absolute", left: `${cur.box.x * 100}%`, top: `${cur.box.y * 100}%`, width: `${cur.box.width * 100}%`, height: `${cur.box.height * 100}%`, borderWidth: 2, borderColor: isInterp ? "#FF9500" : "#34C759", borderStyle: isInterp ? "dashed" : "solid" }} />
                  );
                })()}
                {cameraPose && showFieldLines && frame && (
                  <React.Suspense fallback={null}>
                    <FieldModelView
                      H={cameraPose.fit.H}
                      K={intrinsicsFromFov(result.videoWidth, result.videoHeight, frame.hFovDeg ?? 0)}
                      imageWidth={result.videoWidth}
                      imageHeight={result.videoHeight}
                      canvasWidth={canvas.width}
                      canvasHeight={canvas.height}
                      opacity={0.5}
                    />
                  </React.Suspense>
                )}
              </View>
              {/* Fixed overlays (outside transform) */}
            </View>
          )}
          {/* Transport bar — inside centering container, just below canvas */}
          {!fullScreen && (
            <View style={{ flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 1, paddingVertical: 4, paddingHorizontal: 6, }}>
              <Pressable onPress={() => { setIsPlaying(false); const n = 0; setReviewIdx(n); seekToFrame(n); }} disabled={reviewIdx === 0} style={styles.transportBtn}><Text style={[styles.transportTxt, reviewIdx === 0 && { opacity: 0.3 }]}>{"|<<"}</Text></Pressable>
              <Pressable onPress={() => { setIsPlaying(false); const n = Math.max(0, reviewIdx - 30); setReviewIdx(n); seekToFrame(n); }} disabled={reviewIdx === 0} style={styles.transportBtn}><Text style={[styles.transportTxt, reviewIdx === 0 && { opacity: 0.3 }]}>{"<<"+"<"}</Text></Pressable>
              <Pressable onPress={() => { setIsPlaying(false); const n = Math.max(0, reviewIdx - 15); setReviewIdx(n); seekToFrame(n); }} disabled={reviewIdx === 0} style={styles.transportBtn}><Text style={[styles.transportTxt, reviewIdx === 0 && { opacity: 0.3 }]}>{"<<"}</Text></Pressable>
              <Pressable onPress={() => { setIsPlaying(false); const n = Math.max(0, reviewIdx - 1); setReviewIdx(n); seekToFrame(n); }} disabled={reviewIdx === 0} style={styles.transportBtn}><Text style={[styles.transportTxt, reviewIdx === 0 && { opacity: 0.3 }]}>{"<"}</Text></Pressable>
              <Pressable onPress={() => { if (reviewIdx >= result.frames.length - 1) { setReviewIdx(0); seekToFrame(0); } setIsPlaying((p) => !p); }} style={[styles.transportBtn, { paddingHorizontal: 14 }]}><Text style={[styles.transportTxt, { fontSize: 15 }]}>{isPlaying ? "||" : ">"}</Text></Pressable>
              <Pressable onPress={() => { setIsPlaying(false); const n = Math.min(result.frames.length - 1, reviewIdx + 1); setReviewIdx(n); seekToFrame(n); }} disabled={reviewIdx >= result.frames.length - 1} style={styles.transportBtn}><Text style={[styles.transportTxt, reviewIdx >= result.frames.length - 1 && { opacity: 0.3 }]}>{">"}</Text></Pressable>
              <Pressable onPress={() => { setIsPlaying(false); const n = Math.min(result.frames.length - 1, reviewIdx + 15); setReviewIdx(n); seekToFrame(n); }} disabled={reviewIdx >= result.frames.length - 1} style={styles.transportBtn}><Text style={[styles.transportTxt, reviewIdx >= result.frames.length - 1 && { opacity: 0.3 }]}>{">>"}</Text></Pressable>
              <Pressable onPress={() => { setIsPlaying(false); const n = Math.min(result.frames.length - 1, reviewIdx + 30); setReviewIdx(n); seekToFrame(n); }} disabled={reviewIdx >= result.frames.length - 1} style={styles.transportBtn}><Text style={[styles.transportTxt, reviewIdx >= result.frames.length - 1 && { opacity: 0.3 }]}>{">>"+">"}</Text></Pressable>
              <Pressable onPress={() => { setIsPlaying(false); const n = result.frames.length - 1; setReviewIdx(n); seekToFrame(n); }} disabled={reviewIdx >= result.frames.length - 1} style={styles.transportBtn}><Text style={[styles.transportTxt, reviewIdx >= result.frames.length - 1 && { opacity: 0.3 }]}>{">>"+"|"}</Text></Pressable>
            </View>
          )}
        </View>

        {/* Debug info table — portrait only, below transport */}
        {detectMode && !isLandscape && !fullScreen && (() => {
          const cur = result?.frames[reviewIdx];
          const det = cur && cur.box && !cur.lost ? cur : null;
          const px = det ? { x: (det.box!.x + det.box!.width / 2).toFixed(3), y: (det.box!.y + det.box!.height / 2).toFixed(3) } : null;
          let ray3d: { yzY: string; yzZ: string } | null = null;
          if (det && cameraPose && cameraXYZ && frame) {
            const K = intrinsicsFromFov(result!.videoWidth, result!.videoHeight, cameraFovDeg || 72);
            const ri = computeRayInfo(
              det.box!.x + det.box!.width / 2, det.box!.y + det.box!.height / 2,
              result!.videoWidth, result!.videoHeight, K, cameraPose.fit.Hinv, cameraXYZ,
              false, det.frameIndex, det.timeSec,
            );
            if (ri && ri.yzY != null && ri.yzZ != null) {
              ray3d = { yzY: ri.yzY.toFixed(2), yzZ: ri.yzZ.toFixed(2) };
            }
          }
          // Show the ballistic tracker's internal data.
          const bt = ballisticRef.current;
          const activeTrack = bt?.getActiveTrack();
          const r2Str = activeTrack ? activeTrack.r2.toFixed(4) : "—";
          const speedStr = activeTrack ? `${activeTrack.speedMph.toFixed(0)}mph` : "—";
          const trackObs = activeTrack ? activeTrack.observations.length : 0;
          return (
            <View style={{ backgroundColor: "rgba(0,0,0,0.85)", paddingHorizontal: 10, paddingVertical: 6 }}>
              <Text style={{ color: "#0af", fontSize: 10, fontFamily: "monospace" }}>
                frame {reviewIdx}  t={cur?.timeSec?.toFixed(3) ?? "?"}s  det={detections.size}
              </Text>
              <Text style={{ color: det ? "#34C759" : "#666", fontSize: 10, fontFamily: "monospace" }}>
                px: {px ? `${px.x}, ${px.y}` : "—"}  conf: {det ? det.confidence.toFixed(2) : "—"}
              </Text>
              <Text style={{ color: ray3d ? "#FF9500" : "#666", fontSize: 10, fontFamily: "monospace" }}>
                3D: {ray3d ? `Y=${ray3d.yzY}m Z=${ray3d.yzZ}m` : "—"}
              </Text>
              <Text style={{ color: activeTrack ? "#34C759" : "#666", fontSize: 10, fontFamily: "monospace" }}>
                {activeTrack ? activeTrack.state : "no track"}  R²:{r2Str}  {speedStr}  obs:{trackObs}/{detections.size}
              </Text>
            </View>
          );
        })()}

        {/* Overlaid controls (hidden in fullscreen) */}
        {!fullScreen && <SafeAreaView style={StyleSheet.absoluteFill} pointerEvents="box-none">
          {isLandscape ? (
            /* ── Landscape result review ── */
            <View style={{ flex: 1 }} pointerEvents="box-none">
              {/* Top row: stats + speed */}
              <View pointerEvents="box-none" style={{ flexDirection: "row", justifyContent: "center", flexWrap: "wrap", gap: 4, paddingTop: 4, paddingHorizontal: 8 }}>
                <View style={{ backgroundColor: "rgba(0,0,0,0.6)", paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6, flexDirection: "row", alignItems: "center", gap: 4 }}>
                  {isDetecting && <ActivityIndicator size="small" color="#0af" />}
                  <Text style={{ color: "#fff", fontSize: 9, fontVariant: ["tabular-nums"] }}>
                    {reviewIdx + 1}/{result.frames.length}{isDetecting ? "…" : ""}  ·  t={reviewedFrame ? reviewedFrame.timeSec.toFixed(2) : "?"}s
                    {currentBallDir ? `  ·  az ${currentBallDir.azimuthDeg.toFixed(1)}°  el ${currentBallDir.elevationDeg.toFixed(1)}°` : ""}
                  </Text>
                </View>
                {currentSpeedMph != null && (
                  <View style={{ backgroundColor: "rgba(0,0,0,0.6)", paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6 }}>
                    <Text style={{ color: "#00ff88", fontSize: 10, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{currentSpeedMph.toFixed(1)} mph</Text>
                  </View>
                )}
                {([1, 0.5, 0.25, 0.125] as const).map((s) => (
                  <Pill key={s} label={s === 1 ? "1×" : s === 0.5 ? "½×" : s === 0.25 ? "¼×" : "⅛×"} active={playSpeed === s} onPress={() => setPlaySpeed(s)} small />
                ))}
                {err && <View style={{ backgroundColor: "rgba(180,30,30,0.85)", paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6 }}><Text style={{ color: "#fff", fontSize: 9 }} numberOfLines={1}>{err}</Text></View>}
                {busy && <View style={{ flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: "rgba(0,0,0,0.6)", paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6 }}><ActivityIndicator color="#fff" size="small" /><Text style={{ color: "#fff", fontSize: 9 }}>{busy}</Text></View>}
                {copyHint && <View style={{ backgroundColor: "rgba(0,0,0,0.6)", paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6 }}><Text style={{ color: "#fff", fontSize: 9 }}>{copyHint}</Text></View>}
              </View>
              {/* Right column: actions */}
              <View pointerEvents="box-none" style={{ position: "absolute", right: 6, top: "50%", transform: [{ translateY: -40 }], gap: 4, alignItems: "center" }}>
                <Pill label="Back" onPress={() => { detectionSubRef.current?.remove(); detectionSubRef.current = null; setIsDetecting(false); setDetectMode(false); setDetections(new Map()); setValidatedFrames(new Set()); ballisticRef.current = null; streamingFramesRef.current = []; setIsPlaying(false); setResult(null); setReviewIdx(0); setVp({ scale: 1, tx: 0, ty: 0 }); }} small />
                <Pill label="Export" onPress={handleExportVideo} disabled={!!busy} small />
                <Pill label="Save" active onPress={handleSaveSession} disabled={!!busy} small />
              </View>
            </View>
          ) : (
            /* ── Portrait result review ── */
            <View style={{ flex: 1, justifyContent: "space-between" }} pointerEvents="box-none">
              {/* Top: stats + pose info */}
              <View pointerEvents="box-none" style={{ alignItems: "center", paddingTop: 8, gap: 4 }}>
                <View style={{ backgroundColor: "rgba(0,0,0,0.6)", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 }}>
                  <Text style={{ color: "#fff", fontSize: 10, fontVariant: ["tabular-nums"] }}>
                    {MODE_LABEL[result.mode]}  ·  frame {reviewIdx + 1}/{result.frames.length}
                    {"  ·  t="}
                    {reviewedFrame ? reviewedFrame.timeSec.toFixed(2) : "?"}s
                    {"  ·  conf "}
                    {reviewedFrame ? reviewedFrame.confidence.toFixed(2) : "?"}
                  </Text>
                </View>
                <View style={{ backgroundColor: "rgba(0,0,0,0.6)", paddingHorizontal: 10, paddingVertical: 3, borderRadius: 8 }}>
                  <Text style={{ color: "#fff", fontSize: 9, fontVariant: ["tabular-nums"] }}>
                    {result.frames.length} frames  ·  {result.frames.filter((f) => f.box && !f.lost).length} detected
                    {result.frames.filter((f: any) => f.rejected).length > 0 ? `  ·  ${result.frames.filter((f: any) => f.rejected).length} rejected` : ""}
                    {"  ·  "}{result.elapsedMs}ms
                    {result.frameRate > 0 ? `  ·  ${result.frameRate.toFixed(1)} fps` : ""}
                  </Text>
                </View>
                )}
                {currentBallDir && (
                  <View style={{ backgroundColor: "rgba(0,0,0,0.6)", paddingHorizontal: 10, paddingVertical: 3, borderRadius: 8 }}>
                    <Text style={{ color: currentBallDir.interpolated ? "#FF9500" : "#34C759", fontSize: 10 }}>
                      {currentBallDir.interpolated ? "interp" : "detect"}
                      {"  ·  az "}
                      {currentBallDir.azimuthDeg.toFixed(1)}°
                      {"  ·  el "}
                      {currentBallDir.elevationDeg.toFixed(1)}°
                    </Text>
                  </View>
                )}
                {currentSpeedMph != null && (
                  <View style={{ backgroundColor: "rgba(0,0,0,0.6)", paddingHorizontal: 10, paddingVertical: 3, borderRadius: 8 }}>
                    <Text style={{ color: "#00ff88", fontSize: 12, fontWeight: "700", fontVariant: ["tabular-nums"] }}>
                      {currentSpeedMph.toFixed(1)} mph
                    </Text>
                  </View>
                )}
                {vp.scale > 1.01 && (
                  <View style={{ backgroundColor: "rgba(0,0,0,0.6)", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 }}>
                    <Text style={{ color: "#fff", fontSize: 11 }}>{vp.scale.toFixed(1)}×</Text>
                  </View>
                )}
                {err && (
                  <View style={{ backgroundColor: "rgba(180,30,30,0.85)", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8, marginHorizontal: 16 }}>
                    <Text style={{ color: "#fff", fontSize: 11 }} numberOfLines={2}>{err}</Text>
                  </View>
                )}
                {busy && (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: "rgba(0,0,0,0.6)", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 }}>
                    <ActivityIndicator color="#fff" size="small" />
                    <Text style={{ color: "#fff", fontSize: 11 }}>{busy}</Text>
                  </View>
                )}
                {copyHint && (
                  <View style={{ backgroundColor: "rgba(0,0,0,0.6)", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 }}>
                    <Text style={{ color: "#fff", fontSize: 11 }}>{copyHint}</Text>
                  </View>
                )}
              </View>

              {/* Bottom: speed + action pills */}
              <View style={{ gap: 6, paddingHorizontal: 10, paddingBottom: 16 }}>
                <View style={styles.pillRow}>
                  {([1, 0.5, 0.25, 0.125] as const).map((s) => (
                    <Pill key={s} label={s === 1 ? "1×" : s === 0.5 ? "½×" : s === 0.25 ? "¼×" : "⅛×"} active={playSpeed === s} onPress={() => setPlaySpeed(s)} small />
                  ))}
                  <Pill label="Back" onPress={() => { detectionSubRef.current?.remove(); detectionSubRef.current = null; setIsDetecting(false); setDetectMode(false); setDetections(new Map()); setValidatedFrames(new Set()); ballisticRef.current = null; streamingFramesRef.current = []; setIsPlaying(false); setResult(null); setReviewIdx(0); setVp({ scale: 1, tx: 0, ty: 0 }); }} small />
                  <Pill label="Export" onPress={handleExportVideo} disabled={!!busy} small />
                  <Pill label="Save" active onPress={handleSaveSession} disabled={!!busy} />
                </View>
                {savedViewUrl && (
                  <View style={styles.pillRow}>
                    <Pressable onPress={() => { import("expo-linking").then((L) => L.openURL(savedViewUrl!)).catch(() => {}); }}>
                      <Text style={{ color: "rgba(0,200,255,1)", fontSize: 11, textDecorationLine: "underline" }}>{savedViewUrl}</Text>
                    </Pressable>
                  </View>
                )}
              </View>
            </View>
          )}
        </SafeAreaView>}
      </View>
    )}

    {/* Settings modal */}
    {/* Source picker */}
    <Modal visible={showSourcePicker} transparent animationType="fade" onRequestClose={() => setShowSourcePicker(false)}>
      <Pressable onPress={() => setShowSourcePicker(false)} style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "center", alignItems: "center" }}>
        <Pressable onPress={(e) => e.stopPropagation()} style={{ backgroundColor: theme.surface, borderRadius: 16, padding: 20, width: 280, gap: 12 }}>
          <Text style={{ color: theme.text, fontSize: 18, fontWeight: "700", textAlign: "center", marginBottom: 4 }}>Select Video</Text>
          <Pressable onPress={pickFromLibrary} style={{ backgroundColor: theme.primary, paddingVertical: 14, borderRadius: 10, alignItems: "center" }}>
            <Text style={{ color: "#fff", fontSize: 15, fontWeight: "600" }}>Library</Text>
          </Pressable>
          <Pressable onPress={() => { setShowSourcePicker(false); setShowCamera(true); }} style={{ backgroundColor: "#FF3B30", paddingVertical: 14, borderRadius: 10, alignItems: "center" }}>
            <Text style={{ color: "#fff", fontSize: 15, fontWeight: "600" }}>Record / Buffer</Text>
          </Pressable>
          <Pressable onPress={() => { setShowSourcePicker(false); setLiveMode(true); setVideoUri(null); setFrame(null); setResult(null); setLiveSnapshot(null); setLiveRecording(false); setLiveSegmentCount(0); }} style={{ backgroundColor: "#0af", paddingVertical: 14, borderRadius: 10, alignItems: "center" }}>
            <Text style={{ color: "#fff", fontSize: 15, fontWeight: "600" }}>Live Detect</Text>
          </Pressable>
          <Pressable onPress={() => setShowSourcePicker(false)} style={{ paddingVertical: 10, alignItems: "center" }}>
            <Text style={{ color: theme.textMuted, fontSize: 14 }}>Cancel</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>

    {/* Camera capture */}
    <Modal visible={showCamera} animationType="slide" onRequestClose={() => setShowCamera(false)}>
      <React.Suspense fallback={<View style={{ flex: 1, backgroundColor: "#000", alignItems: "center", justifyContent: "center" }}><ActivityIndicator color="#fff" /></View>}>
        <CameraCapture
          onCapture={(uri) => { setShowCamera(false); loadVideo(uri); }}
          onCancel={() => setShowCamera(false)}
        />
      </React.Suspense>
    </Modal>

    <Modal visible={showSettings} transparent animationType="fade" onRequestClose={() => setShowSettings(false)}>
      <Pressable style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "center", alignItems: "center" }} onPress={() => setShowSettings(false)}>
        <Pressable style={{ backgroundColor: theme.background, borderRadius: 12, padding: 16, width: 300 }} onPress={(e) => e.stopPropagation()}>
          <Text style={{ color: theme.text, fontWeight: "700", fontSize: 15, marginBottom: 12 }}>Settings</Text>

          <View style={{ gap: 12 }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <Text style={{ color: theme.text, fontSize: 13 }}>Preprocess B&W</Text>
              <Pressable onPress={() => useTrackerSettings.getState().setPreprocessBW(!preprocessBW)} style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6, backgroundColor: preprocessBW ? theme.primary : theme.surfaceAlt }}>
                <Text style={{ color: preprocessBW ? "#fff" : theme.text, fontSize: 12, fontWeight: "600" }}>{preprocessBW ? "ON" : "OFF"}</Text>
              </Pressable>
            </View>

            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <Text style={{ color: theme.text, fontSize: 13 }}>Contrast</Text>
              <View style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
                <Pressable onPress={() => useTrackerSettings.getState().setContrastLevel(Math.max(0.5, contrastLevel - 0.25))} style={{ paddingHorizontal: 8, paddingVertical: 4, borderRadius: 4, backgroundColor: theme.surfaceAlt }}><Text style={{ color: theme.text }}>−</Text></Pressable>
                <Text style={{ color: theme.text, fontSize: 12, width: 36, textAlign: "center" }}>{contrastLevel.toFixed(1)}×</Text>
                <Pressable onPress={() => useTrackerSettings.getState().setContrastLevel(Math.min(3.0, contrastLevel + 0.25))} style={{ paddingHorizontal: 8, paddingVertical: 4, borderRadius: 4, backgroundColor: theme.surfaceAlt }}><Text style={{ color: theme.text }}>+</Text></Pressable>
              </View>
            </View>

            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <Text style={{ color: theme.text, fontSize: 13 }}>Outlier rejection</Text>
              <Pressable onPress={() => useTrackerSettings.getState().setOutlierRejection(!outlierRejection)} style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6, backgroundColor: outlierRejection ? theme.primary : theme.surfaceAlt }}>
                <Text style={{ color: outlierRejection ? "#fff" : theme.text, fontSize: 12, fontWeight: "600" }}>{outlierRejection ? "ON" : "OFF"}</Text>
              </Pressable>
            </View>

            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <Text style={{ color: theme.text, fontSize: 13 }}>Outlier threshold</Text>
              <View style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
                <Pressable onPress={() => useTrackerSettings.getState().setOutlierThreshold(Math.max(0.005, outlierThreshold - 0.005))} style={{ paddingHorizontal: 8, paddingVertical: 4, borderRadius: 4, backgroundColor: theme.surfaceAlt }}><Text style={{ color: theme.text }}>−</Text></Pressable>
                <Text style={{ color: theme.text, fontSize: 12, width: 44, textAlign: "center" }}>{outlierThreshold.toFixed(3)}</Text>
                <Pressable onPress={() => useTrackerSettings.getState().setOutlierThreshold(Math.min(0.2, outlierThreshold + 0.005))} style={{ paddingHorizontal: 8, paddingVertical: 4, borderRadius: 4, backgroundColor: theme.surfaceAlt }}><Text style={{ color: theme.text }}>+</Text></Pressable>
              </View>
            </View>

            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <Text style={{ color: theme.text, fontSize: 13 }}>Basepath (ft)</Text>
              <View style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
                <Pressable onPress={() => useTrackerSettings.getState().setBasepathFt(Math.max(30, basepathFt - 5))} style={{ paddingHorizontal: 8, paddingVertical: 4, borderRadius: 4, backgroundColor: theme.surfaceAlt }}><Text style={{ color: theme.text }}>−</Text></Pressable>
                <Text style={{ color: theme.text, fontSize: 12, width: 36, textAlign: "center" }}>{basepathFt}</Text>
                <Pressable onPress={() => useTrackerSettings.getState().setBasepathFt(Math.min(90, basepathFt + 5))} style={{ paddingHorizontal: 8, paddingVertical: 4, borderRadius: 4, backgroundColor: theme.surfaceAlt }}><Text style={{ color: theme.text }}>+</Text></Pressable>
              </View>
            </View>

            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <Text style={{ color: theme.text, fontSize: 13 }}>Track R² threshold</Text>
              <View style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
                <Pressable onPress={() => useTrackerSettings.getState().setTrackR2Threshold(Math.max(0.5, +(trackR2Threshold - 0.01).toFixed(2)))} style={{ paddingHorizontal: 8, paddingVertical: 4, borderRadius: 4, backgroundColor: theme.surfaceAlt }}><Text style={{ color: theme.text }}>−</Text></Pressable>
                <Text style={{ color: theme.text, fontSize: 12, width: 36, textAlign: "center" }}>{trackR2Threshold.toFixed(2)}</Text>
                <Pressable onPress={() => useTrackerSettings.getState().setTrackR2Threshold(Math.min(1.0, +(trackR2Threshold + 0.01).toFixed(2)))} style={{ paddingHorizontal: 8, paddingVertical: 4, borderRadius: 4, backgroundColor: theme.surfaceAlt }}><Text style={{ color: theme.text }}>+</Text></Pressable>
              </View>
            </View>

            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <Text style={{ color: theme.text, fontSize: 13 }}>Camera FOV (°)</Text>
              <View style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
                <Pressable onPress={() => useTrackerSettings.getState().setCameraFovDeg(Math.max(20, cameraFovDeg - 1))} style={{ paddingHorizontal: 8, paddingVertical: 4, borderRadius: 4, backgroundColor: theme.surfaceAlt }}><Text style={{ color: theme.text }}>−</Text></Pressable>
                <Text style={{ color: theme.text, fontSize: 12, width: 36, textAlign: "center" }}>{cameraFovDeg}</Text>
                <Pressable onPress={() => useTrackerSettings.getState().setCameraFovDeg(Math.min(120, cameraFovDeg + 1))} style={{ paddingHorizontal: 8, paddingVertical: 4, borderRadius: 4, backgroundColor: theme.surfaceAlt }}><Text style={{ color: theme.text }}>+</Text></Pressable>
              </View>
            </View>
          </View>

          <Pressable onPress={() => setShowSettings(false)} style={{ marginTop: 16, paddingVertical: 10, backgroundColor: theme.primary, borderRadius: 8, alignItems: "center" }}>
            <Text style={{ color: "#fff", fontWeight: "600" }}>Done</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>

    {/* ── Calibration picker modal ── */}
    <Modal visible={showCalPicker} transparent animationType="fade" onRequestClose={() => setShowCalPicker(false)}>
      <Pressable style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "center", alignItems: "center" }} onPress={() => { setShowCalPicker(false); setRenamingCalId(null); }}>
        <Pressable style={{ backgroundColor: theme.background, borderRadius: 12, padding: 16, width: 320, maxHeight: 480 }} onPress={(e) => e.stopPropagation()}>
          <Text style={{ color: theme.text, fontWeight: "700", fontSize: 15, marginBottom: 12 }}>Calibrations</Text>
          <ScrollView style={{ maxHeight: 380 }}>
            {savedCals.length === 0 && (
              <Text style={{ color: theme.textMuted, fontSize: 13, textAlign: "center", paddingVertical: 20 }}>No saved calibrations</Text>
            )}
            {savedCals.map((cal) => (
              <View key={cal.id} style={{ marginBottom: 8, backgroundColor: theme.surfaceAlt, borderRadius: 8, padding: 10 }}>
                {renamingCalId === cal.id ? (
                  <View style={{ flexDirection: "row", gap: 6, alignItems: "center", marginBottom: 6 }}>
                    <TextInput
                      style={{ flex: 1, color: theme.text, fontSize: 13, borderWidth: 1, borderColor: theme.primary, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 }}
                      value={renameText}
                      onChangeText={setRenameText}
                      autoFocus
                      onSubmitEditing={() => handleRenameCal(cal.id)}
                    />
                    <Pressable onPress={() => handleRenameCal(cal.id)} style={{ paddingHorizontal: 8, paddingVertical: 4, backgroundColor: theme.primary, borderRadius: 4 }}>
                      <Text style={{ color: "#fff", fontSize: 11, fontWeight: "600" }}>OK</Text>
                    </Pressable>
                    <Pressable onPress={() => setRenamingCalId(null)} style={{ paddingHorizontal: 6, paddingVertical: 4 }}>
                      <Text style={{ color: theme.textMuted, fontSize: 11 }}>Cancel</Text>
                    </Pressable>
                  </View>
                ) : (
                  <>
                    <Pressable onPress={() => applyCalibration(cal)}>
                      <Text style={{ color: theme.text, fontSize: 13, fontWeight: "600" }} numberOfLines={1}>{cal.name}</Text>
                      <Text style={{ color: theme.textMuted, fontSize: 10, marginTop: 2 }}>
                        {new Date(cal.savedAt).toLocaleString()}
                        {cal.cameraPose ? `  ·  ${cal.cameraPose.count} pts  ·  ${cal.cameraPose.rmsPx.toFixed(1)}px RMS` : "  ·  no pose"}
                        {cal.fovDeg ? `  ·  ${cal.fovDeg}° FOV` : ""}
                        {`  ·  ${cal.basepathFt}ft`}
                      </Text>
                    </Pressable>
                    <View style={{ flexDirection: "row", gap: 8, marginTop: 6 }}>
                      <Pressable onPress={() => applyCalibration(cal)} style={{ paddingHorizontal: 10, paddingVertical: 4, backgroundColor: theme.primary, borderRadius: 4 }}>
                        <Text style={{ color: "#fff", fontSize: 11, fontWeight: "600" }}>Load</Text>
                      </Pressable>
                      <Pressable onPress={() => { setRenamingCalId(cal.id); setRenameText(cal.name); }} style={{ paddingHorizontal: 10, paddingVertical: 4, backgroundColor: theme.surfaceAlt, borderRadius: 4, borderWidth: 1, borderColor: theme.border }}>
                        <Text style={{ color: theme.text, fontSize: 11 }}>Rename</Text>
                      </Pressable>
                      <Pressable onPress={() => handleDeleteCal(cal.id, cal.name)} style={{ paddingHorizontal: 10, paddingVertical: 4, backgroundColor: theme.surfaceAlt, borderRadius: 4, borderWidth: 1, borderColor: theme.border }}>
                        <Text style={{ color: "#cc3333", fontSize: 11 }}>Delete</Text>
                      </Pressable>
                    </View>
                  </>
                )}
              </View>
            ))}
          </ScrollView>
          <Pressable onPress={() => { setShowCalPicker(false); setRenamingCalId(null); }} style={{ marginTop: 12, paddingVertical: 10, backgroundColor: theme.primary, borderRadius: 8, alignItems: "center" }}>
            <Text style={{ color: "#fff", fontWeight: "600" }}>Close</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>

    {/* ── ROI picker modal ── */}
    <Modal visible={showRoiPicker} transparent animationType="fade" onRequestClose={() => setShowRoiPicker(false)}>
      <Pressable style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "center", alignItems: "center" }} onPress={() => { setShowRoiPicker(false); setRenamingRoiId(null); }}>
        <Pressable style={{ backgroundColor: theme.background, borderRadius: 12, padding: 16, width: 320, maxHeight: 480 }} onPress={(e) => e.stopPropagation()}>
          <Text style={{ color: theme.text, fontWeight: "700", fontSize: 15, marginBottom: 12 }}>Saved ROIs</Text>
          <ScrollView style={{ maxHeight: 380 }}>
            {savedRois.length === 0 && (
              <Text style={{ color: theme.textMuted, fontSize: 13, textAlign: "center", paddingVertical: 20 }}>No saved ROIs</Text>
            )}
            {savedRois.map((roi) => (
              <View key={roi.id} style={{ marginBottom: 8, backgroundColor: theme.surfaceAlt, borderRadius: 8, padding: 10 }}>
                {renamingRoiId === roi.id ? (
                  <View style={{ flexDirection: "row", gap: 6, alignItems: "center", marginBottom: 6 }}>
                    <TextInput
                      style={{ flex: 1, color: theme.text, fontSize: 13, borderWidth: 1, borderColor: theme.primary, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 }}
                      value={renameRoiText}
                      onChangeText={setRenameRoiText}
                      autoFocus
                      onSubmitEditing={() => handleRenameRoi(roi.id)}
                    />
                    <Pressable onPress={() => handleRenameRoi(roi.id)} style={{ paddingHorizontal: 8, paddingVertical: 4, backgroundColor: theme.primary, borderRadius: 4 }}>
                      <Text style={{ color: "#fff", fontSize: 11, fontWeight: "600" }}>OK</Text>
                    </Pressable>
                    <Pressable onPress={() => setRenamingRoiId(null)} style={{ paddingHorizontal: 6, paddingVertical: 4 }}>
                      <Text style={{ color: theme.textMuted, fontSize: 11 }}>Cancel</Text>
                    </Pressable>
                  </View>
                ) : (
                  <>
                    <Pressable onPress={() => applyRoi(roi)}>
                      <Text style={{ color: theme.text, fontSize: 13, fontWeight: "600" }} numberOfLines={1}>{roi.name}</Text>
                      <Text style={{ color: theme.textMuted, fontSize: 10, marginTop: 2 }}>
                        {new Date(roi.savedAt).toLocaleString()}
                        {`  ·  x:${roi.box.x.toFixed(2)} y:${roi.box.y.toFixed(2)} w:${roi.box.width.toFixed(2)} h:${roi.box.height.toFixed(2)}`}
                      </Text>
                    </Pressable>
                    <View style={{ flexDirection: "row", gap: 8, marginTop: 6 }}>
                      <Pressable onPress={() => applyRoi(roi)} style={{ paddingHorizontal: 10, paddingVertical: 4, backgroundColor: theme.primary, borderRadius: 4 }}>
                        <Text style={{ color: "#fff", fontSize: 11, fontWeight: "600" }}>Load</Text>
                      </Pressable>
                      <Pressable onPress={() => { setRenamingRoiId(roi.id); setRenameRoiText(roi.name); }} style={{ paddingHorizontal: 10, paddingVertical: 4, backgroundColor: theme.surfaceAlt, borderRadius: 4, borderWidth: 1, borderColor: theme.border }}>
                        <Text style={{ color: theme.text, fontSize: 11 }}>Rename</Text>
                      </Pressable>
                      <Pressable onPress={() => handleDeleteRoi(roi.id, roi.name)} style={{ paddingHorizontal: 10, paddingVertical: 4, backgroundColor: theme.surfaceAlt, borderRadius: 4, borderWidth: 1, borderColor: theme.border }}>
                        <Text style={{ color: "#cc3333", fontSize: 11 }}>Delete</Text>
                      </Pressable>
                    </View>
                  </>
                )}
              </View>
            ))}
          </ScrollView>
          <Pressable onPress={() => { setShowRoiPicker(false); setRenamingRoiId(null); }} style={{ marginTop: 12, paddingVertical: 10, backgroundColor: theme.primary, borderRadius: 8, alignItems: "center" }}>
            <Text style={{ color: "#fff", fontWeight: "600" }}>Close</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
    </>
  );
}

// ── Pill button (AR tab / camera-app style) ────────────────────────────

function Pill({ label, active, onPress, disabled, small, color }: {
  label: string; active?: boolean; onPress: () => void; disabled?: boolean; small?: boolean; color?: string;
}) {
  return (
    <Pressable
      onPress={onPress} disabled={disabled}
      style={{
        paddingHorizontal: small ? 10 : 16,
        paddingVertical: small ? 5 : 8,
        borderRadius: small ? 14 : 20,
        backgroundColor: active ? "rgba(255,255,255,0.85)" : color ?? "rgba(0,0,0,0.5)",
        borderWidth: 1,
        borderColor: active ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.2)",
        opacity: disabled ? 0.35 : 1,
      }}
    >
      <Text style={{
        color: active ? "#000" : "rgba(255,255,255,0.95)",
        fontSize: small ? 11 : 13, fontWeight: "600",
      }}>{label}</Text>
    </Pressable>
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
  pillRow: {
    flexDirection: "row",
    justifyContent: "center",
    flexWrap: "wrap",
    gap: 6,
  },
  transportBtn: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    minWidth: 36,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  },
  transportTxt: {
    color: "rgba(255,255,255,0.8)",
    fontSize: 13,
    fontWeight: "600" as const,
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
  roi?: NormalizedBox | null,
): Array<{ box: NormalizedBox | null; interpolated: boolean }> {
  const out: Array<{ box: NormalizedBox | null; interpolated: boolean }> = frames.map((f) => ({
    box: f.box && !f.lost ? { ...f.box } : null,
    interpolated: false,
  }));
  // Find first and last real detections for edge extrapolation.
  let firstReal = -1, lastReal = -1;
  for (let j = 0; j < out.length; j++) if (out[j]!.box && !out[j]!.interpolated) { if (firstReal < 0) firstReal = j; lastReal = j; }

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

  // ROI edge extrapolation: extend the trajectory before the first and
  // after the last real detection using the velocity from the nearest
  // two real detections, until the center exits the ROI.
  if (roi && firstReal >= 0 && lastReal > firstReal) {
    // Velocity from first two real detections (for backward extrapolation).
    const second = out.findIndex((o, j) => j > firstReal && o.box && !o.interpolated);
    if (second > firstReal) {
      const b0 = out[firstReal]!.box!, b1 = out[second]!.box!;
      const dt0 = frames[second]!.timeSec - frames[firstReal]!.timeSec;
      if (dt0 > 0) {
        const vx = (b1.x + b1.width / 2 - b0.x - b0.width / 2) / dt0;
        const vy = (b1.y + b1.height / 2 - b0.y - b0.height / 2) / dt0;
        for (let k = firstReal - 1; k >= 0; k--) {
          const dt = frames[k]!.timeSec - frames[firstReal]!.timeSec;
          const cx = b0.x + b0.width / 2 + vx * dt;
          const cy = b0.y + b0.height / 2 + vy * dt;
          if (cx < roi.x || cx > roi.x + roi.width || cy < roi.y || cy > roi.y + roi.height) break;
          out[k] = { box: { x: cx - b0.width / 2, y: cy - b0.height / 2, width: b0.width, height: b0.height }, interpolated: true };
        }
      }
    }
    // Velocity from last two real detections (for forward extrapolation).
    let secondLast = -1;
    for (let j = lastReal - 1; j >= 0; j--) { if (out[j]!.box && !out[j]!.interpolated) { secondLast = j; break; } }
    if (secondLast >= 0) {
      const bA = out[secondLast]!.box!, bB = out[lastReal]!.box!;
      const dtN = frames[lastReal]!.timeSec - frames[secondLast]!.timeSec;
      if (dtN > 0) {
        const vx = (bB.x + bB.width / 2 - bA.x - bA.width / 2) / dtN;
        const vy = (bB.y + bB.height / 2 - bA.y - bA.height / 2) / dtN;
        for (let k = lastReal + 1; k < out.length; k++) {
          const dt = frames[k]!.timeSec - frames[lastReal]!.timeSec;
          const cx = bB.x + bB.width / 2 + vx * dt;
          const cy = bB.y + bB.height / 2 + vy * dt;
          if (cx < roi.x || cx > roi.x + roi.width || cy < roi.y || cy > roi.y + roi.height) break;
          out[k] = { box: { x: cx - bB.width / 2, y: cy - bB.height / 2, width: bB.width, height: bB.height }, interpolated: true };
        }
      }
    }
  }

  return out;
}
