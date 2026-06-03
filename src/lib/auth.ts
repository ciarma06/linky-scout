/**
 * Auth utility — client-side auth state management.
 *
 * - Persists AuthState in localStorage
 * - Calls `request-otp` and `verify-otp` Edge Functions (Linky Assistant)
 * - Exposes local token validation (daysLeft + JWT `exp`)
 *
 * request-otp / verify-otp are public endpoints — no Authorization header needed,
 * only Content-Type: application/json.
 */

export type AuthPlan = "assistant" | "scout" | "bundle";

export interface AuthState {
  jwt: string;
  email: string;
  access: "premium" | "trial";
  expiresAt: string;
  daysLeft: number;
  plan: "assistant" | "scout" | "bundle" | "trial" | null;
  checkedAt?: string;
}

export type VerifyOtpResult = AuthState | { error: string; access?: string };

const STORAGE_KEY = "linkyscout.auth";

const EDGE_FUNCTIONS_BASE_URL =
  process.env.NEXT_PUBLIC_EDGE_FUNCTIONS_BASE_URL ?? "";

function isBrowser(): boolean {
  return typeof window !== "undefined";
}

export function saveAuth(auth: AuthState): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(auth));
  } catch {
    // localStorage unavailable (e.g. private browsing) — ignore.
  }
}

export function getStoredAuth(): AuthState | null {
  if (!isBrowser()) return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AuthState;
    if (
      typeof parsed?.jwt !== "string" ||
      typeof parsed?.email !== "string" ||
      typeof parsed?.access !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearAuth(): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

interface JwtPayload {
  exp?: number;
  [key: string]: unknown;
}

function decodeJwtPayload(jwt: string): JwtPayload | null {
  try {
    const parts = jwt.split(".");
    if (parts.length !== 3) return null;
    const b64url = parts[1];
    const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const decoded =
      typeof atob !== "undefined"
        ? atob(padded)
        : Buffer.from(padded, "base64").toString("utf-8");
    return JSON.parse(decoded) as JwtPayload;
  } catch {
    return null;
  }
}

export function isAuthValid(auth: AuthState | null | undefined): boolean {
  if (!auth) return false;
  if (typeof auth.daysLeft !== "number" || auth.daysLeft <= 0) return false;

  const payload = decodeJwtPayload(auth.jwt);
  if (!payload || typeof payload.exp !== "number") return false;
  return payload.exp * 1000 > Date.now();
}

/**
 * Calls `request-otp` to send the verification code by email.
 */
export async function requestOtp(
  email: string
): Promise<{ ok: boolean; message?: string }> {
  try {
    const res = await fetch(`${EDGE_FUNCTIONS_BASE_URL}/request-otp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });

    if (!res.ok) {
      const data = await safeJson(res);
      return {
        ok: false,
        message:
          (typeof data?.error === "string" && data.error) ||
          (typeof data?.message === "string" && data.message) ||
          `Error ${res.status}`,
      };
    }

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      message:
        err instanceof Error ? err.message : "Network error. Please try again.",
    };
  }
}

/**
 * Calls `verify-otp`. Returns AuthState on success,
 * or `{ error, access? }` on a business-logic error.
 */
export async function verifyOtp(
  email: string,
  code: string
): Promise<VerifyOtpResult> {
  try {
    const res = await fetch(`${EDGE_FUNCTIONS_BASE_URL}/verify-otp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, code }),
    });

    const data = await safeJson(res);

    if (data && typeof data.jwt === "string") {
      const plan =
        data.plan === "assistant" ||
        data.plan === "scout" ||
        data.plan === "bundle" ||
        data.plan === "trial"
          ? data.plan
          : null;

      return {
        jwt: data.jwt,
        email: typeof data.email === "string" ? data.email : email,
        access:
          data.access === "premium" || data.access === "trial"
            ? data.access
            : "premium",
        expiresAt:
          typeof data.expiresAt === "string" ? data.expiresAt : "",
        daysLeft:
          typeof data.daysLeft === "number" ? data.daysLeft : 0,
        plan,
        checkedAt: new Date().toISOString(),
      };
    }

    return {
      error:
        (typeof data?.error === "string" && data.error) ||
        (typeof data?.message === "string" && data.message) ||
        `Error ${res.status}`,
      access: typeof data?.access === "string" ? data.access : undefined,
    };
  } catch (err) {
    return {
      error:
        err instanceof Error ? err.message : "Network error. Please try again.",
    };
  }
}

async function safeJson(
  res: Response
): Promise<Record<string, unknown> | null> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}
