import { useEffect, useRef } from "react";
import { Platform, Linking } from "react-native";
import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import Constants from "expo-constants";
import { useRouter } from "expo-router";
import { apiFetch } from "../api/client";
import { useAuth } from "../state/auth";

// Show notifications even when app is foregrounded
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

// Shared action buttons for most categories
const BASE_ACTIONS: Notifications.NotificationAction[] = [
  {
    identifier: "dismiss",
    buttonTitle: "Dismiss",
    options: { isDestructive: true, opensAppToForeground: false },
  },
  {
    identifier: "open",
    buttonTitle: "Open",
    options: { opensAppToForeground: true },
  },
  {
    identifier: "snooze",
    buttonTitle: "Snooze 15 min",
    options: { opensAppToForeground: false },
  },
];

// Register notification categories with action buttons
async function registerCategories() {
  // General triage (calendar events, files, chat-created items)
  await Notifications.setNotificationCategoryAsync("triage", BASE_ACTIONS);

  // Email triage — adds Open Original and Reply
  await Notifications.setNotificationCategoryAsync("triage-email", [
    ...BASE_ACTIONS,
    {
      identifier: "open-original",
      buttonTitle: "Open in Gmail",
      options: { opensAppToForeground: false },
    },
    {
      identifier: "reply",
      buttonTitle: "Reply in Gmail",
      options: { opensAppToForeground: false },
    },
  ]);

  // Reminders
  await Notifications.setNotificationCategoryAsync("reminder", BASE_ACTIONS);

  // Morning briefing
  await Notifications.setNotificationCategoryAsync("briefing", [
    {
      identifier: "open",
      buttonTitle: "Open",
      options: { opensAppToForeground: true },
    },
  ]);

  // Event heads-up — adds Open in Calendar
  await Notifications.setNotificationCategoryAsync("event-headsup", [
    ...BASE_ACTIONS,
    {
      identifier: "open-original",
      buttonTitle: "Open in Calendar",
      options: { opensAppToForeground: false },
    },
  ]);
}

export function useNotifications() {
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const didRegister = useRef(false);

  // Reset registration flag on sign-out so re-login re-registers
  useEffect(() => {
    if (!isAuthenticated) {
      didRegister.current = false;
    }
  }, [isAuthenticated]);

  // Register categories and push token on mount when authenticated
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

  // Handle notification taps and action button presses
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener(
      (response) => {
        handleNotificationResponse(response, router);
      }
    );
    return () => sub.remove();
  }, [router]);

  // Handle cold-start: app launched by tapping a notification
  useEffect(() => {
    Notifications.getLastNotificationResponseAsync().then((response) => {
      if (response) handleNotificationResponse(response, router);
    });
  }, [router]);
}

function handleNotificationResponse(
  response: Notifications.NotificationResponse,
  router: ReturnType<typeof useRouter>
) {
  const actionId = response.actionIdentifier;
  const data = response.notification.request.content.data;
  const url = data?.url as string | undefined;
  const sourceUrl = data?.sourceUrl as string | undefined;
  const triageItemId = url?.startsWith("whyapp://triage/")
    ? url.replace("whyapp://triage/", "")
    : null;

  // Dismiss — mark triage item as dismissed
  if (actionId === "dismiss" && triageItemId) {
    apiFetch(`/triage/${triageItemId}/status`, {
      method: "POST",
      body: JSON.stringify({ status: "dismissed" }),
    }).catch(() => {});
    return;
  }

  // Snooze — create a reminder 15 min from now
  if (actionId === "snooze") {
    const message =
      response.notification.request.content.body ?? "Snoozed item";
    apiFetch("/push/snooze", {
      method: "POST",
      body: JSON.stringify({
        triageItemId: triageItemId ?? undefined,
        message,
      }),
    }).catch(() => {});
    return;
  }

  // Open Original — open source URL (Gmail, Calendar, etc.) in browser
  if (actionId === "open-original" && sourceUrl) {
    Linking.openURL(sourceUrl);
    return;
  }

  // Reply — open Gmail thread (reply is done in Gmail itself)
  if (actionId === "reply" && sourceUrl) {
    Linking.openURL(sourceUrl);
    return;
  }

  // Default tap or "open" action — navigate to the triage item
  if (triageItemId) {
    router.push(`/triage/${triageItemId}`);
  }
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
