// App color palette + light/dark themes. Components import useTheme() and
// build styles inside makeStyles(theme) so they re-render when the
// system color scheme or user override changes.

import { useColorScheme } from "react-native";
import * as SecureStore from "expo-secure-store";
import { create } from "zustand";
import { useEffect } from "react";

export const palette = {
  tealDark: "#1F5961",
  teal: "#3D7F94",
  tealLight: "#A1CADB",
  yellow: "#E6B441",
  orange: "#CB7D34",
  coral: "#E25448",
  red: "#BA2D2D",
  cream: "#EDE3D1",
  ink: "#1F2024",
} as const;

export interface Theme {
  scheme: "light" | "dark";
  primary: string;
  primaryDark: string;
  primaryLight: string;
  accent: string;
  warning: string;
  destructive: string;
  highlight: string;
  background: string;       // screen background
  surface: string;          // card / row background
  surfaceAlt: string;       // input fields, lifted areas
  border: string;
  text: string;             // primary text
  textMuted: string;        // secondary text
  textSubtle: string;       // tertiary text / placeholders
  headerBg: string;
  headerText: string;
  tabBarBg: string;
  tabBarBorder: string;
}

export const lightTheme: Theme = {
  scheme: "light",
  primary: palette.tealDark,
  primaryDark: palette.tealDark,
  primaryLight: palette.tealLight,
  accent: palette.yellow,
  warning: palette.orange,
  destructive: palette.red,
  highlight: palette.coral,
  background: palette.cream,
  surface: "#ffffff",
  surfaceAlt: "#f5efe2",
  border: "#dccfb8",
  text: palette.ink,
  textMuted: "#5b5d61",
  textSubtle: "#8a8d92",
  headerBg: palette.tealDark,
  headerText: palette.cream,
  tabBarBg: palette.cream,
  tabBarBorder: "#d6c9b3",
};

export const darkTheme: Theme = {
  scheme: "dark",
  primary: palette.tealLight,
  primaryDark: palette.teal,
  primaryLight: "#cae3ec",
  accent: palette.yellow,
  warning: palette.orange,
  destructive: "#E0584D",
  highlight: palette.coral,
  background: "#15171a",
  surface: "#1F2024",
  surfaceAlt: "#2A2B30",
  border: "#33353b",
  text: palette.cream,
  textMuted: "#b8b3a6",
  textSubtle: "#7a766f",
  headerBg: "#0f1418",
  headerText: palette.cream,
  tabBarBg: "#0f1418",
  tabBarBorder: "#2A2B30",
};

// User override stored in expo-secure-store
export type AppearanceMode = "system" | "light" | "dark";
const KEY = "appearance_mode";

interface AppearanceState {
  mode: AppearanceMode;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  setMode: (mode: AppearanceMode) => Promise<void>;
}

export const useAppearance = create<AppearanceState>((set) => ({
  mode: "system",
  hydrated: false,
  hydrate: async () => {
    try {
      const m = (await SecureStore.getItemAsync(KEY)) as AppearanceMode | null;
      if (m === "light" || m === "dark" || m === "system") {
        set({ mode: m, hydrated: true });
      } else {
        set({ hydrated: true });
      }
    } catch {
      set({ hydrated: true });
    }
  },
  setMode: async (mode) => {
    set({ mode });
    try { await SecureStore.setItemAsync(KEY, mode); } catch {}
  },
}));

/** Hydrate the persisted mode once at app start. */
export function useHydrateAppearance() {
  const hydrate = useAppearance((s) => s.hydrate);
  const hydrated = useAppearance((s) => s.hydrated);
  useEffect(() => {
    if (!hydrated) hydrate();
  }, [hydrated, hydrate]);
}

export function useTheme(): Theme {
  const systemScheme = useColorScheme();
  const mode = useAppearance((s) => s.mode);
  const effective: "light" | "dark" =
    mode === "system" ? (systemScheme === "dark" ? "dark" : "light") : mode;
  return effective === "dark" ? darkTheme : lightTheme;
}
