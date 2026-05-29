import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  Image,
  TouchableOpacity,
  StyleSheet,
  SafeAreaView,
  Dimensions,
  ScrollView,
} from "react-native";
import {
  LidarARView,
  lidarARViewAvailable,
  type LidarARViewRef,
} from "../../modules/expo-lidar/src";
import { Yolo, type YoloDetection } from "expo-yolo";
import { Baseball, type BaseballDetection } from "expo-baseball";
import {
  VisionDetect,
  type BodyPoseResult,
  type HandPoseResult,
  type FaceLandmarksResult,
  type PersonSegmentationResult,
  type JointPoint,
  type LandmarkPoint,
} from "expo-vision-detect";

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get("window");

const TOTAL_PAGES = 6;

// --- Types ---

type VizToggle = "planes" | "mesh" | "features";
type DetectionMode = "yolo" | "baseball";
type VisionMode = "bodyPose" | "handPose" | "faceLandmarks" | "segmentation";

interface DetectionOverlay {
  detections: (YoloDetection | BaseballDetection)[];
  imageWidth: number;
  imageHeight: number;
  elapsedMs: number;
}

// --- Body pose skeleton connections ---

const BODY_CONNECTIONS: [string, string][] = [
  // Torso
  ["neck_1_joint", "root"],
  // Left arm
  ["neck_1_joint", "left_shoulder_1_joint"],
  ["left_shoulder_1_joint", "left_forearm_joint"],
  ["left_forearm_joint", "left_hand_joint"],
  // Right arm
  ["neck_1_joint", "right_shoulder_1_joint"],
  ["right_shoulder_1_joint", "right_forearm_joint"],
  ["right_forearm_joint", "right_hand_joint"],
  // Left leg
  ["root", "left_upLeg_joint"],
  ["left_upLeg_joint", "left_leg_joint"],
  ["left_leg_joint", "left_foot_joint"],
  // Right leg
  ["root", "right_upLeg_joint"],
  ["right_upLeg_joint", "right_leg_joint"],
  ["right_leg_joint", "right_foot_joint"],
  // Head
  ["neck_1_joint", "head_joint"],
];

// --- Hand pose connections ---

const FINGER_JOINTS = ["TIP", "DIP", "PIP", "MCP"] as const;
const FINGERS = ["Thumb", "Index", "Middle", "Ring", "Little"] as const;

function getHandConnections(): [string, string][] {
  const conns: [string, string][] = [];
  for (const finger of FINGERS) {
    const joints = FINGER_JOINTS.map((j) =>
      `VNHLK${finger}${j}`.replace("ThumbTIP", "ThumbTip")
        .replace("ThumbDIP", "ThumbIP")
        .replace("ThumbPIP", "ThumbMP")
        .replace("ThumbMCP", "ThumbCMC")
    );
    // Actually use the Apple key names directly
  }
  // Use the raw Apple joint key names
  const thumbKeys = ["VNHLKTIP_0", "VNHLKIP_0", "VNHLKMP_0", "VNHLKCMC_0"];
  const indexKeys = ["VNHLKTIP_1", "VNHLKDIP_1", "VNHLKPIP_1", "VNHLKMCP_1"];
  const middleKeys = ["VNHLKTIP_2", "VNHLKDIP_2", "VNHLKPIP_2", "VNHLKMCP_2"];
  const ringKeys = ["VNHLKTIP_3", "VNHLKDIP_3", "VNHLKPIP_3", "VNHLKMCP_3"];
  const littleKeys = ["VNHLKTIP_4", "VNHLKDIP_4", "VNHLKPIP_4", "VNHLKMCP_4"];
  const wrist = "VNHLKW";

  for (const keys of [thumbKeys, indexKeys, middleKeys, ringKeys, littleKeys]) {
    for (let i = 0; i < keys.length - 1; i++) {
      conns.push([keys[i], keys[i + 1]]);
    }
    conns.push([keys[keys.length - 1], wrist]);
  }
  return conns;
}

const HAND_CONNECTIONS = getHandConnections();

// --- Face landmark region rendering order ---

const FACE_REGIONS_CLOSED = ["faceContour", "leftEye", "rightEye", "outerLips", "innerLips"];
const FACE_REGIONS_OPEN = ["leftEyebrow", "rightEyebrow", "nose", "noseCrest", "medianLine"];

// --- Main screen ---

export default function ARScreen() {
  const arRef = useRef<LidarARViewRef>(null);
  const [page, setPage] = useState(0);
  const scrollRef = useRef<ScrollView>(null);

  // Page 0: viz toggles
  const [viz, setViz] = useState<Record<VizToggle, boolean>>({
    planes: false,
    mesh: false,
    features: false,
  });
  const toggleViz = (key: VizToggle) =>
    setViz((prev) => ({ ...prev, [key]: !prev[key] }));

  // Page 1: detection
  const [detectionMode, setDetectionMode] = useState<DetectionMode | null>(null);
  const [overlay, setOverlay] = useState<DetectionOverlay | null>(null);
  const runningRef = useRef(false);

  // Pages 2-5: vision modes
  const [visionMode, setVisionMode] = useState<VisionMode | null>(null);
  const [bodyPose, setBodyPose] = useState<BodyPoseResult | null>(null);
  const [handPose, setHandPose] = useState<HandPoseResult | null>(null);
  const [faceLandmarks, setFaceLandmarks] = useState<FaceLandmarksResult | null>(null);
  const [segmentation, setSegmentation] = useState<PersonSegmentationResult | null>(null);
  const [visionElapsed, setVisionElapsed] = useState<number>(0);

  // Detection loop (page 1)
  const runDetectionLoop = useCallback(async (mode: DetectionMode) => {
    if (runningRef.current) return;
    runningRef.current = true;
    while (runningRef.current) {
      try {
        const cap = await arRef.current?.captureViewImage(0.6);
        if (!cap) { await sleep(200); continue; }
        const uri = `data:image/jpeg;base64,${cap.imageBase64}`;
        const result = mode === "baseball"
          ? await Baseball.detect(uri, { minConfidence: 0.15 })
          : await Yolo.detect(uri, { minConfidence: 0.20 });
        if (runningRef.current) {
          setOverlay({
            detections: result.detections,
            imageWidth: result.width,
            imageHeight: result.height,
            elapsedMs: result.elapsedMs,
          });
        }
      } catch {
        await sleep(500);
      }
    }
  }, []);

  // Vision mode loop (pages 2-5)
  const runVisionLoop = useCallback(async (mode: VisionMode) => {
    if (runningRef.current) return;
    runningRef.current = true;
    while (runningRef.current) {
      try {
        const cap = await arRef.current?.captureViewImage(0.6);
        if (!cap) { await sleep(200); continue; }
        const uri = `data:image/jpeg;base64,${cap.imageBase64}`;
        switch (mode) {
          case "bodyPose": {
            const r = await VisionDetect.detectBodyPose(uri);
            if (runningRef.current) { setBodyPose(r); setVisionElapsed(r.elapsedMs); }
            break;
          }
          case "handPose": {
            const r = await VisionDetect.detectHandPose(uri);
            if (runningRef.current) { setHandPose(r); setVisionElapsed(r.elapsedMs); }
            break;
          }
          case "faceLandmarks": {
            const r = await VisionDetect.detectFaceLandmarks(uri);
            if (runningRef.current) { setFaceLandmarks(r); setVisionElapsed(r.elapsedMs); }
            break;
          }
          case "segmentation": {
            const r = await VisionDetect.detectPersonSegmentation(uri);
            if (runningRef.current) { setSegmentation(r); setVisionElapsed(r.elapsedMs); }
            break;
          }
        }
      } catch (e) {
        console.warn("[VisionLoop]", mode, e);
        await sleep(500);
      }
    }
  }, []);

  const stopAll = useCallback(() => {
    runningRef.current = false;
    setOverlay(null);
    setDetectionMode(null);
    setVisionMode(null);
    setBodyPose(null);
    setHandPose(null);
    setFaceLandmarks(null);
    setSegmentation(null);
  }, []);

  // Toggle detection mode (page 1)
  const handleDetectionToggle = useCallback((mode: DetectionMode) => {
    if (detectionMode === mode) {
      setDetectionMode(null);
      runningRef.current = false;
      setOverlay(null);
    } else {
      runningRef.current = false;
      setOverlay(null);
      setDetectionMode(mode);
      setTimeout(() => runDetectionLoop(mode), 50);
    }
  }, [detectionMode, runDetectionLoop]);

  // Toggle vision mode (pages 2-5)
  const handleVisionToggle = useCallback((mode: VisionMode) => {
    if (visionMode === mode) {
      setVisionMode(null);
      runningRef.current = false;
    } else {
      runningRef.current = false;
      setVisionMode(mode);
      setTimeout(() => runVisionLoop(mode), 50);
    }
  }, [visionMode, runVisionLoop]);

  // Stop everything when leaving the active page
  useEffect(() => {
    if (page !== 1 && detectionMode) {
      setDetectionMode(null);
      runningRef.current = false;
      setOverlay(null);
    }
    if (page !== 2 && visionMode === "bodyPose") { stopAll(); }
    if (page !== 3 && visionMode === "segmentation") { stopAll(); }
    if (page !== 4 && visionMode === "faceLandmarks") { stopAll(); }
    if (page !== 5 && visionMode === "handPose") { stopAll(); }
  }, [page, detectionMode, visionMode, stopAll]);

  // Cleanup on unmount
  useEffect(() => () => { runningRef.current = false; }, []);

  const handleScroll = useCallback((e: any) => {
    const x = e.nativeEvent.contentOffset.x;
    setPage(Math.round(x / SCREEN_W));
  }, []);

  if (!lidarARViewAvailable()) {
    return (
      <View style={styles.fallback}>
        <Text style={styles.fallbackText}>
          ARKit is not available on this device.
        </Text>
      </View>
    );
  }

  const yoloReady = Yolo.available() && Yolo.isReady();
  const baseballReady = Baseball.available() && Baseball.isReady();
  const visionReady = VisionDetect.available();

  return (
    <View style={styles.container}>
      <LidarARView
        ref={arRef}
        style={StyleSheet.absoluteFill}
        showPlanes={viz.planes}
        showMesh={viz.mesh}
        showFeaturePoints={viz.features}
      />

      {/* Detection bounding box overlay (page 1) */}
      {overlay && overlay.detections.length > 0 && (
        <DetectionBoxes overlay={overlay} mode={detectionMode} />
      )}

      {/* Body pose overlay (page 2) */}
      {bodyPose && bodyPose.bodies.length > 0 && (
        <BodyPoseOverlay result={bodyPose} />
      )}

      {/* Segmentation overlay (page 3) */}
      {segmentation && segmentation.maskBase64 !== "" && (
        <SegmentationOverlay result={segmentation} />
      )}

      {/* Face landmarks overlay (page 4) */}
      {faceLandmarks && faceLandmarks.faces.length > 0 && (
        <FaceLandmarksOverlay result={faceLandmarks} />
      )}

      {/* Hand pose overlay (page 5) */}
      {handPose && handPose.hands.length > 0 && (
        <HandPoseOverlay result={handPose} />
      )}

      {/* Swipeable control pages */}
      <SafeAreaView style={styles.overlay} pointerEvents="box-none">
        {/* Page indicator */}
        <View style={styles.pageIndicator} pointerEvents="none">
          {Array.from({ length: TOTAL_PAGES }, (_, i) => (
            <Dot key={i} active={page === i} />
          ))}
        </View>

        {/* Stats bar */}
        {overlay && detectionMode && (
          <View style={styles.statsBar} pointerEvents="none">
            <Text style={styles.statsText}>
              {overlay.detections.length} detection{overlay.detections.length !== 1 ? "s" : ""}
              {" \u00b7 "}
              {overlay.elapsedMs}ms
            </Text>
          </View>
        )}
        {visionMode && (
          <View style={styles.statsBar} pointerEvents="none">
            <Text style={styles.statsText}>
              {visionMode === "bodyPose" && `${bodyPose?.bodies.length ?? 0} bod${(bodyPose?.bodies.length ?? 0) !== 1 ? "ies" : "y"}`}
              {visionMode === "handPose" && `${handPose?.hands.length ?? 0} hand${(handPose?.hands.length ?? 0) !== 1 ? "s" : ""}`}
              {visionMode === "faceLandmarks" && `${faceLandmarks?.faces.length ?? 0} face${(faceLandmarks?.faces.length ?? 0) !== 1 ? "s" : ""}`}
              {visionMode === "segmentation" && "mask"}
              {" \u00b7 "}
              {visionElapsed}ms
            </Text>
          </View>
        )}

        <ScrollView
          ref={scrollRef}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          onMomentumScrollEnd={handleScroll}
          style={styles.pager}
          contentContainerStyle={styles.pagerContent}
        >
          {/* Page 0: Visualization toggles */}
          <View style={styles.page}>
            <View style={styles.controlBar}>
              <TogglePill label="Planes" active={viz.planes} onPress={() => toggleViz("planes")} />
              <TogglePill label="Mesh" active={viz.mesh} onPress={() => toggleViz("mesh")} />
              <TogglePill label="Features" active={viz.features} onPress={() => toggleViz("features")} />
            </View>
          </View>

          {/* Page 1: Detection modes */}
          <View style={styles.page}>
            <View style={styles.controlBar}>
              <TogglePill
                label="YOLO"
                active={detectionMode === "yolo"}
                onPress={() => handleDetectionToggle("yolo")}
                disabled={!yoloReady}
              />
              <TogglePill
                label="Baseball"
                active={detectionMode === "baseball"}
                onPress={() => handleDetectionToggle("baseball")}
                disabled={!baseballReady}
              />
            </View>
          </View>

          {/* Page 2: Body Pose */}
          <View style={styles.page}>
            <View style={styles.controlBar}>
              <TogglePill
                label="Body Pose"
                active={visionMode === "bodyPose"}
                onPress={() => handleVisionToggle("bodyPose")}
                disabled={!visionReady}
              />
            </View>
          </View>

          {/* Page 3: Person Segmentation */}
          <View style={styles.page}>
            <View style={styles.controlBar}>
              <TogglePill
                label="Segmentation"
                active={visionMode === "segmentation"}
                onPress={() => handleVisionToggle("segmentation")}
                disabled={!visionReady}
              />
            </View>
          </View>

          {/* Page 4: Face Landmarks */}
          <View style={styles.page}>
            <View style={styles.controlBar}>
              <TogglePill
                label="Face Landmarks"
                active={visionMode === "faceLandmarks"}
                onPress={() => handleVisionToggle("faceLandmarks")}
                disabled={!visionReady}
              />
            </View>
          </View>

          {/* Page 5: Hand Pose */}
          <View style={styles.page}>
            <View style={styles.controlBar}>
              <TogglePill
                label="Hand Pose"
                active={visionMode === "handPose"}
                onPress={() => handleVisionToggle("handPose")}
                disabled={!visionReady}
              />
            </View>
          </View>
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

// --- Detection overlay (page 1) ---

function DetectionBoxes({
  overlay,
  mode,
}: {
  overlay: DetectionOverlay;
  mode: DetectionMode | null;
}) {
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {overlay.detections.map((d, i) => {
        const left = d.box.x * 100;
        const top = d.box.y * 100;
        const width = d.box.width * 100;
        const height = d.box.height * 100;
        const color = mode === "baseball" ? "#FF3B30" : boxColor(d.confidence);
        return (
          <View
            key={i}
            style={[
              styles.box,
              {
                left: `${left}%`,
                top: `${top}%`,
                width: `${width}%`,
                height: `${height}%`,
                borderColor: color,
              },
            ]}
          >
            <View style={[styles.boxLabel, { backgroundColor: color }]}>
              <Text style={styles.boxLabelText} numberOfLines={1}>
                {d.label} {(d.confidence * 100).toFixed(0)}%
              </Text>
            </View>
          </View>
        );
      })}
    </View>
  );
}

// --- Body Pose overlay (page 2) ---

function BodyPoseOverlay({ result }: { result: BodyPoseResult }) {
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {result.bodies.map((body, bi) => (
        <React.Fragment key={bi}>
          {/* Draw connections */}
          {BODY_CONNECTIONS.map(([from, to], ci) => {
            const a = body.joints[from];
            const b = body.joints[to];
            if (!a || !b) return null;
            return (
              <SkeletonLine
                key={ci}
                x1={a.x} y1={a.y}
                x2={b.x} y2={b.y}
                color="#00FF88"
              />
            );
          })}
          {/* Draw joints */}
          {Object.entries(body.joints).map(([name, joint]) => (
            <JointDot key={name} x={joint.x} y={joint.y} color="#00FF88" />
          ))}
        </React.Fragment>
      ))}
    </View>
  );
}

// --- Hand Pose overlay (page 5) ---

function HandPoseOverlay({ result }: { result: HandPoseResult }) {
  const colors = ["#FF6B6B", "#4ECDC4", "#FFE66D", "#95E1D3"];
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {result.hands.map((hand, hi) => {
        const color = colors[hi % colors.length];
        return (
          <React.Fragment key={hi}>
            {HAND_CONNECTIONS.map(([from, to], ci) => {
              const a = hand.joints[from];
              const b = hand.joints[to];
              if (!a || !b) return null;
              return (
                <SkeletonLine key={ci} x1={a.x} y1={a.y} x2={b.x} y2={b.y} color={color} />
              );
            })}
            {Object.entries(hand.joints).map(([name, joint]) => (
              <JointDot key={name} x={joint.x} y={joint.y} color={color} size={4} />
            ))}
          </React.Fragment>
        );
      })}
    </View>
  );
}

// --- Face Landmarks overlay (page 4) ---

function FaceLandmarksOverlay({ result }: { result: FaceLandmarksResult }) {
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {result.faces.map((face, fi) => (
        <React.Fragment key={fi}>
          {/* Bounding box */}
          <View
            style={[
              styles.box,
              {
                left: `${face.box.x * 100}%`,
                top: `${face.box.y * 100}%`,
                width: `${face.box.width * 100}%`,
                height: `${face.box.height * 100}%`,
                borderColor: "#FFD93D",
              },
            ]}
          />
          {/* Landmark regions */}
          {face.landmarks && Object.entries(face.landmarks).map(([region, points]) => {
            const closed = FACE_REGIONS_CLOSED.includes(region);
            return (
              <React.Fragment key={region}>
                {/* Lines between consecutive points */}
                {points.map((pt: LandmarkPoint, pi: number) => {
                  const next = closed
                    ? points[(pi + 1) % points.length]
                    : points[pi + 1];
                  if (!next) return null;
                  return (
                    <SkeletonLine
                      key={pi}
                      x1={pt.x} y1={pt.y}
                      x2={next.x} y2={next.y}
                      color="#FFD93D"
                      width={1}
                    />
                  );
                })}
                {/* Dots on each point */}
                {points.map((pt: LandmarkPoint, pi: number) => (
                  <JointDot key={pi} x={pt.x} y={pt.y} color="#FFD93D" size={2} />
                ))}
              </React.Fragment>
            );
          })}
        </React.Fragment>
      ))}
    </View>
  );
}

// --- Segmentation overlay (page 3) ---

function SegmentationOverlay({ result }: { result: PersonSegmentationResult }) {
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <Image
        source={{ uri: `data:image/png;base64,${result.maskBase64}` }}
        style={[StyleSheet.absoluteFill, { opacity: 0.5, tintColor: "#00BFFF" }]}
        resizeMode="cover"
      />
    </View>
  );
}

// --- Shared drawing primitives ---

function SkeletonLine({
  x1, y1, x2, y2, color, width: lineWidth = 2,
}: {
  x1: number; y1: number; x2: number; y2: number;
  color: string; width?: number;
}) {
  const dx = (x2 - x1) * SCREEN_W;
  const dy = (y2 - y1) * SCREEN_H;
  const len = Math.sqrt(dx * dx + dy * dy);
  const angle = Math.atan2(dy, dx) * (180 / Math.PI);
  return (
    <View
      style={{
        position: "absolute",
        left: x1 * SCREEN_W,
        top: y1 * SCREEN_H,
        width: len,
        height: lineWidth,
        backgroundColor: color,
        transform: [{ rotate: `${angle}deg` }],
        transformOrigin: "left center",
        opacity: 0.8,
      }}
    />
  );
}

function JointDot({
  x, y, color, size = 6,
}: {
  x: number; y: number; color: string; size?: number;
}) {
  return (
    <View
      style={{
        position: "absolute",
        left: x * SCREEN_W - size / 2,
        top: y * SCREEN_H - size / 2,
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: color,
        opacity: 0.9,
      }}
    />
  );
}

function boxColor(confidence: number): string {
  if (confidence >= 0.7) return "#34C759";  // green
  if (confidence >= 0.4) return "#FF9500";  // orange
  return "#FF3B30";                          // red
}

// --- Shared components ---

function TogglePill({
  label,
  active,
  onPress,
  disabled,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      style={[styles.pill, active && styles.pillActive, disabled && styles.pillDisabled]}
      activeOpacity={0.7}
    >
      <Text style={[styles.pillText, active && styles.pillTextActive, disabled && styles.pillTextDisabled]}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

function Dot({ active }: { active: boolean }) {
  return (
    <View
      style={[styles.dot, active && styles.dotActive]}
    />
  );
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Styles ---

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000",
  },
  fallback: {
    flex: 1,
    backgroundColor: "#000",
    alignItems: "center",
    justifyContent: "center",
  },
  fallbackText: {
    color: "#fff",
    fontSize: 16,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "flex-end",
  },
  pageIndicator: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 6,
    marginBottom: 12,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: "rgba(255, 255, 255, 0.35)",
  },
  dotActive: {
    backgroundColor: "rgba(255, 255, 255, 0.9)",
  },
  statsBar: {
    alignItems: "center",
    marginBottom: 8,
  },
  statsText: {
    color: "rgba(255, 255, 255, 0.8)",
    fontSize: 12,
    fontWeight: "500",
    fontVariant: ["tabular-nums"],
    backgroundColor: "rgba(0, 0, 0, 0.4)",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
    overflow: "hidden",
  },
  pager: {
    flexGrow: 0,
  },
  pagerContent: {},
  page: {
    width: SCREEN_W,
    paddingBottom: 24,
  },
  controlBar: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 10,
    paddingHorizontal: 16,
  },
  pill: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 20,
    backgroundColor: "rgba(0, 0, 0, 0.45)",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.2)",
  },
  pillActive: {
    backgroundColor: "rgba(255, 255, 255, 0.85)",
    borderColor: "rgba(255, 255, 255, 0.9)",
  },
  pillDisabled: {
    opacity: 0.35,
  },
  pillText: {
    color: "rgba(255, 255, 255, 0.9)",
    fontSize: 14,
    fontWeight: "600",
  },
  pillTextActive: {
    color: "#000",
  },
  pillTextDisabled: {},
  // Detection boxes
  box: {
    position: "absolute",
    borderWidth: 2,
    borderRadius: 4,
  },
  boxLabel: {
    position: "absolute",
    top: -18,
    left: -1,
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 3,
  },
  boxLabelText: {
    color: "#fff",
    fontSize: 10,
    fontWeight: "700",
  },
});
