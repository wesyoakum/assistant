import {
  View,
  Text,
  FlatList,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { apiFetch } from "../src/api/client";
import { type Theme } from "../src/theme";
import { useStyles } from "../src/hooks/useStyles";

interface NotificationEntry {
  id: string;
  title: string;
  body: string;
  category: string | null;
  triage_item_id: string | null;
  created_at: string;
}

interface NotificationHistoryResponse {
  notifications: NotificationEntry[];
}

function formatTime(dateStr: string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const mins = Math.floor(diff / 60000);

  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;

  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  }

  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function categoryIcon(category: string | null): string {
  switch (category) {
    case "triage-high": return "!";
    case "triage-normal": return "i";
    case "reminder": return "R";
    default: return "N";
  }
}

function categoryColor(category: string | null): string {
  switch (category) {
    case "triage-high": return "#BA2D2D";
    case "triage-normal": return "#CB7D34";
    case "reminder": return "#3D7F94";
    default: return "#a0aec0";
  }
}

export default function NotificationHistory() {
  const styles = useStyles(makeStyles);
  const router = useRouter();
  const { data, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ["notification-history"],
    queryFn: () => apiFetch<NotificationHistoryResponse>("/push/history"),
  });

  if (isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  const items = data?.notifications || [];

  return (
    <FlatList
      data={items}
      keyExtractor={(item) => item.id}
      refreshControl={
        <RefreshControl refreshing={isRefetching} onRefresh={refetch} />
      }
      contentContainerStyle={items.length === 0 ? styles.center : styles.list}
      ListEmptyComponent={
        <Text style={styles.emptyText}>No notifications yet</Text>
      }
      renderItem={({ item }) => (
        <Pressable
          style={styles.row}
          onPress={() => {
            if (item.triage_item_id) {
              router.push(`/triage/${item.triage_item_id}`);
            }
          }}
          disabled={!item.triage_item_id}
        >
          <View style={[styles.iconCircle, { backgroundColor: categoryColor(item.category) }]}>
            <Text style={styles.iconText}>{categoryIcon(item.category)}</Text>
          </View>
          <View style={styles.content}>
            <Text style={styles.title}>{item.title}</Text>
            <Text style={styles.body} numberOfLines={2}>{item.body}</Text>
          </View>
          <Text style={styles.time}>{formatTime(item.created_at)}</Text>
        </Pressable>
      )}
    />
  );
}

function makeStyles(theme: Theme) {
  return StyleSheet.create({
    center: { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: theme.background },
    list: { paddingBottom: 20, backgroundColor: theme.background },
    emptyText: { fontSize: 16, color: theme.textSubtle },
    row: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 16,
      paddingVertical: 14,
      backgroundColor: theme.surface,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
    },
    iconCircle: {
      width: 36,
      height: 36,
      borderRadius: 18,
      justifyContent: "center",
      alignItems: "center",
      marginRight: 12,
    },
    iconText: { color: "#fff", fontSize: 16, fontWeight: "700" },
    content: { flex: 1, marginRight: 10 },
    title: { fontSize: 14, fontWeight: "600", color: theme.text, marginBottom: 2 },
    body: { fontSize: 14, color: theme.textMuted, lineHeight: 19 },
    time: { fontSize: 12, color: theme.textSubtle },
  });
}
