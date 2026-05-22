/**
 * Inline-CSS для widget shadow DOM. Цвет аккента — параметризован
 * через CSS-var --le-accent (передаётся tenant'ом через data-color).
 *
 * Дизайн: bottom-right floating bubble + expandable panel 360x540.
 * Mobile (<480px): panel full-width на bottom 70%.
 */

export function renderStyles(accent: string): string {
  return `
    :host { all: initial; }
    .le-root {
      position: fixed;
      bottom: 20px;
      right: 20px;
      font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      --le-accent: ${accent};
      --le-text: #1f2328;
      --le-muted: #6e7681;
      --le-bg: #ffffff;
      --le-panel-bg: #f6f8fa;
      --le-border: #d0d7de;
      --le-bubble-user: var(--le-accent);
      --le-bubble-bot: #eaeef2;
    }

    .le-bubble {
      width: 56px;
      height: 56px;
      border-radius: 50%;
      background: var(--le-accent);
      color: #fff;
      border: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.18);
      transition: transform 120ms ease;
    }
    .le-bubble:hover { transform: scale(1.06); }

    .le-panel {
      width: 360px;
      height: 540px;
      max-height: calc(100vh - 40px);
      background: var(--le-bg);
      border: 1px solid var(--le-border);
      border-radius: 12px;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.16);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .le-header {
      background: var(--le-accent);
      color: #fff;
      padding: 12px 16px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .le-brand {
      font-weight: 600;
      font-size: 14px;
    }
    .le-close {
      background: transparent;
      color: #fff;
      border: 0;
      font-size: 22px;
      line-height: 1;
      cursor: pointer;
      padding: 0 4px;
    }
    .le-close:hover { opacity: 0.8; }

    .le-status {
      padding: 6px 12px;
      background: #fff8c5;
      color: #57451a;
      font-size: 12px;
      border-bottom: 1px solid var(--le-border);
    }

    .le-messages {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      background: var(--le-panel-bg);
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .le-msg {
      max-width: 80%;
      padding: 8px 12px;
      border-radius: 12px;
      font-size: 14px;
      line-height: 1.4;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .le-msg-user {
      align-self: flex-end;
      background: var(--le-bubble-user);
      color: #fff;
      border-bottom-right-radius: 4px;
    }
    .le-msg-bot {
      align-self: flex-start;
      background: var(--le-bubble-bot);
      color: var(--le-text);
      border-bottom-left-radius: 4px;
    }
    .le-msg-system {
      align-self: center;
      background: transparent;
      color: var(--le-muted);
      font-size: 12px;
      font-style: italic;
    }

    .le-compose {
      display: flex;
      gap: 8px;
      padding: 10px;
      border-top: 1px solid var(--le-border);
      background: var(--le-bg);
    }
    .le-input {
      flex: 1;
      padding: 8px 12px;
      border: 1px solid var(--le-border);
      border-radius: 18px;
      font-size: 14px;
      color: var(--le-text);
      background: var(--le-bg);
      outline: none;
    }
    .le-input:focus { border-color: var(--le-accent); }

    .le-send {
      background: var(--le-accent);
      color: #fff;
      border: 0;
      border-radius: 18px;
      padding: 0 14px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .le-send:hover { opacity: 0.92; }

    @media (prefers-color-scheme: dark) {
      .le-root {
        --le-text: #e8eaed;
        --le-muted: #9aa0a6;
        --le-bg: #1e1f22;
        --le-panel-bg: #262830;
        --le-border: #3a3d45;
        --le-bubble-bot: #313338;
      }
      .le-status { background: #463f1c; color: #f0d784; }
    }

    @media (max-width: 480px) {
      .le-root { bottom: 0; right: 0; left: 0; }
      .le-panel {
        width: 100vw;
        height: 70vh;
        max-height: 70vh;
        border-radius: 12px 12px 0 0;
        border: 0;
        border-top: 1px solid var(--le-border);
      }
      .le-bubble { margin: 0 16px 16px auto; }
    }
  `;
}
