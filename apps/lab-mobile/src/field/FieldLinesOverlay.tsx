// Projected field lines overlay on the video.
// Renders foul lines, basepaths, home plate, base diamonds, and optional strike zone
// in bright pink, using the camera homography to project from field to image space.

import React, { useMemo } from "react";
import { StyleSheet } from "react-native";
import Svg, { Path, Rect as SvgRect } from "react-native-svg";
import { fieldToImage, type Homography } from "./videoHomography";
import { projectFieldPoint3D, type CameraIntrinsics } from "./cameraPoseDecompose";

const PINK = "#FF78B4";
const FT_TO_M = 0.3048;

interface Props {
  H: Homography;
  imageWidth: number;
  imageHeight: number;
  basepathFt: number;
  showField: boolean;
  showZone: boolean;
  strikeZoneTopIn?: number;
  strikeZoneBottomIn?: number;
  K?: CameraIntrinsics | null;
}

export function FieldLinesOverlay({
  H, imageWidth, imageHeight, basepathFt, showField, showZone,
  strikeZoneTopIn = 42, strikeZoneBottomIn = 20, K,
}: Props) {
  // Project a ground-plane user-space point (meters) to normalized image coords (0-1).
  const proj = (ux: number, uy: number): { x: number; y: number } | null => {
    const p = fieldToImage(H, { x: ux, y: uy });
    if (!p) return null;
    return { x: p.x / imageWidth, y: p.y / imageHeight };
  };

  // Project a 3D user-space point to normalized coords.
  const proj3D = (ux: number, uy: number, heightFt: number): { x: number; y: number } | null => {
    if (!K) return null;
    const p = projectFieldPoint3D({ x: ux, y: uy, z: heightFt * FT_TO_M }, H, K);
    if (!p) return null;
    return { x: p.u / imageWidth, y: p.v / imageHeight };
  };

  const fieldPath = useMemo(() => {
    if (!showField) return "";
    const bp = basepathFt * FT_TO_M;
    const parts: string[] = [];

    // User coords: X→1B foul line, Y→3B foul line, origin at apex.
    // Bases: 1B=(bp,0), 2B=(bp,bp), 3B=(0,bp)
    const foulEnd = bp * 3;
    const apex = proj(0, 0);
    const f1b = proj(foulEnd, 0);
    const f3b = proj(0, foulEnd);
    if (apex && f1b) parts.push(`M ${apex.x} ${apex.y} L ${f1b.x} ${f1b.y}`);
    if (apex && f3b) parts.push(`M ${apex.x} ${apex.y} L ${f3b.x} ${f3b.y}`);

    // Basepaths: apex → 1B → 2B → 3B → apex.
    const b1b = proj(bp, 0);
    const b2b = proj(bp, bp);
    const b3b = proj(0, bp);
    if (apex && b1b && b2b && b3b) {
      parts.push(`M ${apex.x} ${apex.y} L ${b1b.x} ${b1b.y} L ${b2b.x} ${b2b.y} L ${b3b.x} ${b3b.y} Z`);
    }

    // Home plate pentagon in user coords.
    // Plate front direction is toward 2B: (1,1)/sqrt(2)
    // Plate right direction is toward 1B from center: (1,-1)/sqrt(2)
    const D = Math.SQRT1_2;
    const plateFrontFt = 17 / 12;
    const halfWFt = 8.5 / 12;
    const sideDFt = 8.5 / 12;
    const fwd = { x: D * FT_TO_M, y: D * FT_TO_M };
    const rgt = { x: D * FT_TO_M, y: -D * FT_TO_M };
    const fc = { x: plateFrontFt * fwd.x, y: plateFrontFt * fwd.y };
    const plateCorners = [
      { x: 0, y: 0 }, // apex
      { x: (sideDFt) * fwd.x + halfWFt * rgt.x, y: (sideDFt) * fwd.y + halfWFt * rgt.y }, // right bevel
      { x: fc.x + halfWFt * rgt.x, y: fc.y + halfWFt * rgt.y }, // front right
      { x: fc.x - halfWFt * rgt.x, y: fc.y - halfWFt * rgt.y }, // front left
      { x: (sideDFt) * fwd.x - halfWFt * rgt.x, y: (sideDFt) * fwd.y - halfWFt * rgt.y }, // left bevel
    ];
    const platePts = plateCorners.map((c) => proj(c.x, c.y)).filter(Boolean) as Array<{ x: number; y: number }>;
    if (platePts.length === 5) {
      parts.push(`M ${platePts[0]!.x} ${platePts[0]!.y} ${platePts.slice(1).map((p) => `L ${p.x} ${p.y}`).join(" ")} Z`);
    }

    return parts.join(" ");
  }, [showField, H, basepathFt, imageWidth, imageHeight]);

  const zonePath = useMemo(() => {
    if (!showZone || !K) return "";
    // Strike zone: vertical rectangle at the front of home plate.
    // In user coords, plate front center is along the (1,1)/sqrt(2) direction.
    const D = Math.SQRT1_2;
    const plateFrontFt = 17 / 12;
    const halfWidthFt = 8.5 / 12;
    const topFt = strikeZoneTopIn / 12;
    const botFt = strikeZoneBottomIn / 12;

    // Front edge center in user coords (meters).
    const fcx = plateFrontFt * D * FT_TO_M;
    const fcy = plateFrontFt * D * FT_TO_M;
    // Right direction (perpendicular to apex→2B): (1,-1)/sqrt(2).
    const rx = D * FT_TO_M, ry = -D * FT_TO_M;

    const corners = [
      proj3D(fcx + halfWidthFt * rx, fcy + halfWidthFt * ry, botFt),
      proj3D(fcx - halfWidthFt * rx, fcy - halfWidthFt * ry, botFt),
      proj3D(fcx - halfWidthFt * rx, fcy - halfWidthFt * ry, topFt),
      proj3D(fcx + halfWidthFt * rx, fcy + halfWidthFt * ry, topFt),
    ].filter(Boolean) as Array<{ x: number; y: number }>;

    if (corners.length < 4) return "";
    return `M ${corners[0]!.x} ${corners[0]!.y} ${corners.slice(1).map((p) => `L ${p.x} ${p.y}`).join(" ")} Z`;
  }, [showZone, H, K, strikeZoneTopIn, strikeZoneBottomIn, imageWidth, imageHeight]);

  if (!showField && !showZone) return null;

  return (
    <Svg style={StyleSheet.absoluteFill} viewBox="0 0 1 1" preserveAspectRatio="none">
      {fieldPath !== "" && (
        <Path d={fieldPath} stroke={PINK} strokeWidth={2} fill="none" vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
      )}
      {zonePath !== "" && (
        <>
          <Path d={zonePath} stroke={PINK} strokeWidth={2} fill="rgba(255,120,180,0.15)" vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
    </Svg>
  );
}
