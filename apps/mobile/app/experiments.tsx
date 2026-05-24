import { useState, useEffect } from "react";
import { View, Text, ScrollView, StyleSheet, Pressable, Alert, Platform } from "react-native";
import * as Device from "expo-device";
import Constants from "expo-constants";
import * as Clipboard from "expo-clipboard";
import * as Notifications from "expo-notifications";
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

export default function ExperimentsScreen() {
  const { token } = useAuth();
  const { data: me } = useMe();
  const [pushToken, setPushToken] = useState<string | null>(null);
  const [pushPerm, setPushPerm] = useState<string>("?");
  const [clipboardSnap, setClipboardSnap] = useState<string>("");

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
        Read-only sandbox of what we can access through current Expo modules. Sensors (accelerometer, GPS, haptics, battery) need a new TestFlight build — say the word and I'll queue one.
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
});
