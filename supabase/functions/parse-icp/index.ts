import "@supabase/functions-js/edge-runtime.d.ts";

const CLAUDE_API_KEY = Deno.env.get("CLAUDE_API_KEY");
const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 600;

// System prompt: role specifico (compiler) + linguaggio diretto.
// Niente "expert" generico, niente "helpful".
const SYSTEM_PROMPT = `You are a LinkedIn search filter compiler. Your job: convert a user's ICP description into structured search parameters that LinkdAPI accepts. You output ONLY the requested XML structure, nothing else.`;

// User message: XML-structured con <task>, <field_specs>, <mappings>, <examples>, <output_format>.
// Esempi pensati per coprire 4 casi diversi: tech B2B, fintech UK, behavioral stealth, fashion/B2C edge case.
const buildUserMessage = (icp: string) => `<task>
Convert the ICP description below into LinkedIn search filters. Output a valid JSON object wrapped in <filters>...</filters> tags. Do not output anything else.
</task>

<field_specs>
- keyword (string, 1-3 words): topic/industry term that founders in this ICP use IN THEIR LINKEDIN HEADLINE. NOT a literal copy of the user's words. Translate user intent into LinkedIn vernacular. Empty string if no clear keyword.
- title (string, 1-2 words): job title token, lowercase. Common values: "founder", "ceo", "cto", "head", "vp", "director". Empty string if not specified.
- geoUrns (string array): LinkedIn geo IDs ONLY for countries listed in <mappings>. If user mentions a country not in mappings, omit it. If the user specifies NO country at all, use the DEFAULT_GEO set (see <mappings>). Never return an empty geoUrns array.
- industry (string array): LinkedIn industry IDs ONLY for industries listed in <mappings>. Omit if no clear match. Empty array if not applicable.
- language (string): "en" for English-speaking ICPs, "it" for Italian, "fr" for French, "de" for German, "es" for Spanish. Empty string if not specified.
- maxFollowers (number or null): if user says "under Xk" or "less than X" followers, return X*1000 or X. Null if not mentioned.
- behavioralCriteria (string array): behavioral signals (max 4 items, each max 5 words) that score-profiles will look for in bio/posts. Empty array if none mentioned.
- searchMode (string): "behavioral" if the ICP describes something the person ACTIVELY EXPRESSES IN POSTS (complaints, opinions, announcements, stories they'd write about — e.g. "founders complaining about lead quality", "CEOs posting about hiring struggles", "founders sharing revenue numbers"). "profile" otherwise (role, industry, static attributes, or silent actions that don't necessarily get posted — e.g. "SaaS founder in UK", "founder who does cold outreach"). When unsure, use "profile" (the safe default).
- postKeyword (string): ONLY if searchMode is "behavioral". 1-3 words that would literally appear in a post about this topic — but phrased the way the TARGET writes it, NOT as a neutral industry label. Neutral topic words (e.g. "hiring", "leads", "sales") surface low-engagement thought-leadership posts with almost no comments; problem/symptom phrasing surfaces posts where people actually discuss it and generate comments.
  - For behavioralIntent "expresses": symptom/frustration phrasing a sufferer writes. ICP "founders complaining about lead quality" → "unqualified leads" (NOT "lead quality"); ICP "founders struggling to hire" → "can't find talent" (NOT "hiring").
  - For behavioralIntent "offers": the service/solution phrasing a vendor writes — e.g. "cold outreach", "we book meetings".
  Empty string if searchMode is "profile".
- postKeywordAlternatives (string array): ONLY if searchMode is "behavioral".
  3-4 alternative phrases, DISTINCT from postKeyword and from each other, that
  surface posts generating DISCUSSION among people who LIVE the problem (not
  sellers). Prefer emotional/symptom language a sufferer uses in a post or
  comment but a seller would avoid. Each 1-4 words. Empty array if "profile".
  Example for "founders complaining about lead quality" (primary "unqualified leads"):
  ["leads not converting", "wasted ad spend", "leads going nowhere", "cold leads only"]
- behavioralIntent (string): ONLY if searchMode is "behavioral". Who you want among people posting about the topic:
  "expresses" = people who LIVE the problem (complaints, frustrations, first-person stories — "struggling with X", "frustrated by X", "can't figure out X")
  "offers" = people who SELL solutions to the problem (agencies, consultants, tool builders — "I help companies with X", "we solve X")
  "both" = no distinction needed
  Default to "expresses" when behavioral and intent is unclear. Empty string if searchMode is "profile".
</field_specs>

<mappings>
GEO URNS (use only these):
- USA / United States: "103644278"
- UK / United Kingdom: "101165590"
- Germany: "101282230"
- France: "105015875"
- Italy: "103350119"
- Spain: "105646813"
- Netherlands: "102890719"
- Canada: "101174742"
- Australia: "101452733"
- India: "102713980"
- Europe (broad): use UK + Germany + France + Italy + Spain + Netherlands together

DEFAULT_GEO (use these 9 IDs when the user specifies no country):
["103644278","101165590","101174742","101452733","101282230","105015875","103350119","105646813","102890719"]
(= USA, UK, Canada, Australia, Germany, France, Italy, Spain, Netherlands)

INDUSTRY IDS (use only these, omit if uncertain):
- SaaS / Software / B2B Software: "4"
- IT Services: "96"
- Internet / Online platforms: "6"
- Marketing & Advertising: "80"
- Financial Services / Fintech: "43"
- Banking: "41"
- Insurance: "42"
- E-commerce / Retail: "27"
- Media (Publishing): "82"
- Media Production: "126"
- Entertainment: "28"
- Telecommunications: "8"
- Management Consulting: "11"
- Education / E-Learning: "132"
- Venture Capital / Private Equity: "106"
- Pharmaceuticals: "15"
- Biotechnology: "12"
- Renewable Energy: "60"
- Real Estate: "44"
- Manufacturing: "56"
- Hospitality: "31"
- Healthcare: "14"

KEYWORD TRANSLATION RULES (use these when applicable):
- "stealth founder" / "building new thing" / "next venture" → keyword: "stealth"
- "bootstrapped" / "no funding" / "indie hacker" → keyword: "bootstrapped"
- "early stage" / "pre-seed" / "just started" → keyword: "founder" (the stage is behavioral, not in headline)
- "agency owner" → keyword: "agency"
- generic SaaS founder → keyword: "SaaS"
- generic B2B → keyword: "B2B"
</mappings>

<examples>
<example>
<input>Founder of B2B SaaS startup in the US, less than 10k followers, does cold outreach himself</input>
<output><filters>{"keyword":"SaaS","title":"founder","geoUrns":["103644278"],"industry":["4"],"language":"en","maxFollowers":10000,"behavioralCriteria":["does cold outreach personally","writes own messages"]}</filters></output>
</example>

<example>
<input>CEOs of fintech companies in UK or Germany, bootstrapped</input>
<output><filters>{"keyword":"bootstrapped","title":"ceo","geoUrns":["101165590","101282230"],"industry":["43"],"language":"en","maxFollowers":null,"behavioralCriteria":["bootstrapped","no external funding"]}</filters></output>
</example>

<example>
<input>Founder "Building my next thing", Europe/USA/UK, less than 15k followers</input>
<output><filters>{"keyword":"stealth","title":"founder","geoUrns":["103644278","101165590","101174742","101452733","101282230","105015875","103350119","105646813","102890719"],"industry":[],"language":"en","maxFollowers":15000,"behavioralCriteria":["building stealth project","between ventures","working on new idea"]}</filters></output>
</example>

<example>
<input>fondatori di startup di moda in italia con meno di 20k follower</input>
<output><filters>{"keyword":"fashion","title":"founder","geoUrns":["103350119"],"industry":[],"language":"it","maxFollowers":20000,"behavioralCriteria":[]}</filters></output>
</example>

<example>
<input>Founder-led sales, less than 50k followers</input>
<output><filters>{"keyword":"founder","title":"founder","geoUrns":["103644278","101165590","101174742","101452733","101282230","105015875","103350119","105646813","102890719"],"industry":[],"language":"en","maxFollowers":50000,"behavioralCriteria":["runs sales personally","founder-led sales motion"]}</filters></output>
</example>

<example>
<input>Founders complaining about the quality of their leads</input>
<output><filters>{"keyword":"founder","title":"founder","geoUrns":["103644278","101165590","101174742","101452733","101282230","105015875","103350119","105646813","102890719"],"industry":[],"language":"en","maxFollowers":null,"behavioralCriteria":["complains about lead quality","frustrated with unqualified leads"],"searchMode":"behavioral","postKeyword":"unqualified leads","postKeywordAlternatives":["leads not converting","wasted ad spend","leads going nowhere","cold leads only"],"behavioralIntent":"expresses"}</filters></output>
</example>

<example>
<input>Founders complaining about difficulties to hire</input>
<output><filters>{"keyword":"founder","title":"founder","geoUrns":["103644278","101165590","101174742","101452733","101282230","105015875","103350119","105646813","102890719"],"industry":[],"language":"en","maxFollowers":null,"behavioralCriteria":["struggles to hire","frustrated with recruiting"],"searchMode":"behavioral","postKeyword":"can't find talent","postKeywordAlternatives":["hiring is broken","recruiting nightmare","candidates ghosting","wrong hires"],"behavioralIntent":"expresses"}</filters></output>
</example>

<example>
<input>Founder of B2B SaaS startup in the US who does cold outreach</input>
<output><filters>{"keyword":"SaaS","title":"founder","geoUrns":["103644278"],"industry":["4"],"language":"en","maxFollowers":null,"behavioralCriteria":["does cold outreach personally"],"searchMode":"profile","postKeyword":""}</filters></output>
</example>

<example>
<input>Agency founders who help B2B companies with cold outreach</input>
<output><filters>{"keyword":"agency","title":"founder","geoUrns":["103644278","101165590","101174742","101452733","101282230","105015875","103350119","105646813","102890719"],"industry":[],"language":"en","maxFollowers":null,"behavioralCriteria":["runs outreach agency","helps B2B companies with cold outreach"],"searchMode":"behavioral","postKeyword":"cold outreach","postKeywordAlternatives":["cold email","outbound sales","booking meetings","reply rates"],"behavioralIntent":"offers"}</filters></output>
</example>
</examples>

<rules>
- If the user input is vague or doesn't mention a field, return the empty default for that field (empty string, empty array, or null). DO NOT GUESS. EXCEPTION: geoUrns must NEVER be empty — if no country is specified, use DEFAULT_GEO from <mappings>.
- Country names not in <mappings> must be OMITTED from geoUrns, even if mentioned by the user.
- Industries not in <mappings> must be OMITTED from industry array.
- behavioralCriteria items must be short (max 5 words each) and ONLY include signals the user explicitly mentioned. Do not invent.
- Keyword translation rules in <mappings> take priority over literal user words.
- The KEY TEST for searchMode: "Would this person have likely written a POST about this?" If yes (it's an expressed opinion/complaint/story) → "behavioral". If it's just a role, sector, or a silent action → "profile". Default to "profile" when uncertain.
- If searchMode is "behavioral", postKeyword MUST be non-empty and must be words that appear in the post/comment itself (not the ICP description). For "expresses" it MUST be symptom/frustration phrasing, NOT a neutral topic label — avoid bare generic industry terms like "hiring", "leads", "sales", which surface posts with almost no comments.
- postKeywordAlternatives must be DISTINCT from postKeyword and from each
  other. Prefer phrases that attract first-person frustration in comments
  (symptoms, outcomes, emotional language) over generic topic labels.
  Each 1-4 words. Empty array if searchMode is "profile".
- For behavioralIntent: look for first-person struggle language → "expresses". Service/solution language → "offers". If mixed or unclear → "both". Irrelevant if searchMode is "profile".
</rules>

<output_format>
Output exactly one line:
<filters>{...valid JSON object...}</filters>

Nothing before. Nothing after. No markdown. No reasoning.
</output_format>

<icp_input>
${icp}
</icp_input>`;

// Estrai il JSON da dentro <filters>...</filters>. Più robusto di JSON.parse(text.trim())
// perché tollera testo extra prima/dopo, code fences accidentali, etc.
function extractFilters(text: string): unknown {
  // Cerca pattern <filters>...</filters>
  const xmlMatch = text.match(/<filters>([\s\S]*?)<\/filters>/);
  let jsonText = xmlMatch?.[1]?.trim() ?? text.trim();

  // Fallback: rimuovi markdown fence se presente
  jsonText = jsonText.replace(/^```json\s*/i, "").replace(/```$/, "").trim();

  // Fallback: trova il primo {...} bilanciato se ancora c'è rumore intorno
  if (!jsonText.startsWith("{")) {
    const objMatch = jsonText.match(/\{[\s\S]*\}/);
    if (objMatch) jsonText = objMatch[0];
  }

  return JSON.parse(jsonText);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const body = await req.json();
    const prompt: string = body.prompt ?? "";

    if (!prompt.trim()) {
      return new Response(JSON.stringify({ error: "prompt is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!CLAUDE_API_KEY) {
      return new Response(
        JSON.stringify({ error: "CLAUDE_API_KEY not configured" }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }

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
        messages: [{ role: "user", content: buildUserMessage(prompt) }],
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(`Claude error: ${JSON.stringify(err)}`);
    }

    const data = await response.json();
    const text = data.content[0]?.text ?? "";

    let filters;
    try {
      filters = extractFilters(text);
    } catch (parseErr) {
      console.error(`[parse-icp] Parse failed. Raw text: ${text.substring(0, 300)}`);
      throw new Error(`Failed to parse Claude response: ${parseErr instanceof Error ? parseErr.message : "unknown"}`);
    }

    console.log(`[parse-icp] filters: ${JSON.stringify(filters)}`);

    return new Response(
      JSON.stringify({ filters, originalPrompt: prompt }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
