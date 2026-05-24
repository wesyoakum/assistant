import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../api/client";
import { useAuth } from "../state/auth";
import { useLastSeen, useHydrateLastSeen } from "../state/lastSeen";
import { RELEASES, parseVersion } from "../releases";

/**
 * Once per app launch (after auth + hydrate), check for unread releases and
 * post them as a single assistant chat message. Marks them as seen locally
 * so the next launch is silent.
 */
export function useWhatsNewAnnounce() {
  const { isAuthenticated } = useAuth();
  const queryClient = useQueryClient();
  useHydrateLastSeen();
  const lastSeen = useLastSeen((s) => s.version);
  const hydrated = useLastSeen((s) => s.hydrated);
  const markSeen = useLastSeen((s) => s.markSeen);

  useEffect(() => {
    if (!isAuthenticated || !hydrated) return;
    const unread = RELEASES.filter((r) => parseVersion(r.version) > lastSeen);
    if (unread.length === 0) return;

    // First-launch flood guard: don't post >5 historical entries.
    const toPost = unread.slice(0, 5);
    const latest = Math.max(...toPost.map((r) => parseVersion(r.version)));

    (async () => {
      try {
        // Oldest first so the chat reads top→bottom in release order.
        for (const r of toPost.slice().reverse()) {
          const text = [
            `**${r.version} — ${r.title}**`,
            ...r.notes.map((n) => `- ${n}`),
          ].join("\n");
          await apiFetch("/chat/announce", {
            method: "POST",
            body: JSON.stringify({ text }),
          });
        }
        await markSeen(latest);
        queryClient.invalidateQueries({ queryKey: ["chat-history"] });
      } catch {
        // don't markSeen if any post failed — try again next launch
      }
    })();
    // intentionally run only when lastSeen changes / hydration completes;
    // not when queryClient identity changes (it doesn't).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, hydrated, lastSeen]);
}
