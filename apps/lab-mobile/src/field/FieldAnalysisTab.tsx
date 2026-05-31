import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View, Text, Pressable, StyleSheet, ScrollView, Image, ActivityIndicator, TextInput,
  PanResponder, type LayoutChangeEvent,
} from "react-native";
import Svg, { Circle, Line, Polyline, Polygon, Text as SvgText } from "react-native-svg";
import * as ImagePicker from "expo-image-picker";
import { VisionTracker, type FirstFrameResult } from "expo-vision-tracker";
import { Yolo } from "expo-yolo";
import { useTheme } from "../theme";
import { apiFetch } from "../api/client";
import { FIELD_SPECS, buildFieldLandmarks, type GroundPoint } from "./fieldTemplate";
import {
  fitHomography, fieldToImage, type Correspondence, type LineCorrespondence, type Homography,
} from "./videoHomography";

// Field Analysis: reconcile a non-AR clip to the field (VIDEO_ANALYSIS.md).
//
// Foul-line-centric model (per the field-use reframe):
//   • LINES: the 1B and 3B foul lines, each labeled by TWO taps anywhere on the
//     visible chalk (not endpoints). The apex is their intersection — never
//     tapped. Foul poles / outfield fences are not used.
//   • POINTS: 1B, 2B, 3B, rubber — tapped to pin scale/position along the lines.
//   The homography is fit from points + lines (videoHomography.fitHomography).
//
// Also: a Dataset mode to capture the labeled frame (image + point/line labels)
// to the backend (/datasets/sample) for ML training.

type SpecKey = keyof typeof FIELD_SPECS;
type Mode = "navigate" | "place";
type PointId = "first_base" | "second_base" | "third_base" | "rubber";
type LineId = "foul_1b" | "foul_3b";
type Active = { kind: "point"; id: PointId } | { kind: "line"; id: LineId };

const POINT_CHOICES: { id: PointId; label: string }[] = [
  { id: "first_base", label: "1B" },
  { id: "second_base", label: "2B" },
  { id: "third_base", label: "3B" },
  { id: "rubber", label: "Rubber" },
];
const LINE_CHOICES: { id: LineId; label: string }[] = [
  { id: "foul_1b", label: "1B foul line" },
  { id: "foul_3b", label: "3B foul line" },
];

interface Pt { nx: number; ny: number }
interface PlacedPoint { id: PointId; nx: number; ny: number }
interface PlacedLine { id: LineId; p1: Pt | null; p2: Pt | null }
interface BallPoint { nx: number; ny: number; conf: number; t: number }
interface Rect { x: number; y: number; w: number; h: number }
interface Viewport { scale: number; tx: number; ty: number }

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export function FieldAnalysisTab() {
  const theme = useTheme();
  const [videoUri, setVideoUri] = useState<string | null>(null);
  const [frame, setFrame] = useState<FirstFrameResult | null>(null);
  const [frameTimeSec, setFrameTimeSec] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [specKey, setSpecKey] = useState<SpecKey>("highSchool");
  const [points, setPoints] = useState<PlacedPoint[]>([]);
  const [lines, setLines] = useState<PlacedLine[]>([]);
  const [active, setActive] = useState<Active>({ kind: "line", id: "foul_1b" });
  const [homography, setHomography] = useState<{ H: Homography; rmsPx: number } | null>(null);
  const [ballPath, setBallPath] = useState<BallPoint[] | null>(null);
  const [mode, setMode] = useState<Mode>("place");
  const [vp, setVp] = useState<Viewport>({ scale: 1, tx: 0, ty: 0 });
  const [canvas, setCanvas] = useState({ width: 1, height: 1 });

  // Dataset capture
  const [datasetMode, setDatasetMode] = useState(false);
  const [datasetName, setDatasetName] = useState("field-v1");
  const [addedCount, setAddedCount] = useState(0);

  const canvasViewRef = useRef<View>(null);
  const canvasOffsetRef = useRef({ x: 0, y: 0 });
  const measureCanvas = useCallback(() => {
    canvasViewRef.current?.measureInWindow((x, y) => { canvasOffsetRef.current = { x, y }; });
  }, []);

  const landmarks = useMemo(() => buildFieldLandmarks(FIELD_SPECS[specKey]!), [specKey]);

  // refs the PanResponder reads
  const vpRef = useRef(vp); useEffect(() => { vpRef.current = vp; }, [vp]);
  const modeRef = useRef(mode); useEffect(() => { modeRef.current = mode; }, [mode]);
  const activeRef = useRef(active); useEffect(() => { activeRef.current = active; }, [active]);
  const pointsRef = useRef(points); useEffect(() => { pointsRef.current = points; }, [points]);
  const linesRef = useRef(lines); useEffect(() => { linesRef.current = lines; }, [lines]);
  const canvasRef = useRef(canvas); useEffect(() => { canvasRef.current = canvas; }, [canvas]);
  const frameRef = useRef(frame); useEffect(() => { frameRef.current = frame; }, [frame]);
  const specRef = useRef(specKey); useEffect(() => { specRef.current = specKey; }, [specKey]);
  const autoSolveRef = useRef(false);

  const setViewport = useCallback((v: Viewport) => { vpRef.current = v; setVp(v); }, []);

  // Zoom about the canvas center by a multiplicative factor, keeping the center
  // point fixed (so +/- feel anchored). Used by the +/- buttons.
  const zoomBy = useCallback((factor: number) => {
    const v = vpRef.current;
    const ns = clamp(v.scale * factor, 1, 8);
    if (ns === v.scale) return;
    // Center-anchored: scale the existing translation so the view's center stays put.
    const k = ns / v.scale;
    setViewport({ scale: ns, tx: v.tx * k, ty: v.ty * k });
  }, [setViewport]);

  const imageRect = useMemo<Rect | null>(() => {
    if (!frame) return null;
    const ar = frame.imageWidth / frame.imageHeight;
    const car = canvas.width / canvas.height;
    let w = canvas.width, h = canvas.height, x = 0, y = 0;
    if (ar > car) { h = canvas.width / ar; y = (canvas.height - h) / 2; }
    else { w = canvas.height * ar; x = (canvas.width - w) / 2; }
    return { x, y, w, h };
  }, [frame, canvas]);
  const imageRectRef = useRef(imageRect); useEffect(() => { imageRectRef.current = imageRect; }, [imageRect]);

  const screenToImageNorm = useCallback((lx: number, ly: number) => {
    const c = canvasRef.current; const v = vpRef.current; const rect = imageRectRef.current;
    if (!rect) return null;
    const cx = c.width / 2, cy = c.height / 2;
    const preX = (lx - cx - v.tx) / v.scale + cx;
    const preY = (ly - cy - v.ty) / v.scale + cy;
    return { nx: (preX - rect.x) / rect.w, ny: (preY - rect.y) / rect.h };
  }, []);

  // ── solve from current points + lines ──────────────────────────────────────
  const solveFrom = useCallback((pts: PlacedPoint[], lns: PlacedLine[], quiet = false): boolean => {
    const f = frameRef.current;
    if (!f) return false;
    const lm = buildFieldLandmarks(FIELD_SPECS[specRef.current]!);
    const W = f.imageWidth, H = f.imageHeight;
    const corr: Correspondence[] = pts.map((p) => ({
      field: lm[p.id] as GroundPoint,
      image: { u: p.nx * W, v: p.ny * H },
    }));
    const completeLines = lns.filter((l): l is { id: LineId; p1: Pt; p2: Pt } => !!l.p1 && !!l.p2);
    const lineCorr: LineCorrespondence[] = completeLines.map((l) => ({
      field: l.id === "foul_1b"
        ? [lm.apex as GroundPoint, lm.first_base as GroundPoint]
        : [lm.apex as GroundPoint, lm.third_base as GroundPoint],
      image: [{ u: l.p1.nx * W, v: l.p1.ny * H }, { u: l.p2.nx * W, v: l.p2.ny * H }],
    }));
    const constraintPairs = corr.length + completeLines.length * 2;
    if (constraintPairs < 4) {
      if (!quiet) setErr("Add more: e.g. both foul lines + a base, or 4 points.");
      return false;
    }
    const fit = fitHomography(corr, lineCorr);
    if (!fit) { if (!quiet) setErr("Couldn't solve — spread the labels out (avoid a single line)."); return false; }
    setErr(null);
    setHomography({ H: fit.H, rmsPx: fit.rmsPx });
    return true;
  }, []);

  const reflow = useCallback((pts: PlacedPoint[], lns: PlacedLine[]) => {
    pointsRef.current = pts; linesRef.current = lns;
    setPoints(pts); setLines(lns); setBallPath(null);
    if (autoSolveRef.current) solveFrom(pts, lns, true);
    else setHomography(null);
  }, [solveFrom]);

  // Place a tap for the active point or line.
  const placeAt = useCallback((nx: number, ny: number) => {
    const a = activeRef.current;
    if (a.kind === "point") {
      const next = [...pointsRef.current.filter((p) => p.id !== a.id), { id: a.id, nx: clamp01(nx), ny: clamp01(ny) }];
      reflow(next, linesRef.current);
    } else {
      const cur = linesRef.current.find((l) => l.id === a.id) ?? { id: a.id, p1: null, p2: null };
      let upd: PlacedLine;
      if (!cur.p1) upd = { ...cur, p1: { nx: clamp01(nx), ny: clamp01(ny) } };
      else if (!cur.p2) upd = { ...cur, p2: { nx: clamp01(nx), ny: clamp01(ny) } };
      else {
        // both set → replace the nearer endpoint
        const d1 = Math.hypot(cur.p1.nx - nx, cur.p1.ny - ny);
        const d2 = Math.hypot(cur.p2.nx - nx, cur.p2.ny - ny);
        upd = d1 <= d2 ? { ...cur, p1: { nx: clamp01(nx), ny: clamp01(ny) } } : { ...cur, p2: { nx: clamp01(nx), ny: clamp01(ny) } };
      }
      reflow(pointsRef.current, [...linesRef.current.filter((l) => l.id !== a.id), upd]);
    }
  }, [reflow]);

  // Drag fine-tune the active point, or the nearer endpoint of the active line.
  const nudge = useCallback((dnx: number, dny: number, atNx: number, atNy: number) => {
    const a = activeRef.current;
    if (a.kind === "point") {
      const cur = pointsRef.current;
      if (!cur.some((p) => p.id === a.id)) return;
      reflow(cur.map((p) => (p.id === a.id ? { ...p, nx: clamp01(p.nx + dnx), ny: clamp01(p.ny + dny) } : p)), linesRef.current);
    } else {
      const cur = linesRef.current.find((l) => l.id === a.id);
      if (!cur || (!cur.p1 && !cur.p2)) return;
      const d1 = cur.p1 ? Math.hypot(cur.p1.nx - atNx, cur.p1.ny - atNy) : Infinity;
      const d2 = cur.p2 ? Math.hypot(cur.p2.nx - atNx, cur.p2.ny - atNy) : Infinity;
      const moveP1 = d1 <= d2;
      const upd: PlacedLine = moveP1 && cur.p1
        ? { ...cur, p1: { nx: clamp01(cur.p1.nx + dnx), ny: clamp01(cur.p1.ny + dny) } }
        : cur.p2 ? { ...cur, p2: { nx: clamp01(cur.p2.nx + dnx), ny: clamp01(cur.p2.ny + dny) } } : cur;
      reflow(pointsRef.current, [...linesRef.current.filter((l) => l.id !== a.id), upd]);
    }
  }, [reflow]);

  // ── gestures (pan via drag; zoom via +/- buttons) ──
  const gestureRef = useRef({ startTx: 0, startTy: 0, lastDx: 0, lastDy: 0, startLX: 0, startLY: 0, startNx: 0, startNy: 0, moved: false });
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (evt) => {
        measureCanvas();
        const off = canvasOffsetRef.current;
        const lx = evt.nativeEvent.pageX - off.x, ly = evt.nativeEvent.pageY - off.y;
        const norm = screenToImageNorm(lx, ly);
        gestureRef.current = {
          startTx: vpRef.current.tx, startTy: vpRef.current.ty,
          lastDx: 0, lastDy: 0, startLX: lx, startLY: ly,
          startNx: norm?.nx ?? 0, startNy: norm?.ny ?? 0, moved: false,
        };
      },
      onPanResponderMove: (evt, gesture) => {
        const g = gestureRef.current;
        if (Math.hypot(gesture.dx, gesture.dy) > 6) g.moved = true;
        if (modeRef.current === "navigate") {
          // Pan only — drag moves the view; zoom is the +/- buttons.
          setViewport({ scale: vpRef.current.scale, tx: g.startTx + gesture.dx, ty: g.startTy + gesture.dy });
        } else {
          const rect = imageRectRef.current; if (!rect) return;
          const incDx = gesture.dx - g.lastDx, incDy = gesture.dy - g.lastDy;
          g.lastDx = gesture.dx; g.lastDy = gesture.dy;
          nudge((incDx / vpRef.current.scale) / rect.w, (incDy / vpRef.current.scale) / rect.h, g.startNx, g.startNy);
        }
      },
      onPanResponderRelease: () => {
        const g = gestureRef.current;
        if (modeRef.current === "place" && !g.moved) {
          const p = screenToImageNorm(g.startLX, g.startLY);
          if (p && p.nx >= 0 && p.nx <= 1 && p.ny >= 0 && p.ny <= 1) placeAt(p.nx, p.ny);
        }
      },
    })
  ).current;

  // ── video / frame ──
  const loadFrame = useCallback(async (uri: string, timeSec: number) => {
    setBusy("loading frame…");
    try {
      const f = timeSec === 0 ? await VisionTracker.firstFrame(uri, 0.9) : await VisionTracker.frameAtTime(uri, timeSec, 0.9);
      setFrame(f); setFrameTimeSec(timeSec);
    } catch (e) { setErr(`frame load failed: ${(e as Error).message}`); }
    finally { setBusy(null); }
  }, []);

  const pickVideo = useCallback(async () => {
    setErr(null);
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { setErr("Photo library permission denied."); return; }
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions?.Videos ?? ("videos" as any), quality: 1 });
    if (res.canceled || !res.assets?.[0]) return;
    const uri = res.assets[0].uri;
    setVideoUri(uri);
    setFrame(null); setFrameTimeSec(0);
    setPoints([]); pointsRef.current = []; setLines([]); linesRef.current = [];
    setHomography(null); setBallPath(null); autoSolveRef.current = false;
    setViewport({ scale: 1, tx: 0, ty: 0 });
    await loadFrame(uri, 0);
  }, [setViewport, loadFrame]);

  const frameStep = useCallback((deltaSec: number) => {
    if (!videoUri || !frame) return;
    const max = Math.max(0, frame.durationSec - (frame.frameRate > 0 ? 1 / frame.frameRate : 0.001));
    loadFrame(videoUri, Math.max(0, Math.min(max, frameTimeSec + deltaSec)));
  }, [videoUri, frame, frameTimeSec, loadFrame]);

  const frameStepSec = frame && frame.frameRate > 0 ? 1 / frame.frameRate : 1 / 30;

  const solve = useCallback(() => {
    if (solveFrom(pointsRef.current, linesRef.current)) autoSolveRef.current = true;
  }, [solveFrom]);

  const clearActive = useCallback(() => {
    const a = activeRef.current;
    if (a.kind === "point") reflow(pointsRef.current.filter((p) => p.id !== a.id), linesRef.current);
    else reflow(pointsRef.current, linesRef.current.filter((l) => l.id !== a.id));
  }, [reflow]);

  const clearAll = useCallback(() => {
    autoSolveRef.current = false;
    setPoints([]); pointsRef.current = []; setLines([]); linesRef.current = [];
    setHomography(null); setBallPath(null); setActive({ kind: "line", id: "foul_1b" });
  }, []);

  const runBallPath = useCallback(async () => {
    if (!videoUri || !frame) return;
    setBusy("detecting ball…"); setErr(null);
    try {
      const fps = frame.frameRate > 0 ? frame.frameRate : 30;
      const pts: BallPoint[] = [];
      let misses = 0;
      for (let t = frameTimeSec; t < frame.durationSec && misses < 20; t += 1 / fps) {
        let f: FirstFrameResult;
        try { f = await VisionTracker.frameAtTime(videoUri, t, 0.85); } catch { break; }
        const res = await Yolo.detect(`data:image/jpeg;base64,${f.imageBase64}`, { minConfidence: 0.1 }).catch(() => null);
        const ball = res?.detections.filter((d) => d.label === "sports ball").sort((a, b) => b.confidence - a.confidence)[0];
        if (ball) { misses = 0; pts.push({ nx: ball.box.x + ball.box.width / 2, ny: ball.box.y + ball.box.height / 2, conf: ball.confidence, t }); }
        else misses++;
        if (pts.length > 300) break;
      }
      setBallPath(pts);
      if (pts.length === 0) setErr("No ball detected in this clip segment.");
    } catch (e) { setErr(`ball detection failed: ${(e as Error).message}`); }
    finally { setBusy(null); }
  }, [videoUri, frame, frameTimeSec]);

  const addToDataset = useCallback(async () => {
    const f = frameRef.current;
    if (!f) return;
    if (points.length === 0 && lines.length === 0) { setErr("Label something before adding to the dataset."); return; }
    setBusy("uploading sample…"); setErr(null);
    try {
      await apiFetch("/datasets/sample", {
        method: "POST",
        body: JSON.stringify({
          dataset: datasetName.trim() || "field-v1",
          imageBase64: f.imageBase64,
          imageWidth: f.imageWidth,
          imageHeight: f.imageHeight,
          fieldSpec: specKey,
          keypoints: points.map((p) => ({ id: p.id, nx: p.nx, ny: p.ny, visible: true })),
          lines: lines.filter((l) => l.p1 && l.p2).map((l) => ({ id: l.id, p1: l.p1, p2: l.p2 })),
          sourceVideo: videoUri ?? undefined,
          timeSec: frameTimeSec,
        }),
      });
      setAddedCount((n) => n + 1);
    } catch (e) {
      setErr(`upload failed: ${(e as Error).message}`);
    } finally { setBusy(null); }
  }, [points, lines, datasetName, specKey, videoUri, frameTimeSec]);

  // ── overlay projection ──
  const projectedField = useMemo(() => {
    if (!homography || !frame) return null;
    const toImg = (p: GroundPoint) => {
      const px = fieldToImage(homography.H, p);
      return px ? { nx: px.x / frame.imageWidth, ny: px.y / frame.imageHeight } : null;
    };
    const L = landmarks;
    const ext = FIELD_SPECS[specKey]!.foulLineLength; // draw the foul lines out to the fence dist
    return {
      foul1: [toImg(L.apex), toImg({ x: ext, z: 0 })] as const,
      foul3: [toImg(L.apex), toImg({ x: 0, z: ext })] as const,
      bases: [toImg(L.apex), toImg(L.first_base), toImg(L.second_base), toImg(L.third_base), toImg(L.apex)],
      rubber: toImg(L.rubber),
    };
  }, [homography, frame, landmarks, specKey]);

  if (!VisionTracker.available()) {
    return <View style={[styles.center, { backgroundColor: theme.background }]}><Text style={{ color: theme.text }}>Video frame extraction not available in this build.</Text></View>;
  }

  const toCanvas = (nx: number, ny: number) => imageRect ? { x: imageRect.x + nx * imageRect.w, y: imageRect.y + ny * imageRect.h } : { x: 0, y: 0 };
  const placedLine = (id: LineId) => lines.find((l) => l.id === id);
  const lineComplete = (l: PlacedLine | undefined) => !!l?.p1 && !!l?.p2;
  const constraintPairs = points.length + lines.filter((l) => lineComplete(l)).length * 2;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.background }} contentContainerStyle={{ padding: 12 }} scrollEnabled={mode !== "navigate"}>
      <Text style={[styles.h1, { color: theme.text }]}>Field Analysis</Text>
      <Text style={[styles.sub, { color: theme.textMuted }]}>Label the two foul lines (two taps each) + a base or two, solve, then overlay the field / ball path. Apex = where the foul lines cross.</Text>

      <Pressable onPress={pickVideo} style={[styles.btn, { backgroundColor: theme.primary }]}>
        <Text style={styles.btnText}>{videoUri ? "Pick a different video" : "Pick video"}</Text>
      </Pressable>

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
        {(Object.keys(FIELD_SPECS) as SpecKey[]).map((k) => (
          <Pressable key={k} onPress={() => { setSpecKey(k); if (autoSolveRef.current) solveFrom(pointsRef.current, linesRef.current, true); }}
            style={[styles.pill, { backgroundColor: specKey === k ? theme.primary : theme.surfaceAlt, borderColor: theme.border }]}>
            <Text style={{ color: specKey === k ? "#fff" : theme.text, fontSize: 12, fontWeight: "600" }}>{FIELD_SPECS[k]!.name}</Text>
          </Pressable>
        ))}
      </View>

      {frame && imageRect && (
        <>
          <View style={{ flexDirection: "row", gap: 6, marginTop: 10 }}>
            {(["place", "navigate"] as Mode[]).map((m) => (
              <Pressable key={m} onPress={() => setMode(m)} style={[styles.btn, { flex: 1, backgroundColor: mode === m ? theme.primary : theme.surfaceAlt }]}>
                <Text style={[styles.btnText, { color: mode === m ? "#fff" : theme.text }]}>{m === "place" ? "Place / Edit" : "Pan"}</Text>
              </Pressable>
            ))}
          </View>
          {/* Zoom controls: +/- buttons (pinch removed); drag pans in Pan mode. */}
          <View style={{ flexDirection: "row", gap: 6, marginTop: 6, alignItems: "center" }}>
            <Pressable onPress={() => zoomBy(1 / 1.5)} style={[styles.btn, { flex: 1, backgroundColor: theme.surfaceAlt }]}>
              <Text style={[styles.btnText, { color: theme.text, fontSize: 18 }]}>−</Text>
            </Pressable>
            <Text style={{ color: theme.textMuted, fontSize: 13, width: 56, textAlign: "center", fontVariant: ["tabular-nums"] }}>{vp.scale.toFixed(1)}×</Text>
            <Pressable onPress={() => zoomBy(1.5)} style={[styles.btn, { flex: 1, backgroundColor: theme.surfaceAlt }]}>
              <Text style={[styles.btnText, { color: theme.text, fontSize: 18 }]}>+</Text>
            </Pressable>
            <Pressable onPress={() => setViewport({ scale: 1, tx: 0, ty: 0 })} style={[styles.btn, { flex: 1, backgroundColor: theme.surfaceAlt }]}>
              <Text style={[styles.btnText, { color: theme.text }]}>Reset</Text>
            </Pressable>
          </View>

          <View
            ref={canvasViewRef}
            {...panResponder.panHandlers}
            onLayout={(e: LayoutChangeEvent) => { setCanvas({ width: e.nativeEvent.layout.width || 1, height: e.nativeEvent.layout.height || 1 }); measureCanvas(); }}
            style={{ width: "100%", aspectRatio: frame.imageWidth / frame.imageHeight, backgroundColor: "#111", borderRadius: 8, overflow: "hidden", marginTop: 8 }}
          >
            <View style={[StyleSheet.absoluteFill, { transform: [{ translateX: vp.tx }, { translateY: vp.ty }, { scale: vp.scale }] }]}>
              <Image source={{ uri: `data:image/jpeg;base64,${frame.imageBase64}` }} style={StyleSheet.absoluteFill} resizeMode="contain" />
              <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
                {/* Solved field overlay */}
                {projectedField && (() => {
                  const ln = (a: Pt | null, b: Pt | null) => { if (!a || !b) return null; const pa = toCanvas(a.nx, a.ny), pb = toCanvas(b.nx, b.ny); return { x1: pa.x, y1: pa.y, x2: pb.x, y2: pb.y }; };
                  const f1 = ln(projectedField.foul1[0], projectedField.foul1[1]);
                  const f3 = ln(projectedField.foul3[0], projectedField.foul3[1]);
                  const ring = projectedField.bases.every(Boolean) ? projectedField.bases.map((b) => { const p = toCanvas(b!.nx, b!.ny); return `${p.x},${p.y}`; }).join(" ") : null;
                  const r = projectedField.rubber ? toCanvas(projectedField.rubber.nx, projectedField.rubber.ny) : null;
                  const sw = 2 / vp.scale;
                  return (<>
                    {f1 && <Line {...f1} stroke="#FFD60A" strokeWidth={sw} strokeOpacity={0.85} />}
                    {f3 && <Line {...f3} stroke="#FFD60A" strokeWidth={sw} strokeOpacity={0.85} />}
                    {ring && <Polygon points={ring} fill="none" stroke="#0A84FF" strokeWidth={sw} strokeOpacity={0.85} />}
                    {r && <Circle cx={r.x} cy={r.y} r={5 / vp.scale} fill="#0A84FF" />}
                  </>);
                })()}
                {ballPath && ballPath.length >= 2 && (
                  <Polyline points={ballPath.map((p) => { const c = toCanvas(p.nx, p.ny); return `${c.x},${c.y}`; }).join(" ")} fill="none" stroke="#FF3B30" strokeWidth={2 / vp.scale} strokeOpacity={0.9} />
                )}
                {ballPath?.map((p, i) => { const c = toCanvas(p.nx, p.ny); return <Circle key={i} cx={c.x} cy={c.y} r={2.5 / vp.scale} fill="#FF3B30" />; })}

                {/* Labeled LINES (two taps → segment) */}
                {lines.map((l) => {
                  const isActive = active.kind === "line" && active.id === l.id;
                  const col = isActive ? "#FF9F0A" : "#30D158";
                  const sw = 2.5 / vp.scale;
                  const c1 = l.p1 ? toCanvas(l.p1.nx, l.p1.ny) : null;
                  const c2 = l.p2 ? toCanvas(l.p2.nx, l.p2.ny) : null;
                  return (
                    <React.Fragment key={l.id}>
                      {c1 && c2 && <Line x1={c1.x} y1={c1.y} x2={c2.x} y2={c2.y} stroke={col} strokeWidth={sw} />}
                      {c1 && <Circle cx={c1.x} cy={c1.y} r={5 / vp.scale} fill={col} stroke="#fff" strokeWidth={1 / vp.scale} />}
                      {c2 && <Circle cx={c2.x} cy={c2.y} r={5 / vp.scale} fill={col} stroke="#fff" strokeWidth={1 / vp.scale} />}
                    </React.Fragment>
                  );
                })}
                {/* Labeled POINTS */}
                {points.map((p) => {
                  const isActive = active.kind === "point" && active.id === p.id;
                  const c = toCanvas(p.nx, p.ny);
                  const col = isActive ? "#FF9F0A" : "#34C759";
                  return (
                    <React.Fragment key={p.id}>
                      <Circle cx={c.x} cy={c.y} r={(isActive ? 7 : 6) / vp.scale} fill={col} fillOpacity={0.9} stroke="#fff" strokeWidth={1 / vp.scale} />
                      <SvgText x={c.x + 9 / vp.scale} y={c.y + 4 / vp.scale} fill={col} fontSize={11 / vp.scale} fontWeight="bold">{p.id}</SvgText>
                    </React.Fragment>
                  );
                })}
              </Svg>
            </View>
          </View>

          <View style={{ flexDirection: "row", gap: 6, marginTop: 8 }}>
            <Pressable onPress={() => frameStep(-1)} style={[styles.smBtn, { backgroundColor: theme.surfaceAlt }]}><Text style={{ color: theme.text }}>«1s</Text></Pressable>
            <Pressable onPress={() => frameStep(-frameStepSec)} style={[styles.smBtn, { backgroundColor: theme.surfaceAlt }]}><Text style={{ color: theme.text }}>‹ frame</Text></Pressable>
            <Pressable onPress={() => frameStep(frameStepSec)} style={[styles.smBtn, { backgroundColor: theme.surfaceAlt }]}><Text style={{ color: theme.text }}>frame ›</Text></Pressable>
            <Pressable onPress={() => frameStep(1)} style={[styles.smBtn, { backgroundColor: theme.surfaceAlt }]}><Text style={{ color: theme.text }}>1s»</Text></Pressable>
          </View>
          <Text style={{ color: theme.textMuted, fontSize: 12, marginTop: 4 }}>
            {frameTimeSec.toFixed(2)}s / {frame.durationSec.toFixed(2)}s{frame.frameRate > 0 ? ` · ${frame.frameRate.toFixed(0)} fps` : ""}
            {mode === "place" ? (active.kind === "line" ? "  ·  tap two points on the chalk" : "  ·  tap to place, drag to fine-tune") : "  ·  drag to pan · +/- to zoom"}
          </Text>

          {/* LINE picker */}
          <Text style={[styles.label, { color: theme.text }]}>Foul lines</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {LINE_CHOICES.map((c) => {
              const l = placedLine(c.id);
              const complete = lineComplete(l);
              const half = !!l && !complete;
              const isActive = active.kind === "line" && active.id === c.id;
              return (
                <View key={c.id} style={[styles.pill, { flexDirection: "row", alignItems: "center", gap: 6,
                  backgroundColor: isActive ? theme.primary : complete ? theme.surface : theme.surfaceAlt,
                  borderColor: complete ? "#30D158" : theme.border }]}>
                  <Pressable onPress={() => setActive({ kind: "line", id: c.id })}>
                    <Text style={{ color: isActive ? "#fff" : theme.text, fontSize: 12 }}>{complete ? "✓ " : half ? "½ " : ""}{c.label}</Text>
                  </Pressable>
                  {!!l && <Pressable onPress={() => reflow(pointsRef.current, linesRef.current.filter((x) => x.id !== c.id))} hitSlop={8}>
                    <Text style={{ color: isActive ? "#fff" : theme.textMuted, fontSize: 13, fontWeight: "700" }}>✕</Text>
                  </Pressable>}
                </View>
              );
            })}
          </View>

          {/* POINT picker */}
          <Text style={[styles.label, { color: theme.text }]}>Bases / rubber</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {POINT_CHOICES.map((c) => {
              const isPlaced = points.some((p) => p.id === c.id);
              const isActive = active.kind === "point" && active.id === c.id;
              return (
                <View key={c.id} style={[styles.pill, { flexDirection: "row", alignItems: "center", gap: 6,
                  backgroundColor: isActive ? theme.primary : isPlaced ? theme.surface : theme.surfaceAlt,
                  borderColor: isPlaced ? "#34C759" : theme.border }]}>
                  <Pressable onPress={() => setActive({ kind: "point", id: c.id })}>
                    <Text style={{ color: isActive ? "#fff" : theme.text, fontSize: 12 }}>{isPlaced ? "✓ " : ""}{c.label}</Text>
                  </Pressable>
                  {isPlaced && <Pressable onPress={() => reflow(pointsRef.current.filter((p) => p.id !== c.id), linesRef.current)} hitSlop={8}>
                    <Text style={{ color: isActive ? "#fff" : theme.textMuted, fontSize: 13, fontWeight: "700" }}>✕</Text>
                  </Pressable>}
                </View>
              );
            })}
          </View>

          <View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}>
            <Pressable onPress={solve} disabled={constraintPairs < 4 || !!busy}
              style={[styles.btn, { flex: 1, backgroundColor: theme.highlight, opacity: constraintPairs < 4 || busy ? 0.4 : 1 }]}>
              <Text style={styles.btnText}>Solve field</Text>
            </Pressable>
            <Pressable onPress={clearActive} style={[styles.btn, { backgroundColor: theme.surfaceAlt }]}>
              <Text style={[styles.btnText, { color: theme.text }]}>Clear active</Text>
            </Pressable>
            <Pressable onPress={clearAll} style={[styles.btn, { backgroundColor: theme.surfaceAlt }]}>
              <Text style={[styles.btnText, { color: theme.text }]}>Clear all</Text>
            </Pressable>
          </View>

          {homography && (
            <>
              <Text style={{ color: theme.textMuted, fontSize: 12, marginTop: 6 }}>Field solved · reprojection {homography.rmsPx.toFixed(1)} px RMS{autoSolveRef.current ? " · live" : ""}</Text>
              <Pressable onPress={runBallPath} disabled={!!busy} style={[styles.btn, { backgroundColor: theme.primary, marginTop: 6, opacity: busy ? 0.4 : 1 }]}>
                <Text style={styles.btnText}>{busy === "detecting ball…" ? "Detecting…" : "Detect ball path (YOLO)"}</Text>
              </Pressable>
              {ballPath && <Text style={{ color: theme.textMuted, fontSize: 12, marginTop: 4 }}>Ball detected in {ballPath.length} frames.</Text>}
            </>
          )}

          {/* Dataset capture */}
          <Pressable onPress={() => setDatasetMode((v) => !v)} style={[styles.btn, { backgroundColor: theme.surfaceAlt, marginTop: 12 }]}>
            <Text style={[styles.btnText, { color: theme.text }]}>{datasetMode ? "▾ Dataset capture" : "▸ Dataset capture"}</Text>
          </Pressable>
          {datasetMode && (
            <View style={{ marginTop: 8, gap: 8 }}>
              <Text style={{ color: theme.textMuted, fontSize: 12 }}>Save this labeled frame (image + labels) to a training dataset on the server.</Text>
              <TextInput
                value={datasetName} onChangeText={setDatasetName} placeholder="dataset name" placeholderTextColor={theme.textMuted}
                autoCapitalize="none" autoCorrect={false}
                style={{ color: theme.text, backgroundColor: theme.surfaceAlt, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.border }}
              />
              <Pressable onPress={addToDataset} disabled={!!busy} style={[styles.btn, { backgroundColor: theme.primary, opacity: busy ? 0.4 : 1 }]}>
                <Text style={styles.btnText}>{busy === "uploading sample…" ? "Uploading…" : `Add to dataset (${points.length + lines.filter((l) => lineComplete(l)).length} labels)`}</Text>
              </Pressable>
              {addedCount > 0 && <Text style={{ color: theme.textMuted, fontSize: 12 }}>Added {addedCount} sample{addedCount === 1 ? "" : "s"} this session.</Text>}
            </View>
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
  label: { fontSize: 13, marginTop: 12, marginBottom: 6, fontWeight: "600" },
  btn: { paddingVertical: 12, paddingHorizontal: 14, borderRadius: 10, alignItems: "center" },
  btnText: { color: "#fff", fontWeight: "600", fontSize: 14 },
  smBtn: { flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: "center" },
  pill: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth },
});
