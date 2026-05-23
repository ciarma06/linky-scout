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
const SCORE_THRESHOLD = 50;

type ScoreItem = { i: number; s: number; r: string; c: string };

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

# CRITICAL DISAMBIGUATION: USER vs SELLER OF THE ICP KEYWORD
The ICP describes BUYERS of a product/service. People who SELL that same product/service to others are NOT a match, even if they use the same keywords.

For ANY topic mentioned in the ICP (cold outreach, marketing, AI, lead gen, growth, SEO, etc.), distinguish:
- **USER (correct match)**: founder whose PRODUCT is something else. They USE the ICP topic as a method to grow their own business. Their bio/posts describe the topic as something they DO for themselves.
- **SELLER (wrong match, MAX score 45)**: founder whose PRODUCT IS the ICP topic. They SELL it as a service/tool to others. Their bio/posts describe the topic as their OFFERING.

Signal phrases that indicate a SELLER (apply cap at 45):
- "we book meetings for..."
- "we help companies with..."
- "done-for-you [topic]"
- "[topic] as a service"
- "we generate [leads/sales/meetings] for..."
- "I help B2B SaaS [grow/scale/get clients]"
- "outreach agency", "growth agency", "marketing agency", "lead gen agency"
- Product name explicitly contains the topic (e.g. "OutreachPro", "LeadEngine", "GrowthBot")

Examples:
- ICP "founders who do cold outreach" + profile "Founder of LeadGenAgency, we book meetings for SaaS" → score 45 (SELLER)
- ICP "founders who do cold outreach" + profile "Founder of HRTool, I do cold outreach to find customers" → score 80+ (USER)

# OUT-OF-ICP B2B SECTORS
If headline or bio indicate one of these sectors, MAX score 35:
- Nonprofit, charity, ministry, religious organization
- Community/youth outreach, social work, advocacy
- Healthcare/medical practice (unless ICP is explicitly healthcare)
- Influencer, lifestyle brand, content creator (unless ICP is explicitly creator economy)

# BEHAVIOR RULES
1. **When in doubt, go down**: if unsure between 75 and 80, write 73. Between 60 and 65, write 58. The high band requires proof.
2. **Don't invent**: if bio doesn't mention something, don't assume it's there.
3. **Evidence must be active, not passive**: "received a cold email", "replied to an outreach", "was pitched by X", "got a DM from Y" are NOT behavioral signals for doing outreach. Only count signals where the profile ACTIVELY does the action (sent, wrote, built, ran, tested, launched).
4. **best_context (field c)**: write ONE concrete hook for the first outreach message, citing a specific fact from the profile. Max 200 characters. Empty string if no concrete hook.
5. **match_reason (field r)**: 1 sentence, max 150 characters. Explain the "why" of the score citing the key criterion.
6. **ALWAYS WRITE IN ENGLISH**: match_reason and best_context must be in English regardless of ICP language.

# OUTPUT FORMAT
Respond with ONLY a valid JSON array, no markdown, no text before/after.
Schema per element: { "i": number, "s": number, "r": string, "c": string }
Where "i" is the profile index in the input (starts at 0).

# EXAMPLES

<example>
ICP: "Founder of B2B SaaS startup doing cold outreach on LinkedIn"
Profile: headline "Co-Founder @ TechCo | We build dev tools", bio "Building developer tools for European teams", post: "Hiring a designer".
Output: { "i": 0, "s": 67, "r": "Founder in B2B tech but no proof of SaaS or direct outreach", "c": "" }
</example>

<example>
ICP: "Founder of B2B SaaS doing cold outreach"
Profile: headline "Founder @ LeadFlow | Done-for-you LinkedIn outreach for SaaS", bio "We help B2B SaaS companies generate 50+ meetings/month via cold outreach"
Output: { "i": 0, "s": 42, "r": "SELLER of outreach services, not a user. Sells the ICP topic instead of using it", "c": "" }
</example>

<example>
ICP: "Founder of B2B SaaS"
Profile: headline "Founder at Rising Star Outreach", bio "Nonprofit supporting children in need".
Output: { "i": 0, "s": 18, "r": "Nonprofit charity, completely outside B2B ICP", "c": "" }
</example>

<example>
ICP: "Founder of B2B SaaS doing cold outreach on LinkedIn"
Profile: headline "Founder @ VoiceFlow | AI voice agents for sales teams", bio "Building voice AI to automate cold calls", post: "Got a cold email today using AI for personalization — interesting tactic."
Output: { "i": 0, "s": 55, "r": "SaaS founder but only passive outreach signal (received cold email), no active outreach proof", "c": "" }
</example>`;

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

    const scoreable = profiles.filter(isScoreable);
    const insufficient = profiles.filter((p) => !isScoreable(p));

    console.log(
      `[score] totale: ${profiles.length}, scorabili: ${scoreable.length}, dati insufficienti: ${insufficient.length}`,
    );

    if (scoreable.length === 0) {
      // Nessun profilo scorabile: elimina insufficient e termina
      const insufficientIds = insufficient.map((p) => p.id);
      if (insufficientIds.length > 0) {
        const { error: delErr } = await supabase
          .from("search_results")
          .delete()
          .in("id", insufficientIds);
        if (delErr) console.error(`[score] DELETE insufficient failed: ${delErr.message}`);
      }
      console.log(`[score] WARNING: nessun profilo scorabile, eliminati ${insufficientIds.length}`);
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

Return the JSON scoring array for all ${profileInput.length} profiles. Remember: respond in English. Apply USER vs SELLER disambiguation strictly.`;

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

    // Update batch
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

    // --- DELETE robusto: due query separate invece di .or() ---
    // Bug del precedente .or(): la sintassi PostgREST può non funzionare come atteso
    // con condizioni miste IS NULL e LT. Due DELETE separate sono garantite.

    // DELETE 1: profili con score < soglia
    const { data: deletedLowScore, error: delLowErr } = await supabase
      .from("search_results")
      .delete()
      .eq("search_id", searchId)
      .lt("match_score", SCORE_THRESHOLD)
      .select("id, match_score");

    if (delLowErr) {
      console.error(`[score] DELETE low score failed: ${delLowErr.message}`);
    }

    // DELETE 2: profili senza score (insufficient + eventuali bug)
    const { data: deletedNull, error: delNullErr } = await supabase
      .from("search_results")
      .delete()
      .eq("search_id", searchId)
      .is("match_score", null)
      .select("id");

    if (delNullErr) {
      console.error(`[score] DELETE null score failed: ${delNullErr.message}`);
    }

    const deletedLowCount = deletedLowScore?.length ?? 0;
    const deletedNullCount = deletedNull?.length ?? 0;
    const totalDeleted = deletedLowCount + deletedNullCount;

    console.log(
      `[score] DELETE: low_score=${deletedLowCount} (soglia ${SCORE_THRESHOLD}), ` +
      `null_score=${deletedNullCount}, totale_eliminati=${totalDeleted}`,
    );

    if (deletedLowScore && deletedLowScore.length > 0) {
      const scores = deletedLowScore.map((r) => r.match_score).sort((a, b) => b - a);
      console.log(`[score] score dei profili eliminati: ${scores.join(", ")}`);
    }

    const survivors = scores.filter((s) => s.s >= SCORE_THRESHOLD).length;

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
        deleted: totalDeleted,
        deletedLow: deletedLowCount,
        deletedNull: deletedNullCount,
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
