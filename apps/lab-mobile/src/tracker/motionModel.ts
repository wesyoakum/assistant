// Motion model for ball trajectory prediction.
// Uses polynomial fitting on a sliding time window.
// Structured for future replacement with Kalman filter or ballistic model.

import { lsqQuadratic } from "./polyFit";

export interface MotionModel {
  update(t: number, x: number, y: number): void;
  predict(t: number): { x: number; y: number };
  residual(t: number, x: number, y: number): number;
  velocity(): { vx: number; vy: number } | null;
  pointCount(): number;
  clone(): MotionModel;
}

interface Point { t: number; x: number; y: number }

export class PolynomialMotionModel implements MotionModel {
  private buffer: Point[] = [];
  private windowSec: number;
  private fitX: number[] | null = null;
  private fitY: number[] | null = null;

  constructor(windowSec = 0.5) {
    this.windowSec = windowSec;
  }

  update(t: number, x: number, y: number): void {
    this.buffer.push({ t, x, y });
    // Trim to sliding window
    const cutoff = t - this.windowSec;
    while (this.buffer.length > 3 && this.buffer[0]!.t < cutoff) {
      this.buffer.shift();
    }
    this.refit();
  }

  predict(t: number): { x: number; y: number } {
    const n = this.buffer.length;
    if (n === 0) return { x: 0.5, y: 0.5 };
    if (n === 1) return { x: this.buffer[0]!.x, y: this.buffer[0]!.y };
    if (n === 2) {
      const p0 = this.buffer[0]!, p1 = this.buffer[1]!;
      const dt = p1.t - p0.t || 1e-6;
      const frac = (t - p0.t) / dt;
      return {
        x: p0.x + (p1.x - p0.x) * frac,
        y: p0.y + (p1.y - p0.y) * frac,
      };
    }
    // Quadratic evaluation
    if (this.fitX && this.fitY) {
      return {
        x: this.fitX[0]! * t * t + this.fitX[1]! * t + this.fitX[2]!,
        y: this.fitY[0]! * t * t + this.fitY[1]! * t + this.fitY[2]!,
      };
    }
    // Fallback to last point
    return { x: this.buffer[n - 1]!.x, y: this.buffer[n - 1]!.y };
  }

  residual(t: number, x: number, y: number): number {
    const p = this.predict(t);
    return Math.hypot(x - p.x, y - p.y);
  }

  velocity(): { vx: number; vy: number } | null {
    const n = this.buffer.length;
    if (n < 2) return null;
    if (n === 2) {
      const p0 = this.buffer[0]!, p1 = this.buffer[1]!;
      const dt = p1.t - p0.t || 1e-6;
      return { vx: (p1.x - p0.x) / dt, vy: (p1.y - p0.y) / dt };
    }
    // Quadratic derivative: dx/dt = 2at + b
    if (this.fitX && this.fitY) {
      const t = this.buffer[n - 1]!.t;
      return {
        vx: 2 * this.fitX[0]! * t + this.fitX[1]!,
        vy: 2 * this.fitY[0]! * t + this.fitY[1]!,
      };
    }
    return null;
  }

  pointCount(): number {
    return this.buffer.length;
  }

  clone(): MotionModel {
    const m = new PolynomialMotionModel(this.windowSec);
    m.buffer = this.buffer.map((p) => ({ ...p }));
    m.fitX = this.fitX ? [...this.fitX] : null;
    m.fitY = this.fitY ? [...this.fitY] : null;
    return m;
  }

  private refit(): void {
    if (this.buffer.length < 3) {
      this.fitX = null;
      this.fitY = null;
      return;
    }
    const ts = this.buffer.map((p) => p.t);
    const xs = this.buffer.map((p) => p.x);
    const ys = this.buffer.map((p) => p.y);
    this.fitX = lsqQuadratic(ts, xs);
    this.fitY = lsqQuadratic(ts, ys);
  }
}
