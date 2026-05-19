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
import { apiFetch } from "../../src/api/client";

interface RawEmail {
  id: string;
  message_id: string;
  thread_id: string | null;
  subject: string | null;
  from_addr: string | null;
  email_date: string | null;
  snippet: string | null;
  collected_at: string;
}

interface MessagesResponse {
  messages: RawEmail[];
}

function formatDate(dateStr: string | null, fallback: string): string {
  const d = new Date(dateStr || fallback);
  if (isNaN(d.getTime())) return "";
  const now = new Date();
  const mins = Math.floor((now.getTime() - d.getTime()) / 60000);
  if (mins >= 0 && mins < 60) return `${mins}m ago`;
  if (mins >= 0 && mins < 24 * 60) return `${Math.floor(mins / 60)}h ago`;
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  }
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default function EmailScreen() {
  const queryClient = useQueryClient();

  const { data, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ["emails"],
    queryFn: () => apiFetch<MessagesResponse>("/gmail/messages"),
  });

  const syncMutation = useMutation({
    mutationFn: () => apiFetch("/gmail/sync", { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["emails"] });
    },
  });

  // Pull on mount.
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

  const items = data?.messages || [];

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
          <Text style={styles.emptyText}>No collected emails</Text>
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
        <View style={styles.row}>
          <View style={styles.rowContent}>
            {item.from_addr && (
              <Text style={styles.sender} numberOfLines={1}>
                {item.from_addr}
              </Text>
            )}
            <Text style={styles.subject} numberOfLines={1}>
              {item.subject || "(no subject)"}
            </Text>
            {item.snippet && (
              <Text style={styles.snippet} numberOfLines={2}>
                {item.snippet}
              </Text>
            )}
          </View>
          <Text style={styles.time}>
            {formatDate(item.email_date, item.collected_at)}
          </Text>
        </View>
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
    alignItems: "flex-start",
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: "#fff",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#eee",
  },
  rowContent: { flex: 1, marginRight: 10 },
  sender: { fontSize: 13, fontWeight: "600", color: "#333", marginBottom: 2 },
  subject: { fontSize: 15, color: "#222", lineHeight: 20 },
  snippet: { fontSize: 13, color: "#666", marginTop: 3 },
  time: { fontSize: 12, color: "#999" },
});
