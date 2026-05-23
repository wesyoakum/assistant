import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import Constants from "expo-constants";
import { useRouter } from "expo-router";
import { apiFetch } from "../api/client";
import { useAuth } from "../state/auth";

// Show notifications even when app is foregrounded.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

// Only the reminder category is in use now.
async function registerCategories() {
  await Notifications.setNotificationCategoryAsync("reminder", [
    {
      identifier: "open",
      buttonTitle: "Open",
      options: { opensAppToForeground: true },
    },
  ]);
}

export function useNotifications() {
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const didRegister = useRef(false);

  // Reset registration flag on sign-out so re-login re-registers.
  useEffect(() => {
    if (!isAuthenticated) {
      didRegister.current = false;
    }
  }, [isAuthenticated]);

  useEffect(() => {
    if (!isAuthenticated) return;

    registerCategories();

    if (didRegister.current) return;

    (async () => {
      try {
        const token = await registerForPush();
        if (!token) return;
        await apiFetch("/push/register", {
          method: "POST",
          body: JSON.stringify({ token, platform: Platform.OS }),
        });
        didRegister.current = true;
      } catch (err) {
        console.warn("[push] Registration failed, will retry next launch:", err);
      }
    })();
  }, [isAuthenticated]);

  // Default tap on a reminder routes to chat (where reminders are created).
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener(() => {
      router.push("/(tabs)/chat");
    });
    return () => sub.remove();
  }, [router]);

  useEffect(() => {
    Notifications.getLastNotificationResponseAsync().then((response) => {
      if (response) router.push("/(tabs)/chat");
    });
  }, [router]);
}

async function registerForPush(): Promise<string | null> {
  if (!Device.isDevice) {
    console.log("[push] Not a physical device, skipping");
    return null;
  }

  const { status: existing } = await Notifications.getPermissionsAsync();
  let finalStatus = existing;

  if (existing !== "granted") {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (finalStatus !== "granted") {
    console.log("[push] Permission not granted");
    return null;
  }

  const projectId = Constants.expoConfig?.extra?.eas?.projectId;
  if (!projectId) {
    console.warn("[push] No EAS projectId found");
    return null;
  }

  const { data: token } = await Notifications.getExpoPushTokenAsync({
    projectId,
  });

  console.log("[push] Registered token:", token);
  return token;
}
