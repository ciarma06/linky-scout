// get-credits/index.ts
//
// Returns the authenticated user's current credit balance plus their plan,
// pulled from `user_credits` and `user_subscriptions`. Used by the sidebar
// and the settings page in Linky Scout (and reusable from Linky Assistant).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { resolveAccess } from "../_shared/access.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const JWT_SECRET = Deno.env.get("AUTH_JWT_SECRET")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

async function verifyJwt(token: string): Promise<{ email: string } | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(atob(parts[1]));
    if (!payload.email || !payload.exp) return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;

    const encoder = new TextEncoder();
    const keyData = encoder.encode(JWT_SECRET);
    const key = await crypto.subtle.importKey(
      "raw",
      keyData,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const data = encoder.encode(`${parts[0]}.${parts[1]}`);
    const sig = Uint8Array.from(
      atob(parts[2].replace(/-/g, "+").replace(/_/g, "/")),
      (c) => c.charCodeAt(0),
    );
    const valid = await crypto.subtle.verify("HMAC", key, sig, data);
    if (!valid) return null;

    return { email: payload.email };
  } catch {
    return null;
  }
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const authHeader = req.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const auth = await verifyJwt(token);

  if (!auth) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  try {
    const email = auth.email.trim().toLowerCase();

    const { data: creditsRow, error: creditsError } = await supabase
      .from("user_credits")
      .select(
        "subscription_credits, pack_credits, credits_period_end, messages_used, messages_limit",
      )
      .eq("email", email)
      .maybeSingle();

    if (creditsError) {
      console.error("[get-credits] user_credits lookup error:", creditsError);
    }

    const { data: subscription, error: subscriptionError } = await supabase
      .from("user_subscriptions")
      .select("plan")
      .eq("email", email)
      .maybeSingle();

    if (subscriptionError) {
      console.error(
        "[get-credits] user_subscriptions lookup error:",
        subscriptionError,
      );
    }

    const access = await resolveAccess(email, SUPABASE_URL, SERVICE_KEY);
    const plan = subscription?.plan ?? null;

    return jsonResponse({
      subscription_credits:
        typeof creditsRow?.subscription_credits === "number"
          ? creditsRow.subscription_credits
          : 0,
      pack_credits:
        typeof creditsRow?.pack_credits === "number"
          ? creditsRow.pack_credits
          : 0,
      credits_period_end: creditsRow?.credits_period_end ?? null,
      messages_used:
        typeof creditsRow?.messages_used === "number"
          ? creditsRow.messages_used
          : 0,
      messages_limit:
        typeof creditsRow?.messages_limit === "number"
          ? creditsRow.messages_limit
          : 0,
      plan,
      access: access.access,
    });
  } catch (err) {
    console.error("[get-credits] unexpected error:", err);
    const message =
      err instanceof Error ? err.message : "Internal server error";
    return jsonResponse({ error: message }, 500);
  }
});
