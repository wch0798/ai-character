mod alerts;
mod setup_web;
mod usage_report;
mod local_ai;
mod remote_ai;
mod chat_state;
mod workspace_changes;
mod run_history;
mod usage_dashboard;
use agent_commands::launch_git_installer;
use agent_commands::prepare_cradle_environment;
use agent_commands::get_cradle_environment_status;
use agent_commands::run_automatic_provider;
use agent_commands::get_automatic_provider_status;
use agent_commands::get_free_auto_readiness;
use agent_commands::open_keys_env_file;
use agent_commands::ensure_keys_env_file;
use crate::web_search::search_web_background;
use agent_commands::open_web_agent;
use agent_commands::list_web_accounts;
use agent_commands::update_web_accounts;
use agent_commands::open_web_account;
use agent_commands::open_all_web_accounts;
use agent_commands::open_alternate_web_agent;
use agent_commands::close_web_account;
use agent_commands::close_web_accounts;
use agent_commands::list_agent_runs;
use agent_commands::restore_checkpoint;
use agent_commands::list_checkpoints;
#[cfg(target_os = "macos")]
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use crate::chat_state::{get_state_db_path, load_ui_state, save_ui_state};
use agent_commands::{
    apply_workspace_changes, discard_workspace_changes, get_workspace_changes,
    get_workspace_diff,
};
mod agent_commands;
use agent_commands::{get_app_preferences, get_sensitive_files, set_app_preferences};
mod agent_core;
mod agent_install;
mod settings;
mod windows_process;
#[cfg(windows)]
mod windows_setup;
mod workspace;
mod live2d_resources;
mod live2d_user;
mod text_files;
mod web_search;
mod provider_router;
mod environment_preflight;
mod local_env;
mod web_accounts;
mod isolated_browser;
mod path_guard;
mod window_stack;
mod app_tray;
mod work_log;
mod click_through;
mod claude_plugins;
mod single_instance;
mod usage_ledger;
mod policy_engine;
mod cloud_commands;
mod context_optimizer;
mod process_util;
mod coder_worktree;
mod test_runner;
mod claude_integration;
#[cfg(desktop)]
mod scheduled_jobs;
#[cfg(desktop)]
mod updates;

use agent_commands::{
    ask_claude, cancel_agent, detect_agent, detect_agent_runtime, get_project_dir, run_agent,
    set_agent_path, set_project_dir, get_conversation_dir, set_conversation_dir,
};
use usage_dashboard::{get_usage_snapshot, open_usage_dashboard};

static ATTACHMENT_STAGE_COUNTER: AtomicU64 = AtomicU64::new(1);
#[cfg(test)]
fn claude_args(prompt: &str) -> Vec<String> {
    vec!["-p".to_string(), prompt.to_string()]
}

fn inspect_attachment_access_impl(path: &std::path::Path) -> Vec<bool> {
    let exists = path.exists();
    let is_file = path.is_file();

    let readable = is_file && std::fs::File::open(path).is_ok();

    /*
     * truncate/create 없이 쓰기 권한만 확인한다.
     * 파일 내용은 변경하지 않는다.
     */
    let writable = is_file && std::fs::OpenOptions::new().write(true).open(path).is_ok();

    vec![exists, is_file, readable, writable]
}

#[tauri::command]
fn inspect_attachment_access(path: String) -> Result<Vec<bool>, String> {
    if path.trim().is_empty() {
        return Err("파일 경로가 비어 있습니다.".to_string());
    }

    let allowed = crate::path_guard::assert_inspectable_path(std::path::Path::new(&path))?;
    Ok(inspect_attachment_access_impl(&allowed))
}

fn configured_attachment_project_dir() -> std::path::PathBuf {
    crate::settings::load_settings()
        .ok()
        .and_then(|settings| settings.project_dir)
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| std::path::PathBuf::from("."))
}

fn attachment_stage_root() -> std::path::PathBuf {
    configured_attachment_project_dir()
        .join(".ai-character")
        .join("attachments")
        .join(format!("attachments-{}", std::process::id()))
}

fn stage_attachment_impl(source: &std::path::Path) -> Result<std::path::PathBuf, String> {
    let source = crate::path_guard::assert_inspectable_path(source)?;
    if !source.exists() {
        return Err("원본 파일이 없습니다.".to_string());
    }

    if !source.is_file() {
        return Err("현재는 파일만 첨부할 수 있습니다.".to_string());
    }

    /*
     * 실제로 읽기 가능한지 먼저 확인.
     */
    std::fs::File::open(&source).map_err(|error| format!("원본 파일 읽기 권한 없음: {}", error))?;

    let root = attachment_stage_root();

    std::fs::create_dir_all(&root)
        .map_err(|error| format!("임시 첨부 폴더 생성 실패: {}", error))?;

    let original_name = source
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("attachment");

    let id = ATTACHMENT_STAGE_COUNTER.fetch_add(1, Ordering::Relaxed);

    let target = root.join(format!("{:06}-{}", id, original_name));

    std::fs::copy(source, &target)
        .map_err(|error| format!("첨부 파일 임시복사 실패: {}", error))?;

    Ok(target)
}

#[tauri::command]
fn stage_attachment(path: String) -> Result<String, String> {
    let staged = stage_attachment_impl(std::path::Path::new(&path))?;

    let project_dir = configured_attachment_project_dir();
    let project = project_dir.as_path();

    let relative = staged
        .strip_prefix(project)
        .map_err(|error| format!("프로젝트 상대경로 변환 실패: {}", error))?;

    relative
        .to_str()
        .map(|value| value.to_string())
        .ok_or_else(|| "임시 파일 경로 변환 실패".to_string())
}

#[tauri::command]
fn remove_staged_attachment(path: String) -> Result<(), String> {
    let supplied = std::path::PathBuf::from(&path);

    let target = if supplied.is_absolute() {
        supplied
    } else {
        configured_attachment_project_dir().join(supplied)
    };

    let root = attachment_stage_root();

    if !target.starts_with(&root) {
        return Err("임시 첨부 경로가 아닙니다.".to_string());
    }

    if target.exists() {
        std::fs::remove_file(&target).map_err(|error| format!("임시 첨부 삭제 실패: {}", error))?;
    }

    Ok(())
}

#[cfg(target_os = "macos")]
fn parse_process_stats(output: &str) -> Result<(f64, f64), String> {
    let mut values = output.split_whitespace();

    let cpu_percent = values
        .next()
        .ok_or("CPU 정보가 없습니다.")?
        .parse::<f64>()
        .map_err(|error| format!("CPU 파싱 실패: {}", error))?;

    let rss_kb = values
        .next()
        .ok_or("RAM 정보가 없습니다.")?
        .parse::<f64>()
        .map_err(|error| format!("RAM 파싱 실패: {}", error))?;

    Ok((cpu_percent, rss_kb / 1024.0))
}

#[tauri::command]
async fn get_process_stats() -> Result<Vec<f64>, String> {
    let pid = std::process::id();

    let result = tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "macos")]
        {
            let output = Command::new("/bin/ps")
                .args(["-p", &pid.to_string(), "-o", "%cpu=", "-o", "rss="])
                .env("LC_ALL", "C")
                .output()
                .map_err(|error| format!("ps 실행 실패: {}", error))?;

            if !output.status.success() {
                return Err("프로세스 정보를 읽지 못했습니다.".to_string());
            }

            let text = String::from_utf8_lossy(&output.stdout);
            let (cpu, memory_mb) = parse_process_stats(&text)?;
            return Ok(vec![cpu, memory_mb]);
        }

        #[cfg(windows)]
        {
            let _ = pid;
            let (cpu, memory_mb) = crate::windows_process::read_process_stats()?;
            return Ok(vec![cpu, memory_mb]);
        }

        #[cfg(all(unix, not(target_os = "macos")))]
        {
            let _ = pid;
            Ok(vec![0.0, 0.0])
        }
    })
    .await
    .map_err(|error| format!("성능 조회 작업 실패: {}", error))?;

    result
}

fn should_show_window(is_visible: bool) -> bool {
    !is_visible
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_uses_print_mode() {
        let args = claude_args("안녕");

        assert_eq!(args, vec!["-p".to_string(), "안녕".to_string(),]);
    }

    #[test]
    fn stages_attachment_into_temp_area() {
        let source =
            std::env::temp_dir().join(format!("ai-character-source-{}.txt", std::process::id()));

        std::fs::write(&source, b"temporary attachment").unwrap();

        let staged = stage_attachment_impl(&source).unwrap();

        assert!(staged.exists());

        assert!(staged.starts_with(attachment_stage_root()));

        assert_eq!(
            std::fs::read_to_string(&staged).unwrap(),
            "temporary attachment"
        );

        let _ = std::fs::remove_file(source);

        let _ = std::fs::remove_file(staged);
    }

    #[test]
    fn attachment_access_reports_readable_file() {
        let path =
            std::env::temp_dir().join(format!("ai-character-access-{}.txt", std::process::id()));

        std::fs::write(&path, b"hello").unwrap();

        let access = inspect_attachment_access_impl(&path);

        assert_eq!(access[0], true);
        assert_eq!(access[1], true);
        assert_eq!(access[2], true);

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn attachment_access_rejects_secret_and_system_paths() {
        assert!(inspect_attachment_access("keys.env".to_string()).is_err());
        assert!(inspect_attachment_access("/etc/passwd".to_string()).is_err());
        #[cfg(windows)]
        assert!(inspect_attachment_access(r"C:\Windows\System32\config\SAM".to_string()).is_err());
    }
}

#[cfg(target_os = "macos")]
#[cfg(test)]
mod process_stats_tests {
    use super::*;

    #[test]
    fn parses_process_stats() {
        let (cpu, memory_mb) = parse_process_stats(" 12.5 153600\n").unwrap();

        assert_eq!(cpu, 12.5);

        assert_eq!(memory_mb, 150.0);
    }
}

/// Claude Code hooks re-invoke this binary with `--cradle-hook <kind>`.
pub fn run_cli_hook() -> Option<i32> {
    claude_integration::run_hook_from_args()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    crate::single_instance::claim();
    let _ = local_env::load_on_startup();

    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            crate::alerts::init(app.handle().clone());
            // 외장 볼륨 keys는 시작 시 자동 접근하지 않음(TCC 대화로 UI가 막히는 것 방지).
            // 키가 필요하면 Application Support 또는 사용자가 허용한 뒤 설정에서 연다.
            let _ = app;
            #[cfg(desktop)]
            {
                use tauri::Manager;
                use tauri_plugin_global_shortcut::ShortcutState;

                let shortcut = tauri_plugin_global_shortcut::Builder::new()
                    .with_shortcuts(["ctrl+shift+space"])
                    .map(|builder| {
                        builder
                            .with_handler(|app, _shortcut, event| {
                                if event.state != ShortcutState::Pressed {
                                    return;
                                }

                                let Some(window) = app.get_webview_window("main") else {
                                    eprintln!("main window를 찾지 못했습니다.");
                                    return;
                                };

                                match window.is_visible() {
                                    Ok(is_visible) => {
                                        if should_show_window(is_visible) {
                                            if let Err(error) = window.show() {
                                                eprintln!("창 표시 실패: {}", error);
                                            }
                                        } else if let Err(error) = window.hide() {
                                            eprintln!("창 숨김 실패: {}", error);
                                        }
                                    }

                                    Err(error) => {
                                        eprintln!("창 상태 확인 실패: {}", error);
                                    }
                                }
                            })
                            .build()
                    });
                match shortcut {
                    Ok(plugin) => {
                        if let Err(error) = app.handle().plugin(plugin) {
                            eprintln!("전역 단축키를 건너뜁니다: {error}");
                        }
                    }
                    Err(error) => {
                        eprintln!("전역 단축키를 건너뜁니다: {error}");
                    }
                }
                match app
                    .handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())
                {
                    Ok(()) => crate::updates::mark_updater_ready(),
                    Err(error) => eprintln!("앱 업데이터를 건너뜁니다: {error}"),
                }
                crate::updates::start(app.handle().clone());
                crate::scheduled_jobs::start(app.handle().clone());
            }

            crate::window_stack::bind_main_focus_restore(app.handle());
            crate::click_through::start(app.handle().clone());
            if let Err(error) = crate::app_tray::install(app) {
                eprintln!("트레이를 건너뜁니다: {error}");
            }
            crate::setup_web::start(app.handle().clone());
            std::thread::spawn(crate::remote_ai::on_startup);

            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            ask_claude,
            get_process_stats,
            inspect_attachment_access,
            stage_attachment,
            remove_staged_attachment,
            run_agent,
            cancel_agent,
            get_project_dir,
            set_project_dir,
            get_conversation_dir,
            set_conversation_dir,
            set_agent_path,
            detect_agent,
            detect_agent_runtime,
            load_ui_state,
            save_ui_state,
            get_state_db_path,
            get_workspace_changes,
            get_workspace_diff,
            apply_workspace_changes,
            discard_workspace_changes,
            get_app_preferences,
            set_app_preferences,
            get_sensitive_files,
            list_agent_runs,
            list_checkpoints,
            restore_checkpoint,
            open_web_agent,
            list_web_accounts,
            update_web_accounts,
            open_web_account,
            open_all_web_accounts,
            open_alternate_web_agent,
            close_web_account,
            close_web_accounts,
            search_web_background,
            get_automatic_provider_status,
            get_free_auto_readiness,
            open_keys_env_file,
            ensure_keys_env_file,
            open_usage_dashboard,
            crate::work_log::open_work_log,
            crate::work_log::get_work_log,
            crate::work_log::set_work_log,
            crate::work_log::close_work_log,
            crate::click_through::get_screen_cursor,
            crate::click_through::set_click_through_regions,
            crate::click_through::set_click_through_capture,
            get_usage_snapshot,
            run_automatic_provider,
            get_cradle_environment_status,
            prepare_cradle_environment,
            launch_git_installer,
            agent_install::get_runtime_setup_status,
            agent_install::install_windows_runtimes,
            agent_install::install_agent_cli,
            agent_install::install_all_required_runtimes,
            agent_install::launch_agent_login,
            agent_install::launch_github_login,
            claude_plugins::get_claude_plugins,
            claude_plugins::add_claude_plugin_marketplace,
            claude_plugins::install_claude_plugin,
            claude_plugins::set_claude_plugin_enabled,
            claude_plugins::uninstall_claude_plugin,
            claude_plugins::open_claude_plugin_catalog,
            live2d_resources::read_live2d_bytes,
            live2d_resources::read_live2d_text,
            live2d_user::resolve_live2d_abs_path,
            live2d_user::append_debug_log,
            live2d_user::read_force_live2d_model,
            live2d_user::clear_force_live2d_model,
            live2d_user::get_user_live2d_dir,
            live2d_user::open_user_live2d_dir,
            live2d_user::list_user_live2d_models,
            live2d_user::import_user_live2d_model,
            live2d_user::remove_user_live2d_model,
            live2d_user::dedupe_user_live2d_models,
            text_files::write_text_file,
            text_files::read_text_file,
            policy_engine::get_policy_settings,
            policy_engine::set_policy_settings,
            policy_engine::request_paid_approval,
            policy_engine::request_risky_action_approval,
            policy_engine::classify_shell_command,
            cloud_commands::list_api_usage,
            cloud_commands::get_api_usage_summary,
            cloud_commands::list_provider_models,
            cloud_commands::refresh_free_models,
            cloud_commands::list_paid_approvals,
            cloud_commands::list_update_history,
            cloud_commands::get_agent_success_rates,
            context_optimizer::build_task_context,
            coder_worktree::create_coder_worktree,
            coder_worktree::merge_coder_worktree,
            coder_worktree::discard_coder_worktree,
            test_runner::detect_project_test_commands,
            test_runner::run_project_tests,
            claude_integration::get_claude_integration_settings,
            claude_integration::set_claude_integration_settings,
            claude_integration::get_claude_integration_status,
            claude_plugins::update_claude_plugins,
            local_env::get_api_key_status,
            local_env::save_api_key,
            local_env::test_api_key,
            updates::get_update_settings,
            updates::set_update_settings,
            updates::set_cradle_activity,
            updates::run_updates_now,
            updates::has_pending_app_update,
            updates::restart_to_apply_update,
            updates::get_update_status,
            updates::cancel_updates,
            updates::get_updater_build_status,
            setup_web::open_setup_web,
            setup_web::reset_recommended_settings,
            usage_report::get_usage_report,
            scheduled_jobs::list_scheduled_jobs,
            scheduled_jobs::running_scheduled_jobs,
            scheduled_jobs::cancel_scheduled_job,
            scheduled_jobs::list_scheduled_job_runs,
            alerts::get_usage_alerts,
            alerts::get_alert_settings,
            alerts::set_alert_settings,
            alerts::notify_desktop,
            scheduled_jobs::save_scheduled_job,
            scheduled_jobs::delete_scheduled_job,
            scheduled_jobs::run_scheduled_job_now,
            scheduled_jobs::open_reports_folder
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
