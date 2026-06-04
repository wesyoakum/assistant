// 3D field model overlay — move the model to match the video.
//
// The user directly manipulates the 3D camera to align the model with
// the video. Handle positions are projected from the model's empties.
//
// Progressive constraint via selected handles:
//   0 selected → free orbit around field center
//   1 selected → orbit around that handle's field position
//   2 selected → rotate around the axis between them (1 DOF)
//   3 selected → locked orientation; drag to translate, pinch to scale
//
// Tap a handle to select/deselect it. Pinch always zooms.
// "Direct manipulation" feel: drag moves the model, not the camera.

import React, {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  forwardRef,
} from "react";
import { StyleSheet, View, PanResponder, Text } from "react-native";
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
const SELECTED_COLOR = "rgba(255,120,255,0.95)";
const HANDLE_R = 6;

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

    // ── Selected handles (up to 3) ────────────────────────────────────
    const [selected, setSelected] = useState<string[]>([]);

    // ── Orbit camera state ────────────────────────────────────────────
    const [orbit, setOrbit] = useState({
      azimuth: 0,
      elevation: 0.25,
      distance: 25,
      targetX: 0,
      targetY: 8,
    });

    const [projTick, setProjTick] = useState(0);

    // ── Field coord lookup ────────────────────────────────────────────
    const fieldById = useMemo(() => {
      const m: Record<string, { x: number; y: number }> = {};
      for (const h of handles) m[h.id] = { x: h.position.x, y: h.position.y };
      return m;
    }, [handles]);

    // ── Compute camera position from orbit state ──────────────────────
    const updateCamera = useCallback(() => {
      const cam = cameraRef.current;
      if (!cam) return;
      const { azimuth, elevation, distance, targetX, targetY } = orbit;
      const cosE = Math.cos(elevation);
      cam.position.set(
        targetX + distance * cosE * Math.sin(azimuth),
        targetY - distance * cosE * Math.cos(azimuth),
        distance * Math.sin(elevation),
      );
      cam.up.set(0, 0, 1);
      cam.lookAt(targetX, targetY, 0);
      cam.updateProjectionMatrix();
    }, [orbit]);

    useEffect(() => { updateCamera(); }, [updateCamera]);

    // ── Project model handles through Three.js camera → screen ────────
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

    // ── Homography from projected positions ───────────────────────────
    const homography = useMemo((): HomographyFit | null => {
      const ids = Object.keys(projectedHandles);
      if (ids.length < 4) return null;
      const corr: Correspondence[] = ids.map((id) => ({
        field: fieldById[id]!,
        image: {
          u: projectedHandles[id]!.nx * imageWidth,
          v: projectedHandles[id]!.ny * imageHeight,
        },
      }));
      return fitHomography(corr);
    }, [projectedHandles, fieldById, imageWidth, imageHeight]);

    // ── Coordinate transforms ─────────────────────────────────────────
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
    const lastPanRef = useRef<{ x: number; y: number } | null>(null);
    const didMoveRef = useRef(false);
    const grantPosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
    const selectedRef = useRef(selected);
    selectedRef.current = selected;

    const responder = useMemo(
      () =>
        PanResponder.create({
          onStartShouldSetPanResponder: () => true,
          onMoveShouldSetPanResponder: () => true,
          onPanResponderTerminationRequest: () => false,
          onPanResponderGrant: (_, gs) => {
            lastTouchRef.current = null;
            lastPinchRef.current = null;
            lastPanRef.current = null;
            didMoveRef.current = false;
            grantPosRef.current = { x: gs.x0, y: gs.y0 };
          },
          onPanResponderMove: (e) => {
            const touches = e.nativeEvent.touches;
            if (Math.hypot(
              touches[0]!.pageX - grantPosRef.current.x,
              touches[0]!.pageY - grantPosRef.current.y,
            ) > 5) didMoveRef.current = true;

            if (touches.length === 2) {
              // ── Two fingers: pinch (zoom) + pan ──
              const t0 = touches[0]!, t1 = touches[1]!;
              const dist = Math.hypot(t0.pageX - t1.pageX, t0.pageY - t1.pageY);
              const cx = (t0.pageX + t1.pageX) / 2;
              const cy = (t0.pageY + t1.pageY) / 2;

              if (lastPinchRef.current !== null && lastPanRef.current !== null) {
                const pinchDelta = dist - lastPinchRef.current;
                const panDx = cx - lastPanRef.current.x;
                const panDy = cy - lastPanRef.current.y;

                setOrbit((prev) => ({
                  ...prev,
                  distance: Math.max(5, Math.min(100, prev.distance - pinchDelta * 0.1)),
                  targetX: prev.targetX + panDx * 0.05,
                  targetY: prev.targetY - panDy * 0.05,
                }));
              }
              lastPinchRef.current = dist;
              lastPanRef.current = { x: cx, y: cy };
              lastTouchRef.current = null;
            } else if (touches.length === 1) {
              // ── One finger: behavior depends on selection count ──
              const t = touches[0]!;
              const cur = { x: t.pageX, y: t.pageY };
              const sel = selectedRef.current;

              if (lastTouchRef.current) {
                const dx = cur.x - lastTouchRef.current.x;
                const dy = cur.y - lastTouchRef.current.y;

                if (sel.length === 0) {
                  // 0 selected: free orbit around field center
                  setOrbit((prev) => ({
                    ...prev,
                    azimuth: prev.azimuth - dx * 0.005,
                    elevation: Math.max(0.05, Math.min(1.4, prev.elevation + dy * 0.005)),
                  }));
                } else if (sel.length === 1) {
                  // 1 selected: orbit keeping current pan/zoom locked
                  setOrbit((prev) => ({
                    ...prev,
                    azimuth: prev.azimuth - dx * 0.005,
                    elevation: Math.max(0.05, Math.min(1.4, prev.elevation + dy * 0.005)),
                  }));
                } else if (sel.length === 2) {
                  // 2 selected: rotate around the axis between them
                  const f0 = fieldById[sel[0]!];
                  const f1 = fieldById[sel[1]!];
                  if (f0 && f1) {
                    // Axis direction in screen space (approximate)
                    const s0 = screenHandlesRef.current[sel[0]!];
                    const s1 = screenHandlesRef.current[sel[1]!];
                    if (s0 && s1) {
                      const axisX = s1.x - s0.x;
                      const axisY = s1.y - s0.y;
                      const axisLen = Math.hypot(axisX, axisY);
                      if (axisLen > 1) {
                        // Component of drag perpendicular to axis
                        const perpComponent = (-dx * axisY + dy * axisX) / axisLen;
                        // Axis midpoint as orbit target
                        const midX = (f0.x + f1.x) / 2;
                        const midY = (f0.y + f1.y) / 2;
                        // Axis direction in field coords
                        const fAxisX = f1.x - f0.x;
                        const fAxisY = f1.y - f0.y;
                        const fAxisAngle = Math.atan2(fAxisY, fAxisX);
                        // Rotate perpendicular to the field axis, keep pan/zoom locked
                        setOrbit((prev) => ({
                          ...prev,
                          azimuth: prev.azimuth + Math.cos(fAxisAngle - prev.azimuth) * perpComponent * 0.003,
                          elevation: Math.max(0.05, Math.min(1.4,
                            prev.elevation + Math.sin(fAxisAngle - prev.azimuth) * perpComponent * 0.003)),
                        }));
                      }
                    }
                  }
                } else {
                  // 3 selected: locked orientation, translate only
                  setOrbit((prev) => ({
                    ...prev,
                    targetX: prev.targetX + dx * 0.05,
                    targetY: prev.targetY - dy * 0.05,
                  }));
                }
              }
              lastTouchRef.current = cur;
            }
          },
          onPanResponderRelease: (_, gs) => {
            // Tap (no significant movement): toggle handle selection
            if (!didMoveRef.current) {
              const lx = gs.x0 - canvasPageOffset.x;
              const ly = gs.y0 - canvasPageOffset.y;
              const sh = screenHandlesRef.current;

              // Find nearest handle within tap radius
              let nearId = "";
              let nearDist = 30; // max tap distance in pixels
              for (const h of handles) {
                const s = sh[h.id];
                if (!s) continue;
                const d = Math.hypot(lx - s.x, ly - s.y);
                if (d < nearDist) { nearDist = d; nearId = h.id; }
              }

              if (nearId) {
                setSelected((prev) => {
                  if (prev.includes(nearId)) {
                    // Deselect
                    return prev.filter((id) => id !== nearId);
                  }
                  if (prev.length >= 3) {
                    // Replace oldest selection
                    return [...prev.slice(1), nearId];
                  }
                  return [...prev, nearId];
                });
              } else {
                // Tap on empty space: clear selection
                setSelected([]);
              }
            }

            lastTouchRef.current = null;
            lastPinchRef.current = null;
            lastPanRef.current = null;
            setProjTick((t) => t + 1);
          },
        }),
      [canvasPageOffset, fieldById, handles],
    );

    // ── Mode label ────────────────────────────────────────────────────
    const modeLabel = useMemo(() => {
      if (selected.length === 0) return "drag to orbit";
      if (selected.length === 1) return `orbit around ${selected[0]}`;
      if (selected.length === 2) return `rotate on ${selected[0]}–${selected[1]} axis`;
      return "drag to translate";
    }, [selected]);

    // ── Imperative handle ─────────────────────────────────────────────
    useImperativeHandle(
      ref,
      () => ({
        solve: (): CameraPose | null =>
          homography ? { fit: homography, sides: ["left", "right"] } : null,
        reset: () => {
          setOrbit({ azimuth: 0, elevation: 0.25, distance: 25, targetX: 0, targetY: 8 });
          setSelected([]);
        },
        anchoredCount: () => Object.keys(projectedHandles).length,
        getState: () => ({
          positions: projectedHandles,
          anchored: Object.fromEntries(handles.map((h) => [h.id, true])),
        }),
        setState: () => {},
      }),
      [homography, projectedHandles, handles],
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

    // ── Render ────────────────────────────────────────────────────────
    return (
      <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
        <GLView
          style={{ width: canvas.width, height: canvas.height }}
          onContextCreate={onContextCreate}
          pointerEvents="none"
        />

        {/* Projected handle dots */}
        {handles.map((h) => {
          const s = screenHandles[h.id];
          if (!s) return null;
          const isSel = selected.includes(h.id);
          const color = isSel ? SELECTED_COLOR : FREE_COLOR;
          return (
            <View key={h.id} pointerEvents="none" style={{
              position: "absolute", left: s.x - HANDLE_R, top: s.y - HANDLE_R,
              width: HANDLE_R * 2, height: HANDLE_R * 2, borderRadius: HANDLE_R,
              borderWidth: isSel ? 2.5 : 1.5, borderColor: color,
              backgroundColor: isSel ? "rgba(255,120,255,0.25)" : "rgba(0,200,255,0.15)",
            }} />
          );
        })}

        {/* Handle labels */}
        {handles.map((h) => {
          const s = screenHandles[h.id];
          if (!s) return null;
          const isSel = selected.includes(h.id);
          return (
            <Text key={`lbl-${h.id}`} pointerEvents="none" style={{
              position: "absolute", left: s.x - 30, top: s.y - HANDLE_R - 12,
              width: 60, textAlign: "center",
              color: isSel ? SELECTED_COLOR : FREE_COLOR,
              fontSize: 7, fontWeight: "600",
            }}>{h.id}</Text>
          );
        })}

        {/* Status */}
        <Text pointerEvents="none" style={{
          position: "absolute", left: 10, top: 8,
          color: "rgba(0,200,255,0.9)", fontSize: 11, fontWeight: "600",
        }}>
          {loadStatus} · {modeLabel} · pinch to zoom
        </Text>

        {/* Touch surface */}
        <View {...responder.panHandlers} style={StyleSheet.absoluteFill} />
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
