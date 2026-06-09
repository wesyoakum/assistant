// Persist calibrations to the app's documents directory.
// Follows the same pattern as savedVideos.ts — fully defensive.

export interface SavedCalibration {
  id: string;
  name: string;
  savedAt: string;
  positions: Record<string, { nx: number; ny: number }>;
  anchored: Record<string, boolean>;
  cameraPose: {
    H: number[];
    Hinv: number[];
    rmsPx: number;
    count: number;
  } | null;
  cameraXYZ: { x: number; y: number; z: number } | null;
  cameraAngles: { panDeg: number; tiltDeg: number; rollDeg: number } | null;
  basepathFt: number;
  fovDeg: number;
}

let fsAvailable = false;
let Paths: any, File: any, Directory: any;
try {
  const fs = require("expo-file-system");
  Paths = fs.Paths;
  File = fs.File;
  Directory = fs.Directory;
  fsAvailable = !!Paths?.document;
} catch {
  fsAvailable = false;
}

function getDir() {
  if (!fsAvailable) return null;
  try {
    const dir = new Directory(Paths.document, "saved-calibrations");
    if (!dir.exists) dir.create({ intermediates: true });
    return dir;
  } catch { return null; }
}

function getIndexFile() {
  const dir = getDir();
  if (!dir) return null;
  try { return new File(dir, "index.json"); } catch { return null; }
}

async function readIndex(): Promise<SavedCalibration[]> {
  try {
    const f = getIndexFile();
    if (!f || !f.exists) return [];
    const raw = await f.text();
    return JSON.parse(raw) as SavedCalibration[];
  } catch { return []; }
}

function writeIndex(entries: SavedCalibration[]) {
  try {
    const f = getIndexFile();
    if (!f) return;
    f.write(JSON.stringify(entries, null, 2));
  } catch {}
}

export async function listCalibrations(): Promise<SavedCalibration[]> {
  return readIndex();
}

export async function saveCalibration(
  cal: Omit<SavedCalibration, "id" | "savedAt">,
): Promise<SavedCalibration> {
  if (!fsAvailable) throw new Error("File system not available");
  const id = Date.now().toString(36);
  const entry: SavedCalibration = { ...cal, id, savedAt: new Date().toISOString() };
  const index = await readIndex();
  index.unshift(entry);
  writeIndex(index);
  return entry;
}

export async function loadCalibration(id: string): Promise<SavedCalibration | null> {
  const index = await readIndex();
  return index.find((c) => c.id === id) ?? null;
}

export async function deleteCalibration(id: string): Promise<void> {
  const index = await readIndex();
  writeIndex(index.filter((c) => c.id !== id));
}

export async function renameCalibration(id: string, name: string): Promise<void> {
  const index = await readIndex();
  const entry = index.find((c) => c.id === id);
  if (entry) {
    entry.name = name;
    writeIndex(index);
  }
}
