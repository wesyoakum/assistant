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

interface Suggestion {
  id: string;
  title: string;
  start_iso: string;
  end_iso: string;
  location: string | null;
  triage_summary: string | null;
}

interface SuggestionsResponse {
  suggestions: Suggestion[];
}

export default function CalendarScreen() {
  const queryClient = useQueryClient();

  const { data, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ["calendar-events"],
    queryFn: () => apiFetch<EventsResponse>("/calendar/events"),
  });


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
          style={{ backgroundColor: "#4285F4", paddingVertical: 10, alignItems: "center", marginHorizontal: 16, marginTop: 12, marginBottom: 8, borderRadius: 10 }}
          onPress={() => refetch()}
        >
          <Text style={{ color: "#fff", fontSize: 15, fontWeight: "600" }}>
            {isRefetching ? "Syncing..." : "Sync Calendar"}
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

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  list: { paddingBottom: 20 },
  emptyText: { fontSize: 16, color: "#999" },
  sectionHeader: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: "#f7f7f7",
  },
  sectionTitle: { fontSize: 14, fontWeight: "700", color: "#555" },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: "#fff",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#eee",
  },
  timeCol: { width: 65, marginRight: 12, paddingTop: 1 },
  time: { fontSize: 14, fontWeight: "600", color: "#333" },
  timeEnd: { fontSize: 12, color: "#999" },
  content: { flex: 1, marginRight: 8 },
  summary: { fontSize: 15, color: "#222" },
  calName: { fontSize: 12, color: "#4285F4", fontWeight: "600", marginTop: 2 },
  location: { fontSize: 13, color: "#888", marginTop: 2 },
  datesMeta: { flexDirection: "row", gap: 10, marginTop: 3 },
  metaText: { fontSize: 11, color: "#bbb" },
  soon: {
    fontSize: 12,
    fontWeight: "600",
    color: "#ed8936",
    paddingTop: 1,
  },
  suggestionsWrap: {
    padding: 16,
    paddingBottom: 8,
  },
  suggestionsTitle: {
    fontSize: 14,
    fontWeight: "700",
    color: "#ed8936",
    marginBottom: 8,
  },
  suggestionCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fff8f0",
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: "#fde6cc",
  },
  suggestionContent: { flex: 1, marginRight: 10 },
  suggestionName: { fontSize: 15, fontWeight: "600", color: "#333" },
  suggestionTime: { fontSize: 13, color: "#888", marginTop: 2 },
  suggestionMeta: { fontSize: 12, color: "#aaa", marginTop: 1 },
  suggestionActions: { gap: 6 },
  acceptBtn: {
    backgroundColor: "#4285F4",
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 8,
    alignItems: "center",
  },
  acceptText: { color: "#fff", fontSize: 13, fontWeight: "600" },
  rejectBtn: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    alignItems: "center",
  },
  rejectText: { color: "#999", fontSize: 13 },
});
