// supabase/functions/stage1-commenters/index.ts

import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { getLeadProvider } from "../_shared/lead-providers/index.ts";
import type { SearchFilters } from "../_shared/lead-providers/types.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const CHUNK_SIZE = 12;
const MAX_CANDIDATES = 25;
const MAX_POSTS_PAGES = 1;
const TARGET_CANDIDATES = 12; // stop adattivo: smetti di provare keyword una volta raggiunti
const MAX_SOURCE_POSTS_PER_KEYWORD = 3;
const POSTS_PER_PAGE = 10;
const MIN_POST_COMMENTS = 2; // sotto 2 il rapporto credito/lead è pessimo
const COMMENTS_PER_POST = 30;
// 10 = soglia minima per escludere emoji singoli e micro-reazioni; commenti tipo
// 'SEND', 'PRODUCT', 'Same here' sono lead-magnet hunter di valore (interessati alla categoria del tool)
const MIN_COMMENT_LENGTH = 10;
const MATCH_POST_LIMIT = 2000;

const COST_SEARCH_POSTS = 1;
const COST_POST_COMMENTS = 1;
const COST_PROFILE_OVERVIEW = 2;

const SELLER_IN_COMMENT_PATTERNS = [
  /\bat\s+[\w&\s'.,-]+\s+we\b/i,
  /\bwe\s+(built|build|solve|help|created|developed|offer)\b/i,
  /\bour\s+(platform|tool|agency|solution|product|service|software)\b/i,
  /\bdm\s+me\s+to\s+discuss\s+our\b/i,
  /\bmy\s+(agency|company|firm|startup)\b/i,
];

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildHeadlineSellerCheck(postKeyword: string) {
  const kw = escapeRegex(postKeyword.trim());
  const topicSpecific = new RegExp(
    `${kw}\\s+(expert|consultant|coach|specialist|strategist|agency)`,
    "i",
  );
  const genericPatterns = [
    /\bagency\s+founder\b/i,
    /\bi\s+help\s+.+\s+with\b/i,
    /\bhelping\s+.+\s+(generate|scale)\b/i,
    /\b10x\s+their\s+leads\b/i,
    /\bwe\s+help\s+.+\s+(with|to)\b/i,
    /\b(founder|ceo)\s+@?\s*.+\s+(agency|consulting)\b/i,
  ];

  return (headline: string): boolean => {
    if (!headline) return false;
    if (topicSpecific.test(headline)) return true;
    if (!new RegExp(kw, "i").test(headline)) return false;
    return genericPatterns.some((pattern) => pattern.test(headline));
  };
}

const STANDARD_DECISION_MAKER_ROLES = [
  "founder",
  "co-founder",
  "cofounder",
  "ceo",
  "owner",
  "president",
  "managing director",
  "md",
  "partner",
  "chief",
];

const EXCLUDED_OPERATIONAL_ROLES = [
  "assistant",
  "intern",
  "trainee",
  "student",
  "coordinator",
  "apprentice",
];

function buildRoleMatcher(title: string) {
  const titleRole = title?.trim().toLowerCase();
  const targetRoles = [
    ...new Set([
      ...(titleRole ? [titleRole] : []),
      ...STANDARD_DECISION_MAKER_ROLES,
    ]),
  ];

  const targetPatterns = targetRoles.map(
    (role) => new RegExp(`\\b${escapeRegex(role)}\\b`, "i"),
  );
  const excludedPatterns = EXCLUDED_OPERATIONAL_ROLES.map(
    (role) => new RegExp(`\\b${escapeRegex(role)}\\b`, "i"),
  );

  return (headline: string): boolean => {
    if (!headline?.trim()) return false;
    if (excludedPatterns.some((pattern) => pattern.test(headline))) return false;
    return targetPatterns.some((pattern) => pattern.test(headline));
  };
}

function formatRelativeTime(timestampMs: number): string {
  const now = Date.now();
  const diffMs = now - timestampMs;
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (days < 1) return "today";
  if (days < 2) return "yesterday";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  if (days < 365) return `${Math.floor(days / 30)} months ago`;
  return `${Math.floor(days / 365)} years ago`;
}

async function hasAnyResults(searchId: string): Promise<boolean> {
  const { count } = await supabase
    .from("search_results")
    .select("id", { count: "exact", head: true })
    .eq("search_id", searchId);
  return (count ?? 0) > 0;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405, headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const { searchId, filters } = body as {
      searchId?: string;
      filters?: SearchFilters & { maxFollowers?: number | null; postKeyword?: string };
    };

    if (!searchId || !filters) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: searchId and filters" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const provider = getLeadProvider();
    const { title, postKeyword, maxFollowers } = filters;
    const postKeywordAlternatives = filters.postKeywordAlternatives ?? [];

    if (!postKeyword?.trim()) {
      console.error(`[stage1-commenters] postKeyword vuoto, impossibile procedere`);
      return new Response(
        JSON.stringify({ done: true, stillPending: 0, error: "empty postKeyword" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    const isSearchPhase = !(await hasAnyResults(searchId));

    // ===================================================================
    // FASE 1: search/posts → filtra post → getPostComments → insert
    // ===================================================================
    if (isSearchPhase) {
      const keywordsToTry = [postKeyword, ...postKeywordAlternatives].filter(Boolean);
      const keywordsUsed: string[] = [];
      let creditsUsed = 0;
      let sourcePostsUsed = 0;

      const candidates = new Map<
        string,
        { url: string; fullName: string; headline: string; matchComment: string; createdAt: number }
      >();
      const dropped = { commentTooShort: 0, commentSeller: 0, headlineSeller: 0, roleMismatch: 0 };
      const isHeadlineSeller = buildHeadlineSellerCheck(postKeyword);
      const matchesRole = buildRoleMatcher(title ?? "");

      for (const kw of keywordsToTry) {
        if (candidates.size >= TARGET_CANDIDATES) break;
        keywordsUsed.push(kw);

        const allPostsRaw: Array<{
          postID: string;
          urn: string;
          engagements: { commentsCount: number };
        }> = [];
        let start = 0;
        let pages = 0;

        while (pages < MAX_POSTS_PAGES) {
          // NB: authorJobTitle non passato di proposito — vogliamo post con
          // alta discussione, indipendentemente dal ruolo dell'autore del post.
          // Il filtro sul ruolo del commentatore è applicato qui (headline gratis
          // da posts/comments), prima dell'enrichment a crediti.
          const resp = await provider.searchPosts({
            keyword: kw,
            datePosted: "past-year",
            sortBy: "relevance",
            start,
          });
          creditsUsed += COST_SEARCH_POSTS;
          pages += 1;
          allPostsRaw.push(...resp.posts);
          if (!resp.hasMore) break;
          start += POSTS_PER_PAGE;
        }

        const counts = allPostsRaw
          .map((p) => p.engagements?.commentsCount ?? 0)
          .sort((a, b) => b - a);
        console.log(
          `[stage1-commenters] keyword "${kw}" raw posts: ${allPostsRaw.length} totali. ` +
          `commentsCount distribution: max=${counts[0] ?? 0}, ` +
          `top5=[${counts.slice(0, 5).join(",")}], ` +
          `>=5: ${counts.filter((n) => n >= 5).length}, ` +
          `>=2: ${counts.filter((n) => n >= 2).length}, ` +
          `>=1: ${counts.filter((n) => n >= 1).length}`,
        );

        const sourcePosts: Array<{ postID: string; urn: string; commentsCount: number }> = [];
        for (const post of allPostsRaw) {
          if (post.engagements.commentsCount >= MIN_POST_COMMENTS && post.postID) {
            sourcePosts.push({
              postID: post.postID,
              urn: post.urn,
              commentsCount: post.engagements.commentsCount,
            });
          }
        }
        sourcePosts.sort((a, b) => b.commentsCount - a.commentsCount);
        const topSourcePosts = sourcePosts.slice(0, MAX_SOURCE_POSTS_PER_KEYWORD);

        const beforeSize = candidates.size;

        for (const sp of topSourcePosts) {
          if (candidates.size >= TARGET_CANDIDATES) break;
          console.log(
            `[stage1-commenters] calling getPostComments postID="${sp.postID}" urn="${sp.urn}" commentsCount=${sp.commentsCount}`,
          );

          try {
            const commentsResp = await provider.getPostComments({
              urn: sp.postID,
              count: COMMENTS_PER_POST,
              sortBy: "date_posted",
            });
            creditsUsed += COST_POST_COMMENTS;
            sourcePostsUsed += 1;

            for (const item of commentsResp.comments) {
              if (candidates.size >= TARGET_CANDIDATES) break;

              const { author, comment } = item;
              const text = comment?.trim() ?? "";

              if (text.length < MIN_COMMENT_LENGTH) {
                dropped.commentTooShort += 1;
                continue;
              }
              if (SELLER_IN_COMMENT_PATTERNS.some((pattern) => pattern.test(text))) {
                dropped.commentSeller += 1;
                continue;
              }
              if (author.id.startsWith("urn:li:company:")) continue;
              if (isHeadlineSeller(author.headline)) {
                dropped.headlineSeller += 1;
                continue;
              }
              if (!matchesRole(author.headline)) {
                dropped.roleMismatch += 1;
                continue;
              }
              if (!author.urn) continue;

              const existing = candidates.get(author.urn);
              if (!existing || text.length > existing.matchComment.length) {
                candidates.set(author.urn, {
                  url: author.url,
                  fullName: author.name,
                  headline: author.headline,
                  matchComment: text,
                  createdAt: item.createdAt,
                });
              }
            }
          } catch (err) {
            console.warn(
              `[stage1-commenters] posts/comments fallito per ${sp.postID}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }

        const added = candidates.size - beforeSize;
        console.log(
          `[stage1-commenters] keyword "${kw}": +${added} nuovi candidati (totale ${candidates.size})`,
        );
      }

      const rows = [...candidates.entries()].map(([urn, c]) => {
        const relativeTime = formatRelativeTime(c.createdAt);
        const matchPostWithDate = `[Posted ${relativeTime}] ${c.matchComment}`;
        return {
          search_id: searchId,
          linkedin_urn: urn,
          linkedin_url: c.url,
          full_name: c.fullName,
          headline: c.headline,
          location: "",
          follower_count: -1,
          match_score: null,
          saved_to_crm: false,
          match_post: matchPostWithDate.slice(0, MATCH_POST_LIMIT),
        };
      });

      if (rows.length > 0) {
        const { error } = await supabase.from("search_results").insert(rows);
        if (error) throw new Error(`Insert failed: ${error.message}`);
      }

      console.log(
        `[stage1-commenters] inseriti ${rows.length} candidati. ` +
        `Filtri gratis: A ${dropped.commentTooShort} too-short, B ${dropped.commentSeller} seller-pitch, ` +
        `C ${dropped.headlineSeller} seller-headline, D ${dropped.roleMismatch} role-mismatch`,
      );
      console.log(`[stage1-commenters] CREDITI questo chunk: ${creditsUsed}`);

      const done = rows.length === 0;
      return new Response(
        JSON.stringify({
          done,
          stillPending: rows.length,
          candidatesFound: rows.length,
          sourcePostsUsed,
          keywordsUsed,
          creditsUsed,
          mode: "commenters",
          searchId,
          dropped,
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    // ===================================================================
    // FASE 2: chunk di overview sui pending (identica a stage1-behavioral)
    // ===================================================================
    const { data: pending } = await supabase
      .from("search_results")
      .select("id, linkedin_url, linkedin_urn")
      .eq("search_id", searchId)
      .eq("follower_count", -1)
      .limit(CHUNK_SIZE);

    let overviewCalls = 0;
    let overviewFailed = 0;

    if (pending && pending.length > 0) {
      for (const p of pending) {
        const username = p.linkedin_url.split("/in/")[1]?.replace(/\/$/, "") ?? "";
        overviewCalls += 1;
        console.log(
          `[stage1-commenters] overview attempt: url="${p.linkedin_url}" → username="${username}"`,
        );

        if (!username) {
          await supabase
            .from("search_results")
            .update({ follower_count: 0 })
            .eq("id", p.id);
          continue;
        }

        try {
          const overview = await provider.getProfileOverview(username);
          const fc = overview.followerCount ?? 0;

          if (maxFollowers && fc > maxFollowers) {
            await supabase.from("search_results").delete().eq("id", p.id);
            continue;
          }

          await supabase
            .from("search_results")
            .update({
              follower_count: fc,
              linkedin_urn: overview.urn ?? p.linkedin_urn,
            })
            .eq("id", p.id);
        } catch (err) {
          overviewFailed += 1;
          console.warn(
            `[stage1-commenters] overview failed: username="${username}", url="${p.linkedin_url}", error="${err instanceof Error ? err.message : String(err)}"`,
          );
          await supabase
            .from("search_results")
            .update({ follower_count: 0 })
            .eq("id", p.id);
        }
      }
    }

    const creditsUsed = overviewCalls * COST_PROFILE_OVERVIEW;

    const { count: stillPending } = await supabase
      .from("search_results")
      .select("id", { count: "exact", head: true })
      .eq("search_id", searchId)
      .eq("follower_count", -1);

    const done = (stillPending ?? 0) === 0;

    console.log(
      `[stage1-commenters] overview chunk: ${overviewCalls} chiamate, ${overviewFailed} falliti (tenuti), ` +
      `pending: ${stillPending ?? 0}, done: ${done}`,
    );
    console.log(`[stage1-commenters] CREDITI questo chunk: ${creditsUsed}`);

    return new Response(
      JSON.stringify({
        done,
        stillPending: stillPending ?? 0,
        chunkProcessed: overviewCalls,
        overviewFailed,
        creditsUsed,
        searchId,
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
