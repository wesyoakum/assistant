// 3D field model overlay with integrated calibration handles.
//
// Replaces BatterBoxOverlay entirely: the Blender GLB provides both the
// rendered field geometry AND the calibration handle positions (empties).
// Touch-draggable handle dots are positioned absolutely over the GLView.
//
// Handle states:
//   Free (white)     — not anchored, moves with rigid-body transform
//   Dragging (yellow) — actively being moved by finger
//   Anchored (green) — locked in place, used for homography solve
//   Selected (purple) — anchored handle tapped; shows nudge controls

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

const FREE_COLOR = "rgba(255,255,255,0.6)";
const DRAGGING_COLOR = "rgba(255,220,0,0.95)";
const ANCHORED_COLOR = "rgba(0,255,100,0.95)";
const SELECTED_COLOR = "rgba(180,100,255,0.95)";
const HANDLE_R = 8;

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
    const glRef = useRef<ExpoWebGLRenderingContext | null>(null);

    // ── Calibration state ─────────────────────────────────────────────
    const [positions, setPositions] = useState<Record<string, { nx: number; ny: number }>>({});
    const [anchored, setAnchored] = useState<Record<string, boolean>>({});
    const [draggingId, setDraggingId] = useState<string | null>(null);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [handles, setHandles] = useState<HandlePoint[]>([]);
    const [loadStatus, setLoadStatus] = useState<string>("loading…");

    const posRef = useRef(positions);
    posRef.current = positions;
    const anchoredRef = useRef(anchored);
    anchoredRef.current = anchored;
    const handlesRef = useRef(handles);
    handlesRef.current = handles;
    const selectedRef = useRef(selectedId);
    selectedRef.current = selectedId;

    const fieldById = useMemo(() => {
      const m: Record<string, { x: number; y: number }> = {};
      for (const h of handles) m[h.id] = { x: h.position.x, y: h.position.y };
      return m;
    }, [handles]);

    const anchoredIds = useMemo(
      () => handles.filter((h) => anchored[h.id]).map((h) => h.id),
      [handles, anchored],
    );
    const anchorCount = anchoredIds.length;

    // ── Homography from anchored handles ──────────────────────────────
    const homography = useMemo((): HomographyFit | null => {
      if (anchorCount < 4) return null;
      const corr: Correspondence[] = anchoredIds.map((id) => ({
        field: fieldById[id]!,
        image: { u: positions[id]!.nx * imageWidth, v: positions[id]!.ny * imageHeight },
      }));
      return fitHomography(corr);
    }, [anchored, positions, anchorCount, anchoredIds, imageWidth, imageHeight, fieldById]);

    // ── Sync Three.js camera from ALL handle positions ────────────────
    // Build the projection matrix DIRECTLY from the homography, bypassing
    // camera pose decomposition entirely. This avoids all the axis
    // convention mismatches between CV, Three.js, and our field coords.
    //
    // The homography H maps field (x,y) → image (u,v). We extend it to
    // a full 3x4 matrix that also handles Z (height above ground) using
    // the third rotation column r3 = r1 × r2 from the decomposition.
    // Then we convert to a 4x4 OpenGL clip-space matrix.
    useEffect(() => {
      const cam = cameraRef.current;
      if (!cam || handles.length < 4) return;

      const corr: Correspondence[] = [];
      for (const h of handles) {
        const p = positions[h.id];
        const f = fieldById[h.id];
        if (!p || !f) continue;
        corr.push({
          field: f,
          image: { u: p.nx * imageWidth, v: p.ny * imageHeight },
        });
      }
      if (corr.length < 4) return;

      const fit = fitHomography(corr);
      if (!fit) return;
      const H = fit.H;

      // Decompose just enough to get r3 for the Z column.
      const hFovDeg = 69;
      const K = intrinsicsFromFov(imageWidth, imageHeight, hFovDeg);
      const ifx = 1 / K.fx, ify = 1 / K.fy;
      const Kinv = [ifx, 0, -K.cx * ifx, 0, ify, -K.cy * ify, 0, 0, 1];
      const M = mul3x3(Kinv, H);
      const c0 = [M[0]!, M[3]!, M[6]!];
      let lambda = Math.sqrt(c0[0] * c0[0] + c0[1] * c0[1] + c0[2] * c0[2]);
      if (lambda < 1e-10) return;
      // Sign: ensure positive depth for the origin.
      if (M[8]! / lambda < 0) lambda = -lambda;

      const r1 = c0.map((v) => v / lambda);
      const c1 = [M[1]!, M[4]!, M[7]!];
      const r2 = c1.map((v) => v / lambda);
      const r3 = [
        r1[1]! * r2[2]! - r1[2]! * r2[1]!,
        r1[2]! * r2[0]! - r1[0]! * r2[2]!,
        r1[0]! * r2[1]! - r1[1]! * r2[0]!,
      ];

      // Z column in image space: lambda * K * r3
      // This gives the image-pixel response to height (z) in the same
      // scale as the homography columns.
      const Kz0 = lambda * (K.fx * r3[0]! + K.cx * r3[2]!);
      const Kz1 = lambda * (K.fy * r3[1]! + K.cy * r3[2]!);
      const Kz2 = lambda * r3[2]!;

      // Full 3x4 projection: maps (x, y, z, 1) → (u·w, v·w, w)
      // P = [H0  H1  Kz0  H2]
      //     [H3  H4  Kz1  H5]
      //     [H6  H7  Kz2  H8]
      const P00 = H[0]!, P01 = H[1]!, P02 = Kz0, P03 = H[2]!;
      const P10 = H[3]!, P11 = H[4]!, P12 = Kz1, P13 = H[5]!;
      const P20 = H[6]!, P21 = H[7]!, P22 = Kz2, P23 = H[8]!;

      // Convert to OpenGL 4x4 clip-space matrix.
      // NDC_x = 2·(u/w)/W - 1 → clip_x = 2·(u·w)/(W) - w = (2·P_row0/W - P_row2) · [x,y,z,1]
      // NDC_y = 1 - 2·(v/w)/H → clip_y = w - 2·(v·w)/H = (P_row2 - 2·P_row1/H) · [x,y,z,1]
      // clip_w = P_row2 · [x,y,z,1]
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
    }, [positions, handles, fieldById, imageWidth, imageHeight, canvas]);

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

    const screenHandles = useMemo(() => {
      const result: Record<string, { x: number; y: number }> = {};
      for (const h of handles) {
        const pos = positions[h.id] ?? { nx: 0.5, ny: 0.5 };
        result[h.id] = imageToScreen(pos.nx, pos.ny);
      }
      return result;
    }, [handles, positions, imageToScreen]);

    const screenHandlesRef = useRef(screenHandles);
    screenHandlesRef.current = screenHandles;

    // ── Nudge a selected handle by pixel increments ───────────────────
    const nudge = useCallback((dx: number, dy: number) => {
      const id = selectedRef.current;
      if (!id) return;
      setPositions((prev) => {
        const p = prev[id];
        if (!p) return prev;
        return {
          ...prev,
          [id]: {
            nx: p.nx + dx / imageWidth,
            ny: p.ny + dy / imageHeight,
          },
        };
      });
    }, [imageWidth, imageHeight]);

    // ── Touch handling ────────────────────────────────────────────────
    type Drag = { id: string; offset: { dnx: number; dny: number } };
    const dragRef = useRef<Drag | null>(null);
    const didMoveRef = useRef(false);

    const responder = useMemo(
      () =>
        PanResponder.create({
          onStartShouldSetPanResponder: () => true,
          onMoveShouldSetPanResponder: () => true,
          onPanResponderTerminationRequest: () => true,
          onPanResponderGrant: (_, gs) => {
            didMoveRef.current = false;
            const lx = gs.x0 - canvasPageOffset.x;
            const ly = gs.y0 - canvasPageOffset.y;
            const touchImg = screenToImage(lx, ly);
            const sh = screenHandlesRef.current;
            const hs = handlesRef.current;

            let nearId = hs[0]?.id ?? "";
            let nearDist = Infinity;
            for (const h of hs) {
              const s = sh[h.id];
              if (!s) continue;
              const d = Math.hypot(lx - s.x, ly - s.y);
              if (d < nearDist) { nearDist = d; nearId = h.id; }
            }

            const handlePos = posRef.current[nearId] ?? { nx: 0.5, ny: 0.5 };
            dragRef.current = {
              id: nearId,
              offset: { dnx: handlePos.nx - touchImg.nx, dny: handlePos.ny - touchImg.ny },
            };
            setDraggingId(nearId);
            setSelectedId(null); // clear selection when starting a drag
          },
          onPanResponderMove: (_, gs) => {
            const drag = dragRef.current;
            if (!drag) return;
            if (Math.hypot(gs.dx, gs.dy) > 3) didMoveRef.current = true;
            const lx = gs.moveX - canvasPageOffset.x;
            const ly = gs.moveY - canvasPageOffset.y;
            const curImg = screenToImage(lx, ly);
            const newPos = {
              nx: curImg.nx + drag.offset.dnx,
              ny: curImg.ny + drag.offset.dny,
            };

            const anchorId = drag.id === "plate_apex"
              ? anchoredIds[0] || "2B"
              : "plate_apex";
            const anchorField = fieldById[anchorId];
            const dragField = fieldById[drag.id];

            setPositions((prev) => {
              const anchorImg = prev[anchorId];
              if (!anchorImg || !anchorField || !dragField)
                return { ...prev, [drag.id]: newPos };

              const ffx = dragField.x - anchorField.x;
              const ffy = dragField.y - anchorField.y;
              const fDist = Math.hypot(ffx, ffy);
              if (fDist < 1e-6) return { ...prev, [drag.id]: newPos };

              const iix = newPos.nx - anchorImg.nx;
              const iiy = newPos.ny - anchorImg.ny;
              const iDist = Math.hypot(iix, iiy);
              if (iDist < 1e-6) return { ...prev, [drag.id]: newPos };

              const scale = iDist / fDist;
              const rot = Math.atan2(iiy, iix) - Math.atan2(ffy, ffx);
              const cosR = Math.cos(rot) * scale;
              const sinR = Math.sin(rot) * scale;

              // Anchored handles stay fixed. Free handles get their exact
              // rigid-body positions so collinearity is preserved.
              const next: Record<string, { nx: number; ny: number }> = {};
              for (const h of handlesRef.current) {
                if (h.id === anchorId) {
                  next[h.id] = anchorImg;
                } else if (h.id === drag.id) {
                  next[h.id] = newPos;
                } else if (anchoredRef.current[h.id]) {
                  // Anchored handles stay put.
                  next[h.id] = prev[h.id]!;
                } else {
                  // Free handles: apply similarity transform.
                  const fx = fieldById[h.id]!.x - anchorField.x;
                  const fy = fieldById[h.id]!.y - anchorField.y;
                  next[h.id] = {
                    nx: anchorImg.nx + cosR * fx - sinR * fy,
                    ny: anchorImg.ny + sinR * fx + cosR * fy,
                  };
                }
              }
              return next;
            });
          },
          onPanResponderRelease: () => {
            const drag = dragRef.current;
            if (drag) {
              if (!didMoveRef.current && anchoredRef.current[drag.id]) {
                // Tap on anchored handle → select it (purple).
                setSelectedId(drag.id);
              } else if (didMoveRef.current) {
                // Dragged → anchor.
                setAnchored((prev) => ({ ...prev, [drag.id]: true }));
              }
            }
            setDraggingId(null);
            dragRef.current = null;
          },
          onPanResponderTerminate: () => {
            setDraggingId(null);
            dragRef.current = null;
          },
        }),
      [canvasPageOffset, screenToImage, anchoredIds, fieldById],
    );

    // ── Imperative handle ─────────────────────────────────────────────
    useImperativeHandle(
      ref,
      () => ({
        solve: (): CameraPose | null =>
          homography ? { fit: homography, sides: ["left", "right"] } : null,
        reset: () => {
          initDefaultPositions(handlesRef.current, fieldById);
          setAnchored({});
          setDraggingId(null);
          setSelectedId(null);
        },
        anchoredCount: () => anchorCount,
        getState: () => ({ positions, anchored }),
        setState: (s) => { setPositions(s.positions); setAnchored(s.anchored); },
      }),
      [homography, anchorCount, positions, anchored, fieldById],
    );

    function initDefaultPositions(
      hs: HandlePoint[],
      fById: Record<string, { x: number; y: number }>,
    ) {
      // Virtual camera behind the plate, elevated, looking toward outfield.
      const cam = { x: 2, y: -10, z: 3 };
      const focus = { x: 0, y: 15, z: 0 };
      const hFov = 69;
      const fwd = [focus.x - cam.x, focus.y - cam.y, focus.z - cam.z];
      const fLen = Math.hypot(fwd[0]!, fwd[1]!, fwd[2]!);
      fwd[0]! /= fLen; fwd[1]! /= fLen; fwd[2]! /= fLen;
      const up = [0, 0, 1];
      const right = [
        fwd[1]! * up[2]! - fwd[2]! * up[1]!,
        fwd[2]! * up[0]! - fwd[0]! * up[2]!,
        fwd[0]! * up[1]! - fwd[1]! * up[0]!,
      ];
      const rLen = Math.hypot(right[0]!, right[1]!, right[2]!);
      right[0]! /= rLen; right[1]! /= rLen; right[2]! /= rLen;
      const camUp = [
        right[1]! * fwd[2]! - right[2]! * fwd[1]!,
        right[2]! * fwd[0]! - right[0]! * fwd[2]!,
        right[0]! * fwd[1]! - right[1]! * fwd[0]!,
      ];
      const fx = 0.5 / Math.tan(((hFov * Math.PI) / 180) / 2);

      const result: Record<string, { nx: number; ny: number }> = {};
      for (const h of hs) {
        const f = fById[h.id];
        if (!f) continue;
        const dx = f.x - cam.x, dy = f.y - cam.y, dz = 0 - cam.z;
        const cx2 = right[0]! * dx + right[1]! * dy + right[2]! * dz;
        const cy2 = camUp[0]! * dx + camUp[1]! * dy + camUp[2]! * dz;
        const cz2 = fwd[0]! * dx + fwd[1]! * dy + fwd[2]! * dz;
        if (cz2 < 0.01) { result[h.id] = { nx: 0.5, ny: 0.5 }; continue; }
        result[h.id] = { nx: 0.5 + fx * (cx2 / cz2), ny: 0.5 - fx * (cy2 / cz2) };
      }
      setPositions(result);
    }

    // ── GL context setup ──────────────────────────────────────────────
    const onContextCreate = useCallback(
      async (gl: ExpoWebGLRenderingContext) => {
        glRef.current = gl;

        const renderer = new Renderer({ gl }) as unknown as THREE.WebGLRenderer;
        renderer.setSize(gl.drawingBufferWidth, gl.drawingBufferHeight);
        renderer.setClearColor(0x000000, 0);
        rendererRef.current = renderer;

        const scene = new THREE.Scene();
        sceneRef.current = scene;

        const camera = new THREE.PerspectiveCamera(
          60, gl.drawingBufferWidth / gl.drawingBufferHeight, 0.1, 500,
        );
        camera.up.set(0, 0, 1);
        camera.position.set(0, -15, 5);
        camera.lookAt(0, 10, 0);
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
          console.warn("[FieldModelOverlay] GLB failed:", msg);
          setLoadStatus(`GLB failed: ${msg.slice(0, 60)}`);
        }

        if (loadedHandles.length === 0) {
          loadedHandles = buildFallbackHandles();
          setLoadStatus(`fallback (${loadedHandles.length} handles)`);
        }

        setHandles(loadedHandles);
        const fById: Record<string, { x: number; y: number }> = {};
        for (const h of loadedHandles) fById[h.id] = { x: h.position.x, y: h.position.y };
        initDefaultPositions(loadedHandles, fById);

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

    // ── Handle color helper ───────────────────────────────────────────
    function handleColor(id: string): { border: string; bg: string } {
      if (id === draggingId) return { border: DRAGGING_COLOR, bg: "rgba(255,220,0,0.35)" };
      if (id === selectedId) return { border: SELECTED_COLOR, bg: "rgba(180,100,255,0.3)" };
      if (anchored[id]) return { border: ANCHORED_COLOR, bg: "rgba(0,255,100,0.25)" };
      return { border: FREE_COLOR, bg: "rgba(255,255,255,0.08)" };
    }

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
          const { border, bg } = handleColor(h.id);
          return (
            <View key={h.id} pointerEvents="none" style={{
              position: "absolute", left: s.x - HANDLE_R, top: s.y - HANDLE_R,
              width: HANDLE_R * 2, height: HANDLE_R * 2, borderRadius: HANDLE_R,
              borderWidth: 2, borderColor: border, backgroundColor: bg,
            }} />
          );
        })}

        {/* Handle labels */}
        {handles.map((h) => {
          const s = screenHandles[h.id];
          if (!s) return null;
          const { border } = handleColor(h.id);
          return (
            <Text key={`lbl-${h.id}`} pointerEvents="none" style={{
              position: "absolute", left: s.x - 30, top: s.y - HANDLE_R - 14,
              width: 60, textAlign: "center", color: border, fontSize: 7, fontWeight: "600",
            }}>{h.id}</Text>
          );
        })}

        {/* Status text */}
        <Text pointerEvents="none" style={{
          position: "absolute", left: 10, top: 8,
          color: anchorCount >= 4 ? ANCHORED_COLOR : "rgba(255,200,0,0.9)",
          fontSize: 11, fontWeight: "600",
        }}>
          {anchorCount >= 4 && homography
            ? `${anchorCount} anchored · RMS ${homography.rmsPx.toFixed(1)}px`
            : `${anchorCount}/4 anchored · ${loadStatus}`}
        </Text>

        {/* Nudge controls for selected (purple) handle */}
        {selectedId && (() => {
          const s = screenHandles[selectedId];
          if (!s) return null;
          const btnSize = 32;
          const gap = 4;
          return (
            <View pointerEvents="box-none" style={{
              position: "absolute", left: s.x - btnSize * 1.5 - gap, top: s.y + HANDLE_R + 8,
              alignItems: "center",
            }}>
              {/* Up */}
              <Pressable onPress={() => nudge(0, -1)} style={nudgeBtnStyle(btnSize)}>
                <Text style={nudgeText}>▲</Text>
              </Pressable>
              {/* Left / Deactivate / Right */}
              <View style={{ flexDirection: "row", gap }}>
                <Pressable onPress={() => nudge(-1, 0)} style={nudgeBtnStyle(btnSize)}>
                  <Text style={nudgeText}>◀</Text>
                </Pressable>
                <Pressable
                  onPress={() => {
                    setAnchored((prev) => { const n = { ...prev }; delete n[selectedId]; return n; });
                    setSelectedId(null);
                  }}
                  style={[nudgeBtnStyle(btnSize), { backgroundColor: "rgba(255,60,60,0.7)" }]}
                >
                  <Text style={[nudgeText, { fontSize: 9 }]}>✕</Text>
                </Pressable>
                <Pressable onPress={() => nudge(1, 0)} style={nudgeBtnStyle(btnSize)}>
                  <Text style={nudgeText}>▶</Text>
                </Pressable>
              </View>
              {/* Down */}
              <Pressable onPress={() => nudge(0, 1)} style={nudgeBtnStyle(btnSize)}>
                <Text style={nudgeText}>▼</Text>
              </Pressable>
            </View>
          );
        })()}

        {/* Touch surface */}
        <View {...responder.panHandlers} style={StyleSheet.absoluteFill} />
      </View>
    );
  },
);

// ── Styles ──────────────────────────────────────────────────────────────

const nudgeBtnStyle = (size: number) => ({
  width: size, height: size, borderRadius: size / 2,
  backgroundColor: "rgba(180,100,255,0.5)",
  alignItems: "center" as const, justifyContent: "center" as const,
  margin: 2,
});

const nudgeText = { color: "#fff", fontSize: 14, fontWeight: "600" as const };

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
// Positions match the Blender model after +90° X rotation (Z-up).
// X = 1B foul line, Y = 3B foul line, Z = up. Origin = plate apex.
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
