// supabase/functions/_shared/linkdapi-call-stats.ts

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

/** Chiavi contatore persistite su search_jobs.linkdapi_call_stats */
export type LinkdApiStatKey =
  | "motore_a_search_people"
  | "motore_bc_search_posts"
  | "motore_c_posts_comments"
  | "profile_overview"
  | "profile_details"
  | "posts_all";

export type LinkdApiCallContext = {
  jobId?: string;
  searchId?: string;
  stage?: string;
};

/** Mappa label interna → chiave contatore + motore diagnostico */
const LABEL_TO_STAT: Record<string, { key: LinkdApiStatKey; engine: string; endpoint: string }> = {
  "search/people": {
    key: "motore_a_search_people",
    engine: "A",
    endpoint: "GET /api/v1/search/people (profile-search)",
  },
  "search/posts": {
    key: "motore_bc_search_posts",
    engine: "B|C",
    endpoint: "GET /api/v1/search/posts (post-search)",
  },
  "posts/comments": {
    key: "motore_c_posts_comments",
    engine: "C",
    endpoint: "GET /api/v1/posts/comments (comments/by-post)",
  },
  "profile/overview": {
    key: "profile_overview",
    engine: "enrich",
    endpoint: "GET /api/v1/profile/overview",
  },
  "profile/details": {
    key: "profile_details",
    engine: "enrich",
    endpoint: "GET /api/v1/profile/details",
  },
  "posts/all": {
    key: "posts_all",
    engine: "enrich",
    endpoint: "GET /api/v1/posts/all",
  },
};

export function resolveLinkdApiStat(label: string): {
  key: LinkdApiStatKey | null;
  engine: string;
  endpoint: string;
} {
  return LABEL_TO_STAT[label] ?? {
    key: null,
    engine: "?",
    endpoint: label,
  };
}

export function logLinkdApiCall(
  label: string,
  ctx?: LinkdApiCallContext,
  extra?: Record<string, unknown>,
) {
  const meta = resolveLinkdApiStat(label);
  console.log(
    JSON.stringify({
      tag: "linkdapi-call",
      label,
      engine: meta.engine,
      endpoint: meta.endpoint,
      statKey: meta.key,
      jobId: ctx?.jobId ?? null,
      searchId: ctx?.searchId ?? null,
      stage: ctx?.stage ?? null,
      ...extra,
    }),
  );
}

export async function recordLinkdApiCall(
  supabase: SupabaseClient,
  label: string,
  ctx?: LinkdApiCallContext,
): Promise<void> {
  const meta = resolveLinkdApiStat(label);
  if (!ctx?.jobId || !meta.key) return;

  const { error } = await supabase.rpc("increment_linkdapi_call_stats", {
    p_job_id: ctx.jobId,
    p_key: meta.key,
  });

  if (error) {
    console.warn(
      `[linkdapi-stats] increment fallito job=${ctx.jobId} key=${meta.key}: ${error.message}`,
    );
  }
}

export async function setLinkdApiRouting(
  supabase: SupabaseClient,
  jobId: string,
  routing: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase.rpc("merge_linkdapi_call_stats", {
    p_job_id: jobId,
    p_patch: { routing },
  });

  if (error) {
    console.warn(`[linkdapi-stats] merge routing fallito job=${jobId}: ${error.message}`);
  }
}

/** Riepilogo leggibile per i log orchestrator */
export function formatLinkdApiSummary(stats: Record<string, unknown> | null): string {
  if (!stats) return "nessun contatore";
  const a = Number(stats.motore_a_search_people ?? 0);
  const bc = Number(stats.motore_bc_search_posts ?? 0);
  const c = Number(stats.motore_c_posts_comments ?? 0);
  const routing = stats.routing as Record<string, unknown> | undefined;
  const route = routing
    ? `routing=${JSON.stringify(routing)}`
    : "routing=non impostato";
  return (
    `Motore A (search/people)=${a}, ` +
    `Motore B/C (search/posts)=${bc}, ` +
    `Motore C (posts/comments)=${c}, ` +
    route
  );
}
