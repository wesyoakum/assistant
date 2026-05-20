import { Text } from "react-native";
import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

type IconName = React.ComponentProps<typeof Ionicons>["name"];

function tabIcon(name: IconName) {
  return ({ color, size }: { color: string; size: number }) => (
    <Ionicons name={name} size={size} color={color} />
  );
}

const APP_VERSION = "v12";

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: "#4285F4",
        headerShown: true,
        headerRight: () => (
          <Text style={{ fontSize: 10, color: "#ccc", marginRight: 12 }}>{APP_VERSION}</Text>
        ),
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
