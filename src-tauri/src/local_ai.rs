//! Local (installed) AI: checks this computer, judges which models can run, and pulls them through Ollama.

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

pub const OLLAMA_BASE: &str = "http://127.0.0.1:11434";
pub const LMSTUDIO_BASE: &str = "http://127.0.0.1:1234";
const PREFERRED_KEY: &str = "local.ollama_model";
const MODELS_DIR_KEY: &str = "local.models_dir";
const MODELS_FOLDER: &str = "AI-Character-Models";
const INSTALL_JOB: &str = "ollama-install";
const DISK_HEADROOM_GB: f64 = 2.0;
#[cfg(target_os = "macos")]
const OLLAMA_MAC_ZIP: &str = "https://ollama.com/download/Ollama-darwin.zip";
#[cfg(windows)]
const OLLAMA_WINDOWS_SETUP: &str = "https://ollama.com/download/OllamaSetup.exe";
pub const OLLAMA_LINUX_COMMAND: &str = "curl -fsSL https://ollama.com/install.sh | sh";

pub struct CatalogModel {
    pub id: &'static str,
    pub label: &'static str,
    pub maker: &'static str,
    pub size_gb: f64,
    pub min_ram_gb: f64,
    pub rec_ram_gb: f64,
    pub note: &'static str,
}

/// Korean and Chinese models from the Ollama library; sizes are the default 4-bit downloads.
pub const CATALOG: &[CatalogModel] = &[
    CatalogModel { id: "exaone3.5:2.4b", label: "EXAONE 3.5 2.4B", maker: "LG AI연구원 (한국)", size_gb: 1.6, min_ram_gb: 4.0, rec_ram_gb: 8.0, note: "한국어 특화 · 가벼워서 어떤 컴퓨터든 무난" },
    CatalogModel { id: "exaone3.5:7.8b", label: "EXAONE 3.5 7.8B", maker: "LG AI연구원 (한국)", size_gb: 4.8, min_ram_gb: 8.0, rec_ram_gb: 16.0, note: "한국어 특화 · 품질과 속도 균형" },
    CatalogModel { id: "exaone-deep:7.8b", label: "EXAONE Deep 7.8B", maker: "LG AI연구원 (한국)", size_gb: 4.8, min_ram_gb: 8.0, rec_ram_gb: 16.0, note: "수학·코딩 추론 특화 (답이 느린 편)" },
    CatalogModel { id: "exaone3.5:32b", label: "EXAONE 3.5 32B", maker: "LG AI연구원 (한국)", size_gb: 19.0, min_ram_gb: 32.0, rec_ram_gb: 48.0, note: "한국어 최고 품질 · 고사양 전용" },
    CatalogModel { id: "qwen3:4b", label: "Qwen3 4B", maker: "Alibaba (중국)", size_gb: 2.5, min_ram_gb: 8.0, rec_ram_gb: 8.0, note: "다국어 · 가벼움" },
    CatalogModel { id: "qwen3:8b", label: "Qwen3 8B", maker: "Alibaba (중국)", size_gb: 5.2, min_ram_gb: 8.0, rec_ram_gb: 16.0, note: "다국어·코딩 균형" },
    CatalogModel { id: "qwen2.5-coder:7b", label: "Qwen2.5 Coder 7B", maker: "Alibaba (중국)", size_gb: 4.7, min_ram_gb: 8.0, rec_ram_gb: 16.0, note: "코딩 특화" },
    CatalogModel { id: "qwen3:14b", label: "Qwen3 14B", maker: "Alibaba (중국)", size_gb: 9.3, min_ram_gb: 16.0, rec_ram_gb: 24.0, note: "더 똑똑하지만 무거움" },
    CatalogModel { id: "qwen3:30b", label: "Qwen3 30B (MoE)", maker: "Alibaba (중국)", size_gb: 19.0, min_ram_gb: 32.0, rec_ram_gb: 48.0, note: "크지만 MoE라 속도는 빠른 편 · 고사양 전용" },
    CatalogModel { id: "deepseek-r1:8b", label: "DeepSeek R1 8B", maker: "DeepSeek (중국)", size_gb: 5.2, min_ram_gb: 8.0, rec_ram_gb: 16.0, note: "추론 특화 (생각 과정을 길게 씀)" },
];

const RECOMMEND_ORDER: &[&str] = &["exaone3.5:7.8b", "qwen3:8b", "exaone3.5:2.4b", "qwen3:4b"];

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    pub os: String,
    pub arch: String,
    pub cpu: Option<String>,
    pub apple_silicon: bool,
    pub nvidia_gpu: bool,
    /// Largest NVIDIA card memory, when `nvidia-smi` answers.
    pub vram_gb: Option<f64>,
    pub gpus: Vec<String>,
    pub ram_gb: Option<f64>,
    pub free_disk_gb: Option<f64>,
    /// Where models will be saved; free space is measured on this drive.
    pub models_dir: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Assessment {
    /// `good`, `slow`, `no_ram`, `no_disk` or `unknown`.
    pub verdict: &'static str,
    pub reason: String,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobProgress {
    pub status: String,
    pub completed: u64,
    pub total: u64,
    pub done: bool,
    pub error: Option<String>,
}

fn jobs() -> &'static Mutex<HashMap<String, JobProgress>> {
    static JOBS: OnceLock<Mutex<HashMap<String, JobProgress>>> = OnceLock::new();
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn set_job(id: &str, update: impl FnOnce(&mut JobProgress)) {
    if let Ok(mut map) = jobs().lock() {
        update(map.entry(id.to_string()).or_default());
    }
}

fn job_running(id: &str) -> bool {
    jobs().lock().ok().and_then(|map| map.get(id).map(|job| !job.done)).unwrap_or(false)
}

fn quiet_command(program: &str) -> Command {
    let mut command = Command::new(program);
    command.stdin(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command
}

fn command_text(program: &str, args: &[&str]) -> Option<String> {
    command_text_env(program, args, &[])
}

fn command_text_env(program: &str, args: &[&str], envs: &[(&str, &std::ffi::OsStr)]) -> Option<String> {
    let mut command = quiet_command(program);
    command.args(args);
    for (name, value) in envs {
        command.env(name, value);
    }
    let output = command.output().ok()?;
    output.status.success().then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

fn default_models_dir() -> Option<PathBuf> {
    home_dir().map(|home| home.join(".ollama").join("models"))
}

/// The folder picked in setup (for example on an external drive).
fn chosen_models_dir() -> Option<PathBuf> {
    crate::settings::load_settings().ok()?.extra(MODELS_DIR_KEY).filter(|value| !value.is_empty()).map(PathBuf::from)
}

/// Ollama saves models under `OLLAMA_MODELS` or `~/.ollama/models` on every OS.
fn models_dir() -> Option<PathBuf> {
    chosen_models_dir()
        .or_else(|| std::env::var_os("OLLAMA_MODELS").filter(|value| !value.is_empty()).map(PathBuf::from))
        .or_else(default_models_dir)
}

/// A picked external drive that is no longer in the disk list (unplugged).
fn models_drive_missing() -> bool {
    chosen_models_dir().is_some_and(|dir| disk_for_dir(&list_disks(), &dir.to_string_lossy()).is_none())
}

/// The models folder may not exist before the first download, so measure its nearest existing parent.
fn existing_ancestor(path: &std::path::Path) -> Option<PathBuf> {
    path.ancestors().find(|candidate| candidate.exists()).map(PathBuf::from)
}

fn gb(bytes: f64) -> f64 {
    (bytes / 1_073_741_824.0 * 10.0).round() / 10.0
}

/// Available kilobytes from the second line of `df -k <path>`.
pub fn parse_df_available_kb(text: &str) -> Option<f64> {
    text.lines().nth(1)?.split_whitespace().nth(3)?.parse().ok()
}

/// `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits` lines: `name, MiB`.
pub fn parse_nvidia_smi(text: &str) -> Vec<(String, f64)> {
    text.lines()
        .filter_map(|line| {
            let (name, memory) = line.rsplit_once(',')?;
            let mib = memory.trim().parse::<f64>().ok()?;
            Some((name.trim().to_string(), (mib / 1024.0 * 10.0).round() / 10.0))
        })
        .filter(|(name, _)| !name.is_empty())
        .collect()
}

/// Four lines from the Windows probe script: total memory bytes, free bytes, CPU name, `|`-joined GPU names.
pub fn parse_windows_probe(text: &str) -> (Option<f64>, Option<f64>, Option<String>, Vec<String>) {
    let mut lines = text.lines().map(str::trim);
    let ram = lines.next().and_then(|line| line.parse::<f64>().ok()).map(gb);
    let free = lines.next().and_then(|line| line.parse::<f64>().ok()).map(gb);
    let cpu = lines.next().filter(|line| !line.is_empty()).map(str::to_string);
    let gpus = lines.next().unwrap_or_default().split('|').map(str::trim).filter(|name| !name.is_empty()).map(str::to_string).collect();
    (ram, free, cpu, gpus)
}

const WINDOWS_PROBE: &str = "$c=Get-CimInstance Win32_ComputerSystem; $p=Get-CimInstance Win32_Processor | Select-Object -First 1; \
    $q=Split-Path -Qualifier $env:AI_CHARACTER_PROBE_PATH; $d=Get-CimInstance Win32_LogicalDisk -Filter \"DeviceID='$q'\"; \
    $g=(Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name }) -join '|'; \
    Write-Output $c.TotalPhysicalMemory; Write-Output $d.FreeSpace; Write-Output $p.Name; Write-Output $g";

pub fn system_info() -> SystemInfo {
    let mut info = SystemInfo {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        ..Default::default()
    };
    let models = models_dir();
    info.models_dir = models.as_ref().map(|path| path.to_string_lossy().into_owned());
    let probe = models
        .as_deref()
        .and_then(existing_ancestor)
        .or_else(home_dir)
        .unwrap_or_else(|| PathBuf::from(if cfg!(windows) { "C:\\" } else { "/" }));
    if cfg!(target_os = "macos") {
        info.ram_gb = command_text("sysctl", &["-n", "hw.memsize"]).and_then(|text| text.parse::<f64>().ok()).map(gb);
        info.cpu = command_text("sysctl", &["-n", "machdep.cpu.brand_string"]);
        info.apple_silicon = info.arch == "aarch64";
    } else if cfg!(windows) {
        let env = [("AI_CHARACTER_PROBE_PATH", probe.as_os_str())];
        if let Some(text) = command_text_env("powershell", &["-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROBE], &env) {
            (info.ram_gb, info.free_disk_gb, info.cpu, info.gpus) = parse_windows_probe(&text);
        }
    } else {
        if let Ok(text) = std::fs::read_to_string("/proc/meminfo") {
            info.ram_gb = text
                .lines()
                .find_map(|line| line.strip_prefix("MemTotal:"))
                .and_then(|rest| rest.split_whitespace().next()?.parse::<f64>().ok())
                .map(|kb| gb(kb * 1024.0));
        }
        if let Ok(text) = std::fs::read_to_string("/proc/cpuinfo") {
            info.cpu = text.lines().find_map(|line| line.strip_prefix("model name")).map(|rest| rest.trim_start_matches([' ', '\t', ':']).to_string());
        }
    }
    if !cfg!(windows) {
        let path = probe.to_string_lossy().into_owned();
        info.free_disk_gb = command_text("df", &["-k", &path]).as_deref().and_then(parse_df_available_kb).map(|kb| gb(kb * 1024.0));
    }
    if !cfg!(target_os = "macos") {
        let cards = command_text("nvidia-smi", &["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"])
            .map(|text| parse_nvidia_smi(&text))
            .unwrap_or_default();
        info.vram_gb = cards.iter().map(|(_, vram)| *vram).reduce(f64::max);
        for (name, _) in cards {
            if !info.gpus.contains(&name) {
                info.gpus.push(name);
            }
        }
    }
    info.nvidia_gpu = info.vram_gb.is_some() || info.gpus.iter().any(|name| name.to_ascii_uppercase().contains("NVIDIA"));
    info
}

pub fn assess(model: &CatalogModel, system: &SystemInfo) -> Assessment {
    if let Some(free) = system.free_disk_gb {
        if free < model.size_gb + DISK_HEADROOM_GB {
            return Assessment {
                verdict: "no_disk",
                reason: format!("저장공간이 부족합니다 ({:.1}GB 필요, 남은 공간 {free:.1}GB)", model.size_gb + DISK_HEADROOM_GB),
            };
        }
    }
    let Some(ram) = system.ram_gb else {
        return Assessment { verdict: "unknown", reason: "메모리 크기를 확인하지 못했습니다".into() };
    };
    // Reported totals run slightly under the marketed size (e.g. 15.9 for 16GB).
    let ram = ram + 0.5;
    if ram < model.min_ram_gb {
        return Assessment {
            verdict: "no_ram",
            reason: format!("메모리가 부족합니다 (최소 {:.0}GB, 이 컴퓨터 {:.0}GB)", model.min_ram_gb, ram.floor()),
        };
    }
    // A model that fits in the graphics card runs there, so system memory matters less.
    let needed_vram = model.size_gb * 1.2;
    // Without nvidia-smi the card size is unknown; assume a common 6-8GB card.
    let fits_gpu = system.nvidia_gpu && system.vram_gb.map_or(model.size_gb <= 6.0, |vram| vram + 0.5 >= needed_vram);
    if system.apple_silicon || fits_gpu {
        if ram < model.rec_ram_gb && !fits_gpu {
            return Assessment {
                verdict: "slow",
                reason: format!("돌아가지만 메모리가 빠듯해 느릴 수 있습니다 (권장 {:.0}GB)", model.rec_ram_gb),
            };
        }
        let place = if fits_gpu { "그래픽카드에서" } else { "Apple 칩에서" };
        return Assessment { verdict: "good", reason: format!("이 컴퓨터의 {place} 잘 돌아갑니다") };
    }
    if ram < model.rec_ram_gb {
        return Assessment {
            verdict: "slow",
            reason: format!("돌아가지만 메모리가 빠듯해 느릴 수 있습니다 (권장 {:.0}GB)", model.rec_ram_gb),
        };
    }
    if model.size_gb <= 3.0 {
        return Assessment { verdict: "good", reason: "작은 모델이라 그래픽 가속 없이도 잘 돌아갑니다".into() };
    }
    let reason = if let (true, Some(vram)) = (system.nvidia_gpu, system.vram_gb) {
        format!("그래픽카드 메모리({vram:.0}GB)보다 커서 일부를 CPU로 돌려 느릴 수 있습니다")
    } else if system.os == "macos" {
        "Intel Mac은 그래픽 가속이 안 돼 답변이 느릴 수 있습니다".to_string()
    } else {
        "NVIDIA 그래픽카드가 없어 CPU로 돌려 답변이 느릴 수 있습니다".to_string()
    };
    Assessment { verdict: "slow", reason }
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Disk {
    pub mount: String,
    pub label: String,
    pub free_gb: f64,
    pub total_gb: f64,
    pub external: bool,
    /// Folder models go to when this disk is picked; empty means Ollama's default folder.
    pub models_dir: String,
}

/// `df -k -P` rows for real local disks; the boot disk's hidden APFS volumes are skipped.
pub fn parse_df_disks(text: &str, macos: bool) -> Vec<Disk> {
    let mut disks = Vec::new();
    let mut root_container = None;
    for line in text.lines().skip(1) {
        let Some(split) = line
            .match_indices('%')
            .map(|(index, _)| index)
            .find(|index| line[index + 1..].starts_with(char::is_whitespace) && line[index + 1..].trim_start().starts_with('/'))
        else {
            continue;
        };
        let mount = line[split + 1..].trim().to_string();
        let fields: Vec<&str> = line[..split].split_whitespace().collect();
        let [device, total, _used, free, ..] = fields.as_slice() else { continue };
        if !device.starts_with("/dev/") {
            continue;
        }
        let name = device.trim_start_matches("/dev/");
        let container: String = match name.strip_prefix("disk") {
            Some(rest) => rest.chars().take_while(char::is_ascii_digit).collect(),
            None => name.to_string(),
        };
        let (total, free) = (total.parse::<f64>().unwrap_or(0.0), free.parse::<f64>().unwrap_or(0.0));
        let external = if macos {
            if mount == "/" {
                root_container = Some(container.clone());
                false
            } else if mount.starts_with("/Volumes/") && root_container.as_deref() != Some(container.as_str()) {
                true
            } else {
                continue;
            }
        } else if mount == "/" {
            false
        } else if ["/media/", "/mnt/", "/run/media/"].iter().any(|prefix| mount.starts_with(prefix)) {
            true
        } else {
            continue;
        };
        let label = if external { mount.rsplit('/').next().unwrap_or(&mount).to_string() } else { "내장 디스크".to_string() };
        let models_dir = if external { format!("{mount}/{MODELS_FOLDER}") } else { String::new() };
        disks.push(Disk { mount, label, free_gb: gb(free * 1024.0), total_gb: gb(total * 1024.0), external, models_dir });
    }
    disks
}

/// Lines of `DeviceID|FreeSpace|Size|VolumeName|DriveType` from Win32_LogicalDisk.
pub fn parse_windows_disks(text: &str, system_drive: &str) -> Vec<Disk> {
    text.lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.trim().split('|').collect();
            let [id, free, size, name, kind] = parts.as_slice() else { return None };
            let free = free.parse::<f64>().ok()?;
            let size = size.parse::<f64>().unwrap_or(0.0);
            let system = id.eq_ignore_ascii_case(system_drive);
            let label = if name.is_empty() { id.to_string() } else { format!("{id} {name}") };
            Some(Disk {
                mount: format!("{id}\\"),
                label: if system { format!("{label} (시스템)") } else { label },
                free_gb: gb(free),
                total_gb: gb(size),
                external: *kind == "2" || !system,
                models_dir: if system { String::new() } else { format!("{id}\\{MODELS_FOLDER}") },
            })
        })
        .collect()
}

pub fn list_disks() -> Vec<Disk> {
    if cfg!(windows) {
        let script = "Get-CimInstance Win32_LogicalDisk | Where-Object { $_.DriveType -in 2,3 } | ForEach-Object { \"$($_.DeviceID)|$($_.FreeSpace)|$($_.Size)|$($_.VolumeName)|$($_.DriveType)\" }";
        let system = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into());
        command_text("powershell", &["-NoProfile", "-NonInteractive", "-Command", script])
            .map(|text| parse_windows_disks(&text, &system))
            .unwrap_or_default()
    } else {
        let args: &[&str] = if cfg!(target_os = "macos") { &["-k", "-P"] } else { &["-k", "-P", "-l"] };
        command_text("df", args).map(|text| parse_df_disks(&text, cfg!(target_os = "macos"))).unwrap_or_default()
    }
}

fn disk_for_dir<'a>(disks: &'a [Disk], dir: &str) -> Option<&'a Disk> {
    if dir.is_empty() {
        return disks.iter().find(|disk| !disk.external);
    }
    disks.iter().filter(|disk| !disk.models_dir.is_empty() && dir.starts_with(&disk.mount)).max_by_key(|disk| disk.mount.len())
}

/// Environment Ollama needs for the chosen model folder. Ollama itself stays on 127.0.0.1;
/// sharing goes through the encrypted connection in `remote_ai`.
pub fn ollama_env() -> Vec<(&'static str, String)> {
    let mut env = Vec::new();
    if let Some(dir) = chosen_models_dir() {
        env.push(("OLLAMA_MODELS", dir.to_string_lossy().into_owned()));
    }
    env
}

fn set_user_env(name: &str, value: Option<&str>) {
    if cfg!(target_os = "macos") {
        let _ = match value {
            Some(value) => quiet_command("launchctl").args(["setenv", name, value]).stdout(Stdio::null()).status(),
            None => quiet_command("launchctl").args(["unsetenv", name]).stdout(Stdio::null()).status(),
        };
    } else if cfg!(windows) {
        let _ = match value {
            Some(value) => quiet_command("reg").args(["add", "HKCU\\Environment", "/v", name, "/t", "REG_SZ", "/d", value, "/f"]).stdout(Stdio::null()).status(),
            None => quiet_command("reg").args(["delete", "HKCU\\Environment", "/v", name, "/f"]).stdout(Stdio::null()).status(),
        };
    }
}

/// Makes the Ollama app (started outside this app too) see the same settings.
pub fn apply_ollama_env() {
    let value = ollama_env().into_iter().find(|(key, _)| *key == "OLLAMA_MODELS").map(|(_, value)| value);
    set_user_env("OLLAMA_MODELS", value.as_deref());
}

/// Undoes the old network share that opened Ollama on 0.0.0.0 without a password.
pub fn clear_shared_ollama_host() {
    set_user_env("OLLAMA_HOST", None);
    restart_ollama_if_running();
}

fn stop_ollama() {
    if cfg!(target_os = "macos") {
        let _ = quiet_command("osascript").args(["-e", "quit app \"Ollama\""]).stdout(Stdio::null()).status();
        std::thread::sleep(Duration::from_millis(800));
        let _ = quiet_command("pkill").args(["-x", "ollama"]).stdout(Stdio::null()).status();
    } else if cfg!(windows) {
        let _ = quiet_command("taskkill").args(["/IM", "ollama app.exe", "/F"]).stdout(Stdio::null()).status();
        let _ = quiet_command("taskkill").args(["/IM", "ollama.exe", "/F"]).stdout(Stdio::null()).status();
    }
}

/// Restarts Ollama so a new model folder or sharing setting takes effect. Linux services are left alone.
pub fn restart_ollama_if_running() -> bool {
    if !ollama_running() || !cfg!(any(target_os = "macos", windows)) {
        return false;
    }
    stop_ollama();
    for _ in 0..20 {
        if !ollama_running() {
            break;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    start_ollama().is_ok()
}

pub fn set_models_dir(dir: &str) -> Result<Value, String> {
    let disks = list_disks();
    let disk = disk_for_dir(&disks, dir).filter(|disk| disk.models_dir == dir).ok_or("목록에 있는 디스크만 고를 수 있습니다.")?;
    if !dir.is_empty() {
        let path = PathBuf::from(dir);
        std::fs::create_dir_all(&path).map_err(|error| format!("{}에 폴더를 만들지 못했습니다 (읽기 전용이거나 권한이 없음): {error}", disk.label))?;
        tempfile::tempfile_in(&path).map_err(|_| format!("{}에 쓸 수 없습니다. 읽기 전용 디스크인지 확인하세요.", disk.label))?;
    }
    let mut settings = crate::settings::load_settings()?;
    settings.set_extra(MODELS_DIR_KEY, (!dir.is_empty()).then(|| dir.to_string()));
    crate::settings::save_settings(&settings)?;
    apply_ollama_env();
    let restarted = restart_ollama_if_running();
    let mut message = format!("모델 저장 위치를 {}(으)로 바꿨습니다.", disk.label);
    if restarted {
        message.push_str(" Ollama를 다시 켰습니다.");
    } else if cfg!(target_os = "linux") && ollama_running() {
        message.push_str(" Linux 서비스로 실행 중이면 OLLAMA_MODELS를 서비스 설정에도 넣고 다시 시작해 주세요.");
    }
    message.push_str(" 이미 받은 모델은 이전 위치에 남아 있으니 필요하면 다시 받으세요.");
    Ok(json!({ "message": message }))
}

fn port_open(port: u16) -> bool {
    let address = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    std::net::TcpStream::connect_timeout(&address, Duration::from_millis(150)).is_ok()
}

pub fn ollama_running() -> bool {
    port_open(11434)
}

pub fn lmstudio_running() -> bool {
    port_open(1234)
}

fn app_candidates(mac_name: &str, windows_dir: &str, windows_exe: &str) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if cfg!(target_os = "macos") {
        paths.push(PathBuf::from("/Applications").join(mac_name));
        if let Some(home) = home_dir() {
            paths.push(home.join("Applications").join(mac_name));
        }
    } else if cfg!(windows) {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            paths.push(PathBuf::from(local).join("Programs").join(windows_dir).join(windows_exe));
        }
    }
    paths
}

fn ollama_app() -> Option<PathBuf> {
    app_candidates("Ollama.app", "Ollama", "ollama app.exe").into_iter().find(|path| path.exists())
}

fn ollama_installed() -> bool {
    ollama_app().is_some() || crate::process_util::find_tool("ollama").is_some()
}

fn lmstudio_installed() -> bool {
    app_candidates("LM Studio.app", "LM Studio", "LM Studio.exe").into_iter().any(|path| path.exists())
}

fn client(timeout_secs: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        .user_agent("AI-Character/0.2 local-ai")
        .build()
        .map_err(|error| error.to_string())
}

async fn get_json(url: &str) -> Option<Value> {
    let response = client(3).ok()?.get(url).send().await.ok()?;
    serde_json::from_str(&response.text().await.ok()?).ok()
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledModel {
    pub name: String,
    pub size_gb: f64,
}

pub fn parse_installed(value: &Value) -> Vec<InstalledModel> {
    value
        .get("models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|model| {
            Some(InstalledModel {
                name: model.get("name")?.as_str()?.to_string(),
                size_gb: gb(model.get("size").and_then(Value::as_f64).unwrap_or(0.0)),
            })
        })
        .collect()
}

pub async fn ollama_installed_models() -> Vec<InstalledModel> {
    if !ollama_running() {
        return Vec::new();
    }
    get_json(&format!("{OLLAMA_BASE}/api/tags")).await.map(|value| parse_installed(&value)).unwrap_or_default()
}

pub async fn lmstudio_models() -> Vec<String> {
    if !lmstudio_running() {
        return Vec::new();
    }
    get_json(&format!("{LMSTUDIO_BASE}/v1/models"))
        .await
        .and_then(|value| value.get("data").and_then(Value::as_array).cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|model| model.get("id").and_then(Value::as_str))
        .filter(|id| !id.contains("embed"))
        .map(str::to_string)
        .collect()
}

pub fn preferred_model() -> Option<String> {
    crate::settings::load_settings().ok()?.extra(PREFERRED_KEY).filter(|value| !value.is_empty()).map(str::to_string)
}

/// Tags like `qwen3:latest` match a catalog id written without the tag.
fn same_model(installed: &str, id: &str) -> bool {
    installed == id || installed.strip_suffix(":latest") == Some(id)
}

fn catalog_values(system: &SystemInfo, installed: &[InstalledModel], disks: &[Disk]) -> Vec<Value> {
    let recommended = RECOMMEND_ORDER
        .iter()
        .filter_map(|id| CATALOG.iter().find(|model| model.id == *id))
        .find(|model| assess(model, system).verdict == "good")
        .map(|model| model.id);
    CATALOG
        .iter()
        .map(|model| {
            let assessment = assess(model, system);
            let mut reason = assessment.reason;
            if assessment.verdict == "no_disk" {
                let needed = model.size_gb + DISK_HEADROOM_GB;
                if let Some(other) = disks.iter().filter(|disk| disk.free_gb >= needed).max_by(|a, b| a.free_gb.total_cmp(&b.free_gb)) {
                    reason.push_str(&format!(" → 저장 위치를 '{}'({:.0}GB 남음)로 바꾸면 받을 수 있습니다", other.label, other.free_gb));
                }
            }
            json!({
                "id": model.id,
                "label": model.label,
                "maker": model.maker,
                "sizeGb": model.size_gb,
                "minRamGb": model.min_ram_gb,
                "recRamGb": model.rec_ram_gb,
                "note": model.note,
                "verdict": assessment.verdict,
                "reason": reason,
                "installed": installed.iter().any(|item| same_model(&item.name, model.id)),
                "recommended": recommended == Some(model.id),
            })
        })
        .collect()
}

async fn ollama_summary(installed: &[InstalledModel]) -> Value {
    let running = ollama_running();
    let version = if running {
        get_json(&format!("{OLLAMA_BASE}/api/version")).await.and_then(|value| value.get("version")?.as_str().map(str::to_string))
    } else {
        None
    };
    json!({
        "installed": running || ollama_installed(),
        "running": running,
        "version": version,
        "models": installed,
        "installMethod": install_method(),
        "installCommand": (!cfg!(any(target_os = "macos", windows))).then_some(OLLAMA_LINUX_COMMAND),
    })
}

pub async fn status() -> Value {
    let system = system_info();
    let disks = list_disks();
    let installed = ollama_installed_models().await;
    let current_dir = chosen_models_dir().map(|dir| dir.to_string_lossy().into_owned()).unwrap_or_default();
    let lm_running = lmstudio_running();
    json!({
        "system": system,
        "disks": disks,
        "modelsDir": current_dir,
        "modelsDirMissing": models_drive_missing(),
        "ollama": ollama_summary(&installed).await,
        "lmstudio": {
            "installed": lm_running || lmstudio_installed(),
            "running": lm_running,
            "models": lmstudio_models().await,
        },
        "catalog": catalog_values(&system, &installed, &disks),
        "preferred": preferred_model(),
        "share": crate::remote_ai::share_status(),
        "jobs": jobs_snapshot(),
    })
}

/// What another computer sees after entering this computer's share code (no paths, keys or settings).
pub async fn shared_status() -> Value {
    let mut system = system_info();
    system.models_dir = None;
    let disks = list_disks();
    let installed = ollama_installed_models().await;
    json!({
        "system": system,
        "ollama": ollama_summary(&installed).await,
        "catalog": catalog_values(&system, &installed, &disks),
    })
}

fn install_method() -> &'static str {
    if cfg!(target_os = "macos") {
        "공식 Ollama 앱을 내려받아 응용 프로그램 폴더에 설치합니다 (약 200MB)."
    } else if cfg!(windows) {
        "winget으로 설치하고, winget이 없는 PC는 공식 설치 프로그램을 내려받아 엽니다 (약 1.5GB, 그래픽카드 드라이버 포함)."
    } else {
        "터미널에서 공식 설치 명령을 실행합니다 (관리자 비밀번호 필요)."
    }
}

fn catalog_model(id: &str) -> Result<&'static CatalogModel, String> {
    CATALOG.iter().find(|model| model.id == id).ok_or_else(|| "목록에 없는 모델입니다.".to_string())
}

pub fn catalog_entry(id: &str) -> Result<&'static CatalogModel, String> {
    catalog_model(id)
}

pub fn jobs_snapshot() -> HashMap<String, JobProgress> {
    jobs().lock().map(|map| map.clone()).unwrap_or_default()
}

/// Streams Ollama's NDJSON pull progress into the job table.
async fn pull(base: &str, model: &str, job_id: &str) -> Result<(), String> {
    let body = json!({ "model": model, "stream": true }).to_string();
    let mut response = client(6 * 60 * 60)?
        .post(format!("{base}/api/pull"))
        .header("content-type", "application/json")
        .body(body)
        .send()
        .await
        .map_err(|error| format!("Ollama에 연결하지 못했습니다: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("Ollama가 거절했습니다 ({})", response.status()));
    }
    let mut buffer = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| format!("다운로드가 끊겼습니다: {error}"))? {
        buffer.extend_from_slice(&chunk);
        while let Some(end) = buffer.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = buffer.drain(..=end).collect();
            let Ok(event) = serde_json::from_slice::<Value>(&line) else { continue };
            if let Some(error) = event.get("error").and_then(Value::as_str) {
                return Err(error.to_string());
            }
            let status = event.get("status").and_then(Value::as_str).unwrap_or_default().to_string();
            let total = event.get("total").and_then(Value::as_u64);
            let completed = event.get("completed").and_then(Value::as_u64);
            set_job(job_id, |job| {
                job.status = status;
                if let Some(total) = total {
                    job.total = total;
                    job.completed = completed.unwrap_or(0);
                }
            });
        }
    }
    Ok(())
}

pub fn start_pull(id: &str) -> Result<Value, String> {
    let model = catalog_model(id)?;
    if !ollama_running() {
        return Err("Ollama가 꺼져 있습니다. 먼저 Ollama를 설치하고 켜 주세요.".into());
    }
    if models_drive_missing() {
        return Err("모델 저장 위치로 고른 외장 디스크가 연결되어 있지 않습니다. 디스크를 연결하거나 저장 위치를 바꿔 주세요.".into());
    }
    let assessment = assess(model, &system_info());
    if matches!(assessment.verdict, "no_disk" | "no_ram") {
        return Err(format!("{} — 이 컴퓨터에는 받을 수 없습니다.", assessment.reason));
    }
    spawn_pull(OLLAMA_BASE.to_string(), model.id.to_string(), model.id.to_string())
}

pub fn spawn_pull(base: String, model: String, job_id: String) -> Result<Value, String> {
    if job_running(&job_id) {
        return Ok(json!({ "started": false, "message": "이미 받는 중입니다." }));
    }
    set_job(&job_id, |job| *job = JobProgress { status: "시작하는 중".into(), ..Default::default() });
    tauri::async_runtime::spawn(async move {
        let result = pull(&base, &model, &job_id).await;
        set_job(&job_id, |job| {
            job.done = true;
            match result {
                Ok(()) => job.status = "완료".into(),
                Err(error) => job.error = Some(crate::policy_engine::mask_secrets(&error)),
            }
        });
    });
    Ok(json!({ "started": true }))
}

pub async fn delete_model(name: &str) -> Result<Value, String> {
    let installed = ollama_installed_models().await;
    if !installed.iter().any(|model| model.name == name) {
        return Err("설치되어 있지 않은 모델입니다.".into());
    }
    let response = client(30)?
        .delete(format!("{OLLAMA_BASE}/api/delete"))
        .header("content-type", "application/json")
        .body(json!({ "model": name }).to_string())
        .send()
        .await
        .map_err(|error| format!("Ollama에 연결하지 못했습니다: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("삭제하지 못했습니다 ({})", response.status()));
    }
    if preferred_model().as_deref() == Some(name) {
        set_preferred(None)?;
    }
    Ok(json!({ "deleted": name }))
}

pub fn set_preferred(model: Option<String>) -> Result<Value, String> {
    let mut settings = crate::settings::load_settings()?;
    settings.set_extra(PREFERRED_KEY, model.clone().filter(|value| !value.trim().is_empty()));
    crate::settings::save_settings(&settings)?;
    Ok(json!({ "preferred": model }))
}

pub fn start_ollama() -> Result<Value, String> {
    if ollama_running() {
        return Ok(json!({ "message": "이미 켜져 있습니다." }));
    }
    if let Some(app) = ollama_app() {
        let spawned = if cfg!(target_os = "macos") {
            quiet_command("open").arg("-a").arg(&app).stdout(Stdio::null()).spawn()
        } else {
            quiet_command(&app.to_string_lossy()).envs(ollama_env()).stdout(Stdio::null()).spawn()
        };
        spawned.map_err(|error| format!("Ollama를 켜지 못했습니다: {error}"))?;
    } else if let Some(cli) = crate::process_util::find_tool("ollama") {
        quiet_command(&cli.to_string_lossy())
            .arg("serve")
            .envs(ollama_env())
            .stdout(Stdio::null())
            .spawn()
            .map_err(|error| format!("Ollama를 켜지 못했습니다: {error}"))?;
    } else {
        return Err("Ollama가 설치되어 있지 않습니다.".into());
    }
    Ok(json!({ "message": "Ollama를 켜는 중입니다. 몇 초 뒤 상태가 바뀝니다." }))
}

/// Downloads the official installer into `dir`, reporting progress on the install job.
#[cfg(any(target_os = "macos", windows))]
async fn download_installer(url: &str, dir: &std::path::Path, file_name: &str) -> Result<PathBuf, String> {
    let mut response = client(60 * 60)?
        .get(url)
        .send()
        .await
        .map_err(|error| format!("다운로드하지 못했습니다: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("다운로드하지 못했습니다 ({})", response.status()));
    }
    let total = response.content_length().unwrap_or(0);
    let path = dir.join(file_name);
    let mut file = std::fs::File::create(&path).map_err(|error| error.to_string())?;
    let mut completed = 0u64;
    while let Some(chunk) = response.chunk().await.map_err(|error| format!("다운로드가 끊겼습니다: {error}"))? {
        std::io::Write::write_all(&mut file, &chunk).map_err(|error| error.to_string())?;
        completed += chunk.len() as u64;
        set_job(INSTALL_JOB, |job| {
            job.status = "공식 설치 파일 내려받는 중".into();
            job.total = total;
            job.completed = completed;
        });
    }
    Ok(path)
}

#[cfg(target_os = "macos")]
async fn install_ollama() -> Result<String, String> {
    let dir = tempfile::tempdir().map_err(|error| error.to_string())?;
    let zip_path = download_installer(OLLAMA_MAC_ZIP, dir.path(), "Ollama-darwin.zip").await?;
    set_job(INSTALL_JOB, |job| job.status = "설치하는 중".into());
    let system_apps = PathBuf::from("/Applications");
    let target = if tempfile::tempfile_in(&system_apps).is_ok() {
        system_apps
    } else {
        let user_apps = home_dir().ok_or("홈 폴더를 찾지 못했습니다.")?.join("Applications");
        std::fs::create_dir_all(&user_apps).map_err(|error| error.to_string())?;
        user_apps
    };
    let status = quiet_command("ditto")
        .arg("-x")
        .arg("-k")
        .arg(&zip_path)
        .arg(&target)
        .stdout(Stdio::null())
        .status()
        .map_err(|error| error.to_string())?;
    if !status.success() {
        return Err("압축을 풀지 못했습니다.".into());
    }
    quiet_command("open")
        .arg("-a")
        .arg(target.join("Ollama.app"))
        .stdout(Stdio::null())
        .spawn()
        .map_err(|error| format!("설치했지만 켜지 못했습니다: {error}"))?;
    Ok("설치 완료 · 켜는 중 (처음 켤 때 Ollama 창이 뜨면 안내대로 진행하세요)".into())
}

/// winget first; PCs without it get the official installer window instead.
#[cfg(windows)]
async fn install_ollama() -> Result<String, String> {
    set_job(INSTALL_JOB, |job| job.status = "winget으로 설치하는 중".into());
    let winget = tauri::async_runtime::spawn_blocking(|| crate::windows_setup::run_winget("Ollama.Ollama"))
        .await
        .map_err(|error| error.to_string())?;
    if winget.is_ok() {
        let _ = start_ollama();
        return Ok("설치 완료 · 켜는 중".into());
    }
    let dir = std::env::temp_dir().join("ai-character-ollama");
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let setup = download_installer(OLLAMA_WINDOWS_SETUP, &dir, "OllamaSetup.exe").await?;
    Command::new(&setup).spawn().map_err(|error| format!("설치 프로그램을 열지 못했습니다: {error}"))?;
    Ok("Ollama 설치 창을 열었습니다. 설치를 마치면 '다시 확인'을 누르세요".into())
}

#[cfg(not(any(target_os = "macos", windows)))]
async fn install_ollama() -> Result<String, String> {
    Err(format!("Linux는 터미널에서 직접 설치해 주세요 (관리자 비밀번호 필요): {OLLAMA_LINUX_COMMAND}"))
}

pub fn start_install_ollama() -> Result<Value, String> {
    if ollama_installed() {
        return start_ollama();
    }
    if !cfg!(any(target_os = "macos", windows)) {
        return Err(format!("Linux는 터미널에서 직접 설치해 주세요 (관리자 비밀번호 필요): {OLLAMA_LINUX_COMMAND}"));
    }
    if job_running(INSTALL_JOB) {
        return Ok(json!({ "message": "이미 설치하는 중입니다." }));
    }
    set_job(INSTALL_JOB, |job| *job = JobProgress { status: "시작하는 중".into(), ..Default::default() });
    tauri::async_runtime::spawn(async {
        let result = install_ollama().await;
        finish_install(result);
    });
    Ok(json!({ "message": "Ollama 설치를 시작했습니다." }))
}

fn finish_install(result: Result<String, String>) {
    set_job(INSTALL_JOB, |job| {
        job.done = true;
        match result {
            Ok(message) => job.status = message,
            Err(error) => job.error = Some(error),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn system(ram: f64, disk: f64, accelerated: bool) -> SystemInfo {
        SystemInfo { ram_gb: Some(ram), free_disk_gb: Some(disk), apple_silicon: accelerated, ..Default::default() }
    }

    fn model(id: &str) -> &'static CatalogModel {
        catalog_model(id).unwrap()
    }

    #[test]
    fn catalog_is_consistent() {
        for (index, item) in CATALOG.iter().enumerate() {
            assert!(item.min_ram_gb <= item.rec_ram_gb, "{}", item.id);
            assert!(!CATALOG[..index].iter().any(|other| other.id == item.id), "duplicate {}", item.id);
        }
        for id in RECOMMEND_ORDER {
            assert!(catalog_model(id).is_ok());
        }
    }

    fn machine(os: &str, ram: f64, disk: f64, apple: bool, vram: Option<f64>, nvidia: bool) -> SystemInfo {
        SystemInfo {
            os: os.into(),
            ram_gb: Some(ram),
            free_disk_gb: Some(disk),
            apple_silicon: apple,
            nvidia_gpu: nvidia,
            vram_gb: vram,
            ..Default::default()
        }
    }

    #[test]
    fn assess_covers_every_verdict() {
        assert_eq!(assess(model("exaone3.5:7.8b"), &system(15.9, 200.0, true)).verdict, "good");
        assert_eq!(assess(model("exaone3.5:7.8b"), &system(8.0, 200.0, true)).verdict, "slow");
        assert_eq!(assess(model("exaone3.5:7.8b"), &system(16.0, 200.0, false)).verdict, "slow");
        assert_eq!(assess(model("exaone3.5:2.4b"), &system(8.0, 200.0, false)).verdict, "good");
        assert_eq!(assess(model("exaone3.5:32b"), &system(16.0, 200.0, true)).verdict, "no_ram");
        assert_eq!(assess(model("qwen3:8b"), &system(32.0, 5.0, true)).verdict, "no_disk");
        let unknown = SystemInfo { free_disk_gb: Some(100.0), ..Default::default() };
        assert_eq!(assess(model("qwen3:8b"), &unknown).verdict, "unknown");
    }

    #[test]
    fn assess_other_computers() {
        let office_laptop = machine("windows", 7.8, 120.0, false, None, false);
        assert_eq!(assess(model("exaone3.5:2.4b"), &office_laptop).verdict, "good");
        assert_eq!(assess(model("exaone3.5:7.8b"), &office_laptop).verdict, "slow");
        assert_eq!(assess(model("qwen3:14b"), &office_laptop).verdict, "no_ram");

        let gaming_pc = machine("windows", 16.0, 500.0, false, Some(12.0), true);
        assert_eq!(assess(model("qwen3:8b"), &gaming_pc).verdict, "good");
        assert_eq!(assess(model("qwen3:14b"), &gaming_pc).verdict, "good");
        let rtx_8gb = machine("windows", 32.0, 500.0, false, Some(8.0), true);
        let too_big = assess(model("qwen3:14b"), &rtx_8gb);
        assert_eq!(too_big.verdict, "slow");
        assert!(too_big.reason.contains("그래픽카드 메모리"));

        let small_card = machine("windows", 32.0, 500.0, false, Some(4.0), true);
        assert_eq!(assess(model("exaone3.5:7.8b"), &small_card).verdict, "slow");
        let unknown_card = machine("windows", 16.0, 500.0, false, None, true);
        assert_eq!(assess(model("qwen3:8b"), &unknown_card).verdict, "good");

        let intel_mac = machine("macos", 16.0, 200.0, false, None, false);
        assert!(assess(model("qwen3:8b"), &intel_mac).reason.contains("Intel Mac"));

        let big_mac = machine("macos", 64.0, 500.0, true, None, false);
        assert_eq!(assess(model("exaone3.5:32b"), &big_mac).verdict, "good");

        let linux_server = machine("linux", 64.0, 40.0, false, Some(24.0), true);
        assert_eq!(assess(model("qwen3:30b"), &linux_server).verdict, "good");
    }

    #[test]
    fn parses_windows_and_nvidia_probes() {
        let (ram, free, cpu, gpus) = parse_windows_probe("17079869440\r\n107374182400\r\nIntel(R) Core(TM) i5-12400F\r\nNVIDIA GeForce RTX 3060|Microsoft Basic Display\r\n");
        assert_eq!(ram, Some(15.9));
        assert_eq!(free, Some(100.0));
        assert_eq!(cpu.as_deref(), Some("Intel(R) Core(TM) i5-12400F"));
        assert_eq!(gpus, vec!["NVIDIA GeForce RTX 3060", "Microsoft Basic Display"]);
        assert_eq!(parse_windows_probe("").0, None);
        let cards = parse_nvidia_smi("NVIDIA GeForce RTX 3060, 12288\nNVIDIA GeForce GTX 1650, 4096\nbad line\n");
        assert_eq!(cards, vec![("NVIDIA GeForce RTX 3060".to_string(), 12.0), ("NVIDIA GeForce GTX 1650".to_string(), 4.0)]);
    }

    #[test]
    fn parses_df_and_tags() {
        let df = "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3s5 971350180 500000000 104857600 83% /System/Volumes/Data\n";
        assert_eq!(parse_df_available_kb(df), Some(104857600.0));
        assert_eq!(parse_df_available_kb(""), None);
        let tags = json!({ "models": [{ "name": "qwen3:8b", "size": 5_200_000_000u64 }, { "name": "bad" }] });
        let models = parse_installed(&tags);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].size_gb, 4.8);
        assert!(same_model("qwen3:latest", "qwen3") && !same_model("qwen3:8b", "qwen3:4b"));
    }

    #[test]
    fn lists_internal_and_external_disks() {
        let mac = "Filesystem     1024-blocks      Used  Available Capacity  Mounted on
/dev/disk3s1s1   239362496  13320000   12840000    51%    /
devfs                  205       205          0   100%    /dev
/dev/disk3s5     239362496 200800000   12840000    94%    /System/Volumes/Data
map auto_home            0         0          0   100%    /System/Volumes/Data/home
/dev/disk3s3     239362496   1484000   12840000    11%    /Volumes/Recovery
/dev/disk7s1    1953309744  30240000 1920000000     2%    /Volumes/백업
/dev/disk8s1     976762584  10000000  900000000     2%    /Volumes/My Passport
";
        let disks = parse_df_disks(mac, true);
        assert_eq!(disks.iter().map(|d| d.label.as_str()).collect::<Vec<_>>(), vec!["내장 디스크", "백업", "My Passport"]);
        assert!(!disks[0].external && disks[0].models_dir.is_empty());
        assert_eq!(disks[1].models_dir, "/Volumes/백업/AI-Character-Models");
        assert_eq!(disks[2].mount, "/Volumes/My Passport");
        assert!(disks[1].free_gb > 1800.0);

        let linux = "Filesystem 1024-blocks Used Available Capacity Mounted on
/dev/nvme0n1p2 500000000 100000000 400000000 20% /
/dev/nvme0n1p1 500000 1000 499000 1% /boot/efi
/dev/sdb1 1000000000 0 1000000000 0% /media/kim/USB
";
        let disks = parse_df_disks(linux, false);
        assert_eq!(disks.len(), 2);
        assert!(disks[1].external && disks[1].models_dir == "/media/kim/USB/AI-Character-Models");

        let windows = "C:|107374182400|512110190592|Windows|3\nD:|900000000000|1000000000000|Data|3\nE:|50000000000|64000000000||2\n";
        let disks = parse_windows_disks(windows, "C:");
        assert_eq!(disks.len(), 3);
        assert!(disks[0].label.contains("시스템") && disks[0].models_dir.is_empty());
        assert_eq!(disks[1].models_dir, "D:\\AI-Character-Models");
        assert!(disks[2].external && disks[2].label == "E:");
        assert_eq!(disk_for_dir(&disks, "D:\\AI-Character-Models").unwrap().label, "D: Data");
    }

    #[test]
    fn pull_rejects_unknown_models() {
        assert!(start_pull("evil; rm -rf /").is_err());
    }
}
