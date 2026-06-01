// Persist picked videos to the app's documents directory so they survive
// across sessions. Each saved video gets a human-readable name and a
// stable file:// URI that the native modules can read.

import * as FileSystem from "expo-file-system";

const VIDEOS_DIR = `${FileSystem.documentDirectory}saved-videos/`;
const INDEX_PATH = `${VIDEOS_DIR}index.json`;

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

async function ensureDir() {
  const info = await FileSystem.getInfoAsync(VIDEOS_DIR);
  if (!info.exists) await FileSystem.makeDirectoryAsync(VIDEOS_DIR, { intermediates: true });
}

async function readIndex(): Promise<SavedVideo[]> {
  try {
    const raw = await FileSystem.readAsStringAsync(INDEX_PATH);
    return JSON.parse(raw) as SavedVideo[];
  } catch {
    return [];
  }
}

async function writeIndex(entries: SavedVideo[]) {
  await FileSystem.writeAsStringAsync(INDEX_PATH, JSON.stringify(entries, null, 2));
}

/** List all saved videos (newest first). */
export async function listSavedVideos(): Promise<SavedVideo[]> {
  await ensureDir();
  return readIndex();
}

/** Save a video from a temporary picker URI to the documents directory. */
export async function saveVideo(sourceUri: string, name?: string): Promise<SavedVideo> {
  await ensureDir();
  const id = Date.now().toString(36);
  const ext = sourceUri.split(".").pop() || "mov";
  const filename = `${id}.${ext}`;
  const destUri = `${VIDEOS_DIR}${filename}`;

  await FileSystem.copyAsync({ from: sourceUri, to: destUri });

  const entry: SavedVideo = {
    id,
    name: name || filename,
    uri: destUri,
    savedAt: new Date().toISOString(),
  };

  const index = await readIndex();
  index.unshift(entry);
  await writeIndex(index);
  return entry;
}

/** Delete a saved video. */
export async function deleteSavedVideo(id: string): Promise<void> {
  const index = await readIndex();
  const entry = index.find((v) => v.id === id);
  if (entry) {
    await FileSystem.deleteAsync(entry.uri, { idempotent: true });
    await writeIndex(index.filter((v) => v.id !== id));
  }
}
