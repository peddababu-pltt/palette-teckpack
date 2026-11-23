import { usePluginTranslations } from "@palettelab/sdk"
import type { Job } from "../api"
import { downloadUrl, imgCrossOrigin, resolveUrl, withCacheBust } from "../api"
import { STRINGS } from "../strings"

const dlIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </svg>
)

type TFunc = (key: string, values?: undefined, defaultValue?: string) => string

export function garmentLabel(job: Job, t: TFunc): string {
  const c = job.classification
  if (c && c.status === "success") {
    const category = t(`taxonomy.category.${c.category}`, undefined, c.category)
    const subcategory = t(`taxonomy.subcategory.${c.subcategory}`, undefined, c.subcategory)
    return `${category}/${subcategory}`
  }
  return t("galleryCard.techpackFallback")
}

export default function GalleryCard({
  job,
  imgUrl,
  thumbUrl,
  menuOpen,
  onToggleMenu,
  onOpen,
  onDelete,
  onShare,
}: {
  job: Job
  imgUrl: string
  thumbUrl: string
  menuOpen: boolean
  onToggleMenu: () => void
  onOpen: (tab: "overview" | "parts" | "pattern" | "spec") => void
  onDelete: () => void
  onShare: () => void
}) {
  const { t } = usePluginTranslations(STRINGS)
  const out = job.outputs || ({} as Job["outputs"])
  const partsReady = !!out.parts_svg
  const patternReady = !!out.pattern_svg
  const label = garmentLabel(job, t)
  const [cat, sub] = label.split("/")
  // pattern-pages.pdf is overwritten in place on every draft, so its URL never
  // changes and the browser happily serves a stale copy — cache-bust with the
  // job's mtime. parts.svg's menu download link is left as-is, matching the
  // original (only the overlay's own Parts SVG tab cache-busts that one).
  const patternPdfUrl = withCacheBust(resolveUrl(out.pattern_pages), job.mtime)
  const partsSvgUrl = resolveUrl(out.parts_svg)
  // Older backends don't send `owner`; treat that as the caller's own job.
  const isOwner = job.owner !== false
  const isShared = isOwner && !!job.shared && (job.shared.org || job.shared.users.length > 0)

  return (
    <div className="tp-card">
      <div className="tp-card-media">
        <span className="tp-size-badge">{job.size_kb} KB</span>
        <div className="tp-card-actions">
          <a className="tp-icon-btn tp-download-btn" href={downloadUrl(imgUrl)!} download title={t("galleryCard.downloadFlat")} aria-label={t("galleryCard.downloadFlat")}>
            {dlIcon}
          </a>
          <button
            type="button"
            className="tp-icon-btn"
            title={partsReady ? t("galleryCard.openPartsSvg") : t("galleryCard.tracePartsSvg")}
            aria-label={t("galleryCard.partsSvgAria")}
            disabled={!job.has_sketch}
            onClick={(e) => {
              e.stopPropagation()
              onOpen("parts")
            }}
          >
            {t("galleryCard.svgLabel")}
          </button>
          <button
            type="button"
            className="tp-icon-btn"
            title={t("galleryCard.moreActions")}
            aria-label={t("galleryCard.moreActions")}
            aria-haspopup="true"
            aria-expanded={menuOpen}
            onClick={(e) => {
              e.stopPropagation()
              onToggleMenu()
            }}
          >
            &hellip;
          </button>
        </div>
        <div className={`tp-menu${menuOpen ? "" : " hidden"}`}>
          <button
            type="button"
            className="tp-menu-item"
            disabled={!job.has_sketch}
            onClick={(e) => {
              e.stopPropagation()
              onToggleMenu()
              onOpen("pattern")
            }}
          >
            {patternReady ? t("galleryCard.openSewingPattern") : t("galleryCard.draftSewingPattern")}
          </button>
          {patternPdfUrl && (
            <a className="tp-menu-item" href={downloadUrl(patternPdfUrl)!} download onClick={(e) => { e.stopPropagation(); onToggleMenu() }}>
              {t("galleryCard.downloadPatternPdf")}
            </a>
          )}
          {partsReady && partsSvgUrl && (
            <a className="tp-menu-item" href={downloadUrl(partsSvgUrl)!} download onClick={(e) => { e.stopPropagation(); onToggleMenu() }}>
              {t("galleryCard.downloadPartsSvg")}
            </a>
          )}
          <button
            type="button"
            className="tp-menu-item"
            onClick={(e) => {
              e.stopPropagation()
              onToggleMenu()
              onOpen("overview")
            }}
          >
            {t("galleryCard.details")}
          </button>
          {isOwner && (
            <button
              type="button"
              className="tp-menu-item"
              onClick={(e) => {
                e.stopPropagation()
                onToggleMenu()
                onShare()
              }}
            >
              {t("galleryCard.share")}
            </button>
          )}
          {isOwner && (
            <button
              type="button"
              className="tp-menu-item tp-menu-danger"
              onClick={(e) => {
                e.stopPropagation()
                onToggleMenu()
                onDelete()
              }}
            >
              {t("galleryCard.deleteTechpack")}
            </button>
          )}
        </div>
        {/* The flat, not the uploaded photo: the card stands for the techpack this
            run produced, and the flat is that deliverable. */}
        <div className="tp-card-thumb-clip">
          <img
            className="tp-thumb"
            src={thumbUrl}
            crossOrigin={imgCrossOrigin()}
            alt={`${label} — ${label}`}
            draggable
            title={t("galleryCard.dragHint")}
            onClick={() => onOpen("overview")}
            onDragStart={(e) => {
              e.dataTransfer.setData("text/uri-list", imgUrl)
              e.dataTransfer.setData("text/plain", imgUrl)
              e.dataTransfer.effectAllowed = "copy"
            }}
          />
        </div>
      </div>
      <div className="tp-card-caption">
        <span className="tp-card-cat">{cat}</span>
        <span className="tp-card-sub">{sub || ""}</span>
        {!isOwner && <span className="tp-card-shared">{t("galleryCard.sharedWithYou")}</span>}
        {isShared && <span className="tp-card-shared">{t("galleryCard.sharedBadge")}</span>}
      </div>
      <div className="tp-card-foot">
        <button
          type="button"
          className="tp-card-foot-btn"
          disabled={!job.has_sketch}
          title={out.pattern_svg ? t("galleryCard.openSewingPattern") : t("galleryCard.draftSewingPattern")}
          onClick={() => onOpen("pattern")}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 7l4-4 4 4-2 2 6 6 2-2 4 4-4 4-4-4 2-2-6-6-2 2z" />
          </svg>
          {t("galleryCard.pattern")}
        </button>
        <button type="button" className={`tp-card-foot-btn${out.measurements ? " is-ready" : ""}`} onClick={() => onOpen("spec")}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21.3 8.7l-12.6 12.6a1 1 0 01-1.4 0l-4.6-4.6a1 1 0 010-1.4L15.3 2.7a1 1 0 011.4 0l4.6 4.6a1 1 0 010 1.4z" />
            <path d="M7.5 10.5l2 2M10.5 7.5l2 2M13.5 4.5l2 2" />
          </svg>
          {t("galleryCard.spec")}
        </button>
      </div>
    </div>
  )
}
