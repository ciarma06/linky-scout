"use client";

import { useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { CREDIT_PACKS, formatCredits, startCheckout } from "@/lib/credits";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/utils";

interface BuyCreditsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function BuyCreditsModal({ open, onOpenChange }: BuyCreditsModalProps) {
  const { user } = useAuth();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const locked = user?.plan === "assistant";

  async function handlePurchase(priceId: string, packId: string) {
    if (locked) return;
    if (!user?.email) {
      toast.error("Please sign in again.");
      return;
    }
    setPendingId(packId);
    try {
      await startCheckout(priceId, user.email);
      // startCheckout redirects to Stripe — keep spinner going until navigation.
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Could not start checkout.";
      toast.error(message);
      setPendingId(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-full sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-xl">Get more credits</DialogTitle>
          <DialogDescription>
            One-time purchases — credits never expire
          </DialogDescription>
        </DialogHeader>

        {locked && (
          <p className="rounded-xl bg-muted/60 px-4 py-3 text-sm text-muted-foreground">
            Upgrade to Scout or Bundle to buy credit packs.
          </p>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {CREDIT_PACKS.map((pack) => {
            const busy = pendingId === pack.id;
            const disabled = locked || (pendingId !== null && !busy);

            return (
              <div
                key={pack.id}
                className={cn(
                  "flex min-w-0 flex-col overflow-hidden rounded-2xl border bg-card transition-colors",
                  pack.recommended
                    ? "border-[#6d47f5] ring-1 ring-[#6d47f5]/30"
                    : "border-border",
                  locked && "opacity-60",
                )}
                title={
                  locked
                    ? "Upgrade to Scout or Bundle to buy credit packs"
                    : undefined
                }
              >
                {/* Badge strip — only for recommended pack */}
                {pack.recommended ? (
                  <div className="flex items-center justify-center bg-[#6d47f5]/10 py-1.5 dark:bg-[#6d47f5]/20">
                    <span className="text-[11px] font-semibold uppercase tracking-widest text-[#6d47f5] dark:text-[#a48cff]">
                      ✦ Most Popular
                    </span>
                  </div>
                ) : (
                  /* Invisible spacer so all cards are the same height */
                  <div className="py-1.5" aria-hidden />
                )}

                <div className="flex flex-1 flex-col gap-4 p-5">
                  {/* Name + tagline */}
                  <div className="flex flex-col gap-1">
                    <p className="font-heading text-base font-bold text-foreground">
                      {pack.name}
                    </p>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {pack.tagline}
                    </p>
                  </div>

                  {/* Credits count */}
                  <div className="flex flex-col gap-0.5">
                    <span className="font-heading text-3xl font-bold tabular-nums leading-none text-foreground">
                      {formatCredits(pack.credits)}
                    </span>
                    <span className="text-xs font-medium text-muted-foreground">
                      credits
                    </span>
                  </div>

                  {/* Price */}
                  <p className="font-heading text-xl font-semibold tabular-nums text-foreground">
                    {pack.priceLabel}
                  </p>

                  {/* CTA */}
                  <Button
                    type="button"
                    onClick={() => handlePurchase(pack.priceId, pack.id)}
                    disabled={disabled}
                    title={
                      locked
                        ? "Upgrade to Scout or Bundle to buy credit packs"
                        : undefined
                    }
                    className={cn(
                      "mt-auto h-10 w-full rounded-xl text-sm font-semibold",
                      pack.recommended
                        ? "bg-[#6d47f5] text-white hover:bg-[#6d47f5]/90"
                        : "bg-foreground/90 text-background hover:bg-foreground",
                    )}
                  >
                    {busy ? (
                      <>
                        <Loader2 className="size-4 animate-spin" />
                        Loading...
                      </>
                    ) : (
                      <>
                        <Sparkles className="size-4" />
                        Buy now
                      </>
                    )}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
