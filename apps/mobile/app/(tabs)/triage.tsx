import { useEffect } from "react";
import {
  View,
  Text,
  FlatList,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
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
  deadline: string | null;
  origin_date: string | null;
  created_at: string;
}

interface TriageResponse {
  items: TriageItem[];
  cursor?: string;
}

const SOURCE_ICONS: Record<string, string> = {
  email: "\u2709",
  calendar: "\uD83D\uDCC5",
  document: "\uD83D\uDCC4",
  image: "\uD83D\uDDBC",
  voice: "\uD83C\uDFA4",
  chat: "\uD83D\uDCAC",
};

function priorityColor(p: number): string {
  if (p >= 4) return "#e53e3e";
  if (p === 3) return "#ed8936";
  if (p === 2) return "#3182ce";
  return "#a0aec0";
}

function formatDeadline(deadline: string | null): string | null {
  if (!deadline) return null;
  const d = new Date(deadline);
  const now = Date.now();
  const diff = d.getTime() - now;

  if (diff < 0) return "Overdue";
  if (diff < 60 * 60 * 1000) return `${Math.ceil(diff / 60000)}m left`;
  if (diff < 24 * 60 * 60 * 1000) return `${Math.ceil(diff / 3600000)}h left`;

  return `by ${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}

function formatOrigin(originDate: string | null, createdAt: string): string {
  const date = originDate || createdAt;
  const d = new Date(date);
  const now = Date.now();
  const diff = now - d.getTime();
  const mins = Math.floor(diff / 60000);

  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function truncateSummary(summary: string | null): string {
  if (!summary) return "No description";
  const words = summary.split(/\s+/);
  if (words.length <= 10) return summary;
  return words.slice(0, 10).join(" ") + "...";
}

export default function TriageScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();

  const { data, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ["triage"],
    queryFn: () => apiFetch<TriageResponse>("/triage?status=open"),
  });

  const syncMutation = useMutation({
    mutationFn: () => apiFetch("/gmail/sync", { method: "POST" }),
    onSuccess: () => {
      setTimeout(
        () => queryClient.invalidateQueries({ queryKey: ["triage"] }),
        3000
      );
    },
  });

  // Auto-sync on mount
  useEffect(() => {
    syncMutation.mutate();
  }, []);

  if (isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  // Sort by priority desc, then urgency desc
  const items = [...(data?.items || [])].sort(
    (a, b) => b.priority - a.priority || b.urgency - a.urgency
  );

  return (
    <FlatList
      data={items}
      keyExtractor={(item) => item.id}
      refreshControl={
        <RefreshControl
          refreshing={isRefetching || syncMutation.isPending}
          onRefresh={() => {
            syncMutation.mutate();
            refetch();
          }}
        />
      }
      contentContainerStyle={items.length === 0 ? styles.center : styles.list}
      ListEmptyComponent={
        <Text style={styles.emptyText}>Nothing to triage right now</Text>
      }
      renderItem={({ item }) => {
        const deadline = formatDeadline(item.deadline);
        const origin = formatOrigin(item.origin_date, item.created_at);
        const icon = SOURCE_ICONS[item.source_type] || "\u2022";

        return (
          <Pressable
            style={styles.row}
            onPress={() => router.push(`/triage/${item.id}`)}
          >
            <View style={styles.leftCol}>
              <View
                style={[
                  styles.priorityBar,
                  { backgroundColor: priorityColor(item.priority) },
                ]}
              />
            </View>

            <View style={styles.content}>
              <View style={styles.topRow}>
                <Text style={styles.sourceIcon}>{icon}</Text>
                <Text style={styles.summary} numberOfLines={1}>
                  {truncateSummary(item.summary)}
                </Text>
              </View>

              <View style={styles.bottomRow}>
                <Text style={styles.origin}>{origin}</Text>
                {deadline && (
                  <Text
                    style={[
                      styles.deadline,
                      deadline === "Overdue" && styles.deadlineOverdue,
                    ]}
                  >
                    {deadline}
                  </Text>
                )}
              </View>
            </View>

            <View style={styles.priorityBadge}>
              <Text style={styles.priorityNum}>P{item.priority}</Text>
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
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingRight: 16,
    paddingVertical: 12,
    backgroundColor: "#fff",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#eee",
  },
  leftCol: { width: 4, marginRight: 14 },
  priorityBar: {
    width: 4,
    height: "100%",
    borderRadius: 2,
    minHeight: 36,
  },
  content: { flex: 1, marginRight: 10 },
  topRow: { flexDirection: "row", alignItems: "center", marginBottom: 4 },
  sourceIcon: { fontSize: 14, marginRight: 6 },
  summary: { fontSize: 15, color: "#222", flex: 1 },
  bottomRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  origin: { fontSize: 12, color: "#999" },
  deadline: { fontSize: 12, color: "#ed8936", fontWeight: "600" },
  deadlineOverdue: { color: "#e53e3e" },
  priorityBadge: {
    backgroundColor: "#f0f0f0",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 10,
  },
  priorityNum: { fontSize: 12, fontWeight: "700", color: "#555" },
});
