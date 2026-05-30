import React, { useCallback, useRef, useState } from "react";
import { View, Text, StyleSheet, SafeAreaView, Pressable } from "react-native";
import { useRouter } from "expo-router";
import {
  LidarARView,
  lidarARViewAvailable,
  type LidarARViewRef,
} from "../modules/expo-lidar/src";
import { computeHomePlatePose, type HomePlatePose, type Vec3 } from "../src/field/coordinateFrame";

// Standalone test: establish an AR "world" anchored to home plate, completely
// separate from the Field registration flow. You mark the 5 corners of home
// plate (aim the crosshair at each, tap Capture); the plate's pose — origin,
// orientation, scale — is recovered purely from that geometry
// (src/field/coordinateFrame.ts → computeHomePlatePose) and a virtual plate is
// dropped onto the real one to confirm it. This stands in for automatic
// detection: swap the 5 manual taps for a corner detector later and nothing
// downstream changes.

const INSTRUCTIONS =
  "Aim the crosshair at a corner of home plate, then tap Capture. Walk around and capture all 5 corners.";

export default function PlateWorldScreen() {
  const router = useRouter();
  const arRef = useRef<LidarARViewRef>(null);
  const cornersRef = useRef<Vec3[]>([]);
  const [count, setCount] = useState(0);
  const [pose, setPose] = useState<HomePlatePose | null>(null);
  const [status, setStatus] = useState(INSTRUCTIONS);

  const establish = useCallback(async (corners: Vec3[]) => {
    const p = computeHomePlatePose(corners);
    if (!p) {
      setStatus("Couldn't solve the plate from those corners. Tap Reset and try again.");
      return;
    }
    setPose(p);
    // Heading toward the pitcher = field "forward". home_plate landmark uses the
    // same atan2(forward.x, forward.z) convention as src/field/templates.ts.
    const headingDeg = (Math.atan2(p.forward.x, p.forward.z) * 180) / Math.PI;
    try {
      await arRef.current?.clearFieldLandmarks();
      await arRef.current?.addFieldLandmarkAtWorld(
        p.center.x, p.center.y, p.center.z, "home_plate", headingDeg,
      );
    } catch {
      // Rendering the marker is best-effort; the pose readout still stands.
    }
    const frontIn = p.frontEdgeLengthM * 39.3701;
    const errPct = Math.round(p.scaleError * 100);
    const ok = p.scaleError <= 0.2;
    setStatus(
      (ok
        ? "World anchored to home plate."
        : "Placed, but the size looks off — recheck your corners.") +
        `\nFront edge ${frontIn.toFixed(1)}in (expected 17in, ${errPct}% off) · heading ${headingDeg.toFixed(0)}°`,
    );
  }, []);

  const capture = useCallback(async () => {
    const hit = await arRef.current?.raycastScreenPoint(0.5, 0.5).catch(() => null);
    if (!hit) {
      setStatus("No surface under the crosshair. Aim at the ground near the plate and try again.");
      return;
    }
    const next: Vec3[] = [...cornersRef.current, { x: hit.worldX, y: hit.worldY, z: hit.worldZ }];
    cornersRef.current = next;
    setCount(next.length);
    if (next.length < 5) {
      setStatus(`Captured ${next.length}/5 corners. Move to the next corner.`);
    } else {
      setStatus("Solving…");
      await establish(next);
    }
  }, [establish]);

  const reset = useCallback(async () => {
    cornersRef.current = [];
    setCount(0);
    setPose(null);
    setStatus(INSTRUCTIONS);
    try {
      await arRef.current?.clearFieldLandmarks();
    } catch {
      // ignore
    }
  }, []);

  if (!lidarARViewAvailable()) {
    return (
      <View style={styles.fallback}>
        <Text style={styles.fallbackText}>ARKit isn't available on this device.</Text>
        <Pressable onPress={() => router.back()} style={styles.exitBtn}>
          <Text style={styles.exitText}>Back</Text>
        </Pressable>
      </View>
    );
  }

  const done = count >= 5;

  return (
    <View style={styles.container}>
      <LidarARView ref={arRef} style={StyleSheet.absoluteFill} showPlanes />

      {/* Center crosshair — what Capture raycasts against. */}
      <View pointerEvents="none" style={styles.crosshairWrap}>
        <View style={styles.crosshairH} />
        <View style={styles.crosshairV} />
        {pose ? null : <Text style={styles.crosshairHint}>{count}/5</Text>}
      </View>

      <SafeAreaView style={styles.overlay} pointerEvents="box-none">
        <View style={styles.topBar} pointerEvents="box-none">
          <Text style={styles.title}>Plate World</Text>
          <Pressable onPress={() => router.back()} style={styles.exitBtn}>
            <Text style={styles.exitText}>Exit</Text>
          </Pressable>
        </View>

        <View style={styles.bottom} pointerEvents="box-none">
          <Text style={styles.status}>{status}</Text>
          <View style={styles.controls}>
            <Pressable
              onPress={capture}
              disabled={done}
              style={[styles.btn, done && styles.btnDisabled]}
            >
              <Text style={styles.btnText}>{done ? "Captured 5/5" : `Capture ${count}/5`}</Text>
            </Pressable>
            <Pressable onPress={reset} style={[styles.btn, styles.btnSecondary]}>
              <Text style={[styles.btnText, styles.btnTextSecondary]}>Reset</Text>
            </Pressable>
          </View>
        </View>
      </SafeAreaView>
    </View>
  );
}

const CROSS = 28;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#000" },
  fallback: { flex: 1, backgroundColor: "#000", alignItems: "center", justifyContent: "center", gap: 16 },
  fallbackText: { color: "#fff", fontSize: 16 },
  crosshairWrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
  crosshairH: { position: "absolute", width: CROSS, height: 2, backgroundColor: "rgba(255,255,255,0.85)", borderRadius: 1 },
  crosshairV: { position: "absolute", width: 2, height: CROSS, backgroundColor: "rgba(255,255,255,0.85)", borderRadius: 1 },
  crosshairHint: {
    position: "absolute",
    marginTop: CROSS + 14,
    color: "#fff",
    fontSize: 13,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
    textShadowColor: "rgba(0,0,0,0.8)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  overlay: { ...StyleSheet.absoluteFillObject, justifyContent: "space-between" },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  title: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700",
    textShadowColor: "rgba(0,0,0,0.8)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  exitBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 18,
    backgroundColor: "rgba(0,0,0,0.45)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.25)",
  },
  exitText: { color: "#fff", fontSize: 14, fontWeight: "600" },
  bottom: { paddingHorizontal: 16, paddingBottom: 16, gap: 12 },
  status: {
    color: "#fff",
    fontSize: 13,
    lineHeight: 18,
    textAlign: "center",
    backgroundColor: "rgba(0,0,0,0.5)",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    overflow: "hidden",
  },
  controls: { flexDirection: "row", justifyContent: "center", gap: 10 },
  btn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.9)",
  },
  btnSecondary: { backgroundColor: "rgba(0,0,0,0.5)", borderWidth: 1, borderColor: "rgba(255,255,255,0.3)" },
  btnDisabled: { opacity: 0.45 },
  btnText: { fontSize: 15, fontWeight: "700", color: "#000" },
  btnTextSecondary: { color: "#fff" },
});
