import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  SafeAreaView,
  Dimensions,
} from "react-native";
import {
  Lidar,
  LidarARView,
  lidarARViewAvailable,
  type LidarARViewRef,
} from "../../modules/expo-lidar/src";
import { computeHomePlatePose, transformPoint, type Vec3 } from "../../src/field/coordinateFrame";
import {
  runPlatePipelineDebug,
  type Point2,
  type PlatePipelineDebug,
} from "../../src/field/plateDetect";
import { fitFoulLines, type GroundPointXZ } from "../../src/field/foulLine";
import {
  PlateDebugOverlay,
  PlatePlacementOverlay,
  DEFAULT_DEBUG_LAYERS,
  type PlateDebugLayers,
} from "../../src/field/PlateDebugOverlay";

const { width: SCREEN_W } = Dimensions.get("window");

const DEBUG_LAYER_KEYS: { key: keyof PlateDebugLayers; label: string }[] = [
  { key: "region", label: "Region" },
  { key: "dp", label: "DP" },
  { key: "edges", label: "Edges" },
  { key: "corners", label: "Corners" },
  { key: "snapped", label: "Snapped" },
];

// Plate — establish an AR world anchored to home plate.
//
// This is Phase A / §8.2 of the field-registration plan (AR_WORLD_ANCHOR.md):
// the manual 5-corner tap is the calibration stand-in ahead of the automatic
// region → contour → solvePnP fix. Each tap raycasts the screen-center crosshair
// to the ground plane; at 5 corners, computeHomePlatePose() recovers the plate's
// pose by pure geometry and drops a virtual home_plate marker on the real one.
export default function PlateScreen() {
  const arRef = useRef<LidarARViewRef>(null);

  const plateCornersRef = useRef<Vec3[]>([]);
  const [plateCount, setPlateCount] = useState(0);
  const trainingCountRef = useRef(0);
  const [trainingCount, setTrainingCount] = useState(0);
  const [plateStatus, setPlateStatus] = useState(
    "Aim the crosshair at a home-plate corner, then tap Capture (0/5).",
  );

  // Debug visualization of the detection pipeline (toggleable layers).
  const [debugOn, setDebugOn] = useState(false);
  const [debugLayers, setDebugLayers] = useState<PlateDebugLayers>(DEFAULT_DEBUG_LAYERS);
  const [debugData, setDebugData] = useState<PlatePipelineDebug | null>(null);
  const [viewSize, setViewSize] = useState({ w: 0, h: 0 });

  // ── Auto acquire / maintain state machine ──────────────────────────────────
  // "off"        — Auto not running.
  // "acquiring"  — scanning for the biggest plausible plate; draws a green
  //                candidate and offers "Confirm Anchor". No anchor yet.
  // "maintaining"— anchor set; keeps scanning but ONLY near the anchor's screen
  //                position, re-establishing to correct drift (never a new plate).
  type AutoPhase = "off" | "acquiring" | "maintaining";
  const [autoPhase, setAutoPhase] = useState<AutoPhase>("off");
  const autoPhaseRef = useRef<AutoPhase>("off");
  useEffect(() => { autoPhaseRef.current = autoPhase; }, [autoPhase]);
  // Snapped plate corners (PIXEL space) currently drawn by the placement overlay.
  const [placementCorners, setPlacementCorners] = useState<Point2[] | null>(null);
  // World-space corners of the live candidate (for confirm) / last good fix.
  const candidateWorldRef = useRef<Vec3[] | null>(null);
  // The committed anchor's world center, used to gate maintain-mode scanning to
  // a region of interest around it (so we re-lock the SAME plate, not a new one).
  const anchorCenterRef = useRef<Vec3 | null>(null);

  // ── Foul-line yaw maintenance (AR_WORLD_ANCHOR §5) ─────────────────────────
  // Toggle so we can test plate-only (off = behaves exactly as before) vs.
  // foul-line-assisted yaw correction (on). The latest accepted plate pose's
  // worldToField matrix lets us express raycast ground points in the field frame
  // for fitFoulLines; the recovered yaw drift refines the anchor heading.
  const [foulLinesOn, setFoulLinesOn] = useState(false);
  const foulLinesOnRef = useRef(false);
  useEffect(() => { foulLinesOnRef.current = foulLinesOn; }, [foulLinesOn]);
  const worldToFieldRef = useRef<number[] | null>(null);
  // Smoothed yaw-drift correction (radians), low-passed to avoid jitter.
  const yawCorrRef = useRef(0);

  // Run the full pipeline on the current frame's best contour and capture every
  // intermediate stage for the overlay. Picks the contour whose template snap
  // has the lowest residual (the most plate-like), so the overlay tracks the
  // real plate even with other white blobs (bases, chalk) in frame.
  //
  // The native contour points are view-normalized (0..1). We scale them into
  // PIXEL space before running the pipeline, because fitPlateTemplate is a
  // uniform-scale (isotropic) fit — feeding it normalized coords on a non-square
  // screen stretches the snapped plate (the real 3D anchor is unaffected; it's
  // solved in metric space). The overlay then plots these pixel coords directly.
  const runDebug = useCallback(async () => {
    const { w: W, h: H } = viewSize;
    if (W <= 0 || H <= 0) { setPlateStatus("Debug: view not measured yet — try again."); return; }
    let contours: number[][];
    try {
      contours = (await arRef.current?.detectPlateContours(6)) ?? [];
    } catch (e) {
      setPlateStatus(`Debug failed: ${(e as Error).message}`);
      return;
    }
    if (contours.length === 0) { setDebugData(null); setPlateStatus("Debug: no white region found."); return; }

    let best: PlatePipelineDebug | null = null;
    for (const flat of contours) {
      const pts: Point2[] = [];
      for (let i = 0; i + 1 < flat.length; i += 2) pts.push({ x: flat[i]! * W, y: flat[i + 1]! * H });
      const dbg = runPlatePipelineDebug(pts);
      const r = dbg.snappedRmsInches ?? Infinity;
      const bestR = best?.snappedRmsInches ?? Infinity;
      if (best === null || r < bestR) best = dbg;
    }
    setDebugData(best);
    if (best?.snappedRmsInches != null) {
      setPlateStatus(`Debug: fit ${best.snappedRmsInches.toFixed(1)}in RMS · conf ${((best.confidence ?? 0) * 100).toFixed(0)}%`);
    } else {
      setPlateStatus("Debug: contour found, no plate fit.");
    }
  }, [viewSize]);

  const toggleDebug = useCallback(() => {
    setDebugOn((on) => !on);
  }, []);

  // Continuous identify loop: while Debug is on, keep re-running detection and
  // refreshing the overlay (~6/sec) so you can watch how well it picks up the
  // plate as you move. Pure feedback — it does NOT anchor. The loop stops and the
  // overlay clears when Debug is turned off or the screen unmounts.
  useEffect(() => {
    if (!debugOn) { setDebugData(null); return; }
    let cancelled = false;
    (async () => {
      while (!cancelled) {
        await runDebug();
        await new Promise((r) => setTimeout(r, 150));
      }
    })();
    return () => { cancelled = true; };
  }, [debugOn, runDebug]);

  const toggleLayer = useCallback((key: keyof PlateDebugLayers) => {
    setDebugLayers((l) => ({ ...l, [key]: !l[key] }));
  }, []);

  const establishPlateWorld = useCallback(async (
    corners: Vec3[],
    opts: { quiet?: boolean; yawCorrDeg?: number } = {},
  ) => {
    const p = computeHomePlatePose(corners);
    if (!p) { if (!opts.quiet) setPlateStatus("Couldn't solve the plate — tap Reset and recapture."); return false; }
    // Heading toward the pitcher = field "forward" (same atan2 convention as
    // src/field/templates.ts), used to orient the rendered plate. When foul-line
    // maintenance supplies a yaw correction, fold it into the plate's heading.
    const baseHeadingDeg = (Math.atan2(p.forward.x, p.forward.z) * 180) / Math.PI;
    const headingDeg = baseHeadingDeg + (opts.yawCorrDeg ?? 0);
    try {
      await arRef.current?.clearFieldLandmarks();
      await arRef.current?.addFieldLandmarkAtWorld(
        p.center.x, p.center.y, p.center.z, "home_plate", headingDeg,
      );
    } catch {
      // Marker render is best-effort; the readout still stands.
    }
    anchorCenterRef.current = p.center;        // for maintain-mode ROI gating
    worldToFieldRef.current = p.frame.worldToField; // for foul-line field-frame transform
    const frontIn = p.frontEdgeLengthM * 39.3701;
    const errPct = Math.round(p.scaleError * 100);
    const foulNote = opts.yawCorrDeg != null ? ` · foul yaw ${opts.yawCorrDeg >= 0 ? "+" : ""}${opts.yawCorrDeg.toFixed(1)}°` : "";
    setPlateStatus(
      `${p.scaleError <= 0.2 ? "World anchored" : "Placed (size off?)"} · ` +
      `${frontIn.toFixed(1)}in (${errPct}% off 17in) · heading ${headingDeg.toFixed(0)}°${foulNote}`,
    );
    return true;
  }, []);

  const capturePlateCorner = useCallback(async () => {
    const hit = await arRef.current?.raycastScreenPoint(0.5, 0.5).catch(() => null);
    if (!hit) { setPlateStatus("No surface under the crosshair — aim at the ground."); return; }
    const next: Vec3[] = [...plateCornersRef.current, { x: hit.worldX, y: hit.worldY, z: hit.worldZ }];
    plateCornersRef.current = next;
    setPlateCount(next.length);
    if (next.length < 5) setPlateStatus(`Captured ${next.length}/5 — move to the next corner.`);
    else { setPlateStatus("Solving…"); await establishPlateWorld(next); }
  }, [establishPlateWorld]);

  const resetPlateWorld = useCallback(async () => {
    plateCornersRef.current = [];
    setPlateCount(0);
    setPlateStatus("Aim the crosshair at a home-plate corner, then tap Capture (0/5).");
    try { await arRef.current?.clearFieldLandmarks(); } catch { /* ignore */ }
  }, []);

  // One auto scan pass (Phase A, AR_WORLD_ANCHOR §4). Behaviour depends on phase:
  //  • acquiring  — pick the BIGGEST plausible plate anywhere in frame.
  //  • maintaining— only accept a candidate whose snapped center is near the
  //                 committed anchor's projected screen position (ROI gate), so
  //                 we re-lock the same physical plate and ignore others.
  // Draws the snapped plate (green=acquiring, cyan=maintaining) and stashes its
  // world-space corners. In maintaining, also re-establishes the anchor to
  // correct drift. Returns the world corners drawn, or null.
  const scanOnce = useCallback(async (): Promise<Vec3[] | null> => {
    const { w: W, h: H } = viewSize;
    if (W <= 0 || H <= 0) return null;

    // Maintain ROI: project the anchor center to screen; accept only candidates
    // whose centroid lands within this normalized radius of it.
    const MAINTAIN_ROI = 0.28; // ~28% of view diagonal
    let roi: { x: number; y: number } | null = null;
    if (autoPhaseRef.current === "maintaining" && anchorCenterRef.current) {
      const c = anchorCenterRef.current;
      const proj = await arRef.current?.projectWorldPoint(c.x, c.y, c.z).catch(() => null);
      if (proj && proj.isInFront) roi = { x: proj.screenX, y: proj.screenY };
      // If the anchor is off-screen/behind, skip this pass (keep last drawing).
      else return candidateWorldRef.current;
    }

    let contours: number[][];
    try {
      contours = (await arRef.current?.detectPlateContours(8)) ?? [];
    } catch {
      return null;
    }
    if (contours.length === 0) { setPlacementCorners(null); candidateWorldRef.current = null; return null; }

    // Evaluate every candidate contour; score by snap residual, but in acquiring
    // mode bias toward the BIGGEST (largest snapped area) plausible plate.
    type Cand = { snapPx: Point2[]; centroid: Point2; area: number; rms: number };
    const cands: Cand[] = [];
    for (const flat of contours) {
      const pts: Point2[] = [];
      for (let i = 0; i + 1 < flat.length; i += 2) pts.push({ x: flat[i]! * W, y: flat[i + 1]! * H });
      const dbg = runPlatePipelineDebug(pts);
      if (!dbg.snappedCorners) continue;
      const snap = dbg.snappedCorners;
      let cx = 0, cy = 0;
      for (const p of snap) { cx += p.x; cy += p.y; }
      cx /= snap.length; cy /= snap.length;
      cands.push({
        snapPx: snap,
        centroid: { x: cx, y: cy },
        area: polygonArea(snap),
        rms: dbg.snappedRmsInches ?? Infinity,
      });
    }
    if (cands.length === 0) { setPlacementCorners(null); candidateWorldRef.current = null; return null; }

    let chosen: Cand | undefined;
    if (roi) {
      // Maintain: nearest-to-ROI among those within the radius.
      const diag = Math.hypot(W, H);
      const within = cands
        .map((c) => ({ c, d: Math.hypot(c.centroid.x - roi!.x * W, c.centroid.y - roi!.y * H) }))
        .filter((x) => x.d <= MAINTAIN_ROI * diag)
        .sort((a, b) => a.d - b.d);
      chosen = within[0]?.c;
      if (!chosen) return candidateWorldRef.current; // nothing near anchor this frame
    } else {
      // Acquire: the biggest plausible plate.
      chosen = [...cands].sort((a, b) => b.area - a.area)[0];
    }
    if (!chosen) return null;

    setPlacementCorners(chosen.snapPx);

    // Raycast the snapped corners (back to normalized) to the ground plane.
    const world: Vec3[] = [];
    for (const c of chosen.snapPx) {
      const hit = await arRef.current?.raycastScreenPoint(c.x / W, c.y / H).catch(() => null);
      if (!hit) { candidateWorldRef.current = null; return null; }
      world.push({ x: hit.worldX, y: hit.worldY, z: hit.worldZ });
    }
    candidateWorldRef.current = world;
    return world;
  }, [viewSize]);

  // Foul-line yaw pass (AR_WORLD_ANCHOR §5). Reuses the white-region contours we
  // already detect, raycasts ALL their points to the ground in one batch call,
  // transforms them into the plate's field frame, drops everything within 2m of
  // the plate (batter's box), and fits the two foul lines. Returns the recovered
  // yaw-drift (degrees) to fold into the heading, or null if not enough signal.
  const scanFoulLineYaw = useCallback(async (): Promise<number | null> => {
    const { w: W, h: H } = viewSize;
    const w2f = worldToFieldRef.current;
    if (W <= 0 || H <= 0 || !w2f) return null;

    let contours: number[][];
    try {
      contours = (await arRef.current?.detectPlateContours(8)) ?? [];
    } catch {
      return null;
    }
    if (contours.length === 0) return null;

    // Flatten all contour points to a single normalized [nx,ny,...] batch.
    const flatNorm: number[] = [];
    for (const c of contours) for (const v of c) flatNorm.push(v);
    if (flatNorm.length < 12) return null;

    let world: number[];
    try {
      world = (await arRef.current?.raycastScreenPoints(flatNorm)) ?? [];
    } catch {
      return null;
    }

    // World → field frame; keep near-ground points as XZ (x→1B, z→3B).
    const ground: GroundPointXZ[] = [];
    for (let i = 0; i + 2 < world.length; i += 3) {
      const x = world[i]!, y = world[i + 1]!, z = world[i + 2]!;
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
      const f = transformPoint({ x, y, z }, w2f);
      if (Math.abs(f.y) > 0.25) continue; // not on the ground plane
      ground.push({ x: f.x, z: f.z });
    }
    if (ground.length < 12) return null;

    const fit = fitFoulLines(ground, { excludeRadiusM: 2 });
    if (fit.confidence < 0.35) return null;
    return (fit.yawDriftRad * 180) / Math.PI;
  }, [viewSize]);

  // Confirm the current acquiring candidate → establish the anchor and switch to
  // maintaining (which re-locks the SAME plate to correct drift).
  const confirmAnchor = useCallback(async () => {
    const world = candidateWorldRef.current;
    if (!world || world.length !== 5) { setPlateStatus("No plate detected yet — keep aiming."); return; }
    const ok = await establishPlateWorld(world);
    if (ok) setAutoPhase("maintaining");
  }, [establishPlateWorld]);

  const startAuto = useCallback(() => {
    anchorCenterRef.current = null;
    candidateWorldRef.current = null;
    worldToFieldRef.current = null;
    yawCorrRef.current = 0;
    setPlacementCorners(null);
    setAutoPhase("acquiring");
    setPlateStatus("Looking for home plate…");
  }, []);

  const stopAuto = useCallback(async () => {
    setAutoPhase("off");
    setPlacementCorners(null);
    candidateWorldRef.current = null;
    anchorCenterRef.current = null;
    worldToFieldRef.current = null;
    yawCorrRef.current = 0;
    try { await arRef.current?.clearFieldLandmarks(); } catch { /* ignore */ }
    setPlateStatus("Auto-detect off.");
  }, []);

  // Auto loop: scan ~4/sec while acquiring or maintaining. In maintaining, each
  // successful scan re-establishes the anchor to correct drift — using the plate
  // alone (foul lines OFF = original behavior, the B test mode) or refining the
  // heading with the foul-line yaw drift (foul lines ON, §5), low-passed.
  useEffect(() => {
    if (autoPhase === "off") return;
    let cancelled = false;
    (async () => {
      while (!cancelled) {
        const world = await scanOnce();
        if (!cancelled && world && autoPhaseRef.current === "maintaining") {
          let yawCorrDeg: number | undefined;
          if (foulLinesOnRef.current) {
            const measured = await scanFoulLineYaw();
            if (measured != null) {
              // Low-pass: ease toward the measurement to damp per-frame jitter.
              yawCorrRef.current = yawCorrRef.current * 0.7 + measured * 0.3;
            }
            yawCorrDeg = yawCorrRef.current;
          }
          if (!cancelled) await establishPlateWorld(world, { quiet: true, yawCorrDeg });
        }
        await new Promise((r) => setTimeout(r, 220));
      }
    })();
    return () => { cancelled = true; };
  }, [autoPhase, scanOnce, scanFoulLineYaw, establishPlateWorld]);

  // Save the current AR frame to the photo library to build a labeling dataset
  // for the §10 fallback (and for line-robustness testing, §7.3). Point the
  // phone at home plate from varied angles/distances/lighting and tap repeatedly.
  const saveTrainingFrame = useCallback(async () => {
    try {
      const cap = await arRef.current?.captureViewImage(0.9);
      if (!cap) { setPlateStatus("Couldn't grab a frame — try again."); return; }
      const ok = await Lidar.saveImageToPhotos(cap.imageBase64);
      if (ok) {
        const n = trainingCountRef.current + 1;
        trainingCountRef.current = n;
        setTrainingCount(n);
        setPlateStatus(`Saved training frame #${n} to Photos.`);
      } else {
        setPlateStatus("Save failed — check Photos permission.");
      }
    } catch (e) {
      setPlateStatus(`Save failed: ${(e as Error).message}`);
    }
  }, []);

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
    <View
      style={styles.container}
      onLayout={(e) => setViewSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
    >
      <LidarARView ref={arRef} style={StyleSheet.absoluteFill} />

      {/* Auto acquire/maintain placement overlay (green=candidate, cyan=anchored) */}
      {autoPhase !== "off" && (
        <PlatePlacementOverlay
          corners={placementCorners}
          width={viewSize.w}
          height={viewSize.h}
          confirmed={autoPhase === "maintaining"}
        />
      )}

      {/* Pipeline debug overlay (stroke-only, toggleable layers) */}
      {debugOn && (
        <PlateDebugOverlay
          debug={debugData}
          layers={debugLayers}
          width={viewSize.w}
          height={viewSize.h}
        />
      )}

      {/* Crosshair — only for the manual capture flow (hidden during Auto) */}
      {autoPhase === "off" && (
        <View pointerEvents="none" style={styles.plateCrosshair}>
          <View style={styles.crossH} />
          <View style={styles.crossV} />
        </View>
      )}

      <SafeAreaView style={styles.overlay} pointerEvents="box-none">
        <View style={styles.statsBar} pointerEvents="none">
          <Text style={styles.statsText}>{plateStatus}</Text>
        </View>

        {/* Per-layer toggles (only while Debug is on) */}
        {debugOn && (
          <View style={styles.layerBar}>
            {DEBUG_LAYER_KEYS.map(({ key, label }) => (
              <TogglePill
                key={key}
                label={label}
                active={debugLayers[key]}
                onPress={() => toggleLayer(key)}
                small
              />
            ))}
          </View>
        )}

        <View style={styles.controlBar}>
          {autoPhase === "off" && (
            <>
              <TogglePill
                label={plateCount >= 5 ? "Captured 5/5" : `Capture ${plateCount}/5`}
                active={plateCount > 0 && plateCount < 5}
                onPress={capturePlateCorner}
                disabled={plateCount >= 5}
              />
              <TogglePill label="Auto" active={false} onPress={startAuto} />
              <TogglePill label="Debug" active={debugOn} onPress={toggleDebug} />
              <TogglePill label="Reset" active={false} onPress={resetPlateWorld} />
              <TogglePill
                label={trainingCount > 0 ? `Save Frame (${trainingCount})` : "Save Frame"}
                active={false}
                onPress={saveTrainingFrame}
              />
            </>
          )}
          {autoPhase === "acquiring" && (
            <>
              <TogglePill
                label="Confirm Anchor"
                active={!!placementCorners}
                onPress={confirmAnchor}
                disabled={!placementCorners}
              />
              <TogglePill label="Cancel" active={false} onPress={stopAuto} />
            </>
          )}
          {autoPhase === "maintaining" && (
            <>
              <TogglePill
                label="Foul Lines"
                active={foulLinesOn}
                onPress={() => setFoulLinesOn((v) => !v)}
              />
              <TogglePill label="Re-acquire" active={false} onPress={startAuto} />
              <TogglePill label="Stop Auto" active onPress={stopAuto} />
            </>
          )}
        </View>
      </SafeAreaView>
    </View>
  );
}

// Shoelace area of a polygon (pixel² ), for picking the biggest plate.
function polygonArea(pts: Point2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!, q = pts[(i + 1) % pts.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

function TogglePill({
  label,
  active,
  onPress,
  disabled,
  small,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  disabled?: boolean;
  small?: boolean;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      style={[styles.pill, small && styles.pillSmall, active && styles.pillActive, disabled && styles.pillDisabled]}
      activeOpacity={0.7}
    >
      <Text style={[styles.pillText, small && styles.pillTextSmall, active && styles.pillTextActive]}>
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
  statsBar: {
    alignItems: "center",
    marginBottom: 8,
  },
  statsText: {
    color: "rgba(255, 255, 255, 0.8)",
    fontSize: 12,
    fontWeight: "500",
    fontVariant: ["tabular-nums"],
    backgroundColor: "rgba(0, 0, 0, 0.4)",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
    overflow: "hidden",
  },
  controlBar: {
    flexDirection: "row",
    justifyContent: "center",
    flexWrap: "wrap",
    gap: 10,
    paddingHorizontal: 16,
    paddingBottom: 24,
  },
  layerBar: {
    flexDirection: "row",
    justifyContent: "center",
    flexWrap: "wrap",
    gap: 6,
    paddingHorizontal: 16,
    marginBottom: 10,
  },
  pill: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 20,
    backgroundColor: "rgba(0, 0, 0, 0.45)",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.2)",
  },
  pillSmall: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
  },
  pillActive: {
    backgroundColor: "rgba(255, 255, 255, 0.85)",
    borderColor: "rgba(255, 255, 255, 0.9)",
  },
  pillDisabled: {
    opacity: 0.35,
  },
  pillText: {
    color: "rgba(255, 255, 255, 0.9)",
    fontSize: 14,
    fontWeight: "600",
  },
  pillTextSmall: {
    fontSize: 12,
  },
  pillTextActive: {
    color: "#000",
  },
  // Crosshair
  plateCrosshair: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
  crossH: { position: "absolute", width: 28, height: 2, backgroundColor: "rgba(255,255,255,0.85)", borderRadius: 1 },
  crossV: { position: "absolute", width: 2, height: 28, backgroundColor: "rgba(255,255,255,0.85)", borderRadius: 1 },
});
