//stage2-enrich/index.ts

import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { getLeadProvider } from "../_shared/lead-providers/index.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const BATCH_SIZE = 25;

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
        JSON.stringify({ message: "No candidates to enrich" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    const provider = getLeadProvider();

    for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
      const batch = candidates.slice(i, i + BATCH_SIZE);

      await Promise.all(
        batch.map(async (candidate) => {
          try {
            const [details, posts] = await Promise.all([
              provider.getProfileDetails(candidate.linkedin_urn),
              provider.getRecentPosts(candidate.linkedin_urn).catch(() => []),
            ]);

            await supabase
              .from("search_results")
              .update({
                bio: details.bio ?? "",
                recent_posts: posts.length > 0 ? posts : null,
              })
              .eq("id", candidate.id);
          } catch {
            // profile not accessible — leave bio=null, don't block the batch
          }
        }),
      );

      if (i + BATCH_SIZE < candidates.length) {
        await sleep(61_000);
      }
    }

    return new Response(
      JSON.stringify({ enriched: candidates.length, searchId }),
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
