function normalizeText(value) {
  return String(value ?? "").trim();
}

export const HEARTBEAT_GREEN_THRESHOLD_MINUTES = 45;
export const HEARTBEAT_YELLOW_THRESHOLD_MINUTES = 90;

export function normalizeAlarmIdentifier(value) {
  const raw = normalizeText(value);
  if (!raw) return "";
  const compact = raw.replace(/\s+/g, "");
  if (compact.startsWith("+")) {
    return `+${compact.slice(1).replace(/\D/g, "")}`;
  }
  const digits = compact.replace(/\D/g, "");
  if (!digits) return "";
  return digits.startsWith("46") ? `+${digits}` : digits;
}

function heartbeatPayloadFromItem(item) {
  const payload = item?.sourcePayload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }
  const heartbeat = payload.__heartbeat;
  return heartbeat && typeof heartbeat === "object" && !Array.isArray(heartbeat) ? heartbeat : {};
}

function sourcePayloadFromItem(item) {
  const payload = item?.sourcePayload;
  return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
}

export function getAlarmIdentifier(item) {
  const sourcePayload = sourcePayloadFromItem(item);
  const heartbeatPayload = heartbeatPayloadFromItem(item);
  return normalizeAlarmIdentifier(
    item?.alarmIdentifier ??
      heartbeatPayload?.alarmIdentifier ??
      sourcePayload?.F ??
      sourcePayload?.Identifier ??
      sourcePayload?.Identifikator ??
      sourcePayload?.Abonnement ??
      item?.externalId ??
      ""
  );
}

export function getApartmentLabel(item) {
  return normalizeText(item?.apartmentLabel ?? heartbeatPayloadFromItem(item)?.apartmentLabel ?? "");
}

export function getLastHeartbeatAt(item) {
  return normalizeText(item?.lastHeartbeatAt ?? heartbeatPayloadFromItem(item)?.lastHeartbeatAt ?? "");
}

export function getHeartbeatSourceImportedAt(item) {
  return normalizeText(
    item?.heartbeatSourceImportedAt ?? heartbeatPayloadFromItem(item)?.heartbeatSourceImportedAt ?? ""
  );
}

function getHeartbeatReferenceDate(item, now = new Date()) {
  const importedAtRaw = getHeartbeatSourceImportedAt(item);
  if (!importedAtRaw) return now;
  const importedAt = new Date(importedAtRaw);
  if (Number.isNaN(importedAt.getTime())) return now;
  return importedAt.getTime() <= now.getTime() ? importedAt : now;
}

export function getHeartbeatAgeMinutes(item, now = new Date(), mode = "live") {
  const raw = getLastHeartbeatAt(item);
  if (!raw) return null;
  const heartbeatAt = new Date(raw);
  if (Number.isNaN(heartbeatAt.getTime())) return null;
  const referenceDate = mode === "snapshot" ? getHeartbeatReferenceDate(item, now) : now;
  const diffMs = referenceDate.getTime() - heartbeatAt.getTime();
  if (!Number.isFinite(diffMs)) return null;
  return Math.max(0, Math.floor(diffMs / 60000));
}

export function getHeartbeatStatus(item, now = new Date()) {
  const ageMinutes = getHeartbeatAgeMinutes(item, now, "snapshot");
  if (ageMinutes == null) return "unknown";
  if (ageMinutes <= HEARTBEAT_GREEN_THRESHOLD_MINUTES) return "green";
  if (ageMinutes <= HEARTBEAT_YELLOW_THRESHOLD_MINUTES) return "yellow";
  return "red";
}

export function formatHeartbeatAge(item, now = new Date()) {
  const ageMinutes = getHeartbeatAgeMinutes(item, now, "live");
  if (ageMinutes == null) return "Ukjent";
  if (ageMinutes < 60) return `${ageMinutes} min`;
  const hours = Math.floor(ageMinutes / 60);
  const minutes = ageMinutes % 60;
  return minutes === 0 ? `${hours} t` : `${hours} t ${minutes} min`;
}

export function getDisplayAddress(item) {
  return [item?.address, item?.postalCode, item?.city].filter(Boolean).join(", ");
}

export function getLocationKey(item) {
  const explicit = normalizeText(item?.locationKey ?? heartbeatPayloadFromItem(item)?.locationKey ?? "");
  if (explicit) return explicit.toLowerCase();
  return [item?.address, item?.postalCode, item?.city]
    .map((value) => normalizeText(value).toLowerCase())
    .join("|");
}

export function mapSafetyAlarmToV2Item(item, now = new Date()) {
  const heartbeatStatus = getHeartbeatStatus(item, now);
  return {
    ...item,
    alarmIdentifier: getAlarmIdentifier(item),
    apartmentLabel: getApartmentLabel(item),
    lastHeartbeatAt: getLastHeartbeatAt(item),
    heartbeatSourceImportedAt: getHeartbeatSourceImportedAt(item),
    heartbeatStatus,
    heartbeatAgeLabel: formatHeartbeatAge(item, now),
    displayAddress: getDisplayAddress(item),
    locationKey: getLocationKey(item),
  };
}

function heartbeatRank(status) {
  if (status === "red") return 0;
  if (status === "yellow") return 1;
  if (status === "green") return 2;
  return 3;
}

export function sortV2Items(items, sortBy = "critical_alpha") {
  return [...items].sort((a, b) => {
    if (sortBy === "critical_alpha") {
      if (Boolean(a.critical) !== Boolean(b.critical)) {
        return a.critical ? -1 : 1;
      }
      return String(a.name ?? "").localeCompare(String(b.name ?? ""), "nb", { sensitivity: "base" });
    }
    if (sortBy === "heartbeat_oldest") {
      const ageA = getHeartbeatAgeMinutes(a);
      const ageB = getHeartbeatAgeMinutes(b);
      if (ageA == null && ageB != null) return 1;
      if (ageA != null && ageB == null) return -1;
      if (ageA != null && ageB != null && ageA !== ageB) return ageB - ageA;
    } else {
      const statusDiff = heartbeatRank(a.heartbeatStatus) - heartbeatRank(b.heartbeatStatus);
      if (statusDiff !== 0) return statusDiff;
      if (Boolean(a.critical) !== Boolean(b.critical)) {
        return a.critical ? -1 : 1;
      }
    }
    return String(a.name ?? "").localeCompare(String(b.name ?? ""), "nb", { sensitivity: "base" });
  });
}

export function groupV2ItemsByLocation(items) {
  const byLocation = new Map();
  for (const item of items) {
    const key = item.locationKey || item.id;
    const existing = byLocation.get(key) ?? {
      locationKey: key,
      displayAddress: item.displayAddress || item.address || "Ukjent adresse",
      address: item.address || "",
      postalCode: item.postalCode || "",
      city: item.city || "",
      lat: item.lat ?? null,
      lng: item.lng ?? null,
      criticalCount: 0,
      residentCount: 0,
      status: "green",
      items: [],
    };
    existing.items.push(item);
    existing.residentCount += 1;
    if (item.critical) existing.criticalCount += 1;
    if (item.heartbeatStatus === "red") {
      existing.status = "red";
    } else if (item.heartbeatStatus === "yellow" && existing.status !== "red") {
      existing.status = "yellow";
    } else if (item.heartbeatStatus === "unknown" && existing.status === "green") {
      existing.status = "unknown";
    }
    byLocation.set(key, existing);
  }

  return [...byLocation.values()]
    .map((location) => ({
      ...location,
      items: sortV2Items(location.items),
    }))
    .sort((a, b) => {
      const statusDiff = heartbeatRank(a.status) - heartbeatRank(b.status);
      if (statusDiff !== 0) return statusDiff;
      if (a.criticalCount !== b.criticalCount) return b.criticalCount - a.criticalCount;
      return String(a.displayAddress ?? "").localeCompare(String(b.displayAddress ?? ""), "nb", {
        sensitivity: "base",
      });
    });
}
