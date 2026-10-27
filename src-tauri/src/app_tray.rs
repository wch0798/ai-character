use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{App, AppHandle, Emitter, Manager};

pub fn install(app: &mut App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "캐릭터 보이기", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "hide", "캐릭터 숨기기", true, None::<&str>)?;
    let chat = MenuItem::with_id(app, "chat", "채팅 열기", true, None::<&str>)?;
    let new_chat = MenuItem::with_id(app, "new-chat", "새 채팅", true, None::<&str>)?;
    let stop = MenuItem::with_id(app, "stop", "답변 중지", true, None::<&str>)?;
    let reset_position = MenuItem::with_id(app, "reset-position", "캐릭터 위치 초기화", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "설정", true, None::<&str>)?;
    let setup_web = MenuItem::with_id(app, "setup_web", "처음 설정 (웹)", true, None::<&str>)?;
    let usage = MenuItem::with_id(app, "usage", "사용량", true, None::<&str>)?;
    let automation = MenuItem::with_id(app, "automation", "자동화 현황", true, None::<&str>)?;
    let restart = MenuItem::with_id(app, "restart", "재시작", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(
        app,
        &[
            &show, &hide, &reset_position, &sep, &chat, &new_chat, &stop, &sep, &settings, &setup_web, &usage, &automation, &sep, &restart,
            &quit,
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
            "restart" => {
                #[cfg(desktop)]
                if let Err(error) = crate::updates::restart_to_apply_update(app.clone()) {
                    eprintln!("{error}");
                }
                app.restart()
            }
            "show" => show_main(app),
            "hide" => hide_main(app),
            "setup_web" => {
                if let Err(error) = crate::setup_web::open(app, None) {
                    eprintln!("{error}");
                }
            }
            "chat" | "settings" | "usage" | "automation" | "new-chat" | "stop" | "reset-position" => {
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

/// Tells the page whether it is on screen: WebView2 does not always send `visibilitychange`
/// when the window comes back, and the character must start drawing again.
pub const VISIBILITY_EVENT: &str = "main-window-visibility";

/// Brings the character back: out of the taskbar, onto a screen, in front, drawing again.
pub(crate) fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        bring_onto_a_screen(&window);
        let _ = window.set_always_on_top(true);
        let _ = window.set_focus();
        let _ = window.emit(VISIBILITY_EVENT, true);
    }
}

pub(crate) fn hide_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
        let _ = window.emit(VISIBILITY_EVENT, false);
    }
}

/// The show/hide shortcut. A minimized window counts as hidden: Windows reports it visible,
/// so hiding it again would leave the user with nothing to bring back.
///
/// The global-hotkey callback runs inside its own hidden window's message handler, outside the
/// event loop's normal flow. Showing or focusing a window there can deliver a nested WM_PAINT,
/// which trips tao's `flush_paint_messages` assertion and aborts the app, so the work is queued
/// onto the event loop instead. (`run_on_main_thread` called from the main thread runs at once,
/// so it is sent from another thread.)
pub(crate) fn toggle_main(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || toggle_now(&handle));
    });
}

fn toggle_now(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else { return };
    let visible = window.is_visible().unwrap_or(false);
    let minimized = window.is_minimized().unwrap_or(false);
    if should_hide(visible, minimized) {
        hide_main(app);
    } else {
        show_main(app);
    }
}

fn should_hide(visible: bool, minimized: bool) -> bool {
    visible && !minimized
}

/// A window left on a monitor that is gone (unplugged, resolution changed) is moved to the
/// middle of the primary screen.
fn bring_onto_a_screen(window: &tauri::WebviewWindow) {
    let (Ok(position), Ok(size), Ok(monitors)) = (window.outer_position(), window.outer_size(), window.available_monitors()) else {
        return;
    };
    let center = (position.x + size.width as i32 / 2, position.y + size.height as i32 / 2);
    let screens: Vec<(i32, i32, u32, u32)> = monitors
        .iter()
        .map(|monitor| (monitor.position().x, monitor.position().y, monitor.size().width, monitor.size().height))
        .collect();
    if point_on_a_screen(center, &screens) {
        return;
    }
    if let Ok(Some(primary)) = window.primary_monitor() {
        let (screen, area) = (primary.position(), primary.size());
        let x = screen.x + (area.width.saturating_sub(size.width) / 2) as i32;
        let y = screen.y + (area.height.saturating_sub(size.height) / 2) as i32;
        let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
    }
}

fn point_on_a_screen(point: (i32, i32), screens: &[(i32, i32, u32, u32)]) -> bool {
    screens.iter().any(|&(x, y, width, height)| {
        point.0 >= x && point.0 < x + width as i32 && point.1 >= y && point.1 < y + height as i32
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shortcut_brings_back_a_minimized_window() {
        assert!(should_hide(true, false));
        assert!(!should_hide(true, true));
        assert!(!should_hide(false, false));
    }

    #[test]
    fn finds_windows_left_off_screen() {
        let screens = [(0, 0, 1920, 1080), (1920, 0, 2560, 1440)];
        assert!(point_on_a_screen((100, 100), &screens));
        assert!(point_on_a_screen((3000, 1300), &screens));
        assert!(!point_on_a_screen((5000, 200), &screens));
        assert!(!point_on_a_screen((100, -400), &screens));
    }
}
