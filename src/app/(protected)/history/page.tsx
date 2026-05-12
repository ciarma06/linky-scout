//history/page.tsx

"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Clock, RefreshCcw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ScoreBadge } from "@/components/score-badge";
import { useAuth } from "@/lib/auth-context";
import { formatRelativeDate, truncate } from "@/lib/format";
import type { SearchWithStats } from "@/lib/types";

interface RawSearchRow {
  id: string;
  user_id: string;
  icp_prompt: string;
  created_at: string;
  search_results?: Array<{ match_score: number | null }> | null;
}

export default function HistoryPage() {
  const router = useRouter();
  const { user } = useAuth();
  const [searches, setSearches] = useState<SearchWithStats[]>([]);
  const [loading, setLoading] = useState(true);

  const userEmail = user?.email;

  useEffect(() => {
    if (!userEmail || !user?.jwt) return;

    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(
          `${process.env.NEXT_PUBLIC_EDGE_FUNCTIONS_BASE_URL}/get-searches`,
          {
            method: "GET",
            headers: {
              "Authorization": `Bearer ${user!.jwt}`,
              "Content-Type": "application/json",
            },
          }
        );

        if (!res.ok) throw new Error("Failed to fetch searches");
        const json = await res.json();

        if (cancelled) return;

        const rows: SearchWithStats[] = (json.searches ?? []).map(
          (s: RawSearchRow) => {
            const scores = (s.search_results ?? [])
              .map((r) => r.match_score)
              .filter((v): v is number => typeof v === "number" && !Number.isNaN(v));
            const positive = scores.filter((n) => n > 0);
            const top = positive.length > 0 ? Math.max(...positive) : null;
            return {
              id: s.id,
              user_id: s.user_id,
              icp_prompt: s.icp_prompt,
              created_at: s.created_at,
              match_count: positive.length,
              top_score: top,
            };
          }
        );

        setSearches(rows);
      } catch {
        toast.error("Could not load search history.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => { cancelled = true; };
  }, [userEmail, user?.jwt]);

  function viewResults(id: string) {
    router.push(`/?searchId=${encodeURIComponent(id)}`);
  }

  function reRun(prompt: string) {
    router.push(`/?prompt=${encodeURIComponent(prompt)}`);
  }

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-heading text-3xl font-semibold tracking-tight text-foreground">
          Search History
        </h1>
        <p className="text-base text-muted-foreground">
          Your previous ICP searches.
        </p>
      </header>

      {loading ? (
        <HistorySkeleton />
      ) : searches.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="flex flex-col gap-3">
          {searches.map((s) => (
            <Card key={s.id} className="rounded-2xl">
              <CardContent className="flex flex-col gap-4 py-5 md:flex-row md:items-center md:justify-between">
                <div className="flex min-w-0 flex-1 items-start gap-4">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[#6d47f5]/10 text-[#6d47f5] dark:bg-[#6d47f5]/20 dark:text-[#a48cff]">
                    <Clock className="size-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="line-clamp-2 text-sm font-medium text-foreground">
                      {truncate(s.icp_prompt, 100) || "Untitled search"}
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      <span>{formatRelativeDate(s.created_at)}</span>
                      <span>
                        {s.match_count}{" "}
                        {s.match_count === 1 ? "match" : "matches"}
                      </span>
                      {s.top_score != null && (
                        <span className="inline-flex items-center gap-1.5">
                          Top score
                          <ScoreBadge score={s.top_score} size="sm" />
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="rounded-xl"
                    onClick={() => reRun(s.icp_prompt)}
                  >
                    <RefreshCcw className="size-4" />
                    Re-run
                  </Button>
                  <Button
                    type="button"
                    className="rounded-xl bg-[#6d47f5] text-white hover:bg-[#6d47f5]/90"
                    onClick={() => viewResults(s.id)}
                  >
                    View Results
                    <ArrowRight className="size-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function HistorySkeleton() {
  return (
    <div className="flex flex-col gap-3">
      {[0, 1, 2].map((i) => (
        <Card key={i} className="rounded-2xl">
          <CardContent className="py-5">
            <div className="h-4 w-3/4 animate-pulse rounded-full bg-muted" />
            <div className="mt-3 h-3 w-1/2 animate-pulse rounded-full bg-muted" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <Card className="rounded-2xl">
      <CardHeader>
        <CardTitle className="text-lg">No searches yet</CardTitle>
        <CardDescription>
          Run your first ICP search from the New Search page.
        </CardDescription>
      </CardHeader>
    </Card>
  );
}
