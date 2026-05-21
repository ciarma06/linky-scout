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

// Soglia minima bio per considerare un profilo "scoreable".
// Sotto i 50 caratteri la bio è di solito solo una tagline ripetitiva
// dell'headline e non aggiunge segnale utile allo scoring.
const MIN_BIO_LENGTH = 50;

type ScoreItem = { i: number; s: number; r: string; c: string };

const SYSTEM_PROMPT = `Sei un analista B2B senior specializzato in lead qualification per outreach LinkedIn.

Il tuo compito: assegnare a ogni profilo uno score 0-100 che indica quanto matcha l'ICP fornito.

# RUBRICA DI SCORING (segui sempre queste bande)

**90-100 — Match perfetto**
- Headline, bio E post recenti confermano TUTTI i criteri dell'ICP (ruolo, settore, segnali comportamentali).
- C'è prova esplicita nei contenuti (non solo inferenza dal titolo).

**75-89 — Match forte**
- Ruolo e settore confermati. Almeno UN segnale comportamentale presente.
- Bio rilevante ma non tutti i criteri dell'ICP sono dimostrati.

**60-74 — Match plausibile ("forse buono")**
- Ruolo corretto. Settore corretto o adiacente. Pochi segnali comportamentali.
- Vale comunque la pena valutare per outreach, ma con messaggio generico.

**40-59 — Mismatch debole**
- Ruolo o settore divergono dall'ICP. Match solo superficiale.
- Outreach probabilmente inefficace.

**0-39 — Mismatch chiaro**
- Profilo fuori target (ruolo sbagliato, settore sbagliato, o profilo inattivo).
- Non vale crediti per outreach.

# PENALTY DETERMINISTICI (applica SEMPRE)
- Headline generica senza ruolo specifico (es. "Founder", "CEO & Founder" senza azienda chiara): -10
- Follower count incoerente con l'ICP (se specificato): -10
- Lingua dei post diversa da quella dell'ICP: -5

# ATTENZIONE — SETTORI FUORI ICP B2B
Se la headline o la bio indicano uno di questi settori, lo score MASSIMO è 35:
- Nonprofit, charity, ministry, religious organization
- Community/youth outreach, social work, advocacy
- Healthcare/medical practice (a meno che l'ICP non sia esplicitamente healthcare)
- Influencer, lifestyle brand, content creator (a meno che l'ICP non sia esplicitamente creator economy)

# REGOLE DI COMPORTAMENTO
1. **In dubbio scendi**: se non sei sicuro tra 75 e 80, scrivi 73. Tra 60 e 65, scrivi 58. La banda alta richiede prove.
2. **Non inventare**: se la bio non menziona qualcosa, non assumere che ci sia.
3. **best_context (campo c)**: scrivi UN aggancio concreto per il primo messaggio outreach, citando un fatto specifico dal profilo (un post, una posizione, un risultato). Max 200 caratteri. Se non ci sono agganci concreti, stringa vuota.
4. **match_reason (campo r)**: 1 frase, max 150 caratteri. Spiega il "perché" dello score citando il criterio chiave.

# FORMATO OUTPUT
Rispondi con SOLO un array JSON valido, nessun markdown, nessun testo prima/dopo.
Schema per ogni elemento: { "i": number, "s": number, "r": string, "c": string }
Dove "i" è l'indice del profilo nell'input (parte da 0).

# ESEMPIO DI SCORING BORDERLINE
ICP: "Founder di startup SaaS B2B che fa cold outreach su LinkedIn"
Profilo: headline "Co-Founder @ TechCo | We build dev tools", bio "Building developer tools for European teams", post: "Hiring a designer".

Output corretto: { "i": 0, "s": 67, "r": "Founder in tech B2B ma nessuna prova di SaaS o outreach diretto", "c": "" }

# ESEMPIO DI SETTORE FUORI ICP
ICP: "Founder di startup SaaS B2B"
Profilo: headline "Founder at Rising Star Outreach", bio "Nonprofit supporting children in need".

Output corretto: { "i": 0, "s": 18, "r": "Nonprofit charity, settore completamente fuori ICP B2B", "c": "" }`;

function parseScoreResponse(text: string): ScoreItem[] {
  const cleaned = text.replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const matches = cleaned.match(/\{[^{}]*"i"\s*:\s*\d+[^{}]*\}/g) ?? [];
    return matches
      .map((m) => {
        try {
          return JSON.parse(m);
        } catch {
          return null;
        }
      })
      .filter(Boolean) as ScoreItem[];
  }
}

/**
 * Decide se un profilo ha dati sufficienti per essere scorato da Claude.
 * Richiede: bio significativa (>= MIN_BIO_LENGTH caratteri) OPPURE almeno un post.
 * Profili senza nulla finiscono con match_score = null e label "Dati insufficienti".
 */
function isScoreable(p: {
  bio: string | null;
  recent_posts: unknown;
}): boolean {
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

    // --- ROUTING: separa profili scorabili da profili con dati insufficienti ---
    const scoreable = profiles.filter(isScoreable);
    const insufficient = profiles.filter((p) => !isScoreable(p));

    console.log(
      `[score] totale: ${profiles.length}, scorabili: ${scoreable.length}, dati insufficienti: ${insufficient.length}`,
    );

    // --- Marca subito i profili senza dati con label fissa ---
    // match_score resta NULL → il badge UI mostrerà "—".
    // match_reason spiega all'utente perché non c'è score.
    if (insufficient.length > 0) {
      await Promise.all(
        insufficient.map((p) =>
          supabase
            .from("search_results")
            .update({
              match_score: null,
              match_reason: "Dati insufficienti: bio e post non disponibili",
              best_context: "Apri il profilo LinkedIn per maggiori dettagli",
            })
            .eq("id", p.id)
        ),
      );
    }

    // Edge case: nessun profilo scorabile → esci senza chiamare Claude
    if (scoreable.length === 0) {
      return new Response(
        JSON.stringify({
          scored: 0,
          insufficient: insufficient.length,
          message: "No scoreable candidates",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    type RecentPost = { text?: string; postedAt?: string; url?: string };

    // L'indice `i` qui si riferisce alla posizione in `scoreable`, NON in `profiles`.
    // Importante per il mapping inverso degli score.
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

# PROFILI DA VALUTARE (${profileInput.length})
${JSON.stringify(profileInput)}

Restituisci l'array JSON di scoring per tutti i ${profileInput.length} profili.`;

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

    // --- Update batch: s.i è indice in `scoreable`, NON in `profiles` ---
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

    const topMatches = [...scores]
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
        insufficient: insufficient.length,
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
