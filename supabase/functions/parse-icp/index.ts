import "@supabase/functions-js/edge-runtime.d.ts";

const CLAUDE_API_KEY = Deno.env.get("CLAUDE_API_KEY");

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
        model: "claude-sonnet-4-6",
        max_tokens: 500,
        system:
          "You are an expert at parsing ICP (Ideal Customer Profile) descriptions into structured LinkedIn search filters. Always respond with valid JSON only, no preamble, no explanation, no markdown backticks.",
        messages: [
          {
            role: "user",
            content:
              `Parse this ICP description into LinkedIn search filters:\n\n${prompt}\n\nReturn a JSON object with these exact fields:\n- keyword: string (1-3 words describing the industry or topic, e.g. "B2B SaaS")\n- title: string (single job title keyword, e.g. "founder" or "ceo")\n- geoUrns: array of strings (LinkedIn geo URN IDs for the countries mentioned. Use these mappings: USA/United States="103644278", UK/United Kingdom="101165590", Germany="101282230", France="105015875", Italy="103350119", Spain="105646813", Netherlands="102890719", Canada="101174742", Australia="101452733", India="102713980". Empty array if no country specified)\n- language: string (use "en" for English, empty string if not specified)\n- maxFollowers: number or null (if the user mentions a follower limit like "under 10k", put 10000. null if not mentioned)\n- behavioralCriteria: array of strings (behavioral signals to look for in bio and posts, e.g. ["does outreach alone", "bootstrapped", "no funding"]). Empty array if none mentioned.\n\nIMPORTANT: Return ONLY the raw JSON object, no markdown, no backticks, nothing else.`,
          },
        ],
      }),
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(`Claude error: ${JSON.stringify(err)}`);
    }

    const data = await response.json();
    const text = data.content[0].text.trim();

    let filters;
    try {
      filters = JSON.parse(text);
    } catch {
      throw new Error("Failed to parse Claude response as JSON");
    }

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
