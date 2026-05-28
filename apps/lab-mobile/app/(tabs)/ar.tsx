import React, { useRef, useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  SafeAreaView,
} from "react-native";
import {
  LidarARView,
  lidarARViewAvailable,
  type LidarARViewRef,
} from "../../modules/expo-lidar/src";

type VizToggle = "planes" | "mesh" | "features";

export default function ARScreen() {
  const arRef = useRef<LidarARViewRef>(null);
  const [active, setActive] = useState<Record<VizToggle, boolean>>({
    planes: false,
    mesh: false,
    features: false,
  });

  const toggle = (key: VizToggle) =>
    setActive((prev) => ({ ...prev, [key]: !prev[key] }));

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
      <LidarARView
        ref={arRef}
        style={StyleSheet.absoluteFill}
        showPlanes={active.planes}
        showMesh={active.mesh}
        showFeaturePoints={active.features}
      />

      {/* Transparent overlay controls */}
      <SafeAreaView style={styles.overlay} pointerEvents="box-none">
        <View style={styles.controlBar}>
          <TogglePill
            label="Planes"
            active={active.planes}
            onPress={() => toggle("planes")}
          />
          <TogglePill
            label="Mesh"
            active={active.mesh}
            onPress={() => toggle("mesh")}
          />
          <TogglePill
            label="Features"
            active={active.features}
            onPress={() => toggle("features")}
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
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      style={[styles.pill, active && styles.pillActive]}
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
  controlBar: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 10,
    paddingBottom: 24,
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
  pillText: {
    color: "rgba(255, 255, 255, 0.9)",
    fontSize: 14,
    fontWeight: "600",
  },
  pillTextActive: {
    color: "#000",
  },
});
