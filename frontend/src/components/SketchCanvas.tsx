import { useEffect, useRef, useState } from "react"
import { usePluginTranslations } from "@palettelab/sdk"
import { STRINGS } from "../strings"

type Tool = "pen" | "eraser" | "pan" | "select"

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
  const [tool, setTool] = useState<Tool>("pen")
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
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const marqueeStartRef = useRef<{ x: number; y: number } | null>(null)

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
    if (!undoStack.length) return
    const data = undoStack[undoStack.length - 1]
    const current = snapshot()
    setUndoStack((prev) => prev.slice(0, -1))
    setRedoStack((prev) => [...prev, current])
    await restore(data)
  }

  async function redo() {
    if (!redoStack.length) return
    const data = redoStack[redoStack.length - 1]
    const current = snapshot()
    setRedoStack((prev) => prev.slice(0, -1))
    setUndoStack((prev) => [...prev, current])
    await restore(data)
  }

  function clearCanvas() {
    pushUndo()
    const canvas = canvasRef.current
    const ctx = canvas?.getContext("2d")
    if (!canvas || !ctx) return
    ctx.globalAlpha = 1
    ctx.fillStyle = "#FFFFFF"
    ctx.fillRect(0, 0, canvas.width, canvas.height)
  }

  function pointFromEvent(e: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current
    if (!canvas) return { x: 0, y: 0 }
    const rect = canvas.getBoundingClientRect()
    return {
      x: ((e.clientX - rect.left) / rect.width) * canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * canvas.height,
    }
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (tool === "pan") return
    const canvas = canvasRef.current
    const ctx = canvas?.getContext("2d")
    if (!canvas || !ctx) return
    const point = pointFromEvent(e)
    if (tool === "select") {
      marqueeStartRef.current = point
      setMarquee({ x: point.x, y: point.y, w: 0, h: 0 })
      return
    }
    pushUndo()
    drawingRef.current = true
    lastPointRef.current = point
    ctx.lineCap = "round"
    ctx.lineJoin = "round"
    ctx.lineWidth = strokeWidth
    ctx.globalAlpha = opacity / 100
    ctx.strokeStyle = tool === "eraser" ? "#FFFFFF" : color
    ctx.beginPath()
    ctx.moveTo(point.x, point.y)
    ctx.lineTo(point.x, point.y)
    ctx.stroke()
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    const point = pointFromEvent(e)
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
    if (!drawingRef.current || tool === "pan") return
    const canvas = canvasRef.current
    const ctx = canvas?.getContext("2d")
    if (!canvas || !ctx || !lastPointRef.current) return
    ctx.beginPath()
    ctx.moveTo(lastPointRef.current.x, lastPointRef.current.y)
    ctx.lineTo(point.x, point.y)
    ctx.stroke()
    lastPointRef.current = point
  }

  function onPointerUp() {
    if (tool === "select" && marquee) {
      const canvas = canvasRef.current
      const ctx = canvas?.getContext("2d")
      if (canvas && ctx && marquee.w > 0 && marquee.h > 0) {
        pushUndo()
        ctx.globalAlpha = 1
        ctx.fillStyle = "#FFFFFF"
        ctx.fillRect(marquee.x, marquee.y, marquee.w, marquee.h)
      }
      marqueeStartRef.current = null
      setMarquee(null)
      return
    }
    drawingRef.current = false
    lastPointRef.current = null
  }

  function handleSelectSketch() {
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
  const scaleX = rect ? rect.width / CANVAS_WIDTH : 1
  const scaleY = rect ? rect.height / CANVAS_HEIGHT : 1

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
        className="sketch-canvas-stage-wrap"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose()
        }}
      >
        <div className="sketch-canvas-stage">
          <canvas
            ref={canvasRef}
            width={CANVAS_WIDTH}
            height={CANVAS_HEIGHT}
            className={`sketch-canvas${tool === "pan" ? " pan" : ""}`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
          />
          {marquee && (
            <div
              className="sketch-canvas-marquee"
              style={{
                left: marquee.x * scaleX,
                top: marquee.y * scaleY,
                width: marquee.w * scaleX,
                height: marquee.h * scaleY,
              }}
            />
          )}
        </div>
      </div>

      <div className="sketch-canvas-toolbar">
        <button
          type="button"
          className={`sc-tool-btn${tool === "pen" ? " active" : ""}`}
          title={t("sketchCanvas.pen")}
          onClick={() => setTool("pen")}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17 3a2.828 2.828 0 114 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
          </svg>
        </button>
        <button
          type="button"
          className={`sc-tool-btn${tool === "eraser" ? " active" : ""}`}
          title={t("sketchCanvas.eraser")}
          onClick={() => setTool("eraser")}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 20H9L4 15a1.5 1.5 0 010-2l8-8a2 2 0 013 0l6 6a2 2 0 010 3l-5 5" />
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
              <span>{strokeWidth}px</span>
            </div>
            <input
              type="range"
              min={1}
              max={20}
              value={strokeWidth}
              onChange={(e) => setStrokeWidth(Number(e.target.value))}
            />
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
          </div>
        )}
        <button
          type="button"
          className={`sc-tool-btn${tool === "pan" ? " active" : ""}`}
          title={t("sketchCanvas.pan")}
          onClick={() => setTool("pan")}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 11V6a2 2 0 00-4 0v5M14 10V4a2 2 0 00-4 0v7M10 10.5V6a2 2 0 00-4 0v9a7 7 0 0014 0v-3a2 2 0 00-4 0" />
          </svg>
        </button>
        <button
          type="button"
          className={`sc-tool-btn${tool === "select" ? " active" : ""}`}
          title={t("sketchCanvas.select")}
          onClick={() => setTool("select")}
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
