// supabase/functions/stage1-search/index.ts

import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { getLeadProvider } from "../_shared/lead-providers/index.ts";
import type { ProfileBasic, SearchFilters } from "../_shared/lead-providers/types.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// CHUNK_SIZE=12: loop sequenziale, rate limiter in linkdapi.ts gestisce il ritmo.
// 12 chiamate × ~2.5s (token bucket) = ~30s per chunk, ben dentro i 150s di timeout.
// Self-loop: process-search-job rilancia stage1 finché done=true.
const CHUNK_SIZE = 12;
const SEARCH_COUNT = 50;
const TARGET_CANDIDATES = 40;
const PREFILTER_FLOOR = 15;

const COST_SEARCH_PEOPLE = 1;
const COST_PROFILE_OVERVIEW = 2;

const HEADLINE_BLACKLIST = [
  "nonprofit", "non profit", "ministry", "ministries", "charity",
  "church", "religious", "youth outreach", "community outreach",
  "outreach worker", "outreach coordinator", "outreach ministries",
];

const normalize = (s: string) =>
  s.toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const headlineMatchesTitle = (headline: string, title: string): boolean => {
  if (!title?.trim()) return true;
  if (!headline) return false;
  const h = normalize(headline);
  const tokens = normalize(title).split(" ").filter((t) => t.length > 2);
  if (tokens.length === 0) return true;
  return tokens.every((t) => h.includes(t));
};

const headlineIsBlacklisted = (headline: string): boolean => {
  if (!headline) return false;
  const h = normalize(headline);
  return HEADLINE_BLACKLIST.some((bad) => h.includes(bad));
};

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
    const { searchId, filters, jobId } = body as {
      searchId?: string;
      filters?: SearchFilters & { maxFollowers?: number | null };
      jobId?: string;
    };

    if (!searchId || !filters) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: searchId and filters" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const provider = getLeadProvider({
      jobId,
      searchId,
      stage: "stage1-search",
    });
    const { keyword, title, geoUrns, industry, language, maxFollowers } = filters;

    let creditsUsed = 0;
    let overviewCalls = 0;

    // Verifica se è la prima invocazione per questo searchId.
    // follower_count = -1 è il marker "scheletro in attesa di overview".
    const { count: pendingCount } = await supabase
      .from("search_results")
      .select("id", { count: "exact", head: true })
      .eq("search_id", searchId)
      .eq("follower_count", -1);

    const isFirstCall = (pendingCount ?? 0) === 0 && !(await hasAnyResults(searchId));

    // PRIMA INVOCAZIONE: search/people + insert scheletri
    if (isFirstCall) {
      const rawProfiles: ProfileBasic[] = await provider.searchProfiles({
        keyword, title, geoUrns, industry, language, count: SEARCH_COUNT,
      });
      creditsUsed += COST_SEARCH_PEOPLE;

      console.log(`[stage1] search/people: ${rawProfiles.length} profili grezzi`);

      const titleFiltered = rawProfiles.filter((p) =>
        headlineMatchesTitle(p.headline ?? "", title ?? "")
      );
      const preFiltered = titleFiltered.filter((p) =>
        !headlineIsBlacklisted(p.headline ?? "")
      );

      const blacklisted = titleFiltered.length - preFiltered.length;
      console.log(
        `[stage1] post-filtro headline: ${preFiltered.length}/${rawProfiles.length} ` +
        `(title match: ${titleFiltered.length}, blacklisted: ${blacklisted})`,
      );

      const toEnrich = preFiltered.length >= PREFILTER_FLOOR ? preFiltered : rawProfiles;

      const rows = toEnrich.slice(0, TARGET_CANDIDATES).map((p) => ({
        search_id: searchId,
        linkedin_urn: p.urn,
        linkedin_url: p.url,
        full_name: p.fullName,
        headline: p.headline,
        location: p.location,
        follower_count: -1, // marker "pending overview"
        match_score: null,
        saved_to_crm: false,
      }));

      if (rows.length > 0) {
        const { error } = await supabase.from("search_results").insert(rows);
        if (error) throw new Error(`Insert failed: ${error.message}`);
      }

      console.log(`[stage1] inseriti ${rows.length} scheletri (overview pendente)`);
    }

    // TUTTE LE INVOCAZIONI: processa un chunk di scheletri pending.
    // Loop SEQUENZIALE: il rate limiter in linkdapi.ts gestisce il ritmo,
    // niente sleep né Promise.all che causano thundering herd sul lock Postgres.
    const { data: pending } = await supabase
      .from("search_results")
      .select("id, linkedin_url, linkedin_urn")
      .eq("search_id", searchId)
      .eq("follower_count", -1)
      .limit(CHUNK_SIZE);

    let overviewFailed = 0;

    if (pending && pending.length > 0) {
      for (const p of pending) {
        const username = p.linkedin_url.split("/in/")[1]?.replace(/\/$/, "") ?? "";
        overviewCalls += 1;

        if (!username) {
          await supabase.from("search_results").delete().eq("id", p.id);
          continue;
        }

        try {
          const overview = await provider.getProfileOverview(username);
          const fc = overview.followerCount ?? 0;

          if (maxFollowers && fc > maxFollowers) {
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
          overviewFailed += 1;
          await supabase.from("search_results").delete().eq("id", p.id);
        }
      }
    }

    creditsUsed += overviewCalls * COST_PROFILE_OVERVIEW;

    const { count: stillPending } = await supabase
      .from("search_results")
      .select("id", { count: "exact", head: true })
      .eq("search_id", searchId)
      .eq("follower_count", -1);

    const done = (stillPending ?? 0) === 0;

    console.log(
      `[stage1] chunk: ${overviewCalls} overview, ${overviewFailed} falliti, ` +
      `pending rimanenti: ${stillPending ?? 0}, done: ${done}`,
    );
    console.log(`[stage1] CREDITI LINKDAPI questo chunk: ${creditsUsed}`);

    return new Response(
      JSON.stringify({
        done,
        chunkProcessed: overviewCalls,
        chunkFailed: overviewFailed,
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
