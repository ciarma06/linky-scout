// supabase/functions/_shared/lead-providers/linkdapi.ts

import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { acquireLinkdApiToken } from "../rate-limiter.ts";
import type {
  LeadDataProvider,
  Post,
  PostSearchFilters,
  PostSearchResponse,
  ProfileBasic,
  ProfileDetails,
  ProfileOverview,
  SearchFilters,
} from "./types.ts";

const DEFAULT_BASE_URL = "https://linkdapi.com";

export class LinkdAPIProvider implements LeadDataProvider {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #supabase: SupabaseClient;

  constructor(apiKey: string, baseUrl: string = DEFAULT_BASE_URL) {
    this.#apiKey = apiKey;
    this.#baseUrl = baseUrl.replace(/\/$/, "");
    // Client interno per rate limiting (service role)
    this.#supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
  }

  /**
   * Authenticated GET. Acquisisce un token dal rate limiter PRIMA della fetch.
   * Se il bucket è vuoto, blocca finché un token non si libera (max 90s).
   */
  async #request<T>(
    endpoint: string,
    params: Record<string, string | number> = {},
    label?: string,
  ): Promise<T> {
    // RATE LIMITING: blocca qui se necessario
    await acquireLinkdApiToken(this.#supabase, label ?? endpoint);

    const url = new URL(`${this.#baseUrl}${endpoint}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "x-linkdapi-apikey": this.#apiKey,
        "Accept": "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(
        `LinkdAPI error ${response.status} on ${endpoint}: ${response.statusText}`,
      );
    }

    const json = await response.json() as {
      success?: boolean;
      statusCode?: number;
      message?: string;
      data: T;
    };

    if (json.success === false) {
      throw new Error(
        `LinkdAPI error on ${endpoint}: ${json.message ?? "unknown error"}`,
      );
    }

    return json.data;
  }

  async searchProfiles(filters: SearchFilters): Promise<ProfileBasic[]> {
    type RawPerson = {
      urn: string; profileID: string; url: string;
      firstName: string; lastName: string; fullName: string;
      headline: string; location: string;
      profilePictureURL: string; premium: boolean;
    };
    type RawResponse = {
      people: RawPerson[]; total: number; start: number; count: number; hasMore: boolean;
    };

    const params: Record<string, string | number> = {};
    if (filters.keyword) params["keyword"] = filters.keyword;
    if (filters.title) params["title"] = filters.title;
    if (filters.geoUrns?.length) params["geoUrn"] = filters.geoUrns.join(",");
    if (filters.industry?.length) params["industry"] = filters.industry.join(",");
    if (filters.language) params["profileLanguage"] = filters.language;
    if (filters.count !== undefined) params["count"] = filters.count;

    const data = await this.#request<RawResponse>(
      "/api/v1/search/people",
      params,
      "search/people",
    );

    return (data.people ?? []).map((p) => ({
      urn: p.urn, url: p.url, fullName: p.fullName,
      headline: p.headline, location: p.location,
    }));
  }

  /**
   * Cerca post per keyword/contenuto. Usato dal motore comportamentale.
   * Restituisce post con autore, paginati (10 per pagina).
   */
  async searchPosts(filters: PostSearchFilters): Promise<PostSearchResponse> {
    type RawAuthor = {
      name: string;
      headline: string;
      urn: string;
      id: string;
      url: string;
      profilePictureURL: string;
    };
    type RawPost = {
      urn: string;
      postID: string;
      postURL: string;
      text: string;
      author: RawAuthor;
      postedAt: unknown;
      engagements: unknown;
      mediaContent: unknown[];
    };
    type RawResponse = {
      posts: RawPost[];
      total: number;
      start: number;
      count: number;
      hasMore: boolean;
    };

    const params: Record<string, string | number> = {
      keyword: filters.keyword,
    };
    if (filters.authorJobTitle) params["authorJobTitle"] = filters.authorJobTitle;
    if (filters.authorIndustry) params["authorIndustry"] = filters.authorIndustry;
    if (filters.datePosted) params["datePosted"] = filters.datePosted;
    if (filters.sortBy) params["sortBy"] = filters.sortBy;
    if (filters.start !== undefined) params["start"] = filters.start;

    const data = await this.#request<RawResponse>(
      "/api/v1/search/posts",
      params,
      "search/posts",
    );

    return {
      posts: (data.posts ?? []).map((p) => ({
        postText: p.text ?? "",
        author: {
          urn: p.author?.urn ?? "",
          url: p.author?.url ?? "",
          fullName: p.author?.name ?? "",
          headline: p.author?.headline ?? "",
        },
      })),
      total: data.total ?? 0,
      hasMore: data.hasMore ?? false,
    };
  }

  async getProfileOverview(username: string): Promise<ProfileOverview> {
    type RawOverview = {
      firstName: string; lastName: string; fullName: string;
      headline: string; publicIdentifier: string;
      followerCount: number; connectionsCount: number; urn: string;
    };

    const data = await this.#request<RawOverview>(
      "/api/v1/profile/overview",
      { username },
      "profile/overview",
    );

    return { urn: data.urn, followerCount: data.followerCount };
  }

  async getProfileDetails(urn: string): Promise<ProfileDetails> {
    type RawPosition = {
      jobTitle: string; company: string; location: string;
      duration: string; companyLink: string; companyId: string; jobDescription: string;
    };
    type RawDetails = {
      about: string;
      featuredPosts: Array<{ postLink: string; postText: string }>;
      positions: RawPosition[];
      education: unknown[];
      languages: unknown;
    };

    const data = await this.#request<RawDetails>(
      "/api/v1/profile/details",
      { urn },
      "profile/details",
    );

    return {
      urn,
      bio: data.about ?? "",
      positions: (data.positions ?? []).map((pos) => ({
        jobTitle: pos.jobTitle, company: pos.company, duration: pos.duration,
      })),
    };
  }

  async getRecentPosts(urn: string): Promise<Post[]> {
    type RawPost = {
      text: string; url: string; urn: string;
      author: unknown; postedAt: string; edited: boolean;
      engagements: unknown; mediaContent: unknown[]; resharedPostContent: unknown;
    };
    type RawResponse = { posts: RawPost[] };

    const data = await this.#request<RawResponse>(
      "/api/v1/posts/all",
      { urn },
      "posts/all",
    );

    return (data.posts ?? []).map((p) => ({
      text: p.text, postedAt: p.postedAt, url: p.url,
    }));
  }
}
