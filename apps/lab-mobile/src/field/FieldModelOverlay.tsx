// 3D field model overlay with integrated calibration handles.
//
// Replaces BatterBoxOverlay entirely: the Blender GLB provides both the
// rendered field geometry AND the calibration handle positions (empties).
// Touch-draggable handle dots are positioned absolutely over the GLView.
//
// Workflow:
//   1. GLB loads → handles extracted → projected to screen via default camera
//   2. User drags handles to match video landmarks → anchor on release
//   3. With 4+ anchored handles, homography auto-solves → camera syncs →
//      3D model aligns with the video frame

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
  fieldToImage,
  type Correspondence,
  type HomographyFit,
} from "./videoHomography";
import { type CameraPose } from "./batterBox";
import { decomposeCameraPose, intrinsicsFromFov } from "./cameraPoseDecompose";

// ── Public interface ────────────────────────────────────────────────────

export interface FieldModelOverlayProps {
  imageWidth: number;
  imageHeight: number;
  vp: { scale: number; tx: number; ty: number };
  canvas: { width: number; height: number };
  canvasPageOffset: { x: number; y: number };
}

/** Same imperative interface as the old BatterBoxOverlay so TrackerTab
 *  can swap in without changes. */
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

const ANCHORED_COLOR = "rgba(0,255,100,0.95)";
const ACTIVE_COLOR = "rgba(255,220,0,0.95)";
const FREE_COLOR = "rgba(255,255,255,0.6)";
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
    // positions: normalized image coords (0-1) per handle id
    const [positions, setPositions] = useState<Record<string, { nx: number; ny: number }>>({});
    const [anchored, setAnchored] = useState<Record<string, boolean>>({});
    const [activeId, setActiveId] = useState<string | null>(null);
    const [handles, setHandles] = useState<HandlePoint[]>([]);

    const posRef = useRef(positions);
    posRef.current = positions;
    const anchoredRef = useRef(anchored);
    anchoredRef.current = anchored;
    const handlesRef = useRef(handles);
    handlesRef.current = handles;

    // Build field coord lookup from model handles.
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
        image: {
          u: positions[id]!.nx * imageWidth,
          v: positions[id]!.ny * imageHeight,
        },
      }));
      return fitHomography(corr);
    }, [anchored, positions, anchorCount, anchoredIds, imageWidth, imageHeight, fieldById]);

    // ── Sync Three.js camera when homography is solved ────────────────
    useEffect(() => {
      const cam = cameraRef.current;
      if (!cam || !homography) return;

      const hFovDeg = 69; // TODO: pass from video metadata
      const K = intrinsicsFromFov(imageWidth, imageHeight, hFovDeg);
      const pose = decomposeCameraPose(homography.H, K);
      if (!pose) return;

      cam.position.set(pose.position.x, pose.position.y, pose.position.z);
      cam.rotation.order = "ZXY";
      const d2r = Math.PI / 180;
      cam.rotation.z = -pose.panDeg * d2r;
      cam.rotation.x = (90 + pose.tiltDeg) * d2r;
      cam.rotation.y = pose.rollDeg * d2r;

      const aspect = imageWidth / imageHeight;
      cam.fov =
        2 * Math.atan(Math.tan((hFovDeg * d2r) / 2) / aspect) * (180 / Math.PI);
      cam.aspect = canvas.width / canvas.height;
      cam.updateProjectionMatrix();
    }, [homography, imageWidth, imageHeight, canvas]);

    // ── Coordinate transforms ─────────────────────────────────────────
    const imageToScreen = useCallback(
      (nx: number, ny: number) => {
        const cx = canvas.width / 2;
        const cy = canvas.height / 2;
        return {
          x: (nx * canvas.width - cx) * vp.scale + cx + vp.tx,
          y: (ny * canvas.height - cy) * vp.scale + cy + vp.ty,
        };
      },
      [canvas, vp],
    );

    const screenToImage = useCallback(
      (sx: number, sy: number) => {
        const cx = canvas.width / 2;
        const cy = canvas.height / 2;
        const ix = (sx - cx - vp.tx) / vp.scale + cx;
        const iy = (sy - cy - vp.ty) / vp.scale + cy;
        return {
          nx: Math.max(0, Math.min(1, ix / canvas.width)),
          ny: Math.max(0, Math.min(1, iy / canvas.height)),
        };
      },
      [canvas, vp],
    );

    // Screen positions for rendering handle dots.
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

            // Find nearest handle.
            let nearId = hs[0]?.id ?? "";
            let nearDist = Infinity;
            for (const h of hs) {
              const s = sh[h.id];
              if (!s) continue;
              const d = Math.hypot(lx - s.x, ly - s.y);
              if (d < nearDist) {
                nearDist = d;
                nearId = h.id;
              }
            }

            const handlePos = posRef.current[nearId] ?? { nx: 0.5, ny: 0.5 };
            dragRef.current = {
              id: nearId,
              offset: {
                dnx: handlePos.nx - touchImg.nx,
                dny: handlePos.ny - touchImg.ny,
              },
            };
            setActiveId(nearId);
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

            // Rigid-body transform around an anchor point.
            const anchorId =
              drag.id === "plate_apex"
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
              const rot =
                Math.atan2(iiy, iix) - Math.atan2(ffy, ffx);
              const cosR = Math.cos(rot) * scale;
              const sinR = Math.sin(rot) * scale;

              const MAX_STEP = 0.03;
              function limit(target: number, current: number): number {
                const delta = target - current;
                if (Math.abs(delta) <= MAX_STEP) return target;
                return current + Math.sign(delta) * MAX_STEP;
              }

              const next: Record<string, { nx: number; ny: number }> = {};
              for (const h of handlesRef.current) {
                if (h.id === anchorId) {
                  next[h.id] = anchorImg;
                } else if (
                  anchoredRef.current[h.id] &&
                  h.id !== drag.id
                ) {
                  next[h.id] = prev[h.id]!;
                } else if (h.id === drag.id) {
                  next[h.id] = newPos;
                } else {
                  const fx = fieldById[h.id]!.x - anchorField.x;
                  const fy = fieldById[h.id]!.y - anchorField.y;
                  const targetNx = anchorImg.nx + cosR * fx - sinR * fy;
                  const targetNy = anchorImg.ny + sinR * fx + cosR * fy;
                  const cur = prev[h.id] ?? { nx: 0.5, ny: 0.5 };
                  next[h.id] = {
                    nx: limit(targetNx, cur.nx),
                    ny: limit(targetNy, cur.ny),
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
                // Tap anchored → unanchor.
                setAnchored((prev) => {
                  const n = { ...prev };
                  delete n[drag.id];
                  return n;
                });
              } else if (didMoveRef.current) {
                // Dragged → anchor (cap at 4 unless already anchored).
                setAnchored((prev) => {
                  const count = Object.values(prev).filter(Boolean).length;
                  if (count >= 4 && !prev[drag.id]) return prev;
                  return { ...prev, [drag.id]: true };
                });
              }
            }
            setActiveId(null);
            dragRef.current = null;
          },
          onPanResponderTerminate: () => {
            setActiveId(null);
            dragRef.current = null;
          },
        }),
      [canvasPageOffset, screenToImage, anchoredIds, fieldById],
    );

    // ── Imperative handle (matches BatterBoxOverlayHandle) ────────────
    useImperativeHandle(
      ref,
      () => ({
        solve: (): CameraPose | null =>
          homography ? { fit: homography, sides: ["left", "right"] } : null,
        reset: () => {
          initDefaultPositions(handlesRef.current, fieldById);
          setAnchored({});
          setActiveId(null);
        },
        anchoredCount: () => anchorCount,
        getState: () => ({ positions, anchored }),
        setState: (s) => {
          setPositions(s.positions);
          setAnchored(s.anchored);
        },
      }),
      [homography, anchorCount, positions, anchored, fieldById],
    );

    // Helper to set default handle screen positions from a virtual camera.
    function initDefaultPositions(
      hs: HandlePoint[],
      fById: Record<string, { x: number; y: number }>,
    ) {
      const cam = { x: 2, y: -10, z: 3 };
      const focus = { x: 0, y: 8, z: 0 };
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
        const dx = f.x - cam.x;
        const dy = f.y - cam.y;
        const dz = 0 - cam.z;
        const cx2 = right[0]! * dx + right[1]! * dy + right[2]! * dz;
        const cy2 = camUp[0]! * dx + camUp[1]! * dy + camUp[2]! * dz;
        const cz2 = fwd[0]! * dx + fwd[1]! * dy + fwd[2]! * dz;
        if (cz2 < 0.01) {
          result[h.id] = { nx: 0.5, ny: 0.5 };
        } else {
          result[h.id] = {
            nx: 0.5 + fx * (cx2 / cz2),
            ny: 0.5 - fx * (cy2 / cz2),
          };
        }
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
          60,
          gl.drawingBufferWidth / gl.drawingBufferHeight,
          0.1,
          500,
        );
        camera.up.set(0, 0, 1);
        camera.position.set(0, -15, 5);
        camera.lookAt(0, 10, 0);
        cameraRef.current = camera;

        scene.add(new THREE.AmbientLight(0xffffff, 0.6));
        const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
        dirLight.position.set(5, -5, 10);
        scene.add(dirLight);

        try {
          const model = await loadFieldModel(
            require("../../assets/models/field.glb"),
          );
          modelRef.current = model;
          scene.add(model.scene);

          // Initialize handle state from model empties.
          setHandles(model.handles);
          const fById: Record<string, { x: number; y: number }> = {};
          for (const h of model.handles)
            fById[h.id] = { x: h.position.x, y: h.position.y };
          initDefaultPositions(model.handles, fById);

          console.log(
            "[FieldModelOverlay] loaded",
            model.handles.length,
            "handles:",
            model.handles.map((h) => h.id).join(", "),
          );
        } catch (e) {
          console.warn("[FieldModelOverlay] GLB load failed:", e);
        }

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

    // Cleanup
    useEffect(() => {
      return () => {
        cancelAnimationFrame(rafRef.current);
        rendererRef.current?.dispose();
      };
    }, []);

    // ── Render ────────────────────────────────────────────────────────
    return (
      <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
        {/* 3D scene */}
        <GLView
          style={{ width: canvas.width, height: canvas.height }}
          onContextCreate={onContextCreate}
          pointerEvents="none"
        />

        {/* Handle dots (absolute-positioned Views) */}
        {handles.map((h) => {
          const s = screenHandles[h.id];
          if (!s) return null;
          const isA = !!anchored[h.id];
          const isAct = activeId === h.id;
          const color = isAct
            ? ACTIVE_COLOR
            : isA
              ? ANCHORED_COLOR
              : FREE_COLOR;
          return (
            <View
              key={h.id}
              pointerEvents="none"
              style={{
                position: "absolute",
                left: s.x - HANDLE_R,
                top: s.y - HANDLE_R,
                width: HANDLE_R * 2,
                height: HANDLE_R * 2,
                borderRadius: HANDLE_R,
                borderWidth: isA || isAct ? 2 : 1,
                borderColor: color,
                backgroundColor:
                  isAct
                    ? "rgba(255,220,0,0.35)"
                    : isA
                      ? "rgba(0,255,100,0.25)"
                      : "rgba(255,255,255,0.08)",
                alignItems: "center",
                justifyContent: "center",
              }}
            />
          );
        })}

        {/* Handle labels */}
        {handles.map((h) => {
          const s = screenHandles[h.id];
          if (!s) return null;
          const isA = !!anchored[h.id];
          const isAct = activeId === h.id;
          const color = isAct
            ? ACTIVE_COLOR
            : isA
              ? ANCHORED_COLOR
              : FREE_COLOR;
          return (
            <Text
              key={`lbl-${h.id}`}
              pointerEvents="none"
              style={{
                position: "absolute",
                left: s.x - 30,
                top: s.y - HANDLE_R - 14,
                width: 60,
                textAlign: "center",
                color,
                fontSize: 7,
                fontWeight: "600",
              }}
            >
              {h.id}
            </Text>
          );
        })}

        {/* Status text */}
        <Text
          pointerEvents="none"
          style={{
            position: "absolute",
            left: 10,
            top: 8,
            color:
              anchorCount >= 4 ? ANCHORED_COLOR : "rgba(255,200,0,0.9)",
            fontSize: 11,
            fontWeight: "600",
          }}
        >
          {anchorCount >= 4 && homography
            ? `${anchorCount} anchored · RMS ${homography.rmsPx.toFixed(1)}px`
            : `${anchorCount}/4 anchored`}
        </Text>

        {/* Touch surface */}
        <View {...responder.panHandlers} style={StyleSheet.absoluteFill} />
      </View>
    );
  },
);
