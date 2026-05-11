/**
 * Format a follower count as a short string (e.g. 1234 -> "1.2k", 15000 -> "15k").
 */
export function formatFollowers(count: number | null | undefined): string {
  if (count == null || Number.isNaN(count)) return "—";
  if (count < 1000) return String(count);
  if (count < 10_000) {
    const v = count / 1000;
    return `${v.toFixed(1).replace(/\.0$/, "")}k`;
  }
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  const m = count / 1_000_000;
  return `${m.toFixed(1).replace(/\.0$/, "")}M`;
}

/**
 * Format an ISO timestamp as a relative date (e.g. "2 hours ago", "3 days ago").
 */
export function formatRelativeDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";

  const diffMs = Date.now() - date.getTime();
  const sec = Math.round(diffMs / 1000);
  const min = Math.round(sec / 60);
  const hr = Math.round(min / 60);
  const day = Math.round(hr / 24);
  const week = Math.round(day / 7);
  const month = Math.round(day / 30);
  const year = Math.round(day / 365);

  if (sec < 60) return "just now";
  if (min < 60) return `${min} ${min === 1 ? "minute" : "minutes"} ago`;
  if (hr < 24) return `${hr} ${hr === 1 ? "hour" : "hours"} ago`;
  if (day < 7) return `${day} ${day === 1 ? "day" : "days"} ago`;
  if (week < 5) return `${week} ${week === 1 ? "week" : "weeks"} ago`;
  if (month < 12) return `${month} ${month === 1 ? "month" : "months"} ago`;
  return `${year} ${year === 1 ? "year" : "years"} ago`;
}

/**
 * Format an ISO date as a short "Mon DD, YYYY".
 */
export function formatShortDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Truncate a string and append an ellipsis if it exceeds the limit.
 */
export function truncate(
  text: string | null | undefined,
  max: number
): string {
  if (!text) return "";
  if (text.length <= max) return text;
  return text.slice(0, max).trimEnd() + "…";
}

/**
 * Map a job stage code to a human-readable progress label.
 */
export function stageLabel(stage: string | null | undefined): string {
  switch (stage) {
    case "parsing":
      return "Parsing your ICP description...";
    case "searching":
      return "Searching LinkedIn profiles...";
    case "enriching":
      return "Analyzing bios and recent posts...";
    case "scoring":
      return "AI is scoring matches...";
    case "completed":
      return "Done.";
    case "queued":
      return "Queued — starting your search...";
    default:
      return "Working on it...";
  }
}

/**
 * Pick a deterministic pastel hue from a string (for avatar bg).
 */
export function avatarHue(seed: string | null | undefined): number {
  if (!seed) return 250;
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) % 360;
  }
  return h;
}
