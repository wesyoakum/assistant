import { useState, useEffect } from "react";
import { View, Text, ScrollView, StyleSheet, Pressable, Alert, Platform } from "react-native";
import * as Device from "expo-device";
import Constants from "expo-constants";
import * as Clipboard from "expo-clipboard";
import * as Notifications from "expo-notifications";
import { Accelerometer, Gyroscope, Magnetometer } from "expo-sensors";
import * as Location from "expo-location";
import * as Haptics from "expo-haptics";
import * as Battery from "expo-battery";
import { useAuth } from "../src/state/auth";
import { useMe } from "../src/hooks/useMe";

interface Row {
  label: string;
  value: string | number | boolean | null | undefined;
}

function Section({ title, rows }: { title: string; rows: Row[] }) {
  return (
    <View style={{ marginBottom: 20 }}>
      <Text style={styles.sectionTitle}>{title}</Text>
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

export default function ExperimentsScreen() {
  const { token } = useAuth();
  const { data: me } = useMe();
  const [pushToken, setPushToken] = useState<string | null>(null);
  const [pushPerm, setPushPerm] = useState<string>("?");
  const [clipboardSnap, setClipboardSnap] = useState<string>("");

  // Sensors — live values, polled at ~5 Hz (200 ms)
  const [accel, setAccel] = useState<{ x: number; y: number; z: number } | null>(null);
  const [gyro, setGyro] = useState<{ x: number; y: number; z: number } | null>(null);
  const [mag, setMag] = useState<{ x: number; y: number; z: number } | null>(null);

  useEffect(() => {
    Accelerometer.setUpdateInterval(200);
    Gyroscope.setUpdateInterval(200);
    Magnetometer.setUpdateInterval(200);
    const subs = [
      Accelerometer.addListener(setAccel),
      Gyroscope.addListener(setGyro),
      Magnetometer.addListener(setMag),
    ];
    return () => subs.forEach((s) => s.remove());
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

  // Location — on demand, not always-on
  const [loc, setLoc] = useState<Location.LocationObject | null>(null);
  const [locStatus, setLocStatus] = useState<string>("not requested");
  const requestLocation = async () => {
    try {
      setLocStatus("requesting…");
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status !== "granted") {
        setLocStatus(`denied: ${perm.status}`);
        return;
      }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      setLoc(pos);
      setLocStatus("granted");
    } catch (err) {
      setLocStatus(`error: ${(err as Error).message}`);
    }
  };

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
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
      <Text style={{ fontSize: 13, color: "#888", marginBottom: 16 }}>
        Sandbox of iPhone APIs reachable through Expo modules. Motion sensors update live; location is on-demand.
      </Text>

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

      <Section
        title="Clipboard (expo-clipboard)"
        rows={[{ label: "Current clipboard", value: clipboardSnap || "(tap Read below)" }]}
      />
      <Pressable style={styles.btn} onPress={refreshClipboard}>
        <Text style={styles.btnText}>Read clipboard</Text>
      </Pressable>

      <Section
        title="Motion (expo-sensors)"
        rows={[
          { label: "Accelerometer x", value: accel ? fmt(accel.x, 3) : null },
          { label: "Accelerometer y", value: accel ? fmt(accel.y, 3) : null },
          { label: "Accelerometer z", value: accel ? fmt(accel.z, 3) : null },
          { label: "Gyroscope x", value: gyro ? fmt(gyro.x, 3) : null },
          { label: "Gyroscope y", value: gyro ? fmt(gyro.y, 3) : null },
          { label: "Gyroscope z", value: gyro ? fmt(gyro.z, 3) : null },
          { label: "Magnetometer x", value: mag ? fmt(mag.x, 1) : null },
          { label: "Magnetometer y", value: mag ? fmt(mag.y, 1) : null },
          { label: "Magnetometer z", value: mag ? fmt(mag.z, 1) : null },
        ]}
      />

      <Section
        title="Battery (expo-battery)"
        rows={[
          { label: "Level", value: battery ? `${Math.round(battery.level * 100)}%` : null },
          { label: "State", value: battery ? batteryStateLabel(battery.state) : null },
          { label: "Low power mode", value: battery?.lowPower },
        ]}
      />

      <Section
        title="Location (expo-location)"
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
      <Pressable style={styles.btn} onPress={requestLocation}>
        <Text style={styles.btnText}>Get current location</Text>
      </Pressable>

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
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f2f2f7" },
  sectionTitle: {
    fontSize: 12,
    fontWeight: "600",
    color: "#888",
    textTransform: "uppercase",
    marginBottom: 6,
    marginLeft: 4,
  },
  card: { backgroundColor: "#fff", borderRadius: 12, overflow: "hidden" },
  row: {
    flexDirection: "row",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#eee",
  },
  rowLabel: { flex: 1, fontSize: 13, color: "#666" },
  rowValue: { flex: 1, fontSize: 13, color: "#222", textAlign: "right" },
  btn: {
    backgroundColor: "#4285F4",
    paddingVertical: 12,
    alignItems: "center",
    borderRadius: 10,
    marginTop: -10,
    marginBottom: 20,
  },
  btnText: { color: "#fff", fontWeight: "600", fontSize: 14 },
  hapBtn: {
    backgroundColor: "#eef3fb",
    borderColor: "#4285F4",
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 16,
  },
  hapBtnText: { color: "#4285F4", fontWeight: "600", fontSize: 13 },
});
