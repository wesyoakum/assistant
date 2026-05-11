import { useEffect } from "react";
import { Slot, useRouter, useSegments } from "expo-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useAuth } from "../src/state/auth";

const queryClient = new QueryClient();

function AuthGate() {
  const { isAuthenticated, isLoading, loadToken } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    loadToken();
  }, [loadToken]);

  useEffect(() => {
    if (isLoading) return;

    const onSignIn = segments[0] === "sign-in";

    if (!isAuthenticated && !onSignIn) {
      router.replace("/sign-in");
    } else if (isAuthenticated && onSignIn) {
      router.replace("/(tabs)/triage");
    }
  }, [isAuthenticated, isLoading, segments, router]);

  return <Slot />;
}

export default function RootLayout() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthGate />
    </QueryClientProvider>
  );
}
