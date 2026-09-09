import { useEffect, useRef, useState, type ReactNode } from "react"
import { usePluginTranslations } from "@palettelab/sdk"
import type { PartInfo } from "../api"
import { STRINGS } from "../strings"

// Zoom/pan chrome shared by the Parts SVG and Sewing pattern (SVG fallback)
// tabs. `children` is the actual stage content: an <object> for a plain SVG,
// or a composited <canvas> once per-part visibility is wired up.
export default function SvgViewer({
  downloads,
  aside,
  rerun,
  children,
}: {
  downloads: ReactNode
  aside?: ReactNode
  rerun?: { label: string; title?: string; onClick: () => void }
  children: ReactNode
}) {
  const { t } = usePluginTranslations(STRINGS)
  const [zoom, setZoom] = useState(1)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const canvasRef = useRef<HTMLDivElement>(null)

  // Wheel-to-zoom has to prevent the page from scrolling underneath the
  // viewer, and React attaches onWheel as a passive listener (preventDefault
  // inside it is a no-op) — so this binds natively instead.
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    function onWheel(e: WheelEvent) {
      e.preventDefault()
      setZoom((z) => Math.min(8, Math.max(0.25, z * (e.deltaY < 0 ? 1.1 : 1 / 1.1))))
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [])

  return (
    <div className={aside ? "tp-viewer-layout" : ""}>
      <div className="tp-viewer-main">
        <div className="tp-svg-viewer">
          <div className="tp-svg-controls">
            <button type="button" className="tp-ctrl-btn" title={t("svgViewer.zoomOut")} aria-label={t("svgViewer.zoomOut")} onClick={() => setZoom((z) => Math.max(0.25, z / 1.25))}>
              &minus;
            </button>
            <span className="tp-svg-zoom-level">{Math.round(zoom * 100)}%</span>
            <button type="button" className="tp-ctrl-btn" title={t("svgViewer.zoomIn")} aria-label={t("svgViewer.zoomIn")} onClick={() => setZoom((z) => Math.min(8, z * 1.25))}>
              +
            </button>
            <button
              type="button"
              className="tp-ctrl-btn"
              onClick={() => {
                setZoom(1)
                setPos({ x: 0, y: 0 })
              }}
            >
              {t("svgViewer.reset")}
            </button>
            {rerun && (
              <button type="button" className="tp-ctrl-btn" title={rerun.title || ""} onClick={rerun.onClick}>
                {rerun.label}
              </button>
            )}
            <span className="tp-layer-toggle">{t("svgViewer.dragToPan")}</span>
          </div>
          <div
            className="tp-svg-canvas"
            ref={canvasRef}
            onPointerDown={(e) => {
              const startX = e.clientX - pos.x
              const startY = e.clientY - pos.y
              const move = (ev: PointerEvent) => setPos({ x: ev.clientX - startX, y: ev.clientY - startY })
              const up = () => {
                window.removeEventListener("pointermove", move)
                window.removeEventListener("pointerup", up)
              }
              window.addEventListener("pointermove", move)
              window.addEventListener("pointerup", up)
            }}
          >
            <div className="tp-svg-scroll" id="ov-svg-stage" style={{ transform: `translate(${pos.x}px, ${pos.y}px) scale(${zoom})` }}>
              {children}
            </div>
          </div>
        </div>
        <div className="tp-modal-actions" style={{ marginTop: 12 }}>
          {downloads}
        </div>
      </div>
      {aside}
    </div>
  )
}

// The output frame a run reports its percentage inside, so the Parts SVG /
// Sewing pattern tabs' first paint is already the output area — not a strip
// swapped out for a different-looking panel minutes later.
export function ViewerTaskPanel({
  label,
  pct,
  status,
  onCancel,
}: {
  label: string
  pct: number
  status?: string
  onCancel: () => void
}) {
  const { t } = usePluginTranslations(STRINGS)
  return (
    <div className="tp-viewer-main">
      <div className="tp-svg-viewer">
        <div className="tp-svg-controls">
          <button type="button" className="tp-ctrl-btn" disabled aria-hidden="true">
            &minus;
          </button>
          <span className="tp-svg-zoom-level">100%</span>
          <button type="button" className="tp-ctrl-btn" disabled aria-hidden="true">
            +
          </button>
          <button type="button" className="tp-ctrl-btn" disabled aria-hidden="true">
            {t("svgViewer.reset")}
          </button>
        </div>
        <div className="tp-svg-canvas" style={{ cursor: "default" }}>
          <div className="tp-task tp-task-center" role="status" aria-live="polite">
            <span className="tp-spinner" />
            <div className="tp-task-info">
              <div className="tp-task-label">{label}</div>
              <div className="tp-task-pct">{status || `${pct}%`}</div>
            </div>
            <button type="button" className="tp-modal-btn tp-task-cancel" onClick={onCancel}>
              {t("taskPanel.cancel")}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// Every part is exported as a FULL-canvas transparent PNG, so the garment is
// just those layers stacked at the origin in the tracer's own z-order — no
// per-layer offsets to track. Hiding a part is a real composite: what's left
// is the garment minus that piece, redrawn on any visibility toggle.
export function PartsCanvas({ parts, visible }: { parts: PartInfo[]; visible: boolean[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imagesRef = useRef<HTMLImageElement[]>([])
  const sizedRef = useRef(false)

  // Sizing the canvas BUFFER to the source image's full native resolution
  // (often 2x+ the CSS width the modal actually gives it) and letting the
  // browser's own element-to-page compositor scale it down for display is
  // what fused every dashed stitch line into the solid seam beside it: a
  // 2-3px source gap survives fine at 1:1, but the compositor's downscale
  // (not controlled by ctx.imageSmoothingQuality, which only affects
  // drawImage calls INSIDE the canvas) shrinks it below one screen pixel.
  // Sizing the buffer to the actual display width up front, and doing the
  // one real downscale ourselves via drawImage with imageSmoothingQuality
  // = "high", keeps that gap render-able instead of lossy-recompressed.
  function sizeToDisplay(canvas: HTMLCanvasElement, naturalW: number, naturalH: number) {
    const containerW = canvas.parentElement?.clientWidth || naturalW
    const dpr = window.devicePixelRatio || 1
    // never upscale past native — that would just blur the other way
    const scale = Math.min(1, containerW / naturalW)
    const w = Math.max(1, Math.round(naturalW * scale * dpr))
    const h = Math.max(1, Math.round(naturalH * scale * dpr))
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
      return true
    }
    return false
  }

  useEffect(() => {
    sizedRef.current = false
    imagesRef.current = parts.map((p) => {
      const img = new Image()
      img.onload = () => {
        const canvas = canvasRef.current
        if (canvas && !sizedRef.current) {
          sizeToDisplay(canvas, img.naturalWidth, img.naturalHeight)
          sizedRef.current = true
        }
        draw()
      }
      img.src = p.image
      return img
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parts])

  // The modal/container width can change after the initial size (window
  // resize) — re-fit the buffer to it so the same fusion can't creep back
  // in at a different viewport size.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ro = new ResizeObserver(() => {
      const img = imagesRef.current[0]
      if (!img || !img.naturalWidth) return
      if (sizeToDisplay(canvas, img.naturalWidth, img.naturalHeight)) draw()
    })
    if (canvas.parentElement) ro.observe(canvas.parentElement)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parts])

  function draw() {
    const canvas = canvasRef.current
    if (!canvas || !sizedRef.current) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = "high"
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    parts.forEach((_, i) => {
      const img = imagesRef.current[i]
      if (visible[i] && img && img.complete && img.naturalWidth) ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    })
  }

  useEffect(() => {
    draw()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible])

  return <canvas className="tp-part-canvas" ref={canvasRef} />
}
