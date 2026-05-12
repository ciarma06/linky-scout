import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const CLAUDE_API_KEY = Deno.env.get("CLAUDE_API_KEY");

type RecentPost = {
  text?: string;
  postedAt?: string;
  url?: string;
};

type ProfileForClaude = {
  index: number;
  id: string;
  fullName: string | null;
  headline: string | null;
  location: string | null;
  followerCount: number | null;
  bio: string;
  recentPosts: Array<{ text: string | undefined; postedAt: string | undefined }>;
};

type ClaudeScore = {
  index: number;
  match_score: number;
  match_reason: string;
  best_context: string;
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
    const { searchId, icpPrompt } = body as {
      searchId?: string;
      icpPrompt?: string;
    };

    if (!searchId || !icpPrompt?.trim()) {
      return new Response(
        JSON.stringify({
          error: "Missing required fields: searchId and icpPrompt",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    if (!CLAUDE_API_KEY) {
      return new Response(
        JSON.stringify({ error: "CLAUDE_API_KEY not configured" }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }

    const { data: candidates, error } = await supabase
      .from("search_results")
      .select(
        "id, full_name, headline, location, follower_count, bio, recent_posts",
      )
      .eq("search_id", searchId);

    if (error) {
      throw new Error(`Failed to fetch candidates: ${error.message}`);
    }

    if (!candidates || candidates.length === 0) {
      return new Response(
        JSON.stringify({ message: "No candidates to score" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    type CandidateRow = {
      id: string;
      full_name: string | null;
      headline: string | null;
      location: string | null;
      follower_count: number | null;
      bio: string | null;
      recent_posts: RecentPost[] | null;
    };

    const profilesForClaude: ProfileForClaude[] = (candidates as CandidateRow[])
      .map((c, index) => ({
        index,
        id: c.id,
        fullName: c.full_name,
        headline: c.headline,
        location: c.location,
        followerCount: c.follower_count,
        bio: c.bio ?? "",
        recentPosts: Array.isArray(c.recent_posts)
          ? c.recent_posts.slice(0, 3).map((p) => ({
            text: p.text?.slice(0, 300),
            postedAt: p.postedAt,
          }))
          : [],
      }));

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": CLAUDE_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 8000,
        system:
          `You are an expert B2B sales analyst. You evaluate LinkedIn profiles against an ICP (Ideal Customer Profile) description.

You will receive a list of profiles and an ICP description. For each profile, evaluate how well it matches the ICP based on their headline, bio, and recent posts.

IMPORTANT: Return ONLY a valid JSON array, no markdown, no backticks, no explanation. Each element must have exactly these fields:
- index: number (same as input)
- match_score: number 0-100 (0=no match, 100=perfect match)
- match_reason: string (1-2 sentences explaining why this profile matches or doesn't match the ICP, be specific and reference actual content from their bio or posts)
- best_context: string (the single most relevant quote or sentence from their bio or posts to use as an outreach hook. Empty string if no relevant content found)`,
        messages: [
          {
            role: "user",
            content: `ICP Description: ${icpPrompt}

Profiles to evaluate:
${JSON.stringify(profilesForClaude, null, 2)}

Return a JSON array with one object per profile. Use the same index values as the input.`,
          },
        ],
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(`Claude error: ${JSON.stringify(err)}`);
    }

    const data = await response.json();
    let text: string = data.content[0].text.trim();

    // Rimuovi eventuali backtick markdown
    text = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();

    let scores: ClaudeScore[];
    try {
      scores = JSON.parse(text);
    } catch {
      // Prova a estrarre array anche se il JSON è troncato
      const match = text.match(/^\[[\s\S]*/);
      if (match) {
        // Aggiungi chiusura se troncato
        let partial = match[0];
        // Trova l'ultimo oggetto completo
        const lastComplete = partial.lastIndexOf('},');
        if (lastComplete > 0) {
          partial = partial.substring(0, lastComplete + 1) + ']';
          try {
            scores = JSON.parse(partial);
          } catch {
            throw new Error(`Failed to parse Claude response: ${text.substring(0, 200)}`);
          }
        } else {
          throw new Error(`Failed to parse Claude response: ${text.substring(0, 200)}`);
        }
      } else {
        throw new Error(`Failed to parse Claude response: ${text.substring(0, 200)}`);
      }
    }

    if (!Array.isArray(scores)) {
      throw new Error("Claude response is not an array");
    }

    await Promise.all(
      scores.map(async (score) => {
        const candidate = profilesForClaude[score.index];
        if (!candidate) return;

        await supabase
          .from("search_results")
          .update({
            match_score: score.match_score,
            match_reason: score.match_reason,
            best_context: score.best_context,
          })
          .eq("id", candidate.id);
      }),
    );

    const topMatches = [...scores]
      .sort((a, b) => b.match_score - a.match_score)
      .slice(0, 3)
      .map((s) => ({
        name: profilesForClaude[s.index]?.fullName,
        score: s.match_score,
        reason: s.match_reason,
      }));

    return new Response(
      JSON.stringify({
        scored: scores.length,
        searchId,
        topMatches,
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
