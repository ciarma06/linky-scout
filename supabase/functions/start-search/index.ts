import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { getCachedResults, hashICP } from "../_shared/lead-providers/cache.ts";
import { canUseScout, resolveAccess } from "../_shared/access.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const JWT_SECRET = Deno.env.get("AUTH_JWT_SECRET")!;

const SEARCH_COST = 100;

const DEFAULT_PROMPTS = [
  "B2B SaaS founders, USA, <15k followers",
  "CEO tech startup, Europe, AI sector",
  "Head of Sales, Series A-B, USA",
  "Founder, bootstrapped SaaS, UK/Australia",
] as const;

let _defaultHashesCache: Set<string> | null = null;

async function getDefaultHashes(): Promise<Set<string>> {
  if (_defaultHashesCache) return _defaultHashesCache;
  const hashes = await Promise.all(DEFAULT_PROMPTS.map((p) => hashICP(p)));
  _defaultHashesCache = new Set(hashes);
  return _defaultHashesCache;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
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

interface DeductResult {
  success: boolean;
  new_balance: number;
  used_from: string | null;
}

async function deductCredits(
  email: string,
  amount: number,
  searchId: string,
): Promise<DeductResult> {
  const { data, error } = await supabase.rpc("deduct_search_credits", {
    p_email: email,
    p_amount: amount,
    p_search_id: searchId,
  });

  if (error) {
    console.error("[start-search] deduct_search_credits error:", error);
    throw new Error(error.message);
  }

  const row = Array.isArray(data) ? data[0] : data;
  return {
    success: Boolean(row?.success),
    new_balance: typeof row?.new_balance === "number" ? row.new_balance : 0,
    used_from: typeof row?.used_from === "string" ? row.used_from : null,
  };
}

async function userHasPreviousSearch(
  email: string,
  icpHash: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("searches")
    .select("id")
    .eq("user_id", email)
    .eq("icp_hash", icpHash)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("[start-search] previous search lookup failed:", error);
    return false;
  }
  return data !== null;
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

  const access = await resolveAccess(
    auth.email,
    SUPABASE_URL,
    SERVICE_KEY,
    "scout",
  );

  if (!canUseScout(access)) {
    const messages: Record<string, string> = {
      trial_ended: "Your free trial has ended. Upgrade to keep searching.",
      expired: "Your subscription has expired. Renew to keep searching.",
      none: "No active plan found. Sign up to start searching.",
    };
    const message = messages[access.access] ?? "Access not available.";
    return jsonResponse(
      {
        error: "access_denied",
        access: access.access,
        message,
      },
      403,
    );
  }

  try {
    const body = await req.json().catch(() => ({}));
    const { icpPrompt: rawPrompt } = body as { icpPrompt?: string };

    if (!rawPrompt?.trim()) {
      return jsonResponse(
        { error: "Missing required field: icpPrompt" },
        400,
      );
    }

    const icpPrompt = rawPrompt.trim();
    const userEmail = auth.email;

    const icpHash = await hashICP(icpPrompt);
    const defaults = await getDefaultHashes();
    const isDefault = defaults.has(icpHash);

    if (access.access === "trial" && !isDefault) {
      return jsonResponse(
        {
          error: "upgrade_required",
          message: "Upgrade to run custom searches",
          access: "trial",
        },
        403,
      );
    }

    let isFree = isDefault;
    if (!isFree && access.access === "premium") {
      const hasPrior = await userHasPreviousSearch(userEmail, icpHash);
      if (hasPrior) isFree = true;
    }

    const { data: search, error: searchError } = await supabase
      .from("searches")
      .insert({
        user_id: userEmail,
        icp_prompt: icpPrompt,
        icp_hash: icpHash,
      })
      .select("id")
      .single();

    if (searchError || !search) {
      throw new Error(
        `Failed to create search: ${searchError?.message ?? "unknown error"}`,
      );
    }

    const searchId = search.id as string;

    if (!isFree) {
      let deduct: DeductResult;
      try {
        deduct = await deductCredits(userEmail, SEARCH_COST, searchId);
      } catch (err) {
        await supabase.from("searches").delete().eq("id", searchId);
        const message = err instanceof Error ? err.message : "Credit error";
        return jsonResponse({ error: message }, 500);
      }

      if (!deduct.success) {
        await supabase.from("searches").delete().eq("id", searchId);
        return jsonResponse(
          {
            error: "insufficient_credits",
            balance: deduct.new_balance,
            required: SEARCH_COST,
          },
          402,
        );
      }
    }

    const cacheResult = await getCachedResults(supabase, icpPrompt);

    if (isDefault && !cacheResult.hit) {
      console.warn(
        "[start-search] default prompt cache miss, running live free:",
        icpPrompt,
      );
    }

    if (cacheResult.hit) {
      if (
        Array.isArray(cacheResult.results) &&
        cacheResult.results.length > 0
      ) {
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

    const { data: job, error: jobError } = await supabase
      .from("search_jobs")
      .insert({
        search_id: searchId,
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
      searchId,
    });
  } catch (err) {
    console.error("[start-search] unexpected error:", err);
    const message = err instanceof Error ? err.message : "Internal server error";
    return jsonResponse({ error: message }, 500);
  }
});
