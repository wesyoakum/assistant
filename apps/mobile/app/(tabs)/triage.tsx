import { useCallback } from "react";
import {
  View,
  Text,
  SectionList,
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
  created_at: string;
}

interface TriageResponse {
  items: TriageItem[];
  cursor?: string;
}

const PRIORITY_LABELS: Record<string, { label: string; color: string }> = {
  urgent: { label: "Urgent", color: "#e53e3e" },
  normal: { label: "Normal", color: "#3182ce" },
  low: { label: "Low", color: "#a0aec0" },
};

function getPriorityGroup(priority: number): string {
  if (priority >= 4) return "urgent";
  if (priority === 3) return "normal";
  return "low";
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
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
      // Wait a moment for classification queue to process, then refetch
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ["triage"] }), 3000);
    },
  });

  const handleRefresh = useCallback(() => {
    syncMutation.mutate();
    refetch();
  }, [syncMutation, refetch]);

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      apiFetch(`/triage/${id}/status`, {
        method: "POST",
        body: JSON.stringify({ status }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["triage"] }),
  });

  if (isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  const items = data?.items || [];

  if (items.length === 0) {
    return (
      <View style={styles.center}>
        <Text style={styles.emptyText}>No items to triage</Text>
        <Pressable
          style={styles.syncButton}
          onPress={() => syncMutation.mutate()}
          disabled={syncMutation.isPending}
        >
          <Text style={styles.syncButtonText}>
            {syncMutation.isPending ? "Syncing..." : "Sync Gmail"}
          </Text>
        </Pressable>
      </View>
    );
  }

  // Group by priority tier
  const groups: Record<string, TriageItem[]> = {
    urgent: [],
    normal: [],
    low: [],
  };
  for (const item of items) {
    const group = getPriorityGroup(item.priority);
    groups[group]!.push(item);
  }

  const sections = Object.entries(groups)
    .filter(([, items]) => items.length > 0)
    .map(([key, items]) => ({
      key,
      title: PRIORITY_LABELS[key]!.label,
      color: PRIORITY_LABELS[key]!.color,
      data: items,
    }));

  return (
    <SectionList
      sections={sections}
      keyExtractor={(item) => item.id}
      refreshControl={
        <RefreshControl
          refreshing={isRefetching || syncMutation.isPending}
          onRefresh={handleRefresh}
        />
      }
      renderSectionHeader={({ section }) => (
        <View style={styles.sectionHeader}>
          <View
            style={[styles.sectionDot, { backgroundColor: section.color }]}
          />
          <Text style={styles.sectionTitle}>
            {section.title} ({section.data.length})
          </Text>
        </View>
      )}
      renderItem={({ item }) => (
        <Pressable
          style={styles.itemRow}
          onPress={() => router.push(`/triage/${item.id}`)}
        >
          <View style={styles.itemContent}>
            <View style={styles.itemTop}>
              {item.category && (
                <Text style={styles.category}>{item.category}</Text>
              )}
              <Text style={styles.timeAgo}>{timeAgo(item.created_at)}</Text>
            </View>
            <Text style={styles.summary} numberOfLines={2}>
              {item.summary || "No summary"}
            </Text>
            {item.suggested_action && (
              <Text style={styles.action} numberOfLines={1}>
                {item.suggested_action}
              </Text>
            )}
          </View>
          <View style={styles.itemActions}>
            <Pressable
              style={styles.doneBtn}
              onPress={(e) => {
                e.stopPropagation();
                statusMutation.mutate({ id: item.id, status: "done" });
              }}
            >
              <Text style={styles.doneBtnText}>Done</Text>
            </Pressable>
          </View>
        </Pressable>
      )}
      contentContainerStyle={styles.list}
    />
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  emptyText: { fontSize: 16, color: "#999", marginBottom: 16 },
  syncButton: {
    backgroundColor: "#4285F4",
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 10,
  },
  syncButtonText: { color: "#fff", fontSize: 15, fontWeight: "600" },
  list: { paddingBottom: 20 },
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
  itemRow: {
    flexDirection: "row",
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: "#fff",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#eee",
  },
  itemContent: { flex: 1, marginRight: 12 },
  itemTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 4,
  },
  category: {
    fontSize: 12,
    fontWeight: "600",
    color: "#4285F4",
    textTransform: "uppercase",
  },
  timeAgo: { fontSize: 12, color: "#999" },
  summary: { fontSize: 15, color: "#222", lineHeight: 20 },
  action: { fontSize: 13, color: "#666", marginTop: 4 },
  itemActions: { justifyContent: "center" },
  doneBtn: {
    backgroundColor: "#48bb78",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  },
  doneBtnText: { color: "#fff", fontSize: 13, fontWeight: "600" },
});
