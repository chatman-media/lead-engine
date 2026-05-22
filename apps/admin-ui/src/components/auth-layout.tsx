import { RocketIcon } from "lucide-react";
import type * as React from "react";

import { ModeToggle } from "@/components/mode-toggle";

export function AuthLayout({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div className="relative grid min-h-screen place-items-center overflow-hidden px-4 py-10">
      {/* атмосферный glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-1/3 left-1/2 size-[60rem] -translate-x-1/2 rounded-full opacity-50 blur-3xl"
        style={{
          background:
            "radial-gradient(closest-side, color-mix(in oklch, var(--primary) 35%, transparent), transparent)",
        }}
      />
      <div className="absolute right-4 top-4">
        <ModeToggle />
      </div>

      <div className="relative w-full max-w-sm">
        <div className="mb-7 flex flex-col items-center gap-3 text-center">
          <span className="grid size-11 place-items-center rounded-xl bg-gradient-to-br from-primary to-chart-5 text-primary-foreground shadow-[0_8px_30px_-8px_var(--primary)]">
            <RocketIcon className="size-5" />
          </span>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
            {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
          </div>
        </div>

        <div className="bg-card/80 rounded-xl border p-6 shadow-xl backdrop-blur-sm">
          {children}
        </div>

        {footer && <div className="mt-5 text-center text-sm text-muted-foreground">{footer}</div>}
      </div>
    </div>
  );
}
