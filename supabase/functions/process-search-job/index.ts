import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { setCachedResults } from "../_shared/lead-providers/cache.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

async function callFunction(name: string, body: Record<string, unknown>) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${SERVICE_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`${name} failed: ${err}`);
  }
  return res.json();
}

async function updateJob(jobId: string, updates: Record<string, unknown>) {
  await supabase.from("search_jobs").update(updates).eq("id", jobId);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  const body = await req.json().catch(() => ({}));
  const { jobId } = body as { jobId?: string };

  if (!jobId?.trim()) {
    return new Response(
      JSON.stringify({ error: "Missing required field: jobId" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  try {
    const { data: job, error: jobError } = await supabase
      .from("search_jobs")
      .select("*, searches(icp_prompt)")
      .eq("id", jobId)
      .single();

    if (jobError || !job) {
      throw new Error(
        `Job not found: ${jobError?.message ?? "unknown error"}`,
      );
    }

    const icpPrompt = (job.searches as { icp_prompt: string }).icp_prompt;
    const searchId = job.search_id as string;

    // Stage 1 — parse ICP
    await updateJob(jobId, {
      status: "running",
      progress: 5,
      current_stage: "parsing",
      started_at: new Date().toISOString(),
    });
    const { filters } = await callFunction("parse-icp", { prompt: icpPrompt });

    // Stage 2 — search + coarse filter
    await updateJob(jobId, { progress: 15, current_stage: "searching" });
    await callFunction("stage1-search", { searchId, filters });

    // Stage 3 — bio + posts enrichment
    await updateJob(jobId, { progress: 50, current_stage: "enriching" });
    await callFunction("stage2-enrich", { searchId });

    // Stage 4 — AI scoring
    await updateJob(jobId, { progress: 80, current_stage: "scoring" });
    await callFunction("score-profiles", { searchId, icpPrompt });

    // Stage 5 — cache final results
    const { data: results } = await supabase
      .from("search_results")
      .select("*")
      .eq("search_id", searchId)
      .order("match_score", { ascending: false });

    await setCachedResults(supabase, icpPrompt, results ?? []);

    // Complete
    await updateJob(jobId, {
      status: "completed",
      progress: 100,
      current_stage: "completed",
      completed_at: new Date().toISOString(),
    });

    return new Response(
      JSON.stringify({ success: true, jobId, searchId }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    await updateJob(jobId, {
      status: "failed",
      error_message: message,
    });
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});
