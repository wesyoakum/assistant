// Ballistic flight tracker.
//
// Operates on 3D observations (mid-plane intersections from ray tracing).
// Maintains a single active ballistic trajectory. Rejects spurious detections
// via physics-based validation: quadratic fit quality, minimum speed, and
// prediction gating.
//
// State machine: CANDIDATE → VALIDATED → PENDING_REPLACEMENT → CLOSED
//
// Pure JS, no native deps → unit-testable.

import { lsqQuadratic, computeR2 } from "./polyFit";

// ── Types ──

export interface Observation3D {
  frameIndex: number;
  timeSec: number;
  yzY: number;       // distance toward 2B on mid-plane (meters)
  yzZ: number;       // height on mid-plane (meters)
  pixelX: number;    // original pixel center (normalized 0-1)
  pixelY: number;
  confidence: number;
  rayDir: { x: number; y: number; z: number };
}

export type BallisticTrackState = "candidate" | "validated" | "pending_replacement" | "closed";

export interface BallisticTrack {
  id: number;
  state: BallisticTrackState;
  observations: Observation3D[];
  fitY: number[] | null;   // [a, b, c] for yzY(t) = a*t² + b*t + c
  fitZ: number[] | null;   // [a, b, c] for yzZ(t)
  r2: number;
  speedMph: number;
  startFrame: number;
  endFrame: number;
  lastUpdateFrame: number;
  missedFrameCount: number;
  reasonClosed: string | null;
}

export interface BallisticTrackerConfig {
  minObservations: number;
  minSpeedMph: number;
  maxMissedFrames: number;
  observationMaxAge: number;
  gateThresholdM: number;
  pendingConfirmCount: number;
  r2Threshold: number;
  frameRate: number;
}

const DEFAULTS: BallisticTrackerConfig = {
  minObservations: 3,
  minSpeedMph: 20,
  maxMissedFrames: 15,
  observationMaxAge: 15,
  gateThresholdM: 1.0,        // 1 meter prediction gate
  pendingConfirmCount: 5,
  r2Threshold: 0.95,
  frameRate: 30,
};

const MPH_PER_MS = 2.23694; // m/s → mph

// ── BallisticTracker ──

export class BallisticTracker {
  private config: BallisticTrackerConfig;
  private tracks: BallisticTrack[] = [];
  private unassigned: Observation3D[] = [];
  private nextId = 1;
  private currentFrame = 0;
  private log: string[] = [];

  constructor(config: Partial<BallisticTrackerConfig> = {}) {
    this.config = { ...DEFAULTS, ...config };
  }

  /** Feed a single observation. Call for each frame with a valid detection. */
  addObservation(obs: Observation3D): void {
    this.currentFrame = obs.frameIndex;

    const active = this.getActiveTrack();
    const pending = this.getPendingTrack();

    // Try to assign to active validated track.
    if (active) {
      const residual = this.residual(active, obs);
      if (residual < this.config.gateThresholdM) {
        this.acceptObservation(active, obs);
        // Also check pending — if it exists, try to add there too.
        if (pending) {
          const pRes = this.residual(pending, obs);
          if (pRes < this.config.gateThresholdM) {
            this.acceptObservation(pending, obs);
            this.checkPendingPromotion(pending);
          } else {
            pending.missedFrameCount++;
          }
        }
        this.ageUnassigned();
        return;
      }
      // Outside gate — reject from active track.
      active.missedFrameCount++;
    }

    // Try to assign to pending replacement track.
    if (pending) {
      const pRes = this.residual(pending, obs);
      if (pRes < this.config.gateThresholdM) {
        this.acceptObservation(pending, obs);
        this.checkPendingPromotion(pending);
        this.ageUnassigned();
        return;
      }
      pending.missedFrameCount++;
    }

    // Unassigned — add to pool.
    this.unassigned.push(obs);
    this.ageUnassigned();
    this.tryCandidateFormation();
    this.checkMissedTracks();
  }

  /** Advance frame counter when there's no detection (lost frame). */
  tick(frameIndex: number): void {
    this.currentFrame = frameIndex;
    const active = this.getActiveTrack();
    if (active) active.missedFrameCount++;
    const pending = this.getPendingTrack();
    if (pending) pending.missedFrameCount++;
    this.ageUnassigned();
    this.checkMissedTracks();
  }

  /** Get the current active (validated) track, or null. */
  getActiveTrack(): BallisticTrack | null {
    return this.tracks.find((t) => t.state === "validated") ?? null;
  }

  /** Get the pending replacement track, or null. */
  getPendingTrack(): BallisticTrack | null {
    return this.tracks.find((t) => t.state === "pending_replacement") ?? null;
  }

  /** Get all closed tracks. */
  getClosedTracks(): BallisticTrack[] {
    return this.tracks.filter((t) => t.state === "closed");
  }

  /** Get frame indices belonging to the active track (for filtering detections). */
  getFilteredFrameIndices(): Set<number> {
    const active = this.getActiveTrack();
    const closed = this.getClosedTracks();
    const set = new Set<number>();
    if (active) for (const o of active.observations) set.add(o.frameIndex);
    for (const t of closed) for (const o of t.observations) set.add(o.frameIndex);
    return set;
  }

  /** Get the internal log (for debugging). */
  getLog(): string[] {
    return this.log;
  }

  // ── Private ──

  private acceptObservation(track: BallisticTrack, obs: Observation3D): void {
    track.observations.push(obs);
    track.endFrame = obs.frameIndex;
    track.lastUpdateFrame = obs.frameIndex;
    track.missedFrameCount = 0;
    this.refit(track);
  }

  private refit(track: BallisticTrack): void {
    const obs = track.observations;
    if (obs.length < 3) {
      track.fitY = null;
      track.fitZ = null;
      track.r2 = 0;
      track.speedMph = 0;
      return;
    }
    const ts = obs.map((o) => o.timeSec);
    const ys = obs.map((o) => o.yzY);
    const zs = obs.map((o) => o.yzZ);
    track.fitY = lsqQuadratic(ts, ys);
    track.fitZ = lsqQuadratic(ts, zs);

    // R² on combined 2D trajectory.
    const tMin = obs[0]!.timeSec;
    const pts = obs.map((o) => ({ tn: o.timeSec - tMin, cx: o.yzY, cy: o.yzZ }));
    const tns = pts.map((p) => p.tn);
    const fitYn = lsqQuadratic(tns, pts.map((p) => p.cx));
    const fitZn = lsqQuadratic(tns, pts.map((p) => p.cy));
    track.r2 = computeR2(pts, fitYn, fitZn);

    // Speed at midpoint.
    const tMid = obs[Math.floor(obs.length / 2)]!.timeSec;
    const vy = 2 * track.fitY[0]! * tMid + track.fitY[1]!;
    const vz = 2 * track.fitZ[0]! * tMid + track.fitZ[1]!;
    track.speedMph = Math.hypot(vy, vz) * MPH_PER_MS;
  }

  private residual(track: BallisticTrack, obs: Observation3D): number {
    if (!track.fitY || !track.fitZ) {
      // No fit yet — use distance from last observation.
      const last = track.observations[track.observations.length - 1];
      if (!last) return Infinity;
      return Math.hypot(obs.yzY - last.yzY, obs.yzZ - last.yzZ);
    }
    const t = obs.timeSec;
    const predY = track.fitY[0]! * t * t + track.fitY[1]! * t + track.fitY[2]!;
    const predZ = track.fitZ[0]! * t * t + track.fitZ[1]! * t + track.fitZ[2]!;
    return Math.hypot(obs.yzY - predY, obs.yzZ - predZ);
  }

  private ageUnassigned(): void {
    const cutoff = this.currentFrame - this.config.observationMaxAge;
    this.unassigned = this.unassigned.filter((o) => o.frameIndex >= cutoff);
  }

  private tryCandidateFormation(): void {
    if (this.unassigned.length < this.config.minObservations) return;
    // Already have a candidate? Try adding to it.
    const candidate = this.tracks.find((t) => t.state === "candidate");
    if (candidate) {
      // Try to add newest unassigned to candidate.
      const newest = this.unassigned[this.unassigned.length - 1]!;
      if (candidate.observations.some((o) => o.frameIndex === newest.frameIndex)) return;
      const res = this.residual(candidate, newest);
      if (res < this.config.gateThresholdM * 2) {
        this.acceptObservation(candidate, newest);
        this.unassigned.pop();
        this.tryValidateCandidate(candidate);
      }
      return;
    }

    // Try to form a new candidate from the unassigned pool.
    // Use the most recent minObservations observations.
    const recent = this.unassigned.slice(-this.config.minObservations);
    if (recent.length < this.config.minObservations) return;

    // Check they're reasonably close in time (within ~0.5s).
    const dt = recent[recent.length - 1]!.timeSec - recent[0]!.timeSec;
    if (dt > 0.5) return;

    const track: BallisticTrack = {
      id: this.nextId++,
      state: "candidate",
      observations: [...recent],
      fitY: null,
      fitZ: null,
      r2: 0,
      speedMph: 0,
      startFrame: recent[0]!.frameIndex,
      endFrame: recent[recent.length - 1]!.frameIndex,
      lastUpdateFrame: recent[recent.length - 1]!.frameIndex,
      missedFrameCount: 0,
      reasonClosed: null,
    };
    this.refit(track);
    this.tracks.push(track);
    // Remove used observations from unassigned.
    const usedFrames = new Set(recent.map((o) => o.frameIndex));
    this.unassigned = this.unassigned.filter((o) => !usedFrames.has(o.frameIndex));
    this.addLog(`Track ${track.id}: candidate formed (${recent.length} obs, R²=${track.r2.toFixed(3)}, ${track.speedMph.toFixed(0)}mph)`);
    this.tryValidateCandidate(track);
  }

  private tryValidateCandidate(track: BallisticTrack): void {
    if (track.state !== "candidate") return;
    if (track.observations.length < this.config.minObservations) return;
    if (track.r2 < this.config.r2Threshold) return;
    if (track.speedMph < this.config.minSpeedMph) {
      this.addLog(`Track ${track.id}: candidate rejected (${track.speedMph.toFixed(0)}mph < ${this.config.minSpeedMph}mph)`);
      return;
    }

    const active = this.getActiveTrack();
    if (!active) {
      track.state = "validated";
      this.addLog(`Track ${track.id}: validated (${track.observations.length} obs, ${track.speedMph.toFixed(0)}mph)`);
    } else {
      track.state = "pending_replacement";
      this.addLog(`Track ${track.id}: pending replacement for Track ${active.id}`);
    }
  }

  private checkPendingPromotion(pending: BallisticTrack): void {
    if (pending.state !== "pending_replacement") return;
    if (pending.observations.length < this.config.pendingConfirmCount) return;
    if (pending.r2 < this.config.r2Threshold) return;

    // Promote: close active, make pending the new active.
    const active = this.getActiveTrack();
    if (active) {
      active.state = "closed";
      active.reasonClosed = "replaced";
      this.addLog(`Track ${active.id}: closed (replaced by Track ${pending.id})`);
    }
    pending.state = "validated";
    this.addLog(`Track ${pending.id}: promoted to validated (${pending.observations.length} obs)`);
  }

  private checkMissedTracks(): void {
    for (const t of this.tracks) {
      if (t.state === "validated" && t.missedFrameCount > this.config.maxMissedFrames) {
        t.state = "closed";
        t.reasonClosed = "max_missed_frames";
        this.addLog(`Track ${t.id}: closed (missed ${t.missedFrameCount} frames)`);
      }
      if (t.state === "pending_replacement" && t.missedFrameCount > this.config.maxMissedFrames) {
        t.state = "closed";
        t.reasonClosed = "pending_expired";
        this.addLog(`Track ${t.id}: pending expired`);
      }
      if (t.state === "candidate" && t.missedFrameCount > this.config.observationMaxAge) {
        t.state = "closed";
        t.reasonClosed = "candidate_expired";
      }
    }
  }

  private addLog(msg: string): void {
    this.log.push(msg);
  }
}
