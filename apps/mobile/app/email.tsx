import { useCallback, useRef } from "react";
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
import { apiFetch } from "../src/api/client";
import { type Theme } from "../src/theme";
import { useStyles } from "../src/hooks/useStyles";

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
  const lastSyncTime = useRef<string | null>(null);
  const styles = useStyles(makeStyles);

  const { data, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ["emails"],
    queryFn: () => apiFetch<{ emails: RawEmail[] }>("/gmail/emails"),
  });

  const syncMutation = useMutation({
    mutationFn: () => {
      const syncStart = new Date().toISOString();
      return apiFetch<{ synced: number; stored: number }>("/gmail/sync", { method: "POST" }).then((result) => {
        if (result.stored > 0) {
          lastSyncTime.current = syncStart;
        }
        return result;
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["emails"] });
    },
  });

  const isNew = (email: RawEmail) => {
    if (!lastSyncTime.current) return false;
    return email.collected_at >= lastSyncTime.current;
  };

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
          {syncMutation.isPending
            ? "Syncing..."
            : syncMutation.data?.stored
              ? `Sync Email (${syncMutation.data.stored} new)`
              : "Sync Email"}
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
        renderItem={({ item }) => {
          const fresh = isNew(item);
          return (
            <View style={[styles.row, fresh && styles.rowNew]}>
              {fresh && <View style={styles.newDot} />}
              <View style={styles.rowContent}>
                {item.from_addr && (
                  <Text style={[styles.sender, fresh && styles.senderNew]} numberOfLines={1}>
                    {item.from_addr}
                  </Text>
                )}
                <Text style={[styles.subject, fresh && styles.subjectNew]} numberOfLines={1}>
                  {item.subject || "(no subject)"}
                </Text>
                {item.snippet && (
                  <Text style={styles.snippet} numberOfLines={2}>
                    {item.snippet}
                  </Text>
                )}
              </View>
              <View style={styles.timeCol}>
                <Text style={styles.time}>
                  {formatEmailDate(item.email_date)}
                </Text>
                {fresh && <Text style={styles.newLabel}>NEW</Text>}
              </View>
            </View>
          );
        }}
      />
    </View>
  );
}

function makeStyles(theme: Theme) {
  return StyleSheet.create({
    center: { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: theme.background },
    list: { paddingBottom: 20 },
    emptyText: { fontSize: 16, color: theme.textSubtle },
    syncBtn: {
      backgroundColor: theme.primary,
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
      backgroundColor: theme.surface,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
    },
    rowNew: {
      backgroundColor: theme.scheme === "dark" ? theme.surfaceAlt : "#f0f7ff",
      borderLeftWidth: 3,
      borderLeftColor: theme.primary,
    },
    newDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: theme.primary,
      marginRight: 8,
    },
    rowContent: { flex: 1, marginRight: 10 },
    sender: { fontSize: 13, fontWeight: "600", color: theme.textMuted, marginBottom: 2 },
    senderNew: { color: theme.primary },
    subject: { fontSize: 15, color: theme.text, lineHeight: 20 },
    subjectNew: { fontWeight: "700" },
    snippet: { fontSize: 13, color: theme.textMuted, marginTop: 3, lineHeight: 18 },
    timeCol: { alignItems: "flex-end" },
    time: { fontSize: 12, color: theme.textSubtle },
    newLabel: { fontSize: 10, fontWeight: "700", color: theme.primary, marginTop: 2 },
  });
}
