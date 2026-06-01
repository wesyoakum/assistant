// Persist picked videos to the app's documents directory.
// Fully defensive — if expo-file-system isn't available, everything no-ops.

export interface SavedVideo {
  id: string;
  name: string;
  uri: string;
  savedAt: string;
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
    const dir = new Directory(Paths.document, "saved-videos");
    if (!dir.exists) dir.create({ intermediates: true });
    return dir;
  } catch { return null; }
}

function getIndexFile() {
  const dir = getDir();
  if (!dir) return null;
  try { return new File(dir, "index.json"); } catch { return null; }
}

async function readIndex(): Promise<SavedVideo[]> {
  try {
    const f = getIndexFile();
    if (!f || !f.exists) return [];
    const raw = await f.text();
    return JSON.parse(raw) as SavedVideo[];
  } catch { return []; }
}

function writeIndex(entries: SavedVideo[]) {
  try {
    const f = getIndexFile();
    if (!f) return;
    f.write(JSON.stringify(entries, null, 2));
  } catch {}
}

export async function listSavedVideos(): Promise<SavedVideo[]> {
  return readIndex();
}

export async function saveVideo(sourceUri: string, name?: string): Promise<SavedVideo> {
  const dir = getDir();
  if (!dir) throw new Error("File system not available");
  const id = Date.now().toString(36);
  const ext = sourceUri.split(".").pop() || "mov";
  const filename = `${id}.${ext}`;
  const src = new File(sourceUri);
  const dest = new File(dir, filename);
  src.copy(dest);
  const entry: SavedVideo = { id, name: name || filename, uri: dest.uri, savedAt: new Date().toISOString() };
  const index = await readIndex();
  index.unshift(entry);
  writeIndex(index);
  return entry;
}

export async function deleteSavedVideo(id: string): Promise<void> {
  const index = await readIndex();
  const entry = index.find((v) => v.id === id);
  if (entry) {
    try { const f = new File(entry.uri); if (f.exists) f.delete(); } catch {}
    writeIndex(index.filter((v) => v.id !== id));
  }
}
