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

    const latest = Math.max(...unread.map((r) => parseVersion(r.version)));
    const lines: string[] = ["**What's new**", ""];
    for (const r of unread.slice(0, 8)) {
      lines.push(`**${r.version} — ${r.title}**`);
      for (const n of r.notes) lines.push(`- ${n}`);
      lines.push("");
    }
    const text = lines.join("\n").trim();

    (async () => {
      try {
        await apiFetch("/chat/announce", {
          method: "POST",
          body: JSON.stringify({ text }),
        });
        await markSeen(latest);
        queryClient.invalidateQueries({ queryKey: ["chat-history"] });
      } catch {
        // don't markSeen if the post failed — try again next launch
      }
    })();
    // intentionally run only when lastSeen changes / hydration completes;
    // not when queryClient identity changes (it doesn't).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, hydrated, lastSeen]);
}
