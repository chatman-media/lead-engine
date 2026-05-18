import { useCallback, useEffect, useRef, useState } from "react";

// Custom-styled replacements for the native window.confirm / prompt / alert.
// Call sites use the imperative helpers below; <DialogHost/> (mounted once in
// App) renders the UI and wires up the module-level singletons on mount.

type ConfirmOptions = {
  message: string;
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
};

type PromptOptions = {
  message: string;
  title?: string;
  placeholder?: string;
  defaultValue?: string;
  confirmLabel?: string;
  cancelLabel?: string;
};

type ToastKind = "error" | "success" | "info";

type ActiveDialog =
  | { kind: "confirm"; opts: ConfirmOptions; resolve: (v: boolean) => void }
  | { kind: "prompt"; opts: PromptOptions; resolve: (v: string | null) => void };

type Toast = { id: number; message: string; kind: ToastKind };

let openConfirm: ((opts: ConfirmOptions) => Promise<boolean>) | null = null;
let openPrompt: ((opts: PromptOptions) => Promise<string | null>) | null = null;
let pushToast: ((message: string, kind: ToastKind) => void) | null = null;

/** Styled confirm dialog. Resolves true when the user confirms. */
export function confirmDialog(
  message: string,
  opts: Omit<ConfirmOptions, "message"> = {},
): Promise<boolean> {
  if (!openConfirm) return Promise.resolve(window.confirm(message));
  return openConfirm({ message, ...opts });
}

/** Styled prompt dialog. Resolves the entered text, or null when cancelled. */
export function promptDialog(
  message: string,
  opts: Omit<PromptOptions, "message"> = {},
): Promise<string | null> {
  if (!openPrompt) return Promise.resolve(window.prompt(message, opts.defaultValue ?? ""));
  return openPrompt({ message, ...opts });
}

/** Styled toast notification — the replacement for window.alert. */
export function notify(message: string, kind: ToastKind = "info"): void {
  if (!pushToast) {
    window.alert(message);
    return;
  }
  pushToast(message, kind);
}

let toastSeq = 0;

export function DialogHost() {
  const [dialog, setDialog] = useState<ActiveDialog | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [inputValue, setInputValue] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    openConfirm = (opts) =>
      new Promise<boolean>((resolve) => {
        setDialog({ kind: "confirm", opts, resolve });
      });
    openPrompt = (opts) =>
      new Promise<string | null>((resolve) => {
        setInputValue(opts.defaultValue ?? "");
        setDialog({ kind: "prompt", opts, resolve });
      });
    pushToast = (message, kind) => {
      const id = ++toastSeq;
      setToasts((t) => [...t, { id, message, kind }]);
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
    };
    return () => {
      openConfirm = null;
      openPrompt = null;
      pushToast = null;
    };
  }, []);

  const cancel = useCallback(() => {
    setDialog((cur) => {
      if (cur?.kind === "confirm") cur.resolve(false);
      else if (cur?.kind === "prompt") cur.resolve(null);
      return null;
    });
  }, []);

  const accept = useCallback(() => {
    setDialog((cur) => {
      if (cur?.kind === "confirm") cur.resolve(true);
      else if (cur?.kind === "prompt") cur.resolve(inputValue);
      return null;
    });
  }, [inputValue]);

  useEffect(() => {
    if (!dialog) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      } else if (e.key === "Enter") {
        e.preventDefault();
        accept();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dialog, cancel, accept]);

  useEffect(() => {
    if (dialog?.kind === "prompt") inputRef.current?.focus();
    else if (dialog?.kind === "confirm") confirmRef.current?.focus();
  }, [dialog]);

  return (
    <>
      {dialog && (
        <div className="dialog-backdrop" onMouseDown={cancel}>
          <div
            className="dialog"
            role="dialog"
            aria-modal="true"
            onMouseDown={(e) => e.stopPropagation()}
          >
            {dialog.opts.title && <div className="dialog-title">{dialog.opts.title}</div>}
            <div className="dialog-body">{dialog.opts.message}</div>
            {dialog.kind === "prompt" && (
              <input
                ref={inputRef}
                className="dialog-input"
                value={inputValue}
                placeholder={dialog.opts.placeholder ?? ""}
                onChange={(e) => setInputValue(e.target.value)}
              />
            )}
            <div className="dialog-actions">
              <button type="button" className="btn btn-ghost" onClick={cancel}>
                {dialog.opts.cancelLabel ?? "Отмена"}
              </button>
              <button
                ref={confirmRef}
                type="button"
                className={
                  dialog.kind === "confirm" && dialog.opts.danger
                    ? "btn btn-danger"
                    : "btn btn-primary"
                }
                onClick={accept}
              >
                {dialog.opts.confirmLabel ?? (dialog.kind === "prompt" ? "ОК" : "Подтвердить")}
              </button>
            </div>
          </div>
        </div>
      )}
      {toasts.length > 0 && (
        <div className="toast-stack">
          {toasts.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`toast toast-${t.kind}`}
              onClick={() => setToasts((cur) => cur.filter((x) => x.id !== t.id))}
            >
              {t.message}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
