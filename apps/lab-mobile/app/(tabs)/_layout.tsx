import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "../../src/theme";

// OTA tag — bump this letter with each OTA push to verify updates land.
export const OTA_TAG = "b";

export default function TabsLayout() {
  const theme = useTheme();
  return (
    <Tabs
      screenOptions={{
        tabBarStyle: { display: "none" },
        headerStyle: { backgroundColor: theme.headerBg },
        headerTintColor: theme.headerText,
        headerTitleStyle: { color: theme.headerText, fontWeight: "600" },
        sceneStyle: { backgroundColor: theme.background },
        headerShown: false,
      }}
    >
      <Tabs.Screen name="tracker" />
      <Tabs.Screen name="ar" options={{ href: null }} />
      <Tabs.Screen name="field" options={{ href: null }} />
      <Tabs.Screen name="settings" options={{ href: null }} />
    </Tabs>
  );
}
