import { usePluginTranslations } from "@palettelab/sdk"
import { STRINGS } from "../strings"

// A run the overlay started: spinner + percent + status. Used for single
// modal-style stages (measure) that don't need the SVG/PDF viewer chrome.
export default function TaskPanel({
  label,
  pct,
  onCancel,
}: {
  label: string
  pct?: number
  onCancel?: () => void
}) {
  const { t } = usePluginTranslations(STRINGS)
  return (
    <div className="tp-task">
      <span className="tp-spinner" />
      <div className="tp-task-info">
        <div className="tp-task-label">{label}</div>
        {pct != null && <div className="tp-task-pct">{pct}%</div>}
      </div>
      {onCancel && (
        <button type="button" className="tp-modal-btn tp-task-cancel" onClick={onCancel}>
          {t("taskPanel.cancel")}
        </button>
      )}
    </div>
  )
}
