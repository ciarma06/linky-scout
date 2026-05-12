import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { getCachedResults } from "../_shared/lead-providers/cache.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const { icpPrompt, userEmail } = body as {
      icpPrompt?: string;
      userEmail?: string;
    };

    if (!icpPrompt?.trim() || !userEmail?.trim()) {
      return new Response(
        JSON.stringify({
          error: "Missing required fields: icpPrompt and userEmail",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const cacheResult = await getCachedResults(supabase, icpPrompt);

    if (cacheResult.hit) {
      // Record in history even for cached results
      const { data: search } = await supabase
        .from("searches")
        .insert({ user_id: userEmail, icp_prompt: icpPrompt })
        .select("id")
        .single();

      return new Response(
        JSON.stringify({ cached: true, results: cacheResult.results, searchId: search?.id }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
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

    return new Response(
      JSON.stringify({ cached: false, jobId: job.id, searchId: search.id }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
