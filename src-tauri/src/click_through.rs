use serde::Deserialize;
use std::sync::atomic::{AtomicIsize, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HitRegion {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl HitRegion {
    fn contains(self, x: i32, y: i32) -> bool {
        let px = x as f64;
        let py = y as f64;
        px >= self.x
            && py >= self.y
            && px <= self.x + self.width
            && py <= self.y + self.height
    }
}

struct ClickThroughState {
    regions: Vec<HitRegion>,
    capture: bool,
}

impl Default for ClickThroughState {
    fn default() -> Self {
        Self {
            regions: Vec::new(),
            capture: false,
        }
    }
}

static STATE: Mutex<ClickThroughState> = Mutex::new(ClickThroughState {
    regions: Vec::new(),
    capture: false,
});

static MAIN_HWND: AtomicIsize = AtomicIsize::new(0);

#[cfg(windows)]
const GWL_EXSTYLE: i32 = -20;
#[cfg(windows)]
const WS_EX_TRANSPARENT: isize = 0x0000_0020;
#[cfg(windows)]
const WS_EX_LAYERED: isize = 0x0008_0000;
#[cfg(windows)]
const SWP_NOSIZE: u32 = 0x0001;
#[cfg(windows)]
const SWP_NOMOVE: u32 = 0x0002;
#[cfg(windows)]
const SWP_NOZORDER: u32 = 0x0004;
#[cfg(windows)]
const SWP_NOACTIVATE: u32 = 0x0010;
#[cfg(windows)]
const SWP_FRAMECHANGED: u32 = 0x0020;
#[cfg(windows)]
const WM_TIMER: u32 = 0x0113;
#[cfg(windows)]
const WM_NCDESTROY: u32 = 0x0082;
#[cfg(windows)]
const WM_CLICK_THROUGH: u32 = 0x8000 + 0x31;
#[cfg(windows)]
const TIMER_ID: usize = 0xA1C7;
#[cfg(windows)]
const SUBCLASS_ID: usize = 0xA1C8;

#[cfg(windows)]
#[repr(C)]
struct Point {
    x: i32,
    y: i32,
}

#[cfg(windows)]
#[link(name = "user32")]
extern "system" {
    fn GetCursorPos(point: *mut Point) -> i32;
    fn GetWindowLongPtrW(hwnd: *mut std::ffi::c_void, index: i32) -> isize;
    fn SetWindowLongPtrW(hwnd: *mut std::ffi::c_void, index: i32, new_long: isize) -> isize;
    fn SetWindowPos(
        hwnd: *mut std::ffi::c_void,
        insert_after: *mut std::ffi::c_void,
        x: i32,
        y: i32,
        cx: i32,
        cy: i32,
        flags: u32,
    ) -> i32;
    fn PostMessageW(hwnd: *mut std::ffi::c_void, msg: u32, wparam: usize, lparam: isize) -> i32;
    fn SetTimer(hwnd: *mut std::ffi::c_void, id: usize, elapse: u32, timer_fn: *mut std::ffi::c_void) -> usize;
    fn KillTimer(hwnd: *mut std::ffi::c_void, id: usize) -> i32;
}

#[cfg(windows)]
#[link(name = "comctl32")]
extern "system" {
    fn SetWindowSubclass(
        hwnd: *mut std::ffi::c_void,
        pfn: unsafe extern "system" fn(
            *mut std::ffi::c_void,
            u32,
            usize,
            isize,
            usize,
            usize,
        ) -> isize,
        id: usize,
        data: usize,
    ) -> i32;
    fn InitCommonControls();
    fn RemoveWindowSubclass(
        hwnd: *mut std::ffi::c_void,
        pfn: unsafe extern "system" fn(
            *mut std::ffi::c_void,
            u32,
            usize,
            isize,
            usize,
            usize,
        ) -> isize,
        id: usize,
    ) -> i32;
    fn DefSubclassProc(
        hwnd: *mut std::ffi::c_void,
        msg: u32,
        wparam: usize,
        lparam: isize,
    ) -> isize;
}

pub fn screen_cursor() -> Option<(i32, i32)> {
    #[cfg(windows)]
    {
        let mut point = Point { x: 0, y: 0 };
        if unsafe { GetCursorPos(&mut point) } == 0 {
            return None;
        }
        return Some((point.x, point.y));
    }
    #[cfg(target_os = "macos")]
    {
        return macos_screen_cursor();
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    None
}

#[cfg(target_os = "macos")]
#[repr(C)]
struct CGPoint {
    x: f64,
    y: f64,
}

#[cfg(target_os = "macos")]
#[repr(C)]
struct CGSize {
    width: f64,
    height: f64,
}

#[cfg(target_os = "macos")]
#[repr(C)]
struct CGRect {
    origin: CGPoint,
    size: CGSize,
}

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CGEventCreate(source: *const std::ffi::c_void) -> *mut std::ffi::c_void;
    fn CGEventGetLocation(event: *mut std::ffi::c_void) -> CGPoint;
    fn CGMainDisplayID() -> u32;
    fn CGDisplayBounds(display: u32) -> CGRect;
    fn CFRelease(cf: *const std::ffi::c_void);
}

#[cfg(target_os = "macos")]
fn macos_screen_cursor() -> Option<(i32, i32)> {
    unsafe {
        let event = CGEventCreate(std::ptr::null());
        if event.is_null() {
            return None;
        }
        let point = CGEventGetLocation(event);
        CFRelease(event);
        let bounds = CGDisplayBounds(CGMainDisplayID());
        Some(quartz_point_to_top_left(
            point.x,
            point.y,
            bounds.size.height,
        ))
    }
}

#[cfg(any(test, target_os = "macos"))]
fn quartz_point_to_top_left(x: f64, y: f64, primary_height: f64) -> (i32, i32) {
    (x.round() as i32, (primary_height - y).round() as i32)
}

#[tauri::command]
pub fn get_screen_cursor() -> Result<Vec<i32>, String> {
    screen_cursor()
        .map(|(x, y)| vec![x, y])
        .ok_or_else(|| "커서 위치를 읽지 못했습니다.".into())
}

#[tauri::command]
pub fn set_click_through_regions(regions: Vec<HitRegion>, capture: bool) -> Result<(), String> {
    {
        let mut state = STATE
            .lock()
            .map_err(|_| "클릭 통과 상태를 잠그지 못했습니다.".to_string())?;
        state.regions = regions;
        state.capture = capture;
    }
    request_apply();
    Ok(())
}

#[tauri::command]
pub fn set_click_through_capture(capture: bool) -> Result<(), String> {
    {
        let mut state = STATE
            .lock()
            .map_err(|_| "클릭 통과 상태를 잠그지 못했습니다.".to_string())?;
        state.capture = capture;
    }
    request_apply();
    Ok(())
}

pub fn start(app: AppHandle) {
    refresh_hwnd(&app);
    #[cfg(windows)]
    {
        install_window_hook();
    }
    #[cfg(target_os = "macos")]
    {
        start_macos_click_through(app);
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        std::thread::Builder::new()
            .name("click-through".into())
            .spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_millis(32));
                let (capture, regions) = {
                    let Ok(state) = STATE.lock() else {
                        continue;
                    };
                    (state.capture, state.regions.clone())
                };
                let ignore = if capture {
                    false
                } else {
                    match screen_cursor() {
                        Some((x, y)) => !regions.iter().copied().any(|region| region.contains(x, y)),
                        None => continue,
                    }
                };
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_ignore_cursor_events(ignore);
                }
            })
            .ok();
    }
}

#[cfg(target_os = "macos")]
fn start_macos_click_through(app: AppHandle) {
    std::thread::Builder::new()
        .name("click-through".into())
        .spawn(move || {
            let mut last: Option<bool> = None;
            loop {
                std::thread::sleep(std::time::Duration::from_millis(16));
                let Some(ignore) = desired_ignore() else {
                    continue;
                };
                if last == Some(ignore) {
                    continue;
                }
                last = Some(ignore);
                let handle = app.clone();
                let _ = app.run_on_main_thread(move || {
                    if let Some(window) = handle.get_webview_window("main") {
                        let _ = window.set_ignore_cursor_events(ignore);
                    }
                });
            }
        })
        .ok();
}

fn refresh_hwnd(app: &AppHandle) {
    #[cfg(windows)]
    {
        if MAIN_HWND.load(Ordering::Relaxed) != 0 {
            return;
        }
        let Some(window) = app.get_webview_window("main") else {
            return;
        };
        if let Ok(hwnd) = window.hwnd() {
            MAIN_HWND.store(hwnd.0 as isize, Ordering::Relaxed);
        }
    }
    #[cfg(not(windows))]
    {
        let _ = app;
    }
}

fn request_apply() {
    #[cfg(windows)]
    {
        let hwnd = MAIN_HWND.load(Ordering::Relaxed);
        if hwnd == 0 {
            return;
        }
        unsafe {
            PostMessageW(hwnd as *mut std::ffi::c_void, WM_CLICK_THROUGH, 0, 0);
        }
    }
}

#[cfg(windows)]
fn install_window_hook() {
    let hwnd = MAIN_HWND.load(Ordering::Relaxed);
    if hwnd == 0 {
        return;
    }
    let handle = hwnd as *mut std::ffi::c_void;
    unsafe {
        InitCommonControls();
        SetWindowSubclass(handle, subclass_proc, SUBCLASS_ID, 0);
        SetTimer(handle, TIMER_ID, 16, std::ptr::null_mut());
        apply_from_state();
    }
}

#[cfg(windows)]
unsafe extern "system" fn subclass_proc(
    hwnd: *mut std::ffi::c_void,
    msg: u32,
    wparam: usize,
    lparam: isize,
    _id: usize,
    _data: usize,
) -> isize {
    if msg == WM_TIMER && wparam == TIMER_ID {
        apply_from_state();
        return 0;
    }
    if msg == WM_CLICK_THROUGH {
        apply_from_state();
        return 0;
    }
    if msg == WM_NCDESTROY {
        KillTimer(hwnd, TIMER_ID);
        RemoveWindowSubclass(hwnd, subclass_proc, SUBCLASS_ID);
    }
    DefSubclassProc(hwnd, msg, wparam, lparam)
}

fn desired_ignore() -> Option<bool> {
    let Ok(state) = STATE.try_lock() else {
        return None;
    };
    if state.capture {
        return Some(false);
    }
    let (x, y) = screen_cursor()?;
    Some(!state.regions.iter().copied().any(|region| region.contains(x, y)))
}

fn apply_from_state() {
    let Some(ignore) = desired_ignore() else {
        return;
    };
    #[cfg(windows)]
    unsafe {
        set_hwnd_transparent(MAIN_HWND.load(Ordering::Relaxed), ignore);
    }
    #[cfg(not(windows))]
    {
        let _ = ignore;
    }
}

#[cfg(windows)]
unsafe fn set_hwnd_transparent(hwnd: isize, ignore: bool) {
    if hwnd == 0 {
        return;
    }
    let handle = hwnd as *mut std::ffi::c_void;
    let current = GetWindowLongPtrW(handle, GWL_EXSTYLE);
    let mut next = current;
    if ignore {
        next |= WS_EX_TRANSPARENT | WS_EX_LAYERED;
    } else {
        next &= !WS_EX_TRANSPARENT;
    }
    if next == current {
        return;
    }
    SetWindowLongPtrW(handle, GWL_EXSTYLE, next);
    SetWindowPos(
        handle,
        std::ptr::null_mut(),
        0,
        0,
        0,
        0,
        SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hit_region_contains_screen_point() {
        let region = HitRegion {
            x: 100.0,
            y: 200.0,
            width: 50.0,
            height: 80.0,
        };
        assert!(region.contains(120, 230));
        assert!(!region.contains(10, 10));
        assert!(region.contains(100, 200));
        assert!(region.contains(150, 280));
        assert!(!region.contains(151, 230));
    }

    #[test]
    fn quartz_bottom_left_maps_to_tauri_top_left() {
        assert_eq!(quartz_point_to_top_left(100.0, 80.0, 1080.0), (100, 1000));
        assert_eq!(quartz_point_to_top_left(0.0, 1080.0, 1080.0), (0, 0));
    }
}
