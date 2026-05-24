import { useMemo } from "react";
import {
  View,
  Text,
  SectionList,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
  Linking,
} from "react-native";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../../src/api/client";
import { type Theme } from "../../src/theme";
import { useStyles } from "../../src/hooks/useStyles";

interface CalendarEvent {
  id: string;
  calendarId: string;
  calendarName: string;
  summary: string;
  description: string | null;
  location: string | null;
  start: string;
  end: string;
  allDay: boolean;
  htmlLink: string;
  status: string;
  organizer: string | null;
  responseStatus: string | null;
  created: string | null;
  updated: string | null;
}

interface EventsResponse {
  events: CalendarEvent[];
}

function formatTime(iso: string, allDay: boolean): string {
  if (allDay) return "All day";
  const d = new Date(iso);
  return d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatDateHeader(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === tomorrow.toDateString()) return "Tomorrow";

  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
}

function formatShortDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function getDateKey(iso: string): string {
  return iso.slice(0, 10);
}

function timeUntil(iso: string): string | null {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff < 0 || diff > 24 * 60 * 60 * 1000) return null;
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `in ${mins}m`;
  return `in ${Math.floor(mins / 60)}h`;
}

export default function CalendarScreen() {
  const styles = useStyles(makeStyles);
  const queryClient = useQueryClient();

  const { data, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ["calendar-events"],
    queryFn: () => apiFetch<EventsResponse>("/calendar/events"),
  });

  const syncMutation = useMutation({
    mutationFn: () => apiFetch("/calendar/sync", { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["calendar-events"] });
    },
  });

  const isSyncing = syncMutation.isPending;


  const sections = useMemo(() => {
    const events = data?.events || [];
    const grouped: Record<string, CalendarEvent[]> = {};

    for (const evt of events) {
      const key = getDateKey(evt.start);
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(evt);
    }

    return Object.entries(grouped)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([dateKey, evts]) => ({
        key: dateKey,
        title: formatDateHeader(dateKey),
        data: evts,
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
      keyExtractor={(item) => `${item.calendarId}-${item.id}`}
      refreshControl={
        <RefreshControl refreshing={isRefetching} onRefresh={refetch} />
      }
      contentContainerStyle={
        sections.length === 0 ? styles.center : styles.list
      }
      ListHeaderComponent={
        <Pressable
          style={{ backgroundColor: "#3D7F94", paddingVertical: 10, alignItems: "center", marginHorizontal: 16, marginTop: 12, marginBottom: 8, borderRadius: 10, opacity: isSyncing ? 0.6 : 1 }}
          onPress={() => syncMutation.mutate()}
          disabled={isSyncing}
        >
          <Text style={{ color: "#fff", fontSize: 15, fontWeight: "600" }}>
            {isSyncing ? "Syncing..." : "Sync Calendar"}
          </Text>
        </Pressable>
      }
      ListEmptyComponent={
        <Text style={styles.emptyText}>No upcoming events</Text>
      }
      renderSectionHeader={({ section }) => (
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>{section.title}</Text>
        </View>
      )}
      renderItem={({ item }) => {
        const soon = timeUntil(item.start);
        const created = formatShortDate(item.created);
        const updated = formatShortDate(item.updated);
        const showUpdated = updated && updated !== created;

        return (
          <Pressable
            style={styles.row}
            onPress={() => {
              if (item.htmlLink) Linking.openURL(item.htmlLink);
            }}
          >
            <View style={styles.timeCol}>
              <Text style={styles.time}>
                {formatTime(item.start, item.allDay)}
              </Text>
              {!item.allDay && (
                <Text style={styles.timeEnd}>
                  {formatTime(item.end, false)}
                </Text>
              )}
            </View>

            <View style={styles.content}>
              <Text style={styles.summary} numberOfLines={1}>
                {item.summary}
              </Text>

              <Text style={styles.calName} numberOfLines={1}>
                {item.calendarName}
              </Text>

              {item.location && (
                <Text style={styles.location} numberOfLines={1}>
                  {item.location}
                </Text>
              )}

              <View style={styles.datesMeta}>
                {created && (
                  <Text style={styles.metaText}>Created {created}</Text>
                )}
                {showUpdated && (
                  <Text style={styles.metaText}>Modified {updated}</Text>
                )}
              </View>
            </View>

            {soon && <Text style={styles.soon}>{soon}</Text>}
          </Pressable>
        );
      }}
    />
  );
}

function makeStyles(theme: Theme) {
  return StyleSheet.create({
    center: { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: theme.background },
    list: { paddingBottom: 20 },
    emptyText: { fontSize: 16, color: theme.textSubtle },
    sectionHeader: {
      paddingHorizontal: 16,
      paddingVertical: 10,
      backgroundColor: theme.surfaceAlt,
    },
    sectionTitle: { fontSize: 14, fontWeight: "700", color: theme.textMuted },
    row: {
      flexDirection: "row",
      alignItems: "flex-start",
      paddingHorizontal: 16,
      paddingVertical: 12,
      backgroundColor: theme.surface,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
    },
    timeCol: { width: 65, marginRight: 12, paddingTop: 1 },
    time: { fontSize: 14, fontWeight: "600", color: theme.text },
    timeEnd: { fontSize: 12, color: theme.textSubtle },
    content: { flex: 1, marginRight: 8 },
    summary: { fontSize: 15, color: theme.text },
    calName: { fontSize: 12, color: theme.primary, fontWeight: "600", marginTop: 2 },
    location: { fontSize: 13, color: theme.textMuted, marginTop: 2 },
    datesMeta: { flexDirection: "row", gap: 10, marginTop: 3 },
    metaText: { fontSize: 11, color: theme.textSubtle },
    soon: {
      fontSize: 12,
      fontWeight: "600",
      color: theme.warning,
      paddingTop: 1,
    },
  });
}
