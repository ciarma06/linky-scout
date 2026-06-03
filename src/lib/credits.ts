// credits.ts — shared client-side helpers + types for the credits system.

import { EDGE_FUNCTIONS_BASE_URL } from "./supabase";

export const SEARCH_COST = 100;

export const GET_MORE_CREDITS_URL = "https://linkyassistant.com/#pricing";
export const CREATE_CHECKOUT_URL =
  "https://www.linkyassistant.com/api/create-checkout";

export interface CreditPack {
  id: string;
  name: string;
  /** Number of credits the user receives. */
  credits: number;
  /** Stripe Price ID. */
  priceId: string;
  /** Display price (purely cosmetic; the real price lives in Stripe). */
  priceLabel: string;
  /** One-line marketing tagline. */
  tagline: string;
  /** Whether this pack is the recommended option (highlighted). */
  recommended?: boolean;
}

export const CREDIT_PACKS: CreditPack[] = [
  {
    id: "trial",
    name: "Trial",
    credits: 100,
    priceId: "price_1TYYa7AqaCXpBWed0KrcuLX7",
    priceLabel: "$4.99",
    tagline: "1 extra search to try things out.",
  },
  {
    id: "growth",
    name: "Growth",
    credits: 500,
    priceId: "price_1TYYe5AqaCXpBWedvIgOpNMS",
    priceLabel: "$16.99",
    tagline: "5 searches — best for steady prospecting.",
    recommended: true,
  },
  {
    id: "scale",
    name: "Scale",
    credits: 1000,
    priceId: "price_1TYYfNAqaCXpBWedb5120RQs",
    priceLabel: "$29.99",
    tagline: "10 searches — for high-volume outbound.",
  },
];

export function formatCredits(value: number): string {
  return Math.max(0, Math.round(value)).toLocaleString("en-US");
}

export interface CreditsResponse {
  subscription_credits: number;
  pack_credits: number;
  credits_period_end: string | null;
  messages_used: number;
  messages_limit: number;
  plan: "trial" | "assistant" | "scout" | "bundle" | null;
  access: string;
}

/**
 * Total spendable credits = subscription + pack.
 */
export function totalCredits(c: CreditsResponse | null | undefined): number {
  if (!c) return 0;
  return (c.subscription_credits ?? 0) + (c.pack_credits ?? 0);
}

/**
 * Fetch the current user's credit balance via the `get-credits` Edge Function.
 */
export async function fetchCredits(jwt: string): Promise<CreditsResponse> {
  const res = await fetch(`${EDGE_FUNCTIONS_BASE_URL}/get-credits`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
    },
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(
      (typeof data?.error === "string" && data.error) ||
        `Failed to load credits (${res.status})`,
    );
  }

  return (await res.json()) as CreditsResponse;
}

/**
 * Kick the user into Stripe Checkout via the Linky Assistant landing.
 * On success the page redirects to Stripe; on failure the promise rejects.
 */
export async function startCheckout(
  priceId: string,
  email: string,
): Promise<void> {
  const res = await fetch(CREATE_CHECKOUT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ priceId, email }),
  });

  const data = (await res.json().catch(() => ({}))) as {
    url?: string;
    error?: string;
  };

  if (!res.ok || data.error || !data.url) {
    throw new Error(data.error ?? `Checkout failed (${res.status})`);
  }

  window.location.href = data.url;
}
