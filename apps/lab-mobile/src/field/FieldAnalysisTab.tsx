import React, { useCallback, useMemo, useState } from "react";
import {
  View, Text, Pressable, StyleSheet, ScrollView, Image, ActivityIndicator,
  type LayoutChangeEvent, type GestureResponderEvent,
} from "react-native";
import Svg, { Circle, Line, Polyline, Polygon, Text as SvgText } from "react-native-svg";
import * as ImagePicker from "expo-image-picker";
import { VisionTracker, type FirstFrameResult } from "expo-vision-tracker";
import { Yolo } from "expo-yolo";
import { useTheme } from "../theme";
import {
  FIELD_SPECS, buildFieldLandmarks, type LandmarkId, type GroundPoint,
} from "../field/fieldTemplate";
import {
  fitHomography, fieldToImage, type Correspondence, type Homography,
} from "../field/videoHomography";

// Field Analysis: reconcile a non-AR clip to the field (VIDEO_ANALYSIS.md).
// Flow: import clip → scrub to a clear frame → tap field landmarks and label
// each → fit the ground homography → overlay the projected field + run YOLO to
// draw the 2D ball path. All on-ground; no live AR. Built on the unit-tested
// fieldTemplate + videoHomography core.

type SpecKey = keyof typeof FIELD_SPECS;

// The landmarks the user can place, in the order the picker offers them.
const LABEL_CHOICES: { id: LandmarkId; label: string }[] = [
  { id: "apex", label: "Home (apex)" },
  { id: "first_base", label: "1st base" },
  { id: "second_base", label: "2nd base" },
  { id: "third_base", label: "3rd base" },
  { id: "rubber", label: "Rubber" },
  { id: "foul_pole_first", label: "RF pole" },
  { id: "foul_pole_third", label: "LF pole" },
  { id: "plate_front", label: "Plate front" },
];

interface PlacedLabel {
  id: LandmarkId;
  /** Normalized image coords (0..1). */
  nx: number;
  ny: number;
}

interface BallPoint { nx: number; ny: number; conf: number; t: number }

export function FieldAnalysisTab() {
  const theme = useTheme();
  const [videoUri, setVideoUri] = useState<string | null>(null);
  const [frame, setFrame] = useState<FirstFrameResult | null>(null);
  const [frameTimeSec, setFrameTimeSec] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [specKey, setSpecKey] = useState<SpecKey>("highSchool");
  const [labels, setLabels] = useState<PlacedLabel[]>([]);
  const [pendingId, setPendingId] = useState<LandmarkId>("apex");
  const [homography, setHomography] = useState<{ H: Homography; rmsPx: number } | null>(null);
  const [ballPath, setBallPath] = useState<BallPoint[] | null>(null);

  // Canvas geometry (image is rendered resizeMode="contain" to avoid the crop
  // that "cover" introduces — taps must map to true image pixels for the fit).
  const [canvas, setCanvas] = useState({ width: 1, height: 1 });

  const landmarks = useMemo(() => buildFieldLandmarks(FIELD_SPECS[specKey]!), [specKey]);

  const pickVideo = useCallback(async () => {
    setErr(null);
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { setErr("Photo library permission denied."); return; }
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions?.Videos ?? ("videos" as any),
      quality: 1,
    });
    if (res.canceled || !res.assets?.[0]) return;
    const uri = res.assets[0].uri;
    setVideoUri(uri);
    setFrame(null); setFrameTimeSec(0); setLabels([]); setHomography(null); setBallPath(null);
    await loadFrame(uri, 0);
  }, []);

  const loadFrame = useCallback(async (uri: string, timeSec: number) => {
    setBusy("loading frame…");
    try {
      const f = timeSec === 0
        ? await VisionTracker.firstFrame(uri, 0.9)
        : await VisionTracker.frameAtTime(uri, timeSec, 0.9);
      setFrame(f);
      setFrameTimeSec(timeSec);
    } catch (e) {
      setErr(`frame load failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }, []);

  const frameStep = useCallback((deltaSec: number) => {
    if (!videoUri || !frame) return;
    const max = Math.max(0, frame.durationSec - (frame.frameRate > 0 ? 1 / frame.frameRate : 0.001));
    const t = Math.max(0, Math.min(max, frameTimeSec + deltaSec));
    loadFrame(videoUri, t);
  }, [videoUri, frame, frameTimeSec, loadFrame]);

  const frameStepSec = frame && frame.frameRate > 0 ? 1 / frame.frameRate : 1 / 30;

  // The contained image rect inside the canvas (letterboxed). Taps outside the
  // image are ignored; inside → normalized image coords.
  const imageRect = useMemo(() => {
    if (!frame) return null;
    const ar = frame.imageWidth / frame.imageHeight;
    const car = canvas.width / canvas.height;
    let w = canvas.width, h = canvas.height, x = 0, y = 0;
    if (ar > car) { h = canvas.width / ar; y = (canvas.height - h) / 2; }
    else { w = canvas.height * ar; x = (canvas.width - w) / 2; }
    return { x, y, w, h };
  }, [frame, canvas]);

  const onCanvasPress = useCallback((e: GestureResponderEvent) => {
    if (!imageRect || !frame) return;
    const { locationX, locationY } = e.nativeEvent;
    const nx = (locationX - imageRect.x) / imageRect.w;
    const ny = (locationY - imageRect.y) / imageRect.h;
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return; // tapped the letterbox
    // Place / replace this landmark id.
    setLabels((prev) => [...prev.filter((l) => l.id !== pendingId), { id: pendingId, nx, ny }]);
    setHomography(null); setBallPath(null);
    // Advance the pending picker to the next unplaced choice.
    const placed = new Set([...labels.map((l) => l.id), pendingId]);
    const next = LABEL_CHOICES.find((c) => !placed.has(c.id));
    if (next) setPendingId(next.id);
  }, [imageRect, frame, pendingId, labels]);

  const solve = useCallback(() => {
    if (labels.length < 4) { setErr("Place at least 4 landmarks to solve."); return; }
    if (!frame) return;
    // Correspondences in PIXEL space (normalized × image dims) ↔ field ground.
    const corr: Correspondence[] = labels.map((l) => ({
      field: landmarks[l.id] as GroundPoint,
      image: { u: l.nx * frame.imageWidth, v: l.ny * frame.imageHeight },
    }));
    const fit = fitHomography(corr);
    if (!fit) { setErr("Couldn't solve — try spreading the landmarks out (avoid a line)."); return; }
    setErr(null);
    setHomography({ H: fit.H, rmsPx: fit.rmsPx });
  }, [labels, frame, landmarks]);

  const runBallPath = useCallback(async () => {
    if (!videoUri || !frame) return;
    setBusy("detecting ball…");
    setErr(null);
    try {
      const fps = frame.frameRate > 0 ? frame.frameRate : 30;
      const step = 1 / fps;
      const pts: BallPoint[] = [];
      let misses = 0;
      for (let t = frameTimeSec; t < frame.durationSec && misses < 20; t += step) {
        let f: FirstFrameResult;
        try { f = await VisionTracker.frameAtTime(videoUri, t, 0.85); } catch { break; }
        const res = await Yolo.detect(`data:image/jpeg;base64,${f.imageBase64}`, { minConfidence: 0.1 })
          .catch(() => null);
        const ball = res?.detections
          .filter((d) => d.label === "sports ball")
          .sort((a, b) => b.confidence - a.confidence)[0];
        if (ball) {
          misses = 0;
          pts.push({
            nx: ball.box.x + ball.box.width / 2,
            ny: ball.box.y + ball.box.height / 2,
            conf: ball.confidence, t,
          });
        } else { misses++; }
        if (pts.length > 300) break;
      }
      setBallPath(pts);
      if (pts.length === 0) setErr("No ball detected in this clip segment.");
    } catch (e) {
      setErr(`ball detection failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }, [videoUri, frame, frameTimeSec]);

  // Project the field model into image (normalized) coords for the overlay.
  const projectedField = useMemo(() => {
    if (!homography || !frame) return null;
    const toImg = (p: GroundPoint) => {
      const px = fieldToImage(homography.H, p);
      if (!px) return null;
      return { nx: px.x / frame.imageWidth, ny: px.y / frame.imageHeight };
    };
    const L = landmarks;
    return {
      foulFirst: [toImg(L.apex), toImg(L.foul_pole_first)],
      foulThird: [toImg(L.apex), toImg(L.foul_pole_third)],
      bases: [toImg(L.apex), toImg(L.first_base), toImg(L.second_base), toImg(L.third_base), toImg(L.apex)],
      rubber: toImg(L.rubber),
    };
  }, [homography, frame, landmarks]);

  const placedIds = new Set(labels.map((l) => l.id));

  if (!VisionTracker.available()) {
    return (
      <View style={[styles.center, { backgroundColor: theme.background }]}>
        <Text style={{ color: theme.text }}>Video frame extraction not available in this build.</Text>
      </View>
    );
  }

  // Helpers to map normalized image coords → on-screen canvas coords for SVG.
  const toCanvas = (nx: number, ny: number) =>
    imageRect ? { x: imageRect.x + nx * imageRect.w, y: imageRect.y + ny * imageRect.h } : { x: 0, y: 0 };
  const seg = (a: { nx: number; ny: number } | null, b: { nx: number; ny: number } | null) => {
    if (!a || !b) return null;
    const pa = toCanvas(a.nx, a.ny), pb = toCanvas(b.nx, b.ny);
    return { x1: pa.x, y1: pa.y, x2: pb.x, y2: pb.y };
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.background }} contentContainerStyle={{ padding: 12 }}>
      <Text style={[styles.h1, { color: theme.text }]}>Field Analysis</Text>
      <Text style={[styles.sub, { color: theme.textMuted }]}>
        Import a clip, tap field landmarks to label them, solve, then overlay the field + ball path.
      </Text>

      <Pressable onPress={pickVideo} style={[styles.btn, { backgroundColor: theme.primary }]}>
        <Text style={styles.btnText}>{videoUri ? "Pick a different video" : "Pick video"}</Text>
      </Pressable>

      {/* Level of play */}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
        {(Object.keys(FIELD_SPECS) as SpecKey[]).map((k) => (
          <Pressable key={k} onPress={() => { setSpecKey(k); setHomography(null); }}
            style={[styles.pill, { backgroundColor: specKey === k ? theme.primary : theme.surfaceAlt, borderColor: theme.border }]}>
            <Text style={{ color: specKey === k ? "#fff" : theme.text, fontSize: 12, fontWeight: "600" }}>{FIELD_SPECS[k]!.name}</Text>
          </Pressable>
        ))}
      </View>

      {frame && imageRect && (
        <>
          {/* Frame canvas with tap-to-label + overlay */}
          <Pressable onPress={onCanvasPress} style={{ marginTop: 10 }}>
            <View
              onLayout={(e: LayoutChangeEvent) => setCanvas({ width: e.nativeEvent.layout.width || 1, height: e.nativeEvent.layout.height || 1 })}
              style={{ width: "100%", aspectRatio: frame.imageWidth / frame.imageHeight, backgroundColor: "#111", borderRadius: 8, overflow: "hidden" }}
            >
              <Image source={{ uri: `data:image/jpeg;base64,${frame.imageBase64}` }} style={StyleSheet.absoluteFill} resizeMode="contain" />
              <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
                {/* Projected field overlay (after solve) */}
                {projectedField && (() => {
                  const f1 = seg(projectedField.foulFirst[0]!, projectedField.foulFirst[1]!);
                  const f3 = seg(projectedField.foulThird[0]!, projectedField.foulThird[1]!);
                  const baseRing = projectedField.bases.every(Boolean)
                    ? projectedField.bases.map((b) => { const p = toCanvas(b!.nx, b!.ny); return `${p.x},${p.y}`; }).join(" ")
                    : null;
                  const r = projectedField.rubber ? toCanvas(projectedField.rubber.nx, projectedField.rubber.ny) : null;
                  return (
                    <>
                      {f1 && <Line {...f1} stroke="#FFD60A" strokeWidth={2} strokeOpacity={0.9} />}
                      {f3 && <Line {...f3} stroke="#FFD60A" strokeWidth={2} strokeOpacity={0.9} />}
                      {baseRing && <Polygon points={baseRing} fill="none" stroke="#0A84FF" strokeWidth={2} strokeOpacity={0.9} />}
                      {r && <Circle cx={r.x} cy={r.y} r={5} fill="#0A84FF" />}
                    </>
                  );
                })()}
                {/* Ball path (after detect) */}
                {ballPath && ballPath.length >= 2 && (
                  <Polyline
                    points={ballPath.map((p) => { const c = toCanvas(p.nx, p.ny); return `${c.x},${c.y}`; }).join(" ")}
                    fill="none" stroke="#FF3B30" strokeWidth={2} strokeOpacity={0.9}
                  />
                )}
                {ballPath?.map((p, i) => { const c = toCanvas(p.nx, p.ny); return <Circle key={i} cx={c.x} cy={c.y} r={2.5} fill="#FF3B30" />; })}
                {/* Placed landmark markers */}
                {labels.map((l) => {
                  const c = toCanvas(l.nx, l.ny);
                  return (
                    <React.Fragment key={l.id}>
                      <Circle cx={c.x} cy={c.y} r={6} fill="#34C759" fillOpacity={0.85} stroke="#fff" strokeWidth={1} />
                      <SvgText x={c.x + 9} y={c.y + 4} fill="#34C759" fontSize={11} fontWeight="bold">{l.id}</SvgText>
                    </React.Fragment>
                  );
                })}
              </Svg>
            </View>
          </Pressable>

          {/* Scrub controls */}
          <View style={{ flexDirection: "row", gap: 6, marginTop: 8 }}>
            <Pressable onPress={() => frameStep(-1)} style={[styles.smBtn, { backgroundColor: theme.surfaceAlt }]}><Text style={{ color: theme.text }}>«1s</Text></Pressable>
            <Pressable onPress={() => frameStep(-frameStepSec)} style={[styles.smBtn, { backgroundColor: theme.surfaceAlt }]}><Text style={{ color: theme.text }}>‹ frame</Text></Pressable>
            <Pressable onPress={() => frameStep(frameStepSec)} style={[styles.smBtn, { backgroundColor: theme.surfaceAlt }]}><Text style={{ color: theme.text }}>frame ›</Text></Pressable>
            <Pressable onPress={() => frameStep(1)} style={[styles.smBtn, { backgroundColor: theme.surfaceAlt }]}><Text style={{ color: theme.text }}>1s»</Text></Pressable>
          </View>
          <Text style={{ color: theme.textMuted, fontSize: 12, marginTop: 4 }}>
            {frameTimeSec.toFixed(2)}s / {frame.durationSec.toFixed(2)}s{frame.frameRate > 0 ? ` · ${frame.frameRate.toFixed(0)} fps` : ""}
          </Text>

          {/* Landmark picker: which landmark the next tap places */}
          <Text style={[styles.label, { color: theme.text }]}>Tap the frame to place: <Text style={{ fontWeight: "700" }}>{LABEL_CHOICES.find((c) => c.id === pendingId)?.label}</Text></Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {LABEL_CHOICES.map((c) => (
              <Pressable key={c.id} onPress={() => setPendingId(c.id)}
                style={[styles.pill, {
                  backgroundColor: pendingId === c.id ? theme.primary : placedIds.has(c.id) ? theme.surface : theme.surfaceAlt,
                  borderColor: placedIds.has(c.id) ? "#34C759" : theme.border,
                }]}>
                <Text style={{ color: pendingId === c.id ? "#fff" : theme.text, fontSize: 12 }}>
                  {placedIds.has(c.id) ? "✓ " : ""}{c.label}
                </Text>
              </Pressable>
            ))}
          </View>

          <View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}>
            <Pressable onPress={solve} disabled={labels.length < 4 || !!busy}
              style={[styles.btn, { flex: 1, backgroundColor: theme.highlight, opacity: labels.length < 4 || busy ? 0.4 : 1 }]}>
              <Text style={styles.btnText}>Solve field ({labels.length})</Text>
            </Pressable>
            <Pressable onPress={() => { setLabels([]); setHomography(null); setBallPath(null); setPendingId("apex"); }}
              style={[styles.btn, { backgroundColor: theme.surfaceAlt }]}>
              <Text style={[styles.btnText, { color: theme.text }]}>Clear</Text>
            </Pressable>
          </View>

          {homography && (
            <>
              <Text style={{ color: theme.textMuted, fontSize: 12, marginTop: 6 }}>
                Field solved · reprojection {homography.rmsPx.toFixed(1)} px RMS
              </Text>
              <Pressable onPress={runBallPath} disabled={!!busy}
                style={[styles.btn, { backgroundColor: theme.primary, marginTop: 6, opacity: busy ? 0.4 : 1 }]}>
                <Text style={styles.btnText}>{busy === "detecting ball…" ? "Detecting…" : "Detect ball path (YOLO)"}</Text>
              </Pressable>
              {ballPath && <Text style={{ color: theme.textMuted, fontSize: 12, marginTop: 4 }}>Ball detected in {ballPath.length} frames.</Text>}
            </>
          )}
        </>
      )}

      {busy && <ActivityIndicator style={{ marginTop: 12 }} color={theme.primary} />}
      {err && <Text style={{ color: "#FF453A", marginTop: 10 }}>{err}</Text>}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  h1: { fontSize: 22, fontWeight: "700", marginBottom: 2 },
  sub: { fontSize: 13, marginBottom: 12 },
  label: { fontSize: 13, marginTop: 12, marginBottom: 6 },
  btn: { paddingVertical: 12, paddingHorizontal: 16, borderRadius: 10, alignItems: "center" },
  btnText: { color: "#fff", fontWeight: "600", fontSize: 15 },
  smBtn: { flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: "center" },
  pill: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth },
});
