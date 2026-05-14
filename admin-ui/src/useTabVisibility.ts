import { useCallback, useState } from "react";

export interface TabKey {
  key: string;
  label: string;
  defaultOn: boolean;
}

export const CONFIGURABLE_TABS: TabKey[] = [
  { key: "analytics", label: "Аналитика", defaultOn: true },
  { key: "vacancies", label: "Вакансии", defaultOn: true },
  { key: "kb-suggestions", label: "Предложения в KB", defaultOn: true },
  { key: "styles", label: "Стили продаж", defaultOn: true },
  { key: "skills", label: "Навыки", defaultOn: true },
  { key: "self-play", label: "Self-play", defaultOn: false },
  { key: "coach", label: "Coach", defaultOn: false },
];

const STORAGE_KEY = "adminTabVisibility";

function loadVisibility(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return {};
}

function defaultFor(key: string): boolean {
  return CONFIGURABLE_TABS.find((t) => t.key === key)?.defaultOn ?? true;
}

export function isTabVisible(stored: Record<string, boolean>, key: string): boolean {
  return key in stored ? stored[key] : defaultFor(key);
}

export function useTabVisibility() {
  const [stored, setStored] = useState<Record<string, boolean>>(loadVisibility);

  const setTab = useCallback((key: string, visible: boolean) => {
    setStored((prev) => {
      const next = { ...prev, [key]: visible };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const visible = useCallback((key: string) => isTabVisible(stored, key), [stored]);

  return { stored, visible, setTab };
}
