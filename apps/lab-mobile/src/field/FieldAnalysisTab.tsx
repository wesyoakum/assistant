import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View, Text, Pressable, StyleSheet, ScrollView, Image, ActivityIndicator,
  PanResponder, type LayoutChangeEvent,
} from "react-native";
import Svg, { Circle, Line, Polyline, Polygon, Text as SvgText } from "react-native-svg";
import * as ImagePicker from "expo-image-picker";
import { VisionTracker, type FirstFrameResult } from "expo-vision-tracker";
import { Yolo } from "expo-yolo";
import { useTheme } from "../theme";
import {
  FIELD_SPECS, buildFieldLandmarks, type LandmarkId, type GroundPoint,
} from "./fieldTemplate";
import {
  fitHomography, fieldToImage, type Correspondence, type Homography,
} from "./videoHomography";

// Field Analysis: reconcile a non-AR clip to the field (VIDEO_ANALYSIS.md).
// Flow: import clip → scrub → tap field landmarks and label each → fit the ground
// homography → overlay the projected field + run YOLO for a 2D ball path.
//
// Interaction:
//   • Mode toggle: NAVIGATE (pinch-zoom / one-finger pan) vs PLACE (tap to set
//     the active landmark; one-finger drag anywhere to fine-tune it).
//   • Landmark pills select the active landmark; placed pills show ✓ and a ✕ to
//     clear just that one.
//   • After a solve, editing a landmark (tap or drag) re-solves live so the
//     overlay updates as you fine-tune.

type SpecKey = keyof typeof FIELD_SPECS;
type Mode = "navigate" | "place";

const LABEL_CHOICES: { id: LandmarkId; label: string }[] = [
  { id: "apex", label: "Home" },
  { id: "first_base", label: "1B" },
  { id: "second_base", label: "2B" },
  { id: "third_base", label: "3B" },
  { id: "rubber", label: "Rubber" },
  { id: "foul_pole_first", label: "RF pole" },
  { id: "foul_pole_third", label: "LF pole" },
  { id: "plate_front", label: "Plate front" },
];

interface PlacedLabel { id: LandmarkId; nx: number; ny: number }
interface BallPoint { nx: number; ny: number; conf: number; t: number }
interface Rect { x: number; y: number; w: number; h: number }
interface Viewport { scale: number; tx: number; ty: number }

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const touchDist = (t: any[]) => Math.hypot(t[0].pageX - t[1].pageX, t[0].pageY - t[1].pageY);

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
  const [mode, setMode] = useState<Mode>("place");
  const [vp, setVp] = useState<Viewport>({ scale: 1, tx: 0, ty: 0 });
  const [canvas, setCanvas] = useState({ width: 1, height: 1 });
  // The canvas view + its measured window offset, for page→canvas-local taps.
  const canvasViewRef = useRef<View>(null);
  const canvasOffsetRef = useRef({ x: 0, y: 0 });
  const measureCanvas = useCallback(() => {
    canvasViewRef.current?.measureInWindow((x, y) => { canvasOffsetRef.current = { x, y }; });
  }, []);

  const landmarks = useMemo(() => buildFieldLandmarks(FIELD_SPECS[specKey]!), [specKey]);

  // ── refs the PanResponder reads (closures would otherwise be stale) ─────────
  const vpRef = useRef(vp); useEffect(() => { vpRef.current = vp; }, [vp]);
  const modeRef = useRef(mode); useEffect(() => { modeRef.current = mode; }, [mode]);
  const pendingIdRef = useRef(pendingId); useEffect(() => { pendingIdRef.current = pendingId; }, [pendingId]);
  const labelsRef = useRef(labels); useEffect(() => { labelsRef.current = labels; }, [labels]);
  const canvasRef = useRef(canvas); useEffect(() => { canvasRef.current = canvas; }, [canvas]);
  const frameRef = useRef(frame); useEffect(() => { frameRef.current = frame; }, [frame]);
  // Auto re-solve after the first manual solve, so fine-tuning updates live.
  const autoSolveRef = useRef(false);

  const setViewport = useCallback((v: Viewport) => { vpRef.current = v; setVp(v); }, []);

  // Contain-fit image rect inside the canvas (pre-transform, scale 1).
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

  // Screen (canvas-local) point → normalized image coords, undoing the viewport.
  const screenToImageNorm = useCallback((lx: number, ly: number) => {
    const c = canvasRef.current; const v = vpRef.current; const rect = imageRectRef.current;
    if (!rect) return null;
    const cx = c.width / 2, cy = c.height / 2;
    const preX = (lx - cx - v.tx) / v.scale + cx;
    const preY = (ly - cy - v.ty) / v.scale + cy;
    return { nx: (preX - rect.x) / rect.w, ny: (preY - rect.y) / rect.h };
  }, []);

  // Compute + set the homography from current labels (used by the button and the
  // live auto-resolve). Returns true on success.
  const solveFrom = useCallback((ls: PlacedLabel[], quiet = false): boolean => {
    const f = frameRef.current;
    if (!f || ls.length < 4) { if (!quiet) setErr("Place at least 4 landmarks to solve."); return false; }
    const lm = buildFieldLandmarks(FIELD_SPECS[specKey]!);
    const corr: Correspondence[] = ls.map((l) => ({
      field: lm[l.id] as GroundPoint,
      image: { u: l.nx * f.imageWidth, v: l.ny * f.imageHeight },
    }));
    const fit = fitHomography(corr);
    if (!fit) { if (!quiet) setErr("Couldn't solve — spread the landmarks out (avoid a line)."); return false; }
    setErr(null);
    setHomography({ H: fit.H, rmsPx: fit.rmsPx });
    return true;
  }, [specKey]);

  // Apply a labels change, and live-resolve if we've solved before.
  const updateLabels = useCallback((next: PlacedLabel[]) => {
    labelsRef.current = next;
    setLabels(next);
    setBallPath(null);
    if (autoSolveRef.current) solveFrom(next, true);
    else setHomography(null);
  }, [solveFrom]);

  const placeActive = useCallback((nx: number, ny: number) => {
    const id = pendingIdRef.current;
    const wasPlaced = labelsRef.current.some((l) => l.id === id);
    const next = [...labelsRef.current.filter((l) => l.id !== id), { id, nx: clamp01(nx), ny: clamp01(ny) }];
    updateLabels(next);
    if (!wasPlaced) {
      const placed = new Set(next.map((l) => l.id));
      const adv = LABEL_CHOICES.find((c) => !placed.has(c.id));
      if (adv) setPendingId(adv.id);
    }
  }, [updateLabels]);

  const nudgeActive = useCallback((dnx: number, dny: number) => {
    const id = pendingIdRef.current;
    const cur = labelsRef.current;
    if (!cur.some((l) => l.id === id)) return; // only fine-tune an already-placed anchor
    updateLabels(cur.map((l) => (l.id === id ? { ...l, nx: clamp01(l.nx + dnx), ny: clamp01(l.ny + dny) } : l)));
  }, [updateLabels]);

  // ── gesture handling ────────────────────────────────────────────────────
  const gestureRef = useRef({ startTx: 0, startTy: 0, startScale: 1, startDist: 0, lastDx: 0, lastDy: 0, startLX: 0, startLY: 0, moved: false });
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (evt) => {
        measureCanvas(); // refresh offset (scroll position may have shifted it)
        const t = evt.nativeEvent.touches;
        // Use PAGE coords minus the canvas's measured window offset. locationX/Y
        // is relative to whichever (possibly transformed/scaled) subview received
        // the touch, so it's wrong under zoom — pageX/Y is consistent.
        const off = canvasOffsetRef.current;
        gestureRef.current = {
          startTx: vpRef.current.tx, startTy: vpRef.current.ty, startScale: vpRef.current.scale,
          startDist: t.length >= 2 ? touchDist(t as any[]) : 0,
          lastDx: 0, lastDy: 0,
          startLX: evt.nativeEvent.pageX - off.x, startLY: evt.nativeEvent.pageY - off.y,
          moved: false,
        };
      },
      onPanResponderMove: (evt, gesture) => {
        const g = gestureRef.current;
        if (Math.hypot(gesture.dx, gesture.dy) > 6) g.moved = true;
        if (modeRef.current === "navigate") {
          const t = evt.nativeEvent.touches;
          if (t.length >= 2 && g.startDist > 0) {
            const d = touchDist(t as any[]);
            const scale = clamp(g.startScale * (d / g.startDist), 1, 8);
            setViewport({ ...vpRef.current, scale });
          } else {
            setViewport({ scale: vpRef.current.scale, tx: g.startTx + gesture.dx, ty: g.startTy + gesture.dy });
          }
        } else {
          // PLACE mode: one-finger drag fine-tunes the active (placed) anchor.
          const rect = imageRectRef.current; if (!rect) return;
          const incDx = gesture.dx - g.lastDx, incDy = gesture.dy - g.lastDy;
          g.lastDx = gesture.dx; g.lastDy = gesture.dy;
          nudgeActive((incDx / vpRef.current.scale) / rect.w, (incDy / vpRef.current.scale) / rect.h);
        }
      },
      onPanResponderRelease: () => {
        const g = gestureRef.current;
        if (modeRef.current === "place" && !g.moved) {
          const p = screenToImageNorm(g.startLX, g.startLY);
          if (p && p.nx >= 0 && p.nx <= 1 && p.ny >= 0 && p.ny <= 1) placeActive(p.nx, p.ny);
        }
      },
    })
  ).current;

  // ── video / frame ───────────────────────────────────────────────────────
  const pickVideo = useCallback(async () => {
    setErr(null);
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { setErr("Photo library permission denied."); return; }
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions?.Videos ?? ("videos" as any), quality: 1,
    });
    if (res.canceled || !res.assets?.[0]) return;
    const uri = res.assets[0].uri;
    setVideoUri(uri);
    setFrame(null); setFrameTimeSec(0); setLabels([]); labelsRef.current = [];
    setHomography(null); setBallPath(null); autoSolveRef.current = false;
    setViewport({ scale: 1, tx: 0, ty: 0 });
    await loadFrame(uri, 0);
  }, [setViewport]);

  const loadFrame = useCallback(async (uri: string, timeSec: number) => {
    setBusy("loading frame…");
    try {
      const f = timeSec === 0
        ? await VisionTracker.firstFrame(uri, 0.9)
        : await VisionTracker.frameAtTime(uri, timeSec, 0.9);
      setFrame(f); setFrameTimeSec(timeSec);
    } catch (e) {
      setErr(`frame load failed: ${(e as Error).message}`);
    } finally { setBusy(null); }
  }, []);

  const frameStep = useCallback((deltaSec: number) => {
    if (!videoUri || !frame) return;
    const max = Math.max(0, frame.durationSec - (frame.frameRate > 0 ? 1 / frame.frameRate : 0.001));
    loadFrame(videoUri, Math.max(0, Math.min(max, frameTimeSec + deltaSec)));
  }, [videoUri, frame, frameTimeSec, loadFrame]);

  const frameStepSec = frame && frame.frameRate > 0 ? 1 / frame.frameRate : 1 / 30;

  const solve = useCallback(() => {
    if (solveFrom(labelsRef.current)) autoSolveRef.current = true;
  }, [solveFrom]);

  const clearLandmark = useCallback((id: LandmarkId) => {
    updateLabels(labelsRef.current.filter((l) => l.id !== id));
    setPendingId(id); // make the cleared one active for easy re-placement
  }, [updateLabels]);

  const clearAll = useCallback(() => {
    autoSolveRef.current = false;
    setLabels([]); labelsRef.current = [];
    setHomography(null); setBallPath(null); setPendingId("apex");
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
    } catch (e) {
      setErr(`ball detection failed: ${(e as Error).message}`);
    } finally { setBusy(null); }
  }, [videoUri, frame, frameTimeSec]);

  // Projected field (normalized image coords) for the overlay.
  const projectedField = useMemo(() => {
    if (!homography || !frame) return null;
    const toImg = (p: GroundPoint) => {
      const px = fieldToImage(homography.H, p);
      return px ? { nx: px.x / frame.imageWidth, ny: px.y / frame.imageHeight } : null;
    };
    const L = landmarks;
    return {
      foulFirst: [toImg(L.apex), toImg(L.foul_pole_first)] as const,
      foulThird: [toImg(L.apex), toImg(L.foul_pole_third)] as const,
      bases: [toImg(L.apex), toImg(L.first_base), toImg(L.second_base), toImg(L.third_base), toImg(L.apex)],
      rubber: toImg(L.rubber),
    };
  }, [homography, frame, landmarks]);

  const placedIds = new Set(labels.map((l) => l.id));

  if (!VisionTracker.available()) {
    return <View style={[styles.center, { backgroundColor: theme.background }]}><Text style={{ color: theme.text }}>Video frame extraction not available in this build.</Text></View>;
  }

  // Normalized image coords → on-screen (pre-transform canvas) coords for SVG.
  const toCanvas = (nx: number, ny: number) => imageRect ? { x: imageRect.x + nx * imageRect.w, y: imageRect.y + ny * imageRect.h } : { x: 0, y: 0 };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.background }} contentContainerStyle={{ padding: 12 }} scrollEnabled={mode === "navigate" ? false : true}>
      <Text style={[styles.h1, { color: theme.text }]}>Field Analysis</Text>
      <Text style={[styles.sub, { color: theme.textMuted }]}>Import a clip, tap field landmarks to label them, solve, then overlay the field + ball path.</Text>

      <Pressable onPress={pickVideo} style={[styles.btn, { backgroundColor: theme.primary }]}>
        <Text style={styles.btnText}>{videoUri ? "Pick a different video" : "Pick video"}</Text>
      </Pressable>

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
        {(Object.keys(FIELD_SPECS) as SpecKey[]).map((k) => (
          <Pressable key={k} onPress={() => { setSpecKey(k); if (autoSolveRef.current) solveFrom(labelsRef.current, true); }}
            style={[styles.pill, { backgroundColor: specKey === k ? theme.primary : theme.surfaceAlt, borderColor: theme.border }]}>
            <Text style={{ color: specKey === k ? "#fff" : theme.text, fontSize: 12, fontWeight: "600" }}>{FIELD_SPECS[k]!.name}</Text>
          </Pressable>
        ))}
      </View>

      {frame && imageRect && (
        <>
          {/* Mode toggle */}
          <View style={{ flexDirection: "row", gap: 6, marginTop: 10 }}>
            {(["place", "navigate"] as Mode[]).map((m) => (
              <Pressable key={m} onPress={() => setMode(m)}
                style={[styles.btn, { flex: 1, backgroundColor: mode === m ? theme.primary : theme.surfaceAlt }]}>
                <Text style={[styles.btnText, { color: mode === m ? "#fff" : theme.text }]}>{m === "place" ? "Place / Edit" : "Zoom / Pan"}</Text>
              </Pressable>
            ))}
            <Pressable onPress={() => setViewport({ scale: 1, tx: 0, ty: 0 })} style={[styles.btn, { backgroundColor: theme.surfaceAlt }]}>
              <Text style={[styles.btnText, { color: theme.text }]}>Reset view</Text>
            </Pressable>
          </View>

          {/* Frame canvas (clips zoom); inner view carries the viewport transform */}
          <View
            ref={canvasViewRef}
            {...panResponder.panHandlers}
            onLayout={(e: LayoutChangeEvent) => { setCanvas({ width: e.nativeEvent.layout.width || 1, height: e.nativeEvent.layout.height || 1 }); measureCanvas(); }}
            style={{ width: "100%", aspectRatio: frame.imageWidth / frame.imageHeight, backgroundColor: "#111", borderRadius: 8, overflow: "hidden", marginTop: 8 }}
          >
            <View style={[StyleSheet.absoluteFill, { transform: [{ translateX: vp.tx }, { translateY: vp.ty }, { scale: vp.scale }] }]}>
              <Image source={{ uri: `data:image/jpeg;base64,${frame.imageBase64}` }} style={StyleSheet.absoluteFill} resizeMode="contain" />
              <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
                {projectedField && (() => {
                  const ln = (a: { nx: number; ny: number } | null, b: { nx: number; ny: number } | null) => {
                    if (!a || !b) return null; const pa = toCanvas(a.nx, a.ny), pb = toCanvas(b.nx, b.ny);
                    return { x1: pa.x, y1: pa.y, x2: pb.x, y2: pb.y };
                  };
                  const f1 = ln(projectedField.foulFirst[0], projectedField.foulFirst[1]);
                  const f3 = ln(projectedField.foulThird[0], projectedField.foulThird[1]);
                  const ring = projectedField.bases.every(Boolean) ? projectedField.bases.map((b) => { const p = toCanvas(b!.nx, b!.ny); return `${p.x},${p.y}`; }).join(" ") : null;
                  const r = projectedField.rubber ? toCanvas(projectedField.rubber.nx, projectedField.rubber.ny) : null;
                  const sw = 2 / vp.scale; // keep stroke ~constant on screen when zoomed
                  return (
                    <>
                      {f1 && <Line {...f1} stroke="#FFD60A" strokeWidth={sw} strokeOpacity={0.9} />}
                      {f3 && <Line {...f3} stroke="#FFD60A" strokeWidth={sw} strokeOpacity={0.9} />}
                      {ring && <Polygon points={ring} fill="none" stroke="#0A84FF" strokeWidth={sw} strokeOpacity={0.9} />}
                      {r && <Circle cx={r.x} cy={r.y} r={5 / vp.scale} fill="#0A84FF" />}
                    </>
                  );
                })()}
                {ballPath && ballPath.length >= 2 && (
                  <Polyline points={ballPath.map((p) => { const c = toCanvas(p.nx, p.ny); return `${c.x},${c.y}`; }).join(" ")} fill="none" stroke="#FF3B30" strokeWidth={2 / vp.scale} strokeOpacity={0.9} />
                )}
                {ballPath?.map((p, i) => { const c = toCanvas(p.nx, p.ny); return <Circle key={i} cx={c.x} cy={c.y} r={2.5 / vp.scale} fill="#FF3B30" />; })}
                {labels.map((l) => {
                  const c = toCanvas(l.nx, l.ny);
                  const active = l.id === pendingId;
                  return (
                    <React.Fragment key={l.id}>
                      <Circle cx={c.x} cy={c.y} r={(active ? 7 : 6) / vp.scale} fill={active ? "#FF9F0A" : "#34C759"} fillOpacity={0.9} stroke="#fff" strokeWidth={1 / vp.scale} />
                      <SvgText x={c.x + 9 / vp.scale} y={c.y + 4 / vp.scale} fill={active ? "#FF9F0A" : "#34C759"} fontSize={11 / vp.scale} fontWeight="bold">{l.id}</SvgText>
                    </React.Fragment>
                  );
                })}
              </Svg>
            </View>
          </View>

          {/* Scrub */}
          <View style={{ flexDirection: "row", gap: 6, marginTop: 8 }}>
            <Pressable onPress={() => frameStep(-1)} style={[styles.smBtn, { backgroundColor: theme.surfaceAlt }]}><Text style={{ color: theme.text }}>«1s</Text></Pressable>
            <Pressable onPress={() => frameStep(-frameStepSec)} style={[styles.smBtn, { backgroundColor: theme.surfaceAlt }]}><Text style={{ color: theme.text }}>‹ frame</Text></Pressable>
            <Pressable onPress={() => frameStep(frameStepSec)} style={[styles.smBtn, { backgroundColor: theme.surfaceAlt }]}><Text style={{ color: theme.text }}>frame ›</Text></Pressable>
            <Pressable onPress={() => frameStep(1)} style={[styles.smBtn, { backgroundColor: theme.surfaceAlt }]}><Text style={{ color: theme.text }}>1s»</Text></Pressable>
          </View>
          <Text style={{ color: theme.textMuted, fontSize: 12, marginTop: 4 }}>
            {frameTimeSec.toFixed(2)}s / {frame.durationSec.toFixed(2)}s{frame.frameRate > 0 ? ` · ${frame.frameRate.toFixed(0)} fps` : ""}
            {mode === "place" ? "  ·  tap to place, drag to fine-tune" : "  ·  pinch to zoom, drag to pan"}
          </Text>

          {/* Landmark picker — tap pill to make active; ✕ clears that one */}
          <Text style={[styles.label, { color: theme.text }]}>Active: <Text style={{ fontWeight: "700" }}>{LABEL_CHOICES.find((c) => c.id === pendingId)?.label}</Text></Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {LABEL_CHOICES.map((c) => {
              const isPlaced = placedIds.has(c.id);
              const isActive = pendingId === c.id;
              return (
                <View key={c.id} style={[styles.pill, { flexDirection: "row", alignItems: "center", gap: 6,
                  backgroundColor: isActive ? theme.primary : isPlaced ? theme.surface : theme.surfaceAlt,
                  borderColor: isPlaced ? "#34C759" : theme.border }]}>
                  <Pressable onPress={() => setPendingId(c.id)}>
                    <Text style={{ color: isActive ? "#fff" : theme.text, fontSize: 12 }}>{isPlaced ? "✓ " : ""}{c.label}</Text>
                  </Pressable>
                  {isPlaced && (
                    <Pressable onPress={() => clearLandmark(c.id)} hitSlop={8}>
                      <Text style={{ color: isActive ? "#fff" : theme.textMuted, fontSize: 13, fontWeight: "700" }}>✕</Text>
                    </Pressable>
                  )}
                </View>
              );
            })}
          </View>

          <View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}>
            <Pressable onPress={solve} disabled={labels.length < 4 || !!busy}
              style={[styles.btn, { flex: 1, backgroundColor: theme.highlight, opacity: labels.length < 4 || busy ? 0.4 : 1 }]}>
              <Text style={styles.btnText}>Solve field ({labels.length})</Text>
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
  btn: { paddingVertical: 12, paddingHorizontal: 14, borderRadius: 10, alignItems: "center" },
  btnText: { color: "#fff", fontWeight: "600", fontSize: 14 },
  smBtn: { flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: "center" },
  pill: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth },
});
