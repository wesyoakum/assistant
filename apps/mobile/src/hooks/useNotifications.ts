import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import Constants from "expo-constants";
import { useRouter } from "expo-router";
import { apiFetch } from "../api/client";
import { useAuth } from "../state/auth";

// Show notifications even when app is foregrounded
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

export function useNotifications() {
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const didRegister = useRef(false);

  // Register for push on mount when authenticated
  useEffect(() => {
    if (!isAuthenticated || didRegister.current) return;
    didRegister.current = true;

    registerForPush().then((token) => {
      if (token) {
        apiFetch("/push/register", {
          method: "POST",
          body: JSON.stringify({
            token,
            platform: Platform.OS,
          }),
        }).catch(() => {
          // Fail silently — will retry next launch
        });
      }
    });
  }, [isAuthenticated]);

  // Handle notification taps — deep link to triage item
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener(
      (response) => {
        const url = response.notification.request.content.data?.url;
        if (typeof url === "string" && url.startsWith("whyapp://triage/")) {
          const id = url.replace("whyapp://triage/", "");
          router.push(`/triage/${id}`);
        }
      }
    );
    return () => sub.remove();
  }, [router]);
}

async function registerForPush(): Promise<string | null> {
  if (!Device.isDevice) {
    // Push tokens don't work on simulators, but Expo Go on a real device is fine
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
