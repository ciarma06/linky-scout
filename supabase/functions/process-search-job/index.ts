//process-search-job/index.ts

import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { setCachedResults } from "../_shared/lead-providers/cache.ts";

declare const EdgeRuntime: { waitUntil: (promise: Promise<unknown>) => void };

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

async function callFunction(name: string, body: Record<string, unknown>) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SERVICE_KEY}`,
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

function triggerNextStage() {
  const promise = fetch(`${SUPABASE_URL}/functions/v1/process-pending-jobs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SERVICE_KEY}`,
    },
  }).then((r) => r.text()).catch(() => {});

  try {
    EdgeRuntime.waitUntil(promise);
  } catch {
    // EdgeRuntime non disponibile, cron farà da safety net
  }
}

async function stageStart(jobId: string, icpPrompt: string) {
  await updateJob(jobId, {
    status: "running",
    progress: 5,
    current_stage: "parsing",
    started_at: new Date().toISOString(),
  });

  const { filters } = await callFunction("parse-icp", { prompt: icpPrompt });

  await updateJob(jobId, {
    progress: 10,
    parsed_filters: filters,
    current_stage: "search",
    next_stage: "search",
  });
}

/**
 * Stage SEARCH ora è CHUNKED: ogni invocazione processa un chunk di profili
 * (~12 overview). Se restano pending, fa loop su sé stesso. Quando finisce,
 * avanza a "enrich".
 */
async function stageSearch(jobId: string, searchId: string, job: Record<string, unknown>) {
  await updateJob(jobId, { progress: 15, current_stage: "searching" });

  const filters = job.parsed_filters;
  if (!filters) throw new Error("parsed_filters mancanti — stage 'start' non completato?");

  // La function ora restituisce { done, stillPending, ... }
  const response = await callFunction("stage1-search", { searchId, filters });
  const done = response.done === true;

  if (done) {
    await updateJob(jobId, {
      progress: 40,
      current_stage: "enrich",
      next_stage: "enrich",
    });
  } else {
    // Self-loop: rimaniamo in stage "search" per processare il prossimo chunk
    // Aggiorniamo il progress proporzionalmente ai pending rimanenti
    const stillPending = response.stillPending ?? 0;
    const progress = stillPending > 0
      ? Math.min(35, 20 + Math.floor((40 - stillPending) / 40 * 15))
      : 35;
    await updateJob(jobId, {
      progress,
      current_stage: "searching",
      next_stage: "search", // loop
    });
  }
}

/**
 * Stage ENRICH ora è CHUNKED: ogni invocazione processa ~6 profili.
 * Loop su sé stesso finché ci sono bio NULL, poi avanza a "score".
 */
async function stageEnrich(jobId: string, searchId: string) {
  await updateJob(jobId, { progress: 50, current_stage: "enriching" });

  const response = await callFunction("stage2-enrich", { searchId });
  const done = response.done === true;

  if (done) {
    await updateJob(jobId, {
      progress: 70,
      current_stage: "score",
      next_stage: "score",
    });
  } else {
    const stillPending = response.stillPending ?? 0;
    const progress = stillPending > 0
      ? Math.min(68, 50 + Math.floor((40 - stillPending) / 40 * 20))
      : 68;
    await updateJob(jobId, {
      progress,
      current_stage: "enriching",
      next_stage: "enrich", // loop
    });
  }
}

async function stageScore(jobId: string, searchId: string, icpPrompt: string) {
  await updateJob(jobId, { progress: 80, current_stage: "scoring" });

  await callFunction("score-profiles", { searchId, icpPrompt });

  await updateJob(jobId, {
    progress: 90,
    current_stage: "finalize",
    next_stage: "finalize",
  });
}

async function stageFinalize(jobId: string, searchId: string, icpPrompt: string) {
  const { data: results } = await supabase
    .from("search_results")
    .select("*")
    .eq("search_id", searchId)
    .order("match_score", { ascending: false });

  await setCachedResults(supabase, icpPrompt, results ?? []);

  await updateJob(jobId, {
    status: "completed",
    progress: 100,
    current_stage: "completed",
    next_stage: null,
    completed_at: new Date().toISOString(),
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const body = await req.json().catch(() => ({}));
  const { jobId, stage } = body as { jobId?: string; stage?: string };

  if (!jobId?.trim()) {
    return new Response(
      JSON.stringify({ error: "Missing jobId" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  try {
    const { data: job } = await supabase
      .from("search_jobs")
      .select("*, searches(icp_prompt)")
      .eq("id", jobId)
      .single();

    if (!job) throw new Error("Job not found");

    const icpPrompt = (job.searches as { icp_prompt: string }).icp_prompt;
    const searchId = job.search_id as string;

    const currentStage = stage || job.next_stage || "start";

    switch (currentStage) {
      case "start":
        await stageStart(jobId, icpPrompt);
        break;
      case "search":
        await stageSearch(jobId, searchId, job);
        break;
      case "enrich":
        await stageEnrich(jobId, searchId);
        break;
      case "score":
        await stageScore(jobId, searchId, icpPrompt);
        break;
      case "finalize":
        await stageFinalize(jobId, searchId, icpPrompt);
        break;
      default:
        throw new Error(`Unknown stage: ${currentStage}`);
    }

    if (currentStage !== "finalize") {
      triggerNextStage();
    }

    return new Response(
      JSON.stringify({ success: true, jobId, stage: currentStage }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    await updateJob(jobId!, {
      status: "failed",
      error_message: message,
      next_stage: null,
    });
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
