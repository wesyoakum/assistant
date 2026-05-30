import React from "react";
import Svg, { Circle, Line, Polyline, Polygon } from "react-native-svg";
import { StyleSheet } from "react-native";
import type { PlatePipelineDebug, Point2 } from "./plateDetect";

// Visual debugger for the plate-detection pipeline (AR_WORLD_ANCHOR §4). Draws
// each stage as a separately toggleable, stroke-only layer over the AR view, so
// you can see on a real field which step is working and which is failing:
//
//   region   — traced white-region outline      (thin green polyline)
//   dp       — Douglas–Peucker seed corners      (small orange dots)
//   edges    — the 5 fitted edge lines           (thin blue segments)
//   corners  — line intersections (recovered)    (red dots)
//   snapped  — the known plate snapped to the fit (cyan polygon outline)
//
// All inputs are in **view-normalized** coordinates (x,y in 0..1), the same
// space LidarARView.detectPlateContours emits. We scale by the rendered view
// size. Pure presentational — no detection logic here; it just renders a
// PlatePipelineDebug from runPlatePipelineDebug().

export interface PlateDebugLayers {
  region: boolean;
  dp: boolean;
  edges: boolean;
  corners: boolean;
  snapped: boolean;
}

export const DEFAULT_DEBUG_LAYERS: PlateDebugLayers = {
  region: true,
  dp: true,
  edges: true,
  corners: true,
  snapped: true,
};

const COLORS = {
  region: "#34C759",   // green
  dp: "#FF9500",       // orange
  edges: "#0A84FF",    // blue
  corners: "#FF3B30",  // red
  snapped: "#32D7E0",  // cyan
};

// Pipeline points are already in PIXEL space (ar.tsx scales the native
// normalized contour by the view size before fitting — fitPlateTemplate needs
// isotropic coords). So we plot them directly; width/height only size the canvas.
function ptsAttr(points: Point2[]): string {
  return points.map((p) => `${p.x},${p.y}`).join(" ");
}

export function PlateDebugOverlay({
  debug,
  layers,
  width,
  height,
}: {
  debug: PlatePipelineDebug | null;
  layers: PlateDebugLayers;
  width: number;
  height: number;
}) {
  if (!debug || width <= 0 || height <= 0) return null;
  const W = width, H = height;

  return (
    <Svg style={StyleSheet.absoluteFill} pointerEvents="none" width={W} height={H}>
      {/* Region outline (stroke only — no fill) */}
      {layers.region && debug.contour.length >= 2 && (
        <Polyline
          points={ptsAttr([...debug.contour, debug.contour[0]!])}
          fill="none"
          stroke={COLORS.region}
          strokeWidth={1.5}
          strokeOpacity={0.9}
        />
      )}

      {/* Fitted edge lines (blue segments between recovered corners) */}
      {layers.edges && debug.edgeLines.map((e, i) => (
        <Line
          key={`edge-${i}`}
          x1={e.from.x} y1={e.from.y}
          x2={e.to.x} y2={e.to.y}
          stroke={COLORS.edges}
          strokeWidth={2}
          strokeOpacity={0.95}
        />
      ))}

      {/* Snapped known-plate outline (cyan polygon) */}
      {layers.snapped && debug.snappedCorners && debug.snappedCorners.length === 5 && (
        <Polygon
          points={ptsAttr(debug.snappedCorners)}
          fill="none"
          stroke={COLORS.snapped}
          strokeWidth={2.5}
          strokeOpacity={0.95}
        />
      )}

      {/* DP seed corners (orange dots) */}
      {layers.dp && debug.seedCorners?.map((p, i) => (
        <Circle key={`dp-${i}`} cx={p.x} cy={p.y} r={4} fill={COLORS.dp} fillOpacity={0.9} />
      ))}

      {/* Recovered corners from intersection (red dots; hollow if seed-fallback) */}
      {layers.corners && debug.intersections?.map((p, i) => {
        const ok = debug.cornerOk?.[i] ?? true;
        return (
          <Circle
            key={`corner-${i}`}
            cx={p.x}
            cy={p.y}
            r={5}
            fill={ok ? COLORS.corners : "none"}
            stroke={COLORS.corners}
            strokeWidth={ok ? 0 : 2}
            fillOpacity={0.95}
          />
        );
      })}
    </Svg>
  );
}
