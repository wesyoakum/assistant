// Multi-track ball detection manager.
//
// Segments a stream of per-frame detections into independent free-flight
// tracks. Each track has its own motion model, prediction gate, and lifecycle.
// A pitch that's hit becomes two tracks. False detections don't corrupt
// valid tracks.

import { type MotionModel, PolynomialMotionModel } from "./motionModel";
import { lsqQuadratic, computeR2 } from "./polyFit";

// ── Types ──

export type TrackState = "candidate" | "confirmed" | "ended" | "archived";

export interface Detection {
  frameIndex: number;
  timeSec: number;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
}

export interface Track {
  id: number;
  state: TrackState;
  detections: Detection[];
  rejectedDetections: Detection[];
  startFrame: number;
  endFrame: number;
  lastUpdateFrame: number;
  missedFrameCount: number;
  confidence: number;
  reasonEnded: string | null;
  model: MotionModel;
  /** Consecutive frames with residual above break threshold. */
  highResidualStreak: number;
}

export interface TrackManagerConfig {
  maxMissedFrames: number;
  candidateMinDetections: number;
  candidateMaxAge: number;
  activeTrackGateThreshold: number;
  breakResidualThreshold: number;
  breakResidualFrameCount: number;
  recentBufferSeconds: number;
  minTrackDuration: number;
  frameRate: number;
  r2Threshold: number;
}

interface FrameLike {
  box: { x: number; y: number; width: number; height: number } | null;
  lost: boolean;
  confidence: number;
  timeSec: number;
  frameIndex: number;
}

const DEFAULTS: TrackManagerConfig = {
  maxMissedFrames: 5,
  candidateMinDetections: 3,
  candidateMaxAge: 10,
  activeTrackGateThreshold: 0.08,
  breakResidualThreshold: 0.06,
  breakResidualFrameCount: 3,
  recentBufferSeconds: 0.5,
  minTrackDuration: 3,
  r2Threshold: 0.95,
  frameRate: 30,
};

// ── TrackManager ──

export class TrackManager {
  private config: TrackManagerConfig;
  private tracks: Track[] = [];
  private nextId = 1;
  private log: string[] = [];

  constructor(config: Partial<TrackManagerConfig> = {}) {
    this.config = { ...DEFAULTS, ...config };
    // Scale gate threshold by frame rate: at 60fps the ball moves half as
    // far per frame as at 30fps.
    this.config.activeTrackGateThreshold *=
      30 / Math.max(1, this.config.frameRate);
  }

  /** Process a full array of tracked frames and return segmented tracks. */
  processFrames(frames: FrameLike[]): Track[] {
    this.reset();
    for (const f of frames) this.addFrame(f);
    return this.finalize();
  }

  /** Reset state for a new run. */
  reset(): void {
    this.tracks = [];
    this.nextId = 1;
    this.log = [];
  }

  /** Feed a single frame incrementally. Call during streaming. */
  addFrame(frame: FrameLike): void {
    const det = this.extractDetection(frame, frame.frameIndex);
    this.processFrame(frame.frameIndex, frame.timeSec, det);
  }

  /** Get current tracks (including near-promoted candidates) for streaming UI. */
  getTracks(): Track[] {
    return this.tracks
      .filter(
        (t) =>
          t.state === "confirmed" ||
          t.state === "archived" ||
          (t.state === "candidate" && t.detections.length >= 2),
      )
      .sort((a, b) => a.startFrame - b.startFrame);
  }

  /** Finalize: end active tracks, archive qualifying ones. Call when detection completes. */
  finalize(): Track[] {
    for (const t of this.activeTracks()) {
      this.endTrack(t, "video_end");
    }
    for (const t of this.tracks) {
      if (t.state === "ended" && t.detections.length >= this.config.minTrackDuration) {
        t.state = "archived";
      }
    }
    return this.getTracks();
  }

  /** Get the internal log (for debugging). */
  getLog(): string[] {
    return this.log;
  }

  // ── Private ──

  private extractDetection(f: FrameLike, index: number): Detection | null {
    if (!f.box || f.lost) return null;
    return {
      frameIndex: index,
      timeSec: f.timeSec,
      x: f.box.x + f.box.width / 2,
      y: f.box.y + f.box.height / 2,
      width: f.box.width,
      height: f.box.height,
      confidence: f.confidence,
    };
  }

  private processFrame(
    frameIndex: number,
    _timeSec: number,
    detection: Detection | null,
  ): void {
    const active = this.activeTracks();

    if (detection) {
      const match = this.findBestMatch(detection, active);

      if (match) {
        // Check for trajectory break before updating.
        const residual = match.model.residual(
          detection.timeSec,
          detection.x,
          detection.y,
        );

        // Velocity discontinuity check.
        const prevVel = match.model.velocity();
        if (prevVel && match.model.pointCount() >= 3) {
          // Temporarily update to get new velocity.
          const clone = match.model.clone();
          clone.update(detection.timeSec, detection.x, detection.y);
          const newVel = clone.velocity();
          if (newVel) {
            const dot =
              prevVel.vx * newVel.vx + prevVel.vy * newVel.vy;
            const magPrev = Math.hypot(prevVel.vx, prevVel.vy);
            const magNew = Math.hypot(newVel.vx, newVel.vy);
            const normDot =
              magPrev > 1e-6 && magNew > 1e-6
                ? dot / (magPrev * magNew)
                : 1;
            if (normDot < -0.3) {
              this.addLog(
                `Track ${match.id}: velocity reversal (dot=${normDot.toFixed(2)}), breaking`,
              );
              this.endTrack(match, "velocity_reversal");
              this.startCandidate(detection);
              this.advanceMissed(frameIndex, null);
              return;
            }
          }
        }

        // High residual streak check.
        if (residual > this.config.breakResidualThreshold) {
          match.highResidualStreak++;
          if (
            match.highResidualStreak >= this.config.breakResidualFrameCount
          ) {
            this.addLog(
              `Track ${match.id}: high residual streak (${match.highResidualStreak}), breaking`,
            );
            this.endTrack(match, "high_residual_streak");
            this.startCandidate(detection);
            this.advanceMissed(frameIndex, null);
            return;
          }
        } else {
          match.highResidualStreak = 0;
        }

        this.updateTrack(match, detection, frameIndex);
        this.advanceMissed(frameIndex, match.id);
      } else {
        // No match — detection is outside all active tracks' gates.
        // If there was a confirmed track, this likely means a new trajectory.
        const confirmed = active.find((t) => t.state === "confirmed");
        if (confirmed) {
          this.addLog(
            `Track ${confirmed.id}: detection outside gate, ending`,
          );
          this.endTrack(confirmed, "gate_miss");
        }
        this.startCandidate(detection);
        this.advanceMissed(frameIndex, null);
      }
    } else {
      // No detection this frame.
      this.advanceMissed(frameIndex, null);
    }

    this.tryPromoteCandidates();
    this.expireStaleCandidates(frameIndex);
  }

  private findBestMatch(
    det: Detection,
    active: Track[],
  ): Track | null {
    let bestTrack: Track | null = null;
    let bestResidual = Infinity;

    for (const t of active) {
      if (t.model.pointCount() === 0) continue;
      const r = t.model.residual(det.timeSec, det.x, det.y);
      if (r < this.config.activeTrackGateThreshold && r < bestResidual) {
        bestResidual = r;
        bestTrack = t;
      }
    }

    return bestTrack;
  }

  private updateTrack(
    track: Track,
    det: Detection,
    frameIndex: number,
  ): void {
    track.detections.push(det);
    track.model.update(det.timeSec, det.x, det.y);
    track.lastUpdateFrame = frameIndex;
    track.endFrame = frameIndex;
    track.missedFrameCount = 0;
    track.confidence =
      track.detections.reduce((s, d) => s + d.confidence, 0) /
      track.detections.length;
  }

  private startCandidate(det: Detection): void {
    const track: Track = {
      id: this.nextId++,
      state: "candidate",
      detections: [det],
      rejectedDetections: [],
      startFrame: det.frameIndex,
      endFrame: det.frameIndex,
      lastUpdateFrame: det.frameIndex,
      missedFrameCount: 0,
      confidence: det.confidence,
      reasonEnded: null,
      model: new PolynomialMotionModel(this.config.recentBufferSeconds),
      highResidualStreak: 0,
    };
    track.model.update(det.timeSec, det.x, det.y);
    this.tracks.push(track);
    this.addLog(
      `Track ${track.id}: candidate started at frame ${det.frameIndex}`,
    );
  }

  private tryPromoteCandidates(): void {
    for (const t of this.tracks) {
      if (t.state !== "candidate") continue;
      if (t.detections.length < this.config.candidateMinDetections) continue;

      // Validate trajectory quality via R².
      if (t.detections.length >= 3) {
        const tMin = t.detections[0]!.timeSec;
        const pts = t.detections.map((d) => ({
          tn: d.timeSec - tMin,
          cx: d.x,
          cy: d.y,
        }));
        const ts = pts.map((p) => p.tn);
        const fitX = lsqQuadratic(ts, pts.map((p) => p.cx));
        const fitY = lsqQuadratic(ts, pts.map((p) => p.cy));
        const r2 = computeR2(pts, fitX, fitY);
        if (r2 < this.config.r2Threshold) continue; // Not a plausible trajectory.
      }

      t.state = "confirmed";
      this.addLog(
        `Track ${t.id}: promoted to confirmed (${t.detections.length} pts)`,
      );
    }
  }

  private advanceMissed(frameIndex: number, matchedId: number | null): void {
    for (const t of this.activeTracks()) {
      if (t.id === matchedId) continue;
      t.missedFrameCount++;
      if (t.missedFrameCount > this.config.maxMissedFrames) {
        this.endTrack(t, "max_missed_frames");
      }
    }
  }

  private expireStaleCandidates(frameIndex: number): void {
    for (const t of this.tracks) {
      if (t.state !== "candidate") continue;
      if (frameIndex - t.startFrame > this.config.candidateMaxAge) {
        this.endTrack(t, "candidate_expired");
      }
    }
  }

  private endTrack(track: Track, reason: string): void {
    if (track.state === "ended" || track.state === "archived") return;
    track.state = "ended";
    track.reasonEnded = reason;
    this.addLog(
      `Track ${track.id}: ended (${reason}, ${track.detections.length} pts)`,
    );
  }

  private activeTracks(): Track[] {
    return this.tracks.filter(
      (t) => t.state === "candidate" || t.state === "confirmed",
    );
  }

  private addLog(msg: string): void {
    this.log.push(msg);
  }
}
