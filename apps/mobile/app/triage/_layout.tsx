import { Stack } from "expo-router";

export default function TriageLayout() {
  return (
    <Stack
      screenOptions={{
        headerBackTitle: "Back",
        headerTintColor: "#4285F4",
      }}
    >
      <Stack.Screen
        name="[id]"
        options={{ title: "Triage Detail" }}
      />
    </Stack>
  );
}
