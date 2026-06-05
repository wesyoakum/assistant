import { useEffect } from "react";
import { ActivityIndicator, View, Text } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { Stack, Redirect, useSegments } from "expo-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Updates from "expo-updates";
import { useAuth } from "../src/state/auth";
import { useTheme, useHydrateAppearance } from "../src/theme";
import { currentRelease } from "../src/releases";
import Constants from "expo-constants";
import * as ScreenOrientation from "expo-screen-orientation";

const queryClient = new QueryClient();

function useOTAUpdates() {
  useEffect(() => {
    if (__DEV__) return;
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
  const theme = useTheme();
  useHydrateAppearance();

  // Allow all orientations — landscape is useful for the tracker.
  useEffect(() => {
    ScreenOrientation.unlockAsync().catch(() => {});
  }, []);

  useOTAUpdates();

  useEffect(() => {
    loadToken();
  }, []);

  if (isLoading) {
    return (
      <View style={{ flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: theme.background }}>
        <ActivityIndicator size="large" color={theme.primary} />
      </View>
    );
  }

  const onSignIn = segments[0] === "sign-in";

  if (!isAuthenticated && !onSignIn) {
    return <Redirect href="/sign-in" />;
  }

  if (isAuthenticated && onSignIn) {
    return <Redirect href="/tracker" />;
  }

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        headerStyle: { backgroundColor: theme.headerBg },
        headerTintColor: theme.headerText,
        headerTitleStyle: { fontWeight: "600" },
        contentStyle: { backgroundColor: theme.background },
      }}
    >
      <Stack.Screen name="tracker" />
      <Stack.Screen name="sign-in" />
      <Stack.Screen name="index" />
    </Stack>
  );
}

function VersionBadge() {
  const theme = useTheme();
  const r = currentRelease();
  const build = Constants.nativeBuildVersion;
  const parts: string[] = [];
  if (r) parts.push(r.version);
  if (r?.pr) parts.push(`PR #${r.pr}`);
  if (build) parts.push(`build ${build}`);
  return (
    <Text
      style={{
        position: "absolute",
        bottom: 4,
        alignSelf: "center",
        fontSize: 11,
        color: theme.textSubtle,
        fontWeight: "600",
      }}
    >
      {parts.join(" · ")}
    </Text>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <QueryClientProvider client={queryClient}>
        <AuthGate />
        <VersionBadge />
      </QueryClientProvider>
    </GestureHandlerRootView>
  );
}
