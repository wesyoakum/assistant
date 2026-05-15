import { useRef, useMemo, useEffect } from "react";
import {
  View,
  Text,
  SectionList,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { Swipeable } from "react-native-gesture-handler";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { apiFetch } from "../../src/api/client";

interface TriageItem {
  id: string;
  source_type: string;
  priority: number;
  urgency: number;
  category: string | null;
  summary: string | null;
  suggested_action: string | null;
  status: string;
  source_ref: string | null;
  source_title: string | null;
  event_at: string | null;
  due_at: string | null;
  event_created_at: string | null;
  event_updated_at: string | null;
  created_at: string;
}

interface TriageResponse {
  items: TriageItem[];
  cursor?: string;
}

// --- Eisenhower matrix ---

type Level = "high" | "medium" | "low";
type Quadrant = "hot" | "action" | "plan" | "noop";

function toLevel(n: number): Level {
  if (n >= 4) return "high";
  if (n === 3) return "medium";
  return "low";
}

function getQuadrant(importance: Level, urgency: Level): Quadrant {
  if (importance === "high" && urgency !== "low") return "hot";
  if (importance === "high" && urgency === "low") return "plan";
  if (urgency === "high" && importance !== "high") return "action";
  if (importance === "medium" && urgency === "medium") return "plan";
  if (importance === "medium" && urgency === "low") return "noop";
  if (importance === "low" && urgency === "medium") return "action";
  return "noop";
}

const QUADRANTS: { key: Quadrant; label: string; color: string }[] = [
  { key: "hot",    label: "Hot",    color: "#e53e3e" },
  { key: "action", label: "Action", color: "#ed8936" },
  { key: "plan",   label: "Plan",   color: "#38a169" },
  { key: "noop",   label: "Noop",   color: "#a0aec0" },
];

// --- Helpers ---

const SOURCE_LABELS: Record<string, string> = {
  email: "Email",
  calendar: "Cal",
  event: "Event",
  document: "Doc",
  image: "Img",
  voice: "Voice",
  chat: "Chat",
};

/** Origin timestamp based on source type */
function getOriginDate(item: TriageItem): string {
  let date: string;
  switch (item.source_type) {
    case "email":
      // Email: use event_at (sent date) if available
      date = item.event_at || item.created_at;
      break;
    case "calendar":
    case "event":
      // Calendar: use event_created_at or event_updated_at
      date = item.event_updated_at || item.event_created_at || item.created_at;
      break;
    default:
      // Capture, chat: date added
      date = item.created_at;
  }
  return formatRelativeDate(date);
}

function formatRelativeDate(dateStr: string): string {
  const d = new Date(dateStr);
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  if (mins < 0) return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Urgency reference — deadline or event time */
function getUrgencyRef(item: TriageItem): string | null {
  const deadline = item.due_at || item.event_at;
  if (!deadline) return null;

  const d = new Date(deadline);
  const diff = d.getTime() - Date.now();

  if (diff < -24 * 60 * 60 * 1000) return "Overdue";
  if (diff < 0) return "Past";
  if (diff < 60 * 60 * 1000) return `${Math.ceil(diff / 60000)}m left`;
  if (diff < 24 * 60 * 60 * 1000) return `${Math.ceil(diff / 3600000)}h left`;
  if (diff < 7 * 24 * 60 * 60 * 1000) {
    return d.toLocaleDateString("en-US", { weekday: "short" });
  }
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}

function truncateSummary(summary: string | null): string {
  if (!summary) return "No description";
  const words = summary.split(/\s+/);
  if (words.length <= 10) return summary;
  return words.slice(0, 10).join(" ") + "\u2026";
}

// --- Component ---

export default function TriageScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const didSync = useRef(false);

  const { data, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ["triage"],
    queryFn: () => apiFetch<TriageResponse>("/triage?status=open"),
  });

  const dismissMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/triage/${id}/status`, {
        method: "POST",
        body: JSON.stringify({ status: "dismissed" }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["triage"] });
      queryClient.invalidateQueries({ queryKey: ["emails"] });
    },
  });

  // Auto-sync on mount
  useEffect(() => {
    if (didSync.current) return;
    didSync.current = true;
    apiFetch("/gmail/sync", { method: "POST" }).then(() => {
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ["triage"] }), 3000);
    });
  }, [queryClient]);

  const sections = useMemo(() => {
    const items = data?.items || [];
    const buckets: Record<Quadrant, TriageItem[]> = {
      hot: [], action: [], plan: [], noop: [],
    };

    for (const item of items) {
      const q = getQuadrant(toLevel(item.priority), toLevel(item.urgency));
      buckets[q].push(item);
    }

    return QUADRANTS
      .filter((q) => buckets[q.key].length > 0)
      .map((q) => ({
        key: q.key,
        label: q.label,
        color: q.color,
        data: buckets[q.key],
      }));
  }, [data]);

  if (isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  return (
    <SectionList
      sections={sections}
      keyExtractor={(item) => item.id}
      refreshControl={
        <RefreshControl refreshing={isRefetching} onRefresh={refetch} />
      }
      contentContainerStyle={
        sections.length === 0 ? styles.center : styles.list
      }
      ListEmptyComponent={
        <Text style={styles.emptyText}>Nothing to triage right now</Text>
      }
      renderSectionHeader={({ section }) => (
        <View style={styles.sectionHeader}>
          <View style={[styles.sectionDot, { backgroundColor: section.color }]} />
          <Text style={styles.sectionTitle}>
            {section.label}
          </Text>
          <Text style={styles.sectionCount}>{section.data.length}</Text>
        </View>
      )}
      renderItem={({ item, section }) => {
        const origin = getOriginDate(item);
        const urgencyRef = getUrgencyRef(item);
        const sourceLabel = SOURCE_LABELS[item.source_type] || item.source_type;

        return (
          <Swipeable
            renderRightActions={() => (
              <Pressable
                style={styles.swipeDismiss}
                onPress={() => dismissMutation.mutate(item.id)}
              >
                <Text style={styles.swipeDismissText}>Dismiss</Text>
              </Pressable>
            )}
            onSwipeableOpen={(direction) => {
              if (direction === "right") dismissMutation.mutate(item.id);
            }}
          >
            <Pressable
              style={styles.row}
              onPress={() => router.push(`/triage/${item.id}`)}
            >
              <View
                style={[styles.priorityBar, { backgroundColor: section.color }]}
              />

              <View style={styles.content}>
                <Text style={styles.summary} numberOfLines={1}>
                  {truncateSummary(item.summary)}
                </Text>

                <View style={styles.metaRow}>
                  <Text style={styles.sourceLabel}>{sourceLabel}</Text>
                  <Text style={styles.dot}>{"\u00B7"}</Text>
                  <Text style={styles.origin}>{origin}</Text>
                  {urgencyRef && (
                    <>
                      <Text style={styles.dot}>{"\u00B7"}</Text>
                      <Text
                        style={[
                          styles.urgencyRef,
                          (urgencyRef === "Overdue" || urgencyRef === "Past") && styles.urgencyOverdue,
                        ]}
                      >
                        {urgencyRef}
                      </Text>
                    </>
                  )}
                </View>
              </View>

              <Text style={[styles.priorityNum, { color: section.color }]}>
                P{item.priority}U{item.urgency}
              </Text>
            </Pressable>
          </Swipeable>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  list: { paddingBottom: 20 },
  emptyText: { fontSize: 16, color: "#999" },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: "#f7f7f7",
  },
  sectionDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: 8,
  },
  sectionTitle: { fontSize: 14, fontWeight: "700", color: "#555" },
  sectionCount: { fontSize: 13, color: "#999", marginLeft: 6 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    paddingRight: 16,
    backgroundColor: "#fff",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#eee",
  },
  priorityBar: {
    width: 4,
    alignSelf: "stretch",
    borderRadius: 2,
    marginRight: 12,
  },
  content: { flex: 1, marginRight: 10 },
  summary: { fontSize: 15, color: "#222", marginBottom: 3 },
  metaRow: { flexDirection: "row", alignItems: "center" },
  sourceLabel: { fontSize: 12, color: "#4285F4", fontWeight: "600" },
  dot: { fontSize: 12, color: "#ccc", marginHorizontal: 5 },
  origin: { fontSize: 12, color: "#999" },
  urgencyRef: { fontSize: 12, color: "#ed8936", fontWeight: "600" },
  urgencyOverdue: { color: "#e53e3e" },
  priorityNum: { fontSize: 13, fontWeight: "700" },
  swipeDismiss: {
    backgroundColor: "#e53e3e",
    justifyContent: "center",
    alignItems: "center",
    width: 90,
  },
  swipeDismissText: { color: "#fff", fontSize: 14, fontWeight: "600" },
});
