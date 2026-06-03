"use client";

import { useEffect, useState } from "react";
import { ExternalLink, Trash2 } from "lucide-react";
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
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SavedLeadsLocked } from "@/components/saved-leads-locked";
import { useAuth } from "@/lib/auth-context";
import { canSaveLeads } from "@/lib/access";
import { useCredits } from "@/lib/credits-context";
import { avatarHue, formatRelativeDate, truncate } from "@/lib/format";
import { getSupabaseBrowserClient } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import type { SavedLead } from "@/lib/types";

export default function SavedLeadsPage() {
  const { user } = useAuth();
  const { plan, isLoading: creditsLoading, refresh } = useCredits();
  const [leads, setLeads] = useState<SavedLead[]>([]);
  const [loading, setLoading] = useState(true);
  const [pendingDelete, setPendingDelete] = useState<SavedLead | null>(null);
  const [deleting, setDeleting] = useState(false);

  const userEmail = user?.email;

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per page mount
  }, []);

  useEffect(() => {
    if (!userEmail || !canSaveLeads(plan)) return;

    let cancelled = false;
    async function load() {
      const supabase = getSupabaseBrowserClient();
      const { data, error } = await supabase
        .from("profili_salvati")
        .select("*")
        .eq("user_email", userEmail!)
        .order("created_at", { ascending: false });

      if (cancelled) return;

      if (error) {
        toast.error("Could not load your saved leads.");
        setLoading(false);
        return;
      }
      setLeads((data ?? []) as SavedLead[]);
      setLoading(false);
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [userEmail, plan]);

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    const supabase = getSupabaseBrowserClient();
    const { error } = await supabase
      .from("profili_salvati")
      .delete()
      .eq("id", pendingDelete.id);
    setDeleting(false);

    if (error) {
      toast.error("Could not remove the lead.");
      return;
    }

    setLeads((prev) => prev.filter((l) => l.id !== pendingDelete.id));
    setPendingDelete(null);
    toast.success("Lead removed.");
  }

  if (creditsLoading) {
    return (
      <div className="flex flex-col gap-8">
        <header className="flex flex-col gap-2">
          <h1 className="font-heading text-3xl font-semibold tracking-tight text-foreground">
            Saved Leads
          </h1>
        </header>
        <LeadsSkeleton />
      </div>
    );
  }

  if (!canSaveLeads(plan)) {
    return <SavedLeadsLocked />;
  }

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-heading text-3xl font-semibold tracking-tight text-foreground">
          Saved Leads
        </h1>
        <p className="text-base text-muted-foreground">
          All your saved prospects
          {!loading && (
            <span className="ml-1 text-muted-foreground">
              · {leads.length} {leads.length === 1 ? "lead" : "leads"}
            </span>
          )}
        </p>
      </header>

      {loading ? (
        <LeadsSkeleton />
      ) : leads.length === 0 ? (
        <Card className="rounded-2xl">
          <CardHeader>
            <CardTitle className="text-lg">No saved leads yet</CardTitle>
            <CardDescription>
              Save prospects from a search to see them here.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <Card className="rounded-2xl">
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow className="border-border">
                  <TableHead className="pl-6">Name</TableHead>
                  <TableHead>Headline</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Context</TableHead>
                  <TableHead>Saved on</TableHead>
                  <TableHead className="pr-6 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {leads.map((lead) => {
                  const initial = lead.full_name?.[0]?.toUpperCase() ?? "?";
                  const hue = avatarHue(
                    lead.full_name ?? lead.linkedin_url ?? lead.id
                  );
                  const isScout = isScoutSource(lead);
                  return (
                    <TableRow key={lead.id}>
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
                                {lead.full_name ?? "—"}
                              </span>
                              {lead.linkedin_url && (
                                <a
                                  href={lead.linkedin_url}
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
                          title={lead.headline ?? ""}
                        >
                          {truncate(lead.headline, 60) || "—"}
                        </p>
                      </TableCell>
                      <TableCell>
                        <SourceBadge isScout={isScout} />
                      </TableCell>
                      <TableCell>
                        <p
                          className="max-w-xs truncate text-sm text-muted-foreground"
                          title={lead.comment_text ?? ""}
                        >
                          {truncate(lead.comment_text, 60) || "—"}
                        </p>
                      </TableCell>
                      <TableCell>
                        <span className="text-sm text-muted-foreground">
                          {formatRelativeDate(lead.created_at)}
                        </span>
                      </TableCell>
                      <TableCell className="pr-6 text-right">
                        <Button
                          type="button"
                          size="sm"
                          variant="destructive"
                          className="rounded-xl"
                          onClick={() => setPendingDelete(lead)}
                        >
                          <Trash2 className="size-4" />
                          Remove
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Dialog
        open={!!pendingDelete}
        onOpenChange={(open) => !open && !deleting && setPendingDelete(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove this lead?</DialogTitle>
            <DialogDescription>
              {pendingDelete?.full_name
                ? `${pendingDelete.full_name} will be removed from your saved leads. This action cannot be undone.`
                : "This action cannot be undone."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={deleting}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              variant="destructive"
              onClick={confirmDelete}
              disabled={deleting}
              className="rounded-xl"
            >
              {deleting ? "Removing..." : "Remove"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function isScoutSource(lead: SavedLead): boolean {
  if (typeof lead.source === "string" && lead.source.toLowerCase() === "scout") {
    return true;
  }
  if (typeof lead.source === "string" && lead.source.length > 0) {
    return false;
  }
  // Fallback heuristic: leads saved from Scout always carry a match context
  // (best_context or match_reason) in comment_text. Leads saved from the
  // Linky Assistant extension typically come from real LinkedIn comments.
  return !!lead.comment_text && lead.comment_text.length > 20;
}

function SourceBadge({ isScout }: { isScout: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center rounded-full px-2.5 text-xs font-medium",
        isScout
          ? "bg-[#6d47f5]/10 text-[#6d47f5] dark:bg-[#6d47f5]/20 dark:text-[#a48cff]"
          : "bg-[#3b82f6]/10 text-[#2563eb] dark:bg-[#3b82f6]/20 dark:text-[#93c5fd]"
      )}
    >
      {isScout ? "Scout" : "Extension"}
    </span>
  );
}

function LeadsSkeleton() {
  return (
    <Card className="rounded-2xl">
      <CardContent className="flex flex-col gap-3 py-5">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center gap-3">
            <div className="size-9 animate-pulse rounded-xl bg-muted" />
            <div className="flex-1 space-y-2">
              <div className="h-3 w-1/3 animate-pulse rounded-full bg-muted" />
              <div className="h-3 w-2/3 animate-pulse rounded-full bg-muted" />
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
