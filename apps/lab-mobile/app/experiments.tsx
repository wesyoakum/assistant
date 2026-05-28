import { useState, useEffect, useRef, useCallback } from "react";
import { View, Text, ScrollView, StyleSheet, Pressable, Alert, Platform, Modal, useWindowDimensions, Image, PanResponder, type GestureResponderEvent, type LayoutChangeEvent } from "react-native";
import * as Device from "expo-device";
import Constants from "expo-constants";
import * as Clipboard from "expo-clipboard";
import * as Notifications from "expo-notifications";
import { Accelerometer, Gyroscope, Magnetometer, DeviceMotion, Barometer, Pedometer } from "expo-sensors";
import type { DeviceMotionMeasurement } from "expo-sensors";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import * as Haptics from "expo-haptics";
import * as Battery from "expo-battery";
import * as Network from "expo-network";
import * as Cellular from "expo-cellular";
import * as Brightness from "expo-brightness";
import * as ScreenOrientation from "expo-screen-orientation";
import { Audio } from "expo-av";
import { BleManager, type Device as BleDevice, type State as BleState } from "react-native-ble-plx";
import LiveAudioStream from "react-native-live-audio-stream";
import { CameraView, useCameraPermissions } from "expo-camera";
import type { CameraView as CameraViewType } from "expo-camera";
import { Lidar, type DepthFrame, type AlignedFrame, type LidarARViewRef, type BallAnchor, type BallState, type FieldLandmarkAnchor, type FieldLandmarkKind, decodeDepthBuffer, sampleDepth, LidarARView, lidarARViewAvailable } from "expo-lidar";
import { GameController, type ControllerInfo, type ControllerInputFrame } from "expo-gamecontroller";
import { VisionDetect, type DetectResult } from "expo-vision-detect";
import { Yolo, type YoloResult } from "expo-yolo";
// HealthKit + NFC deferred — re-add when provisioning profile is sorted.
import FFT from "fft.js";
import { computeFieldFrame, type LandmarkPositions, type Vec3 } from "../src/field/coordinateFrame";
import { detectNotes, identifyChord } from "../src/audio/chords";
import { generateDirtBoundary, computeLandmarkPositions, recomputeFieldFromBase, foulPoleDistFt, FIELD_TEMPLATES } from "../src/field/templates";
import { classifyBall } from "../src/field/classify";
import { useFields, type FieldRegistration } from "../src/state/fields";
import { useAuth } from "../src/state/auth";
import { API_BASE } from "../src/api/client";
import { useMe } from "../src/hooks/useMe";
import { type Theme, useTheme } from "../src/theme";
import { useStyles } from "../src/hooks/useStyles";

interface Row {
  label: string;
  value: string | number | boolean | null | undefined;
}

function Section({ title, rows }: { title: string; rows: Row[] }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={{ marginBottom: 20 }}>
      {title ? <Text style={styles.sectionTitle}>{title}</Text> : null}
      <View style={styles.card}>
        {rows.map((r, i) => (
          <View key={r.label} style={[styles.row, i === rows.length - 1 && { borderBottomWidth: 0 }]}>
            <Text style={styles.rowLabel} numberOfLines={1}>{r.label}</Text>
            <Text style={styles.rowValue} numberOfLines={2}>{format(r.value)}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function format(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "number") return v.toLocaleString();
  if (typeof v === "string") return v || "—";
  return JSON.stringify(v);
}

function fmt(n: number, digits = 2) {
  return n.toFixed(digits);
}

// --- Background location task --------------------------------------------
// Registered at module load so iOS can wake the task while backgrounded.
// Buffer is module-scoped; UI subscribes via bgLocListeners. Cleared on start.
const BG_LOCATION_TASK = "whyapp.bg-location";

export interface BgLocPoint {
  ts: number;
  lat: number;
  lon: number;
  alt: number | null;
  speed: number | null;
  accuracy: number | null;
}

const bgLocBuffer: BgLocPoint[] = [];
const bgLocListeners = new Set<() => void>();

function pushBgLoc(p: BgLocPoint) {
  bgLocBuffer.push(p);
  if (bgLocBuffer.length > 500) bgLocBuffer.splice(0, bgLocBuffer.length - 500);
  bgLocListeners.forEach((cb) => { try { cb(); } catch {} });
}

if (!TaskManager.isTaskDefined(BG_LOCATION_TASK)) {
  TaskManager.defineTask(BG_LOCATION_TASK, async ({ data, error }) => {
    if (error || !data) return;
    const { locations } = data as { locations: Location.LocationObject[] };
    for (const l of locations ?? []) {
      pushBgLoc({
        ts: l.timestamp,
        lat: l.coords.latitude,
        lon: l.coords.longitude,
        alt: l.coords.altitude,
        speed: l.coords.speed,
        accuracy: l.coords.accuracy,
      });
    }
  });
}

// Vision tab — Camera + LiDAR. Isolated as its own component so the
// useCameraPermissions hook and Lidar.isSupported() call only run when
// the tab is mounted. Keeps a crash here from taking down all of Lab.
interface DetectedObject {
  label: string;
  count: number;
  confidence: "high" | "medium" | "low";
  description?: string;
}

/** Colored triangles at screen edges pointing toward off-screen balls. */
function OffScreenIndicators({ balls }: { balls: { number: number; status: BallState; screenX: number; screenY: number }[] }) {
  const { width } = useWindowDimensions();
  const viewH = width * (16 / 9);  // matches 9:16 aspect ratio
  const margin = 12;
  return (
    <View pointerEvents="none" style={{ position: "absolute", top: 0, left: 0, width, height: viewH }}>
      {balls.map((ob) => {
        const angle = Math.atan2(ob.screenY - 0.5, ob.screenX - 0.5);
        // Clamp to screen edge with margin
        const px = Math.max(margin, Math.min(width - margin, ob.screenX * width));
        const py = Math.max(margin, Math.min(viewH - margin, ob.screenY * viewH));
        const color = ob.status === "confirmed" ? "#ff00ff" : ob.status === "probable" ? "#00ffff" : "#ffff00";
        return (
          <View
            key={ob.number}
            style={{
              position: "absolute", left: px - 8, top: py - 8,
              width: 0, height: 0,
              borderLeftWidth: 8, borderRightWidth: 8, borderBottomWidth: 14,
              borderLeftColor: "transparent", borderRightColor: "transparent",
              borderBottomColor: color,
              transform: [{ rotate: `${angle * (180 / Math.PI) + 90}deg` }],
            }}
          />
        );
      })}
    </View>
  );
}

function VisionTab({ theme, styles, pressure }: { theme: Theme; styles: ReturnType<typeof makeStyles>; pressure: { pressure: number; relativeAltitude?: number | null } | null }) {
  const [cameraPerm, requestCameraPerm] = useCameraPermissions();
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraFacing, setCameraFacing] = useState<"back" | "front">("back");
  const cameraRef = useRef<CameraViewType>(null);

  // Claude object detection (one-shot)
  const [detecting, setDetecting] = useState(false);
  const [detectionErr, setDetectionErr] = useState<string | null>(null);
  const [detectionObjects, setDetectionObjects] = useState<DetectedObject[] | null>(null);
  const [detectionNote, setDetectionNote] = useState<string | null>(null);
  const [detectionAt, setDetectionAt] = useState<number | null>(null);
  const [detectionPhotoUri, setDetectionPhotoUri] = useState<string | null>(null);

  // YOLO (on-device, CoreML) — generic object detection with COCO labels
  const yoloAvailable = Yolo.available();
  const yoloReady = yoloAvailable && Yolo.isReady();
  const yoloLoadErr = yoloAvailable ? Yolo.loadError() : null;
  const [yoloRunning, setYoloRunning] = useState(false);
  const [yoloLive, setYoloLive] = useState(false);
  const [yoloResult, setYoloResult] = useState<YoloResult | null>(null);
  const [yoloPhotoUri, setYoloPhotoUri] = useState<string | null>(null);
  const [yoloErr, setYoloErr] = useState<string | null>(null);
  const yoloLiveRef = useRef(false);
  // Ring buffer of last 10 frames for after-the-fact review
  const yoloFramesRef = useRef<{ uri: string; result: YoloResult; ts: number }[]>([]);
  const [yoloFramesVersion, setYoloFramesVersion] = useState(0);
  const [yoloReviewIdx, setYoloReviewIdx] = useState<number | null>(null);

  const runYoloOnce = async () => {
    if (!cameraRef.current) return;
    setYoloErr(null);
    try {
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.5, skipProcessing: true });
      if (!photo?.uri) throw new Error("No image captured");
      const result = await Yolo.detect(photo.uri, { minConfidence: 0.25 });
      // Push into ring buffer (max 10)
      yoloFramesRef.current.push({ uri: photo.uri, result, ts: Date.now() });
      if (yoloFramesRef.current.length > 10) yoloFramesRef.current.shift();
      setYoloFramesVersion((v) => v + 1);
      setYoloPhotoUri(photo.uri);
      setYoloResult(result);
      setYoloReviewIdx(null);
    } catch (err) {
      setYoloErr((err as Error).message);
    }
  };

  const yoloSnap = async () => {
    setYoloRunning(true);
    await runYoloOnce();
    setYoloRunning(false);
  };

  const startYoloLive = async () => {
    if (!cameraOn) return;
    yoloFramesRef.current = [];
    setYoloFramesVersion((v) => v + 1);
    yoloLiveRef.current = true;
    setYoloLive(true);
    while (yoloLiveRef.current) {
      await runYoloOnce();
    }
  };
  const stopYoloLive = () => {
    yoloLiveRef.current = false;
    setYoloLive(false);
    if (yoloFramesRef.current.length > 0) {
      setYoloReviewIdx(yoloFramesRef.current.length - 1);
    }
  };
  const reviewYoloFrame = (idx: number) => {
    const frame = yoloFramesRef.current[idx];
    if (!frame) return;
    setYoloReviewIdx(idx);
    setYoloPhotoUri(frame.uri);
    setYoloResult(frame.result);
  };
  useEffect(() => () => { yoloLiveRef.current = false; }, []);

  // Vision sub-mode — tabs under the camera/depth tile
  type VisionMode = "claude" | "applevision" | "yolo" | "lidar" | "map" | "balls" | "field";
  const [visionMode, setVisionMode] = useState<VisionMode>("balls");
  const VISION_MODE_TABS: { key: VisionMode; label: string }[] = [
    { key: "claude", label: "Claude" },
    { key: "applevision", label: "Apple" },
    { key: "yolo", label: "YOLO" },
    { key: "lidar", label: "LiDAR" },
    { key: "map", label: "Map" },
    { key: "balls", label: "Balls" },
    { key: "field", label: "Field" },
  ];

  // Map mode — ARKit-aligned capture + YOLO + depth → per-object spatial record
  interface MappedObject {
    label: string;
    confidence: number;
    box: { x: number; y: number; width: number; height: number };
    /** Meters from camera, or null if depth sample failed (e.g. sky, mirror) */
    distance: number | null;
    /** Radians, right of optical axis (+) */
    horizontalAngle: number;
    /** Radians, above optical axis (+) */
    verticalAngle: number;
  }
  interface MapCapture {
    id: string;
    timestamp: number;
    imageUri: string;
    imageWidth: number;
    imageHeight: number;
    eulerAngles: { pitch: number; yaw: number; roll: number };
    /** Relative altitude in meters from the barometer zero (null if barometer not ready) */
    relativeAltitudeMeters: number | null;
    objects: MappedObject[];
  }
  const [mapBusy, setMapBusy] = useState(false);
  const [mapErr, setMapErr] = useState<string | null>(null);
  const [mapCaptures, setMapCaptures] = useState<MapCapture[]>([]);
  const [mapShownIdx, setMapShownIdx] = useState<number | null>(null);

  const captureAndMap = async () => {
    if (!yoloReady) { setMapErr("YOLO model not ready"); return; }
    if (!lidarOn) { setMapErr("Start LiDAR (above) first — ARSession must be running"); return; }
    setMapBusy(true);
    setMapErr(null);
    try {
      const aligned = await Lidar.captureAlignedFrame(0.75);
      // Persist the JPEG to a file URI so YOLO + <Image> can read it.
      // Use a data URI for simplicity (works for both).
      const dataUri = `data:image/jpeg;base64,${aligned.imageBase64}`;
      const yoloRes = await Yolo.detect(dataUri, { minConfidence: 0.25 });
      const depth = decodeDepthBuffer(aligned.depthBase64);
      const { fx, fy, cx, cy, imageWidth: intrW, imageHeight: intrH } = aligned.intrinsics;
      const objs: MappedObject[] = yoloRes.detections.map((d) => {
        const nx = d.box.x + d.box.width / 2;
        const ny = d.box.y + d.box.height / 2;
        const distance = sampleDepth(depth, aligned.depthWidth, aligned.depthHeight, nx, ny);
        // Map normalized point back into intrinsics image space.
        const px = nx * intrW;
        const py = ny * intrH;
        return {
          label: d.label,
          confidence: d.confidence,
          box: d.box,
          distance,
          horizontalAngle: Math.atan2(px - cx, fx),
          verticalAngle: Math.atan2(cy - py, fy),
        };
      });
      // Read barometer relative altitude opportunistically.
      let rel: number | null = null;
      if (pressure?.relativeAltitude != null) rel = pressure.relativeAltitude;
      const cap: MapCapture = {
        id: `${aligned.timestamp}`,
        timestamp: Date.now(),
        imageUri: dataUri,
        imageWidth: aligned.imageWidth,
        imageHeight: aligned.imageHeight,
        eulerAngles: aligned.eulerAngles,
        relativeAltitudeMeters: rel,
        objects: objs,
      };
      setMapCaptures((prev) => [cap, ...prev].slice(0, 20));
      setMapShownIdx(0);
    } catch (err) {
      setMapErr((err as Error).message);
    } finally {
      setMapBusy(false);
    }
  };

  // Balls mode — uses ARSCNView as live preview. ARKit owns world tracking,
  // plane detection, raycast, and SceneKit marker rendering. JS orchestrates:
  // captures the current camera frame for YOLO, then calls native raycast for
  // each sports-ball detection. Native returns world XYZ; JS keeps a list of
  // tracked balls with sightings + confidence, and dedups by 3D distance.
  interface TrackedBall {
    id: string;       // ARKit anchor UUID
    number: number;   // assigned by native at creation
    worldX: number;
    worldY: number;
    worldZ: number;
    firstSeen: number;
    lastSeen: number;
    sightings: number;
    lastConfidence: number;
    /** Yellow (candidate) → cyan (probable) → fuchsia (confirmed). Promotion
     *  rules driven by sightings + confidence + close-up shortcut. */
    status: BallState;
    /** Timestamp (ms) when YOLO last matched this ball in a capture. Used
     *  for time-based revalidation: removed if unseen for too long while on screen. */
    lastConfirmedAt: number;
  }
  // ---- Tunable knobs (live-adjustable via Dev panel) ----
  interface BallTunables {
    yoloMinConf: number;
    captureQuality: number;
    tierMax: number;
    tier1Dist: number; tier1Conf: number;
    tier2Dist: number; tier2Conf: number;
    tier3Dist: number; tier3Conf: number;
    tier4Dist: number; tier4Conf: number;
    dedupM: number;  // legacy fallback
    dedupConfirmedM: number;
    dedupProbableM: number;
    dedupCandidateM: number;
    probableSightings: number;
    probableConf: number;
    confirmedSightings: number;
    confirmedConf: number;
    immediateConfirmRange: number;
    immediateConfirmConf: number;
    revalidateScreenTolerance: number;
    // Time-based revalidation: if a ball is on screen but YOLO hasn't
    // re-detected it for this many ms, it gets removed. Tighter for
    // confirmed (higher confidence it was real, remove faster if gone).
    revalTimeoutMs: {
      candidate: number;
      probable: number;
      confirmed: number;
    };
  }
  const DEFAULT_TUNABLES: BallTunables = {
    yoloMinConf: 0.10,
    captureQuality: 0.90,
    tierMax: 8.0,
    tier1Dist: 2.0, tier1Conf: 0.45,
    tier2Dist: 4.0, tier2Conf: 0.30,
    tier3Dist: 6.0, tier3Conf: 0.20,
    tier4Dist: 8.0, tier4Conf: 0.15,
    dedupM: 0.25,
    dedupConfirmedM: 0.10,
    dedupProbableM: 0.15,
    dedupCandidateM: 0.25,
    probableSightings: 2,
    probableConf: 0.30,
    confirmedSightings: 3,
    confirmedConf: 0.45,
    immediateConfirmRange: 2.0,
    immediateConfirmConf: 0.45,
    revalidateScreenTolerance: 0.10,
    revalTimeoutMs: {
      confirmed: 1000,
      probable: 2000,
      candidate: 3000,
    },
  };
  const [tunables, setTunables] = useState<BallTunables>(DEFAULT_TUNABLES);
  // Hold a ref so the running Live loop always sees the latest values
  // without restart when the user drags a slider.
  const tunablesRef = useRef(tunables);
  useEffect(() => { tunablesRef.current = tunables; }, [tunables]);
  const [devOpen, setDevOpen] = useState(false);

  const tierMinConf = (distance: number, t = tunablesRef.current): number => {
    if (distance < t.tier1Dist) return t.tier1Conf;
    if (distance < t.tier2Dist) return t.tier2Conf;
    if (distance < t.tier3Dist) return t.tier3Conf;
    if (distance < t.tier4Dist) return t.tier4Conf;
    return Infinity;
  };
  const tierLabel = (distance: number, t = tunablesRef.current): string => {
    if (distance < t.tier1Dist) return `<${t.tier1Dist}m`;
    if (distance < t.tier2Dist) return `${t.tier1Dist}-${t.tier2Dist}m`;
    if (distance < t.tier3Dist) return `${t.tier2Dist}-${t.tier3Dist}m`;
    if (distance < t.tier4Dist) return `${t.tier3Dist}-${t.tier4Dist}m`;
    return `>${t.tier4Dist}m`;
  };

  /** Revalidation distance bucket — derived from the detection tier boundaries. */
  type RevalBucket = "close" | "mid" | "far" | "skip";
  const revalBucket = (distance: number, t = tunablesRef.current): RevalBucket => {
    if (distance < t.tier1Dist) return "close";
    if (distance < t.tier2Dist) return "mid";
    if (distance < t.tier3Dist) return "far";
    return "skip";
  };
  /** Time-based revalidation timeout for a given state, in ms. */
  const revalTimeout = (state: BallState, t = tunablesRef.current): number => {
    return t.revalTimeoutMs[state];
  };

  /** Tier ordering for picking a "keeper" during cluster merge / dedup. */
  const stateRank = (s: BallState): number =>
    s === "confirmed" ? 2 : s === "probable" ? 1 : 0;
  /** Compute desired state from sightings + last confidence + close-up rule. */
  const promotedState = (
    current: BallState,
    sightings: number,
    lastConfidence: number,
    captureDistance: number,
    t = tunablesRef.current,
  ): BallState => {
    if (current === "confirmed") return "confirmed";
    if (captureDistance < t.immediateConfirmRange && lastConfidence >= t.immediateConfirmConf) return "confirmed";
    if (sightings >= t.confirmedSightings && lastConfidence >= t.confirmedConf) return "confirmed";
    if (current === "probable") return "probable";
    if (sightings >= t.probableSightings && lastConfidence >= t.probableConf) return "probable";
    return "candidate";
  };

  // Diagnostic telemetry for the last capture
  interface DetectionReport {
    confidence: number;
    distance: number | null;
    decision: string;
    ballNumber?: number;
    state?: BallState;
  }
  interface RevalidationReport {
    ballNumber: number;
    state: BallState;
    outcome: "still" | "miss" | "deleted" | "out-of-range" | "off-screen";
    missCount: number;
    missLimit: number;
    distance: number;
    bucket: RevalBucket;
  }
  interface CaptureTelemetry {
    timestamp: number;
    rawDetectionCount: number;
    sportsBallCount: number;
    /** Every YOLO detection's label + confidence, regardless of class. Useful
     *  for diagnosing "why isn't my object detected?" when COCO classes
     *  don't match the actual object (e.g. baseball classified as donut). */
    rawDetections: { label: string; confidence: number }[];
    perDetection: DetectionReport[];
    revalidation: RevalidationReport[];
  }
  const [telemetry, setTelemetry] = useState<CaptureTelemetry | null>(null);
  interface CameraPose {
    worldX: number;
    worldY: number;
    worldZ: number;
    forwardX: number; forwardY: number; forwardZ: number;
    upX: number; upY: number; upZ: number;
  }
  const arRef = useRef<LidarARViewRef>(null);
  const arViewAvailable = lidarARViewAvailable();
  // Use glass (semi-transparent) cards when AR view is filling the screen
  const isArFullscreen = (visionMode === "balls" || visionMode === "field") && arViewAvailable;
  const cardStyle = isArFullscreen ? styles.glassCard : styles.card;
  // AR visualization toggles for the LidarARView
  const [showPlanes, setShowPlanes] = useState(false);
  const [showMesh, setShowMesh] = useState(false);
  const [showFeaturePoints, setShowFeaturePoints] = useState(false);
  const [arEditMode, setArEditMode] = useState(false);

  // Sync edit mode to the scroll-disable mechanism
  useEffect(() => { setFieldEditMode(arEditMode); return () => setFieldEditMode(false); }, [arEditMode]);
  // Turn off edit mode when leaving field tab
  useEffect(() => { if (visionMode !== "field") setArEditMode(false); }, [visionMode]);
  const [balls, setBalls] = useState<TrackedBall[]>([]);
  const ballsRef = useRef<TrackedBall[]>([]);
  // Keep ref in sync so background sweep always sees current balls
  useEffect(() => { ballsRef.current = balls; }, [balls]);
  const [ballsCameraPose, setBallsCameraPose] = useState<CameraPose | null>(null);
  const [ballsBusy, setBallsBusy] = useState(false);
  const [ballsErr, setBallsErr] = useState<string | null>(null);
  const [ballsLastImage, setBallsLastImage] = useState<{ uri: string; width: number; height: number; boxes: { x: number; y: number; width: number; height: number; number: number }[] } | null>(null);
  // Off-screen ball indicators: projected screen position + status for triangles at screen edges
  const [offScreenBalls, setOffScreenBalls] = useState<{ number: number; status: BallState; screenX: number; screenY: number }[]>([]);

  // Poll current camera pose + off-screen ball projections while Balls mode is active
  useEffect(() => {
    if (visionMode !== "balls") return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled || !arRef.current) return;
      const t = await arRef.current.currentCameraTransform().catch(() => null);
      if (cancelled || !t || t.length < 16) return;
      setBallsCameraPose({
        worldX: t[12]!, worldY: t[13]!, worldZ: t[14]!,
        forwardX: -t[8]!, forwardY: -t[9]!, forwardZ: -t[10]!,
        upX: t[4]!, upY: t[5]!, upZ: t[6]!,
      });
      // Project all balls to screen; collect off-screen ones
      const offScreen: { number: number; status: BallState; screenX: number; screenY: number }[] = [];
      for (const b of ballsRef.current) {
        const proj = await arRef.current?.projectWorldPoint(b.worldX, b.worldY, b.worldZ).catch(() => null);
        if (!proj) continue;
        const onScreen = proj.isInFront && proj.screenX >= 0 && proj.screenX <= 1 && proj.screenY >= 0 && proj.screenY <= 1;
        if (!onScreen) {
          offScreen.push({ number: b.number, status: b.status, screenX: proj.screenX, screenY: proj.screenY });
        }
      }
      if (!cancelled) setOffScreenBalls(offScreen);
    };
    const interval = setInterval(tick, 500);
    tick();
    return () => { cancelled = true; clearInterval(interval); };
  }, [visionMode]);

  const captureAndFindBalls = async () => {
    if (!arRef.current) { setBallsErr("AR view not ready"); return; }
    if (!yoloReady) { setBallsErr("YOLO model not ready"); return; }
    setBallsBusy(true);
    setBallsErr(null);
    const t = tunablesRef.current;
    const perDetection: DetectionReport[] = [];
    const revalidationReports: RevalidationReport[] = [];
    let sportsBallCount = 0;
    let rawDetectionCount = 0;
    try {
      const cap = await arRef.current.captureViewImage(t.captureQuality);
      if (!cap) { setBallsErr("No frame yet — give ARKit a moment to start"); return; }
      const dataUri = `data:image/jpeg;base64,${cap.imageBase64}`;
      const yoloRes = await Yolo.detect(dataUri, { minConfidence: t.yoloMinConf });
      rawDetectionCount = yoloRes.detections.length;
      const rawDetections = yoloRes.detections.map((d) => ({ label: d.label, confidence: d.confidence }));

      const camT = await arRef.current.currentCameraTransform();
      const camX = camT?.[12] ?? 0, camY = camT?.[13] ?? 0, camZ = camT?.[14] ?? 0;
      const distFromCamera = (wx: number, wy: number, wz: number) =>
        Math.sqrt((wx - camX) ** 2 + (wy - camY) ** 2 + (wz - camZ) ** 2);

      const liveAnchors = await arRef.current.listBalls().catch(() => [] as BallAnchor[]);
      const liveById = new Map(liveAnchors.map((a) => [a.id, a]));
      let newBalls: TrackedBall[] = ballsRef.current
        .map((b) => {
          const live = liveById.get(b.id);
          return live ? { ...b, worldX: live.worldX, worldY: live.worldY, worldZ: live.worldZ } : b;
        })
        .filter((b) => liveById.has(b.id));

      const drawBoxes: { x: number; y: number; width: number; height: number; number: number }[] = [];
      const matchedIds = new Set<string>();
      const yoloBallDetections: { nx: number; ny: number; confidence: number }[] = [];
      const now = Date.now();

      for (const d of yoloRes.detections) {
        if (d.label !== "sports ball") continue;
        sportsBallCount++;
        const nx = d.box.x + d.box.width / 2;
        const ny = d.box.y + d.box.height / 2;
        yoloBallDetections.push({ nx, ny, confidence: d.confidence });

        const added = await arRef.current.addBallAtScreenPoint(nx, ny, 0.035);
        if (!added) {
          perDetection.push({ confidence: d.confidence, distance: null, decision: "raycast missed (no floor below)" });
          continue;
        }

        const dist = distFromCamera(added.worldX, added.worldY, added.worldZ);
        if (dist > t.tierMax) {
          await arRef.current.removeBall(added.id).catch(() => {});
          perDetection.push({ confidence: d.confidence, distance: dist, decision: `beyond tierMax (${t.tierMax.toFixed(1)}m)` });
          continue;
        }
        const tierFloor = tierMinConf(dist, t);
        if (d.confidence < tierFloor) {
          await arRef.current.removeBall(added.id).catch(() => {});
          perDetection.push({
            confidence: d.confidence,
            distance: dist,
            decision: `conf < tier ${tierLabel(dist, t)} floor (${tierFloor.toFixed(2)})`,
          });
          continue;
        }

        // Per-state dedupe distance: tighter for confirmed (more certain position)
        const dedupFor = (state: BallState) =>
          state === "confirmed" ? t.dedupConfirmedM : state === "probable" ? t.dedupProbableM : t.dedupCandidateM;

        let matchedIdx = -1;
        let bestDist = t.dedupCandidateM;  // start with loosest
        for (let i = 0; i < newBalls.length; i++) {
          const b = newBalls[i]!;
          const threshold = dedupFor(b.status);
          const dx = b.worldX - added.worldX;
          const dy = b.worldY - added.worldY;
          const dz = b.worldZ - added.worldZ;
          const d3 = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (d3 < threshold && d3 < bestDist) { bestDist = d3; matchedIdx = i; }
        }

        if (matchedIdx >= 0) {
          await arRef.current.removeBall(added.id).catch(() => {});
          const b = newBalls[matchedIdx]!;
          const sightings = b.sightings + 1;
          const newStatus = promotedState(b.status, sightings, d.confidence, dist, t);
          if (newStatus !== b.status) {
            await arRef.current.setBallState(b.id, newStatus).catch(() => {});
          }
          newBalls[matchedIdx] = {
            ...b, sightings, lastSeen: now, lastConfidence: d.confidence, status: newStatus, lastConfirmedAt: now,
          };
          matchedIds.add(b.id);
          drawBoxes.push({ ...d.box, number: b.number });
          perDetection.push({
            confidence: d.confidence, distance: dist,
            decision: `merged into #${b.number} (${newStatus})`, ballNumber: b.number, state: newStatus,
          });
        } else {
          const startStatus = promotedState("candidate", 1, d.confidence, dist, t);
          if (startStatus !== "candidate") {
            await arRef.current.setBallState(added.id, startStatus).catch(() => {});
          }
          newBalls.push({
            id: added.id, number: added.number,
            worldX: added.worldX, worldY: added.worldY, worldZ: added.worldZ,
            firstSeen: now, lastSeen: now, sightings: 1, lastConfidence: d.confidence,
            status: startStatus, lastConfirmedAt: now,
          });
          matchedIds.add(added.id);
          drawBoxes.push({ ...d.box, number: added.number });
          perDetection.push({
            confidence: d.confidence, distance: dist,
            decision: `new #${added.number} (${startStatus})`, ballNumber: added.number, state: startStatus,
          });
        }
      }

      // --- Revalidation (time-based: remove if unseen for timeout while on screen) ---
      const stillTracked: TrackedBall[] = [];
      for (const b of newBalls) {
        if (matchedIds.has(b.id)) {
          // YOLO matched it this frame — update lastConfirmedAt
          stillTracked.push({ ...b, lastConfirmedAt: now });
          continue;
        }

        const ballDist = distFromCamera(b.worldX, b.worldY, b.worldZ);
        const bucket = revalBucket(ballDist, t);
        const timeout = revalTimeout(b.status, t);

        if (bucket === "skip") {
          stillTracked.push(b);
          revalidationReports.push({ ballNumber: b.number, state: b.status, outcome: "out-of-range", missCount: 0, missLimit: 0, distance: ballDist, bucket });
          continue;
        }
        const proj = await arRef.current.projectWorldPoint(b.worldX, b.worldY, b.worldZ).catch(() => null);
        const onScreen = proj && proj.isInFront && proj.screenX >= 0 && proj.screenX <= 1 && proj.screenY >= 0 && proj.screenY <= 1;
        if (!onScreen) {
          // Off screen: preserve, don't count against it
          stillTracked.push(b);
          revalidationReports.push({ ballNumber: b.number, state: b.status, outcome: "off-screen", missCount: 0, missLimit: 0, distance: ballDist, bucket });
          continue;
        }
        const tol = t.revalidateScreenTolerance;
        const found = yoloBallDetections.some(
          (det) => Math.abs(det.nx - proj!.screenX) <= tol && Math.abs(det.ny - proj!.screenY) <= tol
        );
        if (found) {
          stillTracked.push({ ...b, lastConfirmedAt: now });
          revalidationReports.push({ ballNumber: b.number, state: b.status, outcome: "still", missCount: 0, missLimit: 0, distance: ballDist, bucket });
        } else {
          const elapsed = now - b.lastConfirmedAt;
          if (elapsed >= timeout) {
            await arRef.current.removeBall(b.id).catch(() => {});
            revalidationReports.push({ ballNumber: b.number, state: b.status, outcome: "deleted", missCount: 0, missLimit: 0, distance: ballDist, bucket });
          } else {
            stillTracked.push(b);
            revalidationReports.push({ ballNumber: b.number, state: b.status, outcome: "miss", missCount: 0, missLimit: 0, distance: ballDist, bucket });
          }
        }
      }
      newBalls = stillTracked;

      newBalls = await mergeBallClusters(newBalls);

      setBalls(newBalls);
      setBallsLastImage({ uri: dataUri, width: cap.imageWidth, height: cap.imageHeight, boxes: drawBoxes });
      setTelemetry({
        timestamp: now,
        rawDetectionCount,
        sportsBallCount,
        rawDetections,
        perDetection,
        revalidation: revalidationReports,
      });
    } catch (err) {
      setBallsErr((err as Error).message);
    } finally {
      setBallsBusy(false);
    }
  };

  /** Merge any pair of tracked balls within their per-state dedupe distance. */
  const mergeBallClusters = async (input: TrackedBall[]): Promise<TrackedBall[]> => {
    const t = tunablesRef.current;
    const arr = [...input];
    let changed = true;
    while (changed) {
      changed = false;
      outer: for (let i = 0; i < arr.length; i++) {
        for (let j = i + 1; j < arr.length; j++) {
          const a = arr[i]!, b = arr[j]!;
          const dx = a.worldX - b.worldX;
          const dy = a.worldY - b.worldY;
          const dz = a.worldZ - b.worldZ;
          const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
          // Use the looser (larger) dedupe of the two balls
          const threshold = Math.max(
            a.status === "confirmed" ? t.dedupConfirmedM : a.status === "probable" ? t.dedupProbableM : t.dedupCandidateM,
            b.status === "confirmed" ? t.dedupConfirmedM : b.status === "probable" ? t.dedupProbableM : t.dedupCandidateM,
          );
          if (dist >= threshold) continue;
          // Higher-tier state wins; ties broken by more sightings.
          const aWins =
            stateRank(a.status) > stateRank(b.status) ||
            (stateRank(a.status) === stateRank(b.status) && a.sightings >= b.sightings);
          const keep = aWins ? a : b;
          const drop = aWins ? b : a;
          keep.sightings = keep.sightings + drop.sightings;
          keep.lastSeen = Math.max(keep.lastSeen, drop.lastSeen);
          keep.lastConfidence = Math.max(keep.lastConfidence, drop.lastConfidence);
          // Take the higher-ranked state across the pair.
          if (stateRank(drop.status) > stateRank(keep.status)) {
            keep.status = drop.status;
            await arRef.current?.setBallState(keep.id, keep.status).catch(() => {});
          }
          try { await arRef.current?.removeBall(drop.id); } catch {}
          const dropIdx = arr.indexOf(drop);
          if (dropIdx >= 0) arr.splice(dropIdx, 1);
          changed = true;
          break outer;
        }
      }
    }
    return arr;
  };

  const clearCandidates = async () => {
    const toDrop = balls.filter((b) => b.status === "candidate");
    for (const b of toDrop) {
      try { await arRef.current?.removeBall(b.id); } catch {}
    }
    setBalls((prev) => prev.filter((b) => b.status !== "candidate"));
  };

  const clearBalls = async () => {
    try { await arRef.current?.clearBalls(); } catch {}
    setBalls([]);
    setBallsLastImage(null);
  };

  // Continuous detection — runs captureAndFindBalls in a loop while active
  const [ballsLive, setBallsLive] = useState(false);
  const ballsLiveRef = useRef(false);
  const startBallsLive = async () => {
    if (!arRef.current || !yoloReady) return;
    ballsLiveRef.current = true;
    setBallsLive(true);
    while (ballsLiveRef.current) {
      await captureAndFindBalls();
      // Stationary objects don't need high frame rate — ~2 captures/sec is plenty
      await new Promise<void>((r) => setTimeout(r, 500));
    }
  };
  const stopBallsLive = () => {
    ballsLiveRef.current = false;
    setBallsLive(false);
  };
  useEffect(() => () => { ballsLiveRef.current = false; }, []);
  // Auto-stop continuous when leaving Balls tab
  useEffect(() => {
    if (visionMode !== "balls" && ballsLiveRef.current) {
      ballsLiveRef.current = false;
      setBallsLive(false);
    }
  }, [visionMode]);

  // Background revalidation sweep: every 5s when in Balls mode and NOT in
  // live capture. Captures a frame, runs YOLO, and revalidates all tracked
  // balls. Removes stale anchors that YOLO can no longer see.
  // (Live capture already revalidates on every frame, so skip during live.)
  useEffect(() => {
    if (visionMode !== "balls") return;
    let cancelled = false;
    const sweep = async () => {
      if (ballsLiveRef.current || cancelled) return;
      if (!arRef.current || !yoloReady) return;
      if (ballsRef.current.length === 0) return;
      await captureAndFindBalls();
    };
    const interval = setInterval(sweep, 5000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [visionMode, yoloReady]);

  const rejectBall = async (id: string) => {
    try { await arRef.current?.removeBall(id); } catch {}
    setBalls((prev) => prev.filter((b) => b.id !== id));
  };

  const resetAR = async () => {
    try { await arRef.current?.resetSession(); } catch {}
    setBalls([]);
    setBallsLastImage(null);
    setBallsCameraPose(null);
  };

  /** Distance + bearing from current camera pose to a ball. */
  const ballRelative = (ball: TrackedBall, pose: CameraPose | null) => {
    if (!pose) return null;
    const dx = ball.worldX - pose.worldX;
    const dy = ball.worldY - pose.worldY;
    const dz = ball.worldZ - pose.worldZ;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const forward = dx * pose.forwardX + dy * pose.forwardY + dz * pose.forwardZ;
    const right = dx * (pose.upY * pose.forwardZ - pose.upZ * pose.forwardY)
                + dy * (pose.upZ * pose.forwardX - pose.upX * pose.forwardZ)
                + dz * (pose.upX * pose.forwardY - pose.upY * pose.forwardX);
    const upDot = dx * pose.upX + dy * pose.upY + dz * pose.upZ;
    return {
      distance,
      horizontalAngleRad: Math.atan2(right, forward),
      verticalAngleRad: Math.atan2(upDot, Math.sqrt(forward * forward + right * right)),
    };
  };

  // Apple Vision (on-device) — faces / text / barcodes
  const visionAvailable = VisionDetect.available();
  const [visionRunning, setVisionRunning] = useState(false);
  const [visionResult, setVisionResult] = useState<DetectResult | null>(null);
  const [visionPhotoUri, setVisionPhotoUri] = useState<string | null>(null);
  const [visionErr, setVisionErr] = useState<string | null>(null);

  const runAppleVision = async () => {
    if (!cameraRef.current) return;
    setVisionRunning(true);
    setVisionErr(null);
    try {
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.8, skipProcessing: true });
      if (!photo?.uri) throw new Error("No image captured");
      const result = await VisionDetect.detect(photo.uri, { faces: true, text: true, barcodes: true });
      setVisionPhotoUri(photo.uri);
      setVisionResult(result);
    } catch (err) {
      setVisionErr((err as Error).message);
    } finally {
      setVisionRunning(false);
    }
  };

  const detectObjects = async () => {
    if (!cameraRef.current) return;
    setDetecting(true);
    setDetectionErr(null);
    try {
      const photo = await cameraRef.current.takePictureAsync({ base64: true, quality: 0.6, skipProcessing: true });
      if (!photo?.base64) throw new Error("No image captured");
      setDetectionPhotoUri(photo.uri ?? null);
      const token = useAuth.getState().token;
      const bytes = Uint8Array.from(atob(photo.base64), (ch) => ch.charCodeAt(0));
      const res = await fetch(`${API_BASE}/vision/detect`, {
        method: "POST",
        headers: {
          "Content-Type": "image/jpeg",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: bytes,
      });
      if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
      const data = await res.json() as { objects?: DetectedObject[]; note?: string };
      setDetectionObjects(data.objects ?? []);
      setDetectionNote(data.note ?? null);
      setDetectionAt(Date.now());
    } catch (err) {
      setDetectionErr((err as Error).message);
    } finally {
      setDetecting(false);
    }
  };

  const lidarAvailable = Lidar.available();
  const lidarSupported = lidarAvailable && Lidar.isSupported();
  const [lidarOn, setLidarOn] = useState(false);
  const [lidarFrame, setLidarFrame] = useState<DepthFrame | null>(null);
  const LIDAR_RES_OPTIONS = [
    { label: "32×24", w: 32, h: 24 },
    { label: "64×48", w: 64, h: 48 },
    { label: "128×96", w: 128, h: 96 },
    { label: "256×192", w: 256, h: 192 },
  ] as const;
  const [lidarResIdx, setLidarResIdx] = useState(0);
  const lidarRes = LIDAR_RES_OPTIONS[lidarResIdx];

  // FPS counter
  const fpsRef = useRef({ count: 0, lastReset: Date.now() });
  const [lidarFps, setLidarFps] = useState(0);

  const startLidarWith = async (w: number, h: number) => {
    try {
      await Lidar.startSession({ width: w, height: h, throttleMs: 100 });
      setLidarOn(true);
    } catch (err) {
      Alert.alert("LiDAR error", (err as Error).message);
    }
  };
  const startLidar = () => startLidarWith(lidarRes.w, lidarRes.h);
  const stopLidar = async () => {
    try { await Lidar.stopSession(); } catch {}
    setLidarOn(false);
    setLidarFrame(null);
    setLidarFps(0);
  };
  const changeRes = async (idx: number) => {
    setLidarResIdx(idx);
    const next = LIDAR_RES_OPTIONS[idx];
    if (lidarOn) {
      try { await Lidar.stopSession(); } catch {}
      await startLidarWith(next.w, next.h);
    }
  };
  useEffect(() => {
    if (!lidarOn) return;
    const sub = Lidar.addDepthListener((frame) => {
      setLidarFrame(frame);
      const now = Date.now();
      fpsRef.current.count++;
      if (now - fpsRef.current.lastReset >= 1000) {
        setLidarFps(fpsRef.current.count);
        fpsRef.current = { count: 0, lastReset: now };
      }
    });
    return () => sub.remove();
  }, [lidarOn]);
  useEffect(() => {
    return () => { Lidar.stopSession().catch(() => {}); };
  }, []);

  return (
    <>
      {/* AR view — full-screen with overlaid controls for balls/field */}
      {(visionMode === "balls" || visionMode === "field") && (
        arViewAvailable ? (
          <View style={{ marginHorizontal: -16, marginTop: -16, marginBottom: 4, aspectRatio: 9 / 16 }}>
            <View pointerEvents={arEditMode ? "auto" : "none"} style={{ flex: 1 }}>
              <LidarARView
                ref={arRef}
                style={{ flex: 1 }}
                showPlanes={showPlanes}
                showMesh={showMesh}
                showFeaturePoints={showFeaturePoints}
              />
            </View>
            {/* Off-screen ball indicators */}
            {visionMode === "balls" && offScreenBalls.length > 0 && (
              <OffScreenIndicators balls={offScreenBalls} />
            )}
            {/* Overlaid controls at bottom */}
            <View pointerEvents="box-none" style={{ position: "absolute", bottom: 0, left: 0, right: 0, paddingBottom: 12, paddingHorizontal: 12 }}>
              {/* Ball count badge */}
              {visionMode === "balls" && balls.length > 0 && (
                <View style={{ alignItems: "center", marginBottom: 8 }}>
                  <View style={{ backgroundColor: "rgba(0,0,0,0.5)", paddingHorizontal: 12, paddingVertical: 4, borderRadius: 12 }}>
                    <Text style={{ color: "#fff", fontSize: 12, fontWeight: "600" }}>
                      {balls.filter((b) => b.status === "confirmed").length} confirmed · {balls.filter((b) => b.status === "probable").length} probable · {balls.filter((b) => b.status === "candidate").length} candidate
                    </Text>
                  </View>
                </View>
              )}
              {/* Action buttons */}
              {visionMode === "balls" && arViewAvailable && yoloReady && (
                <View style={{ flexDirection: "row", gap: 8, marginBottom: 8 }}>
                  <Pressable
                    onPress={captureAndFindBalls}
                    disabled={ballsBusy || ballsLive}
                    style={{ flex: 1, paddingVertical: 12, borderRadius: 10, alignItems: "center", backgroundColor: "rgba(255,255,255,0.2)", opacity: (ballsBusy || ballsLive) ? 0.4 : 1 }}
                  >
                    <Text style={{ color: "#fff", fontSize: 13, fontWeight: "700" }}>
                      {ballsBusy ? "Searching…" : "Snapshot"}
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={ballsLive ? stopBallsLive : startBallsLive}
                    style={{ flex: 1, paddingVertical: 12, borderRadius: 10, alignItems: "center", backgroundColor: ballsLive ? "rgba(255,60,60,0.7)" : "rgba(255,255,255,0.25)" }}
                  >
                    <Text style={{ color: "#fff", fontSize: 13, fontWeight: "700" }}>
                      {ballsLive ? "Stop" : "Live"}
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={clearBalls}
                    disabled={balls.length === 0}
                    style={{ paddingVertical: 12, paddingHorizontal: 16, borderRadius: 10, alignItems: "center", backgroundColor: "rgba(255,255,255,0.15)", opacity: balls.length === 0 ? 0.4 : 1 }}
                  >
                    <Text style={{ color: "#fff", fontSize: 13, fontWeight: "600" }}>Clear</Text>
                  </Pressable>
                </View>
              )}
              {/* Mode tabs — transparent pill bar */}
              <View style={{ flexDirection: "row", gap: 3, backgroundColor: "rgba(0,0,0,0.4)", borderRadius: 10, padding: 3 }}>
                {VISION_MODE_TABS.map((t) => {
                  const active = visionMode === t.key;
                  return (
                    <Pressable
                      key={t.key}
                      onPress={() => setVisionMode(t.key)}
                      style={{
                        flex: 1, paddingVertical: 7, borderRadius: 8, alignItems: "center",
                        backgroundColor: active ? "rgba(255,255,255,0.25)" : "transparent",
                      }}
                    >
                      <Text style={{ fontSize: 11, fontWeight: "600", color: active ? "#fff" : "rgba(255,255,255,0.6)" }}>
                        {t.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
            {/* Top-left overlay toggles */}
            <View pointerEvents="box-none" style={{ position: "absolute", top: 12, left: 12, flexDirection: "row", gap: 6 }}>
              {[
                { label: "P", value: showPlanes, set: setShowPlanes },
                { label: "M", value: showMesh, set: setShowMesh },
                { label: "F", value: showFeaturePoints, set: setShowFeaturePoints },
              ].map((opt) => (
                <Pressable
                  key={opt.label}
                  onPress={() => opt.set(!opt.value)}
                  style={{
                    width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center",
                    backgroundColor: opt.value ? "rgba(255,255,255,0.35)" : "rgba(0,0,0,0.3)",
                  }}
                >
                  <Text style={{ fontSize: 12, fontWeight: "700", color: "#fff" }}>{opt.label}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        ) : (
          <View style={{ width: "100%", aspectRatio: 3 / 4, backgroundColor: theme.surfaceAlt, justifyContent: "center", alignItems: "center" }}>
            <Text style={{ color: theme.textSubtle, fontSize: 13, textAlign: "center", paddingHorizontal: 24 }}>
              AR view not in this build — rebuild the app
            </Text>
          </View>
        )
      )}
      {/* Other vision modes in a card */}
      {!(visionMode === "balls" || visionMode === "field") && (
      <View style={[styles.card, { padding: 0, marginBottom: 4, overflow: "hidden" }]}>
        {(visionMode === "lidar" || visionMode === "map") ? (
          lidarFrame ? (
            <DepthGrid frame={lidarFrame} />
          ) : (
            <View style={{ width: "100%", aspectRatio: 4 / 3, backgroundColor: theme.surfaceAlt, justifyContent: "center", alignItems: "center" }}>
              <Text style={{ color: theme.textSubtle, fontSize: 13, textAlign: "center", paddingHorizontal: 24 }}>
                {!lidarAvailable
                  ? "LiDAR native module not in this build"
                  : lidarSupported
                    ? "Tap Start to begin (depth preview will appear here)"
                    : "No LiDAR sensor on this device"}
              </Text>
            </View>
          )
        ) : (
          cameraOn && cameraPerm?.granted ? (
            <CameraView
              ref={cameraRef}
              style={{ width: "100%", aspectRatio: 4 / 3 }}
              facing={cameraFacing}
              mute
            />
          ) : (
            <View style={{ width: "100%", aspectRatio: 4 / 3, backgroundColor: theme.surfaceAlt, justifyContent: "center", alignItems: "center" }}>
              <Text style={{ color: theme.textSubtle, fontSize: 14 }}>
                {cameraPerm?.granted ? "Camera off" : "Camera permission not granted"}
              </Text>
            </View>
          )
        )}
      </View>
      )}

      {/* Status line under the tile */}
      {(visionMode === "lidar" || visionMode === "map") && lidarFrame && (
        <Text style={{ fontSize: 11, color: theme.textMuted, marginBottom: 8, textAlign: "right", paddingHorizontal: 4 }}>
          {lidarFrame.width}×{lidarFrame.height} · {lidarFps} fps · min {lidarFrame.minMeters.toFixed(2)} m · max {lidarFrame.maxMeters.toFixed(2)} m
        </Text>
      )}

      {/* Mode tabs — only for non-AR modes (AR modes have overlaid tabs) */}
      {!(visionMode === "balls" || visionMode === "field") && (
      <View style={{ flexDirection: "row", gap: 4, marginBottom: 8 }}>
        {VISION_MODE_TABS.map((t) => {
          const active = visionMode === t.key;
          return (
            <Pressable
              key={t.key}
              onPress={() => setVisionMode(t.key)}
              style={{
                flex: 1,
                paddingVertical: 8,
                borderRadius: 8,
                alignItems: "center",
                backgroundColor: active ? theme.primary : theme.surfaceAlt,
                borderWidth: active ? 0 : StyleSheet.hairlineWidth,
                borderColor: theme.border,
              }}
            >
              <Text style={{ fontSize: 12, fontWeight: "600", color: active ? "#fff" : theme.text }}>
                {t.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      )}

      {/* Top-tile controls: start/stop the right hardware.
          Map / Balls modes have their own controls inside the per-mode body. */}
      {(visionMode === "map" || visionMode === "balls" || visionMode === "field") ? null : visionMode === "lidar" ? (
        <View style={[styles.card, { padding: 14, marginBottom: 14 }]}>
          <Text style={{ fontSize: 11, fontWeight: "600", color: theme.textSubtle, textTransform: "uppercase", marginBottom: 6 }}>
            Resolution
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
            {LIDAR_RES_OPTIONS.map((opt, idx) => {
              const active = lidarResIdx === idx;
              return (
                <Pressable
                  key={opt.label}
                  onPress={() => changeRes(idx)}
                  style={{
                    flexGrow: 1,
                    minWidth: "22%",
                    paddingVertical: 8,
                    borderRadius: 8,
                    alignItems: "center",
                    backgroundColor: active ? theme.primary : theme.surfaceAlt,
                    borderWidth: active ? 0 : StyleSheet.hairlineWidth,
                    borderColor: theme.border,
                  }}
                >
                  <Text style={{ fontSize: 12, fontWeight: "600", color: active ? "#fff" : theme.text }}>
                    {opt.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <Pressable
            onPress={lidarOn ? stopLidar : startLidar}
            disabled={!lidarSupported}
            style={{ paddingVertical: 10, borderRadius: 8, alignItems: "center", backgroundColor: lidarSupported ? (lidarOn ? theme.destructive : theme.primary) : theme.surfaceAlt }}
          >
            <Text style={{ color: lidarSupported ? "#fff" : theme.textSubtle, fontSize: 13, fontWeight: "600" }}>
              {!lidarSupported ? "Unsupported" : lidarOn ? "Stop LiDAR" : "Start LiDAR"}
            </Text>
          </Pressable>
          <Text style={{ fontSize: 11, color: theme.textSubtle, marginTop: 6, textAlign: "center" }}>
            Color: red (near) → blue (far). Capped at 5 m. Native sensor res is 256×192.
          </Text>
        </View>
      ) : (
        <View style={[styles.card, { padding: 14, marginBottom: 14 }]}>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Pressable
              onPress={async () => {
                if (!cameraPerm?.granted) {
                  const res = await requestCameraPerm();
                  if (!res.granted) return;
                }
                setCameraOn((on) => !on);
              }}
              style={{ flex: 1, paddingVertical: 10, borderRadius: 8, alignItems: "center", backgroundColor: cameraOn ? theme.destructive : theme.primary }}
            >
              <Text style={{ color: "#fff", fontSize: 13, fontWeight: "600" }}>
                {cameraOn ? "Stop" : "Start"} camera
              </Text>
            </Pressable>
            <Pressable
              onPress={() => setCameraFacing((f) => (f === "back" ? "front" : "back"))}
              disabled={!cameraOn}
              style={{ paddingVertical: 10, paddingHorizontal: 14, borderRadius: 8, alignItems: "center", backgroundColor: theme.surfaceAlt, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.border, opacity: cameraOn ? 1 : 0.4 }}
            >
              <Text style={{ fontSize: 13, fontWeight: "600", color: theme.primary }}>Flip</Text>
            </Pressable>
          </View>
        </View>
      )}

      {/* Per-mode body */}
      {visionMode === "claude" && (
        <>
          <View style={[styles.card, { padding: 14, marginBottom: 4 }]}>
            <Pressable
              onPress={detectObjects}
              disabled={!cameraOn || detecting}
              style={{ paddingVertical: 10, borderRadius: 8, alignItems: "center", backgroundColor: cameraOn ? theme.primary : theme.surfaceAlt, opacity: detecting ? 0.6 : 1 }}
            >
              <Text style={{ color: cameraOn ? "#fff" : theme.textSubtle, fontSize: 13, fontWeight: "600" }}>
                {detecting ? "Asking Claude…" : "Detect (snapshot)"}
              </Text>
            </Pressable>
            <Text style={{ fontSize: 11, color: theme.textSubtle, marginTop: 6, textAlign: "center" }}>
              Sends one frame to Claude Haiku vision. ~¢0.2 per snapshot.
            </Text>
          </View>
          {detectionErr && (
            <View style={[styles.card, { padding: 12, marginBottom: 4 }]}>
              <Text style={{ fontSize: 12, color: theme.destructive }}>{detectionErr}</Text>
            </View>
          )}
          {detectionObjects && (
            <View style={[styles.card, { padding: 12, marginBottom: 16 }]}>
              {detectionPhotoUri && (
                <Image
                  source={{ uri: detectionPhotoUri }}
                  style={{ width: "100%", aspectRatio: 4 / 3, borderRadius: 6, marginBottom: 8 }}
                  resizeMode="cover"
                />
              )}
              <Text style={{ fontSize: 11, color: theme.textSubtle, marginBottom: 6 }}>
                {detectionAt ? `${Math.round((Date.now() - detectionAt) / 1000)} s ago` : ""} · {detectionObjects.length} objects
              </Text>
              {detectionNote && (
                <Text style={{ fontSize: 12, color: theme.textMuted, marginBottom: 8, fontStyle: "italic" }}>
                  {detectionNote}
                </Text>
              )}
              {detectionObjects.length === 0 ? (
                <Text style={{ fontSize: 12, color: theme.textSubtle }}>(nothing detected)</Text>
              ) : (
                detectionObjects.map((o, i) => (
                  <View key={i} style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 4, borderTopWidth: i === 0 ? 0 : StyleSheet.hairlineWidth, borderColor: theme.border }}>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 13, color: theme.text, fontWeight: "600" }}>
                        {o.count > 1 ? `${o.count}× ` : ""}{o.label}
                      </Text>
                      {o.description && (
                        <Text style={{ fontSize: 11, color: theme.textSubtle }}>{o.description}</Text>
                      )}
                    </View>
                    <Text style={{ fontSize: 11, color: o.confidence === "high" ? theme.primary : o.confidence === "medium" ? theme.text : theme.textSubtle, fontWeight: "600", textTransform: "uppercase" }}>
                      {o.confidence}
                    </Text>
                  </View>
                ))
              )}
            </View>
          )}
        </>
      )}

      {visionMode === "applevision" && (
        <>
          <View style={[styles.card, { padding: 14, marginBottom: 4 }]}>
            {!visionAvailable ? (
              <Text style={{ fontSize: 13, color: theme.textSubtle }}>Native module not in this build.</Text>
            ) : (
              <>
                <Pressable
                  onPress={runAppleVision}
                  disabled={!cameraOn || visionRunning}
                  style={{ paddingVertical: 10, borderRadius: 8, alignItems: "center", backgroundColor: cameraOn ? theme.primary : theme.surfaceAlt, opacity: visionRunning ? 0.6 : 1 }}
                >
                  <Text style={{ color: cameraOn ? "#fff" : theme.textSubtle, fontSize: 13, fontWeight: "600" }}>
                    {visionRunning ? "Analyzing…" : "Detect faces / text / barcodes"}
                  </Text>
                </Pressable>
                <Text style={{ fontSize: 11, color: theme.textSubtle, marginTop: 6, textAlign: "center" }}>
                  On-device, free. Apple Vision: face rectangles, OCR (any language), QR/UPC/etc.
                </Text>
              </>
            )}
          </View>
          {visionErr && (
            <View style={[styles.card, { padding: 12, marginBottom: 4 }]}>
              <Text style={{ fontSize: 12, color: theme.destructive }}>{visionErr}</Text>
            </View>
          )}
          {visionResult && visionPhotoUri && (
            <View style={[styles.card, { padding: 8, marginBottom: 4 }]}>
              <View style={{ aspectRatio: visionResult.width / visionResult.height, position: "relative", borderRadius: 6, overflow: "hidden" }}>
                <Image source={{ uri: visionPhotoUri }} style={{ width: "100%", height: "100%" }} resizeMode="cover" />
                {visionResult.faces.map((f, i) => (
                  <View key={`f${i}`} style={{
                    position: "absolute",
                    left: `${f.box.x * 100}%`, top: `${f.box.y * 100}%`,
                    width: `${f.box.width * 100}%`, height: `${f.box.height * 100}%`,
                    borderWidth: 2, borderColor: "#ff5566",
                  }} />
                ))}
                {visionResult.textBlocks.map((t, i) => (
                  <View key={`t${i}`} style={{
                    position: "absolute",
                    left: `${t.box.x * 100}%`, top: `${t.box.y * 100}%`,
                    width: `${t.box.width * 100}%`, height: `${t.box.height * 100}%`,
                    borderWidth: 1, borderColor: "#33ddaa",
                  }} />
                ))}
                {visionResult.barcodes.map((b, i) => (
                  <View key={`b${i}`} style={{
                    position: "absolute",
                    left: `${b.box.x * 100}%`, top: `${b.box.y * 100}%`,
                    width: `${b.box.width * 100}%`, height: `${b.box.height * 100}%`,
                    borderWidth: 2, borderColor: "#ffcc33",
                  }} />
                ))}
              </View>
              <Text style={{ fontSize: 11, color: theme.textSubtle, marginTop: 6, textAlign: "right" }}>
                {visionResult.elapsedMs} ms · {visionResult.faces.length} faces (red) · {visionResult.textBlocks.length} text (green) · {visionResult.barcodes.length} barcodes (yellow)
              </Text>
            </View>
          )}
          {visionResult && (visionResult.textBlocks.length > 0 || visionResult.barcodes.length > 0) && (
            <View style={[styles.card, { padding: 12, marginBottom: 16 }]}>
              {visionResult.textBlocks.length > 0 && (
                <>
                  <Text style={{ fontSize: 11, fontWeight: "600", color: theme.textSubtle, textTransform: "uppercase", marginBottom: 4 }}>
                    Recognized text
                  </Text>
                  <Text style={{ fontSize: 13, color: theme.text, marginBottom: 12 }}>
                    {visionResult.textBlocks.map((t) => t.text).join(" ")}
                  </Text>
                </>
              )}
              {visionResult.barcodes.length > 0 && (
                <>
                  <Text style={{ fontSize: 11, fontWeight: "600", color: theme.textSubtle, textTransform: "uppercase", marginBottom: 4 }}>
                    Barcodes
                  </Text>
                  {visionResult.barcodes.map((b, i) => (
                    <Text key={i} style={{ fontSize: 12, color: theme.text, fontVariant: ["tabular-nums"] }}>
                      {b.symbology}: {b.payload}
                    </Text>
                  ))}
                </>
              )}
            </View>
          )}
        </>
      )}

      {visionMode === "yolo" && (
        <>
          <View style={[styles.card, { padding: 14, marginBottom: 4 }]}>
            {!yoloAvailable ? (
              <Text style={{ fontSize: 13, color: theme.textSubtle }}>Native module not in this build.</Text>
            ) : !yoloReady ? (
              <Text style={{ fontSize: 13, color: theme.destructive }}>{yoloLoadErr ?? "Model failed to load"}</Text>
            ) : (
              <>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <Pressable
                    onPress={yoloSnap}
                    disabled={!cameraOn || yoloRunning || yoloLive}
                    style={{ flex: 1, paddingVertical: 10, borderRadius: 8, alignItems: "center", backgroundColor: cameraOn ? theme.primary : theme.surfaceAlt, opacity: yoloRunning ? 0.6 : 1 }}
                  >
                    <Text style={{ color: cameraOn ? "#fff" : theme.textSubtle, fontSize: 13, fontWeight: "600" }}>
                      {yoloRunning ? "Detecting…" : "Snapshot"}
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={yoloLive ? stopYoloLive : startYoloLive}
                    disabled={!cameraOn}
                    style={{ flex: 1, paddingVertical: 10, borderRadius: 8, alignItems: "center", backgroundColor: yoloLive ? theme.destructive : (cameraOn ? theme.surfaceAlt : theme.surfaceAlt), borderWidth: yoloLive ? 0 : StyleSheet.hairlineWidth, borderColor: theme.border }}
                  >
                    <Text style={{ color: yoloLive ? "#fff" : (cameraOn ? theme.primary : theme.textSubtle), fontSize: 13, fontWeight: "600" }}>
                      {yoloLive ? "Stop live" : "Live (~1–2 fps)"}
                    </Text>
                  </Pressable>
                </View>
                <Text style={{ fontSize: 11, color: theme.textSubtle, marginTop: 6, textAlign: "center" }}>
                  YOLO26n on-device. 80 COCO classes (person, bottle, chair, dog, car, laptop…).
                </Text>
              </>
            )}
          </View>
          {yoloErr && (
            <View style={[styles.card, { padding: 12, marginBottom: 4 }]}>
              <Text style={{ fontSize: 12, color: theme.destructive }}>{yoloErr}</Text>
            </View>
          )}
          {/* Frame scrubber — only after live stop, when buffer has >1 frames */}
          {!yoloLive && yoloReviewIdx !== null && yoloFramesRef.current.length > 1 && (
            <View style={[styles.card, { padding: 12, marginBottom: 4 }]}>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                <Text style={{ fontSize: 11, fontWeight: "600", color: theme.textSubtle, textTransform: "uppercase" }}>
                  Reviewing live capture
                </Text>
                <Text style={{ fontSize: 11, color: theme.textSubtle, fontVariant: ["tabular-nums"] }}>
                  frame {yoloReviewIdx + 1} / {yoloFramesRef.current.length}
                </Text>
              </View>
              <View style={{ flexDirection: "row", gap: 6 }}>
                <Pressable
                  onPress={() => reviewYoloFrame(Math.max(0, yoloReviewIdx - 1))}
                  disabled={yoloReviewIdx <= 0}
                  style={{ flex: 1, paddingVertical: 8, borderRadius: 6, alignItems: "center", backgroundColor: theme.surfaceAlt, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.border, opacity: yoloReviewIdx <= 0 ? 0.4 : 1 }}
                >
                  <Text style={{ fontSize: 13, fontWeight: "600", color: theme.text }}>← Prev</Text>
                </Pressable>
                <Pressable
                  onPress={() => reviewYoloFrame(Math.min(yoloFramesRef.current.length - 1, yoloReviewIdx + 1))}
                  disabled={yoloReviewIdx >= yoloFramesRef.current.length - 1}
                  style={{ flex: 1, paddingVertical: 8, borderRadius: 6, alignItems: "center", backgroundColor: theme.surfaceAlt, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.border, opacity: yoloReviewIdx >= yoloFramesRef.current.length - 1 ? 0.4 : 1 }}
                >
                  <Text style={{ fontSize: 13, fontWeight: "600", color: theme.text }}>Next →</Text>
                </Pressable>
              </View>
              {/* Thumbnail strip */}
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 8 }}>
                {yoloFramesRef.current.map((f, i) => (
                  <Pressable
                    key={f.ts}
                    onPress={() => reviewYoloFrame(i)}
                    style={{
                      marginRight: 4,
                      borderWidth: 2,
                      borderColor: i === yoloReviewIdx ? theme.primary : "transparent",
                      borderRadius: 4,
                    }}
                  >
                    <Image source={{ uri: f.uri }} style={{ width: 56, height: 42, borderRadius: 2 }} />
                  </Pressable>
                ))}
              </ScrollView>
            </View>
          )}
          {yoloResult && yoloPhotoUri && (
            <View style={[styles.card, { padding: 8, marginBottom: 4 }]}>
              <View style={{ aspectRatio: yoloResult.width / yoloResult.height, position: "relative", borderRadius: 6, overflow: "hidden" }}>
                <Image source={{ uri: yoloPhotoUri }} style={{ width: "100%", height: "100%" }} resizeMode="cover" fadeDuration={0} />
                {yoloResult.detections.map((d, i) => (
                  <View key={i} style={{
                    position: "absolute",
                    left: `${d.box.x * 100}%`, top: `${d.box.y * 100}%`,
                    width: `${d.box.width * 100}%`, height: `${d.box.height * 100}%`,
                    borderWidth: 2, borderColor: theme.highlight,
                  }}>
                    <View style={{ position: "absolute", top: -16, left: 0, backgroundColor: theme.highlight, paddingHorizontal: 4, paddingVertical: 1 }}>
                      <Text style={{ color: "#fff", fontSize: 9, fontWeight: "700" }}>
                        {d.label} {(d.confidence * 100).toFixed(0)}%
                      </Text>
                    </View>
                  </View>
                ))}
              </View>
              <Text style={{ fontSize: 11, color: theme.textSubtle, marginTop: 6, textAlign: "right" }}>
                {yoloResult.elapsedMs} ms · {yoloResult.detections.length} detection{yoloResult.detections.length === 1 ? "" : "s"}
                {yoloLive ? ` · live (${yoloFramesRef.current.length}/10)` : ""}
              </Text>
            </View>
          )}
          {yoloResult && yoloResult.detections.length > 0 && (
            <View style={[styles.card, { padding: 12, marginBottom: 16 }]}>
              {yoloResult.detections.map((d, i) => (
                <View key={i} style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 3, borderTopWidth: i === 0 ? 0 : StyleSheet.hairlineWidth, borderColor: theme.border }}>
                  <Text style={{ fontSize: 13, color: theme.text, fontWeight: "600" }}>{d.label}</Text>
                  <Text style={{ fontSize: 12, color: theme.textSubtle, fontVariant: ["tabular-nums"] }}>{(d.confidence * 100).toFixed(0)}%</Text>
                </View>
              ))}
            </View>
          )}
        </>
      )}

      {/* LiDAR mode has no per-mode body beyond the top-tile + controls above. */}

      {visionMode === "map" && (
        <>
          <View style={[styles.card, { padding: 14, marginBottom: 4 }]}>
            {!lidarAvailable ? (
              <Text style={{ fontSize: 13, color: theme.textSubtle }}>LiDAR native module not in this build.</Text>
            ) : !lidarSupported ? (
              <Text style={{ fontSize: 13, color: theme.textSubtle }}>No LiDAR sensor on this device.</Text>
            ) : !yoloAvailable || !yoloReady ? (
              <Text style={{ fontSize: 13, color: theme.textSubtle }}>YOLO native module not ready.</Text>
            ) : (
              <>
                <Pressable
                  onPress={lidarOn ? stopLidar : startLidar}
                  style={{ paddingVertical: 10, borderRadius: 8, alignItems: "center", backgroundColor: lidarOn ? theme.destructive : theme.primary, marginBottom: 8 }}
                >
                  <Text style={{ color: "#fff", fontSize: 13, fontWeight: "600" }}>
                    {lidarOn ? "Stop ARSession" : "Start ARSession (camera + depth)"}
                  </Text>
                </Pressable>
                <Pressable
                  onPress={captureAndMap}
                  disabled={!lidarOn || mapBusy}
                  style={{ paddingVertical: 12, borderRadius: 8, alignItems: "center", backgroundColor: lidarOn ? theme.highlight : theme.surfaceAlt, opacity: mapBusy ? 0.6 : 1 }}
                >
                  <Text style={{ color: lidarOn ? "#fff" : theme.textSubtle, fontSize: 14, fontWeight: "700" }}>
                    {mapBusy ? "Capturing + analyzing…" : "Capture & map objects"}
                  </Text>
                </Pressable>
                <Text style={{ fontSize: 11, color: theme.textSubtle, marginTop: 6, textAlign: "center" }}>
                  Grabs one ARKit frame (camera + depth, time-synced). Runs YOLO, samples depth at each box center.
                </Text>
              </>
            )}
          </View>
          {mapErr && (
            <View style={[styles.card, { padding: 12, marginBottom: 4 }]}>
              <Text style={{ fontSize: 12, color: theme.destructive }}>{mapErr}</Text>
            </View>
          )}

          {mapShownIdx !== null && mapCaptures[mapShownIdx] && (() => {
            const cap = mapCaptures[mapShownIdx]!;
            return (
              <>
                <View style={[styles.card, { padding: 8, marginBottom: 4 }]}>
                  <View style={{ aspectRatio: cap.imageWidth / cap.imageHeight, position: "relative", borderRadius: 6, overflow: "hidden" }}>
                    <Image source={{ uri: cap.imageUri }} style={{ width: "100%", height: "100%" }} resizeMode="cover" fadeDuration={0} />
                    {cap.objects.map((o, i) => (
                      <View key={i} style={{
                        position: "absolute",
                        left: `${o.box.x * 100}%`, top: `${o.box.y * 100}%`,
                        width: `${o.box.width * 100}%`, height: `${o.box.height * 100}%`,
                        borderWidth: 2, borderColor: theme.highlight,
                      }}>
                        <View style={{ position: "absolute", top: -16, left: 0, backgroundColor: theme.highlight, paddingHorizontal: 4, paddingVertical: 1 }}>
                          <Text style={{ color: "#fff", fontSize: 9, fontWeight: "700" }}>
                            {o.label} {o.distance != null ? `· ${o.distance.toFixed(2)}m` : ""}
                          </Text>
                        </View>
                      </View>
                    ))}
                  </View>
                </View>

                <View style={[styles.card, { padding: 12, marginBottom: 4 }]}>
                  <Text style={{ fontSize: 11, fontWeight: "600", color: theme.textSubtle, textTransform: "uppercase", marginBottom: 6 }}>
                    Phone state at capture
                  </Text>
                  <View style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 2 }}>
                    <Text style={{ fontSize: 12, color: theme.textSubtle }}>Pitch / Yaw / Roll</Text>
                    <Text style={{ fontSize: 12, color: theme.text, fontVariant: ["tabular-nums"] }}>
                      {((cap.eulerAngles.pitch * 180) / Math.PI).toFixed(1)}° / {((cap.eulerAngles.yaw * 180) / Math.PI).toFixed(1)}° / {((cap.eulerAngles.roll * 180) / Math.PI).toFixed(1)}°
                    </Text>
                  </View>
                  <View style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 2 }}>
                    <Text style={{ fontSize: 12, color: theme.textSubtle }}>Relative altitude</Text>
                    <Text style={{ fontSize: 12, color: theme.text, fontVariant: ["tabular-nums"] }}>
                      {cap.relativeAltitudeMeters != null ? `${cap.relativeAltitudeMeters.toFixed(2)} m` : "—"}
                    </Text>
                  </View>
                  <View style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 2 }}>
                    <Text style={{ fontSize: 12, color: theme.textSubtle }}>Timestamp</Text>
                    <Text style={{ fontSize: 12, color: theme.text, fontVariant: ["tabular-nums"] }}>
                      {new Date(cap.timestamp).toLocaleTimeString()}
                    </Text>
                  </View>
                </View>

                {cap.objects.length > 0 && (
                  <View style={[styles.card, { padding: 12, marginBottom: 16 }]}>
                    <Text style={{ fontSize: 11, fontWeight: "600", color: theme.textSubtle, textTransform: "uppercase", marginBottom: 6 }}>
                      Mapped objects ({cap.objects.length})
                    </Text>
                    {cap.objects.map((o, i) => (
                      <View key={i} style={{ paddingVertical: 6, borderTopWidth: i === 0 ? 0 : StyleSheet.hairlineWidth, borderColor: theme.border }}>
                        <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                          <Text style={{ fontSize: 13, color: theme.text, fontWeight: "600" }}>{o.label}</Text>
                          <Text style={{ fontSize: 12, color: theme.textSubtle, fontVariant: ["tabular-nums"] }}>
                            {(o.confidence * 100).toFixed(0)}%
                          </Text>
                        </View>
                        <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 2 }}>
                          <Text style={{ fontSize: 11, color: theme.textSubtle }}>
                            distance · h° · v°
                          </Text>
                          <Text style={{ fontSize: 11, color: theme.text, fontVariant: ["tabular-nums"] }}>
                            {o.distance != null ? `${o.distance.toFixed(2)} m` : "—"} · {((o.horizontalAngle * 180) / Math.PI).toFixed(1)}° · {((o.verticalAngle * 180) / Math.PI).toFixed(1)}°
                          </Text>
                        </View>
                      </View>
                    ))}
                  </View>
                )}

                {mapCaptures.length > 1 && (
                  <View style={[styles.card, { padding: 12, marginBottom: 16 }]}>
                    <Text style={{ fontSize: 11, fontWeight: "600", color: theme.textSubtle, textTransform: "uppercase", marginBottom: 6 }}>
                      Recent captures ({mapShownIdx + 1} / {mapCaptures.length})
                    </Text>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                      {mapCaptures.map((c, i) => (
                        <Pressable
                          key={c.id}
                          onPress={() => setMapShownIdx(i)}
                          style={{
                            marginRight: 4,
                            borderWidth: 2,
                            borderColor: i === mapShownIdx ? theme.primary : "transparent",
                            borderRadius: 4,
                          }}
                        >
                          <Image source={{ uri: c.imageUri }} style={{ width: 56, height: 42, borderRadius: 2 }} />
                          <Text style={{ fontSize: 9, color: theme.textSubtle, marginTop: 2, textAlign: "center" }}>
                            {c.objects.length}
                          </Text>
                        </Pressable>
                      ))}
                    </ScrollView>
                  </View>
                )}
              </>
            );
          })()}
        </>
      )}

      {visionMode === "balls" && (
        <>

          {/* Dev panel: tunables + telemetry */}
          <View style={[cardStyle, { padding: 10, marginBottom: 4 }]}>
            <Pressable
              onPress={() => setDevOpen((v) => !v)}
              style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}
            >
              <Text style={{ fontSize: 11, fontWeight: "600", color: theme.textSubtle, textTransform: "uppercase" }}>
                Dev panel
              </Text>
              <Text style={{ fontSize: 11, color: theme.textSubtle }}>{devOpen ? "Hide ▾" : "Show ▸"}</Text>
            </Pressable>
            {devOpen && (
              <View style={{ marginTop: 8 }}>
                {/* Detection */}
                <DevSection label="Detection" theme={theme} styles={styles}>
                  <Stepper label="YOLO min conf" value={tunables.yoloMinConf} step={0.01} min={0.01} max={0.50} decimals={2}
                    onChange={(v) => setTunables((p) => ({ ...p, yoloMinConf: v }))} theme={theme} />
                  <Stepper label="Capture JPEG quality" value={tunables.captureQuality} step={0.05} min={0.3} max={1.0} decimals={2}
                    onChange={(v) => setTunables((p) => ({ ...p, captureQuality: v }))} theme={theme} />
                </DevSection>

                <DevSection label="Distance tiers" theme={theme} styles={styles}>
                  <Stepper label="Tier max (m)" value={tunables.tierMax} step={0.5} min={2} max={15} decimals={1}
                    onChange={(v) => setTunables((p) => ({ ...p, tierMax: v }))} theme={theme} />
                  <Stepper label="Tier 1 ≤ (m)" value={tunables.tier1Dist} step={0.25} min={0.5} max={5} decimals={2}
                    onChange={(v) => setTunables((p) => ({ ...p, tier1Dist: v }))} theme={theme} />
                  <Stepper label="Tier 1 min conf" value={tunables.tier1Conf} step={0.02} min={0.05} max={0.80} decimals={2}
                    onChange={(v) => setTunables((p) => ({ ...p, tier1Conf: v }))} theme={theme} />
                  <Stepper label="Tier 2 ≤ (m)" value={tunables.tier2Dist} step={0.25} min={1} max={8} decimals={2}
                    onChange={(v) => setTunables((p) => ({ ...p, tier2Dist: v }))} theme={theme} />
                  <Stepper label="Tier 2 min conf" value={tunables.tier2Conf} step={0.02} min={0.05} max={0.80} decimals={2}
                    onChange={(v) => setTunables((p) => ({ ...p, tier2Conf: v }))} theme={theme} />
                  <Stepper label="Tier 3 ≤ (m)" value={tunables.tier3Dist} step={0.25} min={2} max={10} decimals={2}
                    onChange={(v) => setTunables((p) => ({ ...p, tier3Dist: v }))} theme={theme} />
                  <Stepper label="Tier 3 min conf" value={tunables.tier3Conf} step={0.02} min={0.05} max={0.80} decimals={2}
                    onChange={(v) => setTunables((p) => ({ ...p, tier3Conf: v }))} theme={theme} />
                  <Stepper label="Tier 4 ≤ (m)" value={tunables.tier4Dist} step={0.25} min={3} max={15} decimals={2}
                    onChange={(v) => setTunables((p) => ({ ...p, tier4Dist: v }))} theme={theme} />
                  <Stepper label="Tier 4 min conf" value={tunables.tier4Conf} step={0.02} min={0.05} max={0.80} decimals={2}
                    onChange={(v) => setTunables((p) => ({ ...p, tier4Conf: v }))} theme={theme} />
                </DevSection>

                <DevSection label="Dedup (per state)" theme={theme} styles={styles}>
                  <Stepper label="Confirmed (m)" value={tunables.dedupConfirmedM} step={0.01} min={0.02} max={0.5} decimals={2}
                    onChange={(v) => setTunables((p) => ({ ...p, dedupConfirmedM: v }))} theme={theme} />
                  <Stepper label="Probable (m)" value={tunables.dedupProbableM} step={0.01} min={0.02} max={0.5} decimals={2}
                    onChange={(v) => setTunables((p) => ({ ...p, dedupProbableM: v }))} theme={theme} />
                  <Stepper label="Candidate (m)" value={tunables.dedupCandidateM} step={0.01} min={0.02} max={0.5} decimals={2}
                    onChange={(v) => setTunables((p) => ({ ...p, dedupCandidateM: v }))} theme={theme} />
                </DevSection>

                <DevSection label="Promotion" theme={theme} styles={styles}>
                  <Stepper label="Probable sightings" value={tunables.probableSightings} step={1} min={1} max={10} decimals={0}
                    onChange={(v) => setTunables((p) => ({ ...p, probableSightings: v }))} theme={theme} />
                  <Stepper label="Probable min conf" value={tunables.probableConf} step={0.02} min={0.05} max={0.80} decimals={2}
                    onChange={(v) => setTunables((p) => ({ ...p, probableConf: v }))} theme={theme} />
                  <Stepper label="Confirmed sightings" value={tunables.confirmedSightings} step={1} min={1} max={10} decimals={0}
                    onChange={(v) => setTunables((p) => ({ ...p, confirmedSightings: v }))} theme={theme} />
                  <Stepper label="Confirmed min conf" value={tunables.confirmedConf} step={0.02} min={0.05} max={0.80} decimals={2}
                    onChange={(v) => setTunables((p) => ({ ...p, confirmedConf: v }))} theme={theme} />
                  <Stepper label="Immediate confirm ≤ (m)" value={tunables.immediateConfirmRange} step={0.25} min={0.5} max={5} decimals={2}
                    onChange={(v) => setTunables((p) => ({ ...p, immediateConfirmRange: v }))} theme={theme} />
                  <Stepper label="Immediate confirm conf" value={tunables.immediateConfirmConf} step={0.02} min={0.05} max={0.80} decimals={2}
                    onChange={(v) => setTunables((p) => ({ ...p, immediateConfirmConf: v }))} theme={theme} />
                </DevSection>

                <DevSection label="Revalidation (delete)" theme={theme} styles={styles}>
                  <Stepper label="Screen tolerance" value={tunables.revalidateScreenTolerance} step={0.01} min={0.02} max={0.30} decimals={2}
                    onChange={(v) => setTunables((p) => ({ ...p, revalidateScreenTolerance: v }))} theme={theme} />
                  <Text style={{ fontSize: 10, color: theme.textSubtle, marginTop: 6, marginBottom: 2 }}>
                    Time-based revalidation: remove if on screen but unseen for this long.
                  </Text>
                  {(["confirmed", "probable", "candidate"] as const).map((st) => (
                    <Stepper
                      key={st}
                      label={`${st} timeout (ms)`}
                      value={tunables.revalTimeoutMs[st]}
                      step={500}
                      min={500}
                      max={10000}
                      decimals={0}
                      onChange={(v) => setTunables((p) => ({
                        ...p,
                        revalTimeoutMs: { ...p.revalTimeoutMs, [st]: v },
                      }))}
                      theme={theme}
                    />
                  ))}
                </DevSection>

                <Pressable
                  onPress={() => setTunables(DEFAULT_TUNABLES)}
                  style={{ marginTop: 8, paddingVertical: 8, borderRadius: 6, alignItems: "center", backgroundColor: theme.surfaceAlt, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.border }}
                >
                  <Text style={{ fontSize: 12, color: theme.text, fontWeight: "600" }}>Reset to defaults</Text>
                </Pressable>
              </View>
            )}
          </View>

          {/* Telemetry: what just happened on the last capture */}
          {telemetry && (
            <View style={[cardStyle, { padding: 10, marginBottom: 4 }]}>
              <Text style={{ fontSize: 11, fontWeight: "600", color: theme.textSubtle, textTransform: "uppercase", marginBottom: 4 }}>
                Last capture — {telemetry.rawDetectionCount} raw · {telemetry.sportsBallCount} sports ball
              </Text>
              {telemetry.perDetection.length === 0 ? (
                <Text style={{ fontSize: 11, color: theme.textSubtle }}>(no sports-ball detections)</Text>
              ) : (
                telemetry.perDetection.map((dr, i) => (
                  <View key={i} style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 2 }}>
                    <Text style={{ fontSize: 11, color: theme.textSubtle, fontVariant: ["tabular-nums"] }}>
                      conf {dr.confidence.toFixed(2)}
                      {dr.distance != null ? ` · ${dr.distance.toFixed(2)} m` : ""}
                    </Text>
                    <Text style={{ fontSize: 11, color: dr.ballNumber != null ? theme.text : theme.textSubtle, flex: 1, textAlign: "right" }} numberOfLines={1}>
                      {dr.decision}
                    </Text>
                  </View>
                ))
              )}
              {telemetry.rawDetections.length > 0 && (
                <>
                  <Text style={{ fontSize: 10, fontWeight: "600", color: theme.textSubtle, textTransform: "uppercase", marginTop: 8, marginBottom: 4 }}>
                    Raw YOLO labels ({telemetry.rawDetections.length})
                  </Text>
                  {telemetry.rawDetections
                    .slice()
                    .sort((a, b) => b.confidence - a.confidence)
                    .map((rd, i) => (
                      <View key={i} style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 1 }}>
                        <Text
                          style={{ fontSize: 11, color: rd.label === "sports ball" ? theme.primary : theme.text, flex: 1 }}
                          numberOfLines={1}
                        >
                          {rd.label}
                        </Text>
                        <Text style={{ fontSize: 11, color: theme.textSubtle, fontVariant: ["tabular-nums"] }}>
                          {(rd.confidence * 100).toFixed(0)}%
                        </Text>
                      </View>
                    ))}
                </>
              )}
              {telemetry.revalidation.length > 0 && (
                <>
                  <Text style={{ fontSize: 10, fontWeight: "600", color: theme.textSubtle, textTransform: "uppercase", marginTop: 8, marginBottom: 4 }}>
                    Revalidation
                  </Text>
                  {telemetry.revalidation.map((rr, i) => {
                    const color = rr.outcome === "deleted" ? theme.destructive : (rr.outcome === "miss" ? theme.highlight : theme.textSubtle);
                    const counter = rr.outcome === "miss" || rr.outcome === "deleted"
                      ? ` (${rr.missCount}/${rr.missLimit === Infinity ? "∞" : rr.missLimit})`
                      : "";
                    return (
                      <View key={i} style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 1 }}>
                        <Text style={{ fontSize: 11, color: theme.text, fontVariant: ["tabular-nums"] }}>
                          #{rr.ballNumber} · {rr.state} @ {rr.distance.toFixed(2)} m ({rr.bucket})
                        </Text>
                        <Text style={{ fontSize: 11, color, fontVariant: ["tabular-nums"] }}>
                          {rr.outcome}{counter}
                        </Text>
                      </View>
                    );
                  })}
                </>
              )}
            </View>
          )}

          {ballsErr && (
            <View style={[cardStyle, { padding: 12, marginBottom: 4 }]}>
              <Text style={{ fontSize: 12, color: theme.destructive }}>{ballsErr}</Text>
            </View>
          )}

          {ballsLastImage && (
            <View style={[cardStyle, { padding: 8, marginBottom: 4 }]}>
              <View style={{ aspectRatio: ballsLastImage.width / ballsLastImage.height, position: "relative", borderRadius: 6, overflow: "hidden" }}>
                <Image source={{ uri: ballsLastImage.uri }} style={{ width: "100%", height: "100%" }} resizeMode="cover" fadeDuration={0} />
                {ballsLastImage.boxes.map((b, i) => {
                  return (
                    <View key={i} style={{
                      position: "absolute",
                      left: `${b.x * 100}%`, top: `${b.y * 100}%`,
                      width: `${b.width * 100}%`, height: `${b.height * 100}%`,
                      borderWidth: 2, borderColor: theme.highlight,
                    }}>
                      <View style={{ position: "absolute", top: -16, left: 0, backgroundColor: theme.highlight, paddingHorizontal: 4, paddingVertical: 1 }}>
                        <Text style={{ color: "#fff", fontSize: 9, fontWeight: "700" }}>#{b.number}</Text>
                      </View>
                    </View>
                  );
                })}
              </View>
              <Text style={{ fontSize: 11, color: theme.textSubtle, marginTop: 6, textAlign: "right" }}>
                {ballsLastImage.boxes.length} ball{ballsLastImage.boxes.length === 1 ? "" : "s"} in last capture · {balls.length} tracked total
              </Text>
            </View>
          )}

          {balls.length > 0 && (
            <View style={[cardStyle, { padding: 12, marginBottom: 16 }]}>
              <Text style={{ fontSize: 11, fontWeight: "600", color: theme.textSubtle, textTransform: "uppercase", marginBottom: 6 }}>
                Tracked balls ({balls.length})
              </Text>
              {balls.map((b, i) => {
                const rel = ballRelative(b, ballsCameraPose);
                const badgeColor =
                  b.status === "confirmed" ? "#ff00ff" :
                  b.status === "probable" ? "#00b8d4" :
                  "#d4a000";
                return (
                  <View key={b.id} style={{ paddingVertical: 8, borderTopWidth: i === 0 ? 0 : StyleSheet.hairlineWidth, borderColor: theme.border }}>
                    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                        <Text style={{ fontSize: 14, color: theme.text, fontWeight: "700" }}>#{b.number}</Text>
                        <View style={{
                          paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4,
                          backgroundColor: badgeColor,
                        }}>
                          <Text style={{ fontSize: 9, fontWeight: "700", color: "#fff", textTransform: "uppercase" }}>
                            {b.status}
                          </Text>
                        </View>
                      </View>
                      <Text style={{ fontSize: 11, color: theme.textSubtle, fontVariant: ["tabular-nums"] }}>
                        seen {b.sightings}× · conf {(b.lastConfidence * 100).toFixed(0)}%
                      </Text>
                    </View>
                    <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 4 }}>
                      <Text style={{ fontSize: 11, color: theme.textSubtle }}>World (x, y, z)</Text>
                      <Text style={{ fontSize: 11, color: theme.text, fontVariant: ["tabular-nums"] }}>
                        {b.worldX.toFixed(2)}, {b.worldY.toFixed(2)}, {b.worldZ.toFixed(2)}
                      </Text>
                    </View>
                    {rel && (
                      <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 2 }}>
                        <Text style={{ fontSize: 11, color: theme.textSubtle }}>From phone</Text>
                        <Text style={{ fontSize: 11, color: theme.text, fontVariant: ["tabular-nums"] }}>
                          {rel.distance.toFixed(2)} m · {((rel.horizontalAngleRad * 180) / Math.PI).toFixed(0)}° h · {((rel.verticalAngleRad * 180) / Math.PI).toFixed(0)}° v
                        </Text>
                      </View>
                    )}
                    <View style={{ flexDirection: "row", gap: 6, marginTop: 8 }}>
                      <Pressable
                        onPress={() => rejectBall(b.id)}
                        style={{ flex: 1, paddingVertical: 6, borderRadius: 6, alignItems: "center", backgroundColor: theme.destructive }}
                      >
                        <Text style={{ fontSize: 11, color: "#fff", fontWeight: "600" }}>Reject</Text>
                      </Pressable>
                    </View>
                  </View>
                );
              })}
            </View>
          )}
        </>
      )}

      {visionMode === "field" && (
        <FieldTab arRef={arRef} theme={theme} styles={styles} cardStyle={cardStyle} arViewAvailable={arViewAvailable} arEditMode={arEditMode} setArEditMode={setArEditMode} />
      )}

    </>
  );
}

// ─── Field Registration Tab ───────────────────────────────────────────────────

function FieldTab({ arRef, theme, styles, cardStyle, arViewAvailable, arEditMode, setArEditMode }: {
  arRef: React.RefObject<LidarARViewRef | null>;
  theme: Theme;
  styles: ReturnType<typeof makeStyles>;
  cardStyle: { backgroundColor: string; borderRadius: number; overflow: "hidden" };
  arViewAvailable: boolean;
  arEditMode: boolean;
  setArEditMode: (v: boolean) => void;
}) {
  const { fields, addField, removeField, activeFieldId, setActiveField } = useFields();
  const [placedLandmarks, setPlacedLandmarks] = useState<FieldLandmarkAnchor[]>([]);
  const placedRef = useRef<FieldLandmarkAnchor[]>([]);
  useEffect(() => { placedRef.current = placedLandmarks; }, [placedLandmarks]);
  const [fieldType, setFieldType] = useState("regulation");
  const [fieldActive, setFieldActive] = useState(false);  // crosshairs visible
  const [nearestLandmark, setNearestLandmark] = useState<{ id: string; kind: string; dist: number } | null>(null);
  const [showItemPicker, setShowItemPicker] = useState(false);
  const [isMoving, setIsMoving] = useState(false);  // tap-and-hold move active
  const isMovingRef = useRef(false);
  const [frameResult, setFrameResult] = useState<string | null>(null);

  const LANDMARK_LABELS: Record<string, string> = {
    home_plate: "HP", first_base: "1B", second_base: "2B", third_base: "3B", rubber: "R",
    foul_pole_right: "RF Pole", foul_pole_left: "LF Pole",
  };
  // Kinds shown in the "Add Item" picker (user-placeable)
  const PLACEABLE_KINDS: FieldLandmarkKind[] = ["home_plate", "first_base", "second_base", "third_base", "rubber", "foul_pole_right", "foul_pole_left"];
  // Kinds shown in the landmarks list
  const LISTED_KINDS = new Set(["home_plate", "first_base", "second_base", "third_base", "rubber", "foul_pole_right", "foul_pole_left"]);

  // ─── Crosshairs polling: raycast screen center every 200ms ─────────
  useEffect(() => {
    if (!fieldActive || !arRef.current) return;
    let cancelled = false;
    const poll = async () => {
      if (cancelled || !arRef.current) return;
      // Raycast screen center (0.5, 0.5)
      const hit = await arRef.current.raycastScreenPoint(0.5, 0.5).catch(() => null);
      if (cancelled) return;
      if (!hit) { setNearestLandmark(null); return; }
      // Find nearest placed landmark within 0.5m
      let nearest: { id: string; kind: string; dist: number } | null = null;
      for (const l of placedRef.current) {
        if (!LISTED_KINDS.has(l.kind)) continue;
        const dx = l.worldX - hit.worldX;
        const dz = l.worldZ - hit.worldZ;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d < 0.5 && (!nearest || d < nearest.dist)) {
          nearest = { id: l.id, kind: l.kind, dist: d };
        }
      }
      setNearestLandmark(nearest);
    };
    const interval = setInterval(poll, 200);
    poll();
    return () => { cancelled = true; clearInterval(interval); };
  }, [fieldActive]);

  // ─── Tap-and-hold move: while held, item follows crosshairs ────────
  useEffect(() => {
    if (!isMoving || !nearestLandmark || !arRef.current) return;
    isMovingRef.current = true;
    let cancelled = false;
    const moveLoop = async () => {
      while (isMovingRef.current && !cancelled) {
        const hit = await arRef.current?.raycastScreenPoint(0.5, 0.5).catch(() => null);
        if (cancelled || !hit || !arRef.current) break;
        const current = placedRef.current.find((l) => l.kind === nearestLandmark.kind);
        if (!current) break;
        // Remove old + place at new world position
        await arRef.current.removeFieldLandmark(current.id);
        const newAnchor = await arRef.current.addFieldLandmarkAtWorld(hit.worldX, hit.worldY, hit.worldZ, current.kind);
        const updated = placedRef.current.map((l) => l.kind === current.kind ? newAnchor : l);

        // If moving HP or a base, recompute the rest of the field
        if (current.kind === "home_plate") {
          await recomputeAllFromHP(hit, updated);
        } else if (["first_base", "second_base", "third_base"].includes(current.kind)) {
          await recomputeFromBase(hit, current.kind as "first_base" | "second_base" | "third_base", updated);
        } else {
          setPlacedLandmarks(updated);
        }

        await new Promise<void>((r) => setTimeout(r, 100));
      }
    };
    moveLoop();
    return () => { cancelled = true; };
  }, [isMoving]);

  // ─── Place entire field at crosshairs ──────────────────────────────
  const placeAtCrosshairs = async (kind: FieldLandmarkKind) => {
    if (!arRef.current) return;
    const hit = await arRef.current.raycastScreenPoint(0.5, 0.5);
    if (!hit) { Alert.alert("No surface", "Point at the ground and try again."); return; }

    if (kind === "home_plate") {
      // Clear and place entire field
      await arRef.current.clearFieldLandmarks();
      const camT = await arRef.current.currentCameraTransform();
      if (!camT || camT.length < 16) return;
      const fwdX = -camT[8]!;
      const fwdZ = -camT[10]!;
      const positions = computeLandmarkPositions(hit.worldX, hit.worldY, hit.worldZ, fwdX, fwdZ, fieldType);
      const placed: FieldLandmarkAnchor[] = [];
      for (const pos of positions) {
        const anchor = await arRef.current.addFieldLandmarkAtWorld(pos.x, pos.y, pos.z, pos.kind as FieldLandmarkKind);
        placed.push(anchor);
      }
      setPlacedLandmarks(placed);
    } else {
      // Place single item
      const old = placedLandmarks.find((l) => l.kind === kind);
      if (old) await arRef.current.removeFieldLandmark(old.id);
      const anchor = await arRef.current.addFieldLandmarkAtWorld(hit.worldX, hit.worldY, hit.worldZ, kind);
      setPlacedLandmarks((prev) => [...prev.filter((l) => l.kind !== kind), anchor]);
    }
    setShowItemPicker(false);
  };

  // ─── Recompute when HP moves: translate everything ─────────────────
  const recomputeAllFromHP = async (newHP: { worldX: number; worldY: number; worldZ: number }, current: FieldLandmarkAnchor[]) => {
    if (!arRef.current) return;
    const oldHP = current.find((l) => l.kind === "home_plate");
    if (!oldHP) return;
    const dx = newHP.worldX - oldHP.worldX;
    const dz = newHP.worldZ - oldHP.worldZ;
    // Translate all non-foul-pole landmarks by the delta
    const updated: FieldLandmarkAnchor[] = [];
    for (const l of current) {
      if (l.kind === "home_plate") { updated.push({ ...l, worldX: newHP.worldX, worldY: newHP.worldY, worldZ: newHP.worldZ }); continue; }
      if (l.kind === "foul_pole_right" || l.kind === "foul_pole_left") {
        // Foul poles move with the field
      }
      const newX = l.worldX + dx;
      const newZ = l.worldZ + dz;
      await arRef.current.removeFieldLandmark(l.id);
      const anchor = await arRef.current.addFieldLandmarkAtWorld(newX, l.worldY, newZ, l.kind);
      updated.push(anchor);
    }
    setPlacedLandmarks(updated);
  };

  // ─── Recompute when a base moves: scale + rotate ───────────────────
  const recomputeFromBase = async (
    newBasePos: { worldX: number; worldY: number; worldZ: number },
    baseKind: "first_base" | "second_base" | "third_base",
    current: FieldLandmarkAnchor[]
  ) => {
    if (!arRef.current) return;
    const hp = current.find((l) => l.kind === "home_plate");
    if (!hp) { setPlacedLandmarks(current); return; }

    const hpPos = { x: hp.worldX, y: hp.worldY, z: hp.worldZ };
    const basePos = { x: newBasePos.worldX, y: newBasePos.worldY, z: newBasePos.worldZ };
    const positions = recomputeFieldFromBase(hpPos, basePos, baseKind, fieldType);

    // Clear all and re-place
    await arRef.current.clearFieldLandmarks();
    const placed: FieldLandmarkAnchor[] = [];
    for (const pos of positions) {
      const anchor = await arRef.current.addFieldLandmarkAtWorld(pos.x, pos.y, pos.z, pos.kind as FieldLandmarkKind);
      placed.push(anchor);
    }
    setPlacedLandmarks(placed);
  };

  const clearAll = async () => {
    if (!arRef.current) return;
    await arRef.current.clearFieldLandmarks();
    setPlacedLandmarks([]);
    setFieldActive(false);
    setNearestLandmark(null);
  };

  const FRAME_KINDS = new Set(["home_plate", "first_base", "second_base", "third_base", "rubber"]);
  const registerField = () => {
    const lm: LandmarkPositions = {};
    for (const l of placedLandmarks) {
      if (FRAME_KINDS.has(l.kind)) {
        (lm as Record<string, { x: number; y: number; z: number }>)[l.kind] = { x: l.worldX, y: l.worldY, z: l.worldZ };
      }
    }
    const frame = computeFieldFrame(lm);
    if (!frame) { Alert.alert("Need landmarks", "Place at least home plate and one base."); return; }
    const boundary = generateDirtBoundary(fieldType);
    const reg: FieldRegistration = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: `Field ${fields.length + 1}`,
      fieldType,
      createdAt: Date.now(),
      landmarks: lm,
      coordinateFrame: frame,
      boundaryPolygon: boundary,
    };
    addField(reg);
    setActiveField(reg.id);
    Alert.alert("Registered", `"${reg.name}" saved.`);
  };

  const hasLandmarks = placedLandmarks.length > 0;
  const listedLandmarks = placedLandmarks.filter((l) => LISTED_KINDS.has(l.kind));
  const remainingKinds = PLACEABLE_KINDS.filter((k) => !placedLandmarks.some((l) => l.kind === k));

  if (!arViewAvailable) {
    return (
      <View style={[cardStyle, { padding: 14 }]}>
        <Text style={{ fontSize: 13, color: theme.textSubtle }}>AR view not in this build.</Text>
      </View>
    );
  }

  return (
    <>
      {/* Crosshairs overlay */}
      {fieldActive && (
        <View pointerEvents="none" style={{
          position: "absolute", top: 0, left: 0, right: 0, aspectRatio: 9 / 16,
          zIndex: 5, justifyContent: "center", alignItems: "center",
        }}>
          <View style={{ position: "absolute", width: 40, height: 2, backgroundColor: "rgba(255,255,255,0.7)", borderRadius: 1 }} />
          <View style={{ position: "absolute", width: 2, height: 40, backgroundColor: "rgba(255,255,255,0.7)", borderRadius: 1 }} />
          {nearestLandmark && (
            <Text style={{
              position: "absolute", top: "50%", marginTop: 28, fontSize: 13,
              color: "#fff", fontWeight: "600", textShadowColor: "rgba(0,0,0,0.8)",
              textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 3,
            }}>
              {LANDMARK_LABELS[nearestLandmark.kind] ?? nearestLandmark.kind} ({nearestLandmark.dist.toFixed(1)}m)
            </Text>
          )}
          {isMoving && (
            <Text style={{
              position: "absolute", top: "50%", marginTop: -40, fontSize: 12,
              color: "#fff", fontWeight: "600", textShadowColor: "rgba(0,0,0,0.8)",
              textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 3,
            }}>
              Moving... release button to stop
            </Text>
          )}
        </View>
      )}

      {/* Controls */}
      <View style={[cardStyle, { padding: 14, marginBottom: 4 }]}>
        {/* Field type selector */}
        <Text style={{ fontSize: 12, fontWeight: "600", color: theme.textMuted, marginBottom: 8 }}>Field Type</Text>
        <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
          {Object.entries(FIELD_TEMPLATES).map(([key, t]) => (
            <Pressable
              key={key}
              onPress={() => setFieldType(key)}
              style={{
                paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6,
                backgroundColor: fieldType === key ? theme.primary : theme.surfaceAlt,
                borderWidth: 1, borderColor: fieldType === key ? theme.primary : theme.border,
              }}
            >
              <Text style={{ fontSize: 12, color: fieldType === key ? "#fff" : theme.text }}>{t.name}</Text>
            </Pressable>
          ))}
        </View>

        {/* Main action button */}
        {!fieldActive ? (
          <Pressable
            onPress={() => { setFieldActive(true); setArEditMode(true); }}
            style={{ paddingVertical: 10, borderRadius: 8, backgroundColor: theme.primary, alignItems: "center" }}
          >
            <Text style={{ fontSize: 14, fontWeight: "600", color: "#fff" }}>Place Field</Text>
          </Pressable>
        ) : nearestLandmark ? (
          <View style={{ gap: 8 }}>
            <Pressable
              onPressIn={() => setIsMoving(true)}
              onPressOut={() => { setIsMoving(false); isMovingRef.current = false; }}
              style={{ paddingVertical: 12, borderRadius: 8, backgroundColor: theme.accent, alignItems: "center" }}
            >
              <Text style={{ fontSize: 14, fontWeight: "600", color: theme.text }}>
                Hold to Move {LANDMARK_LABELS[nearestLandmark.kind] ?? nearestLandmark.kind}
              </Text>
            </Pressable>
          </View>
        ) : (
          <Pressable
            onPress={() => setShowItemPicker(true)}
            style={{ paddingVertical: 10, borderRadius: 8, backgroundColor: theme.primary, alignItems: "center" }}
          >
            <Text style={{ fontSize: 14, fontWeight: "600", color: "#fff" }}>Add Item</Text>
          </Pressable>
        )}

        {/* Done / Clear row */}
        {fieldActive && (
          <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
            <Pressable
              onPress={() => { setFieldActive(false); setArEditMode(false); }}
              style={{ flex: 1, paddingVertical: 8, borderRadius: 8, backgroundColor: theme.surfaceAlt, alignItems: "center", borderWidth: 1, borderColor: theme.border }}
            >
              <Text style={{ fontSize: 13, fontWeight: "600", color: theme.text }}>Done</Text>
            </Pressable>
            {hasLandmarks && (
              <Pressable
                onPress={clearAll}
                style={{ paddingVertical: 8, paddingHorizontal: 16, borderRadius: 8, backgroundColor: theme.destructive, alignItems: "center" }}
              >
                <Text style={{ fontSize: 13, fontWeight: "600", color: "#fff" }}>Clear</Text>
              </Pressable>
            )}
          </View>
        )}
      </View>

      {/* Item picker modal */}
      {showItemPicker && (
        <View style={[cardStyle, { padding: 14, marginBottom: 4 }]}>
          <Text style={{ fontSize: 12, fontWeight: "600", color: theme.textMuted, marginBottom: 8 }}>Add Item at Crosshairs</Text>
          <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
            {(remainingKinds.length > 0 ? remainingKinds : PLACEABLE_KINDS).map((kind) => (
              <Pressable
                key={kind}
                onPress={() => placeAtCrosshairs(kind)}
                style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, backgroundColor: theme.surfaceAlt, borderWidth: 1, borderColor: theme.border }}
              >
                <Text style={{ fontSize: 13, fontWeight: "600", color: theme.text }}>{LANDMARK_LABELS[kind] ?? kind}</Text>
              </Pressable>
            ))}
          </View>
          <Pressable onPress={() => setShowItemPicker(false)} style={{ marginTop: 8, alignItems: "center" }}>
            <Text style={{ fontSize: 12, color: theme.textMuted }}>Cancel</Text>
          </Pressable>
        </View>
      )}

      {/* Placed landmarks list */}
      {listedLandmarks.length > 0 && (
        <View style={[cardStyle, { padding: 14, marginBottom: 4 }]}>
          <Text style={{ fontSize: 12, fontWeight: "600", color: theme.textMuted, marginBottom: 6 }}>Landmarks</Text>
          {listedLandmarks.map((l) => (
            <View key={l.id} style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 4 }}>
              <Text style={{ fontSize: 13, color: theme.text, fontWeight: "600" }}>
                {LANDMARK_LABELS[l.kind] ?? l.kind}
              </Text>
              <Text style={{ fontSize: 11, color: theme.textSubtle, fontVariant: ["tabular-nums"] }}>
                ({l.worldX.toFixed(1)}, {l.worldY.toFixed(1)}, {l.worldZ.toFixed(1)})
              </Text>
            </View>
          ))}
        </View>
      )}

      {/* Register */}
      {hasLandmarks && !fieldActive && (
        <View style={[cardStyle, { padding: 14, marginBottom: 4 }]}>
          {frameResult && (
            <Text style={{ fontSize: 11, color: theme.textSubtle, marginBottom: 8 }}>{frameResult}</Text>
          )}
          <Pressable
            onPress={registerField}
            style={{ paddingVertical: 10, borderRadius: 8, backgroundColor: theme.primary, alignItems: "center" }}
          >
            <Text style={{ fontSize: 14, fontWeight: "600", color: "#fff" }}>Register Field</Text>
          </Pressable>
        </View>
      )}

      {/* Saved fields */}
      {fields.length > 0 && (
        <View style={[cardStyle, { padding: 14, marginBottom: 4 }]}>
          <Text style={{ fontSize: 12, fontWeight: "600", color: theme.textMuted, marginBottom: 6 }}>Saved Fields</Text>
          {fields.map((f) => (
            <View key={f.id} style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: theme.border }}>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 13, color: theme.text, fontWeight: activeFieldId === f.id ? "700" : "400" }}>{f.name}</Text>
                <Text style={{ fontSize: 11, color: theme.textSubtle }}>
                  {FIELD_TEMPLATES[f.fieldType]?.name ?? f.fieldType} · {new Date(f.createdAt).toLocaleDateString()}
                </Text>
              </View>
              <View style={{ flexDirection: "row", gap: 8 }}>
                <Pressable onPress={() => setActiveField(activeFieldId === f.id ? null : f.id)}>
                  <Text style={{ fontSize: 12, color: theme.primary }}>{activeFieldId === f.id ? "Active" : "Use"}</Text>
                </Pressable>
                <Pressable onPress={() => removeField(f.id)}>
                  <Text style={{ fontSize: 12, color: theme.destructive }}>Delete</Text>
                </Pressable>
              </View>
            </View>
          ))}
        </View>
      )}
    </>
  );
}

function DevSection({ label, theme, styles, children }: { label: string; theme: Theme; styles: ReturnType<typeof makeStyles>; children: React.ReactNode }) {
  return (
    <View style={{ marginBottom: 8, borderTopWidth: StyleSheet.hairlineWidth, borderColor: theme.border, paddingTop: 6 }}>
      <Text style={{ fontSize: 10, fontWeight: "700", color: theme.textSubtle, textTransform: "uppercase", marginBottom: 4 }}>
        {label}
      </Text>
      {children}
    </View>
  );
}

function Stepper({ label, value, step, min, max, decimals, onChange, theme }: {
  label: string; value: number; step: number; min: number; max: number; decimals: number;
  onChange: (v: number) => void; theme: Theme;
}) {
  const fmt = (n: number) => decimals === 0 ? String(Math.round(n)) : n.toFixed(decimals);
  const apply = (delta: number) => {
    const next = Math.max(min, Math.min(max, +(value + delta).toFixed(4)));
    onChange(next);
  };
  return (
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 3 }}>
      <Text style={{ fontSize: 11, color: theme.textSubtle, flex: 1 }}>{label}</Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Pressable
          onPress={() => apply(-step)}
          style={{ width: 26, height: 26, borderRadius: 6, alignItems: "center", justifyContent: "center", backgroundColor: theme.surfaceAlt, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.border }}
        >
          <Text style={{ fontSize: 14, color: theme.text, fontWeight: "700" }}>−</Text>
        </Pressable>
        <Text style={{ fontSize: 12, color: theme.text, fontVariant: ["tabular-nums"], minWidth: 48, textAlign: "center" }}>
          {fmt(value)}
        </Text>
        <Pressable
          onPress={() => apply(step)}
          style={{ width: 26, height: 26, borderRadius: 6, alignItems: "center", justifyContent: "center", backgroundColor: theme.surfaceAlt, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.border }}
        >
          <Text style={{ fontSize: 14, color: theme.text, fontWeight: "700" }}>+</Text>
        </Pressable>
      </View>
    </View>
  );
}

function DepthGrid({ frame }: { frame: DepthFrame }) {
  // Native module ships a pre-colorized, pre-rotated PNG. Just display it.
  return (
    <Image
      source={{ uri: `data:image/png;base64,${frame.imageBase64}` }}
      style={{ width: "100%", aspectRatio: frame.width / frame.height, borderRadius: 8 }}
      resizeMode="contain"
      fadeDuration={0}
    />
  );
}

// Game controller — isolated like VisionTab so the native module being
// missing from this build doesn't take down the rest of the Device tab.
function GameControllerSection({ theme, styles }: { theme: Theme; styles: ReturnType<typeof makeStyles> }) {
  const available = GameController.available();
  const [watching, setWatching] = useState(false);
  const [controllers, setControllers] = useState<ControllerInfo[]>([]);
  const [frames, setFrames] = useState<Record<string, ControllerInputFrame>>({});
  const [err, setErr] = useState<string | null>(null);

  const start = async () => {
    try {
      setErr(null);
      await GameController.startWatching(30);
      setWatching(true);
      setControllers(GameController.listControllers());
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const stop = async () => {
    try { await GameController.stopWatching(); } catch {}
    setWatching(false);
    setControllers([]);
    setFrames({});
  };

  useEffect(() => {
    if (!watching) return;
    const sub1 = GameController.addControllersListener(setControllers);
    const sub2 = GameController.addInputListener((batch) => {
      setFrames((prev) => {
        const next = { ...prev };
        for (const f of batch) next[f.id] = f;
        return next;
      });
    });
    return () => { sub1.remove(); sub2.remove(); };
  }, [watching]);

  useEffect(() => () => { GameController.stopWatching().catch(() => {}); }, []);

  return (
    <>
      <Text style={styles.sectionTitle}>Game controller</Text>
      <View style={[styles.card, { padding: 14, marginBottom: 4 }]}>
        {!available ? (
          <Text style={{ fontSize: 13, color: theme.textSubtle }}>
            Native module not in this build.
          </Text>
        ) : (
          <>
            <Pressable
              onPress={watching ? stop : start}
              style={{ paddingVertical: 10, borderRadius: 8, alignItems: "center", backgroundColor: watching ? theme.destructive : theme.primary }}
            >
              <Text style={{ color: "#fff", fontSize: 13, fontWeight: "600" }}>
                {watching ? "Stop watching" : "Start watching"}
              </Text>
            </Pressable>
            {err && <Text style={{ fontSize: 11, color: theme.destructive, marginTop: 6 }}>{err}</Text>}
            <Text style={{ fontSize: 11, color: theme.textSubtle, marginTop: 6, textAlign: "center" }}>
              Pair a DualSense / DualShock / Xbox / MFi pad in iOS Settings → Bluetooth first.
            </Text>
          </>
        )}
      </View>

      {watching && controllers.length === 0 && (
        <View style={[styles.card, { padding: 14, marginBottom: 16 }]}>
          <Text style={{ fontSize: 13, color: theme.textSubtle, textAlign: "center" }}>
            No controllers connected yet…
          </Text>
        </View>
      )}

      {controllers.map((c) => {
        const f = frames[c.id];
        return (
          <View key={c.id} style={[styles.card, { padding: 12, marginBottom: 12 }]}>
            <Text style={{ fontSize: 13, fontWeight: "700", color: theme.text }}>{c.vendorName || "Unknown"}</Text>
            <Text style={{ fontSize: 11, color: theme.textSubtle, marginBottom: 8 }}>
              {c.productCategory} {c.hasExtendedGamepad ? "· extended" : ""} {c.isAttachedToDevice ? "· attached" : ""}
            </Text>
            {f ? <ControllerView frame={f} theme={theme} /> : (
              <Text style={{ fontSize: 12, color: theme.textSubtle }}>Waiting for input…</Text>
            )}
          </View>
        );
      })}
    </>
  );
}

function ControllerView({ frame, theme }: { frame: ControllerInputFrame; theme: Theme }) {
  const buttons: [string, number][] = [
    ["A / ✕", frame.buttonA],
    ["B / ○", frame.buttonB],
    ["X / □", frame.buttonX],
    ["Y / △", frame.buttonY],
    ["LB", frame.leftShoulder],
    ["RB", frame.rightShoulder],
    ["LT", frame.leftTrigger],
    ["RT", frame.rightTrigger],
    ["L3", frame.leftThumbstickButton],
    ["R3", frame.rightThumbstickButton],
    ["Menu", frame.buttonMenu],
    ["Opt", frame.buttonOptions],
    ["Home", frame.buttonHome],
  ];
  return (
    <>
      <View style={{ flexDirection: "row", gap: 12, marginBottom: 10 }}>
        <Stick label="L" x={frame.leftX} y={frame.leftY} theme={theme} />
        <Stick label="R" x={frame.rightX} y={frame.rightY} theme={theme} />
        <Stick label="D-pad" x={frame.dpadX} y={frame.dpadY} theme={theme} />
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
        {buttons.map(([label, v]) => {
          const active = v > 0.05;
          return (
            <View
              key={label}
              style={{
                paddingVertical: 4,
                paddingHorizontal: 8,
                borderRadius: 6,
                backgroundColor: active ? theme.primary : theme.surfaceAlt,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: theme.border,
                minWidth: 40,
                alignItems: "center",
              }}
            >
              <Text style={{ fontSize: 10, color: active ? "#fff" : theme.textSubtle, fontWeight: "600" }}>{label}</Text>
              <Text style={{ fontSize: 10, color: active ? "#fff" : theme.text, fontVariant: ["tabular-nums"] }}>
                {v > 0.01 ? v.toFixed(2) : "—"}
              </Text>
            </View>
          );
        })}
      </View>
    </>
  );
}

function Stick({ label, x, y, theme }: { label: string; x: number; y: number; theme: Theme }) {
  const size = 64;
  const radius = size / 2;
  // GameController y axis: +1 = up. Screen y: +1 = down. Flip.
  const dotX = radius + x * (radius - 6);
  const dotY = radius - y * (radius - 6);
  return (
    <View style={{ alignItems: "center" }}>
      <View style={{
        width: size, height: size, borderRadius: radius,
        backgroundColor: theme.surfaceAlt,
        borderWidth: StyleSheet.hairlineWidth, borderColor: theme.border,
        position: "relative",
      }}>
        <View style={{
          position: "absolute",
          left: dotX - 5, top: dotY - 5,
          width: 10, height: 10, borderRadius: 5,
          backgroundColor: theme.primary,
        }} />
      </View>
      <Text style={{ fontSize: 10, color: theme.textSubtle, marginTop: 4, fontWeight: "600" }}>{label}</Text>
    </View>
  );
}

function XyzRow({
  values,
  digits = 3,
  theme,
}: {
  values: Array<[string, number | null | undefined]>;
  digits?: number;
  theme: Theme;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        justifyContent: "space-around",
        backgroundColor: theme.surface,
        borderRadius: 12,
        paddingVertical: 10,
        paddingHorizontal: 8,
        marginBottom: 20,
      }}
    >
      {values.map(([label, v]) => (
        <View key={label} style={{ flexDirection: "row", alignItems: "baseline", gap: 4 }}>
          <Text style={{ fontSize: 11, fontWeight: "600", color: theme.textSubtle, textTransform: "uppercase" }}>{label}</Text>
          <Text style={{ fontSize: 13, fontWeight: "600", color: theme.text, fontVariant: ["tabular-nums"] }}>
            {v == null ? "—" : v.toFixed(digits)}
          </Text>
        </View>
      ))}
    </View>
  );
}

// --- Altitude unit formatting -------------------------------------------------
type AltUnit = "mm" | "m" | "in" | "ftin";
const ALT_UNITS: { value: AltUnit; label: string }[] = [
  { value: "mm", label: "mm" },
  { value: "m", label: "m" },
  { value: "in", label: "in" },
  { value: "ftin", label: "ft+in" },
];

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

function formatAltitude(meters: number, unit: AltUnit): string {
  const sign = meters < 0 ? "-" : "";
  const m = Math.abs(meters);
  switch (unit) {
    case "mm":
      return `${sign}${(m * 1000).toFixed(1)} mm`;
    case "m":
      return `${sign}${m.toFixed(3)} m`;
    case "in":
      return `${sign}${(m * 39.3701).toFixed(3)} in`;
    case "ftin": {
      const totalIn = m * 39.3701;
      const ft = Math.floor(totalIn / 12);
      const restIn = totalIn - ft * 12;
      const wholeIn = Math.floor(restIn);
      const fracIn = restIn - wholeIn;
      let n = Math.round(fracIn * 16);
      const d = 16;
      if (n === 16) return `${sign}${ft}'${wholeIn + 1}"`;
      if (n === 0) return `${sign}${ft}'${wholeIn}"`;
      const g = gcd(n, d);
      return `${sign}${ft}'${wholeIn} ${n / g}/${d / g}"`;
    }
  }
}

// Open-Meteo WMO weather codes → short label + emoji.
function weatherLabel(code: number): { label: string; emoji: string } {
  if (code === 0) return { label: "Clear", emoji: "☀️" };
  if (code <= 2) return { label: "Mostly clear", emoji: "🌤" };
  if (code === 3) return { label: "Overcast", emoji: "☁️" };
  if (code >= 45 && code <= 48) return { label: "Fog", emoji: "🌫" };
  if (code >= 51 && code <= 57) return { label: "Drizzle", emoji: "🌦" };
  if (code >= 61 && code <= 67) return { label: "Rain", emoji: "🌧" };
  if (code >= 71 && code <= 77) return { label: "Snow", emoji: "🌨" };
  if (code >= 80 && code <= 82) return { label: "Showers", emoji: "🌦" };
  if (code === 85 || code === 86) return { label: "Snow showers", emoji: "🌨" };
  if (code >= 95 && code <= 99) return { label: "Thunderstorm", emoji: "⛈" };
  return { label: `code ${code}`, emoji: "❓" };
}

function magnitude(v: { x: number; y: number; z: number }) {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

const HIST_LEN = 80;

function BarGauge({ value, max, color, height = 14 }: { value: number; max: number; color: string; height?: number }) {
  const pct = Math.max(0, Math.min(1, value / Math.max(0.0001, max))) * 100;
  return (
    <View style={{ height, backgroundColor: "rgba(127,127,127,0.18)", borderRadius: height / 2, overflow: "hidden" }}>
      <View style={{ width: `${pct}%`, height: "100%", backgroundColor: color, borderRadius: height / 2 }} />
    </View>
  );
}

function TiltIndicator({ pitchDeg, rollDeg, color, size = 90 }: { pitchDeg: number; rollDeg: number; color: string; size?: number }) {
  // Map -90..90 to 0..size; clamp so the dot stays inside the circle
  const clamp = (v: number) => Math.max(-90, Math.min(90, v));
  const x = ((clamp(rollDeg) + 90) / 180) * size;
  const y = ((clamp(pitchDeg) + 90) / 180) * size;
  return (
    <View
      style={{
        width: size,
        height: size,
        alignSelf: "center",
        backgroundColor: "rgba(127,127,127,0.15)",
        borderRadius: size / 2,
        position: "relative",
      }}
    >
      {/* crosshairs */}
      <View style={{ position: "absolute", left: 0, right: 0, top: size / 2, height: StyleSheet.hairlineWidth, backgroundColor: "rgba(127,127,127,0.35)" }} />
      <View style={{ position: "absolute", top: 0, bottom: 0, left: size / 2, width: StyleSheet.hairlineWidth, backgroundColor: "rgba(127,127,127,0.35)" }} />
      {/* dot */}
      <View
        style={{
          position: "absolute",
          left: x - 7,
          top: y - 7,
          width: 14,
          height: 14,
          borderRadius: 7,
          backgroundColor: color,
        }}
      />
    </View>
  );
}

function CompassArrow({ headingDeg, color, size = 70 }: { headingDeg: number; color: string; size?: number }) {
  return (
    <View
      style={{
        width: size,
        height: size,
        alignSelf: "center",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: size / 2,
        backgroundColor: "rgba(127,127,127,0.15)",
        position: "relative",
      }}
    >
      <Text style={{ position: "absolute", top: 4, fontSize: 10, fontWeight: "700", color: "rgba(127,127,127,0.7)" }}>N</Text>
      <View style={{ transform: [{ rotate: `${headingDeg}deg` }] }}>
        <View
          style={{
            width: 0,
            height: 0,
            borderLeftWidth: 8,
            borderRightWidth: 8,
            borderBottomWidth: 22,
            borderStyle: "solid",
            borderLeftColor: "transparent",
            borderRightColor: "transparent",
            borderBottomColor: color,
          }}
        />
      </View>
    </View>
  );
}

function MultiSparkline({ lines, height = 70 }: { lines: { samples: number[]; color: string; label?: string }[]; height?: number }) {
  if (lines.every((l) => l.samples.length < 2)) {
    return <View style={{ height, backgroundColor: "transparent" }} />;
  }
  // Shared y-axis range across all lines so they're comparable.
  let min = Infinity;
  let max = -Infinity;
  for (const l of lines) {
    for (const v of l.samples) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (!isFinite(min)) { min = 0; max = 1; }
  return (
    <View style={{ height, position: "relative" }}>
      {lines.map((l, i) => (
        <View key={i} style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0 }}>
          <Sparkline samples={l.samples} color={l.color} height={height} yMin={min} yMax={max} />
        </View>
      ))}
      {/* legend in the top-right corner */}
      <View style={{ position: "absolute", top: 4, right: 8, flexDirection: "row", gap: 8 }}>
        {lines.map((l) => (
          <Text key={l.label} style={{ fontSize: 10, fontWeight: "700", color: l.color }}>
            {l.label}
          </Text>
        ))}
      </View>
    </View>
  );
}

function Sparkline({ samples, color, height = 56, yMin, yMax }: { samples: number[]; color: string; height?: number; yMin?: number; yMax?: number }) {
  const [width, setWidth] = useState(0);

  if (samples.length < 2) {
    return (
      <View
        style={{ height, backgroundColor: "transparent" }}
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      />
    );
  }

  // Use shared scale if provided, otherwise auto-scale.
  const min = yMin ?? Math.min(...samples);
  const max = yMax ?? Math.max(...samples);
  const range = max - min || 1;

  // Pad on the left so "now" is always the right edge.
  const padded: (number | null)[] = Array<number | null>(HIST_LEN - samples.length).fill(null).concat(samples);
  const drawableHeight = height - 6; // 3px padding top + bottom
  const stroke = 2;

  // y goes from top (low value) to bottom (high value) wait — usually we want
  // higher value = higher on screen. In RN, y=0 is top, so invert: y = (1 - norm) * drawable + 3.
  const yFor = (v: number) => (1 - (v - min) / range) * drawableHeight + 3 - stroke / 2;

  return (
    <View
      style={{ height, position: "relative" }}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
    >
      {width > 0 &&
        padded.map((v, i) => {
          if (i === 0 || v == null) return null;
          const prev = padded[i - 1];
          if (prev == null) return null;
          const step = width / (padded.length - 1);
          const x1 = (i - 1) * step;
          const y1 = yFor(prev);
          const y2 = yFor(v);
          const dy = y2 - y1;
          const length = Math.sqrt(step * step + dy * dy);
          const angle = Math.atan2(dy, step); // radians
          return (
            <View
              key={i}
              style={{
                position: "absolute",
                left: x1,
                top: y1,
                width: length,
                height: stroke,
                backgroundColor: color,
                borderRadius: stroke / 2,
                transformOrigin: "left center",
                transform: [{ rotate: `${angle}rad` }],
              }}
            />
          );
        })}
    </View>
  );
}

// Shared ref so FieldTab can disable scrolling when in edit mode
const fieldEditModeRef = { current: false };
const fieldEditModeListeners = new Set<(v: boolean) => void>();
export function setFieldEditMode(v: boolean) {
  fieldEditModeRef.current = v;
  fieldEditModeListeners.forEach((fn) => fn(v));
}

export default function ExperimentsScreen() {
  const styles = useStyles(makeStyles);
  const [scrollEnabled, setScrollEnabled] = useState(true);
  useEffect(() => {
    const listener = (editing: boolean) => setScrollEnabled(!editing);
    fieldEditModeListeners.add(listener);
    return () => { fieldEditModeListeners.delete(listener); };
  }, []);
  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 16, paddingBottom: 60 }} scrollEnabled={scrollEnabled}>
      <ExperimentsContent />
    </ScrollView>
  );
}

export type LabTab = "vision" | "sensors" | "audio" | "device" | "info";

const LAB_TABS: { key: LabTab; label: string }[] = [
  { key: "vision", label: "Vision" },
  { key: "sensors", label: "Sensors" },
  { key: "audio", label: "Audio" },
  { key: "device", label: "Device" },
  { key: "info", label: "Info" },
];

export function ExperimentsContent() {
  const { token } = useAuth();
  const styles = useStyles(makeStyles);
  const theme = useTheme();
  const { data: me } = useMe();
  const [labTab, setLabTab] = useState<LabTab>("vision");
  const [pushToken, setPushToken] = useState<string | null>(null);
  const [pushPerm, setPushPerm] = useState<string>("?");
  const [clipboardSnap, setClipboardSnap] = useState<string>("");

  // Sensors — live values, polled at ~5 Hz (200 ms)
  const [accel, setAccel] = useState<{ x: number; y: number; z: number } | null>(null);
  const [gyro, setGyro] = useState<{ x: number; y: number; z: number } | null>(null);
  const [mag, setMag] = useState<{ x: number; y: number; z: number } | null>(null);
  type XyzHist = { x: number[]; y: number[]; z: number[] };
  const emptyXyzHist = (): XyzHist => ({ x: [], y: [], z: [] });
  const [accelHist, setAccelHist] = useState<XyzHist>(emptyXyzHist());
  const [gyroHist, setGyroHist] = useState<XyzHist>(emptyXyzHist());
  const [magHist, setMagHist] = useState<XyzHist>(emptyXyzHist());

  useEffect(() => {
    Accelerometer.setUpdateInterval(200);
    Gyroscope.setUpdateInterval(200);
    Magnetometer.setUpdateInterval(200);
    const grow = (arr: number[], v: number) => {
      const next = arr.length >= HIST_LEN ? arr.slice(arr.length - HIST_LEN + 1) : arr;
      return [...next, v];
    };
    const pushTo = (set: React.Dispatch<React.SetStateAction<XyzHist>>) =>
      (v: { x: number; y: number; z: number }) => {
        set((prev) => ({ x: grow(prev.x, v.x), y: grow(prev.y, v.y), z: grow(prev.z, v.z) }));
      };
    const subs = [
      Accelerometer.addListener((v) => { setAccel(v); pushTo(setAccelHist)(v); }),
      Gyroscope.addListener((v) => { setGyro(v); pushTo(setGyroHist)(v); }),
      Magnetometer.addListener((v) => { setMag(v); pushTo(setMagHist)(v); }),
    ];
    return () => subs.forEach((s) => s.remove());
  }, []);

  // DeviceMotion — fused orientation, gravity vector, user-acceleration (gravity removed)
  const [motion, setMotion] = useState<DeviceMotionMeasurement | null>(null);
  const [motionZero, setMotionZero] = useState<{ alpha: number; beta: number; gamma: number } | null>(null);
  const [gravityHist, setGravityHist] = useState<XyzHist>(emptyXyzHist());
  const [userAccelHist, setUserAccelHist] = useState<XyzHist>(emptyXyzHist());
  useEffect(() => {
    DeviceMotion.setUpdateInterval(200);
    const grow = (arr: number[], v: number) => {
      const next = arr.length >= HIST_LEN ? arr.slice(arr.length - HIST_LEN + 1) : arr;
      return [...next, v];
    };
    const sub = DeviceMotion.addListener((m) => {
      setMotion(m);
      const g = m.accelerationIncludingGravity;
      if (g) {
        setGravityHist((prev) => ({ x: grow(prev.x, g.x), y: grow(prev.y, g.y), z: grow(prev.z, g.z) }));
      }
      const ua = m.acceleration;
      if (ua) {
        setUserAccelHist((prev) => ({ x: grow(prev.x, ua.x), y: grow(prev.y, ua.y), z: grow(prev.z, ua.z) }));
      }
    });
    return () => sub.remove();
  }, []);

  // Position-by-double-integration. Drifts heavily — meant as a physics demo.
  const [posTracking, setPosTracking] = useState(false);
  const [posDisplay, setPosDisplay] = useState({ x: 0, y: 0, z: 0, vmag: 0 });
  const posState = useRef({ vx: 0, vy: 0, vz: 0, px: 0, py: 0, pz: 0, lastT: 0 });
  useEffect(() => {
    if (!posTracking) return;
    posState.current = { vx: 0, vy: 0, vz: 0, px: 0, py: 0, pz: 0, lastT: Date.now() };
    setPosDisplay({ x: 0, y: 0, z: 0, vmag: 0 });
    const sub = DeviceMotion.addListener((m) => {
      if (!m.acceleration) return;
      const now = Date.now();
      const dt = (now - posState.current.lastT) / 1000;
      posState.current.lastT = now;
      if (dt <= 0 || dt > 0.5) return;

      // High-pass: anything below 0.02 m/s² treated as noise.
      const noise = 0.02;
      const ax = Math.abs(m.acceleration.x) < noise ? 0 : m.acceleration.x;
      const ay = Math.abs(m.acceleration.y) < noise ? 0 : m.acceleration.y;
      const az = Math.abs(m.acceleration.z) < noise ? 0 : m.acceleration.z;

      const s = posState.current;
      s.vx += ax * dt;
      s.vy += ay * dt;
      s.vz += az * dt;
      // ZUPT-ish: bleed velocity when accel is essentially zero.
      if (ax === 0 && ay === 0 && az === 0) {
        s.vx *= 0.9;
        s.vy *= 0.9;
        s.vz *= 0.9;
      }
      s.px += s.vx * dt;
      s.py += s.vy * dt;
      s.pz += s.vz * dt;
      setPosDisplay({
        x: s.px,
        y: s.py,
        z: s.pz,
        vmag: Math.sqrt(s.vx * s.vx + s.vy * s.vy + s.vz * s.vz),
      });
    });
    return () => sub.remove();
  }, [posTracking]);

  const resetPosition = () => {
    posState.current = { vx: 0, vy: 0, vz: 0, px: 0, py: 0, pz: 0, lastT: Date.now() };
    setPosDisplay({ x: 0, y: 0, z: 0, vmag: 0 });
  };

  // Barometer — air pressure in hPa (iPhone 6+ only)
  const [pressure, setPressure] = useState<{ pressure: number; relativeAltitude?: number | null } | null>(null);
  const [pressureHist, setPressureHist] = useState<number[]>([]);
  const [baroAvailable, setBaroAvailable] = useState<boolean | null>(null);
  const [altUnit, setAltUnit] = useState<AltUnit>("ftin");
  const [altZero, setAltZero] = useState<number>(0);
  useEffect(() => {
    Barometer.isAvailableAsync().then(setBaroAvailable).catch(() => setBaroAvailable(false));
    Barometer.setUpdateInterval(500);
    const sub = Barometer.addListener((v) => {
      setPressure(v);
      setPressureHist((prev) => {
        const next = prev.length >= HIST_LEN ? prev.slice(prev.length - HIST_LEN + 1) : prev;
        return [...next, v.pressure];
      });
    });
    return () => sub.remove();
  }, []);

  // Pedometer — step count over a window
  const [pedAvailable, setPedAvailable] = useState<boolean | null>(null);
  const [stepsToday, setStepsToday] = useState<number | null>(null);
  const [liveSteps, setLiveSteps] = useState<number | null>(null);
  useEffect(() => {
    (async () => {
      const ok = await Pedometer.isAvailableAsync();
      setPedAvailable(ok);
      if (!ok) return;

      // Steps since midnight
      try {
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        const res = await Pedometer.getStepCountAsync(start, new Date());
        setStepsToday(res.steps);
      } catch {
        // permission likely not granted yet
      }
    })();

    const sub = Pedometer.watchStepCount((res) => setLiveSteps(res.steps));
    return () => sub.remove();
  }, []);

  // Battery (one-shot + subscribe)
  const [battery, setBattery] = useState<{ level: number; state: number; lowPower: boolean } | null>(null);
  useEffect(() => {
    (async () => {
      const [level, state, lowPower] = await Promise.all([
        Battery.getBatteryLevelAsync(),
        Battery.getBatteryStateAsync(),
        Battery.isLowPowerModeEnabledAsync(),
      ]);
      setBattery({ level, state, lowPower });
    })();
    const sub = Battery.addBatteryLevelListener(({ batteryLevel }) =>
      setBattery((prev) => (prev ? { ...prev, level: batteryLevel } : prev))
    );
    return () => sub.remove();
  }, []);

  // Microphone — metering-only recording (audio is discarded on stop).
  const [micRecording, setMicRecording] = useState<Audio.Recording | null>(null);
  const [micLevel, setMicLevel] = useState<number | null>(null);
  const [micPeak, setMicPeak] = useState<number>(0);
  const [micHist, setMicHist] = useState<number[]>([]);
  const [micStatus, setMicStatus] = useState<string>("idle");

  const startMic = async () => {
    try {
      const perm = await Audio.requestPermissionsAsync();
      if (!perm.granted) {
        setMicStatus(`denied: ${perm.status}`);
        return;
      }
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });
      setMicHist([]);
      setMicPeak(0);
      setMicStatus("listening");
      const preset = Audio.RecordingOptionsPresets.HIGH_QUALITY;
      const options = {
        ...preset,
        isMeteringEnabled: true,
        ios: { ...preset.ios, isMeteringEnabled: true },
      };
      const { recording } = await Audio.Recording.createAsync(
        options,
        (status) => {
          if (status.isRecording && typeof status.metering === "number") {
            // Metering is in dBFS, typically -160..0. Map -60..0 -> 0..1.
            const level = Math.max(0, Math.min(1, (status.metering + 60) / 60));
            setMicLevel(level);
            setMicPeak((p) => (level > p ? level : p));
            setMicHist((prev) => {
              const next = prev.length >= HIST_LEN ? prev.slice(prev.length - HIST_LEN + 1) : prev;
              return [...next, level];
            });
          }
        },
        100
      );
      setMicRecording(recording);
    } catch (err) {
      setMicStatus(`error: ${(err as Error).message}`);
    }
  };

  const stopMic = async () => {
    if (!micRecording) return;
    try {
      await micRecording.stopAndUnloadAsync();
    } catch {
      // ignore
    }
    setMicRecording(null);
    setMicLevel(null);
    setMicStatus("idle");
  };

  // Stop the mic if the user navigates away while it's recording.
  useEffect(() => {
    return () => {
      if (micRecording) {
        micRecording.stopAndUnloadAsync().catch(() => {});
      }
    };
  }, [micRecording]);

  // Location — supports both on-demand "get one" and continuous streaming.
  const [loc, setLoc] = useState<Location.LocationObject | null>(null);
  const [locStatus, setLocStatus] = useState<string>("not requested");
  const [locWatching, setLocWatching] = useState(false);
  const [locBackground, setLocBackground] = useState(false);
  const [speedHist, setSpeedHist] = useState<number[]>([]);
  const [altHist, setAltHist] = useState<number[]>([]);
  const locSubRef = useRef<Location.LocationSubscription | null>(null);
  const [bgLocCount, setBgLocCount] = useState(0);
  const [bgLocLast, setBgLocLast] = useState<BgLocPoint | null>(null);
  useEffect(() => {
    const refresh = () => {
      setBgLocCount(bgLocBuffer.length);
      setBgLocLast(bgLocBuffer[bgLocBuffer.length - 1] ?? null);
    };
    refresh();
    bgLocListeners.add(refresh);
    return () => { bgLocListeners.delete(refresh); };
  }, []);
  useEffect(() => {
    Location.hasStartedLocationUpdatesAsync(BG_LOCATION_TASK)
      .then((started) => { if (started) { setLocBackground(true); setLocWatching(true); setLocStatus("background streaming"); } })
      .catch(() => {});
  }, []);

  const handleLocation = (pos: Location.LocationObject) => {
    setLoc(pos);
    const speed = pos.coords.speed ?? 0;
    const alt = pos.coords.altitude ?? 0;
    setSpeedHist((prev) => {
      const next = prev.length >= HIST_LEN ? prev.slice(prev.length - HIST_LEN + 1) : prev;
      return [...next, Math.max(0, speed)];
    });
    setAltHist((prev) => {
      const next = prev.length >= HIST_LEN ? prev.slice(prev.length - HIST_LEN + 1) : prev;
      return [...next, alt];
    });
  };

  const requestLocation = async () => {
    try {
      setLocStatus("requesting…");
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status !== "granted") {
        setLocStatus(`denied: ${perm.status}`);
        return;
      }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      handleLocation(pos);
      setLocStatus("granted");
    } catch (err) {
      setLocStatus(`error: ${(err as Error).message}`);
    }
  };

  const startWatchingLocation = async () => {
    try {
      setLocStatus("starting…");
      const fg = await Location.requestForegroundPermissionsAsync();
      if (fg.status !== "granted") {
        setLocStatus(`denied: ${fg.status}`);
        return;
      }
      setSpeedHist([]);
      setAltHist([]);
      if (locBackground) {
        const bg = await Location.requestBackgroundPermissionsAsync();
        if (bg.status !== "granted") {
          setLocStatus(`background denied: ${bg.status} — turn on "Always" in Settings`);
          return;
        }
        bgLocBuffer.length = 0;
        setBgLocCount(0);
        setBgLocLast(null);
        await Location.startLocationUpdatesAsync(BG_LOCATION_TASK, {
          accuracy: Location.Accuracy.BestForNavigation,
          timeInterval: 1000,
          distanceInterval: 0,
          showsBackgroundLocationIndicator: true,
          pausesUpdatesAutomatically: false,
          activityType: Location.ActivityType.Other,
          foregroundService: {
            notificationTitle: "whyapp location",
            notificationBody: "Streaming location for the Lab demo",
          },
        });
        setLocWatching(true);
        setLocStatus("background streaming");
        return;
      }
      const sub = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.BestForNavigation,
          timeInterval: 1000,
          distanceInterval: 0,
        },
        handleLocation
      );
      locSubRef.current = sub;
      setLocWatching(true);
      setLocStatus("streaming");
    } catch (err) {
      setLocStatus(`error: ${(err as Error).message}`);
    }
  };

  const stopWatchingLocation = async () => {
    locSubRef.current?.remove();
    locSubRef.current = null;
    try {
      const started = await Location.hasStartedLocationUpdatesAsync(BG_LOCATION_TASK);
      if (started) await Location.stopLocationUpdatesAsync(BG_LOCATION_TASK);
    } catch {}
    setLocWatching(false);
    setLocStatus("stopped");
  };

  useEffect(() => {
    return () => {
      locSubRef.current?.remove();
    };
  }, []);

  const fireHaptic = (kind: "light" | "medium" | "heavy" | "success" | "warning" | "error") => {
    if (kind === "light") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    else if (kind === "medium") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    else if (kind === "heavy") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    else if (kind === "success") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    else if (kind === "warning") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    else if (kind === "error") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
  };

  const batteryStateLabel = (s: number) => {
    switch (s) {
      case Battery.BatteryState.UNPLUGGED: return "unplugged";
      case Battery.BatteryState.CHARGING: return "charging";
      case Battery.BatteryState.FULL: return "full";
      default: return "unknown";
    }
  };

  // Weather — Open-Meteo (free, no key)
  interface WeatherCurrent {
    temperature: number;
    apparentTemperature: number;
    humidity: number;
    windSpeed: number;
    weatherCode: number;
  }
  interface WeatherHourly {
    time: string;
    temperature: number;
    precipProb: number;
  }
  const [weather, setWeather] = useState<{ current: WeatherCurrent; hourly: WeatherHourly[]; placeLat: number; placeLon: number; fetchedAt: number } | null>(null);
  const [weatherErr, setWeatherErr] = useState<string | null>(null);
  const [weatherLoading, setWeatherLoading] = useState(false);
  const fetchWeather = async () => {
    setWeatherLoading(true);
    setWeatherErr(null);
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status !== "granted") throw new Error(`location ${perm.status}`);
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const { latitude, longitude } = pos.coords;
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code&hourly=temperature_2m,precipitation_probability&temperature_unit=fahrenheit&wind_speed_unit=mph&forecast_days=2&timezone=auto`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as {
        current: { temperature_2m: number; apparent_temperature: number; relative_humidity_2m: number; wind_speed_10m: number; weather_code: number };
        hourly: { time: string[]; temperature_2m: number[]; precipitation_probability: number[] };
      };
      const nowH = new Date();
      const hourly: WeatherHourly[] = [];
      for (let i = 0; i < data.hourly.time.length && hourly.length < 24; i++) {
        const t = new Date(data.hourly.time[i]!);
        if (t.getTime() < nowH.getTime() - 30 * 60 * 1000) continue;
        hourly.push({
          time: data.hourly.time[i]!,
          temperature: data.hourly.temperature_2m[i]!,
          precipProb: data.hourly.precipitation_probability[i] ?? 0,
        });
      }
      setWeather({
        current: {
          temperature: data.current.temperature_2m,
          apparentTemperature: data.current.apparent_temperature,
          humidity: data.current.relative_humidity_2m,
          windSpeed: data.current.wind_speed_10m,
          weatherCode: data.current.weather_code,
        },
        hourly,
        placeLat: latitude,
        placeLon: longitude,
        fetchedAt: Date.now(),
      });
    } catch (err) {
      setWeatherErr((err as Error).message);
    } finally {
      setWeatherLoading(false);
    }
  };

  // Network — connection type + Wi-Fi/cellular + online
  const [network, setNetwork] = useState<Network.NetworkState | null>(null);
  useEffect(() => {
    Network.getNetworkStateAsync().then(setNetwork).catch(() => {});
    const sub = Network.addNetworkStateListener(setNetwork);
    return () => sub.remove();
  }, []);

  // Cellular — carrier + generation
  const [cellular, setCellular] = useState<{ carrier: string | null; generation: number | null; isoCountryCode: string | null; mobileCountryCode: string | null; mobileNetworkCode: string | null; allowsVoip: boolean | null } | null>(null);
  useEffect(() => {
    (async () => {
      try {
        const [carrier, generation, iso, mcc, mnc, voip] = await Promise.all([
          Cellular.getCarrierNameAsync(),
          Cellular.getCellularGenerationAsync(),
          Cellular.getIsoCountryCodeAsync(),
          Cellular.getMobileCountryCodeAsync(),
          Cellular.getMobileNetworkCodeAsync(),
          Cellular.allowsVoipAsync(),
        ]);
        setCellular({ carrier, generation, isoCountryCode: iso, mobileCountryCode: mcc, mobileNetworkCode: mnc, allowsVoip: voip });
      } catch { /* not available */ }
    })();
  }, []);

  // Brightness — read + write
  const [brightness, setBrightness] = useState<number | null>(null);
  useEffect(() => {
    Brightness.getBrightnessAsync().then(setBrightness).catch(() => {});
  }, []);
  const adjustBrightness = async (delta: number) => {
    try {
      const cur = brightness ?? (await Brightness.getBrightnessAsync());
      const next = Math.max(0, Math.min(1, cur + delta));
      await Brightness.setBrightnessAsync(next);
      setBrightness(next);
    } catch {
      // permission denied — silently fail
    }
  };

  // Screen orientation
  const [orientation, setOrientation] = useState<ScreenOrientation.Orientation | null>(null);
  useEffect(() => {
    ScreenOrientation.getOrientationAsync().then(setOrientation).catch(() => {});
    const sub = ScreenOrientation.addOrientationChangeListener((evt) => {
      setOrientation(evt.orientationInfo.orientation);
    });
    return () => ScreenOrientation.removeOrientationChangeListener(sub);
  }, []);

  // Bluetooth LE scanner — on-demand because scanning is power-hungry.
  interface BleEntry {
    id: string;
    name: string | null;
    localName: string | null;
    rssi: number | null;
    manufacturerData: string | null;
    serviceUUIDs: string[] | null;
    txPowerLevel: number | null;
    isConnectable: boolean | null;
    seenAt: number;
  }
  const bleManagerRef = useRef<BleManager | null>(null);
  const [bleState, setBleState] = useState<BleState | "Unknown">("Unknown");
  const [bleScanning, setBleScanning] = useState(false);
  const [bleDevices, setBleDevices] = useState<Map<string, BleEntry>>(new Map());
  const [bleSelectedId, setBleSelectedId] = useState<string | null>(null);
  const [bleSortBy, setBleSortBy] = useState<"signal" | "name">("signal");
  const [bleRssiHist, setBleRssiHist] = useState<number[]>([]);
  const bleRssiHistRef = useRef<{ id: string | null; samples: number[] }>({ id: null, samples: [] });

  useEffect(() => {
    const m = new BleManager();
    bleManagerRef.current = m;
    const sub = m.onStateChange((s) => setBleState(s), true);
    return () => {
      sub.remove();
      m.destroy();
      bleManagerRef.current = null;
    };
  }, []);

  const startBleScan = async () => {
    const m = bleManagerRef.current;
    if (!m) return;
    setBleDevices(new Map());
    setBleScanning(true);
    m.startDeviceScan(null, { allowDuplicates: true }, (error, device) => {
      if (error || !device) return;
      setBleDevices((prev) => {
        const next = new Map(prev);
        const existing = next.get(device.id);
        next.set(device.id, {
          id: device.id,
          name: device.name ?? existing?.name ?? null,
          localName: device.localName ?? existing?.localName ?? null,
          rssi: device.rssi ?? existing?.rssi ?? null,
          manufacturerData: device.manufacturerData ?? existing?.manufacturerData ?? null,
          serviceUUIDs: device.serviceUUIDs ?? existing?.serviceUUIDs ?? null,
          txPowerLevel: device.txPowerLevel ?? existing?.txPowerLevel ?? null,
          isConnectable: device.isConnectable ?? existing?.isConnectable ?? null,
          seenAt: Date.now(),
        });
        return next;
      });
      // If a device is selected for monitoring, push its rssi into history.
      if (bleRssiHistRef.current.id === device.id && device.rssi != null) {
        const cur = bleRssiHistRef.current.samples;
        const next = cur.length >= HIST_LEN ? cur.slice(cur.length - HIST_LEN + 1) : cur;
        const updated = [...next, device.rssi];
        bleRssiHistRef.current.samples = updated;
        setBleRssiHist(updated);
      }
    });
  };

  const stopBleScan = () => {
    bleManagerRef.current?.stopDeviceScan();
    setBleScanning(false);
  };

  const selectBleDevice = (id: string) => {
    bleRssiHistRef.current = { id, samples: [] };
    setBleRssiHist([]);
    setBleSelectedId(id);
    // Auto-start scan if not already, so RSSI flows.
    if (!bleScanning) startBleScan();
  };

  const closeBleDetail = () => {
    bleRssiHistRef.current = { id: null, samples: [] };
    setBleSelectedId(null);
    setBleRssiHist([]);
  };

  useEffect(() => {
    return () => {
      bleManagerRef.current?.stopDeviceScan();
    };
  }, []);

  // Microphone frequency spectrum — uses live-audio-stream + FFT.
  // Mutually exclusive with the metering recording above (don't run both).
  const SAMPLE_RATE = 44100;
  const N_BANDS = 96;
  const PEAK_DECAY = 0.92;

  const [fftSize, setFftSize] = useState<4096 | 8192>(4096);
  const [spectrumScale, setSpectrumScale] = useState<"notes" | "linear">("notes");
  // Adjustable axes
  const [freqMin, setFreqMin] = useState<number>(27.5);     // A0
  const [freqMax, setFreqMax] = useState<number>(7040);     // A8
  const [dbFloor, setDbFloor] = useState<number>(-80);
  const [dbCeil, setDbCeil] = useState<number>(0);
  const [spectrumFullscreen, setSpectrumFullscreen] = useState(false);
  const { width: winW, height: winH } = useWindowDimensions();

  // Unlock orientation while the fullscreen spectrum is open; relock to portrait on close.
  useEffect(() => {
    if (spectrumFullscreen) {
      ScreenOrientation.unlockAsync().catch(() => {});
      return () => {
        ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
      };
    }
  }, [spectrumFullscreen]);

  const fftRef = useRef<FFT | null>(null);
  const fftOutRef = useRef<number[] | null>(null);
  const windowRef = useRef<Float32Array | null>(null);
  const bandEdgesRef = useRef<Int32Array | null>(null);
  const accumRef = useRef<Float32Array>(new Float32Array(0));
  const peaksRef = useRef<Float32Array>(new Float32Array(N_BANDS));

  // Rebuild FFT, window, and band edges whenever fftSize, scale, or range changes.
  useEffect(() => {
    fftRef.current = new FFT(fftSize);
    fftOutRef.current = fftRef.current.createComplexArray();
    const w = new Float32Array(fftSize);
    for (let i = 0; i < fftSize; i++) {
      w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (fftSize - 1)));
    }
    windowRef.current = w;
    const edges = new Int32Array(N_BANDS + 1);
    const maxBin = fftSize / 2 - 1;
    for (let i = 0; i <= N_BANDS; i++) {
      let f: number;
      if (spectrumScale === "notes") {
        // Log/exp spacing — equivalent to semitones when the range is one
        // octave per 12 bands. Lets the user freely pick freqMin/freqMax.
        const ratio = Math.log(freqMax / freqMin);
        f = freqMin * Math.exp((ratio * i) / N_BANDS);
      } else {
        f = freqMin + ((freqMax - freqMin) * i) / N_BANDS;
      }
      const bin = Math.round((f * fftSize) / SAMPLE_RATE);
      edges[i] = Math.min(maxBin, Math.max(0, bin));
    }
    bandEdgesRef.current = edges;
    accumRef.current = new Float32Array(0);
    peaksRef.current = new Float32Array(N_BANDS);
  }, [fftSize, spectrumScale, freqMin, freqMax]);

  const [spectrum, setSpectrum] = useState<number[]>([]);
  const [peaks, setPeaks] = useState<number[]>([]);
  const [spectrumOn, setSpectrumOn] = useState(false);

  const startSpectrum = async () => {
    try {
      const perm = await Audio.requestPermissionsAsync();
      if (!perm.granted) return;
      accumRef.current = new Float32Array(0);
      peaksRef.current = new Float32Array(N_BANDS);
      const currentFftSize = fftSize;
      LiveAudioStream.init({
        sampleRate: SAMPLE_RATE,
        channels: 1,
        bitsPerSample: 16,
        audioSource: 6,
        bufferSize: currentFftSize,
        wavFile: "spectrum.wav",
      });
      LiveAudioStream.on("data", (b64: string) => {
        const fs = fftRef.current ? fftRef.current.size : currentFftSize;
        const buf =
          typeof atob === "function"
            ? atob(b64)
            : Buffer.from(b64, "base64").toString("binary");
        const incoming = new Float32Array(Math.floor(buf.length / 2));
        for (let i = 0; i < incoming.length; i++) {
          const lo = buf.charCodeAt(i * 2);
          const hi = buf.charCodeAt(i * 2 + 1);
          let v = (hi << 8) | lo;
          if (v & 0x8000) v -= 0x10000;
          incoming[i] = v / 32768;
        }
        const prev = accumRef.current;
        const combined = new Float32Array(prev.length + incoming.length);
        combined.set(prev);
        combined.set(incoming, prev.length);

        const win = windowRef.current!;
        const out = fftOutRef.current!;
        const edges = bandEdgesRef.current!;
        let offset = 0;
        let lastBands: number[] | null = null;
        while (combined.length - offset >= fs) {
          const frame = new Float32Array(fs);
          for (let i = 0; i < fs; i++) {
            frame[i] = combined[offset + i] * win[i];
          }
          fftRef.current!.realTransform(out, frame);
          fftRef.current!.completeSpectrum(out);
          const bands = new Array<number>(N_BANDS);
          // Reference for dBFS normalization: peak possible magnitude per bin
          // after the Hanning window is ~ fs * 0.5 (window gain 0.5).
          const refLevel = fs * 0.5;
          const range = dbCeil - dbFloor;
          for (let band = 0; band < N_BANDS; band++) {
            const lo = edges[band];
            const hi = Math.max(edges[band + 1], lo + 1);
            let mag = 0;
            for (let bin = lo; bin < hi; bin++) {
              const re = out[bin * 2];
              const im = out[bin * 2 + 1];
              mag += Math.sqrt(re * re + im * im);
            }
            const avg = mag / (hi - lo);
            // To dBFS, then normalize to [0..1] across MIN_DB..MAX_DB.
            const db = 20 * Math.log10(avg / refLevel + 1e-10);
            const norm = (db - dbFloor) / range;
            bands[band] = Math.max(0, Math.min(1, norm));
          }
          lastBands = bands;
          offset += fs / 2; // 50% overlap
        }
        accumRef.current = combined.slice(offset);
        if (lastBands) {
          const p = peaksRef.current;
          const peaksOut = new Array<number>(N_BANDS);
          for (let i = 0; i < N_BANDS; i++) {
            if (lastBands[i] > p[i]) p[i] = lastBands[i];
            else p[i] *= PEAK_DECAY;
            peaksOut[i] = p[i];
          }
          setSpectrum(lastBands);
          setPeaks(peaksOut);
        }
      });
      LiveAudioStream.start();
      setSpectrumOn(true);
    } catch {
      setSpectrumOn(false);
    }
  };

  const stopSpectrum = () => {
    try { LiveAudioStream.stop(); } catch { /* */ }
    setSpectrumOn(false);
    setSpectrum([]);
    setPeaks([]);
    peaksRef.current = new Float32Array(N_BANDS);
  };

  useEffect(() => {
    return () => { try { LiveAudioStream.stop(); } catch { /* */ } };
  }, []);

  // Push token + permission status
  useEffect(() => {
    (async () => {
      try {
        const perm = await Notifications.getPermissionsAsync();
        setPushPerm(perm.status);
        if (perm.status === "granted") {
          const projectId =
            (Constants.expoConfig?.extra?.eas as { projectId?: string } | undefined)?.projectId ||
            (Constants.easConfig as { projectId?: string } | undefined)?.projectId;
          if (projectId) {
            const tok = await Notifications.getExpoPushTokenAsync({ projectId });
            setPushToken(tok.data);
          }
        }
      } catch (err) {
        setPushPerm(`error: ${(err as Error).message}`);
      }
    })();
  }, []);

  const refreshClipboard = async () => {
    try {
      const text = await Clipboard.getStringAsync();
      setClipboardSnap(text || "(empty)");
    } catch (err) {
      setClipboardSnap(`error: ${(err as Error).message}`);
    }
  };

  const copyToClipboard = (text: string, label: string) => {
    Clipboard.setStringAsync(text);
    Alert.alert("Copied", `${label} → clipboard`);
  };

  const c = Constants;

  return (
    <>
      <View style={{ flexDirection: "row", flexWrap: "wrap", backgroundColor: theme.surfaceAlt, borderRadius: 9, padding: 3, marginBottom: 12 }}>
        {LAB_TABS.map((t) => {
          const active = labTab === t.key;
          return (
            <Pressable
              key={t.key}
              onPress={() => setLabTab(t.key)}
              style={{
                flex: 1,
                minWidth: "16%",
                paddingVertical: 7,
                borderRadius: 7,
                alignItems: "center",
                backgroundColor: active ? theme.surface : "transparent",
              }}
            >
              <Text style={{ fontSize: 12, fontWeight: "600", color: active ? theme.text : theme.textMuted }}>
                {t.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {labTab === "info" && (<>
      <Section
        title="Identity"
        rows={[
          { label: "Email", value: me?.email },
          { label: "Name", value: me?.name },
          { label: "isOwner", value: me?.isOwner },
          { label: "Has session token", value: !!token },
        ]}
      />

      <Section
        title="Device (expo-device)"
        rows={[
          { label: "Brand", value: Device.brand },
          { label: "Manufacturer", value: Device.manufacturer },
          { label: "Model name", value: Device.modelName },
          { label: "Model id", value: Device.modelId },
          { label: "Design name", value: Device.designName },
          { label: "Device name", value: Device.deviceName },
          { label: "Device year class", value: Device.deviceYearClass },
          { label: "Total memory (bytes)", value: Device.totalMemory },
          { label: "OS name", value: Device.osName },
          { label: "OS version", value: Device.osVersion },
          { label: "OS build id", value: Device.osBuildId },
          { label: "Is real device", value: Device.isDevice },
        ]}
      />

      <Section
        title="App + runtime (expo-constants)"
        rows={[
          { label: "App version", value: c?.expoConfig?.version },
          { label: "Slug", value: c?.expoConfig?.slug },
          { label: "Scheme", value: typeof c?.expoConfig?.scheme === "string" ? c.expoConfig.scheme : undefined },
          { label: "Platform", value: Platform.OS },
          { label: "Status bar height", value: c?.statusBarHeight },
          { label: "Session ID", value: c?.sessionId },
          { label: "Native app version", value: c?.nativeAppVersion },
          { label: "Native build version", value: c?.nativeBuildVersion },
        ]}
      />

      <Section
        title="Notifications (expo-notifications)"
        rows={[
          { label: "Permission status", value: pushPerm },
          { label: "Expo push token", value: pushToken ? pushToken.slice(0, 28) + "…" : null },
        ]}
      />
      {pushToken && (
        <Pressable
          style={styles.btn}
          onPress={() => copyToClipboard(pushToken, "Push token")}
        >
          <Text style={styles.btnText}>Copy full push token</Text>
        </Pressable>
      )}
      </>)}

      {labTab === "sensors" && (<>
      <Text style={styles.sectionTitle}>Accelerometer</Text>
      <View style={[styles.card, { padding: 6, marginBottom: 4 }]}>
        <MultiSparkline
          lines={[
            { samples: accelHist.x, color: "#E25448", label: "x" },
            { samples: accelHist.y, color: "#3D7F94", label: "y" },
            { samples: accelHist.z, color: "#E6B441", label: "z" },
          ]}
        />
      </View>
      <XyzRow
        values={[["x", accel?.x ?? null], ["y", accel?.y ?? null], ["z", accel?.z ?? null]]}
        digits={3}
        theme={theme}
      />

      <Text style={styles.sectionTitle}>Gyroscope</Text>
      <View style={[styles.card, { padding: 6, marginBottom: 4 }]}>
        <MultiSparkline
          lines={[
            { samples: gyroHist.x, color: "#E25448", label: "x" },
            { samples: gyroHist.y, color: "#3D7F94", label: "y" },
            { samples: gyroHist.z, color: "#E6B441", label: "z" },
          ]}
        />
      </View>
      <XyzRow
        values={[["x", gyro?.x ?? null], ["y", gyro?.y ?? null], ["z", gyro?.z ?? null]]}
        digits={3}
        theme={theme}
      />

      <Text style={styles.sectionTitle}>Magnetometer</Text>
      <View style={[styles.card, { padding: 6, marginBottom: 4 }]}>
        <MultiSparkline
          lines={[
            { samples: magHist.x, color: "#E25448", label: "x" },
            { samples: magHist.y, color: "#3D7F94", label: "y" },
            { samples: magHist.z, color: "#E6B441", label: "z" },
          ]}
        />
      </View>
      <XyzRow
        values={[["x", mag?.x ?? null], ["y", mag?.y ?? null], ["z", mag?.z ?? null]]}
        digits={1}
        theme={theme}
      />

      <Text style={styles.sectionTitle}>Device Motion (fused)</Text>
      <View style={[styles.card, { padding: 12, marginBottom: 4, flexDirection: "row", justifyContent: "space-around", alignItems: "center" }]}>
        <TiltIndicator
          pitchDeg={motion?.rotation ? (motion.rotation.beta * 180) / Math.PI : 0}
          rollDeg={motion?.rotation ? (motion.rotation.gamma * 180) / Math.PI : 0}
          color={theme.primary}
        />
        <CompassArrow
          headingDeg={motion?.rotation ? (motion.rotation.alpha * 180) / Math.PI : 0}
          color={theme.primary}
        />
      </View>
      <Text style={{ fontSize: 10, fontWeight: "600", color: theme.textSubtle, textTransform: "uppercase", marginLeft: 4, marginBottom: 4 }}>Rotation (°)</Text>
      <XyzRow
        values={[
          ["pitch", motion?.rotation ? (motion.rotation.beta * 180) / Math.PI : null],
          ["roll", motion?.rotation ? (motion.rotation.gamma * 180) / Math.PI : null],
          ["yaw", motion?.rotation ? (motion.rotation.alpha * 180) / Math.PI : null],
        ]}
        digits={1}
        theme={theme}
      />
      <Text style={{ fontSize: 10, fontWeight: "600", color: theme.textSubtle, textTransform: "uppercase", marginLeft: 4, marginBottom: 4 }}>Gravity</Text>
      <View style={[styles.card, { padding: 6, marginBottom: 4 }]}>
        <MultiSparkline
          lines={[
            { samples: gravityHist.x, color: "#E25448", label: "x" },
            { samples: gravityHist.y, color: "#3D7F94", label: "y" },
            { samples: gravityHist.z, color: "#E6B441", label: "z" },
          ]}
        />
      </View>
      <XyzRow
        values={[
          ["x", motion?.accelerationIncludingGravity?.x ?? null],
          ["y", motion?.accelerationIncludingGravity?.y ?? null],
          ["z", motion?.accelerationIncludingGravity?.z ?? null],
        ]}
        digits={3}
        theme={theme}
      />
      <Text style={{ fontSize: 10, fontWeight: "600", color: theme.textSubtle, textTransform: "uppercase", marginLeft: 4, marginBottom: 4 }}>User acceleration</Text>
      <View style={[styles.card, { padding: 6, marginBottom: 4 }]}>
        <MultiSparkline
          lines={[
            { samples: userAccelHist.x, color: "#E25448", label: "x" },
            { samples: userAccelHist.y, color: "#3D7F94", label: "y" },
            { samples: userAccelHist.z, color: "#E6B441", label: "z" },
          ]}
        />
      </View>
      <XyzRow
        values={[
          ["x", motion?.acceleration?.x ?? null],
          ["y", motion?.acceleration?.y ?? null],
          ["z", motion?.acceleration?.z ?? null],
        ]}
        digits={3}
        theme={theme}
      />

      {(() => {
        const wrap180 = (d: number) => {
          let x = d;
          while (x > 180) x -= 360;
          while (x < -180) x += 360;
          return x;
        };
        const dPitch = motion?.rotation && motionZero ? wrap180(((motion.rotation.beta - motionZero.beta) * 180) / Math.PI) : 0;
        const dRoll = motion?.rotation && motionZero ? wrap180(((motion.rotation.gamma - motionZero.gamma) * 180) / Math.PI) : 0;
        const dYaw = motion?.rotation && motionZero ? wrap180(((motion.rotation.alpha - motionZero.alpha) * 180) / Math.PI) : 0;
        return (
          <View style={[styles.card, { padding: 14, marginBottom: 4 }]}>
            <Text style={{ fontSize: 11, fontWeight: "600", color: theme.textSubtle, textTransform: "uppercase", marginBottom: 10 }}>
              Relative orientation
            </Text>
            <View style={{ flexDirection: "row", justifyContent: "space-around", alignItems: "center", marginBottom: 12 }}>
              <TiltIndicator pitchDeg={dPitch} rollDeg={dRoll} color={theme.highlight} size={80} />
              <CompassArrow headingDeg={dYaw} color={theme.highlight} size={64} />
            </View>
            <View style={{ flexDirection: "row", justifyContent: "space-around", marginBottom: 10 }}>
              {[
                { label: "Δ pitch", value: dPitch },
                { label: "Δ roll", value: dRoll },
                { label: "Δ yaw", value: dYaw },
              ].map((d) => (
                <View key={d.label} style={{ alignItems: "center" }}>
                  <Text style={{ fontSize: 11, color: theme.textSubtle, fontWeight: "600", textTransform: "uppercase" }}>{d.label}</Text>
                  <Text style={{ fontSize: 18, fontWeight: "700", color: motionZero ? theme.text : theme.textSubtle, marginTop: 2 }}>
                    {motionZero ? fmt(d.value, 1) : "—"}°
                  </Text>
                </View>
              ))}
            </View>
            <Pressable
              onPress={() => motion?.rotation && setMotionZero({ alpha: motion.rotation.alpha, beta: motion.rotation.beta, gamma: motion.rotation.gamma })}
              style={{
                paddingVertical: 10,
                borderRadius: 8,
                alignItems: "center",
                backgroundColor: theme.surfaceAlt,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: theme.border,
              }}
            >
              <Text style={{ fontSize: 13, fontWeight: "600", color: theme.primary }}>
                {motionZero ? "Re-zero" : "Zero here"}
              </Text>
            </Pressable>
          </View>
        );
      })()}

      <View style={[styles.card, { padding: 14, marginBottom: 4 }]}>
        <Text style={{ fontSize: 11, fontWeight: "600", color: theme.textSubtle, textTransform: "uppercase", marginBottom: 4 }}>
          Position (double-integrated)
        </Text>
        <Text style={{ fontSize: 11, color: theme.textSubtle, marginBottom: 10, fontStyle: "italic" }}>
          Drifts fast — sensor noise compounds. Tap reset often.
        </Text>
        <View style={{ flexDirection: "row", justifyContent: "space-around", marginBottom: 12 }}>
          {[
            { label: "Δ x", value: posDisplay.x },
            { label: "Δ y", value: posDisplay.y },
            { label: "Δ z", value: posDisplay.z },
          ].map((d) => (
            <View key={d.label} style={{ alignItems: "center" }}>
              <Text style={{ fontSize: 11, color: theme.textSubtle, fontWeight: "600", textTransform: "uppercase" }}>{d.label}</Text>
              <Text style={{ fontSize: 18, fontWeight: "700", color: posTracking ? theme.text : theme.textSubtle, marginTop: 2 }}>
                {posTracking ? `${(d.value * 100).toFixed(1)} cm` : "—"}
              </Text>
            </View>
          ))}
        </View>
        <Text style={{ fontSize: 12, color: theme.textMuted, textAlign: "center", marginBottom: 10 }}>
          velocity magnitude: {posTracking ? `${posDisplay.vmag.toFixed(3)} m/s` : "—"}
        </Text>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Pressable
            onPress={() => setPosTracking((p) => !p)}
            style={{
              flex: 1,
              paddingVertical: 10,
              borderRadius: 8,
              alignItems: "center",
              backgroundColor: posTracking ? theme.destructive : theme.primary,
            }}
          >
            <Text style={{ fontSize: 13, fontWeight: "600", color: "#fff" }}>
              {posTracking ? "Stop" : "Start tracking"}
            </Text>
          </Pressable>
          {posTracking && (
            <Pressable
              onPress={resetPosition}
              style={{
                flex: 1,
                paddingVertical: 10,
                borderRadius: 8,
                alignItems: "center",
                backgroundColor: theme.surfaceAlt,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: theme.border,
              }}
            >
              <Text style={{ fontSize: 13, fontWeight: "600", color: theme.primary }}>Reset</Text>
            </Pressable>
          )}
        </View>
      </View>
      </>)}

      {labTab === "sensors" && (<>
      <Text style={styles.sectionTitle}>Weather (Open-Meteo)</Text>
      <View style={[styles.card, { padding: 14, marginBottom: 4 }]}>
        {weather ? (
          (() => {
            const wl = weatherLabel(weather.current.weatherCode);
            return (
              <>
                <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 8 }}>
                  <Text style={{ fontSize: 40 }}>{wl.emoji}</Text>
                  <View style={{ flex: 1, marginLeft: 12 }}>
                    <Text style={{ fontSize: 28, fontWeight: "700", color: theme.text, fontVariant: ["tabular-nums"] }}>
                      {weather.current.temperature.toFixed(0)}°F
                    </Text>
                    <Text style={{ fontSize: 13, color: theme.textSubtle }}>
                      Feels {weather.current.apparentTemperature.toFixed(0)}° · {wl.label}
                    </Text>
                  </View>
                </View>
                <View style={{ flexDirection: "row", justifyContent: "space-around", marginBottom: 4 }}>
                  <View style={{ alignItems: "center" }}>
                    <Text style={{ fontSize: 10, color: theme.textSubtle, fontWeight: "600", textTransform: "uppercase" }}>Humidity</Text>
                    <Text style={{ fontSize: 14, color: theme.text, fontVariant: ["tabular-nums"] }}>{weather.current.humidity}%</Text>
                  </View>
                  <View style={{ alignItems: "center" }}>
                    <Text style={{ fontSize: 10, color: theme.textSubtle, fontWeight: "600", textTransform: "uppercase" }}>Wind</Text>
                    <Text style={{ fontSize: 14, color: theme.text, fontVariant: ["tabular-nums"] }}>{weather.current.windSpeed.toFixed(0)} mph</Text>
                  </View>
                </View>
              </>
            );
          })()
        ) : (
          <Text style={{ fontSize: 13, color: theme.textSubtle, textAlign: "center" }}>
            {weatherErr ? `Error: ${weatherErr}` : "Tap below to fetch."}
          </Text>
        )}
        <Pressable
          onPress={fetchWeather}
          disabled={weatherLoading}
          style={{ marginTop: 10, paddingVertical: 10, borderRadius: 8, alignItems: "center", backgroundColor: theme.primary, opacity: weatherLoading ? 0.6 : 1 }}
        >
          <Text style={{ color: "#fff", fontSize: 13, fontWeight: "600" }}>
            {weatherLoading ? "Fetching…" : weather ? "Refresh" : "Fetch weather"}
          </Text>
        </Pressable>
        {weather && (
          <Text style={{ fontSize: 10, color: theme.textSubtle, marginTop: 4, textAlign: "right" }}>
            {Math.round((Date.now() - weather.fetchedAt) / 1000)} s ago · {weather.placeLat.toFixed(3)}, {weather.placeLon.toFixed(3)}
          </Text>
        )}
      </View>
      {weather && weather.hourly.length > 0 && (
        <View style={[styles.card, { padding: 12, marginBottom: 16 }]}>
          <Text style={{ fontSize: 11, fontWeight: "600", color: theme.textSubtle, textTransform: "uppercase", marginBottom: 6 }}>
            Next 24 hours
          </Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            {weather.hourly.map((h, i) => {
              const d = new Date(h.time);
              const hour = d.getHours();
              const label = hour === 0 ? "12a" : hour < 12 ? `${hour}a` : hour === 12 ? "12p" : `${hour - 12}p`;
              return (
                <View key={i} style={{ alignItems: "center", paddingHorizontal: 8, minWidth: 44 }}>
                  <Text style={{ fontSize: 10, color: theme.textSubtle }}>{label}</Text>
                  <Text style={{ fontSize: 13, color: theme.text, fontVariant: ["tabular-nums"], marginVertical: 2 }}>
                    {h.temperature.toFixed(0)}°
                  </Text>
                  <Text style={{ fontSize: 9, color: h.precipProb > 30 ? theme.primary : theme.textSubtle, fontVariant: ["tabular-nums"] }}>
                    {h.precipProb}%
                  </Text>
                </View>
              );
            })}
          </ScrollView>
        </View>
      )}

      <Text style={styles.sectionTitle}>Barometer</Text>
      <View style={[styles.card, { padding: 6, marginBottom: 4, position: "relative" }]}>
        <Sparkline samples={pressureHist} color={theme.accent} height={48} />
        {pressure && (
          <Text
            style={{
              position: "absolute",
              top: 6,
              right: 10,
              fontSize: 10,
              fontWeight: "600",
              color: theme.textSubtle,
            }}
          >
            {(pressure.pressure * 0.0145038).toFixed(3)} psi
          </Text>
        )}
      </View>
      <View style={[styles.card, { padding: 14, marginBottom: 4 }]}>
        <Text style={{ fontSize: 11, fontWeight: "600", color: theme.textSubtle, textTransform: "uppercase", marginBottom: 6 }}>
          Relative altitude
        </Text>
        <Text style={{ fontSize: 28, fontWeight: "700", color: theme.text, marginBottom: 10 }}>
          {pressure?.relativeAltitude != null
            ? formatAltitude(pressure.relativeAltitude - altZero, altUnit)
            : "—"}
        </Text>
        <View style={{ flexDirection: "row", gap: 6, marginBottom: 10 }}>
          {ALT_UNITS.map((u) => {
            const active = altUnit === u.value;
            return (
              <Pressable
                key={u.value}
                onPress={() => setAltUnit(u.value)}
                style={{
                  flex: 1,
                  paddingVertical: 8,
                  borderRadius: 8,
                  alignItems: "center",
                  backgroundColor: active ? theme.primary : theme.surfaceAlt,
                  borderWidth: active ? 0 : StyleSheet.hairlineWidth,
                  borderColor: theme.border,
                }}
              >
                <Text style={{ fontSize: 13, fontWeight: "600", color: active ? "#fff" : theme.text }}>{u.label}</Text>
              </Pressable>
            );
          })}
        </View>
        <Pressable
          onPress={() => setAltZero(pressure?.relativeAltitude ?? 0)}
          style={{
            paddingVertical: 10,
            borderRadius: 8,
            alignItems: "center",
            backgroundColor: theme.surfaceAlt,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: theme.border,
          }}
        >
          <Text style={{ fontSize: 13, fontWeight: "600", color: theme.primary }}>
            Zero here
          </Text>
        </Pressable>
      </View>
      <Section
        title=""
        rows={[
          { label: "Available", value: baroAvailable },
          { label: "Pressure (hPa)", value: pressure ? fmt(pressure.pressure, 2) : null },
          { label: "Raw rel. alt. (m)", value: pressure?.relativeAltitude != null ? fmt(pressure.relativeAltitude, 4) : null },
        ]}
      />
      </>)}

      {labTab === "sensors" && (<>
      <Text style={styles.sectionTitle}>Pedometer</Text>
      <View style={[styles.card, { padding: 14, marginBottom: 4 }]}>
        <BarGauge value={stepsToday ?? 0} max={10000} color={theme.primary} />
        <Text style={{ marginTop: 6, fontSize: 12, color: theme.textMuted, textAlign: "right" }}>
          {(stepsToday ?? 0).toLocaleString()} / 10,000 steps
        </Text>
      </View>
      <Section
        title=""
        rows={[
          { label: "Available", value: pedAvailable },
          { label: "Steps today", value: stepsToday },
          { label: "Steps since open", value: liveSteps },
        ]}
      />
      </>)}

      {labTab === "device" && (<>
      <Text style={styles.sectionTitle}>Battery</Text>
      <View style={[styles.card, { padding: 14, marginBottom: 4 }]}>
        <BarGauge
          value={battery?.level ?? 0}
          max={1}
          color={
            battery == null
              ? theme.textSubtle
              : battery.level < 0.2
                ? theme.destructive
                : battery.level < 0.4
                  ? theme.warning
                  : theme.primary
          }
          height={18}
        />
        <Text style={{ marginTop: 6, fontSize: 12, color: theme.textMuted, textAlign: "right" }}>
          {battery ? `${Math.round(battery.level * 100)}%${battery.state === Battery.BatteryState.CHARGING ? " · charging" : battery.lowPower ? " · low power" : ""}` : "—"}
        </Text>
      </View>
      <Section
        title=""
        rows={[
          { label: "State", value: battery ? batteryStateLabel(battery.state) : null },
          { label: "Low power mode", value: battery?.lowPower },
        ]}
      />
      </>)}

      {labTab === "vision" && <VisionTab theme={theme} styles={styles} pressure={pressure} />}

      {labTab === "audio" && (<>
      <Text style={styles.sectionTitle}>Microphone</Text>
      <View style={[styles.card, { padding: 6, marginBottom: 4 }]}>
        <Sparkline samples={micHist} color={theme.highlight} height={56} />
      </View>
      <View style={[styles.card, { padding: 14, marginBottom: 4 }]}>
        <BarGauge value={micLevel ?? 0} max={1} color={theme.highlight} height={14} />
        <Text style={{ marginTop: 6, fontSize: 12, color: theme.textMuted, textAlign: "right" }}>
          {micRecording
            ? `${Math.round((micLevel ?? 0) * 100)}% · peak ${Math.round(micPeak * 100)}%`
            : micStatus}
        </Text>
        <Pressable
          style={[styles.btn, { marginTop: 10, marginBottom: 0 }]}
          onPress={micRecording ? stopMic : startMic}
        >
          <Text style={styles.btnText}>{micRecording ? "Stop listening" : "Start listening"}</Text>
        </Pressable>
      </View>
      </>)}

      {labTab === "sensors" && (<>
      <Text style={styles.sectionTitle}>Location</Text>
      <View style={[styles.card, { padding: 12, marginBottom: 4, flexDirection: "row", justifyContent: "space-around", alignItems: "center" }]}>
        <CompassArrow
          headingDeg={loc?.coords.heading ?? 0}
          color={theme.primary}
          size={70}
        />
        <View style={{ flex: 1, marginLeft: 16 }}>
          <Text style={{ fontSize: 11, color: theme.textSubtle, fontWeight: "600", textTransform: "uppercase" }}>Speed (m/s)</Text>
          <Sparkline samples={speedHist} color={theme.primary} height={28} />
          <Text style={{ fontSize: 11, color: theme.textSubtle, fontWeight: "600", textTransform: "uppercase", marginTop: 6 }}>Altitude (m)</Text>
          <Sparkline samples={altHist} color={theme.accent} height={28} />
        </View>
      </View>
      <Section
        title=""
        rows={[
          { label: "Status", value: locStatus },
          { label: "Latitude", value: loc ? fmt(loc.coords.latitude, 5) : null },
          { label: "Longitude", value: loc ? fmt(loc.coords.longitude, 5) : null },
          { label: "Accuracy (m)", value: loc?.coords.accuracy != null ? fmt(loc.coords.accuracy, 1) : null },
          { label: "Altitude (m)", value: loc?.coords.altitude != null ? fmt(loc.coords.altitude, 1) : null },
          { label: "Heading (°)", value: loc?.coords.heading != null ? fmt(loc.coords.heading, 1) : null },
          { label: "Speed (m/s)", value: loc?.coords.speed != null ? fmt(loc.coords.speed, 2) : null },
        ]}
      />
      <View style={{ flexDirection: "row", gap: 8, marginBottom: 8 }}>
        <Pressable
          style={[styles.btn, { flex: 1, marginBottom: 0 }]}
          onPress={locWatching ? stopWatchingLocation : startWatchingLocation}
        >
          <Text style={styles.btnText}>{locWatching ? "Stop streaming" : "Start streaming"}</Text>
        </Pressable>
        <Pressable
          style={[styles.btn, { flex: 1, marginBottom: 0, backgroundColor: theme.surfaceAlt, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.border }]}
          onPress={requestLocation}
        >
          <Text style={[styles.btnText, { color: theme.primary }]}>One reading</Text>
        </Pressable>
      </View>
      <Pressable
        onPress={() => { if (!locWatching) setLocBackground((b) => !b); }}
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingVertical: 10,
          paddingHorizontal: 12,
          borderRadius: 8,
          backgroundColor: theme.surfaceAlt,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: theme.border,
          marginBottom: 8,
          opacity: locWatching ? 0.5 : 1,
        }}
      >
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 13, fontWeight: "600", color: theme.text }}>Allow background</Text>
          <Text style={{ fontSize: 11, color: theme.textSubtle, marginTop: 2 }}>
            Keeps streaming when you leave the app. Requires "Always" permission.
          </Text>
        </View>
        <View style={{
          width: 44, height: 24, borderRadius: 12,
          backgroundColor: locBackground ? theme.primary : theme.border,
          padding: 2, justifyContent: "center",
        }}>
          <View style={{
            width: 20, height: 20, borderRadius: 10, backgroundColor: "#fff",
            alignSelf: locBackground ? "flex-end" : "flex-start",
          }} />
        </View>
      </Pressable>
      {locBackground && (
        <View style={[styles.card, { padding: 12, marginBottom: 20 }]}>
          <Text style={{ fontSize: 11, fontWeight: "600", color: theme.textSubtle, textTransform: "uppercase", marginBottom: 6 }}>
            Background buffer
          </Text>
          <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 4 }}>
            <Text style={{ fontSize: 13, color: theme.text }}>Points received</Text>
            <Text style={{ fontSize: 13, color: theme.text, fontVariant: ["tabular-nums"], fontWeight: "600" }}>{bgLocCount}</Text>
          </View>
          {bgLocLast && (
            <>
              <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 4 }}>
                <Text style={{ fontSize: 13, color: theme.text }}>Last point</Text>
                <Text style={{ fontSize: 13, color: theme.text, fontVariant: ["tabular-nums"] }}>
                  {fmt(bgLocLast.lat, 5)}, {fmt(bgLocLast.lon, 5)}
                </Text>
              </View>
              <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                <Text style={{ fontSize: 13, color: theme.text }}>Age</Text>
                <Text style={{ fontSize: 13, color: theme.text, fontVariant: ["tabular-nums"] }}>
                  {Math.round((Date.now() - bgLocLast.ts) / 1000)} s ago
                </Text>
              </View>
            </>
          )}
          <Text style={{ fontSize: 11, color: theme.textSubtle, marginTop: 8 }}>
            Lock the phone, walk around, come back — count should keep climbing.
          </Text>
        </View>
      )}
      </>)}

      {labTab === "device" && (<>
      <Text style={styles.sectionTitle}>Haptics (expo-haptics)</Text>
      <View style={[styles.card, { padding: 8 }]}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {(["light", "medium", "heavy", "success", "warning", "error"] as const).map((k) => (
            <Pressable
              key={k}
              style={styles.hapBtn}
              onPress={() => fireHaptic(k)}
            >
              <Text style={styles.hapBtnText}>{k}</Text>
            </Pressable>
          ))}
        </View>
      </View>
      </>)}

      {labTab === "sensors" && (<>
      <Section
        title="Network"
        rows={[
          { label: "Is connected", value: network?.isConnected },
          { label: "Is internet reachable", value: network?.isInternetReachable },
          { label: "Type", value: network?.type ?? null },
        ]}
      />

      <Section
        title="Cellular"
        rows={[
          { label: "Carrier", value: cellular?.carrier },
          { label: "Generation", value: cellular?.generation != null ? generationLabel(cellular.generation) : null },
          { label: "ISO country", value: cellular?.isoCountryCode },
          { label: "MCC", value: cellular?.mobileCountryCode },
          { label: "MNC", value: cellular?.mobileNetworkCode },
          { label: "Allows VOIP", value: cellular?.allowsVoip },
        ]}
      />
      </>)}

      {labTab === "device" && (<>
      <Text style={styles.sectionTitle}>Brightness</Text>
      <View style={[styles.card, { padding: 14, marginBottom: 4 }]}>
        <BarGauge value={brightness ?? 0} max={1} color={theme.accent} height={16} />
        <Text style={{ marginTop: 6, fontSize: 12, color: theme.textMuted, textAlign: "right" }}>
          {brightness != null ? `${Math.round(brightness * 100)}%` : "—"}
        </Text>
        <View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}>
          {[-0.2, -0.05, 0.05, 0.2].map((d) => (
            <Pressable
              key={d}
              onPress={() => adjustBrightness(d)}
              style={{ flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: "center", backgroundColor: theme.surfaceAlt, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.border }}
            >
              <Text style={{ fontSize: 13, fontWeight: "600", color: theme.text }}>{d > 0 ? `+${Math.round(d * 100)}%` : `${Math.round(d * 100)}%`}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      <Section
        title="Screen orientation"
        rows={[{ label: "Current", value: orientation != null ? orientationLabel(orientation) : null }]}
      />

      <Text style={styles.sectionTitle}>Clipboard (expo-clipboard)</Text>
      <View style={[styles.card, { padding: 14, marginBottom: 4 }]}>
        <Text style={{ fontSize: 13, color: theme.text, marginBottom: 10 }}>
          {clipboardSnap || "(tap Read to see current clipboard)"}
        </Text>
        <Pressable style={styles.btn} onPress={refreshClipboard}>
          <Text style={styles.btnText}>Read clipboard</Text>
        </Pressable>
      </View>
      </>)}

      {labTab === "sensors" && (<>
      <Text style={styles.sectionTitle}>Bluetooth (BLE scan)</Text>
      <View style={[styles.card, { padding: 14, marginBottom: 4 }]}>
        {bleSelectedId ? (() => {
          const d = bleDevices.get(bleSelectedId);
          return (
            <>
              <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 12 }}>
                <Pressable
                  onPress={closeBleDetail}
                  style={{ paddingVertical: 6, paddingHorizontal: 10, borderRadius: 6, backgroundColor: theme.surfaceAlt, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.border, marginRight: 12 }}
                >
                  <Text style={{ fontSize: 13, fontWeight: "600", color: theme.primary }}>‹ Back</Text>
                </Pressable>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 15, fontWeight: "700", color: theme.text }} numberOfLines={1}>
                    {d?.name || d?.localName || "(no name)"}
                  </Text>
                  <Text style={{ fontSize: 10, color: theme.textSubtle }} numberOfLines={1}>{bleSelectedId}</Text>
                </View>
                <Text style={{ fontSize: 16, fontWeight: "700", color: rssiColor(d?.rssi ?? null, theme), marginLeft: 8 }}>
                  {d?.rssi != null ? `${d.rssi}` : "—"}
                </Text>
              </View>

              <Sparkline samples={bleRssiHist} color={theme.primary} height={140} />
              <Text style={{ fontSize: 11, color: theme.textSubtle, marginTop: 6, marginBottom: 16, textAlign: "right" }}>
                {bleRssiHist.length} samples · {bleScanning ? "live" : "scan stopped"}
              </Text>

              <Section
                title=""
                rows={[
                  { label: "Name", value: d?.name },
                  { label: "Local name", value: d?.localName },
                  { label: "RSSI (dBm)", value: d?.rssi },
                  { label: "TX power (dBm)", value: d?.txPowerLevel },
                  { label: "Is connectable", value: d?.isConnectable },
                  { label: "Manufacturer data (b64)", value: d?.manufacturerData },
                  { label: "Service UUIDs", value: d?.serviceUUIDs ? d.serviceUUIDs.join(", ") : null },
                  { label: "Last seen", value: d ? new Date(d.seenAt).toLocaleTimeString() : null },
                ]}
              />
            </>
          );
        })() : (
          <>
            <Text style={{ fontSize: 12, color: theme.textMuted, marginBottom: 8 }}>
              State: {bleState}{bleScanning ? " · scanning" : ""}
            </Text>
            <Pressable
              onPress={bleScanning ? stopBleScan : startBleScan}
              style={{ paddingVertical: 10, borderRadius: 8, alignItems: "center", backgroundColor: bleScanning ? theme.destructive : theme.primary, marginBottom: 10 }}
            >
              <Text style={{ color: "#fff", fontSize: 13, fontWeight: "600" }}>
                {bleScanning ? "Stop scan" : "Start scan"}
              </Text>
            </Pressable>
            <View style={{ flexDirection: "row", gap: 6, marginBottom: 10 }}>
              {(["signal", "name"] as const).map((s) => {
                const active = bleSortBy === s;
                return (
                  <Pressable
                    key={s}
                    onPress={() => setBleSortBy(s)}
                    style={{
                      flex: 1,
                      paddingVertical: 6,
                      borderRadius: 6,
                      alignItems: "center",
                      backgroundColor: active ? theme.primary : theme.surfaceAlt,
                      borderWidth: active ? 0 : StyleSheet.hairlineWidth,
                      borderColor: theme.border,
                    }}
                  >
                    <Text style={{ fontSize: 12, fontWeight: "600", color: active ? "#fff" : theme.text }}>
                      Sort by {s === "signal" ? "signal" : "name"}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            {Array.from(bleDevices.values())
              .sort((a, b) => {
                if (bleSortBy === "signal") return (b.rssi ?? -999) - (a.rssi ?? -999);
                const an = (a.name || a.localName || a.id).toLowerCase();
                const bn = (b.name || b.localName || b.id).toLowerCase();
                return an < bn ? -1 : an > bn ? 1 : 0;
              })
              .slice(0, 30)
              .map((d) => (
                <Pressable
                  key={d.id}
                  onPress={() => selectBleDevice(d.id)}
                  style={{ flexDirection: "row", paddingVertical: 6, alignItems: "center", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border }}
                >
                  <View style={{ flex: 1, marginRight: 8 }}>
                    <Text style={{ color: theme.text, fontSize: 13 }} numberOfLines={1}>{d.name || d.localName || "(no name)"}</Text>
                    <Text style={{ color: theme.textSubtle, fontSize: 10 }} numberOfLines={1}>{d.id}</Text>
                  </View>
                  <Text style={{ color: rssiColor(d.rssi, theme), fontSize: 13, fontWeight: "700" }}>
                    {d.rssi != null ? `${d.rssi} dBm` : "—"}
                  </Text>
                </Pressable>
              ))}
          </>
        )}
      </View>
      </>)}

      {labTab === "device" && <GameControllerSection theme={theme} styles={styles} />}

      {labTab === "sensors" && (<>
      <Text style={styles.sectionTitle}>HealthKit</Text>
      <View style={[styles.card, { padding: 14, marginBottom: 4 }]}>
        <Text style={{ fontSize: 13, color: theme.textMuted }}>
          Apple Watch + HealthKit data deferred until the EAS provisioning profile is sorted. Re-enable in a follow-up.
        </Text>
      </View>
      </>)}

      {labTab === "sensors" && (<>
      <Text style={styles.sectionTitle}>NFC</Text>
      <View style={[styles.card, { padding: 14, marginBottom: 4 }]}>
        <Text style={{ fontSize: 13, color: theme.textMuted }}>
          NFC tag reading deferred until the EAS provisioning profile is sorted. Re-enable in a follow-up.
        </Text>
      </View>
      </>)}

      {labTab === "audio" && (<>
      <Text style={styles.sectionTitle}>Microphone spectrum</Text>
      <Pressable
        onPress={() => setSpectrumFullscreen(true)}
        style={[styles.card, { padding: 6, marginBottom: 4 }]}
      >
        <SpectrumBars samples={spectrum} peaks={peaks} height={90} bandEdges={bandEdgesRef.current} sampleRate={SAMPLE_RATE} fftSize={fftSize} />
        <Text style={{ position: "absolute", top: 8, right: 10, fontSize: 9, fontWeight: "600", color: theme.textSubtle, opacity: 0.7 }}>
          TAP TO FULLSCREEN
        </Text>
      </Pressable>
      <View style={[styles.card, { padding: 14, marginBottom: 4 }]}>
        <View style={{ flexDirection: "row", gap: 6, marginBottom: 8 }}>
          {(["notes", "linear"] as const).map((s) => {
            const active = spectrumScale === s;
            return (
              <Pressable
                key={s}
                onPress={() => setSpectrumScale(s)}
                style={{
                  flex: 1,
                  paddingVertical: 8,
                  borderRadius: 8,
                  alignItems: "center",
                  backgroundColor: active ? theme.primary : theme.surfaceAlt,
                  borderWidth: active ? 0 : StyleSheet.hairlineWidth,
                  borderColor: theme.border,
                }}
              >
                <Text style={{ fontSize: 13, fontWeight: "600", color: active ? "#fff" : theme.text }}>
                  {s === "notes" ? "Notes" : "Linear"}
                </Text>
              </Pressable>
            );
          })}
        </View>
        <View style={{ flexDirection: "row", gap: 6, marginBottom: 10 }}>
          {([4096, 8192] as const).map((sz) => {
            const active = fftSize === sz;
            return (
              <Pressable
                key={sz}
                onPress={() => !spectrumOn && setFftSize(sz)}
                disabled={spectrumOn}
                style={{
                  flex: 1,
                  paddingVertical: 8,
                  borderRadius: 8,
                  alignItems: "center",
                  backgroundColor: active ? theme.primary : theme.surfaceAlt,
                  borderWidth: active ? 0 : StyleSheet.hairlineWidth,
                  borderColor: theme.border,
                  opacity: spectrumOn && !active ? 0.4 : 1,
                }}
              >
                <Text style={{ fontSize: 13, fontWeight: "600", color: active ? "#fff" : theme.text }}>
                  {sz}-pt FFT
                </Text>
              </Pressable>
            );
          })}
        </View>

        <RangeSlider
          label="Frequency"
          minValue={freqMin}
          maxValue={freqMax}
          onChange={(lo, hi) => {
            const newLo = Math.max(10, Math.min(hi / 1.05, lo));
            const newHi = Math.max(newLo * 1.05, Math.min(22000, hi));
            setFreqMin(newLo);
            setFreqMax(newHi);
          }}
          min={10}
          max={22000}
          log
          format={(v) => v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${v.toFixed(v < 100 ? 1 : 0)}`}
          theme={theme}
        />
        <RangeSlider
          label="dB range"
          minValue={dbFloor}
          maxValue={dbCeil}
          onChange={(lo, hi) => {
            const newLo = Math.round(Math.max(-160, Math.min(hi - 10, lo)));
            const newHi = Math.round(Math.max(newLo + 10, Math.min(20, hi)));
            setDbFloor(newLo);
            setDbCeil(newHi);
          }}
          min={-160}
          max={20}
          format={(v) => `${Math.round(v)}`}
          theme={theme}
        />

        <Pressable
          onPress={spectrumOn ? stopSpectrum : startSpectrum}
          style={{ paddingVertical: 10, borderRadius: 8, alignItems: "center", backgroundColor: spectrumOn ? theme.destructive : theme.primary, marginTop: 8 }}
        >
          <Text style={{ color: "#fff", fontSize: 13, fontWeight: "600" }}>
            {spectrumOn ? "Stop" : "Start"} spectrum
          </Text>
        </Pressable>
        <Text style={{ marginTop: 6, fontSize: 11, color: theme.textSubtle, textAlign: "center" }}>
          96 bands · {spectrumScale === "notes" ? "log" : "linear"} {fmtHz(freqMin)} – {fmtHz(freqMax)} · {(SAMPLE_RATE / fftSize).toFixed(1)} Hz/bin · dBFS {dbFloor}…{dbCeil}
        </Text>
      </View>
      </>)}

      <Modal
        visible={spectrumFullscreen}
        animationType="fade"
        onRequestClose={() => setSpectrumFullscreen(false)}
        supportedOrientations={["portrait", "landscape", "landscape-left", "landscape-right"]}
      >
        <View style={{ flex: 1, backgroundColor: theme.background, justifyContent: "center", padding: 12 }}>
          <SpectrumBars
            samples={spectrum}
            peaks={peaks}
            height={Math.max(200, winH - 110)}
            bandEdges={bandEdgesRef.current}
            sampleRate={SAMPLE_RATE}
            fftSize={fftSize}
          />
          <Text style={{ marginTop: 12, fontSize: 12, color: theme.textSubtle, textAlign: "center" }}>
            {fmtHz(freqMin)} – {fmtHz(freqMax)} · dBFS {dbFloor}…{dbCeil} · {spectrumScale}
            {winW > winH ? " · landscape" : ""}
          </Text>
          <Pressable
            onPress={() => setSpectrumFullscreen(false)}
            style={{ marginTop: 12, paddingVertical: 10, borderRadius: 10, alignItems: "center", backgroundColor: theme.primary }}
          >
            <Text style={{ color: "#fff", fontSize: 14, fontWeight: "600" }}>Close</Text>
          </Pressable>
        </View>
      </Modal>
    </>
  );
}

function fmtHz(hz: number): string {
  if (hz >= 1000) return `${(hz / 1000).toFixed(hz < 10000 ? 1 : 0)} kHz`;
  return `${hz < 100 ? hz.toFixed(1) : hz.toFixed(0)} Hz`;
}

function RangeSlider({
  label,
  minValue,
  maxValue,
  onChange,
  min,
  max,
  log = false,
  format,
  theme,
}: {
  label: string;
  minValue: number;
  maxValue: number;
  onChange: (lo: number, hi: number) => void;
  min: number;
  max: number;
  log?: boolean;
  format: (v: number) => string;
  theme: Theme;
}) {
  const [width, setWidth] = useState(0);
  const activeRef = useRef<"min" | "max" | null>(null);

  const valueToRatio = (v: number) => {
    if (log) return Math.log(v / min) / Math.log(max / min);
    return (v - min) / (max - min);
  };
  const ratioToValue = (r: number) => {
    const c = Math.max(0, Math.min(1, r));
    if (log) return min * Math.pow(max / min, c);
    return min + (max - min) * c;
  };

  const minR = Math.max(0, Math.min(1, valueToRatio(minValue)));
  const maxR = Math.max(0, Math.min(1, valueToRatio(maxValue)));

  const onStart = (e: { nativeEvent: { locationX: number } }) => {
    if (width <= 0) return;
    const x = e.nativeEvent.locationX;
    const minX = minR * width;
    const maxX = maxR * width;
    activeRef.current = Math.abs(x - minX) < Math.abs(x - maxX) - 0.5 ? "min" : "max";
    onMove(e);
  };

  const onMove = (e: { nativeEvent: { locationX: number } }) => {
    if (!activeRef.current || width <= 0) return;
    const r = Math.max(0, Math.min(1, e.nativeEvent.locationX / width));
    const v = ratioToValue(r);
    if (activeRef.current === "min") {
      onChange(Math.min(v, maxValue), maxValue);
    } else {
      onChange(minValue, Math.max(v, minValue));
    }
  };

  const trackHeight = 32;
  const thumbSize = 22;

  return (
    <View style={{ marginBottom: 10 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 4 }}>
        <Text style={{ fontSize: 12, color: theme.textMuted }}>{label}</Text>
        <Text style={{ fontSize: 13, fontWeight: "600", color: theme.text }}>
          {format(minValue)} → {format(maxValue)}
        </Text>
      </View>
      <View
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderGrant={onStart}
        onResponderMove={onMove}
        onResponderRelease={() => { activeRef.current = null; }}
        style={{ height: trackHeight, justifyContent: "center" }}
      >
        <View style={{ height: 4, borderRadius: 2, backgroundColor: "rgba(127,127,127,0.25)" }} />
        <View
          style={{
            position: "absolute",
            left: minR * width,
            top: trackHeight / 2 - 2,
            width: Math.max(0, (maxR - minR) * width),
            height: 4,
            borderRadius: 2,
            backgroundColor: theme.primary,
          }}
        />
        {width > 0 && (
          <>
            <View
              style={{
                position: "absolute",
                left: Math.max(0, Math.min(width - thumbSize, minR * width - thumbSize / 2)),
                top: trackHeight / 2 - thumbSize / 2,
                width: thumbSize,
                height: thumbSize,
                borderRadius: thumbSize / 2,
                backgroundColor: theme.primary,
                borderWidth: 2,
                borderColor: theme.surface,
              }}
            />
            <View
              style={{
                position: "absolute",
                left: Math.max(0, Math.min(width - thumbSize, maxR * width - thumbSize / 2)),
                top: trackHeight / 2 - thumbSize / 2,
                width: thumbSize,
                height: thumbSize,
                borderRadius: thumbSize / 2,
                backgroundColor: theme.primary,
                borderWidth: 2,
                borderColor: theme.surface,
              }}
            />
          </>
        )}
      </View>
    </View>
  );
}

function Slider({
  label,
  value,
  onChange,
  min,
  max,
  log = false,
  format,
  theme,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  log?: boolean;
  format: (v: number) => string;
  theme: Theme;
}) {
  const [width, setWidth] = useState(0);

  const valueToRatio = (v: number) => {
    if (log) return Math.log(v / min) / Math.log(max / min);
    return (v - min) / (max - min);
  };
  const ratioToValue = (r: number) => {
    const clamped = Math.max(0, Math.min(1, r));
    if (log) return min * Math.pow(max / min, clamped);
    return min + (max - min) * clamped;
  };

  const handleTouch = (e: { nativeEvent: { locationX: number } }) => {
    if (width <= 0) return;
    const r = e.nativeEvent.locationX / width;
    onChange(ratioToValue(r));
  };

  const ratio = Math.max(0, Math.min(1, valueToRatio(value)));
  const thumbX = ratio * width;
  const trackHeight = 32;
  const thumbSize = 22;

  return (
    <View style={{ marginBottom: 10 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 4 }}>
        <Text style={{ fontSize: 12, color: theme.textMuted }}>{label}</Text>
        <Text style={{ fontSize: 13, fontWeight: "600", color: theme.text }}>{format(value)}</Text>
      </View>
      <View
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderGrant={handleTouch}
        onResponderMove={handleTouch}
        style={{ height: trackHeight, justifyContent: "center" }}
      >
        {/* track */}
        <View
          style={{
            height: 4,
            borderRadius: 2,
            backgroundColor: "rgba(127,127,127,0.25)",
          }}
        />
        {/* filled portion */}
        <View
          style={{
            position: "absolute",
            left: 0,
            top: trackHeight / 2 - 2,
            width: thumbX,
            height: 4,
            borderRadius: 2,
            backgroundColor: theme.primary,
          }}
        />
        {/* thumb */}
        {width > 0 && (
          <View
            style={{
              position: "absolute",
              left: Math.max(0, Math.min(width - thumbSize, thumbX - thumbSize / 2)),
              top: trackHeight / 2 - thumbSize / 2,
              width: thumbSize,
              height: thumbSize,
              borderRadius: thumbSize / 2,
              backgroundColor: theme.primary,
              borderWidth: 2,
              borderColor: theme.surface,
            }}
          />
        )}
      </View>
    </View>
  );
}

function RangeStepper({
  label,
  value,
  onChange,
  steps,
  additive = false,
  format,
  theme,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  steps: number[];
  additive?: boolean;
  format: (v: number) => string;
  theme: Theme;
}) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 6 }}>
      <Text style={{ width: 80, fontSize: 12, color: theme.textMuted }}>{label}</Text>
      <Text style={{ flex: 1, fontSize: 13, fontWeight: "600", color: theme.text }}>
        {format(value)}
      </Text>
      <View style={{ flexDirection: "row", gap: 4 }}>
        {steps.map((s) => (
          <Pressable
            key={s}
            onPress={() => onChange(additive ? value + s : value * s)}
            style={{
              paddingHorizontal: 8,
              paddingVertical: 5,
              borderRadius: 6,
              backgroundColor: theme.surfaceAlt,
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: theme.border,
            }}
          >
            <Text style={{ fontSize: 11, fontWeight: "600", color: theme.text }}>
              {additive ? (s > 0 ? `+${s}` : `${s}`) : s < 1 ? `÷${(1 / s).toFixed(s < 0.6 ? 0 : 2)}` : `×${s}`}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function generationLabel(g: number): string {
  switch (g) {
    case Cellular.CellularGeneration.CELLULAR_2G: return "2G";
    case Cellular.CellularGeneration.CELLULAR_3G: return "3G";
    case Cellular.CellularGeneration.CELLULAR_4G: return "4G";
    case Cellular.CellularGeneration.CELLULAR_5G: return "5G";
    default: return "unknown";
  }
}

function orientationLabel(o: ScreenOrientation.Orientation): string {
  switch (o) {
    case ScreenOrientation.Orientation.PORTRAIT_UP: return "portrait";
    case ScreenOrientation.Orientation.PORTRAIT_DOWN: return "portrait upside-down";
    case ScreenOrientation.Orientation.LANDSCAPE_LEFT: return "landscape left";
    case ScreenOrientation.Orientation.LANDSCAPE_RIGHT: return "landscape right";
    default: return "unknown";
  }
}

function rssiColor(rssi: number | null, theme: Theme): string {
  if (rssi == null) return theme.textSubtle;
  if (rssi > -55) return theme.primary;
  if (rssi > -75) return theme.warning;
  return theme.destructive;
}

function SpectrumBars({ samples, peaks, height = 90, bandEdges, sampleRate, fftSize }: {
  samples: number[]; peaks?: number[]; height?: number;
  bandEdges?: Int32Array | null; sampleRate?: number; fftSize?: number;
}) {
  if (samples.length === 0) {
    return <View style={{ height: height + 20, backgroundColor: "transparent" }} />;
  }
  const peaksArr = peaks && peaks.length === samples.length ? peaks : samples;
  const noteHeight = 18;  // space for note labels at bottom
  const chordHeight = 20; // space for chord label at top
  const totalHeight = height + noteHeight + chordHeight;
  const usable = height - 4;
  const n = samples.length;

  // Detect notes from peaks (which persist + decay like the peak markers)
  const notes = bandEdges && sampleRate && fftSize
    ? detectNotes(peaksArr, bandEdges, 0.15, sampleRate, fftSize)
    : [];
  const chord = identifyChord(notes);

  // Map detected notes to band indices for labeling
  const noteBands = new Map<number, string>();
  if (bandEdges && sampleRate && fftSize) {
    for (const note of notes) {
      // Find the band this note falls in
      for (let i = 0; i < n; i++) {
        const loFreq = (bandEdges[i]! * sampleRate) / fftSize;
        const hiFreq = (bandEdges[i + 1]! * sampleRate) / fftSize;
        if (note.freq >= loFreq && note.freq < hiFreq) {
          noteBands.set(i, note.name.replace(/\d+$/, "")); // strip octave for compact label
          break;
        }
      }
    }
  }

  return (
    <View style={{ height: totalHeight }}>
      {/* Chord label */}
      {chord && (
        <View style={{ height: chordHeight, justifyContent: "center", alignItems: "center" }}>
          <Text style={{ fontSize: 14, fontWeight: "700", color: "#fff" }}>{chord}</Text>
        </View>
      )}
      {!chord && <View style={{ height: chordHeight }} />}
      {/* Bars */}
      <View style={{ height, flexDirection: "row", alignItems: "flex-end", paddingHorizontal: 2 }}>
        {samples.map((v, i) => {
          const barH = Math.max(1, v * usable);
          const peakH = Math.max(1, peaksArr[i]! * usable);
          const hue = (i / (n - 1)) * 260;
          const barColor = `hsl(${hue.toFixed(0)}, 75%, 50%)`;
          const peakColor = `hsl(${hue.toFixed(0)}, 80%, 75%)`;
          const noteLabel = noteBands.get(i);
          return (
            <View key={i} style={{ flex: 1, height, position: "relative", marginRight: 1 }}>
              <View
                style={{
                  position: "absolute", bottom: 0, left: 0, right: 0,
                  height: barH, backgroundColor: barColor, borderRadius: 1,
                }}
              />
              {peaks && (
                <View
                  style={{
                    position: "absolute",
                    bottom: Math.min(usable - 2, Math.max(0, peakH - 2)),
                    left: 0, right: 0, height: 2,
                    backgroundColor: noteLabel ? "#fff" : peakColor,
                    borderRadius: 1,
                  }}
                />
              )}
            </View>
          );
        })}
      </View>
      {/* Note labels at bottom */}
      <View style={{ height: noteHeight, flexDirection: "row", paddingHorizontal: 2 }}>
        {samples.map((_, i) => {
          const noteLabel = noteBands.get(i);
          return (
            <View key={i} style={{ flex: 1, marginRight: 1, alignItems: "center" }}>
              {noteLabel && (
                <Text style={{ fontSize: 7, fontWeight: "700", color: "#fff" }} numberOfLines={1}>
                  {noteLabel}
                </Text>
              )}
            </View>
          );
        })}
      </View>
    </View>
  );
}

function makeStyles(theme: Theme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.background },
    sectionTitle: {
      fontSize: 12,
      fontWeight: "600",
      color: theme.textSubtle,
      textTransform: "uppercase",
      marginBottom: 6,
      marginLeft: 4,
    },
    card: { backgroundColor: theme.surface, borderRadius: 12, overflow: "hidden" },
    glassCard: { backgroundColor: "rgba(0,0,0,0.45)", borderRadius: 12, overflow: "hidden" },
    row: {
      flexDirection: "row",
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
    },
    rowLabel: { flex: 1, fontSize: 13, color: theme.textMuted },
    rowValue: { flex: 1, fontSize: 13, color: theme.text, textAlign: "right" },
    btn: {
      backgroundColor: theme.primary,
      paddingVertical: 12,
      alignItems: "center",
      borderRadius: 10,
      marginTop: -10,
      marginBottom: 20,
    },
    btnText: { color: "#fff", fontWeight: "600", fontSize: 14 },
    hapBtn: {
      backgroundColor: theme.surfaceAlt,
      borderColor: theme.primary,
      borderWidth: StyleSheet.hairlineWidth,
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: 16,
    },
    hapBtnText: { color: theme.primary, fontWeight: "600", fontSize: 13 },
  });
}
