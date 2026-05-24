import { useEffect } from "react";
import { ActivityIndicator, View, Text } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { Stack, Redirect, useSegments } from "expo-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Updates from "expo-updates";
import { useAuth } from "../src/state/auth";
import { useNotifications } from "../src/hooks/useNotifications";
import { useOnOpenSync } from "../src/hooks/useOnOpenSync";

const queryClient = new QueryClient();

function useOTAUpdates() {
  useEffect(() => {
    if (__DEV__) return; // skip in development
    (async () => {
      try {
        const update = await Updates.checkForUpdateAsync();
        if (update.isAvailable) {
          await Updates.fetchUpdateAsync();
          await Updates.reloadAsync();
        }
      } catch {
        // silently fail — don't block the app
      }
    })();
  }, []);
}

function AuthGate() {
  const { isAuthenticated, isLoading, loadToken } = useAuth();
  const segments = useSegments();

  useOTAUpdates();

  useEffect(() => {
    loadToken();
  }, []);

  useNotifications();
  useOnOpenSync();

  if (isLoading) {
    return (
      <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  const onSignIn = segments[0] === "sign-in";

  if (!isAuthenticated && !onSignIn) {
    return <Redirect href="/sign-in" />;
  }

  if (isAuthenticated && onSignIn) {
    return <Redirect href="/(tabs)/chat" />;
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen
        name="notifications"
        options={{ headerShown: true, title: "Notification History" }}
      />
      <Stack.Screen
        name="experiments"
        options={{ headerShown: true, title: "Experiments" }}
      />
      <Stack.Screen name="sign-in" />
      <Stack.Screen name="index" />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <QueryClientProvider client={queryClient}>
        <AuthGate />
      </QueryClientProvider>
      <Text style={{ position: "absolute", bottom: 4, alignSelf: "center", fontSize: 13, color: "#999", fontWeight: "600" }}>v21</Text>
    </GestureHandlerRootView>
  );
}
