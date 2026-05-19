import { useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  Alert,
} from "react-native";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useAuth } from "../../src/state/auth";
import { apiFetch } from "../../src/api/client";

interface CalendarSummary {
  id: string;
  summary: string;
  displayName: string;
  primary: boolean;
  backgroundColor: string;
}

interface CalendarsResponse {
  calendars: CalendarSummary[];
}

interface IcalFeed {
  id: string;
  url: string;
  name: string | null;
  color: string;
  last_synced_at: string | null;
  error_message: string | null;
}

interface IcalFeedsResponse {
  feeds: IcalFeed[];
}

export default function SettingsScreen() {
  const { clearToken } = useAuth();
  const queryClient = useQueryClient();
  const router = useRouter();
  const [calUrl, setCalUrl] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["calendars"],
    queryFn: () => apiFetch<CalendarsResponse>("/calendar/calendars"),
  });

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

  const { data: feedsData, isLoading: feedsLoading } = useQuery({
    queryKey: ["ical-feeds"],
    queryFn: () => apiFetch<IcalFeedsResponse>("/calendar/feeds"),
  });

  const addFeedMutation = useMutation({
    mutationFn: (url: string) =>
      apiFetch("/calendar/feeds", {
        method: "POST",
        body: JSON.stringify({ url }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ical-feeds"] });
      queryClient.invalidateQueries({ queryKey: ["calendar-events"] });
    },
    onError: (err: Error) => {
      Alert.alert("Could not add feed", err.message);
    },
  });

  const deleteFeedMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/calendar/feeds/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ical-feeds"] });
      queryClient.invalidateQueries({ queryKey: ["calendar-events"] });
    },
  });

  const handleAddFeed = () => {
    Alert.prompt(
      "Add iCal Feed",
      "Enter the ICS feed URL (https:// or webcal://)",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Add",
          onPress: (value?: string) => {
            const trimmed = value?.trim();
            if (trimmed) addFeedMutation.mutate(trimmed);
          },
        },
      ],
      "plain-text",
      ""
    );
  };

  const handleDeleteFeed = (feed: IcalFeed) => {
    Alert.alert("Remove Feed", `Remove "${feed.name || feed.url}"?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: () => deleteFeedMutation.mutate(feed.id),
      },
    ]);
  };

  const handleSubscribe = () => {
    const trimmed = calUrl.trim();
    if (!trimmed) return;
    subscribeMutation.mutate(trimmed);
  };

  const handleSignOut = async () => {
    try {
      await apiFetch("/auth/logout", { method: "POST" });
    } catch {
      // Ignore — clear local state regardless
    }
    await clearToken();
  };

  const calendars = data?.calendars || [];
  const icalFeeds = feedsData?.feeds || [];

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
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
                  {cal.displayName}
                </Text>
                {cal.primary && <Text style={styles.calPrimary}>Primary</Text>}
              </View>
            </View>
          ))
        )}
        <View style={styles.addRow}>
          <TextInput
            style={styles.addInput}
            value={calUrl}
            onChangeText={setCalUrl}
            placeholder="Calendar ID, ICS URL, or webcal://"
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

      <Text style={styles.sectionTitle}>iCal Feeds</Text>
      <View style={styles.card}>
        {feedsLoading ? (
          <ActivityIndicator style={styles.loader} />
        ) : icalFeeds.length === 0 ? (
          <Text style={styles.emptyText}>No iCal feeds added yet</Text>
        ) : (
          icalFeeds.map((feed) => (
            <View key={feed.id} style={styles.calRow}>
              <View
                style={[
                  styles.calDot,
                  { backgroundColor: feed.color || "#8B5CF6" },
                ]}
              />
              <View style={styles.calInfo}>
                <Text style={styles.calName} numberOfLines={1}>
                  {feed.name || feed.url}
                </Text>
                {feed.error_message && (
                  <Text style={styles.feedError} numberOfLines={1}>
                    {feed.error_message}
                  </Text>
                )}
                {feed.last_synced_at && !feed.error_message && (
                  <Text style={styles.calPrimary}>
                    Synced {new Date(feed.last_synced_at).toLocaleDateString()}
                  </Text>
                )}
              </View>
              <Pressable
                onPress={() => handleDeleteFeed(feed)}
                style={styles.ctxDelete}
              >
                <Text style={styles.ctxDeleteText}>Remove</Text>
              </Pressable>
            </View>
          ))
        )}
        <Pressable
          style={styles.addFeedBtn}
          onPress={handleAddFeed}
          disabled={addFeedMutation.isPending}
        >
          {addFeedMutation.isPending ? (
            <ActivityIndicator size="small" color="#4285F4" />
          ) : (
            <Text style={styles.addFeedBtnText}>+ Add iCal Feed</Text>
          )}
        </Pressable>
      </View>

      <Text style={styles.sectionTitle}>Account</Text>
      <View style={styles.card}>
        <Pressable
          style={styles.actionBtn}
          onPress={() => {
            Alert.alert("Clear Chat", "This will delete your entire chat history.", [
              { text: "Cancel", style: "cancel" },
              {
                text: "Clear",
                style: "destructive",
                onPress: async () => {
                  await apiFetch("/chat/history", { method: "DELETE" });
                  Alert.alert("Done", "Chat history cleared.", [
                    { text: "OK", onPress: () => router.replace("/(tabs)/chat") },
                  ]);
                },
              },
            ]);
          }}
        >
          <Text style={styles.actionText}>Clear Chat History</Text>
        </Pressable>
        <Pressable
          style={styles.actionBtn}
          onPress={() => {
            const t = useAuth.getState().token;
            if (t) {
              import("expo-clipboard").then((Clipboard) => {
                Clipboard.setStringAsync(t);
                Alert.alert("Copied", "Session token copied to clipboard");
              });
            } else {
              Alert.alert("No token", "You're not signed in");
            }
          }}
        >
          <Text style={[styles.actionText, { color: "#888" }]}>
            Copy Session Token
          </Text>
        </Pressable>
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
  ctxDelete: { paddingVertical: 4, paddingHorizontal: 8 },
  ctxDeleteText: { fontSize: 13, color: "#e53e3e" },
  feedError: { fontSize: 11, color: "#e53e3e", marginTop: 1 },
  addFeedBtn: {
    paddingVertical: 12,
    alignItems: "center",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#eee",
  },
  addFeedBtnText: { fontSize: 15, fontWeight: "600", color: "#4285F4" },
  actionBtn: {
    paddingVertical: 14,
    alignItems: "center",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#eee",
  },
  actionText: { fontSize: 16, fontWeight: "600", color: "#4285F4" },
  signOutBtn: {
    paddingVertical: 14,
    alignItems: "center",
  },
  signOutText: { fontSize: 16, fontWeight: "600", color: "#e53e3e" },
});
