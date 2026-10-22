use crate::agent_core::AgentKind;
use std::collections::{BTreeMap, HashMap};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
pub struct AppSettings {
    pub project_dir: Option<PathBuf>,
    pub agent_paths: HashMap<AgentKind, PathBuf>,
    pub agent_extra_args: HashMap<AgentKind, Vec<String>>,
    pub agent_models: HashMap<AgentKind, String>,
    pub agent_model_presets: HashMap<AgentKind, Vec<String>>,
    pub default_agent: AgentKind,
    pub cradle_enabled: bool,
    pub auto_web_search: bool,
    pub gemini_api_enabled: bool,
    pub allow_paid_openai_api: bool,
    pub close_web_account_after_handoff: bool,
    pub close_web_account_when_cradle_done: bool,
    pub timeout_seconds: u64,
    pub warn_sensitive_files: bool,
    /// Feature options persisted as `x.<name>` lines (policy, Claude integration, updates).
    pub extras: BTreeMap<String, String>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            project_dir: None,
            agent_paths: HashMap::new(),
            agent_extra_args: HashMap::new(),
            agent_models: HashMap::new(),
            agent_model_presets: HashMap::new(),
            default_agent: AgentKind::Claude,
            cradle_enabled: true,
            auto_web_search: true,
            gemini_api_enabled: true,
            allow_paid_openai_api: false,
            close_web_account_after_handoff: true,
            close_web_account_when_cradle_done: true,
            timeout_seconds: 180,
            warn_sensitive_files: true,
            extras: BTreeMap::new(),
        }
    }
}

impl AppSettings {
    pub fn set_agent_path(&mut self, agent: AgentKind, path: PathBuf) {
        self.agent_paths.insert(agent, path);
    }

    pub fn agent_path(&self, agent: AgentKind) -> Option<&PathBuf> {
        self.agent_paths.get(&agent)
    }

    pub fn set_agent_extra_args(&mut self, agent: AgentKind, args: Vec<String>) {
        if args.is_empty() {
            self.agent_extra_args.remove(&agent);
        } else {
            self.agent_extra_args.insert(agent, args);
        }
    }

    pub fn agent_extra_args(&self, agent: AgentKind) -> &[String] {
        self.agent_extra_args
            .get(&agent)
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }

    pub fn set_agent_model(&mut self, agent: AgentKind, model: Option<String>) {
        match model.map(|value| value.trim().to_string()).filter(|value| !value.is_empty()) {
            Some(model) => {
                self.agent_models.insert(agent, model);
            }
            None => {
                self.agent_models.remove(&agent);
            }
        }
    }

    pub fn agent_model(&self, agent: AgentKind) -> Option<&str> {
        self.agent_models.get(&agent).map(String::as_str)
    }

    pub fn set_agent_model_presets(&mut self, agent: AgentKind, presets: Vec<String>) {
        if presets.is_empty() {
            self.agent_model_presets.remove(&agent);
        } else {
            self.agent_model_presets.insert(agent, presets);
        }
    }

    pub fn agent_model_presets(&self, agent: AgentKind) -> &[String] {
        self.agent_model_presets
            .get(&agent)
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }

    pub fn extra(&self, name: &str) -> Option<&str> {
        self.extras.get(name).map(String::as_str)
    }

    pub fn extra_bool(&self, name: &str, default: bool) -> bool {
        match self.extra(name) {
            Some("true") | Some("1") => true,
            Some("false") | Some("0") => false,
            _ => default,
        }
    }

    pub fn extra_u64(&self, name: &str, default: u64) -> u64 {
        self.extra(name)
            .and_then(|value| value.trim().parse::<u64>().ok())
            .unwrap_or(default)
    }

    pub fn extra_f64(&self, name: &str, default: f64) -> f64 {
        self.extra(name)
            .and_then(|value| value.trim().parse::<f64>().ok())
            .filter(|value| value.is_finite())
            .unwrap_or(default)
    }

    pub fn set_extra(&mut self, name: &str, value: Option<String>) {
        match value.map(|value| value.trim().to_string()).filter(|value| !value.is_empty()) {
            Some(value) => {
                self.extras.insert(name.to_string(), value);
            }
            None => {
                self.extras.remove(name);
            }
        }
    }
}

fn hex_encode(value: &str) -> String {
    value
        .as_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn hex_decode(value: &str) -> Result<String, String> {
    if value.len() % 2 != 0 {
        return Err("설정 값 길이가 올바르지 않습니다.".to_string());
    }
    let mut bytes = Vec::with_capacity(value.len() / 2);
    for pair in value.as_bytes().chunks_exact(2) {
        let text = std::str::from_utf8(pair).map_err(|error| error.to_string())?;
        let byte = u8::from_str_radix(text, 16)
            .map_err(|error| format!("설정 값 디코딩 실패: {error}"))?;
        bytes.push(byte);
    }
    String::from_utf8(bytes).map_err(|error| format!("설정 UTF-8 디코딩 실패: {error}"))
}

pub fn settings_path() -> Result<PathBuf, String> {
    #[cfg(target_os = "macos")]
    {
        let home = env::var_os("HOME").ok_or("HOME 환경 변수가 없습니다.")?;
        return Ok(PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join("AI-Character")
            .join("settings.conf"));
    }

    #[cfg(windows)]
    {
        let appdata = env::var_os("APPDATA").ok_or("APPDATA 환경 변수가 없습니다.")?;
        return Ok(PathBuf::from(appdata)
            .join("AI-Character")
            .join("settings.conf"));
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if let Some(config) = env::var_os("XDG_CONFIG_HOME") {
            return Ok(PathBuf::from(config)
                .join("ai-character")
                .join("settings.conf"));
        }
        let home = env::var_os("HOME").ok_or("HOME 환경 변수가 없습니다.")?;
        Ok(PathBuf::from(home)
            .join(".config")
            .join("ai-character")
            .join("settings.conf"))
    }
}

pub fn load_settings() -> Result<AppSettings, String> {
    load_settings_from(&settings_path()?)
}

pub fn save_settings(settings: &AppSettings) -> Result<(), String> {
    save_settings_to(&settings_path()?, settings)
}

pub fn load_settings_from(path: &Path) -> Result<AppSettings, String> {
    if !path.exists() {
        return Ok(AppSettings::default());
    }
    let content = fs::read_to_string(path)
        .map_err(|error| format!("설정 파일 읽기 실패: {} ({error})", path.display()))?;
    let mut settings = AppSettings::default();

    for line in content.lines() {
        let Some((key, encoded)) = line.split_once('=') else {
            continue;
        };
        let decoded = hex_decode(encoded)?;
        match key {
            // Older builds saved `\\?\C:\...`; read it back as a plain drive path.
            "project_dir" => {
                settings.project_dir =
                    Some(crate::path_guard::without_verbatim_drive_prefix(PathBuf::from(decoded)))
            }
            "default_agent" => settings.default_agent = AgentKind::parse(&decoded)?,
            "cradle_enabled" => {
                settings.cradle_enabled = match decoded.as_str() {
                    "true" | "1" => true,
                    "false" | "0" => false,
                    _ => return Err("CRADLE 설정 값이 올바르지 않습니다.".to_string()),
                };
            }
            "auto_web_search" => {
                settings.auto_web_search = match decoded.as_str() {
                    "true" | "1" => true,
                    "false" | "0" => false,
                    _ => return Err("웹 자동검색 설정 값이 올바르지 않습니다.".to_string()),
                };
            }
            "gemini_api_enabled" => {
                settings.gemini_api_enabled = match decoded.as_str() {
                    "true" | "1" => true,
                    "false" | "0" => false,
                    _ => return Err("Gemini API 설정 값이 올바르지 않습니다.".to_string()),
                };
            }
            "allow_paid_openai_api" => {
                settings.allow_paid_openai_api = match decoded.as_str() {
                    "true" | "1" => true,
                    "false" | "0" => false,
                    _ => return Err("OpenAI API 설정 값이 올바르지 않습니다.".to_string()),
                };
            }
            "close_web_account_after_handoff" => {
                settings.close_web_account_after_handoff = match decoded.as_str() {
                    "true" | "1" => true,
                    "false" | "0" => false,
                    _ => {
                        return Err(
                            "웹 계정 창 자동 닫기(핸드오프) 설정 값이 올바르지 않습니다."
                                .to_string(),
                        );
                    }
                };
            }
            "close_web_account_when_cradle_done" => {
                settings.close_web_account_when_cradle_done = match decoded.as_str() {
                    "true" | "1" => true,
                    "false" | "0" => false,
                    _ => {
                        return Err(
                            "웹 계정 창 자동 닫기(CRADLE 종료) 설정 값이 올바르지 않습니다."
                                .to_string(),
                        );
                    }
                };
            }
            "timeout_seconds" => {
                let timeout = decoded
                    .parse::<u64>()
                    .map_err(|error| format!("timeout 설정 해석 실패: {error}"))?;
                settings.timeout_seconds = timeout.clamp(10, 3600);
            }
            "warn_sensitive_files" => {
                settings.warn_sensitive_files = match decoded.as_str() {
                    "true" | "1" => true,
                    "false" | "0" => false,
                    _ => return Err("민감 파일 경고 설정 값이 올바르지 않습니다.".to_string()),
                };
            }
            _ => {
                if let Some(name) = key.strip_prefix("x.") {
                    if !name.is_empty() {
                        settings.extras.insert(name.to_string(), decoded);
                    }
                } else if let Some(agent_name) = key.strip_prefix("agent_model_presets.") {
                    if let Ok(agent) = AgentKind::parse(agent_name) {
                        let presets = decoded
                            .lines()
                            .map(str::trim)
                            .filter(|value| !value.is_empty())
                            .map(str::to_string)
                            .collect::<Vec<_>>();
                        settings.set_agent_model_presets(agent, presets);
                    }
                } else if let Some(agent_name) = key.strip_prefix("agent_model.") {
                    if let Ok(agent) = AgentKind::parse(agent_name) {
                        settings.set_agent_model(agent, Some(decoded));
                    }
                } else if let Some(agent_name) = key.strip_prefix("agent_args.") {
                    if let Ok(agent) = AgentKind::parse(agent_name) {
                        let args = decoded
                            .lines()
                            .map(str::trim)
                            .filter(|value| !value.is_empty())
                            .map(str::to_string)
                            .collect::<Vec<_>>();
                        settings.set_agent_extra_args(agent, args);
                    }
                } else if let Some(agent_name) = key.strip_prefix("agent.") {
                    if let Ok(agent) = AgentKind::parse(agent_name) {
                        settings.agent_paths.insert(agent, PathBuf::from(decoded));
                    }
                }
            }
        }
    }

    Ok(settings)
}

pub fn save_settings_to(path: &Path, settings: &AppSettings) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!("설정 폴더 생성 실패: {} ({error})", parent.display())
        })?;
    }

    let mut lines = Vec::new();
    if let Some(project_dir) = &settings.project_dir {
        lines.push(format!(
            "project_dir={}",
            hex_encode(&project_dir.to_string_lossy())
        ));
    }

    lines.push(format!(
        "default_agent={}",
        hex_encode(settings.default_agent.as_str())
    ));
    lines.push(format!(
        "cradle_enabled={}",
        hex_encode(if settings.cradle_enabled { "true" } else { "false" })
    ));
    lines.push(format!(
        "auto_web_search={}",
        hex_encode(if settings.auto_web_search { "true" } else { "false" })
    ));
    lines.push(format!(
        "gemini_api_enabled={}",
        hex_encode(if settings.gemini_api_enabled { "true" } else { "false" })
    ));
    lines.push(format!(
        "allow_paid_openai_api={}",
        hex_encode(if settings.allow_paid_openai_api { "true" } else { "false" })
    ));
    lines.push(format!(
        "close_web_account_after_handoff={}",
        hex_encode(if settings.close_web_account_after_handoff {
            "true"
        } else {
            "false"
        })
    ));
    lines.push(format!(
        "close_web_account_when_cradle_done={}",
        hex_encode(if settings.close_web_account_when_cradle_done {
            "true"
        } else {
            "false"
        })
    ));
    lines.push(format!(
        "timeout_seconds={}",
        hex_encode(&settings.timeout_seconds.clamp(10, 3600).to_string())
    ));
    lines.push(format!(
        "warn_sensitive_files={}",
        hex_encode(if settings.warn_sensitive_files { "true" } else { "false" })
    ));

    let agents = [
        AgentKind::Claude,
        AgentKind::Codex,
        AgentKind::Cursor,
        AgentKind::Antigravity,
    ];
    for agent in agents {
        if let Some(path) = settings.agent_paths.get(&agent) {
            lines.push(format!(
                "agent.{}={}",
                agent.as_str(),
                hex_encode(&path.to_string_lossy())
            ));
        }
        let args = settings.agent_extra_args(agent);
        if !args.is_empty() {
            lines.push(format!(
                "agent_args.{}={}",
                agent.as_str(),
                hex_encode(&args.join("\n"))
            ));
        }
        if let Some(model) = settings.agent_model(agent) {
            lines.push(format!(
                "agent_model.{}={}",
                agent.as_str(),
                hex_encode(model)
            ));
        }
        let presets = settings.agent_model_presets(agent);
        if !presets.is_empty() {
            lines.push(format!(
                "agent_model_presets.{}={}",
                agent.as_str(),
                hex_encode(&presets.join("\n"))
            ));
        }
    }

    for (name, value) in &settings.extras {
        lines.push(format!("x.{}={}", name, hex_encode(value)));
    }

    let content = format!("{}\n", lines.join("\n"));
    // Write a sibling file and rename it over the real one, so a reader on another
    // thread never sees a truncated file (which would load as defaults and get saved back).
    static WRITE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let temp = path.with_extension("conf.tmp");
    fs::write(&temp, content)
        .and_then(|()| fs::rename(&temp, path))
        .map_err(|error| {
            let _ = fs::remove_file(&temp);
            format!("설정 파일 저장 실패: {} ({error})", path.display())
        })
}
