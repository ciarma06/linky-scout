//score-profiles/index.ts

import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const CLAUDE_API_KEY = Deno.env.get("CLAUDE_API_KEY");

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 5000;
const POST_TEXT_LIMIT = 250;
const POSTS_PER_PROFILE = 3;
const MIN_BIO_LENGTH = 50;

// Soglia minima di score sotto la quale i profili vengono ELIMINATI dal DB
// (non solo nascosti). Cambia la cache e la history di conseguenza.
const SCORE_THRESHOLD = 50;

type ScoreItem = { i: number; s: number; r: string; c: string };

// Prompt interamente in inglese: forza Claude a rispondere SEMPRE in inglese
// indipendentemente dalla lingua dell'ICP fornito dall'utente.
const SYSTEM_PROMPT = `You are a senior B2B analyst specializing in LinkedIn lead qualification for cold outreach.

Your task: assign each profile a score from 0-100 indicating how well it matches the given ICP.

# SCORING RUBRIC (always follow these bands)

**90-100 — Perfect match**
- Headline, bio AND recent posts confirm ALL ICP criteria (role, industry, behavioral signals).
- Explicit evidence in the content (not just inference from job title).

**75-89 — Strong match**
- Role and industry confirmed. At least ONE behavioral signal present.
- Bio is relevant but not all ICP criteria are demonstrated.

**60-74 — Plausible match ("maybe good")**
- Correct role. Correct or adjacent industry. Few behavioral signals.
- Worth evaluating for outreach, but with a generic message.

**40-59 — Weak mismatch**
- Role or industry diverges from ICP. Only superficial match (e.g. keyword in headline).
- Outreach likely ineffective.

**0-39 — Clear mismatch**
- Off-target profile (wrong role, wrong industry, or inactive profile).
- Not worth credits for outreach.

# DETERMINISTIC PENALTIES (always apply)
- Generic headline without specific role (e.g. "Founder", "CEO & Founder" without clear company): -10
- Follower count incoherent with ICP (if specified): -10
- Post language different from ICP language: -5

# OUT-OF-ICP B2B SECTORS
If headline or bio indicate one of these sectors, the MAXIMUM score is 35:
- Nonprofit, charity, ministry, religious organization
- Community/youth outreach, social work, advocacy
- Healthcare/medical practice (unless ICP is explicitly healthcare)
- Influencer, lifestyle brand, content creator (unless ICP is explicitly creator economy)

# BEHAVIOR RULES
1. **When in doubt, go down**: if unsure between 75 and 80, write 73. Between 60 and 65, write 58. The high band requires proof.
2. **Don't invent**: if bio doesn't mention something, don't assume it's there.
3. **best_context (field c)**: write ONE concrete hook for the first outreach message, citing a specific fact from the profile (a post, a position, a result). Max 200 characters. Empty string if no concrete hook.
4. **match_reason (field r)**: 1 sentence, max 150 characters. Explain the "why" of the score citing the key criterion.
5. **ALWAYS WRITE IN ENGLISH**: match_reason and best_context must be in English, regardless of the language of the ICP.

# OUTPUT FORMAT
Respond with ONLY a valid JSON array, no markdown, no text before/after.
Schema per element: { "i": number, "s": number, "r": string, "c": string }
Where "i" is the profile index in the input (starts at 0).

# BORDERLINE SCORING EXAMPLE
ICP: "Founder of B2B SaaS startup doing cold outreach on LinkedIn"
Profile: headline "Co-Founder @ TechCo | We build dev tools", bio "Building developer tools for European teams", post: "Hiring a designer".

Correct output: { "i": 0, "s": 67, "r": "Founder in B2B tech but no proof of SaaS or direct outreach", "c": "" }

# OUT-OF-ICP SECTOR EXAMPLE
ICP: "Founder of B2B SaaS startup"
Profile: headline "Founder at Rising Star Outreach", bio "Nonprofit supporting children in need".

Correct output: { "i": 0, "s": 18, "r": "Nonprofit charity, completely outside B2B ICP", "c": "" }`;

function parseScoreResponse(text: string): ScoreItem[] {
  const cleaned = text.replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const matches = cleaned.match(/\{[^{}]*"i"\s*:\s*\d+[^{}]*\}/g) ?? [];
    return matches
      .map((m) => {
        try { return JSON.parse(m); } catch { return null; }
      })
      .filter(Boolean) as ScoreItem[];
  }
}

function isScoreable(p: { bio: string | null; recent_posts: unknown }): boolean {
  const bioLength = (p.bio ?? "").trim().length;
  const postsCount = Array.isArray(p.recent_posts) ? p.recent_posts.length : 0;
  return bioLength >= MIN_BIO_LENGTH || postsCount >= 1;
}

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
        JSON.stringify({ error: "Missing required fields: searchId and icpPrompt" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    if (!CLAUDE_API_KEY) {
      return new Response(
        JSON.stringify({ error: "CLAUDE_API_KEY not configured" }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }

    const { data: profiles, error } = await supabase
      .from("search_results")
      .select("id, full_name, headline, location, follower_count, bio, recent_posts")
      .eq("search_id", searchId)
      .order("created_at", { ascending: true });

    if (error) {
      throw new Error(`Failed to fetch candidates: ${error.message}`);
    }

    if (!profiles || profiles.length === 0) {
      return new Response(
        JSON.stringify({ scored: 0, message: "No candidates to score" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Routing: separa scorabili da non-scorabili. I non-scorabili saranno
    // eliminati alla fine insieme ai profili con score basso.
    const scoreable = profiles.filter(isScoreable);
    const insufficient = profiles.filter((p) => !isScoreable(p));

    console.log(
      `[score] totale: ${profiles.length}, scorabili: ${scoreable.length}, dati insufficienti: ${insufficient.length}`,
    );

    // Edge case: nessun profilo scorabile
    if (scoreable.length === 0) {
      // Elimina i profili insufficient e termina
      const insufficientIds = insufficient.map((p) => p.id);
      if (insufficientIds.length > 0) {
        await supabase.from("search_results").delete().in("id", insufficientIds);
      }
      console.log(`[score] WARNING: nessun profilo scorabile, eliminati ${insufficientIds.length} insufficient`);
      return new Response(
        JSON.stringify({ scored: 0, deleted: insufficientIds.length }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    type RecentPost = { text?: string; postedAt?: string; url?: string };

    const profileInput = scoreable.map((p, i) => {
      const posts = (Array.isArray(p.recent_posts) ? p.recent_posts as RecentPost[] : [])
        .slice(0, POSTS_PER_PROFILE)
        .map((post) => (post.text ?? "").slice(0, POST_TEXT_LIMIT))
        .filter(Boolean);

      return {
        i,
        headline: p.headline ?? "",
        location: p.location ?? "",
        followers: p.follower_count ?? 0,
        bio: (p.bio ?? "").slice(0, 1500),
        posts,
      };
    });

    const userMessage = `# ICP TARGET
${icpPrompt}

# PROFILES TO EVALUATE (${profileInput.length})
${JSON.stringify(profileInput)}

Return the JSON scoring array for all ${profileInput.length} profiles. Remember: respond in English.`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": CLAUDE_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMessage }],
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(`Claude error: ${JSON.stringify(err)}`);
    }

    const data = await response.json();
    const rawText = (data.content as Array<{ type: string; text?: string }>)
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");

    const scores = parseScoreResponse(rawText);
    console.log(`[score] ricevuti ${scores.length}/${profileInput.length} score`);

    if (!Array.isArray(scores) || scores.length === 0) {
      throw new Error(`Failed to parse Claude response: ${rawText.substring(0, 200)}`);
    }

    // Update batch: l'indice s.i si riferisce a `scoreable`
    await Promise.all(
      scores.map(async (s) => {
        const profile = scoreable[s.i];
        if (!profile) return;
        await supabase
          .from("search_results")
          .update({
            match_score: s.s,
            match_reason: s.r,
            best_context: s.c,
          })
          .eq("id", profile.id);
      }),
    );

    // --- DELETE finale: rimuove insufficient + score sotto soglia ---
    // Cosa elimina: profili con match_score IS NULL (non scorati = insufficient)
    // OPPURE match_score < SCORE_THRESHOLD. La cache e la history conterranno
    // solo i profili sopra soglia.
    const { data: deleted, error: deleteError } = await supabase
      .from("search_results")
      .delete()
      .eq("search_id", searchId)
      .or(`match_score.is.null,match_score.lt.${SCORE_THRESHOLD}`)
      .select("id");

    if (deleteError) {
      console.error(`[score] errore DELETE: ${deleteError.message}`);
    }

    const deletedCount = deleted?.length ?? 0;
    const survivors = scores.filter((s) => s.s >= SCORE_THRESHOLD).length;

    console.log(
      `[score] eliminati ${deletedCount} profili (insufficient + score < ${SCORE_THRESHOLD}), ` +
      `sopravvissuti ${survivors}/${scores.length} scorati`,
    );

    // topMatches calcolato sui sopravvissuti (>= 50)
    const topMatches = [...scores]
      .filter((s) => s.s >= SCORE_THRESHOLD)
      .sort((a, b) => b.s - a.s)
      .slice(0, 3)
      .map((s) => ({
        name: scoreable[s.i]?.full_name,
        score: s.s,
        reason: s.r,
      }));

    return new Response(
      JSON.stringify({
        scored: scores.length,
        survivors,
        deleted: deletedCount,
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
