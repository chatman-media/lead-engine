function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const PAGE_STYLE = `
  :root { color-scheme: light dark; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    max-width: 480px; margin: 3rem auto; padding: 0 1rem; line-height: 1.5;
  }
  h1 { font-size: 1.4rem; }
  form { display: grid; gap: 0.75rem; }
  label { display: grid; gap: 0.25rem; font-size: 0.95rem; }
  input, textarea, button {
    font: inherit; padding: 0.6rem 0.75rem; border-radius: 8px;
    border: 1px solid color-mix(in srgb, currentColor 30%, transparent);
    background: transparent; color: inherit;
  }
  textarea { min-height: 6rem; }
  button {
    cursor: pointer; font-weight: 600;
    background: color-mix(in srgb, currentColor 12%, transparent);
  }
  .error { color: #b91c1c; font-size: 0.9rem; margin-top: 0.25rem; }
  .success { padding: 1rem; border-radius: 8px;
    background: color-mix(in srgb, #16a34a 18%, transparent); }
`;

export function renderForm(opts: {
  token: string;
  errors?: Record<string, string>;
  values?: { name?: string; email?: string; goal?: string };
}): string {
  const errors = opts.errors ?? {};
  const v = opts.values ?? {};
  function field(
    name: "name" | "email" | "goal",
    label: string,
    type: "text" | "email" | "textarea",
    autocomplete?: string,
  ): string {
    const value = escapeHtml(v[name] ?? "");
    const err = errors[name] ? `<div class="error">${escapeHtml(errors[name]!)}</div>` : "";
    const control =
      type === "textarea"
        ? `<textarea name="${name}" required>${value}</textarea>`
        : `<input name="${name}" type="${type}" value="${value}"${
            autocomplete ? ` autocomplete="${autocomplete}"` : ""
          } required />`;
    return `<label>${escapeHtml(label)}${control}${err}</label>`;
  }
  return `<!doctype html>
<html lang="ru"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Анкета</title>
<style>${PAGE_STYLE}</style>
</head><body>
<h1>Расскажите о себе</h1>
<form id="questionnaire" method="post" action="/q/${escapeHtml(opts.token)}" novalidate>
  ${field("name", "Имя", "text", "name")}
  ${field("email", "Email", "email", "email")}
  ${field("goal", "Что вас интересует?", "textarea")}
  <button type="submit">Отправить</button>
</form>
</body></html>`;
}

export function renderSuccess(): string {
  return `<!doctype html>
<html lang="ru"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Спасибо</title>
<style>${PAGE_STYLE}</style>
</head><body>
<div id="success" class="success">
  <h1>Спасибо!</h1>
  <p>Анкета сохранена. Вернитесь в Telegram — мы скоро напишем.</p>
</div>
</body></html>`;
}

export function renderNotFound(): string {
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>Ссылка недействительна</title>
<style>${PAGE_STYLE}</style></head>
<body><h1>Ссылка недействительна</h1>
<p>Возможно, она устарела или уже использована. Запросите новую в Telegram-боте.</p>
</body></html>`;
}
