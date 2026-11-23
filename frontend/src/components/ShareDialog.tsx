// Owner-only sharing for one techpack: the whole organisation, chosen
// teammates, or both. A techpack is private to its creator until shared; the
// backend enforces that on every job route, this only edits the share list.
import { usePlatform, usePluginTranslations } from "@palettelab/sdk"
import { useEffect, useState } from "react"
import type { Job, OrgMember } from "../api"
import { findMemberByEmail, getShare, listMembers, setShare } from "../api"
import { STRINGS } from "../strings"

export default function ShareDialog({ pluginId, job, onClose, onSaved }: {
  pluginId: string
  job: Job
  onClose: () => void
  onSaved: () => void
}) {
  const { t } = usePluginTranslations(STRINGS)
  const platform = usePlatform()
  const [query, setQuery] = useState("")
  const [email, setEmail] = useState("")
  const [adding, setAdding] = useState(false)
  const [emailNote, setEmailNote] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [members, setMembers] = useState<OrgMember[]>([])
  const [membersAvailable, setMembersAvailable] = useState(true)
  const [org, setOrg] = useState(!!job.shared?.org)
  const [users, setUsers] = useState<Set<string>>(new Set(job.shared?.users || []))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      const [m, share] = await Promise.all([listMembers(pluginId, platform), getShare(pluginId, job.job_id)])
      if (!alive) return
      setMembers(m.members)
      setMembersAvailable(m.available)
      if (share) {
        setOrg(share.org)
        setUsers(new Set(share.users))
      }
      setLoading(false)
    })()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pluginId, job.job_id])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onClose() } }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  const q = query.trim().toLowerCase()
  const shown = q
    ? members.filter((m) => `${m.name || ""} ${m.email || ""}`.toLowerCase().includes(q))
    : members
  const picked = members.filter((m) => users.has(m.id)).length

  const toggle = (id: string) => setUsers((cur) => {
    const next = new Set(cur)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  // SDK organization.getMemberByEmail: add one teammate by typing their address
  const addByEmail = async () => {
    const address = email.trim()
    if (!address) return
    setEmailNote(null)
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
      setEmailNote(t("share.emailInvalid"))
      return
    }
    const known = members.find((m) => (m.email || "").toLowerCase() === address.toLowerCase())
    if (known) {
      setUsers((cur) => new Set(cur).add(known.id))
      setEmail("")
      return
    }
    setAdding(true)
    const found = await findMemberByEmail(address, platform)
    setAdding(false)
    if (!found || found.id === String(platform?.user?.id ?? "")) {
      setEmailNote(found ? t("share.emailSelf") : t("share.emailNotFound"))
      return
    }
    setMembers((cur) => (cur.some((m) => m.id === found.id) ? cur : [...cur, found]))
    setMembersAvailable(true)
    setUsers((cur) => new Set(cur).add(found.id))
    setEmail("")
  }

  const save = async () => {
    setSaving(true)
    setError(null)
    // Only ids still in the member list: someone who left the org is dropped
    // rather than failing the whole save.
    const known = new Set(members.map((m) => m.id))
    const res = await setShare(pluginId, job.job_id, {
      org,
      users: membersAvailable ? [...users].filter((u) => known.has(u)) : [],
    })
    setSaving(false)
    if (res.error) {
      setError(`${t("share.failed")}: ${res.error}`)
      return
    }
    const count = membersAvailable ? [...users].filter((u) => known.has(u)).length : 0
    platform?.showToast?.(
      org ? t("share.savedOrg") : count ? t("share.savedPeople", { count }) : t("share.savedPrivate"),
      "success",
    )
    onSaved()
  }

  return (
    <div className="tp-confirm-backdrop" onClick={onClose}>
      <div
        className="tp-confirm tp-share"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tp-share-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="tp-share-title">{t("share.title")}</h3>
        <p>{t("share.intro")}</p>
        <label className="tp-share-row tp-share-everyone">
          <input type="checkbox" checked={org} disabled={saving} onChange={(e) => setOrg(e.target.checked)} />
          <span>{t("share.everyone")}</span>
        </label>
        <div className="tp-share-people-label">
          {t("share.people")}
          {!org && picked > 0 && <span className="tp-share-count">{t("share.selected", { count: picked })}</span>}
        </div>
        {membersAvailable && members.length > 5 && (
          <input
            type="search"
            className="tp-share-search"
            placeholder={t("share.searchPlaceholder")}
            aria-label={t("share.searchPlaceholder")}
            value={query}
            disabled={saving}
            onChange={(e) => setQuery(e.target.value)}
          />
        )}
        {!org && (
          <form
            className="tp-share-add"
            onSubmit={(e) => {
              e.preventDefault()
              void addByEmail()
            }}
          >
            <input
              type="email"
              className="tp-share-search"
              placeholder={t("share.emailPlaceholder")}
              aria-label={t("share.emailPlaceholder")}
              value={email}
              disabled={saving || adding}
              onChange={(e) => {
                setEmail(e.target.value)
                setEmailNote(null)
              }}
            />
            <button type="submit" className="tp-modal-btn" disabled={saving || adding || !email.trim()}>
              {adding ? t("share.loading") : t("share.add")}
            </button>
          </form>
        )}
        {emailNote && <p className="tp-share-error" role="alert">{emailNote}</p>}
        <div className="tp-share-people">
          {loading ? (
            <span className="studio-note">{t("share.loading")}</span>
          ) : !membersAvailable ? (
            <span className="studio-note">{t("share.membersUnavailable")}</span>
          ) : members.length === 0 ? (
            <span className="studio-note">{t("share.noMembers")}</span>
          ) : shown.length === 0 ? (
            <span className="studio-note">{t("share.noMatch")}</span>
          ) : (
            shown.map((m) => (
              <label key={m.id} className="tp-share-row">
                <input
                  type="checkbox"
                  checked={org || users.has(m.id)}
                  disabled={saving || org}
                  onChange={() => toggle(m.id)}
                />
                <span className="tp-share-name">{m.name || m.email || m.id}</span>
                {m.role && m.role !== "member" && <span className="tp-share-role">{m.role}</span>}
                {m.name && m.email && <span className="tp-share-email">{m.email}</span>}
              </label>
            ))
          )}
        </div>
        {error && <p className="tp-share-error" role="alert">{error}</p>}
        <div className="tp-confirm-actions">
          <button type="button" className="tp-modal-btn" onClick={onClose} disabled={saving}>
            {t("share.cancel")}
          </button>
          <button type="button" className="tp-modal-btn tp-confirm-ok" onClick={() => void save()} disabled={saving || loading}>
            {saving ? t("share.saving") : t("share.save")}
          </button>
        </div>
      </div>
    </div>
  )
}
