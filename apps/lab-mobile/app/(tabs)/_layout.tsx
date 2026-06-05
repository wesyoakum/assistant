import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "../../src/theme";

// OTA tag — bump this letter with each OTA push to verify updates land.
export const OTA_TAG = "b";

type IconName = React.ComponentProps<typeof Ionicons>["name"];

function tabIcon(name: IconName) {
  return ({ color, size }: { color: string; size: number }) => (
    <Ionicons name={name} size={size} color={color} />
  );
}

export default function TabsLayout() {
  const theme = useTheme();
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
          title: `Tracker`,
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
          title: `Settings · ${OTA_TAG}`,
          tabBarIcon: tabIcon("settings-outline"),
        }}
      />
    </Tabs>
  );
}
