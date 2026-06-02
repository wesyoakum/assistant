import { View, Text, Pressable, StyleSheet, ScrollView } from "react-native";
import { useAuth } from "../../src/state/auth";
import { type Theme } from "../../src/theme";
import { useStyles } from "../../src/hooks/useStyles";
import { useAppearance, type AppearanceMode } from "../../src/theme";
import { useTrackerSettings } from "../../src/state/trackerSettings";

export default function SettingsScreen() {
  const styles = useStyles(makeStyles);
  const { clearToken } = useAuth();
  const { mode, setMode } = useAppearance();

  const appearances: { label: string; value: AppearanceMode }[] = [
    { label: "System", value: "system" },
    { label: "Light", value: "light" },
    { label: "Dark", value: "dark" },
  ];

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.sectionTitle}>Appearance</Text>
      <View style={styles.row}>
        {appearances.map((a) => (
          <Pressable
            key={a.value}
            style={[styles.chip, mode === a.value && styles.chipActive]}
            onPress={() => setMode(a.value)}
          >
            <Text style={[styles.chipText, mode === a.value && styles.chipTextActive]}>
              {a.label}
            </Text>
          </Pressable>
        ))}
      </View>

      <TrackerSettingsSection styles={styles} />

      <Text style={styles.sectionTitle}>Account</Text>
      <Pressable style={styles.signOutButton} onPress={clearToken}>
        <Text style={styles.signOutText}>Sign out</Text>
      </Pressable>
    </ScrollView>
  );
}

const CONTRAST_LEVELS = [1.0, 1.2, 1.4, 1.6, 1.8, 2.0, 2.5, 3.0];

function TrackerSettingsSection({ styles }: { styles: ReturnType<typeof makeStyles> }) {
  const { preprocessBW, contrastLevel, setPreprocessBW, setContrastLevel } = useTrackerSettings();
  return (
    <>
      <Text style={styles.sectionTitle}>Tracker Preprocessing</Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 12 }}>
        <Text style={styles.chipText}>Black & White</Text>
        <Pressable
          onPress={() => setPreprocessBW(!preprocessBW)}
          style={[styles.chip, preprocessBW && styles.chipActive]}
        >
          <Text style={[styles.chipText, preprocessBW && styles.chipTextActive]}>
            {preprocessBW ? "ON" : "OFF"}
          </Text>
        </Pressable>
      </View>
      <Text style={[styles.chipText, { marginBottom: 8 }]}>Contrast: {contrastLevel.toFixed(1)}×</Text>
      <View style={styles.row}>
        {CONTRAST_LEVELS.map((v) => (
          <Pressable
            key={v}
            onPress={() => setContrastLevel(v)}
            style={[styles.chip, contrastLevel === v && styles.chipActive, { paddingHorizontal: 10 }]}
          >
            <Text style={[styles.chipText, contrastLevel === v && styles.chipTextActive, { fontSize: 12 }]}>
              {v.toFixed(1)}
            </Text>
          </Pressable>
        ))}
      </View>
    </>
  );
}

function makeStyles(theme: Theme) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.background,
    },
    content: {
      padding: 24,
    },
    sectionTitle: {
      fontSize: 14,
      fontWeight: "600",
      color: theme.textMuted,
      textTransform: "uppercase",
      letterSpacing: 0.5,
      marginBottom: 12,
      marginTop: 24,
    },
    row: {
      flexDirection: "row",
      gap: 8,
    },
    chip: {
      paddingHorizontal: 16,
      paddingVertical: 8,
      borderRadius: 8,
      backgroundColor: theme.surface,
      borderWidth: 1,
      borderColor: theme.border,
    },
    chipActive: {
      backgroundColor: theme.primary,
      borderColor: theme.primary,
    },
    chipText: {
      fontSize: 14,
      color: theme.text,
    },
    chipTextActive: {
      color: "#fff",
    },
    signOutButton: {
      backgroundColor: theme.destructive,
      paddingHorizontal: 24,
      paddingVertical: 12,
      borderRadius: 8,
      alignSelf: "flex-start",
    },
    signOutText: {
      color: "#fff",
      fontSize: 15,
      fontWeight: "600",
    },
  });
}
