/** Filters accepted by searchProfiles. All fields are optional. */
export type SearchFilters = {
  keyword?: string;
  title?: string;
  geoUrns?: string[];
  industry?: string[];
  language?: string;
  count?: number;
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

  /** Return follower count and other overview metrics for a profile public username. */
  getProfileOverview(username: string): Promise<ProfileOverview>;

  /** Return bio and work positions for a profile URN. */
  getProfileDetails(urn: string): Promise<ProfileDetails>;

  /** Return the most recent posts for a profile URN. */
  getRecentPosts(urn: string): Promise<Post[]>;
}
