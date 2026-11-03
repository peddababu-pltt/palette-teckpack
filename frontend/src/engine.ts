// Background-run engine for the parts SVG / sewing pattern traces.
//
// A generate run auto-queues both traces the moment it has a sketch, so both
// are usually finished (or well underway) by the time anyone opens the card.
// A stage therefore outlives whichever overlay tab happens to be showing it:
// the run's state lives HERE, independent of React's component tree, so
// switching overlay tabs (or closing the overlay) never restarts it — a tab
// re-mounting just re-subscribes to whatever this engine already knows.
//
// parts and pattern each get their own queue/proc slot server-side (keyed
// "{job_id}:{stage}"), so the two run concurrently on the same job instead of
// one queueing behind the other.

import {
  cancelJobApi,
  makeLogProgress,
  startStage4,
  saveToDataRoom,
  startStage5,
  watchJob,
  type Job,
  type PatternParams,
} from "./api"

export type StageKind = "parts" | "pattern"

export const SVG_KINDS: Record<StageKind, { label: string; outKey: "parts_svg" | "pattern_svg" }> = {
  parts: { label: "Tracing parts SVG", outKey: "parts_svg" },
  pattern: { label: "Drafting sewing pattern", outKey: "pattern_svg" },
}

// The stage-slot name the server keys its queue/proc by -- must match each
// endpoint's own path segment (see job_slot() in main.py).
const STAGE_ENDPOINT: Record<StageKind, string> = {
  parts: "stage4",
  pattern: "stage5",
}

export interface LiveStage {
  key: string
  jobId: string
  kind: StageKind
  label: string
  pct: number
  started: boolean
  error: string | null
  cancelled: boolean
}

type JobPatcher = (jobId: string, patch: (job: Job) => Job) => void

export class StageEngine {
  private pluginId: string
  private live = new Map<string, LiveStage>()
  private listeners = new Set<() => void>()
  private patchJob: JobPatcher
  version = 0

  constructor(pluginId: string, patchJob: JobPatcher) {
    this.pluginId = pluginId
    this.patchJob = patchJob
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit() {
    this.version++
    this.listeners.forEach((fn) => fn())
  }

  static key(jobId: string, kind: StageKind) {
    return `${jobId}:${kind}`
  }

  getLive(jobId: string, kind: StageKind): LiveStage | undefined {
    return this.live.get(StageEngine.key(jobId, kind))
  }

  isLive(jobId: string, kind: StageKind): boolean {
    return this.live.has(StageEngine.key(jobId, kind))
  }

  // Joins an already-running stage for this job+kind, or starts a new one.
  // Never starts a second run for a stage already going.
  queue(job: Job, kind: StageKind, params?: PatternParams): Promise<void> {
    const key = StageEngine.key(job.job_id, kind)
    const existing = this.live.get(key)
    if (existing) return Promise.resolve()

    const live: LiveStage = {
      key,
      jobId: job.job_id,
      kind,
      label: SVG_KINDS[kind].label,
      pct: 0,
      started: false,
      error: null,
      cancelled: false,
    }
    this.live.set(key, live)
    this.emit()

    return this.run(job, kind, live, params)
  }

  // Clears a failed run's stuck entry so queue() sees no `existing` and
  // starts fresh — queue() alone won't do this since it treats any entry
  // (errored or not) as already-claimed.
  retry(job: Job, kind: StageKind): Promise<void> {
    this.live.delete(StageEngine.key(job.job_id, kind))
    return this.queue(job, kind)
  }

  // Redrafts the sewing pattern at a chosen size / with edited measurements.
  // A no-op while a pattern draft is already running for this job.
  redraftPattern(job: Job, params: PatternParams): Promise<void> {
    const key = StageEngine.key(job.job_id, "pattern")
    const existing = this.live.get(key)
    if (existing && !existing.error) return Promise.resolve()
    this.live.delete(key)
    return this.queue(job, "pattern", params)
  }

  private async run(job: Job, kind: StageKind, live: LiveStage, params?: PatternParams): Promise<void> {
    live.started = true
    this.emit()

    const startRes =
      kind === "parts" ? await startStage4(this.pluginId, job.job_id) : await startStage5(this.pluginId, job.job_id, params)
    if (startRes.error) {
      live.error = startRes.error
      this.emit()
      return
    }

    const onLine = makeLogProgress((p) => {
      live.pct = Math.max(live.pct, p)
      this.emit()
    }, kind)

    // A stage reports few milestones (and on the hosted app its log lines may
    // not arrive at all), so the bar sat at 0% for the whole draft. Estimate
    // from elapsed time -- quick at first, easing toward 90% -- and let real
    // milestones push it further; it never moves backwards, and reaches 100%
    // only when the stage is done.
    const t0 = Date.now()
    const tau = kind === "parts" ? 35 : 50 // seconds to ~63%
    const ticker = window.setInterval(() => {
      const est = Math.round(90 * (1 - Math.exp(-(Date.now() - t0) / 1000 / tau)))
      if (est > live.pct) {
        live.pct = est
        this.emit()
      }
    }, 1000)

    await new Promise<void>((done) => {
      const resolve = () => {
        window.clearInterval(ticker)
        done()
      }
      let payload: any = null
      watchJob(this.pluginId, job.job_id, {
        onProgress: (d) => {
          live.pct = Math.max(live.pct, d.percent)
          this.emit()
        },
        onLine,
        onStageDone: (d) => {
          payload = d
        },
        onDone: () => {
          this.live.delete(live.key)
          if (payload) {
            const spec = SVG_KINDS[kind]
            this.patchJob(job.job_id, (current) => ({
              ...current,
              mtime: Date.now() / 1000,
              outputs: {
                ...current.outputs,
                [spec.outKey]: payload.file,
                ...(payload.pages_file ? { pattern_pages: payload.pages_file } : {}),
                ...(payload.pieces_file ? { pattern_pieces: payload.pieces_file } : {}),
                // the 3D try-on reads the garment type / sizes from it
                ...(payload.design_file ? { design: payload.design_file } : {}),
              },
            }))
            // the pattern pages PDF also goes into the org's Data Room
            if (kind === "pattern") void saveToDataRoom(this.pluginId, job.job_id)
          }
          this.emit()
          resolve()
        },
        onError: (msg) => {
          live.error = msg
          this.emit()
          resolve()
        },
        onCancelled: () => {
          live.cancelled = true
          this.live.delete(live.key)
          this.emit()
          resolve()
        },
      }, STAGE_ENDPOINT[kind])
    })
  }

  cancel(jobId: string, kind: StageKind) {
    void cancelJobApi(this.pluginId, jobId, STAGE_ENDPOINT[kind])
  }

  // Both artefacts, queued the moment a generate run has a sketch to trace —
  // nobody has to ask for them, and by the time the card is opened they are
  // usually done.
  autoTrace(job: Job) {
    // not while its sketch is still being made: the parts and pattern would
    // trace the raw flat instead of the final "Default" image. The generate
    // run's own onDone calls this again once it finishes.
    if (!job.has_sketch || job.generating) return
    ;(["parts", "pattern"] as const).forEach((kind) => {
      if (!job.outputs[SVG_KINDS[kind].outKey]) this.queue(job, kind)
    })
  }
}
