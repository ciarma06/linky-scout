import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const { jobId } = body as { jobId?: string };

    if (!jobId?.trim()) {
      return new Response(
        JSON.stringify({ error: "Missing required field: jobId" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const { data: job, error } = await supabase
      .from("search_jobs")
      .select("status, progress, current_stage, error_message, search_id")
      .eq("id", jobId)
      .single();

    if (error || !job) {
      return new Response(
        JSON.stringify({ error: "Job not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      );
    }

    if (job.status === "completed") {
      const { data: results } = await supabase
        .from("search_results")
        .select("*")
        .eq("search_id", job.search_id)
        .order("match_score", { ascending: false });

      return Response.json({ ...job, results: results ?? [] });
    }

    return Response.json(job);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});
