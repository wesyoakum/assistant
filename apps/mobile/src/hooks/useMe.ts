import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../api/client";
import { useAuth } from "../state/auth";

export interface Me {
  id: string;
  email: string;
  name: string;
  picture_url: string;
  created_at: string;
  isOwner: boolean;
}

export function useMe() {
  const { isAuthenticated } = useAuth();
  return useQuery({
    queryKey: ["me"],
    queryFn: () => apiFetch<Me>("/me"),
    enabled: isAuthenticated,
    staleTime: 5 * 60_000,
  });
}
