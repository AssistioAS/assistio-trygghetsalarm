import { useMemo, useState } from "react";
import {
  getAlarmIdentifier,
  groupV2ItemsByLocation,
  mapSafetyAlarmToV2Item,
  normalizeAlarmIdentifier,
  sortV2Items,
} from "../features/safetyAlarmsModel.js";

const VIEWS = [
  { id: "list", label: "Liste" },
  { id: "control", label: "Driftskontroll" },
];

const FILTERS = [
  { id: "all", label: "Alle aktive" },
  { id: "offline", label: "Offline" },
  { id: "critical", label: "Kritiske" },
  { id: "red", label: "Rode" },
  { id: "yellow", label: "Gule" },
];

const SORT_OPTIONS = [
  { id: "critical_alpha", label: "Kritiske forst" },
  { id: "status", label: "Status forst" },
  { id: "heartbeat_oldest", label: "Eldste hjerteslag" },
];

function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("nb-NO", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function parseBirthDate(item) {
  const rawDate = String(item?.sourcePayload?.M ?? "").trim();
  if (rawDate) {
    const date = new Date(rawDate);
    if (!Number.isNaN(date.getTime())) return date;
  }

  const nationalId = String(item?.nationalId ?? "").replace(/\D/g, "");
  if (nationalId.length >= 6) {
    const day = Number(nationalId.slice(0, 2));
    const month = Number(nationalId.slice(2, 4));
    const yearPart = Number(nationalId.slice(4, 6));
    const now = new Date();
    const currentTwoDigitYear = now.getFullYear() % 100;
    const year = yearPart <= currentTwoDigitYear ? 2000 + yearPart : 1900 + yearPart;
    const date = new Date(year, month - 1, day);
    if (!Number.isNaN(date.getTime())) return date;
  }

  return null;
}

function ageFromItem(item) {
  const birthDate = parseBirthDate(item);
  if (!birthDate) return "";
  const now = new Date();
  let age = now.getFullYear() - birthDate.getFullYear();
  const hasHadBirthday =
    now.getMonth() > birthDate.getMonth() ||
    (now.getMonth() === birthDate.getMonth() && now.getDate() >= birthDate.getDate());
  if (!hasHadBirthday) age -= 1;
  return age >= 0 ? String(age) : "";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function makeExcelHtml(items, mode = "critical_only") {
  const rows = items
    .map(
      (item, index) => `
        <tr${item.critical ? ' class="critical"' : ""}>
          <td>${index + 1}</td>
          <td>${escapeHtml(item.name || "")}</td>
          <td>${escapeHtml(ageFromItem(item))}</td>
          <td>${escapeHtml(item.address || "")}</td>
          <td>${escapeHtml([item.postalCode, item.city].filter(Boolean).join(" "))}</td>
          <td>${escapeHtml(item.apartmentLabel || "")}</td>
          <td>${escapeHtml(item.criticalNote || "")}</td>
          <td>${item.critical ? "Kritisk" : "Normal"}</td>
        </tr>`
    )
    .join("");

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    body { font-family: Calibri, Arial, sans-serif; }
    h1 { font-size: 20px; margin-bottom: 8px; }
    p { color: #444; margin-top: 0; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #cfcfcf; padding: 6px 8px; text-align: left; vertical-align: top; }
    th { background: #f3f4f6; font-weight: 700; }
    tr.critical td { background: #fef2f2; }
  </style>
</head>
<body>
  <h1>${mode === "all_active" ? "Alle aktive trygghetsalarmbrukere" : "Kritiske trygghetsalarmbrukere"}</h1>
  <p>Eksportert ${escapeHtml(formatDateTime(new Date().toISOString()))}. Antall: ${items.length}</p>
  <p>${mode === "all_active" ? "Kritiske brukere er markert med lys rod bakgrunn." : "Listen inneholder bare kritiske brukere."}</p>
  <table>
    <thead>
      <tr>
        <th>#</th>
        <th>Navn</th>
        <th>Alder</th>
        <th>Adresse</th>
        <th>Poststed</th>
        <th>Leilighet</th>
        <th>Arsak</th>
        <th>Kritisk</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`;
}

function escapeCsvField(value) {
  const str = String(value ?? "");
  if (str.includes('"') || str.includes(",") || str.includes("\n") || str.includes(";")) {
    return `"${str.replaceAll('"', '""')}"`;
  }
  return str;
}

function makeCsv(items) {
  const headers = ["#", "Navn", "Alder", "Adresse", "Postnummer", "Poststed", "Leilighet", "Telefon", "Arsak", "Kritisk"];
  const rows = items.map((item, index) => [
    index + 1,
    item.name || "",
    ageFromItem(item),
    item.address || "",
    item.postalCode || "",
    item.city || "",
    item.apartmentLabel || "",
    item.phone || "",
    item.criticalNote || "",
    item.critical ? "Ja" : "Nei",
  ]);
  const csvRows = [headers, ...rows].map((row) => row.map(escapeCsvField).join(";"));
  return "\uFEFF" + csvRows.join("\r\n");
}

function makeJsonExport(items) {
  const exportItems = items.map((item, index) => ({
    nr: index + 1,
    navn: item.name || "",
    alder: ageFromItem(item),
    adresse: item.address || "",
    postnummer: item.postalCode || "",
    poststed: item.city || "",
    leilighet: item.apartmentLabel || "",
    telefon: item.phone || "",
    kritisk: item.critical || false,
    arsak: item.criticalNote || "",
    sisteHjerteslag: item.lastHeartbeatAt || null,
    hjerteslagStatus: item.heartbeatStatus || "unknown",
  }));
  return JSON.stringify({
    eksportertTidspunkt: new Date().toISOString(),
    antall: exportItems.length,
    brukere: exportItems,
  }, null, 2);
}

function downloadTextFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

async function isTauri() {
  if (typeof window === "undefined") return false;
  return Boolean(window.__TAURI_INTERNALS__) || Boolean(window.__TAURI__);
}

const FILE_FORMATS = {
  excel: { name: "Excel", extensions: ["xls"], mimeType: "application/vnd.ms-excel;charset=utf-8" },
  csv: { name: "CSV", extensions: ["csv"], mimeType: "text/csv;charset=utf-8" },
  json: { name: "JSON", extensions: ["json"], mimeType: "application/json;charset=utf-8" },
};

async function saveFile({ defaultName, content, format = "excel" }) {
  const formatConfig = FILE_FORMATS[format] || FILE_FORMATS.excel;

  if (await isTauri()) {
    const dialog = await import("@tauri-apps/plugin-dialog");
    const fs = await import("@tauri-apps/plugin-fs");
    const path = await dialog.save({
      defaultPath: defaultName,
      filters: [{ name: formatConfig.name, extensions: formatConfig.extensions }],
    });
    if (!path) return false;
    await fs.writeTextFile(path, content, { create: true });
    return true;
  }

  downloadTextFile(defaultName, content, formatConfig.mimeType);
  return true;
}

function statusTone(status) {
  if (status === "red") {
    return {
      dot: "bg-rose-500 shadow-[0_0_16px_rgba(244,63,94,0.85)]",
      chip: "border-rose-400/40 bg-rose-500/15 text-rose-100",
      card: "border-rose-500/30 bg-rose-950/40",
      label: "Rod",
    };
  }
  if (status === "yellow") {
    return {
      dot: "bg-amber-400 shadow-[0_0_14px_rgba(251,191,36,0.8)]",
      chip: "border-amber-400/40 bg-amber-500/15 text-amber-100",
      card: "border-amber-500/30 bg-amber-950/30",
      label: "Gul",
    };
  }
  if (status === "green") {
    return {
      dot: "bg-emerald-400 shadow-[0_0_14px_rgba(52,211,153,0.7)]",
      chip: "border-emerald-400/40 bg-emerald-500/15 text-emerald-100",
      card: "border-emerald-500/20 bg-emerald-950/20",
      label: "Gronn",
    };
  }
  return {
    dot: "bg-zinc-500 shadow-[0_0_10px_rgba(113,113,122,0.5)]",
    chip: "border-zinc-600 bg-zinc-800 text-zinc-200",
    card: "border-zinc-800 bg-zinc-900/70",
    label: "Ukjent",
  };
}

function criticalBadge(item) {
  if (!item.critical) return null;
  return (
    <span className="rounded-full border border-rose-300/50 bg-rose-500/20 px-2.5 py-1 text-[11px] font-medium text-rose-100">
      Kritisk
    </span>
  );
}

function offlineBadge(item) {
  if (!["red", "yellow"].includes(item.heartbeatStatus)) return null;
  return (
    <span className="rounded-full border border-zinc-600 bg-zinc-900/80 px-2.5 py-1 text-[11px] font-medium text-zinc-100">
      Offline
    </span>
  );
}

function cardTone(item) {
  if (item.critical && ["red", "yellow"].includes(item.heartbeatStatus)) {
    return "border-rose-400/60 bg-rose-500/15 shadow-[0_0_0_1px_rgba(251,113,133,0.12)]";
  }
  return statusTone(item.heartbeatStatus).card;
}

export default function SafetyAlarmsPage({
  items = [],
  heartbeatItems = [],
  onUpdateItem,
  onRefresh,
  onOpenSettings,
  lastImportedAt = null,
  refreshStatus = null,
  isLoading = false,
}) {
  const [view, setView] = useState("list");
  const [filter, setFilter] = useState("all");
  const [sortBy, setSortBy] = useState("critical_alpha");
  const [query, setQuery] = useState("");
  const [selectedLocationKey, setSelectedLocationKey] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [dialogItemId, setDialogItemId] = useState("");
  const [dialogReason, setDialogReason] = useState("");
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [exportFormat, setExportFormat] = useState("excel");

  const activeItems = useMemo(() => {
    const heartbeatByIdentifier = new Map(
      (heartbeatItems ?? [])
        .filter((item) => item && typeof item === "object")
        .map((item) => [normalizeAlarmIdentifier(item.alarmIdentifier), item])
        .filter(([key]) => key)
    );

    return (items ?? [])
      .filter((item) => item?.isActive !== false)
      .map((item) => {
        const alarmIdentifier = getAlarmIdentifier(item);
        if (!alarmIdentifier) return null;
        const heartbeat = heartbeatByIdentifier.get(alarmIdentifier);
        return mapSafetyAlarmToV2Item({
          ...item,
          sourcePayload: heartbeat
            ? {
                ...(item?.sourcePayload &&
                typeof item.sourcePayload === "object" &&
                !Array.isArray(item.sourcePayload)
                  ? item.sourcePayload
                  : {}),
                __heartbeat: heartbeat,
              }
            : item?.sourcePayload,
        });
      })
      .filter(Boolean);
  }, [heartbeatItems, items]);

  const filteredItems = useMemo(() => {
    const normalizedQuery = String(query ?? "").trim().toLowerCase();
    const nextItems = activeItems.filter((item) => {
      if (filter === "offline" && !["red", "yellow"].includes(item.heartbeatStatus)) return false;
      if (filter === "critical" && !item.critical) return false;
      if (filter === "red" && item.heartbeatStatus !== "red") return false;
      if (filter === "yellow" && item.heartbeatStatus !== "yellow") return false;
      if (!normalizedQuery) return true;
      const haystack = [
        item.name,
        item.address,
        item.postalCode,
        item.city,
        item.phone,
        item.alarmIdentifier,
        item.apartmentLabel,
        item.criticalNote,
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(normalizedQuery);
    });
    return sortV2Items(nextItems, sortBy);
  }, [activeItems, filter, query, sortBy]);

  const groupedLocations = useMemo(() => groupV2ItemsByLocation(filteredItems), [filteredItems]);

  const selectedLocation = useMemo(
    () => groupedLocations.find((location) => location.locationKey === selectedLocationKey) ?? groupedLocations[0] ?? null,
    [groupedLocations, selectedLocationKey]
  );

  const stats = useMemo(
    () => ({
      total: activeItems.length,
      offline: activeItems.filter((item) => ["red", "yellow"].includes(item.heartbeatStatus)).length,
      red: activeItems.filter((item) => item.heartbeatStatus === "red").length,
      yellow: activeItems.filter((item) => item.heartbeatStatus === "yellow").length,
      critical: activeItems.filter((item) => item.critical).length,
    }),
    [activeItems]
  );

  const criticalItems = useMemo(() => activeItems.filter((item) => item.critical), [activeItems]);

  const freshnessLabel = lastImportedAt
    ? `Hepro sist hentet ${formatDateTime(lastImportedAt)}`
    : "Hepro: ikke hentet enda";

  const dialogItem = useMemo(
    () => activeItems.find((item) => item.id === dialogItemId) ?? null,
    [activeItems, dialogItemId]
  );

  const openDialog = (item) => {
    setDialogItemId(item.id);
    setDialogReason(String(item.criticalNote ?? ""));
  };

  const closeDialog = () => {
    setDialogItemId("");
    setDialogReason("");
  };

  const saveCriticalState = (critical) => {
    if (!dialogItem || typeof onUpdateItem !== "function") return;
    onUpdateItem(dialogItem.id, {
      critical,
      criticalNote: critical ? dialogReason.trim() : "",
    });
    closeDialog();
  };

  const exportItems = async (mode, format = "excel") => {
    const allActiveItems = sortV2Items(activeItems, "critical_alpha");
    const criticalOnlyItems = allActiveItems.filter((item) => item?.critical);
    const itemsToExport = mode === "all_active" ? allActiveItems : criticalOnlyItems;
    if (itemsToExport.length === 0) return;
    setIsSaving(true);
    try {
      const dateStamp = new Date().toISOString().slice(0, 10);
      const baseFilename = mode === "all_active" ? "trygghetsalarmer_alle" : "kritiske_trygghetsalarmer";

      let content;
      let extension;
      if (format === "csv") {
        content = makeCsv(itemsToExport);
        extension = "csv";
      } else if (format === "json") {
        content = makeJsonExport(itemsToExport);
        extension = "json";
      } else {
        content = makeExcelHtml(itemsToExport, mode);
        extension = "xls";
      }

      await saveFile({
        defaultName: `${baseFilename}_${dateStamp}.${extension}`,
        content,
        format,
      });
    } finally {
      setIsSaving(false);
      setShowExportDialog(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-2xl font-semibold text-white">Trygghetsalarmer</div>
          <div className="mt-1 text-sm text-zinc-400">
            Pilot for heartbeat, driftsstatus og senere kartvisning.
          </div>
          <div className="mt-2 text-xs text-zinc-500">{freshnessLabel}</div>
          {refreshStatus?.message ? (
            <div
              className={`mt-1 text-xs ${
                refreshStatus.lastStatus === "error"
                  ? "text-rose-300"
                  : refreshStatus.lastStatus === "success"
                    ? "text-emerald-300"
                    : "text-sky-300"
              }`}
            >
              {refreshStatus.message}
            </div>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setShowExportDialog(true)}
            disabled={isSaving || activeItems.length === 0}
            className="rounded-xl bg-gradient-to-r from-amber-600 to-yellow-500 px-4 py-2 font-semibold text-white transition hover:from-amber-500 hover:to-yellow-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isSaving ? "Eksporterer..." : "Eksporter"}
          </button>
          {typeof onRefresh === "function" ? (
            <button
              type="button"
              onClick={onRefresh}
              disabled={isLoading}
              className="rounded-xl border border-sky-500/40 bg-sky-500/10 px-4 py-2 font-medium text-sky-100 transition hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isLoading ? "Oppdaterer..." : "Oppdater"}
            </button>
          ) : null}
          {typeof onOpenSettings === "function" ? (
            <button
              type="button"
              onClick={onOpenSettings}
              className="rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-2 text-zinc-200 transition hover:bg-zinc-800"
            >
              Innstillinger
            </button>
          ) : null}
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-5">
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4">
          <div className="text-xs uppercase tracking-wide text-zinc-500">Aktive</div>
          <div className="mt-2 text-3xl font-semibold text-white">{stats.total}</div>
        </div>
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4">
          <div className="text-xs uppercase tracking-wide text-zinc-500">Offline</div>
          <div className="mt-2 text-3xl font-semibold text-white">{stats.offline}</div>
        </div>
        <div className="rounded-2xl border border-rose-500/30 bg-rose-500/10 p-4">
          <div className="text-xs uppercase tracking-wide text-rose-200/80">Rode</div>
          <div className="mt-2 text-3xl font-semibold text-rose-100">{stats.red}</div>
        </div>
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4">
          <div className="text-xs uppercase tracking-wide text-amber-100/80">Gule</div>
          <div className="mt-2 text-3xl font-semibold text-amber-100">{stats.yellow}</div>
        </div>
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4">
          <div className="text-xs uppercase tracking-wide text-zinc-500">Kritiske</div>
          <div className="mt-2 text-3xl font-semibold text-white">{stats.critical}</div>
        </div>
      </div>

      <div className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-4 md:p-5">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex flex-wrap gap-2">
            {VIEWS.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setView(item.id)}
                className={`rounded-full border px-3 py-1.5 text-sm transition ${
                  view === item.id
                    ? "border-sky-400/50 bg-sky-500/15 text-sky-100"
                    : "border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800"
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="h-5 w-px bg-zinc-800" />
          <div className="flex flex-wrap gap-2">
            {FILTERS.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setFilter(item.id)}
                className={`rounded-full border px-3 py-1.5 text-sm transition ${
                  filter === item.id
                    ? "border-amber-400/50 bg-amber-500/15 text-amber-200"
                    : "border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800"
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
          <select
            value={sortBy}
            onChange={(event) => setSortBy(event.target.value)}
            className="rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-amber-500/60"
          >
            {SORT_OPTIONS.map((item) => (
              <option key={item.id} value={item.id}>
                Sortering: {item.label}
              </option>
            ))}
          </select>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Sok etter navn, adresse, identifier eller leilighet..."
            className="min-w-[220px] flex-1 rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 text-zinc-100 focus:outline-none focus:ring-2 focus:ring-amber-500/60"
          />
        </div>

        <div className="mt-4 text-sm text-zinc-400">
          {filter === "critical"
            ? `${filteredItems.length} kritiske brukere i listen`
            : filter === "offline"
              ? `${filteredItems.length} offline brukere i listen`
              : `${filteredItems.length} aktive brukere i listen`}
        </div>

        {view === "list" ? (
          <div className="mt-5 space-y-3">
            {filteredItems.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-zinc-700 bg-zinc-950/40 px-4 py-10 text-center text-sm text-zinc-400">
                {isLoading ? "Laster trygghetsalarmer..." : "Ingen brukere i valgt utvalg."}
              </div>
            ) : (
              filteredItems.map((item) => {
                const tone = statusTone(item.heartbeatStatus);
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => openDialog(item)}
                    className={`block w-full rounded-2xl border p-4 text-left transition ${cardTone(item)}`}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={`h-3 w-3 rounded-full ${tone.dot}`} />
                          <div className="text-lg font-semibold text-white">
                            {item.name || "Uten navn"}
                            {ageFromItem(item) ? `, ${ageFromItem(item)}` : ""}
                          </div>
                          {criticalBadge(item)}
                          {offlineBadge(item)}
                        </div>
                        <div className="mt-1 text-sm text-zinc-300">
                          {item.displayAddress || "Ingen adresse"}
                        </div>
                      </div>
                      <span className={`rounded-full border px-2.5 py-1 text-xs font-medium ${tone.chip}`}>
                        {tone.label}
                      </span>
                    </div>

                    <div className="mt-4 grid gap-3 text-sm text-zinc-200 md:grid-cols-6">
                      <div>
                        <div className="text-[11px] uppercase tracking-wide text-zinc-500">Leilighet</div>
                        <div className="mt-1">{item.apartmentLabel || "-"}</div>
                      </div>
                      <div>
                        <div className="text-[11px] uppercase tracking-wide text-zinc-500">Siste hjerteslag</div>
                        <div className="mt-1">{formatDateTime(item.lastHeartbeatAt)}</div>
                      </div>
                      <div>
                        <div className="text-[11px] uppercase tracking-wide text-zinc-500">Alder</div>
                        <div
                          className={`mt-1 font-medium ${
                            item.heartbeatStatus === "red"
                              ? "text-rose-200"
                              : item.heartbeatStatus === "yellow"
                                ? "text-amber-200"
                                : "text-zinc-100"
                          }`}
                        >
                          {item.heartbeatAgeLabel}
                        </div>
                      </div>
                      <div>
                        <div className="text-[11px] uppercase tracking-wide text-zinc-500">Identifier</div>
                        <div className="mt-1">{item.alarmIdentifier || "-"}</div>
                      </div>
                      <div>
                        <div className="text-[11px] uppercase tracking-wide text-zinc-500">Status</div>
                        <div className="mt-1">{tone.label}</div>
                      </div>
                      <div>
                        <div className="text-[11px] uppercase tracking-wide text-zinc-500">Arsak</div>
                        <div className="mt-1">{item.criticalNote || "-"}</div>
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        ) : (
          <div className="mt-5 grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
            <div className="rounded-3xl border border-zinc-800 bg-[radial-gradient(circle_at_top,_rgba(56,189,248,0.12),_transparent_36%),linear-gradient(180deg,rgba(24,24,27,0.96),rgba(9,9,11,0.98))] p-5">
              <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">Driftskontroll</div>
              <div className="mt-2 text-sm text-zinc-400">
                Aggregert bygningsvisning. Kartmotor kan kobles inn senere uten a endre statusmodellen.
              </div>
              <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {groupedLocations.map((location) => {
                  const tone = statusTone(location.status);
                  return (
                    <button
                      key={location.locationKey}
                      type="button"
                      onClick={() => setSelectedLocationKey(location.locationKey)}
                      className={`rounded-2xl border p-4 text-left transition ${
                        selectedLocation?.locationKey === location.locationKey
                          ? "border-sky-400/50 bg-sky-500/10"
                          : tone.card
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <span className={`h-4 w-4 rounded-full ${tone.dot}`} />
                        <div className="min-w-0">
                          <div className="truncate text-base font-semibold text-white">
                            {location.displayAddress}
                          </div>
                          <div className="mt-0.5 text-xs text-zinc-400">
                            {location.residentCount} brukere
                            {location.criticalCount > 0 ? ` - ${location.criticalCount} kritiske` : ""}
                          </div>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="rounded-3xl border border-zinc-800 bg-zinc-950/80 p-5">
              <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">Valgt bygg</div>
              {selectedLocation ? (
                <>
                  <div className="mt-2 text-lg font-semibold text-white">{selectedLocation.displayAddress}</div>
                  <div className="mt-1 text-sm text-zinc-400">
                    {selectedLocation.residentCount} brukere
                    {selectedLocation.criticalCount > 0 ? ` - ${selectedLocation.criticalCount} kritiske` : ""}
                  </div>
                  <div className="mt-4 space-y-3">
                    {selectedLocation.items.map((item) => {
                      const tone = statusTone(item.heartbeatStatus);
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => openDialog(item)}
                          className="block w-full rounded-2xl border border-zinc-800 bg-zinc-900/70 p-3 text-left"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <span className={`h-2.5 w-2.5 rounded-full ${tone.dot}`} />
                                <div className="truncate font-medium text-white">
                                  {item.name || "Uten navn"}
                                  {ageFromItem(item) ? `, ${ageFromItem(item)}` : ""}
                                </div>
                              </div>
                              <div className="mt-1 text-xs text-zinc-400">
                                {item.apartmentLabel || "Uten leilighetsnummer"}
                              </div>
                            </div>
                            {criticalBadge(item)}
                          </div>
                          <div className="mt-3 flex flex-wrap gap-3 text-xs text-zinc-300">
                            <span>{formatDateTime(item.lastHeartbeatAt)}</span>
                            <span>{item.heartbeatAgeLabel}</span>
                            <span className={`rounded-full border px-2 py-0.5 ${tone.chip}`}>{tone.label}</span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </>
              ) : (
                <div className="mt-3 text-sm text-zinc-400">Ingen lokasjoner i valgt utvalg.</div>
              )}
            </div>
          </div>
        )}
      </div>

      {dialogItem ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4">
          <div className="w-full max-w-xl rounded-3xl border border-zinc-800 bg-zinc-950 p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-xl font-semibold text-white">
                  {dialogItem.name || "Uten navn"}
                  {ageFromItem(dialogItem) ? `, ${ageFromItem(dialogItem)}` : ""}
                </div>
                <div className="mt-1 text-sm text-zinc-400">
                  {[dialogItem.address, dialogItem.postalCode, dialogItem.city].filter(Boolean).join(", ") || "Ingen adresse"}
                </div>
              </div>
              {dialogItem.critical ? (
                <span className="rounded-full border border-rose-300/50 bg-rose-500/20 px-2.5 py-1 text-xs font-medium text-rose-100">
                  Kritisk
                </span>
              ) : null}
            </div>

            <div className="mt-5 space-y-2">
              <div className="text-sm font-medium text-zinc-200">Arsak</div>
              <textarea
                rows={5}
                value={dialogReason}
                onChange={(event) => setDialogReason(event.target.value)}
                placeholder="Skriv hvorfor brukeren vurderes som kritisk..."
                className="w-full rounded-2xl border border-zinc-700 bg-zinc-900 px-3 py-3 text-zinc-100 focus:outline-none focus:ring-2 focus:ring-amber-500/60"
              />
            </div>

            <div className="mt-5 grid gap-3 text-sm text-zinc-300 md:grid-cols-4">
              <div>
                <div className="text-[11px] uppercase tracking-wide text-zinc-500">Leilighet</div>
                <div className="mt-1">{dialogItem.apartmentLabel || "-"}</div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wide text-zinc-500">Alder</div>
                <div className="mt-1">{ageFromItem(dialogItem) || "-"}</div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wide text-zinc-500">Siste hjerteslag</div>
                <div className="mt-1">{formatDateTime(dialogItem.lastHeartbeatAt)}</div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wide text-zinc-500">Heartbeat-alder</div>
                <div className="mt-1">{dialogItem.heartbeatAgeLabel}</div>
              </div>
            </div>

            <div className="mt-6 flex flex-wrap justify-between gap-2">
              <button
                type="button"
                onClick={() => saveCriticalState(false)}
                className="rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-2 text-zinc-200 transition hover:bg-zinc-800"
              >
                Fjern kritisk
              </button>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={closeDialog}
                  className="rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-2 text-zinc-200 transition hover:bg-zinc-800"
                >
                  Avbryt
                </button>
                <button
                  type="button"
                  onClick={() => saveCriticalState(true)}
                  className="rounded-xl bg-gradient-to-r from-amber-600 to-yellow-500 px-4 py-2 font-semibold text-white transition hover:from-amber-500 hover:to-yellow-400"
                >
                  Lagre arsak
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {showExportDialog ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4">
          <div className="w-full max-w-lg rounded-3xl border border-zinc-800 bg-zinc-950 p-5 shadow-2xl">
            <div className="text-xl font-semibold text-white">Eksporter trygghetsalarmer</div>
            <div className="mt-2 text-sm text-zinc-400">
              Velg format og hvilke brukere som skal eksporteres.
            </div>

            <div className="mt-5">
              <div className="text-sm font-medium text-zinc-200">Format</div>
              <div className="mt-2 flex flex-wrap gap-2">
                {[
                  { id: "excel", label: "Excel (.xls)" },
                  { id: "csv", label: "CSV (.csv)" },
                  { id: "json", label: "JSON (.json)" },
                ].map((fmt) => (
                  <button
                    key={fmt.id}
                    type="button"
                    onClick={() => setExportFormat(fmt.id)}
                    className={`rounded-full border px-3 py-1.5 text-sm transition ${
                      exportFormat === fmt.id
                        ? "border-amber-400/50 bg-amber-500/15 text-amber-200"
                        : "border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800"
                    }`}
                  >
                    {fmt.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-5">
              <div className="text-sm font-medium text-zinc-200">Brukere</div>
              <div className="mt-2 grid gap-3">
                <button
                  type="button"
                  onClick={() => exportItems("critical_only", exportFormat)}
                  disabled={isSaving || criticalItems.length === 0}
                  className="rounded-2xl border border-rose-400/40 bg-rose-500/10 p-4 text-left transition hover:bg-rose-500/15 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <div className="text-base font-semibold text-rose-100">Kun kritiske</div>
                  <div className="mt-1 text-sm text-zinc-300">
                    Eksporter bare de {criticalItems.length} kritiske brukerne.
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => exportItems("all_active", exportFormat)}
                  disabled={isSaving || activeItems.length === 0}
                  className="rounded-2xl border border-zinc-700 bg-zinc-900 p-4 text-left transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <div className="text-base font-semibold text-white">Alle aktive</div>
                  <div className="mt-1 text-sm text-zinc-300">
                    Eksporter alle {activeItems.length} aktive brukere.
                  </div>
                </button>
              </div>
            </div>

            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={() => setShowExportDialog(false)}
                className="rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-2 text-zinc-200 transition hover:bg-zinc-800"
              >
                Avbryt
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
