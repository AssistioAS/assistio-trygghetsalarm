# Hepro/Skyresponse nettverksfeilsoking

Denne appen henter trygghetsalarmer fra Hepro/Skyresponse via native Tauri/Rust-backend.

## Status per v1.0.14

Det er bekreftet at appen kan synkronisere mot Hepro pa en jobb-PC i samme kommune som ikke star bak Helsenett. Hvis Hepro apnes fint i Firefox pa en PC bak Helsenett, men appen ikke sender foresporsel eller ikke logger forventet sync, er problemet mest sannsynlig lokalt nettverksoppsett:

- proxy/PAC/WPAD som Firefox eller Windows bruker, men som Rust-klienten ikke automatisk loser
- SSL-inspeksjon med kommunal/Helsenett-sertifikatkjede
- brannmur/policy pa aktuell maskin eller nettverkssone
- manglende manuell proxy i appens nettverksinnstillinger

## Ny diagnostikk i v1.0.14

Ga til `Innstillinger` og bruk `Test Hepro-tilkobling`.

Testen gjor bare login-token-kallet mot Hepro/Skyresponse. Den fullforer ikke full import. Resultatet viser:

- om login-token ble hentet
- hvilken `settings.json` backend faktisk bruker
- sti til `app.log`

Backend logger ogsa Windows Internet Settings:

- `ProxyEnable`
- `ProxyServer`
- `AutoConfigURL`
- `AutoDetect`

Hvis `ProxyServer` finnes og `Bruk systemets proxy-innstillinger` er aktivert, bruker appen den statiske Windows-proxyen automatisk.

Hvis loggen viser `AutoConfigURL` eller `AutoDetect`, men ingen `ProxyServer`, bruker PC-en trolig PAC/WPAD. Da ma den faktiske proxyen som Firefox/Windows loser frem, legges inn manuelt i appen.

## Fremgangsmate pa jobb-PC bak Helsenett

1. Oppdater til minst `v1.0.14`.
2. Apne `Innstillinger`.
3. Kontroller brukernavn/passord og base-URL: `https://hepro.skyresponse.com`.
4. La `Bruk systemets proxy-innstillinger` sta aktivert.
5. Trykk `Test Hepro-tilkobling`.
6. Hvis testen feiler, apne loggfilen som vises i appen.

## Tolkning av vanlige feil

| Symptom | Sannsynlig arsak | Tiltak |
|---|---|---|
| Firefox apner Hepro, appen feiler med connect/timeout | Firefox bruker proxy/PAC som appen ikke far automatisk | Finn faktisk proxy og legg den inn under `Manuell proxy` |
| Feil nevner certificate/SSL/TLS/schannel | SSL-inspeksjon eller manglende rotsertifikat | Prov `Godta SSL-inspeksjon`; hvis det ikke hjelper, fa IT til a legge korrekt CA i Windows Certificate Store |
| Logg viser `ProxyServer` | Statisk proxy finnes | Appen skal bruke denne automatisk fra v1.0.14 |
| Logg viser `AutoConfigURL` eller `AutoDetect`, men ingen `ProxyServer` | PAC/WPAD | Finn proxy via Firefox/IT og legg inn manuelt |
| `Settings file not found` | Backend leser ikke samme innstillinger som UI | Skal vaere rettet i v1.0.14 ved at backend bruker Tauri `appDataDir` |

## Finne proxy fra Firefox

I Firefox:

1. Apne `Innstillinger`.
2. Sok etter `Nettverksinnstillinger`.
3. Trykk `Innstillinger...`.
4. Se om Firefox bruker `Bruk systemets proxyinnstillinger`, automatisk proxy-konfigurasjonsadresse, eller manuell HTTP/HTTPS-proxy.

Hvis det star en automatisk proxy-konfigurasjonsadresse, ma IT eller nettverksansvarlig hjelpe med den faktiske proxy-host/port som skal brukes for `https://hepro.skyresponse.com`.

## Informasjon IT kan trenge

Appen ma kunne na:

- Host: `hepro.skyresponse.com`
- Protokoll: HTTPS
- Port: `443`
- API-stier: `/api/v2/token`, `/api/v2/reports/generate`, `/api/v2/reports/download/...`

Appen bruker native Windows TLS via Rust `reqwest`/`native-tls`. Sertifikater leses fra Windows Certificate Store.

## Viktig skille

At Hepro virker i Firefox beviser at Hepro og nettverket kan fungere, men ikke nodvendigvis at Tauri/Rust-backenden har samme proxy- og sertifikatoppsett som nettleseren.
