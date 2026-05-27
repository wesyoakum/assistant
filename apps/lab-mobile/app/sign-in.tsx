import { useEffect } from "react";
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ActivityIndicator,
} from "react-native";
import * as WebBrowser from "expo-web-browser";
import * as Linking from "expo-linking";
import { useAuth } from "../src/state/auth";
import { type Theme } from "../src/theme";
import { useStyles } from "../src/hooks/useStyles";

const AUTH_BASE = "https://api.whyapp.us/auth/google/start";

export default function SignIn() {
  const { setToken, isLoading } = useAuth();
  const styles = useStyles(makeStyles);

  const returnUrl = Linking.createURL("auth");

  useEffect(() => {
    const subscription = Linking.addEventListener("url", async ({ url }) => {
      const parsed = Linking.parse(url);
      const token = parsed.queryParams?.token;
      if (typeof token === "string") {
        await setToken(token);
      }
    });

    return () => subscription.remove();
  }, [setToken]);

  const handleSignIn = async () => {
    const authUrl = `${AUTH_BASE}?return_url=${encodeURIComponent(returnUrl)}`;
    const result = await WebBrowser.openAuthSessionAsync(authUrl, returnUrl);

    if (result.type === "success" && result.url) {
      const parsed = Linking.parse(result.url);
      const token = parsed.queryParams?.token;
      if (typeof token === "string") {
        await setToken(token);
      }
    }
  };

  if (isLoading) {
    return (
      <View style={styles.container}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>WHY Lab</Text>
      <Text style={styles.subtitle}>Sensor sandbox</Text>
      <Pressable style={styles.button} onPress={handleSignIn}>
        <Text style={styles.buttonText}>Sign in with Google</Text>
      </Pressable>
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
      fontSize: 40,
      fontWeight: "700",
      marginBottom: 8,
      color: theme.text,
    },
    subtitle: {
      fontSize: 18,
      color: theme.textMuted,
      marginBottom: 48,
    },
    button: {
      backgroundColor: theme.primary,
      paddingHorizontal: 32,
      paddingVertical: 16,
      borderRadius: 12,
    },
    buttonText: {
      color: "#fff",
      fontSize: 17,
      fontWeight: "600",
    },
  });
}
