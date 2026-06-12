# Keygen.sh Lisensiering

Guide for lisensiering med Keygen.sh i Tauri-apper.

## Oversikt

```
┌─────────────────┐      ┌──────────────────────┐
│   App starter   │ ───► │  Keygen.sh API       │
│                 │      │  "Er lisensen gyldig?"│
│   Lisens: ABC123│ ◄─── │  ✓ Ja / ✗ Nei        │
└─────────────────┘      └──────────────────────┘
         │
         ▼
    Lagrer resultat lokalt
    (fungerer offline i 7 dager)
```

## Keygen.sh oppsett

### 1. Opprett konto
- Gå til [keygen.sh](https://keygen.sh)
- Registrer deg (gratis for opptil 25 lisenser)
- Velg **Licensing** (ikke Distribution)

### 2. Opprett Policy
Policies er "maler" for lisenser.

1. **Policies → New Policy**
2. Konfigurer:
   - **Name**: f.eks. "Standard", "Pro", "Trial"
   - **Duration**: Tom = evigvarende, eller antall sekunder
   - **Max Machines**: Antall maskiner per lisens (f.eks. 1-3)
3. **Create Policy**

### 3. Opprett lisenser
1. **Licenses → New License**
2. Velg **Policy**
3. **Create License**
4. Kopier lisensnøkkelen som genereres

### 4. Hent API-verdier
- **Account ID**: Settings → Account ID (øverst)
- **Product ID**: Products → klikk produkt → kopier ID

## Kode-implementasjon

### Filstruktur
```
src/
├── licensing/
│   └── keygen.js         # API-modul
├── components/
│   └── LicenseActivation.jsx  # Aktiverings-UI
└── App.jsx               # Integrert lisenssjekk
```

### 1. Lisensmodul (`src/licensing/keygen.js`)

```javascript
import { Store } from "@tauri-apps/plugin-store";

// Konfigurasjon
const KEYGEN_ACCOUNT_ID = "din-account-id";
const KEYGEN_PRODUCT_ID = "din-product-id";
const OFFLINE_GRACE_DAYS = 7;

const KEYGEN_API_URL = `https://api.keygen.sh/v1/accounts/${KEYGEN_ACCOUNT_ID}`;

let store = null;

async function getStore() {
  if (!store) {
    store = await Store.load("license.json");
  }
  return store;
}

// Hent lagret lisens
export async function getStoredLicense() {
  const s = await getStore();
  return await s.get("license") || null;
}

// Lagre lisens lokalt
async function storeLicense(licenseData) {
  const s = await getStore();
  await s.set("license", {
    ...licenseData,
    cachedAt: new Date().toISOString(),
  });
  await s.save();
}

// Slett lisens
export async function clearLicense() {
  const s = await getStore();
  await s.delete("license");
  await s.save();
}

// Valider lisensnøkkel mot API
export async function validateLicense(licenseKey) {
  try {
    const response = await fetch(
      `${KEYGEN_API_URL}/licenses/actions/validate-key`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/vnd.api+json",
          Accept: "application/vnd.api+json",
        },
        body: JSON.stringify({
          meta: {
            key: licenseKey,
            scope: { product: KEYGEN_PRODUCT_ID },
          },
        }),
      }
    );

    const data = await response.json();

    if (data.meta?.valid) {
      const licenseData = {
        key: licenseKey,
        valid: true,
        licenseId: data.data?.id,
        name: data.data?.attributes?.name,
        status: data.data?.attributes?.status,
      };
      await storeLicense(licenseData);
      return { success: true, license: licenseData };
    } else {
      return { success: false, error: data.meta?.code || "INVALID" };
    }
  } catch (error) {
    // Nettverksfeil - sjekk cached lisens
    const cached = await getStoredLicense();
    if (cached && isOfflineValid(cached)) {
      return { success: true, license: cached, offline: true };
    }
    return { success: false, error: "Ingen nettverkstilkobling" };
  }
}

// Sjekk om app har gyldig lisens
export async function checkLicense() {
  const cached = await getStoredLicense();

  if (!cached?.key) {
    return { valid: false, reason: "NO_LICENSE" };
  }

  const result = await validateLicense(cached.key);

  if (result.success) {
    return {
      valid: true,
      license: result.license,
      offline: result.offline || false,
      offlineDaysLeft: getOfflineDaysLeft(cached),
    };
  }

  // Sjekk offline grace period
  if (cached && isOfflineValid(cached)) {
    return {
      valid: true,
      license: cached,
      offline: true,
      offlineDaysLeft: getOfflineDaysLeft(cached),
    };
  }

  return { valid: false, reason: result.error };
}

function isOfflineValid(cached) {
  if (!cached?.cachedAt) return false;
  const days = (new Date() - new Date(cached.cachedAt)) / (1000 * 60 * 60 * 24);
  return days <= OFFLINE_GRACE_DAYS;
}

function getOfflineDaysLeft(cached) {
  if (!cached?.cachedAt) return 0;
  const days = (new Date() - new Date(cached.cachedAt)) / (1000 * 60 * 60 * 24);
  return Math.max(0, Math.ceil(OFFLINE_GRACE_DAYS - days));
}
```

### 2. Aktiverings-UI (`src/components/LicenseActivation.jsx`)

```jsx
import { useState } from "react";
import { validateLicense } from "../licensing/keygen.js";

export default function LicenseActivation({ onActivated }) {
  const [licenseKey, setLicenseKey] = useState("");
  const [error, setError] = useState(null);
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    try {
      const result = await validateLicense(licenseKey.trim());
      if (result.success) {
        onActivated(result.license);
      } else {
        setError(result.error);
      }
    } catch (err) {
      setError("Noe gikk galt");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      <input
        type="text"
        value={licenseKey}
        onChange={(e) => setLicenseKey(e.target.value)}
        placeholder="XXXX-XXXX-XXXX-XXXX"
      />
      {error && <div className="error">{error}</div>}
      <button type="submit" disabled={isLoading}>
        {isLoading ? "Aktiverer..." : "Aktiver lisens"}
      </button>
    </form>
  );
}
```

### 3. Integrasjon i App.jsx

```jsx
import { useEffect, useState } from "react";
import { checkLicense } from "./licensing/keygen.js";
import LicenseActivation from "./components/LicenseActivation.jsx";

export default function App() {
  const [licenseStatus, setLicenseStatus] = useState({ checking: true });

  useEffect(() => {
    async function verify() {
      const result = await checkLicense();
      setLicenseStatus({
        checking: false,
        valid: result.valid,
        license: result.license,
        offline: result.offline,
        offlineDaysLeft: result.offlineDaysLeft,
      });
    }
    verify();
  }, []);

  if (licenseStatus.checking) {
    return <div>Sjekker lisens...</div>;
  }

  if (!licenseStatus.valid) {
    return (
      <LicenseActivation
        onActivated={(license) =>
          setLicenseStatus({ checking: false, valid: true, license })
        }
      />
    );
  }

  return (
    <div>
      {licenseStatus.offline && (
        <div className="warning">
          Offline-modus: {licenseStatus.offlineDaysLeft} dager igjen
        </div>
      )}
      {/* Resten av appen */}
    </div>
  );
}
```

## Administrasjon i Keygen Dashboard

### Se lisenser
**Licenses** → Viser alle lisenser med status og sist validert

### Suspendere kunde
1. **Licenses** → Klikk på lisensen
2. **Suspend**
3. Bruker blokkeres ved neste online-sjekk (eller etter 7 dager offline)

### Gjenopprette kunde
1. **Licenses** → Klikk på lisensen
2. **Reinstate**

### Slette lisens
1. **Licenses** → Klikk på lisensen
2. **Delete** (permanent)

## Flyt for brukere

```
App starter
    │
    ▼
Har lagret lisens? ──Nei──► Vis aktiveringsside
    │                              │
   Ja                              ▼
    │                        Bruker skriver inn nøkkel
    ▼                              │
Valider mot API                    ▼
    │                        Gyldig? ──Nei──► Vis feil
    ▼                              │
Gyldig? ──Ja──► Vis appen         Ja
    │                              │
   Nei                             ▼
    │                        Lagre & vis appen
    ▼
Offline grace period?
    │
   Ja ──► Vis app med advarsel
    │
   Nei ──► Vis aktiveringsside
```

## Prising (Keygen.sh)

| Plan | Lisenser | Pris |
|------|----------|------|
| Free | 25 | $0 |
| Indie | 250 | $49/mnd |
| Business | 2500 | $249/mnd |
| Enterprise | Ubegrenset | Kontakt |

## Lenker

- [Keygen Dashboard](https://app.keygen.sh)
- [Keygen API Docs](https://keygen.sh/docs/api/)
- [Keygen License Validation](https://keygen.sh/docs/api/licenses/#licenses-actions-validate-key)
