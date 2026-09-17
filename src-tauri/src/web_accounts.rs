use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use url::Url;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WebAccountProvider {
    Claude,
    Chatgpt,
    Gemini,
}

impl WebAccountProvider {
    pub fn from_web_target(target: &str) -> Option<Self> {
        match target.trim().to_ascii_lowercase().as_str() {
            "claude_web" | "claude" => Some(Self::Claude),
            "chatgpt_web" | "chatgpt" => Some(Self::Chatgpt),
            "gemini_web" | "gemini" => Some(Self::Gemini),
            _ => None,
        }
    }

    pub fn url(&self) -> &'static str {
        match self {
            Self::Claude => "https://claude.ai/",
            Self::Chatgpt => "https://chatgpt.com/",
            Self::Gemini => "https://gemini.google.com/app",
        }
    }

    pub fn label_ko(&self) -> &'static str {
        match self {
            Self::Claude => "Claude",
            Self::Chatgpt => "ChatGPT",
            Self::Gemini => "Gemini",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebAccountSlot {
    pub id: String,
    pub provider: WebAccountProvider,
    pub label: String,
    pub enabled: bool,
    pub preferred: bool,
    pub open: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WebAccountsFile {
    accounts: Vec<WebAccountSlot>,
}

fn root_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|error| format!("앱 데이터 경로를 찾지 못했습니다: {error}"))
        .map(|path| path.join("web-accounts"))
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(root_dir(app)?.join("accounts.json"))
}

fn profile_dir(app: &AppHandle, account_id: &str) -> Result<PathBuf, String> {
    Ok(root_dir(app)?.join("profiles").join(sanitize_id(account_id)))
}

fn sanitize_id(id: &str) -> String {
    id.chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect()
}

fn window_label(account_id: &str) -> String {
    format!("webacct-{}", sanitize_id(account_id))
}

fn default_accounts() -> Vec<WebAccountSlot> {
    vec![
        WebAccountSlot {
            id: "claude-1".into(),
            provider: WebAccountProvider::Claude,
            label: "Claude 계정 1".into(),
            enabled: true,
            preferred: true,
            open: false,
        },
        WebAccountSlot {
            id: "claude-2".into(),
            provider: WebAccountProvider::Claude,
            label: "Claude 계정 2".into(),
            enabled: true,
            preferred: false,
            open: false,
        },
        WebAccountSlot {
            id: "chatgpt-1".into(),
            provider: WebAccountProvider::Chatgpt,
            label: "ChatGPT 계정 1".into(),
            enabled: true,
            preferred: true,
            open: false,
        },
        WebAccountSlot {
            id: "chatgpt-2".into(),
            provider: WebAccountProvider::Chatgpt,
            label: "ChatGPT 계정 2".into(),
            enabled: true,
            preferred: false,
            open: false,
        },
        WebAccountSlot {
            id: "gemini-1".into(),
            provider: WebAccountProvider::Gemini,
            label: "Gemini 계정 1".into(),
            enabled: true,
            preferred: true,
            open: false,
        },
        WebAccountSlot {
            id: "gemini-2".into(),
            provider: WebAccountProvider::Gemini,
            label: "Gemini 계정 2".into(),
            enabled: true,
            preferred: false,
            open: false,
        },
    ]
}

fn normalize_accounts(mut accounts: Vec<WebAccountSlot>) -> Vec<WebAccountSlot> {
    if accounts.is_empty() {
        return default_accounts();
    }
    for provider in [
        WebAccountProvider::Claude,
        WebAccountProvider::Chatgpt,
        WebAccountProvider::Gemini,
    ] {
        let mut saw_preferred = false;
        for account in accounts.iter_mut().filter(|a| a.provider == provider) {
            if account.preferred && !saw_preferred {
                saw_preferred = true;
            } else {
                account.preferred = false;
            }
        }
        if !saw_preferred {
            if let Some(first) = accounts.iter_mut().find(|a| a.provider == provider) {
                first.preferred = true;
            }
        }
    }
    accounts
}

fn load_accounts(app: &AppHandle) -> Result<Vec<WebAccountSlot>, String> {
    let path = config_path(app)?;
    if !path.is_file() {
        let accounts = default_accounts();
        save_accounts(app, &accounts)?;
        return Ok(accounts);
    }
    let text = fs::read_to_string(&path)
        .map_err(|error| format!("계정 설정을 읽지 못했습니다: {error}"))?;
    let parsed: WebAccountsFile = serde_json::from_str(&text)
        .map_err(|error| format!("계정 설정 JSON이 올바르지 않습니다: {error}"))?;
    Ok(normalize_accounts(parsed.accounts))
}

fn save_accounts(app: &AppHandle, accounts: &[WebAccountSlot]) -> Result<(), String> {
    let path = config_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("계정 설정 폴더를 만들지 못했습니다: {error}"))?;
    }
    let payload = WebAccountsFile {
        accounts: normalize_accounts(accounts.to_vec()),
    };
    let text = serde_json::to_string_pretty(&payload)
        .map_err(|error| format!("계정 설정 저장 실패: {error}"))?;
    fs::write(&path, text).map_err(|error| format!("계정 설정 저장 실패: {error}"))?;
    Ok(())
}

fn mark_open_state(app: &AppHandle, accounts: &mut [WebAccountSlot]) {
    for account in accounts.iter_mut() {
        let label = window_label(&account.id);
        account.open = app.get_webview_window(&label).is_some();
    }
}

pub fn list_accounts(app: &AppHandle) -> Result<Vec<WebAccountSlot>, String> {
    let mut accounts = load_accounts(app)?;
    mark_open_state(app, &mut accounts);
    Ok(accounts)
}

pub fn update_accounts(app: &AppHandle, accounts: Vec<WebAccountSlot>) -> Result<Vec<WebAccountSlot>, String> {
    save_accounts(app, &accounts)?;
    list_accounts(app)
}

fn find_account<'a>(accounts: &'a [WebAccountSlot], account_id: &str) -> Result<&'a WebAccountSlot, String> {
    accounts
        .iter()
        .find(|account| account.id == account_id)
        .ok_or_else(|| format!("계정 슬롯을 찾지 못했습니다: {account_id}"))
}

pub fn open_account(app: &AppHandle, account_id: &str) -> Result<WebAccountSlot, String> {
    let accounts = load_accounts(app)?;
    let account = find_account(&accounts, account_id)?.clone();
    open_account_window(app, &account)?;
    let refreshed = list_accounts(app)?;
    refreshed
        .into_iter()
        .find(|item| item.id == account.id)
        .ok_or_else(|| "계정 창을 연 뒤 상태를 읽지 못했습니다.".to_string())
}

pub fn open_preferred_for_target(app: &AppHandle, target: &str) -> Result<WebAccountSlot, String> {
    let provider = WebAccountProvider::from_web_target(target)
        .ok_or_else(|| format!("지원하지 않는 Web Agent입니다: {target}"))?;
    let accounts = load_accounts(app)?;
    let account = accounts
        .iter()
        .find(|item| item.provider == provider && item.enabled && item.preferred)
        .cloned()
        .or_else(|| {
            accounts
                .iter()
                .find(|item| item.provider == provider && item.enabled)
                .cloned()
        })
        .ok_or_else(|| format!("{} 계정 슬롯이 없습니다.", provider.label_ko()))?;
    open_account_window(app, &account)?;
    Ok(account)
}

pub fn open_all_enabled(app: &AppHandle) -> Result<Vec<WebAccountSlot>, String> {
    let accounts = load_accounts(app)?;
    let mut opened = Vec::new();
    for account in accounts.into_iter().filter(|account| account.enabled) {
        open_account_window(app, &account)?;
        opened.push(account);
    }
    Ok(opened)
}

pub fn open_alternate_for_target(
    app: &AppHandle,
    target: &str,
    exclude_account_id: &str,
) -> Result<WebAccountSlot, String> {
    let provider = WebAccountProvider::from_web_target(target)
        .ok_or_else(|| format!("지원하지 않는 Web Agent입니다: {target}"))?;
    let accounts = load_accounts(app)?;
    let enabled: Vec<_> = accounts
        .iter()
        .filter(|item| item.provider == provider && item.enabled)
        .collect();
    if enabled.len() < 2 {
        return Err(format!(
            "{} 다른 계정 슬롯이 없습니다. 설정에서 두 번째 슬롯을 켜주세요.",
            provider.label_ko()
        ));
    }
    let start = enabled
        .iter()
        .position(|item| item.id == exclude_account_id)
        .unwrap_or(0);
    for offset in 1..=enabled.len() {
        let candidate = enabled[(start + offset) % enabled.len()];
        if candidate.id != exclude_account_id {
            let account = (*candidate).clone();
            open_account_window(app, &account)?;
            return Ok(account);
        }
    }
    Err(format!(
        "{} 다른 계정 슬롯을 찾지 못했습니다.",
        provider.label_ko()
    ))
}

pub fn close_account(app: &AppHandle, account_id: &str) -> Result<(), String> {
    let label = window_label(account_id);
    if let Some(window) = app.get_webview_window(&label) {
        window
            .close()
            .map_err(|error| format!("계정 창 닫기 실패: {error}"))?;
    }
    Ok(())
}

pub fn close_accounts(app: &AppHandle, account_ids: &[String]) -> Result<(), String> {
    for account_id in account_ids {
        let _ = close_account(app, account_id);
    }
    Ok(())
}

fn open_account_window(app: &AppHandle, account: &WebAccountSlot) -> Result<(), String> {
    let label = window_label(&account.id);
    let url = Url::parse(account.provider.url())
        .map_err(|error| format!("URL 파싱 실패: {error}"))?;
    let title = format!("{} · {}", account.provider.label_ko(), account.label);

    if let Some(existing) = app.get_webview_window(&label) {
        existing
            .navigate(url)
            .map_err(|error| format!("계정 창 이동 실패: {error}"))?;
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }

    let data_dir = profile_dir(app, &account.id)?;
    fs::create_dir_all(&data_dir)
        .map_err(|error| format!("계정 프로필 폴더 생성 실패: {error}"))?;

    WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url))
        .title(title)
        .inner_size(1180.0, 820.0)
        .resizable(true)
        .data_directory(data_dir)
        .build()
        .map_err(|error| format!("계정 창을 열지 못했습니다: {error}"))?;
    Ok(())
}
