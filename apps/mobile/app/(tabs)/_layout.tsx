import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "../../src/theme";

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
        name="chat"
        options={{
          title: "Chat",
          tabBarIcon: tabIcon("chatbubble-ellipses-outline"),
        }}
      />
      <Tabs.Screen
        name="triage"
        options={{ href: null }}
      />
      <Tabs.Screen
        name="email"
        options={{
          title: "Email",
          tabBarIcon: tabIcon("mail-outline"),
        }}
      />
      <Tabs.Screen
        name="calendar"
        options={{
          title: "Calendar",
          tabBarIcon: tabIcon("calendar-outline"),
        }}
      />
      <Tabs.Screen
        name="capture"
        options={{
          title: "Capture",
          tabBarIcon: tabIcon("camera-outline"),
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
  );
}
