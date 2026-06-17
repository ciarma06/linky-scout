// supabase/functions/score-profiles/index.ts

import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const CLAUDE_API_KEY = Deno.env.get("CLAUDE_API_KEY");

const MIN_BIO_LENGTH = 30;
const POSTS_PER_PROFILE = 3;
const POST_TEXT_LIMIT = 600;

// Cap applicato SOLO quando il testo del COMMENTO/matchPost è esso stesso un
// sales pitch (matchpost_is_pitch=true) in una ricerca "expresses". Lo teniamo
// SOTTO la DELETE_THRESHOLD di expresses (30) così chi fa pubblicità nei
// commenti viene RIMOSSO, non tenuto al minimo. Un vendor il cui commento è una
// lamentela genuina NON viene cappato (lo giudica lo scoring sul merito).
const COMMENT_PITCH_CAP_FOR_EXPRESSES = 20;

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
Some profiles include a "matchPost" field: a post or comment the person actually wrote that surfaced for the search topic. This is STRONG evidence the person engages with the ICP topic — weight it heavily as a positive signal.
HOWEVER: matchPost proves TOPIC RELEVANCE, not correct SENTIMENT or role. You must still judge sentiment and role against the ICP (e.g. if the ICP wants people COMPLAINING about leads, a post PRAISING a lead tool is not a match).

# DUAL-SIGNAL SCORING (behavioral commenter searches)
When a profile comes from a comment (matchPost is a comment under someone else's post), evaluate TWO independent signals:

1. COMMENT SIGNAL — does the comment text itself express the ICP intent?
   "we're drowning in unqualified leads" is a STRONG comment signal. A short/generic comment like "Interested", "Send", "+1", "Great post" is a WEAK comment signal — BUT a weak comment is NOT disqualifying: commenting on a topic-relevant post is itself a behavioral signal of category interest.

2. BIO SIGNAL — do the headline and bio match the ICP target (role, industry, seniority, context)?

SCORING RULE: take the STRONGER of the two signals as the primary driver; do NOT average them down.
- Strong comment signal (on-sentiment) + on-ICP role → 70-95
- Weak comment + strong on-ICP bio → 55-75
- Weak comment + weak/adjacent bio → 35-50
- No usable signal in either → below 35

ROLE FIT vs an ICP-SPECIFIED ROLE:
If the ICP names a specific target role (e.g. "founders", "CEOs"), the comment author often does NOT hold that exact role — in a commenter search you frequently surface adjacent roles (e.g. an HR manager or recruiter commenting on a hiring post for a "founders" ICP). Apply this ceiling:
- On-sentiment comment + role MATCHES the named ICP role → 70-95.
- On-sentiment comment + role is OFF the named ICP role (genuine pain, wrong persona) → 50-65. They prove the problem is real and can be useful for outreach, but they are NOT the exact target — do not score them as a perfect match.
- If the ICP names NO specific role, ignore this ceiling and judge on sentiment + general fit.

# SELLER / VENDOR HANDLING — two SEPARATE judgments
You MUST set two independent boolean fields. Do NOT conflate them.

1. is_selling_solution (about the PERSON / bio / profile)
Set true when the person promotes, sells, or builds a product/service/solution related to the ICP topic (from bio, headline, or their own posts) — even if they also describe pain points.
Strong signals (any one is enough): launching/founding/announcing a product ("we built X", "introducing X", "just shipped"); first-person vendor language ("our platform/tool", "my agency helps", "I help [audience] with [service]"); consultant/agency positioning; demo/waitlist/beta/pricing/CTA for their own offering.
Set false for a practitioner/end-user living the problem without pitching their own solution.
seller_evidence: if true, the shortest phrase that proves it; else empty string.

2. matchpost_is_pitch (about the COMMENT / matchPost TEXT ONLY)
Set true when the matchPost/comment TEXT ITSELF is a promotion: it advertises a product/service, announces a launch, or pushes a CTA ("we built X to fix this, DM me", "check out our platform [link]", "introducing X").
Set false when the comment text is a genuine first-person expression, opinion, question, or complaint — EVEN IF the person's bio shows they are a vendor.
Examples:
- comment "ugh, hiring senior engineers has been impossible for months" → matchpost_is_pitch=false (genuine complaint)
- comment "same here, recruiting is broken right now" → false
- comment "we built HireFast to solve exactly this — book a demo" → true (pitch)
- comment "great point! our tool does this automatically [link]" → true

CRITICAL for "expresses" intent: is_selling_solution=true does NOT by itself disqualify or cap a profile. A builder who genuinely lives the problem (vendor bio, but a sincere first-person complaint in the comment) is STILL a valid lead — score them on the strength of that genuine signal. Only matchpost_is_pitch=true marks someone using the thread to advertise rather than to express the pain; that case is handled downstream.`;

const ICP_CLASSIC_SYSTEM_PROMPT = `You are an expert B2B sales analyst. You evaluate LinkedIn profiles against an ICP (Ideal Customer Profile) description.

You receive a list of profiles and an ICP description. For each profile, evaluate how well it matches the ICP based on their headline, bio, and recent posts.

# SCORING RUBRIC (profile-based ICP search)
This is a classical ICP search: profiles come from LinkedIn profile search filters (role, industry, geography, follower range). There is no behavioral signal — evaluate fit purely from headline, bio, and recent posts.

Use the FULL 0-100 range. Do NOT cap scores artificially.

- 90-100: Perfect ICP match. Role, industry, seniority, geography, and any explicit constraints (like follower range) ALL align. Bio and headline clearly confirm the target persona. Recent posts (if any) show the person is active and on-topic.
- 80-89: Strong match. All hard criteria met (role, industry, geo); bio is on-target; minor gaps possible (e.g., recent activity unclear, or one secondary attribute slightly off).
- 70-79: Good match. Core criteria met but with one clear gap (e.g., right role but in adjacent industry, or right industry but unclear seniority).
- 60-69: Partial match. Two or more criteria are weak or unclear.
- 40-59: Weak match. Major mismatch on at least one core criterion.
- 0-39: Poor or no match.

# IMPORTANT — founders pitching their OWN product
A founder who promotes their own SaaS in their bio (e.g., "we built X", "introducing X", "founder of Y") is NOT a seller in this context — they ARE the target audience. Do NOT penalize them.
The seller concept applies only to OUTSIDE vendors selling TO the ICP (e.g., an agency owner who sells outreach services to SaaS founders). And even then, no automatic cap is applied for profile-based searches.

# SELLER FIELDS (mostly false for profile-based searches)
Set is_selling_solution=true ONLY when the profile is clearly an outside vendor targeting the ICP audience (and the ICP is the buyer, not the seller).
When the profile IS the ICP (e.g., the ICP is "SaaS founders" and the person is a SaaS founder pitching their own SaaS), set is_selling_solution=false.
When in doubt, set false.

matchpost_is_pitch is always false for profile-based searches (there is no comment).

# OUTPUT FIELDS
- index, match_score (0-100), match_reason (1-2 sentences referencing specific bio/post content), best_context (most relevant quote for outreach)
- is_selling_solution: see above
- seller_evidence: "" unless is_selling_solution=true
- matchpost_is_pitch: always false here
- comment_signal: "none" (no comments in profile-based search)
- bio_signal: "strong" | "weak" | "none" — rate honestly`;

const OUTPUT_FORMAT_PROMPT = `# OUTPUT FORMAT

IMPORTANT: Return ONLY a valid JSON array, no markdown, no backticks, no explanation. Each element must have exactly these fields:

- index: number (same as input)
- match_score: number 0-100 (0=no match, 100=perfect match)
- match_reason: string (1-2 sentences explaining why this profile matches or doesn't match the ICP, be specific and reference actual content from their bio or posts)
- best_context: string (the single most relevant quote or sentence from their bio or posts to use as an outreach hook. Empty string if no relevant content found)
- is_selling_solution: boolean (true if this PERSON sells/offers/builds solutions on the ICP topic, judged from bio/headline/their own posts — see SELLER / VENDOR HANDLING)
- seller_evidence: string (short quote proving seller status; empty string if is_selling_solution is false)
- matchpost_is_pitch: boolean (true ONLY if the matchPost/comment TEXT ITSELF is a promotion/launch/CTA; false for a genuine first-person comment even if the person is a vendor; always false when there is no matchPost)
- comment_signal: string ("strong" if the matchPost/comment itself clearly expresses the ICP intent; "weak" if it hints at interest but is short or generic like "interested"/"send"/"+1"; "none" if no usable signal in the comment)
- bio_signal: string ("strong" if headline+bio clearly match the ICP target role and context; "weak" if partial/adjacent match; "none" if unrelated)`;

function buildSellerRule(intent: string): string {
  if (intent === "offers") {
    return `# SELLER RULE FOR THIS SEARCH
The ICP explicitly targets people who SELL or OFFER solutions on this topic (agencies, consultants, tool builders).
People who sell solutions ARE the target. Classify is_selling_solution accurately — sellers should typically have is_selling_solution=true.
Score normally based on how well their offering matches the ICP. matchpost_is_pitch may be true here and does NOT harm the score.`;
  }
  if (intent === "both") {
    return `# SELLER RULE FOR THIS SEARCH
The ICP targets both people who live the problem AND people who offer solutions.
Classify is_selling_solution and matchpost_is_pitch accurately for every profile. Score normally based on topic relevance — both end-users and sellers can be good matches.`;
  }
  return `# SELLER RULE FOR THIS SEARCH
The ICP targets people who EXPERIENCE or COMPLAIN about the topic (first-person, living the problem) — NOT vendors broadcasting an offer.
Classify is_selling_solution and matchpost_is_pitch accurately for every profile. Score each profile on the genuine strength of their pain signal as an end-user/practitioner. A vendor (is_selling_solution=true) who writes a SINCERE first-person complaint is still a valid lead — score on merit, do not penalize for the bio alone. Only a comment that is itself an advertisement (matchpost_is_pitch=true) is disqualifying; that is enforced downstream, so your job is accurate classification + honest match_score.`;
}

function buildSystemPrompt(searchMode: string, behavioralIntent: string): string {
  if (searchMode === "profile") {
    return `${ICP_CLASSIC_SYSTEM_PROMPT}\n\n${OUTPUT_FORMAT_PROMPT}`;
  }
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
  is_selling_solution: boolean;
  seller_evidence: string;
  matchpost_is_pitch: boolean;
  comment_signal: "strong" | "weak" | "none";
  bio_signal: "strong" | "weak" | "none";
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
    const { searchId, icpPrompt, behavioralIntent = "expresses", searchMode = "profile" } = body as {
      searchId?: string;
      icpPrompt?: string;
      behavioralIntent?: "expresses" | "offers" | "both";
      searchMode?: "profile" | "behavioral";
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

    const DELETE_THRESHOLD =
      searchMode === "profile" ? 40 :
      behavioralIntent === "expresses" ? 30 :
      50;

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
        system: buildSystemPrompt(searchMode, behavioralIntent),
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

    const enforcedScores: ClaudeScore[] = scores.map((score) => {
      if (
        searchMode === "behavioral" &&
        behavioralIntent === "expresses" &&
        score.matchpost_is_pitch === true
      ) {
        const capped = Math.min(score.match_score, COMMENT_PITCH_CAP_FOR_EXPRESSES);
        console.log(
          `[score-profiles] comment-pitch cap applied: index=${score.index} original=${score.match_score} capped=${capped} seller=${score.is_selling_solution} evidence="${score.seller_evidence ?? ""}"`,
        );
        return { ...score, match_score: capped };
      }
      console.log(
        `[score-profiles] signals: index=${score.index} score=${score.match_score} ` +
        `comment=${score.comment_signal} bio=${score.bio_signal} seller=${score.is_selling_solution} pitch=${score.matchpost_is_pitch}`,
      );
      return score;
    });

    await Promise.all(
      enforcedScores.map(async (score) => {
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

    console.log(
      `[score-profiles] DELETE threshold: ${DELETE_THRESHOLD} (searchMode="${searchMode}", behavioralIntent="${behavioralIntent}")`,
    );

    // search_results FK: search_id → searches (not job_id)
    const { error: deleteLowError } = await supabase
      .from("search_results")
      .delete()
      .eq("search_id", searchId)
      .lt("match_score", DELETE_THRESHOLD);

    if (deleteLowError) {
      throw new Error(`Failed to delete low scores: ${deleteLowError.message}`);
    }

    const { error: deleteNullError } = await supabase
      .from("search_results")
      .delete()
      .eq("search_id", searchId)
      .is("match_score", null);

    if (deleteNullError) {
      throw new Error(`Failed to delete unscored results: ${deleteNullError.message}`);
    }

    const topMatches = [...enforcedScores]
      .filter((s) => s.match_score >= 50)
      .sort((a, b) => b.match_score - a.match_score)
      .slice(0, 3)
      .map((s) => ({
        name: scoreable[s.index]?.full_name,
        score: s.match_score,
        reason: s.match_reason,
      }));

    return new Response(
      JSON.stringify({
        scored: enforcedScores.length,
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
