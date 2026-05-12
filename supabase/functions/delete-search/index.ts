import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const JWT_SECRET = Deno.env.get("AUTH_JWT_SECRET")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
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
      "raw", keyData,
      { name: "HMAC", hash: "SHA-256" },
      false, ["verify"]
    );
    const data = encoder.encode(`${parts[0]}.${parts[1]}`);
    const sig = Uint8Array.from(atob(parts[2].replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
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

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const authHeader = req.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const payload = await verifyJwt(token);

  if (!payload) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  let body: { searchId?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const searchId = body.searchId?.trim();
  if (!searchId) {
    return jsonResponse({ error: "Missing searchId" }, 400);
  }

  try {
    // Ensure the search belongs to the authenticated user before deleting.
    const { data: search, error: fetchError } = await supabase
      .from("searches")
      .select("id, user_id")
      .eq("id", searchId)
      .maybeSingle();

    if (fetchError) throw fetchError;
    if (!search) {
      return jsonResponse({ error: "Search not found" }, 404);
    }
    if (search.user_id !== payload.email) {
      return jsonResponse({ error: "Forbidden" }, 403);
    }

    // Delete children first in case ON DELETE CASCADE is not configured.
    const { error: resultsError } = await supabase
      .from("search_results")
      .delete()
      .eq("search_id", searchId);
    if (resultsError) throw resultsError;

    const { error: jobsError } = await supabase
      .from("search_jobs")
      .delete()
      .eq("search_id", searchId);
    if (jobsError) throw jobsError;

    const { error: searchError } = await supabase
      .from("searches")
      .delete()
      .eq("id", searchId);
    if (searchError) throw searchError;

    return jsonResponse({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal error";
    return jsonResponse({ error: message }, 500);
  }
});
