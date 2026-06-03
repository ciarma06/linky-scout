"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { useAuth } from "./auth-context";
import { CreditsResponse, fetchCredits } from "./credits";

interface CreditsContextType {
  credits: CreditsResponse | null;
  plan: CreditsResponse["plan"];
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

const CreditsContext = createContext<CreditsContextType | undefined>(undefined);

export function CreditsProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [credits, setCredits] = useState<CreditsResponse | null>(null);
  // Start as true so the UI shows "—" instead of "0" before the first fetch.
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!user?.jwt) {
      setCredits(null);
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const data = await fetchCredits(user.jwt);
      setCredits(data);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Could not load credits.";
      setError(message);
      console.error("[CreditsProvider] refresh failed:", err);
    } finally {
      setIsLoading(false);
    }
  }, [user?.jwt]);

  // Initial load + reload whenever the JWT changes.
  // setState inside an effect is the correct pattern here because we are
  // syncing from an external source (Edge Function).
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!user?.jwt) {
      setCredits(null);
      return;
    }
    void refresh();
  }, [user?.jwt, refresh]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const value = useMemo<CreditsContextType>(
    () => ({
      credits,
      plan: credits?.plan ?? null,
      isLoading,
      error,
      refresh,
    }),
    [credits, isLoading, error, refresh],
  );

  return (
    <CreditsContext.Provider value={value}>{children}</CreditsContext.Provider>
  );
}

export function useCredits(): CreditsContextType {
  const ctx = useContext(CreditsContext);
  if (!ctx) {
    throw new Error("useCredits must be used inside <CreditsProvider>");
  }
  return ctx;
}
