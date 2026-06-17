// supabase/functions/stage2-enrich/index.ts

import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { getLeadProvider } from "../_shared/lead-providers/index.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// CHUNK_SIZE=6: 6 profili × 2 chiamate sequenziali × ~2.5s = ~30s per chunk.
// Self-loop: process-search-job rilancia stage2 finché done=true.
// Niente Promise.all né sleep: il rate limiter in linkdapi.ts gestisce il ritmo.
const CHUNK_SIZE = 6;

const COST_PROFILE_DETAILS = 1;
const COST_POSTS_ALL = 1;

Deno.serve(async (req) => {
  try {
    const body = await req.json().catch(() => ({}));
    const { searchId, jobId } = body as { searchId?: string; jobId?: string };

    if (!searchId) {
      return new Response(
        JSON.stringify({ error: "Missing required field: searchId" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const { data: candidates, error } = await supabase
      .from("search_results")
      .select("id, linkedin_urn")
      .eq("search_id", searchId)
      .is("bio", null)
      .limit(CHUNK_SIZE);

    if (error) throw new Error(`Failed to fetch candidates: ${error.message}`);

    if (!candidates || candidates.length === 0) {
      console.log(`[stage2] nessun candidato da arricchire, done`);
      return new Response(
        JSON.stringify({ done: true, chunkProcessed: 0, creditsUsed: 0 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    const provider = getLeadProvider({
      jobId,
      searchId,
      stage: "stage2-enrich",
    });

    let detailsCalls = 0;
    let postsCalls = 0;
    let detailsFailed = 0;
    let postsFailed = 0;

    // Loop SEQUENZIALE: details e posts in serie per ogni profilo.
    // Il rate limiter in linkdapi.ts garantisce di non sfondare i 30 req/min.
    for (const candidate of candidates) {
      detailsCalls += 1;

      let bio = "";
      let posts: Awaited<ReturnType<typeof provider.getRecentPosts>> = [];

      try {
        const details = await provider.getProfileDetails(candidate.linkedin_urn);
        bio = details.bio ?? "";
      } catch {
        detailsFailed += 1;
        // Marca bio="" per non reinserire in "bio IS NULL" al prossimo chunk
        await supabase
          .from("search_results")
          .update({ bio: "" })
          .eq("id", candidate.id);
        continue;
      }

      postsCalls += 1;
      try {
        posts = await provider.getRecentPosts(candidate.linkedin_urn);
      } catch {
        postsFailed += 1;
      }

      await supabase
        .from("search_results")
        .update({
          bio,
          recent_posts: posts.length > 0 ? posts : null,
        })
        .eq("id", candidate.id);
    }

    const creditsUsed =
      detailsCalls * COST_PROFILE_DETAILS + postsCalls * COST_POSTS_ALL;

    // Verifica se restano altri profili con bio NULL
    const { count: stillPending } = await supabase
      .from("search_results")
      .select("id", { count: "exact", head: true })
      .eq("search_id", searchId)
      .is("bio", null);

    const done = (stillPending ?? 0) === 0;

    console.log(
      `[stage2] chunk: ${detailsCalls} details (${detailsFailed} fail), ` +
      `${postsCalls} posts (${postsFailed} fail), pending: ${stillPending ?? 0}, done: ${done}`,
    );
    console.log(`[stage2] CREDITI LINKDAPI questo chunk: ${creditsUsed}`);

    return new Response(
      JSON.stringify({
        done,
        chunkProcessed: candidates.length,
        detailsFailed,
        postsFailed,
        stillPending: stillPending ?? 0,
        creditsUsed,
        searchId,
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});
