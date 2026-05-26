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
    version: "v89",
    title: "Balls: live-tunable knobs + per-capture telemetry",
    notes: [
      "New Dev panel under the Balls AR view. Every tuning constant is now a +/- stepper: YOLO confidence, distance tiers, dedup, promotion thresholds, revalidation thresholds",
      "Per-capture telemetry shows what was detected, why each detection was kept/rejected (\"conf < tier floor\", \"merged into #3\", \"raycast missed\"), and the revalidation outcome for each tracked ball",
      "Reset-to-defaults button. JS-only — ships via OTA",
    ],
  },
  {
    version: "v88",
    title: "Balls: three tiers + distance-aware confidence + auto-revalidation (needs rebuild)",
    notes: [
      "Spheres now color-coded: candidate (yellow), probable (cyan), confirmed (fuchsia)",
      "Distance-tiered YOLO confidence: strict ≥0.45 within 2 m, looser ≥0.15 at 6–8 m, skip past 8 m",
      "Close-up high-confidence detections (< 2 m, ≥0.45) skip straight to confirmed in one shot",
      "Auto-revalidation: a tracked ball that's in view and within 3 m but not detected on 3 consecutive captures gets removed",
      "New Reset AR button wipes ARKit's world map and every anchor",
    ],
  },
  {
    version: "v87",
    title: "Balls: AR overlays — planes / mesh / feature points (needs rebuild)",
    notes: [
      "Three new toggles under the Balls AR view: Planes (translucent quads for detected floor/walls — blue=horizontal, purple=vertical), Mesh (LiDAR scene reconstruction as a green wireframe over walls, furniture, everything), Features (ARKit's debug feature-point dots)",
      "ARSession now also detects vertical planes and runs scene reconstruction (no extra battery if you don't enable the overlays — toggles are purely cosmetic)",
    ],
  },
  {
    version: "v86",
    title: "Balls: dedup that actually dedups",
    notes: [
      "Tracked-ball positions now refreshed from ARKit at every capture, so dedup compares to ARKit's current anchor positions instead of the stale ones we stored",
      "Dedup distance bumped from 15 cm → 25 cm to account for raycast jitter",
      "Post-capture cluster-merge pass walks the list and merges any close pairs that snuck in earlier",
    ],
  },
  {
    version: "v85",
    title: "YOLOv8n + continuous detection (needs rebuild)",
    notes: [
      "Swapped YOLOv3-Tiny for YOLOv8n (newer model, similar size). Meaningfully better at small/distant objects",
      "Balls mode has a Live button now — continuous capture loop at ~2 fps; balls accumulate / auto-confirm as you sweep",
      "Snapshot button still there for single-shot",
    ],
  },
  {
    version: "v84",
    title: "Balls: candidate / confirmed lifecycle + farther detection (needs rebuild)",
    notes: [
      "Lower YOLO confidence threshold (0.1) + higher-quality captures so smaller / farther balls turn up as candidates",
      "Each ball is candidate or confirmed. Reaches confirmed at ≥2 sightings with conf ≥35%, or by tapping Confirm",
      "Per-ball Reject button removes the anchor + the row",
      "Capture status badge + confidence shown in each row",
    ],
  },
  {
    version: "v83",
    title: "Balls: real AR view (needs rebuild)",
    notes: [
      "Replaced the depth-grid preview with ARSCNView — live camera with proper portrait orientation",
      "ARKit handles raycast to floor, places ARAnchors, renders SceneKit spheres + numbered labels that stay glued to ball positions as you move",
      "Capture: takes one ARKit frame, runs YOLO, raycasts each sports ball to the floor plane",
      "Live distance + bearing in the list updates as you walk around (camera pose polled every 500 ms)",
    ],
  },
  {
    version: "v82",
    title: "Balls: ARKit-tracked ball locations (Phase 1)",
    notes: [
      "New Lab → Vision → Balls mode. Start ARSession, sweep the area, tap Capture & find balls",
      "Each capture filters YOLO to sports balls and computes world XYZ from depth + intrinsics + camera transform",
      "Balls within 15 cm of an existing track are merged; positions averaged across sightings",
      "List shows world XYZ, sightings count, and live distance / bearing / elevation from the latest capture's camera pose",
      "Next phase: continuous detection + AR overlay",
    ],
  },
  {
    version: "v81",
    title: "Object → LiDAR spatial mapping (needs rebuild)",
    notes: [
      "New Lab → Vision → Map tab. Start ARSession, tap Capture & map",
      "ARKit grabs one frame (camera image + depth, time-synced); YOLO runs on it; depth is sampled at each detection",
      "For each object: label · distance (m) · horizontal angle · vertical angle, plus phone pitch/yaw/roll and barometer-relative altitude at the moment of capture",
      "Last 20 captures kept; thumbnail strip to switch between them",
      "Also: camera shutter sound is now silenced app-wide",
    ],
  },
  {
    version: "v80",
    title: "Vision tab: detection modes as tabs + frame review",
    notes: [
      "Lab → Vision: tabs under the camera tile for Claude / Apple / YOLO / LiDAR",
      "LiDAR view now shares the same display area as the camera (one tile, swapped by the active tab)",
      "Last capture stays visible inside the active tab",
      "YOLO Live keeps the last 10 frames — stop live and step through them with Prev/Next + thumbnail strip",
    ],
  },
  {
    version: "v79",
    title: "Chat web search + recurring events + weather card",
    notes: [
      "Chat can now browse the web — ask about news, sports scores, current weather, anything time-sensitive",
      "Chat can create recurring events on Google Calendar (\"every Mon/Wed/Fri at 7am\", \"15th of every month\", etc.)",
      "Lab → Env → Weather: tap Fetch to pull current conditions + 24-hour forecast from Open-Meteo using your location",
    ],
  },
  {
    version: "v78",
    title: "YOLO object detection + Claude snapshot preview (needs rebuild)",
    notes: [
      "Lab → Vision → YOLO. On-device Core ML inference with 80 COCO classes (person, bottle, chair, dog, car, laptop, …)",
      "Two modes: Snapshot (one frame) or Live (~3–5 fps snap-and-process loop)",
      "Bounding boxes overlay the photo with per-detection labels + confidence",
      "Also: Claude vision now shows the snapshot it analyzed",
    ],
  },
  {
    version: "v77",
    title: "Apple Vision detection (needs rebuild)",
    notes: [
      "Lab → Vision → Detect faces / text / barcodes. On-device, free, fast (~50–200 ms per snapshot)",
      "Renders bounding boxes over the photo: faces red, text green, barcodes yellow. OCR text + barcode payloads listed below",
      "New local Expo module wrapping Apple Vision framework",
    ],
  },
  {
    version: "v76",
    title: "Object detection — Claude vision (one-shot)",
    notes: [
      "Lab → Vision → Detect (snapshot). Takes one camera frame, sends to Claude Haiku, lists objects with confidence + a one-line scene summary",
      "Smart but slow (~1–2 s per call, ~¢0.2 per snapshot)",
      "First of three detection modes — Vision framework built-ins (faces/text/barcodes) and on-device YOLO are next",
    ],
  },
  {
    version: "v75",
    title: "Game controllers (needs rebuild)",
    notes: [
      "Lab → Device → Game controller. Pair a DualSense / DualShock / Xbox / MFi pad in iOS Settings → Bluetooth, then tap Start watching",
      "Live readout: dual sticks + D-pad as joystick dots, face/shoulder/trigger/menu buttons light up when pressed",
      "New local Expo module wrapping iOS GameController framework — needs the new TestFlight build",
    ],
  },
  {
    version: "v74",
    title: "Background location streaming",
    notes: [
      "Lab → Device → Location has a new Allow-background toggle. Asks for Always permission and uses TaskManager so iOS keeps feeding points while the app is backgrounded or the phone is locked",
      "Counter + last point + age show what arrived while you were away",
    ],
  },
  {
    version: "v73",
    title: "LiDAR: native bitmap render (smooth at 256×192)",
    notes: ["Swift colorizes + rotates the depth frame and ships a PNG; JS just draws an <Image>. Full-res no longer chokes the view tree"],
  },
  {
    version: "v72",
    title: "LiDAR: selectable resolution + fps counter",
    pr: 66,
    notes: ["Pick 32×24 / 64×48 / 128×96 / 256×192 (native). FPS shown beside the chart so you can see how each performs"],
  },
  {
    version: "v71",
    title: "LiDAR depth map rotated 90° CW for portrait",
    pr: 65,
    notes: ["ARKit depth ships in landscape; rotated in JS to match how you hold the phone"],
  },
  {
    version: "v70",
    title: "LiDAR — fix archive (root .gitignore + explicit includes)",
    pr: 64,
    notes: ["Repo-root .gitignore now has !apps/mobile/modules/**/ios/ negation; .easignore explicitly includes modules/"],
  },
  {
    version: "v69",
    title: "LiDAR — fix EAS Build archive missing module files",
    pr: 63,
    notes: ["Apps/mobile/.easignore stops EAS from excluding local Expo modules' ios files via the broad ios/ rule"],
  },
  {
    version: "v68",
    title: "LiDAR module rename — matches Expo convention",
    pr: 62,
    notes: ["Swift class renamed to LidarModule (no Expo prefix), config uses 'apple' platform — fixes autolinking"],
  },
  {
    version: "v67",
    title: "LiDAR autolinking fix",
    pr: 61,
    notes: ["Tells EAS Build where to find local native modules — fixes LiDAR being missing from the binary"],
  },
  {
    version: "v66",
    title: "Fix Lab crash from Vision tab",
    pr: 60,
    notes: [
      "Camera + LiDAR hooks moved into a sub-component that only mounts when Vision is the active tab",
      "LiDAR native module loaded defensively — if missing, the section just shows 'not in this build'",
    ],
  },
  {
    version: "v65",
    title: "Camera preview + LiDAR depth (needs rebuild)",
    pr: 59,
    notes: [
      "New Lab → Vision sub-tab",
      "Live camera preview (back/front, flip button)",
      "LiDAR depth map rendered as a 32×24 color grid (red near, blue far)",
      "Requires the new TestFlight build to actually work",
    ],
  },
  {
    version: "v64",
    title: "Darker teal primary in light mode",
    pr: 58,
    notes: ["Buttons and accent text use the darker palette teal — better contrast on cream backgrounds"],
  },
  {
    version: "v63",
    title: "Motion charts: 3 overlaid x/y/z lines",
    pr: 57,
    notes: [
      "Accel / gyro / mag plots now show x (red), y (teal), z (yellow) on a shared scale",
      "Device Motion gets new Gravity and User-acceleration charts (also tri-color)",
    ],
  },
  {
    version: "v62",
    title: "Motion: compact x/y/z rows under each chart",
    pr: 56,
    notes: [
      "Accel / gyro / mag readouts collapse to one row each (x, y, z side by side)",
      "Device Motion split into Rotation / Gravity / User-acceleration single-line rows",
    ],
  },
  {
    version: "v61",
    title: "Spectrum: dual-thumb range sliders",
    pr: 55,
    notes: [
      "One slider for frequency range (both min and max thumbs)",
      "One slider for dB range",
      "Touching grabs the closer thumb; can't cross past the other",
    ],
  },
  {
    version: "v60",
    title: "Audio spectrum: sliders instead of steppers",
    pr: 54,
    notes: [
      "Drag the four range controls instead of tapping × / ÷ / ± buttons",
      "Frequency sliders use a log scale so movement is musical, not linear",
    ],
  },
  {
    version: "v59",
    title: "BLE: sort by signal/name, inline detail view",
    pr: 53,
    notes: [
      "Sort device list by signal strength (default) or name",
      "Tapping a device replaces the list with its chart + info in place — no modal",
    ],
  },
  {
    version: "v58",
    title: "Settings: Calendars + GroupMe move into Context",
    pr: 52,
    notes: [
      "Settings tabs slimmed to General | Context | Usage | Lab",
      "Calendar config, iCal feeds, and GroupMe all live under Context now",
    ],
  },
  {
    version: "v57",
    title: "Tap a BLE device to monitor it",
    pr: 51,
    notes: [
      "Lab → Env → Bluetooth: tap any device row to open a detail view",
      "Live RSSI line graph + all advertised info (manufacturer data, service UUIDs, TX power)",
    ],
  },
  {
    version: "v56",
    title: "Defer HealthKit + NFC for now",
    pr: 50,
    notes: [
      "Pulled the two packages so the next TestFlight build succeeds",
      "Coming back once the EAS provisioning profile is sorted",
    ],
  },
  {
    version: "v55",
    title: "Settings: dedicated Usage tab with full dashboard",
    pr: 49,
    notes: [
      "API usage moved out of General into its own Settings tab",
      "Daily spend bar chart (last 30 days)",
      "Cumulative spend chart (all time)",
      "Recent call list (model, purpose, cost, tokens)",
    ],
  },
  {
    version: "v54",
    title: "Lab grouped into tabs",
    pr: 48,
    notes: [
      "Six sub-tabs: Motion · Audio · Env · Device · Health · Info",
      "Clipboard moved to Device",
    ],
  },
  {
    version: "v53",
    title: "HealthKit + NFC + background location (needs rebuild)",
    pr: 47,
    notes: [
      "HealthKit: heart rate, HRV, SpO₂, steps, active energy — read from Apple Watch / Health app",
      "NFC: scan a tag and read its NDEF payload",
      "Background location keys in Info.plist (when you grant 'Always')",
      "Fullscreen spectrum rotates to landscape (also from previous PR)",
    ],
  },
  {
    version: "v52",
    title: "Fullscreen spectrum supports landscape",
    pr: 46,
    notes: [
      "Rotate the phone in the fullscreen spectrum view — chart fills the wider screen",
      "Rest of the app stays portrait",
      "Requires the next native rebuild to actually rotate (app.json change)",
    ],
  },
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
