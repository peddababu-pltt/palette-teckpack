import { useEffect } from "react"
import { usePluginTranslations } from "@palettelab/sdk"
import type { Job, OverlayTab } from "../api"
import type { StageEngine } from "../engine"
import { STRINGS } from "../strings"
import { garmentLabel } from "./GalleryCard"
import OverviewTab from "./tabs/OverviewTab"
import PartsTab from "./tabs/PartsTab"
import PatternTab from "./tabs/PatternTab"
import SpecTab from "./tabs/SpecTab"

// One overlay serves every card action — detail, parts SVG, sewing pattern,
// and spec — via an in-modal tab bar instead of separate stage pages.
export default function Overlay({
  job,
  tab,
  pluginId,
  engine,
  onTabChange,
  onClose,
  onPatchJob,
}: {
  job: Job
  tab: OverlayTab
  pluginId: string
  engine: StageEngine
  onTabChange: (tab: OverlayTab) => void
  onClose: () => void
  onPatchJob: (jobId: string, patch: (job: Job) => Job) => void
}) {
  const { t } = usePluginTranslations(STRINGS)
  const CARD_TABS: { id: OverlayTab; label: string }[] = [
    { id: "overview", label: t("overlay.tabSketch") },
    { id: "parts", label: t("overlay.tabPartsSvg") },
    { id: "pattern", label: t("overlay.tabSewingPattern") },
    { id: "spec", label: t("overlay.tabSpec") },
  ]

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [onClose])

  const out = job.outputs
  const ready: Record<OverlayTab, boolean> = {
    overview: false,
    parts: !!out.parts_svg,
    pattern: !!out.pattern_svg,
    spec: !!out.measurements,
  }

  return (
    <div
      id="overlay"
      className="tp-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="tp-overlay-panel tp-overlay-wide">
        <div className="tp-overlay-header">
          <div>
            <h2 id="ov-title">{garmentLabel(job, t)}</h2>
            <div id="ov-sub" className="studio-note">
              {new Date(job.mtime * 1000).toLocaleString()}
            </div>
          </div>
          <div className="tp-modal-actions" id="ov-actions">
            <div className="toggle-group ov-tabs">
              {CARD_TABS.map((tab_) => (
                <button
                  type="button"
                  key={tab_.id}
                  className={`toggle-btn${tab_.id === tab ? " active" : ""}`}
                  onClick={() => onTabChange(tab_.id)}
                >
                  {tab_.label}
                  {ready[tab_.id] && <span className="ov-tab-dot" title={t("overlay.ready")} />}
                </button>
              ))}
            </div>
          </div>
          <button className="tp-overlay-close" id="ov-close" title={t("overlay.close")} aria-label={t("overlay.close")} onClick={onClose}>
            &times;
          </button>
        </div>
        <div id="ov-body">
          {tab === "overview" && <OverviewTab job={job} pluginId={pluginId} />}
          {tab === "parts" && <PartsTab job={job} pluginId={pluginId} engine={engine} />}
          {tab === "pattern" && <PatternTab job={job} pluginId={pluginId} engine={engine} />}
          {tab === "spec" && <SpecTab job={job} pluginId={pluginId} onPatchJob={onPatchJob} />}
        </div>
      </div>
    </div>
  )
}
