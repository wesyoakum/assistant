import { useEffect } from "react";
import { ActivityIndicator, View } from "react-native";
import { Slot, Redirect, useSegments } from "expo-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useAuth } from "../src/state/auth";

const queryClient = new QueryClient();

function AuthGate() {
  const { isAuthenticated, isLoading, loadToken } = useAuth();
  const segments = useSegments();

  useEffect(() => {
    loadToken();
  }, []);

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

  return <Slot />;
}

export default function RootLayout() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthGate />
    </QueryClientProvider>
  );
}
