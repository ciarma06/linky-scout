"use client";

import Link from "next/link";
import { Coins } from "lucide-react";

import { CURRENT_CREDITS, formatCredits } from "@/lib/credits";
import { cn } from "@/lib/utils";

interface CreditsBadgeProps {
  className?: string;
}

export function CreditsBadge({ className }: CreditsBadgeProps) {
  return (
    <Link
      href="/settings"
      aria-label={`${formatCredits(CURRENT_CREDITS)} credits available. Open settings.`}
      title="View your credits in Settings"
      className={cn(
        "inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 shadow-sm transition-colors",
        "hover:border-[#6d47f5]/60 hover:bg-[#6d47f5]/5",
        className
      )}
    >
      <span className="flex size-6 items-center justify-center rounded-full bg-[#6d47f5]/10 text-[#6d47f5] dark:bg-[#6d47f5]/20 dark:text-[#a48cff]">
        <Coins className="size-3.5" />
      </span>
      <span className="text-sm font-semibold tabular-nums text-foreground">
        {formatCredits(CURRENT_CREDITS)}
      </span>
      <span className="text-xs font-medium text-muted-foreground">credits</span>
    </Link>
  );
}
