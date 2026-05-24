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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Markdown from "react-native-markdown-display";
import { apiFetch } from "../../src/api/client";
import { useTheme, type Theme } from "../../src/theme";
import { useStyles } from "../../src/hooks/useStyles";

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
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const flatListRef = useRef<FlatList>(null);
  const didInitialScroll = useRef(false);
  const theme = useTheme();
  const styles = useStyles(makeStyles);
  const mdStyles = useStyles(makeMdStyles);

  // Server-backed history. Refetches when the briefing endpoint inserts
  // a new assistant message (cache invalidated from useOnOpenSync).
  const { data: history } = useQuery({
    queryKey: ["chat-history"],
    queryFn: () => apiFetch<HistoryResponse>("/chat/history?limit=50"),
    staleTime: 0,
  });

  const serverMessages: Message[] = history?.messages ?? [];
  const messages: Message[] =
    serverMessages.length > 0
      ? [...serverMessages, ...pending]
      : pending.length > 0
        ? pending
        : [{ id: "greeting-0", role: "assistant", content: "How can I help?" }];

  const sendMutation = useMutation({
    mutationFn: async (text: string) => {
      return apiFetch<ChatResponse>("/chat", {
        method: "POST",
        body: JSON.stringify({ message: text }),
      });
    },
    onSuccess: async () => {
      // Server persisted both the user message and the assistant reply.
      // Refetch history, then clear local pending state.
      await queryClient.invalidateQueries({ queryKey: ["chat-history"] });
      setPending([]);
    },
    onError: (err: Error) => {
      setPending((prev) => [
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

    setPending((prev) => [
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

  // Scroll to the last message when the keyboard opens — otherwise it covers
  // the bottom of the conversation.
  useEffect(() => {
    const sub = Keyboard.addListener("keyboardDidShow", () => {
      requestAnimationFrame(() =>
        flatListRef.current?.scrollToEnd({ animated: true })
      );
    });
    return () => sub.remove();
  }, []);

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
          onContentSizeChange={() => {
            // First time content lays out (chat opening): jump instantly so
            // we appear at the bottom. After that, animate so new messages
            // scroll in smoothly.
            const animated = didInitialScroll.current;
            didInitialScroll.current = true;
            flatListRef.current?.scrollToEnd({ animated });
          }}
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
          placeholderTextColor={theme.textSubtle}
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

function makeStyles(theme: Theme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.background },
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
      backgroundColor: theme.primary,
    },
    assistantBubble: {
      alignSelf: "flex-start",
      backgroundColor: theme.surfaceAlt,
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
    typingText: { fontSize: 13, color: theme.textSubtle },
    inputRow: {
      flexDirection: "row",
      alignItems: "flex-end",
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.border,
      backgroundColor: theme.surface,
    },
    input: {
      flex: 1,
      fontSize: 15,
      color: theme.text,
      backgroundColor: theme.surfaceAlt,
      borderRadius: 20,
      paddingHorizontal: 16,
      paddingVertical: 10,
      maxHeight: 100,
      marginRight: 8,
    },
    sendBtn: {
      backgroundColor: theme.primary,
      paddingHorizontal: 18,
      paddingVertical: 10,
      borderRadius: 20,
    },
    sendBtnDisabled: { opacity: 0.4 },
    sendBtnText: { color: "#fff", fontSize: 15, fontWeight: "600" },
  });
}

function makeMdStyles(theme: Theme) {
  return {
    body: { fontSize: 15, lineHeight: 21, color: theme.text },
    strong: { fontWeight: "700" as const },
    em: { fontStyle: "italic" as const },
    paragraph: { marginTop: 0, marginBottom: 0 },
    bullet_list: { marginTop: 4, marginBottom: 4 },
    ordered_list: { marginTop: 4, marginBottom: 4 },
    list_item: { marginBottom: 2 },
    code_inline: { backgroundColor: theme.border, paddingHorizontal: 4, borderRadius: 3, fontSize: 14 },
    fence: { backgroundColor: theme.border, padding: 8, borderRadius: 6, fontSize: 13 },
  };
}
