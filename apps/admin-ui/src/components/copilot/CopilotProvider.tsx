import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { ApiError, type CopilotAction, type CopilotChatMessage, saas } from "@/api/saas";

/**
 * Контекст копайлота. Состояние живёт ВЫШЕ `<Routes>` (см. App.tsx), поэтому
 * чат и открытость дока переживают навигацию, в т.ч. переход онбординг↔кабинет
 * (это сиблинг-роуты). Сам `<CopilotDock/>` рендерится флекс-соседом внутри
 * каждого layout'а и читает это состояние.
 *
 * Принцип «советы + действия с подтверждением»: `send()` только спрашивает
 * ассистента (бэкенд ничего не пишет). Если приходит `action` — кладём в
 * `pendingAction`; запись делает `confirmAction()` через существующие методы
 * (`installVertical`/`applyWorkflow`). После успеха бампаем `appliedTick`, и
 * страницы перечитывают свои данные.
 */

export interface PageCopilotContext {
  /** Стабильный id страницы (onboarding/leads/funnel/...). */
  pageId: string;
  /** Человекочитаемая подпись для шапки дока. */
  label: string;
  /** Компактный снапшот данных страницы — инъектируется в промпт. */
  data?: unknown;
  /** Настроен ли chat-LLM. false → док показывает BYOK-подсказку. */
  llmReady?: boolean;
}

interface CopilotContextValue {
  open: boolean;
  setOpen: (v: boolean) => void;
  toggle: () => void;
  messages: CopilotChatMessage[];
  busy: boolean;
  error: string;
  pendingAction: CopilotAction | null;
  applying: boolean;
  llmReady: boolean;
  pageId: string;
  pageLabel: string;
  /** Инкрементится после успешного действия — страницы перечитывают данные. */
  appliedTick: number;
  /** Запрошенный ассистентом шаг (для онбординга); уникальный `at` = свежесть. */
  navStep: { step: number; at: number } | null;
  send: (text: string) => Promise<void>;
  confirmAction: () => Promise<void>;
  dismissAction: () => void;
  clear: () => void;
  gotoLlmSetup: () => void;
  publishContext: (ctx: PageCopilotContext | null) => void;
}

const CopilotCtx = createContext<CopilotContextValue | null>(null);

export function useCopilot(): CopilotContextValue {
  const v = useContext(CopilotCtx);
  if (!v) throw new Error("useCopilot must be used within CopilotProvider");
  return v;
}

const OPEN_KEY = "copilot-dock-open";

export function CopilotProvider({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const [open, setOpenState] = useState(() => localStorage.getItem(OPEN_KEY) === "true");
  const [messages, setMessages] = useState<CopilotChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pendingAction, setPendingAction] = useState<CopilotAction | null>(null);
  const [applying, setApplying] = useState(false);
  const [appliedTick, setAppliedTick] = useState(0);
  const [navStep, setNavStep] = useState<{ step: number; at: number } | null>(null);
  const [llmError, setLlmError] = useState(false);
  const [pageMeta, setPageMeta] = useState<{ pageId: string; label: string; llmReady: boolean }>({
    pageId: "unknown",
    label: "Ассистент",
    llmReady: true,
  });

  // Полный контекст (с data) держим в ref: send() читает свежий снапшот без
  // лишних ререндеров и stale-замыканий. Прочие refs синхронизируют значения
  // для стабильных (useCallback []) async-колбэков.
  const pageRef = useRef<PageCopilotContext | null>(null);
  const busyRef = useRef(busy);
  const messagesRef = useRef(messages);
  const pendingRef = useRef(pendingAction);
  const applyingRef = useRef(applying);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  useEffect(() => {
    pendingRef.current = pendingAction;
  }, [pendingAction]);
  useEffect(() => {
    applyingRef.current = applying;
  }, [applying]);

  const setOpen = useCallback((v: boolean) => {
    setOpenState(v);
    localStorage.setItem(OPEN_KEY, String(v));
  }, []);
  const toggle = useCallback(() => {
    setOpenState((v) => {
      const nv = !v;
      localStorage.setItem(OPEN_KEY, String(nv));
      return nv;
    });
  }, []);

  // ⌘/Ctrl+J — переключить док. Один листенер на провайдер (док монтируется в
  // одном экземпляре за раз).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && (e.key === "j" || e.key === "J")) {
        e.preventDefault();
        toggle();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  const publishContext = useCallback((ctx: PageCopilotContext | null) => {
    const prevId = pageRef.current?.pageId;
    pageRef.current = ctx;
    const nextId = ctx?.pageId ?? "unknown";
    if (nextId !== prevId) setLlmError(false); // смена страницы сбрасывает 503-флаг
    const next = ctx
      ? { pageId: ctx.pageId, label: ctx.label, llmReady: ctx.llmReady ?? true }
      : { pageId: "unknown", label: "Ассистент", llmReady: true };
    setPageMeta((prev) =>
      prev.pageId === next.pageId && prev.label === next.label && prev.llmReady === next.llmReady
        ? prev
        : next,
    );
  }, []);

  const send = useCallback(async (text: string) => {
    const t = text.trim();
    if (!t || busyRef.current) return;
    const next: CopilotChatMessage[] = [...messagesRef.current, { role: "user", content: t }];
    setMessages(next);
    setError("");
    setPendingAction(null);
    setBusy(true);
    try {
      const res = await saas.copilotChat({
        page: pageRef.current?.pageId ?? "unknown",
        context: pageRef.current?.data,
        messages: next,
      });
      setMessages([...next, { role: "assistant", content: res.reply }]);
      if (res.action) setPendingAction(res.action);
    } catch (err) {
      if (err instanceof ApiError && err.status === 503) {
        setLlmError(true); // chat-LLM не настроен → покажем BYOK-подсказку
      } else {
        setError(err instanceof Error ? err.message : "Ошибка запроса к ассистенту");
      }
    } finally {
      setBusy(false);
    }
  }, []);

  const confirmAction = useCallback(async () => {
    const action = pendingRef.current;
    if (!action || applyingRef.current) return;
    setApplying(true);
    setError("");
    try {
      if (action.type === "install_vertical") {
        await saas.installVertical(action.slug);
        toast.success(`Вертикаль «${action.displayName}» установлена`);
        setAppliedTick((n) => n + 1);
        setPendingAction(null);
      } else if (action.type === "build_funnel") {
        const res = await saas.applyWorkflow(action.stages);
        toast.success(`Воронка применена — стадий: ${res.stageCount}`);
        setAppliedTick((n) => n + 1);
        setPendingAction(null);
      } else if (action.type === "navigate") {
        if (action.to) navigate(action.to);
        else if (typeof action.step === "number") setNavStep({ step: action.step, at: Date.now() });
        setPendingAction(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось выполнить действие");
    } finally {
      setApplying(false);
    }
  }, [navigate]);

  const dismissAction = useCallback(() => setPendingAction(null), []);
  const clear = useCallback(() => {
    setMessages([]);
    setError("");
    setPendingAction(null);
  }, []);

  const gotoLlmSetup = useCallback(() => {
    if (pageRef.current?.pageId === "onboarding") setNavStep({ step: 1, at: Date.now() });
    else navigate("/settings");
  }, [navigate]);

  const value: CopilotContextValue = {
    open,
    setOpen,
    toggle,
    messages,
    busy,
    error,
    pendingAction,
    applying,
    llmReady: pageMeta.llmReady && !llmError,
    pageId: pageMeta.pageId,
    pageLabel: pageMeta.label,
    appliedTick,
    navStep,
    send,
    confirmAction,
    dismissAction,
    clear,
    gotoLlmSetup,
    publishContext,
  };

  return <CopilotCtx.Provider value={value}>{children}</CopilotCtx.Provider>;
}
