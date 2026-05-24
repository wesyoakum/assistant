import { useState, useEffect, useRef } from "react";
import { View, Text, ScrollView, StyleSheet, Pressable, Alert, Platform } from "react-native";
import * as Device from "expo-device";
import Constants from "expo-constants";
import * as Clipboard from "expo-clipboard";
import * as Notifications from "expo-notifications";
import { Accelerometer, Gyroscope, Magnetometer, DeviceMotion, Barometer, Pedometer } from "expo-sensors";
import type { DeviceMotionMeasurement } from "expo-sensors";
import * as Location from "expo-location";
import * as Haptics from "expo-haptics";
import * as Battery from "expo-battery";
import * as Network from "expo-network";
import * as Cellular from "expo-cellular";
import * as Brightness from "expo-brightness";
import * as ScreenOrientation from "expo-screen-orientation";
import { Audio } from "expo-av";
import { BleManager, type Device as BleDevice, type State as BleState } from "react-native-ble-plx";
import LiveAudioStream from "react-native-live-audio-stream";
import FFT from "fft.js";
import { useAuth } from "../src/state/auth";
import { useMe } from "../src/hooks/useMe";
import { type Theme, useTheme } from "../src/theme";
import { useStyles } from "../src/hooks/useStyles";

interface Row {
  label: string;
  value: string | number | boolean | null | undefined;
}

function Section({ title, rows }: { title: string; rows: Row[] }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={{ marginBottom: 20 }}>
      {title ? <Text style={styles.sectionTitle}>{title}</Text> : null}
      <View style={styles.card}>
        {rows.map((r, i) => (
          <View key={r.label} style={[styles.row, i === rows.length - 1 && { borderBottomWidth: 0 }]}>
            <Text style={styles.rowLabel} numberOfLines={1}>{r.label}</Text>
            <Text style={styles.rowValue} numberOfLines={2}>{format(r.value)}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function format(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "number") return v.toLocaleString();
  if (typeof v === "string") return v || "—";
  return JSON.stringify(v);
}

function fmt(n: number, digits = 2) {
  return n.toFixed(digits);
}

// --- Altitude unit formatting -------------------------------------------------
type AltUnit = "mm" | "m" | "in" | "ftin";
const ALT_UNITS: { value: AltUnit; label: string }[] = [
  { value: "mm", label: "mm" },
  { value: "m", label: "m" },
  { value: "in", label: "in" },
  { value: "ftin", label: "ft+in" },
];

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

function formatAltitude(meters: number, unit: AltUnit): string {
  const sign = meters < 0 ? "-" : "";
  const m = Math.abs(meters);
  switch (unit) {
    case "mm":
      return `${sign}${(m * 1000).toFixed(1)} mm`;
    case "m":
      return `${sign}${m.toFixed(3)} m`;
    case "in":
      return `${sign}${(m * 39.3701).toFixed(3)} in`;
    case "ftin": {
      const totalIn = m * 39.3701;
      const ft = Math.floor(totalIn / 12);
      const restIn = totalIn - ft * 12;
      const wholeIn = Math.floor(restIn);
      const fracIn = restIn - wholeIn;
      let n = Math.round(fracIn * 16);
      const d = 16;
      if (n === 16) return `${sign}${ft}'${wholeIn + 1}"`;
      if (n === 0) return `${sign}${ft}'${wholeIn}"`;
      const g = gcd(n, d);
      return `${sign}${ft}'${wholeIn} ${n / g}/${d / g}"`;
    }
  }
}

function magnitude(v: { x: number; y: number; z: number }) {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

const HIST_LEN = 80;

function BarGauge({ value, max, color, height = 14 }: { value: number; max: number; color: string; height?: number }) {
  const pct = Math.max(0, Math.min(1, value / Math.max(0.0001, max))) * 100;
  return (
    <View style={{ height, backgroundColor: "rgba(127,127,127,0.18)", borderRadius: height / 2, overflow: "hidden" }}>
      <View style={{ width: `${pct}%`, height: "100%", backgroundColor: color, borderRadius: height / 2 }} />
    </View>
  );
}

function TiltIndicator({ pitchDeg, rollDeg, color, size = 90 }: { pitchDeg: number; rollDeg: number; color: string; size?: number }) {
  // Map -90..90 to 0..size; clamp so the dot stays inside the circle
  const clamp = (v: number) => Math.max(-90, Math.min(90, v));
  const x = ((clamp(rollDeg) + 90) / 180) * size;
  const y = ((clamp(pitchDeg) + 90) / 180) * size;
  return (
    <View
      style={{
        width: size,
        height: size,
        alignSelf: "center",
        backgroundColor: "rgba(127,127,127,0.15)",
        borderRadius: size / 2,
        position: "relative",
      }}
    >
      {/* crosshairs */}
      <View style={{ position: "absolute", left: 0, right: 0, top: size / 2, height: StyleSheet.hairlineWidth, backgroundColor: "rgba(127,127,127,0.35)" }} />
      <View style={{ position: "absolute", top: 0, bottom: 0, left: size / 2, width: StyleSheet.hairlineWidth, backgroundColor: "rgba(127,127,127,0.35)" }} />
      {/* dot */}
      <View
        style={{
          position: "absolute",
          left: x - 7,
          top: y - 7,
          width: 14,
          height: 14,
          borderRadius: 7,
          backgroundColor: color,
        }}
      />
    </View>
  );
}

function CompassArrow({ headingDeg, color, size = 70 }: { headingDeg: number; color: string; size?: number }) {
  return (
    <View
      style={{
        width: size,
        height: size,
        alignSelf: "center",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: size / 2,
        backgroundColor: "rgba(127,127,127,0.15)",
        position: "relative",
      }}
    >
      <Text style={{ position: "absolute", top: 4, fontSize: 10, fontWeight: "700", color: "rgba(127,127,127,0.7)" }}>N</Text>
      <View style={{ transform: [{ rotate: `${headingDeg}deg` }] }}>
        <View
          style={{
            width: 0,
            height: 0,
            borderLeftWidth: 8,
            borderRightWidth: 8,
            borderBottomWidth: 22,
            borderStyle: "solid",
            borderLeftColor: "transparent",
            borderRightColor: "transparent",
            borderBottomColor: color,
          }}
        />
      </View>
    </View>
  );
}

function Sparkline({ samples, color, height = 56 }: { samples: number[]; color: string; height?: number }) {
  const [width, setWidth] = useState(0);

  if (samples.length < 2) {
    return (
      <View
        style={{ height, backgroundColor: "transparent" }}
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      />
    );
  }

  // Auto-scale to the visible window.
  const min = Math.min(...samples);
  const max = Math.max(...samples);
  const range = max - min || 1;

  // Pad on the left so "now" is always the right edge.
  const padded: (number | null)[] = Array<number | null>(HIST_LEN - samples.length).fill(null).concat(samples);
  const drawableHeight = height - 6; // 3px padding top + bottom
  const stroke = 2;

  // y goes from top (low value) to bottom (high value) wait — usually we want
  // higher value = higher on screen. In RN, y=0 is top, so invert: y = (1 - norm) * drawable + 3.
  const yFor = (v: number) => (1 - (v - min) / range) * drawableHeight + 3 - stroke / 2;

  return (
    <View
      style={{ height, position: "relative" }}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
    >
      {width > 0 &&
        padded.map((v, i) => {
          if (i === 0 || v == null) return null;
          const prev = padded[i - 1];
          if (prev == null) return null;
          const step = width / (padded.length - 1);
          const x1 = (i - 1) * step;
          const y1 = yFor(prev);
          const y2 = yFor(v);
          const dy = y2 - y1;
          const length = Math.sqrt(step * step + dy * dy);
          const angle = Math.atan2(dy, step); // radians
          return (
            <View
              key={i}
              style={{
                position: "absolute",
                left: x1,
                top: y1,
                width: length,
                height: stroke,
                backgroundColor: color,
                borderRadius: stroke / 2,
                transformOrigin: "left center",
                transform: [{ rotate: `${angle}rad` }],
              }}
            />
          );
        })}
    </View>
  );
}

export default function ExperimentsScreen() {
  const styles = useStyles(makeStyles);
  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
      <ExperimentsContent />
    </ScrollView>
  );
}

export function ExperimentsContent() {
  const { token } = useAuth();
  const styles = useStyles(makeStyles);
  const theme = useTheme();
  const { data: me } = useMe();
  const [pushToken, setPushToken] = useState<string | null>(null);
  const [pushPerm, setPushPerm] = useState<string>("?");
  const [clipboardSnap, setClipboardSnap] = useState<string>("");

  // Sensors — live values, polled at ~5 Hz (200 ms)
  const [accel, setAccel] = useState<{ x: number; y: number; z: number } | null>(null);
  const [gyro, setGyro] = useState<{ x: number; y: number; z: number } | null>(null);
  const [mag, setMag] = useState<{ x: number; y: number; z: number } | null>(null);
  const [accelHist, setAccelHist] = useState<number[]>([]);
  const [gyroHist, setGyroHist] = useState<number[]>([]);
  const [magHist, setMagHist] = useState<number[]>([]);

  useEffect(() => {
    Accelerometer.setUpdateInterval(200);
    Gyroscope.setUpdateInterval(200);
    Magnetometer.setUpdateInterval(200);
    const pushTo = (set: React.Dispatch<React.SetStateAction<number[]>>) =>
      (v: { x: number; y: number; z: number }) => {
        const m = magnitude(v);
        set((prev) => {
          const next = prev.length >= HIST_LEN ? prev.slice(prev.length - HIST_LEN + 1) : prev;
          return [...next, m];
        });
      };
    const subs = [
      Accelerometer.addListener((v) => { setAccel(v); pushTo(setAccelHist)(v); }),
      Gyroscope.addListener((v) => { setGyro(v); pushTo(setGyroHist)(v); }),
      Magnetometer.addListener((v) => { setMag(v); pushTo(setMagHist)(v); }),
    ];
    return () => subs.forEach((s) => s.remove());
  }, []);

  // DeviceMotion — fused orientation, gravity vector, user-acceleration (gravity removed)
  const [motion, setMotion] = useState<DeviceMotionMeasurement | null>(null);
  const [motionZero, setMotionZero] = useState<{ alpha: number; beta: number; gamma: number } | null>(null);
  useEffect(() => {
    DeviceMotion.setUpdateInterval(200);
    const sub = DeviceMotion.addListener(setMotion);
    return () => sub.remove();
  }, []);

  // Position-by-double-integration. Drifts heavily — meant as a physics demo.
  const [posTracking, setPosTracking] = useState(false);
  const [posDisplay, setPosDisplay] = useState({ x: 0, y: 0, z: 0, vmag: 0 });
  const posState = useRef({ vx: 0, vy: 0, vz: 0, px: 0, py: 0, pz: 0, lastT: 0 });
  useEffect(() => {
    if (!posTracking) return;
    posState.current = { vx: 0, vy: 0, vz: 0, px: 0, py: 0, pz: 0, lastT: Date.now() };
    setPosDisplay({ x: 0, y: 0, z: 0, vmag: 0 });
    const sub = DeviceMotion.addListener((m) => {
      if (!m.acceleration) return;
      const now = Date.now();
      const dt = (now - posState.current.lastT) / 1000;
      posState.current.lastT = now;
      if (dt <= 0 || dt > 0.5) return;

      // High-pass: anything below 0.02 m/s² treated as noise.
      const noise = 0.02;
      const ax = Math.abs(m.acceleration.x) < noise ? 0 : m.acceleration.x;
      const ay = Math.abs(m.acceleration.y) < noise ? 0 : m.acceleration.y;
      const az = Math.abs(m.acceleration.z) < noise ? 0 : m.acceleration.z;

      const s = posState.current;
      s.vx += ax * dt;
      s.vy += ay * dt;
      s.vz += az * dt;
      // ZUPT-ish: bleed velocity when accel is essentially zero.
      if (ax === 0 && ay === 0 && az === 0) {
        s.vx *= 0.9;
        s.vy *= 0.9;
        s.vz *= 0.9;
      }
      s.px += s.vx * dt;
      s.py += s.vy * dt;
      s.pz += s.vz * dt;
      setPosDisplay({
        x: s.px,
        y: s.py,
        z: s.pz,
        vmag: Math.sqrt(s.vx * s.vx + s.vy * s.vy + s.vz * s.vz),
      });
    });
    return () => sub.remove();
  }, [posTracking]);

  const resetPosition = () => {
    posState.current = { vx: 0, vy: 0, vz: 0, px: 0, py: 0, pz: 0, lastT: Date.now() };
    setPosDisplay({ x: 0, y: 0, z: 0, vmag: 0 });
  };

  // Barometer — air pressure in hPa (iPhone 6+ only)
  const [pressure, setPressure] = useState<{ pressure: number; relativeAltitude?: number | null } | null>(null);
  const [pressureHist, setPressureHist] = useState<number[]>([]);
  const [baroAvailable, setBaroAvailable] = useState<boolean | null>(null);
  const [altUnit, setAltUnit] = useState<AltUnit>("ftin");
  const [altZero, setAltZero] = useState<number>(0);
  useEffect(() => {
    Barometer.isAvailableAsync().then(setBaroAvailable).catch(() => setBaroAvailable(false));
    Barometer.setUpdateInterval(500);
    const sub = Barometer.addListener((v) => {
      setPressure(v);
      setPressureHist((prev) => {
        const next = prev.length >= HIST_LEN ? prev.slice(prev.length - HIST_LEN + 1) : prev;
        return [...next, v.pressure];
      });
    });
    return () => sub.remove();
  }, []);

  // Pedometer — step count over a window
  const [pedAvailable, setPedAvailable] = useState<boolean | null>(null);
  const [stepsToday, setStepsToday] = useState<number | null>(null);
  const [liveSteps, setLiveSteps] = useState<number | null>(null);
  useEffect(() => {
    (async () => {
      const ok = await Pedometer.isAvailableAsync();
      setPedAvailable(ok);
      if (!ok) return;

      // Steps since midnight
      try {
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        const res = await Pedometer.getStepCountAsync(start, new Date());
        setStepsToday(res.steps);
      } catch {
        // permission likely not granted yet
      }
    })();

    const sub = Pedometer.watchStepCount((res) => setLiveSteps(res.steps));
    return () => sub.remove();
  }, []);

  // Battery (one-shot + subscribe)
  const [battery, setBattery] = useState<{ level: number; state: number; lowPower: boolean } | null>(null);
  useEffect(() => {
    (async () => {
      const [level, state, lowPower] = await Promise.all([
        Battery.getBatteryLevelAsync(),
        Battery.getBatteryStateAsync(),
        Battery.isLowPowerModeEnabledAsync(),
      ]);
      setBattery({ level, state, lowPower });
    })();
    const sub = Battery.addBatteryLevelListener(({ batteryLevel }) =>
      setBattery((prev) => (prev ? { ...prev, level: batteryLevel } : prev))
    );
    return () => sub.remove();
  }, []);

  // Microphone — metering-only recording (audio is discarded on stop).
  const [micRecording, setMicRecording] = useState<Audio.Recording | null>(null);
  const [micLevel, setMicLevel] = useState<number | null>(null);
  const [micPeak, setMicPeak] = useState<number>(0);
  const [micHist, setMicHist] = useState<number[]>([]);
  const [micStatus, setMicStatus] = useState<string>("idle");

  const startMic = async () => {
    try {
      const perm = await Audio.requestPermissionsAsync();
      if (!perm.granted) {
        setMicStatus(`denied: ${perm.status}`);
        return;
      }
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });
      setMicHist([]);
      setMicPeak(0);
      setMicStatus("listening");
      const preset = Audio.RecordingOptionsPresets.HIGH_QUALITY;
      const options = {
        ...preset,
        isMeteringEnabled: true,
        ios: { ...preset.ios, isMeteringEnabled: true },
      };
      const { recording } = await Audio.Recording.createAsync(
        options,
        (status) => {
          if (status.isRecording && typeof status.metering === "number") {
            // Metering is in dBFS, typically -160..0. Map -60..0 -> 0..1.
            const level = Math.max(0, Math.min(1, (status.metering + 60) / 60));
            setMicLevel(level);
            setMicPeak((p) => (level > p ? level : p));
            setMicHist((prev) => {
              const next = prev.length >= HIST_LEN ? prev.slice(prev.length - HIST_LEN + 1) : prev;
              return [...next, level];
            });
          }
        },
        100
      );
      setMicRecording(recording);
    } catch (err) {
      setMicStatus(`error: ${(err as Error).message}`);
    }
  };

  const stopMic = async () => {
    if (!micRecording) return;
    try {
      await micRecording.stopAndUnloadAsync();
    } catch {
      // ignore
    }
    setMicRecording(null);
    setMicLevel(null);
    setMicStatus("idle");
  };

  // Stop the mic if the user navigates away while it's recording.
  useEffect(() => {
    return () => {
      if (micRecording) {
        micRecording.stopAndUnloadAsync().catch(() => {});
      }
    };
  }, [micRecording]);

  // Location — supports both on-demand "get one" and continuous streaming.
  const [loc, setLoc] = useState<Location.LocationObject | null>(null);
  const [locStatus, setLocStatus] = useState<string>("not requested");
  const [locWatching, setLocWatching] = useState(false);
  const [speedHist, setSpeedHist] = useState<number[]>([]);
  const [altHist, setAltHist] = useState<number[]>([]);
  const locSubRef = useRef<Location.LocationSubscription | null>(null);

  const handleLocation = (pos: Location.LocationObject) => {
    setLoc(pos);
    const speed = pos.coords.speed ?? 0;
    const alt = pos.coords.altitude ?? 0;
    setSpeedHist((prev) => {
      const next = prev.length >= HIST_LEN ? prev.slice(prev.length - HIST_LEN + 1) : prev;
      return [...next, Math.max(0, speed)];
    });
    setAltHist((prev) => {
      const next = prev.length >= HIST_LEN ? prev.slice(prev.length - HIST_LEN + 1) : prev;
      return [...next, alt];
    });
  };

  const requestLocation = async () => {
    try {
      setLocStatus("requesting…");
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status !== "granted") {
        setLocStatus(`denied: ${perm.status}`);
        return;
      }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      handleLocation(pos);
      setLocStatus("granted");
    } catch (err) {
      setLocStatus(`error: ${(err as Error).message}`);
    }
  };

  const startWatchingLocation = async () => {
    try {
      setLocStatus("starting…");
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status !== "granted") {
        setLocStatus(`denied: ${perm.status}`);
        return;
      }
      setSpeedHist([]);
      setAltHist([]);
      const sub = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.BestForNavigation,
          timeInterval: 1000,
          distanceInterval: 0,
        },
        handleLocation
      );
      locSubRef.current = sub;
      setLocWatching(true);
      setLocStatus("streaming");
    } catch (err) {
      setLocStatus(`error: ${(err as Error).message}`);
    }
  };

  const stopWatchingLocation = () => {
    locSubRef.current?.remove();
    locSubRef.current = null;
    setLocWatching(false);
    setLocStatus("stopped");
  };

  useEffect(() => {
    return () => {
      locSubRef.current?.remove();
    };
  }, []);

  const fireHaptic = (kind: "light" | "medium" | "heavy" | "success" | "warning" | "error") => {
    if (kind === "light") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    else if (kind === "medium") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    else if (kind === "heavy") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    else if (kind === "success") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    else if (kind === "warning") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    else if (kind === "error") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
  };

  const batteryStateLabel = (s: number) => {
    switch (s) {
      case Battery.BatteryState.UNPLUGGED: return "unplugged";
      case Battery.BatteryState.CHARGING: return "charging";
      case Battery.BatteryState.FULL: return "full";
      default: return "unknown";
    }
  };

  // Network — connection type + Wi-Fi/cellular + online
  const [network, setNetwork] = useState<Network.NetworkState | null>(null);
  useEffect(() => {
    Network.getNetworkStateAsync().then(setNetwork).catch(() => {});
    const sub = Network.addNetworkStateListener(setNetwork);
    return () => sub.remove();
  }, []);

  // Cellular — carrier + generation
  const [cellular, setCellular] = useState<{ carrier: string | null; generation: number | null; isoCountryCode: string | null; mobileCountryCode: string | null; mobileNetworkCode: string | null; allowsVoip: boolean | null } | null>(null);
  useEffect(() => {
    (async () => {
      try {
        const [carrier, generation, iso, mcc, mnc, voip] = await Promise.all([
          Cellular.getCarrierNameAsync(),
          Cellular.getCellularGenerationAsync(),
          Cellular.getIsoCountryCodeAsync(),
          Cellular.getMobileCountryCodeAsync(),
          Cellular.getMobileNetworkCodeAsync(),
          Cellular.allowsVoipAsync(),
        ]);
        setCellular({ carrier, generation, isoCountryCode: iso, mobileCountryCode: mcc, mobileNetworkCode: mnc, allowsVoip: voip });
      } catch { /* not available */ }
    })();
  }, []);

  // Brightness — read + write
  const [brightness, setBrightness] = useState<number | null>(null);
  useEffect(() => {
    Brightness.getBrightnessAsync().then(setBrightness).catch(() => {});
  }, []);
  const adjustBrightness = async (delta: number) => {
    try {
      const cur = brightness ?? (await Brightness.getBrightnessAsync());
      const next = Math.max(0, Math.min(1, cur + delta));
      await Brightness.setBrightnessAsync(next);
      setBrightness(next);
    } catch {
      // permission denied — silently fail
    }
  };

  // Screen orientation
  const [orientation, setOrientation] = useState<ScreenOrientation.Orientation | null>(null);
  useEffect(() => {
    ScreenOrientation.getOrientationAsync().then(setOrientation).catch(() => {});
    const sub = ScreenOrientation.addOrientationChangeListener((evt) => {
      setOrientation(evt.orientationInfo.orientation);
    });
    return () => ScreenOrientation.removeOrientationChangeListener(sub);
  }, []);

  // Bluetooth LE scanner — on-demand because scanning is power-hungry.
  const bleManagerRef = useRef<BleManager | null>(null);
  const [bleState, setBleState] = useState<BleState | "Unknown">("Unknown");
  const [bleScanning, setBleScanning] = useState(false);
  const [bleDevices, setBleDevices] = useState<Map<string, { id: string; name: string | null; rssi: number | null; seenAt: number }>>(new Map());

  useEffect(() => {
    const m = new BleManager();
    bleManagerRef.current = m;
    const sub = m.onStateChange((s) => setBleState(s), true);
    return () => {
      sub.remove();
      m.destroy();
      bleManagerRef.current = null;
    };
  }, []);

  const startBleScan = async () => {
    const m = bleManagerRef.current;
    if (!m) return;
    setBleDevices(new Map());
    setBleScanning(true);
    m.startDeviceScan(null, { allowDuplicates: true }, (error, device) => {
      if (error || !device) return;
      setBleDevices((prev) => {
        const next = new Map(prev);
        const existing = next.get(device.id);
        next.set(device.id, {
          id: device.id,
          name: device.name ?? device.localName ?? existing?.name ?? null,
          rssi: device.rssi ?? existing?.rssi ?? null,
          seenAt: Date.now(),
        });
        return next;
      });
    });
  };

  const stopBleScan = () => {
    bleManagerRef.current?.stopDeviceScan();
    setBleScanning(false);
  };

  useEffect(() => {
    return () => {
      bleManagerRef.current?.stopDeviceScan();
    };
  }, []);

  // Microphone frequency spectrum — uses live-audio-stream + FFT.
  // Mutually exclusive with the metering recording above (don't run both).
  const SAMPLE_RATE = 44100;
  const N_BANDS = 96;
  const MIN_FREQ = 20;
  const MAX_FREQ = 20000;
  const PEAK_DECAY = 0.92;

  const [fftSize, setFftSize] = useState<4096 | 8192>(4096);
  const fftRef = useRef<FFT | null>(null);
  const fftOutRef = useRef<number[] | null>(null);
  const windowRef = useRef<Float32Array | null>(null);
  const bandEdgesRef = useRef<Int32Array | null>(null);
  const accumRef = useRef<Float32Array>(new Float32Array(0));
  const peaksRef = useRef<Float32Array>(new Float32Array(N_BANDS));

  // Rebuild FFT, window, and band edges whenever fftSize changes.
  useEffect(() => {
    fftRef.current = new FFT(fftSize);
    fftOutRef.current = fftRef.current.createComplexArray();
    const w = new Float32Array(fftSize);
    for (let i = 0; i < fftSize; i++) {
      w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (fftSize - 1)));
    }
    windowRef.current = w;
    const edges = new Int32Array(N_BANDS + 1);
    const ratio = Math.log(MAX_FREQ / MIN_FREQ);
    for (let i = 0; i <= N_BANDS; i++) {
      const f = MIN_FREQ * Math.exp((ratio * i) / N_BANDS);
      const bin = Math.round((f * fftSize) / SAMPLE_RATE);
      edges[i] = Math.min(fftSize / 2 - 1, Math.max(0, bin));
    }
    bandEdgesRef.current = edges;
    accumRef.current = new Float32Array(0);
    peaksRef.current = new Float32Array(N_BANDS);
  }, [fftSize]);

  const [spectrum, setSpectrum] = useState<number[]>([]);
  const [peaks, setPeaks] = useState<number[]>([]);
  const [spectrumOn, setSpectrumOn] = useState(false);

  const startSpectrum = async () => {
    try {
      const perm = await Audio.requestPermissionsAsync();
      if (!perm.granted) return;
      accumRef.current = new Float32Array(0);
      peaksRef.current = new Float32Array(N_BANDS);
      const currentFftSize = fftSize;
      LiveAudioStream.init({
        sampleRate: SAMPLE_RATE,
        channels: 1,
        bitsPerSample: 16,
        audioSource: 6,
        bufferSize: currentFftSize,
        wavFile: "spectrum.wav",
      });
      LiveAudioStream.on("data", (b64: string) => {
        const fs = fftRef.current ? fftRef.current.size : currentFftSize;
        const buf =
          typeof atob === "function"
            ? atob(b64)
            : Buffer.from(b64, "base64").toString("binary");
        const incoming = new Float32Array(Math.floor(buf.length / 2));
        for (let i = 0; i < incoming.length; i++) {
          const lo = buf.charCodeAt(i * 2);
          const hi = buf.charCodeAt(i * 2 + 1);
          let v = (hi << 8) | lo;
          if (v & 0x8000) v -= 0x10000;
          incoming[i] = v / 32768;
        }
        const prev = accumRef.current;
        const combined = new Float32Array(prev.length + incoming.length);
        combined.set(prev);
        combined.set(incoming, prev.length);

        const win = windowRef.current!;
        const out = fftOutRef.current!;
        const edges = bandEdgesRef.current!;
        let offset = 0;
        let lastBands: number[] | null = null;
        while (combined.length - offset >= fs) {
          const frame = new Float32Array(fs);
          for (let i = 0; i < fs; i++) {
            frame[i] = combined[offset + i] * win[i];
          }
          fftRef.current!.realTransform(out, frame);
          fftRef.current!.completeSpectrum(out);
          const bands = new Array<number>(N_BANDS);
          // Reference for dBFS normalization: peak possible magnitude per bin
          // after the Hanning window is ~ fs * 0.5 (window gain 0.5).
          const refLevel = fs * 0.5;
          const MIN_DB = -80;
          const MAX_DB = 0;
          const range = MAX_DB - MIN_DB;
          for (let band = 0; band < N_BANDS; band++) {
            const lo = edges[band];
            const hi = Math.max(edges[band + 1], lo + 1);
            let mag = 0;
            for (let bin = lo; bin < hi; bin++) {
              const re = out[bin * 2];
              const im = out[bin * 2 + 1];
              mag += Math.sqrt(re * re + im * im);
            }
            const avg = mag / (hi - lo);
            // To dBFS, then normalize to [0..1] across MIN_DB..MAX_DB.
            const db = 20 * Math.log10(avg / refLevel + 1e-10);
            const norm = (db - MIN_DB) / range;
            bands[band] = Math.max(0, Math.min(1, norm));
          }
          lastBands = bands;
          offset += fs / 2; // 50% overlap
        }
        accumRef.current = combined.slice(offset);
        if (lastBands) {
          const p = peaksRef.current;
          const peaksOut = new Array<number>(N_BANDS);
          for (let i = 0; i < N_BANDS; i++) {
            if (lastBands[i] > p[i]) p[i] = lastBands[i];
            else p[i] *= PEAK_DECAY;
            peaksOut[i] = p[i];
          }
          setSpectrum(lastBands);
          setPeaks(peaksOut);
        }
      });
      LiveAudioStream.start();
      setSpectrumOn(true);
    } catch {
      setSpectrumOn(false);
    }
  };

  const stopSpectrum = () => {
    try { LiveAudioStream.stop(); } catch { /* */ }
    setSpectrumOn(false);
    setSpectrum([]);
    setPeaks([]);
    peaksRef.current = new Float32Array(N_BANDS);
  };

  useEffect(() => {
    return () => { try { LiveAudioStream.stop(); } catch { /* */ } };
  }, []);

  // Push token + permission status
  useEffect(() => {
    (async () => {
      try {
        const perm = await Notifications.getPermissionsAsync();
        setPushPerm(perm.status);
        if (perm.status === "granted") {
          const projectId =
            (Constants.expoConfig?.extra?.eas as { projectId?: string } | undefined)?.projectId ||
            (Constants.easConfig as { projectId?: string } | undefined)?.projectId;
          if (projectId) {
            const tok = await Notifications.getExpoPushTokenAsync({ projectId });
            setPushToken(tok.data);
          }
        }
      } catch (err) {
        setPushPerm(`error: ${(err as Error).message}`);
      }
    })();
  }, []);

  const refreshClipboard = async () => {
    try {
      const text = await Clipboard.getStringAsync();
      setClipboardSnap(text || "(empty)");
    } catch (err) {
      setClipboardSnap(`error: ${(err as Error).message}`);
    }
  };

  const copyToClipboard = (text: string, label: string) => {
    Clipboard.setStringAsync(text);
    Alert.alert("Copied", `${label} → clipboard`);
  };

  const c = Constants;

  return (
    <>
      <Text style={[styles.rowLabel, { fontSize: 13, marginBottom: 16, flex: 0 }]}>
        Sandbox of iPhone APIs reachable through Expo modules. Motion sensors update live; location is on-demand.
      </Text>

      <Section
        title="Identity"
        rows={[
          { label: "Email", value: me?.email },
          { label: "Name", value: me?.name },
          { label: "isOwner", value: me?.isOwner },
          { label: "Has session token", value: !!token },
        ]}
      />

      <Section
        title="Device (expo-device)"
        rows={[
          { label: "Brand", value: Device.brand },
          { label: "Manufacturer", value: Device.manufacturer },
          { label: "Model name", value: Device.modelName },
          { label: "Model id", value: Device.modelId },
          { label: "Design name", value: Device.designName },
          { label: "Device name", value: Device.deviceName },
          { label: "Device year class", value: Device.deviceYearClass },
          { label: "Total memory (bytes)", value: Device.totalMemory },
          { label: "OS name", value: Device.osName },
          { label: "OS version", value: Device.osVersion },
          { label: "OS build id", value: Device.osBuildId },
          { label: "Is real device", value: Device.isDevice },
        ]}
      />

      <Section
        title="App + runtime (expo-constants)"
        rows={[
          { label: "App version", value: c?.expoConfig?.version },
          { label: "Slug", value: c?.expoConfig?.slug },
          { label: "Scheme", value: typeof c?.expoConfig?.scheme === "string" ? c.expoConfig.scheme : undefined },
          { label: "Platform", value: Platform.OS },
          { label: "Status bar height", value: c?.statusBarHeight },
          { label: "Session ID", value: c?.sessionId },
          { label: "Native app version", value: c?.nativeAppVersion },
          { label: "Native build version", value: c?.nativeBuildVersion },
        ]}
      />

      <Section
        title="Notifications (expo-notifications)"
        rows={[
          { label: "Permission status", value: pushPerm },
          { label: "Expo push token", value: pushToken ? pushToken.slice(0, 28) + "…" : null },
        ]}
      />
      {pushToken && (
        <Pressable
          style={styles.btn}
          onPress={() => copyToClipboard(pushToken, "Push token")}
        >
          <Text style={styles.btnText}>Copy full push token</Text>
        </Pressable>
      )}

      <Section
        title="Clipboard (expo-clipboard)"
        rows={[{ label: "Current clipboard", value: clipboardSnap || "(tap Read below)" }]}
      />
      <Pressable style={styles.btn} onPress={refreshClipboard}>
        <Text style={styles.btnText}>Read clipboard</Text>
      </Pressable>

      <Text style={styles.sectionTitle}>Accelerometer</Text>
      <View style={[styles.card, { padding: 6, marginBottom: 4 }]}>
        <Sparkline samples={accelHist} color={theme.primary} />
      </View>
      <Section
        title=""
        rows={[
          { label: "x", value: accel ? fmt(accel.x, 3) : null },
          { label: "y", value: accel ? fmt(accel.y, 3) : null },
          { label: "z", value: accel ? fmt(accel.z, 3) : null },
        ]}
      />

      <Text style={styles.sectionTitle}>Gyroscope</Text>
      <View style={[styles.card, { padding: 6, marginBottom: 4 }]}>
        <Sparkline samples={gyroHist} color={theme.warning} />
      </View>
      <Section
        title=""
        rows={[
          { label: "x", value: gyro ? fmt(gyro.x, 3) : null },
          { label: "y", value: gyro ? fmt(gyro.y, 3) : null },
          { label: "z", value: gyro ? fmt(gyro.z, 3) : null },
        ]}
      />

      <Text style={styles.sectionTitle}>Magnetometer</Text>
      <View style={[styles.card, { padding: 6, marginBottom: 4 }]}>
        <Sparkline samples={magHist} color={theme.destructive} />
      </View>
      <Section
        title=""
        rows={[
          { label: "x", value: mag ? fmt(mag.x, 1) : null },
          { label: "y", value: mag ? fmt(mag.y, 1) : null },
          { label: "z", value: mag ? fmt(mag.z, 1) : null },
        ]}
      />

      <Text style={styles.sectionTitle}>Device Motion (fused)</Text>
      <View style={[styles.card, { padding: 12, marginBottom: 4, flexDirection: "row", justifyContent: "space-around", alignItems: "center" }]}>
        <TiltIndicator
          pitchDeg={motion?.rotation ? (motion.rotation.beta * 180) / Math.PI : 0}
          rollDeg={motion?.rotation ? (motion.rotation.gamma * 180) / Math.PI : 0}
          color={theme.primary}
        />
        <CompassArrow
          headingDeg={motion?.rotation ? (motion.rotation.alpha * 180) / Math.PI : 0}
          color={theme.primary}
        />
      </View>
      <Section
        title=""
        rows={[
          { label: "Pitch (°)", value: motion?.rotation ? fmt((motion.rotation.beta * 180) / Math.PI, 1) : null },
          { label: "Roll (°)", value: motion?.rotation ? fmt((motion.rotation.gamma * 180) / Math.PI, 1) : null },
          { label: "Yaw (°)", value: motion?.rotation ? fmt((motion.rotation.alpha * 180) / Math.PI, 1) : null },
          { label: "Gravity x", value: motion?.accelerationIncludingGravity ? fmt(motion.accelerationIncludingGravity.x, 3) : null },
          { label: "Gravity y", value: motion?.accelerationIncludingGravity ? fmt(motion.accelerationIncludingGravity.y, 3) : null },
          { label: "Gravity z", value: motion?.accelerationIncludingGravity ? fmt(motion.accelerationIncludingGravity.z, 3) : null },
          { label: "User accel x", value: motion?.acceleration ? fmt(motion.acceleration.x, 3) : null },
          { label: "User accel y", value: motion?.acceleration ? fmt(motion.acceleration.y, 3) : null },
          { label: "User accel z", value: motion?.acceleration ? fmt(motion.acceleration.z, 3) : null },
        ]}
      />

      {(() => {
        const wrap180 = (d: number) => {
          let x = d;
          while (x > 180) x -= 360;
          while (x < -180) x += 360;
          return x;
        };
        const dPitch = motion?.rotation && motionZero ? wrap180(((motion.rotation.beta - motionZero.beta) * 180) / Math.PI) : 0;
        const dRoll = motion?.rotation && motionZero ? wrap180(((motion.rotation.gamma - motionZero.gamma) * 180) / Math.PI) : 0;
        const dYaw = motion?.rotation && motionZero ? wrap180(((motion.rotation.alpha - motionZero.alpha) * 180) / Math.PI) : 0;
        return (
          <View style={[styles.card, { padding: 14, marginBottom: 4 }]}>
            <Text style={{ fontSize: 11, fontWeight: "600", color: theme.textSubtle, textTransform: "uppercase", marginBottom: 10 }}>
              Relative orientation
            </Text>
            <View style={{ flexDirection: "row", justifyContent: "space-around", alignItems: "center", marginBottom: 12 }}>
              <TiltIndicator pitchDeg={dPitch} rollDeg={dRoll} color={theme.highlight} size={80} />
              <CompassArrow headingDeg={dYaw} color={theme.highlight} size={64} />
            </View>
            <View style={{ flexDirection: "row", justifyContent: "space-around", marginBottom: 10 }}>
              {[
                { label: "Δ pitch", value: dPitch },
                { label: "Δ roll", value: dRoll },
                { label: "Δ yaw", value: dYaw },
              ].map((d) => (
                <View key={d.label} style={{ alignItems: "center" }}>
                  <Text style={{ fontSize: 11, color: theme.textSubtle, fontWeight: "600", textTransform: "uppercase" }}>{d.label}</Text>
                  <Text style={{ fontSize: 18, fontWeight: "700", color: motionZero ? theme.text : theme.textSubtle, marginTop: 2 }}>
                    {motionZero ? fmt(d.value, 1) : "—"}°
                  </Text>
                </View>
              ))}
            </View>
            <Pressable
              onPress={() => motion?.rotation && setMotionZero({ alpha: motion.rotation.alpha, beta: motion.rotation.beta, gamma: motion.rotation.gamma })}
              style={{
                paddingVertical: 10,
                borderRadius: 8,
                alignItems: "center",
                backgroundColor: theme.surfaceAlt,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: theme.border,
              }}
            >
              <Text style={{ fontSize: 13, fontWeight: "600", color: theme.primary }}>
                {motionZero ? "Re-zero" : "Zero here"}
              </Text>
            </Pressable>
          </View>
        );
      })()}

      <View style={[styles.card, { padding: 14, marginBottom: 4 }]}>
        <Text style={{ fontSize: 11, fontWeight: "600", color: theme.textSubtle, textTransform: "uppercase", marginBottom: 4 }}>
          Position (double-integrated)
        </Text>
        <Text style={{ fontSize: 11, color: theme.textSubtle, marginBottom: 10, fontStyle: "italic" }}>
          Drifts fast — sensor noise compounds. Tap reset often.
        </Text>
        <View style={{ flexDirection: "row", justifyContent: "space-around", marginBottom: 12 }}>
          {[
            { label: "Δ x", value: posDisplay.x },
            { label: "Δ y", value: posDisplay.y },
            { label: "Δ z", value: posDisplay.z },
          ].map((d) => (
            <View key={d.label} style={{ alignItems: "center" }}>
              <Text style={{ fontSize: 11, color: theme.textSubtle, fontWeight: "600", textTransform: "uppercase" }}>{d.label}</Text>
              <Text style={{ fontSize: 18, fontWeight: "700", color: posTracking ? theme.text : theme.textSubtle, marginTop: 2 }}>
                {posTracking ? `${(d.value * 100).toFixed(1)} cm` : "—"}
              </Text>
            </View>
          ))}
        </View>
        <Text style={{ fontSize: 12, color: theme.textMuted, textAlign: "center", marginBottom: 10 }}>
          velocity magnitude: {posTracking ? `${posDisplay.vmag.toFixed(3)} m/s` : "—"}
        </Text>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Pressable
            onPress={() => setPosTracking((p) => !p)}
            style={{
              flex: 1,
              paddingVertical: 10,
              borderRadius: 8,
              alignItems: "center",
              backgroundColor: posTracking ? theme.destructive : theme.primary,
            }}
          >
            <Text style={{ fontSize: 13, fontWeight: "600", color: "#fff" }}>
              {posTracking ? "Stop" : "Start tracking"}
            </Text>
          </Pressable>
          {posTracking && (
            <Pressable
              onPress={resetPosition}
              style={{
                flex: 1,
                paddingVertical: 10,
                borderRadius: 8,
                alignItems: "center",
                backgroundColor: theme.surfaceAlt,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: theme.border,
              }}
            >
              <Text style={{ fontSize: 13, fontWeight: "600", color: theme.primary }}>Reset</Text>
            </Pressable>
          )}
        </View>
      </View>

      <Text style={styles.sectionTitle}>Barometer</Text>
      <View style={[styles.card, { padding: 6, marginBottom: 4, position: "relative" }]}>
        <Sparkline samples={pressureHist} color={theme.accent} height={48} />
        {pressure && (
          <Text
            style={{
              position: "absolute",
              top: 6,
              right: 10,
              fontSize: 10,
              fontWeight: "600",
              color: theme.textSubtle,
            }}
          >
            {(pressure.pressure * 0.0145038).toFixed(3)} psi
          </Text>
        )}
      </View>
      <View style={[styles.card, { padding: 14, marginBottom: 4 }]}>
        <Text style={{ fontSize: 11, fontWeight: "600", color: theme.textSubtle, textTransform: "uppercase", marginBottom: 6 }}>
          Relative altitude
        </Text>
        <Text style={{ fontSize: 28, fontWeight: "700", color: theme.text, marginBottom: 10 }}>
          {pressure?.relativeAltitude != null
            ? formatAltitude(pressure.relativeAltitude - altZero, altUnit)
            : "—"}
        </Text>
        <View style={{ flexDirection: "row", gap: 6, marginBottom: 10 }}>
          {ALT_UNITS.map((u) => {
            const active = altUnit === u.value;
            return (
              <Pressable
                key={u.value}
                onPress={() => setAltUnit(u.value)}
                style={{
                  flex: 1,
                  paddingVertical: 8,
                  borderRadius: 8,
                  alignItems: "center",
                  backgroundColor: active ? theme.primary : theme.surfaceAlt,
                  borderWidth: active ? 0 : StyleSheet.hairlineWidth,
                  borderColor: theme.border,
                }}
              >
                <Text style={{ fontSize: 13, fontWeight: "600", color: active ? "#fff" : theme.text }}>{u.label}</Text>
              </Pressable>
            );
          })}
        </View>
        <Pressable
          onPress={() => setAltZero(pressure?.relativeAltitude ?? 0)}
          style={{
            paddingVertical: 10,
            borderRadius: 8,
            alignItems: "center",
            backgroundColor: theme.surfaceAlt,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: theme.border,
          }}
        >
          <Text style={{ fontSize: 13, fontWeight: "600", color: theme.primary }}>
            Zero here
          </Text>
        </Pressable>
      </View>
      <Section
        title=""
        rows={[
          { label: "Available", value: baroAvailable },
          { label: "Pressure (hPa)", value: pressure ? fmt(pressure.pressure, 2) : null },
          { label: "Raw rel. alt. (m)", value: pressure?.relativeAltitude != null ? fmt(pressure.relativeAltitude, 4) : null },
        ]}
      />

      <Text style={styles.sectionTitle}>Pedometer</Text>
      <View style={[styles.card, { padding: 14, marginBottom: 4 }]}>
        <BarGauge value={stepsToday ?? 0} max={10000} color={theme.primary} />
        <Text style={{ marginTop: 6, fontSize: 12, color: theme.textMuted, textAlign: "right" }}>
          {(stepsToday ?? 0).toLocaleString()} / 10,000 steps
        </Text>
      </View>
      <Section
        title=""
        rows={[
          { label: "Available", value: pedAvailable },
          { label: "Steps today", value: stepsToday },
          { label: "Steps since open", value: liveSteps },
        ]}
      />

      <Text style={styles.sectionTitle}>Battery</Text>
      <View style={[styles.card, { padding: 14, marginBottom: 4 }]}>
        <BarGauge
          value={battery?.level ?? 0}
          max={1}
          color={
            battery == null
              ? theme.textSubtle
              : battery.level < 0.2
                ? theme.destructive
                : battery.level < 0.4
                  ? theme.warning
                  : theme.primary
          }
          height={18}
        />
        <Text style={{ marginTop: 6, fontSize: 12, color: theme.textMuted, textAlign: "right" }}>
          {battery ? `${Math.round(battery.level * 100)}%${battery.state === Battery.BatteryState.CHARGING ? " · charging" : battery.lowPower ? " · low power" : ""}` : "—"}
        </Text>
      </View>
      <Section
        title=""
        rows={[
          { label: "State", value: battery ? batteryStateLabel(battery.state) : null },
          { label: "Low power mode", value: battery?.lowPower },
        ]}
      />

      <Text style={styles.sectionTitle}>Microphone</Text>
      <View style={[styles.card, { padding: 6, marginBottom: 4 }]}>
        <Sparkline samples={micHist} color={theme.highlight} height={56} />
      </View>
      <View style={[styles.card, { padding: 14, marginBottom: 4 }]}>
        <BarGauge value={micLevel ?? 0} max={1} color={theme.highlight} height={14} />
        <Text style={{ marginTop: 6, fontSize: 12, color: theme.textMuted, textAlign: "right" }}>
          {micRecording
            ? `${Math.round((micLevel ?? 0) * 100)}% · peak ${Math.round(micPeak * 100)}%`
            : micStatus}
        </Text>
        <Pressable
          style={[styles.btn, { marginTop: 10, marginBottom: 0 }]}
          onPress={micRecording ? stopMic : startMic}
        >
          <Text style={styles.btnText}>{micRecording ? "Stop listening" : "Start listening"}</Text>
        </Pressable>
      </View>

      <Text style={styles.sectionTitle}>Location</Text>
      <View style={[styles.card, { padding: 12, marginBottom: 4, flexDirection: "row", justifyContent: "space-around", alignItems: "center" }]}>
        <CompassArrow
          headingDeg={loc?.coords.heading ?? 0}
          color={theme.primary}
          size={70}
        />
        <View style={{ flex: 1, marginLeft: 16 }}>
          <Text style={{ fontSize: 11, color: theme.textSubtle, fontWeight: "600", textTransform: "uppercase" }}>Speed (m/s)</Text>
          <Sparkline samples={speedHist} color={theme.primary} height={28} />
          <Text style={{ fontSize: 11, color: theme.textSubtle, fontWeight: "600", textTransform: "uppercase", marginTop: 6 }}>Altitude (m)</Text>
          <Sparkline samples={altHist} color={theme.accent} height={28} />
        </View>
      </View>
      <Section
        title=""
        rows={[
          { label: "Status", value: locStatus },
          { label: "Latitude", value: loc ? fmt(loc.coords.latitude, 5) : null },
          { label: "Longitude", value: loc ? fmt(loc.coords.longitude, 5) : null },
          { label: "Accuracy (m)", value: loc?.coords.accuracy != null ? fmt(loc.coords.accuracy, 1) : null },
          { label: "Altitude (m)", value: loc?.coords.altitude != null ? fmt(loc.coords.altitude, 1) : null },
          { label: "Heading (°)", value: loc?.coords.heading != null ? fmt(loc.coords.heading, 1) : null },
          { label: "Speed (m/s)", value: loc?.coords.speed != null ? fmt(loc.coords.speed, 2) : null },
        ]}
      />
      <View style={{ flexDirection: "row", gap: 8, marginBottom: 20 }}>
        <Pressable
          style={[styles.btn, { flex: 1, marginBottom: 0 }]}
          onPress={locWatching ? stopWatchingLocation : startWatchingLocation}
        >
          <Text style={styles.btnText}>{locWatching ? "Stop streaming" : "Start streaming"}</Text>
        </Pressable>
        <Pressable
          style={[styles.btn, { flex: 1, marginBottom: 0, backgroundColor: theme.surfaceAlt, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.border }]}
          onPress={requestLocation}
        >
          <Text style={[styles.btnText, { color: theme.primary }]}>One reading</Text>
        </Pressable>
      </View>

      <Text style={styles.sectionTitle}>Haptics (expo-haptics)</Text>
      <View style={[styles.card, { padding: 8 }]}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {(["light", "medium", "heavy", "success", "warning", "error"] as const).map((k) => (
            <Pressable
              key={k}
              style={styles.hapBtn}
              onPress={() => fireHaptic(k)}
            >
              <Text style={styles.hapBtnText}>{k}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      <Section
        title="Network"
        rows={[
          { label: "Is connected", value: network?.isConnected },
          { label: "Is internet reachable", value: network?.isInternetReachable },
          { label: "Type", value: network?.type ?? null },
        ]}
      />

      <Section
        title="Cellular"
        rows={[
          { label: "Carrier", value: cellular?.carrier },
          { label: "Generation", value: cellular?.generation != null ? generationLabel(cellular.generation) : null },
          { label: "ISO country", value: cellular?.isoCountryCode },
          { label: "MCC", value: cellular?.mobileCountryCode },
          { label: "MNC", value: cellular?.mobileNetworkCode },
          { label: "Allows VOIP", value: cellular?.allowsVoip },
        ]}
      />

      <Text style={styles.sectionTitle}>Brightness</Text>
      <View style={[styles.card, { padding: 14, marginBottom: 4 }]}>
        <BarGauge value={brightness ?? 0} max={1} color={theme.accent} height={16} />
        <Text style={{ marginTop: 6, fontSize: 12, color: theme.textMuted, textAlign: "right" }}>
          {brightness != null ? `${Math.round(brightness * 100)}%` : "—"}
        </Text>
        <View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}>
          {[-0.2, -0.05, 0.05, 0.2].map((d) => (
            <Pressable
              key={d}
              onPress={() => adjustBrightness(d)}
              style={{ flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: "center", backgroundColor: theme.surfaceAlt, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.border }}
            >
              <Text style={{ fontSize: 13, fontWeight: "600", color: theme.text }}>{d > 0 ? `+${Math.round(d * 100)}%` : `${Math.round(d * 100)}%`}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      <Section
        title="Screen orientation"
        rows={[{ label: "Current", value: orientation != null ? orientationLabel(orientation) : null }]}
      />

      <Text style={styles.sectionTitle}>Bluetooth (BLE scan)</Text>
      <View style={[styles.card, { padding: 14, marginBottom: 4 }]}>
        <Text style={{ fontSize: 12, color: theme.textMuted, marginBottom: 8 }}>
          State: {bleState}{bleScanning ? " · scanning" : ""}
        </Text>
        <Pressable
          onPress={bleScanning ? stopBleScan : startBleScan}
          style={{ paddingVertical: 10, borderRadius: 8, alignItems: "center", backgroundColor: bleScanning ? theme.destructive : theme.primary, marginBottom: 10 }}
        >
          <Text style={{ color: "#fff", fontSize: 13, fontWeight: "600" }}>
            {bleScanning ? "Stop scan" : "Start scan"}
          </Text>
        </Pressable>
        {Array.from(bleDevices.values())
          .sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999))
          .slice(0, 20)
          .map((d) => (
            <View key={d.id} style={{ flexDirection: "row", paddingVertical: 6, alignItems: "center", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border }}>
              <View style={{ flex: 1, marginRight: 8 }}>
                <Text style={{ color: theme.text, fontSize: 13 }} numberOfLines={1}>{d.name || "(no name)"}</Text>
                <Text style={{ color: theme.textSubtle, fontSize: 10 }} numberOfLines={1}>{d.id}</Text>
              </View>
              <Text style={{ color: rssiColor(d.rssi, theme), fontSize: 13, fontWeight: "700" }}>
                {d.rssi != null ? `${d.rssi} dBm` : "—"}
              </Text>
            </View>
          ))}
      </View>

      <Text style={styles.sectionTitle}>Microphone spectrum</Text>
      <View style={[styles.card, { padding: 6, marginBottom: 4 }]}>
        <SpectrumBars samples={spectrum} peaks={peaks} height={90} />
      </View>
      <View style={[styles.card, { padding: 14, marginBottom: 4 }]}>
        <View style={{ flexDirection: "row", gap: 6, marginBottom: 10 }}>
          {([4096, 8192] as const).map((sz) => {
            const active = fftSize === sz;
            return (
              <Pressable
                key={sz}
                onPress={() => !spectrumOn && setFftSize(sz)}
                disabled={spectrumOn}
                style={{
                  flex: 1,
                  paddingVertical: 8,
                  borderRadius: 8,
                  alignItems: "center",
                  backgroundColor: active ? theme.primary : theme.surfaceAlt,
                  borderWidth: active ? 0 : StyleSheet.hairlineWidth,
                  borderColor: theme.border,
                  opacity: spectrumOn && !active ? 0.4 : 1,
                }}
              >
                <Text style={{ fontSize: 13, fontWeight: "600", color: active ? "#fff" : theme.text }}>
                  {sz}-pt FFT
                </Text>
              </Pressable>
            );
          })}
        </View>
        <Pressable
          onPress={spectrumOn ? stopSpectrum : startSpectrum}
          style={{ paddingVertical: 10, borderRadius: 8, alignItems: "center", backgroundColor: spectrumOn ? theme.destructive : theme.primary }}
        >
          <Text style={{ color: "#fff", fontSize: 13, fontWeight: "600" }}>
            {spectrumOn ? "Stop" : "Start"} spectrum
          </Text>
        </Pressable>
        <Text style={{ marginTop: 6, fontSize: 11, color: theme.textSubtle, textAlign: "center" }}>
          96 log-spaced bands · 20 Hz – 20 kHz · {(SAMPLE_RATE / fftSize).toFixed(1)} Hz/bin · dBFS -80…0
        </Text>
      </View>
    </>
  );
}

function generationLabel(g: number): string {
  switch (g) {
    case Cellular.CellularGeneration.CELLULAR_2G: return "2G";
    case Cellular.CellularGeneration.CELLULAR_3G: return "3G";
    case Cellular.CellularGeneration.CELLULAR_4G: return "4G";
    case Cellular.CellularGeneration.CELLULAR_5G: return "5G";
    default: return "unknown";
  }
}

function orientationLabel(o: ScreenOrientation.Orientation): string {
  switch (o) {
    case ScreenOrientation.Orientation.PORTRAIT_UP: return "portrait";
    case ScreenOrientation.Orientation.PORTRAIT_DOWN: return "portrait upside-down";
    case ScreenOrientation.Orientation.LANDSCAPE_LEFT: return "landscape left";
    case ScreenOrientation.Orientation.LANDSCAPE_RIGHT: return "landscape right";
    default: return "unknown";
  }
}

function rssiColor(rssi: number | null, theme: Theme): string {
  if (rssi == null) return theme.textSubtle;
  if (rssi > -55) return theme.primary;
  if (rssi > -75) return theme.warning;
  return theme.destructive;
}

function SpectrumBars({ samples, peaks, height = 90 }: { samples: number[]; peaks?: number[]; height?: number }) {
  if (samples.length === 0) {
    return <View style={{ height, backgroundColor: "transparent" }} />;
  }
  // Samples are normalized [0..1] dBFS — no auto-scale.
  const peaksArr = peaks && peaks.length === samples.length ? peaks : samples;
  const usable = height - 4;
  const n = samples.length;
  return (
    <View style={{ height, flexDirection: "row", alignItems: "flex-end", paddingHorizontal: 2 }}>
      {samples.map((v, i) => {
        const barH = Math.max(1, v * usable);
        const peakH = Math.max(1, peaksArr[i] * usable);
        const hue = (i / (n - 1)) * 260;
        const barColor = `hsl(${hue.toFixed(0)}, 75%, 50%)`;
        const peakColor = `hsl(${hue.toFixed(0)}, 80%, 75%)`;
        return (
          <View key={i} style={{ flex: 1, height, position: "relative", marginRight: 1 }}>
            <View
              style={{
                position: "absolute",
                bottom: 0,
                left: 0,
                right: 0,
                height: barH,
                backgroundColor: barColor,
                borderRadius: 1,
              }}
            />
            {peaks && (
              <View
                style={{
                  position: "absolute",
                  bottom: Math.min(usable - 2, Math.max(0, peakH - 2)),
                  left: 0,
                  right: 0,
                  height: 2,
                  backgroundColor: peakColor,
                  borderRadius: 1,
                }}
              />
            )}
          </View>
        );
      })}
    </View>
  );
}

function makeStyles(theme: Theme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.background },
    sectionTitle: {
      fontSize: 12,
      fontWeight: "600",
      color: theme.textSubtle,
      textTransform: "uppercase",
      marginBottom: 6,
      marginLeft: 4,
    },
    card: { backgroundColor: theme.surface, borderRadius: 12, overflow: "hidden" },
    row: {
      flexDirection: "row",
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
    },
    rowLabel: { flex: 1, fontSize: 13, color: theme.textMuted },
    rowValue: { flex: 1, fontSize: 13, color: theme.text, textAlign: "right" },
    btn: {
      backgroundColor: theme.primary,
      paddingVertical: 12,
      alignItems: "center",
      borderRadius: 10,
      marginTop: -10,
      marginBottom: 20,
    },
    btnText: { color: "#fff", fontWeight: "600", fontSize: 14 },
    hapBtn: {
      backgroundColor: theme.surfaceAlt,
      borderColor: theme.primary,
      borderWidth: StyleSheet.hairlineWidth,
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: 16,
    },
    hapBtnText: { color: theme.primary, fontWeight: "600", fontSize: 13 },
  });
}
