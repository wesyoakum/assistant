// Persist picked videos to the app's documents directory so they survive
// across sessions. Each saved video gets a human-readable name and a
// stable file:// URI that the native modules can read.

import { Paths, File, Directory } from "expo-file-system";

const VIDEOS_DIR = new Directory(Paths.document, "saved-videos");
const INDEX_FILE = new File(VIDEOS_DIR, "index.json");

export interface SavedVideo {
  /** Unique ID (timestamp-based). */
  id: string;
  /** User-visible name (defaults to filename, editable later). */
  name: string;
  /** Stable file:// URI in the documents directory. */
  uri: string;
  /** When it was saved. */
  savedAt: string;
}

function ensureDir() {
  if (!VIDEOS_DIR.exists) VIDEOS_DIR.create({ intermediates: true });
}

async function readIndex(): Promise<SavedVideo[]> {
  try {
    if (!INDEX_FILE.exists) return [];
    const raw = await INDEX_FILE.text();
    return JSON.parse(raw) as SavedVideo[];
  } catch {
    return [];
  }
}

function writeIndex(entries: SavedVideo[]) {
  INDEX_FILE.write(JSON.stringify(entries, null, 2));
}

/** List all saved videos (newest first). */
export async function listSavedVideos(): Promise<SavedVideo[]> {
  ensureDir();
  return readIndex();
}

/** Save a video from a temporary picker URI to the documents directory. */
export async function saveVideo(sourceUri: string, name?: string): Promise<SavedVideo> {
  ensureDir();
  const id = Date.now().toString(36);
  const ext = sourceUri.split(".").pop() || "mov";
  const filename = `${id}.${ext}`;

  const src = new File(sourceUri);
  const dest = new File(VIDEOS_DIR, filename);
  src.copy(dest);

  const entry: SavedVideo = {
    id,
    name: name || filename,
    uri: dest.uri,
    savedAt: new Date().toISOString(),
  };

  const index = await readIndex();
  index.unshift(entry);
  writeIndex(index);
  return entry;
}

/** Delete a saved video. */
export async function deleteSavedVideo(id: string): Promise<void> {
  const index = await readIndex();
  const entry = index.find((v) => v.id === id);
  if (entry) {
    const f = new File(entry.uri);
    if (f.exists) f.delete();
    writeIndex(index.filter((v) => v.id !== id));
  }
}
