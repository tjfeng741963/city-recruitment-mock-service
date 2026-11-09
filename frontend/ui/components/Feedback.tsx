import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { Button } from "./Button";
import { Dialog, ToastViewport, type ToastItem } from "./Overlay";
import type { Tone } from "./Display";

const TOAST_MS = 4000;

type ToastFn = (title: string, tone?: Tone) => void;
type ConfirmOptions = { title: string; description?: ReactNode; confirmLabel?: string; danger?: boolean };
type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const FeedbackContext = createContext<{ toast: ToastFn; confirm: ConfirmFn } | null>(null);

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [pending, setPending] = useState<(ConfirmOptions & { resolve: (ok: boolean) => void }) | null>(null);
  const seq = useRef(0);

  const dismiss = useCallback((id: number) => setToasts((s) => s.filter((t) => t.id !== id)), []);

  const toast = useCallback<ToastFn>(
    (title, tone = "success") => {
      const id = ++seq.current;
      setToasts((s) => [...s.slice(-2), { id, tone, title }]);
      window.setTimeout(() => dismiss(id), TOAST_MS);
    },
    [dismiss],
  );

  const confirm = useCallback<ConfirmFn>((opts) => new Promise((resolve) => setPending({ ...opts, resolve })), []);

  function settle(ok: boolean) {
    pending?.resolve(ok);
    setPending(null);
  }

  return (
    <FeedbackContext.Provider value={{ toast, confirm }}>
      {children}
      <ToastViewport items={toasts} onDismiss={dismiss} />
      <Dialog
        open={pending !== null}
        onClose={() => settle(false)}
        title={pending?.title ?? ""}
        description={pending?.description}
        footer={
          <>
            <Button variant="secondary" onClick={() => settle(false)}>
              取消
            </Button>
            <Button variant={pending?.danger ? "destructive" : "primary"} onClick={() => settle(true)}>
              {pending?.confirmLabel ?? "确定"}
            </Button>
          </>
        }
      />
    </FeedbackContext.Provider>
  );
}

export function useFeedback() {
  const ctx = useContext(FeedbackContext);
  if (!ctx) throw new Error("useFeedback must be used inside <FeedbackProvider>");
  return ctx;
}
