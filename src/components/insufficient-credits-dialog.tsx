"use client";

import { AlertTriangle, ShoppingCart } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { formatCredits, SEARCH_COST } from "@/lib/credits";

interface InsufficientCreditsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  balance: number;
  onBuyMore?: () => void;
}

export function InsufficientCreditsDialog({
  open,
  onOpenChange,
  balance,
  onBuyMore,
}: InsufficientCreditsDialogProps) {
  function handleBuyMore() {
    onOpenChange(false);
    onBuyMore?.();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm sm:max-w-sm">
        <DialogHeader>
          <div className="flex size-10 items-center justify-center rounded-xl bg-[#f59e0b]/15 text-[#b45309] dark:bg-[#f59e0b]/20 dark:text-[#fbbf24]">
            <AlertTriangle className="size-5" />
          </div>
          <DialogTitle className="text-lg">You&apos;re out of credits</DialogTitle>
          <DialogDescription>
            You need {SEARCH_COST} credits to start a new search. You currently
            have{" "}
            <span className="font-semibold text-foreground">
              {formatCredits(balance)}
            </span>
            .
          </DialogDescription>
        </DialogHeader>

        <DialogFooter className="flex flex-col gap-2 sm:flex-row">
          <Button
            type="button"
            onClick={handleBuyMore}
            className="h-10 w-full rounded-xl bg-[#6d47f5] text-white hover:bg-[#6d47f5]/90 sm:flex-1"
          >
            <ShoppingCart className="size-4" />
            Buy more credits
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="h-10 w-full rounded-xl sm:w-auto"
          >
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
