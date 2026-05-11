"use client";

import { Bookmark, BookmarkCheck, ExternalLink, MapPin, Users } from "lucide-react";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { ScoreBadge } from "@/components/score-badge";
import { avatarHue, formatFollowers, formatShortDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { SearchResult } from "@/lib/types";

interface LeadDetailSheetProps {
  result: SearchResult | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isSaved: boolean;
  isSaving: boolean;
  onSave: (result: SearchResult) => void;
}

export function LeadDetailSheet({
  result,
  open,
  onOpenChange,
  isSaved,
  isSaving,
  onSave,
}: LeadDetailSheetProps) {
  if (!result) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent className="sm:max-w-xl" />
      </Sheet>
    );
  }

  const initial = result.full_name?.[0]?.toUpperCase() ?? "?";
  const hue = avatarHue(result.full_name ?? result.linkedin_url ?? "");

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className="flex w-full flex-col gap-0 overflow-y-auto p-0 sm:max-w-xl"
      >
        <SheetHeader className="border-b border-border p-6">
          <div className="flex items-start gap-4">
            <div
              className="flex size-12 shrink-0 items-center justify-center rounded-2xl text-base font-semibold text-white shadow-sm"
              style={{
                backgroundColor: `hsl(${hue} 65% 55%)`,
              }}
            >
              {initial}
            </div>
            <div className="min-w-0 flex-1">
              <SheetTitle className="font-heading text-xl font-semibold">
                {result.full_name ?? "Unknown"}
              </SheetTitle>
              {result.headline && (
                <SheetDescription className="mt-1 text-sm">
                  {result.headline}
                </SheetDescription>
              )}
              <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                {result.location && (
                  <span className="inline-flex items-center gap-1.5">
                    <MapPin className="size-3.5" />
                    {result.location}
                  </span>
                )}
                {result.follower_count != null && (
                  <span className="inline-flex items-center gap-1.5">
                    <Users className="size-3.5" />
                    {formatFollowers(result.follower_count)} followers
                  </span>
                )}
              </div>
            </div>
            <ScoreBadge score={result.match_score} size="lg" />
          </div>
        </SheetHeader>

        <div className="flex flex-1 flex-col gap-6 p-6">
          {result.match_reason && (
            <section>
              <h3 className="mb-2 font-heading text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Match reason
              </h3>
              <p className="text-sm leading-relaxed text-foreground">
                {result.match_reason}
              </p>
            </section>
          )}

          {result.best_context && (
            <section>
              <h3 className="mb-2 font-heading text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Best context
              </h3>
              <blockquote
                className={cn(
                  "rounded-xl border-l-4 border-[#6d47f5] bg-[#6d47f5]/5 p-4 text-sm italic leading-relaxed text-foreground",
                  "dark:bg-[#6d47f5]/10"
                )}
              >
                “{result.best_context}”
              </blockquote>
            </section>
          )}

          {result.bio && (
            <section>
              <h3 className="mb-2 font-heading text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Bio
              </h3>
              <p className="whitespace-pre-line text-sm leading-relaxed text-foreground">
                {result.bio}
              </p>
            </section>
          )}

          {Array.isArray(result.recent_posts) &&
            result.recent_posts.length > 0 && (
              <section>
                <h3 className="mb-2 font-heading text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  Recent posts
                </h3>
                <ul className="flex flex-col gap-3">
                  {result.recent_posts.map((post, idx) => (
                    <li
                      key={idx}
                      className="rounded-xl border border-border bg-card p-3"
                    >
                      <p className="text-sm leading-relaxed text-foreground">
                        {post.text ?? ""}
                      </p>
                      {post.postedAt && (
                        <p className="mt-2 text-xs text-muted-foreground">
                          {formatShortDate(post.postedAt)}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}

          {result.linkedin_url && (
            <a
              href={result.linkedin_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 self-start rounded-xl px-3 py-2 text-sm font-medium text-[#6d47f5] hover:bg-[#6d47f5]/10 dark:text-[#a48cff] dark:hover:bg-[#6d47f5]/20"
            >
              <ExternalLink className="size-4" />
              Open on LinkedIn
            </a>
          )}
        </div>

        <div className="sticky bottom-0 border-t border-border bg-card p-4">
          <Button
            type="button"
            size="lg"
            disabled={isSaved || isSaving}
            onClick={() => onSave(result)}
            className={cn(
              "h-11 w-full rounded-xl text-white",
              isSaved
                ? "bg-[#10b981] hover:bg-[#10b981]/90"
                : "bg-[#6d47f5] hover:bg-[#6d47f5]/90"
            )}
          >
            {isSaved ? (
              <>
                <BookmarkCheck className="size-4" />
                Saved
              </>
            ) : (
              <>
                <Bookmark className="size-4" />
                {isSaving ? "Saving..." : "Save Lead"}
              </>
            )}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
