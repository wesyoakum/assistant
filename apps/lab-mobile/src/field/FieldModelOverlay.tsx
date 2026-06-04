// 3D field model overlay — progressive calibration.
//
// Workflow:
//   0 anchors → free orbit (rotate + zoom + pan)
//   Tap handle → anchor it at its current screen position
//   1 anchor  → drag rotates + zooms, anchor stays pinned on screen
//   2 anchors → drag rotates around anchor–anchor axis, both stay pinned
//   3 anchors → fully constrained, done
//
// Model/Video toggle lets you switch which layer gestures control.

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

interface Anchor {
  id: string;
  /** Screen position (normalized 0-1) where this handle was pinned. */
  nx: number;
  ny: number;
}

// ── Component ───────────────────────────────────────────────────────────

export const FieldModelOverlay = forwardRef<FieldModelOverlayHandle, FieldModelOverlayProps>(
  function FieldModelOverlay(
    { imageWidth, imageHeight, vp, canvas, canvasPageOffset },
    ref,
  ) {
    // ── GL refs ───────────────────────────────────────────────────────
    const sceneRef = useRef<THREE.Scene | null>(null);
    const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
    const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
    const modelRef = useRef<FieldModel | null>(null);
    const rafRef = useRef<number>(0);

    // ── Model handles ─────────────────────────────────────────────────
    const [handles, setHandles] = useState<HandlePoint[]>([]);
    const [loadStatus, setLoadStatus] = useState<string>("loading…");

    // ── Anchored handles ──────────────────────────────────────────────
    const [anchors, setAnchors] = useState<Anchor[]>([]);
    const anchorsRef = useRef(anchors);
    anchorsRef.current = anchors;

    // ── Control mode ──────────────────────────────────────────────────
    const [controlMode, setControlMode] = useState<"model" | "video">("model");

    // ── Orbit camera state ────────────────────────────────────────────
    const [orbit, setOrbit] = useState({
      azimuth: 0,
      elevation: 0.25,
      distance: 25,
      targetX: 0,
      targetY: 8,
    });
    const orbitRef = useRef(orbit);
    orbitRef.current = orbit;

    const [projTick, setProjTick] = useState(0);

    // ── Field coord lookup ────────────────────────────────────────────
    const fieldById = useMemo(() => {
      const m: Record<string, { x: number; y: number }> = {};
      for (const h of handles) m[h.id] = { x: h.position.x, y: h.position.y };
      return m;
    }, [handles]);
    const fieldByIdRef = useRef(fieldById);
    fieldByIdRef.current = fieldById;

    // ── Camera helpers ────────────────────────────────────────────────

    /** Compute camera world position from orbit params. */
    function camPosFromOrbit(o: typeof orbit) {
      const cosE = Math.cos(o.elevation);
      return {
        x: o.targetX + o.distance * cosE * Math.sin(o.azimuth),
        y: o.targetY - o.distance * cosE * Math.cos(o.azimuth),
        z: o.distance * Math.sin(o.elevation),
      };
    }

    /** Project a field point through the camera. Returns normalized (0-1). */
    function projectPoint(cam: THREE.PerspectiveCamera, fx: number, fy: number): { nx: number; ny: number } {
      cam.updateMatrixWorld();
      const v = new THREE.Vector3(fx, fy, 0).project(cam);
      return { nx: (v.x + 1) / 2, ny: (1 - v.y) / 2 };
    }

    /** Apply orbit state to the Three.js camera. */
    function applyCameraOrbit(cam: THREE.PerspectiveCamera, o: typeof orbit) {
      const p = camPosFromOrbit(o);
      cam.position.set(p.x, p.y, p.z);
      cam.up.set(0, 0, 1);
      cam.lookAt(o.targetX, o.targetY, 0);
      cam.updateMatrixWorld();
      cam.updateProjectionMatrix();
    }

    /**
     * Solve for targetX/targetY so that a field point projects to a
     * specific screen position, given fixed azimuth/elevation/distance.
     * Uses Newton iteration (2-3 steps converge).
     */
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
        const v = new THREE.Vector3(fieldPt.x, fieldPt.y, 0).project(cam);
        return { nx: (v.x + 1) / 2, ny: (1 - v.y) / 2 };
      }

      for (let i = 0; i < 5; i++) {
        const p = proj(tx, ty);
        const ex = screenPt.nx - p.nx;
        const ey = screenPt.ny - p.ny;
        if (Math.abs(ex) < 0.0005 && Math.abs(ey) < 0.0005) break;

        const eps = 0.01;
        const px = proj(tx + eps, ty);
        const py = proj(tx, ty + eps);
        const j00 = (px.nx - p.nx) / eps, j01 = (py.nx - p.nx) / eps;
        const j10 = (px.ny - p.ny) / eps, j11 = (py.ny - p.ny) / eps;
        const det = j00 * j11 - j01 * j10;
        if (Math.abs(det) < 1e-12) break;
        tx += (j11 * ex - j01 * ey) / det;
        ty += (-j10 * ex + j00 * ey) / det;
      }

      return { targetX: tx, targetY: ty };
    }

    // ── Update camera from orbit state ────────────────────────────────
    const updateCamera = useCallback(() => {
      const cam = cameraRef.current;
      if (!cam) return;
      applyCameraOrbit(cam, orbit);
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

    // ── Homography ────────────────────────────────────────────────────
    const homography = useMemo((): HomographyFit | null => {
      const ids = Object.keys(projectedHandles);
      if (ids.length < 4) return null;
      const corr: Correspondence[] = ids.map((id) => ({
        field: fieldById[id]!,
        image: { u: projectedHandles[id]!.nx * imageWidth, v: projectedHandles[id]!.ny * imageHeight },
      }));
      return fitHomography(corr);
    }, [projectedHandles, fieldById, imageWidth, imageHeight]);

    // ── Screen positions ──────────────────────────────────────────────
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

    // ── Touch handling ────────────────────────────────────────────────
    const lastTouchRef = useRef<{ x: number; y: number } | null>(null);
    const lastPinchRef = useRef<number | null>(null);
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
            lastPinchRef.current = null;
            didMoveRef.current = false;
            grantPosRef.current = { x: gs.x0, y: gs.y0 };
          },
          onPanResponderMove: (e) => {
            const touches = e.nativeEvent.touches;
            if (Math.hypot(
              touches[0]!.pageX - grantPosRef.current.x,
              touches[0]!.pageY - grantPosRef.current.y,
            ) > 5) didMoveRef.current = true;

            const cam = cameraRef.current;
            if (!cam) return;
            const anch = anchorsRef.current;
            const fbi = fieldByIdRef.current;

            if (touches.length === 2) {
              // ── Pinch: zoom (all modes) ──
              const t0 = touches[0]!, t1 = touches[1]!;
              const dist = Math.hypot(t0.pageX - t1.pageX, t0.pageY - t1.pageY);
              if (lastPinchRef.current !== null) {
                const pinchDelta = dist - lastPinchRef.current;
                setOrbit((prev) => {
                  const next = {
                    ...prev,
                    distance: Math.max(5, Math.min(100, prev.distance - pinchDelta * 0.1)),
                  };
                  // If 1 anchor, solve target to keep it pinned after zoom
                  if (anch.length === 1) {
                    const a = anch[0]!;
                    const f = fbi[a.id];
                    if (f) {
                      const solved = solveTarget(next.azimuth, next.elevation, next.distance, f, a, cam);
                      next.targetX = solved.targetX;
                      next.targetY = solved.targetY;
                    }
                  }
                  return next;
                });
              }
              lastPinchRef.current = dist;
              lastTouchRef.current = null;
            } else if (touches.length === 1) {
              const t = touches[0]!;
              const cur = { x: t.pageX, y: t.pageY };

              if (lastTouchRef.current) {
                const dx = cur.x - lastTouchRef.current.x;
                const dy = cur.y - lastTouchRef.current.y;

                if (anch.length === 0) {
                  // ── 0 anchors: free orbit ──
                  setOrbit((prev) => ({
                    ...prev,
                    azimuth: prev.azimuth - dx * 0.005,
                    elevation: Math.max(0.05, Math.min(1.4, prev.elevation + dy * 0.005)),
                  }));
                } else if (anch.length === 1) {
                  // ── 1 anchor: rotate + solve target to keep anchor pinned ──
                  setOrbit((prev) => {
                    const newAz = prev.azimuth - dx * 0.005;
                    const newEl = Math.max(0.05, Math.min(1.4, prev.elevation + dy * 0.005));
                    const a = anch[0]!;
                    const f = fbi[a.id];
                    if (!f) return { ...prev, azimuth: newAz, elevation: newEl };
                    const solved = solveTarget(newAz, newEl, prev.distance, f, a, cam);
                    return {
                      azimuth: newAz,
                      elevation: newEl,
                      distance: prev.distance,
                      targetX: solved.targetX,
                      targetY: solved.targetY,
                    };
                  });
                } else if (anch.length >= 2) {
                  // ── 2+ anchors: rotate around the axis between first two anchors ──
                  const a0 = anch[0]!, a1 = anch[1]!;
                  const f0 = fbi[a0.id], f1 = fbi[a1.id];
                  if (f0 && f1) {
                    // Axis direction on screen
                    const s0 = screenHandlesRef.current[a0.id];
                    const s1 = screenHandlesRef.current[a1.id];
                    if (s0 && s1) {
                      const axisX = s1.x - s0.x, axisY = s1.y - s0.y;
                      const axisLen = Math.hypot(axisX, axisY);
                      if (axisLen > 1) {
                        const perpComponent = (-dx * axisY + dy * axisX) / axisLen;
                        const fAxisAngle = Math.atan2(f1.y - f0.y, f1.x - f0.x);

                        setOrbit((prev) => {
                          const newAz = prev.azimuth + Math.cos(fAxisAngle - prev.azimuth) * perpComponent * 0.003;
                          const newEl = Math.max(0.05, Math.min(1.4,
                            prev.elevation + Math.sin(fAxisAngle - prev.azimuth) * perpComponent * 0.003));
                          // Solve target to keep first anchor pinned
                          const solved = solveTarget(newAz, newEl, prev.distance, f0, a0, cam);
                          return {
                            azimuth: newAz,
                            elevation: newEl,
                            distance: prev.distance,
                            targetX: solved.targetX,
                            targetY: solved.targetY,
                          };
                        });
                      }
                    }
                  }
                }
              }
              lastTouchRef.current = cur;
            }
          },
          onPanResponderRelease: (_, gs) => {
            // ── Tap: toggle anchor ──
            if (!didMoveRef.current) {
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
                  if (prev.some((a) => a.id === nearId)) {
                    // Deanchor
                    return prev.filter((a) => a.id !== nearId);
                  }
                  if (prev.length >= 3) return prev; // fully constrained
                  // Anchor at current projected screen position
                  const p = proj[nearId];
                  if (!p) return prev;
                  return [...prev, { id: nearId, nx: p.nx, ny: p.ny }];
                });
              }
            }

            lastTouchRef.current = null;
            lastPinchRef.current = null;
            setProjTick((t) => t + 1);
          },
        }),
      [canvasPageOffset, handles, projectedHandles],
    );

    // ── Mode label ────────────────────────────────────────────────────
    const modeLabel = useMemo(() => {
      if (anchors.length === 0) return "drag to orbit · tap handle to anchor";
      if (anchors.length === 1) return `${anchors[0]!.id} pinned · drag to rotate`;
      if (anchors.length === 2) return `2 pinned · drag to tilt`;
      return "3 pinned · calibrated";
    }, [anchors]);

    // ── Imperative handle ─────────────────────────────────────────────
    useImperativeHandle(
      ref,
      () => ({
        solve: (): CameraPose | null =>
          homography ? { fit: homography, sides: ["left", "right"] } : null,
        reset: () => {
          setOrbit({ azimuth: 0, elevation: 0.25, distance: 25, targetX: 0, targetY: 8 });
          setAnchors([]);
        },
        anchoredCount: () => anchors.length,
        getState: () => ({
          positions: projectedHandles,
          anchored: Object.fromEntries(anchors.map((a) => [a.id, true])),
        }),
        setState: () => {},
      }),
      [homography, projectedHandles, anchors],
    );

    // ── GL context setup ──────────────────────────────────────────────
    const onContextCreate = useCallback(
      async (gl: ExpoWebGLRenderingContext) => {
        const renderer = new Renderer({ gl }) as unknown as THREE.WebGLRenderer;
        renderer.setSize(gl.drawingBufferWidth, gl.drawingBufferHeight);
        renderer.setClearColor(0x000000, 0);
        rendererRef.current = renderer;

        const scene = new THREE.Scene();
        sceneRef.current = scene;

        const camera = new THREE.PerspectiveCamera(
          50, gl.drawingBufferWidth / gl.drawingBufferHeight, 0.1, 500,
        );
        camera.up.set(0, 0, 1);
        camera.position.set(0, -25, 7);
        camera.lookAt(0, 8, 0);
        cameraRef.current = camera;

        scene.add(new THREE.AmbientLight(0xffffff, 0.6));
        const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
        dirLight.position.set(5, -5, 10);
        scene.add(dirLight);

        let loadedHandles: HandlePoint[] = [];
        try {
          const model = await loadFieldModel(require("../../assets/models/field.glb"));
          modelRef.current = model;
          model.scene.traverse((node: any) => {
            if (node.isMesh && node.material) {
              const mats = Array.isArray(node.material) ? node.material : [node.material];
              for (const mat of mats) {
                mat.transparent = true;
                mat.opacity = 0.35;
                mat.depthWrite = false;
              }
            }
          });
          scene.add(model.scene);
          loadedHandles = model.handles;
          setLoadStatus(`${model.handles.length} handles`);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          setLoadStatus(`GLB failed: ${msg.slice(0, 60)}`);
        }

        if (loadedHandles.length === 0) {
          loadedHandles = buildFallbackHandles();
          setLoadStatus(`fallback (${loadedHandles.length} handles)`);
        }

        setHandles(loadedHandles);
        setProjTick(1);

        const render = () => {
          rafRef.current = requestAnimationFrame(render);
          if (rendererRef.current && sceneRef.current && cameraRef.current) {
            rendererRef.current.render(sceneRef.current, cameraRef.current);
            gl.endFrameEXP();
          }
        };
        render();
      },
      [],
    );

    useEffect(() => () => {
      cancelAnimationFrame(rafRef.current);
      rendererRef.current?.dispose();
    }, []);

    // ── Anchor set for quick lookup ───────────────────────────────────
    const anchorSet = useMemo(() => new Set(anchors.map((a) => a.id)), [anchors]);

    // ── Render ────────────────────────────────────────────────────────
    return (
      <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
        <GLView
          style={{ width: canvas.width, height: canvas.height }}
          onContextCreate={onContextCreate}
          pointerEvents="none"
        />

        {/* Handle dots */}
        {handles.map((h) => {
          const s = screenHandles[h.id];
          if (!s) return null;
          const isAnch = anchorSet.has(h.id);
          return (
            <View key={h.id} pointerEvents="none" style={{
              position: "absolute", left: s.x - HANDLE_R, top: s.y - HANDLE_R,
              width: HANDLE_R * 2, height: HANDLE_R * 2, borderRadius: HANDLE_R,
              borderWidth: isAnch ? 2.5 : 1.5,
              borderColor: isAnch ? ANCHOR_COLOR : FREE_COLOR,
              backgroundColor: isAnch ? "rgba(0,255,100,0.25)" : "rgba(0,200,255,0.15)",
            }} />
          );
        })}

        {/* Handle labels */}
        {handles.map((h) => {
          const s = screenHandles[h.id];
          if (!s) return null;
          const isAnch = anchorSet.has(h.id);
          return (
            <Text key={`lbl-${h.id}`} pointerEvents="none" style={{
              position: "absolute", left: s.x - 30, top: s.y - HANDLE_R - 12,
              width: 60, textAlign: "center",
              color: isAnch ? ANCHOR_COLOR : FREE_COLOR,
              fontSize: 7, fontWeight: "600",
            }}>{h.id}</Text>
          );
        })}

        {/* Status */}
        <Text pointerEvents="none" style={{
          position: "absolute", left: 10, top: 8,
          color: "rgba(0,200,255,0.9)", fontSize: 11, fontWeight: "600",
        }}>
          {anchors.length}/3 · {modeLabel}
        </Text>

        {/* Toggle: Model / Video */}
        <Pressable
          onPress={() => setControlMode((m) => m === "model" ? "video" : "model")}
          style={{
            position: "absolute", right: 10, top: 6,
            paddingHorizontal: 10, paddingVertical: 4,
            borderRadius: 10,
            backgroundColor: controlMode === "model" ? "rgba(0,200,255,0.7)" : "rgba(255,160,0,0.7)",
          }}
        >
          <Text style={{ color: "#fff", fontSize: 11, fontWeight: "700" }}>
            {controlMode === "model" ? "Model" : "Video"}
          </Text>
        </Pressable>

        {/* Touch surface — only active in model mode */}
        {controlMode === "model" && (
          <View {...responder.panHandlers} style={StyleSheet.absoluteFill} />
        )}
      </View>
    );
  },
);

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
