//stage2-enrich/index.ts

import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { getLeadProvider } from "../_shared/lead-providers/index.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// Chunk 6: stage2 fa 2 chiamate parallele per profilo = 12 req in burst.
// Su tier Hobby (30 req/min) sta sotto il limite con margine 18.
// Niente pause interne. Self-loop tramite next_stage.
const CHUNK_SIZE = 6;

const COST_PROFILE_DETAILS = 1;
const COST_POSTS_ALL = 1;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.serve(async (req) => {
  try {
    const body = await req.json().catch(() => ({}));
    const { searchId } = body;

    if (!searchId) {
      return new Response(
        JSON.stringify({ error: "Missing required field: searchId" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    // Prendi solo CHUNK_SIZE profili senza bio
    const { data: candidates, error } = await supabase
      .from("search_results")
      .select("id, linkedin_urn")
      .eq("search_id", searchId)
      .is("bio", null)
      .limit(CHUNK_SIZE);

    if (error) {
      throw new Error(`Failed to fetch candidates: ${error.message}`);
    }

    if (!candidates || candidates.length === 0) {
      console.log(`[stage2] nessun candidato da arricchire, done`);
      return new Response(
        JSON.stringify({ done: true, chunkProcessed: 0, creditsUsed: 0 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    const provider = getLeadProvider();

    let detailsCalls = 0;
    let postsCalls = 0;
    let detailsFailed = 0;
    let postsFailed = 0;

    await Promise.all(
      candidates.map(async (candidate) => {
        detailsCalls += 1;
        postsCalls += 1;

        let bio = "";
        let posts: Awaited<ReturnType<typeof provider.getRecentPosts>> = [];

        try {
          const details = await provider.getProfileDetails(candidate.linkedin_urn);
          bio = details.bio ?? "";
        } catch {
          detailsFailed += 1;
          // Marca con stringa vuota per non rientrare nei "bio IS NULL" del prossimo chunk
          await supabase
            .from("search_results")
            .update({ bio: "" })
            .eq("id", candidate.id);
          return;
        }

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
      }),
    );

    const creditsUsed = detailsCalls * COST_PROFILE_DETAILS + postsCalls * COST_POSTS_ALL;

    // Verifica se restano altri bio NULL
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

    if (!done) {
      await sleep(25_000);
    }

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
