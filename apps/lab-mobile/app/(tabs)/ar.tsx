import React, { useCallback, useRef, useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  SafeAreaView,
  Dimensions,
} from "react-native";
import {
  Lidar,
  LidarARView,
  lidarARViewAvailable,
  type LidarARViewRef,
} from "../../modules/expo-lidar/src";
import { computeHomePlatePose, type Vec3 } from "../../src/field/coordinateFrame";

const { width: SCREEN_W } = Dimensions.get("window");

// Plate — establish an AR world anchored to home plate.
//
// This is Phase A / §8.2 of the field-registration plan (AR_WORLD_ANCHOR.md):
// the manual 5-corner tap is the calibration stand-in ahead of the automatic
// region → contour → solvePnP fix. Each tap raycasts the screen-center crosshair
// to the ground plane; at 5 corners, computeHomePlatePose() recovers the plate's
// pose by pure geometry and drops a virtual home_plate marker on the real one.
export default function PlateScreen() {
  const arRef = useRef<LidarARViewRef>(null);

  const plateCornersRef = useRef<Vec3[]>([]);
  const [plateCount, setPlateCount] = useState(0);
  const trainingCountRef = useRef(0);
  const [trainingCount, setTrainingCount] = useState(0);
  const [plateStatus, setPlateStatus] = useState(
    "Aim the crosshair at a home-plate corner, then tap Capture (0/5).",
  );

  const establishPlateWorld = useCallback(async (corners: Vec3[]) => {
    const p = computeHomePlatePose(corners);
    if (!p) { setPlateStatus("Couldn't solve the plate — tap Reset and recapture."); return; }
    // Heading toward the pitcher = field "forward" (same atan2 convention as
    // src/field/templates.ts), used to orient the rendered plate.
    const headingDeg = (Math.atan2(p.forward.x, p.forward.z) * 180) / Math.PI;
    try {
      await arRef.current?.clearFieldLandmarks();
      await arRef.current?.addFieldLandmarkAtWorld(
        p.center.x, p.center.y, p.center.z, "home_plate", headingDeg,
      );
    } catch {
      // Marker render is best-effort; the readout still stands.
    }
    const frontIn = p.frontEdgeLengthM * 39.3701;
    const errPct = Math.round(p.scaleError * 100);
    setPlateStatus(
      `${p.scaleError <= 0.2 ? "World anchored" : "Placed (size off?)"} · ` +
      `${frontIn.toFixed(1)}in (${errPct}% off 17in) · heading ${headingDeg.toFixed(0)}°`,
    );
  }, []);

  const capturePlateCorner = useCallback(async () => {
    const hit = await arRef.current?.raycastScreenPoint(0.5, 0.5).catch(() => null);
    if (!hit) { setPlateStatus("No surface under the crosshair — aim at the ground."); return; }
    const next: Vec3[] = [...plateCornersRef.current, { x: hit.worldX, y: hit.worldY, z: hit.worldZ }];
    plateCornersRef.current = next;
    setPlateCount(next.length);
    if (next.length < 5) setPlateStatus(`Captured ${next.length}/5 — move to the next corner.`);
    else { setPlateStatus("Solving…"); await establishPlateWorld(next); }
  }, [establishPlateWorld]);

  const resetPlateWorld = useCallback(async () => {
    plateCornersRef.current = [];
    setPlateCount(0);
    setPlateStatus("Aim the crosshair at a home-plate corner, then tap Capture (0/5).");
    try { await arRef.current?.clearFieldLandmarks(); } catch { /* ignore */ }
  }, []);

  // Save the current AR frame to the photo library to build a labeling dataset
  // for the §10 fallback (and for line-robustness testing, §7.3). Point the
  // phone at home plate from varied angles/distances/lighting and tap repeatedly.
  const saveTrainingFrame = useCallback(async () => {
    try {
      const cap = await arRef.current?.captureViewImage(0.9);
      if (!cap) { setPlateStatus("Couldn't grab a frame — try again."); return; }
      const ok = await Lidar.saveImageToPhotos(cap.imageBase64);
      if (ok) {
        const n = trainingCountRef.current + 1;
        trainingCountRef.current = n;
        setTrainingCount(n);
        setPlateStatus(`Saved training frame #${n} to Photos.`);
      } else {
        setPlateStatus("Save failed — check Photos permission.");
      }
    } catch (e) {
      setPlateStatus(`Save failed: ${(e as Error).message}`);
    }
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

  return (
    <View style={styles.container}>
      <LidarARView ref={arRef} style={StyleSheet.absoluteFill} />

      {/* Crosshair — Capture raycasts against screen center */}
      <View pointerEvents="none" style={styles.plateCrosshair}>
        <View style={styles.crossH} />
        <View style={styles.crossV} />
      </View>

      <SafeAreaView style={styles.overlay} pointerEvents="box-none">
        <View style={styles.statsBar} pointerEvents="none">
          <Text style={styles.statsText}>{plateStatus}</Text>
        </View>

        <View style={styles.controlBar}>
          <TogglePill
            label={plateCount >= 5 ? "Captured 5/5" : `Capture ${plateCount}/5`}
            active={plateCount > 0 && plateCount < 5}
            onPress={capturePlateCorner}
            disabled={plateCount >= 5}
          />
          <TogglePill label="Reset" active={false} onPress={resetPlateWorld} />
          <TogglePill
            label={trainingCount > 0 ? `Save Frame (${trainingCount})` : "Save Frame"}
            active={false}
            onPress={saveTrainingFrame}
          />
        </View>
      </SafeAreaView>
    </View>
  );
}

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
      <Text style={[styles.pillText, active && styles.pillTextActive]}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

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
  controlBar: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingBottom: 24,
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
  // Crosshair
  plateCrosshair: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
  crossH: { position: "absolute", width: 28, height: 2, backgroundColor: "rgba(255,255,255,0.85)", borderRadius: 1 },
  crossV: { position: "absolute", width: 2, height: 28, backgroundColor: "rgba(255,255,255,0.85)", borderRadius: 1 },
});
