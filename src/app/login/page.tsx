"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/lib/auth-context";
import { requestOtp, verifyOtp } from "@/lib/auth";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BRAND = "#6d47f5";

// Purchase / subscription page URL. Move to an env var if you want to parameterise it.
const PURCHASE_URL = "https://linkyassistant.com";

type Step = "email" | "otp" | "expired";

export default function LoginPage() {
  const router = useRouter();
  const { user, isLoading, login } = useAuth();

  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [expiredKind, setExpiredKind] = useState<
    "waitlist" | "premium" | null
  >(null);

  // Already logged in → go to dashboard.
  useEffect(() => {
    if (!isLoading && user) {
      router.replace("/");
    }
  }, [isLoading, user, router]);

  async function handleRequestOtp(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const trimmed = email.trim().toLowerCase();
    if (!EMAIL_REGEX.test(trimmed)) {
      setError("Please enter a valid email address.");
      return;
    }

    setSubmitting(true);
    const res = await requestOtp(trimmed);
    setSubmitting(false);

    if (res.ok) {
      setEmail(trimmed);
      setCode("");
      setStep("otp");
    } else {
      setError(res.message ?? "Could not send the code. Please try again.");
    }
  }

  async function handleVerifyOtp(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!/^[0-9]{6}$/.test(code)) {
      setError("The code must be exactly 6 digits.");
      return;
    }

    setSubmitting(true);
    const res = await verifyOtp(email, code);
    setSubmitting(false);

    if ("jwt" in res) {
      login(res);
      router.replace("/");
      return;
    }

    if (res.access === "expired_waitlist" || res.access === "expired_premium") {
      setExpiredKind(
        res.access === "expired_premium" ? "premium" : "waitlist"
      );
      setStep("expired");
      return;
    }

    if (res.access === "unauthorized") {
      setError("Email address not recognised.");
      return;
    }

    setError(res.error || "Invalid code. Please try again.");
  }

  function goBackToEmail() {
    setStep("email");
    setCode("");
    setError(null);
    setExpiredKind(null);
  }

  return (
    <div className="flex min-h-full flex-1 items-center justify-center bg-zinc-50 px-4 py-12">
      <div className="w-full max-w-[400px]">
        <div className="mb-6 flex flex-col items-center gap-2">
          <Image
            src="/logo.png"
            alt="Linky Scout"
            width={80}
            height={80}
            priority
          />
          <h1
            className="font-heading text-3xl font-semibold tracking-tight"
            style={{ color: BRAND }}
          >
            Linky Scout
          </h1>
        </div>

        <Card className="gap-5 py-6">
          {step === "email" && (
            <>
              <CardHeader>
                <CardTitle className="text-xl">Sign in with your email</CardTitle>
                <CardDescription>
                  We&apos;ll send you a 6-digit code to log in.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleRequestOtp} className="flex flex-col gap-3">
                  <label
                    htmlFor="email"
                    className="text-sm font-medium text-foreground"
                  >
                    Email
                  </label>
                  <Input
                    id="email"
                    type="email"
                    autoComplete="email"
                    inputMode="email"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    aria-invalid={!!error || undefined}
                    disabled={submitting}
                    className="h-10"
                  />
                  {error && (
                    <p className="text-sm text-red-600" role="alert">
                      {error}
                    </p>
                  )}
                  <Button
                    type="submit"
                    size="lg"
                    disabled={submitting}
                    className="mt-2 h-10 text-white hover:opacity-90"
                    style={{ backgroundColor: BRAND }}
                  >
                    {submitting ? "Sending…" : "Send code"}
                  </Button>
                </form>
              </CardContent>
            </>
          )}

          {step === "otp" && (
            <>
              <CardHeader>
                <CardTitle className="text-xl">Check your email</CardTitle>
                <CardDescription>
                  We sent a 6-digit code to{" "}
                  <span className="font-medium text-foreground">{email}</span>.
                  It expires in 10 minutes.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleVerifyOtp} className="flex flex-col gap-3">
                  <label
                    htmlFor="otp"
                    className="text-sm font-medium text-foreground"
                  >
                    Verification code
                  </label>
                  <Input
                    id="otp"
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    placeholder="123456"
                    value={code}
                    onChange={(e) =>
                      setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
                    }
                    aria-invalid={!!error || undefined}
                    disabled={submitting}
                    className="h-10 text-center text-lg tracking-[0.4em]"
                  />
                  {error && (
                    <p className="text-sm text-red-600" role="alert">
                      {error}
                    </p>
                  )}
                  <Button
                    type="submit"
                    size="lg"
                    disabled={submitting || code.length !== 6}
                    className="mt-2 h-10 text-white hover:opacity-90"
                    style={{ backgroundColor: BRAND }}
                  >
                    {submitting ? "Verifying…" : "Verify"}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="lg"
                    onClick={goBackToEmail}
                    disabled={submitting}
                    className="h-10"
                  >
                    Back
                  </Button>
                </form>
              </CardContent>
            </>
          )}

          {step === "expired" && (
            <>
              <CardHeader>
                <CardTitle className="text-xl">
                  Your trial has ended
                </CardTitle>
                <CardDescription>
                  {expiredKind === "premium"
                    ? "Your premium subscription has expired. Renew to keep using Linky Scout."
                    : "Your trial period is over. Purchase a plan to keep using Linky Scout."}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <Button
                  asChild
                  size="lg"
                  className="h-10 text-white hover:opacity-90"
                  style={{ backgroundColor: BRAND }}
                >
                  <a
                    href={PURCHASE_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Get a plan
                  </a>
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="lg"
                  onClick={goBackToEmail}
                  className="h-10"
                >
                  Use a different email
                </Button>
              </CardContent>
            </>
          )}
        </Card>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          By signing in you agree to our Terms of Service and Privacy Policy.
        </p>
      </div>
    </div>
  );
}
