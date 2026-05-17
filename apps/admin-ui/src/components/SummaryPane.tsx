import { useState } from "react";
import type { ConversationSummary } from "../api.ts";

/**
 * Read-only view of the long-conversation summary stored in
 * `conversations.summary_json`. Shown alongside MemoryPane on the chat
 * page so operators can see what the bot "remembers" from older turns
 * (the recent-history window is fixed at 12 raw messages — anything
 * past that is only visible through this summary).
 *
 * Refresh is automatic on the bot side (fire-and-forget after each
 * reply) so this pane is intentionally read-only — operators don't edit
 * the summary; if it's wrong they edit memory facts or take over the
 * conversation.
 */
export function SummaryPane({ summary }: { summary: ConversationSummary | null }) {
  const [collapsed, setCollapsed] = useState(true);

  // Hide the pane entirely when there's no summary yet — short chats
  // shouldn't show an empty box.
  if (!summary) return null;

  return (
    <div
      data-testid="summary-pane"
      style={{
        borderBottom: "1px solid var(--border)",
        background: "var(--bg-1)",
        flexShrink: 0,
      }}
    >
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        data-testid="summary-toggle"
        style={{
          width: "100%",
          padding: "10px 24px",
          background: "transparent",
          border: "none",
          borderTop: "1px solid var(--border)",
          color: "var(--text-3)",
          fontFamily: "var(--mono)",
          fontSize: 11,
          letterSpacing: "0.06em",
          textAlign: "left",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span style={{ width: 10, display: "inline-block" }}>{collapsed ? "▸" : "▾"}</span>
        <span>SUMMARY</span>
        <span style={{ color: "var(--text)", fontWeight: 600 }}>
          to msg #{summary.summarizedThroughMsgId}
        </span>
        <span style={{ marginLeft: "auto", fontSize: 10 }}>
          updated {new Date(summary.updatedAt * 1000).toLocaleString("ru-RU")}
        </span>
      </button>

      {!collapsed && (
        <div
          style={{
            padding: "8px 24px 14px",
            color: "var(--text-2)",
            fontFamily: "var(--sans)",
            fontSize: 13,
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {summary.summary}
        </div>
      )}
    </div>
  );
}
