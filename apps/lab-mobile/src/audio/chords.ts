// Note detection from spectrum peaks + guitar chord recognition.

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;

/** Convert a frequency to the nearest MIDI note number. A4 = 69 = 440Hz. */
export function freqToMidi(freq: number): number {
  return 69 + 12 * Math.log2(freq / 440);
}

/** Convert a MIDI note number to a frequency. */
export function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Get note name + octave from MIDI note number. */
export function midiToNoteName(midi: number): string {
  const note = NOTE_NAMES[((Math.round(midi) % 12) + 12) % 12];
  const octave = Math.floor(Math.round(midi) / 12) - 1;
  return `${note}${octave}`;
}

/** Get just the pitch class (0-11) from a MIDI note. */
function pitchClass(midi: number): number {
  return ((Math.round(midi) % 12) + 12) % 12;
}

export interface DetectedNote {
  freq: number;
  midi: number;
  name: string;
  amplitude: number;  // 0-1 normalized
}

/**
 * Detect prominent notes from spectrum data.
 * @param bands - normalized 0-1 amplitude for each band
 * @param bandEdges - frequency edge for each band boundary (N_BANDS + 1 values)
 * @param threshold - minimum amplitude to count as a note (0-1)
 * @param sampleRate - audio sample rate
 * @param fftSize - FFT window size
 */
export function detectNotes(
  bands: number[],
  bandEdges: Int32Array,
  threshold: number,
  sampleRate: number,
  fftSize: number,
): DetectedNote[] {
  const notes: DetectedNote[] = [];
  const n = bands.length;

  for (let i = 1; i < n - 1; i++) {
    const v = bands[i]!;
    if (v < threshold) continue;
    // Local peak: higher than both neighbors
    if (v <= (bands[i - 1] ?? 0) || v <= (bands[i + 1] ?? 0)) continue;

    // Center frequency of this band
    const loFreq = (bandEdges[i]! * sampleRate) / fftSize;
    const hiFreq = (bandEdges[i + 1]! * sampleRate) / fftSize;
    const freq = (loFreq + hiFreq) / 2;
    if (freq < 20) continue;

    const midi = freqToMidi(freq);
    const name = midiToNoteName(midi);

    // Skip if we already have a note within 1 semitone (keep the louder one)
    const existing = notes.find((n) => Math.abs(n.midi - midi) < 1);
    if (existing) {
      if (v > existing.amplitude) {
        existing.freq = freq;
        existing.midi = midi;
        existing.name = name;
        existing.amplitude = v;
      }
      continue;
    }

    notes.push({ freq, midi, name, amplitude: v });
  }

  // Sort by amplitude descending, keep top 6 (guitar has 6 strings)
  notes.sort((a, b) => b.amplitude - a.amplitude);
  return notes.slice(0, 6);
}

// ─── Guitar chord recognition ─────────────────────────────────────────────────

interface ChordPattern {
  name: string;
  intervals: number[];  // semitone intervals from root (pitch classes)
}

// Common guitar chord voicings as pitch class sets (intervals from root)
const CHORD_PATTERNS: ChordPattern[] = [
  // Triads
  { name: "maj",  intervals: [0, 4, 7] },
  { name: "min",  intervals: [0, 3, 7] },
  { name: "dim",  intervals: [0, 3, 6] },
  { name: "aug",  intervals: [0, 4, 8] },
  // Seventh chords
  { name: "7",    intervals: [0, 4, 7, 10] },
  { name: "maj7", intervals: [0, 4, 7, 11] },
  { name: "m7",   intervals: [0, 3, 7, 10] },
  { name: "m7b5", intervals: [0, 3, 6, 10] },
  { name: "dim7", intervals: [0, 3, 6, 9] },
  // Sus chords
  { name: "sus2", intervals: [0, 2, 7] },
  { name: "sus4", intervals: [0, 5, 7] },
  // Add chords
  { name: "add9", intervals: [0, 2, 4, 7] },
  // Power chord
  { name: "5",    intervals: [0, 7] },
];

/**
 * Identify the most likely guitar chord from detected notes.
 * Returns null if fewer than 2 notes or no match found.
 */
export function identifyChord(notes: DetectedNote[]): string | null {
  if (notes.length < 2) return null;

  // Get unique pitch classes from detected notes
  const classes = [...new Set(notes.map((n) => pitchClass(n.midi)))];
  if (classes.length < 2) return null;

  let bestMatch: { root: string; name: string; score: number } | null = null;

  // Try each detected note as a potential root
  for (const rootClass of classes) {
    // Normalize all pitch classes relative to this root
    const normalized = classes.map((c) => ((c - rootClass + 12) % 12)).sort((a, b) => a - b);

    // Check against each chord pattern
    for (const pattern of CHORD_PATTERNS) {
      // How many of the pattern's intervals are present?
      const matched = pattern.intervals.filter((iv) => normalized.includes(iv)).length;
      // How many extra notes are there that aren't in the pattern?
      const extra = normalized.filter((iv) => !pattern.intervals.includes(iv)).length;

      // Score: fraction of pattern matched, penalized for extra notes
      const score = matched / pattern.intervals.length - extra * 0.15;

      // Must match at least 2 intervals and score > 0.5
      if (matched >= 2 && score > 0.5 && (!bestMatch || score > bestMatch.score)) {
        const rootName = NOTE_NAMES[rootClass];
        bestMatch = { root: rootName!, name: pattern.name, score };
      }
    }
  }

  if (!bestMatch) return null;

  // Format: "C maj" → "C", "A min" → "Am", "G 7" → "G7"
  const { root, name } = bestMatch;
  if (name === "maj") return root;
  if (name === "min") return `${root}m`;
  return `${root}${name}`;
}
