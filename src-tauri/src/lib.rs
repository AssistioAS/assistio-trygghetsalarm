mod hepro;

use serde::Serialize;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![run_safety_alarm_hepro_sync])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
