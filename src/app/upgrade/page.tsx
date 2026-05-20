"use client";

import { useEffect } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { ArrowRight, CheckCircle2, LogOut, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/utils";

const BRAND = "#6d47f5";
const PRICING_URL = "https://linkyassistant.com/#pricing";

interface UpgradePlan {
  id: "scout" | "bundle";
  name: string;
  tagline: string;
  features: string[];
  highlighted?: boolean;
}

const UPGRADE_PLANS: UpgradePlan[] = [
  {
    id: "scout",
    name: "Scout",
    tagline: "Hunt high-fit LinkedIn leads at scale.",
    features: [
      "Run AI-powered ICP searches",
      "Enriched profiles with bio + recent posts",
      "Match-scored shortlists ranked by relevance",
      "Save top leads to your CRM",
    ],
  },
  {
    id: "bundle",
    name: "Bundle",
    tagline: "Scout + Assistant. Find and engage with one workflow.",
    features: [
      "Everything in Scout",
      "Linky Assistant — AI comments on LinkedIn",
      "Single subscription, lower combined price",
      "Priority support",
    ],
    highlighted: true,
  },
];

export default function UpgradePage() {
  const router = useRouter();
  const { user, isLoading, logout } = useAuth();

  useEffect(() => {
    if (isLoading) return;
    if (!user) {
      router.replace("/login");
      return;
    }
    // If the user is already on Scout / Bundle, send them home.
    if (user.plan === "scout" || user.plan === "bundle") {
      router.replace("/");
    }
  }, [isLoading, user, router]);

  function handleLogout() {
    logout();
    router.replace("/login");
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-50 px-4 py-12">
      <div className="w-full max-w-4xl">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <Image
            src="/logo.png"
            alt="Linky Scout"
            width={64}
            height={64}
            priority
            className="h-auto"
          />
          <h1
            className="font-heading text-3xl font-semibold tracking-tight"
            style={{ color: BRAND }}
          >
            Scout requires the Scout or Bundle plan
          </h1>
          <p className="max-w-xl text-sm text-muted-foreground">
            Your current plan unlocks Linky Assistant only. Upgrade to start
            running AI-powered LinkedIn lead searches with Linky Scout.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          {UPGRADE_PLANS.map((plan) => (
            <Card
              key={plan.id}
              className={cn(
                "rounded-2xl",
                plan.highlighted && "border-[#6d47f5] ring-1 ring-[#6d47f5]/30",
              )}
            >
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg">
                  {plan.name}
                  {plan.highlighted && (
                    <span className="inline-flex h-5 items-center rounded-full bg-[#6d47f5] px-2 text-[10px] font-semibold uppercase tracking-wide text-white">
                      Best value
                    </span>
                  )}
                </CardTitle>
                <CardDescription>{plan.tagline}</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <ul className="flex flex-col gap-2">
                  {plan.features.map((f) => (
                    <li
                      key={f}
                      className="flex items-start gap-2 text-sm text-foreground"
                    >
                      <CheckCircle2
                        className="mt-0.5 size-4 shrink-0 text-[#6d47f5]"
                        aria-hidden
                      />
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
                <Button
                  asChild
                  size="lg"
                  className={cn(
                    "mt-2 h-11 rounded-xl",
                    plan.highlighted
                      ? "bg-[#6d47f5] text-white hover:bg-[#6d47f5]/90"
                      : "bg-foreground text-background hover:bg-foreground/90",
                  )}
                >
                  <a href={PRICING_URL} target="_blank" rel="noopener noreferrer">
                    <Sparkles className="size-4" />
                    See {plan.name} pricing
                    <ArrowRight className="size-4" />
                  </a>
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="mt-6 flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <span>Signed in as {user?.email}</span>
          <span>•</span>
          <button
            type="button"
            onClick={handleLogout}
            className="inline-flex items-center gap-1 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            <LogOut className="size-3" />
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
