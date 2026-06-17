mod hepro;

use serde::Serialize;
use tauri::Manager;

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
fn run_safety_alarm_hepro_sync(_app: tauri::AppHandle) -> Result<SafetyAlarmSyncResult, String> {
    // Use native Rust implementation instead of Python scripts
    let result = hepro::run_full_sync(None)?;

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
        .invoke_handler(tauri::generate_handler![run_safety_alarm_hepro_sync, get_log_path])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
