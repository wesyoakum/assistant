import { useEffect, useRef } from "react";
import { AppState, AppStateStatus } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../api/client";
import { useAuth } from "../state/auth";

const MIN_INTERVAL_MS = 30_000; // throttle: don't re-sync more than every 30s

async function runSyncs() {
  // Fire in parallel; one failing shouldn't block the other
  await Promise.allSettled([
    apiFetch("/gmail/sync", { method: "POST" }),
    apiFetch("/calendar/sync", { method: "POST" }),
  ]);
}

export function useOnOpenSync() {
  const queryClient = useQueryClient();
  const { isAuthenticated } = useAuth();
  const lastSyncAt = useRef<number>(0);

  useEffect(() => {
    if (!isAuthenticated) return;

    const sync = async () => {
      const now = Date.now();
      if (now - lastSyncAt.current < MIN_INTERVAL_MS) return;
      lastSyncAt.current = now;
      await runSyncs();
      queryClient.invalidateQueries({ queryKey: ["emails"] });
      queryClient.invalidateQueries({ queryKey: ["calendar-events"] });
      queryClient.invalidateQueries({ queryKey: ["ical-feeds"] });
    };

    // Initial sync on mount (app launch)
    sync();

    // Re-sync on foreground
    const onChange = (state: AppStateStatus) => {
      if (state === "active") sync();
    };
    const sub = AppState.addEventListener("change", onChange);
    return () => sub.remove();
  }, [isAuthenticated, queryClient]);
}
