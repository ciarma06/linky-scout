import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

export function normalizeICP(prompt: string): string {
  return prompt
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .split(/\s+/)
    .sort()
    .join(" ");
}

export async function hashICP(prompt: string): Promise<string> {
  const normalized = normalizeICP(prompt);
  const buffer = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(normalized),
  );
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function getCachedResults(
  supabase: SupabaseClient,
  icpPrompt: string,
): Promise<{ hit: true; results: unknown[] } | { hit: false }> {
  const hash = await hashICP(icpPrompt);

  const { data, error } = await supabase
    .from("search_cache")
    .select("results")
    .eq("icp_hash", hash)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();

  if (error || !data) return { hit: false };

  return { hit: true, results: data.results as unknown[] };
}

export async function setCachedResults(
  supabase: SupabaseClient,
  icpPrompt: string,
  results: unknown[],
): Promise<void> {
  const hash = await hashICP(icpPrompt);

  await supabase.from("search_cache").upsert(
    {
      icp_hash: hash,
      results,
      expires_at: new Date(Date.now() + 7 *24 * 60 * 60 * 1000).toISOString(),
    },
    { onConflict: "icp_hash" },
  );
}
