import { useTheme } from "../useTheme.ts";

function SunIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

/**
 * Переключатель светлой / тёмной темы — иконка-кнопка.
 *   variant="bar"      — встроенная иконка (шапка сайдбара админки)
 *   variant="floating" — плавающая круглая иконка в углу (страница входа)
 */
export function ThemeToggle({ variant = "bar" }: { variant?: "bar" | "floating" }) {
  const { theme, toggle } = useTheme();
  const dark = theme === "dark";
  const label = dark ? "Светлая тема" : "Тёмная тема";

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={label}
      title={label}
      className={variant === "floating" ? "theme-toggle-icon" : "icon-btn"}
    >
      {dark ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}
