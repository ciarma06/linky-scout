import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const CLAUDE_API_KEY = Deno.env.get("CLAUDE_API_KEY");

const MIN_BIO_LENGTH = 30;
const POSTS_PER_PROFILE = 3;
const POST_TEXT_LIMIT = 300;

function isScoreable(p: { bio: string | null; recent_posts: unknown; match_post?: string | null }): boolean {
  const bioLength = (p.bio ?? "").trim().length;
  const postsCount = Array.isArray(p.recent_posts) ? p.recent_posts.length : 0;
  const hasMatchPost = !!(p.match_post && p.match_post.trim().length > 0);
  // Un candidato comportamentale con match_post è SEMPRE scorabile:
  // il post che ha fatto match è già prova di pertinenza al tema.
  return bioLength >= MIN_BIO_LENGTH || postsCount >= 1 || hasMatchPost;
}

const BASE_SYSTEM_PROMPT = `You are an expert B2B sales analyst. You evaluate LinkedIn profiles against an ICP (Ideal Customer Profile) description.

You will receive a list of profiles and an ICP description. For each profile, evaluate how well it matches the ICP based on their headline, bio, and recent posts.

# BEHAVIORAL MATCH (field "matchPost")
Some profiles include a "matchPost" field: a post the person actually wrote that matched the search topic. This is STRONG evidence the person engages with the ICP topic — weight it heavily as a positive signal.
HOWEVER: matchPost proves TOPIC RELEVANCE, not correct SENTIMENT or role. You must still apply:
- USER vs SELLER disambiguation (someone posting about "lead quality" might SELL lead-gen services → still cap at 45)
- The actual ICP intent (e.g. if ICP wants people COMPLAINING about leads, a post PRAISING their lead tool is not a match)
A profile with a strong, on-sentiment matchPost can reach 85-95. A profile whose matchPost is off-sentiment or from a seller does NOT get the boost.`;

const OUTPUT_FORMAT_PROMPT = `# OUTPUT FORMAT
IMPORTANT: Return ONLY a valid JSON array, no markdown, no backticks, no explanation. Each element must have exactly these fields:
- index: number (same as input)
- match_score: number 0-100 (0=no match, 100=perfect match)
- match_reason: string (1-2 sentences explaining why this profile matches or doesn't match the ICP, be specific and reference actual content from their bio or posts)
- best_context: string (the single most relevant quote or sentence from their bio or posts to use as an outreach hook. Empty string if no relevant content found)`;

function buildSellerRule(intent: string): string {
  if (intent === "offers") {
    return `# SELLER RULE FOR THIS SEARCH
The ICP explicitly targets people who SELL or OFFER solutions on this topic (agencies, consultants, tool builders).
DO NOT apply the seller cap. People who sell solutions ARE the target.
Score them normally based on how well their offering matches the ICP.`;
  }
  if (intent === "both") {
    return `# SELLER RULE FOR THIS SEARCH
The ICP targets both people who live the problem AND people who offer solutions.
Apply no seller cap. Score based on topic relevance only.`;
  }
  return `# SELLER RULE FOR THIS SEARCH
The ICP targets people who EXPERIENCE or COMPLAIN about the topic (first-person, living the problem).
People who SELL solutions to this problem are NOT the target — apply the standard seller cap (max 45).`;
}

function buildSystemPrompt(behavioralIntent: string): string {
  return `${BASE_SYSTEM_PROMPT}

${buildSellerRule(behavioralIntent)}

${OUTPUT_FORMAT_PROMPT}`;
}

type RecentPost = {
  text?: string;
  postedAt?: string;
  url?: string;
};

type ScoreableCandidate = {
  id: string;
  full_name: string | null;
  headline: string | null;
  location: string | null;
  follower_count: number | null;
  bio: string | null;
  recent_posts: RecentPost[] | null;
  match_post?: string | null;
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
    const { searchId, icpPrompt, behavioralIntent = "expresses" } = body as {
      searchId?: string;
      icpPrompt?: string;
      behavioralIntent?: "expresses" | "offers" | "both";
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
        "id, full_name, headline, location, follower_count, bio, recent_posts, match_post",
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

    const scoreable = (candidates as ScoreableCandidate[]).filter(isScoreable);

    if (scoreable.length === 0) {
      return new Response(
        JSON.stringify({ message: "No scoreable candidates" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    const profileInput = scoreable.map((p, i) => {
      const posts = (Array.isArray(p.recent_posts) ? p.recent_posts as RecentPost[] : [])
        .slice(0, POSTS_PER_PROFILE)
        .map((post) => (post.text ?? "").slice(0, POST_TEXT_LIMIT))
        .filter(Boolean);

      const base = {
        i,
        headline: p.headline ?? "",
        location: p.location ?? "",
        followers: p.follower_count ?? 0,
        bio: (p.bio ?? "").slice(0, 1500),
        posts,
      };

      // Solo per candidati comportamentali: includi il post che ha fatto match
      const mp = (p.match_post ?? "").trim();
      return mp ? { ...base, matchPost: mp.slice(0, 500) } : base;
    });

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
        system: buildSystemPrompt(behavioralIntent),
        messages: [
          {
            role: "user",
            content: `ICP Description: ${icpPrompt}

Profiles to evaluate:
${JSON.stringify(profileInput, null, 2)}

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
        const candidate = scoreable[score.index];
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
        name: scoreable[s.index]?.full_name,
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
