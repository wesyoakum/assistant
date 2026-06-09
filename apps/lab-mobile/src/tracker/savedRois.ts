// Persist named ROIs to the app's documents directory.
// Same pattern as savedCalibrations.ts / savedVideos.ts.

import type { NormalizedBox } from "expo-vision-tracker";

export interface SavedRoi {
  id: string;
  name: string;
  savedAt: string;
  box: NormalizedBox;
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
    const dir = new Directory(Paths.document, "saved-rois");
    if (!dir.exists) dir.create({ intermediates: true });
    return dir;
  } catch { return null; }
}

function getIndexFile() {
  const dir = getDir();
  if (!dir) return null;
  try { return new File(dir, "index.json"); } catch { return null; }
}

async function readIndex(): Promise<SavedRoi[]> {
  try {
    const f = getIndexFile();
    if (!f || !f.exists) return [];
    const raw = await f.text();
    return JSON.parse(raw) as SavedRoi[];
  } catch { return []; }
}

function writeIndex(entries: SavedRoi[]) {
  try {
    const f = getIndexFile();
    if (!f) return;
    f.write(JSON.stringify(entries, null, 2));
  } catch {}
}

export async function listRois(): Promise<SavedRoi[]> {
  return readIndex();
}

export async function saveRoi(
  roi: Omit<SavedRoi, "id" | "savedAt">,
): Promise<SavedRoi> {
  if (!fsAvailable) throw new Error("File system not available");
  const id = Date.now().toString(36);
  const entry: SavedRoi = { ...roi, id, savedAt: new Date().toISOString() };
  const index = await readIndex();
  index.unshift(entry);
  writeIndex(index);
  return entry;
}

export async function deleteRoi(id: string): Promise<void> {
  const index = await readIndex();
  writeIndex(index.filter((r) => r.id !== id));
}

export async function renameRoi(id: string, name: string): Promise<void> {
  const index = await readIndex();
  const entry = index.find((r) => r.id === id);
  if (entry) {
    entry.name = name;
    writeIndex(index);
  }
}
