"use client";

import { Check } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const UPGRADE_URL = "https://www.linkyassistant.com/#pricing";

const SAVE_LEADS_BENEFITS = [
  "Save unlimited leads from your searches",
  "AI-powered message generation on LinkedIn",
  "Seamless workflow between Scout and Assistant",
] as const;

const CUSTOM_SEARCH_BENEFITS = [
  "Search any role, industry, or geography on LinkedIn",
  "Behavioral search — find leads by what they post",
  "Save and organize leads across searches",
] as const;

export type UpgradeModalProps = {
  open: boolean;
  onClose: () => void;
  reason?: "save_leads" | "custom_search" | "access_denied";
};

export function UpgradeModal({
  open,
  onClose,
  reason = "save_leads",
}: UpgradeModalProps) {
  const isCustomSearch = reason === "custom_search";
  const isAccessDenied = reason === "access_denied";

  const title = isAccessDenied
    ? "Your plan is no longer active"
    : isCustomSearch
      ? "Run custom searches with a paid plan"
      : "Save leads with Linky Assistant";
  const description = isAccessDenied
    ? "Your subscription or trial has ended. Upgrade or renew your plan to continue finding leads on LinkedIn."
    : isCustomSearch
      ? "Your trial includes only the sample searches. Upgrade to search any audience on LinkedIn and unlock your full prospecting workflow."
      : "Saving leads is included in Linky Assistant and Bundle plans. Upgrade to keep your best prospects organized and pipe them straight into AI-powered outreach.";
  const benefits = isCustomSearch || isAccessDenied
    ? CUSTOM_SEARCH_BENEFITS
    : SAVE_LEADS_BENEFITS;
  const primaryCta = isAccessDenied ? "View plans →" : "Get Linky Assistant →";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        className="gap-5 sm:max-w-md"
        overlayClassName="bg-black/60 supports-backdrop-filter:backdrop-blur-sm"
      >
        <DialogHeader>
          <DialogTitle className="font-heading text-lg">{title}</DialogTitle>
          <DialogDescription className="text-sm leading-relaxed">
            {description}
          </DialogDescription>
        </DialogHeader>

        <ul className="flex flex-col gap-2.5">
          {benefits.map((text) => (
            <li key={text} className="flex items-start gap-2.5 text-sm">
              <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-[#6d47f5]/10 text-[#6d47f5]">
                <Check className="size-3" strokeWidth={2.5} />
              </span>
              <span className="text-foreground">{text}</span>
            </li>
          ))}
        </ul>

        <DialogFooter className="flex-col gap-2 sm:flex-col">
          <Button asChild className="w-full rounded-xl">
            <a href={UPGRADE_URL} target="_blank" rel="noopener noreferrer">
              {primaryCta}
            </a>
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="w-full rounded-xl"
            onClick={onClose}
          >
            Maybe later
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
