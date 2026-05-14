"use client";

import { useMemo, useState } from "react";
import { Bookmark, BookmarkCheck, ExternalLink, MapPin } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { LeadDetailSheet } from "@/components/lead-detail-sheet";
import { ScoreBadge } from "@/components/score-badge";
import { avatarHue, formatFollowers, truncate } from "@/lib/format";
import { saveLead } from "@/lib/leads";
import { cn } from "@/lib/utils";
import type { SearchResult } from "@/lib/types";

interface SearchResultsTableProps {
  results: SearchResult[];
  userEmail: string;
  title?: string;
}

export function SearchResultsTable({
  results,
  userEmail,
  title = "Results",
}: SearchResultsTableProps) {
  const sorted = useMemo(
    () =>
      [...results].sort(
        (a, b) => (b.match_score ?? -1) - (a.match_score ?? -1)
      ),
    [results]
  );

  // Saved-IDs are derived from props (server state) PLUS a local override
  // for items the user saves during this session — no effect needed.
  const baseSavedIds = useMemo(() => {
    const set = new Set<string>();
    for (const r of results) if (r.saved_to_crm) set.add(r.id);
    return set;
  }, [results]);

  const [extraSavedIds, setExtraSavedIds] = useState<Set<string>>(new Set());
  const savedIds = useMemo(() => {
    if (extraSavedIds.size === 0) return baseSavedIds;
    const merged = new Set(baseSavedIds);
    for (const id of extraSavedIds) merged.add(id);
    return merged;
  }, [baseSavedIds, extraSavedIds]);

  const [savingIds, setSavingIds] = useState<Set<string>>(new Set());
  const [active, setActive] = useState<SearchResult | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  async function handleSave(result: SearchResult) {
    if (savedIds.has(result.id) || savingIds.has(result.id)) return;

    setSavingIds((prev) => {
      const next = new Set(prev);
      next.add(result.id);
      return next;
    });

    const res = await saveLead(result, userEmail);

    setSavingIds((prev) => {
      const next = new Set(prev);
      next.delete(result.id);
      return next;
    });

    if (res.outcome === "saved") {
      setExtraSavedIds((prev) => {
        const next = new Set(prev);
        next.add(result.id);
        return next;
      });
      toast.success("Lead saved");
    } else if (res.outcome === "already_exists") {
      setExtraSavedIds((prev) => {
        const next = new Set(prev);
        next.add(result.id);
        return next;
      });
      toast.info("Lead already saved");
    } else {
      toast.error(res.message ?? "Could not save the lead. Please try again.");
    }
  }

  function openDetail(result: SearchResult) {
    setActive(result);
    setSheetOpen(true);
  }

  if (sorted.length === 0) {
    return (
      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle className="text-lg">{title}</CardTitle>
          <CardDescription>No matches found.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <>
      <Card className="rounded-2xl">
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle className="text-lg">{title}</CardTitle>
              <CardDescription>
                Found {sorted.length} {sorted.length === 1 ? "match" : "matches"}
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow className="border-border">
                <TableHead className="pl-6">Name</TableHead>
                <TableHead>Headline</TableHead>
                <TableHead className="w-32">Location</TableHead>
                <TableHead className="text-right">Followers</TableHead>
                <TableHead className="text-center">Score</TableHead>
                <TableHead className="pr-6 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((r) => {
                const initial = r.full_name?.[0]?.toUpperCase() ?? "?";
                const hue = avatarHue(r.full_name ?? r.linkedin_url ?? r.id);
                const saved = savedIds.has(r.id);
                const saving = savingIds.has(r.id);

                return (
                  <TableRow
                    key={r.id}
                    onClick={() => openDetail(r)}
                    className="cursor-pointer"
                  >
                    <TableCell className="pl-6">
                      <div className="flex items-center gap-3">
                        <div
                          className="flex size-9 shrink-0 items-center justify-center rounded-xl text-sm font-semibold text-white"
                          style={{
                            backgroundColor: `hsl(${hue} 65% 55%)`,
                          }}
                        >
                          {initial}
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate text-sm font-medium text-foreground">
                              {r.full_name ?? "—"}
                            </span>
                            {r.linkedin_url && (
                              <a
                                href={r.linkedin_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-muted-foreground hover:text-[#6d47f5]"
                                aria-label="Open on LinkedIn"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <ExternalLink className="size-3.5" />
                              </a>
                            )}
                          </div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <p
                        className="max-w-xs truncate text-sm text-muted-foreground"
                        title={r.headline ?? ""}
                      >
                        {truncate(r.headline, 60) || "—"}
                      </p>
                    </TableCell>
                    <TableCell className="w-32 max-w-[8rem]">
                      {r.location ? (
                        <span
                          className="inline-flex max-w-full items-center gap-1.5 text-sm text-muted-foreground"
                          title={r.location}
                        >
                          <MapPin className="size-3.5 shrink-0" />
                          <span className="truncate">{r.location}</span>
                        </span>
                      ) : (
                        <span className="text-sm text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right text-sm tabular-nums text-muted-foreground">
                      {formatFollowers(r.follower_count)}
                    </TableCell>
                    <TableCell className="text-center">
                      <ScoreBadge score={r.match_score} size="md" />
                    </TableCell>
                    <TableCell className="pr-6 text-right">
                      <Button
                        type="button"
                        size="sm"
                        variant={saved ? "ghost" : "outline"}
                        disabled={saved || saving}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleSave(r);
                        }}
                        className={cn(
                          "rounded-xl",
                          saved &&
                            "pointer-events-none text-[#10b981] dark:text-[#34d399]"
                        )}
                      >
                        {saved ? (
                          <>
                            <BookmarkCheck className="size-4" />
                            Saved
                          </>
                        ) : (
                          <>
                            <Bookmark className="size-4" />
                            {saving ? "Saving..." : "Save Lead"}
                          </>
                        )}
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <LeadDetailSheet
        result={active}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        isSaved={active ? savedIds.has(active.id) : false}
        isSaving={active ? savingIds.has(active.id) : false}
        onSave={handleSave}
      />
    </>
  );
}
