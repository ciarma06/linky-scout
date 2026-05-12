//process-pending-jobs/index.ts

import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

async function launchJob(jobId: string, stage: string) {
  // Fire-and-forget: spariamo la richiesta a process-search-job e abortiamo
  // l'attesa della risposta dopo 1500ms. Il server continua a processare
  // nel suo isolate indipendente. In questo modo process-pending-jobs
  // ritorna velocemente invece di restare appeso per tutta la durata dello stage.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 1500);

  try {
    await fetch(`${SUPABASE_URL}/functions/v1/process-search-job`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SERVICE_KEY}`,
      },
      body: JSON.stringify({ jobId, stage }),
      signal: controller.signal,
    });
  } catch (err) {
    // AbortError è atteso (significa che la richiesta è partita e abbiamo
    // tagliato l'attesa della risposta). Solo errori diversi vanno loggati.
    const name = err instanceof Error ? err.name : "";
    if (name !== "AbortError") {
      console.error(`[cron] Failed to launch job ${jobId} stage ${stage}:`, err);
    }
  } finally {
    clearTimeout(timeoutId);
  }
}

Deno.serve(async (_req) => {
  try {
    const { data: pendingJobs } = await supabase
      .from("search_jobs")
      .select("id")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(3);

    const { data: runningJobs } = await supabase
      .from("search_jobs")
      .select("id, next_stage")
      .eq("status", "running")
      .not("next_stage", "is", null)
      .limit(5);

    const launched: string[] = [];

    for (const job of pendingJobs ?? []) {
      await launchJob(job.id, "start");
      launched.push(`${job.id}:start`);
    }

    for (const job of runningJobs ?? []) {
      // Lock ottimistico: setta next_stage=null PRIMA di lanciare,
      // così il prossimo tick del cron non riprende lo stesso stage.
      // Se l'UPDATE non trova la riga (già presa da un altro tick), skip.
      const { data: updated, error } = await supabase
        .from("search_jobs")
        .update({ next_stage: null })
        .eq("id", job.id)
        .eq("next_stage", job.next_stage)
        .select("id")
        .single();

      if (error || !updated) continue;

      await launchJob(job.id, job.next_stage);
      launched.push(`${job.id}:${job.next_stage}`);
    }

    return new Response(
      JSON.stringify({
        message: launched.length > 0 ? "Jobs launched" : "No jobs to process",
        launched,
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("[cron] Error:", err);
    return new Response(
      JSON.stringify({ message: "Cron error", error: String(err) }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
