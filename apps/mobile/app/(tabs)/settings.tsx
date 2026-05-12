import { useState } from "react";
import {
  View,
  Text,
  TextInput,
  Switch,
  Pressable,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  Alert,
} from "react-native";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../../src/state/auth";
import { apiFetch } from "../../src/api/client";

interface CalendarSummary {
  id: string;
  summary: string;
  primary: boolean;
  backgroundColor: string;
  enabled: boolean;
}

interface CalendarsResponse {
  calendars: CalendarSummary[];
}

export default function SettingsScreen() {
  const { clearToken } = useAuth();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["calendars"],
    queryFn: () => apiFetch<CalendarsResponse>("/calendar/calendars"),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      apiFetch(`/calendar/calendars/${encodeURIComponent(id)}/toggle`, {
        method: "POST",
        body: JSON.stringify({ enabled }),
      }),
    onMutate: async ({ id, enabled }) => {
      await queryClient.cancelQueries({ queryKey: ["calendars"] });
      const prev = queryClient.getQueryData<CalendarsResponse>(["calendars"]);
      queryClient.setQueryData<CalendarsResponse>(["calendars"], (old) => {
        if (!old) return old;
        return {
          calendars: old.calendars.map((c) =>
            c.id === id ? { ...c, enabled } : c
          ),
        };
      });
      return { prev };
    },
    onError: (_err, _vars, context) => {
      if (context?.prev) {
        queryClient.setQueryData(["calendars"], context.prev);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["calendars"] });
      queryClient.invalidateQueries({ queryKey: ["calendar-events"] });
    },
  });

  const [calUrl, setCalUrl] = useState("");

  const subscribeMutation = useMutation({
    mutationFn: (url: string) =>
      apiFetch("/calendar/calendars/subscribe", {
        method: "POST",
        body: JSON.stringify({ url }),
      }),
    onSuccess: () => {
      setCalUrl("");
      queryClient.invalidateQueries({ queryKey: ["calendars"] });
      queryClient.invalidateQueries({ queryKey: ["calendar-events"] });
    },
    onError: (err: Error) => {
      Alert.alert("Could not add calendar", err.message);
    },
  });

  const handleSubscribe = () => {
    const trimmed = calUrl.trim();
    if (!trimmed) return;
    subscribeMutation.mutate(trimmed);
  };

  const handleSignOut = async () => {
    try {
      await apiFetch("/auth/logout", { method: "POST" });
    } catch {
      // Ignore — we clear local state regardless
    }
    await clearToken();
  };

  const calendars = data?.calendars || [];

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Calendars section */}
      <Text style={styles.sectionTitle}>Calendars</Text>
      <View style={styles.card}>
        {isLoading ? (
          <ActivityIndicator style={styles.loader} />
        ) : calendars.length === 0 ? (
          <Text style={styles.emptyText}>No calendars found</Text>
        ) : (
          calendars.map((cal) => (
            <View key={cal.id} style={styles.calRow}>
              <View
                style={[styles.calDot, { backgroundColor: cal.backgroundColor }]}
              />
              <View style={styles.calInfo}>
                <Text style={styles.calName} numberOfLines={1}>
                  {cal.summary}
                </Text>
                {cal.primary && (
                  <Text style={styles.calPrimary}>Primary</Text>
                )}
              </View>
              <Switch
                value={cal.enabled}
                onValueChange={(enabled) =>
                  toggleMutation.mutate({ id: cal.id, enabled })
                }
                trackColor={{ false: "#ddd", true: "#4285F4" }}
              />
            </View>
          ))
        )}
        {/* Add calendar input */}
        <View style={styles.addRow}>
          <TextInput
            style={styles.addInput}
            value={calUrl}
            onChangeText={setCalUrl}
            placeholder="Calendar ID or ICS URL"
            placeholderTextColor="#aaa"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="done"
            onSubmitEditing={handleSubscribe}
          />
          <Pressable
            style={[styles.addBtn, !calUrl.trim() && styles.addBtnDisabled]}
            onPress={handleSubscribe}
            disabled={!calUrl.trim() || subscribeMutation.isPending}
          >
            {subscribeMutation.isPending ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text style={styles.addBtnText}>Add</Text>
            )}
          </Pressable>
        </View>
      </View>

      {/* Account section */}
      <Text style={styles.sectionTitle}>Account</Text>
      <View style={styles.card}>
        <Pressable style={styles.signOutBtn} onPress={handleSignOut}>
          <Text style={styles.signOutText}>Sign Out</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f2f2f7" },
  content: { padding: 16, paddingBottom: 40 },
  sectionTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: "#888",
    textTransform: "uppercase",
    marginBottom: 8,
    marginTop: 16,
    marginLeft: 4,
  },
  card: {
    backgroundColor: "#fff",
    borderRadius: 12,
    overflow: "hidden",
  },
  loader: { padding: 20 },
  emptyText: { padding: 16, fontSize: 15, color: "#999", textAlign: "center" },
  calRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#eee",
  },
  calDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    marginRight: 12,
  },
  calInfo: { flex: 1, marginRight: 12 },
  calName: { fontSize: 15, color: "#222" },
  calPrimary: { fontSize: 12, color: "#999", marginTop: 1 },
  addRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#eee",
  },
  addInput: {
    flex: 1,
    fontSize: 14,
    color: "#222",
    backgroundColor: "#f5f5f5",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginRight: 8,
  },
  addBtn: {
    backgroundColor: "#4285F4",
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    minWidth: 50,
    alignItems: "center",
  },
  addBtnDisabled: { opacity: 0.4 },
  addBtnText: { color: "#fff", fontSize: 14, fontWeight: "600" },
  signOutBtn: {
    paddingVertical: 14,
    alignItems: "center",
  },
  signOutText: { fontSize: 16, fontWeight: "600", color: "#e53e3e" },
});
