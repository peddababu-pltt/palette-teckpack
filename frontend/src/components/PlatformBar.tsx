import { usePlatform, usePluginTranslations } from "@palettelab/sdk"
import { STRINGS } from "../strings"

// pltt dev's local simulator always serves the frontend on localhost, and a
// real Palette OS install never does -- so this is a reliable dev-only gate
// without any build-time env plumbing.
function isLocalDev(): boolean {
  const h = window.location.hostname
  return h === "localhost" || h === "127.0.0.1"
}

// Local-dev-only header widget: shows the signed-in user/org and lets you
// flip theme/language straight through the real Palette platform context
// (usePlatform()'s setColorMode/setLanguage), not a hardcoded mock.
export default function PlatformBar() {
  const platform = usePlatform()
  const { t } = usePluginTranslations(STRINGS)
  if (!isLocalDev()) return null

  const { user, organizationId, orgRole, colorMode, setColorMode, language, setLanguage, supportedLanguages } =
    platform
  const languages = supportedLanguages && supportedLanguages.length ? supportedLanguages : [language]

  function nextLanguage() {
    const i = languages.indexOf(language)
    setLanguage(languages[(i + 1) % languages.length])
  }

  return (
    <div className="platform-bar" title="Local dev only -- live Palette platform context">
      <span className="platform-bar-user">
        {user?.name || user?.email || t("platformBar.unknownUser")}
        {organizationId != null && (
          <>
            {" "}
            · org #{organizationId}
            {orgRole ? ` (${orgRole})` : ""}
          </>
        )}
      </span>
      <div className="toggle-group">
        <button type="button" className="toggle-btn" onClick={() => setColorMode(colorMode === "dark" ? "light" : "dark")}>
          {colorMode === "dark" ? t("platformBar.dark") : t("platformBar.light")}
        </button>
        {languages.length > 1 && (
          <button type="button" className="toggle-btn" onClick={nextLanguage}>
            {language}
          </button>
        )}
      </div>
    </div>
  )
}
