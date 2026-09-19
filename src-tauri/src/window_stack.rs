use tauri::Manager;

pub fn suppress_main_always_on_top(app: &tauri::AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.set_always_on_top(false);
    }
}

pub fn restore_main_always_on_top(app: &tauri::AppHandle) {
    if app.get_webview_window("usage-dashboard").is_some() {
        return;
    }
    if app.get_webview_window("work-log").is_some() {
        return;
    }
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.set_always_on_top(true);
    }
}

pub fn bind_main_focus_restore(app: &tauri::AppHandle) {
    let Some(main) = app.get_webview_window("main") else {
        return;
    };
    let handle = app.clone();
    let _ = main.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Focused(true)) {
            restore_main_always_on_top(&handle);
        }
    });
}
