"use client";

import Link from "next/link";
import { Lock } from "lucide-react";

import { Button } from "@/components/ui/button";

const UPGRADE_URL = "https://www.linkyassistant.com/#pricing";

export function SavedLeadsLocked() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4 py-16 text-center">
      <div className="mb-5 flex size-14 items-center justify-center rounded-2xl bg-muted">
        <Lock className="size-7 text-muted-foreground" />
      </div>
      <h2 className="font-heading text-xl font-semibold tracking-tight text-foreground">
        Saved Leads is part of Linky Assistant
      </h2>
      <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
        Upgrade to Assistant or Bundle to save and organize leads from your
        searches.
      </p>
      <Button asChild className="mt-6 rounded-xl">
        <a
          href={UPGRADE_URL}
          target="_blank"
          rel="noopener noreferrer"
        >
          Get Linky Assistant →
        </a>
      </Button>
      <Link
        href="/"
        className="mt-4 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      >
        ← Back to search
      </Link>
    </div>
  );
}
