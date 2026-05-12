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
        language?: string;
        maxFollowers?: number | null;
        behavioralCriteria?: string[];
      };
    };

    const provider = getLeadProvider();

    const profiles = await provider.searchProfiles({
      keyword: filters.keyword,
      title: filters.title,
      geoUrns: filters.geoUrns,
      language: filters.language,
      count: 50,
    });

    const overviews: Array<{
      urn: string;
      username: string;
      followerCount: number;
      profile: (typeof profiles)[number];
    }> = [];

    for (let i = 0; i < profiles.length; i += BATCH_SIZE) {
      const batch = profiles.slice(i, i + BATCH_SIZE);

      const batchResults = await Promise.all(
        batch.map(async (profile) => {
          try {
            const username =
              profile.url.split("/in/")[1]?.replace(/\/$/, "") ?? "";
            if (!username) return null;

            const overview = await provider.getProfileOverview(username);
            return {
              urn: profile.urn,
              username,
              followerCount: overview.followerCount,
              profile,
            };
          } catch {
            return null;
          }
        }),
      );

      overviews.push(
        ...(batchResults.filter(Boolean) as typeof overviews),
      );

      if (i + BATCH_SIZE < profiles.length) {
        await sleep(61000);
      }
    }

    const filtered = overviews.filter((item) => {
      if (
        filters.maxFollowers !== null &&
        filters.maxFollowers !== undefined
      ) {
        if (item.followerCount > filters.maxFollowers) return false;
      }

      const headline = item.profile.headline.toLowerCase();
      const titleKeyword = filters.title?.toLowerCase() ?? "";
      if (titleKeyword && !headline.includes(titleKeyword)) return false;

      return true;
    });

    const candidates = filtered.slice(0, 50);

    if (candidates.length > 0) {
      const rows = candidates.map((item) => ({
        search_id: searchId,
        linkedin_urn: item.urn,
        linkedin_url: item.profile.url,
        full_name: item.profile.fullName,
        headline: item.profile.headline,
        location: item.profile.location,
        follower_count: item.followerCount,
        match_score: null,
        saved_to_crm: false,
      }));

      await supabase.from("search_results").insert(rows);
    }

    return new Response(
      JSON.stringify({
        totalFound: profiles.length,
        afterFilter: candidates.length,
        candidates: candidates.map((c) => ({
          urn: c.urn,
          username: c.username,
          url: c.profile.url,
          fullName: c.profile.fullName,
          headline: c.profile.headline,
          location: c.profile.location,
          followerCount: c.followerCount,
        })),
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
