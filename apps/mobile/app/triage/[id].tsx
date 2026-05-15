import { useState } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  Linking,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../../src/api/client";

interface TriageItem {
  id: string;
  source_type: string;
  source_ref: string | null;
  source_title: string | null;
  source_url: string | null;
  priority: number;
  urgency: number;
  category: string | null;
  summary: string | null;
  suggested_action: string | null;
  classifier_json: string | null;
  event_at: string | null;
  due_at: string | null;
  event_created_at: string | null;
  event_updated_at: string | null;
  status: string;
  created_at: string;
}

type Level = "high" | "medium" | "low";
type Quadrant = "hot" | "action" | "plan" | "noop";

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

const QUADRANT_META: Record<Quadrant, { label: string; color: string }> = {
  hot:    { label: "Hot",    color: "#e53e3e" },
  action: { label: "Action", color: "#ed8936" },
  plan:   { label: "Plan",   color: "#38a169" },
  noop:   { label: "Noop",   color: "#a0aec0" },
};

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "Unknown";
  return new Date(dateStr).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatDeadline(deadline: string | null): string | null {
  if (!deadline) return null;
  const d = new Date(deadline);
  const diff = d.getTime() - Date.now();
  if (diff < 0) return "Overdue";
  if (diff < 60 * 60 * 1000) return `Expires in ${Math.ceil(diff / 60000)} minutes`;
  if (diff < 24 * 60 * 60 * 1000) return `Expires in ${Math.ceil(diff / 3600000)} hours`;
  return `Respond by ${d.toLocaleDateString("en-US", { month: "long", day: "numeric" })}`;
}

function sourceLabel(sourceType: string): string {
  switch (sourceType) {
    case "email": return "Email";
    case "calendar": return "Calendar Event";
    case "document": return "Document";
    case "image": return "Image";
    case "voice": return "Voice Memo";
    case "chat": return "Chat";
    default: return sourceType;
  }
}

function getGmailUrl(sourceRef: string | null): string | null {
  if (!sourceRef) return null;
  return `https://mail.google.com/mail/u/0/#inbox/${sourceRef}`;
}

// --- Score picker component ---

function ScorePicker({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <View style={styles.pickerRow}>
      <Text style={styles.pickerLabel}>{label}</Text>
      <View style={styles.pickerButtons}>
        {[1, 2, 3, 4, 5].map((n) => (
          <Pressable
            key={n}
            style={[
              styles.pickerBtn,
              n === value && styles.pickerBtnActive,
            ]}
            onPress={() => onChange(n)}
          >
            <Text
              style={[
                styles.pickerBtnText,
                n === value && styles.pickerBtnTextActive,
              ]}
            >
              {n}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

// --- Main component ---

export default function TriageDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();

  const { data: item, isLoading } = useQuery({
    queryKey: ["triage", id],
    queryFn: () => apiFetch<TriageItem>(`/triage/${id}`),
    enabled: !!id,
  });

  const [localPriority, setLocalPriority] = useState<number | null>(null);
  const [localUrgency, setLocalUrgency] = useState<number | null>(null);
  const [scoresExpanded, setScoresExpanded] = useState(false);

  const feedbackMutation = useMutation({
    mutationFn: (body: { kind: string; corrected_priority: number; corrected_urgency: number }) =>
      apiFetch(`/triage/${id}/feedback`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["triage", id] });
      queryClient.invalidateQueries({ queryKey: ["triage"] });
    },
  });

  const statusMutation = useMutation({
    mutationFn: (status: "done" | "dismissed") =>
      apiFetch(`/triage/${id}/status`, {
        method: "POST",
        body: JSON.stringify({ status }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["triage"] });
      router.back();
    },
  });

  if (isLoading || !item) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  const priority = localPriority ?? item.priority;
  const urgency = localUrgency ?? item.urgency;
  const imp = toLevel(priority);
  const urg = toLevel(urgency);
  const quadrant = QUADRANT_META[getQuadrant(imp, urg)];
  const deadline = formatDeadline(item.due_at || item.event_at);
  // Origin: email sent date, calendar created/edited, or triage created
  const originDate = formatDate(
    item.source_type === "email" ? (item.event_at || item.created_at) :
    (item.source_type === "event" || item.source_type === "calendar")
      ? (item.event_updated_at || item.event_created_at || item.created_at)
      : item.created_at
  );
  const hasChanged =
    (localPriority !== null && localPriority !== item.priority) ||
    (localUrgency !== null && localUrgency !== item.urgency);

  let details: string | null = null;
  if (item.classifier_json) {
    try {
      const parsed = JSON.parse(item.classifier_json);
      details = parsed.details || parsed.extended_summary || null;
    } catch {
      // ignore
    }
  }

  // Build source detail lines
  const sourceDetails: { label: string; value: string }[] = [];
  if (item.source_title) sourceDetails.push({ label: "From", value: item.source_title });
  if (item.source_type === "email" && item.event_at) {
    sourceDetails.push({ label: "Sent", value: formatDate(item.event_at) });
  } else if (item.event_at) {
    sourceDetails.push({ label: "Event", value: formatDate(item.event_at) });
  }
  if (item.due_at) sourceDetails.push({ label: "Due", value: formatDate(item.due_at) });
  if (item.event_created_at) sourceDetails.push({ label: "Created", value: formatDate(item.event_created_at) });
  if (item.event_updated_at && item.event_updated_at !== item.event_created_at) {
    sourceDetails.push({ label: "Modified", value: formatDate(item.event_updated_at) });
  }
  sourceDetails.push({ label: "Fetched", value: formatDate(item.created_at) });

  const handleSaveScores = () => {
    feedbackMutation.mutate({
      kind: "wrong_priority",
      corrected_priority: priority,
      corrected_urgency: urgency,
    });
    setLocalPriority(null);
    setLocalUrgency(null);
  };

  const handleOpenOriginal = () => {
    // Use source_url if available (covers events with htmlLink)
    if (item.source_url) {
      Linking.openURL(item.source_url);
      return;
    }
    if (item.source_type === "email") {
      const url = getGmailUrl(item.source_ref);
      if (url) Linking.openURL(url);
    } else if (item.source_type === "event" || item.source_type === "calendar") {
      // Fall back to Google Calendar web
      if (item.source_ref) {
        Linking.openURL(`https://calendar.google.com/calendar/event?eid=${item.source_ref}`);
      }
    }
  };

  const handleDiscussInChat = () => {
    router.push({
      pathname: "/(tabs)/chat",
      params: {
        triageId: item.id,
        context: item.summary || "this triage item",
      },
    });
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={styles.sourceLabel}>{sourceLabel(item.source_type)}</Text>
          {item.category && (
            <Text style={styles.category}>{item.category}</Text>
          )}
        </View>
        <View style={styles.headerBadges}>
          <View style={[styles.quadrantBadge, { backgroundColor: quadrant.color }]}>
            <Text style={styles.badgeText}>{quadrant.label}</Text>
          </View>
          <Pressable
            style={styles.puBadge}
            onPress={() => setScoresExpanded(!scoresExpanded)}
          >
            <Text style={styles.puBadgeText}>P{priority}U{urgency}</Text>
          </Pressable>
        </View>
      </View>

      {/* Summary */}
      <Text style={styles.summary}>{item.summary || "No summary"}</Text>

      {/* Score pickers — expanded */}
      {scoresExpanded && (
        <View style={styles.scoresSection}>
          <ScorePicker
            label="Importance"
            value={priority}
            onChange={setLocalPriority}
          />
          <ScorePicker
            label="Urgency"
            value={urgency}
            onChange={setLocalUrgency}
          />
          {hasChanged && (
            <Pressable
              style={styles.saveScoresBtn}
              onPress={handleSaveScores}
              disabled={feedbackMutation.isPending}
            >
              <Text style={styles.saveScoresText}>
                {feedbackMutation.isPending ? "Saving..." : "Save Scores"}
              </Text>
            </Pressable>
          )}
        </View>
      )}

      {/* Source details */}
      <View style={styles.timeSection}>
        <View style={styles.timeRow}>
          <Text style={styles.timeLabel}>Origin</Text>
          <Text style={styles.timeValue}>{originDate}</Text>
        </View>
        {deadline && (
          <View style={styles.timeRow}>
            <Text style={styles.timeLabel}>Deadline</Text>
            <Text
              style={[
                styles.timeValue,
                styles.deadlineValue,
                deadline === "Overdue" && styles.deadlineOverdue,
              ]}
            >
              {deadline}
            </Text>
          </View>
        )}
        {sourceDetails.map((d) => (
          <View key={d.label} style={styles.timeRow}>
            <Text style={styles.timeLabel}>{d.label}</Text>
            <Text style={styles.timeValue}>{d.value}</Text>
          </View>
        ))}
      </View>

      {/* Details */}
      {details && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Details</Text>
          <Text style={styles.sectionBody}>{details}</Text>
        </View>
      )}

      {/* Suggested action */}
      {item.suggested_action && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Suggested Action</Text>
          <Text style={styles.sectionBody}>{item.suggested_action}</Text>
        </View>
      )}

      {/* Action buttons */}
      <View style={styles.actions}>
        <Pressable style={styles.chatBtn} onPress={handleDiscussInChat}>
          <Text style={styles.chatBtnText}>Discuss in Chat</Text>
        </Pressable>

        {(item.source_url || item.source_ref) && (
          <Pressable style={styles.openBtn} onPress={handleOpenOriginal}>
            <Text style={styles.openBtnText}>Open Original</Text>
          </Pressable>
        )}

        <Pressable
          style={styles.dismissBtn}
          onPress={() => statusMutation.mutate("dismissed")}
          disabled={statusMutation.isPending}
        >
          <Text style={styles.dismissBtnText}>Dismiss</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  container: { flex: 1, backgroundColor: "#fff" },
  content: { padding: 20, paddingBottom: 40 },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 16,
  },
  headerLeft: { flex: 1, marginRight: 12 },
  sourceLabel: { fontSize: 13, fontWeight: "600", color: "#666", marginBottom: 2 },
  category: { fontSize: 13, fontWeight: "700", color: "#4285F4", textTransform: "uppercase" },
  quadrantBadge: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 12,
  },
  badgeText: { color: "#fff", fontSize: 13, fontWeight: "700" },
  summary: { fontSize: 20, color: "#111", lineHeight: 28, marginBottom: 20 },
  headerBadges: { flexDirection: "row", alignItems: "center", gap: 6 },
  puBadge: {
    backgroundColor: "#e8e8e8",
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 12,
  },
  puBadgeText: { fontSize: 11, fontWeight: "700", color: "#666" },
  scoresSection: {
    backgroundColor: "#f8f8f8",
    borderRadius: 10,
    padding: 14,
    marginBottom: 20,
  },
  pickerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  pickerLabel: { fontSize: 14, fontWeight: "600", color: "#555", width: 90 },
  pickerButtons: { flexDirection: "row", gap: 6 },
  pickerBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#e8e8e8",
    justifyContent: "center",
    alignItems: "center",
  },
  pickerBtnActive: {
    backgroundColor: "#4285F4",
  },
  pickerBtnText: { fontSize: 15, fontWeight: "600", color: "#666" },
  pickerBtnTextActive: { color: "#fff" },
  saveScoresBtn: {
    backgroundColor: "#4285F4",
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: "center",
    marginTop: 4,
  },
  saveScoresText: { color: "#fff", fontSize: 14, fontWeight: "600" },
  timeSection: {
    backgroundColor: "#f8f8f8",
    borderRadius: 10,
    padding: 14,
    marginBottom: 20,
  },
  timeRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 4,
  },
  timeLabel: { fontSize: 13, color: "#888" },
  timeValue: { fontSize: 13, color: "#444", fontWeight: "500" },
  deadlineValue: { color: "#ed8936", fontWeight: "700" },
  deadlineOverdue: { color: "#e53e3e" },
  section: { marginBottom: 20 },
  sectionTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: "#888",
    textTransform: "uppercase",
    marginBottom: 6,
  },
  sectionBody: { fontSize: 15, color: "#333", lineHeight: 22 },
  actions: { marginTop: 12, gap: 12 },
  chatBtn: {
    backgroundColor: "#4285F4",
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center",
  },
  chatBtnText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  openBtn: {
    backgroundColor: "#f0f0f0",
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center",
  },
  openBtnText: { color: "#333", fontSize: 16, fontWeight: "600" },
  dismissBtn: {
    backgroundColor: "#fff",
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#ddd",
  },
  dismissBtnText: { color: "#999", fontSize: 16, fontWeight: "600" },
});
