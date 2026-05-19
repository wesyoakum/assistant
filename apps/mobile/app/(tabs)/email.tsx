import { useCallback } from "react";
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
  subject: string | null;
  from_addr: string | null;
  email_date: string | null;
  snippet: string | null;
  collected_at: string;
}

function formatEmailDate(dateStr: string | null): string {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "";

  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const mins = Math.floor(diff / 60000);

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
    queryFn: () => apiFetch<{ emails: RawEmail[] }>("/gmail/emails"),
  });

  const syncMutation = useMutation({
    mutationFn: () => apiFetch("/gmail/sync", { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["emails"] });
    },
  });

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

  const emails = data?.emails || [];

  return (
    <View style={{ flex: 1 }}>
      <Pressable
        style={styles.syncBtn}
        onPress={() => syncMutation.mutate()}
        disabled={syncMutation.isPending}
      >
        <Text style={styles.syncBtnText}>
          {syncMutation.isPending ? "Syncing..." : "Sync Email"}
        </Text>
      </Pressable>

      <FlatList
        data={emails}
        keyExtractor={(item) => item.id}
        refreshControl={
          <RefreshControl
            refreshing={isRefetching || syncMutation.isPending}
            onRefresh={handleRefresh}
          />
        }
        contentContainerStyle={emails.length === 0 ? styles.center : styles.list}
        ListEmptyComponent={
          <Text style={styles.emptyText}>No emails yet. Tap Sync Email above.</Text>
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
              {formatEmailDate(item.email_date)}
            </Text>
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  list: { paddingBottom: 20 },
  emptyText: { fontSize: 16, color: "#999" },
  syncBtn: {
    backgroundColor: "#4285F4",
    paddingVertical: 10,
    alignItems: "center",
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 8,
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
  rowContent: { flex: 1, marginRight: 10 },
  sender: { fontSize: 13, fontWeight: "600", color: "#333", marginBottom: 2 },
  subject: { fontSize: 15, color: "#222", lineHeight: 20 },
  snippet: { fontSize: 13, color: "#666", marginTop: 3, lineHeight: 18 },
  time: { fontSize: 12, color: "#999" },
});
