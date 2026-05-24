// Release notes shown in the "What's new" banner. Newest first.
// Bump APP_VERSION in app/_layout.tsx and add a new entry here for each
// user-facing change.

export interface Release {
  version: string;
  title: string;
  notes: string[];
  /** GitHub PR number, if applicable. Shown next to the version label. */
  pr?: number;
}

export const RELEASES: Release[] = [
  {
    version: "v51",
    title: "Spectrum: adjustable axes + tap to fullscreen",
    pr: 45,
    notes: [
      "Adjust min/max frequency and dB floor/ceiling via stepper buttons",
      "Tap the spectrum chart to expand it fullscreen",
    ],
  },
  {
    version: "v50",
    title: "Spectrum: notes vs linear",
    pr: 44,
    notes: [
      "Spectrum bands default to one semitone each (A0 → A8, 8 octaves)",
      "Toggle to 'Linear' for equal-Hz spacing instead",
    ],
  },
  {
    version: "v49",
    title: "Spectrum: full hearing range",
    pr: 43,
    notes: ["20 Hz – 20 kHz across the 96 bands"],
  },
  {
    version: "v48",
    title: "Spectrum on a dBFS scale",
    pr: 42,
    notes: [
      "Mic spectrum bars now display dBFS (-80 to 0)",
      "Ambient low-frequency noise sits near the bottom; voice/music pop up clearly",
    ],
  },
  {
    version: "v47",
    title: "Location streaming",
    pr: 41,
    notes: [
      "Start streaming → live updates, plus speed + altitude sparklines",
      "Compass arrow shows current heading",
      "Foreground only for now (background needs a TestFlight rebuild)",
    ],
  },
  {
    version: "v46",
    title: "Color spectrum + peak holds",
    pr: 40,
    notes: [
      "Mic spectrum bars now colorized red → blue across frequency",
      "Classic equalizer peak markers that slowly fall back",
      "Picker to switch between 4096 and 8192 FFT size",
    ],
  },
  {
    version: "v45",
    title: "Hi-res mic spectrum",
    pr: 39,
    notes: [
      "4096-point FFT, 96 log-spaced bands from 30 Hz to 12 kHz",
      "Hanning window + 50% overlap for smoother visuals",
    ],
  },
  {
    version: "v44",
    title: "More sensors (needs a TestFlight build)",
    notes: [
      "Network: Wi-Fi vs cellular + reachability",
      "Cellular: carrier name + 2G/3G/4G/5G",
      "Brightness: read and adjust",
      "Screen orientation",
      "Bluetooth (BLE): scan nearby devices + RSSI",
      "Microphone spectrum: live 32-band FFT",
    ],
  },
  {
    version: "v43",
    title: "Version label shows PR + build",
    pr: 37,
    notes: ["Bottom badge now shows the current version, PR number, and native build"],
  },
  {
    version: "v42",
    title: "Email + Calendar moved under Context",
    pr: 36,
    notes: [
      "Bottom tabs slim down to Chat | Capture | Settings",
      "Email and Calendar views now live under Settings → Context",
      "Clear Chat / Emails / Calendar buttons moved there too",
    ],
  },
  {
    version: "v41",
    title: "What's new = one message per update",
    pr: 35,
    notes: ["Each release posts as its own chat message, not a bundle"],
  },
  {
    version: "v40",
    title: "Settings reorganized",
    pr: 34,
    notes: [
      "New 'Context' tab — your preferences live here",
      "New 'Lab' tab — sensor sandbox moved in from a separate screen",
      "GroupMe text colors fixed in dark mode",
    ],
  },
  {
    version: "v39",
    title: "What's new lives in chat now",
    pr: 33,
    notes: [
      "Release notes post as an assistant message in chat instead of a banner",
      "Chat reliably scrolls to the bottom on open",
    ],
  },
  {
    version: "v38",
    title: "Position by integration (experimental)",
    pr: 32,
    notes: ["Tap 'Start tracking' to integrate accelerometer into position", "Drifts heavily — that's the physics demo"],
  },
  {
    version: "v37",
    title: "Relative orientation",
    pr: 31,
    notes: ["New card under Device Motion: tap 'Zero here' to start tracking how far you've rotated"],
  },
  {
    version: "v36",
    title: "Barometer in psi",
    pr: 30,
    notes: ["Tiny psi readout in the corner of the pressure chart"],
  },
  {
    version: "v35",
    title: "Line charts instead of bars",
    pr: 29,
    notes: ["Sensor sparklines now draw as smooth lines"],
  },
  {
    version: "v34",
    title: "What's new banner",
    pr: 28,
    notes: [
      "A dismissible banner shows recent changes when you open chat",
      "Tap 'Got it' to mark them as seen",
    ],
  },
  {
    version: "v33",
    title: "Altitude in your units",
    pr: 27,
    notes: [
      "Pick mm / m / in / ft+in for relative altitude in Experiments",
      "Tap 'Zero here' to set the baseline",
    ],
  },
  {
    version: "v32",
    title: "Microphone visualizer",
    pr: 26,
    notes: [
      "Tap 'Start listening' in Experiments to see a live mic waveform",
      "Audio is never persisted or uploaded",
    ],
  },
  {
    version: "v31",
    title: "More motion visualizations",
    pr: 25,
    notes: [
      "Tilt + compass for device motion, pressure sparkline for barometer",
      "Battery and step progress bars",
    ],
  },
  {
    version: "v30",
    title: "More sensors",
    pr: 24,
    notes: ["DeviceMotion, Barometer, Pedometer added to Experiments"],
  },
  {
    version: "v29",
    title: "Motion sparklines",
    pr: 23,
    notes: ["Live mini-charts above accel / gyro / mag readouts"],
  },
  {
    version: "v28",
    title: "Chat opens at the bottom",
    pr: 22,
    notes: ["No more scrolling down on open"],
  },
  {
    version: "v25",
    title: "Dark mode",
    pr: 19,
    notes: ["System / Light / Dark picker in Settings → General"],
  },
];

/** Parse "v34" -> 34. Returns 0 if unparseable. */
export function parseVersion(v: string): number {
  const n = parseInt(v.replace(/^v/i, ""), 10);
  return Number.isFinite(n) ? n : 0;
}

/** Latest release (top of the list). */
export function currentRelease(): Release | null {
  return RELEASES[0] ?? null;
}
