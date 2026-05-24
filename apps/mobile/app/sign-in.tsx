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

const AUTH_BASE = "https://api.whyapp.us/auth/google/start";

export default function SignIn() {
  const { setToken, isLoading } = useAuth();

  // Build the return URL that works in both Expo Go (exp://) and standalone (whyapp://)
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
      <Text style={styles.title}>whyapp</Text>
      <Text style={styles.subtitle}>Your personal assistant</Text>
      <Pressable style={styles.button} onPress={handleSignIn}>
        <Text style={styles.buttonText}>Sign in with Google</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#fff",
    padding: 24,
  },
  title: {
    fontSize: 40,
    fontWeight: "700",
    marginBottom: 8,
    color: "#111",
  },
  subtitle: {
    fontSize: 18,
    color: "#666",
    marginBottom: 48,
  },
  button: {
    backgroundColor: "#3D7F94",
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
