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
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../../src/api/client";

interface TriageItem {
  id: string;
  source_type: string;
  source_ref: string | null;
  priority: number;
  urgency: number;
  category: string | null;
  summary: string | null;
  suggested_action: string | null;
  classifier_json: string | null;
  deadline: string | null;
  origin_date: string | null;
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
  const now = Date.now();
  const diff = d.getTime() - now;

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
  // source_ref for email is typically the Gmail message/thread ID
  return `https://mail.google.com/mail/u/0/#inbox/${sourceRef}`;
}

export default function TriageDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();

  const { data: item, isLoading } = useQuery({
    queryKey: ["triage", id],
    queryFn: () => apiFetch<TriageItem>(`/triage/${id}`),
    enabled: !!id,
  });

  if (isLoading || !item) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  const deadline = formatDeadline(item.deadline);
  const originDate = formatDate(item.origin_date || item.created_at);
  const imp = toLevel(item.priority);
  const urg = toLevel(item.urgency);
  const quadrant = QUADRANT_META[getQuadrant(imp, urg)];

  // Parse extended summary from classifier output
  let details: string | null = null;
  if (item.classifier_json) {
    try {
      const parsed = JSON.parse(item.classifier_json);
      details = parsed.details || parsed.extended_summary || null;
    } catch {
      // ignore
    }
  }

  const handleOpenOriginal = () => {
    if (item.source_type === "email") {
      const url = getGmailUrl(item.source_ref);
      if (url) Linking.openURL(url);
    }
    // Future: handle other source types (image viewer, audio player, etc.)
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
        <View style={[styles.quadrantBadge, { backgroundColor: quadrant.color }]}>
          <Text style={styles.badgeText}>{quadrant.label}</Text>
        </View>
      </View>

      {/* Importance / Urgency */}
      <View style={styles.levelRow}>
        <Text style={styles.levelLabel}>Importance: <Text style={styles.levelValue}>{imp}</Text></Text>
        <Text style={styles.levelLabel}>Urgency: <Text style={styles.levelValue}>{urg}</Text></Text>
      </View>

      {/* Summary */}
      <Text style={styles.summary}>{item.summary || "No summary"}</Text>

      {/* Time info */}
      <View style={styles.timeSection}>
        <View style={styles.timeRow}>
          <Text style={styles.timeLabel}>Received</Text>
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
      </View>

      {/* Details / extended summary */}
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

        {item.source_ref && (
          <Pressable style={styles.openBtn} onPress={handleOpenOriginal}>
            <Text style={styles.openBtnText}>Open Original</Text>
          </Pressable>
        )}
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
  levelRow: {
    flexDirection: "row",
    gap: 20,
    marginBottom: 16,
  },
  levelLabel: { fontSize: 13, color: "#888" },
  levelValue: { fontWeight: "700", color: "#444", textTransform: "capitalize" },
  summary: { fontSize: 20, color: "#111", lineHeight: 28, marginBottom: 20 },
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
});
