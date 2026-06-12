import { useCallback, useEffect, useRef, useState } from "react";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import SafetyAlarmsPage from "./components/SafetyAlarmsPage.jsx";
import SettingsPage from "./components/SettingsPage.jsx";
import LicenseActivation from "./components/LicenseActivation.jsx";
import { checkLicense } from "./licensing/keygen.js";
import {
  loadSafetyAlarms,
  loadHeartbeats,
  saveSafetyAlarms,
  saveHeartbeats,
  getLastImportedAt,
  loadSettings,
  getActiveWorkspace,
  getSyncInterval,
} from "./storage/jsonStorage.js";

export default function App() {
  const [items, setItems] = useState([]);
  const [heartbeatItems, setHeartbeatItems] = useState([]);
  const [lastImportedAt, setLastImportedAt] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshStatus, setRefreshStatus] = useState(null);
  const [currentPage, setCurrentPage] = useState("alarms");
  const [updateAvailable, setUpdateAvailable] = useState(null);
  const [updateProgress, setUpdateProgress] = useState(null);
  const [licenseStatus, setLicenseStatus] = useState({ checking: true, valid: false });
  const [syncIntervalMinutes, setSyncIntervalMinutes] = useState(20);
  const [isSyncing, setIsSyncing] = useState(false);
  const didHydrateRef = useRef(false);
  const syncIntervalRef = useRef(null);

  // Sjekk lisens ved oppstart
  useEffect(() => {
    async function verifyLicense() {
      try {
        const result = await checkLicense();
        setLicenseStatus({
          checking: false,
          valid: result.valid,
          license: result.license,
          offline: result.offline,
          offlineDaysLeft: result.offlineDaysLeft,
        });
      } catch (error) {
        console.error("Lisensfeil:", error);
        setLicenseStatus({ checking: false, valid: false });
      }
    }
    verifyLicense();
  }, []);

  const handleLicenseActivated = (license) => {
    setLicenseStatus({ checking: false, valid: true, license });
  };

  useEffect(() => {
    async function checkForUpdates() {
      try {
        const update = await check();
        if (update) {
          setUpdateAvailable(update);
        }
      } catch (error) {
        console.log("Kunne ikke sjekke oppdateringer:", error);
      }
    }
    checkForUpdates();
  }, []);

  const handleInstallUpdate = useCallback(async () => {
    if (!updateAvailable) return;
    try {
      setUpdateProgress("Laster ned...");
      await updateAvailable.downloadAndInstall((event) => {
        if (event.event === "Started") {
          setUpdateProgress(`Laster ned... 0%`);
        } else if (event.event === "Progress") {
          const percent = Math.round((event.data.chunkLength / event.data.contentLength) * 100);
          setUpdateProgress(`Laster ned... ${percent}%`);
        } else if (event.event === "Finished") {
          setUpdateProgress("Installerer...");
        }
      });
      await relaunch();
    } catch (error) {
      console.error("Feil ved oppdatering:", error);
      setUpdateProgress(null);
    }
  }, [updateAvailable]);

  useEffect(() => {
    if (didHydrateRef.current) return;
    didHydrateRef.current = true;

    async function hydrate() {
      setIsLoading(true);
      try {
        const [alarms, heartbeats, importedAt] = await Promise.all([
          loadSafetyAlarms(),
          loadHeartbeats(),
          getLastImportedAt(),
        ]);
        setItems(alarms);
        setHeartbeatItems(heartbeats);
        setLastImportedAt(importedAt);
      } catch (error) {
        console.error("Feil ved lasting av data:", error);
        setRefreshStatus({
          lastStatus: "error",
          message: `Feil ved lasting: ${error.message}`,
        });
      } finally {
        setIsLoading(false);
      }
    }

    hydrate();
  }, []);

  const handleUpdateItem = useCallback(
    async (itemId, updates) => {
      const nextItems = items.map((item) =>
        item.id === itemId ? { ...item, ...updates } : item
      );
      setItems(nextItems);
      try {
        await saveSafetyAlarms(nextItems);
      } catch (error) {
        console.error("Feil ved lagring:", error);
      }
    },
    [items]
  );

  const doSync = useCallback(async (showFullLoading = true) => {
    if (showFullLoading) {
      setIsLoading(true);
      setRefreshStatus({ lastStatus: "loading", message: "Oppdaterer..." });
    }
    setIsSyncing(true);

    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const result = await invoke("run_safety_alarm_hepro_sync");

      if (result.success) {
        const [alarms, heartbeats, importedAt] = await Promise.all([
          loadSafetyAlarms(),
          loadHeartbeats(),
          getLastImportedAt(),
        ]);
        setItems(alarms);
        setHeartbeatItems(heartbeats);
        setLastImportedAt(importedAt);
        if (showFullLoading) {
          setRefreshStatus({
            lastStatus: "success",
            message: "Oppdatering fullført",
          });
        }
      } else if (showFullLoading) {
        setRefreshStatus({
          lastStatus: "error",
          message: result.stderr || "Ukjent feil ved oppdatering",
        });
      }
    } catch (error) {
      console.error("Feil ved Hepro-sync:", error);
      if (showFullLoading) {
        setRefreshStatus({
          lastStatus: "error",
          message: `Feil: ${error.message || error}`,
        });
      }
    } finally {
      setIsSyncing(false);
      if (showFullLoading) {
        setIsLoading(false);
      }
    }
  }, []);

  const handleRefresh = useCallback(() => {
    doSync(true);
  }, [doSync]);

  // Last sync-intervall fra innstillinger ved oppstart
  useEffect(() => {
    async function loadSyncSettings() {
      try {
        const settings = await loadSettings();
        const workspace = getActiveWorkspace(settings);
        const interval = getSyncInterval(workspace);
        setSyncIntervalMinutes(interval);
      } catch (error) {
        console.log("Kunne ikke laste sync-innstillinger:", error);
      }
    }
    loadSyncSettings();
  }, []);

  // Auto-sync mot Hepro
  useEffect(() => {
    if (!licenseStatus.valid) return;

    // Kjør sync ved oppstart
    doSync(false);

    // Sett opp intervall
    if (syncIntervalRef.current) {
      clearInterval(syncIntervalRef.current);
    }

    const intervalMs = syncIntervalMinutes * 60 * 1000;
    syncIntervalRef.current = setInterval(() => {
      doSync(false);
    }, intervalMs);

    return () => {
      if (syncIntervalRef.current) {
        clearInterval(syncIntervalRef.current);
      }
    };
  }, [licenseStatus.valid, syncIntervalMinutes, doSync]);

  const handleSyncIntervalChange = useCallback((minutes) => {
    setSyncIntervalMinutes(minutes);
  }, []);

  // Vis loading mens lisens sjekkes
  if (licenseStatus.checking) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
        <div className="text-zinc-400">Sjekker lisens...</div>
      </div>
    );
  }

  // Vis aktiveringsside hvis ingen gyldig lisens
  if (!licenseStatus.valid) {
    return <LicenseActivation onActivated={handleLicenseActivated} />;
  }

  return (
    <div className="min-h-screen bg-zinc-950 p-4 md:p-6">
      {isSyncing && (
        <div className="mb-4 flex items-center gap-3 rounded-lg bg-emerald-900/50 border border-emerald-700 px-4 py-3">
          <svg className="h-5 w-5 animate-spin text-emerald-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          <span className="text-emerald-100">Synkroniserer med Hepro...</span>
        </div>
      )}
      {licenseStatus.offline && (
        <div className="mb-4 flex items-center justify-between rounded-lg bg-amber-900/50 border border-amber-700 px-4 py-3">
          <span className="text-amber-100">
            Offline-modus: {licenseStatus.offlineDaysLeft} dager igjen
          </span>
        </div>
      )}
      {updateAvailable && (
        <div className="mb-4 flex items-center justify-between rounded-lg bg-blue-900/50 border border-blue-700 px-4 py-3">
          <span className="text-blue-100">
            Ny versjon tilgjengelig: <strong>{updateAvailable.version}</strong>
          </span>
          {updateProgress ? (
            <span className="text-blue-200 text-sm">{updateProgress}</span>
          ) : (
            <button
              onClick={handleInstallUpdate}
              className="rounded bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-500"
            >
              Oppdater nå
            </button>
          )}
        </div>
      )}
      {currentPage === "settings" ? (
        <SettingsPage
          onBack={() => setCurrentPage("alarms")}
          onSyncIntervalChange={handleSyncIntervalChange}
        />
      ) : (
        <SafetyAlarmsPage
          items={items}
          heartbeatItems={heartbeatItems}
          onUpdateItem={handleUpdateItem}
          onRefresh={handleRefresh}
          lastImportedAt={lastImportedAt}
          refreshStatus={refreshStatus}
          isLoading={isLoading}
          onOpenSettings={() => setCurrentPage("settings")}
        />
      )}
    </div>
  );
}
