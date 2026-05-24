import { useRef, useMemo, useEffect, useState } from "react";
import {
  View,
  Text,
  SectionList,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
  Alert,
} from "react-native";
import { Swipeable } from "react-native-gesture-handler";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { apiFetch } from "../../src/api/client";

interface TriageItem {
  id: string;
  source_type: string;
  priority: number;
  urgency: number;
  quadrant: string | null;
  next_check_at: string | null;
  category: string | null;
  summary: string | null;
  suggested_action: string | null;
  status: string;
  source_ref: string | null;
  source_title: string | null;
  event_at: string | null;
  due_at: string | null;
  event_created_at: string | null;
  event_updated_at: string | null;
  created_at: string;
}

interface TriageResponse {
  items: TriageItem[];
  cursor?: string;
}

interface ControlStatus {
  mode: "normal" | "controlled";
  batchSize: number;
  collected: number;
  pending: number;
  items: { subject: string; from: string; snippet: string; collected_at: string }[];
}

interface CollectResponse {
  collected: number;
  emails?: number;
  calendar?: number;
  captures?: number;
  total: number;
  items: ControlStatus["items"];
}

interface ClassifyNextResponse {
  classified: {
    subject: string;
    from: string;
    priority: number;
    urgency: number;
    category: string;
    summary: string;
    suggested_action: string;
    triage_item_id: string;
  }[];
  remaining: number;
}

// --- Eisenhower matrix ---

type Level = "high" | "medium" | "low";
type Quadrant = "hot" | "action" | "plan" | "monitor" | "noop";

function toLevel(n: number): Level {
  if (n >= 4) return "high";
  if (n === 3) return "medium";
  return "low";
}

function getQuadrant(importance: Level, urgency: Level): Quadrant {
  if (importance === "high" && urgency !== "low") return "hot";
  if (importance === "high" && urgency === "low") return "plan";
  if (urgency === "high" && importance !== "high") return "action";
  if (importance === "medium" && urgency === "medium") return "plan";
  if (importance === "medium" && urgency === "low") return "noop";
  if (importance === "low" && urgency === "medium") return "action";
  return "noop";
}

const QUADRANTS: { key: Quadrant; label: string; color: string }[] = [
  { key: "hot",     label: "Hot",     color: "#BA2D2D" },
  { key: "action",  label: "Action",  color: "#CB7D34" },
  { key: "plan",    label: "Plan",    color: "#38a169" },
  { key: "monitor", label: "Monitor", color: "#4a90a4" },
  { key: "noop",    label: "Noop",    color: "#a0aec0" },
];

// --- Helpers ---

const SOURCE_LABELS: Record<string, string> = {
  email: "Email",
  calendar: "Cal",
  event: "Event",
  document: "Doc",
  image: "Img",
  voice: "Voice",
  chat: "Chat",
};

/** Origin timestamp based on source type */
function getOriginDate(item: TriageItem): string {
  let date: string;
  switch (item.source_type) {
    case "email":
      // Email: use event_at (sent date) if available
      date = item.event_at || item.created_at;
      break;
    case "calendar":
    case "event":
      // Calendar: use event_created_at or event_updated_at
      date = item.event_updated_at || item.event_created_at || item.created_at;
      break;
    default:
      // Capture, chat: date added
      date = item.created_at;
  }
  return formatRelativeDate(date);
}

function formatRelativeDate(dateStr: string): string {
  const d = new Date(dateStr);
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  if (mins < 0) return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Urgency reference — deadline or event time */
function getUrgencyRef(item: TriageItem): string | null {
  const deadline = item.due_at || item.event_at;
  if (!deadline) return null;

  const d = new Date(deadline);
  const diff = d.getTime() - Date.now();

  if (diff < -24 * 60 * 60 * 1000) return "Overdue";
  if (diff < 0) return "Past";
  if (diff < 60 * 60 * 1000) return `${Math.ceil(diff / 60000)}m left`;
  if (diff < 24 * 60 * 60 * 1000) return `${Math.ceil(diff / 3600000)}h left`;
  if (diff < 7 * 24 * 60 * 60 * 1000) {
    return d.toLocaleDateString("en-US", { weekday: "short" });
  }
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
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
  const [recentIds, setRecentIds] = useState<Set<string>>(new Set());

  const { data, isLoading, refetch, isRefetching, error: triageError } = useQuery({
    queryKey: ["triage"],
    queryFn: () => apiFetch<TriageResponse>("/triage?status=open"),
  });

  const { data: control } = useQuery({
    queryKey: ["control-status"],
    queryFn: () => apiFetch<ControlStatus>("/control/status"),
  });

  const isControlled = control?.mode === "controlled";

  const collectMutation = useMutation({
    mutationFn: () =>
      apiFetch<CollectResponse>("/control/collect", { method: "POST" }),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ["control-status"] });
      Alert.alert(
        "Context collected",
        res.collected > 0
          ? `Pulled ${[
              res.emails ? `${res.emails} email${res.emails > 1 ? "s" : ""}` : "",
              res.calendar ? `${res.calendar} calendar event${res.calendar > 1 ? "s" : ""}` : "",
              res.captures ? `${res.captures} capture${res.captures > 1 ? "s" : ""}` : "",
            ].filter(Boolean).join(", ")}. ${res.total} awaiting classification.`
          : `Nothing new. ${res.total} awaiting classification.`
      );
    },
    onError: (err: Error) => Alert.alert("Collect failed", err.message),
  });

  const classifyMutation = useMutation({
    mutationFn: () =>
      apiFetch<ClassifyNextResponse>("/control/classify-next", { method: "POST" }),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ["control-status"] });
      queryClient.invalidateQueries({ queryKey: ["triage"] });
      queryClient.invalidateQueries({ queryKey: ["emails"] });
      if (res.classified.length === 0) {
        Alert.alert("Nothing to classify", "Collect new context first.");
        return;
      }
      // Track recently classified items for visual highlighting
      setRecentIds(new Set(res.classified.map((c) => c.triage_item_id).filter(Boolean)));
      const lines = res.classified
        .map((c) => `• I${c.importance || c.priority}U${c.urgency} — ${c.summary}`)
        .join("\n");
      Alert.alert(
        `Classified ${res.classified.length}`,
        `${lines}\n\n${res.remaining} still awaiting classification.`
      );
    },
    onError: (err: Error) => Alert.alert("Classify failed", err.message),
  });

  const dismissMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/triage/${id}/status`, {
        method: "POST",
        body: JSON.stringify({ status: "dismissed" }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["triage"] });
      queryClient.invalidateQueries({ queryKey: ["emails"] });
    },
  });

  // Auto-sync on mount — disabled in controlled mode (manual collect/classify).
  useEffect(() => {
    if (control === undefined) return; // wait until mode is known
    if (isControlled) return;
    if (didSync.current) return;
    didSync.current = true;
    apiFetch("/gmail/sync", { method: "POST" }).then(() => {
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ["triage"] }), 3000);
    });
  }, [queryClient, control, isControlled]);

  const sections = useMemo(() => {
    const items = data?.items || [];
    const buckets: Record<Quadrant, TriageItem[]> = {
      hot: [], action: [], plan: [], monitor: [], noop: [],
    };

    for (const item of items) {
      const q: Quadrant = (item.quadrant as Quadrant) || getQuadrant(toLevel(item.priority), toLevel(item.urgency));
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
        sections.length === 0 && !isControlled ? styles.center : styles.list
      }
      ListHeaderComponent={
        isControlled ? (
          <View style={styles.controlPanel}>
            <View style={styles.controlHeaderRow}>
              <Text style={styles.controlTitle}>Controlled Mode</Text>
              <Text style={styles.controlBadge}>spend control</Text>
            </View>
            <Text style={styles.controlStat}>
              {control!.collected} collected · awaiting classification · {data?.items?.length ?? 0} triaged{triageError ? ` · ERR: ${triageError.message}` : ""}
            </Text>
            {control!.items.length > 0 && (
              <View style={styles.collectedList}>
                {control!.items.slice(0, 5).map((it, i) => (
                  <Text key={i} style={styles.collectedItem} numberOfLines={1}>
                    • {it.subject}
                  </Text>
                ))}
                {control!.items.length > 5 && (
                  <Text style={styles.collectedMore}>
                    +{control!.items.length - 5} more
                  </Text>
                )}
              </View>
            )}
            <View style={styles.controlButtons}>
              <Pressable
                style={[styles.controlBtn, styles.controlBtnSecondary]}
                onPress={() => collectMutation.mutate()}
                disabled={collectMutation.isPending}
              >
                {collectMutation.isPending ? (
                  <ActivityIndicator size="small" color="#3D7F94" />
                ) : (
                  <Text style={styles.controlBtnSecondaryText}>
                    Collect new context
                  </Text>
                )}
              </Pressable>
              <Pressable
                style={[
                  styles.controlBtn,
                  styles.controlBtnPrimary,
                  (control!.collected === 0 || classifyMutation.isPending) &&
                    styles.controlBtnDisabled,
                ]}
                onPress={() => classifyMutation.mutate()}
                disabled={control!.collected === 0 || classifyMutation.isPending}
              >
                {classifyMutation.isPending ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={styles.controlBtnPrimaryText}>
                    Classify next ({control!.batchSize})
                  </Text>
                )}
              </Pressable>
            </View>
          </View>
        ) : null
      }
      ListEmptyComponent={
        isControlled ? null : (
          <Text style={styles.emptyText}>Nothing to triage right now</Text>
        )
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
        const origin = getOriginDate(item);
        const urgencyRef = getUrgencyRef(item);
        const sourceLabel = SOURCE_LABELS[item.source_type] || item.source_type;

        return (
          <Swipeable
            renderRightActions={() => (
              <Pressable
                style={styles.swipeDismiss}
                onPress={() => dismissMutation.mutate(item.id)}
              >
                <Text style={styles.swipeDismissText}>Dismiss</Text>
              </Pressable>
            )}
            onSwipeableOpen={(direction) => {
              if (direction === "right") dismissMutation.mutate(item.id);
            }}
          >
            <Pressable
              style={[styles.row, recentIds.has(item.id) && styles.recentRow]}
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
                  {urgencyRef && (
                    <>
                      <Text style={styles.dot}>{"\u00B7"}</Text>
                      <Text
                        style={[
                          styles.urgencyRef,
                          (urgencyRef === "Overdue" || urgencyRef === "Past") && styles.urgencyOverdue,
                        ]}
                      >
                        {urgencyRef}
                      </Text>
                    </>
                  )}
                </View>
              </View>

              <Text style={[styles.priorityNum, { color: section.color }]}>
                P{item.priority}U{item.urgency}
              </Text>
            </Pressable>
          </Swipeable>
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
  recentRow: {
    backgroundColor: "#f0f7ff",
    borderLeftWidth: 3,
    borderLeftColor: "#3D7F94",
  },
  priorityBar: {
    width: 4,
    alignSelf: "stretch",
    borderRadius: 2,
    marginRight: 12,
  },
  content: { flex: 1, marginRight: 10 },
  summary: { fontSize: 15, color: "#1F2024", marginBottom: 3 },
  metaRow: { flexDirection: "row", alignItems: "center" },
  sourceLabel: { fontSize: 12, color: "#3D7F94", fontWeight: "600" },
  dot: { fontSize: 12, color: "#ccc", marginHorizontal: 5 },
  origin: { fontSize: 12, color: "#999" },
  urgencyRef: { fontSize: 12, color: "#CB7D34", fontWeight: "600" },
  urgencyOverdue: { color: "#BA2D2D" },
  priorityNum: { fontSize: 13, fontWeight: "700" },
  swipeDismiss: {
    backgroundColor: "#BA2D2D",
    justifyContent: "center",
    alignItems: "center",
    width: 90,
  },
  swipeDismissText: { color: "#fff", fontSize: 14, fontWeight: "600" },
  controlPanel: {
    backgroundColor: "#fff",
    margin: 12,
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: "#e2e8f0",
  },
  controlHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 6,
  },
  controlTitle: { fontSize: 16, fontWeight: "700", color: "#1F2024" },
  controlBadge: {
    fontSize: 11,
    fontWeight: "600",
    color: "#7c3aed",
    backgroundColor: "#ede9fe",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    overflow: "hidden",
    textTransform: "uppercase",
  },
  controlStat: { fontSize: 13, color: "#666", marginBottom: 10 },
  collectedList: {
    backgroundColor: "#f7f7f9",
    borderRadius: 8,
    padding: 10,
    marginBottom: 12,
  },
  collectedItem: { fontSize: 13, color: "#444", marginVertical: 1 },
  collectedMore: { fontSize: 12, color: "#999", marginTop: 4 },
  controlButtons: { flexDirection: "row", gap: 10 },
  controlBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  controlBtnPrimary: { backgroundColor: "#3D7F94" },
  controlBtnPrimaryText: { color: "#fff", fontSize: 14, fontWeight: "700" },
  controlBtnSecondary: {
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#3D7F94",
  },
  controlBtnSecondaryText: { color: "#3D7F94", fontSize: 14, fontWeight: "700" },
  controlBtnDisabled: { opacity: 0.4 },
});
