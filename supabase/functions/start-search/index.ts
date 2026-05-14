import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { getCachedResults } from "../_shared/lead-providers/cache.ts";

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
      false, ["verify"],
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

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const authHeader = req.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const auth = await verifyJwt(token);

  if (!auth) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  try {
    const body = await req.json().catch(() => ({}));
    const { icpPrompt } = body as { icpPrompt?: string };

    if (!icpPrompt?.trim()) {
      return jsonResponse(
        { error: "Missing required field: icpPrompt" },
        400,
      );
    }

    // The authenticated email from the JWT is the source of truth — we no
    // longer trust the `userEmail` field that used to come from the body.
    const userEmail = auth.email;

    const cacheResult = await getCachedResults(supabase, icpPrompt);

    if (cacheResult.hit) {
      // Record in history even for cached results
      const { data: search } = await supabase
        .from("searches")
        .insert({ user_id: userEmail, icp_prompt: icpPrompt })
        .select("id")
        .single();

      const searchId = search?.id;

      // ── FIX: inserisci i risultati cached anche in search_results ──
      // Così la history page e "View Results" trovano i dati associati
      // a questo searchId, invece di mostrare 0 matches.
      if (searchId && Array.isArray(cacheResult.results) && cacheResult.results.length > 0) {
        type CachedRow = Record<string, unknown>;

        const rows = (cacheResult.results as CachedRow[]).map((r) => ({
          search_id: searchId,
          linkedin_urn: r.linkedin_urn ?? "",
          linkedin_url: r.linkedin_url ?? "",
          full_name: r.full_name ?? null,
          headline: r.headline ?? null,
          location: r.location ?? null,
          follower_count: r.follower_count ?? null,
          bio: r.bio ?? null,
          recent_posts: r.recent_posts ?? null,
          match_score: r.match_score ?? null,
          match_reason: r.match_reason ?? null,
          best_context: r.best_context ?? null,
          saved_to_crm: false,
        }));

        await supabase.from("search_results").insert(rows);
      }

      return jsonResponse({
        cached: true,
        results: cacheResult.results,
        searchId,
      });
    }

    const { data: search, error: searchError } = await supabase
      .from("searches")
      .insert({ user_id: userEmail, icp_prompt: icpPrompt })
      .select("id")
      .single();

    if (searchError || !search) {
      throw new Error(
        `Failed to create search: ${searchError?.message ?? "unknown error"}`,
      );
    }

    const { data: job, error: jobError } = await supabase
      .from("search_jobs")
      .insert({
        search_id: search.id,
        user_id: userEmail,
        status: "pending",
        progress: 0,
        current_stage: "queued",
      })
      .select("id")
      .single();

    if (jobError || !job) {
      throw new Error(
        `Failed to create job: ${jobError?.message ?? "unknown error"}`,
      );
    }

    return jsonResponse({
      cached: false,
      jobId: job.id,
      searchId: search.id,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return jsonResponse({ error: message }, 500);
  }
});
