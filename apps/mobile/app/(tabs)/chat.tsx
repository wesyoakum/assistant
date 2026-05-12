import { useState, useRef, useCallback, useEffect } from "react";
import {
  View,
  Text,
  TextInput,
  FlatList,
  Pressable,
  Keyboard,
  TouchableWithoutFeedback,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  ActivityIndicator,
} from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Markdown from "react-native-markdown-display";
import { apiFetch } from "../../src/api/client";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
}

interface ChatResponse {
  reply: string;
  savedContext?: string[];
  createdItems?: string[];
}

export default function ChatScreen() {
  const params = useLocalSearchParams<{ triageId?: string; context?: string }>();
  const [messages, setMessages] = useState<Message[]>(() => {
    if (params.context) {
      return [
        {
          id: "system-0",
          role: "assistant" as const,
          content: `Let's discuss: ${params.context}`,
        },
      ];
    }
    return [];
  });
  const queryClient = useQueryClient();
  const [input, setInput] = useState("");
  const flatListRef = useRef<FlatList>(null);
  const didGreet = useRef(false);

  // Fetch greeting on mount (only if no triage context)
  useEffect(() => {
    if (didGreet.current || params.context) return;
    didGreet.current = true;

    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    apiFetch<{ greeting: string }>(`/chat/greeting?tz=${encodeURIComponent(tz)}`)
      .then((data) => {
        setMessages((prev) => [
          ...prev,
          {
            id: "greeting-0",
            role: "assistant",
            content: data.greeting,
          },
        ]);
      })
      .catch(() => {
        // Fail silently — user can still chat
      });
  }, []);

  const sendMutation = useMutation({
    mutationFn: async (text: string) => {
      // Send conversation history for context
      const history = messages.map((m) => ({
        role: m.role,
        content: m.content,
      }));
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const body: Record<string, unknown> = { message: text, history, timezone: tz };
      if (params.triageId) body.triage_item_id = params.triageId;
      return apiFetch<ChatResponse>("/chat", {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
    onSuccess: (data) => {
      setMessages((prev) => [
        ...prev,
        {
          id: `assistant-${Date.now()}`,
          role: "assistant",
          content: data.reply,
        },
      ]);
      if (data.savedContext?.length) {
        queryClient.invalidateQueries({ queryKey: ["user-context"] });
      }
      if (data.createdItems?.length) {
        queryClient.invalidateQueries({ queryKey: ["triage"] });
      }
    },
    onError: (err: Error) => {
      setMessages((prev) => [
        ...prev,
        {
          id: `error-${Date.now()}`,
          role: "assistant",
          content: `Error: ${err.message}`,
        },
      ]);
    },
  });

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || sendMutation.isPending) return;

    setMessages((prev) => [
      ...prev,
      {
        id: `user-${Date.now()}`,
        role: "user",
        content: text,
      },
    ]);
    setInput("");
    sendMutation.mutate(text);
  }, [input, sendMutation]);

  return (
    <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={90}
      >
        <FlatList
          ref={flatListRef}
          data={messages}
          keyExtractor={(item) => item.id}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={styles.messageList}
          onContentSizeChange={() =>
            flatListRef.current?.scrollToEnd({ animated: true })
          }
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <ActivityIndicator size="small" color="#999" />
            </View>
          }
          renderItem={({ item }) => (
            <View
              style={[
                styles.messageBubble,
                item.role === "user" ? styles.userBubble : styles.assistantBubble,
              ]}
            >
              {item.role === "user" ? (
                <Text style={[styles.messageText, styles.userText]}>
                  {item.content}
                </Text>
              ) : (
                <Markdown style={item.role === "assistant" ? mdStyles : mdStylesUser}>
                  {item.content}
                </Markdown>
              )}
            </View>
          )}
        />

        {sendMutation.isPending && (
          <View style={styles.typingRow}>
            <ActivityIndicator size="small" color="#999" />
            <Text style={styles.typingText}>Thinking...</Text>
          </View>
        )}

        <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder="Message your assistant..."
          placeholderTextColor="#999"
          multiline
          maxLength={2000}
          returnKeyType="send"
          blurOnSubmit={false}
          onSubmitEditing={handleSend}
        />
        <Pressable
          style={[styles.sendBtn, !input.trim() && styles.sendBtnDisabled]}
          onPress={handleSend}
          disabled={!input.trim() || sendMutation.isPending}
        >
          <Text style={styles.sendBtnText}>Send</Text>
        </Pressable>
      </View>
      </KeyboardAvoidingView>
    </TouchableWithoutFeedback>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f9f9f9" },
  messageList: { padding: 16, paddingBottom: 8, flexGrow: 1 },
  emptyContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingTop: 120,
  },
  emptyTitle: { fontSize: 24, fontWeight: "700", color: "#333", marginBottom: 8 },
  emptyText: { fontSize: 15, color: "#999", textAlign: "center", maxWidth: 260 },
  messageBubble: {
    maxWidth: "80%",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 16,
    marginBottom: 8,
  },
  userBubble: {
    alignSelf: "flex-end",
    backgroundColor: "#4285F4",
  },
  assistantBubble: {
    alignSelf: "flex-start",
    backgroundColor: "#e8e8e8",
  },
  messageText: { fontSize: 15, lineHeight: 21 },
  userText: { color: "#fff" },
  assistantText: { color: "#222" },
  typingRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingBottom: 4,
    gap: 6,
  },
  typingText: { fontSize: 13, color: "#999" },
  errorText: { fontSize: 13, color: "#e53e3e" },
  inputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#ddd",
    backgroundColor: "#fff",
  },
  input: {
    flex: 1,
    fontSize: 15,
    color: "#222",
    backgroundColor: "#f2f2f2",
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    maxHeight: 100,
    marginRight: 8,
  },
  sendBtn: {
    backgroundColor: "#4285F4",
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 20,
  },
  sendBtnDisabled: { opacity: 0.4 },
  sendBtnText: { color: "#fff", fontSize: 15, fontWeight: "600" },
});

const mdStyles = {
  body: { fontSize: 15, lineHeight: 21, color: "#222" },
  strong: { fontWeight: "700" as const },
  em: { fontStyle: "italic" as const },
  paragraph: { marginTop: 0, marginBottom: 0 },
  bullet_list: { marginTop: 4, marginBottom: 4 },
  ordered_list: { marginTop: 4, marginBottom: 4 },
  list_item: { marginBottom: 2 },
  code_inline: { backgroundColor: "#d5d5d5", paddingHorizontal: 4, borderRadius: 3, fontSize: 14 },
  fence: { backgroundColor: "#d5d5d5", padding: 8, borderRadius: 6, fontSize: 13 },
};

const mdStylesUser = {
  ...mdStyles,
  body: { ...mdStyles.body, color: "#fff" },
};
