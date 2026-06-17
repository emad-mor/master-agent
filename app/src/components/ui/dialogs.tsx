"use client";

import { useCallback, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, AlertTriangle } from "lucide-react";
import { cx } from "@/lib/format";
import "./dialogs.css";

/* useDialogs — an in-app replacement for window.confirm / prompt / alert that
 * matches Daryan's look. Returns promise-based openers plus a `dialog` node to
 * render and an `isOpen` flag (handy for suppressing an enclosing panel's own
 * Escape handler while a dialog is up).
 *
 *   const { confirm, prompt, alert, dialog, isOpen } = useDialogs();
 *   if (!(await confirm({ title, body, tone: "danger" }))) return;   // → boolean
 *   const name = await prompt({ title, inputLabel });                // → string | null
 *   await alert({ title, body });                                    // → void
 *   return <>… {dialog}</>;
 *
 * Pass `onConfirm` to run async work with an in-dialog spinner; throw from it to
 * keep the dialog open and surface the error. `typePhrase` gates the confirm
 * button behind typing an exact phrase (for irreversible actions). */

type Tone = "danger" | "default";
type Kind = "confirm" | "prompt" | "alert";

export type DialogOpts = {
  tone?: Tone;
  icon?: React.ReactNode;
  title: string;
  body?: React.ReactNode;
  quote?: string;                       // a quoted preview (e.g. the item being removed)
  confirmLabel?: string;
  cancelLabel?: string;
  confirmIcon?: React.ReactNode;
  typePhrase?: string;                  // require typing this exact phrase to arm confirm
  // prompt only:
  inputLabel?: React.ReactNode;
  initialValue?: string;
  placeholder?: string;
  // optional async work, run with a spinner; throw to keep the dialog open + show the error
  onConfirm?: (value: string) => void | Promise<void>;
};

type Spec = DialogOpts & { kind: Kind };
type Active = Spec & { resolve: (v: unknown) => void };

export function useDialogs() {
  const [active, setActive] = useState<Active | null>(null);

  const open = useCallback(
    <T,>(spec: Spec) =>
      new Promise<T>((resolve) => setActive({ ...spec, resolve: resolve as (v: unknown) => void })),
    [],
  );

  const confirm = useCallback((o: DialogOpts) => open<boolean>({ ...o, kind: "confirm" }), [open]);
  const prompt = useCallback((o: DialogOpts) => open<string | null>({ ...o, kind: "prompt" }), [open]);
  const alert = useCallback((o: DialogOpts) => open<void>({ ...o, kind: "alert" }), [open]);

  const dialog =
    active && typeof document !== "undefined"
      ? createPortal(
          <DialogView
            spec={active}
            onDone={(v) => {
              const r = active.resolve;
              setActive(null);
              r(v);
            }}
          />,
          document.body,
        )
      : null;

  return { confirm, prompt, alert, dialog, isOpen: !!active };
}

function DialogView({ spec, onDone }: { spec: Active; onDone: (v: unknown) => void }) {
  const isPrompt = spec.kind === "prompt";
  const isAlert = spec.kind === "alert";
  const danger = spec.tone === "danger";
  const needsType = !!spec.typePhrase && !isPrompt && !isAlert;
  const hasInput = isPrompt || needsType;

  const [value, setValue] = useState(isPrompt ? spec.initialValue ?? "" : "");
  const [gate, setGate] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const armed = !needsType || gate.trim().toLowerCase() === spec.typePhrase!.trim().toLowerCase();
  const cancelValue: unknown = isPrompt ? null : false;

  const cancel = useCallback(() => { if (!busy) onDone(cancelValue); }, [busy, cancelValue, onDone]);

  const submit = useCallback(async () => {
    if (busy || !armed) return;
    const result: unknown = isPrompt ? value.trim() : true;
    if (spec.onConfirm) {
      setErr(null);
      setBusy(true);
      try {
        await spec.onConfirm(isPrompt ? value.trim() : "");
        onDone(result);
      } catch (e) {
        setBusy(false);
        setErr(e instanceof Error && e.message ? e.message : "Something went wrong — please try again.");
      }
    } else {
      onDone(result);
    }
  }, [busy, armed, isPrompt, value, spec, onDone]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.stopPropagation(); cancel(); }
    else if (e.key === "Enter" && !e.shiftKey && (!hasInput || armed)) { e.preventDefault(); void submit(); }
  };

  return (
    <div
      className="dlg-backdrop"
      onMouseDown={(e) => { if (e.target === e.currentTarget) cancel(); }}
    >
      <div
        className={cx("dlg", danger && "dlg--danger")}
        role={isAlert ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-label={spec.title}
        onKeyDown={onKey}
      >
        <div className="dlg__head">
          {spec.icon ?? (danger ? <AlertTriangle size={18} style={{ color: "#ff6b6b", flexShrink: 0 }} /> : null)}
          <h3 className="dlg__title">{spec.title}</h3>
        </div>

        {spec.body != null && <p className="dlg__body">{spec.body}</p>}
        {spec.quote && <p className="dlg__quote">“{spec.quote}”</p>}

        {isPrompt && (
          <>
            {spec.inputLabel != null && <label className="dlg__label">{spec.inputLabel}</label>}
            <input
              className="dlg__input"
              autoFocus
              value={value}
              disabled={busy}
              placeholder={spec.placeholder}
              onChange={(e) => setValue(e.target.value)}
            />
          </>
        )}

        {needsType && (
          <>
            <label className="dlg__label">
              Type <span className="dlg__phrase">{spec.typePhrase}</span> to confirm
            </label>
            <input
              className={cx("dlg__input dlg__input--mono", armed && "dlg__input--armed")}
              autoFocus
              value={gate}
              disabled={busy}
              placeholder={spec.typePhrase}
              onChange={(e) => setGate(e.target.value)}
            />
          </>
        )}

        {err && <p className="dlg__err">{err}</p>}

        <div className="dlg__actions">
          {!isAlert && (
            <button className="dlg__btn dlg__btn--ghost" onClick={cancel} disabled={busy}>
              {spec.cancelLabel ?? "Cancel"}
            </button>
          )}
          <button
            autoFocus={!hasInput}
            className={cx("dlg__btn", danger ? "dlg__btn--danger" : "dlg__btn--primary")}
            onClick={() => void submit()}
            disabled={!armed || busy}
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : spec.confirmIcon}
            {spec.confirmLabel ?? (isAlert ? "OK" : "Confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
