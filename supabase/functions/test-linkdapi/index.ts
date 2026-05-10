import "@supabase/functions-js/edge-runtime.d.ts";
import { getLeadProvider } from "../_shared/lead-providers/index.ts";

Deno.serve(async (_req) => {
  try {
    const provider = getLeadProvider();

    // 1. Search profiles
    const profiles = await provider.searchProfiles({
      keyword: "B2B SaaS",
      title: "founder",
      language: "en",
      count: 5,
    });

    console.log("Raw profiles:", JSON.stringify(profiles))

    if (profiles.length === 0) {
      return Response.json(
        { error: "searchProfiles returned no results" },
        { status: 404 },
      );
    }

    const firstProfile = profiles[0];
    const firstUrn = firstProfile.urn;
    const firstUsername = firstProfile.url.split("/in/")[1]?.replace(/\/$/, "");

    if (!firstUsername) {
      return Response.json(
        { error: `Could not extract username from URL: ${firstProfile.url}` },
        { status: 500 },
      );
    }

    // 2. Profile overview, details and recent posts in parallel
    const [overview, details, posts] = await Promise.all([
      provider.getProfileOverview(firstUsername),
      provider.getProfileDetails(firstUrn),
      provider.getRecentPosts(firstUrn).catch(() => []),
    ]);

    return Response.json({ profiles, overview, details, posts });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
});
