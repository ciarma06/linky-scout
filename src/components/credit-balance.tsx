"use client";

import Link from "next/link";
import { Coins } from "lucide-react";

import { useCredits } from "@/lib/credits-context";
import { formatCredits, totalCredits } from "@/lib/credits";
import { cn } from "@/lib/utils";

interface CreditBalanceProps {
  className?: string;
  /**
   * Compact variant for the sidebar (no "credits" label, smaller spacing).
   */
  compact?: boolean;
}

export function CreditBalance({ className, compact = false }: CreditBalanceProps) {
  const { credits, isLoading } = useCredits();
  const balance = totalCredits(credits);

  const label = isLoading && !credits ? "—" : formatCredits(balance);

  return (
    <Link
      href="/settings#credits"
      aria-label={`${label} credits remaining. Open credits in Settings.`}
      title="View and buy credits"
      className={cn(
        "inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 shadow-sm transition-colors",
        "hover:border-[#6d47f5]/60 hover:bg-[#6d47f5]/5",
        compact && "w-full justify-start",
        className,
      )}
    >
      <span className="flex size-6 items-center justify-center rounded-full bg-[#6d47f5]/10 text-[#6d47f5] dark:bg-[#6d47f5]/20 dark:text-[#a48cff]">
        <Coins className="size-3.5" />
      </span>
      <span
        className={cn(
          "text-sm font-semibold tabular-nums text-foreground",
          isLoading && !credits && "opacity-50",
        )}
      >
        {label}
      </span>
      {!compact && (
        <span className="text-xs font-medium text-muted-foreground">
          credits
        </span>
      )}
      {compact && (
        <span className="text-xs font-medium text-muted-foreground">
          credits remaining
        </span>
      )}
    </Link>
  );
}
