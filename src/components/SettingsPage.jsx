import { useEffect, useState } from "react";
import {
  loadSettings,
  getActiveWorkspace,
  getHeproSettings,
  saveHeproSettings,
  getSyncInterval,
  saveSyncInterval,
  getProxySettings,
  saveProxySettings,
} from "../storage/jsonStorage.js";

export default function SettingsPage({ onBack, onSyncIntervalChange }) {
  const [baseUrl, setBaseUrl] = useState("https://hepro.skyresponse.com");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [reportId, setReportId] = useState("9");
  const [syncInterval, setSyncInterval] = useState("20");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState(null);

  // Proxy settings for Helsenett/enterprise networks
  const [proxyUrl, setProxyUrl] = useState("");
  const [proxyUsername, setProxyUsername] = useState("");
  const [proxyPassword, setProxyPassword] = useState("");
  const [useSystemProxy, setUseSystemProxy] = useState(true);
  const [acceptInvalidCerts, setAcceptInvalidCerts] = useState(false);
  const [showProxySettings, setShowProxySettings] = useState(false);

  useEffect(() => {
    async function loadAllSettings() {
      setIsLoading(true);
      try {
        const settings = await loadSettings();
        const workspace = getActiveWorkspace(settings);
        const hepro = getHeproSettings(workspace);
        const proxy = getProxySettings(workspace);

        setBaseUrl(hepro.baseUrl);
        setUsername(hepro.username);
        setPassword(hepro.password);
        setReportId(String(hepro.reportId));
        setSyncInterval(String(getSyncInterval(workspace)));

        // Load proxy settings
        setProxyUrl(proxy.url);
        setProxyUsername(proxy.username);
        setProxyPassword(proxy.password);
        setUseSystemProxy(proxy.useSystemProxy);
        setAcceptInvalidCerts(proxy.acceptInvalidCerts);

        // Show proxy settings if any are configured
        if (proxy.url || !proxy.useSystemProxy || proxy.acceptInvalidCerts) {
          setShowProxySettings(true);
        }
      } catch (error) {
        console.error("Feil ved lasting av innstillinger:", error);
      } finally {
        setIsLoading(false);
      }
    }
    loadAllSettings();
  }, []);

  const handleSave = async () => {
    setIsSaving(true);
    setSaveStatus(null);
    try {
      const heproSuccess = await saveHeproSettings({
        baseUrl: baseUrl.trim() || "https://hepro.skyresponse.com",
        username: username.trim(),
        password: password,
        reportId: parseInt(reportId, 10) || 9,
      });

      const proxySuccess = await saveProxySettings({
        url: proxyUrl.trim(),
        username: proxyUsername.trim(),
        password: proxyPassword,
        useSystemProxy,
        acceptInvalidCerts,
      });

      const intervalMinutes = parseInt(syncInterval, 10) || 20;
      const intervalSuccess = await saveSyncInterval(intervalMinutes);

      if (heproSuccess && intervalSuccess && proxySuccess) {
        setSaveStatus({ type: "success", message: "Innstillinger lagret" });
        if (onSyncIntervalChange) {
          onSyncIntervalChange(intervalMinutes);
        }
      } else {
        setSaveStatus({ type: "error", message: "Kunne ikke lagre innstillinger" });
      }
    } catch (error) {
      setSaveStatus({ type: "error", message: `Feil: ${error.message}` });
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-2xl font-semibold text-white">Innstillinger</div>
            <div className="mt-1 text-sm text-zinc-400">Hepro API-konfigurasjon</div>
          </div>
        </div>
        <div className="rounded-2xl border border-dashed border-zinc-700 bg-zinc-950/40 px-4 py-10 text-center text-sm text-zinc-400">
          Laster innstillinger...
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-2xl font-semibold text-white">Innstillinger</div>
          <div className="mt-1 text-sm text-zinc-400">
            Konfigurer tilkobling til Hepro/Skyresponse API
          </div>
        </div>
        {typeof onBack === "function" && (
          <button
            type="button"
            onClick={onBack}
            className="rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-2 text-zinc-200 transition hover:bg-zinc-800"
          >
            Tilbake
          </button>
        )}
      </div>

      <div className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5 md:p-6">
        <div className="text-lg font-semibold text-white">Hepro API</div>
        <div className="mt-1 text-sm text-zinc-400">
          Innstillinger for import av trygghetsalarmer fra Hepro/Skyresponse
        </div>

        <div className="mt-6 grid gap-5 md:grid-cols-2">
          <div className="md:col-span-2">
            <label className="block text-sm font-medium text-zinc-200">
              API-adresse (Base URL)
            </label>
            <input
              type="url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://hepro.skyresponse.com"
              className="mt-2 w-full rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-3 text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-amber-500/60"
            />
            <div className="mt-1 text-xs text-zinc-500">
              Standard: https://hepro.skyresponse.com
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-zinc-200">
              Brukernavn
            </label>
            <input
              type="email"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="bruker@eksempel.no"
              autoComplete="username"
              className="mt-2 w-full rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-3 text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-amber-500/60"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-zinc-200">
              Passord
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="********"
              autoComplete="current-password"
              className="mt-2 w-full rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-3 text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-amber-500/60"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-zinc-200">
              Rapport-ID
            </label>
            <input
              type="number"
              value={reportId}
              onChange={(e) => setReportId(e.target.value)}
              placeholder="9"
              min="1"
              className="mt-2 w-full rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-3 text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-amber-500/60"
            />
            <div className="mt-1 text-xs text-zinc-500">
              Standard rapport-ID for Hepro er 9
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-zinc-200">
              Auto-sync intervall (minutter)
            </label>
            <input
              type="number"
              value={syncInterval}
              onChange={(e) => setSyncInterval(e.target.value)}
              placeholder="20"
              min="1"
              max="1440"
              className="mt-2 w-full rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-3 text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-amber-500/60"
            />
            <div className="mt-1 text-xs text-zinc-500">
              Hvor ofte appen synkroniserer med Hepro (standard: 20 min)
            </div>
          </div>
        </div>

        {/* Proxy Settings Section */}
        <div className="mt-6 border-t border-zinc-800 pt-6">
          <button
            type="button"
            onClick={() => setShowProxySettings(!showProxySettings)}
            className="flex w-full items-center justify-between text-left"
          >
            <div>
              <div className="text-lg font-semibold text-white">Nettverksinnstillinger</div>
              <div className="mt-1 text-sm text-zinc-400">
                For Helsenett og andre bedriftsnettverk med proxy/brannmur
              </div>
            </div>
            <svg
              className={`h-5 w-5 text-zinc-400 transition-transform ${showProxySettings ? "rotate-180" : ""}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          {showProxySettings && (
            <div className="mt-4 space-y-4">
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3">
                <div className="flex items-start gap-2">
                  <svg className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <div className="text-sm text-amber-200">
                    Hvis du er på Helsenett og får tilkoblingsfeil, aktiver "Godta SSL-inspeksjon" nedenfor. Dette er trygt innenfor Helsenett.
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  id="useSystemProxy"
                  checked={useSystemProxy}
                  onChange={(e) => setUseSystemProxy(e.target.checked)}
                  className="h-5 w-5 rounded border-zinc-600 bg-zinc-800 text-amber-500 focus:ring-amber-500/50"
                />
                <label htmlFor="useSystemProxy" className="text-sm text-zinc-200">
                  Bruk systemets proxy-innstillinger (anbefalt)
                </label>
              </div>

              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  id="acceptInvalidCerts"
                  checked={acceptInvalidCerts}
                  onChange={(e) => setAcceptInvalidCerts(e.target.checked)}
                  className="h-5 w-5 rounded border-zinc-600 bg-zinc-800 text-amber-500 focus:ring-amber-500/50"
                />
                <label htmlFor="acceptInvalidCerts" className="text-sm text-zinc-200">
                  Godta SSL-inspeksjon (for Helsenett med SSL-proxy)
                </label>
              </div>

              <div className="border-t border-zinc-800 pt-4">
                <div className="text-sm font-medium text-zinc-300">Manuell proxy (valgfritt)</div>
                <div className="mt-1 text-xs text-zinc-500">
                  La stå tomt for å bruke automatiske innstillinger
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-zinc-200">
                  Proxy-adresse
                </label>
                <input
                  type="url"
                  value={proxyUrl}
                  onChange={(e) => setProxyUrl(e.target.value)}
                  placeholder="http://proxy.helsenett.no:8080"
                  className="mt-2 w-full rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-3 text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-amber-500/60"
                />
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <label className="block text-sm font-medium text-zinc-200">
                    Proxy-brukernavn
                  </label>
                  <input
                    type="text"
                    value={proxyUsername}
                    onChange={(e) => setProxyUsername(e.target.value)}
                    placeholder="(valgfritt)"
                    autoComplete="off"
                    className="mt-2 w-full rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-3 text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-amber-500/60"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-zinc-200">
                    Proxy-passord
                  </label>
                  <input
                    type="password"
                    value={proxyPassword}
                    onChange={(e) => setProxyPassword(e.target.value)}
                    placeholder="(valgfritt)"
                    autoComplete="off"
                    className="mt-2 w-full rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-3 text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-amber-500/60"
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        {saveStatus && (
          <div
            className={`mt-5 rounded-xl border p-3 text-sm ${
              saveStatus.type === "success"
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
                : "border-rose-500/40 bg-rose-500/10 text-rose-200"
            }`}
          >
            {saveStatus.message}
          </div>
        )}

        <div className="mt-6 flex justify-end">
          <button
            type="button"
            onClick={handleSave}
            disabled={isSaving}
            className="rounded-xl bg-gradient-to-r from-amber-600 to-yellow-500 px-6 py-2.5 font-semibold text-white transition hover:from-amber-500 hover:to-yellow-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isSaving ? "Lagrer..." : "Lagre innstillinger"}
          </button>
        </div>
      </div>

      <div className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5 md:p-6">
        <div className="text-lg font-semibold text-white">Om innstillingene</div>
        <div className="mt-3 space-y-2 text-sm text-zinc-400">
          <p>
            Innstillingene lagres lokalt i <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">%APPDATA%\no.svein.assistio-trygghetsalarm\settings.json</code>
          </p>
          <p>
            Appen bruker native Windows TLS og leser sertifikater fra Windows Certificate Store.
          </p>
          <p className="text-amber-400/80">
            <strong>Helsenett:</strong> Hvis du er på Helsenett med SSL-inspeksjon, aktiver "Godta SSL-inspeksjon" under Nettverksinnstillinger.
          </p>
        </div>
      </div>
    </div>
  );
}
