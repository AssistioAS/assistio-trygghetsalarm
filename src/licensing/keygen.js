/**
 * Keygen.sh lisensmodul
 *
 * Dokumentasjon: https://keygen.sh/docs/api/
 */

import { Store } from "@tauri-apps/plugin-store";

// ============================================
// KONFIGURASJON - Fyll inn dine verdier her
// ============================================
const KEYGEN_ACCOUNT_ID = "c5edce77-0f5f-4de4-ab93-2adc66daaba8"; // Fra Keygen dashboard
const KEYGEN_PRODUCT_ID = "10a658eb-4fb0-4df6-a4e8-e9bdfa2243d1"; // Fra Keygen dashboard

// Hvor lenge lisensen er gyldig offline (i dager)
const OFFLINE_GRACE_DAYS = 7;

// ============================================

const KEYGEN_API_URL = `https://api.keygen.sh/v1/accounts/${KEYGEN_ACCOUNT_ID}`;
const LICENSE_STORE_KEY = "license";

let store = null;

async function getStore() {
  if (!store) {
    store = await Store.load("license.json");
  }
  return store;
}

/**
 * Hent lagret lisensdata
 */
export async function getStoredLicense() {
  const s = await getStore();
  const data = await s.get(LICENSE_STORE_KEY);
  return data || null;
}

/**
 * Lagre lisensdata lokalt
 */
async function storeLicense(licenseData) {
  const s = await getStore();
  await s.set(LICENSE_STORE_KEY, {
    ...licenseData,
    cachedAt: new Date().toISOString(),
  });
  await s.save();
}

/**
 * Slett lagret lisens
 */
export async function clearLicense() {
  const s = await getStore();
  await s.delete(LICENSE_STORE_KEY);
  await s.save();
}

/**
 * Valider en lisensnøkkel mot Keygen API
 */
export async function validateLicense(licenseKey) {
  try {
    const response = await fetch(`${KEYGEN_API_URL}/licenses/actions/validate-key`, {
      method: "POST",
      headers: {
        "Content-Type": "application/vnd.api+json",
        "Accept": "application/vnd.api+json",
      },
      body: JSON.stringify({
        meta: {
          key: licenseKey,
          scope: {
            product: KEYGEN_PRODUCT_ID,
          },
        },
      }),
    });

    const data = await response.json();

    if (data.meta?.valid) {
      const licenseData = {
        key: licenseKey,
        valid: true,
        licenseId: data.data?.id,
        name: data.data?.attributes?.name,
        expiry: data.data?.attributes?.expiry,
        status: data.data?.attributes?.status,
      };
      await storeLicense(licenseData);
      return { success: true, license: licenseData };
    } else {
      return {
        success: false,
        error: translateError(data.meta?.code || "UNKNOWN"),
      };
    }
  } catch (error) {
    // Nettverksfeil - sjekk om vi har cached lisens
    const cached = await getStoredLicense();
    if (cached && isOfflineGracePeriodValid(cached)) {
      return {
        success: true,
        license: cached,
        offline: true,
      };
    }
    return {
      success: false,
      error: "Kunne ikke koble til lisensserver. Sjekk internettilkobling.",
    };
  }
}

/**
 * Sjekk om appen har gyldig lisens (cached eller online)
 */
export async function checkLicense() {
  const cached = await getStoredLicense();

  if (!cached?.key) {
    return { valid: false, reason: "NO_LICENSE" };
  }

  // Prøv å validere online
  const result = await validateLicense(cached.key);

  if (result.success) {
    return {
      valid: true,
      license: result.license,
      offline: result.offline || false,
    };
  }

  // Sjekk offline grace period
  if (cached && isOfflineGracePeriodValid(cached)) {
    return {
      valid: true,
      license: cached,
      offline: true,
      offlineDaysLeft: getOfflineDaysLeft(cached),
    };
  }

  return { valid: false, reason: result.error || "INVALID" };
}

/**
 * Sjekk om offline grace period fortsatt er gyldig
 */
function isOfflineGracePeriodValid(cachedLicense) {
  if (!cachedLicense?.cachedAt) return false;

  const cachedDate = new Date(cachedLicense.cachedAt);
  const now = new Date();
  const daysSinceCached = (now - cachedDate) / (1000 * 60 * 60 * 24);

  return daysSinceCached <= OFFLINE_GRACE_DAYS;
}

/**
 * Få antall dager igjen av offline grace period
 */
function getOfflineDaysLeft(cachedLicense) {
  if (!cachedLicense?.cachedAt) return 0;

  const cachedDate = new Date(cachedLicense.cachedAt);
  const now = new Date();
  const daysSinceCached = (now - cachedDate) / (1000 * 60 * 60 * 24);

  return Math.max(0, Math.ceil(OFFLINE_GRACE_DAYS - daysSinceCached));
}

/**
 * Oversett Keygen feilkoder til norsk
 */
function translateError(code) {
  const errors = {
    NOT_FOUND: "Lisensnøkkel ikke funnet",
    SUSPENDED: "Lisensen er suspendert",
    EXPIRED: "Lisensen har utløpt",
    OVERDUE: "Lisensen er forfalt",
    NO_MACHINE: "Lisensen er ikke aktivert på denne maskinen",
    NO_MACHINES: "Ingen aktiverte maskiner",
    TOO_MANY_MACHINES: "For mange maskiner aktivert",
    TOO_MANY_CORES: "For mange CPU-kjerner",
    TOO_MANY_PROCESSES: "For mange prosesser",
    FINGERPRINT_SCOPE_MISMATCH: "Maskin-ID stemmer ikke",
    HEARTBEAT_NOT_STARTED: "Heartbeat ikke startet",
    HEARTBEAT_DEAD: "Heartbeat stoppet",
    PRODUCT_SCOPE_MISMATCH: "Feil produkt",
    POLICY_SCOPE_MISMATCH: "Feil policy",
    MACHINE_SCOPE_MISMATCH: "Feil maskin",
    ENTITLEMENTS_MISSING: "Manglende rettigheter",
    ENTITLEMENTS_SCOPE_MISMATCH: "Feil rettigheter",
    UNKNOWN: "Ukjent feil",
  };
  return errors[code] || `Feil: ${code}`;
}
