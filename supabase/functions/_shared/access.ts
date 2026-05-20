// _shared/access.ts
//
// Shared access-control helper for all Linky Edge Functions
// (used by both Linky Assistant and Linky Scout).
//
// resolveAccess(email, supabaseUrl, serviceKey, requiredProduct?)
//   • returns the user's current entitlement state
//   • optionally checks that the user's plan grants a specific product
//
// Plan → Product mapping:
//   assistant → ['assistant']
//   scout     → ['scout']
//   bundle    → ['assistant', 'scout']
//
// The function is intentionally REST-based (no @supabase/supabase-js import)
// so it stays drop-in safe inside any Edge Function and uses the
// SERVICE_ROLE_KEY both as `apikey` header AND as Bearer token.

export type Plan = "assistant" | "scout" | "bundle";
export type Product = "assistant" | "scout";

export type AccessResult =
  | { access: "premium"; plan: Plan; expiresAt: string; daysLeft: number }
  | {
      access: "waitlist_trial";
      expiresAt: string;
      daysLeft: number;
      plan?: undefined;
    }
  | { access: "expired_premium"; plan?: undefined }
  | { access: "expired_waitlist"; plan?: undefined }
  | { access: "unauthorized"; plan?: undefined };

const TRIAL_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

const PLAN_GRANTS: Record<Plan, Product[]> = {
  assistant: ["assistant"],
  scout: ["scout"],
  bundle: ["assistant", "scout"],
};

interface SubscriptionRow {
  email: string;
  plan?: string | null;
  status?: string | null;
  current_period_end?: string | null;
}

interface WaitlistRow {
  email: string;
  created_at?: string | null;
}

function daysLeftBetween(future: number, now: number): number {
  return Math.max(0, Math.ceil((future - now) / DAY_MS));
}

async function restGet<T>(
  supabaseUrl: string,
  serviceKey: string,
  path: string,
): Promise<T[]> {
  const url = `${supabaseUrl}/rest/v1/${path}`;
  try {
    const res = await fetch(url, {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(
        `[access.ts] REST GET ${path} failed (${res.status}): ${text}`,
      );
      return [];
    }
    return (await res.json()) as T[];
  } catch (err) {
    console.error(`[access.ts] REST GET ${path} threw:`, err);
    return [];
  }
}

function isPlan(value: string | null | undefined): value is Plan {
  return value === "assistant" || value === "scout" || value === "bundle";
}

export async function resolveAccess(
  email: string,
  supabaseUrl: string,
  serviceKey: string,
  requiredProduct?: Product,
): Promise<AccessResult> {
  if (!email || !supabaseUrl || !serviceKey) {
    return { access: "unauthorized" };
  }

  const normalized = email.trim().toLowerCase();
  if (!normalized) return { access: "unauthorized" };

  const encoded = encodeURIComponent(normalized);
  const now = Date.now();

  // ── 1. user_subscriptions ──────────────────────────────────────────────
  const subRows = await restGet<SubscriptionRow>(
    supabaseUrl,
    serviceKey,
    `user_subscriptions?email=eq.${encoded}&select=email,plan,status,current_period_end&limit=1`,
  );

  if (subRows.length > 0) {
    const sub = subRows[0];
    const expiresAtMs = sub.current_period_end
      ? Date.parse(sub.current_period_end)
      : NaN;
    const isActive =
      sub.status === "active" &&
      Number.isFinite(expiresAtMs) &&
      expiresAtMs > now;

    if (isActive) {
      const planRaw = (sub.plan ?? "").toLowerCase();
      if (!isPlan(planRaw)) {
        console.error(
          `[access.ts] subscription for ${normalized} has invalid plan="${sub.plan}"`,
        );
        return { access: "unauthorized" };
      }

      if (requiredProduct && !PLAN_GRANTS[planRaw].includes(requiredProduct)) {
        return { access: "unauthorized" };
      }

      return {
        access: "premium",
        plan: planRaw,
        expiresAt: new Date(expiresAtMs).toISOString(),
        daysLeft: daysLeftBetween(expiresAtMs, now),
      };
    }

    // Found but not active / expired → expired_premium
    return { access: "expired_premium" };
  }

  // ── 2. utenti_waitlist (legacy trial fallback) ─────────────────────────
  const wlRows = await restGet<WaitlistRow>(
    supabaseUrl,
    serviceKey,
    `utenti_waitlist?email=eq.${encoded}&select=email,created_at&limit=1`,
  );

  if (wlRows.length > 0) {
    const wl = wlRows[0];
    const createdMs = wl.created_at ? Date.parse(wl.created_at) : NaN;
    if (!Number.isFinite(createdMs)) {
      return { access: "expired_waitlist" };
    }

    const expiresMs = createdMs + TRIAL_DAYS * DAY_MS;
    if (expiresMs > now) {
      return {
        access: "waitlist_trial",
        expiresAt: new Date(expiresMs).toISOString(),
        daysLeft: daysLeftBetween(expiresMs, now),
      };
    }
    return { access: "expired_waitlist" };
  }

  return { access: "unauthorized" };
}

/**
 * Convenience helper: returns true if the access result grants the user
 * the ability to run Scout searches (`premium` with a scout-granting plan
 * OR waitlist_trial). Returns false otherwise.
 */
export function canUseScout(result: AccessResult): boolean {
  if (result.access === "waitlist_trial") return true;
  if (result.access === "premium") {
    return PLAN_GRANTS[result.plan].includes("scout");
  }
  return false;
}
