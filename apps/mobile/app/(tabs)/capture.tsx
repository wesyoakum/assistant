import { useState, useCallback, useEffect } from "react";
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  Alert,
  ActivityIndicator,
  FlatList,
  Image,
  RefreshControl,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import { Audio } from "expo-av";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../../src/state/auth";
import { API_BASE, apiFetch } from "../../src/api/client";

type UploadState = "idle" | "uploading" | "processing" | "done" | "error";

interface IngestedFile {
  id: string;
  kind: "image" | "pdf" | "audio";
  r2_key: string;
  status: "pending" | "processing" | "done" | "error";
  created_at: string;
}

interface TriageItemRef {
  id: string;
}

function fileIcon(kind: string): keyof typeof Ionicons.glyphMap {
  switch (kind) {
    case "image": return "image-outline";
    case "pdf": return "document-text-outline";
    case "audio": return "musical-notes-outline";
    default: return "document-outline";
  }
}

function fileKindLabel(kind: string): string {
  switch (kind) {
    case "image": return "Image";
    case "pdf": return "Document";
    case "audio": return "Voice Memo";
    default: return "File";
  }
}

function statusColor(status: string): string {
  switch (status) {
    case "done": return "#38a169";
    case "processing":
    case "pending": return "#ed8936";
    case "error": return "#e53e3e";
    default: return "#a0aec0";
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case "done": return "Done";
    case "processing": return "Processing";
    case "pending": return "Pending";
    case "error": return "Error";
    default: return status;
  }
}

function formatFileDate(dateStr: string): string {
  return new Date(dateStr).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

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

function FileThumbnail({ file, token }: { file: IngestedFile; token: string }) {
  const [blobUri, setBlobUri] = useState<string | null>(null);

  useEffect(() => {
    if (file.kind === "image" && file.status === "done") {
      fetch(`${API_BASE}/files/${file.id}/download`, {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then((res) => res.blob())
        .then((blob) => {
          const reader = new FileReader();
          reader.onload = () => setBlobUri(reader.result as string);
          reader.readAsDataURL(blob);
        })
        .catch(() => {});
    }
  }, [file.id, file.kind, file.status, token]);

  if (file.kind === "image" && blobUri) {
    return (
      <Image source={{ uri: blobUri }} style={styles.fileThumbnail} />
    );
  }

  return (
    <View style={styles.fileIconWrap}>
      <Ionicons name={fileIcon(file.kind)} size={24} color="#4285F4" />
    </View>
  );
}

export default function CaptureScreen() {
  const { token } = useAuth();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [state, setState] = useState<UploadState>("idle");
  const [recording, setRecording] = useState<Audio.Recording | null>(null);
  const [isRecording, setIsRecording] = useState(false);

  const {
    data: filesData,
    isLoading: filesLoading,
    refetch: refetchFiles,
  } = useQuery({
    queryKey: ["files"],
    queryFn: () => apiFetch<{ files: IngestedFile[] }>("/files"),
    enabled: !!token,
  });

  const handleResult = (id: string) => {
    setState("done");
    queryClient.invalidateQueries({ queryKey: ["files"] });
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

  const handleFileTap = useCallback(async (file: IngestedFile) => {
    if (file.status !== "done") return;

    // Find the triage item that references this file
    try {
      const data = await apiFetch<{ items: TriageItemRef[] }>(
        `/triage?source_type=${file.kind === "audio" ? "voice" : file.kind === "pdf" ? "document" : "image"}&limit=50`
      );
      const match = data.items.find((item: any) => item.source_ref === file.id);
      if (match) {
        router.push(`/triage/${match.id}`);
      } else {
        Alert.alert("Not Found", "No triage item found for this file yet.");
      }
    } catch {
      Alert.alert("Error", "Could not look up triage item.");
    }
  }, [router]);

  const busy = state === "uploading" || state === "processing";

  const renderFileRow = useCallback(({ item: file }: { item: IngestedFile }) => (
    <Pressable
      style={styles.fileRow}
      onPress={() => handleFileTap(file)}
      disabled={file.status !== "done"}
    >
      <FileThumbnail file={file} token={token!} />
      <View style={styles.fileInfo}>
        <Text style={styles.fileKind}>{fileKindLabel(file.kind)}</Text>
        <Text style={styles.fileDate}>{formatFileDate(file.created_at)}</Text>
      </View>
      <View style={[styles.statusBadge, { backgroundColor: statusColor(file.status) + "22" }]}>
        <Text style={[styles.statusText, { color: statusColor(file.status) }]}>
          {statusLabel(file.status)}
        </Text>
      </View>
      {file.status === "done" && (
        <Ionicons name="chevron-forward" size={18} color="#ccc" />
      )}
    </Pressable>
  ), [token, handleFileTap]);

  const files = filesData?.files ?? [];

  const ListHeader = (
    <>
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
              <Ionicons name="camera-outline" size={32} color="#4285F4" />
              <Text style={styles.cardLabel}>Camera</Text>
            </Pressable>

            <Pressable style={styles.card} onPress={pickImage}>
              <Ionicons name="images-outline" size={32} color="#4285F4" />
              <Text style={styles.cardLabel}>Photo Library</Text>
            </Pressable>

            <Pressable style={styles.card} onPress={pickDocument}>
              <Ionicons name="document-outline" size={32} color="#4285F4" />
              <Text style={styles.cardLabel}>Document</Text>
            </Pressable>

            <Pressable
              style={[styles.card, isRecording && styles.cardRecording]}
              onPress={isRecording ? stopRecording : startRecording}
            >
              <Ionicons name={isRecording ? "stop-circle-outline" : "mic-outline"} size={32} color={isRecording ? "#e53e3e" : "#4285F4"} />
              <Text style={styles.cardLabel}>
                {isRecording ? "Stop Recording" : "Voice Memo"}
              </Text>
            </Pressable>
          </View>
        </>
      )}

      {/* Recent captures section header */}
      <View style={styles.recentHeader}>
        <Text style={styles.recentTitle}>Recent Captures</Text>
        {filesLoading && <ActivityIndicator size="small" />}
      </View>
    </>
  );

  return (
    <FlatList
      style={styles.container}
      contentContainerStyle={styles.listContent}
      data={files}
      keyExtractor={(item) => item.id}
      renderItem={renderFileRow}
      ListHeaderComponent={ListHeader}
      ListEmptyComponent={
        !filesLoading ? (
          <Text style={styles.emptyText}>No files captured yet.</Text>
        ) : null
      }
      refreshControl={
        <RefreshControl
          refreshing={false}
          onRefresh={() => refetchFiles()}
        />
      }
    />
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#fff",
  },
  listContent: {
    padding: 24,
    paddingBottom: 40,
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
  cardLabel: { fontSize: 14, fontWeight: "600", color: "#555", marginTop: 4 },
  busyWrap: { alignItems: "center", gap: 12, paddingVertical: 40 },
  busyText: { fontSize: 16, color: "#888" },
  // Recent captures section
  recentHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 32,
    marginBottom: 12,
  },
  recentTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#111",
  },
  emptyText: {
    fontSize: 14,
    color: "#aaa",
    textAlign: "center",
    paddingVertical: 20,
  },
  fileRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    paddingHorizontal: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#eee",
    gap: 12,
  },
  fileThumbnail: {
    width: 44,
    height: 44,
    borderRadius: 8,
    backgroundColor: "#f0f0f0",
  },
  fileIconWrap: {
    width: 44,
    height: 44,
    borderRadius: 8,
    backgroundColor: "#f0f0f0",
    justifyContent: "center",
    alignItems: "center",
  },
  fileInfo: {
    flex: 1,
  },
  fileKind: {
    fontSize: 15,
    fontWeight: "600",
    color: "#333",
  },
  fileDate: {
    fontSize: 12,
    color: "#999",
    marginTop: 2,
  },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
  },
  statusText: {
    fontSize: 11,
    fontWeight: "600",
  },
});
