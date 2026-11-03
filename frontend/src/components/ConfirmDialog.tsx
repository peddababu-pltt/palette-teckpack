// In-app confirmation dialog. window.confirm() is unreliable here: the hosted app
// runs this plugin inside an embedded frame, where the browser's own modal
// dialogs are blocked or shown oddly -- "Delete techpack" asked and nothing
// appeared. `const ok = await confirm({ message })` instead, from any component
// under <ConfirmProvider>.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react"

export interface ConfirmOptions {
  message: string
  title?: string
  confirmLabel?: string
  cancelLabel?: string // "" hides the cancel button (a plain message box)
  danger?: boolean // the confirm button reads as destructive
}

type Confirm = (opts: ConfirmOptions) => Promise<boolean>

const ConfirmContext = createContext<Confirm>(async () => false)

export function useConfirm(): Confirm {
  return useContext(ConfirmContext)
}

export function ConfirmProvider({ children, labels }: {
  children: ReactNode
  labels: { confirm: string; cancel: string }
}) {
  const [open, setOpen] = useState<ConfirmOptions | null>(null)
  const resolver = useRef<((ok: boolean) => void) | null>(null)
  const confirmBtn = useRef<HTMLButtonElement>(null)

  const confirm = useCallback<Confirm>((opts) => {
    resolver.current?.(false) // a second ask replaces an unanswered one
    setOpen(opts)
    return new Promise<boolean>((resolve) => { resolver.current = resolve })
  }, [])

  const answer = useCallback((ok: boolean) => {
    resolver.current?.(ok)
    resolver.current = null
    setOpen(null)
  }, [])

  useEffect(() => {
    if (!open) return
    confirmBtn.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); answer(false) }
      else if (e.key === "Enter") { e.preventDefault(); answer(true) }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, answer])

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {open && (
        <div className="tp-confirm-backdrop" onClick={() => answer(false)}>
          <div
            className="tp-confirm"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={open.title ? "tp-confirm-title" : undefined}
            aria-describedby="tp-confirm-message"
            onClick={(e) => e.stopPropagation()}
          >
            {open.title && <h3 id="tp-confirm-title">{open.title}</h3>}
            <p id="tp-confirm-message">{open.message}</p>
            <div className="tp-confirm-actions">
              {open.cancelLabel !== "" && (
                <button type="button" className="tp-modal-btn" onClick={() => answer(false)}>
                  {open.cancelLabel || labels.cancel}
                </button>
              )}
              <button
                type="button"
                ref={confirmBtn}
                className={`tp-modal-btn tp-confirm-ok${open.danger ? " is-danger" : ""}`}
                onClick={() => answer(true)}
              >
                {open.confirmLabel || labels.confirm}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  )
}
