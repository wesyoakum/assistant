import { View, Text, ScrollView, StyleSheet, ActivityIndicator } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../../src/api/client";

interface TriageItem {
  id: string;
  source_type: string;
  priority: number;
  urgency: number;
  category: string | null;
  summary: string | null;
  suggested_action: string | null;
  classifier_json: string | null;
  status: string;
  created_at: string;
}

export default function TriageDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();

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

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Text style={styles.category}>
          {item.category?.toUpperCase() || "UNCATEGORIZED"}
        </Text>
        <View style={styles.badges}>
          <View style={[styles.badge, { backgroundColor: priorityColor(item.priority) }]}>
            <Text style={styles.badgeText}>P{item.priority}</Text>
          </View>
          <View style={[styles.badge, { backgroundColor: "#6b7280" }]}>
            <Text style={styles.badgeText}>U{item.urgency}</Text>
          </View>
        </View>
      </View>

      <Text style={styles.summary}>{item.summary || "No summary"}</Text>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Suggested Action</Text>
        <Text style={styles.sectionBody}>
          {item.suggested_action || "None"}
        </Text>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Source</Text>
        <Text style={styles.sectionBody}>
          {item.source_type} — {new Date(item.created_at).toLocaleString()}
        </Text>
      </View>

      {item.classifier_json && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Classifier Output</Text>
          <Text style={styles.code}>
            {JSON.stringify(JSON.parse(item.classifier_json), null, 2)}
          </Text>
        </View>
      )}
    </ScrollView>
  );
}

function priorityColor(p: number): string {
  if (p >= 4) return "#e53e3e";
  if (p === 3) return "#3182ce";
  return "#a0aec0";
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  container: { flex: 1, backgroundColor: "#fff" },
  content: { padding: 20 },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 16,
  },
  category: { fontSize: 13, fontWeight: "700", color: "#4285F4" },
  badges: { flexDirection: "row", gap: 6 },
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  badgeText: { color: "#fff", fontSize: 12, fontWeight: "700" },
  summary: { fontSize: 18, color: "#111", lineHeight: 26, marginBottom: 24 },
  section: { marginBottom: 20 },
  sectionTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: "#888",
    textTransform: "uppercase",
    marginBottom: 6,
  },
  sectionBody: { fontSize: 15, color: "#333", lineHeight: 22 },
  code: {
    fontSize: 12,
    fontFamily: "monospace",
    backgroundColor: "#f5f5f5",
    padding: 12,
    borderRadius: 8,
    color: "#333",
  },
});
