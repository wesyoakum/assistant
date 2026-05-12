import * as SecureStore from "expo-secure-store";
import { create } from "zustand";

const TOKEN_KEY = "session_jwt";

interface AuthState {
  token: string | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  loadToken: () => Promise<void>;
  setToken: (token: string) => Promise<void>;
  clearToken: () => Promise<void>;
}

export const useAuth = create<AuthState>((set) => ({
  token: null,
  isLoading: false,
  isAuthenticated: false,

  loadToken: async () => {
    try {
      const token = await SecureStore.getItemAsync(TOKEN_KEY);
      set({ token, isAuthenticated: !!token, isLoading: false });
    } catch {
      set({ token: null, isAuthenticated: false, isLoading: false });
    }
  },

  setToken: async (token: string) => {
    await SecureStore.setItemAsync(TOKEN_KEY, token);
    set({ token, isAuthenticated: true });
  },

  clearToken: async () => {
    await SecureStore.deleteItemAsync(TOKEN_KEY);
    set({ token: null, isAuthenticated: false });
  },
}));
