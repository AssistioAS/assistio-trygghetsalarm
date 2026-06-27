//! Native Rust implementation of Hepro/Skyresponse API sync.
//! Replaces the Python scripts to eliminate external dependencies.

#![allow(dead_code)]

use base64::Engine;
use chrono::Utc;
use quick_xml::events::Event;
use quick_xml::Reader;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::Duration;
use zip::ZipArchive;

// ============================================================================
// Configuration Constants
// ============================================================================

const DEFAULT_BASE_URL: &str = "https://hepro.skyresponse.com";
const DOWNLOAD_RETRIES: u32 = 8;
const DOWNLOAD_RETRY_SECONDS: u64 = 2;
const SAFETY_REPORT_ID: i32 = 9;
const HEARTBEAT_REPORT_ID: i32 = 119;

// ============================================================================
// Data Structures
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProxySettings {
    /// Proxy URL (e.g., "http://proxy.helsenett.no:8080")
    #[serde(default)]
    pub url: String,
    /// Proxy username (optional, for authenticated proxies)
    #[serde(default)]
    pub username: String,
    /// Proxy password (optional, for authenticated proxies)
    #[serde(default)]
    pub password: String,
    /// Use system proxy settings (Windows IE/WinHTTP settings)
    #[serde(default = "default_true", rename = "useSystemProxy")]
    pub use_system_proxy: bool,
    /// Accept invalid/self-signed certificates (use with caution, for Helsenett SSL inspection)
    #[serde(default, rename = "acceptInvalidCerts")]
    pub accept_invalid_certs: bool,
}

fn default_true() -> bool {
    true
}

#[cfg(target_os = "windows")]
fn read_windows_internet_setting(name: &str) -> Option<String> {
    let output = Command::new("reg")
        .args([
            "query",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
            "/v",
            name,
        ])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        if !line.contains(name) {
            continue;
        }

        if let Some(value) = line.split_whitespace().last() {
            return Some(value.trim().to_string());
        }
    }

    None
}

#[cfg(target_os = "windows")]
fn proxy_enabled_from_windows() -> bool {
    read_windows_internet_setting("ProxyEnable")
        .map(|value| value.eq_ignore_ascii_case("0x1") || value == "1")
        .unwrap_or(false)
}

#[cfg(target_os = "windows")]
fn proxy_url_from_windows_proxy_server(proxy_server: &str) -> Option<String> {
    let raw = proxy_server.trim();
    if raw.is_empty() {
        return None;
    }

    let candidate = raw
        .split(';')
        .find_map(|part| {
            let part = part.trim();
            part.strip_prefix("https=")
                .or_else(|| part.strip_prefix("http="))
        })
        .unwrap_or(raw)
        .trim();

    if candidate.is_empty() || candidate.contains('=') {
        return None;
    }

    if candidate.starts_with("http://") || candidate.starts_with("https://") {
        Some(candidate.to_string())
    } else {
        Some(format!("http://{}", candidate))
    }
}

#[cfg(target_os = "windows")]
fn detect_windows_static_proxy_url() -> Option<String> {
    if !proxy_enabled_from_windows() {
        return None;
    }

    read_windows_internet_setting("ProxyServer")
        .and_then(|proxy_server| proxy_url_from_windows_proxy_server(&proxy_server))
}

#[cfg(target_os = "windows")]
fn log_windows_proxy_settings() {
    let proxy_enable = read_windows_internet_setting("ProxyEnable")
        .unwrap_or_else(|| "(not set)".to_string());
    let proxy_server = read_windows_internet_setting("ProxyServer")
        .unwrap_or_else(|| "(not set)".to_string());
    let auto_config_url = read_windows_internet_setting("AutoConfigURL")
        .unwrap_or_else(|| "(not set)".to_string());
    let auto_detect = read_windows_internet_setting("AutoDetect")
        .unwrap_or_else(|| "(not set)".to_string());

    log::info!("Windows Internet Settings:");
    log::info!("  - ProxyEnable: {}", proxy_enable);
    log::info!("  - ProxyServer: {}", proxy_server);
    log::info!("  - AutoConfigURL: {}", auto_config_url);
    log::info!("  - AutoDetect: {}", auto_detect);

    if proxy_server == "(not set)" && (auto_config_url != "(not set)" || auto_detect == "0x1") {
        log::warn!(
            "Windows appears to use PAC/WPAD proxy discovery. Enter the resolved proxy manually in the app if Hepro works in the browser but not here."
        );
    }
}

#[cfg(not(target_os = "windows"))]
fn detect_windows_static_proxy_url() -> Option<String> {
    None
}

#[cfg(not(target_os = "windows"))]
fn log_windows_proxy_settings() {}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiSettings {
    #[serde(rename = "baseUrl")]
    pub base_url: String,
    pub username: String,
    pub password: String,
    #[serde(rename = "reportId")]
    pub report_id: i32,
    #[serde(rename = "workspaceId")]
    pub workspace_id: String,
    #[serde(rename = "workspaceName")]
    pub workspace_name: String,
    #[serde(rename = "dataFilePath")]
    pub data_file_path: String,
    /// Proxy settings for enterprise networks (Helsenett)
    #[serde(default)]
    pub proxy: ProxySettings,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SafetyAlarmItem {
    pub id: String,
    #[serde(rename = "externalId")]
    pub external_id: String,
    pub name: String,
    pub address: String,
    #[serde(rename = "postalCode")]
    pub postal_code: String,
    pub city: String,
    pub phone: String,
    #[serde(rename = "nationalId")]
    pub national_id: String,
    #[serde(rename = "dispatchGroup")]
    pub dispatch_group: String,
    #[serde(rename = "keyInfo")]
    pub key_info: String,
    #[serde(rename = "isActive")]
    pub is_active: bool,
    #[serde(rename = "alarmStatus")]
    pub alarm_status: String,
    #[serde(rename = "sourceImportedAt")]
    pub source_imported_at: String,
    #[serde(rename = "sourceRowHash")]
    pub source_row_hash: String,
    #[serde(rename = "sourceProvider")]
    pub source_provider: String,
    #[serde(rename = "sourcePayload")]
    pub source_payload: HashMap<String, String>,
    #[serde(rename = "processStatus")]
    pub process_status: String,
    pub critical: bool,
    #[serde(rename = "criticalNote")]
    pub critical_note: String,
    #[serde(rename = "keyBoxStatus")]
    pub key_box_status: String,
    #[serde(rename = "keyBoxInstalledAt")]
    pub key_box_installed_at: Option<String>,
    #[serde(rename = "billingStatus")]
    pub billing_status: String,
    pub notes: String,
    #[serde(rename = "personId")]
    pub person_id: Option<String>,
    #[serde(rename = "personName")]
    pub person_name: String,
    #[serde(rename = "requestId")]
    pub request_id: Option<String>,
    #[serde(rename = "requestTitle")]
    pub request_title: String,
    #[serde(rename = "taskId")]
    pub task_id: Option<String>,
    #[serde(rename = "taskTitle")]
    pub task_title: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SafetyAlarmsData {
    #[serde(rename = "schemaVersion")]
    pub schema_version: i32,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    pub items: Vec<SafetyAlarmItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HeartbeatItem {
    #[serde(rename = "alarmIdentifier")]
    pub alarm_identifier: String,
    #[serde(rename = "apartmentLabel")]
    pub apartment_label: String,
    #[serde(rename = "lastHeartbeatAt")]
    pub last_heartbeat_at: String,
    #[serde(rename = "heartbeatSourceImportedAt")]
    pub heartbeat_source_imported_at: String,
    pub raw: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HeartbeatsData {
    #[serde(rename = "schemaVersion")]
    pub schema_version: i32,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    pub items: Vec<HeartbeatItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MetaData {
    #[serde(rename = "lastImportedAt")]
    pub last_imported_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SyncResult {
    pub success: bool,
    pub message: String,
    pub safety_alarms_created: i32,
    pub safety_alarms_updated: i32,
    pub safety_alarms_total: i32,
    pub heartbeats_created: i32,
    pub heartbeats_updated: i32,
    pub heartbeats_total: i32,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
}

#[derive(Debug, Serialize)]
struct ReportPayload {
    #[serde(rename = "reportArguments")]
    report_arguments: ReportArguments,
    #[serde(rename = "outputFormat")]
    output_format: String,
    #[serde(rename = "reportId")]
    report_id: i32,
}

#[derive(Debug, Serialize)]
struct ReportArguments {
    #[serde(rename = "runMode")]
    run_mode: String,
    #[serde(rename = "exactMatch")]
    exact_match: bool,
    #[serde(rename = "nameOnly")]
    name_only: bool,
    #[serde(rename = "entityIds")]
    entity_ids: Vec<String>,
    #[serde(rename = "searchText")]
    search_text: String,
}

// Column mappings for report ID 9
struct ColumnMap {
    name: &'static str,
    key_info: &'static str,
    national_id: &'static str,
    address: &'static str,
    postal_code: &'static str,
    city: &'static str,
    phone: &'static str,
    is_active: &'static str,
}

const REPORT_9_COLUMNS: ColumnMap = ColumnMap {
    name: "D",
    key_info: "H",
    national_id: "U",
    address: "Z",
    postal_code: "AA",
    city: "AB",
    phone: "AG",
    is_active: "BR",
};

// ============================================================================
// API Client
// ============================================================================

fn build_http_client(proxy_settings: &ProxySettings) -> Result<reqwest::blocking::Client, String> {
    // Log proxy configuration for debugging
    log::info!("Building HTTP client with proxy settings:");
    log::info!("  - Use system proxy: {}", proxy_settings.use_system_proxy);
    log::info!("  - Custom proxy URL: {}", if proxy_settings.url.is_empty() { "(none)" } else { &proxy_settings.url });
    log::info!("  - Accept invalid certs: {}", proxy_settings.accept_invalid_certs);
    log_windows_proxy_settings();

    // Log environment proxy variables
    if let Ok(proxy) = std::env::var("HTTPS_PROXY").or_else(|_| std::env::var("https_proxy")) {
        log::info!("  - HTTPS_PROXY env: {}", proxy);
    }
    if let Ok(proxy) = std::env::var("HTTP_PROXY").or_else(|_| std::env::var("http_proxy")) {
        log::info!("  - HTTP_PROXY env: {}", proxy);
    }

    let mut builder = reqwest::blocking::Client::builder()
        .use_native_tls()
        .timeout(Duration::from_secs(120))
        .connect_timeout(Duration::from_secs(30))
        // Use a browser-like User-Agent to avoid proxy filtering
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");

    // Configure proxy
    if !proxy_settings.url.is_empty() {
        // Use explicitly configured proxy
        log::info!("Configuring explicit proxy: {}", proxy_settings.url);
        let mut proxy = reqwest::Proxy::all(&proxy_settings.url)
            .map_err(|e| format!("Ugyldig proxy-URL '{}': {}", proxy_settings.url, e))?;

        // Add proxy authentication if provided
        if !proxy_settings.username.is_empty() {
            log::info!("Adding proxy authentication for user: {}", proxy_settings.username);
            proxy = proxy.basic_auth(&proxy_settings.username, &proxy_settings.password);
        }

        builder = builder.proxy(proxy);
    } else if proxy_settings.use_system_proxy {
        if let Some(proxy_url) = detect_windows_static_proxy_url() {
            log::info!("Configuring detected Windows static proxy: {}", proxy_url);
            let proxy = reqwest::Proxy::all(&proxy_url)
                .map_err(|e| format!("Ugyldig Windows proxy-URL '{}': {}", proxy_url, e))?;
            builder = builder.proxy(proxy);
        } else {
            log::info!(
                "No static Windows proxy detected. If the browser uses PAC/WPAD, enter the proxy manually."
            );
        }
    } else if !proxy_settings.use_system_proxy {
        // Disable all proxies (direct connection)
        log::info!("Disabling all proxies (direct connection)");
        builder = builder.no_proxy();
    }

    // Handle SSL certificate validation
    // WARNING: Only enable this for enterprise networks with SSL inspection (like Helsenett)
    if proxy_settings.accept_invalid_certs {
        log::warn!("SSL certificate validation is DISABLED - only use this in trusted enterprise networks");
        builder = builder.danger_accept_invalid_certs(true);
    }

    builder
        .build()
        .map_err(|e| format!("Kunne ikke opprette HTTP-klient: {}", e))
}

pub fn login_and_get_token(settings: &ApiSettings) -> Result<String, String> {
    log::info!("Logging in to Skyresponse...");
    let client = build_http_client(&settings.proxy)?;

    let url = format!("{}/api/v2/token", settings.base_url.trim_end_matches('/'));

    let params = [
        ("Username", settings.username.as_str()),
        ("Password", settings.password.as_str()),
        ("GrantType", "password"),
    ];

    log::info!("Connecting to Skyresponse API: {}", url);

    let response = client
        .post(&url)
        .form(&params)
        .send()
        .map_err(|e| {
            let error_msg = format!("{:?}", e);
            log::error!("Connection error details: {}", error_msg);

            if error_msg.contains("certificate") || error_msg.contains("ssl") || error_msg.contains("tls") || error_msg.contains("Certificate") {
                format!("SSL/TLS-feil: Bedriftsproxy eller brannmur blokkerer tilkoblingen. Kontakt IT-avdelingen for å åpne tilgang til hepro.skyresponse.com. Teknisk: {}", e)
            } else if error_msg.contains("dns") || error_msg.contains("resolve") || error_msg.contains("getaddrinfo") {
                format!("DNS-feil: Kunne ikke slå opp hepro.skyresponse.com. Sjekk nettverkstilkobling. Teknisk: {}", e)
            } else if error_msg.contains("connect") || error_msg.contains("Connection") {
                format!("Tilkoblingsfeil: Brannmur blokkerer kanskje utgående HTTPS. Kontakt IT for å åpne port 443 til hepro.skyresponse.com. Teknisk: {}", e)
            } else if error_msg.contains("timeout") || error_msg.contains("Timeout") {
                format!("Tidsavbrudd: Serveren svarer ikke. Kan skyldes treg forbindelse eller brannmur. Teknisk: {}", e)
            } else if error_msg.contains("proxy") || error_msg.contains("Proxy") {
                format!("Proxy-feil: Bedriftsproxy tillater ikke tilkoblingen. Kontakt IT. Teknisk: {}", e)
            } else {
                format!("Nettverksfeil ved tilkobling til Skyresponse: {}", e)
            }
        })?;

    if !response.status().is_success() {
        return Err(format!(
            "Login failed with status {}: {}",
            response.status(),
            response.text().unwrap_or_default()
        ));
    }

    let token_response: TokenResponse = response
        .json()
        .map_err(|e| format!("Failed to parse token response: {}", e))?;

    Ok(token_response.access_token)
}

pub fn generate_report_filename(token: &str, settings: &ApiSettings) -> Result<String, String> {
    let client = build_http_client(&settings.proxy)?;
    let url = format!(
        "{}/api/v2/reports/generate",
        settings.base_url.trim_end_matches('/')
    );

    let payload = ReportPayload {
        report_arguments: ReportArguments {
            run_mode: "BySearchCriteria".to_string(),
            exact_match: false,
            name_only: false,
            entity_ids: vec![],
            search_text: String::new(),
        },
        output_format: "EXCEL".to_string(),
        report_id: settings.report_id,
    };

    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&payload)
        .timeout(Duration::from_secs(120))
        .send()
        .map_err(|e| format!("Generate report request failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "Generate report failed with status {}: {}",
            response.status(),
            response.text().unwrap_or_default()
        ));
    }

    let text = response
        .text()
        .map_err(|e| format!("Failed to read response: {}", e))?;

    // Try to parse as JSON first
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
        if let Some(filename) = json
            .get("fileName")
            .or_else(|| json.get("filename"))
            .or_else(|| json.get("name"))
            .and_then(|v| v.as_str())
        {
            return Ok(filename.to_string());
        }
    }

    // Otherwise, treat as plain text filename
    Ok(text.trim().trim_matches('"').to_string())
}

pub fn download_report_file(
    token: &str,
    filename: &str,
    output_dir: &Path,
    settings: &ApiSettings,
) -> Result<PathBuf, String> {
    let client = build_http_client(&settings.proxy)?;
    let encoded_filename = urlencoding::encode(filename.trim());
    let url = format!(
        "{}/api/v2/reports/download/{}",
        settings.base_url.trim_end_matches('/'),
        encoded_filename
    );

    let mut last_error = String::new();

    for attempt in 1..=DOWNLOAD_RETRIES {
        let response = client
            .get(&url)
            .header("Authorization", format!("Bearer {}", token))
            .timeout(Duration::from_secs(300))
            .send();

        match response {
            Ok(resp) => {
                if resp.status().is_success() {
                    let bytes = resp
                        .bytes()
                        .map_err(|e| format!("Failed to read response bytes: {}", e))?;

                    // Check if response is JSON with base64 encoded data
                    if let Ok(json) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                        if let Some(file_data) = json.get("fileData").and_then(|v| v.as_str()) {
                            let decoded = base64::engine::general_purpose::STANDARD
                                .decode(file_data)
                                .map_err(|e| format!("Failed to decode base64: {}", e))?;

                            let resolved_name = json
                                .get("fileName")
                                .or_else(|| json.get("filename"))
                                .and_then(|v| v.as_str())
                                .unwrap_or(filename);

                            fs::create_dir_all(output_dir)
                                .map_err(|e| format!("Failed to create output dir: {}", e))?;

                            let target = output_dir.join(resolved_name);
                            fs::write(&target, decoded)
                                .map_err(|e| format!("Failed to write file: {}", e))?;

                            return Ok(target);
                        }
                    }

                    // Direct binary response
                    fs::create_dir_all(output_dir)
                        .map_err(|e| format!("Failed to create output dir: {}", e))?;

                    let target = output_dir.join(filename);
                    fs::write(&target, &bytes)
                        .map_err(|e| format!("Failed to write file: {}", e))?;

                    return Ok(target);
                } else if resp.status().as_u16() == 404 {
                    let body = resp.text().unwrap_or_default();
                    if body.contains("FileNotFoundException") && attempt < DOWNLOAD_RETRIES {
                        log::info!(
                            "Report not ready yet ({}/{}). Retrying in {} seconds...",
                            attempt,
                            DOWNLOAD_RETRIES,
                            DOWNLOAD_RETRY_SECONDS
                        );
                        thread::sleep(Duration::from_secs(DOWNLOAD_RETRY_SECONDS));
                        continue;
                    }
                    last_error = format!("Download failed with 404: {}", body);
                } else {
                    last_error = format!(
                        "Download failed with status {}: {}",
                        resp.status(),
                        resp.text().unwrap_or_default()
                    );
                }
            }
            Err(e) => {
                last_error = format!("Download request failed: {}", e);
            }
        }
    }

    Err(last_error)
}

// ============================================================================
// XLSX Parsing
// ============================================================================

fn column_letter_to_index(cell_ref: &str) -> usize {
    let letters: String = cell_ref.chars().filter(|c| c.is_ascii_alphabetic()).collect();
    let mut value: usize = 0;
    for ch in letters.to_uppercase().chars() {
        value = value * 26 + (ch as usize - 'A' as usize + 1);
    }
    value.saturating_sub(1)
}

fn extract_column_letter(cell_ref: &str) -> String {
    cell_ref
        .chars()
        .filter(|c| c.is_ascii_alphabetic())
        .collect::<String>()
        .to_uppercase()
}

fn read_shared_strings(archive: &mut ZipArchive<std::fs::File>) -> Result<Vec<String>, String> {
    let mut strings = Vec::new();

    let file = match archive.by_name("xl/sharedStrings.xml") {
        Ok(f) => f,
        Err(_) => return Ok(strings), // No shared strings file is okay
    };

    let mut reader = Reader::from_reader(std::io::BufReader::new(file));
    reader.config_mut().trim_text(true);

    let mut buf = Vec::new();
    let mut current_string = String::new();
    let mut in_si = false;
    let mut in_t = false;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => {
                let name = e.local_name();
                if name.as_ref() == b"si" {
                    in_si = true;
                    current_string.clear();
                } else if name.as_ref() == b"t" && in_si {
                    in_t = true;
                }
            }
            Ok(Event::Text(e)) => {
                if in_t {
                    if let Ok(text) = e.unescape() {
                        current_string.push_str(&text);
                    }
                }
            }
            Ok(Event::End(e)) => {
                let name = e.local_name();
                if name.as_ref() == b"t" {
                    in_t = false;
                } else if name.as_ref() == b"si" {
                    strings.push(current_string.clone());
                    in_si = false;
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("XML parse error: {}", e)),
            _ => {}
        }
        buf.clear();
    }

    Ok(strings)
}

fn find_first_sheet_path(archive: &mut ZipArchive<std::fs::File>) -> Result<String, String> {
    // Read workbook.xml into memory first
    let workbook_content = {
        let mut workbook_file = archive
            .by_name("xl/workbook.xml")
            .map_err(|e| format!("Failed to read workbook.xml: {}", e))?;
        let mut content = Vec::new();
        std::io::Read::read_to_end(&mut workbook_file, &mut content)
            .map_err(|e| format!("Failed to read workbook.xml content: {}", e))?;
        content
    };

    let mut reader = Reader::from_reader(workbook_content.as_slice());
    reader.config_mut().trim_text(true);

    let mut buf = Vec::new();
    let mut sheet_rid: Option<String> = None;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Empty(e)) | Ok(Event::Start(e)) => {
                if e.local_name().as_ref() == b"sheet" {
                    for attr in e.attributes().flatten() {
                        if attr.key.as_ref() == b"r:id"
                            || attr.key.local_name().as_ref() == b"id"
                        {
                            sheet_rid = Some(
                                String::from_utf8_lossy(&attr.value).to_string(),
                            );
                            break;
                        }
                    }
                    if sheet_rid.is_some() {
                        break;
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("XML parse error: {}", e)),
            _ => {}
        }
        buf.clear();
    }

    let rid = sheet_rid.ok_or("No sheet found in workbook")?;

    // Read workbook rels into memory
    let rels_content = {
        let mut rels_file = archive
            .by_name("xl/_rels/workbook.xml.rels")
            .map_err(|e| format!("Failed to read workbook.xml.rels: {}", e))?;
        let mut content = Vec::new();
        std::io::Read::read_to_end(&mut rels_file, &mut content)
            .map_err(|e| format!("Failed to read rels content: {}", e))?;
        content
    };

    let mut reader = Reader::from_reader(rels_content.as_slice());
    reader.config_mut().trim_text(true);
    buf.clear();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Empty(e)) | Ok(Event::Start(e)) => {
                if e.local_name().as_ref() == b"Relationship" {
                    let mut is_target = false;
                    let mut target = String::new();

                    for attr in e.attributes().flatten() {
                        if attr.key.local_name().as_ref() == b"Id" {
                            is_target = String::from_utf8_lossy(&attr.value) == rid;
                        }
                        if attr.key.local_name().as_ref() == b"Target" {
                            target = String::from_utf8_lossy(&attr.value).to_string();
                        }
                    }

                    if is_target && !target.is_empty() {
                        let target = target.replace('\\', "/").trim_start_matches('/').to_string();
                        return Ok(if target.starts_with("xl/") {
                            target
                        } else {
                            format!("xl/{}", target)
                        });
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("XML parse error: {}", e)),
            _ => {}
        }
        buf.clear();
    }

    // Fallback to default sheet path
    Ok("xl/worksheets/sheet1.xml".to_string())
}

pub fn read_xlsx_row_maps(xlsx_path: &Path) -> Result<Vec<HashMap<String, String>>, String> {
    let file =
        fs::File::open(xlsx_path).map_err(|e| format!("Failed to open xlsx file: {}", e))?;

    let mut archive =
        ZipArchive::new(file).map_err(|e| format!("Failed to read xlsx as zip: {}", e))?;

    let shared_strings = read_shared_strings(&mut archive)?;
    let sheet_path = find_first_sheet_path(&mut archive)?;

    // Read sheet into memory first to avoid borrow issues
    let sheet_content = {
        let mut sheet_file = archive
            .by_name(&sheet_path)
            .map_err(|e| format!("Failed to read sheet {}: {}", sheet_path, e))?;
        let mut content = Vec::new();
        std::io::Read::read_to_end(&mut sheet_file, &mut content)
            .map_err(|e| format!("Failed to read sheet content: {}", e))?;
        content
    };

    let mut reader = Reader::from_reader(sheet_content.as_slice());
    reader.config_mut().trim_text(true);

    let mut buf = Vec::new();
    let mut rows: Vec<HashMap<String, String>> = Vec::new();
    let mut current_row: HashMap<String, String> = HashMap::new();
    let mut current_cell_ref = String::new();
    let mut current_cell_type = String::new();
    let mut current_value = String::new();
    let mut in_row = false;
    let mut in_cell = false;
    let mut in_value = false;
    let mut in_inline_str = false;  // For t="inlineStr" cells
    let mut in_t = false;           // For <t> tags inside inline strings

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let name = e.local_name();
                if name.as_ref() == b"row" {
                    in_row = true;
                    current_row.clear();
                } else if name.as_ref() == b"c" && in_row {
                    in_cell = true;
                    current_cell_ref.clear();
                    current_cell_type.clear();
                    current_value.clear();

                    for attr in e.attributes().flatten() {
                        if attr.key.local_name().as_ref() == b"r" {
                            current_cell_ref = String::from_utf8_lossy(&attr.value).to_string();
                        } else if attr.key.local_name().as_ref() == b"t" {
                            current_cell_type = String::from_utf8_lossy(&attr.value).to_string();
                        }
                    }
                } else if name.as_ref() == b"v" && in_cell {
                    in_value = true;
                } else if name.as_ref() == b"is" && in_cell {
                    // Inline string container
                    in_inline_str = true;
                } else if name.as_ref() == b"t" && (in_inline_str || in_cell) {
                    // Text tag (inside inline string or directly)
                    in_t = true;
                }
            }
            Ok(Event::Empty(e)) => {
                // Handle empty/self-closing tags
                let name = e.local_name();
                if name.as_ref() == b"c" && in_row {
                    // Empty cell - just skip
                }
            }
            Ok(Event::Text(e)) => {
                if in_value || in_t {
                    if let Ok(text) = e.unescape() {
                        current_value.push_str(&text);
                    }
                }
            }
            Ok(Event::End(e)) => {
                let name = e.local_name();
                if name.as_ref() == b"v" {
                    in_value = false;
                } else if name.as_ref() == b"t" {
                    in_t = false;
                } else if name.as_ref() == b"is" {
                    in_inline_str = false;
                } else if name.as_ref() == b"c" {
                    if in_cell && !current_cell_ref.is_empty() {
                        let col = extract_column_letter(&current_cell_ref);
                        let value = if current_cell_type == "s" {
                            // Shared string reference
                            if let Ok(idx) = current_value.parse::<usize>() {
                                shared_strings
                                    .get(idx)
                                    .cloned()
                                    .unwrap_or_default()
                            } else {
                                current_value.clone()
                            }
                        } else {
                            // Inline string or direct value
                            current_value.clone()
                        };

                        if !value.trim().is_empty() {
                            current_row.insert(col, value.trim().to_string());
                        }
                    }
                    in_cell = false;
                    in_inline_str = false;
                    in_t = false;
                } else if name.as_ref() == b"row" {
                    if in_row {
                        rows.push(current_row.clone());
                    }
                    in_row = false;
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("XML parse error: {}", e)),
            _ => {}
        }
        buf.clear();
    }

    Ok(rows)
}

// ============================================================================
// Data Normalization and Processing
// ============================================================================

fn normalize_text(value: &str) -> String {
    value.trim().to_string()
}

fn normalize_alarm_identifier(value: &str) -> String {
    let raw = value.trim().replace(' ', "");
    if raw.is_empty() {
        return String::new();
    }

    if raw.starts_with('+') {
        let digits: String = raw[1..].chars().filter(|c| c.is_ascii_digit()).collect();
        if digits.is_empty() {
            return String::new();
        }
        return format!("+{}", digits);
    }

    let digits: String = raw.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return String::new();
    }

    if digits.starts_with("46") {
        format!("+{}", digits)
    } else {
        digits
    }
}

fn bool_from_value(value: &str) -> Option<bool> {
    let text = value.trim().to_lowercase();
    if text.is_empty() {
        return None;
    }
    if ["1", "true", "yes", "ja", "active", "aktiv"].contains(&text.as_str()) {
        return Some(true);
    }
    if ["0", "false", "no", "nei", "inactive", "inaktiv", "disabled"].contains(&text.as_str()) {
        return Some(false);
    }
    None
}

fn status_from_value(value: &str) -> String {
    let text = value.trim().to_lowercase();
    if text.is_empty() {
        return "unknown".to_string();
    }

    let installed_tokens = ["aktiv", "active", "install", "running", "ok"];
    let ordered_tokens = ["bestilt", "ordered", "pending"];
    let paused_tokens = ["pause", "hold"];
    let ended_tokens = ["ended", "stopp", "avslutt", "inactive", "inaktiv"];

    if installed_tokens.iter().any(|t| text.contains(t)) {
        return "installed".to_string();
    }
    if ordered_tokens.iter().any(|t| text.contains(t)) {
        return "ordered".to_string();
    }
    if paused_tokens.iter().any(|t| text.contains(t)) {
        return "paused".to_string();
    }
    if ended_tokens.iter().any(|t| text.contains(t)) {
        return "ended".to_string();
    }

    text.chars().take(80).collect()
}

fn stable_payload_hash(payload: &HashMap<String, String>) -> String {
    let json = serde_json::to_string(payload).unwrap_or_default();
    let mut hasher = Sha256::new();
    hasher.update(json.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn normalize_import_record(
    row: &HashMap<String, String>,
    imported_at: &str,
    report_id: i32,
) -> Option<HashMap<String, serde_json::Value>> {
    let cols = &REPORT_9_COLUMNS;

    let mut external_id = row.get("E").cloned().unwrap_or_default();
    if external_id.is_empty() {
        external_id = row.get("A").cloned().unwrap_or_default();
    }

    let name = row.get(cols.name).cloned().unwrap_or_default();
    let address = row.get(cols.address).cloned().unwrap_or_default();
    let postal_code = row.get(cols.postal_code).cloned().unwrap_or_default();
    let city = row.get(cols.city).cloned().unwrap_or_default();
    let phone = row.get(cols.phone).cloned().unwrap_or_default();
    let national_id = row.get(cols.national_id).cloned().unwrap_or_default();
    let key_info = row.get(cols.key_info).cloned().unwrap_or_default();
    let sender_identifier = normalize_alarm_identifier(row.get("F").unwrap_or(&String::new()));
    let active_flag = bool_from_value(row.get(cols.is_active).unwrap_or(&String::new()));

    // Skip header rows
    let ext_lower = external_id.to_lowercase();
    if ext_lower == "bruker id" || ext_lower == "externalid" || ext_lower == "id" {
        return None;
    }
    let name_lower = name.trim().to_lowercase();
    if name_lower == "navn" || name_lower == "name" {
        return None;
    }

    // For report 9, skip inactive and those without sender identifier
    if report_id == 9 {
        if active_flag == Some(false) {
            return None;
        }
        if sender_identifier.is_empty() {
            return None;
        }
    }

    let status_text = if active_flag == Some(true) || active_flag.is_none() {
        "active"
    } else {
        "inactive"
    };

    let is_active = active_flag.unwrap_or(true);
    let alarm_status = status_from_value(status_text);

    let mut import_payload: HashMap<String, serde_json::Value> = HashMap::new();
    import_payload.insert("externalId".to_string(), serde_json::json!(external_id));
    import_payload.insert("name".to_string(), serde_json::json!(name));
    import_payload.insert("address".to_string(), serde_json::json!(address));
    import_payload.insert("postalCode".to_string(), serde_json::json!(postal_code));
    import_payload.insert("city".to_string(), serde_json::json!(city));
    import_payload.insert("phone".to_string(), serde_json::json!(phone));
    import_payload.insert("nationalId".to_string(), serde_json::json!(national_id));
    import_payload.insert("dispatchGroup".to_string(), serde_json::json!(""));
    import_payload.insert("keyInfo".to_string(), serde_json::json!(key_info));
    import_payload.insert("isActive".to_string(), serde_json::json!(is_active));
    import_payload.insert("alarmStatus".to_string(), serde_json::json!(alarm_status));
    import_payload.insert(
        "sourceImportedAt".to_string(),
        serde_json::json!(imported_at),
    );
    import_payload.insert(
        "sourceProvider".to_string(),
        serde_json::json!("skyresponse"),
    );
    import_payload.insert("sourcePayload".to_string(), serde_json::json!(row));
    import_payload.insert(
        "sourceRowHash".to_string(),
        serde_json::json!(stable_payload_hash(row)),
    );

    if external_id.is_empty() && name.is_empty() {
        return None;
    }

    Some(import_payload)
}

fn existing_lookup_key(item: &serde_json::Value) -> String {
    let external_id = item
        .get("externalId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_lowercase();

    if !external_id.is_empty() {
        return format!("id:{}", external_id);
    }

    let name = item
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_lowercase();
    let address = item
        .get("address")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_lowercase();

    format!("name:{}|addr:{}", name, address)
}

// ============================================================================
// Settings Loading
// ============================================================================

fn get_default_settings_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("no.svein.assistio-trygghetsalarm")
        .join("settings.json")
}

fn get_default_data_dir() -> PathBuf {
    dirs::document_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Assistio-Trygghetsalarm")
}

pub fn load_settings(settings_path: Option<&Path>) -> Result<ApiSettings, String> {
    let path = settings_path
        .map(PathBuf::from)
        .unwrap_or_else(get_default_settings_path);

    if !path.exists() {
        return Err(format!("Settings file not found: {}", path.display()));
    }

    let content =
        fs::read_to_string(&path).map_err(|e| format!("Failed to read settings: {}", e))?;

    let settings: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse settings: {}", e))?;

    // Navigate to workspace settings
    let workspace_settings = settings
        .get("workspaceSettings")
        .ok_or("No workspaceSettings found")?;

    let workspaces = workspace_settings
        .get("workspaces")
        .and_then(|v| v.as_array())
        .ok_or("No workspaces found")?;

    // Get active workspace
    let active_id = workspace_settings
        .get("activeWorkspaceId")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let workspace = if !active_id.is_empty() {
        workspaces
            .iter()
            .find(|w| w.get("id").and_then(|v| v.as_str()) == Some(active_id))
    } else {
        workspaces.first()
    }
    .ok_or("No workspace found")?;

    let safety_import = workspace
        .get("safetyAlarmImport")
        .ok_or("No safetyAlarmImport settings")?;

    // Read proxy settings (can be in safetyAlarmImport or at workspace level)
    let proxy_config = safety_import
        .get("proxy")
        .or_else(|| workspace.get("proxy"));

    let proxy = if let Some(p) = proxy_config {
        ProxySettings {
            url: p
                .get("url")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            username: p
                .get("username")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            password: p
                .get("password")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            use_system_proxy: p
                .get("useSystemProxy")
                .and_then(|v| v.as_bool())
                .unwrap_or(true),
            accept_invalid_certs: p
                .get("acceptInvalidCerts")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
        }
    } else {
        ProxySettings::default()
    };

    log::info!("Loaded settings for workspace: {}",
        workspace.get("name").and_then(|v| v.as_str()).unwrap_or("unknown"));
    log::info!("Proxy config: url={}, useSystemProxy={}, acceptInvalidCerts={}",
        if proxy.url.is_empty() { "(none)" } else { &proxy.url },
        proxy.use_system_proxy,
        proxy.accept_invalid_certs);

    Ok(ApiSettings {
        base_url: safety_import
            .get("baseUrl")
            .and_then(|v| v.as_str())
            .unwrap_or(DEFAULT_BASE_URL)
            .trim_end_matches('/')
            .to_string(),
        username: safety_import
            .get("username")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        password: safety_import
            .get("password")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        report_id: safety_import
            .get("reportId")
            .and_then(|v| v.as_i64())
            .unwrap_or(SAFETY_REPORT_ID as i64) as i32,
        workspace_id: workspace
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        workspace_name: workspace
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        data_file_path: workspace
            .get("dataFilePath")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        proxy,
    })
}

fn derive_data_file_path(settings: &ApiSettings) -> PathBuf {
    if !settings.data_file_path.is_empty() {
        let path = PathBuf::from(&settings.data_file_path);
        return path.with_file_name("safety_alarms.json");
    }
    get_default_data_dir().join("safety_alarms.json")
}

fn derive_heartbeat_file_path(settings: &ApiSettings) -> PathBuf {
    if !settings.data_file_path.is_empty() {
        let path = PathBuf::from(&settings.data_file_path);
        return path.with_file_name("safety_alarm_heartbeats.json");
    }
    get_default_data_dir().join("safety_alarm_heartbeats.json")
}

// ============================================================================
// Main Sync Functions
// ============================================================================

pub fn sync_safety_alarms(settings: &ApiSettings, download_dir: &Path) -> Result<SyncResult, String> {
    let imported_at = Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();

    // Login and download report
    log::info!("Logging in to Skyresponse...");
    let token = login_and_get_token(settings)?;

    log::info!("Generating safety alarms report...");
    let mut safety_settings = settings.clone();
    safety_settings.report_id = SAFETY_REPORT_ID;
    let filename = generate_report_filename(&token, &safety_settings)?;

    log::info!("Downloading report: {}", filename);
    let xlsx_path = download_report_file(&token, &filename, download_dir, &safety_settings)?;

    log::info!("Parsing Excel file...");
    let row_maps = read_xlsx_row_maps(&xlsx_path)?;
    log::info!("Found {} rows in worksheet", row_maps.len());

    // Normalize records
    let mut imported_items: Vec<HashMap<String, serde_json::Value>> = Vec::new();
    let mut skipped = 0;

    for row in &row_maps {
        if let Some(normalized) = normalize_import_record(row, &imported_at, SAFETY_REPORT_ID) {
            imported_items.push(normalized);
        } else {
            skipped += 1;
        }
    }

    log::info!(
        "Parsed {} valid records, skipped {}",
        imported_items.len(),
        skipped
    );

    // Load existing data
    let data_path = derive_data_file_path(settings);
    let current_data: serde_json::Value = if data_path.exists() {
        let content = fs::read_to_string(&data_path)
            .map_err(|e| format!("Failed to read existing data: {}", e))?;
        serde_json::from_str(&content).unwrap_or_else(|_| {
            serde_json::json!({
                "schemaVersion": 1,
                "updatedAt": imported_at,
                "items": []
            })
        })
    } else {
        serde_json::json!({
            "schemaVersion": 1,
            "updatedAt": imported_at,
            "items": []
        })
    };

    let current_items = current_data
        .get("items")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    // Build lookup of existing items
    let mut lookup: HashMap<String, serde_json::Value> = HashMap::new();
    for item in &current_items {
        let key = existing_lookup_key(item);
        lookup.insert(key, item.clone());
    }

    // Merge imported items
    let mut created = 0;
    let mut updated = 0;
    let imported_keys: std::collections::HashSet<String> = imported_items
        .iter()
        .map(|item| {
            let external_id = item
                .get("externalId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_lowercase();
            if !external_id.is_empty() {
                format!("id:{}", external_id)
            } else {
                let name = item
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_lowercase();
                let address = item
                    .get("address")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_lowercase();
                format!("name:{}|addr:{}", name, address)
            }
        })
        .collect();

    for imported in &imported_items {
        let external_id = imported
            .get("externalId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_lowercase();
        let key = if !external_id.is_empty() {
            format!("id:{}", external_id)
        } else {
            let name = imported
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_lowercase();
            let address = imported
                .get("address")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_lowercase();
            format!("name:{}|addr:{}", name, address)
        };

        if let Some(existing) = lookup.get(&key) {
            // Update existing
            let mut merged = existing.clone();
            if let Some(obj) = merged.as_object_mut() {
                for (k, v) in imported {
                    obj.insert(k.clone(), v.clone());
                }
                obj.insert("updatedAt".to_string(), serde_json::json!(imported_at));
            }
            lookup.insert(key, merged);
            updated += 1;
        } else {
            // Create new
            let mut new_item = serde_json::json!({
                "id": imported.get("externalId").and_then(|v| v.as_str()).unwrap_or(""),
                "processStatus": "new",
                "critical": false,
                "criticalNote": "",
                "keyBoxStatus": "unknown",
                "keyBoxInstalledAt": null,
                "billingStatus": "not_ready",
                "notes": "",
                "personId": null,
                "personName": "",
                "requestId": null,
                "requestTitle": "",
                "taskId": null,
                "taskTitle": "",
                "createdAt": imported_at,
                "updatedAt": imported_at
            });

            if let Some(obj) = new_item.as_object_mut() {
                for (k, v) in imported {
                    obj.insert(k.clone(), v.clone());
                }
            }

            lookup.insert(key, new_item);
            created += 1;
        }
    }

    // Remove items not in import (for report 9)
    let mut deleted = 0;
    let keys_to_remove: Vec<String> = lookup
        .keys()
        .filter(|k| {
            !imported_keys.contains(*k)
                && lookup
                    .get(*k)
                    .and_then(|v| v.get("sourceProvider"))
                    .and_then(|v| v.as_str())
                    == Some("skyresponse")
        })
        .cloned()
        .collect();

    for key in keys_to_remove {
        lookup.remove(&key);
        deleted += 1;
    }

    // Sort items
    let mut items: Vec<serde_json::Value> = lookup.into_values().collect();
    items.sort_by(|a, b| {
        let a_critical = a.get("critical").and_then(|v| v.as_bool()).unwrap_or(false);
        let b_critical = b.get("critical").and_then(|v| v.as_bool()).unwrap_or(false);
        let a_active = a.get("isActive").and_then(|v| v.as_bool()).unwrap_or(true);
        let b_active = b.get("isActive").and_then(|v| v.as_bool()).unwrap_or(true);
        let a_name = a
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_lowercase();
        let b_name = b
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_lowercase();

        (!a_critical)
            .cmp(&(!b_critical))
            .then((!a_active).cmp(&(!b_active)))
            .then(a_name.cmp(&b_name))
    });

    // Save data
    let next_data = serde_json::json!({
        "schemaVersion": 1,
        "updatedAt": imported_at,
        "items": items
    });

    if let Some(parent) = data_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create data dir: {}", e))?;
    }

    fs::write(
        &data_path,
        serde_json::to_string_pretty(&next_data).unwrap(),
    )
    .map_err(|e| format!("Failed to write data file: {}", e))?;

    // Save meta.json
    let meta_path = data_path.with_file_name("meta.json");
    let meta_data = serde_json::json!({
        "lastImportedAt": imported_at
    });
    fs::write(
        &meta_path,
        serde_json::to_string_pretty(&meta_data).unwrap(),
    )
    .map_err(|e| format!("Failed to write meta file: {}", e))?;

    log::info!(
        "Safety alarms sync complete: created={}, updated={}, deleted={}, total={}",
        created,
        updated,
        deleted,
        items.len()
    );

    Ok(SyncResult {
        success: true,
        message: format!(
            "Safety alarms: {} created, {} updated, {} total",
            created,
            updated,
            items.len()
        ),
        safety_alarms_created: created,
        safety_alarms_updated: updated,
        safety_alarms_total: items.len() as i32,
        heartbeats_created: 0,
        heartbeats_updated: 0,
        heartbeats_total: 0,
    })
}

pub fn sync_heartbeats(settings: &ApiSettings, download_dir: &Path) -> Result<SyncResult, String> {
    let imported_at = Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();

    // Login and download heartbeat report
    log::info!("Downloading heartbeat report...");
    let token = login_and_get_token(settings)?;

    let mut heartbeat_settings = settings.clone();
    heartbeat_settings.report_id = HEARTBEAT_REPORT_ID;

    let filename = generate_report_filename(&token, &heartbeat_settings)?;
    let xlsx_path = download_report_file(&token, &filename, download_dir, &heartbeat_settings)?;

    log::info!("Parsing heartbeat Excel file...");
    let row_maps = read_xlsx_row_maps(&xlsx_path)?;

    // Find header row with heartbeat columns
    let heartbeat_keywords = ["hjerteslag", "kommunikasjon", "heartbeat", "lastseen", "lastcontact"];
    let identifier_aliases = ["identifier", "identifikator", "abonnement"];
    let apartment_aliases = ["leilighetnummer", "leilighet", "hybel", "romnummer"];
    let heartbeat_aliases = ["hjerteslag", "kommunikasjon", "heartbeat", "lastseen", "lastcontact", "sistekommunikasjon", "sistehjerteslag"];

    fn normalize_header(s: &str) -> String {
        s.trim()
            .to_lowercase()
            .replace('æ', "ae")
            .replace('ø', "o")
            .replace('å', "a")
            .replace(' ', "")
            .chars()
            .filter(|c| c.is_alphanumeric())
            .collect()
    }

    // Detect header row - look for any cell containing heartbeat-related keywords
    let mut header_index = None;

    for (idx, row) in row_maps.iter().enumerate() {
        let all_values: String = row
            .values()
            .map(|v| normalize_header(v))
            .collect::<Vec<_>>()
            .join(" ");

        // Check if any heartbeat keyword is contained in any cell
        if heartbeat_keywords.iter().any(|keyword| all_values.contains(keyword)) {
            header_index = Some(idx);
            log::info!("Found heartbeat header at row {}", idx);
            break;
        }
    }

    // Fallback: if no header found, try first row with multiple columns
    let header_idx = match header_index {
        Some(idx) => idx,
        None => {
            log::warn!("Could not find heartbeat header row by keywords, using first row with data");
            row_maps.iter().position(|row| row.len() >= 3).unwrap_or(0)
        }
    };

    // Build column-to-header mapping from header row
    let header_row = row_maps.get(header_idx).cloned().unwrap_or_default();
    let col_to_header: HashMap<String, String> = header_row
        .iter()
        .map(|(col, val)| (col.clone(), val.clone()))
        .collect();

    log::info!("Heartbeat header row has {} columns", col_to_header.len());

    // Parse records
    let mut imported_items: Vec<HeartbeatItem> = Vec::new();

    for row in row_maps.iter().skip(header_idx + 1) {
        // Build a row with header names as keys
        let mut named_row: HashMap<String, String> = HashMap::new();
        for (col, value) in row {
            if let Some(header) = col_to_header.get(col) {
                named_row.insert(header.clone(), value.clone());
            }
            // Also keep column letter for fallback
            named_row.insert(col.clone(), value.clone());
        }

        // Find identifier - look for known identifier columns first
        let mut identifier = String::new();
        for (key, value) in &named_row {
            let norm_key = normalize_header(key);
            if identifier_aliases.iter().any(|a| norm_key.contains(a)) {
                let norm_val = normalize_alarm_identifier(value);
                if !norm_val.is_empty() {
                    identifier = norm_val;
                    break;
                }
            }
        }

        // Fallback: look for identifier pattern in any column
        if identifier.is_empty() {
            for value in named_row.values() {
                let norm = normalize_alarm_identifier(value);
                if !norm.is_empty() && (norm.starts_with('+') || norm.len() >= 8) {
                    identifier = norm;
                    break;
                }
            }
        }

        if identifier.is_empty() {
            continue;
        }

        // Find apartment - look by header name
        let mut apartment = String::new();
        for (key, value) in &named_row {
            let norm_key = normalize_header(key);
            if apartment_aliases.iter().any(|a| norm_key.contains(a)) {
                apartment = value.clone();
                break;
            }
        }

        // Find heartbeat timestamp - look by header name first
        let mut heartbeat = String::new();
        for (key, value) in &named_row {
            let norm_key = normalize_header(key);
            if heartbeat_aliases.iter().any(|a| norm_key.contains(a)) {
                // This column should contain the heartbeat timestamp
                if !value.is_empty() && value.len() > 8 {
                    heartbeat = value.clone();
                    break;
                }
            }
        }

        // Fallback: look for datetime-like values
        if heartbeat.is_empty() {
            for value in named_row.values() {
                // Skip the identifier value
                if normalize_alarm_identifier(value) == identifier {
                    continue;
                }
                // Look for datetime pattern
                if (value.contains('-') || value.contains('/')) && value.len() > 10 {
                    heartbeat = value.clone();
                    break;
                }
            }
        }

        // Store raw with header names for better readability
        imported_items.push(HeartbeatItem {
            alarm_identifier: identifier,
            apartment_label: apartment,
            last_heartbeat_at: heartbeat,
            heartbeat_source_imported_at: imported_at.clone(),
            raw: named_row.into_iter().filter(|(k, _)| !k.chars().all(|c| c.is_ascii_uppercase())).collect(),
        });
    }

    log::info!("Parsed {} heartbeat records from XLSX", imported_items.len());

    // Log some sample imported identifiers for debugging
    if !imported_items.is_empty() {
        let samples: Vec<_> = imported_items.iter().take(3).map(|i| i.alarm_identifier.as_str()).collect();
        log::info!("Sample imported heartbeat identifiers: {:?}", samples);
    }

    // Load existing safety alarms to filter
    let safety_path = derive_data_file_path(settings);
    let active_identifiers: std::collections::HashSet<String> = if safety_path.exists() {
        let content = fs::read_to_string(&safety_path).unwrap_or_default();
        let data: serde_json::Value = serde_json::from_str(&content).unwrap_or_default();
        data.get("items")
            .and_then(|v| v.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter(|item| {
                        item.get("isActive")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(true)
                    })
                    .filter_map(|item| {
                        item.get("sourcePayload")
                            .and_then(|v| v.get("F"))
                            .and_then(|v| v.as_str())
                            .map(normalize_alarm_identifier)
                            .filter(|s| !s.is_empty())
                    })
                    .collect()
            })
            .unwrap_or_default()
    } else {
        std::collections::HashSet::new()
    };

    log::info!("Found {} active safety alarm identifiers for filtering", active_identifiers.len());

    // Log some sample active identifiers for debugging
    if !active_identifiers.is_empty() {
        let samples: Vec<_> = active_identifiers.iter().take(3).collect();
        log::info!("Sample active safety alarm identifiers: {:?}", samples);
    }

    // Filter to active users
    let filtered_items: Vec<HeartbeatItem> = imported_items
        .into_iter()
        .filter(|item| active_identifiers.contains(&item.alarm_identifier))
        .collect();

    log::info!("Filtered to {} heartbeat records (matching active alarms)", filtered_items.len());

    // Load and merge with existing heartbeats
    let heartbeat_path = derive_heartbeat_file_path(settings);
    let current_data: HeartbeatsData = if heartbeat_path.exists() {
        let content = fs::read_to_string(&heartbeat_path).unwrap_or_default();
        serde_json::from_str(&content).unwrap_or(HeartbeatsData {
            schema_version: 1,
            updated_at: imported_at.clone(),
            items: vec![],
        })
    } else {
        HeartbeatsData {
            schema_version: 1,
            updated_at: imported_at.clone(),
            items: vec![],
        }
    };

    // Merge
    let mut lookup: HashMap<String, HeartbeatItem> = HashMap::new();
    for item in current_data.items {
        lookup.insert(item.alarm_identifier.clone(), item);
    }

    let mut created = 0;
    let mut updated = 0;

    for item in filtered_items {
        let key = item.alarm_identifier.clone();
        if lookup.contains_key(&key) {
            updated += 1;
        } else {
            created += 1;
        }
        lookup.insert(key, item);
    }

    let mut items: Vec<HeartbeatItem> = lookup.into_values().collect();
    items.sort_by(|a, b| {
        a.apartment_label
            .to_lowercase()
            .cmp(&b.apartment_label.to_lowercase())
            .then(a.alarm_identifier.cmp(&b.alarm_identifier))
    });

    // Save
    let next_data = HeartbeatsData {
        schema_version: 1,
        updated_at: imported_at,
        items: items.clone(),
    };

    if let Some(parent) = heartbeat_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create dir: {}", e))?;
    }

    fs::write(
        &heartbeat_path,
        serde_json::to_string_pretty(&next_data).unwrap(),
    )
    .map_err(|e| format!("Failed to write heartbeats: {}", e))?;

    log::info!(
        "Heartbeats sync complete: created={}, updated={}, total={}",
        created,
        updated,
        items.len()
    );

    Ok(SyncResult {
        success: true,
        message: format!(
            "Heartbeats: {} created, {} updated, {} total",
            created,
            updated,
            items.len()
        ),
        safety_alarms_created: 0,
        safety_alarms_updated: 0,
        safety_alarms_total: 0,
        heartbeats_created: created,
        heartbeats_updated: updated,
        heartbeats_total: items.len() as i32,
    })
}

/// Check if an error is SSL/TLS related (indicates corporate proxy/Helsenett)
fn is_ssl_error(error: &str) -> bool {
    let error_lower = error.to_lowercase();
    error_lower.contains("certificate") ||
    error_lower.contains("ssl") ||
    error_lower.contains("tls") ||
    error_lower.contains("handshake") ||
    error_lower.contains("schannel") ||
    error_lower.contains("cert")
}

/// Internal sync function with specific settings
fn do_sync(settings: &ApiSettings, download_dir: &Path) -> Result<SyncResult, String> {
    // Sync safety alarms first
    let safety_result = sync_safety_alarms(settings, download_dir)?;

    // Then sync heartbeats
    let heartbeat_result = sync_heartbeats(settings, download_dir)?;

    Ok(SyncResult {
        success: true,
        message: format!(
            "Sync complete. Safety alarms: {} new, {} updated, {} total. Heartbeats: {} new, {} updated, {} total.",
            safety_result.safety_alarms_created,
            safety_result.safety_alarms_updated,
            safety_result.safety_alarms_total,
            heartbeat_result.heartbeats_created,
            heartbeat_result.heartbeats_updated,
            heartbeat_result.heartbeats_total
        ),
        safety_alarms_created: safety_result.safety_alarms_created,
        safety_alarms_updated: safety_result.safety_alarms_updated,
        safety_alarms_total: safety_result.safety_alarms_total,
        heartbeats_created: heartbeat_result.heartbeats_created,
        heartbeats_updated: heartbeat_result.heartbeats_updated,
        heartbeats_total: heartbeat_result.heartbeats_total,
    })
}

/// Main sync function that syncs both safety alarms and heartbeats
/// Automatically retries with SSL bypass if SSL errors are detected (for Helsenett/enterprise networks)
pub fn run_full_sync(settings_path: Option<&Path>) -> Result<SyncResult, String> {
    let mut settings = load_settings(settings_path)?;

    log::info!(
        "Starting Hepro sync for workspace: {}",
        settings.workspace_name
    );

    // Create download directory
    let download_dir = get_default_data_dir().join("downloads");
    fs::create_dir_all(&download_dir)
        .map_err(|e| format!("Failed to create download dir: {}", e))?;

    // First attempt with current settings
    match do_sync(&settings, &download_dir) {
        Ok(result) => Ok(result),
        Err(error) => {
            // If SSL error and we haven't already enabled SSL bypass, retry with it
            if is_ssl_error(&error) && !settings.proxy.accept_invalid_certs {
                log::warn!("SSL error detected, retrying with certificate bypass (Helsenett/enterprise mode)");
                log::warn!("Original error: {}", error);

                // Enable SSL bypass and retry
                settings.proxy.accept_invalid_certs = true;

                match do_sync(&settings, &download_dir) {
                    Ok(result) => {
                        log::info!("Sync succeeded with SSL bypass - this appears to be a Helsenett/enterprise network");
                        Ok(result)
                    }
                    Err(retry_error) => {
                        log::error!("Sync failed even with SSL bypass: {}", retry_error);
                        Err(retry_error)
                    }
                }
            } else {
                Err(error)
            }
        }
    }
}
