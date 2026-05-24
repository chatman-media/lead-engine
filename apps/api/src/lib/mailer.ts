/**
 * Thin Resend HTTP client + HTML email templates.
 *
 * Resend не требует DNS-верификации домена на dev (можно слать на реальные адреса
 * с resend.dev суб-доменом). В продакшне нужен verified domain.
 *
 * Env vars:
 *   RESEND_API_KEY     — sk_live_... или sk_test_... (обязательно для email)
 *   PLATFORM_FROM_EMAIL — "lead-engine <noreply@leadengine.app>" (опционально)
 *
 * Если RESEND_API_KEY не задан, Mailer всё равно создаётся но логирует вместо отправки.
 */

export interface MailerOpts {
  /** Resend API key. Если не задан — dry-run (console.log). */
  apiKey?: string;
  /** "Name <email>" или просто "email". Default: "lead-engine <noreply@leadengine.app>" */
  fromAddress?: string;
}

export interface SendOpts {
  to: string;
  subject: string;
  html: string;
}

export class Mailer {
  private apiKey: string | undefined;
  private from: string;

  constructor(opts: MailerOpts = {}) {
    this.apiKey = opts.apiKey;
    this.from = opts.fromAddress ?? "lead-engine <noreply@leadengine.app>";
  }

  async send(opts: SendOpts): Promise<void> {
    if (!this.apiKey) {
      console.log(
        `[mailer] dry-run (no RESEND_API_KEY) → to=${opts.to} subject="${opts.subject}"`,
      );
      return;
    }
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: this.from,
        to: [opts.to],
        subject: opts.subject,
        html: opts.html,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Resend error ${res.status}: ${body}`);
    }
  }
}

// ---------------------------------------------------------------------------
// HTML Templates
// ---------------------------------------------------------------------------

function baseLayout(content: string): string {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>lead-engine</title>
  <style>
    body { margin: 0; padding: 0; background: #f4f4f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
    .wrap { max-width: 560px; margin: 40px auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
    .header { background: #4f46e5; padding: 28px 32px; }
    .header-logo { color: #ffffff; font-size: 20px; font-weight: 700; letter-spacing: -0.3px; text-decoration: none; }
    .body { padding: 32px; color: #18181b; }
    h1 { margin: 0 0 16px; font-size: 22px; font-weight: 700; color: #18181b; }
    p { margin: 0 0 16px; font-size: 15px; line-height: 1.6; color: #52525b; }
    .btn { display: inline-block; margin: 8px 0 24px; padding: 12px 24px; background: #4f46e5; color: #ffffff !important; border-radius: 8px; font-weight: 600; font-size: 15px; text-decoration: none; }
    .footer { padding: 20px 32px; background: #fafafa; border-top: 1px solid #e4e4e7; font-size: 12px; color: #a1a1aa; text-align: center; }
    .footer a { color: #a1a1aa; }
    .highlight { background: #fef9c3; border-left: 3px solid #eab308; padding: 12px 16px; border-radius: 4px; margin-bottom: 20px; font-size: 14px; color: #713f12; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="header">
      <span class="header-logo">lead-engine</span>
    </div>
    <div class="body">
      ${content}
    </div>
    <div class="footer">
      lead-engine · AI-ассистент для рекрутинга<br/>
      <a href="https://app.leadengine.app">app.leadengine.app</a>
    </div>
  </div>
</body>
</html>`;
}

/** Приветственное письмо после регистрации. */
export function welcomeEmailHtml(opts: { email: string; slug: string; appUrl: string }): string {
  return baseLayout(`
    <h1>Добро пожаловать в lead-engine 🎉</h1>
    <p>Аккаунт <strong>${opts.email}</strong> создан. Ваше рабочее пространство:</p>
    <a href="${opts.appUrl}" class="btn">Открыть дашборд →</a>
    <p>С чего начать:</p>
    <ol style="margin:0 0 20px;padding-left:20px;font-size:15px;line-height:1.8;color:#52525b;">
      <li>Подключите Telegram-бот (Settings → Channels)</li>
      <li>Введите ключ OpenAI (Settings → LLM)</li>
      <li>Загрузите базу знаний (Settings → Knowledge Base)</li>
    </ol>
    <p>Онбординг занимает 15 минут — бот начнёт отвечать кандидатам сразу после настройки.</p>
    <p style="margin-bottom:0">Если нужна помощь — просто ответьте на это письмо.</p>
  `);
}

/** Письмо за 3 дня до конца триала. */
export function trialEndingEmailHtml(opts: {
  email: string;
  slug: string;
  daysLeft: number;
  appUrl: string;
  billingUrl: string;
}): string {
  return baseLayout(`
    <h1>Триал заканчивается через ${opts.daysLeft} ${opts.daysLeft === 1 ? "день" : "дня"}</h1>
    <div class="highlight">
      ⏰ После окончания триала бот перейдёт на Free-план (1 канал, 100 ответов/мес).
    </div>
    <p>Чтобы сохранить полный доступ — подключите карту. Первое списание только после окончания триала.</p>
    <a href="${opts.billingUrl}" class="btn">Подключить оплату →</a>
    <p>Если у вас есть вопросы или нужна помощь с настройкой — ответьте на это письмо.</p>
    <p style="margin-bottom:0">Спасибо что тестируете lead-engine!</p>
  `);
}

/** Письмо при неудачной оплате. */
export function paymentFailedEmailHtml(opts: {
  email: string;
  slug: string;
  appUrl: string;
  billingUrl: string;
}): string {
  return baseLayout(`
    <h1>Не удалось списать оплату</h1>
    <div class="highlight">
      ❌ Платёж за подписку lead-engine не прошёл. Обычно это проблема с картой или недостаточно средств.
    </div>
    <p>Пожалуйста, обновите способ оплаты — Stripe сделает ещё несколько попыток в ближайшие дни, после чего аккаунт перейдёт на Free-план.</p>
    <a href="${opts.billingUrl}" class="btn">Обновить карту →</a>
    <p style="margin-bottom:0">Если это ошибка — ответьте на это письмо, разберёмся вместе.</p>
  `);
}
