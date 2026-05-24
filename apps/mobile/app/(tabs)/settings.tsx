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
  Linking,
  Switch,
} from "react-native";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useAuth } from "../../src/state/auth";
import { useMe } from "../../src/hooks/useMe";
import { apiFetch } from "../../src/api/client";
import { useTheme, useAppearance, type Theme, type AppearanceMode } from "../../src/theme";
import { useStyles } from "../../src/hooks/useStyles";
import { ExperimentsContent } from "../experiments";

interface UsageSummaryData {
  today: { calls: number; costCents: number };
  week: { calls: number; costCents: number };
  month: { calls: number; costCents: number };
  allTime: { calls: number; costCents: number };
}

function UsageSummary() {
  const { token } = useAuth();
  const theme = useTheme();
  const { data, isLoading } = useQuery({
    queryKey: ["usage-summary"],
    queryFn: () => apiFetch<UsageSummaryData>("/usage/summary"),
    staleTime: 30_000,
  });

  const fmt = (cents: number) => "$" + (cents / 100).toFixed(2);

  if (isLoading) return <ActivityIndicator style={{ padding: 16 }} />;
  if (!data) return null;

  return (
    <View style={{ backgroundColor: theme.surface, borderRadius: 12, overflow: "hidden" }}>
      <View style={{ flexDirection: "row", paddingVertical: 12 }}>
        {[
          { label: "Today", v: data.today },
          { label: "7d", v: data.week },
          { label: "30d", v: data.month },
          { label: "All", v: data.allTime },
        ].map((col) => (
          <View key={col.label} style={{ flex: 1, alignItems: "center" }}>
            <Text style={{ fontSize: 11, color: theme.textSubtle, fontWeight: "600", textTransform: "uppercase" }}>{col.label}</Text>
            <Text style={{ fontSize: 20, fontWeight: "700", marginTop: 2, color: theme.text }}>{fmt(col.v.costCents)}</Text>
            <Text style={{ fontSize: 11, color: theme.textSubtle }}>{col.v.calls} calls</Text>
          </View>
        ))}
      </View>
      <Pressable
        style={{ paddingVertical: 12, alignItems: "center", borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border }}
        onPress={() => Linking.openURL("https://whyapp.us/usage#token=" + (token || ""))}
      >
        <Text style={{ fontSize: 14, fontWeight: "600", color: theme.primary }}>View Full Dashboard</Text>
      </Pressable>
    </View>
  );
}

interface CalendarSummary {
  id: string;
  summary: string;
  alias: string | null;
  displayName: string;
  primary: boolean;
  backgroundColor: string;
  enabled: boolean;
}

interface CalendarsResponse {
  calendars: CalendarSummary[];
}

interface IcalFeed {
  id: string;
  url: string;
  name: string | null;
  color: string;
  enabled: number;
  last_synced_at: string | null;
  error_message: string | null;
}

interface IcalFeedsResponse {
  feeds: IcalFeed[];
}

interface ContextEntry {
  id: string;
  kind: string;
  label: string;
  detail: string | null;
  created_at: string;
}

interface ContextResponse {
  entries: ContextEntry[];
}

interface GroupMeStatus {
  connected: boolean;
  groupme_user_id?: string | null;
  groupme_name?: string | null;
  connected_at?: string;
}

interface GroupMeGroup {
  id: string;
  name: string;
  description: string | null;
  image_url: string | null;
  member_count: number | null;
  last_message_at: number | null;
  enabled: boolean;
}

interface GroupMeGroupsResponse {
  groups: GroupMeGroup[];
}

function GroupMeSection() {
  const queryClient = useQueryClient();
  const [token, setToken] = useState("");
  const theme = useTheme();
  const styles = useStyles(makeStyles);

  const { data: status, isLoading: statusLoading } = useQuery({
    queryKey: ["groupme-status"],
    queryFn: () => apiFetch<GroupMeStatus>("/groupme/status"),
  });

  const { data: groupsData, isLoading: groupsLoading, error: groupsError } = useQuery({
    queryKey: ["groupme-groups"],
    queryFn: () => apiFetch<GroupMeGroupsResponse>("/groupme/groups"),
    enabled: !!status?.connected,
  });

  const connectMutation = useMutation({
    mutationFn: (accessToken: string) =>
      apiFetch("/groupme/token", {
        method: "POST",
        body: JSON.stringify({ access_token: accessToken }),
      }),
    onSuccess: () => {
      setToken("");
      queryClient.invalidateQueries({ queryKey: ["groupme-status"] });
      queryClient.invalidateQueries({ queryKey: ["groupme-groups"] });
    },
    onError: (err: Error) => Alert.alert("Could not connect GroupMe", err.message),
  });

  const disconnectMutation = useMutation({
    mutationFn: () => apiFetch("/groupme", { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["groupme-status"] });
      queryClient.removeQueries({ queryKey: ["groupme-groups"] });
    },
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      apiFetch(`/groupme/groups/${encodeURIComponent(id)}/toggle`, {
        method: "POST",
        body: JSON.stringify({ enabled }),
      }),
    onMutate: async ({ id, enabled }) => {
      await queryClient.cancelQueries({ queryKey: ["groupme-groups"] });
      const prev = queryClient.getQueryData<GroupMeGroupsResponse>(["groupme-groups"]);
      queryClient.setQueryData<GroupMeGroupsResponse>(["groupme-groups"], (old) => {
        if (!old) return old;
        return {
          groups: old.groups.map((g) => (g.id === id ? { ...g, enabled } : g)),
        };
      });
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(["groupme-groups"], ctx.prev);
    },
  });

  if (statusLoading) return <ActivityIndicator style={{ padding: 16 }} />;

  if (!status?.connected) {
    return (
      <View style={{ padding: 16 }}>
        <Text style={{ fontSize: 14, color: theme.textMuted, marginBottom: 12 }}>
          Paste an access token from{" "}
          <Text style={{ color: theme.primary }} onPress={() => Linking.openURL("https://dev.groupme.com")}>
            dev.groupme.com
          </Text>
          {" "}(sign in, then tap "Access Token" in the top right).
        </Text>
        <TextInput
          style={styles.addInput}
          value={token}
          onChangeText={setToken}
          placeholder="GroupMe access token"
          placeholderTextColor={theme.textSubtle}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
        />
        <Pressable
          style={[styles.addBtn, { marginTop: 12 }, !token.trim() && styles.addBtnDisabled]}
          onPress={() => token.trim() && connectMutation.mutate(token.trim())}
          disabled={!token.trim() || connectMutation.isPending}
        >
          {connectMutation.isPending ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text style={styles.addBtnText}>Connect</Text>
          )}
        </Pressable>
      </View>
    );
  }

  const groups = groupsData?.groups || [];

  return (
    <>
      <View style={{ paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border, flexDirection: "row", alignItems: "center" }}>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 15, fontWeight: "500", color: theme.text }}>Connected as {status.groupme_name || "GroupMe user"}</Text>
        </View>
        <Pressable
          onPress={() =>
            Alert.alert("Disconnect GroupMe?", "This removes your stored access token.", [
              { text: "Cancel", style: "cancel" },
              { text: "Disconnect", style: "destructive", onPress: () => disconnectMutation.mutate() },
            ])
          }
          style={{ paddingVertical: 4, paddingHorizontal: 8 }}
        >
          <Text style={{ fontSize: 13, color: theme.destructive }}>Disconnect</Text>
        </Pressable>
      </View>
      {groupsLoading ? (
        <ActivityIndicator style={{ padding: 16 }} />
      ) : groupsError ? (
        <Text style={{ padding: 16, color: theme.destructive }}>
          {(groupsError as Error).message}
        </Text>
      ) : groups.length === 0 ? (
        <Text style={styles.emptyText}>No groups found</Text>
      ) : (
        groups.map((g) => (
          <View key={g.id} style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border }}>
            <View style={{ flex: 1, marginRight: 12 }}>
              <Text style={{ fontSize: 15, fontWeight: "500", color: theme.text }}>{g.name}</Text>
              {g.member_count != null && (
                <Text style={{ fontSize: 12, color: theme.textSubtle, marginTop: 2 }}>
                  {g.member_count} members
                  {g.last_message_at ? ` • last message ${new Date(g.last_message_at * 1000).toLocaleString()}` : ""}
                </Text>
              )}
            </View>
            <Switch
              value={g.enabled}
              onValueChange={(enabled) => toggleMutation.mutate({ id: g.id, enabled })}
              trackColor={{ false: theme.border, true: theme.primary }}
            />
          </View>
        ))
      )}
    </>
  );
}

function AppearancePicker() {
  const theme = useTheme();
  const mode = useAppearance((s) => s.mode);
  const setMode = useAppearance((s) => s.setMode);

  const options: { value: AppearanceMode; label: string }[] = [
    { value: "system", label: "System" },
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
  ];

  return (
    <View style={{ flexDirection: "row", padding: 12, gap: 8 }}>
      {options.map((opt) => {
        const active = mode === opt.value;
        return (
          <Pressable
            key={opt.value}
            onPress={() => setMode(opt.value)}
            style={{
              flex: 1,
              paddingVertical: 10,
              borderRadius: 8,
              alignItems: "center",
              backgroundColor: active ? theme.primary : theme.surfaceAlt,
              borderWidth: active ? 0 : StyleSheet.hairlineWidth,
              borderColor: theme.border,
            }}
          >
            <Text
              style={{
                fontSize: 14,
                fontWeight: "600",
                color: active ? "#fff" : theme.text,
              }}
            >
              {opt.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function PreferencesList() {
  const styles = useStyles(makeStyles);
  const theme = useTheme();
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["context"],
    queryFn: () => apiFetch<ContextResponse>("/context"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/context/${id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["context"] }),
  });

  const prefs = (data?.entries || []).filter((e) => e.kind === "preference");

  const handleDelete = (entry: ContextEntry) => {
    Alert.alert(
      "Remove Preference",
      entry.label,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Remove", style: "destructive", onPress: () => deleteMutation.mutate(entry.id) },
      ]
    );
  };

  if (isLoading) return <ActivityIndicator style={{ padding: 16 }} />;

  if (prefs.length === 0) {
    return (
      <Text style={{ padding: 16, fontSize: 14, color: theme.textSubtle, textAlign: "center" }}>
        No preferences yet. Ask the chat to remember something.
      </Text>
    );
  }

  return (
    <>
      {prefs.map((p) => (
        <View key={p.id} style={{ flexDirection: "row", alignItems: "flex-start", paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border }}>
          <View style={{ flex: 1, marginRight: 12 }}>
            <Text style={{ fontSize: 15, color: "#1F2024", fontWeight: "500" }}>{p.label}</Text>
            {p.detail && (
              <Text style={{ fontSize: 13, color: theme.textMuted, marginTop: 2 }}>{p.detail}</Text>
            )}
          </View>
          <Pressable onPress={() => handleDelete(p)} style={{ paddingVertical: 4, paddingHorizontal: 8 }}>
            <Text style={{ fontSize: 13, color: "#BA2D2D" }}>Remove</Text>
          </Pressable>
        </View>
      ))}
    </>
  );
}


type SettingsTab = "general" | "calendars" | "groupme" | "context" | "experiments";

const TABS: { key: SettingsTab; label: string }[] = [
  { key: "general", label: "General" },
  { key: "calendars", label: "Calendars" },
  { key: "groupme", label: "GroupMe" },
  { key: "context", label: "Context" },
  { key: "experiments", label: "Lab" },
];

export default function SettingsScreen() {
  const { clearToken } = useAuth();
  const queryClient = useQueryClient();
  const router = useRouter();
  const [tab, setTab] = useState<SettingsTab>("general");
  const { data: me } = useMe();
  const theme = useTheme();
  const styles = useStyles(makeStyles);


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


  const aliasMutation = useMutation({
    mutationFn: ({ id, alias }: { id: string; alias: string | null }) =>
      apiFetch(`/calendar/calendars/${encodeURIComponent(id)}/alias`, {
        method: "POST",
        body: JSON.stringify({ alias }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["calendars"] });
      queryClient.invalidateQueries({ queryKey: ["calendar-events"] });
    },
  });

  const handleRename = (cal: CalendarSummary) => {
    Alert.prompt(
      "Rename Calendar",
      `Enter a nickname for "${cal.summary}"`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Clear", style: "destructive", onPress: () => aliasMutation.mutate({ id: cal.id, alias: null }) },
        { text: "Save", onPress: (value) => {
          if (value?.trim()) aliasMutation.mutate({ id: cal.id, alias: value.trim() });
        }},
      ],
      "plain-text",
      cal.alias || ""
    );
  };

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

  // --- iCal Feeds ---
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
          onPress: (value) => {
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
    Alert.alert(
      "Remove Feed",
      `Remove "${feed.name || feed.url}"?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => deleteFeedMutation.mutate(feed.id),
        },
      ]
    );
  };

  const icalFeeds = feedsData?.feeds || [];

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
      {/* Tab bar */}
      <View style={styles.tabBar}>
        {TABS.map((t) => (
          <Pressable
            key={t.key}
            style={[styles.tabItem, tab === t.key && styles.tabItemActive]}
            onPress={() => setTab(t.key)}
          >
            <Text
              style={[styles.tabText, tab === t.key && styles.tabTextActive]}
            >
              {t.label}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* GroupMe section */}
      {tab === "groupme" && (
        <>
          <Text style={styles.sectionTitle}>GroupMe</Text>
          <View style={styles.card}>
            <GroupMeSection />
          </View>
        </>
      )}

      {/* General section */}
      {tab === "general" && (
        <>
          <Text style={styles.sectionTitle}>API Usage</Text>
          <UsageSummary />
        </>
      )}

      {/* Context tab — preferences, data views, and per-source clear buttons */}
      {tab === "context" && (
        <>
          <Text style={styles.sectionTitle}>Preferences</Text>
          <View style={styles.card}>
            <PreferencesList />
          </View>

          <Text style={styles.sectionTitle}>Email</Text>
          <View style={styles.card}>
            <Pressable
              style={styles.clearChatBtn}
              onPress={() => router.push("/email")}
            >
              <Text style={[styles.clearChatText, { color: theme.primary }]}>View Emails</Text>
            </Pressable>
            <Pressable
              style={[styles.clearChatBtn, { borderBottomWidth: 0 }]}
              onPress={() => {
                Alert.alert("Clear Emails", "This will delete all stored emails and reset sync state.", [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: "Clear",
                    style: "destructive",
                    onPress: async () => {
                      await apiFetch("/gmail/emails", { method: "DELETE" });
                      queryClient.invalidateQueries({ queryKey: ["emails"] });
                      Alert.alert("Done", "All email data cleared.");
                    },
                  },
                ]);
              }}
            >
              <Text style={styles.clearChatText}>Clear Emails</Text>
            </Pressable>
          </View>

          <Text style={styles.sectionTitle}>Calendar</Text>
          <View style={styles.card}>
            <Pressable
              style={styles.clearChatBtn}
              onPress={() => router.push("/calendar")}
            >
              <Text style={[styles.clearChatText, { color: theme.primary }]}>View Calendar</Text>
            </Pressable>
            <Pressable
              style={[styles.clearChatBtn, { borderBottomWidth: 0 }]}
              onPress={() => {
                Alert.alert("Clear Calendar Data", "This will delete all synced calendar data (sync state, suggestions, events).", [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: "Clear",
                    style: "destructive",
                    onPress: async () => {
                      await apiFetch("/calendar/data", { method: "DELETE" });
                      queryClient.invalidateQueries({ queryKey: ["calendar-events"] });
                      Alert.alert("Done", "All calendar data cleared.");
                    },
                  },
                ]);
              }}
            >
              <Text style={styles.clearChatText}>Clear Calendar Data</Text>
            </Pressable>
          </View>

          <Text style={styles.sectionTitle}>Chat</Text>
          <View style={styles.card}>
            <Pressable
              style={[styles.clearChatBtn, { borderBottomWidth: 0 }]}
              onPress={() => {
                Alert.alert("Clear Chat", "This will delete your entire chat history.", [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: "Clear",
                    style: "destructive",
                    onPress: async () => {
                      await apiFetch("/chat/history", { method: "DELETE" });
                      queryClient.invalidateQueries({ queryKey: ["chat-history"] });
                      Alert.alert("Done", "Chat history cleared. Opening a fresh chat.", [
                        { text: "OK", onPress: () => router.replace("/(tabs)/chat") },
                      ]);
                    },
                  },
                ]);
              }}
            >
              <Text style={styles.clearChatText}>Clear Chat History</Text>
            </Pressable>
          </View>
        </>
      )}

      {/* Experiments tab — sensor sandbox */}
      {tab === "experiments" && <ExperimentsContent />}

      {/* Calendars section */}
      {tab === "calendars" && (
      <>
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
              <Pressable style={styles.calInfo} onPress={() => handleRename(cal)}>
                <Text style={styles.calName} numberOfLines={1}>
                  {cal.displayName}
                </Text>
                {cal.alias && (
                  <Text style={styles.calOriginal} numberOfLines={1}>{cal.summary}</Text>
                )}
                {cal.primary && !cal.alias && (
                  <Text style={styles.calPrimary}>Primary</Text>
                )}
              </Pressable>
              <Switch
                value={cal.enabled}
                onValueChange={(enabled) =>
                  toggleMutation.mutate({ id: cal.id, enabled })
                }
                trackColor={{ false: theme.border, true: theme.primary }}
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
            placeholder="Calendar ID, ICS URL, or webcal://"
            placeholderTextColor={theme.textSubtle}
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
      </>
      )}


      {/* iCal Feeds section */}
      {tab === "calendars" && (
      <>
      <Text style={styles.sectionTitle}>iCal Feeds</Text>
      <View style={styles.card}>
        {feedsLoading ? (
          <ActivityIndicator style={styles.loader} />
        ) : icalFeeds.length === 0 ? (
          <Text style={styles.emptyText}>No iCal feeds added yet</Text>
        ) : (
          icalFeeds.map((feed) => (
            <View key={feed.id} style={styles.calRow}>
              <View style={[styles.calDot, { backgroundColor: feed.color || "#8B5CF6" }]} />
              <View style={styles.calInfo}>
                <Text style={styles.calName} numberOfLines={1}>
                  {feed.name || feed.url}
                </Text>
                {feed.name && (
                  <Text style={styles.calOriginal} numberOfLines={1}>{feed.url}</Text>
                )}
                {feed.error_message && (
                  <Text style={styles.feedError} numberOfLines={1}>{feed.error_message}</Text>
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
            <ActivityIndicator size="small" color={theme.primary} />
          ) : (
            <Text style={styles.addFeedBtnText}>+ Add iCal Feed</Text>
          )}
        </Pressable>
      </View>
      </>
      )}

      {/* Notifications section */}
      {tab === "general" && (
      <>
      <Text style={styles.sectionTitle}>Appearance</Text>
      <View style={styles.card}>
        <AppearancePicker />
      </View>

      <Text style={styles.sectionTitle}>Notifications</Text>
      <View style={styles.card}>
        <Pressable
          style={styles.clearChatBtn}
          onPress={() => router.push("/notifications")}
        >
          <Text style={[styles.clearChatText, { color: theme.primary }]}>View Notification History</Text>
        </Pressable>
      </View>


      {/* Account section */}
      <Text style={styles.sectionTitle}>Account</Text>
      <View style={styles.card}>
        <Pressable
          style={styles.clearChatBtn}
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
          <Text style={[styles.clearChatText, { color: theme.textSubtle }]}>Copy Session Token</Text>
        </Pressable>
        <Pressable style={styles.signOutBtn} onPress={handleSignOut}>
          <Text style={styles.signOutText}>Sign Out</Text>
        </Pressable>
      </View>
      </>
      )}
    </ScrollView>
  );
}

function makeStyles(theme: Theme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.background },
    content: { padding: 16, paddingBottom: 40 },
    tabBar: {
      flexDirection: "row",
      backgroundColor: theme.surfaceAlt,
      borderRadius: 9,
      padding: 3,
      marginBottom: 8,
    },
    tabItem: {
      flex: 1,
      paddingVertical: 7,
      borderRadius: 7,
      alignItems: "center",
    },
    tabItemActive: {
      backgroundColor: theme.surface,
    },
    tabText: { fontSize: 13, fontWeight: "600", color: theme.textMuted },
    tabTextActive: { color: theme.text },
    sectionTitle: {
      fontSize: 13,
      fontWeight: "600",
      color: theme.textSubtle,
      textTransform: "uppercase",
      marginBottom: 8,
      marginTop: 16,
      marginLeft: 4,
    },
    card: {
      backgroundColor: theme.surface,
      borderRadius: 12,
      overflow: "hidden",
    },
    loader: { padding: 20 },
    emptyText: { padding: 16, fontSize: 15, color: theme.textSubtle, textAlign: "center" },
    calRow: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
    },
    calDot: {
      width: 12,
      height: 12,
      borderRadius: 6,
      marginRight: 12,
    },
    calInfo: { flex: 1, marginRight: 12 },
    calName: { fontSize: 15, color: theme.text },
    calOriginal: { fontSize: 11, color: theme.textSubtle, marginTop: 1 },
    calPrimary: { fontSize: 12, color: theme.textSubtle, marginTop: 1 },
    addRow: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.border,
    },
    addInput: {
      flex: 1,
      fontSize: 14,
      color: theme.text,
      backgroundColor: theme.surfaceAlt,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 8,
      marginRight: 8,
    },
    addBtn: {
      backgroundColor: theme.primary,
      paddingHorizontal: 16,
      paddingVertical: 8,
      borderRadius: 8,
      minWidth: 50,
      alignItems: "center",
    },
    addBtnDisabled: { opacity: 0.4 },
    addBtnText: { color: "#fff", fontSize: 14, fontWeight: "600" },
    ctxDelete: { paddingVertical: 4, paddingHorizontal: 8 },
    ctxDeleteText: { fontSize: 13, color: theme.destructive },
    clearChatBtn: {
      paddingVertical: 14,
      alignItems: "center",
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
    },
    clearChatText: { fontSize: 16, fontWeight: "600", color: theme.warning },
    signOutBtn: {
      paddingVertical: 14,
      alignItems: "center",
    },
    signOutText: { fontSize: 16, fontWeight: "600", color: theme.destructive },
    feedError: { fontSize: 11, color: theme.destructive, marginTop: 1 },
    addFeedBtn: {
      paddingVertical: 12,
      alignItems: "center",
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.border,
    },
    addFeedBtnText: { fontSize: 15, fontWeight: "600", color: theme.primary },
  });
}
