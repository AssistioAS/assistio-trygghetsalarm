use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::Manager;

#[derive(Serialize)]
struct SafetyAlarmSyncResult {
    success: bool,
    stdout: String,
    stderr: String,
    script_path: String,
}

fn find_script_dir_in_tree(root: &Path, depth: usize) -> Option<PathBuf> {
    if depth == 0 {
        return None;
    }
    let script_name = "skyresponse_import_safety_alarms.py";
    if root.join(script_name).exists() {
        return Some(root.to_path_buf());
    }
    let direct_api_dir = root.join("Trygghetsalarmer_API");
    if direct_api_dir.join(script_name).exists() {
        return Some(direct_api_dir);
    }

    let entries = fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if let Some(found) = find_script_dir_in_tree(&path, depth - 1) {
            return Some(found);
        }
    }

    None
}

fn find_trygghetsalarmer_api_dir(app: Option<&tauri::AppHandle>) -> Option<PathBuf> {
    let current_dir = std::env::current_dir().ok()?;
    let candidates = [
        current_dir.clone(),
        current_dir.join(".."),
        current_dir.join("../.."),
    ];

    for candidate in candidates {
        let Ok(normalized) = candidate.canonicalize() else {
            continue;
        };
        if let Some(found) = find_script_dir_in_tree(&normalized, 3) {
            return Some(found);
        }
    }

    if let Some(app_handle) = app {
        let mut extra_candidates: Vec<PathBuf> = Vec::new();
        if let Ok(resource_dir) = app_handle.path().resource_dir() {
            extra_candidates.push(resource_dir);
        }
        if let Ok(exe_path) = std::env::current_exe() {
            if let Some(parent) = exe_path.parent() {
                extra_candidates.push(parent.to_path_buf());
                extra_candidates.push(parent.join("resources"));
            }
        }

        for candidate in extra_candidates {
            let Ok(normalized) = candidate.canonicalize() else {
                continue;
            };
            if let Some(found) = find_script_dir_in_tree(&normalized, 5) {
                return Some(found);
            }
        }
    }

    None
}

fn run_named_python_script(
    api_dir: &Path,
    script_name: &str,
    extra_args: &[&str],
) -> Result<SafetyAlarmSyncResult, String> {
    let script_path = api_dir.join(script_name);
    if !script_path.exists() {
        return Err(format!(
            "Fant ikke importscript: {}",
            script_path.display()
        ));
    }

    let mut last_error = String::new();

    for program in ["py", "python"] {
        let mut command = Command::new(program);
        if let Some(parent) = api_dir.parent() {
            command.current_dir(parent);
        } else {
            command.current_dir(api_dir);
        }
        if program == "py" {
            command.arg("-3");
            command.arg(&script_path);
        } else {
            command.arg(&script_path);
        }
        for extra_arg in extra_args {
            command.arg(extra_arg);
        }

        match command.output() {
            Ok(output) => {
                let stdout = String::from_utf8_lossy(&output.stdout).to_string();
                let stderr = String::from_utf8_lossy(&output.stderr).to_string();
                if output.status.success() {
                    return Ok(SafetyAlarmSyncResult {
                        success: true,
                        stdout,
                        stderr,
                        script_path: script_path.display().to_string(),
                    });
                }
                last_error = format!(
                    "Hepro-sync feilet med {}. Stdout: {} Stderr: {}",
                    output.status,
                    stdout,
                    stderr
                );
            }
            Err(error) => {
                last_error = format!("Kunne ikke starte {}: {}", program, error);
            }
        }
    }

    Err(last_error)
}

fn run_python_script(api_dir: &Path) -> Result<SafetyAlarmSyncResult, String> {
    let base_result = run_named_python_script(
        api_dir,
        "skyresponse_import_safety_alarms.py",
        &["--download"],
    )?;
    let heartbeat_result = run_named_python_script(
        api_dir,
        "skyresponse_import_alarm_heartbeats.py",
        &["--download"],
    )?;

    Ok(SafetyAlarmSyncResult {
        success: true,
        stdout: format!(
            "{}\n\nHeartbeat sync\n{}",
            base_result.stdout.trim(),
            heartbeat_result.stdout.trim()
        ),
        stderr: [base_result.stderr.trim(), heartbeat_result.stderr.trim()]
            .into_iter()
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n"),
        script_path: format!(
            "{};{}",
            base_result.script_path,
            heartbeat_result.script_path
        ),
    })
}

#[tauri::command]
fn run_safety_alarm_hepro_sync(app: tauri::AppHandle) -> Result<SafetyAlarmSyncResult, String> {
    let api_dir = find_trygghetsalarmer_api_dir(Some(&app)).ok_or_else(|| {
        "Fant ikke Trygghetsalarmer_API. Hepro-sync krever at scriptressursene er tilgjengelige.".to_string()
    })?;
    run_python_script(&api_dir)
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
