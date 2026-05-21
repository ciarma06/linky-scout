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

const BATCH_SIZE = 25;
const BATCH_PAUSE_MS = 61_000;
const SEARCH_COUNT = 50;        // profili richiesti a search/people
const TARGET_CANDIDATES = 40;   // candidati massimi inseriti in DB
const PREFILTER_FLOOR = 15;     // sotto questa soglia disabilitiamo il pre-filtro

// Token che, se presenti nella headline normalizzata, indicano profili
// fuori target B2B (nonprofit, charity, religioso, community work).
// Conservativa per evitare falsi negativi.
const HEADLINE_BLACKLIST = [
  "nonprofit",
  "non profit",
  "ministry",
  "ministries",
  "charity",
  "church",
  "religious",
  "youth outreach",
  "community outreach",
  "outreach worker",
  "outreach coordinator",
  "outreach ministries",
];

// Normalizza una stringa per matching case-insensitive senza accenti/punteggiatura.
const normalize = (s: string) =>
  s.toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// Matcher AND-tollerante: tutti i token del title devono essere presenti
// nella headline. Token <= 2 caratteri vengono ignorati.
const headlineMatchesTitle = (headline: string, title: string): boolean => {
  if (!title?.trim()) return true;
  if (!headline) return false;
  const h = normalize(headline);
  const tokens = normalize(title).split(" ").filter((t) => t.length > 2);
  if (tokens.length === 0) return true;
  return tokens.every((t) => h.includes(t));
};

// Matcher OR: basta UN token blacklisted per scartare il profilo.
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

    // --- STEP 1: search/people grezza (1 credito) ---
    const rawProfiles: ProfileBasic[] = await provider.searchProfiles({
      keyword,
      title,
      geoUrns,
      industry,
      language,
      count: SEARCH_COUNT,
    });

    console.log(`[stage1] search/people: ${rawProfiles.length} profili grezzi`);

    // --- STEP 2: PRE-FILTRO headline (title match + blacklist) ---
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
      `risparmio: ${(rawProfiles.length - preFiltered.length) * 2} crediti)`,
    );

    // Fallback: se il pre-filtro è troppo aggressivo, usiamo i grezzi.
    // Meglio rumore che zero risultati per ICP molto specifici.
    const toEnrich = preFiltered.length >= PREFILTER_FLOOR
      ? preFiltered
      : rawProfiles;

    if (toEnrich.length < preFiltered.length) {
      console.log(`[stage1] WARNING: pre-filtro disabilitato (sotto soglia ${PREFILTER_FLOOR})`);
    }

    // --- STEP 3: profile/overview SOLO sui survivors (2 crediti/cad) ---
    const enriched: Array<ProfileBasic & { followerCount: number }> = [];

    for (let i = 0; i < toEnrich.length; i += BATCH_SIZE) {
      const batch = toEnrich.slice(i, i + BATCH_SIZE);

      const results = await Promise.all(
        batch.map(async (p) => {
          try {
            const username = p.url.split("/in/")[1]?.replace(/\/$/, "") ?? "";
            if (!username) return null;
            const overview = await provider.getProfileOverview(username);
            return {
              ...p,
              urn: overview.urn ?? p.urn,
              followerCount: overview.followerCount ?? 0,
            };
          } catch {
            // Profilo non accessibile: lo saltiamo silenziosamente.
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

    // --- STEP 4: filtro hard sui followers (post-overview) ---
    const final = enriched
      .filter((p) => !maxFollowers || p.followerCount <= maxFollowers)
      .slice(0, TARGET_CANDIDATES);

    console.log(`[stage1] candidati finali: ${final.length}`);

    // --- STEP 5: insert in search_results ---
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
