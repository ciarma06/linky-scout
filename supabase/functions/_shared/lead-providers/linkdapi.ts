import type {
  LeadDataProvider,
  Post,
  ProfileBasic,
  ProfileDetails,
  ProfileOverview,
  SearchFilters,
} from "./types.ts";

const DEFAULT_BASE_URL = "https://linkdapi.com";

export class LinkdAPIProvider implements LeadDataProvider {
  readonly #apiKey: string;
  readonly #baseUrl: string;

  constructor(apiKey: string, baseUrl: string = DEFAULT_BASE_URL) {
    this.#apiKey = apiKey;
    this.#baseUrl = baseUrl.replace(/\/$/, "");
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Perform an authenticated GET request and return the unwrapped `data`
   * payload from the LinkdAPI response envelope
   * (`{ success, statusCode, message, data }`).
   * Throws a descriptive error for non-2xx responses or unsuccessful payloads.
   */
  async #request<T>(
    endpoint: string,
    params: Record<string, string | number> = {},
  ): Promise<T> {
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

  // ---------------------------------------------------------------------------
  // LeadDataProvider implementation
  // ---------------------------------------------------------------------------

  /**
   * Search LinkedIn profiles using keyword, title, geo, industry and language
   * filters.  Returns a lightweight list of matching profiles.
   */
  async searchProfiles(filters: SearchFilters): Promise<ProfileBasic[]> {
    type RawPerson = {
      urn: string;
      profileID: string;
      url: string;
      firstName: string;
      lastName: string;
      fullName: string;
      headline: string;
      location: string;
      profilePictureURL: string;
      premium: boolean;
    };

    type RawResponse = {
      people: RawPerson[];
      total: number;
      start: number;
      count: number;
      hasMore: boolean;
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
    );

    return (data.people ?? []).map((p) => ({
      urn: p.urn,
      url: p.url,
      fullName: p.fullName,
      headline: p.headline,
      location: p.location,
    }));
  }

  /**
   * Fetch follower count and other overview metrics for the given public
   * username (i.e. the slug after `/in/` in a LinkedIn profile URL).
   */
  async getProfileOverview(username: string): Promise<ProfileOverview> {
    type RawOverview = {
      firstName: string;
      lastName: string;
      fullName: string;
      headline: string;
      publicIdentifier: string;
      followerCount: number;
      connectionsCount: number;
      urn: string;
    };

    const data = await this.#request<RawOverview>(
      "/api/v1/profile/overview",
      { username },
    );

    return {
      urn: data.urn,
      followerCount: data.followerCount,
    };
  }

  /**
   * Fetch bio and work-history positions for the given profile URN.
   */
  async getProfileDetails(urn: string): Promise<ProfileDetails> {
    type RawPosition = {
      jobTitle: string;
      company: string;
      location: string;
      duration: string;
      companyLink: string;
      companyId: string;
      jobDescription: string;
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
    );

    return {
      urn,
      bio: data.about ?? "",
      positions: (data.positions ?? []).map((pos) => ({
        jobTitle: pos.jobTitle,
        company: pos.company,
        duration: pos.duration,
      })),
    };
  }

  /**
   * Fetch the most recent posts published by the profile with the given URN.
   */
  async getRecentPosts(urn: string): Promise<Post[]> {
    type RawPost = {
      text: string;
      url: string;
      urn: string;
      author: unknown;
      postedAt: string;
      edited: boolean;
      engagements: unknown;
      mediaContent: unknown[];
      resharedPostContent: unknown;
    };

    type RawResponse = { posts: RawPost[] };

    const data = await this.#request<RawResponse>(
      "/api/v1/posts/all",
      { urn },
    );

    return (data.posts ?? []).map((p) => ({
      text: p.text,
      postedAt: p.postedAt,
      url: p.url,
    }));
  }
}
