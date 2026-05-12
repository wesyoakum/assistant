import { useState, useRef, useCallback } from "react";
import {
  View,
  Text,
  TextInput,
  FlatList,
  Pressable,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  ActivityIndicator,
} from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useMutation } from "@tanstack/react-query";
import { apiFetch } from "../../src/api/client";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
}

interface ChatResponse {
  reply: string;
}

export default function ChatScreen() {
  const params = useLocalSearchParams<{ triageId?: string; context?: string }>();
  const [messages, setMessages] = useState<Message[]>(() => {
    if (params.context) {
      return [
        {
          id: "system-0",
          role: "assistant",
          content: `Let's discuss: ${params.context}`,
          timestamp: new Date(),
        },
      ];
    }
    return [];
  });
  const [input, setInput] = useState("");
  const flatListRef = useRef<FlatList>(null);

  const sendMutation = useMutation({
    mutationFn: async (text: string) => {
      const body: Record<string, string> = { message: text };
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
          timestamp: new Date(),
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
        timestamp: new Date(),
      },
    ]);
    setInput("");
    sendMutation.mutate(text);
  }, [input, sendMutation]);

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      keyboardVerticalOffset={90}
    >
      <FlatList
        ref={flatListRef}
        data={messages}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.messageList}
        onContentSizeChange={() =>
          flatListRef.current?.scrollToEnd({ animated: true })
        }
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyTitle}>Assistant</Text>
            <Text style={styles.emptyText}>
              Ask questions, provide feedback, or discuss triage items.
            </Text>
          </View>
        }
        renderItem={({ item }) => (
          <View
            style={[
              styles.messageBubble,
              item.role === "user" ? styles.userBubble : styles.assistantBubble,
            ]}
          >
            <Text
              style={[
                styles.messageText,
                item.role === "user"
                  ? styles.userText
                  : styles.assistantText,
              ]}
            >
              {item.content}
            </Text>
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
          onSubmitEditing={handleSend}
          returnKeyType="send"
          blurOnSubmit={false}
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
