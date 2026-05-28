import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  Text,
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

const { width: SCREEN_W } = Dimensions.get("window");

// --- Types ---

type VizToggle = "planes" | "mesh" | "features";
type DetectionMode = "yolo" | "baseball";

interface DetectionOverlay {
  detections: (YoloDetection | BaseballDetection)[];
  imageWidth: number;
  imageHeight: number;
  elapsedMs: number;
}

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

  // Detection loop
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

  const stopDetection = useCallback(() => {
    runningRef.current = false;
    setOverlay(null);
  }, []);

  // Toggle detection mode
  const handleDetectionToggle = useCallback((mode: DetectionMode) => {
    if (detectionMode === mode) {
      setDetectionMode(null);
      stopDetection();
    } else {
      if (detectionMode) stopDetection();
      setDetectionMode(mode);
      runDetectionLoop(mode);
    }
  }, [detectionMode, runDetectionLoop, stopDetection]);

  // Stop detection when leaving page 1
  useEffect(() => {
    if (page !== 1 && detectionMode) {
      setDetectionMode(null);
      stopDetection();
    }
  }, [page, detectionMode, stopDetection]);

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

  return (
    <View style={styles.container}>
      <LidarARView
        ref={arRef}
        style={StyleSheet.absoluteFill}
        showPlanes={viz.planes}
        showMesh={viz.mesh}
        showFeaturePoints={viz.features}
      />

      {/* Detection bounding box overlay */}
      {overlay && overlay.detections.length > 0 && (
        <DetectionBoxes overlay={overlay} mode={detectionMode} />
      )}

      {/* Swipeable control pages */}
      <SafeAreaView style={styles.overlay} pointerEvents="box-none">
        {/* Page indicator */}
        <View style={styles.pageIndicator} pointerEvents="none">
          <Dot active={page === 0} />
          <Dot active={page === 1} />
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
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

// --- Detection overlay ---

function DetectionBoxes({
  overlay,
  mode,
}: {
  overlay: DetectionOverlay;
  mode: DetectionMode | null;
}) {
  // The captured image is landscape (from ARKit) but the view is portrait.
  // ARKit captureViewImage returns the image matching the view's orientation,
  // so we can map box coords directly to screen coords.
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
