import { View, Text, Pressable } from "react-native";
import { useTheme } from "../theme";
import { RELEASES, parseVersion } from "../releases";
import { useLastSeen, useHydrateLastSeen } from "../state/lastSeen";

export function WhatsNewBanner() {
  const theme = useTheme();
  useHydrateLastSeen();
  const lastSeen = useLastSeen((s) => s.version);
  const hydrated = useLastSeen((s) => s.hydrated);
  const markSeen = useLastSeen((s) => s.markSeen);

  if (!hydrated) return null;

  const unread = RELEASES.filter((r) => parseVersion(r.version) > lastSeen);
  if (unread.length === 0) return null;

  const latest = Math.max(...unread.map((r) => parseVersion(r.version)));

  return (
    <View
      style={{
        backgroundColor: theme.primary,
        borderRadius: 14,
        padding: 14,
        margin: 12,
        marginBottom: 4,
      }}
    >
      <Text style={{ color: "#fff", fontWeight: "700", fontSize: 14, marginBottom: 8, opacity: 0.85 }}>
        WHAT'S NEW
      </Text>
      {unread.slice(0, 6).map((r) => (
        <View key={r.version} style={{ marginBottom: 10 }}>
          <Text style={{ color: "#fff", fontWeight: "600", fontSize: 14, marginBottom: 2 }}>
            {r.version} · {r.title}
          </Text>
          {r.notes.map((n, i) => (
            <Text
              key={i}
              style={{ color: "rgba(255,255,255,0.88)", fontSize: 13, marginLeft: 8, marginTop: 2, lineHeight: 18 }}
            >
              · {n}
            </Text>
          ))}
        </View>
      ))}
      {unread.length > 6 && (
        <Text style={{ color: "rgba(255,255,255,0.7)", fontSize: 12, marginBottom: 8 }}>
          …and {unread.length - 6} more
        </Text>
      )}
      <Pressable
        onPress={() => markSeen(latest)}
        style={{
          marginTop: 4,
          paddingVertical: 10,
          borderRadius: 9,
          alignItems: "center",
          backgroundColor: "rgba(255,255,255,0.18)",
        }}
      >
        <Text style={{ color: "#fff", fontWeight: "700", fontSize: 14 }}>Got it</Text>
      </Pressable>
    </View>
  );
}
