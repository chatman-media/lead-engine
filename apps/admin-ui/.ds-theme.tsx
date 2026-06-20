// Preview-only theme provider for /design-sync. Lead Engine is dark-first, so
// previews must render in the `.dark` theme to match the real product. Putting
// `dark` on <html> (not just a wrapper div) also themes Radix portaled content
// — dialogs, selects, dropdowns, tooltips — which escape any in-tree wrapper.
//
// This component is rendered ONLY around preview cards (via cfg.provider). It is
// never part of a design built from the bundle, so it cannot force a theme on
// the design agent's output.
import * as React from "react";

export function ThemeRoot(props: { children?: React.ReactNode }) {
  React.useLayoutEffect(() => {
    const html = document.documentElement;
    const hadDark = html.classList.contains("dark");
    html.classList.add("dark");
    const b = document.body;
    const prev = {
      background: b.style.background,
      color: b.style.color,
      minHeight: b.style.minHeight,
    };
    b.style.background = "var(--background)";
    b.style.color = "var(--foreground)";
    b.style.minHeight = "100vh";
    return () => {
      if (!hadDark) html.classList.remove("dark");
      b.style.background = prev.background;
      b.style.color = prev.color;
      b.style.minHeight = prev.minHeight;
    };
  }, []);
  return (props.children ?? null) as React.ReactElement;
}
