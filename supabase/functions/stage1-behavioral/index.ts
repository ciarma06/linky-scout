// supabase/functions/stage1-behavioral/index.ts

import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { getLeadProvider } from "../_shared/lead-providers/index.ts";
import type { SearchFilters } from "../_shared/lead-providers/types.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const CHUNK_SIZE = 12;           // overview per chunk (fase 2)
const MAX_AUTHORS = 25;          // tetto autori unici
const MAX_PAGES = 6;             // tetto pagine search/posts
const POSTS_PER_PAGE = 10;       // search/posts torna 10/pagina
const MATCH_POST_LIMIT = 2000;   // cap lunghezza testo post salvato

const COST_SEARCH_POSTS = 1;
const COST_PROFILE_OVERVIEW = 2;

async function hasAnyResults(searchId: string): Promise<boolean> {
  const { count } = await supabase
    .from("search_results")
    .select("id", { count: "exact", head: true })
    .eq("search_id", searchId);
  return (count ?? 0) > 0;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405, headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const { searchId, filters } = body as {
      searchId?: string;
      filters?: SearchFilters & { maxFollowers?: number | null; postKeyword?: string };
    };

    if (!searchId || !filters) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: searchId and filters" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const provider = getLeadProvider();
    const { title, postKeyword, maxFollowers } = filters;

    // Guardia: postKeyword obbligatorio per il motore comportamentale.
    // L'orchestrator dovrebbe già garantirlo, ma difendiamo comunque.
    if (!postKeyword?.trim()) {
      console.error(`[stage1-behavioral] postKeyword vuoto, impossibile procedere`);
      return new Response(
        JSON.stringify({ done: true, stillPending: 0, error: "empty postKeyword" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    const isSearchPhase = !(await hasAnyResults(searchId));

    // ===================================================================
    // FASE 1 (prima invocazione): search/posts + dedup autori + insert
    // ===================================================================
    if (isSearchPhase) {
      const uniqueAuthors = new Map<string, { url: string; fullName: string; headline: string; matchPost: string }>();
      let start = 0;
      let pages = 0;
      let creditsUsed = 0;

      while (pages < MAX_PAGES && uniqueAuthors.size < MAX_AUTHORS) {
        const resp = await provider.searchPosts({
          keyword: postKeyword,
          authorJobTitle: title,
          datePosted: "past-month",
          sortBy: "relevance",
          start,
        });
        creditsUsed += COST_SEARCH_POSTS;
        pages += 1;

        for (const post of resp.posts) {
          if (uniqueAuthors.size >= MAX_AUTHORS) break;
          const urn = post.author.urn;
          // dedup per autore: teniamo il PRIMO post che ha fatto match
          if (!urn || uniqueAuthors.has(urn)) continue;
          uniqueAuthors.set(urn, {
            url: post.author.url,
            fullName: post.author.fullName,
            headline: post.author.headline,
            matchPost: post.postText,
          });
        }

        if (!resp.hasMore) break;
        start += POSTS_PER_PAGE;
      }

      const rows = [...uniqueAuthors.entries()].map(([urn, a]) => ({
        search_id: searchId,
        linkedin_urn: urn,
        linkedin_url: a.url,
        full_name: a.fullName,
        headline: a.headline,
        location: "", // search/posts non restituisce location
        follower_count: -1, // marker pending overview
        match_score: null,
        saved_to_crm: false,
        match_post: a.matchPost.slice(0, MATCH_POST_LIMIT),
      }));

      if (rows.length > 0) {
        const { error } = await supabase.from("search_results").insert(rows);
        if (error) throw new Error(`Insert failed: ${error.message}`);
      }

      console.log(
        `[stage1-behavioral] search/posts: ${pages} pagine, ${rows.length} autori unici inseriti`,
      );
      console.log(`[stage1-behavioral] CREDITI questo chunk: ${creditsUsed}`);

      // Se 0 autori: done=true subito (no loop infinito, pipeline avanza a vuoto)
      const done = rows.length === 0;
      return new Response(
        JSON.stringify({
          done,
          stillPending: rows.length,
          authorsFound: rows.length,
          creditsUsed,
          mode: "behavioral",
          searchId,
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    // ===================================================================
    // FASE 2 (invocazioni successive): chunk di overview sui pending
    // ===================================================================
    const { data: pending } = await supabase
      .from("search_results")
      .select("id, linkedin_url, linkedin_urn")
      .eq("search_id", searchId)
      .eq("follower_count", -1)
      .limit(CHUNK_SIZE);

    let overviewCalls = 0;
    let overviewFailed = 0;

    if (pending && pending.length > 0) {
      for (const p of pending) {
        const username = p.linkedin_url.split("/in/")[1]?.replace(/\/$/, "") ?? "";
        overviewCalls += 1;

        if (!username) {
          // Senza username non possiamo fare overview; ma teniamo il profilo
          // con follower_count=0 perché ha comunque il match_post.
          await supabase
            .from("search_results")
            .update({ follower_count: 0 })
            .eq("id", p.id);
          continue;
        }

        try {
          const overview = await provider.getProfileOverview(username);
          const fc = overview.followerCount ?? 0;

          if (maxFollowers && fc > maxFollowers) {
            // Sopra soglia follower: questo sì lo eliminiamo (filtro hard esplicito)
            await supabase.from("search_results").delete().eq("id", p.id);
            continue;
          }

          await supabase
            .from("search_results")
            .update({
              follower_count: fc,
              linkedin_urn: overview.urn ?? p.linkedin_urn,
            })
            .eq("id", p.id);
        } catch {
          // DIFFERENZA dal motore A: NON cancelliamo. Il match_post è prova
          // preziosa. follower_count=0 fa uscire la riga dai pending.
          overviewFailed += 1;
          await supabase
            .from("search_results")
            .update({ follower_count: 0 })
            .eq("id", p.id);
        }
      }
    }

    const creditsUsed = overviewCalls * COST_PROFILE_OVERVIEW;

    const { count: stillPending } = await supabase
      .from("search_results")
      .select("id", { count: "exact", head: true })
      .eq("search_id", searchId)
      .eq("follower_count", -1);

    const done = (stillPending ?? 0) === 0;

    console.log(
      `[stage1-behavioral] overview chunk: ${overviewCalls} chiamate, ${overviewFailed} falliti (tenuti), ` +
      `pending: ${stillPending ?? 0}, done: ${done}`,
    );
    console.log(`[stage1-behavioral] CREDITI questo chunk: ${creditsUsed}`);

    return new Response(
      JSON.stringify({
        done,
        stillPending: stillPending ?? 0,
        chunkProcessed: overviewCalls,
        overviewFailed,
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
