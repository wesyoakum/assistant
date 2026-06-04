// Load a GLB field model and extract named empties as handle positions.
//
// Empties named "handle_*" become calibration landmarks. Their world-space
// position (after Z-up correction) is the field coordinate. Mesh objects
// render as the 3D overlay.
//
// glTF uses Y-up; Blender's glTF exporter converts Z-up → Y-up on export.
// We rotate the loaded scene -90° around X to restore Z-up in Three.js,
// then set camera.up = (0,0,1).

import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/addons/loaders/GLTFLoader.js";
import { Asset } from "expo-asset";

export interface HandlePoint {
  id: string;
  /** Field position in meters (Z-up), after Y-up → Z-up rotation. */
  position: THREE.Vector3;
}

export interface FieldModel {
  /** The root scene object (already rotated to Z-up). */
  scene: THREE.Group;
  /** Named calibration handles extracted from "handle_*" empties. */
  handles: HandlePoint[];
}

/**
 * Load a .glb asset and extract handle empties.
 *
 * @param assetModule  `require("../../assets/models/field.glb")`
 */
export async function loadFieldModel(assetModule: number): Promise<FieldModel> {
  // Resolve the asset to a local file URI.
  const [asset] = await Asset.loadAsync(assetModule);
  if (!asset?.localUri) throw new Error("Failed to load field model asset");

  // Use fetch() to read the local file as an ArrayBuffer.
  // This is more reliable than FileSystem + atob in Hermes.
  const response = await fetch(asset.localUri);
  const arrayBuffer = await response.arrayBuffer();

  // Parse with GLTFLoader.
  const gltf = await new Promise<GLTF>((resolve, reject) => {
    const loader = new GLTFLoader();
    loader.parse(arrayBuffer, "", resolve, reject);
  });

  // Rotate from glTF Y-up to our Z-up convention.
  const root = new THREE.Group();
  root.rotation.x = -Math.PI / 2;
  root.add(gltf.scene);
  root.updateMatrixWorld(true);

  // Extract empties whose name starts with "handle_".
  const handles: HandlePoint[] = [];
  root.traverse((node) => {
    if (!node.name.startsWith("handle_")) return;
    const wp = new THREE.Vector3();
    node.getWorldPosition(wp);
    handles.push({
      id: node.name.replace("handle_", ""),
      position: wp,
    });
  });

  return { scene: root, handles };
}
