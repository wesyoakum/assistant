import { useRef, useMemo } from "react";
import {
  View,
  Text,
  SectionList,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { apiFetch } from "../../src/api/client";

interface TriageItem {
  id: string;
  source_type: string;
  priority: number; // importance 1-5
  urgency: number;  // urgency 1-5
  category: string | null;
  summary: string | null;
  suggested_action: string | null;
  status: string;
  source_ref: string | null;
  deadline: string | null;
  origin_date: string | null;
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
  // High importance
  if (importance === "high" && urgency !== "low") return "hot";
  if (importance === "high" && urgency === "low") return "plan";
  // High urgency
  if (urgency === "high" && importance !== "high") return "action";
  // Medium importance + medium urgency leans toward plan
  if (importance === "medium" && urgency === "medium") return "plan";
  if (importance === "medium" && urgency === "low") return "noop";
  if (importance === "low" && urgency === "medium") return "action";
  // Low + low
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
  document: "Doc",
  image: "Img",
  voice: "Voice",
  chat: "Chat",
};

function formatDeadline(deadline: string | null): string | null {
  if (!deadline) return null;
  const d = new Date(deadline);
  const diff = d.getTime() - Date.now();
  if (diff < 0) return "Overdue";
  if (diff < 60 * 60 * 1000) return `${Math.ceil(diff / 60000)}m left`;
  if (diff < 24 * 60 * 60 * 1000) return `${Math.ceil(diff / 3600000)}h left`;
  return `by ${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}

function formatOrigin(originDate: string | null, createdAt: string): string {
  const d = new Date(originDate || createdAt);
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
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

  if (!didSync.current) {
    didSync.current = true;
    apiFetch("/gmail/sync", { method: "POST" }).then(() => {
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ["triage"] }), 3000);
    });
  }

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
        const deadline = formatDeadline(item.deadline);
        const origin = formatOrigin(item.origin_date, item.created_at);
        const sourceLabel = SOURCE_LABELS[item.source_type] || item.source_type;
        const imp = toLevel(item.priority);
        const urg = toLevel(item.urgency);

        return (
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
                {deadline && (
                  <>
                    <Text style={styles.dot}>{"\u00B7"}</Text>
                    <Text
                      style={[
                        styles.deadline,
                        deadline === "Overdue" && styles.deadlineOverdue,
                      ]}
                    >
                      {deadline}
                    </Text>
                  </>
                )}
              </View>
            </View>

            <View style={styles.levelPill}>
              <Text style={styles.levelText}>
                P{item.priority}U{item.urgency}
              </Text>
            </View>
          </Pressable>
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
  deadline: { fontSize: 12, color: "#ed8936", fontWeight: "600" },
  deadlineOverdue: { color: "#e53e3e" },
  levelPill: {
    backgroundColor: "#f0f0f0",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 10,
  },
  levelText: { fontSize: 11, fontWeight: "700", color: "#555" },
});
