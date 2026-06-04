// 3D field model overlay — progressive anchor calibration.
//
// Workflow:
//   0 anchors → free orbit (drag rotates)
//   Tap handle → anchor it at its current screen position (green)
//   1 anchor  → drag rotates, anchor stays pinned on screen
//   2 anchors → drag rotates around anchor–anchor axis, both stay pinned
//   3 anchors → fully constrained, done
//
// Zoom is controlled by a slider below the video, not touch.
// Model/Video toggle switches which layer gestures control.

import React, {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  forwardRef,
} from "react";
import { StyleSheet, View, PanResponder, Text, Pressable } from "react-native";
import { GLView, type ExpoWebGLRenderingContext } from "expo-gl";
import { Renderer } from "expo-three";
import * as THREE from "three";
import { loadFieldModel, type FieldModel, type HandlePoint } from "./loadFieldModel";
import {
  fitHomography,
  type Correspondence,
  type HomographyFit,
} from "./videoHomography";
import { type CameraPose } from "./batterBox";

// ── Public interface ────────────────────────────────────────────────────

export interface FieldModelOverlayProps {
  imageWidth: number;
  imageHeight: number;
  vp: { scale: number; tx: number; ty: number };
  canvas: { width: number; height: number };
  canvasPageOffset: { x: number; y: number };
}

export interface FieldModelOverlayHandle {
  solve: () => CameraPose | null;
  reset: () => void;
  anchoredCount: () => number;
  getState: () => {
    positions: Record<string, { nx: number; ny: number }>;
    anchored: Record<string, boolean>;
  };
  setState: (s: {
    positions: Record<string, { nx: number; ny: number }>;
    anchored: Record<string, boolean>;
  }) => void;
}

// ── Colors ──────────────────────────────────────────────────────────────

const FREE_COLOR = "rgba(0,200,255,0.9)";
const ANCHOR_COLOR = "rgba(0,255,100,0.95)";
const HANDLE_R = 6;

// ── Types ───────────────────────────────────────────────────────────────

interface Anchor { id: string; nx: number; ny: number; }

// ── Component ───────────────────────────────────────────────────────────

export const FieldModelOverlay = forwardRef<FieldModelOverlayHandle, FieldModelOverlayProps>(
  function FieldModelOverlay(
    { imageWidth, imageHeight, vp, canvas, canvasPageOffset },
    ref,
  ) {
    const sceneRef = useRef<THREE.Scene | null>(null);
    const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
    const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
    const modelRef = useRef<FieldModel | null>(null);
    const rafRef = useRef<number>(0);

    const [handles, setHandles] = useState<HandlePoint[]>([]);
    const [loadStatus, setLoadStatus] = useState<string>("loading…");
    const [anchors, setAnchors] = useState<Anchor[]>([]);
    const anchorsRef = useRef(anchors);
    anchorsRef.current = anchors;
    const [controlMode, setControlMode] = useState<"model" | "video">("model");

    const [orbit, setOrbit] = useState({
      azimuth: 0, elevation: 0.25, distance: 25, targetX: 0, targetY: 8,
    });
    const orbitRef = useRef(orbit);
    orbitRef.current = orbit;
    const [projTick, setProjTick] = useState(0);

    const fieldById = useMemo(() => {
      const m: Record<string, { x: number; y: number }> = {};
      for (const h of handles) m[h.id] = { x: h.position.x, y: h.position.y };
      return m;
    }, [handles]);
    const fieldByIdRef = useRef(fieldById);
    fieldByIdRef.current = fieldById;

    // ── Camera helpers ────────────────────────────────────────────────

    function applyCam(cam: THREE.PerspectiveCamera, o: typeof orbit) {
      const cosE = Math.cos(o.elevation);
      cam.position.set(
        o.targetX + o.distance * cosE * Math.sin(o.azimuth),
        o.targetY - o.distance * cosE * Math.cos(o.azimuth),
        o.distance * Math.sin(o.elevation),
      );
      cam.up.set(0, 0, 1);
      cam.lookAt(o.targetX, o.targetY, 0);
      cam.updateMatrixWorld();
      cam.updateProjectionMatrix();
    }

    function projPt(cam: THREE.PerspectiveCamera, fx: number, fy: number) {
      const v = new THREE.Vector3(fx, fy, 0).project(cam);
      return { nx: (v.x + 1) / 2, ny: (1 - v.y) / 2 };
    }

    /** Newton solve: find targetX/targetY so fieldPt projects to screenPt. */
    function solveTarget(
      az: number, el: number, dist: number,
      fieldPt: { x: number; y: number },
      screenPt: { nx: number; ny: number },
      cam: THREE.PerspectiveCamera,
    ): { targetX: number; targetY: number } {
      let tx = fieldPt.x, ty = fieldPt.y;
      const cosE = Math.cos(el);
      const offX = dist * cosE * Math.sin(az);
      const offY = -dist * cosE * Math.cos(az);
      const offZ = dist * Math.sin(el);

      function proj(ttx: number, tty: number) {
        cam.position.set(ttx + offX, tty + offY, offZ);
        cam.up.set(0, 0, 1);
        cam.lookAt(ttx, tty, 0);
        cam.updateMatrixWorld();
        return projPt(cam, fieldPt.x, fieldPt.y);
      }

      for (let i = 0; i < 5; i++) {
        const p = proj(tx, ty);
        const ex = screenPt.nx - p.nx, ey = screenPt.ny - p.ny;
        if (Math.abs(ex) < 0.0005 && Math.abs(ey) < 0.0005) break;
        const eps = 0.01;
        const px = proj(tx + eps, ty), py = proj(tx, ty + eps);
        const j00 = (px.nx - p.nx) / eps, j01 = (py.nx - p.nx) / eps;
        const j10 = (px.ny - p.ny) / eps, j11 = (py.ny - p.ny) / eps;
        const det = j00 * j11 - j01 * j10;
        if (Math.abs(det) < 1e-12) break;
        tx += (j11 * ex - j01 * ey) / det;
        ty += (-j10 * ex + j00 * ey) / det;
      }
      return { targetX: tx, targetY: ty };
    }

    /**
     * Newton solve for 2 anchors: find (az, el, tx, ty) so both field
     * points project to their saved screen positions, given fixed distance.
     * The drag provides an initial delta to az/el; we refine all 4 params.
     */
    function solve2Anchors(
      initAz: number, initEl: number, dist: number,
      f0: { x: number; y: number }, s0: { nx: number; ny: number },
      f1: { x: number; y: number }, s1: { nx: number; ny: number },
      cam: THREE.PerspectiveCamera,
    ): { azimuth: number; elevation: number; targetX: number; targetY: number } {
      let az = initAz, el = initEl;
      let tx = (f0.x + f1.x) / 2, ty = (f0.y + f1.y) / 2;

      // Start with target from 1-anchor solve on f0
      const s1a = solveTarget(az, el, dist, f0, s0, cam);
      tx = s1a.targetX; ty = s1a.targetY;

      // Refine: 4 unknowns (az, el, tx, ty), 4 equations (2 anchors × 2 coords)
      for (let i = 0; i < 5; i++) {
        applyCam(cam, { azimuth: az, elevation: el, distance: dist, targetX: tx, targetY: ty });
        const p0 = projPt(cam, f0.x, f0.y);
        const p1 = projPt(cam, f1.x, f1.y);
        const err = [s0.nx - p0.nx, s0.ny - p0.ny, s1.nx - p1.nx, s1.ny - p1.ny];
        if (err.every((e) => Math.abs(e) < 0.001)) break;

        // Numerical Jacobian (4×4)
        const eps = [0.001, 0.001, 0.01, 0.01]; // az, el, tx, ty
        const params = [az, el, tx, ty];
        const J: number[][] = [];
        for (let j = 0; j < 4; j++) {
          const p2 = [...params]; p2[j] += eps[j]!;
          applyCam(cam, { azimuth: p2[0]!, elevation: p2[1]!, distance: dist, targetX: p2[2]!, targetY: p2[3]! });
          const q0 = projPt(cam, f0.x, f0.y);
          const q1 = projPt(cam, f1.x, f1.y);
          J.push([
            (q0.nx - p0.nx) / eps[j]!, (q0.ny - p0.ny) / eps[j]!,
            (q1.nx - p1.nx) / eps[j]!, (q1.ny - p1.ny) / eps[j]!,
          ]);
        }

        // Solve J^T * delta = err (use J^T since J is 4 cols × 4 rows packed weirdly)
        // Actually J[j] = column j of the Jacobian. Transpose to get rows.
        const JT = J.map((col, j) => col); // J[j][i] = d(err_i)/d(param_j)
        // Solve 4x4: JT * dp = err
        const dp = solve4x4(
          JT.map((col) => [...col]),
          [...err],
        );
        if (!dp) break;

        az += dp[0]!;
        el = Math.max(0.05, Math.min(1.4, el + dp[1]!));
        tx += dp[2]!;
        ty += dp[3]!;
      }

      return { azimuth: az, elevation: el, targetX: tx, targetY: ty };
    }

    // ── Update camera ─────────────────────────────────────────────────
    const updateCamera = useCallback(() => {
      const cam = cameraRef.current;
      if (!cam) return;
      applyCam(cam, orbit);
    }, [orbit]);

    useEffect(() => { updateCamera(); }, [updateCamera]);

    // ── Project handles ───────────────────────────────────────────────
    const projectedHandles = useMemo(() => {
      const cam = cameraRef.current;
      if (!cam || handles.length === 0) return {} as Record<string, { nx: number; ny: number }>;
      cam.updateMatrixWorld();
      cam.updateProjectionMatrix();
      const result: Record<string, { nx: number; ny: number }> = {};
      for (const h of handles) {
        const v = new THREE.Vector3(h.position.x, h.position.y, h.position.z);
        v.project(cam);
        result[h.id] = { nx: (v.x + 1) / 2, ny: (1 - v.y) / 2 };
      }
      return result;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [handles, orbit, projTick]);

    const homography = useMemo((): HomographyFit | null => {
      const ids = Object.keys(projectedHandles);
      if (ids.length < 4) return null;
      const corr: Correspondence[] = ids.map((id) => ({
        field: fieldById[id]!,
        image: { u: projectedHandles[id]!.nx * imageWidth, v: projectedHandles[id]!.ny * imageHeight },
      }));
      return fitHomography(corr);
    }, [projectedHandles, fieldById, imageWidth, imageHeight]);

    const imageToScreen = useCallback(
      (nx: number, ny: number) => {
        const cx = canvas.width / 2, cy = canvas.height / 2;
        return {
          x: (nx * canvas.width - cx) * vp.scale + cx + vp.tx,
          y: (ny * canvas.height - cy) * vp.scale + cy + vp.ty,
        };
      },
      [canvas, vp],
    );

    const screenHandles = useMemo(() => {
      const result: Record<string, { x: number; y: number }> = {};
      for (const h of handles) {
        const pos = projectedHandles[h.id];
        if (!pos) continue;
        result[h.id] = imageToScreen(pos.nx, pos.ny);
      }
      return result;
    }, [handles, projectedHandles, imageToScreen]);

    const screenHandlesRef = useRef(screenHandles);
    screenHandlesRef.current = screenHandles;

    // ── Touch: drag only (no pinch zoom) ──────────────────────────────
    const lastTouchRef = useRef<{ x: number; y: number } | null>(null);
    const didMoveRef = useRef(false);
    const grantPosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

    const responder = useMemo(
      () =>
        PanResponder.create({
          onStartShouldSetPanResponder: () => true,
          onMoveShouldSetPanResponder: () => true,
          onPanResponderTerminationRequest: () => false,
          onPanResponderGrant: (_, gs) => {
            lastTouchRef.current = null;
            didMoveRef.current = false;
            grantPosRef.current = { x: gs.x0, y: gs.y0 };
          },
          onPanResponderMove: (e) => {
            const touches = e.nativeEvent.touches;
            if (touches.length !== 1) return; // only single-finger drag
            const t = touches[0]!;
            const cur = { x: t.pageX, y: t.pageY };
            if (Math.hypot(cur.x - grantPosRef.current.x, cur.y - grantPosRef.current.y) > 5)
              didMoveRef.current = true;

            const cam = cameraRef.current;
            if (!cam || !lastTouchRef.current) { lastTouchRef.current = cur; return; }

            const dx = cur.x - lastTouchRef.current.x;
            const dy = cur.y - lastTouchRef.current.y;
            lastTouchRef.current = cur;

            const anch = anchorsRef.current;
            const fbi = fieldByIdRef.current;

            if (anch.length === 0) {
              // ── 0 anchors: free orbit ──
              setOrbit((prev) => ({
                ...prev,
                azimuth: prev.azimuth - dx * 0.005,
                elevation: Math.max(0.05, Math.min(1.4, prev.elevation + dy * 0.005)),
              }));
            } else if (anch.length === 1) {
              // ── 1 anchor: rotate, pin anchor ──
              const a = anch[0]!;
              const f = fbi[a.id];
              if (!f) return;
              setOrbit((prev) => {
                const newAz = prev.azimuth - dx * 0.005;
                const newEl = Math.max(0.05, Math.min(1.4, prev.elevation + dy * 0.005));
                const solved = solveTarget(newAz, newEl, prev.distance, f, a, cam);
                return { azimuth: newAz, elevation: newEl, distance: prev.distance, ...solved };
              });
            } else if (anch.length >= 2) {
              // ── 2+ anchors: rotate around axis, pin both ──
              const a0 = anch[0]!, a1 = anch[1]!;
              const f0 = fbi[a0.id], f1 = fbi[a1.id];
              if (!f0 || !f1) return;
              const s0 = screenHandlesRef.current[a0.id];
              const s1 = screenHandlesRef.current[a1.id];
              if (!s0 || !s1) return;
              const axisX = s1.x - s0.x, axisY = s1.y - s0.y;
              const axisLen = Math.hypot(axisX, axisY);
              if (axisLen < 1) return;
              const perpComponent = (-dx * axisY + dy * axisX) / axisLen;
              const fAxisAngle = Math.atan2(f1.y - f0.y, f1.x - f0.x);

              setOrbit((prev) => {
                const dAz = Math.cos(fAxisAngle - prev.azimuth) * perpComponent * 0.003;
                const dEl = Math.sin(fAxisAngle - prev.azimuth) * perpComponent * 0.003;
                const initAz = prev.azimuth + dAz;
                const initEl = Math.max(0.05, Math.min(1.4, prev.elevation + dEl));
                const solved = solve2Anchors(initAz, initEl, prev.distance, f0, a0, f1, a1, cam);
                return { distance: prev.distance, ...solved };
              });
            }
          },
          onPanResponderRelease: (_, gs) => {
            if (!didMoveRef.current) {
              // Tap: toggle anchor
              const lx = gs.x0 - canvasPageOffset.x;
              const ly = gs.y0 - canvasPageOffset.y;
              const sh = screenHandlesRef.current;
              const proj = projectedHandles;

              let nearId = "";
              let nearDist = 30;
              for (const h of handles) {
                const s = sh[h.id];
                if (!s) continue;
                const d = Math.hypot(lx - s.x, ly - s.y);
                if (d < nearDist) { nearDist = d; nearId = h.id; }
              }

              if (nearId) {
                setAnchors((prev) => {
                  if (prev.some((a) => a.id === nearId)) return prev.filter((a) => a.id !== nearId);
                  if (prev.length >= 3) return prev;
                  const p = proj[nearId];
                  if (!p) return prev;
                  return [...prev, { id: nearId, nx: p.nx, ny: p.ny }];
                });
              }
            }
            lastTouchRef.current = null;
            setProjTick((t) => t + 1);
          },
        }),
      [canvasPageOffset, handles, projectedHandles],
    );

    // ── Zoom handler (from slider) ────────────────────────────────────
    const handleZoom = useCallback((delta: number) => {
      const cam = cameraRef.current;
      if (!cam) return;
      const anch = anchorsRef.current;
      const fbi = fieldByIdRef.current;

      setOrbit((prev) => {
        const newDist = Math.max(5, Math.min(100, prev.distance + delta));
        if (anch.length === 1) {
          const a = anch[0]!;
          const f = fbi[a.id];
          if (f) {
            const solved = solveTarget(prev.azimuth, prev.elevation, newDist, f, a, cam);
            return { ...prev, distance: newDist, ...solved };
          }
        } else if (anch.length >= 2) {
          const a0 = anch[0]!, a1 = anch[1]!;
          const f0 = fbi[a0.id], f1 = fbi[a1.id];
          if (f0 && f1) {
            const solved = solve2Anchors(prev.azimuth, prev.elevation, newDist, f0, a0, f1, a1, cam);
            return { distance: newDist, ...solved };
          }
        }
        return { ...prev, distance: newDist };
      });
    }, []);

    const modeLabel = useMemo(() => {
      if (anchors.length === 0) return "drag to orbit · tap to anchor";
      if (anchors.length === 1) return `${anchors[0]!.id} pinned`;
      if (anchors.length === 2) return "2 pinned · drag to tilt";
      return "calibrated";
    }, [anchors]);

    // ── Imperative handle ─────────────────────────────────────────────
    useImperativeHandle(ref, () => ({
      solve: (): CameraPose | null => homography ? { fit: homography, sides: ["left", "right"] } : null,
      reset: () => { setOrbit({ azimuth: 0, elevation: 0.25, distance: 25, targetX: 0, targetY: 8 }); setAnchors([]); },
      anchoredCount: () => anchors.length,
      getState: () => ({ positions: projectedHandles, anchored: Object.fromEntries(anchors.map((a) => [a.id, true])) }),
      setState: () => {},
    }), [homography, projectedHandles, anchors]);

    // ── GL setup ──────────────────────────────────────────────────────
    const onContextCreate = useCallback(async (gl: ExpoWebGLRenderingContext) => {
      const renderer = new Renderer({ gl }) as unknown as THREE.WebGLRenderer;
      renderer.setSize(gl.drawingBufferWidth, gl.drawingBufferHeight);
      renderer.setClearColor(0x000000, 0);
      rendererRef.current = renderer;

      const scene = new THREE.Scene();
      sceneRef.current = scene;

      const camera = new THREE.PerspectiveCamera(50, gl.drawingBufferWidth / gl.drawingBufferHeight, 0.1, 500);
      camera.up.set(0, 0, 1);
      camera.position.set(0, -25, 7);
      camera.lookAt(0, 8, 0);
      cameraRef.current = camera;

      scene.add(new THREE.AmbientLight(0xffffff, 0.6));
      const dl = new THREE.DirectionalLight(0xffffff, 0.8);
      dl.position.set(5, -5, 10);
      scene.add(dl);

      let lh: HandlePoint[] = [];
      try {
        const model = await loadFieldModel(require("../../assets/models/field.glb"));
        modelRef.current = model;
        model.scene.traverse((node: any) => {
          if (node.isMesh && node.material) {
            for (const mat of (Array.isArray(node.material) ? node.material : [node.material])) {
              mat.transparent = true; mat.opacity = 0.35; mat.depthWrite = false;
            }
          }
        });
        scene.add(model.scene);
        lh = model.handles;
        setLoadStatus(`${lh.length} handles`);
      } catch (e) {
        setLoadStatus(`GLB failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 60)}`);
      }
      if (lh.length === 0) { lh = buildFallbackHandles(); setLoadStatus(`fallback (${lh.length})`); }
      setHandles(lh);
      setProjTick(1);

      const render = () => {
        rafRef.current = requestAnimationFrame(render);
        if (rendererRef.current && sceneRef.current && cameraRef.current) {
          rendererRef.current.render(sceneRef.current, cameraRef.current);
          gl.endFrameEXP();
        }
      };
      render();
    }, []);

    useEffect(() => () => { cancelAnimationFrame(rafRef.current); rendererRef.current?.dispose(); }, []);

    const anchorSet = useMemo(() => new Set(anchors.map((a) => a.id)), [anchors]);

    // ── Render ────────────────────────────────────────────────────────
    return (
      <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
        <GLView style={{ width: canvas.width, height: canvas.height }} onContextCreate={onContextCreate} pointerEvents="none" />

          {handles.map((h) => {
            const s = screenHandles[h.id]; if (!s) return null;
            const isA = anchorSet.has(h.id);
            return (
              <View key={h.id} pointerEvents="none" style={{
                position: "absolute", left: s.x - HANDLE_R, top: s.y - HANDLE_R,
                width: HANDLE_R * 2, height: HANDLE_R * 2, borderRadius: HANDLE_R,
                borderWidth: isA ? 2.5 : 1.5,
                borderColor: isA ? ANCHOR_COLOR : FREE_COLOR,
                backgroundColor: isA ? "rgba(0,255,100,0.25)" : "rgba(0,200,255,0.15)",
              }} />
            );
          })}

          {handles.map((h) => {
            const s = screenHandles[h.id]; if (!s) return null;
            const isA = anchorSet.has(h.id);
            return (
              <Text key={`l-${h.id}`} pointerEvents="none" style={{
                position: "absolute", left: s.x - 30, top: s.y - HANDLE_R - 12,
                width: 60, textAlign: "center", color: isA ? ANCHOR_COLOR : FREE_COLOR,
                fontSize: 7, fontWeight: "600",
              }}>{h.id}</Text>
            );
          })}

          <Text pointerEvents="none" style={{
            position: "absolute", left: 10, top: 8,
            color: "rgba(0,200,255,0.9)", fontSize: 11, fontWeight: "600",
          }}>{anchors.length}/3 · {modeLabel}</Text>

          <Pressable
            onPress={() => setControlMode((m) => m === "model" ? "video" : "model")}
            style={{
              position: "absolute", right: 10, top: 6,
              paddingHorizontal: 10, paddingVertical: 4, borderRadius: 10,
              backgroundColor: controlMode === "model" ? "rgba(0,200,255,0.7)" : "rgba(255,160,0,0.7)",
            }}
          >
            <Text style={{ color: "#fff", fontSize: 11, fontWeight: "700" }}>
              {controlMode === "model" ? "Model" : "Video"}
            </Text>
          </Pressable>

          {controlMode === "model" && (
            <View {...responder.panHandlers} style={StyleSheet.absoluteFill} />
          )}

        {/* Zoom controls — top left under status */}
        <View style={{
          position: "absolute", top: 24, left: 10,
          flexDirection: "row", alignItems: "center", gap: 4,
        }}>
          <Pressable onPress={() => handleZoom(3)} style={zoomBtn}>
            <Text style={zoomBtnText}>−</Text>
          </Pressable>
          <Pressable onPress={() => handleZoom(-3)} style={zoomBtn}>
            <Text style={zoomBtnText}>+</Text>
          </Pressable>
          <Text style={{ color: "rgba(255,255,255,0.4)", fontSize: 10, marginLeft: 4 }}>
            {orbit.distance.toFixed(0)}m
          </Text>
        </View>
      </View>
    );
  },
);

// ── Styles ──────────────────────────────────────────────────────────────

const zoomBtn = {
  width: 32, height: 32, borderRadius: 16,
  backgroundColor: "rgba(255,255,255,0.12)",
  alignItems: "center" as const, justifyContent: "center" as const,
};
const zoomBtnText = { color: "#fff", fontSize: 18, fontWeight: "600" as const };

// ── 4x4 linear solve (Gaussian elimination) ─────────────────────────────

function solve4x4(A: number[][], b: number[]): number[] | null {
  const n = 4;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let maxRow = col, maxVal = Math.abs(M[col]![col]!);
    for (let row = col + 1; row < n; row++) {
      const v = Math.abs(M[row]![col]!);
      if (v > maxVal) { maxVal = v; maxRow = row; }
    }
    if (maxVal < 1e-12) return null;
    [M[col], M[maxRow]] = [M[maxRow]!, M[col]!];
    const pivot = M[col]![col]!;
    for (let j = col; j <= n; j++) M[col]![j]! /= pivot;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const f = M[row]![col]!;
      for (let j = col; j <= n; j++) M[row]![j]! -= f * M[col]![j]!;
    }
  }
  return M.map((row) => row[n]!);
}

// ── Fallback handles ────────────────────────────────────────────────────

function buildFallbackHandles(): HandlePoint[] {
  const h = (id: string, x: number, y: number, z: number = 0) => ({
    id, position: new THREE.Vector3(x, y, z),
  });
  return [
    h("plate_apex", 0, 0),
    h("1B", 18.288, 0),
    h("2B", 18.288, 18.288),
    h("3B", 0, 18.288),
    h("right_BB_front_right", 1.922, -0.323),
    h("right_BB_front_left", 1.060, 0.539),
    h("right_BB_back_right", 0.629, -1.616),
    h("right_BB_back_left", -0.233, -0.754),
    h("left_BB_front_right", 0.539, 1.060),
    h("left_BB_front_left", -0.323, 1.922),
    h("left_BB_back_right", -0.754, -0.234),
    h("left_BB_back_left", -1.616, 0.628),
  ];
}
