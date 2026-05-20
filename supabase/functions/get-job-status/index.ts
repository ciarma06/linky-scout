//get-job-status/index.ts

import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { canUseScout, resolveAccess } from "../_shared/access.ts";

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

  const access = await resolveAccess(
    auth.email,
    SUPABASE_URL,
    SERVICE_KEY,
    "scout",
  );

  if (!canUseScout(access)) {
    return jsonResponse(
      { error: "Unauthorized", access: access.access },
      401,
    );
  }

  try {
    const body = await req.json().catch(() => ({}));
    const { jobId, searchId } = body as { jobId?: string; searchId?: string };

    // Modalità 1: carica risultati direttamente da searchId (per "View Results" dalla history)
    if (searchId?.trim() && !jobId?.trim()) {
      const { data: search } = await supabase
        .from("searches")
        .select("icp_prompt, user_id")
        .eq("id", searchId)
        .maybeSingle();

      if (!search) {
        return jsonResponse({ error: "Search not found" }, 404);
      }
      if (search.user_id !== auth.email) {
        return jsonResponse({ error: "Forbidden" }, 403);
      }

      const { data: results } = await supabase
        .from("search_results")
        .select("*")
        .eq("search_id", searchId)
        .order("match_score", { ascending: false });

      return jsonResponse({
        status: "completed",
        progress: 100,
        current_stage: "completed",
        error_message: null,
        icp_prompt: search.icp_prompt ?? "",
        results: results ?? [],
      });
    }

    // Modalità 2: polling standard per jobId
    if (!jobId?.trim()) {
      return jsonResponse({ error: "Missing jobId or searchId" }, 400);
    }

    const { data: job, error } = await supabase
      .from("search_jobs")
      .select("status, progress, current_stage, error_message, search_id, user_id")
      .eq("id", jobId)
      .maybeSingle();

    if (error || !job) {
      return jsonResponse({ error: "Job not found" }, 404);
    }

    if (job.user_id !== auth.email) {
      return jsonResponse({ error: "Forbidden" }, 403);
    }

    // Don't leak user_id back to the client.
    const { user_id: _userId, ...jobPublic } = job;

    if (job.status === "completed") {
      const { data: results } = await supabase
        .from("search_results")
        .select("*")
        .eq("search_id", job.search_id)
        .order("match_score", { ascending: false });

      return jsonResponse({ ...jobPublic, results: results ?? [] });
    }

    return jsonResponse(jobPublic);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return jsonResponse({ error: message }, 500);
  }
});
