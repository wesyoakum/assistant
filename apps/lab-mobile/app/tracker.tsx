import { View, Pressable, Text } from "react-native";
import { router } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { TrackerTab } from "../src/tracker/TrackerTab";
import { useTheme } from "../src/theme";

export default function TrackerScreen() {
  const theme = useTheme();
  return (
    <View style={{ flex: 1 }}>
      <TrackerTab />
      <SafeAreaView
        pointerEvents="box-none"
        style={{ position: "absolute", top: 0, right: 0 }}
      >
        <Pressable
          onPress={() => router.push("/spectrum")}
          hitSlop={10}
          style={{
            marginTop: 8,
            marginRight: 12,
            paddingHorizontal: 10,
            paddingVertical: 6,
            borderRadius: 14,
            backgroundColor: "rgba(0,0,0,0.55)",
          }}
        >
          <Text style={{ color: theme.text, fontSize: 12, fontWeight: "600" }}>🎤 Spectrum</Text>
        </Pressable>
      </SafeAreaView>
    </View>
  );
}
