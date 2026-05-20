"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { Sidebar } from "@/components/sidebar";
import { CreditBalance } from "@/components/credit-balance";
import { useAuth } from "@/lib/auth-context";
import { CreditsProvider } from "@/lib/credits-context";

export default function ProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const { user, isLoading } = useAuth();

  useEffect(() => {
    if (isLoading) return;
    if (!user) {
      router.replace("/login");
      return;
    }
    if (user.plan === "assistant") {
      router.replace("/upgrade");
    }
  }, [isLoading, user, router]);

  if (isLoading) {
    return (
      <div className="flex min-h-screen flex-1 items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <div
            className="size-8 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-[#6d47f5]"
            aria-hidden
          />
          <p className="text-sm text-muted-foreground">Loading…</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return null;
  }

  // user.plan === 'assistant' is also a hard block — the effect above redirects
  // to /upgrade, render nothing in the meantime so we don't briefly flash the
  // dashboard.
  if (user.plan === "assistant") {
    return null;
  }

  return (
    <CreditsProvider>
      <div className="flex h-screen overflow-hidden bg-background">
        <Sidebar />
        <main className="flex flex-1 flex-col overflow-y-auto">
          <header className="sticky top-0 z-10 flex items-center justify-end border-b border-border bg-background/80 px-8 py-3 backdrop-blur-sm">
            <CreditBalance />
          </header>
          <div className="mx-auto w-full max-w-6xl px-8 py-10">{children}</div>
        </main>
      </div>
    </CreditsProvider>
  );
}
