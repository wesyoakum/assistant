import { Stack } from "expo-router";

export default function TriageLayout() {
  return (
    <Stack
      screenOptions={{
        headerBackTitle: "Back",
        headerTintColor: "#3D7F94",
      }}
    >
      <Stack.Screen
        name="[id]"
        options={{ title: "Triage Detail v7" }}
      />
    </Stack>
  );
}
