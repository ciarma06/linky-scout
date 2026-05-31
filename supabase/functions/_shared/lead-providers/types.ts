//shared/lead-providers/types.ts

/** Filters accepted by searchProfiles. All fields are optional. */
export type SearchFilters = {
  keyword?: string;
  title?: string;
  geoUrns?: string[];
  industry?: string[];
  language?: string;
  count?: number;
  searchMode?: "profile" | "behavioral";
  postKeyword?: string;
};

/** Filtri per la ricerca dei post (motore comportamentale). */
export type PostSearchFilters = {
  keyword: string;
  authorJobTitle?: string;
  authorIndustry?: string;
  datePosted?: "past-24h" | "past-week" | "past-month" | "past-year";
  sortBy?: "relevance" | "date_posted";
  start?: number;
};

/** Un post restituito da search/posts, con autore. */
export type PostSearchResult = {
  postText: string;
  urn: string;
  postID: string;
  engagements: {
    commentsCount: number;
  };
  author: {
    urn: string;
    url: string;
    fullName: string;
    headline: string;
  };
};

/** Risposta paginata di search/posts. */
export type PostSearchResponse = {
  posts: PostSearchResult[];
  total: number;
  hasMore: boolean;
};

/** Commento su un post (posts/comments). */
export type PostComment = {
  author: {
    urn: string;
    url: string;
    name: string;
    headline: string;
    id: string;
  };
  comment: string;
};

/** Risposta paginata di posts/comments. */
export type PostCommentsResponse = {
  comments: PostComment[];
  cursor: string | null;
};

/** Minimal profile data returned by a search. */
export type ProfileBasic = {
  urn: string;
  url: string;
  fullName: string;
  headline: string;
  location: string;
};

/** Aggregated metrics for a profile. */
export type ProfileOverview = {
  urn: string;
  followerCount: number;
};

/** Rich profile data including work history. */
export type ProfileDetails = {
  urn: string;
  bio: string;
  positions: Array<{
    jobTitle: string;
    company: string;
    duration: string;
  }>;
};

/** A single LinkedIn post. */
export type Post = {
  text: string;
  postedAt: string;
  url?: string;
};

/** Abstract contract every lead-data provider must satisfy. */
export interface LeadDataProvider {
  /** Search profiles by keyword, title, location, industry, etc. */
  searchProfiles(filters: SearchFilters): Promise<ProfileBasic[]>;

  /** Cerca post per contenuto/keyword (motore comportamentale). */
  searchPosts(filters: PostSearchFilters): Promise<PostSearchResponse>;

  /** Commenti su un post (urn = postID numerico, non URN completo). */
  getPostComments(args: {
    urn: string;
    count?: number;
    sortBy?: "relevance" | "date_posted";
    start?: number;
  }): Promise<PostCommentsResponse>;

  /** Return follower count and other overview metrics for a profile public username. */
  getProfileOverview(username: string): Promise<ProfileOverview>;

  /** Return bio and work positions for a profile URN. */
  getProfileDetails(urn: string): Promise<ProfileDetails>;

  /** Return the most recent posts for a profile URN. */
  getRecentPosts(urn: string): Promise<Post[]>;
}
