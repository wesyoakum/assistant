import { Tabs } from "expo-router";
import { Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import Constants from "expo-constants";
import { useTheme } from "../../src/theme";

// Code-level OTA tag — change this to verify OTA updates land.
const OTA_TAG = "b";

type IconName = React.ComponentProps<typeof Ionicons>["name"];

function tabIcon(name: IconName) {
  return ({ color, size }: { color: string; size: number }) => (
    <Ionicons name={name} size={size} color={color} />
  );
}

export default function TabsLayout() {
  const theme = useTheme();
  const appVersion = Constants.expoConfig?.version ?? "?";
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: theme.primary,
        tabBarInactiveTintColor: theme.scheme === "dark" ? theme.textSubtle : theme.primaryDark,
        tabBarStyle: { backgroundColor: theme.tabBarBg, borderTopColor: theme.tabBarBorder },
        headerStyle: { backgroundColor: theme.headerBg },
        headerTintColor: theme.headerText,
        headerTitleStyle: { color: theme.headerText, fontWeight: "600" },
        sceneStyle: { backgroundColor: theme.background },
        headerShown: true,
      }}
    >
      <Tabs.Screen
        name="tracker"
        options={{
          title: "Tracker",
          tabBarIcon: tabIcon("locate-outline"),
        }}
      />
      <Tabs.Screen
        name="ar"
        options={{
          title: "Plate",
          headerShown: false,
          tabBarIcon: tabIcon("scan-outline"),
          href: null,
        }}
      />
      <Tabs.Screen
        name="field"
        options={{
          title: "Field",
          tabBarIcon: tabIcon("grid-outline"),
          href: null,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "Settings",
          tabBarIcon: tabIcon("settings-outline"),
        }}
      />
    </Tabs>
    <View pointerEvents="none" style={{ position: "absolute", bottom: 2, left: 0, right: 0, alignItems: "center" }}>
      <Text style={{ color: theme.textSubtle, fontSize: 9, opacity: 0.5 }}>v{appVersion}{OTA_TAG}</Text>
    </View>
  );
}
