"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { CreditsBadge } from "@/components/credits-badge";
import { Sidebar } from "@/components/sidebar";
import { useAuth } from "@/lib/auth-context";

export default function ProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const { user, isLoading } = useAuth();

  useEffect(() => {
    if (!isLoading && !user) {
      router.replace("/login");
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

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar />
      <main className="flex-1 overflow-y-auto">
        <div className="sticky top-0 z-20 border-b border-border bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/70">
          <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-end px-8">
            <CreditsBadge />
          </div>
        </div>
        <div className="mx-auto w-full max-w-6xl px-8 py-10">{children}</div>
      </main>
    </div>
  );
}
