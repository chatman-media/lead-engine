import { createContext, useContext, useEffect, useState } from "react";

type Theme = "dark" | "light" | "system";

interface ThemeProviderState {
  theme: Theme;
  resolvedTheme: "dark" | "light";
  setTheme: (theme: Theme) => void;
}

const STORAGE_KEY = "admin-theme";

const ThemeProviderContext = createContext<ThemeProviderState | null>(null);

function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function applyThemeClass(resolved: "dark" | "light") {
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    if (typeof localStorage === "undefined") return "dark";
    return (localStorage.getItem(STORAGE_KEY) as Theme | null) ?? "dark";
  });
  const [resolvedTheme, setResolvedTheme] = useState<"dark" | "light">(() =>
    theme === "system" ? (systemPrefersDark() ? "dark" : "light") : theme,
  );

  useEffect(() => {
    const resolved = theme === "system" ? (systemPrefersDark() ? "dark" : "light") : theme;
    setResolvedTheme(resolved);
    applyThemeClass(resolved);
  }, [theme]);

  // Реагируем на смену системной темы, когда выбран режим "system".
  useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      const resolved = mq.matches ? "dark" : "light";
      setResolvedTheme(resolved);
      applyThemeClass(resolved);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  function setTheme(next: Theme) {
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore (private mode)
    }
    setThemeState(next);
  }

  return (
    <ThemeProviderContext.Provider value={{ theme, resolvedTheme, setTheme }}>
      {children}
    </ThemeProviderContext.Provider>
  );
}

export function useTheme(): ThemeProviderState {
  const ctx = useContext(ThemeProviderContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
