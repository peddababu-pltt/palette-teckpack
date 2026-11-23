// Typed fetch helpers + SSE plumbing for the techpack backend
// (backend/api/main.py, mounted at /api/v1/plugins/<pluginId>/*).
//
// Every call here goes through plain `fetch` against `getBaseUrl()`, not the
// SDK's own `apiFetch` — see `bootstrapBaseUrl` and `apiCall` below for why:
// in short, `apiFetch` forces both a JSON content-type (breaks multipart
// uploads) and `credentials: "include"` (breaks under pltt dev's local
// simulator, whose generated CORS config is allow_origins="*" +
// allow_credentials=False — those two can never coexist for a browser).

import { createPaletteClient, getBaseUrl, hasPermission, setBaseUrl } from "@palettelab/sdk"
import type { PlatformContext } from "@palettelab/sdk"

// The SDK's module-level `getBaseUrl()` defaults to a hardcoded
// "http://localhost:8000" and is only ever corrected by a call to
// `setBaseUrl()` — nothing in `pltt dev`'s local no-Docker simulator makes
// that call (the simulator instead wires a *context-scoped* `platform.apiFetch`
// straight to the real, dynamically-chosen backend port; that's the only
// thing guaranteed to be wired correctly there). `getBaseUrl()` is still what
// every plain `<img src>`, download `<a href>`, `EventSource`, and multipart
// `fetch` in this file needs, since none of those can be routed through a
// fetch-wrapper function. Fix it once, at startup, by making one real
// `platform.apiFetch` call and reading the *actual* URL the browser fetched
// (`Response.url`, after the simulator's rewrite to `http://127.0.0.1:<port>`)
// instead of the path we asked for — then `setBaseUrl()` to that origin so
// every subsequent getBaseUrl()-based call resolves correctly for the rest of
// the session. Call this once, before rendering anything that depends on it.
export async function bootstrapBaseUrl(
  platformApiFetch: (path: string, init?: RequestInit) => Promise<Response>,
  pluginId: string,
): Promise<void> {
  bootstrappedPluginId = pluginId
  try {
    const res = await platformApiFetch(`/api/v1/plugins/${pluginId}/health`)
    if (res.url) {
      const u = new URL(res.url)
      setBaseUrl(u.origin)
      // A preview publish is served through a per-publish gateway prefix
      // (/api/v1/appstore/previews/<id>/plugins/<pluginId>/...), not the
      // direct /api/v1/plugins/<pluginId>/... path every other call in this
      // file assumes, and it's gated by a `preview_token` query param. Both
      // only show up in the *resolved* health URL — capture them here so
      // every later call (and every backend-returned file/thumb path) can be
      // rewritten onto the same gateway instead of 404ing against the direct
      // path. For a live (non-preview) install these are a no-op: the
      // resolved path already matches the default and there's no token.
      resolvedPrefix = u.pathname.replace(/\/health$/, "")
      previewQuery = u.search
    }
  } catch {
    // Left at the SDK's default; real hosted deployments may already point
    // it correctly (that path isn't exercised by pltt dev's local simulator).
  }
}

let resolvedPrefix: string | null = null
let previewQuery = ""
let bootstrappedPluginId: string | null = null

function withPreviewQuery(path: string): string {
  if (!previewQuery) return path
  return `${path}${path.includes("?") ? "&" : "?"}${previewQuery.slice(1)}`
}

// Rewrites a direct /api/v1/plugins/<pluginId>/... path (the shape every
// backend-returned file/thumb URL uses, and the shape every call below
// defaults to before bootstrap resolves) onto the preview gateway prefix
// captured above, when one was captured.
function rewritePrefix(path: string): string {
  if (!resolvedPrefix || !bootstrappedPluginId) return path
  const defaultPrefix = `/api/v1/plugins/${bootstrappedPluginId}`
  return path.startsWith(defaultPrefix) ? resolvedPrefix + path.slice(defaultPrefix.length) : path
}

export const SIZES = ["XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL"] as const
export type Size = (typeof SIZES)[number]

export type OverlayTab = "overview" | "parts" | "pattern" | "spec"

// ---------------- shapes returned by the backend ----------------

export interface AnalyzeMeasurement {
  key: string
  label: string
  cm: number | null
  how: string
}

export interface AnalyzeResult {
  imageKind: "photo" | "flat_sketch" | "not_a_garment" | string
  garmentCategory: string
  design: string | null
  designLabel: string | null
  bodyRegion: "upper" | "lower" | "full" | null
  apparentSize: string
  confidence: number
  notes: string
  measurements: AnalyzeMeasurement[]
}

export interface AnalyzeUnavailable {
  unavailable: string
}

export type AnalyzeResponse = AnalyzeResult | AnalyzeUnavailable

export function isAnalyzeUnavailable(a: AnalyzeResponse | null): a is AnalyzeUnavailable {
  return !!a && "unavailable" in a
}

export interface Variation {
  id: string
  label: string
  sketch: string | null
  realistic: string | null
}

export interface JobOutputs {
  parts_svg: string | null
  pattern_svg: string | null
  pattern_pages: string | null
  design: string | null
  pattern_pieces?: string | null
  measurements: string | null
  redraw: string | null
}

export interface PomEntry {
  name: string
  values: Record<string, number>
}

export interface Classification {
  status: "success" | "failure" | string
  category?: string
  subcategory?: string
  block_type?: string
  confidence?: number
  reasoning?: string
  construction_elements?: string[]
  selected_size?: string
  poms?: PomEntry[]
}

export interface Job {
  job_id: string
  sketch: string
  thumb: string
  input: string | null
  size_kb: number
  mtime: number
  classification: Classification | null
  has_sketch: boolean
  generating?: boolean // its generate pipeline is still running (sketch not final yet)
  variations: Variation[]
  references: string[]
  outputs: JobOutputs
  owner?: boolean // the caller created it (can share / delete); false = shared with them
  shared?: JobShare | null // only sent to the owner
}

export interface JobShare {
  org: boolean // everyone in the organisation can open it
  users: string[] // teammates it is shared with, by user id
}

export interface OrgMember {
  id: string
  name: string | null
  email: string | null
  role?: string | null
}

export interface PatternMeasurement {
  key: string
  label: string
  how: string
  cm: number | null
  overridden: boolean
}

export interface PatternDesign {
  design?: string
  designKey?: string
  custom?: boolean
  size?: string
  sizes?: string[]
  measurements?: PatternMeasurement[]
  sizeTable?: Record<string, Record<string, number | null>>
  extraPieces?: string[]
  fit?: string
  closure?: string
  buttonCount?: number
  pockets?: { type: string; count?: number; position?: string }
  collarStyle?: string
  neckline?: string
  sleeveLength?: string
  [key: string]: unknown
}

// pattern-pieces.json: one transparent PNG per cut piece, for the 3D preview.
export interface PatternPiece3D {
  suffix: string
  file: string // relative to the job dir
  wMm: number
  hMm: number
  // the cutline's box inside the texture, mm from its top-left
  cutMm: { x: number; y: number; w: number; h: number }
  onFold: boolean
  extra: boolean
  // AI read of the piece (backend piece-placement.mjs); absent when unavailable
  place?: { role: string; centreEdge: "left" | "right" | "none"; sewnOn: string }
}

export interface PatternPieces3D {
  dir: string
  garment?: { region: "upper" | "lower" | "full" } | null
  pieces: PatternPiece3D[]
}

export interface PartInfo {
  name: string
  label: string
  image: string
  /** The part as it sits in parts.svg, for stacking into the full view (`image`
   *  strokes its full outline, which doubles every shared seam when stacked).
   *  null for jobs traced before these existed. */
  layer: string | null
  bbox: { x: number; y: number; w: number; h: number; cw: number; ch: number } | null
}

export interface PartsResponse {
  garment_type: string | null
  recombined: string | null
  parts: PartInfo[]
}

export type MeasureResult = Classification

// ---------------- job run event contract ----------------

export type SseHandlers = {
  onProgress?: (d: { event: "stage_progress"; stage: string; completed: number; total: number; percent: number }) => void
  onStageDone?: (d: Record<string, any>) => void
  onError?: (message: string) => void
  onCancelled?: () => void
  onDone?: () => void
  onLine?: (line: string) => void
}

/** A live watch on one job run; close() stops it. */
export interface JobWatch {
  close: () => void
}

const POLL_MS = 1000
const POLL_MAX_FAILURES = 5

// Follows one run of job_id by polling GET /jobs/<id>/run, and routes its
// events to the matching handler. The run's state lives in the database, so
// this works whichever server answers each poll, and keeps working after a
// backend restart -- the old EventSource stream only existed on the one
// server that started the job. `done` is a separate terminal sentinel from
// `stage_done`, which carries the stage's payload (file urls, classification).
export function watchJob(pluginId: string, jobId: string, handlers: SseHandlers, stage?: string): JobWatch {
  // stage names which of the job's runs to read: parts and pattern run as
  // independent slots server-side, so omitting it only works for the
  // create-a-job routes, which never have a second stage running alongside.
  const stageQuery = stage ? `&stage=${encodeURIComponent(stage)}` : ""
  let after = 0
  let closed = false
  let failures = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  const close = () => {
    closed = true
    if (timer) clearTimeout(timer)
  }

  // true = the run is over and nothing more will come
  const dispatch = (raw: string): boolean => {
    let parsed: any = null
    try {
      parsed = JSON.parse(raw)
    } catch {
      // not JSON -> a raw subprocess log line
    }
    if (parsed && parsed.event === "stage_progress") {
      handlers.onProgress?.(parsed)
    } else if (parsed && parsed.event === "stage_done") {
      handlers.onStageDone?.(parsed)
    } else if (parsed && parsed.event === "error") {
      handlers.onError?.(parsed.message)
      return true
    } else if (parsed && parsed.event === "cancelled") {
      handlers.onCancelled?.()
      return true
    } else if (parsed && parsed.event === "done") {
      handlers.onDone?.()
      return true
    } else {
      handlers.onLine?.(raw)
    }
    return false
  }

  const poll = async () => {
    if (closed) return
    try {
      const res = await apiCall(`${jobsBase(pluginId)}/${jobId}/run?after=${after}${stageQuery}`)
      if (closed) return
      if (res.status === 404) {
        handlers.onError?.("this job has no run to follow")
        close()
        return
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data: { status: string; total: number; events: string[]; error?: string | null } = await res.json()
      failures = 0
      after = data.total
      for (const ev of data.events || []) {
        if (closed) return
        if (dispatch(ev)) {
          close()
          return
        }
      }
      // Finished without a terminal event left in the kept window: still end it.
      if (data.status === "error") { handlers.onError?.(data.error || "the job failed"); close(); return }
      if (data.status === "cancelled") { handlers.onCancelled?.(); close(); return }
      if (data.status === "done") { handlers.onDone?.(); close(); return }
    } catch {
      // A dropped request (network hiccup, a server restarting) is retried; only
      // a run of failures gives up, so the caller's spinner can't hang forever.
      if (++failures >= POLL_MAX_FAILURES) {
        handlers.onError?.("lost connection to the server")
        close()
        return
      }
    }
    if (!closed) timer = setTimeout(poll, POLL_MS)
  }

  void poll()
  return { close }
}

// ---------------- url helpers ----------------

// Job/output URLs from the backend are absolute PATHS on the API host
// (e.g. "/api/v1/plugins/techpack/jobs/<id>/file/flat_sketch.png"), not full
// URLs. The plugin frontend runs in its own document (a different origin
// than the API host in local dev), so every one of those has to be resolved
// against getBaseUrl() before it can be used as an <img src>, fetch target,
// download href, etc.
export function resolveUrl(u: string | null | undefined): string | null {
  if (!u) return null
  if (/^https?:\/\//i.test(u)) return u
  return `${getBaseUrl()}${withPreviewQuery(rewritePrefix(u))}`
}

// pattern-pages.pdf and parts.svg (+ its part PNGs) are overwritten in place
// on every (re)trace, so their URL never changes and the browser happily
// serves a stale cached copy. Cache-bust with the job's mtime.
/** A backend asset next to a job file: `.../jobs/<id>/file/x?v=..&preview_token=..`
 *  -> `.../assets/<path>?preview_token=..`. Keeps the query (a hosted preview
 *  authorises every request with its token; without it the asset is refused and
 *  the 3D try-on fell back to its stand-in body), drops the job's cache-bust. */
export function assetUrlFrom(jobFileUrl: string, assetPath: string): string {
  const u = new URL(jobFileUrl, window.location.href)
  u.pathname = u.pathname.replace(/\/jobs\/.*$/, `/assets/${assetPath}`)
  u.searchParams.delete("v")
  return u.href
}

export function withCacheBust(url: string | null, mtime: number | null | undefined): string | null {
  if (!url) return null
  const v = Math.round((mtime || 0) * 1000)
  return `${url}${url.includes("?") ? "&" : "?"}v=${v}`
}

// job_file serves the same URL inline (for <object>/<img> embeds) by default.
// An <a download> link needs the backend to send Content-Disposition:
// attachment instead, or Chrome ignores the download attribute cross-origin
// and navigates to the file — append dl=1 to opt into that.
export function downloadUrl(url: string | null): string | null {
  if (!url) return null
  return `${url}${url.includes("?") ? "&" : "?"}dl=1`
}

// pltt dev's local simulator runs its CORS config wildcard-open
// (allow_origins="*" + allow_credentials=False in backend_runner.py) and
// DevPluginContextMiddleware fakes an authenticated user on every request
// regardless, so no cookie is needed — and a credentialed fetch against a
// wildcard origin is one browsers refuse outright. The real hosted backend
// (apps-api.pltt.xyz) is a different subdomain than the app frontend
// (apps.pltt.xyz) and gates every non-/health route behind an actual
// session cookie, which `fetch` only attaches cross-origin when told to.
// Toggle on the resolved backend origin so the same call sites work in both.
function credentialsMode(): RequestCredentials {
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(getBaseUrl()) ? "omit" : "include"
}

// A plain `<img src>`/`new Image()` never sends credentials cross-origin
// unless told to — unlike `fetch`, there's no per-call opt-in, only the
// element's `crossOrigin` attribute. Every gallery thumbnail, sketch, and
// part image is served from a permission-gated route (only /health is
// public), so on staging/production (cross-origin backend, real session
// cookie) these need `crossOrigin="use-credentials"` or they 401 exactly
// like an unauthenticated fetch would. Local dev's wildcard CORS can't
// combine with credentialed image requests either, so this mirrors
// credentialsMode() exactly.
export function imgCrossOrigin(): "use-credentials" | undefined {
  return credentialsMode() === "include" ? "use-credentials" : undefined
}

// NOTE: intentionally no preview-query suffix here — every call site below
// appends more path (`/analyze`, `/jobs/generate`, ...) after `base()`, and a
// query string has to be last. Those call sites wrap their full URL in
// withPreviewQuery() themselves instead.
function base(pluginId: string) {
  const prefix = resolvedPrefix ?? `/api/v1/plugins/${pluginId}`
  return `${getBaseUrl()}${prefix}`
}

function jobsBase(pluginId: string) {
  return resolvedPrefix ? `${resolvedPrefix}/jobs` : `/api/v1/plugins/${pluginId}/jobs`
}

// A real hosted session (staging/production) is a short-lived cookie, and a
// job can take minutes across several stages (analyze -> generate -> stage2
// -> stage4/5 -> measure -> parts polling), so a request issued late in that
// flow can easily 401 on an access token that was still fresh when the job
// started. The SDK's own `apiFetch` handles exactly this by retrying once
// through `POST /api/v1/auth/refresh` (see node_modules/@palettelab/sdk's
// dist) -- this file can't use that helper directly (it hardcodes a JSON
// content-type that breaks multipart, and `credentials: "include"` that
// breaks pltt dev's wildcard-CORS simulator), so it mirrors just the
// refresh-and-retry behavior here instead. Preview auth is a `preview_token`
// query param, not a cookie session, so there's nothing to refresh there.
function canRefreshSession(): boolean {
  return credentialsMode() === "include" && !resolvedPrefix
}

let refreshInFlight: Promise<boolean> | null = null

async function tryRefreshSession(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = fetch(`${getBaseUrl()}/api/v1/auth/refresh`, { method: "POST", credentials: "include" })
      .then((res) => res.ok)
      .catch(() => false)
      .finally(() => {
        refreshInFlight = null
      })
  }
  return refreshInFlight
}

// Every real network call in this file should go through this instead of a
// bare `fetch` so a mid-session cookie expiry gets one silent retry instead
// of surfacing as a bare 401 to the user.
async function fetchWithRefresh(url: string, init: RequestInit): Promise<Response> {
  const res = await fetch(url, init)
  if (res.status !== 401 || !canRefreshSession()) return res
  const refreshed = await tryRefreshSession()
  return refreshed ? fetch(url, init) : res
}

// The SDK's own `apiFetch` unconditionally sends `credentials: "include"`
// (hardcoded inside the SDK, not overridable via init), which breaks under
// pltt dev's local simulator (see `credentialsMode` above) — so every call
// here goes through plain `fetch` with credentials toggled per-environment
// instead.
async function apiCall(path: string, init?: RequestInit): Promise<Response> {
  return fetchWithRefresh(`${getBaseUrl()}${withPreviewQuery(path)}`, { ...init, credentials: credentialsMode() })
}

// ---------------- REST calls ----------------

/** Is the high-quality (Blender) garment simulation available on this server? */
export async function simulateAvailable(pluginId: string): Promise<boolean> {
  try {
    const res = await fetchWithRefresh(withPreviewQuery(`${base(pluginId)}/simulate/available`), { credentials: credentialsMode() })
    return res.ok && !!(await res.json()).available
  } catch {
    return false
  }
}

/** Queue a Blender simulation of the assembled garment (progress: watchJob(..., "simulate")). */
export async function startBlenderSim(pluginId: string, jobId: string, payload: unknown): Promise<{ status?: string; error?: string }> {
  const fd = new FormData()
  fd.append("payload", new Blob([JSON.stringify(payload)], { type: "application/json" }), "garment-sim-input.json")
  try {
    const res = await fetchWithRefresh(withPreviewQuery(`${jobsBase(pluginId)}/${jobId}/simulate`), {
      method: "POST", body: fd, credentials: credentialsMode(),
    })
    return await res.json()
  } catch (err: any) {
    return { error: err?.message || String(err) }
  }
}

/** Upload an image of sewing-pattern pieces: segmented + classified into a new job. */
export async function uploadPatternImage(
  pluginId: string, file: File, longestCm: number, size: string,
): Promise<{ job_id?: string; error?: string }> {
  const fd = new FormData()
  fd.append("image", file, file.name || "pattern.png")
  fd.append("longest_cm", String(longestCm))
  fd.append("size", size)
  try {
    const res = await fetchWithRefresh(withPreviewQuery(`${base(pluginId)}/jobs/pattern-image`), {
      method: "POST", body: fd, credentials: credentialsMode(),
    })
    return await res.json()
  } catch (err: any) {
    return { error: err?.message || String(err) }
  }
}

export async function analyzeImage(pluginId: string, file: File): Promise<AnalyzeResponse> {
  const fd = new FormData()
  fd.append("image", file, file.name || "upload.png")
  try {
    const res = await fetchWithRefresh(withPreviewQuery(`${base(pluginId)}/analyze`), {
      method: "POST",
      body: fd,
      credentials: credentialsMode(),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.error) return { unavailable: data.error || "analysis failed" }
    return data as AnalyzeResult
  } catch (err: any) {
    return { unavailable: err?.message || String(err) }
  }
}

export interface GenerateParams {
  photo: File
  references: File[]
  prompt: string
  measurements: Record<string, number> | null
  mode: "sketch" | "both"
  variants?: number
  colors?: string[]
  season?: string
  fabric?: string
}

export async function generateJob(
  pluginId: string,
  params: GenerateParams,
): Promise<{ job_id: string } | { error: string }> {
  const fd = new FormData()
  fd.append("photo", params.photo, params.photo.name)
  params.references.forEach((f) => fd.append("references", f))
  if (params.prompt) fd.append("prompt", params.prompt)
  if (params.measurements && Object.keys(params.measurements).length) {
    fd.append("measurements", JSON.stringify(params.measurements))
  }
  fd.append("mode", params.mode)
  if (params.mode === "sketch") {
    fd.append("variants", String(params.variants ?? 2))
  } else {
    if (params.colors) params.colors.forEach((c) => fd.append("colors", c))
    if (params.season) fd.append("season", params.season)
    if (params.fabric) fd.append("fabric", params.fabric)
  }
  // One id per Generate click, sent on the retry too: the gateway can answer
  // 502/503/504 after the server already created the job, and the backend
  // returns that same job for a repeated id instead of making a second one.
  const requestId = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, "0")).join("")
  fd.append("request_id", requestId)
  // A 502/503/504 without a JSON body is the platform's gateway answering for an
  // app that is restarting (right after a new version goes live): try once more
  // after a moment instead of failing the upload with a bare "request failed".
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetchWithRefresh(withPreviewQuery(`${base(pluginId)}/jobs/generate`), {
        method: "POST",
        body: fd,
        credentials: credentialsMode(),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok && !data.error) return data
      if (!data.error && [502, 503, 504].includes(res.status) && attempt === 0) {
        await new Promise((r) => setTimeout(r, 4000))
        continue
      }
      return {
        error: data.error || (res.status >= 500
          ? `The server is unavailable right now (HTTP ${res.status}). Please try again in a moment.`
          : `Upload failed (HTTP ${res.status}).`),
      }
    } catch (err: any) {
      return { error: err?.message || String(err) }
    }
  }
}

export async function listJobs(pluginId: string): Promise<Job[]> {
  try {
    const res = await apiCall(`${jobsBase(pluginId)}/list`)
    const data = await res.json()
    return data.jobs || []
  } catch {
    // Network hiccup or a host that hasn't wired the API base yet — degrade
    // to an empty dashboard rather than crashing the mount effect.
    return []
  }
}

export async function deleteJobApi(pluginId: string, jobId: string): Promise<void> {
  await apiCall(`${jobsBase(pluginId)}/${jobId}`, { method: "DELETE" })
}

export async function listMembers(
  pluginId: string,
  platform?: PlatformContext,
): Promise<{ available: boolean; members: OrgMember[] }> {
  try {
    // jobsBase() minus its trailing "/jobs": apiCall wants a path, not base()'s full URL
    const res = await apiCall(`${jobsBase(pluginId).slice(0, -"/jobs".length)}/members`)
    if (res.ok) {
      const data = await res.json()
      if (data.available) return data
    }
  } catch {
    // fall through to the platform's own member list
  }
  // The backend's member service isn't there (pltt dev, or a runtime without it):
  // ask the platform directly -- same organisation, same members:read grant.
  if (!canReadMembers(platform)) return { available: false, members: [] }
  try {
    const raw = await createPaletteClient(platform).organization.listMembers()
    const me = platform?.user?.id != null ? String(platform.user.id) : null
    const members = (raw || [])
      .filter((m) => m && m.is_active !== false && String(m.id) !== me)
      .map((m) => ({ id: String(m.id), name: m.name || null, email: m.email || null, role: m.role || null }))
    return { available: true, members }
  } catch {
    return { available: false, members: [] }
  }
}

// SDK hasPermission() is false when the context carries no permission list at
// all, so only a list that is there and lacks members:read counts as a "no".
function canReadMembers(platform?: PlatformContext): boolean {
  return !platform?.permissions || hasPermission(platform, "members:read")
}

/** One org member by email (SDK organization.getMemberByEmail), or null when
 *  nobody in this organisation has that address or the lookup isn't available. */
export async function findMemberByEmail(email: string, platform?: PlatformContext): Promise<OrgMember | null> {
  if (!canReadMembers(platform)) return null
  try {
    const m = await createPaletteClient(platform).organization.getMemberByEmail(email)
    if (!m || m.is_active === false) return null
    return { id: String(m.id), name: m.name || null, email: m.email || null, role: m.role || null }
  } catch {
    return null
  }
}

export async function getShare(pluginId: string, jobId: string): Promise<JobShare | null> {
  try {
    const res = await apiCall(`${jobsBase(pluginId)}/${jobId}/share`)
    return res.ok ? await res.json() : null
  } catch {
    return null
  }
}

export async function setShare(pluginId: string, jobId: string, share: JobShare): Promise<{ error?: string }> {
  try {
    const res = await apiCall(`${jobsBase(pluginId)}/${jobId}/share`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(share),
    })
    if (res.ok) return {}
    const data = await res.json().catch(() => ({}))
    return { error: data.error || data.detail || `HTTP ${res.status}` }
  } catch (err: any) {
    return { error: err?.message || String(err) }
  }
}

export async function cancelJobApi(pluginId: string, jobId: string, stage?: string): Promise<void> {
  const query = stage ? `?stage=${encodeURIComponent(stage)}` : ""
  try {
    await apiCall(`${jobsBase(pluginId)}/${jobId}/cancel${query}`, { method: "POST" })
  } catch {
    // best-effort — the subprocess may already have exited
  }
}

export async function startStage4(pluginId: string, jobId: string): Promise<{ ok?: boolean; error?: string; generating?: boolean }> {
  try {
    const res = await apiCall(`${jobsBase(pluginId)}/${jobId}/stage4`, { method: "POST" })
    return await res.json()
  } catch (err: any) {
    return { error: err?.message || String(err) }
  }
}

// Size + measurement overrides from the pattern tab's editor; omitted for a plain
// (auto) draft, which then keeps whatever the job was created with.
export interface PatternParams {
  size: string
  measurements: Record<string, number>
}

/** Real 3D garment for the try-on (backend garment3d.py): the sketch made
 *  photoreal and reconstructed by three.ws. Watch with stage "garment3d". */
/** `region` "upper" shoots the garment in a T-pose (the try-on raises the arms to it). */
export async function startGarment3D(pluginId: string, jobId: string, colour: string, desc: string, region: "upper" | "lower" = "upper"): Promise<{ ok?: boolean; error?: string }> {
  const body = new FormData()
  body.append("colour", colour)
  body.append("desc", desc)
  body.append("region", region)
  try {
    const res = await apiCall(`${jobsBase(pluginId)}/${jobId}/garment3d`, { method: "POST", body })
    return await res.json()
  } catch (err: any) {
    return { error: err?.message || String(err) }
  }
}

export async function startStage5(
  pluginId: string,
  jobId: string,
  params?: PatternParams,
): Promise<{ ok?: boolean; error?: string; generating?: boolean }> {
  let body: FormData | undefined
  if (params) {
    body = new FormData()
    body.append("size", params.size)
    body.append("measurements", JSON.stringify(params.measurements))
  }
  try {
    const res = await apiCall(`${jobsBase(pluginId)}/${jobId}/stage5`, { method: "POST", body })
    return await res.json()
  } catch (err: any) {
    return { error: err?.message || String(err) }
  }
}

/** Copies the job's pattern PDF and 3D garment into the org's "Techpack" Data
 *  Room (backend save_to_dataroom). Best effort: never throws. */
export async function saveToDataRoom(pluginId: string, jobId: string): Promise<void> {
  try {
    const res = await apiCall(`${jobsBase(pluginId)}/${jobId}/save-to-dataroom`, { method: "POST" })
    const out = await res.json()
    if (out?.skipped || out?.error) console.info("[techpack] Data Room copy skipped:", out.reason || out.error)
  } catch (err) {
    console.info("[techpack] Data Room copy skipped:", err)
  }
}

export async function startMeasure(
  pluginId: string,
  jobId: string,
  size: string,
): Promise<{ ok?: boolean; error?: string }> {
  const fd = new FormData()
  fd.append("size", size)
  try {
    const res = await fetchWithRefresh(withPreviewQuery(`${base(pluginId)}/jobs/${jobId}/measure`), {
      method: "POST",
      body: fd,
      credentials: credentialsMode(),
    })
    return await res.json()
  } catch (err: any) {
    return { error: err?.message || String(err) }
  }
}

export async function getParts(pluginId: string, jobId: string, bust?: number): Promise<PartsResponse | null> {
  try {
    const qs = bust ? `?v=${bust}` : ""
    const res = await apiCall(`${jobsBase(pluginId)}/${jobId}/parts${qs}`)
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

// Fetch a backend-hosted JSON file (pattern-design.json, measurements.json)
// given its resolved absolute URL.
// Job files are rewritten in place by redrafts while their ?v= stays the job's
// sketch time, so always revalidate (a 304 when unchanged) -- never trust a
// copy the browser cached on its own before the server sent Cache-Control.
export async function fetchJson<T>(absUrl: string): Promise<T | null> {
  try {
    const res = await fetchWithRefresh(absUrl, { credentials: credentialsMode(), cache: "no-cache" })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

// Fetch a backend-hosted binary file (pattern-pages.pdf) as raw bytes. Used
// instead of handing pdf.js a bare URL: pdf.js does its own internal fetch
// with no credentials/refresh awareness, so a cross-origin session cookie
// (staging/production) never gets attached to it and every load 401s
// regardless of the auth handling everywhere else in this file.
export async function fetchBinary(absUrl: string): Promise<ArrayBuffer> {
  const res = await fetchWithRefresh(absUrl, { credentials: credentialsMode(), cache: "no-cache" })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.arrayBuffer()
}

// Fetch an arbitrary (possibly cross-origin) URL back as a File, used when a
// gallery thumbnail is dropped onto the sidebar dropzone.
export async function fetchAsFile(absUrl: string): Promise<File> {
  const res = await fetch(absUrl)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const blob = await res.blob()
  if (!blob.type.startsWith("image/")) throw new Error("not an image")
  const name = absUrl.split("/").pop()?.split("?")[0] || "dropped.png"
  return new File([blob], name, { type: blob.type })
}

// ---------------- progress heuristics (single-stage runs) ----------------
// A single-script stage (parts SVG, sewing pattern, measure) is ONE backend
// step, so `stage_progress` fires once at 0% and never moves again. Progress
// for those is read off milestones the underlying script already prints on
// stdout — real events in the run, never a timer, so the bar only advances
// when the pipeline actually reaches that point and never goes backwards.
type Kind = "parts" | "pattern" | "measure"

const STAGE_MILESTONES: Record<Kind, [RegExp, number][]> = {
  parts: [
    [/\binput ok:/, 4],
    [/\bink threshold:/, 12],
    [/\d+ regions ->/, 22],
    [/\bgarment:/, 42],
    [/groups\.json/, 52],
    [/relationship graph:/, 60],
    [/wrote .*\.svg \(\d+ layers/, 90],
    [/part images ->/, 96],
    [/\bDone: .*\.svg/, 99],
  ],
  pattern: [
    [/\bPieces:/, 55],
    [/\bSize:/, 80],
    [/\bSaved: /, 90],
    [/one page per part/, 97],
  ],
  measure: [[/\bdetected:/, 90], [/not a garment/, 90]],
}

export function isUpscaleWarningLine(line: string): { exhausted: boolean } | null {
  if (!/upscale warning/i.test(line)) return null
  return { exhausted: /exhausted balance|user is locked/i.test(line) }
}

// Returns a stateful line-consumer: feed it every raw log line, it calls
// `setPercent` with a monotonically increasing 0-99 estimate.
export function makeLogProgress(setPercent: (pct: number) => void, kind: Kind) {
  const milestones = STAGE_MILESTONES[kind] || []
  let best = 0
  let regions = 0
  let layers = 0
  const TRACE_LO = 60
  const TRACE_HI = 88
  const set = (pct: number) => {
    const p = Math.min(99, Math.max(best, Math.round(pct)))
    if (p !== best) {
      best = p
      setPercent(p)
    }
  }
  return (line: string) => {
    const m = line.match(/(\d+) regions ->/)
    if (m) regions = parseInt(m[1], 10)
    if (/\]\s+\d+ paths/.test(line) && regions > 0) {
      layers++
      set(TRACE_LO + Math.min(1, layers / regions) * (TRACE_HI - TRACE_LO))
    }
    for (const [re, pct] of milestones) if (re.test(line)) set(pct)
  }
}
