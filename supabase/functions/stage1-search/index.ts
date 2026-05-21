//stage1-search/index.ts

import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { getLeadProvider } from "../_shared/lead-providers/index.ts";
import type { ProfileBasic, SearchFilters } from "../_shared/lead-providers/types.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Batch size 10: tier Hobby = 30 req/min. Stage1 fa 1 chiamata per profilo
// (profile/overview), quindi 10 in burst = 10 req, ampio margine sotto i 30.
const BATCH_SIZE = 10;
const BATCH_PAUSE_MS = 61_000;
const SEARCH_COUNT = 50;
const TARGET_CANDIDATES = 40;
const PREFILTER_FLOOR = 15;

// Costo crediti LinkdAPI per chiamata
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

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const { searchId, filters } = body as {
      searchId?: string;
      filters?: SearchFilters & { maxFollowers?: number | null };
    };

    if (!searchId || !filters) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: searchId and filters" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const provider = getLeadProvider();
    const { keyword, title, geoUrns, industry, language, maxFollowers } = filters;

    // Counter crediti LinkdAPI
    let creditsUsed = 0;
    let overviewCalls = 0;

    // STEP 1: search/people (1 credito)
    const rawProfiles: ProfileBasic[] = await provider.searchProfiles({
      keyword, title, geoUrns, industry, language, count: SEARCH_COUNT,
    });
    creditsUsed += COST_SEARCH_PEOPLE;

    console.log(`[stage1] search/people: ${rawProfiles.length} profili grezzi`);

    // STEP 2: pre-filtro headline (title match + blacklist)
    const titleFiltered = rawProfiles.filter((p) =>
      headlineMatchesTitle(p.headline ?? "", title ?? "")
    );
    const preFiltered = titleFiltered.filter((p) =>
      !headlineIsBlacklisted(p.headline ?? "")
    );

    const blacklisted = titleFiltered.length - preFiltered.length;

    console.log(
      `[stage1] post-filtro headline: ${preFiltered.length}/${rawProfiles.length} ` +
      `(title match: ${titleFiltered.length}, blacklisted: ${blacklisted}, ` +
      `risparmio: ${(rawProfiles.length - preFiltered.length) * COST_PROFILE_OVERVIEW} crediti)`,
    );

    const toEnrich = preFiltered.length >= PREFILTER_FLOOR
      ? preFiltered
      : rawProfiles;

    if (toEnrich.length < preFiltered.length) {
      console.log(`[stage1] WARNING: pre-filtro disabilitato (sotto soglia ${PREFILTER_FLOOR})`);
    }

    // STEP 3: profile/overview SOLO sui survivors (2 crediti/cad)
    const enriched: Array<ProfileBasic & { followerCount: number }> = [];

    for (let i = 0; i < toEnrich.length; i += BATCH_SIZE) {
      const batch = toEnrich.slice(i, i + BATCH_SIZE);

      const results = await Promise.all(
        batch.map(async (p) => {
          const username = p.url.split("/in/")[1]?.replace(/\/$/, "") ?? "";
          if (!username) return null;
          overviewCalls += 1; // conta SEMPRE, anche errori (LinkdAPI consuma)
          try {
            const overview = await provider.getProfileOverview(username);
            return {
              ...p,
              urn: overview.urn ?? p.urn,
              followerCount: overview.followerCount ?? 0,
            };
          } catch {
            return null;
          }
        }),
      );

      for (const r of results) {
        if (r !== null) enriched.push(r);
      }

      if (i + BATCH_SIZE < toEnrich.length) {
        await sleep(BATCH_PAUSE_MS);
      }
    }

    creditsUsed += overviewCalls * COST_PROFILE_OVERVIEW;

    // STEP 4: filtro hard sui followers
    const final = enriched
      .filter((p) => !maxFollowers || p.followerCount <= maxFollowers)
      .slice(0, TARGET_CANDIDATES);

    console.log(`[stage1] candidati finali: ${final.length}`);

    // LOG CREDITI LINKDAPI STAGE 1
    console.log(
      `[stage1] CREDITI LINKDAPI: ${creditsUsed} ` +
      `(search/people: 1 × ${COST_SEARCH_PEOPLE} = ${COST_SEARCH_PEOPLE}, ` +
      `profile/overview: ${overviewCalls} × ${COST_PROFILE_OVERVIEW} = ${overviewCalls * COST_PROFILE_OVERVIEW})`,
    );

    // STEP 5: insert in search_results
    const rows = final.map((p) => ({
      search_id: searchId,
      linkedin_urn: p.urn,
      linkedin_url: p.url,
      full_name: p.fullName,
      headline: p.headline,
      location: p.location,
      follower_count: p.followerCount,
      match_score: null,
      saved_to_crm: false,
    }));

    if (rows.length > 0) {
      const { error: insertError } = await supabase
        .from("search_results")
        .insert(rows);
      if (insertError) {
        throw new Error(`Failed to insert results: ${insertError.message}`);
      }
    }

    return new Response(
      JSON.stringify({
        inserted: rows.length,
        prefiltered: preFiltered.length,
        blacklisted,
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
