//stage1-search/index.ts

import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { getLeadProvider } from "../_shared/lead-providers/index.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const BATCH_SIZE = 25;
const BATCH_PAUSE_MS = 61_000;
const TARGET_CANDIDATES = 40;

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

Deno.serve(async (req) => {
  try {
    const body = await req.json().catch(() => null);

    if (!body?.filters) {
      return new Response(
        JSON.stringify({ error: "Missing required field: filters" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const { searchId, filters } = body as {
      searchId: string;
      filters: {
        keyword?: string;
        title?: string;
        geoUrns?: string[];
        industry?: string[];
        language?: string;
        maxFollowers?: number | null;
        behavioralCriteria?: string[];
      };
    };

    const provider = getLeadProvider();

    const rawProfiles = await provider.searchProfiles({
      keyword: filters.keyword,
      title: filters.title,
      geoUrns: filters.geoUrns,
      industry: filters.industry,
      language: filters.language,
      count: 50,
    });

    console.log(`[stage1] search/people: ${rawProfiles.length} profili grezzi`);

    const preFiltered = rawProfiles.filter((p) =>
      headlineMatchesTitle(p.headline ?? "", filters.title ?? "")
    );

    console.log(
      `[stage1] post-filtro headline: ${preFiltered.length}/${rawProfiles.length} ` +
        `(risparmio: ${(rawProfiles.length - preFiltered.length) * 2} crediti)`,
    );

    const toEnrich = preFiltered.length >= 15 ? preFiltered : rawProfiles;

    const enriched: Array<{
      urn: string;
      url: string;
      fullName: string;
      headline: string;
      location: string;
      followerCount: number;
    }> = [];

    for (let i = 0; i < toEnrich.length; i += BATCH_SIZE) {
      const batch = toEnrich.slice(i, i + BATCH_SIZE);

      const results = await Promise.all(
        batch.map(async (profile) => {
          try {
            const username =
              profile.url.split("/in/")[1]?.replace(/\/$/, "") ?? "";
            if (!username) return null;

            const overview = await provider.getProfileOverview(username);
            return {
              urn: overview.urn ?? profile.urn,
              url: profile.url,
              fullName: profile.fullName,
              headline: profile.headline,
              location: profile.location,
              followerCount: overview.followerCount ?? 0,
            };
          } catch {
            return null;
          }
        }),
      );

      enriched.push(...(results.filter(Boolean) as typeof enriched));

      if (i + BATCH_SIZE < toEnrich.length) {
        await sleep(BATCH_PAUSE_MS);
      }
    }

    const final = enriched
      .filter((p) => {
        if (
          filters.maxFollowers !== null &&
          filters.maxFollowers !== undefined
        ) {
          return p.followerCount <= filters.maxFollowers;
        }
        return true;
      })
      .slice(0, TARGET_CANDIDATES);

    console.log(`[stage1] candidati finali: ${final.length}`);

    if (final.length > 0) {
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

      const { error } = await supabase.from("search_results").insert(rows);
      if (error) throw error;
    }

    return new Response(
      JSON.stringify({
        totalFound: rawProfiles.length,
        prefiltered: preFiltered.length,
        afterFilter: final.length,
        inserted: final.length,
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
