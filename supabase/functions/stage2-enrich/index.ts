//stage2-enrich/index.ts

import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { getLeadProvider } from "../_shared/lead-providers/index.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Batch size 10: stage2 fa DUE chiamate per profilo (details + posts) in parallelo,
// quindi 10 profili = 20 req in burst. Su tier Hobby (30 req/min) sta sotto il limite
// con margine di 10 req. Con 25 sforava il burst e generava 429 → bio NULL.
const BATCH_SIZE = 10;

// Costo crediti LinkdAPI
const COST_PROFILE_DETAILS = 1;
const COST_POSTS_ALL = 1;

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

    const { data: candidates, error } = await supabase
      .from("search_results")
      .select("id, linkedin_urn, linkedin_url")
      .eq("search_id", searchId)
      .is("bio", null);

    if (error) {
      throw new Error(`Failed to fetch candidates: ${error.message}`);
    }

    if (!candidates || candidates.length === 0) {
      return new Response(
        JSON.stringify({ message: "No candidates to enrich", creditsUsed: 0 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    const provider = getLeadProvider();

    // Counter crediti + errori
    let detailsCalls = 0;
    let postsCalls = 0;
    let detailsFailed = 0;
    let postsFailed = 0;

    for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
      const batch = candidates.slice(i, i + BATCH_SIZE);

      await Promise.all(
        batch.map(async (candidate) => {
          // Conta SEMPRE le chiamate (LinkdAPI consuma anche su errore)
          detailsCalls += 1;
          postsCalls += 1;

          let bio = "";
          let posts: Awaited<ReturnType<typeof provider.getRecentPosts>> = [];

          try {
            const details = await provider.getProfileDetails(candidate.linkedin_urn);
            bio = details.bio ?? "";
          } catch {
            detailsFailed += 1;
            return; // skip update se details fallisce (bio resta null)
          }

          try {
            posts = await provider.getRecentPosts(candidate.linkedin_urn);
          } catch {
            postsFailed += 1;
            posts = [];
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

      if (i + BATCH_SIZE < candidates.length) {
        await sleep(61_000);
      }
    }

    const creditsUsed = detailsCalls * COST_PROFILE_DETAILS + postsCalls * COST_POSTS_ALL;

    console.log(
      `[stage2] CREDITI LINKDAPI: ${creditsUsed} ` +
      `(profile/details: ${detailsCalls} × ${COST_PROFILE_DETAILS} = ${detailsCalls}, ` +
      `posts/all: ${postsCalls} × ${COST_POSTS_ALL} = ${postsCalls})`,
    );

    console.log(
      `[stage2] errori: details ${detailsFailed}/${detailsCalls}, posts ${postsFailed}/${postsCalls}`,
    );

    return new Response(
      JSON.stringify({
        enriched: candidates.length,
        creditsUsed,
        detailsFailed,
        postsFailed,
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
