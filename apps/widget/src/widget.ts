/**
 * Floating chat bubble + expandable panel. Vanilla DOM, no framework.
 * Shadow DOM isolates стили от host-страницы.
 */

import { renderStyles } from "./styles.ts";
import { WsClient } from "./ws-client.ts";

export interface WidgetConfig {
  slug: string;
  host: string;
  brand?: string;
  color?: string;
  auth?: string;
}

interface Message {
  role: "user" | "bot" | "system";
  text: string;
  ts: number;
}

const USER_ID_KEY = "lead_engine_widget_user_id";
const MESSAGES_KEY_PREFIX = "lead_engine_widget_msgs_";
const OPEN_STATE_KEY = "lead_engine_widget_open";

function getOrMakeUserId(): string {
  let id = localStorage.getItem(USER_ID_KEY);
  if (!id) {
    // Простой uuid-like (8-4-4-12 hex from crypto)
    const arr = new Uint8Array(16);
    crypto.getRandomValues(arr);
    const hex = Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
    id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 28)}`;
    localStorage.setItem(USER_ID_KEY, id);
  }
  return id;
}

function loadMessages(slug: string): Message[] {
  try {
    const raw = localStorage.getItem(MESSAGES_KEY_PREFIX + slug);
    if (!raw) return [];
    const arr = JSON.parse(raw) as Message[];
    if (!Array.isArray(arr)) return [];
    return arr.slice(-50); // keep last 50 для размера storage
  } catch {
    return [];
  }
}

function saveMessages(slug: string, msgs: Message[]): void {
  try {
    localStorage.setItem(MESSAGES_KEY_PREFIX + slug, JSON.stringify(msgs.slice(-50)));
  } catch {
    // ignore quota
  }
}

export function mountWidget(cfg: WidgetConfig): void {
  const userId = getOrMakeUserId();
  const color = cfg.color ?? "#6aa6ff";
  const brand = cfg.brand ?? "Чат-бот";

  // Shadow DOM root.
  const host = document.createElement("div");
  host.id = "lead-engine-widget-host";
  host.style.cssText = "all:initial;position:fixed;z-index:2147483647;";
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });

  const styleEl = document.createElement("style");
  styleEl.textContent = renderStyles(color);
  shadow.appendChild(styleEl);

  // Bubble + panel.
  const root = document.createElement("div");
  root.className = "le-root";
  root.innerHTML = `
    <button class="le-bubble" title="Открыть чат" aria-label="Открыть чат">
      <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
      </svg>
    </button>
    <div class="le-panel" hidden>
      <header class="le-header">
        <span class="le-brand"></span>
        <button class="le-close" title="Свернуть" aria-label="Свернуть">×</button>
      </header>
      <div class="le-status" hidden></div>
      <div class="le-messages" role="log" aria-live="polite"></div>
      <form class="le-compose" autocomplete="off">
        <input type="text" class="le-input" placeholder="Напишите сообщение…" required maxlength="2000" />
        <button type="submit" class="le-send" title="Отправить" aria-label="Отправить">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="22" y1="2" x2="11" y2="13"></line>
            <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
          </svg>
        </button>
      </form>
    </div>
  `;
  shadow.appendChild(root);

  const bubble = root.querySelector<HTMLButtonElement>(".le-bubble")!;
  const panel = root.querySelector<HTMLDivElement>(".le-panel")!;
  const brandEl = root.querySelector<HTMLSpanElement>(".le-brand")!;
  const closeBtn = root.querySelector<HTMLButtonElement>(".le-close")!;
  const statusEl = root.querySelector<HTMLDivElement>(".le-status")!;
  const messagesEl = root.querySelector<HTMLDivElement>(".le-messages")!;
  const composeEl = root.querySelector<HTMLFormElement>(".le-compose")!;
  const inputEl = root.querySelector<HTMLInputElement>(".le-input")!;

  brandEl.textContent = brand;

  // Restore messages from localStorage.
  const messages: Message[] = loadMessages(cfg.slug);
  for (const m of messages) appendBubble(m);

  function appendBubble(msg: Message) {
    const div = document.createElement("div");
    div.className = `le-msg le-msg-${msg.role}`;
    div.textContent = msg.text;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function pushMessage(role: Message["role"], text: string) {
    const msg = { role, text, ts: Math.floor(Date.now() / 1000) };
    messages.push(msg);
    saveMessages(cfg.slug, messages);
    appendBubble(msg);
  }

  function setStatus(text: string | null) {
    if (!text) {
      statusEl.hidden = true;
      statusEl.textContent = "";
    } else {
      statusEl.hidden = false;
      statusEl.textContent = text;
    }
  }

  // WS client.
  const wsBase = cfg.host.replace(/^http/, "ws");
  const wsUrl = new URL(`${wsBase}/ws/${cfg.slug}`);
  wsUrl.searchParams.set("user", userId);
  if (cfg.auth) wsUrl.searchParams.set("auth", cfg.auth);

  const ws = new WsClient({
    url: wsUrl.toString(),
    onOpen: () => setStatus(null),
    onReady: () => setStatus(null),
    onBotText: (text) => pushMessage("bot", text),
    onError: (code, message) => setStatus(`Ошибка: ${code} — ${message}`),
    onClose: () => setStatus("Соединение разорвано. Переподключаемся…"),
    onConnecting: () => setStatus("Подключение…"),
  });

  // Open/close panel + restore last open state.
  function openPanel() {
    panel.hidden = false;
    bubble.style.display = "none";
    inputEl.focus();
    sessionStorage.setItem(OPEN_STATE_KEY, "1");
    ws.connect();
  }
  function closePanel() {
    panel.hidden = true;
    bubble.style.display = "";
    sessionStorage.removeItem(OPEN_STATE_KEY);
  }
  bubble.addEventListener("click", openPanel);
  closeBtn.addEventListener("click", closePanel);

  // Auto-open if user was viewing widget на reload.
  if (sessionStorage.getItem(OPEN_STATE_KEY) === "1") {
    openPanel();
  }

  // Compose submit.
  composeEl.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = inputEl.value.trim();
    if (!text) return;
    pushMessage("user", text);
    ws.sendText(text);
    inputEl.value = "";
  });
}
