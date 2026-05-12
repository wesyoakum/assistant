import { Redirect } from "expo-router";
import { useAuth } from "../src/state/auth";

export default function Index() {
  const { isAuthenticated, isLoading } = useAuth();
  if (isLoading) return null;
  return <Redirect href={isAuthenticated ? "/(tabs)/triage" : "/sign-in"} />;
}
