// Lightweight 3D field model overlay — renders the GLB model projected onto
// the video using a pre-computed camera pose. No handle editing, just display.

import React, { useEffect, useRef, useCallback } from "react";
import { StyleSheet } from "react-native";
import { GLView } from "expo-gl";
import * as THREE from "three";
import { loadFieldModel, type FieldModel } from "./loadFieldModel";
import type { Homography } from "./videoHomography";
import type { CameraIntrinsics } from "./cameraPoseDecompose";

interface Props {
  H: Homography;
  K: CameraIntrinsics;
  imageWidth: number;
  imageHeight: number;
  canvasWidth: number;
  canvasHeight: number;
  opacity?: number;
}

function mul3x3(A: number[], B: number[]): number[] {
  const C = new Array(9).fill(0);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      for (let k = 0; k < 3; k++)
        C[r * 3 + c] += A[r * 3 + k]! * B[k * 3 + c]!;
  return C;
}

function cross3(a: number[], b: number[]): number[] {
  return [
    a[1]! * b[2]! - a[2]! * b[1]!,
    a[2]! * b[0]! - a[0]! * b[2]!,
    a[0]! * b[1]! - a[1]! * b[0]!,
  ];
}

export function FieldModelView({ H, K, imageWidth, imageHeight, canvasWidth, canvasHeight, opacity = 0.5 }: Props) {
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const modelRef = useRef<FieldModel | null>(null);
  const rafRef = useRef<number>(0);
  const propsRef = useRef({ H, K, imageWidth, imageHeight, canvasWidth, canvasHeight, opacity });
  propsRef.current = { H, K, imageWidth, imageHeight, canvasWidth, canvasHeight, opacity };

  const onContextCreate = useCallback(async (gl: any) => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, canvasWidth / canvasHeight, 0.01, 1000);
    camera.up.set(0, 0, 1);
    const renderer = new THREE.WebGLRenderer({ context: gl, alpha: true });
    renderer.setSize(canvasWidth, canvasHeight);
    renderer.setClearColor(0x000000, 0);
    sceneRef.current = scene;
    cameraRef.current = camera;
    rendererRef.current = renderer;

    // Load model.
    try {
      const model = await loadFieldModel(require("../../assets/models/field.glb"));
      modelRef.current = model;
      scene.add(model.scene);
      // Set model materials to semi-transparent.
      model.scene.traverse((node) => {
        if ((node as THREE.Mesh).isMesh) {
          const mesh = node as THREE.Mesh;
          const mat = mesh.material as THREE.MeshBasicMaterial;
          if (mat) {
            mat.transparent = true;
            mat.opacity = opacity;
            mat.depthWrite = false;
          }
        }
      });
    } catch {}

    // Ambient light.
    scene.add(new THREE.AmbientLight(0xffffff, 1));

    const render = () => {
      const p = propsRef.current;
      // Update renderer size if canvas changed.
      const cw = Math.max(1, Math.round(p.canvasWidth));
      const ch = Math.max(1, Math.round(p.canvasHeight));
      if (renderer.domElement.width !== cw || renderer.domElement.height !== ch) {
        renderer.setSize(cw, ch);
        camera.aspect = cw / ch;
      }
      syncCamera(camera, p.H, p.K, p.imageWidth, p.imageHeight, cw, ch);
      // Update opacity.
      modelRef.current?.scene.traverse((node) => {
        if ((node as THREE.Mesh).isMesh) {
          const mat = (node as THREE.Mesh).material as THREE.MeshBasicMaterial;
          if (mat && mat.opacity !== p.opacity) mat.opacity = p.opacity;
        }
      });
      renderer.render(scene, camera);
      gl.endFrameEXP();
      rafRef.current = requestAnimationFrame(render);
    };
    render();
  }, []);

  useEffect(() => () => { cancelAnimationFrame(rafRef.current); rendererRef.current?.dispose(); }, []);

  return (
    <GLView
      style={{ width: canvasWidth, height: canvasHeight }}
      onContextCreate={onContextCreate}
      pointerEvents="none"
    />
  );
}

function syncCamera(
  camera: THREE.PerspectiveCamera,
  H: Homography,
  K: CameraIntrinsics,
  imageWidth: number, imageHeight: number,
  _canvasWidth: number, _canvasHeight: number,
) {
  // Use the same projection approach as FieldModelOverlay — build the full
  // projection matrix directly from the homography + K·r3 column.
  const ifx = 1 / K.fx, ify = 1 / K.fy;
  const Kinv = [ifx, 0, -K.cx * ifx, 0, ify, -K.cy * ify, 0, 0, 1];
  const M = mul3x3(Kinv, H);
  const c0 = [M[0]!, M[3]!, M[6]!];
  const c1 = [M[1]!, M[4]!, M[7]!];

  let lambda = Math.sqrt(c0[0]! ** 2 + c0[1]! ** 2 + c0[2]! ** 2);
  if (lambda < 1e-10) return;
  if (M[8]! / lambda < 0) lambda = -lambda;

  const r1 = c0.map((v) => v / lambda);
  const r2 = c1.map((v) => v / lambda);
  const r3 = cross3(r1, r2);

  // Build Z column: K * r3 * lambda (to match homography scale).
  const Kz0 = lambda * (K.fx * r3[0]! + K.cx * r3[2]!);
  const Kz1 = lambda * (K.fy * r3[1]! + K.cy * r3[2]!);
  const Kz2 = lambda * r3[2]!;

  const P00 = H[0]!, P01 = H[1]!, P02 = Kz0, P03 = H[2]!;
  const P10 = H[3]!, P11 = H[4]!, P12 = Kz1, P13 = H[5]!;
  const P20 = H[6]!, P21 = H[7]!, P22 = Kz2, P23 = H[8]!;
  const W = imageWidth, Hi = imageHeight;

  camera.matrixAutoUpdate = false;
  camera.matrix.identity();
  camera.matrixWorld.identity();
  camera.matrixWorldInverse.identity();
  camera.projectionMatrix.set(
    2*P00/W - P20,   2*P01/W - P21,   2*P02/W - P22,   2*P03/W - P23,
    P20 - 2*P10/Hi,  P21 - 2*P11/Hi,  P22 - 2*P12/Hi,  P23 - 2*P13/Hi,
    -P20 * 0.001,    -P21 * 0.001,     -P22 * 0.001,     -P23 * 0.001,
    P20,              P21,              P22,              P23,
  );
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
}
