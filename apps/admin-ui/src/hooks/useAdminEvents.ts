import { useEffect, useRef } from "react";
import { getToken } from "@/api/saas";

export type AdminEvent =
  | {
      type: "new_message";
      conversationId: number;
      contactId: number;
      preview: string | null;
      role?: "user" | "assistant" | "human";
    }
  | { type: "stage_changed"; leadId: number; toStage: string; toStageDisplayName: string }
  | { type: "conversation_mode"; conversationId: number; mode: string };

/**
 * Subscribes to the admin SSE event stream (/api/admin/events).
 * Uses fetch + ReadableStream so we can pass Authorization header
 * (native EventSource doesn't support custom headers).
 * Reconnects automatically with exponential backoff on disconnect.
 */
export function useAdminEvents(onEvent: (event: AdminEvent) => void) {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    let stopped = false;
    let delay = 1_000;
    let abortController: AbortController | null = null;

    async function connect() {
      const token = getToken();
      if (!token) return;

      abortController = new AbortController();
      try {
        const res = await fetch("/api/admin/events", {
          headers: { Authorization: `Bearer ${token}` },
          signal: abortController.signal,
        });

        if (!res.ok || !res.body) return;
        delay = 1_000;

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done || stopped) break;

          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const raw = line.slice(5).trim();
            if (!raw) continue;
            try {
              const event = JSON.parse(raw) as AdminEvent;
              onEventRef.current(event);
            } catch {}
          }
        }
      } catch {
        // AbortError on cleanup or network error — reconnect below.
      }

      if (!stopped) {
        setTimeout(connect, delay);
        delay = Math.min(delay * 2, 30_000);
      }
    }

    connect();

    return () => {
      stopped = true;
      abortController?.abort();
    };
  }, []);
}
