// 3D field model overlay — place anchors individually.
//
// 1. Pick a handle from the dropdown
// 2. Drag it to the matching spot on the video
// 3. Repeat for 4+ handles
// 4. 3D model overlays using the homography from placed anchors
// 5. Tap any placed handle to select + nudge it

import React, {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  forwardRef,
} from "react";
import { StyleSheet, View, PanResponder, Text, Pressable, ScrollView } from "react-native";
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
import { intrinsicsFromFov } from "./cameraPoseDecompose";

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

const PLACED_COLOR = "rgba(0,255,100,0.95)";
const ACTIVE_COLOR = "rgba(255,220,0,0.95)";
const FREE_COLOR = "rgba(0,200,255,0.7)";
const HANDLE_R = 8;

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

    // ── Placed anchors: handle id → normalized screen position ────────
    const [placed, setPlaced] = useState<Record<string, { nx: number; ny: number }>>({});
    const placedRef = useRef(placed);
    placedRef.current = placed;

    // ── Currently active handle (being placed or nudged) ──────────────
    const [activeId, setActiveId] = useState<string | null>(null);
    const activeIdRef = useRef(activeId);
    activeIdRef.current = activeId;

    // ── Dropdown open state ───────────────────────────────────────────
    const [dropdownOpen, setDropdownOpen] = useState(false);

    // ── Control mode ──────────────────────────────────────────────────
    const [controlMode, setControlMode] = useState<"model" | "video">("model");

    // ── Field coord lookup ────────────────────────────────────────────
    const fieldById = useMemo(() => {
      const m: Record<string, { x: number; y: number }> = {};
      for (const h of handles) m[h.id] = { x: h.position.x, y: h.position.y };
      return m;
    }, [handles]);

    const placedCount = Object.keys(placed).length;

    // ── Homography from placed anchors ────────────────────────────────
    const homography = useMemo((): HomographyFit | null => {
      if (placedCount < 4) return null;
      const corr: Correspondence[] = Object.entries(placed).map(([id, p]) => ({
        field: fieldById[id]!,
        image: { u: p.nx * imageWidth, v: p.ny * imageHeight },
      }));
      return fitHomography(corr);
    }, [placed, fieldById, imageWidth, imageHeight, placedCount]);

    // ── Sync 3D camera when homography is available ───────────────────
    useEffect(() => {
      const cam = cameraRef.current;
      if (!cam || !homography) return;

      const hFovDeg = 69;
      const K = intrinsicsFromFov(imageWidth, imageHeight, hFovDeg);
      const ifx = 1 / K.fx, ify = 1 / K.fy;
      const Kinv = [ifx, 0, -K.cx * ifx, 0, ify, -K.cy * ify, 0, 0, 1];
      const M = mul3x3(Kinv, homography.H);
      const c0 = [M[0]!, M[3]!, M[6]!];
      const c1 = [M[1]!, M[4]!, M[7]!];
      const c2 = [M[2]!, M[5]!, M[8]!];

      let lambda = Math.sqrt(c0[0] * c0[0] + c0[1] * c0[1] + c0[2] * c0[2]);
      if (lambda < 1e-10) return;
      if (M[8]! / lambda < 0) lambda = -lambda;

      const r1 = c0.map((v) => v / lambda);
      const r2 = c1.map((v) => v / lambda);
      const t = c2.map((v) => v / lambda);
      const r3 = [
        r1[1]! * r2[2]! - r1[2]! * r2[1]!,
        r1[2]! * r2[0]! - r1[0]! * r2[2]!,
        r1[0]! * r2[1]! - r1[1]! * r2[0]!,
      ];

      // Z column for height: lambda * K * r3
      const Kz0 = lambda * (K.fx * r3[0]! + K.cx * r3[2]!);
      const Kz1 = lambda * (K.fy * r3[1]! + K.cy * r3[2]!);
      const Kz2 = lambda * r3[2]!;

      const H = homography.H;
      const P00 = H[0]!, P01 = H[1]!, P02 = Kz0, P03 = H[2]!;
      const P10 = H[3]!, P11 = H[4]!, P12 = Kz1, P13 = H[5]!;
      const P20 = H[6]!, P21 = H[7]!, P22 = Kz2, P23 = H[8]!;

      const W = imageWidth, Hi = imageHeight;

      cam.matrixAutoUpdate = false;
      cam.matrix.identity();
      cam.matrixWorld.identity();
      cam.matrixWorldInverse.identity();

      cam.projectionMatrix.set(
        2*P00/W - P20,   2*P01/W - P21,   2*P02/W - P22,   2*P03/W - P23,
        P20 - 2*P10/Hi,  P21 - 2*P11/Hi,  P22 - 2*P12/Hi,  P23 - 2*P13/Hi,
        -P20 * 0.001,    -P21 * 0.001,     -P22 * 0.001,     -P23 * 0.001,
        P20,              P21,              P22,              P23,
      );
      cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    }, [homography, imageWidth, imageHeight]);

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

    const screenToImage = useCallback(
      (sx: number, sy: number) => {
        const cx = canvas.width / 2, cy = canvas.height / 2;
        const ix = (sx - cx - vp.tx) / vp.scale + cx;
        const iy = (sy - cy - vp.ty) / vp.scale + cy;
        return {
          nx: Math.max(0, Math.min(1, ix / canvas.width)),
          ny: Math.max(0, Math.min(1, iy / canvas.height)),
        };
      },
      [canvas, vp],
    );

    // ── Touch handling ────────────────────────────────────────────────
    const dragRef = useRef<{ id: string; offset: { dnx: number; dny: number } } | null>(null);
    const didMoveRef = useRef(false);

    const screenPlaced = useMemo(() => {
      const result: Record<string, { x: number; y: number }> = {};
      for (const [id, p] of Object.entries(placed)) {
        result[id] = imageToScreen(p.nx, p.ny);
      }
      return result;
    }, [placed, imageToScreen]);
    const screenPlacedRef = useRef(screenPlaced);
    screenPlacedRef.current = screenPlaced;

    const responder = useMemo(
      () =>
        PanResponder.create({
          // Only claim the gesture if there's an active handle to place,
          // or the touch is near a placed handle. Otherwise let the parent
          // (video zoom/pan) handle it — prevents accidental anchor moves.
          onStartShouldSetPanResponder: (_, gs) => {
            // Active handle waiting to be placed? Always claim.
            if (activeIdRef.current) return true;
            // Near a placed handle? Claim.
            const lx = gs.x0 - canvasPageOffset.x;
            const ly = gs.y0 - canvasPageOffset.y;
            const sp = screenPlacedRef.current;
            for (const [, s] of Object.entries(sp)) {
              if (Math.hypot(lx - s.x, ly - s.y) < 40) return true;
            }
            return false;
          },
          onMoveShouldSetPanResponder: () => !!dragRef.current,
          onPanResponderTerminationRequest: () => !dragRef.current,
          onPanResponderGrant: (_, gs) => {
            didMoveRef.current = false;
            const lx = gs.x0 - canvasPageOffset.x;
            const ly = gs.y0 - canvasPageOffset.y;
            const touchImg = screenToImage(lx, ly);
            const aid = activeIdRef.current;

            if (aid && placedRef.current[aid]) {
              // Already active + placed: start dragging it
              const pos = placedRef.current[aid]!;
              dragRef.current = {
                id: aid,
                offset: { dnx: pos.nx - touchImg.nx, dny: pos.ny - touchImg.ny },
              };
              return;
            }

            if (aid && !placedRef.current[aid]) {
              // New handle being placed: drop it at touch position
              setPlaced((prev) => ({ ...prev, [aid]: touchImg }));
              dragRef.current = { id: aid, offset: { dnx: 0, dny: 0 } };
              return;
            }

            // No active: find nearest placed handle
            const sp = screenPlacedRef.current;
            let nearId = "";
            let nearDist = 40;
            for (const [id, s] of Object.entries(sp)) {
              const d = Math.hypot(lx - s.x, ly - s.y);
              if (d < nearDist) { nearDist = d; nearId = id; }
            }
            if (nearId) {
              setActiveId(nearId);
              const pos = placedRef.current[nearId]!;
              dragRef.current = {
                id: nearId,
                offset: { dnx: pos.nx - touchImg.nx, dny: pos.ny - touchImg.ny },
              };
            }
          },
          onPanResponderMove: (_, gs) => {
            const drag = dragRef.current;
            if (!drag) return;
            if (Math.hypot(gs.dx, gs.dy) > 3) didMoveRef.current = true;
            const lx = gs.moveX - canvasPageOffset.x;
            const ly = gs.moveY - canvasPageOffset.y;
            const curImg = screenToImage(lx, ly);
            setPlaced((prev) => ({
              ...prev,
              [drag.id]: {
                nx: curImg.nx + drag.offset.dnx,
                ny: curImg.ny + drag.offset.dny,
              },
            }));
          },
          onPanResponderRelease: () => {
            dragRef.current = null;
          },
          onPanResponderTerminate: () => {
            dragRef.current = null;
          },
        }),
      [canvasPageOffset, screenToImage],
    );

    // ── Select a handle from dropdown ─────────────────────────────────
    const selectHandle = useCallback((id: string) => {
      setActiveId(id);
      setDropdownOpen(false);
      // If not already placed, it'll be placed on first touch
    }, []);

    // ── Remove a placed handle ────────────────────────────────────────
    const removeHandle = useCallback((id: string) => {
      setPlaced((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      if (activeId === id) setActiveId(null);
    }, [activeId]);

    // ── Nudge active handle ───────────────────────────────────────────
    const nudge = useCallback((dx: number, dy: number) => {
      if (!activeId || !placed[activeId]) return;
      setPlaced((prev) => {
        const p = prev[activeId];
        if (!p) return prev;
        return { ...prev, [activeId]: { nx: p.nx + dx / imageWidth, ny: p.ny + dy / imageHeight } };
      });
    }, [activeId, placed, imageWidth, imageHeight]);

    // ── Imperative handle ─────────────────────────────────────────────
    useImperativeHandle(ref, () => ({
      solve: (): CameraPose | null => homography ? { fit: homography, sides: ["left", "right"] } : null,
      reset: () => { setPlaced({}); setActiveId(null); setDropdownOpen(false); },
      anchoredCount: () => placedCount,
      getState: () => ({
        positions: placed,
        anchored: Object.fromEntries(Object.keys(placed).map((id) => [id, true])),
      }),
      setState: (s) => { setPlaced(s.positions); },
    }), [homography, placed, placedCount]);

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

      // Don't render the 3D model until homography is solved — start hidden
      if (modelRef.current) modelRef.current.scene.visible = false;

      const render = () => {
        rafRef.current = requestAnimationFrame(render);
        if (rendererRef.current && sceneRef.current && cameraRef.current) {
          rendererRef.current.render(sceneRef.current, cameraRef.current);
          gl.endFrameEXP();
        }
      };
      render();
    }, []);

    useEffect(() => {
      if (modelRef.current) modelRef.current.scene.visible = !!homography;
    }, [homography]);

    useEffect(() => () => { cancelAnimationFrame(rafRef.current); rendererRef.current?.dispose(); }, []);

    // ── Available (not yet placed) handles for dropdown ───────────────
    const availableHandles = useMemo(
      () => handles.filter((h) => !placed[h.id]),
      [handles, placed],
    );

    // ── Render ────────────────────────────────────────────────────────
    return (
      <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
        <GLView
          style={{ width: canvas.width, height: canvas.height }}
          onContextCreate={onContextCreate}
          pointerEvents="none"
        />

        {/* Placed handle dots */}
        {Object.entries(placed).map(([id]) => {
          const s = screenPlaced[id];
          if (!s) return null;
          const isActive = activeId === id;
          return (
            <View key={id} pointerEvents="none" style={{
              position: "absolute", left: s.x - HANDLE_R, top: s.y - HANDLE_R,
              width: HANDLE_R * 2, height: HANDLE_R * 2, borderRadius: HANDLE_R,
              borderWidth: 2,
              borderColor: isActive ? ACTIVE_COLOR : PLACED_COLOR,
              backgroundColor: isActive ? "rgba(255,220,0,0.3)" : "rgba(0,255,100,0.2)",
            }} />
          );
        })}

        {/* Handle labels */}
        {Object.entries(placed).map(([id]) => {
          const s = screenPlaced[id];
          if (!s) return null;
          const isActive = activeId === id;
          return (
            <Text key={`l-${id}`} pointerEvents="none" style={{
              position: "absolute", left: s.x - 30, top: s.y - HANDLE_R - 14,
              width: 60, textAlign: "center",
              color: isActive ? ACTIVE_COLOR : PLACED_COLOR,
              fontSize: 7, fontWeight: "700",
            }}>{id}</Text>
          );
        })}

        {/* Touch surface — BEFORE controls so controls render on top */}
        {controlMode === "model" && (
          <View {...responder.panHandlers} style={StyleSheet.absoluteFill} />
        )}

        {/* Status bar — top center */}
        <View style={{ position: "absolute", top: 8, left: 0, right: 0, alignItems: "center" }} pointerEvents="none">
          <Text style={{
            color: "rgba(255,255,255,0.8)", fontSize: 12, fontWeight: "500",
            backgroundColor: "rgba(0,0,0,0.4)", paddingHorizontal: 10, paddingVertical: 4,
            borderRadius: 8, overflow: "hidden",
          }}>
            {placedCount}/4 anchors{placedCount >= 4 ? " ✓" : ""}{activeId ? ` · ${activeId}` : ""}
          </Text>
        </View>

        {/* Controls — bottom, AR-style pills */}
        <View style={{ position: "absolute", bottom: 0, left: 0, right: 0 }} pointerEvents="box-none">
          {/* Nudge row (only when active handle is placed) */}
          {activeId && placed[activeId] && (
            <View style={{ flexDirection: "row", justifyContent: "center", gap: 8, marginBottom: 8 }}>
              <Pill label="◀" onPress={() => nudge(-1, 0)} small />
              <Pill label="▲" onPress={() => nudge(0, -1)} small />
              <Pill label="▼" onPress={() => nudge(0, 1)} small />
              <Pill label="▶" onPress={() => nudge(1, 0)} small />
            </View>
          )}

          {/* Main control row */}
          <View style={{ flexDirection: "row", justifyContent: "center", flexWrap: "wrap", gap: 8, paddingHorizontal: 12, paddingBottom: 16 }}>
            <Pill
              label={activeId ? activeId : "Place ▾"}
              active={dropdownOpen}
              onPress={() => setDropdownOpen((v) => !v)}
            />
            {activeId && placed[activeId] && (
              <Pill label="Remove" onPress={() => removeHandle(activeId)} />
            )}
            <Pill
              label={controlMode === "model" ? "Model" : "Video"}
              active={controlMode === "video"}
              onPress={() => setControlMode((m) => m === "model" ? "video" : "model")}
            />
          </View>
        </View>

        {/* Dropdown list — above the control bar */}
        {dropdownOpen && (
          <View style={{
            position: "absolute", bottom: 60, left: 12, right: 12,
            maxHeight: 240, backgroundColor: "rgba(0,0,0,0.9)",
            borderRadius: 12, padding: 6,
          }}>
            <ScrollView>
              {availableHandles.map((h) => (
                <Pressable
                  key={h.id}
                  onPress={() => selectHandle(h.id)}
                  style={{
                    paddingHorizontal: 14, paddingVertical: 10,
                    borderBottomWidth: 0.5, borderBottomColor: "rgba(255,255,255,0.1)",
                  }}
                >
                  <Text style={{ color: "#fff", fontSize: 14 }}>{h.id}</Text>
                </Pressable>
              ))}
              {availableHandles.length === 0 && (
                <Text style={{ color: "rgba(255,255,255,0.4)", fontSize: 13, padding: 10 }}>
                  All handles placed
                </Text>
              )}
            </ScrollView>
          </View>
        )}
      </View>
    );
  },
);

// ── Pill button (matches AR tab style) ───────────────────────────────────

function Pill({ label, active, onPress, disabled, small }: {
  label: string; active?: boolean; onPress: () => void; disabled?: boolean; small?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={{
        paddingHorizontal: small ? 12 : 18,
        paddingVertical: small ? 6 : 10,
        borderRadius: small ? 14 : 20,
        backgroundColor: active ? "rgba(255,255,255,0.85)" : "rgba(0,0,0,0.45)",
        borderWidth: 1,
        borderColor: active ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.2)",
        opacity: disabled ? 0.35 : 1,
      }}
    >
      <Text style={{
        color: active ? "#000" : "rgba(255,255,255,0.9)",
        fontSize: small ? 12 : 14,
        fontWeight: "600",
      }}>{label}</Text>
    </Pressable>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────

function mul3x3(A: number[], B: number[]): number[] {
  const C = new Array(9).fill(0);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      for (let k = 0; k < 3; k++)
        C[r * 3 + c] += A[r * 3 + k]! * B[k * 3 + c]!;
  return C;
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
