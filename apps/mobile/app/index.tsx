import { View, ActivityIndicator } from "react-native";

// Root route — AuthGate in _layout.tsx immediately redirects
// to /sign-in or /(tabs)/triage based on auth state.
export default function Index() {
  return (
    <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
      <ActivityIndicator size="large" />
    </View>
  );
}
