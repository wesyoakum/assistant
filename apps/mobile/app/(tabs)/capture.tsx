import { useState } from "react";
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  Alert,
  ActivityIndicator,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import { Audio } from "expo-av";
import { useAuth } from "../../src/state/auth";

const API_BASE = "https://api.whyapp.us";

type UploadState = "idle" | "uploading" | "processing" | "done" | "error";

async function uploadFile(
  uri: string,
  contentType: string,
  token: string
): Promise<{ id: string }> {
  const res = await fetch(uri);
  const blob = await res.blob();

  const uploadRes = await fetch(`${API_BASE}/files/upload`, {
    method: "POST",
    headers: {
      "Content-Type": contentType,
      Authorization: `Bearer ${token}`,
    },
    body: blob,
  });

  if (!uploadRes.ok) {
    const err = await uploadRes.text();
    throw new Error(`Upload failed: ${err}`);
  }

  return uploadRes.json();
}

export default function CaptureScreen() {
  const { token } = useAuth();
  const [state, setState] = useState<UploadState>("idle");
  const [recording, setRecording] = useState<Audio.Recording | null>(null);
  const [isRecording, setIsRecording] = useState(false);

  const handleResult = (id: string) => {
    setState("done");
    Alert.alert("Captured", "Your item is being analyzed and will appear in Triage shortly.", [
      { text: "OK", onPress: () => setState("idle") },
    ]);
  };

  const handleError = (err: unknown) => {
    setState("error");
    const msg = err instanceof Error ? err.message : "Unknown error";
    Alert.alert("Upload Failed", msg, [
      { text: "OK", onPress: () => setState("idle") },
    ]);
  };

  const pickPhoto = async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("Permission needed", "Camera access is required to take photos.");
      return;
    }

    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ["images"],
      quality: 0.8,
    });

    if (result.canceled || !result.assets[0]) return;

    setState("uploading");
    try {
      const asset = result.assets[0];
      const type = asset.mimeType || "image/jpeg";
      const data = await uploadFile(asset.uri, type, token!);
      handleResult(data.id);
    } catch (err) {
      handleError(err);
    }
  };

  const pickImage = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("Permission needed", "Photo library access is required.");
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 0.8,
    });

    if (result.canceled || !result.assets[0]) return;

    setState("uploading");
    try {
      const asset = result.assets[0];
      const type = asset.mimeType || "image/jpeg";
      const data = await uploadFile(asset.uri, type, token!);
      handleResult(data.id);
    } catch (err) {
      handleError(err);
    }
  };

  const pickDocument = async () => {
    const result = await DocumentPicker.getDocumentAsync({
      type: ["application/pdf", "image/*"],
      copyToCacheDirectory: true,
    });

    if (result.canceled || !result.assets[0]) return;

    setState("uploading");
    try {
      const asset = result.assets[0];
      const type = asset.mimeType || "application/pdf";
      const data = await uploadFile(asset.uri, type, token!);
      handleResult(data.id);
    } catch (err) {
      handleError(err);
    }
  };

  const startRecording = async () => {
    try {
      const perm = await Audio.requestPermissionsAsync();
      if (!perm.granted) {
        Alert.alert("Permission needed", "Microphone access is required for voice memos.");
        return;
      }

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });

      const { recording: rec } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY
      );
      setRecording(rec);
      setIsRecording(true);
    } catch (err) {
      handleError(err);
    }
  };

  const stopRecording = async () => {
    if (!recording) return;

    setIsRecording(false);
    setState("uploading");

    try {
      await recording.stopAndUnloadAsync();
      const uri = recording.getURI();
      setRecording(null);

      if (!uri) throw new Error("No recording URI");

      const data = await uploadFile(uri, "audio/m4a", token!);
      handleResult(data.id);
    } catch (err) {
      setRecording(null);
      handleError(err);
    }
  };

  const busy = state === "uploading" || state === "processing";

  return (
    <View style={styles.container}>
      {busy ? (
        <View style={styles.busyWrap}>
          <ActivityIndicator size="large" />
          <Text style={styles.busyText}>
            {state === "uploading" ? "Uploading..." : "Analyzing..."}
          </Text>
        </View>
      ) : (
        <>
          <Text style={styles.heading}>Capture</Text>
          <Text style={styles.subtext}>
            Take a photo, pick a file, or record a voice memo. It will be
            analyzed and added to your triage.
          </Text>

          <View style={styles.grid}>
            <Pressable style={styles.card} onPress={pickPhoto}>
              <Text style={styles.cardIcon}>C</Text>
              <Text style={styles.cardLabel}>Camera</Text>
            </Pressable>

            <Pressable style={styles.card} onPress={pickImage}>
              <Text style={styles.cardIcon}>P</Text>
              <Text style={styles.cardLabel}>Photo Library</Text>
            </Pressable>

            <Pressable style={styles.card} onPress={pickDocument}>
              <Text style={styles.cardIcon}>D</Text>
              <Text style={styles.cardLabel}>Document</Text>
            </Pressable>

            <Pressable
              style={[styles.card, isRecording && styles.cardRecording]}
              onPress={isRecording ? stopRecording : startRecording}
            >
              <Text style={styles.cardIcon}>{isRecording ? "S" : "V"}</Text>
              <Text style={styles.cardLabel}>
                {isRecording ? "Stop Recording" : "Voice Memo"}
              </Text>
            </Pressable>
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#fff",
    padding: 24,
    justifyContent: "center",
  },
  heading: { fontSize: 28, fontWeight: "700", color: "#111", marginBottom: 8 },
  subtext: { fontSize: 15, color: "#888", lineHeight: 22, marginBottom: 32 },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
  },
  card: {
    width: "47%",
    backgroundColor: "#f5f5f5",
    borderRadius: 16,
    paddingVertical: 28,
    alignItems: "center",
    gap: 8,
  },
  cardRecording: {
    backgroundColor: "#fee2e2",
  },
  cardIcon: { fontSize: 28, fontWeight: "700", color: "#4285F4" },
  cardLabel: { fontSize: 14, fontWeight: "600", color: "#555" },
  busyWrap: { alignItems: "center", gap: 12 },
  busyText: { fontSize: 16, color: "#888" },
});
