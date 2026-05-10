import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

Deno.serve(async (_req) => {
  try {
    const { data: job } = await supabase
      .from("search_jobs")
      .select("id")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (!job) {
      return new Response(
        JSON.stringify({ message: "No pending jobs" }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    // Fire-and-forget: il cron ha un timeout di 30s, non aspettiamo la pipeline
    fetch(`${SUPABASE_URL}/functions/v1/process-search-job`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SERVICE_KEY}`,
      },
      body: JSON.stringify({ jobId: job.id }),
    });

    return new Response(
      JSON.stringify({ message: "Job started", jobId: job.id }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch {
    return new Response(
      JSON.stringify({ message: "No pending jobs or error" }),
      { headers: { "Content-Type": "application/json" } },
    );
  }
});
