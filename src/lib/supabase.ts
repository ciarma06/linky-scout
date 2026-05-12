//supabase.ts

"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

let cached: SupabaseClient | null = null;

/**
 * Browser Supabase client (anon key). RLS does the filtering by user_email.
 */
export function getSupabaseBrowserClient(): SupabaseClient {
  if (cached) return cached;
  cached = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}

export const EDGE_FUNCTIONS_BASE_URL =
  process.env.NEXT_PUBLIC_EDGE_FUNCTIONS_BASE_URL ?? "";

