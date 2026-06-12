# Tauri Auto-Update med GitHub Releases

Guide for å sette opp automatisk oppdatering i Tauri-apper med GitHub Releases som backend.

## Oversikt

```
┌─────────────────┐      ┌──────────────────────────┐
│   Brukerens app │ ───► │  GitHub Releases         │
│   v1.0.0        │      │  - latest.json           │
│                 │ ◄─── │  - app_1.1.0.msi.zip     │
│   "Ny versjon!" │      │  - app_1.1.0.msi.zip.sig │
└─────────────────┘      └──────────────────────────┘
```

## Steg 1: Installer avhengigheter

### Rust (Cargo.toml)
```toml
[dependencies]
tauri-plugin-updater = "2"
tauri-plugin-process = "2"
```

### JavaScript (package.json)
```bash
npm install @tauri-apps/plugin-updater @tauri-apps/plugin-process
```

## Steg 2: Aktiver plugins i Rust

I `src-tauri/src/lib.rs` (eller `main.rs`):

```rust
pub fn run() {
    tauri::Builder::default()
        // ... andre plugins
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // ...
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

## Steg 3: Generer signeringsnøkkel

```bash
npx tauri signer generate -w ~/.tauri/myapp.key
```

- Velg et sterkt passord og **husk det**
- Kommandoen viser en **offentlig nøkkel** (starter med `dW5...`)
- Privat nøkkel lagres i `~/.tauri/myapp.key` - **hold denne hemmelig!**

## Steg 4: Konfigurer tauri.conf.json

Legg til `plugins`-seksjon:

```json
{
  "plugins": {
    "updater": {
      "pubkey": "DIN_OFFENTLIGE_NØKKEL_HER",
      "endpoints": [
        "https://github.com/AssistioAS/REPO-NAVN/releases/latest/download/latest.json"
      ]
    }
  }
}
```

Bytt ut:
- `DIN_OFFENTLIGE_NØKKEL_HER` med nøkkelen fra steg 3
- `REPO-NAVN` med ditt repository-navn

## Steg 5: Legg til update-sjekk i React

```jsx
import { useCallback, useEffect, useState } from "react";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export default function App() {
  const [updateAvailable, setUpdateAvailable] = useState(null);
  const [updateProgress, setUpdateProgress] = useState(null);

  // Sjekk etter oppdateringer ved oppstart
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
  const handleInstallUpdate = useCallback(async () => {
    if (!updateAvailable) return;
    try {
      setUpdateProgress("Laster ned...");
      await updateAvailable.downloadAndInstall((event) => {
        if (event.event === "Started") {
          setUpdateProgress("Laster ned... 0%");
        } else if (event.event === "Progress") {
          const percent = Math.round(
            (event.data.chunkLength / event.data.contentLength) * 100
          );
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

  return (
    <div>
      {updateAvailable && (
        <div className="update-banner">
          <span>Ny versjon: {updateAvailable.version}</span>
          {updateProgress ? (
            <span>{updateProgress}</span>
          ) : (
            <button onClick={handleInstallUpdate}>Oppdater nå</button>
          )}
        </div>
      )}
      {/* Resten av appen */}
    </div>
  );
}
```

## Steg 6: Bygg med signering

### Windows (PowerShell)
```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content ~/.tauri/myapp.key -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "ditt-passord"
npm run tauri:build
```

### macOS/Linux (Bash)
```bash
export TAURI_SIGNING_PRIVATE_KEY=$(cat ~/.tauri/myapp.key)
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="ditt-passord"
npm run tauri:build
```

## Steg 7: Last opp til GitHub Release

Etter bygg finner du filene i `src-tauri/target/release/bundle/`:

| Fil | Beskrivelse |
|-----|-------------|
| `App_x.x.x_x64-setup.exe` | Windows installer (NSIS) |
| `App_x.x.x_x64_en-US.msi.zip` | Windows MSI (zippet) |
| `App_x.x.x_x64_en-US.msi.zip.sig` | Signatur for MSI |
| `latest.json` | Versjonsinformasjon |

### Opprett GitHub Release:
1. Gå til repo → Releases → "Create a new release"
2. Tag: `v1.0.0` (match versjon i tauri.conf.json)
3. Last opp:
   - `*.msi.zip`
   - `*.msi.zip.sig`
   - `latest.json`
4. Publiser release

## Workflow for nye versjoner

1. **Oppdater versjon** i både `tauri.conf.json` og `package.json`
2. **Bygg** med signeringsnøkler (steg 6)
3. **Opprett ny GitHub Release** med filene
4. **Brukere ser automatisk** "Ny versjon tilgjengelig!" ved neste oppstart

## Filstruktur etter oppsett

```
prosjekt/
├── package.json              # +@tauri-apps/plugin-updater, plugin-process
├── src/
│   └── App.jsx               # +update-sjekk logikk
└── src-tauri/
    ├── Cargo.toml            # +tauri-plugin-updater, process
    ├── tauri.conf.json       # +plugins.updater config
    └── src/
        └── lib.rs            # +plugin registrering
```

## Feilsøking

### "Kunne ikke sjekke oppdateringer"
- Sjekk at GitHub-URL i `endpoints` er korrekt
- Verifiser at `latest.json` er lastet opp til release

### Signatur-feil
- Sjekk at `pubkey` i config matcher nøkkelen du genererte
- Verifiser at `.sig`-filen er lastet opp sammen med `.msi.zip`

### Update vises ikke
- Sjekk at versjon i release er **høyere** enn installert versjon
- Sjekk nettverkstilgang til GitHub

## Lenker

- [Tauri Updater Plugin Docs](https://v2.tauri.app/plugin/updater/)
- [GitHub Releases](https://docs.github.com/en/repositories/releasing-projects-on-github)
