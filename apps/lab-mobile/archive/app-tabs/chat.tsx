import { View, Text, StyleSheet } from "react-native";
import { type Theme } from "../../src/theme";
import { useStyles } from "../../src/hooks/useStyles";

export default function ChatScreen() {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Chat</Text>
      <Text style={styles.subtitle}>Coming in Phase 2</Text>
    </View>
  );
}

function makeStyles(theme: Theme) {
  return StyleSheet.create({
    container: {
      flex: 1,
      justifyContent: "center",
      alignItems: "center",
      backgroundColor: theme.background,
      padding: 24,
    },
    title: {
      fontSize: 28,
      fontWeight: "700",
      color: theme.text,
      marginBottom: 8,
    },
    subtitle: {
      fontSize: 16,
      color: theme.textMuted,
    },
  });
}
