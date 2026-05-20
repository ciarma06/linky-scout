"use client";

import { useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { CREDIT_PACKS, formatCredits, startCheckout } from "@/lib/credits";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/utils";

interface CreditPacksProps {
  /**
   * Visual variant. "grid" stacks them as full cards (settings page),
   * "compact" lays them out as a tight row (insufficient-credits modal).
   */
  variant?: "grid" | "compact";
  /**
   * When true, disable purchase with a tooltip explaining the user must
   * upgrade. Used when `plan === 'assistant'`.
   */
  locked?: boolean;
  lockedReason?: string;
}

export function CreditPacks({
  variant = "grid",
  locked = false,
  lockedReason,
}: CreditPacksProps) {
  const { user } = useAuth();
  const [pendingId, setPendingId] = useState<string | null>(null);

  async function handlePurchase(priceId: string, packId: string) {
    if (locked) {
      toast.error(lockedReason ?? "Upgrade to Scout to buy credit packs.");
      return;
    }
    if (!user?.email) {
      toast.error("Please sign in again.");
      return;
    }

    setPendingId(packId);
    try {
      await startCheckout(priceId, user.email);
      // startCheckout already redirects to Stripe — if we end up here the
      // navigation hasn't happened yet, keep the spinner spinning.
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Could not start checkout.";
      toast.error(message);
      setPendingId(null);
    }
  }

  return (
    <div
      className={cn(
        variant === "grid"
          ? "grid grid-cols-1 gap-3 sm:grid-cols-3"
          : "flex flex-col gap-2 sm:flex-row",
      )}
    >
      {CREDIT_PACKS.map((pack) => {
        const busy = pendingId === pack.id;
        const disabled = locked || (pendingId !== null && !busy);

        return (
          <div
            key={pack.id}
            className={cn(
              "flex flex-col gap-3 rounded-2xl border bg-card p-4 transition-colors",
              pack.recommended
                ? "border-[#6d47f5] ring-1 ring-[#6d47f5]/30"
                : "border-border",
              locked && "opacity-60",
            )}
            title={locked ? lockedReason : undefined}
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-heading text-sm font-semibold text-foreground">
                  {pack.name}
                </p>
                <p className="text-xs text-muted-foreground">{pack.tagline}</p>
              </div>
              {pack.recommended && (
                <span className="inline-flex h-5 shrink-0 items-center rounded-full bg-[#6d47f5] px-2 text-[10px] font-semibold uppercase tracking-wide text-white">
                  Best
                </span>
              )}
            </div>

            <div className="flex items-baseline gap-1.5">
              <span className="font-heading text-2xl font-semibold tabular-nums leading-none text-foreground">
                {formatCredits(pack.credits)}
              </span>
              <span className="text-xs font-medium text-muted-foreground">
                credits
              </span>
              <span className="ml-auto text-sm font-semibold text-foreground">
                {pack.priceLabel}
              </span>
            </div>

            <Button
              type="button"
              onClick={() => handlePurchase(pack.priceId, pack.id)}
              disabled={disabled}
              className={cn(
                "h-9 w-full rounded-xl text-sm",
                pack.recommended
                  ? "bg-[#6d47f5] text-white hover:bg-[#6d47f5]/90"
                  : "bg-foreground/90 text-background hover:bg-foreground",
              )}
            >
              {busy ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Redirecting…
                </>
              ) : (
                <>
                  <Sparkles className="size-4" />
                  Buy {pack.name}
                </>
              )}
            </Button>
          </div>
        );
      })}
    </div>
  );
}
