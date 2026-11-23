import { useEffect, useRef, useState } from "react"
import { usePluginTranslations } from "@palettelab/sdk"
import { STRINGS } from "../strings"

type Tool = "pencil" | "marker" | "brush" | "eraser" | "pan" | "select"
type Floating = { canvas: HTMLCanvasElement; url: string; x: number; y: number; w: number; h: number }

// Each drawing tool is the same stroke engine with a different character:
// how wide it runs for a given stroke size, how opaque it lays down, and
// whether overlaps darken. A pencil is what it always was -- the slider width,
// exactly the opacity asked for, crisp. A marker is broad, flat-ended and
// translucent, and multiplies so a second pass over the same spot reads
// darker, the way ink pooling does. A brush is round and pressure-ish: it
// thins out as the stroke speeds up (see BRUSH_SPEED_PX).
const TOOL_WIDTH: Record<string, number> = { pencil: 1, marker: 3, brush: 2, eraser: 6 }
const MARKER_ALPHA = 0.5      // ...of whatever the opacity slider says
const BRUSH_MIN_SCALE = 0.45  // a fast brush stroke narrows to this much
const BRUSH_SPEED_PX = 40     // px per event that counts as "fast"
// How far the drawn point chases the pointer, per event. A mouse or a finger
// arrives as a jittery polyline and drawing it literally is what made the
// pencil feel hard and scratchy -- every hand tremor became a visible corner.
// Pulling the drawn point only part of the way toward each raw one low-passes
// that out, so a slow curve comes out as a curve. 1 = follow exactly (which is
// what the eraser wants: a rubber that lags behind the ring you are aiming
// with is worse than a slightly rough edge).
const SMOOTHING = 0.55

const MAX_HISTORY = 30
const CANVAS_WIDTH = 900
const CANVAS_HEIGHT = 640
const PRESET_COLORS = [
  "#111111",
  "#8E8E93",
  "#E0575A",
  "#F0883E",
  "#E0B23C",
  "#3FB16D",
  "#4E8EF7",
  "#8B6CF0",
  "#D95FD9",
]

function loadImageOnto(ctx: CanvasRenderingContext2D, url: string, width: number, height: number): Promise<void> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      ctx.globalAlpha = 1
      ctx.clearRect(0, 0, width, height)
      ctx.fillStyle = "#FFFFFF"
      ctx.fillRect(0, 0, width, height)
      ctx.drawImage(img, 0, 0, width, height)
      resolve()
    }
    img.onerror = () => resolve()
    img.src = url
  })
}

export default function SketchCanvas({
  initialImageUrl,
  onSelect,
  onClose,
}: {
  initialImageUrl: string | null
  onSelect: (file: File) => void
  onClose: () => void
}) {
  const { t } = usePluginTranslations(STRINGS)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [tool, setTool] = useState<Tool>("pencil")
  const [color, setColor] = useState("#111111")
  const [strokeWidth, setStrokeWidth] = useState(3)
  const [opacity, setOpacity] = useState(100)
  const [colorPopoverOpen, setColorPopoverOpen] = useState(false)
  const [sizePopoverOpen, setSizePopoverOpen] = useState(false)
  const customColorInputRef = useRef<HTMLInputElement | null>(null)
  const [undoStack, setUndoStack] = useState<string[]>([])
  const [redoStack, setRedoStack] = useState<string[]>([])
  const drawingRef = useRef(false)
  const lastPointRef = useRef<{ x: number; y: number } | null>(null)
  // Midpoint of the previous segment: each new segment is drawn as a quadratic
  // through it with the raw point as the control, so a dragged stroke comes out
  // as a curve instead of the chain of straight chords a plain lineTo gives.
  const lastMidRef = useRef<{ x: number; y: number } | null>(null)
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const marqueeStartRef = useRef<{ x: number; y: number } | null>(null)
  // Select tool: a marquee LIFTS that region off the page into a floating piece
  // you can drag elsewhere; Delete/Backspace throws it away (erasing the region),
  // Enter/Esc, a click outside it or switching tools drops it back onto the page.
  const [floating, setFloatingState] = useState<Floating | null>(null)
  const floatingRef = useRef<Floating | null>(null)
  const dragRef = useRef<{ start: { x: number; y: number }; ox: number; oy: number } | null>(null)
  const [overFloating, setOverFloating] = useState(false)
  // Pan tool: the page is moved (and wheel-zoomed) as a view transform -- the
  // bitmap itself never changes, and pointFromCoords reads the transformed rect,
  // so drawing still lands under the cursor at any pan/zoom.
  const [view, setView] = useState({ x: 0, y: 0, zoom: 1 })
  const viewRef = useRef(view)
  viewRef.current = view
  const panStartRef = useRef<{ cx: number; cy: number; vx: number; vy: number } | null>(null)
  const [panning, setPanning] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)

  function setFloating(f: Floating | null) {
    floatingRef.current = f
    setFloatingState(f)
  }

  // Drops the floating selection back onto the page where it now sits.
  function commitFloating() {
    const f = floatingRef.current
    if (!f) return
    const ctx = canvasRef.current?.getContext("2d")
    if (ctx) {
      ctx.globalAlpha = 1
      ctx.globalCompositeOperation = "source-over"
      ctx.drawImage(f.canvas, Math.round(f.x), Math.round(f.y))
    }
    setFloating(null)
  }

  // Lifts a marquee region off the page: copies it out, whitens where it was.
  function liftSelection(r: { x: number; y: number; w: number; h: number }) {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext("2d")
    if (!canvas || !ctx) return
    const x = Math.max(0, Math.floor(r.x)), y = Math.max(0, Math.floor(r.y))
    const w = Math.min(canvas.width, Math.ceil(r.x + r.w)) - x
    const h = Math.min(canvas.height, Math.ceil(r.y + r.h)) - y
    if (w < 2 || h < 2) return
    pushUndo()
    const piece = document.createElement("canvas")
    piece.width = w
    piece.height = h
    piece.getContext("2d")?.drawImage(canvas, x, y, w, h, 0, 0, w, h)
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = "source-over"
    ctx.fillStyle = "#FFFFFF"
    ctx.fillRect(x, y, w, h)
    setFloating({ canvas: piece, url: piece.toDataURL("image/png"), x, y, w, h })
  }

  function pickTool(next: Tool) {
    commitFloating()
    setTool(next)
  }

  function insideFloating(p: { x: number; y: number }) {
    const f = floatingRef.current
    return !!f && p.x >= f.x && p.x <= f.x + f.w && p.y >= f.y && p.y <= f.y + f.h
  }

  // Wheel zooms around the cursor. Registered by hand because React's onWheel is
  // passive and can't stop the page from scrolling.
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    function onWheel(e: WheelEvent) {
      const stage = stageRef.current
      if (!stage) return
      e.preventDefault()
      const v = viewRef.current
      const zoom = Math.min(4, Math.max(0.5, v.zoom * Math.exp(-e.deltaY * 0.0015)))
      if (zoom === v.zoom) return
      const r = stage.getBoundingClientRect()
      // untransformed centre of the stage (scale is about the centre)
      const c0x = r.left + r.width / 2 - v.x, c0y = r.top + r.height / 2 - v.y
      const k = zoom / v.zoom
      setView({
        zoom,
        x: e.clientX - c0x - (e.clientX - c0x - v.x) * k,
        y: e.clientY - c0y - (e.clientY - c0y - v.y) * k,
      })
    }
    wrap.addEventListener("wheel", onWheel, { passive: false })
    return () => wrap.removeEventListener("wheel", onWheel)
  }, [])

  // Load the starting bitmap once on mount: the previously-saved drawing if
  // there is one, otherwise a blank white page.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    if (initialImageUrl) {
      void loadImageOnto(ctx, initialImageUrl, canvas.width, canvas.height)
    } else {
      ctx.fillStyle = "#FFFFFF"
      ctx.fillRect(0, 0, canvas.width, canvas.height)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (floatingRef.current) {
        if (e.key === "Delete" || e.key === "Backspace") {
          e.preventDefault()
          setFloating(null) // the region was already whitened when it was lifted
          return
        }
        if (e.key === "Escape" || e.key === "Enter") {
          e.preventDefault()
          commitFloating()
          return
        }
      }
      if (e.key !== "Escape") return
      if (colorPopoverOpen) {
        setColorPopoverOpen(false)
        return
      }
      if (sizePopoverOpen) {
        setSizePopoverOpen(false)
        return
      }
      onClose()
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [onClose, colorPopoverOpen, sizePopoverOpen])

  function snapshot(): string {
    const canvas = canvasRef.current
    if (!canvas) return ""
    return canvas.toDataURL("image/png")
  }

  function pushUndo() {
    const data = snapshot()
    if (!data) return
    setUndoStack((prev) => {
      const next = [...prev, data]
      return next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next
    })
    setRedoStack([])
  }

  async function restore(data: string) {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext("2d")
    if (!canvas || !ctx) return
    await loadImageOnto(ctx, data, canvas.width, canvas.height)
  }

  async function undo() {
    commitFloating()
    if (!undoStack.length) return
    const data = undoStack[undoStack.length - 1]
    const current = snapshot()
    setUndoStack((prev) => prev.slice(0, -1))
    setRedoStack((prev) => [...prev, current])
    await restore(data)
  }

  async function redo() {
    commitFloating()
    if (!redoStack.length) return
    const data = redoStack[redoStack.length - 1]
    const current = snapshot()
    setRedoStack((prev) => prev.slice(0, -1))
    setUndoStack((prev) => [...prev, current])
    await restore(data)
  }

  function clearCanvas() {
    commitFloating()
    pushUndo()
    const canvas = canvasRef.current
    const ctx = canvas?.getContext("2d")
    if (!canvas || !ctx) return
    ctx.globalAlpha = 1
    ctx.fillStyle = "#FFFFFF"
    ctx.fillRect(0, 0, canvas.width, canvas.height)
  }

  function pointFromCoords(clientX: number, clientY: number) {
    const canvas = canvasRef.current
    if (!canvas) return { x: 0, y: 0 }
    const rect = canvas.getBoundingClientRect()
    return {
      x: ((clientX - rect.left) / rect.width) * canvas.width,
      y: ((clientY - rect.top) / rect.height) * canvas.height,
    }
  }

  function pointFromEvent(e: React.PointerEvent<HTMLCanvasElement>) {
    return pointFromCoords(e.clientX, e.clientY)
  }

  const baseWidth = strokeWidth * (TOOL_WIDTH[tool] ?? 1)

  // Everything about the tool except the per-segment width, which the brush
  // varies as it goes.
  function configure(ctx: CanvasRenderingContext2D) {
    ctx.lineJoin = "round"
    ctx.lineCap = tool === "marker" ? "square" : "round"
    // The eraser is ALWAYS opaque. It used to take the opacity slider like a
    // pen does, so at 40% it laid 40%-white over the drawing and one pass left
    // most of the stroke behind -- erasing "worked" only by clicking the same
    // spot over and over. An eraser has no opacity; it either takes the pixel
    // or it does not.
    ctx.globalAlpha =
      tool === "eraser" ? 1 : (opacity / 100) * (tool === "marker" ? MARKER_ALPHA : 1)
    // multiply lets marker strokes pool where they cross, which is the whole
    // look of one. Every other tool paints over.
    ctx.globalCompositeOperation = tool === "marker" ? "multiply" : "source-over"
    ctx.strokeStyle = tool === "eraser" ? "#FFFFFF" : color
    ctx.lineWidth = baseWidth
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext("2d")
    if (!canvas || !ctx) return
    if (tool === "pan") {
      canvas.setPointerCapture?.(e.pointerId)
      panStartRef.current = { cx: e.clientX, cy: e.clientY, vx: view.x, vy: view.y }
      setPanning(true)
      return
    }
    const point = pointFromEvent(e)
    if (tool === "select") {
      canvas.setPointerCapture?.(e.pointerId)
      const f = floatingRef.current
      if (f && insideFloating(point)) {
        dragRef.current = { start: point, ox: f.x, oy: f.y }
        return
      }
      commitFloating()
      marqueeStartRef.current = point
      setMarquee({ x: point.x, y: point.y, w: 0, h: 0 })
      return
    }
    // Capture the pointer for the whole stroke. Without it the drag belongs to
    // the canvas only while the cursor is over it, so running off the edge --
    // or just moving faster than the hit-testing keeps up with -- dropped the
    // rest of the stroke, and the eraser appeared to need short repeated
    // clicks to do anything.
    canvas.setPointerCapture?.(e.pointerId)
    pushUndo()
    drawingRef.current = true
    lastPointRef.current = point
    lastMidRef.current = point
    configure(ctx)
    // A tap with no drag still marks the paper: a dot of the tool's own width.
    ctx.beginPath()
    ctx.arc(point.x, point.y, Math.max(0.5, baseWidth / 2), 0, Math.PI * 2)
    ctx.fillStyle = tool === "eraser" ? "#FFFFFF" : color
    ctx.fill()
  }

  function paintTo(ctx: CanvasRenderingContext2D, raw: { x: number; y: number }) {
    const last = lastPointRef.current
    const lastMid = lastMidRef.current
    if (!last || !lastMid) return
    const chase = tool === "eraser" ? 1 : SMOOTHING
    const point = {
      x: last.x + (raw.x - last.x) * chase,
      y: last.y + (raw.y - last.y) * chase,
    }
    const mid = { x: (last.x + point.x) / 2, y: (last.y + point.y) / 2 }
    if (tool === "brush") {
      const dist = Math.hypot(point.x - last.x, point.y - last.y)
      const scale = Math.max(BRUSH_MIN_SCALE, 1 - dist / BRUSH_SPEED_PX)
      ctx.lineWidth = baseWidth * scale
    }
    ctx.beginPath()
    ctx.moveTo(lastMid.x, lastMid.y)
    ctx.quadraticCurveTo(last.x, last.y, mid.x, mid.y)
    ctx.stroke()
    lastPointRef.current = point
    lastMidRef.current = mid
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (tool === "pan") {
      const start = panStartRef.current
      if (start) setView((v) => ({ ...v, x: start.vx + e.clientX - start.cx, y: start.vy + e.clientY - start.cy }))
      return
    }
    const point = pointFromEvent(e)
    if (tool === "select" && dragRef.current) {
      const d = dragRef.current
      const f = floatingRef.current
      if (f) setFloating({ ...f, x: d.ox + point.x - d.start.x, y: d.oy + point.y - d.start.y })
      return
    }
    if (tool === "select" && !marqueeStartRef.current) {
      const over = insideFloating(point)
      if (over !== overFloating) setOverFloating(over)
      return
    }
    if (tool === "select" && marqueeStartRef.current) {
      const start = marqueeStartRef.current
      setMarquee({
        x: Math.min(start.x, point.x),
        y: Math.min(start.y, point.y),
        w: Math.abs(point.x - start.x),
        h: Math.abs(point.y - start.y),
      })
      return
    }
    if (!drawingRef.current) return
    const canvas = canvasRef.current
    const ctx = canvas?.getContext("2d")
    if (!canvas || !ctx) return
    configure(ctx)
    // The browser batches pointer moves to one per frame and hands the ones it
    // skipped over here. Painting only the last of them is what made a quick
    // sweep come out as long straight chords -- and, with the eraser, as a
    // scatter of gaps between them.
    const coalesced = e.nativeEvent.getCoalescedEvents?.() ?? []
    if (coalesced.length > 1) {
      for (const ev of coalesced) paintTo(ctx, pointFromCoords(ev.clientX, ev.clientY))
      return
    }
    paintTo(ctx, point)
  }

  function onPointerUp(e?: React.PointerEvent<HTMLCanvasElement>) {
    const cap = canvasRef.current
    if (tool === "pan" || tool === "select") {
      if (cap && e && cap.hasPointerCapture?.(e.pointerId)) cap.releasePointerCapture(e.pointerId)
    }
    if (tool === "pan") {
      panStartRef.current = null
      setPanning(false)
      return
    }
    if (tool === "select" && dragRef.current) {
      dragRef.current = null
      return
    }
    // Smoothing lags the drawn point behind the pointer, so a stroke would end
    // a few px short of where you lifted. Close the gap before finishing.
    if (drawingRef.current && e && tool !== "eraser") {
      const ctx = canvasRef.current?.getContext("2d")
      const last = lastPointRef.current
      const end = pointFromEvent(e)
      if (ctx && last && lastMidRef.current && Math.hypot(end.x - last.x, end.y - last.y) > 0.5) {
        configure(ctx)
        ctx.beginPath()
        ctx.moveTo(lastMidRef.current.x, lastMidRef.current.y)
        ctx.quadraticCurveTo(last.x, last.y, end.x, end.y)
        ctx.stroke()
      }
    }
    if (tool === "select") {
      if (marquee) liftSelection(marquee)
      marqueeStartRef.current = null
      setMarquee(null)
      return
    }
    const canvas = canvasRef.current
    if (canvas && e && canvas.hasPointerCapture?.(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId)
    }
    // Leave the context the way the next stroke expects to find it -- the
    // marker's multiply and its half alpha are per-tool, not global state.
    const ctx = canvas?.getContext("2d")
    if (ctx) {
      ctx.globalCompositeOperation = "source-over"
      ctx.globalAlpha = 1
    }
    drawingRef.current = false
    lastPointRef.current = null
    lastMidRef.current = null
  }

  function handleSelectSketch() {
    commitFloating()
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.toBlob((blob) => {
      if (!blob) return
      const file = new File([blob], "sketch.png", { type: "image/png" })
      onSelect(file)
    }, "image/png")
  }

  const canvasEl = canvasRef.current
  const rect = canvasEl?.getBoundingClientRect()
  // screen px per canvas px, zoom included (rect is the transformed size)
  const scaleX = rect ? rect.width / CANVAS_WIDTH : 1
  // Overlays sit inside the (transformed) stage, so place them in percentages of
  // the page: they then follow pan and zoom with no maths of their own.
  const pct = (r: { x: number; y: number; w: number; h: number }) => ({
    left: `${(r.x / CANVAS_WIDTH) * 100}%`,
    top: `${(r.y / CANVAS_HEIGHT) * 100}%`,
    width: `${(r.w / CANVAS_WIDTH) * 100}%`,
    height: `${(r.h / CANVAS_HEIGHT) * 100}%`,
  })

  // The ring under the pointer is the eraser's actual footprint, in SCREEN px
  // (the canvas is 900px wide but drawn smaller, so its own units are not what
  // the cursor is measured in). It used to be a fixed 30px circle whatever the
  // stroke size said, so what you rubbed out never matched what you aimed at.
  // Capped at 128 because past that a cursor image is silently ignored and you
  // get no ring at all.
  const eraserPx = Math.min(128, Math.max(6, strokeWidth * TOOL_WIDTH.eraser * scaleX))
  const eraserBox = Math.ceil(eraserPx) + 4
  const eraserCursor =
    `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='${eraserBox}' height='${eraserBox}'` +
    ` viewBox='0 0 ${eraserBox} ${eraserBox}'%3E%3Ccircle cx='${eraserBox / 2}' cy='${eraserBox / 2}'` +
    ` r='${eraserPx / 2}' fill='none' stroke='%23555' stroke-width='1.5'/%3E%3C/svg%3E")` +
    ` ${Math.round(eraserBox / 2)} ${Math.round(eraserBox / 2)}, cell`

  return (
    <div className="sketch-canvas-overlay">
      <button
        type="button"
        className="sketch-canvas-close"
        title={t("sketchCanvas.close")}
        aria-label={t("sketchCanvas.close")}
        onClick={onClose}
      >
        &times;
      </button>
      <button type="button" className="sketch-canvas-select-btn" onClick={handleSelectSketch}>
        {t("sketchCanvas.selectSketch")}
      </button>

      <div
        ref={wrapRef}
        className="sketch-canvas-stage-wrap"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose()
        }}
      >
        <div
          ref={stageRef}
          className="sketch-canvas-stage"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}
        >
          <canvas
            ref={canvasRef}
            width={CANVAS_WIDTH}
            height={CANVAS_HEIGHT}
            className={`sketch-canvas${tool === "pan" ? (panning ? " panning" : " pan") : ""}`}
            style={
              tool === "select"
                ? { cursor: overFloating || dragRef.current ? "move" : "crosshair" }
                : tool === "eraser"
                ? { cursor: eraserCursor }
                : tool === "pencil"
                ? { cursor: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20' viewBox='0 0 24 24'%3E%3Cpath d='M17 3a2.828 2.828 0 114 4L7.5 20.5 2 22l1.5-5.5L17 3z' fill='none' stroke='%23333' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") 2 18, crosshair` }
                : undefined
            }
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          />
          {floating && (
            <div className="sketch-canvas-floating" style={pct(floating)}>
              <img src={floating.url} alt="" draggable={false} />
            </div>
          )}
          {marquee && <div className="sketch-canvas-marquee" style={pct(marquee)} />}
        </div>
      </div>

      <div className="sketch-canvas-toolbar">
        <button
          type="button"
          className={`sc-tool-btn${tool === "pencil" ? " active" : ""}`}
          title={t("sketchCanvas.pencil")}
          onClick={() => pickTool("pencil")}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17 3a2.828 2.828 0 114 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
          </svg>
        </button>
        <button
          type="button"
          className={`sc-tool-btn${tool === "marker" ? " active" : ""}`}
          title={t("sketchCanvas.marker")}
          onClick={() => pickTool("marker")}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 3l6 6-9.5 9.5H6l-1.5-4.5L15 3z" />
            <path d="M4 21h9" />
          </svg>
        </button>
        <button
          type="button"
          className={`sc-tool-btn${tool === "brush" ? " active" : ""}`}
          title={t("sketchCanvas.brush")}
          onClick={() => pickTool("brush")}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9.5 14.5 20 4a2 2 0 00-3-3L6.5 11.5" />
            <path d="M6.5 11.5a3.5 3.5 0 013 3.5c0 2-1.5 3-3.5 3H3c1.5-1 1.5-2 1.5-3.5a3 3 0 012-3z" />
          </svg>
        </button>
        <button
          type="button"
          className={`sc-tool-btn${tool === "eraser" ? " active" : ""}`}
          title={t("sketchCanvas.eraser")}
          onClick={() => pickTool("eraser")}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="8" />
          </svg>
        </button>
        <button
          type="button"
          className="sc-color-swatch"
          style={{ background: color }}
          title={t("sketchCanvas.color")}
          onClick={() => {
            setSizePopoverOpen(false)
            setColorPopoverOpen((open) => !open)
          }}
        />
        {colorPopoverOpen && (
          <div className="sc-popover sc-color-popover">
            {PRESET_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className={`sc-color-option${color === c ? " active" : ""}`}
                style={{ background: c }}
                onClick={() => {
                  setColor(c)
                  setColorPopoverOpen(false)
                }}
              />
            ))}
            <button
              type="button"
              className="sc-color-option sc-color-custom"
              title={t("sketchCanvas.color")}
              onClick={() => customColorInputRef.current?.click()}
            />
            <input
              ref={customColorInputRef}
              type="color"
              className="sc-color-native-input"
              value={color}
              onChange={(e) => {
                setColor(e.target.value)
                setColorPopoverOpen(false)
              }}
            />
          </div>
        )}

        <button
          type="button"
          className={`sc-tool-btn${sizePopoverOpen ? " active" : ""}`}
          title={t("sketchCanvas.strokeWidth")}
          onClick={() => {
            setColorPopoverOpen(false)
            setSizePopoverOpen((open) => !open)
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="4" y1="7" x2="20" y2="7" />
            <line x1="4" y1="12" x2="20" y2="12" />
            <line x1="4" y1="17" x2="20" y2="17" />
          </svg>
        </button>
        {sizePopoverOpen && (
          <div className="sc-popover sc-size-popover">
            <div className="sc-popover-row">
              <span>{t("sketchCanvas.strokeWidth")}</span>
              {/* What the slider means depends on the tool -- a marker runs 3x
                  the pencil and the eraser 6x -- so show the width that will
                  actually be laid down, not the slider's own number. */}
              <span>{Math.round(baseWidth)}px</span>
            </div>
            <input
              type="range"
              min={1}
              max={20}
              value={strokeWidth}
              onChange={(e) => setStrokeWidth(Number(e.target.value))}
            />
            {/* No opacity row for the eraser: it is always fully opaque (see
                configure), so a slider here would be a control that does
                nothing -- which is exactly what made erasing look broken. */}
            {tool !== "eraser" && (
              <>
                <div className="sc-popover-row">
                  <span>{t("sketchCanvas.opacity")}</span>
                  <span>{opacity}%</span>
                </div>
                <input
                  type="range"
                  min={1}
                  max={100}
                  value={opacity}
                  onChange={(e) => setOpacity(Number(e.target.value))}
                />
              </>
            )}
          </div>
        )}
        <button
          type="button"
          className={`sc-tool-btn${tool === "pan" ? " active" : ""}`}
          title={t("sketchCanvas.pan")}
          onClick={() => pickTool("pan")}
          // double-click the hand to put the page back: centred, 100%
          onDoubleClick={() => setView({ x: 0, y: 0, zoom: 1 })}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 11V6a2 2 0 00-4 0v5M14 10V4a2 2 0 00-4 0v7M10 10.5V6a2 2 0 00-4 0v9a7 7 0 0014 0v-3a2 2 0 00-4 0" />
          </svg>
        </button>
        <button
          type="button"
          className={`sc-tool-btn${tool === "select" ? " active" : ""}`}
          title={t("sketchCanvas.select")}
          onClick={() => pickTool("select")}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray="4 3">
            <rect x="4" y="4" width="16" height="16" rx="1" />
          </svg>
        </button>
        <button type="button" className="sc-tool-btn" disabled={!undoStack.length} title={t("sketchCanvas.undo")} onClick={undo}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 14L4 9l5-5M4 9h11a5 5 0 010 10h-1" />
          </svg>
        </button>
        <button type="button" className="sc-tool-btn" disabled={!redoStack.length} title={t("sketchCanvas.redo")} onClick={redo}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 14l5-5-5-5M20 9H9a5 5 0 000 10h1" />
          </svg>
        </button>
        <button type="button" className="sc-tool-btn sc-tool-danger" title={t("sketchCanvas.clear")} onClick={clearCanvas}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 6h18M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2m3 0-1 14a2 2 0 01-2 2H7a2 2 0 01-2-2L4 6" />
          </svg>
        </button>
      </div>
    </div>
  )
}
