# Release Guide

Hvordan slippe nye versjoner av Assistio Trygghetsalarm.

## Quick Release

```powershell
.\release.ps1 1.0.3
```

Ferdig! GitHub bygger og releaser automatisk.

## Hva skjer?

```
.\release.ps1 1.0.3
        │
        ▼
┌─────────────────────────────┐
│ 1. Oppdaterer versjon i     │
│    - tauri.conf.json        │
│    - package.json           │
│                             │
│ 2. Git commit + tag + push  │
└─────────────────────────────┘
        │
        ▼
┌─────────────────────────────┐
│ GitHub Actions              │
│ - Bygger app                │
│ - Signerer                  │
│ - Lager release             │
│ - Laster opp installer      │
└─────────────────────────────┘
        │
        ▼
┌─────────────────────────────┐
│ Brukere                     │
│ "Ny versjon tilgjengelig!"  │
└─────────────────────────────┘
```

## Sjekk status

Se byggestatus: https://github.com/AssistioAS/assistio-trygghetsalarm/actions

Se releases: https://github.com/AssistioAS/assistio-trygghetsalarm/releases

## Manuell release (alternativ)

Hvis du vil gjøre det steg for steg:

```powershell
# 1. Oppdater versjon manuelt i tauri.conf.json og package.json

# 2. Commit, tag og push
git add .
git commit -m "Release v1.0.3"
git tag v1.0.3
git push
git push --tags
```

## Lokal bygging (uten GitHub Actions)

For testing eller debugging:

```powershell
# Sett miljøvariabler
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content ".\~\.tauri\assistio.key" -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "ditt-passord"

# Bygg
npm run tauri:build

# Filer ligger i:
# src-tauri/target/release/bundle/nsis/
# src-tauri/target/release/bundle/msi/
```

## Versjonering

Bruk [Semantic Versioning](https://semver.org/):

| Endring | Versjon | Eksempel |
|---------|---------|----------|
| Bugfix | x.x.PATCH | 1.0.0 → 1.0.1 |
| Ny funksjon | x.MINOR.0 | 1.0.1 → 1.1.0 |
| Breaking change | MAJOR.0.0 | 1.1.0 → 2.0.0 |

## Feilsøking

### GitHub Actions feiler

1. Gå til Actions-fanen
2. Klikk på feilet workflow
3. Se loggene for detaljer

Vanlige problemer:
- **Secrets mangler**: Sjekk at `TAURI_PRIVATE_KEY` og `TAURI_KEY_PASSWORD` er satt
- **Rust-feil**: Kjør `npm run tauri:build` lokalt for å se feilmeldinger

### Brukere får ikke oppdatering

Sjekk at:
1. `latest.json` er lastet opp i release
2. URL i `tauri.conf.json` matcher GitHub-repo
3. Ny versjon er høyere enn installert versjon

## Secrets (GitHub)

Secrets ligger i: Repository → Settings → Secrets → Actions

| Secret | Beskrivelse |
|--------|-------------|
| `TAURI_PRIVATE_KEY` | Innholdet av `~\.tauri\assistio.key` |
| `TAURI_KEY_PASSWORD` | Passord for signeringsnøkkel |

## Filer

| Fil | Beskrivelse |
|-----|-------------|
| `release.ps1` | Release-script |
| `.github/workflows/release.yml` | GitHub Actions workflow |
| `src-tauri/tauri.conf.json` | App-versjon og updater-config |
| `~\.tauri\assistio.key` | Signeringsnøkkel (ALDRI commit!) |
