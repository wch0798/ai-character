//! Windows에서 콘솔(CMD) 창이 깜빡이지 않게 프로세스를 실행하고,
//! 셸 없이 CPU/RAM 통계를 읽습니다.

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use std::process::Command;
#[cfg(windows)]
use std::sync::atomic::{AtomicU64, Ordering};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(windows)]
pub fn hide_console(command: &mut Command) -> &mut Command {
    command.creation_flags(CREATE_NO_WINDOW)
}

#[cfg(not(windows))]
pub fn hide_console(command: &mut std::process::Command) -> &mut std::process::Command {
    command
}

#[cfg(windows)]
#[repr(C)]
struct ProcessMemoryCounters {
    cb: u32,
    page_fault_count: u32,
    peak_working_set_size: usize,
    working_set_size: usize,
    quota_peak_paged_pool_usage: usize,
    quota_paged_pool_usage: usize,
    quota_peak_non_paged_pool_usage: usize,
    quota_non_paged_pool_usage: usize,
    pagefile_usage: usize,
    peak_pagefile_usage: usize,
}

#[cfg(windows)]
#[repr(C)]
struct FileTime {
    low: u32,
    high: u32,
}

#[cfg(windows)]
impl FileTime {
    fn as_u64(self) -> u64 {
        ((self.high as u64) << 32) | self.low as u64
    }
}

#[cfg(windows)]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetCurrentProcess() -> isize;
    fn K32GetProcessMemoryInfo(
        process: isize,
        ppsmem_counters: *mut ProcessMemoryCounters,
        cb: u32,
    ) -> i32;
    fn GetProcessTimes(
        process: isize,
        creation: *mut FileTime,
        exit: *mut FileTime,
        kernel: *mut FileTime,
        user: *mut FileTime,
    ) -> i32;
}

#[cfg(windows)]
static LAST_CPU_FILETIME: AtomicU64 = AtomicU64::new(0);
#[cfg(windows)]
static LAST_CPU_MS: AtomicU64 = AtomicU64::new(0);

/// 셸/CMD 없이 현재 프로세스 CPU% · Working Set(MB)을 읽습니다.
#[cfg(windows)]
pub fn read_process_stats() -> Result<(f64, f64), String> {
    unsafe {
        let process = GetCurrentProcess();

        let mut counters = std::mem::zeroed::<ProcessMemoryCounters>();
        counters.cb = std::mem::size_of::<ProcessMemoryCounters>() as u32;
        if K32GetProcessMemoryInfo(process, &mut counters, counters.cb) == 0 {
            return Err("Windows 메모리 정보를 읽지 못했습니다.".to_string());
        }
        let memory_mb = counters.working_set_size as f64 / (1024.0 * 1024.0);

        let mut creation = FileTime { low: 0, high: 0 };
        let mut exit = FileTime { low: 0, high: 0 };
        let mut kernel = FileTime { low: 0, high: 0 };
        let mut user = FileTime { low: 0, high: 0 };
        if GetProcessTimes(
            process,
            &mut creation,
            &mut exit,
            &mut kernel,
            &mut user,
        ) == 0
        {
            return Ok((0.0, memory_mb));
        }

        let cpu_filetime = kernel.as_u64().saturating_add(user.as_u64());
        let wall_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        let prev_cpu = LAST_CPU_FILETIME.swap(cpu_filetime, Ordering::SeqCst);
        let prev_wall = LAST_CPU_MS.swap(wall_ms, Ordering::SeqCst);

        let cores = std::thread::available_parallelism()
            .map(|n| n.get() as f64)
            .unwrap_or(1.0)
            .max(1.0);

        let cpu_percent = if prev_cpu == 0 || prev_wall == 0 || wall_ms <= prev_wall {
            0.0
        } else {
            let delta_cpu = cpu_filetime.saturating_sub(prev_cpu) as f64;
            // FILETIME = 100ns units; wall is ms → 10_000 * 100ns
            let delta_wall_100ns = (wall_ms - prev_wall) as f64 * 10_000.0;
            if delta_wall_100ns <= 0.0 {
                0.0
            } else {
                ((delta_cpu / delta_wall_100ns) * 100.0 / cores).clamp(0.0, 100.0)
            }
        };

        Ok((cpu_percent, memory_mb))
    }
}
