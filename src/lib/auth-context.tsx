"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import {
  AuthState,
  clearAuth,
  getStoredAuth,
  isAuthValid,
  saveAuth,
} from "./auth";

interface AuthContextType {
  user: AuthState | null;
  isLoading: boolean;
  login: (auth: AuthState) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthState | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // Synchronous localStorage read after mount to populate initial state.
    // setState inside an effect is the correct pattern here because we are
    // syncing from an external source (browser storage) — one of the few
    // legitimate exceptions to the React 19 lint rule.
    const stored = getStoredAuth();
    const valid = stored ? isAuthValid(stored) : false;
    if (stored && !valid) clearAuth();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setUser(valid ? stored : null);
    setIsLoading(false);
  }, []);

  const login = useCallback((auth: AuthState) => {
    saveAuth(auth);
    setUser(auth);
  }, []);

  const logout = useCallback(() => {
    clearAuth();
    setUser(null);
  }, []);

  const value = useMemo<AuthContextType>(
    () => ({ user, isLoading, login, logout }),
    [user, isLoading, login, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used inside <AuthProvider>");
  }
  return ctx;
}
