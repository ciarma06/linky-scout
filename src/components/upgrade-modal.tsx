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

const BENEFITS = [
  "Save unlimited leads from your searches",
  "AI-powered message generation on LinkedIn",
  "Seamless workflow between Scout and Assistant",
] as const;

export type UpgradeModalProps = {
  open: boolean;
  onClose: () => void;
};

export function UpgradeModal({ open, onClose }: UpgradeModalProps) {
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
          <DialogTitle className="font-heading text-lg">
            Save leads with Linky Assistant
          </DialogTitle>
          <DialogDescription className="text-sm leading-relaxed">
            Saving leads is included in Linky Assistant and Bundle plans.
            Upgrade to keep your best prospects organized and pipe them straight
            into AI-powered outreach.
          </DialogDescription>
        </DialogHeader>

        <ul className="flex flex-col gap-2.5">
          {BENEFITS.map((text) => (
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
            <a
              href={UPGRADE_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              Get Linky Assistant →
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
