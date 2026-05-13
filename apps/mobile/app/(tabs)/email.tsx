import { useCallback, useEffect } from "react";
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
  event_at: string | null;
  source_title: string | null;
  created_at: string;
}

interface TriageResponse {
  items: TriageItem[];
  cursor?: string;
}

function formatEmailDate(dateStr: string | null, fallback: string): string {
  const d = new Date(dateStr || fallback);
  if (isNaN(d.getTime())) return "Unknown";

  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const mins = Math.floor(diff / 60000);

  if (mins >= 0 && mins < 60) return `${mins}m ago`;
  if (mins >= 0 && mins < 24 * 60) return `${Math.floor(mins / 60)}h ago`;

  // If today, show time
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  }

  // Otherwise show date
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function priorityColor(p: number): string {
  if (p >= 4) return "#e53e3e";
  if (p === 3) return "#ed8936";
  if (p === 2) return "#3182ce";
  return "#a0aec0";
}

export default function EmailScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();

  const { data, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ["emails"],
    queryFn: () =>
      apiFetch<TriageResponse>("/triage?source_type=email&status=open"),
  });

  const syncMutation = useMutation({
    mutationFn: () => apiFetch("/gmail/sync", { method: "POST" }),
    onSuccess: () => {
      setTimeout(
        () => queryClient.invalidateQueries({ queryKey: ["emails"] }),
        3000
      );
    },
  });

  // Auto-sync on mount
  useEffect(() => {
    syncMutation.mutate();
  }, []);

  const handleRefresh = useCallback(() => {
    syncMutation.mutate();
    refetch();
  }, [syncMutation, refetch]);

  if (isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  const items = data?.items || [];

  return (
    <FlatList
      data={items}
      keyExtractor={(item) => item.id}
      refreshControl={
        <RefreshControl
          refreshing={isRefetching || syncMutation.isPending}
          onRefresh={handleRefresh}
        />
      }
      contentContainerStyle={items.length === 0 ? styles.center : styles.list}
      ListEmptyComponent={
        <View style={styles.emptyWrap}>
          <Text style={styles.emptyText}>No emails to review</Text>
          <Pressable
            style={styles.syncBtn}
            onPress={() => syncMutation.mutate()}
            disabled={syncMutation.isPending}
          >
            <Text style={styles.syncBtnText}>
              {syncMutation.isPending ? "Syncing..." : "Sync Gmail"}
            </Text>
          </Pressable>
        </View>
      }
      renderItem={({ item }) => (
        <Pressable
          style={styles.row}
          onPress={() => router.push(`/triage/${item.id}`)}
        >
          <View
            style={[styles.priorityDot, { backgroundColor: priorityColor(item.priority) }]}
          />
          <View style={styles.rowContent}>
            {item.source_title && (
              <Text style={styles.sender} numberOfLines={1}>
                {item.source_title}
              </Text>
            )}
            <Text style={styles.summary} numberOfLines={2}>
              {item.summary || "No subject"}
            </Text>
            {item.suggested_action && (
              <Text style={styles.action} numberOfLines={1}>
                {item.suggested_action}
              </Text>
            )}
          </View>
          <Text style={styles.time}>
            {formatEmailDate(item.event_at, item.created_at)}
          </Text>
        </Pressable>
      )}
    />
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  list: { paddingBottom: 20 },
  emptyWrap: { alignItems: "center" },
  emptyText: { fontSize: 16, color: "#999", marginBottom: 16 },
  syncBtn: {
    backgroundColor: "#4285F4",
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 10,
  },
  syncBtnText: { color: "#fff", fontSize: 15, fontWeight: "600" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: "#fff",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#eee",
  },
  priorityDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: 12,
  },
  rowContent: { flex: 1, marginRight: 10 },
  sender: { fontSize: 13, fontWeight: "600", color: "#333", marginBottom: 2 },
  summary: { fontSize: 15, color: "#222", lineHeight: 20 },
  action: { fontSize: 13, color: "#666", marginTop: 3 },
  time: { fontSize: 12, color: "#999" },
});
