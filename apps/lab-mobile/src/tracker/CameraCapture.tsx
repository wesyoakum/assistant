import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  SafeAreaView,
  ActivityIndicator,
  Alert,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as FileSystem from "expo-file-system";
import * as MediaLibrary from "expo-media-library";
import { VisionTracker } from "expo-vision-tracker";

type CaptureMode = "record" | "buffer";
type FacingType = "front" | "back";

function lensLabel(id: string): string {
  const lower = id.toLowerCase();
  if (lower.includes("ultrawide") || lower.includes("ultra_wide") || lower.includes("ultra wide")) return "0.5x";
  if (lower.includes("telephoto")) return "5x";
  if (lower.includes("wide") || lower === "back") return "1x";
  // Strip common prefixes for unknown lenses.
  return id.replace(/^builtIn/i, "").replace(/^back/i, "").replace(/Camera$/i, "").trim() || id;
}

// Filter out compound cameras and LiDAR — keep individual physical lenses.
function isPhysicalLens(id: string): boolean {
  const lower = id.toLowerCase();
  if (lower.includes("dual") || lower.includes("triple") || lower.includes("lidar")) return false;
  return true;
}

interface Props {
  onCapture: (uri: string) => void;
  onCancel: () => void;
}

export function CameraCapture({ onCapture, onCancel }: Props) {
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);
  const [mode, setMode] = useState<CaptureMode>("record");
  const [facing, setFacing] = useState<FacingType>("back");
  const [lens, setLens] = useState<string>("builtInWideAngleCamera");
  const [availableLenses, setAvailableLenses] = useState<string[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [bufferSeconds, setBufferSeconds] = useState(5);
  const [busy, setBusy] = useState<string | null>(null);
  const [segmentCount, setSegmentCount] = useState(0);

  // Save to camera roll then pass to tracker.
  const saveAndCapture = useCallback(async (uri: string) => {
    try {
      const { status } = await MediaLibrary.requestPermissionsAsync();
      if (status === "granted") {
        await MediaLibrary.saveToLibraryAsync(uri);
      }
    } catch {}
    onCapture(uri);
  }, [onCapture]);

  // Buffer mode: ring buffer of segment URIs.
  const segmentsRef = useRef<string[]>([]);
  const bufferActiveRef = useRef(false);
  const segmentDuration = 1; // seconds per segment

  // Request permission on mount.
  useEffect(() => {
    if (!permission?.granted) requestPermission();
  }, [permission]);

  // Query available lenses when camera is ready.
  const onCameraReady = useCallback(async () => {
    try {
      const lenses = await cameraRef.current?.getAvailableLensesAsync?.();
      if (lenses && lenses.length > 0) {
        setAvailableLenses(lenses);
        if (!lenses.includes(lens)) setLens(lenses[0]!);
      }
    } catch {}
  }, [lens]);

  // Clean up segments on unmount.
  useEffect(() => {
    return () => {
      bufferActiveRef.current = false;
      for (const uri of segmentsRef.current) {
        FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
      }
    };
  }, []);

  // ── Record mode ──

  const startRecording = useCallback(() => {
    if (!cameraRef.current || isRecording) return;
    setIsRecording(true);
    cameraRef.current.recordAsync().then((result) => {
      setIsRecording(false);
      if (result?.uri) saveAndCapture(result.uri);
    }).catch((e: any) => {
      setIsRecording(false);
      Alert.alert("Recording failed", e?.message ?? "Unknown error");
    });
  }, [isRecording, saveAndCapture]);

  const stopRecording = useCallback(() => {
    cameraRef.current?.stopRecording();
  }, []);

  // ── Buffer mode ──

  // Buffer mode: record in segments, keep a ring buffer of the last N seconds.
  const bufferTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const recordOneSegment = useCallback((): Promise<string | null> => {
    return new Promise((resolve) => {
      if (!cameraRef.current || !bufferActiveRef.current) { resolve(null); return; }
      const cam = cameraRef.current;
      // Stop after segmentDuration seconds.
      const timer = setTimeout(() => {
        try { cam.stopRecording(); } catch {}
      }, segmentDuration * 1000);
      cam.recordAsync().then((result) => {
        clearTimeout(timer);
        resolve(result?.uri ?? null);
      }).catch(() => {
        clearTimeout(timer);
        resolve(null);
      });
    });
  }, []);

  // Resolves when the buffer loop has stopped and all segments are collected.
  const bufferDoneRef = useRef<((segments: string[]) => void) | null>(null);

  const startBuffering = useCallback(async () => {
    if (!cameraRef.current || bufferActiveRef.current) return;
    bufferActiveRef.current = true;
    segmentsRef.current = [];
    setSegmentCount(0);
    setIsRecording(true);

    bufferTimerRef.current = setInterval(() => {
      setSegmentCount(segmentsRef.current.length);
    }, 500);

    // Record segments in a loop.
    while (bufferActiveRef.current) {
      const uri = await recordOneSegment();
      if (uri) {
        segmentsRef.current.push(uri);
        const maxSegments = Math.ceil(bufferSeconds / segmentDuration);
        while (segmentsRef.current.length > maxSegments) {
          const old = segmentsRef.current.shift();
          if (old) FileSystem.deleteAsync(old, { idempotent: true }).catch(() => {});
        }
        setSegmentCount(segmentsRef.current.length);
      }
      // Check if capture was requested — if so, the current segment just
      // finished naturally (stopRecording wasn't called mid-segment).
      if (!bufferActiveRef.current) break;
    }
    if (bufferTimerRef.current) clearInterval(bufferTimerRef.current);
    // Signal that the loop is done with the final segment list.
    if (bufferDoneRef.current) {
      bufferDoneRef.current([...segmentsRef.current]);
      bufferDoneRef.current = null;
    }
  }, [bufferSeconds, recordOneSegment]);

  const captureBuffer = useCallback(async () => {
    // Signal the loop to stop after the current segment finishes.
    setBusy("finishing segment…");
    const segments = await new Promise<string[]>((resolve) => {
      bufferDoneRef.current = resolve;
      bufferActiveRef.current = false;
      // Don't call stopRecording — let the current segment's setTimeout
      // finish it naturally.
    });
    setIsRecording(false);
    if (bufferTimerRef.current) clearInterval(bufferTimerRef.current);
    if (segments.length === 0) {
      Alert.alert("No buffer", "No video segments captured yet. Try waiting a few seconds.");
      return;
    }
    if (segments.length === 1) {
      saveAndCapture(segments[0]!);
      return;
    }
    // Stitch multiple segments into one video.
    setBusy("stitching…");
    try {
      const result = await VisionTracker.stitchVideos(segments);
      setBusy(null);
      saveAndCapture(result.uri);
    } catch (e: any) {
      setBusy(null);
      Alert.alert("Stitch failed", e?.message ?? "Using last segment instead.");
      saveAndCapture(segments[segments.length - 1]!);
    }
  }, [saveAndCapture]);

  if (!permission) {
    return (
      <View style={styles.container}>
        <ActivityIndicator color="#fff" />
      </View>
    );
  }
  if (!permission.granted) {
    return (
      <View style={styles.container}>
        <Text style={styles.msg}>Camera permission required</Text>
        <Pressable onPress={requestPermission} style={styles.btn}>
          <Text style={styles.btnTxt}>Grant Permission</Text>
        </Pressable>
        <Pressable onPress={onCancel} style={[styles.btn, { backgroundColor: "#333" }]}>
          <Text style={styles.btnTxt}>Cancel</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <CameraView
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        facing={facing}
        mode="video"
        videoQuality="1080p"
        mute
        {...(facing === "back" ? { selectedLens: lens } : {})}
        onCameraReady={onCameraReady}
      />

      <SafeAreaView style={StyleSheet.absoluteFill} pointerEvents="box-none">
        {/* Top controls */}
        <View style={styles.topBar}>
          <Pressable onPress={onCancel} style={styles.pill}>
            <Text style={styles.pillTxt}>Cancel</Text>
          </Pressable>

          <View style={{ flexDirection: "row", gap: 6 }}>
            <Pressable
              onPress={() => { if (!isRecording) setMode("record"); }}
              style={[styles.pill, mode === "record" && styles.pillActive]}
            >
              <Text style={[styles.pillTxt, mode === "record" && styles.pillTxtActive]}>Record</Text>
            </Pressable>
            <Pressable
              onPress={() => { if (!isRecording) setMode("buffer"); }}
              style={[styles.pill, mode === "buffer" && styles.pillActive]}
            >
              <Text style={[styles.pillTxt, mode === "buffer" && styles.pillTxtActive]}>Buffer</Text>
            </Pressable>
          </View>

          <Pressable
            onPress={() => { if (!isRecording) setFacing((f) => f === "back" ? "front" : "back"); }}
            style={styles.pill}
          >
            <Text style={styles.pillTxt}>Flip</Text>
          </Pressable>
        </View>

        {/* Lens picker (back camera only, shows available lenses) */}
        {facing === "back" && !isRecording && (() => {
          const physical = availableLenses.filter(isPhysicalLens);
          return physical.length > 1 ? (
            <View style={{ flexDirection: "row", justifyContent: "center", gap: 6, marginTop: 8 }}>
              {physical.map((l) => (
                <Pressable
                  key={l}
                  onPress={() => setLens(l)}
                  style={[styles.pill, { paddingHorizontal: 14, paddingVertical: 8 }, lens === l && styles.pillActive]}
                >
                  <Text style={[styles.pillTxt, { fontSize: 14 }, lens === l && styles.pillTxtActive]}>
                    {lensLabel(l)}
                  </Text>
                </Pressable>
              ))}
            </View>
          ) : null;
        })()}

        {/* Buffer duration control */}
        {mode === "buffer" && !isRecording && (
          <View style={styles.bufferBar}>
            {[3, 5, 10].map((s) => (
              <Pressable
                key={s}
                onPress={() => setBufferSeconds(s)}
                style={[styles.pill, bufferSeconds === s && styles.pillActive]}
              >
                <Text style={[styles.pillTxt, bufferSeconds === s && styles.pillTxtActive]}>{s}s</Text>
              </Pressable>
            ))}
          </View>
        )}

        {/* Bottom controls */}
        <View style={styles.bottomBar}>
          {busy ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <ActivityIndicator color="#fff" />
              <Text style={{ color: "#fff", fontSize: 14 }}>{busy}</Text>
            </View>
          ) : mode === "record" ? (
            <Pressable
              onPress={isRecording ? stopRecording : startRecording}
              style={[styles.recordBtn, isRecording && styles.recordBtnActive]}
            >
              <View style={[styles.recordDot, isRecording && styles.recordDotActive]} />
            </Pressable>
          ) : (
            <>
              {!isRecording ? (
                <View style={{ alignItems: "center" }}>
                  <Pressable onPress={startBuffering} style={styles.recordBtn}>
                    <View style={[styles.recordDot, { backgroundColor: "#34C759" }]} />
                  </Pressable>
                  <Text style={{ color: "#aaa", fontSize: 11, marginTop: 8 }}>Tap to start buffer</Text>
                </View>
              ) : segmentCount === 0 ? (
                <View style={{ alignItems: "center" }}>
                  <View style={[styles.recordBtn, { borderColor: "#34C759", opacity: 0.5 }]}>
                    <ActivityIndicator color="#34C759" />
                  </View>
                  <Text style={{ color: "#34C759", fontSize: 12, marginTop: 8 }}>Recording first segment…</Text>
                </View>
              ) : (
                <View style={{ alignItems: "center" }}>
                  <Pressable onPress={captureBuffer} style={[styles.recordBtn, { borderColor: "#34C759" }]}>
                    <View style={{ width: 20, height: 20, borderRadius: 4, backgroundColor: "#34C759" }} />
                  </Pressable>
                  <Text style={{ color: "#34C759", fontSize: 14, fontWeight: "700", marginTop: 8 }}>
                    {segmentCount * segmentDuration}s buffered — tap to save
                  </Text>
                </View>
              )}
            </>
          )}
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000",
    alignItems: "center",
    justifyContent: "center",
  },
  msg: { color: "#fff", fontSize: 16, marginBottom: 16 },
  btn: {
    backgroundColor: "#4285F4",
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 10,
    marginTop: 8,
  },
  btnTxt: { color: "#fff", fontSize: 14, fontWeight: "600" },
  topBar: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingTop: 8,
  },
  bottomBar: {
    position: "absolute",
    bottom: 40,
    left: 0,
    right: 0,
    alignItems: "center",
  },
  bufferBar: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 8,
    marginTop: 8,
  },
  pill: {
    backgroundColor: "rgba(0,0,0,0.5)",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
  },
  pillActive: {
    backgroundColor: "#fff",
  },
  pillTxt: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "600",
  },
  pillTxtActive: {
    color: "#000",
  },
  recordBtn: {
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 4,
    borderColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
  recordBtnActive: {
    borderColor: "#FF3B30",
  },
  recordDot: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: "#FF3B30",
  },
  recordDotActive: {
    width: 20,
    height: 20,
    borderRadius: 4,
    backgroundColor: "#FF3B30",
  },
});
