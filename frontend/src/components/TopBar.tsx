import { useEffect, useRef, useState } from "react"
import { usePlatform, usePluginTranslations } from "@palettelab/sdk"
import { STRINGS } from "../strings"

// pltt dev's local simulator always serves the frontend on localhost, and a
// real Palette OS install never does -- so this is a reliable dev-only gate
// without any build-time env plumbing. Only the org/role debug text is gated;
// the theme and language controls call real platform APIs and belong in the
// shipped UI.
function isLocalDev(): boolean {
  const h = window.location.hostname
  return h === "localhost" || h === "127.0.0.1"
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return "?"
  const first = parts[0][0]
  const last = parts.length > 1 ? parts[parts.length - 1][0] : ""
  return (first + last).toUpperCase()
}

// The shell header: global search on the left, platform controls on the right.
// Search is a controlled input owned by App so this bar and the dashboard's own
// field filter the same list rather than competing.
export default function TopBar({
  search,
  onSearchChange,
  onDeleteAll,
}: {
  search: string
  onSearchChange: (value: string) => void
  onDeleteAll: () => void
}) {
  const platform = usePlatform()
  const { t } = usePluginTranslations(STRINGS)
  const { user, organizationId, orgRole, colorMode, setColorMode, language, setLanguage, supportedLanguages } =
    platform
  const languages = supportedLanguages && supportedLanguages.length ? supportedLanguages : [language]
  const name = user?.name || user?.email || t("platformBar.unknownUser")

  const searchRef = useRef<HTMLInputElement | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)

  // Cmd/Ctrl-K is the shortcut the placeholder advertises, so it has to work.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key.toLowerCase() !== "k" || !(e.metaKey || e.ctrlKey)) return
      e.preventDefault()
      searchRef.current?.focus()
      searchRef.current?.select()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  // Same pattern as the gallery card menu: a document listener that ignores
  // clicks originating inside the menu, rather than relying on
  // stopPropagation to keep the opening click from immediately closing it.
  useEffect(() => {
    if (!menuOpen) return
    function close(e: MouseEvent) {
      if ((e.target as HTMLElement | null)?.closest(".topbar-account")) return
      setMenuOpen(false)
    }
    document.addEventListener("click", close)
    return () => document.removeEventListener("click", close)
  }, [menuOpen])

  function nextLanguage() {
    const i = languages.indexOf(language)
    setLanguage(languages[(i + 1) % languages.length])
  }

  const dark = colorMode === "dark"

  return (
    <header className="topbar">
      <div className="topbar-search">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <line x1="20" y1="20" x2="16.65" y2="16.65" />
        </svg>
        <input
          ref={searchRef}
          type="search"
          placeholder={t("topBar.searchPlaceholder")}
          aria-label={t("topBar.searchAria")}
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
        />
        <kbd className="topbar-kbd">{t("topBar.searchShortcut")}</kbd>
      </div>

      <div className="topbar-tools">
        <svg className="topbar-sun" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />
        </svg>
        <button
          type="button"
          className={`topbar-switch${dark ? " is-on" : ""}`}
          role="switch"
          aria-checked={dark}
          aria-label={t("topBar.themeAria")}
          title={dark ? t("platformBar.dark") : t("platformBar.light")}
          onClick={() => setColorMode(dark ? "light" : "dark")}
        >
          <span className="topbar-switch-knob" />
        </button>

        {languages.length > 1 && (
          <button type="button" className="topbar-pill" aria-label={t("topBar.languageAria")} onClick={nextLanguage}>
            {language}
          </button>
        )}

        <div className="topbar-account">
          <button
            type="button"
            className="topbar-account-btn"
            aria-haspopup="true"
            aria-expanded={menuOpen}
            aria-label={t("topBar.accountAria")}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <span className="topbar-avatar" aria-hidden="true">
              {initials(name)}
            </span>
            <span className="topbar-account-name">{name}</span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
          {menuOpen && (
            <div className="tp-menu topbar-menu" role="menu">
              {isLocalDev() && organizationId != null && (
                <div className="topbar-menu-meta">
                  org #{organizationId}
                  {orgRole ? ` (${orgRole})` : ""}
                </div>
              )}
              <button
                type="button"
                role="menuitem"
                className="topbar-menu-item is-danger"
                onClick={() => {
                  setMenuOpen(false)
                  onDeleteAll()
                }}
              >
                {t("app.deleteAll")}
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}
