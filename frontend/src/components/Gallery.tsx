import { useEffect, useMemo, useState } from "react"
import { usePluginTranslations } from "@palettelab/sdk"
import { resolveUrl, type Job } from "../api"
import { STRINGS } from "../strings"
import GalleryCard, { garmentLabel } from "./GalleryCard"

export default function Gallery({
  jobs,
  generating,
  genPercent,
  onCancelGenerate,
  onOpenCard,
  onDeleteJob,
}: {
  jobs: Job[]
  generating: boolean
  genPercent: number
  onCancelGenerate: () => void
  onOpenCard: (job: Job, tab: "overview" | "parts" | "pattern" | "spec") => void
  onDeleteJob: (job: Job) => void
}) {
  const { t } = usePluginTranslations(STRINGS)
  const [search, setSearch] = useState("")
  const [view, setView] = useState<"grid" | "list">("grid")
  const [openMenuJobId, setOpenMenuJobId] = useState<string | null>(null)

  useEffect(() => {
    // The toggle button's onClick calls stopPropagation, but that doesn't
    // reliably stop this native document listener from also seeing the very
    // same click that opened the menu -- closing it again in the same tick,
    // so it never appears to open at all. Ignoring clicks that originate
    // from the menu or its toggle button doesn't depend on stopPropagation
    // working the way that assumed.
    const close = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      if (target?.closest(".tp-menu, [aria-haspopup='true']")) return
      setOpenMenuJobId(null)
    }
    document.addEventListener("click", close)
    return () => document.removeEventListener("click", close)
  }, [])

  // ONE card per techpack — variants and (in "both" mode) the realistic
  // render are the same garment, so they live inside the card's own overlay,
  // not as extra tiles competing with it on the dashboard.
  const entries = useMemo(() => {
    const q = search.trim().toLowerCase()
    return jobs
      .map((job) => ({ job, img: resolveUrl(job.sketch), thumb: resolveUrl(job.thumb || job.sketch), label: garmentLabel(job, t) }))
      .filter((e) => e.img)
      .filter((e) => !q || e.label.toLowerCase().includes(q))
  }, [jobs, search, t])

  return (
    <div className="studio-main">
      <div className="studio-main-head">
        <div>
          <h2>{t("gallery.dashboard")}</h2>
          <span className="studio-note" id="gallery-count">
            {entries.length
              ? t(entries.length === 1 ? "gallery.techpackCountOne" : "gallery.techpackCountMany", { count: entries.length })
              : ""}
          </span>
        </div>
        <div className="dash-tools">
          <div className="search-field">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <line x1="20" y1="20" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="search"
              id="gallery-search"
              placeholder={t("gallery.searchPlaceholder")}
              aria-label={t("gallery.searchAria")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="toolbar-group" id="view-toolbar" role="group" aria-label={t("gallery.cardLayoutAria")}>
            <button
              type="button"
              className={`toolbar-btn icon-only${view === "grid" ? " active" : ""}`}
              title={t("gallery.gridView")}
              aria-label={t("gallery.gridView")}
              aria-pressed={view === "grid"}
              onClick={() => setView("grid")}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="7" height="7" rx="1.5" />
                <rect x="14" y="3" width="7" height="7" rx="1.5" />
                <rect x="3" y="14" width="7" height="7" rx="1.5" />
                <rect x="14" y="14" width="7" height="7" rx="1.5" />
              </svg>
            </button>
            <button
              type="button"
              className={`toolbar-btn icon-only${view === "list" ? " active" : ""}`}
              title={t("gallery.listView")}
              aria-label={t("gallery.listView")}
              aria-pressed={view === "list"}
              onClick={() => setView("list")}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="8" y1="6" x2="21" y2="6" />
                <line x1="8" y1="12" x2="21" y2="12" />
                <line x1="8" y1="18" x2="21" y2="18" />
                <line x1="3.5" y1="6" x2="3.5" y2="6" />
                <line x1="3.5" y1="12" x2="3.5" y2="12" />
                <line x1="3.5" y1="18" x2="3.5" y2="18" />
              </svg>
            </button>
          </div>
        </div>
      </div>
      <div className="studio-main-scroll">
        <div id="gallery" className={`tp-gallery${view === "list" ? " is-list" : ""}`}>
          {generating && (
            <div className="tp-card tp-card-skeleton" aria-label={t("gallery.generatingAria")} aria-busy="true">
              <div className="tp-card-media">
                <button type="button" className="upload-preview-clear tp-cancel-btn" title={t("gallery.cancelRun")} aria-label={t("gallery.cancelRun")} onClick={onCancelGenerate}>
                  &times;
                </button>
                <span className="tp-spinner" />
                <span className="tp-skeleton-pct">{genPercent}%</span>
              </div>
              <div className="tp-card-caption">
                <span className="tp-card-cat tp-ph tp-ph-cat" />
                <span className="tp-card-sub tp-ph tp-ph-sub" />
              </div>
              <div className="tp-card-foot">
                <span className="tp-card-foot-btn tp-ph" />
                <span className="tp-card-foot-btn tp-ph" />
              </div>
            </div>
          )}
          {entries.map((e) => (
            <GalleryCard
              key={e.job.job_id}
              job={e.job}
              imgUrl={e.img!}
              thumbUrl={e.thumb!}
              menuOpen={openMenuJobId === e.job.job_id}
              onToggleMenu={() => setOpenMenuJobId((cur) => (cur === e.job.job_id ? null : e.job.job_id))}
              onOpen={(tab) => onOpenCard(e.job, tab)}
              onDelete={() => onDeleteJob(e.job)}
            />
          ))}
        </div>
        <p className="studio-note" id="gallery-empty" style={{ display: entries.length > 0 || generating ? "none" : "block" }}>
          {t("gallery.emptyState")}
        </p>
      </div>
    </div>
  )
}
