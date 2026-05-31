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

/**
 * Triggera process-pending-jobs in background per lanciare subito il prossimo stage.
 * Usa EdgeRuntime.waitUntil per garantire che la fetch parta prima dello shutdown dell'isolate.
 * Se waitUntil non è disponibile, nessun problema: il cron raccoglierà il job entro 60s.
 */
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
    // EdgeRuntime.waitUntil non disponibile — il cron farà da safety net
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
 * Stage SEARCH con routing tra i due motori:
 * - searchMode "behavioral" + postKeyword valido → stage1-behavioral (search/posts)
 * - altrimenti → stage1-search (search/people, motore standard)
 * Entrambi sono chunked self-loop: ritornano { done, stillPending }.
 */
async function stageSearch(
  jobId: string,
  searchId: string,
  job: Record<string, unknown>,
) {
  await updateJob(jobId, { progress: 10, current_stage: "searching" });

  const filters = job.parsed_filters as
    | (Record<string, unknown> & { searchMode?: string; postKeyword?: string })
    | null;
  if (!filters)
    throw new Error("parsed_filters mancanti — stage 'start' non completato?");

  const mode = filters.searchMode ?? "profile";
  const hasKeyword =
    typeof filters.postKeyword === "string" &&
    filters.postKeyword.trim().length > 0;

  if (mode === "behavioral" && !hasKeyword) {
    console.log(
      `[orchestrator] WARNING: searchMode=behavioral ma postKeyword vuoto → fallback a stage1-search`,
    );
  }

  let response;
  if (mode === "behavioral" && hasKeyword) {
    const intent = (filters.behavioralIntent as string) ?? "expresses";
    if (intent === "expresses") {
      response = await callFunction("stage1-commenters", { searchId, filters });
    } else if (intent === "offers" || intent === "both") {
      if (intent === "both") {
        console.warn(`[process-search-job] behavioralIntent="both" trattato come "offers"`);
      }
      response = await callFunction("stage1-behavioral", { searchId, filters });
    } else {
      console.warn(`[process-search-job] intent sconosciuto "${intent}", fallback a behavioral`);
      response = await callFunction("stage1-behavioral", { searchId, filters });
    }
  } else {
    response = await callFunction("stage1-search", { searchId, filters });
  }
  const done = response.done === true;

  if (done) {
    await updateJob(jobId, {
      progress: 38,
      current_stage: "enrich",
      next_stage: "enrich",
    });
  } else {
    const { count: totalInserted } = await supabase
      .from("search_results")
      .select("id", { count: "exact", head: true })
      .eq("search_id", searchId);

    const { count: stillPending } = await supabase
      .from("search_results")
      .select("id", { count: "exact", head: true })
      .eq("search_id", searchId)
      .eq("follower_count", -1);

    const total = totalInserted ?? 1;
    const pending = stillPending ?? 0;
    const done_ratio = Math.max(0, (total - pending) / total);
    const progress = Math.round(12 + done_ratio * 23);

    await updateJob(jobId, {
      progress,
      current_stage: "searching",
      next_stage: "search",
    });
  }
}

async function stageEnrich(jobId: string, searchId: string) {
  await updateJob(jobId, { progress: 40, current_stage: "enriching" });

  const response = await callFunction("stage2-enrich", { searchId });
  const done = response.done === true;

  if (done) {
    await updateJob(jobId, {
      progress: 72,
      current_stage: "score",
      next_stage: "score",
    });
  } else {
    const { count: totalCandidates } = await supabase
      .from("search_results")
      .select("id", { count: "exact", head: true })
      .eq("search_id", searchId);

    const { count: stillPending } = await supabase
      .from("search_results")
      .select("id", { count: "exact", head: true })
      .eq("search_id", searchId)
      .is("bio", null);

    const total = totalCandidates ?? 1;
    const pending = stillPending ?? 0;
    const done_ratio = Math.max(0, (total - pending) / total);
    const progress = Math.round(42 + done_ratio * 28);

    await updateJob(jobId, {
      progress,
      current_stage: "enriching",
      next_stage: "enrich",
    });
  }
}

async function stageScore(
  jobId: string,
  searchId: string,
  icpPrompt: string,
  job: Record<string, unknown>,
) {
  await updateJob(jobId, { progress: 80, current_stage: "scoring" });

  const filters = job.parsed_filters as Record<string, unknown> | null;
  const behavioralIntent = (filters?.behavioralIntent as string) ?? "expresses";

  await callFunction("score-profiles", { searchId, icpPrompt, behavioralIntent });

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
        await stageScore(jobId, searchId, icpPrompt, job);
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
