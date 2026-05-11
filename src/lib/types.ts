export interface RecentPost {
  text?: string;
  postedAt?: string;
  url?: string;
}

export interface SearchResult {
  id: string;
  search_id: string;
  linkedin_urn: string | null;
  linkedin_url: string | null;
  full_name: string | null;
  headline: string | null;
  location: string | null;
  follower_count: number | null;
  bio: string | null;
  recent_posts: RecentPost[] | null;
  match_score: number | null;
  match_reason: string | null;
  best_context: string | null;
  saved_to_crm: boolean | null;
  created_at?: string;
}

export interface Search {
  id: string;
  user_id: string;
  icp_prompt: string;
  created_at: string;
}

export interface SearchWithStats extends Search {
  match_count: number;
  top_score: number | null;
}

export type JobStatus =
  | "pending"
  | "queued"
  | "running"
  | "completed"
  | "failed";

export type JobStage =
  | "queued"
  | "parsing"
  | "searching"
  | "enriching"
  | "scoring"
  | "completed";

export interface JobStatusResponse {
  status: JobStatus;
  progress: number;
  current_stage: JobStage | string;
  error_message: string | null;
  search_id: string;
  results?: SearchResult[];
}

export interface StartSearchResponse {
  cached: boolean;
  results?: SearchResult[];
  jobId?: string;
  searchId?: string;
  error?: string;
}

export interface SavedLead {
  id: string;
  full_name: string | null;
  linkedin_url: string | null;
  comment_text: string | null;
  comment_url: string | null;
  user_email: string;
  source?: string | null;
  headline?: string | null;
  created_at: string;
}
