import { useEffect, useState } from "react";
import {
  loadSettings,
  getActiveWorkspace,
  getHeproSettings,
  saveHeproSettings,
} from "../storage/jsonStorage.js";

export default function SettingsPage({ onBack }) {
  const [baseUrl, setBaseUrl] = useState("https://hepro.skyresponse.com");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [reportId, setReportId] = useState("9");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState(null);

  useEffect(() => {
    async function loadHeproSettings() {
      setIsLoading(true);
      try {
        const settings = await loadSettings();
        const workspace = getActiveWorkspace(settings);
        const hepro = getHeproSettings(workspace);
        setBaseUrl(hepro.baseUrl);
        setUsername(hepro.username);
        setPassword(hepro.password);
        setReportId(String(hepro.reportId));
      } catch (error) {
        console.error("Feil ved lasting av innstillinger:", error);
      } finally {
        setIsLoading(false);
      }
    }
    loadHeproSettings();
  }, []);

  const handleSave = async () => {
    setIsSaving(true);
    setSaveStatus(null);
    try {
      const success = await saveHeproSettings({
        baseUrl: baseUrl.trim() || "https://hepro.skyresponse.com",
        username: username.trim(),
        password: password,
        reportId: parseInt(reportId, 10) || 9,
      });
      if (success) {
        setSaveStatus({ type: "success", message: "Innstillinger lagret" });
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
            Python-importskriptene leser disse innstillingene for a autentisere mot Hepro API.
          </p>
        </div>
      </div>
    </div>
  );
}
