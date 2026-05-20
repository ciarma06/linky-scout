"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Coins, LogOut, Mail, ShieldCheck, ShoppingCart, Sun } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { BuyCreditsModal } from "@/components/buy-credits-modal";
import { ThemeToggle } from "@/components/theme-toggle";
import { useAuth } from "@/lib/auth-context";
import { useCredits } from "@/lib/credits-context";
import { formatCredits, totalCredits } from "@/lib/credits";
import { cn } from "@/lib/utils";

export default function SettingsPage() {
  const router = useRouter();
  const { user, logout } = useAuth();
  const { credits, isLoading } = useCredits();
  const [buyCreditsOpen, setBuyCreditsOpen] = useState(false);

  function handleLogout() {
    logout();
    router.replace("/login");
  }

  const planLabel = formatPlan(user?.plan, user?.access);
  const planTone = planTones(user?.plan, user?.access);
  const balance = totalCredits(credits);
  const locked = user?.plan === "assistant";

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-heading text-3xl font-semibold tracking-tight text-foreground">
          Settings
        </h1>
        <p className="text-base text-muted-foreground">
          Manage your account, plan and credits.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-5">
        <Card className="rounded-2xl">
          <CardHeader>
            <CardTitle className="text-lg">Account</CardTitle>
            <CardDescription>
              Your sign-in details and active plan.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Row
              icon={<Mail className="size-4" />}
              iconBg="bg-[#3b82f6]/10 text-[#2563eb] dark:bg-[#3b82f6]/20 dark:text-[#93c5fd]"
              label="Email"
              value={
                <span className="text-sm font-medium text-foreground">
                  {user?.email ?? "—"}
                </span>
              }
            />
            <Row
              icon={<ShieldCheck className="size-4" />}
              iconBg="bg-[#6d47f5]/10 text-[#6d47f5] dark:bg-[#6d47f5]/20 dark:text-[#a48cff]"
              label="Plan"
              value={
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "inline-flex h-6 items-center rounded-full px-2.5 text-xs font-medium",
                      planTone,
                    )}
                  >
                    {planLabel}
                  </span>
                  {typeof user?.daysLeft === "number" && (
                    <span className="text-xs text-muted-foreground">
                      {user.daysLeft > 0
                        ? `${user.daysLeft} ${
                            user.daysLeft === 1 ? "day" : "days"
                          } left`
                        : "Expired"}
                    </span>
                  )}
                </div>
              }
            />
          </CardContent>
        </Card>

        <Card id="credits" className="scroll-mt-24 rounded-2xl">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Coins className="size-4 text-[#6d47f5]" />
              Credits
            </CardTitle>
            <CardDescription>
              Each search costs 100 credits. Top up any time.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <div className="flex flex-wrap items-end justify-between gap-4 rounded-2xl bg-muted/40 p-4">
              <div className="flex items-center gap-3">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[#f59e0b]/15 text-[#b45309] dark:bg-[#f59e0b]/20 dark:text-[#fbbf24]">
                  <Coins className="size-4" />
                </div>
                <div className="flex flex-col">
                  <span className="text-xs font-medium text-muted-foreground">
                    Available balance
                  </span>
                  <span
                    className={cn(
                      "font-heading text-3xl font-semibold tabular-nums leading-none text-foreground",
                      isLoading && !credits && "opacity-50",
                    )}
                  >
                    {isLoading && !credits ? "—" : formatCredits(balance)}
                  </span>
                </div>
              </div>
              {credits && (
                <div className="flex flex-col items-start text-xs text-muted-foreground sm:items-end">
                  <span>
                    Subscription:{" "}
                    <span className="font-semibold tabular-nums text-foreground">
                      {formatCredits(credits.subscription_credits)}
                    </span>
                  </span>
                  <span>
                    Packs:{" "}
                    <span className="font-semibold tabular-nums text-foreground">
                      {formatCredits(credits.pack_credits)}
                    </span>
                  </span>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between gap-4">
              <div className="flex flex-col gap-1">
                <p className="font-heading text-sm font-semibold text-foreground">
                  Need more credits?
                </p>
                {locked ? (
                  <p className="text-xs text-muted-foreground">
                    Upgrade to Scout or Bundle to buy credit packs.
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    One-off packs — they never expire and stack on top of your
                    subscription credits.
                  </p>
                )}
              </div>
              <Button
                type="button"
                disabled={locked}
                title={
                  locked
                    ? "Upgrade to Scout or Bundle to buy credit packs"
                    : undefined
                }
                onClick={() => setBuyCreditsOpen(true)}
                className="shrink-0 rounded-xl bg-[#6d47f5] text-white hover:bg-[#6d47f5]/90 disabled:opacity-50"
              >
                <ShoppingCart className="size-4" />
                Get More Credits
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-2xl">
          <CardHeader>
            <CardTitle className="text-lg">Theme</CardTitle>
            <CardDescription>
              Switch between light and dark mode.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Row
              icon={<Sun className="size-4" />}
              iconBg="bg-[#f59e0b]/15 text-[#b45309] dark:bg-[#f59e0b]/20 dark:text-[#fbbf24]"
              label="Appearance"
              value={<ThemeToggle variant="labelled" />}
            />
          </CardContent>
        </Card>

        <Card className="rounded-2xl">
          <CardHeader>
            <CardTitle className="text-lg">Actions</CardTitle>
            <CardDescription>Sign out of Linky Scout.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              type="button"
              variant="destructive"
              onClick={handleLogout}
              className="rounded-xl"
            >
              <LogOut className="size-4" />
              Logout
            </Button>
          </CardContent>
        </Card>
      </div>

      <BuyCreditsModal
        open={buyCreditsOpen}
        onOpenChange={setBuyCreditsOpen}
      />
    </div>
  );
}

interface RowProps {
  icon: React.ReactNode;
  iconBg: string;
  label: string;
  value: React.ReactNode;
}

function Row({ icon, iconBg, label, value }: RowProps) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex items-center gap-3">
        <div
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-xl",
            iconBg,
          )}
        >
          {icon}
        </div>
        <span className="text-sm font-medium text-muted-foreground">
          {label}
        </span>
      </div>
      <div className="text-right">{value}</div>
    </div>
  );
}

function formatPlan(
  plan: string | null | undefined,
  access: string | null | undefined,
): string {
  if (plan === "scout") return "Scout";
  if (plan === "bundle") return "Bundle";
  if (plan === "assistant") return "Assistant";
  if (!access) return "—";
  const v = access.toLowerCase();
  if (v.includes("expired")) return "Expired";
  if (v === "premium") return "Premium";
  if (v === "waitlist_trial" || v === "trial" || v === "active") return "Trial";
  return access.charAt(0).toUpperCase() + access.slice(1);
}

function planTones(
  plan: string | null | undefined,
  access: string | null | undefined,
): string {
  if (plan === "scout" || plan === "bundle") {
    return "bg-[#6d47f5]/10 text-[#6d47f5] dark:bg-[#6d47f5]/20 dark:text-[#a48cff]";
  }
  if (plan === "assistant") {
    return "bg-[#f59e0b]/10 text-[#b45309] dark:bg-[#f59e0b]/20 dark:text-[#fbbf24]";
  }
  if (!access) return "bg-muted text-muted-foreground";
  const v = access.toLowerCase();
  if (v.includes("expired")) {
    return "bg-[#ef4444]/10 text-[#ef4444] dark:bg-[#ef4444]/20 dark:text-[#fca5a5]";
  }
  return "bg-[#10b981]/15 text-[#047857] dark:bg-[#10b981]/20 dark:text-[#34d399]";
}
