import { create } from "zustand";
import * as SecureStore from "expo-secure-store";
import { useEffect } from "react";

const KEY = "last_seen_release";

interface LastSeenState {
  version: number;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  markSeen: (version: number) => Promise<void>;
  reset: () => Promise<void>;
}

export const useLastSeen = create<LastSeenState>((set, get) => ({
  version: 0,
  hydrated: false,
  hydrate: async () => {
    try {
      const raw = await SecureStore.getItemAsync(KEY);
      const v = raw ? parseInt(raw, 10) : 0;
      set({ version: Number.isFinite(v) ? v : 0, hydrated: true });
    } catch {
      set({ hydrated: true });
    }
  },
  markSeen: async (version: number) => {
    if (version <= get().version) return;
    set({ version });
    try {
      await SecureStore.setItemAsync(KEY, String(version));
    } catch {
      // ignore
    }
  },
  reset: async () => {
    set({ version: 0 });
    try {
      await SecureStore.deleteItemAsync(KEY);
    } catch {
      // ignore
    }
  },
}));

export function useHydrateLastSeen() {
  const hydrated = useLastSeen((s) => s.hydrated);
  const hydrate = useLastSeen((s) => s.hydrate);
  useEffect(() => {
    if (!hydrated) hydrate();
  }, [hydrated, hydrate]);
}
