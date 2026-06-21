const DATA_DIR = "Assistio-Trygghetsalarm";
const ALARMS_FILE = "safety_alarms.json";
const HEARTBEATS_FILE = "safety_alarm_heartbeats.json";
const META_FILE = "meta.json";
const SETTINGS_APP_ID = "no.svein.assistio-trygghetsalarm";
const SETTINGS_FILE = "settings.json";

async function isTauri() {
  if (typeof window === "undefined") return false;
  if (Boolean(window.__TAURI_INTERNALS__) || Boolean(window.__TAURI__)) {
    return true;
  }
  try {
    const protocol = String(window.location?.protocol ?? "").toLowerCase();
    const hostname = String(window.location?.hostname ?? "").toLowerCase();
    if (protocol === "tauri:") return true;
    if (hostname === "tauri.localhost" || hostname.endsWith(".tauri.localhost"))
      return true;
  } catch (_error) {
    // Ignore
  }
  return false;
}

async function ensureDataDir() {
  if (!(await isTauri())) return null;

  const fs = await import("@tauri-apps/plugin-fs");
  const { documentDir, join } = await import("@tauri-apps/api/path");

  const docDir = await documentDir();
  const dataPath = await join(docDir, DATA_DIR);

  const exists = await fs.exists(dataPath);
  if (!exists) {
    await fs.mkdir(dataPath, { recursive: true });
  }

  return dataPath;
}

async function getFilePath(filename) {
  const dataPath = await ensureDataDir();
  if (!dataPath) return null;

  const { join } = await import("@tauri-apps/api/path");
  return await join(dataPath, filename);
}

async function readJsonFile(filename) {
  if (!(await isTauri())) return null;

  const filePath = await getFilePath(filename);
  if (!filePath) return null;

  const fs = await import("@tauri-apps/plugin-fs");
  const exists = await fs.exists(filePath);
  if (!exists) return null;

  try {
    const content = await fs.readTextFile(filePath);
    const normalized = content.trim().replace(/^\uFEFF/, "");
    if (!normalized) return null;
    return JSON.parse(normalized);
  } catch (error) {
    console.error(`Feil ved lesing av ${filename}:`, error);
    return null;
  }
}

async function writeJsonFile(filename, data) {
  if (!(await isTauri())) return false;

  const filePath = await getFilePath(filename);
  if (!filePath) return false;

  const fs = await import("@tauri-apps/plugin-fs");
  try {
    const content = JSON.stringify(data, null, 2) + "\n";
    await fs.writeTextFile(filePath, content);
    return true;
  } catch (error) {
    console.error(`Feil ved skriving av ${filename}:`, error);
    return false;
  }
}

export async function loadSafetyAlarms() {
  const data = await readJsonFile(ALARMS_FILE);
  if (!data) return [];

  if (Array.isArray(data)) return data;
  if (data.items && Array.isArray(data.items)) return data.items;

  return [];
}

export async function saveSafetyAlarms(items) {
  return await writeJsonFile(ALARMS_FILE, { items, updatedAt: new Date().toISOString() });
}

export async function loadHeartbeats() {
  const data = await readJsonFile(HEARTBEATS_FILE);
  if (!data) return [];

  if (Array.isArray(data)) return data;
  if (data.items && Array.isArray(data.items)) return data.items;

  return [];
}

export async function saveHeartbeats(items) {
  return await writeJsonFile(HEARTBEATS_FILE, { items, updatedAt: new Date().toISOString() });
}

export async function getLastImportedAt() {
  const data = await readJsonFile(META_FILE);
  return data?.lastImportedAt ?? null;
}

export async function setLastImportedAt(timestamp) {
  const existing = (await readJsonFile(META_FILE)) ?? {};
  return await writeJsonFile(META_FILE, {
    ...existing,
    lastImportedAt: timestamp,
  });
}

async function getSettingsFilePath() {
  if (!(await isTauri())) return null;
  const { appDataDir, join } = await import("@tauri-apps/api/path");
  const appDir = await appDataDir();
  return await join(appDir, SETTINGS_FILE);
}

export async function loadSettings() {
  if (!(await isTauri())) return null;
  const filePath = await getSettingsFilePath();
  if (!filePath) return null;

  const fs = await import("@tauri-apps/plugin-fs");
  const exists = await fs.exists(filePath);
  if (!exists) return null;

  try {
    const content = await fs.readTextFile(filePath);
    const normalized = content.trim().replace(/^\uFEFF/, "");
    if (!normalized) return null;
    return JSON.parse(normalized);
  } catch (error) {
    console.error("Feil ved lesing av settings:", error);
    return null;
  }
}

export async function saveSettings(settings) {
  if (!(await isTauri())) return false;
  const filePath = await getSettingsFilePath();
  if (!filePath) return false;

  const fs = await import("@tauri-apps/plugin-fs");
  try {
    const { dirname } = await import("@tauri-apps/api/path");
    const dir = await dirname(filePath);
    const dirExists = await fs.exists(dir);
    if (!dirExists) {
      await fs.mkdir(dir, { recursive: true });
    }
    const content = JSON.stringify(settings, null, 2) + "\n";
    await fs.writeTextFile(filePath, content);
    return true;
  } catch (error) {
    console.error("Feil ved skriving av settings:", error);
    return false;
  }
}

export function getActiveWorkspace(settings) {
  const workspaceSettings = settings?.workspaceSettings ?? {};
  const workspaces = workspaceSettings.workspaces ?? [];
  if (!Array.isArray(workspaces) || workspaces.length === 0) return null;

  const activeId = workspaceSettings.activeWorkspaceId ?? "";
  if (activeId) {
    const found = workspaces.find((w) => w.id === activeId);
    if (found) return found;
  }
  return workspaces[0] ?? null;
}

export function getHeproSettings(workspace) {
  const importSettings = workspace?.safetyAlarmImport ?? {};
  return {
    baseUrl: importSettings.baseUrl ?? "https://hepro.skyresponse.com",
    username: importSettings.username ?? "",
    password: importSettings.password ?? "",
    reportId: importSettings.reportId ?? 9,
  };
}

export function getProxySettings(workspace) {
  const proxySettings = workspace?.safetyAlarmImport?.proxy ?? workspace?.proxy ?? {};
  return {
    url: proxySettings.url ?? "",
    username: proxySettings.username ?? "",
    password: proxySettings.password ?? "",
    useSystemProxy: proxySettings.useSystemProxy ?? true,
    acceptInvalidCerts: proxySettings.acceptInvalidCerts ?? false,
  };
}

export async function saveProxySettings(proxySettings) {
  const settings = (await loadSettings()) ?? {};
  const workspaceSettings = settings.workspaceSettings ?? {};
  const workspaces = workspaceSettings.workspaces ?? [];

  let activeId = workspaceSettings.activeWorkspaceId ?? "";
  let targetIndex = workspaces.findIndex((w) => w.id === activeId);

  if (targetIndex < 0 && workspaces.length > 0) {
    targetIndex = 0;
    activeId = workspaces[0].id ?? "workspace-1";
  }

  if (targetIndex < 0) {
    activeId = "workspace-1";
    workspaces.push({
      id: activeId,
      name: "Standard",
      type: "local",
      safetyAlarmImport: { proxy: proxySettings },
    });
    targetIndex = 0;
  } else {
    const existingImport = workspaces[targetIndex].safetyAlarmImport ?? {};
    workspaces[targetIndex] = {
      ...workspaces[targetIndex],
      safetyAlarmImport: {
        ...existingImport,
        proxy: proxySettings,
      },
    };
  }

  const updatedSettings = {
    ...settings,
    workspaceSettings: {
      ...workspaceSettings,
      activeWorkspaceId: activeId,
      workspaces,
    },
  };

  return await saveSettings(updatedSettings);
}

export function getSyncInterval(workspace) {
  return workspace?.syncIntervalMinutes ?? 20;
}

export async function saveSyncInterval(minutes) {
  const settings = (await loadSettings()) ?? {};
  const workspaceSettings = settings.workspaceSettings ?? {};
  const workspaces = workspaceSettings.workspaces ?? [];

  let activeId = workspaceSettings.activeWorkspaceId ?? "";
  let targetIndex = workspaces.findIndex((w) => w.id === activeId);

  if (targetIndex < 0 && workspaces.length > 0) {
    targetIndex = 0;
  }

  if (targetIndex >= 0) {
    workspaces[targetIndex] = {
      ...workspaces[targetIndex],
      syncIntervalMinutes: minutes,
    };

    const updatedSettings = {
      ...settings,
      workspaceSettings: {
        ...workspaceSettings,
        workspaces,
      },
    };

    return await saveSettings(updatedSettings);
  }

  return false;
}

export async function saveHeproSettings(heproSettings) {
  const settings = (await loadSettings()) ?? {};
  const workspaceSettings = settings.workspaceSettings ?? {};
  const workspaces = workspaceSettings.workspaces ?? [];

  let activeId = workspaceSettings.activeWorkspaceId ?? "";
  let targetIndex = workspaces.findIndex((w) => w.id === activeId);

  if (targetIndex < 0 && workspaces.length > 0) {
    targetIndex = 0;
    activeId = workspaces[0].id ?? "workspace-1";
  }

  if (targetIndex < 0) {
    activeId = "workspace-1";
    workspaces.push({
      id: activeId,
      name: "Standard",
      type: "local",
      safetyAlarmImport: heproSettings,
    });
    targetIndex = 0;
  } else {
    workspaces[targetIndex] = {
      ...workspaces[targetIndex],
      safetyAlarmImport: heproSettings,
    };
  }

  const updatedSettings = {
    ...settings,
    workspaceSettings: {
      ...workspaceSettings,
      activeWorkspaceId: activeId,
      workspaces,
    },
  };

  return await saveSettings(updatedSettings);
}
