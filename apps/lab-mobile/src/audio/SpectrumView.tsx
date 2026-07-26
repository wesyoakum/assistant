// Microphone audio spectrum (extracted from the archived experiments Lab
// screen). Live mic input → FFT → log-spaced band powers rendered as bars.
// Optional note/chord identification via ./chords.
//
// Native modules used (both already installed, no rebuild needed):
//   - react-native-live-audio-stream   (mic capture)
//   - fft.js                            (radix-4 real FFT)
//   - expo-av                           (mic permission prompt)
//
// The extraction dropped two features from the original: the fullscreen
// modal + orientation unlock, and the pan/pinch gestures on the chart.
// The RangeSlider controls set frequency / dB range with the same result.

import React, { useEffect, useRef, useState } from "react";
import { View, Text, Pressable, ScrollView, StyleSheet } from "react-native";
import { Audio } from "expo-av";
import LiveAudioStream from "react-native-live-audio-stream";
import FFT from "fft.js";
import { useTheme, type Theme } from "../theme";
import { detectNotes } from "./chords";

const SAMPLE_RATE = 44100;
const N_BANDS = 96;
const PEAK_DECAY = 0.92;

export function SpectrumView() {
  const theme = useTheme();
  const [fftSize, setFftSize] = useState<4096 | 8192>(4096);
  const [spectrumScale, setSpectrumScale] = useState<"notes" | "linear">("notes");
  const [freqMin, setFreqMin] = useState<number>(27.5);
  const [freqMax, setFreqMax] = useState<number>(7040);
  const [dbFloor, setDbFloor] = useState<number>(-80);
  const [dbCeil, setDbCeil] = useState<number>(0);

  const fftRef = useRef<FFT | null>(null);
  const fftOutRef = useRef<number[] | null>(null);
  const windowRef = useRef<Float32Array | null>(null);
  const bandEdgesRef = useRef<Int32Array | null>(null);
  const accumRef = useRef<Float32Array>(new Float32Array(0));
  const peaksRef = useRef<Float32Array>(new Float32Array(N_BANDS));

  // Rebuild FFT, window, and band edges when size/scale/range change.
  useEffect(() => {
    fftRef.current = new FFT(fftSize);
    fftOutRef.current = fftRef.current.createComplexArray();
    const w = new Float32Array(fftSize);
    for (let i = 0; i < fftSize; i++) {
      w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (fftSize - 1)));
    }
    windowRef.current = w;
    const edges = new Int32Array(N_BANDS + 1);
    const maxBin = fftSize / 2 - 1;
    for (let i = 0; i <= N_BANDS; i++) {
      let f: number;
      if (spectrumScale === "notes") {
        const ratio = Math.log(freqMax / freqMin);
        f = freqMin * Math.exp((ratio * i) / N_BANDS);
      } else {
        f = freqMin + ((freqMax - freqMin) * i) / N_BANDS;
      }
      const bin = Math.round((f * fftSize) / SAMPLE_RATE);
      edges[i] = Math.min(maxBin, Math.max(0, bin));
    }
    bandEdgesRef.current = edges;
    accumRef.current = new Float32Array(0);
    peaksRef.current = new Float32Array(N_BANDS);
  }, [fftSize, spectrumScale, freqMin, freqMax]);

  const [spectrum, setSpectrum] = useState<number[]>([]);
  const [peaks, setPeaks] = useState<number[]>([]);
  const [spectrumOn, setSpectrumOn] = useState(false);
  const [permError, setPermError] = useState<string | null>(null);

  const startSpectrum = async () => {
    setPermError(null);
    try {
      const perm = await Audio.requestPermissionsAsync();
      if (!perm.granted) {
        setPermError("Microphone permission was denied. Enable it in Settings → whyLab.");
        return;
      }
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
        const buf = typeof atob === "function"
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
          for (let i = 0; i < fs; i++) frame[i] = combined[offset + i]! * win[i]!;
          fftRef.current!.realTransform(out, frame);
          fftRef.current!.completeSpectrum(out);
          const bands = new Array<number>(N_BANDS);
          // Hanning window has ~0.5 gain, so peak possible per-bin magnitude is fs*0.5.
          const refLevel = fs * 0.5;
          const range = dbCeil - dbFloor;
          for (let band = 0; band < N_BANDS; band++) {
            const lo = edges[band]!;
            const hi = Math.max(edges[band + 1]!, lo + 1);
            let mag = 0;
            for (let bin = lo; bin < hi; bin++) {
              const re = out[bin * 2]!;
              const im = out[bin * 2 + 1]!;
              mag += Math.sqrt(re * re + im * im);
            }
            const avg = mag / (hi - lo);
            const db = 20 * Math.log10(avg / refLevel + 1e-10);
            const norm = (db - dbFloor) / range;
            bands[band] = Math.max(0, Math.min(1, norm));
          }
          lastBands = bands;
          offset += fs / 2;  // 50% overlap
        }
        accumRef.current = combined.slice(offset);
        if (lastBands) {
          const p = peaksRef.current;
          const peaksOut = new Array<number>(N_BANDS);
          for (let i = 0; i < N_BANDS; i++) {
            if (lastBands[i]! > p[i]!) p[i] = lastBands[i]!;
            else p[i] *= PEAK_DECAY;
            peaksOut[i] = p[i]!;
          }
          setSpectrum(lastBands);
          setPeaks(peaksOut);
        }
      });
      LiveAudioStream.start();
      setSpectrumOn(true);
    } catch (e) {
      setPermError(`Could not start mic: ${(e as Error).message}`);
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

  useEffect(() => () => { try { LiveAudioStream.stop(); } catch { /* */ } }, []);

  const styles = makeStyles(theme);

  return (
    <ScrollView contentContainerStyle={{ padding: 12 }}>
      <Text style={{ fontSize: 18, fontWeight: "700", color: theme.text, marginBottom: 6 }}>
        Audio spectrum
      </Text>
      <Text style={{ fontSize: 12, color: theme.textSubtle, marginBottom: 12 }}>
        Live mic input → {fftSize}-pt FFT → {N_BANDS} log-spaced bands. Peak markers decay ~8% per frame. Note labels appear when the scale is set to Notes.
      </Text>

      <View style={styles.card}>
        <SpectrumBars
          samples={spectrum}
          peaks={peaks}
          height={200}
          bandEdges={bandEdgesRef.current}
          sampleRate={SAMPLE_RATE}
          fftSize={fftSize}
        />
      </View>

      <View style={[styles.card, { padding: 14, marginTop: 8 }]}>
        <View style={{ flexDirection: "row", gap: 6, marginBottom: 8 }}>
          {(["notes", "linear"] as const).map((s) => {
            const active = spectrumScale === s;
            return (
              <Pressable
                key={s}
                onPress={() => setSpectrumScale(s)}
                style={[styles.pill, active ? styles.pillActive : styles.pillInactive]}
              >
                <Text style={{ fontSize: 13, fontWeight: "600", color: active ? "#fff" : theme.text }}>
                  {s === "notes" ? "Notes" : "Linear"}
                </Text>
              </Pressable>
            );
          })}
        </View>
        <View style={{ flexDirection: "row", gap: 6, marginBottom: 10 }}>
          {([4096, 8192] as const).map((sz) => {
            const active = fftSize === sz;
            return (
              <Pressable
                key={sz}
                onPress={() => !spectrumOn && setFftSize(sz)}
                disabled={spectrumOn}
                style={[
                  styles.pill,
                  active ? styles.pillActive : styles.pillInactive,
                  spectrumOn && !active ? { opacity: 0.4 } : null,
                ]}
              >
                <Text style={{ fontSize: 13, fontWeight: "600", color: active ? "#fff" : theme.text }}>
                  {sz}-pt FFT
                </Text>
              </Pressable>
            );
          })}
        </View>

        <RangeSlider
          label="Frequency"
          minValue={freqMin}
          maxValue={freqMax}
          onChange={(lo, hi) => {
            const newLo = Math.max(10, Math.min(hi / 1.05, lo));
            const newHi = Math.max(newLo * 1.05, Math.min(22000, hi));
            setFreqMin(newLo);
            setFreqMax(newHi);
          }}
          min={10}
          max={22000}
          log
          format={(v) => v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${v.toFixed(v < 100 ? 1 : 0)}`}
          theme={theme}
        />
        <RangeSlider
          label="dB range"
          minValue={dbFloor}
          maxValue={dbCeil}
          onChange={(lo, hi) => {
            const newLo = Math.round(Math.max(-160, Math.min(hi - 10, lo)));
            const newHi = Math.round(Math.max(newLo + 10, Math.min(20, hi)));
            setDbFloor(newLo);
            setDbCeil(newHi);
          }}
          min={-160}
          max={20}
          format={(v) => `${Math.round(v)}`}
          theme={theme}
        />

        <Pressable
          onPress={spectrumOn ? stopSpectrum : startSpectrum}
          style={{
            paddingVertical: 10,
            borderRadius: 8,
            alignItems: "center",
            backgroundColor: spectrumOn ? theme.destructive : theme.primary,
            marginTop: 8,
          }}
        >
          <Text style={{ color: "#fff", fontSize: 13, fontWeight: "600" }}>
            {spectrumOn ? "Stop" : "Start"} spectrum
          </Text>
        </Pressable>
        <Text style={{ marginTop: 6, fontSize: 11, color: theme.textSubtle, textAlign: "center" }}>
          {N_BANDS} bands · {spectrumScale === "notes" ? "log" : "linear"} {fmtHz(freqMin)} – {fmtHz(freqMax)} · {(SAMPLE_RATE / fftSize).toFixed(1)} Hz/bin · dBFS {dbFloor}…{dbCeil}
        </Text>
        {permError && (
          <Text style={{ marginTop: 6, fontSize: 11, color: theme.destructive, textAlign: "center" }}>
            {permError}
          </Text>
        )}
      </View>
    </ScrollView>
  );
}

function fmtHz(hz: number): string {
  if (hz >= 1000) return `${(hz / 1000).toFixed(hz < 10000 ? 1 : 0)} kHz`;
  return `${hz < 100 ? hz.toFixed(1) : hz.toFixed(0)} Hz`;
}

function SpectrumBars({ samples, peaks, height = 90, bandEdges, sampleRate, fftSize }: {
  samples: number[]; peaks?: number[]; height?: number;
  bandEdges?: Int32Array | null; sampleRate?: number; fftSize?: number;
}) {
  if (samples.length === 0) {
    return <View style={{ height: height + 18, backgroundColor: "transparent" }} />;
  }
  const peaksArr = peaks && peaks.length === samples.length ? peaks : samples;
  const noteHeight = 18;
  const totalHeight = height + noteHeight;
  const usable = height - 4;
  const n = samples.length;

  const notes = bandEdges && sampleRate && fftSize
    ? detectNotes(peaksArr, bandEdges, 0.15, sampleRate, fftSize)
    : [];

  const noteBands = new Map<number, string>();
  if (bandEdges && sampleRate && fftSize) {
    for (const note of notes) {
      for (let i = 0; i < n; i++) {
        const loFreq = (bandEdges[i]! * sampleRate) / fftSize;
        const hiFreq = (bandEdges[i + 1]! * sampleRate) / fftSize;
        if (note.freq >= loFreq && note.freq < hiFreq) {
          noteBands.set(i, note.name.replace(/\d+$/, ""));
          break;
        }
      }
    }
  }

  return (
    <View style={{ height: totalHeight, padding: 6 }}>
      <View style={{ height, flexDirection: "row", alignItems: "flex-end", paddingHorizontal: 2 }}>
        {samples.map((v, i) => {
          const barH = Math.max(1, v * usable);
          const peakH = Math.max(1, peaksArr[i]! * usable);
          const hue = (i / Math.max(1, n - 1)) * 260;
          const barColor = `hsl(${hue.toFixed(0)}, 75%, 50%)`;
          const peakColor = `hsl(${hue.toFixed(0)}, 80%, 75%)`;
          const noteLabel = noteBands.get(i);
          return (
            <View key={i} style={{ flex: 1, height, position: "relative", marginRight: 1 }}>
              <View style={{
                position: "absolute", bottom: 0, left: 0, right: 0,
                height: barH, backgroundColor: barColor, borderRadius: 1,
              }} />
              {peaks && (
                <View style={{
                  position: "absolute",
                  bottom: Math.min(usable - 2, Math.max(0, peakH - 2)),
                  left: 0, right: 0, height: 2,
                  backgroundColor: noteLabel ? "#fff" : peakColor,
                  borderRadius: 1,
                }} />
              )}
            </View>
          );
        })}
      </View>
      <View style={{ height: noteHeight, flexDirection: "row", paddingHorizontal: 2 }}>
        {samples.map((_, i) => {
          const noteLabel = noteBands.get(i);
          return (
            <View key={i} style={{ flex: 1, marginRight: 1, alignItems: "center" }}>
              {noteLabel && (
                <Text style={{ fontSize: 7, fontWeight: "700", color: "#fff" }} numberOfLines={1}>
                  {noteLabel}
                </Text>
              )}
            </View>
          );
        })}
      </View>
    </View>
  );
}

function RangeSlider({
  label, minValue, maxValue, onChange, min, max, log = false, format, theme,
}: {
  label: string; minValue: number; maxValue: number;
  onChange: (lo: number, hi: number) => void;
  min: number; max: number; log?: boolean;
  format: (v: number) => string; theme: Theme;
}) {
  const [width, setWidth] = useState(0);
  const activeRef = useRef<"min" | "max" | null>(null);

  const valueToRatio = (v: number) => log
    ? Math.log(v / min) / Math.log(max / min)
    : (v - min) / (max - min);
  const ratioToValue = (r: number) => {
    const c = Math.max(0, Math.min(1, r));
    return log ? min * Math.pow(max / min, c) : min + (max - min) * c;
  };

  const minR = Math.max(0, Math.min(1, valueToRatio(minValue)));
  const maxR = Math.max(0, Math.min(1, valueToRatio(maxValue)));

  const onStart = (e: { nativeEvent: { locationX: number } }) => {
    if (width <= 0) return;
    const x = e.nativeEvent.locationX;
    const minX = minR * width;
    const maxX = maxR * width;
    activeRef.current = Math.abs(x - minX) < Math.abs(x - maxX) - 0.5 ? "min" : "max";
    onMove(e);
  };
  const onMove = (e: { nativeEvent: { locationX: number } }) => {
    if (!activeRef.current || width <= 0) return;
    const r = Math.max(0, Math.min(1, e.nativeEvent.locationX / width));
    const v = ratioToValue(r);
    if (activeRef.current === "min") onChange(Math.min(v, maxValue), maxValue);
    else onChange(minValue, Math.max(v, minValue));
  };

  const trackHeight = 32;
  const thumbSize = 22;
  return (
    <View style={{ marginBottom: 10 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 4 }}>
        <Text style={{ fontSize: 12, color: theme.textMuted }}>{label}</Text>
        <Text style={{ fontSize: 13, fontWeight: "600", color: theme.text }}>
          {format(minValue)} → {format(maxValue)}
        </Text>
      </View>
      <View
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderGrant={onStart}
        onResponderMove={onMove}
        onResponderRelease={() => { activeRef.current = null; }}
        style={{ height: trackHeight, justifyContent: "center" }}
      >
        <View style={{ height: 4, borderRadius: 2, backgroundColor: "rgba(127,127,127,0.25)" }} />
        <View style={{
          position: "absolute",
          left: minR * width,
          top: trackHeight / 2 - 2,
          width: Math.max(0, (maxR - minR) * width),
          height: 4, borderRadius: 2,
          backgroundColor: theme.primary,
        }} />
        {width > 0 && (
          <>
            <View style={{
              position: "absolute",
              left: Math.max(0, Math.min(width - thumbSize, minR * width - thumbSize / 2)),
              top: trackHeight / 2 - thumbSize / 2,
              width: thumbSize, height: thumbSize, borderRadius: thumbSize / 2,
              backgroundColor: theme.primary, borderWidth: 2, borderColor: theme.surface,
            }} />
            <View style={{
              position: "absolute",
              left: Math.max(0, Math.min(width - thumbSize, maxR * width - thumbSize / 2)),
              top: trackHeight / 2 - thumbSize / 2,
              width: thumbSize, height: thumbSize, borderRadius: thumbSize / 2,
              backgroundColor: theme.primary, borderWidth: 2, borderColor: theme.surface,
            }} />
          </>
        )}
      </View>
    </View>
  );
}

function makeStyles(theme: Theme) {
  return StyleSheet.create({
    card: { backgroundColor: theme.surface, borderRadius: 12, overflow: "hidden" },
    pill: {
      flex: 1,
      paddingVertical: 8,
      borderRadius: 8,
      alignItems: "center",
    },
    pillActive: { backgroundColor: theme.primary },
    pillInactive: {
      backgroundColor: theme.surfaceAlt,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
    },
  });
}
