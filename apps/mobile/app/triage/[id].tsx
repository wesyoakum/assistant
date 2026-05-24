import { useState, useEffect } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  Linking,
  Image,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Ionicons } from "@expo/vector-icons";
import { apiFetch, API_BASE } from "../../src/api/client";
import { useAuth } from "../../src/state/auth";

interface TriageItem {
  id: string;
  source_type: string;
  source_ref: string | null;
  source_title: string | null;
  source_url: string | null;
  priority: number;
  urgency: number;
  quadrant: string | null;
  next_check_at: string | null;
  compound_idx: number | null;
  category: string | null;
  summary: string | null;
  suggested_action: string | null;
  classifier_json: string | null;
  source_json: string | null;
  event_at: string | null;
  due_at: string | null;
  event_created_at: string | null;
  event_updated_at: string | null;
  status: string;
  created_at: string;
}

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

const QUADRANT_META: Record<Quadrant, { label: string; color: string }> = {
  hot:     { label: "Hot",     color: "#BA2D2D" },
  action:  { label: "Action",  color: "#CB7D34" },
  plan:    { label: "Plan",    color: "#38a169" },
  monitor: { label: "Monitor", color: "#4a90a4" },
  noop:    { label: "Noop",    color: "#a0aec0" },
};

const CATEGORIES = [
  "billing", "scheduling", "personal", "work", "newsletter",
  "notification", "social", "shopping", "travel", "security",
  "health", "legal", "other",
];

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

// --- Detail row component ---

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexDirection: "row", marginBottom: 4 }}>
      <Text style={{ fontSize: 13, color: "#888", width: 80 }}>{label}</Text>
      <Text style={{ fontSize: 13, color: "#333", flex: 1 }}>{value}</Text>
    </View>
  );
}

// --- Email content component ---

function EmailContent({ sourceJson }: { sourceJson: string }) {
  try {
    const parsed = JSON.parse(sourceJson);
    const emails: { subject?: string; from?: string; date?: string; bodyText?: string }[] = Array.isArray(parsed) ? parsed : [parsed];
    return (
      <View style={{ marginBottom: 20 }}>
        <Text style={{ fontSize: 13, fontWeight: "700", color: "#888", textTransform: "uppercase", marginBottom: 6 }}>
          {emails.length > 1 ? `Sources (${emails.length} emails)` : "Email"}
        </Text>
        {emails.map((email, i) => (
          <View key={i} style={{ backgroundColor: "#f8f8f8", borderRadius: 10, padding: 14, marginBottom: i < emails.length - 1 ? 8 : 0 }}>
            <Text style={{ fontSize: 14, fontWeight: "600", color: "#222", marginBottom: 4 }}>{email.subject || "(no subject)"}</Text>
            <Text style={{ fontSize: 13, color: "#666", marginBottom: 2 }}>From: {email.from || "unknown"}</Text>
            <Text style={{ fontSize: 12, color: "#999", marginBottom: 10 }}>{email.date ? new Date(email.date).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : ""}</Text>
            <View style={{ height: 1, backgroundColor: "#e0e0e0", marginBottom: 10 }} />
            <Text style={{ fontSize: 14, color: "#333", lineHeight: 20 }} numberOfLines={50}>{email.bodyText || "(no body)"}</Text>
          </View>
        ))}
      </View>
    );
  } catch {
    return null;
  }
}

// --- Calendar content component ---

function CalendarContent({ item }: { item: TriageItem }) {
  let evtData: Record<string, string | null> = {};
  if (item.source_json) {
    try { evtData = JSON.parse(item.source_json); } catch { /* ignore */ }
  }
  const title = (evtData.summary as string) || item.summary || "(untitled event)";
  const start = (evtData.start as string) || item.event_at;
  const end = (evtData.end as string) || null;
  const location = (evtData.location as string) || null;
  const description = (evtData.description as string) || null;
  const organizer = (evtData.organizer as string) || null;
  const calendar = (evtData.calendarName as string) || item.source_title || null;
  const fmtD = (d: string | null) => d ? new Date(d).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : null;

  return (
    <View style={{ marginBottom: 20 }}>
      <Text style={{ fontSize: 13, fontWeight: "700", color: "#888", textTransform: "uppercase", marginBottom: 6 }}>Calendar Event</Text>
      <View style={{ backgroundColor: "#f8f8f8", borderRadius: 10, padding: 14 }}>
        <Text style={{ fontSize: 16, fontWeight: "600", color: "#222", marginBottom: 8 }}>{title}</Text>
        {start && <DetailRow label="Start" value={fmtD(start)!} />}
        {end && <DetailRow label="End" value={fmtD(end)!} />}
        {calendar && <DetailRow label="Calendar" value={calendar} />}
        {location && <DetailRow label="Location" value={location} />}
        {organizer && <DetailRow label="Organizer" value={organizer} />}
        {description && (
          <>
            <View style={{ height: 1, backgroundColor: "#e0e0e0", marginVertical: 8 }} />
            <Text style={{ fontSize: 14, color: "#333", lineHeight: 20 }}>{description}</Text>
          </>
        )}
      </View>
    </View>
  );
}

// --- File preview component ---

function FilePreview({ sourceType, sourceRef }: { sourceType: string; sourceRef: string | null }) {
  const { token } = useAuth();
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (sourceType === "image" && sourceRef && token) {
      setLoading(true);
      fetch(`${API_BASE}/files/${sourceRef}/download`, {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then((res) => res.blob())
        .then((blob) => {
          const reader = new FileReader();
          reader.onload = () => {
            setImageUri(reader.result as string);
            setLoading(false);
          };
          reader.readAsDataURL(blob);
        })
        .catch(() => setLoading(false));
    }
  }, [sourceType, sourceRef, token]);

  if (!sourceRef) return null;

  if (sourceType === "image") {
    return (
      <View style={styles.filePreviewSection}>
        <Text style={styles.sectionTitle}>Captured Image</Text>
        {loading ? (
          <ActivityIndicator style={{ paddingVertical: 40 }} />
        ) : imageUri ? (
          <Image
            source={{ uri: imageUri }}
            style={styles.previewImage}
            resizeMode="contain"
          />
        ) : (
          <Text style={styles.previewError}>Could not load image</Text>
        )}
      </View>
    );
  }

  if (sourceType === "document" || sourceType === "voice") {
    const handleOpen = () => {
      if (token) {
        // Open in browser with token as query param (fine for 1-2 testers)
        Linking.openURL(`${API_BASE}/files/${sourceRef}/download?token=${encodeURIComponent(token)}`);
      }
    };

    return (
      <View style={styles.filePreviewSection}>
        <Text style={styles.sectionTitle}>
          {sourceType === "document" ? "Captured Document" : "Voice Memo"}
        </Text>
        <Pressable style={styles.viewFileBtn} onPress={handleOpen}>
          <Ionicons
            name={sourceType === "document" ? "document-text-outline" : "musical-notes-outline"}
            size={20}
            color="#3D7F94"
          />
          <Text style={styles.viewFileBtnText}>View Original File</Text>
        </Pressable>
      </View>
    );
  }

  return null;
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
  const [localCategory, setLocalCategory] = useState<string | null>(null);
  const [scoresExpanded, setScoresExpanded] = useState(false);
  const [localImpact, setLocalImpact] = useState<number | null>(null);
  const [localMeaning, setLocalMeaning] = useState<number | null>(null);
  const [localResponsibility, setLocalResponsibility] = useState<number | null>(null);
  const [localTimeSensitivity, setLocalTimeSensitivity] = useState<number | null>(null);
  const [localImmediacy, setLocalImmediacy] = useState<number | null>(null);

  const editMutation = useMutation({
    mutationFn: (body: Record<string, number | string>) =>
      apiFetch(`/triage/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      setLocalPriority(null);
      setLocalUrgency(null);
      setLocalCategory(null);
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
  const quadrantKey: Quadrant = (item.quadrant as Quadrant) || getQuadrant(imp, urg);
  const quadrant = QUADRANT_META[quadrantKey];
  const deadline = formatDeadline(item.due_at || item.event_at);
  // Origin: email sent date, calendar created/edited, or triage created
  const originDate = formatDate(
    item.source_type === "email" ? (item.event_at || item.created_at) :
    (item.source_type === "event" || item.source_type === "calendar")
      ? (item.event_updated_at || item.event_created_at || item.created_at)
      : item.created_at
  );
  const category = localCategory ?? item.category ?? "other";
  const hasChanged =
    (localPriority !== null && localPriority !== item.priority) ||
    (localUrgency !== null && localUrgency !== item.urgency) ||
    (localCategory !== null && localCategory !== (item.category ?? "other"));

  let details: string | null = null;
  let reasoning: string | null = null;
  let fiveFactors: { impact: number; meaning: number; responsibility: number; time_sensitivity: number; immediacy: number } | null = null;
  if (item.classifier_json) {
    try {
      const parsed = JSON.parse(item.classifier_json);
      details = parsed.details || parsed.extended_summary || null;
      reasoning = parsed.reasoning || null;
      if (parsed.impact !== undefined) {
        fiveFactors = {
          impact: parsed.impact,
          meaning: parsed.meaning,
          responsibility: parsed.responsibility,
          time_sensitivity: parsed.time_sensitivity,
          immediacy: parsed.immediacy,
        };
      }
    } catch {
      // ignore
    }
  }

  const hasDimensionChanges = fiveFactors && (
    (localImpact !== null && localImpact !== fiveFactors.impact) ||
    (localMeaning !== null && localMeaning !== fiveFactors.meaning) ||
    (localResponsibility !== null && localResponsibility !== fiveFactors.responsibility) ||
    (localTimeSensitivity !== null && localTimeSensitivity !== fiveFactors.time_sensitivity) ||
    (localImmediacy !== null && localImmediacy !== fiveFactors.immediacy)
  );

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

  const handleSave = () => {
    const updates: Record<string, number | string> = {};
    if (localPriority !== null && localPriority !== item.priority) updates.priority = localPriority;
    if (localUrgency !== null && localUrgency !== item.urgency) updates.urgency = localUrgency;
    if (localCategory !== null && localCategory !== (item.category ?? "other")) updates.category = localCategory;
    if (fiveFactors) {
      if (localImpact !== null && localImpact !== fiveFactors.impact) updates.impact = localImpact;
      if (localMeaning !== null && localMeaning !== fiveFactors.meaning) updates.meaning = localMeaning;
      if (localResponsibility !== null && localResponsibility !== fiveFactors.responsibility) updates.responsibility = localResponsibility;
      if (localTimeSensitivity !== null && localTimeSensitivity !== fiveFactors.time_sensitivity) updates.time_sensitivity = localTimeSensitivity;
      if (localImmediacy !== null && localImmediacy !== fiveFactors.immediacy) updates.immediacy = localImmediacy;
    }
    if (Object.keys(updates).length > 0) {
      editMutation.mutate(updates);
    }
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

      {/* Compound item badge */}
      {item.compound_idx != null && (
        <Text style={styles.compoundBadge}>
          Part of a multi-item input (item {item.compound_idx + 1})
        </Text>
      )}

      {/* Score pickers + category — expanded */}
      {scoresExpanded && (
        <View style={styles.scoresSection}>
          {fiveFactors && (
            <>
              <Text style={[styles.pickerLabel, { marginBottom: 8, fontSize: 12, color: "#888" }]}>SCORING DIMENSIONS</Text>
              <ScorePicker label="Impact" value={localImpact ?? fiveFactors.impact} onChange={setLocalImpact} />
              <ScorePicker label="Meaning" value={localMeaning ?? fiveFactors.meaning} onChange={setLocalMeaning} />
              <ScorePicker label="Responsibility" value={localResponsibility ?? fiveFactors.responsibility} onChange={setLocalResponsibility} />
              <ScorePicker label="Time Sens." value={localTimeSensitivity ?? fiveFactors.time_sensitivity} onChange={setLocalTimeSensitivity} />
              <ScorePicker label="Immediacy" value={localImmediacy ?? fiveFactors.immediacy} onChange={setLocalImmediacy} />
              <View style={{ height: 1, backgroundColor: "#ddd", marginVertical: 10 }} />
              <Text style={[styles.pickerLabel, { marginBottom: 8, fontSize: 12, color: "#888" }]}>SYNTHESIZED</Text>
            </>
          )}
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
          {reasoning && (
            <Text style={{ fontSize: 13, color: "#666", marginBottom: 10, lineHeight: 18 }}>{reasoning}</Text>
          )}
          <View style={styles.categoryPicker}>
            <Text style={styles.pickerLabel}>Category</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.categoryScroll}>
              {CATEGORIES.map((cat) => (
                <Pressable
                  key={cat}
                  style={[styles.categoryChip, category === cat && styles.categoryChipActive]}
                  onPress={() => setLocalCategory(cat)}
                >
                  <Text style={[styles.categoryChipText, category === cat && styles.categoryChipTextActive]}>
                    {cat}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>
          {(hasChanged || hasDimensionChanges) && (
            <Pressable
              style={styles.saveScoresBtn}
              onPress={handleSave}
              disabled={editMutation.isPending}
            >
              <Text style={styles.saveScoresText}>
                {editMutation.isPending ? "Saving..." : "Save Changes"}
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

      {/* Email content */}
      {item.source_type === "email" && item.source_json && (
        <EmailContent sourceJson={item.source_json} />
      )}

      {/* Calendar event details */}
      {(item.source_type === "event" || item.source_type === "calendar") && (
        <CalendarContent item={item} />
      )}

      {/* File preview for captured items */}
      {(item.source_type === "image" || item.source_type === "document" || item.source_type === "voice") && (
        <FilePreview sourceType={item.source_type} sourceRef={item.source_ref} />
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

        {(item.source_json || item.source_ref) && (
          <Pressable
            style={styles.openBtn}
            onPress={async () => {
              try {
                const res = await apiFetch<{ ok: boolean; newItemId?: string; summary?: string }>(`/triage/${item.id}/reevaluate`, { method: "POST" });
                queryClient.invalidateQueries({ queryKey: ["triage"] });
                if (res.newItemId && res.newItemId !== item.id) {
                  router.replace(`/triage/${res.newItemId}`);
                } else {
                  queryClient.invalidateQueries({ queryKey: ["triage", id] });
                }
              } catch (err: unknown) {
                Alert.alert("Error", err instanceof Error ? err.message : "Re-evaluate failed");
              }
            }}
          >
            <Text style={[styles.openBtnText, { color: "#3D7F94" }]}>Re-evaluate</Text>
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
  category: { fontSize: 13, fontWeight: "700", color: "#3D7F94", textTransform: "uppercase" },
  quadrantBadge: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 12,
  },
  badgeText: { color: "#fff", fontSize: 13, fontWeight: "700" },
  summary: { fontSize: 20, color: "#111", lineHeight: 28, marginBottom: 20 },
  compoundBadge: { fontSize: 12, color: "#666", backgroundColor: "#f0f0f0", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, marginBottom: 12, alignSelf: "flex-start" as const, overflow: "hidden" as const },
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
    backgroundColor: "#3D7F94",
  },
  pickerBtnText: { fontSize: 15, fontWeight: "600", color: "#666" },
  pickerBtnTextActive: { color: "#fff" },
  categoryPicker: {
    marginBottom: 10,
  },
  categoryScroll: {
    marginTop: 6,
  },
  categoryChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
    backgroundColor: "#e8e8e8",
    marginRight: 6,
  },
  categoryChipActive: {
    backgroundColor: "#3D7F94",
  },
  categoryChipText: {
    fontSize: 13,
    fontWeight: "600",
    color: "#666",
  },
  categoryChipTextActive: {
    color: "#fff",
  },
  saveScoresBtn: {
    backgroundColor: "#3D7F94",
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
  deadlineValue: { color: "#CB7D34", fontWeight: "700" },
  deadlineOverdue: { color: "#BA2D2D" },
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
    backgroundColor: "#3D7F94",
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
  // File preview styles
  filePreviewSection: {
    marginBottom: 20,
  },
  previewImage: {
    width: "100%",
    height: 280,
    borderRadius: 12,
    backgroundColor: "#f0f0f0",
  },
  previewError: {
    fontSize: 14,
    color: "#999",
    textAlign: "center",
    paddingVertical: 20,
  },
  viewFileBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#f0f0f0",
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 12,
  },
  viewFileBtnText: {
    fontSize: 15,
    fontWeight: "600",
    color: "#3D7F94",
  },
});
