//page.tsx

"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Search, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import { SearchResultsTable } from "@/components/search-results-table";
import { useAuth } from "@/lib/auth-context";
import { stageLabel } from "@/lib/format";
import { EDGE_FUNCTIONS_BASE_URL, getSupabaseBrowserClient } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import type {
  JobStatusResponse,
  SearchResult,
  StartSearchResponse,
} from "@/lib/types";

const SAMPLE_PROMPTS = [
  "B2B founder, USA, SaaS, <10k followers",
  "CEO startup tech, Europe, AI sector",
  "Solo founder doing outreach, English speaking",
];

const POLL_INTERVAL_MS = 3000;

type UiStage = "idle" | "running" | "done" | "error";

interface UiState {
  stage: UiStage;
  results: SearchResult[];
  progress: number;
  currentStage: string;
  error: string | null;
}

const INITIAL_STATE: UiState = {
  stage: "idle",
  results: [],
  progress: 0,
  currentStage: "queued",
  error: null,
};

export default function Page() {
  return (
    <Suspense fallback={<NewSearchSkeleton />}>
      <NewSearchView />
    </Suspense>
  );
}

function NewSearchSkeleton() {
  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-heading text-3xl font-semibold tracking-tight text-foreground">
          Find Your Ideal Leads
        </h1>
        <p className="text-sm text-muted-foreground">
          Describe your ideal customer and let AI find them on LinkedIn.
        </p>
      </header>
      <Card className="rounded-2xl" />
    </div>
  );
}

function NewSearchView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user } = useAuth();

  const [prompt, setPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [ui, setUi] = useState<UiState>(INITIAL_STATE);
  const [, setActiveJobId] = useState<string | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => clearPolling();
  }, [clearPolling]);

  const userEmail = user?.email;
  const loadSearchResults = useCallback(
    async (searchId: string) => {
      if (!user?.jwt) return;
      try {
        const res = await fetch(`${EDGE_FUNCTIONS_BASE_URL}/get-job-status`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${user.jwt}`,
          },
          body: JSON.stringify({ jobId: null, searchId }),
        });
  
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Failed to load results");
  
        if (data.icp_prompt) setPrompt(data.icp_prompt);
        setUi({
          stage: "done",
          results: data.results ?? [],
          progress: 100,
          currentStage: "completed",
          error: null,
        });
      } catch (err) {
        toast.error("Could not load saved results.");
      }
    },
    [user?.jwt]
  );

  // Sync local state from URL query params (an external source).
  // setState inside an effect is the correct pattern here.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const promptParam = searchParams.get("prompt");
    const searchIdParam = searchParams.get("searchId");

    if (searchIdParam) {
      void loadSearchResults(searchIdParam);
      return;
    }
    if (promptParam) {
      setPrompt(promptParam);
    }
  }, [searchParams, loadSearchResults]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const userJwt = user?.jwt;
  const pollJob = useCallback(
    async (jobId: string) => {
      if (!userJwt) return;
      try {
        const res = await fetch(`${EDGE_FUNCTIONS_BASE_URL}/get-job-status`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${userJwt}`,
          },
          body: JSON.stringify({ jobId }),
        });
        const data = (await res.json()) as JobStatusResponse | { error: string };

        if (!res.ok || "error" in data) {
          const msg =
            ("error" in data && data.error) || `Request failed (${res.status})`;
          throw new Error(msg);
        }

        if (data.status === "failed") {
          clearPolling();
          setUi({
            stage: "error",
            results: [],
            progress: data.progress ?? 0,
            currentStage: data.current_stage ?? "",
            error: data.error_message ?? "Search failed.",
          });
          toast.error(data.error_message ?? "Search failed.");
          return;
        }

        if (data.status === "completed") {
          clearPolling();
          setUi({
            stage: "done",
            results: data.results ?? [],
            progress: 100,
            currentStage: "completed",
            error: null,
          });
          return;
        }

        setUi((prev) => ({
          ...prev,
          stage: "running",
          progress: typeof data.progress === "number" ? data.progress : prev.progress,
          currentStage: data.current_stage ?? prev.currentStage,
        }));
      } catch (err) {
        clearPolling();
        const message =
          err instanceof Error ? err.message : "Could not check job status.";
        setUi({
          stage: "error",
          results: [],
          progress: 0,
          currentStage: "",
          error: message,
        });
        toast.error(message);
      }
    },
    [userJwt, clearPolling]
  );

  const startPolling = useCallback(
    (jobId: string) => {
      clearPolling();
      void pollJob(jobId);
      pollTimerRef.current = setInterval(() => {
        void pollJob(jobId);
      }, POLL_INTERVAL_MS);
    },
    [pollJob, clearPolling]
  );

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = prompt.trim();
    if (!trimmed) {
      toast.error("Please describe your ideal customer first.");
      return;
    }
    if (!user?.jwt || !user.email) {
      toast.error("Your session has expired. Please sign in again.");
      return;
    }

    clearPolling();
    setSubmitting(true);
    setActiveJobId(null);
    setUi({
      stage: "running",
      results: [],
      progress: 5,
      currentStage: "queued",
      error: null,
    });

    try {
      const res = await fetch(`${EDGE_FUNCTIONS_BASE_URL}/start-search`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${user.jwt}`,
        },
        body: JSON.stringify({ icpPrompt: trimmed, userEmail: user.email }),
      });

      const data = (await res.json()) as StartSearchResponse;
      if (!res.ok || data.error) {
        throw new Error(data.error ?? `Request failed (${res.status})`);
      }

      if (data.cached && data.results) {
        setUi({
          stage: "done",
          results: data.results,
          progress: 100,
          currentStage: "completed",
          error: null,
        });
        toast.success("Found cached results in an instant.");
        return;
      }

      if (data.jobId) {
        setActiveJobId(data.jobId);
        startPolling(data.jobId);
        toast.info(
          "⏱ Estimated time: 2–4 minutes. We'll notify you when results are ready.",
          { duration: 8000 }
        );
      } else {
        throw new Error("Unexpected response from start-search.");
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Could not start the search.";
      setUi({
        stage: "error",
        results: [],
        progress: 0,
        currentStage: "",
        error: message,
      });
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  }

  function handleSamplePrompt(text: string) {
    setPrompt(text);
  }

  function handleReset() {
    clearPolling();
    setUi(INITIAL_STATE);
    setPrompt("");
    // Strip any ?searchId= / ?prompt= params to keep the URL clean.
    router.replace("/");
  }

  const isRunning = ui.stage === "running";
  const showResults = ui.stage === "done" && ui.results.length >= 0;

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-heading text-3xl font-semibold tracking-tight text-foreground">
          Find Your Ideal Leads
        </h1>
        <p className="text-base text-muted-foreground">
          Describe your ideal customer and let AI find them on LinkedIn.
        </p>
      </header>

      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Sparkles className="size-4 text-[#6d47f5]" />
            Describe your ICP
          </CardTitle>
          <CardDescription>
            Be specific about industry, geography, role, follower range or any
            behavioural signals.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={6}
              disabled={submitting || isRunning}
              placeholder="e.g. B2B SaaS founder in USA or UK, less than 10k followers, does outreach alone, bootstrapped..."
              className="min-h-[150px] resize-none rounded-xl bg-background p-4 text-sm leading-relaxed"
            />

            <div className="flex flex-wrap gap-2">
              {SAMPLE_PROMPTS.map((sample) => (
                <button
                  type="button"
                  key={sample}
                  onClick={() => handleSamplePrompt(sample)}
                  disabled={submitting || isRunning}
                  className={cn(
                    "rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors",
                    "hover:border-[#6d47f5]/60 hover:bg-[#6d47f5]/5 hover:text-foreground",
                    "disabled:cursor-not-allowed disabled:opacity-60"
                  )}
                >
                  {sample}
                </button>
              ))}
            </div>

            <Button
              type="submit"
              size="lg"
              disabled={submitting || isRunning || !prompt.trim()}
              className="h-12 w-full rounded-xl bg-[#6d47f5] text-base font-medium text-white hover:bg-[#6d47f5]/90"
            >
              <Search className="size-4" />
              {isRunning ? "Searching..." : submitting ? "Starting..." : "Search"}
            </Button>
          </form>
        </CardContent>
      </Card>

      {isRunning && (
        <Card className="rounded-2xl">
          <CardContent className="flex flex-col gap-3 py-5">
            <div className="flex items-center justify-between gap-3">
              <p
                key={ui.currentStage}
                className="animate-stage-fade font-heading text-sm font-medium text-foreground"
              >
                {stageLabel(ui.currentStage)}
              </p>
              <span className="text-sm font-medium tabular-nums text-muted-foreground">
                {Math.round(ui.progress)}%
              </span>
            </div>
            <Progress value={ui.progress} className="h-2 rounded-full" />
          </CardContent>
        </Card>
      )}

      {ui.stage === "error" && ui.error && (
        <Card className="rounded-2xl border-[#ef4444]/40">
          <CardHeader>
            <CardTitle className="text-base text-[#ef4444]">
              Search failed
            </CardTitle>
            <CardDescription>{ui.error}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              variant="outline"
              onClick={handleReset}
              className="rounded-xl"
            >
              Try again
            </Button>
          </CardContent>
        </Card>
      )}

      {showResults && (
        <SearchResultsTable
          results={ui.results}
          userEmail={user?.email ?? ""}
        />
      )}
    </div>
  );
}
