//components/score-badge.tsx

import { cn } from "@/lib/utils";

interface ScoreBadgeProps {
  score: number | null | undefined;
  size?: "sm" | "md" | "lg";
  className?: string;
}

export function ScoreBadge({ score, size = "sm", className }: ScoreBadgeProps) {
  const n = typeof score === "number" ? Math.round(score) : null;

  const sizeClass =
    size === "lg"
      ? "h-9 min-w-14 px-3 text-base"
      : size === "md"
        ? "h-7 min-w-11 px-2.5 text-sm"
        : "h-6 min-w-10 px-2 text-xs";

  if (n == null) {
    return (
      <span
        className={cn(
          "inline-flex items-center justify-center rounded-full bg-muted font-semibold text-muted-foreground",
          sizeClass,
          className
        )}
      >
        —
      </span>
    );
  }

  let tone: { bg: string; text: string };
  if (n >= 80) {
    tone = {
      bg: "bg-[#10b981]/15 dark:bg-[#10b981]/20",
      text: "text-[#047857] dark:text-[#34d399]",
    };
  } else if (n >= 60) {
    tone = {
      bg: "bg-[#f59e0b]/15 dark:bg-[#f59e0b]/20",
      text: "text-[#b45309] dark:text-[#fbbf24]",
    };
  } else {
    tone = {
      bg: "bg-muted",
      text: "text-muted-foreground",
    };
  }

  return (
    <span
      className={cn(
        "inline-flex items-center justify-center rounded-full font-semibold tabular-nums",
        sizeClass,
        tone.bg,
        tone.text,
        className
      )}
    >
      {n}
    </span>
  );
}
