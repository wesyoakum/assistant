import { Stack } from "expo-router";
import { View } from "react-native";
import { SpectrumView } from "../src/audio/SpectrumView";
import { useTheme } from "../src/theme";

export default function SpectrumScreen() {
  const theme = useTheme();
  return (
    <View style={{ flex: 1, backgroundColor: theme.background }}>
      <Stack.Screen options={{ title: "Audio spectrum", headerShown: true }} />
      <SpectrumView />
    </View>
  );
}
