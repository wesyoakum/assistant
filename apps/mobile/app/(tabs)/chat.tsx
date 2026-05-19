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
  ActionSheetIOS,
  Alert,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import { useMutation } from "@tanstack/react-query";
import Markdown from "react-native-markdown-display";
import { apiFetch } from "../../src/api/client";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
}

interface ChatResponse {
  reply: string;
}

interface HistoryResponse {
  messages: { id: string; role: "user" | "assistant"; content: string }[];
}

export default function ChatScreen() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const flatListRef = useRef<FlatList>(null);
  const didInit = useRef(false);

  // Load history on mount
  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;

    (async () => {
      try {
        const history = await apiFetch<HistoryResponse>("/chat/history?limit=50");
        if (history.messages.length > 0) {
          setMessages(history.messages);
          return;
        }
      } catch {
        // Continue
      }

      // Static greeting for empty chat
      setMessages([{
        id: "greeting-0",
        role: "assistant",
        content: "How can I help?",
      }]);
    })();
  }, []);

  const sendMutation = useMutation({
    mutationFn: async (text: string) => {
      return apiFetch<ChatResponse>("/chat", {
        method: "POST",
        body: JSON.stringify({ message: text }),
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

  const handleLongPress = useCallback((content: string) => {
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: ["Copy", "Cancel"], cancelButtonIndex: 1 },
        (idx) => {
          if (idx === 0) Clipboard.setStringAsync(content);
        }
      );
    } else {
      Clipboard.setStringAsync(content);
      Alert.alert("Copied to clipboard");
    }
  }, []);

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
            <Pressable
              onLongPress={() => handleLongPress(item.content)}
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
                <Markdown style={mdStyles}>
                  {item.content}
                </Markdown>
              )}
            </Pressable>
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
          placeholder="Message..."
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
