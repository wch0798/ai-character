use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{App, AppHandle, Emitter, Manager};

pub fn install(app: &mut App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "캐릭터 보이기", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "hide", "캐릭터 숨기기", true, None::<&str>)?;
    let chat = MenuItem::with_id(app, "chat", "채팅 열기", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "설정", true, None::<&str>)?;
    let usage = MenuItem::with_id(app, "usage", "사용량", true, None::<&str>)?;
    let restart = MenuItem::with_id(app, "restart", "재시작", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(
        app,
        &[
            &show, &hide, &sep, &chat, &settings, &usage, &sep, &restart, &quit,
        ],
    )?;

    let Some(icon) = app.default_window_icon().cloned() else {
        eprintln!("트레이 아이콘 리소스가 없어 시스템 트레이를 건너뜁니다.");
        return Ok(());
    };

    let _tray = TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("AI Character")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "quit" => app.exit(0),
            "restart" => app.restart(),
            "show" => show_main(app),
            "hide" => hide_main(app),
            "chat" | "settings" | "usage" => {
                show_main(app);
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.emit("tray-action", event.id().as_ref());
                }
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.set_always_on_top(true);
    }
}

fn hide_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}
