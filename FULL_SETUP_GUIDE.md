# Komplett Oppsett: Tauri + Auto-Update + Lisensiering

Alt du trenger for å sette opp en Tauri-app med automatisk oppdatering via GitHub Releases og lisensiering via Keygen.sh.

## Oversikt

```
┌─────────────────────────────────────────────────────────────┐
│                        Din App                               │
├─────────────────────────────────────────────────────────────┤
│  Auto-Update          │  Lisensiering      │  Auto-Sync     │
│  ✓ GitHub Releases    │  ✓ Keygen.sh       │  ✓ Intervall   │
│  ✓ Signert            │  ✓ Offline-støtte  │  ✓ Bakgrunn    │
└─────────────────────────────────────────────────────────────┘
```

---

## Del 1: Auto-Update med GitHub Releases

### 1.1 Installer avhengigheter

**Rust (Cargo.toml):**
```toml
[dependencies]
tauri-plugin-updater = "2"
tauri-plugin-process = "2"
```

**JavaScript (package.json):**
```bash
npm install @tauri-apps/plugin-updater @tauri-apps/plugin-process
```

### 1.2 Aktiver plugins (lib.rs)

```rust
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // ... andre plugins
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

### 1.3 Legg til permissions (capabilities/default.json)

**VIKTIG!** Uten dette får du "updater.check not allowed" feil.

```json
{
  "permissions": [
    "core:default",
    "updater:default",
    "process:default"
    // ... andre permissions
  ]
}
```

### 1.4 Generer signeringsnøkkel

```bash
npx tauri signer generate -w ~/.tauri/myapp.key
```

- Husk passordet!
- Lagre nøkkelen trygt (ALDRI commit til git)
- Kopier den offentlige nøkkelen (vises i output)

### 1.5 Konfigurer updater (tauri.conf.json)

```json
{
  "bundle": {
    "createUpdaterArtifacts": true
  },
  "plugins": {
    "updater": {
      "pubkey": "DIN_OFFENTLIGE_NØKKEL",
      "endpoints": [
        "https://github.com/OWNER/REPO/releases/latest/download/latest.json"
      ]
    }
  }
}
```

### 1.6 React-kode for oppdateringssjekk

```jsx
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

// Sjekk ved oppstart
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

// Installer oppdatering
const handleInstallUpdate = async () => {
  await updateAvailable.downloadAndInstall();
  await relaunch();
};
```

---

## Del 2: GitHub Actions for Automatisk Release

### 2.1 Opprett workflow (.github/workflows/release.yml)

```yaml
name: Release

on:
  push:
    tags:
      - 'v*'

permissions:
  contents: write

jobs:
  build:
    runs-on: windows-latest

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Setup Rust
        uses: dtolnay/rust-toolchain@stable

      - name: Install dependencies
        run: npm ci

      - name: Build and release
        uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_KEY_PASSWORD }}
        with:
          tagName: ${{ github.ref_name }}
          releaseName: '${{ github.ref_name }}'
          releaseBody: 'Se endringer i commit-historikken.'
          releaseDraft: false
          prerelease: false
          includeUpdaterJson: true
```

### 2.2 Legg til "tauri" script i package.json

**VIKTIG!** Tauri-action forventer dette scriptet.

```json
{
  "scripts": {
    "tauri": "tauri",
    "tauri:dev": "tauri dev",
    "tauri:build": "tauri build"
  }
}
```

### 2.3 Legg til Secrets i GitHub

Gå til: Repository → Settings → Secrets → Actions

| Secret | Verdi |
|--------|-------|
| `TAURI_PRIVATE_KEY` | Innholdet av signeringsnøkkel-filen |
| `TAURI_KEY_PASSWORD` | Passordet du valgte |

**NB:** Secret-navn kan kun inneholde bokstaver, tall og understrek.

### 2.4 Gjør repoet offentlig

**VIKTIG!** Private repos krever autentisering for å laste ned filer.

Appen kan ikke hente `latest.json` fra private repos uten token.

Løsning: Gjør repoet offentlig (Secrets forblir hemmelige).

### 2.5 Release-script (release.ps1)

```powershell
param(
    [Parameter(Mandatory=$true)]
    [string]$version
)

# Oppdater versjon i konfig-filer
$tauriConf = Get-Content "src-tauri/tauri.conf.json" -Raw | ConvertFrom-Json
$tauriConf.version = $version
$tauriConf | ConvertTo-Json -Depth 10 | Set-Content "src-tauri/tauri.conf.json"

$packageJson = Get-Content "package.json" -Raw | ConvertFrom-Json
$packageJson.version = $version
$packageJson | ConvertTo-Json -Depth 10 | Set-Content "package.json"

Write-Host "Versjon oppdatert til $version" -ForegroundColor Green

# Git commit og tag
git add .
git commit -m "Release v$version"
git tag "v$version"
git push
git push --tags

Write-Host "Release v$version startet!" -ForegroundColor Cyan
```

**Bruk:**
```powershell
.\release.ps1 1.0.7
```

---

## Del 3: Lisensiering med Keygen.sh

### 3.1 Opprett Keygen-konto

1. Gå til [keygen.sh](https://keygen.sh) (gratis for 25 lisenser)
2. Velg **Licensing** (ikke Distribution)
3. Opprett **Policy** (mal for lisenser)
4. Opprett **Product**
5. Noter **Account ID** og **Product ID**

### 3.2 Lisensmodul (src/licensing/keygen.js)

```javascript
import { Store } from "@tauri-apps/plugin-store";

const KEYGEN_ACCOUNT_ID = "din-account-id";
const KEYGEN_PRODUCT_ID = "din-product-id";
const OFFLINE_GRACE_DAYS = 7;

const KEYGEN_API_URL = `https://api.keygen.sh/v1/accounts/${KEYGEN_ACCOUNT_ID}`;

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
    return data.meta?.valid;
  } catch (error) {
    // Offline - sjekk cached lisens
    return checkOfflineGracePeriod();
  }
}
```

### 3.3 Administrasjon

- **Suspender kunde:** Licenses → Klikk lisens → Suspend
- **Gjenopprett:** Licenses → Klikk lisens → Reinstate
- **Ny lisens:** Licenses → New License → Velg Policy

---

## Del 4: Vanlige feil og løsninger

### Hepro/Skyresponse virker i Firefox, men ikke i appen

Se `HEPRO_NETWORK_TROUBLESHOOTING.md`.

Kortversjon: Firefox kan bruke proxy/PAC/WPAD eller sertifikater som Tauri/Rust-backenden ikke automatisk får brukt. Fra `v1.0.14` finnes `Test Hepro-tilkobling` under `Innstillinger`. Testen viser loggsti, og backend logger Windows proxyinnstillinger (`ProxyServer`, `AutoConfigURL`, `AutoDetect`).

### "updater.check not allowed"
**Løsning:** Legg til `"updater:default"` og `"process:default"` i capabilities/default.json

### "Missing script: tauri"
**Løsning:** Legg til `"tauri": "tauri"` i package.json scripts

### "Resource not accessible by integration"
**Løsning:** Legg til `permissions: contents: write` i workflow

### "Could not fetch a valid release JSON"
**Løsninger:**
1. Sjekk at repoet er offentlig
2. Sjekk at `includeUpdaterJson: true` er satt i workflow
3. Sjekk at `createUpdaterArtifacts: true` er satt i tauri.conf.json

### "unexpected argument 'build' found"
**Løsning:** Ikke bruk `tauriScript` med build - la tauri-action håndtere det

### Dev-versjon viser ikke oppdateringer
**Forventet oppførsel.** Kun installerte versjoner sjekker oppdateringer.

---

## Del 5: Sjekkliste for nytt prosjekt

### Oppsett
- [ ] Installer tauri-plugin-updater og tauri-plugin-process
- [ ] Aktiver plugins i lib.rs
- [ ] Legg til permissions i capabilities/default.json
- [ ] Generer signeringsnøkkel
- [ ] Konfigurer updater i tauri.conf.json
- [ ] Sett `createUpdaterArtifacts: true` i bundle
- [ ] Legg til `"tauri": "tauri"` i package.json scripts

### GitHub
- [ ] Opprett GitHub repo (offentlig)
- [ ] Legg til Secrets (TAURI_PRIVATE_KEY, TAURI_KEY_PASSWORD)
- [ ] Opprett .github/workflows/release.yml
- [ ] Sett `permissions: contents: write` i workflow
- [ ] Sett `includeUpdaterJson: true` i workflow

### Keygen (valgfritt)
- [ ] Opprett Keygen-konto
- [ ] Opprett Policy og Product
- [ ] Implementer lisenssjekk i appen

### Test
- [ ] Kjør første release med `.\release.ps1 1.0.0`
- [ ] Installer appen
- [ ] Kjør ny release med `.\release.ps1 1.0.1`
- [ ] Verifiser at "Ny versjon tilgjengelig" vises

---

## Filstruktur

```
prosjekt/
├── .github/
│   └── workflows/
│       └── release.yml        # GitHub Actions
├── src/
│   ├── licensing/
│   │   └── keygen.js          # Lisensmodul
│   ├── components/
│   │   └── LicenseActivation.jsx
│   └── App.jsx                # Update-sjekk
├── src-tauri/
│   ├── capabilities/
│   │   └── default.json       # Permissions (VIKTIG!)
│   ├── src/
│   │   └── lib.rs             # Plugin-registrering
│   └── tauri.conf.json        # Updater-config
├── package.json               # "tauri" script
├── release.ps1                # Release-script
└── ~/.tauri/myapp.key         # Signeringsnøkkel (ALDRI commit!)
```

---

## Lenker

- [Tauri Updater Plugin](https://v2.tauri.app/plugin/updater/)
- [Tauri GitHub Action](https://github.com/tauri-apps/tauri-action)
- [Keygen.sh Docs](https://keygen.sh/docs/api/)
- [GitHub Actions Secrets](https://docs.github.com/en/actions/security-guides/encrypted-secrets)
