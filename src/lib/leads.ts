"use client";

import { getSupabaseBrowserClient } from "@/lib/supabase";
import type { SearchResult } from "@/lib/types";

export type SaveLeadOutcome = "saved" | "already_exists" | "error";

export interface SaveLeadResult {
  outcome: SaveLeadOutcome;
  message?: string;
}

/**
 * Insert a lead into `profili_salvati` and mark the search_result as saved.
 *
 * Returns:
 *  - "saved" on success
 *  - "already_exists" when the same linkedin_url is already saved for this user
 *  - "error" otherwise
 */
export async function saveLead(
  result: SearchResult,
  userEmail: string
): Promise<SaveLeadResult> {
  if (!result.linkedin_url || !userEmail) {
    return { outcome: "error", message: "Missing required fields." };
  }

  const supabase = getSupabaseBrowserClient();

  const { data: existing, error: lookupError } = await supabase
    .from("profili_salvati")
    .select("id")
    .eq("user_email", userEmail)
    .eq("linkedin_url", result.linkedin_url)
    .limit(1)
    .maybeSingle();

  if (lookupError && lookupError.code !== "PGRST116") {
    return { outcome: "error", message: lookupError.message };
  }

  if (existing) {
    await supabase
      .from("search_results")
      .update({ saved_to_crm: true })
      .eq("id", result.id);
    return { outcome: "already_exists" };
  }

  const { error: insertError } = await supabase.from("profili_salvati").insert({
    full_name: result.full_name,
    linkedin_url: result.linkedin_url,
    comment_text: result.best_context ?? result.match_reason ?? "",
    comment_url: result.linkedin_url,
    user_email: userEmail,
    source: "scout",
  });

  if (insertError) {
    // 23505 = unique_violation (lead already saved by this user)
    if (insertError.code === "23505") {
      await supabase
        .from("search_results")
        .update({ saved_to_crm: true })
        .eq("id", result.id);
      return { outcome: "already_exists" };
    }
    return { outcome: "error", message: insertError.message };
  }

  await supabase
    .from("search_results")
    .update({ saved_to_crm: true })
    .eq("id", result.id);

  return { outcome: "saved" };
}
