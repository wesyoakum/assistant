// App color palette. Sampled from the user's reference image.
// Use the semantic aliases (primary/destructive/warning/...) in new code;
// the raw palette is exported for one-off needs.

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

// Semantic tokens. Prefer these in components.
export const theme = {
  primary: palette.teal,
  primaryDark: palette.tealDark,
  primaryLight: palette.tealLight,
  accent: palette.yellow,
  warning: palette.orange,
  destructive: palette.red,
  highlight: palette.coral,
  surface: "#ffffff",
  surfaceAlt: palette.cream,
  text: palette.ink,
  textMuted: "#666",
  textSubtle: "#999",
  border: "#eee",
} as const;
