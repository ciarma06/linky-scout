"use client";

import { Suspense, useEffect, useState } from "react";
import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";

import { useAuth } from "@/lib/auth-context";
import type { AuthPlan } from "@/lib/auth";

const BRAND = "#6d47f5";

interface MagicLinkPayload {
  email: string;
  plan?: AuthPlan;
  exp: number;
}

function decodeJwtPayload(token: string): MagicLinkPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const decoded =
      typeof atob !== "undefined"
        ? atob(padded)
        : Buffer.from(padded, "base64").toString("utf-8");
    const json = JSON.parse(decoded) as Record<string, unknown>;

    const email = typeof json.email === "string" ? json.email : null;
    const exp = typeof json.exp === "number" ? json.exp : null;

    if (!email || !exp) return null;

    let plan: AuthPlan | undefined;
    if (
      json.plan === "assistant" ||
      json.plan === "scout" ||
      json.plan === "bundle"
    ) {
      plan = json.plan;
    }

    return { email, plan, exp };
  } catch {
    return null;
  }
}

export default function AuthPage() {
  return (
    <Suspense fallback={<AuthSpinner label="Signing you in..." />}>
      <AuthHandler />
    </Suspense>
  );
}

function AuthHandler() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { login } = useAuth();
  const [status, setStatus] = useState<"working" | "error">("working");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    const token = searchParams.get("token")?.trim();

    if (!token) {
      router.replace("/login?error=missing_token");
      return;
    }

    const payload = decodeJwtPayload(token);

    if (!payload) {
      router.replace("/login?error=invalid_token");
      return;
    }

    const expiresAtMs = payload.exp * 1000;
    if (expiresAtMs <= Date.now()) {
      router.replace("/login?error=expired_token");
      return;
    }

    try {
      const daysLeft = Math.max(
        0,
        Math.ceil((expiresAtMs - Date.now()) / (1000 * 60 * 60 * 24)),
      );

      login({
        jwt: token,
        email: payload.email,
        access: "premium",
        plan: payload.plan,
        expiresAt: new Date(expiresAtMs).toISOString(),
        daysLeft,
        checkedAt: new Date().toISOString(),
      });

      router.replace("/");
    } catch (err) {
      console.error("[/auth] failed to persist magic-link session:", err);
      setStatus("error");
      setErrorMessage(
        err instanceof Error ? err.message : "Could not sign you in.",
      );
    }
  }, [searchParams, router, login]);

  if (status === "error") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-50 px-4">
        <div className="flex flex-col items-center gap-4 text-center">
          <p className="font-heading text-lg font-semibold text-foreground">
            Sign-in failed
          </p>
          <p className="max-w-sm text-sm text-muted-foreground">
            {errorMessage ?? "Please try signing in again."}
          </p>
          <button
            type="button"
            onClick={() => router.replace("/login")}
            className="rounded-xl px-4 py-2 text-sm font-medium text-white hover:opacity-90"
            style={{ backgroundColor: BRAND }}
          >
            Back to login
          </button>
        </div>
      </div>
    );
  }

  return <AuthSpinner label="Signing you in..." />;
}

function AuthSpinner({ label }: { label: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 px-4">
      <div className="flex flex-col items-center gap-4">
        <Image
          src="/logo.png"
          alt="Linky Scout"
          width={64}
          height={64}
          priority
          className="h-auto"
        />
        <div
          className="size-8 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-[#6d47f5]"
          aria-hidden
        />
        <p className="text-sm font-medium text-muted-foreground">{label}</p>
      </div>
    </div>
  );
}
