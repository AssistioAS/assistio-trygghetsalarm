mod hepro;

use serde::Serialize;
use std::sync::{Mutex, OnceLock};
use tauri::Manager;

static HEPRO_OPERATION_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn hepro_operation_lock() -> &'static Mutex<()> {
    HEPRO_OPERATION_LOCK.get_or_init(|| Mutex::new(()))
}

#[derive(Serialize)]
struct SafetyAlarmSyncResult {
    success: bool,
    message: String,
    safety_alarms_created: i32,
    safety_alarms_updated: i32,
    safety_alarms_total: i32,
    heartbeats_created: i32,
    heartbeats_updated: i32,
    heartbeats_total: i32,
}

#[tauri::command]
fn run_safety_alarm_hepro_sync(app: tauri::AppHandle) -> Result<SafetyAlarmSyncResult, String> {
    let _guard = hepro_operation_lock()
        .try_lock()
        .map_err(|_| "Hepro-synkronisering eller tilkoblingstest pågår allerede.".to_string())?;

    let settings_path = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Kunne ikke finne appdata-mappe: {}", e))?
        .join("settings.json");

    log::info!(
        "Manual/automatic Hepro sync invoked. Settings path: {}",
        settings_path.display()
    );

    // Use native Rust implementation instead of Python scripts
    let result = hepro::run_full_sync(Some(&settings_path))?;

    Ok(SafetyAlarmSyncResult {
        success: result.success,
        message: result.message,
        safety_alarms_created: result.safety_alarms_created,
        safety_alarms_updated: result.safety_alarms_updated,
        safety_alarms_total: result.safety_alarms_total,
        heartbeats_created: result.heartbeats_created,
        heartbeats_updated: result.heartbeats_updated,
        heartbeats_total: result.heartbeats_total,
    })
}

#[derive(Serialize)]
struct HeproConnectionTestResult {
    success: bool,
    message: String,
    settings_path: String,
    log_path: String,
}

#[tauri::command]
fn test_hepro_connection(app: tauri::AppHandle) -> Result<HeproConnectionTestResult, String> {
    let _guard = hepro_operation_lock()
        .try_lock()
        .map_err(|_| "Hepro-synkronisering eller tilkoblingstest pågår allerede.".to_string())?;

    let settings_path = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Kunne ikke finne appdata-mappe: {}", e))?
        .join("settings.json");
    let log_path = app
        .path()
        .app_log_dir()
        .map_err(|e| format!("Kunne ikke finne loggmappe: {}", e))?
        .join("app.log");

    log::info!(
        "Hepro connection test invoked. Settings path: {}",
        settings_path.display()
    );

    let test_result = hepro::load_settings(Some(&settings_path))
        .and_then(|settings| hepro::login_and_get_token(&settings));

    match test_result {
        Ok(_) => {
            log::info!("Hepro connection test succeeded");
            Ok(HeproConnectionTestResult {
                success: true,
                message: "Tilkobling OK. Login-token ble hentet fra Hepro/Skyresponse.".to_string(),
                settings_path: settings_path.to_string_lossy().to_string(),
                log_path: log_path.to_string_lossy().to_string(),
            })
        }
        Err(error) => {
            log::error!("Hepro connection test failed: {}", error);
            Ok(HeproConnectionTestResult {
                success: false,
                message: format!("Tilkobling feilet: {}", error),
                settings_path: settings_path.to_string_lossy().to_string(),
                log_path: log_path.to_string_lossy().to_string(),
            })
        }
    }
}

#[tauri::command]
fn get_log_path(app: tauri::AppHandle) -> Result<String, String> {
    let log_dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    let log_file = log_dir.join("app.log");
    Ok(log_file.to_string_lossy().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::LogDir { file_name: Some("app.log".into()) },
                ))
                .max_file_size(1_000_000) // 1MB per file
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepOne)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            run_safety_alarm_hepro_sync,
            test_hepro_connection,
            get_log_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
