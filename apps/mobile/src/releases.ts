// Release notes shown in the "What's new" banner. Newest first.
// Bump APP_VERSION in app/_layout.tsx and add a new entry here for each
// user-facing change.

export interface Release {
  version: string;
  title: string;
  notes: string[];
}

export const RELEASES: Release[] = [
  {
    version: "v34",
    title: "What's new banner",
    notes: [
      "A dismissible banner shows recent changes when you open chat",
      "Tap 'Got it' to mark them as seen",
    ],
  },
  {
    version: "v33",
    title: "Altitude in your units",
    notes: [
      "Pick mm / m / in / ft+in for relative altitude in Experiments",
      "Tap 'Zero here' to set the baseline",
    ],
  },
  {
    version: "v32",
    title: "Microphone visualizer",
    notes: [
      "Tap 'Start listening' in Experiments to see a live mic waveform",
      "Audio is never persisted or uploaded",
    ],
  },
  {
    version: "v31",
    title: "More motion visualizations",
    notes: [
      "Tilt + compass for device motion, pressure sparkline for barometer",
      "Battery and step progress bars",
    ],
  },
  {
    version: "v30",
    title: "More sensors",
    notes: ["DeviceMotion, Barometer, Pedometer added to Experiments"],
  },
  {
    version: "v29",
    title: "Motion sparklines",
    notes: ["Live mini-charts above accel / gyro / mag readouts"],
  },
  {
    version: "v28",
    title: "Chat opens at the bottom",
    notes: ["No more scrolling down on open"],
  },
  {
    version: "v25",
    title: "Dark mode",
    notes: ["System / Light / Dark picker in Settings → General"],
  },
];

/** Parse "v34" -> 34. Returns 0 if unparseable. */
export function parseVersion(v: string): number {
  const n = parseInt(v.replace(/^v/i, ""), 10);
  return Number.isFinite(n) ? n : 0;
}
