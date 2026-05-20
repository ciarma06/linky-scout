"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Clock, Search, Settings, Users } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth-context";
import { ThemeToggle } from "@/components/theme-toggle";

interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  /** Pastel background classes for the icon wrapper in inactive state. */
  iconBg: string;
  /** Foreground color of the icon in inactive state. */
  iconFg: string;
}

const NAV_ITEMS: NavItem[] = [
  {
    label: "New Search",
    href: "/",
    icon: Search,
    iconBg: "bg-[#6d47f5]/10 dark:bg-[#6d47f5]/20",
    iconFg: "text-[#6d47f5] dark:text-[#a48cff]",
  },
  {
    label: "Search History",
    href: "/history",
    icon: Clock,
    iconBg: "bg-[#3b82f6]/10 dark:bg-[#3b82f6]/20",
    iconFg: "text-[#2563eb] dark:text-[#93c5fd]",
  },
  {
    label: "Saved Leads",
    href: "/leads",
    icon: Users,
    iconBg: "bg-[#10b981]/15 dark:bg-[#10b981]/20",
    iconFg: "text-[#047857] dark:text-[#34d399]",
  },
  {
    label: "Settings",
    href: "/settings",
    icon: Settings,
    iconBg: "bg-zinc-200/70 dark:bg-zinc-700/40",
    iconFg: "text-zinc-600 dark:text-zinc-300",
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const { user } = useAuth();

  const initial = user?.email?.[0]?.toUpperCase() ?? "?";
  const email = user?.email ?? "";

  return (
    <aside className="flex h-screen w-[260px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar">
      <div className="flex items-center gap-3 px-5 pt-6 pb-4">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl overflow-hidden shadow-sm">
          <Image
            src="/logo.png"
            alt="Linky Scout"
            width={40}
            height={40}
            className="h-auto object-contain"
          />
        </div>
        <div className="min-w-0">
          <p className="font-heading text-base font-bold leading-tight text-foreground">
            Linky Scout
          </p>
          <p className="truncate text-xs text-muted-foreground">
            Find your perfect leads
          </p>
        </div>
      </div>

      <div className="px-3">
        <div className="h-px w-full bg-sidebar-border" />
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-2">
        <ul className="flex flex-col gap-1">
          {NAV_ITEMS.map((item) => {
            const active =
              item.href === "/"
                ? pathname === "/"
                : pathname === item.href || pathname.startsWith(`${item.href}/`);
            const Icon = item.icon;
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "group flex items-center gap-3 rounded-xl px-2.5 py-2 text-sm font-medium transition-colors",
                    active
                      ? "bg-[#6d47f5] text-white"
                      : "text-foreground hover:bg-muted"
                  )}
                >
                  <span
                    className={cn(
                      "flex size-8 shrink-0 items-center justify-center rounded-xl transition-colors",
                      active
                        ? "bg-white/20 text-white"
                        : cn(item.iconBg, item.iconFg)
                    )}
                  >
                    <Icon className="size-4" />
                  </span>
                  <span className="truncate">{item.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="mt-auto border-t border-sidebar-border p-3">
        <div className="flex items-center gap-3 rounded-xl bg-muted/40 p-2.5">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-[#6d47f5] text-sm font-semibold text-white">
            {initial}
          </div>
          <div className="min-w-0 flex-1">
            <p
              className="truncate text-sm font-medium text-foreground"
              title={email}
            >
              {email || "Signed in"}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {user?.access ?? ""}
            </p>
          </div>
          <ThemeToggle />
        </div>
      </div>
    </aside>
  );
}
