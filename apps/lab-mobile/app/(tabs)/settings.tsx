import { View, Text, Pressable, StyleSheet, ScrollView } from "react-native";
import { useAuth } from "../../src/state/auth";
import { type Theme } from "../../src/theme";
import { useStyles } from "../../src/hooks/useStyles";
import { useAppearance, type AppearanceMode } from "../../src/theme";

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

      <Text style={styles.sectionTitle}>Account</Text>
      <Pressable style={styles.signOutButton} onPress={clearToken}>
        <Text style={styles.signOutText}>Sign out</Text>
      </Pressable>
    </ScrollView>
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
