"use strict";

const REPO = "wch0798/ai-character";
const REPO_URL = `https://github.com/${REPO}`;

const SECTIONS = [
  { id: "welcome", title: "시작하기", essential: true },
  { id: "folder", title: "기본 작업 폴더", essential: true },
  { id: "keys", title: "AI 키 연결", essential: true },
  { id: "accounts", title: "프로그램 · 로그인" },
  { id: "behavior", title: "동작 방식" },
  { id: "alerts", title: "알림 · 비용 한도" },
  { id: "updates", title: "자동 업데이트" },
  { id: "finish", title: "마무리 · 백업" },
];

const KEY_INFO = {
  GEMINI_API_KEY: {
    title: "Google Gemini",
    tag: ["free", "무료 · 추천"],
    url: "https://aistudio.google.com/apikey",
    desc: "Google 계정만 있으면 1분 안에 무료로 받을 수 있습니다. 조사·검토·계획처럼 정확한 정보가 필요한 일을 이 키로 처리합니다.",
    how: "링크 열기 → 'Create API key' → 만들어진 키 복사 → 아래 칸에 붙여넣고 저장",
  },
  OPENROUTER_API_KEY: {
    title: "OpenRouter",
    tag: ["free", "무료 모델"],
    url: "https://openrouter.ai/settings/keys",
    desc: "여러 회사의 무료 모델을 쓸 수 있습니다. Gemini가 막힐 때 대신 사용합니다.",
    how: "로그인 → 'Create Key' → 키 복사 → 붙여넣고 저장",
  },
  JINA_API_KEY: {
    title: "Jina 웹 검색",
    tag: ["free", "무료 · 웹 검색에 필요"],
    url: "https://jina.ai/",
    desc: "AI가 인터넷을 검색할 때 쓰는 서비스입니다. 이 키가 없으면 '오늘 날씨', '최신 뉴스' 같은 질문에 웹을 찾아보지 못합니다. 가입하면 무료 사용량을 줍니다.",
    how: "사이트 접속 → 화면의 'API Key' 영역에서 jina_ 로 시작하는 키 복사 → 붙여넣고 저장",
  },
  GROQ_API_KEY: {
    title: "Groq",
    tag: ["free", "무료 · 추천 · 아주 빠름"],
    url: "https://console.groq.com/keys",
    desc: "카드 없이 영구 무료입니다 (분당 30회, 하루 1,000회). 답이 매우 빨라서 Gemini 다음 대체 경로로 좋습니다.",
    how: "Google 계정으로 로그인 → 'Create API Key' → gsk_ 로 시작하는 키 복사 → 붙여넣고 저장",
  },
  NVIDIA_API_KEY: {
    title: "NVIDIA NIM",
    tag: ["free", "무료 · 하루 한도 없음"],
    url: "https://build.nvidia.com/settings/api-keys",
    desc: "카드 없이 무료입니다 (분당 약 40회, 하루 한도 없음). NVIDIA는 '개발·시험용'으로 안내합니다.",
    how: "로그인 → 'Generate API Key' (권한은 'Public API Endpoints' 선택) → nvapi- 로 시작하는 키 복사 → 붙여넣고 저장",
  },
  ZAI_API_KEY: {
    title: "Z.ai GLM (중국 Zhipu)",
    tag: ["free", "무료 Flash 모델만"],
    url: "https://z.ai/manage-apikey/apikey-list",
    desc: "GLM-4.7-Flash를 기간 제한 없이 무료로 씁니다. 앱은 무료 Flash 모델만 부르도록 고정되어 있어 같은 키로 유료 모델이 불리는 일이 없습니다. 한 번에 요청 하나씩만 처리합니다.",
    how: "가입 → API Keys → 'Create a new API key' → 복사 → 붙여넣고 저장 (충전은 하지 마세요)",
  },
  SAMBANOVA_API_KEY: {
    title: "SambaNova",
    tag: ["free", "무료 · 하루 횟수 적음"],
    url: "https://cloud.sambanova.ai/apis",
    desc: "카드 없이 무료지만 모델마다 하루 약 20회로 적습니다. 다른 무료 AI가 다 막혔을 때 쓰는 예비용입니다.",
    how: "가입 → API Keys → 'Generate New API Key' → 복사 → 붙여넣고 저장",
  },
  CLOUDFLARE_API_TOKEN: {
    title: "Cloudflare Workers AI 토큰",
    tag: ["free", "무료 · 계정 ID도 필요"],
    url: "https://dash.cloudflare.com/?to=/:account/ai/workers-ai",
    desc: "무료 플랜은 하루 10,000 뉴런(작은 질문 수백 개)까지 무료이고, 무료 플랜에서는 요금이 나가지 않습니다. 아래 '계정 ID'도 함께 넣어야 동작합니다.",
    how: "로그인 → Workers AI → 'Use REST API' → 'Create a Workers AI API Token' → 복사 → 붙여넣고 저장",
  },
  CLOUDFLARE_ACCOUNT_ID: {
    title: "Cloudflare 계정 ID",
    tag: ["", "토큰과 같은 화면"],
    url: "https://dash.cloudflare.com/?to=/:account/ai/workers-ai",
    desc: "토큰을 만든 'Use REST API' 화면에 'Account ID'가 함께 나옵니다. 비밀번호는 아니지만 키와 같은 파일에 저장합니다.",
    how: "같은 화면에서 Account ID 복사 → 붙여넣고 저장",
  },
  SILICONFLOW_API_KEY: {
    title: "SiliconFlow (중국)",
    tag: ["free", "무료 소형 모델만"],
    url: "https://cloud.siliconflow.com/account/ak",
    desc: "Qwen3-8B 같은 작은 모델이 무료입니다. 앱은 무료 모델만 부르도록 고정되어 있습니다. 무료 모델에 실명 인증을 요구하는 경우가 있어 한국 계정은 막힐 수 있습니다.",
    how: "가입 → API Keys → 'Create new API key' → 복사 → 붙여넣고 저장 (충전은 하지 마세요)",
  },
  SKT_AX_API_KEY: {
    title: "SKT A.X 4.0 (한국)",
    tag: ["free", "무료 · 가입 없음"],
    url: "https://github.com/SKT-AI/A.X-4.0",
    desc: "SK텔레콤이 무료 체험용으로 공개한 키입니다. 가입 없이 '공개 체험 키로 켜기' 한 번이면 됩니다. 한국어에 강하고, IP당 분당 10회까지입니다. 체험(베타) 서비스라 예고 없이 바뀔 수 있습니다.",
    how: "아래 '공개 체험 키로 켜기'를 누르면 끝",
  },
  HASA_API_KEY: {
    title: "HASA 공공 AI 허브 (한국)",
    tag: ["free", "무료 · 한국 모델 다수"],
    url: "https://open.hasa.re.kr/account/dev-keys",
    desc: "비영리 공공 서비스로 EXAONE·HyperCLOVA X·Kanana·Mi:dm·Solar 같은 국산 모델을 무료로 씁니다 (하루 500회, 분당 10회, 한 번에 1개). 기본은 EXAONE 4.0 32B입니다. 개발·시험용 키라 고객용 서비스에는 쓰면 안 됩니다.",
    how: "이메일로 가입 → 개발 키 화면에서 'sk-dev-' 키 발급 → 복사 → 붙여넣고 저장",
  },
  HUNYUAN_API_KEY: {
    title: "Tencent Hunyuan (중국)",
    tag: ["free", "무료 lite 모델만"],
    url: "https://console.cloud.tencent.com/hunyuan/start",
    desc: "hunyuan-lite 모델이 무료입니다. 앱은 hunyuan-lite만 부르도록 고정되어 있습니다. Tencent Cloud 가입과 실명 인증(여권 가능)이 필요해 한국에서는 번거로울 수 있습니다.",
    how: "Tencent Cloud 가입·인증 → 混元 콘솔 → API KEY 만들기 → 복사 → 붙여넣고 저장 (충전은 하지 마세요)",
  },
  GITHUB_TOKEN: {
    title: "GitHub 토큰",
    tag: ["", "선택"],
    url: "https://github.com/settings/personal-access-tokens/new",
    desc: "예약 작업의 PR 요약 같은 GitHub 기능에 사용합니다. 권한은 읽기만 주면 충분합니다.",
    how: "토큰 이름 입력 → 저장소 읽기 권한 → 'Generate token' → 복사 → 붙여넣고 저장",
  },
  OPENAI_API_KEY: {
    title: "OpenAI",
    tag: ["warn", "유료"],
    url: "https://platform.openai.com/api-keys",
    desc: "호출할 때마다 요금이 나갑니다. '동작 방식'에서 유료 사용을 켜고, 매번 승인해야만 사용됩니다.",
    how: "필요할 때만 등록하세요.",
  },
  ANTHROPIC_API_KEY: {
    title: "Anthropic API",
    tag: ["warn", "유료"],
    url: "https://console.anthropic.com/settings/keys",
    desc: "Claude 구독(Pro/Max)과는 별개인 종량제 키입니다. 구독형 Claude 프로그램에는 이 키를 넘기지 않아 구독 요금만 쓰도록 막아 둡니다.",
    how: "구독형 Claude만 쓴다면 등록하지 않아도 됩니다.",
  },
};

const LOGIN_AGENTS = { claude: "Claude 로그인", codex: "Codex 로그인", cursor: "Cursor 로그인", antigravity: "Antigravity 로그인" };

const SIGN_STEPS = [
  {
    id: "pubkey",
    title: "공개키를 GitHub 변수(Variable)로 등록",
    url: `${REPO_URL}/settings/variables/actions/new`,
    name: "AI_CHARACTER_UPDATER_PUBKEY",
    lines: [
      "'열기 + 이름 복사'를 누르면 GitHub 화면이 열리고 이름이 복사됩니다. Name 칸에 붙여넣기(⌘V / Ctrl+V).",
      ".key.pub 파일을 텍스트 편집기로 열어 내용 전체를 Value 칸에 붙여넣고 'Add variable'.",
    ],
  },
  {
    id: "privateKey",
    title: "개인키를 GitHub 비밀(Secret)로 등록",
    url: `${REPO_URL}/settings/secrets/actions/new`,
    name: "TAURI_SIGNING_PRIVATE_KEY",
    lines: [
      "Name 칸에 붙여넣기 후, .key 파일(끝이 .pub 아닌 것) 내용 전체를 Secret 칸에 붙여넣고 'Add secret'.",
      "개인키는 이 페이지나 채팅에 붙여넣지 마세요. GitHub 화면에만 넣습니다.",
    ],
  },
  {
    id: "password",
    title: "키 비밀번호를 Secret으로 등록 (비밀번호를 정했을 때만)",
    url: `${REPO_URL}/settings/secrets/actions/new`,
    name: "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
    lines: ["키를 만들 때 비밀번호를 넣지 않았다면 '완료'만 누르고 넘어가세요."],
  },
  {
    id: "push",
    title: "자동 배포 파일을 GitHub에 올리기",
    url: `${REPO_URL}/blob/main/.github/workflows/release.yml`,
    lines: [
      "Cursor 채팅에 '변경 내용 커밋하고 푸시해줘'라고 말하면 됩니다.",
      "'열기'를 눌렀을 때 파일 내용이 보이면 완료, 404면 아직입니다.",
    ],
  },
  {
    id: "build",
    title: "서명된 설치본 만들기",
    url: `${REPO_URL}/actions/workflows/release.yml`,
    lines: [
      "오른쪽 'Run workflow' → 초록 'Run workflow'. 20~40분 뒤 초록 체크가 뜨면 성공입니다.",
      "로그에 'building without auto-update artifacts'가 보이면 위의 이름 철자나 Variable/Secret 위치를 확인하세요.",
    ],
  },
  {
    id: "install",
    title: "새 설치본을 한 번 직접 설치",
    url: `${REPO_URL}/releases/latest`,
    lines: [
      "Assets에서 Apple 칩 Mac은 aarch64 .dmg, Intel Mac은 x64 .dmg, Windows는 x64-setup.exe.",
      "설치 후 이 페이지를 다시 열면 맨 위 상태가 '자동 업데이트 켜짐'으로 바뀝니다.",
    ],
  },
];

let state = null;
let runtime = null;
let runtimeStale = false;
let current = "welcome";
const dirty = new Set();

// ---------- helpers ----------

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key === "text") el.textContent = value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (value === true) el.setAttribute(key, "");
    else el.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

function toast(message, tone) {
  const item = h("div", { class: `toast ${tone || ""}`, text: message });
  document.getElementById("toast").append(item);
  setTimeout(() => item.remove(), tone === "bad" ? 9000 : 4500);
}

const OFFLINE_MESSAGE = "AI Character 앱과 연결이 끊겼습니다. 앱이 꺼져 있거나 다시 시작하는 중이에요. 앱이 켜지면 자동으로 다시 연결됩니다 — 입력한 내용은 그대로 두고 잠시 기다린 뒤 다시 저장해 주세요.";
let reconnectTimer = null;

function setOffline(offline) {
  const banner = document.getElementById("offline");
  banner.hidden = !offline;
  if (offline && !reconnectTimer) {
    reconnectTimer = setInterval(async () => {
      try {
        const response = await fetch("/api/state", { credentials: "same-origin" });
        if (!response.ok) return;
        state = await response.json();
        clearInterval(reconnectTimer);
        reconnectTimer = null;
        banner.hidden = true;
        toast("앱과 다시 연결되었습니다. 방금 하던 저장을 다시 눌러 주세요.", "ok");
        if (dirty.has(current)) renderNav();
        else render();
      } catch {
        // still offline
      }
    }, 2500);
  }
}

async function request(path, options) {
  let response;
  try {
    response = await fetch(path, { credentials: "same-origin", ...options });
  } catch {
    setOffline(true);
    throw new Error(OFFLINE_MESSAGE);
  }
  setOffline(false);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) showFatal("이 페이지의 접속이 만료되었습니다. 작업 표시줄(Windows) 또는 메뉴 막대(Mac)의 AI Character 아이콘 → '처음 설정 (웹)'을 누르거나, 앱 설정의 '웹에서 설정 보기'를 누르면 다시 열립니다.");
    throw new Error(data.error || `요청 실패 (${response.status})`);
  }
  return data;
}

const api = {
  get: (path) => request(path),
  post: (path, body) =>
    request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-AI-Character": "setup" },
      body: JSON.stringify(body || {}),
    }),
};

async function busy(button, task, busyText) {
  const label = button.textContent;
  button.disabled = true;
  if (busyText) button.textContent = busyText;
  try {
    return await task();
  } catch (error) {
    toast(error.message || String(error), "bad");
    return undefined;
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

/** Two-click confirmation for destructive actions; no native dialogs. */
function confirmButton(label, armedLabel, action, className) {
  let timer = null;
  const button = h("button", { class: className || "danger", text: label });
  button.addEventListener("click", () => {
    if (!timer) {
      button.textContent = armedLabel;
      button.classList.add("armed");
      timer = setTimeout(() => {
        timer = null;
        button.textContent = label;
        button.classList.remove("armed");
      }, 4000);
      return;
    }
    clearTimeout(timer);
    timer = null;
    button.textContent = label;
    button.classList.remove("armed");
    action(button);
  });
  return button;
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = h("textarea", { style: "position:fixed;opacity:0" });
    area.value = text;
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

function toggle(id, title, desc, checked, options) {
  const input = h("input", { type: "checkbox", id, "data-field": id });
  input.checked = Boolean(checked);
  return h(
    "label",
    { class: `toggle ${options && options.danger ? "danger" : ""}` },
    input,
    h("span", { class: "switch" }),
    h("div", {}, h("strong", { text: title }), h("span", { class: "desc", text: desc }))
  );
}

function numberField(id, title, desc, value, min, max, step) {
  const input = h("input", { type: "number", id, min, max, step: step || 1, "data-field": id });
  input.value = value;
  return h("div", { class: "field" }, h("div", {}, h("strong", { text: title }), h("span", { class: "desc", text: desc })), input);
}

/** An emptied number box keeps the old value instead of silently becoming 0 ("no limit"). */
function numberOr(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : fallback;
}

function readField(id) {
  const el = document.getElementById(id);
  if (!el) return undefined;
  if (el.type === "checkbox") return el.checked;
  if (el.type === "number") return el.value.trim() === "" ? NaN : Number(el.value);
  return el.value;
}

function explain(title, items) {
  return h("details", { class: "explain" }, h("summary", { text: title }), h("ul", {}, ...items.map((item) => h("li", { text: item }))));
}

/** Beginner step-by-step card. Each step: [title, detail, ...extra nodes]. */
function guide(title, steps, options) {
  const opts = options || {};
  return h(
    "details",
    { class: "card guide", open: opts.open !== false },
    h("summary", { text: title }),
    opts.lead ? h("p", { class: "muted small", text: opts.lead }) : null,
    h(
      "ol",
      { class: "steps" },
      ...steps.map(([stepTitle, detail, ...extra]) => h("li", {}, h("strong", { text: stepTitle }), detail ? h("p", { class: "small", text: detail }) : null, ...extra))
    ),
    opts.tip ? h("p", { class: "tip", text: `💡 ${opts.tip}` }) : null
  );
}

function faq(title, items) {
  return h("div", { class: "card" }, h("h3", { text: title }), ...items.map(([question, answer]) => h("details", { class: "faq" }, h("summary", { text: question }), h("p", { class: "small", text: answer }))));
}

function glossary(items) {
  return h(
    "details",
    { class: "card" },
    h("summary", { text: "📖 처음 보는 단어 풀이" }),
    h("dl", { class: "glossary" }, ...items.flatMap(([word, meaning]) => [h("dt", { text: word }), h("dd", { text: meaning })]))
  );
}

const LOCAL_WORDS = [
  ["모델", "AI의 '두뇌' 파일입니다. 이름 뒤의 숫자(2.4B, 7.8B…)가 클수록 똑똑하지만 파일이 크고 메모리를 많이 씁니다. B는 10억(Billion)이라는 뜻입니다."],
  ["Ollama (올라마)", "모델 파일을 내 컴퓨터에서 실행해 주는 무료 프로그램입니다. 모델을 쓰려면 먼저 이것부터 설치합니다."],
  ["메모리 (RAM)", "컴퓨터가 일할 때 쓰는 책상 크기입니다. 모델이 이 책상 위에 올라가야 돌아가므로, 모델 크기보다 넉넉해야 합니다."],
  ["저장공간 (디스크)", "파일을 보관하는 창고입니다. 내장 디스크가 꽉 찼다면 외장하드를 저장 위치로 고를 수 있습니다."],
  ["그래픽카드 (GPU)", "그림 처리용 부품이지만 AI 계산도 아주 빠르게 합니다. NVIDIA 카드나 Apple 칩(M1~M4)이 있으면 답이 빨리 나옵니다."],
  ["GB (기가바이트)", "크기 단위입니다. 사진 한 장이 약 0.005GB, 영화 한 편이 약 2~5GB입니다. 모델 하나는 보통 2~20GB입니다."],
];

function showFatal(message) {
  const box = document.getElementById("fatal");
  box.textContent = message;
  box.style.display = "block";
}

// ---------- progress ----------

function progress() {
  return (state && state.setup && state.setup.progress) || {};
}

async function saveProgress(id, value) {
  const next = { ...progress() };
  if (value) next[id] = value;
  else delete next[id];
  const saved = await api.post("/api/setup", { progress: next });
  state.setup = saved;
  renderNav();
}

function nextSection(id) {
  const index = SECTIONS.findIndex((s) => s.id === id);
  return SECTIONS[Math.min(SECTIONS.length - 1, index + 1)].id;
}

function prevSection(id) {
  const index = SECTIONS.findIndex((s) => s.id === id);
  return SECTIONS[Math.max(0, index - 1)].id;
}

function go(id) {
  if (location.hash !== `#${id}`) location.hash = id;
  else show(id);
}

// ---------- status summaries ----------

function summary() {
  const keys = state.apiKeys || [];
  const has = (name) => keys.some((k) => k.name === name && k.configured);
  const readiness = state.readiness || {};
  const build = state.build || {};
  return {
    folder: Boolean(state.projectDir),
    freeKey: has("GEMINI_API_KEY") || has("OPENROUTER_API_KEY"),
    handsFree: Boolean(readiness.handsFreeReady),
    claude: Boolean(readiness.claudeCliReady),
    signed: Boolean(build.signed && build.updaterReady),
    sourceRun: Boolean(build.sourceRun),
  };
}

// ---------- rendering ----------

function renderNav() {
  const nav = document.getElementById("nav");
  const done = progress();
  const item = (section, index) => {
    const mark = done[section.id];
    return h(
      "li",
      {},
      h(
        "a",
        { href: `#${section.id}`, class: [section.id === current ? "active" : "", mark || ""].join(" ").trim() },
        h("span", { class: "dot", text: mark === "done" ? "✓" : mark === "skipped" ? "–" : String(index + 1) }),
        section.title
      )
    );
  };
  const indexed = SECTIONS.map((section, index) => [section, index]);
  nav.replaceChildren(...indexed.filter(([section]) => section.essential).map(([section, index]) => item(section, index)));
  document.getElementById("nav-more").replaceChildren(...indexed.filter(([section]) => !section.essential).map(([section, index]) => item(section, index)));
  document.getElementById("nav-usage").classList.toggle("active", current === "usage");
  for (const id of ["local", "remote", "help"]) document.getElementById(`nav-${id}`).classList.toggle("active", current === id);
  const count = SECTIONS.filter((s) => done[s.id]).length;
  document.getElementById("overall-fill").style.width = `${Math.round((count / SECTIONS.length) * 100)}%`;
  document.getElementById("overall-text").textContent = state.setup && state.setup.completed ? "설정 완료 ✓" : `${count} / ${SECTIONS.length} 단계`;
}

function footer(id, save) {
  const isLast = id === SECTIONS[SECTIONS.length - 1].id;
  const back = h("button", { class: "link", text: "← 이전", onclick: () => go(prevSection(id)) });
  if (id === SECTIONS[0].id) back.style.visibility = "hidden";
  const skip = h("button", {
    class: "link",
    text: "나중에 하기",
    onclick: async () => {
      await saveProgress(id, "skipped").catch(() => undefined);
      go(nextSection(id));
    },
  });
  const nextButton = h("button", { class: "primary", text: isLast ? "설정 완료" : save ? "저장하고 다음 →" : "다음 →" });
  nextButton.addEventListener("click", () =>
    busy(nextButton, async () => {
      if (save) await save();
      dirty.delete(id);
      await saveProgress(id, "done");
      if (isLast) {
        state.setup = await api.post("/api/setup", { completed: true });
        renderNav();
        toast("처음 설정을 마쳤습니다. 이 창은 닫아도 됩니다.", "ok");
        render();
        return;
      }
      if (save) toast("저장했습니다.", "ok");
      go(nextSection(id));
    }, "저장 중…")
  );
  return h("div", { class: "footer-nav" }, back, h("div", { class: "row" }, isLast ? null : skip, nextButton));
}

function header(id, title, lead) {
  const index = SECTIONS.findIndex((s) => s.id === id);
  const optional = !SECTIONS[index].essential && id !== "finish";
  return [
    h("div", { class: "eyebrow" }, `${index + 1}단계 / ${SECTIONS.length}`, optional ? h("span", { class: "badge", style: "margin-left:8px", text: "선택 · 건너뛰어도 됩니다" }) : null),
    h("h2", { text: title }),
    h("p", { class: "lead", text: lead }),
  ];
}

function keyTestFailed(message) {
  return /실패|거부|오류/.test(String(message || ""));
}

function keyConfigured(name) {
  return (state.apiKeys || []).some((k) => k.name === name && k.configured);
}

/** Saves one key from an inline input; used by the quick setup so a beginner never leaves the first page. */
function inlineKey(name, placeholder) {
  const input = h("input", { type: "password", class: "grow", placeholder, autocomplete: "off", spellcheck: "false" });
  const save = h("button", { class: "primary", text: "저장" });
  save.addEventListener("click", () =>
    busy(save, async () => {
      const value = input.value.trim();
      if (!value) throw new Error("키를 붙여넣어 주세요.");
      state.apiKeys = await api.post("/api/key", { name, value });
      input.value = "";
      const status = (state.apiKeys || []).find((k) => k.name === name);
      if (status && status.testable) {
        const result = await api.post("/api/key/test", { name }).catch((error) => ({ message: `저장은 됐지만 연결 확인 실패: ${error.message}` }));
        toast(result.message, keyTestFailed(result.message) ? "bad" : "ok");
      } else {
        toast("저장했습니다.", "ok");
      }
      await refreshState();
      render();
    }, "저장 중…")
  );
  return h("div", { class: "row" }, input, save);
}

function quickSetup() {
  const s = summary();
  const recommendedDone = Boolean(state.preferences && state.preferences.cradleEnabled && state.alerts && state.alerts.blockPaidOverLimit);
  const apply = h("button", { class: "primary", text: recommendedDone ? "다시 적용" : "추천 설정 적용" });
  apply.addEventListener("click", () =>
    busy(apply, async () => {
      state = await api.post("/api/recommended");
      toast("추천 설정을 적용했습니다.", "ok");
      render();
    }, "적용 중…")
  );
  const pick = h("button", { class: "primary", text: s.folder ? "다른 폴더 선택" : "폴더 선택…" });
  pick.addEventListener("click", () =>
    busy(pick, async () => {
      toast("AI Character 앱에 폴더 선택 창이 열렸습니다. 이 브라우저 뒤에 가려져 있을 수 있어요.");
      const result = await api.post("/api/project/pick");
      if (result.cancelled) return;
      await refreshState();
      toast("작업 폴더를 저장했습니다.", "ok");
      render();
    }, "선택 창 열림…")
  );
  const step = (done, num, title, desc, ...body) =>
    h("div", { class: `quick-step ${done ? "done" : ""}` }, h("div", { class: "num", text: done ? "✓" : String(num) }), h("div", {}, h("h4", { text: title }), h("p", { class: "muted small", text: desc }), ...body));
  return h(
    "div",
    { class: "card" },
    h("h3", { text: "3분 빠른 설정" }),
    h("p", { class: "muted small", text: "아래 세 가지만 하면 바로 쓸 수 있어요. 나머지 단계는 나중에 필요할 때 하면 됩니다." }),
    h(
      "div",
      { class: "quick", style: "margin-top:12px" },
      step(recommendedDone, 1, "추천 설정 켜기", "무료 AI 자동 선택 · 필요할 때 웹 검색 · 유료 API 차단 · 하루 1달러 한도 · 알림을 한 번에 켭니다.", h("div", { class: "row" }, apply)),
      step(s.folder, 2, "기본 작업 폴더 고르기", s.folder ? `현재: ${state.projectDir} — 대화마다 대화창 위 📁 '바꾸기'로 다른 폴더를 쓸 수 있어요.` : "새 대화가 처음 쓰는 폴더입니다. 대화마다 나중에 다른 폴더로 바꿀 수 있어요.", h("div", { class: "row" }, pick)),
      step(
        keyConfigured("GEMINI_API_KEY"),
        3,
        "Gemini 무료 키 넣기",
        keyConfigured("GEMINI_API_KEY") ? "등록됨. 새 키로 바꾸려면 다시 붙여넣으세요." : "① 아래 링크 열기 → ② 'Create API key' → ③ 키 복사 → ④ 여기에 붙여넣고 저장",
        h("p", { class: "small" }, h("a", { href: KEY_INFO.GEMINI_API_KEY.url, target: "_blank", rel: "noopener noreferrer", text: "Gemini 키 받는 곳 열기 ↗" })),
        inlineKey("GEMINI_API_KEY", "AIza… 로 시작하는 키 붙여넣기")
      ),
      step(
        keyConfigured("JINA_API_KEY"),
        "+",
        "(선택) Jina 웹 검색 키",
        keyConfigured("JINA_API_KEY") ? "등록됨. AI가 필요할 때 인터넷을 검색합니다." : "인터넷 검색이 필요하면 넣으세요. jina.ai 접속 → 'API Key'의 jina_… 키 복사 → 붙여넣고 저장",
        h("p", { class: "small" }, h("a", { href: KEY_INFO.JINA_API_KEY.url, target: "_blank", rel: "noopener noreferrer", text: "Jina 키 받는 곳 열기 ↗" })),
        inlineKey("JINA_API_KEY", "jina_… 로 시작하는 키 붙여넣기")
      )
    )
  );
}

function providerById(id) {
  return (state.providers || []).find((p) => p.provider === id) || {};
}

function usingRow(name, what, on, statusText, detail) {
  return h(
    "tr",
    {},
    h("td", {}, name),
    h("td", {}, h("span", { class: `badge ${on === true ? "ok" : on === "warn" ? "warn" : ""}`, text: statusText })),
    h("td", {}, h("div", { text: detail || "" }), h("div", { class: "what", text: what }))
  );
}

function usingNow() {
  const r = state.readiness || {};
  const gemini = providerById("gemini_api");
  const openrouter = providerById("openrouter_api");
  const openai = providerById("openai_api");
  const freePool = providerById("free_pool_api");
  const usage = state.usage;
  const build = state.build || {};
  const rows = [
    usingRow("무료 자동 모드 (CRADLE)", "조사·검토·계획처럼 두뇌가 처리할 일은 무료 AI가 자동으로 합니다. 일반 대화는 ChatGPT(Codex)가 답합니다.", r.cradleEnabled ? true : "warn", r.cradleEnabled ? "켜짐" : "꺼짐", r.handsFreeReady ? "대화는 ChatGPT, 정보 처리는 무료 Gemini" : r.message),
    usingRow("Google Gemini", "정확한 정보와 조사의 담당입니다. 무료 모델을 순서대로 시도합니다.", gemini.available ? true : "warn", gemini.available ? "정보 담당" : "안 씀", gemini.available ? `모델: ${gemini.model}` : gemini.reason),
    usingRow("OpenRouter", "Gemini가 막힐 때의 무료 대체입니다. 코드·음악 전용 모델은 정보 답변에 쓰지 않습니다.", openrouter.available ? true : "", openrouter.available ? "대기" : "안 씀", openrouter.available ? `모델: ${openrouter.model}` : openrouter.reason),
    usingRow("추가 무료 AI", `Gemini·OpenRouter까지 막히면 ${FREE_ORDER_TEXT} 순서로 준비된 곳을 대신 씁니다. 모두 무료 등급만 사용합니다.`, freePool.available ? true : "", freePool.available ? "대기 중" : "안 씀", freePool.available ? `순서: ${freePool.model}` : "'AI 키 연결'에서 키를 넣거나 '내 컴퓨터 AI'에서 설치하면 사용합니다."),
    usingRow("Jina 웹 검색", "최신 정보가 필요한 질문이면 인터넷을 검색해 결과를 AI에게 넘깁니다.", r.jinaApiConfigured && r.autoWebSearch ? true : "warn", r.jinaApiConfigured ? (r.autoWebSearch ? "사용 중" : "꺼짐") : "키 없음", r.jinaApiConfigured ? (r.autoWebSearch ? "필요할 때 자동 검색" : "'동작 방식'에서 웹 검색을 켜세요.") : "키가 없어 웹 검색을 못 합니다. 3단계에서 넣을 수 있어요."),
    usingRow("Claude (구독형 프로그램)", "파일 작업의 계획과 수정 담당입니다. Cursor도 파일을 고칠 수 있고, 플러그인은 Claude에 붙습니다.", r.claudeCliReady ? true : "", r.claudeCliReady ? "파일 작업" : "없음", r.claudeCliReady ? "구독 사용 한도(5시간·주간) 안에서 사용" : "없어도 Cursor나 무료 AI로 일부 작업은 됩니다."),
    usingRow("OpenAI (유료)", "호출마다 요금이 나가는 API. 허용해도 매번 승인을 받고, 하루 한도를 넘으면 막힙니다.", openai.enabled ? "warn" : "", openai.enabled ? "허용됨" : "차단", openai.reason),
  ];
  if (usage) {
    const limit = usage.dailyCostLimitUsd > 0 ? ` / 한도 $${usage.dailyCostLimitUsd}` : " (유료 사용 안 함)";
    rows.push(usingRow("오늘 사용량", "앱이 오늘 AI를 부른 횟수와 유료 비용입니다. 구독형 Claude 사용은 비용 0으로 셉니다.", usage.level === "ok" ? true : "warn", usage.level === "over" ? "한도 초과" : usage.level === "warn" ? "주의" : "정상", `호출 ${usage.calls}회 · 유료 ${usage.paidCalls}회 · $${Number(usage.costUsd || 0).toFixed(2)}${limit}`));
  }
  rows.push(usingRow("앱 자동 업데이트", "새 버전이 나오면 서명을 확인한 뒤 받아 둡니다.", build.signed && build.updaterReady ? true : "", build.signed ? "켜짐" : build.sourceRun ? "git 업데이트" : "서명 없음", `현재 v${build.version}`));
  const paths = state.paths || {};
  return h(
    "details",
    { class: "card" },
    h("summary", { text: "🔍 자세히 보기: 지금 어떤 AI를 쓰고 있나요?" }),
    h("p", { class: "muted small", text: "이 앱이 실제로 쓰는 서비스와 상태입니다. 다른 단계에서 바꾸면 여기도 바로 바뀝니다." }),
    h("div", { class: "table-wrap" }, h("table", { class: "using" }, h("thead", {}, h("tr", {}, h("th", { text: "구성 요소" }), h("th", { text: "상태" }), h("th", { text: "설명" }))), h("tbody", {}, ...rows))),
    h(
      "details",
      { class: "explain", style: "margin-top:12px" },
      h("summary", { text: "내 정보는 어디에 저장되나요?" }),
      h(
        "ul",
        {},
        h("li", { text: `설정: ${paths.settings || "앱 설정 폴더"}` }),
        h("li", { text: `API 키: ${r.keysEnvPath || "앱 전용 keys.env"} — 이 컴퓨터 사용자만 읽을 수 있고, 이 페이지는 키를 다시 보여 주지 않습니다.` }),
        h("li", { text: "대화 기록·사용량: 앱 폴더의 데이터베이스. 인터넷에 올리지 않습니다." }),
        h("li", { text: "이 설정 페이지: 이 컴퓨터 안(127.0.0.1)에서만 열리고 다른 기기에서는 접속할 수 없습니다." })
      )
    )
  );
}

function workOrder() {
  const items = [
    ["대화", "ChatGPT 구독이 답합니다."],
    ["정보 찾기", "무료 Gemini가 찾습니다."],
    ["파일 고치기", "Claude가 계획하고 고칩니다. Cursor도 고칠 수 있습니다."],
  ];
  return h(
    "div",
    { class: "card" },
    h("h3", { text: "질문하면 누가 답하나요?" }),
    h("ol", { class: "steps" }, ...items.map(([title, body]) => h("li", {}, h("h4", { text: title }), h("p", { text: body })))),
    h("p", { class: "muted small", text: "유료 API는 꺼져 있습니다. 사용량을 다 쓰면 채팅에 알려 줍니다." })
  );
}

function resetSettingsCard() {
  const button = h("button", { text: "설정 초기화" });
  button.title = "동작 스위치와 왼쪽 단계 체크를 모두 풉니다. 키와 작업 폴더는 지우지 않습니다.";
  let armed = false;
  let timer = 0;
  button.addEventListener("click", () => {
    if (!armed) {
      armed = true;
      button.textContent = "한 번 더 누르면 체크까지 해제";
      timer = window.setTimeout(() => {
        armed = false;
        button.textContent = "설정 초기화";
      }, 4000);
      return;
    }
    window.clearTimeout(timer);
    armed = false;
    button.textContent = "설정 초기화";
    busy(button, async () => {
      localStorage.removeItem("aic-sign-steps");
      state = await api.post("/api/reset");
      toast("초기화했습니다. 체크는 모두 풀렸고, 키와 작업 폴더는 그대로입니다.", "ok");
      render();
    }, "초기화 중…");
  });
  return h(
    "div",
    { class: "card" },
    h("h3", { text: "설정 초기화" }),
    h("p", { class: "muted small", text: "동작 방식, 알림, 업데이트 스위치와 왼쪽 단계 체크를 모두 풉니다. API 키와 작업 폴더는 지우지 않습니다." }),
    h("div", { class: "row" }, button)
  );
}

function readyBanner() {
  const s = summary();
  const recommended = Boolean(state.preferences && state.preferences.cradleEnabled);
  const left = [!recommended && "추천 설정", !s.folder && "작업 폴더", !keyConfigured("GEMINI_API_KEY") && "Gemini 키"].filter(Boolean);
  if (left.length === 0) {
    return h("div", { class: "notice ok" }, h("strong", { text: "✓ 바로 쓸 수 있어요. " }), "화면의 캐릭터를 클릭해 대화창을 열고 말을 걸어 보세요. 아래 단계는 필요할 때만 하면 됩니다.");
  }
  return h("div", { class: "notice" }, h("strong", { text: `남은 필수 항목 ${left.length}개: ` }), `${left.join(" · ")} — 아래 카드에서 차례로 하면 됩니다.`);
}

function sectionWelcome() {
  return [
    ...header("welcome", "AI Character 시작하기", "아래 세 가지만 하면 바로 쓸 수 있습니다. 버튼을 누르는 즉시 앱에 반영되고, 언제든 다시 열어 고칠 수 있어요."),
    readyBanner(),
    quickSetup(),
    workOrder(),
    usingNow(),
    footer("welcome"),
  ];
}

function sectionFolder() {
  const input = h("input", { type: "text", class: "grow", id: "project-path", placeholder: "/Users/나/Documents/내프로젝트" });
  input.value = state.projectDir || "";
  input.addEventListener("input", () => dirty.add("folder"));
  const pick = h("button", { class: "primary", text: "폴더 선택…" });
  pick.addEventListener("click", () =>
    busy(pick, async () => {
      toast("AI Character 앱에 폴더 선택 창이 열렸습니다. 브라우저 뒤에 있을 수 있어요.");
      const result = await api.post("/api/project/pick");
      if (result.cancelled) return;
      state.projectDir = result.projectDir;
      input.value = result.projectDir;
      dirty.delete("folder");
      toast("작업 폴더를 저장했습니다.", "ok");
    }, "선택 창 열림…")
  );
  const save = async () => {
    const path = input.value.trim();
    if (!path) throw new Error("폴더 경로를 입력하거나 '폴더 선택…'을 눌러 주세요.");
    if (path === state.projectDir) return;
    const result = await api.post("/api/project", { path });
    state.projectDir = result.projectDir;
  };
  return [
    ...header("folder", "기본 작업 폴더", "AI가 코드나 문서를 읽고 고칠 때 새 대화가 처음 쓰는 폴더입니다. 작업은 복사본에서 하고, 원본은 확인 후에만 바뀝니다."),
    h("div", { class: "notice" }, h("strong", { text: "📁 대화마다 다른 폴더를 쓸 수 있어요. " }), "대화창 위의 폴더 표시에서 '바꾸기'를 누르면 그 대화만 다른 폴더로 작업합니다 (Claude Code처럼). 여기서 정하는 건 새 대화의 시작 폴더입니다."),
    h(
      "div",
      { class: "card stack" },
      h("div", { class: "row" }, input, pick),
      h("p", { class: "muted small", text: "시스템 폴더나 홈 폴더 전체는 보안상 선택할 수 없습니다. 프로젝트별 폴더를 고르세요. 폴더 안에 .ai-character 작업 공간이 만들어집니다." })
    ),
    footer("folder", save),
  ];
}

function keyRow(status) {
  const info = KEY_INFO[status.name] || { title: status.label, tag: ["", ""], desc: "" };
  const input = h("input", { type: "password", class: "grow", placeholder: status.configured ? "새 키로 바꾸려면 입력" : "여기에 키 붙여넣기", autocomplete: "off", spellcheck: "false" });
  input.addEventListener("input", () => dirty.add("keys"));
  const save = h("button", { class: "primary", text: "저장" });
  save.addEventListener("click", () =>
    busy(save, async () => {
      const value = input.value.trim();
      if (!value) throw new Error("키를 붙여넣어 주세요.");
      state.apiKeys = await api.post("/api/key", { name: status.name, value });
      input.value = "";
      dirty.delete("keys");
      toast(`${info.title} 키를 저장했습니다.`, "ok");
      if (status.testable) {
        const result = await api.post("/api/key/test", { name: status.name }).catch((error) => ({ message: `연결 확인 실패: ${error.message}` }));
        toast(result.message, keyTestFailed(result.message) ? "bad" : "ok");
      }
      await refreshState();
      render();
    }, "저장 중…")
  );
  const actions = [save];
  if (status.name === "SKT_AX_API_KEY" && !status.configured) {
    const quick = h("button", { class: "primary", text: "공개 체험 키로 켜기" });
    quick.addEventListener("click", () =>
      busy(quick, async () => {
        state.apiKeys = await api.post("/api/key/skt-public");
        toast("SKT A.X를 켰습니다.", "ok");
        await refreshState();
        render();
      }, "켜는 중…")
    );
    actions.unshift(quick);
  }
  if (status.configured && status.testable) {
    const test = h("button", { text: "연결 확인" });
    test.addEventListener("click", () =>
      busy(test, async () => {
        const result = await api.post("/api/key/test", { name: status.name });
        toast(result.message, keyTestFailed(result.message) ? "bad" : "ok");
      }, "확인 중…")
    );
    actions.push(test);
  }
  if (status.configured) {
    actions.push(
      confirmButton("삭제", "한 번 더 누르면 삭제", (button) =>
        busy(button, async () => {
          state.apiKeys = await api.post("/api/key", { name: status.name, value: "" });
          toast(`${info.title} 키를 지웠습니다.`);
          await refreshState();
          render();
        })
      )
    );
  }
  return h(
    "div",
    { class: "key-row stack" },
    h(
      "div",
      { class: "row space" },
      h("div", { class: "row" }, h("h4", { text: info.title }), info.tag[1] ? h("span", { class: `badge ${info.tag[0]}`, text: info.tag[1] }) : null),
      h("span", { class: `badge ${status.configured ? "ok" : ""}`, text: status.configured ? "등록됨" : "없음" })
    ),
    h("p", { class: "muted small", text: info.desc }),
    info.url ? h("p", { class: "small" }, h("a", { href: info.url, target: "_blank", rel: "noopener noreferrer", text: "키 받는 곳 열기 ↗" }), "  ", h("span", { class: "muted", text: info.how })) : null,
    h("div", { class: "row" }, input, ...actions),
    status.configured && status.source ? h("p", { class: "muted small mono", text: `저장 위치: ${status.source}` }) : null
  );
}

const EXTRA_FREE_KEYS = [
  "GROQ_API_KEY",
  "NVIDIA_API_KEY",
  "SKT_AX_API_KEY",
  "HASA_API_KEY",
  "ZAI_API_KEY",
  "SAMBANOVA_API_KEY",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "SILICONFLOW_API_KEY",
  "HUNYUAN_API_KEY",
];
const FREE_ORDER_TEXT = "Groq → NVIDIA → SKT A.X → HASA → GLM → SambaNova → Cloudflare → SiliconFlow → Hunyuan → 내 컴퓨터(Ollama) → 다른 컴퓨터 → LM Studio";

function freeService(id) {
  return (state.freeServices || []).find((s) => s.id === id) || {};
}

function localLinkCard() {
  const running = (state.freeServices || []).filter((s) => s.local && s.configured).map((s) => s.label);
  return h(
    "div",
    { class: "card row space" },
    h(
      "div",
      { class: "stack" },
      h("h3", { text: "💻 내 컴퓨터에 설치하는 AI는 따로 있어요" }),
      h("p", { class: "muted small", text: running.length ? `지금 켜져 있음: ${running.join(", ")}` : "Ollama·LM Studio처럼 이 컴퓨터에 설치해 쓰는 AI는 '내 컴퓨터 AI (설치형)'에서 사양 확인부터 설치까지 합니다." })
    ),
    h("button", { text: "내 컴퓨터 AI 열기 →", onclick: () => go("local") })
  );
}

function sectionKeys() {
  const keys = state.apiKeys || [];
  const free = keys.filter((k) => ["GEMINI_API_KEY", "OPENROUTER_API_KEY"].includes(k.name));
  const extraFree = EXTRA_FREE_KEYS.map((name) => keys.find((k) => k.name === name)).filter(Boolean);
  const optional = keys.filter((k) => ["JINA_API_KEY", "GITHUB_TOKEN"].includes(k.name));
  const paid = keys.filter((k) => ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"].includes(k.name));
  const openFile = h("button", { text: "키 파일 직접 열기" });
  openFile.addEventListener("click", () =>
    busy(openFile, async () => {
      const result = await api.post("/api/keys/open");
      toast(`키 파일을 열었습니다: ${result.path}`);
    })
  );
  return [
    ...header("keys", "AI 키 연결", "정보 찾기에 쓰는 무료 Gemini 키만 넣으면 됩니다. 대화는 ChatGPT 로그인, 파일 고치기는 Claude 로그인이 담당이라 여기 키와 별개입니다."),
    h("div", { class: "card" }, h("h3", { text: "Gemini (이것만 넣으면 됩니다)" }), ...free.filter((k) => k.name === "GEMINI_API_KEY").map(keyRow)),
    h(
      "details",
      { class: "card" },
      h("summary", { text: "다른 AI 키 더 보기 (안 넣어도 됩니다)" }),
      h("p", { class: "muted small", text: "Gemini가 막힐 때의 대체와 웹 검색, 유료 키입니다. 유료 키는 허용하고 매번 승인해야 쓰입니다." }),
      ...free.filter((k) => k.name !== "GEMINI_API_KEY").map(keyRow),
      ...extraFree.map(keyRow),
      ...optional.map(keyRow),
      ...paid.map(keyRow),
      h("div", { class: "row" }, openFile)
    ),
    footer("keys"),
  ];
}

function sectionAccounts() {
  const list = h("div", { class: "stack" });
  const refresh = h("button", { text: "다시 확인" });
  const load = async () => {
    if (!runtime) list.replaceChildren(h("div", { class: "row muted" }, h("span", { class: "spinner" }), "설치·로그인 상태를 확인하는 중…"));
    runtimeStale = false;
    runtime = await api.get("/api/runtime");
    renderRuntime(list);
  };
  refresh.addEventListener("click", () => busy(refresh, load, "확인 중…"));
  if (runtime) renderRuntime(list);
  // Coming back from a login window marks the result stale: re-check quietly in the background.
  if (!runtime || runtimeStale) load().catch((error) => list.replaceChildren(h("p", { class: "notice warn", text: error.message })));
  const github = h("button", { text: "GitHub 로그인" });
  github.addEventListener("click", () =>
    busy(github, async () => {
      const result = await api.post("/api/login", { agent: "github" });
      toast(result.message || "GitHub 로그인 창을 열었습니다.");
    })
  );
  return [
    ...header("accounts", "프로그램 · 로그인", "Claude·Codex 같은 구독형 AI 프로그램을 쓰려면 설치하고 한 번 로그인합니다. 무료 키만 쓸 거라면 건너뛰어도 됩니다."),
    explain("여기 나오는 프로그램은 각각 뭔가요?", [
      "Git: 파일 변경 이력을 관리하는 도구. AI가 코드를 고칠 때 되돌리기용으로 씁니다.",
      "Node.js: Claude·Codex 프로그램을 설치하고 실행하는 데 필요한 기반 프로그램입니다.",
      "Claude (Claude Code): Anthropic의 코딩 AI. Claude Pro/Max 구독 계정으로 로그인해 씁니다.",
      "Codex: OpenAI의 코딩 AI. ChatGPT Plus/Pro 계정으로 로그인해 씁니다.",
      "Cursor · Antigravity: 다른 회사의 AI 코딩 도구. 설치돼 있으면 작업을 맡길 수 있습니다.",
      "로그인 버튼을 누르면 브라우저나 해당 앱이 열립니다. 로그인을 마치고 이 페이지로 돌아오면 상태가 자동으로 새로고침됩니다.",
    ]),
    h("div", { class: "notice", text: "구독형(Claude Pro/Max, ChatGPT Plus)은 월정액이라 호출당 요금이 없지만, 5시간·주간 사용 한도가 있습니다. 한도에 닿으면 앱이 무료 AI로 자동 전환합니다." }),
    h("div", { class: "card" }, h("div", { class: "row space", style: "margin-bottom:8px" }, h("h3", { text: "설치 · 로그인 상태" }), refresh), list),
    h("div", { class: "card row space" }, h("div", {}, h("h3", { text: "GitHub" }), h("p", { class: "muted small", text: "PR 요약, 코드 저장 같은 기능에 씁니다. 브라우저에서 로그인합니다." })), github),
    footer("accounts"),
  ];
}

function loginBadge(signIn) {
  if (!signIn) return null;
  if (signIn.loggedIn === true) return h("span", { class: "badge ok", text: "✓ 로그인됨" });
  if (signIn.loggedIn === false) return h("span", { class: "badge warn", text: "로그인 필요" });
  return h("span", { class: "badge", text: "로그인 확인 불가" });
}

function renderRuntime(list) {
  if (!runtime) return;
  const rows = runtime.components.map((component) => {
    const actions = [];
    if (!component.ready && component.canAutoInstall) {
      const install = h("button", { class: "primary", text: "설치" });
      install.addEventListener("click", () =>
        busy(install, async () => {
          const results = await api.post("/api/install", { target: component.id });
          for (const result of results) toast(result.message, result.ok ? "ok" : "bad");
          runtime = await api.get("/api/runtime");
          renderRuntime(list);
        }, "설치 중… (몇 분)")
      );
      actions.push(install);
    }
    const signIn = (runtime.logins || []).find((item) => item.id === component.id);
    if (component.ready && LOGIN_AGENTS[component.id]) {
      const login = h("button", {
        class: signIn && signIn.loggedIn === false ? "primary" : "",
        text: signIn && signIn.loggedIn ? "다시 로그인" : LOGIN_AGENTS[component.id],
      });
      login.addEventListener("click", () =>
        busy(login, async () => {
          const result = await api.post("/api/login", { agent: component.id });
          toast(result.message || "로그인 창을 열었습니다. 끝나면 이 페이지로 돌아오세요.");
        })
      );
      actions.push(login);
    }
    return h(
      "div",
      { class: "key-row row space" },
      h("div", { style: "min-width:0;flex:1" }, h("div", { class: "row" }, h("h4", { text: component.label }), h("span", { class: `badge ${component.ready ? "ok" : "warn"}`, text: component.ready ? "설치됨" : "없음" }), component.ready ? loginBadge(signIn) : null), signIn && component.ready ? h("p", { class: "small", text: signIn.account ? `${signIn.detail} (${signIn.account})` : signIn.detail }) : null, h("p", { class: "muted small mono", style: "word-break:break-all", text: component.detail })),
      h("div", { class: "row" }, ...actions)
    );
  });
  const manual = runtime.platform !== "windows" && runtime.components.some((c) => !c.ready && !c.canAutoInstall)
    ? h("p", { class: "muted small", text: "macOS에서는 Claude/Codex를 터미널로 설치합니다: npm install -g @anthropic-ai/claude-code  ·  npm install -g @openai/codex (Node.js 필요: nodejs.org)" })
    : null;
  // replaceChildren turns a null argument into the text "null", so drop it here.
  list.replaceChildren(...[h("p", { class: "small", text: runtime.message }), ...rows, manual].filter(Boolean));
}

function sectionBehavior() {
  const p = state.preferences || {};
  const paid = Boolean(p.allowPaidOpenAiApi);
  const agent = h("select", { id: "defaultAgent" }, ...["claude", "codex", "cursor", "antigravity"].map((value) => {
    const option = h("option", { value, text: { claude: "Claude", codex: "Codex", cursor: "Cursor", antigravity: "Antigravity" }[value] });
    option.selected = p.defaultAgent === value;
    return option;
  }));
  const save = async () => {
    state.preferences = await api.post("/api/preferences", {
      defaultAgent: readField("defaultAgent"),
      cradleEnabled: readField("cradleEnabled"),
      autoWebSearch: readField("autoWebSearch"),
      geminiApiEnabled: readField("geminiApiEnabled"),
      allowPaidOpenAiApi: readField("allowPaidOpenAiApi"),
      warnSensitiveFiles: readField("warnSensitiveFiles"),
      closeWebAccountAfterHandoff: readField("closeWebAccountAfterHandoff"),
      closeWebAccountWhenCradleDone: readField("closeWebAccountWhenCradleDone"),
      timeoutSeconds: Math.min(3600, Math.max(10, Math.round(readField("timeoutSeconds") || 180))),
    });
    await refreshState();
  };
  return [
    ...header("behavior", "동작 방식", "질문을 어떤 AI가 어떻게 처리할지 정합니다. 잘 모르겠으면 기본값 그대로 두세요."),
    workOrder(),
    explain("질문하면 앱 안에서 무슨 일이 일어나나요?", [
      "1) 앱이 질문을 보고 일반 대화인지, 조사가 필요한지, 파일을 고쳐야 하는지 판단합니다.",
      "2) 최신 정보가 필요하면 Jina로 웹을 검색해 결과를 함께 넘깁니다 (웹 검색이 켜져 있고 키가 있을 때).",
      "3) 대화는 ChatGPT(Codex)가 먼저 답합니다. 정보 조사는 무료 Gemini가 먼저 해서 구독 한도를 아끼고, 막히면 채팅에 알린 뒤 다음 AI로 넘어갑니다.",
      "4) 파일 작업은 Claude가 계획하고 고칩니다. Cursor도 파일을 고칠 수 있습니다. 플러그인·스킬·MCP는 Claude에 붙습니다. 구독 한도가 차면 채팅에 알리고 무료 AI가 이어받습니다.",
      "5) 유료 API는 '유료 허용'이 켜져 있고, 그 호출을 사용자가 승인하고, 하루 한도 안일 때만 씁니다.",
    ]),
    h(
      "div",
      { class: "card" },
      toggle("cradleEnabled", "무료 자동 모드 (CRADLE)", "질문에 맞는 무료 AI를 자동으로 골라 처리합니다. 처음엔 켜 두는 것을 추천합니다.", p.cradleEnabled),
      toggle("geminiApiEnabled", "Gemini 무료 키 사용", "조사·검토·계획처럼 정확한 정보가 필요한 일을 무료 Gemini가 먼저 처리합니다.", p.geminiApiEnabled),
      toggle("autoWebSearch", "필요하면 웹 검색", "최신 정보가 필요한 질문은 웹을 찾아본 뒤 답합니다. Jina 키가 있어야 동작합니다.", p.autoWebSearch),
      toggle("warnSensitiveFiles", "민감한 파일 경고", ".env·키 파일 같은 비밀 파일을 AI에게 보내기 전에 알려 줍니다.", p.warnSensitiveFiles),
      toggle("allowPaidOpenAiApi", "유료 OpenAI API 허용", "켜도 호출마다 승인을 받습니다. 요금이 나가므로 필요할 때만 켜세요.", paid, { danger: true })
    ),
    h(
      "details",
      { class: "card" },
      h("summary", { text: "더 보기 (구독형 프로그램 · 웹 계정)" }),
      h("div", { class: "field" }, h("div", {}, h("strong", { text: "기본 구독형 프로그램" }), h("span", { class: "desc", text: "코드 작업처럼 무거운 일을 맡길 프로그램" })), agent),
      numberField("timeoutSeconds", "한 번에 기다릴 최대 시간(초)", "너무 오래 걸리면 중단합니다. 10~3600", p.timeoutSeconds || 180, 10, 3600),
      toggle("closeWebAccountAfterHandoff", "웹 계정 창 자동 닫기", "웹 계정에서 답을 받아 오면 창을 닫습니다.", p.closeWebAccountAfterHandoff),
      toggle("closeWebAccountWhenCradleDone", "작업이 끝나면 웹 계정 창 닫기", "자동 작업이 끝났을 때 열린 창을 정리합니다.", p.closeWebAccountWhenCradleDone)
    ),
    footer("behavior", save),
  ];
}

function sectionAlerts() {
  const a = state.alerts || {};
  const save = async () => {
    state.alerts = await api.post("/api/alerts", {
      desktop: readField("desktop"),
      dailyCostLimitUsd: Math.min(10000, numberOr(readField("dailyCostLimitUsd"), a.dailyCostLimitUsd ?? 1)),
      dailyCallWarn: Math.round(numberOr(readField("dailyCallWarn"), a.dailyCallWarn ?? 300)),
      blockPaidOverLimit: readField("blockPaidOverLimit"),
    });
  };
  return [
    ...header("alerts", "알림 · 비용 한도", "유료 API에 하루 얼마까지 쓸지 직접 정합니다. 0달러로 두면 유료 API를 아예 쓰지 않습니다."),
    h(
      "div",
      { class: "card" },
      toggle("desktop", "데스크톱 알림", "자리를 비운 사이 답변이 끝나거나 예약 작업이 실패하면 알려 줍니다.", a.desktop),
      numberField("dailyCostLimitUsd", "하루 유료 한도 (달러)", "0 = 유료 API를 아예 쓰지 않음. 금액을 넣으면 하루에 그 금액까지만 씁니다. 무제한은 없습니다.", a.dailyCostLimitUsd ?? 1, 0, 10000, 0.5),
      toggle("blockPaidOverLimit", "한도에 닿으면 유료 호출 막기", "켜 두면 한도를 넘은 날은 유료 API를 쓰지 않고 무료 AI만 씁니다. 끄면 알림만 보내고 계속 씁니다. (한도가 0이면 이 스위치와 상관없이 유료를 쓰지 않습니다)", a.blockPaidOverLimit ?? true),
      numberField("dailyCallWarn", "하루 호출 경고 횟수", "이만큼 호출하면 알려 줍니다. 0이면 끔.", a.dailyCallWarn ?? 300, 0, 100000)
    ),
    footer("alerts", save),
  ];
}

function signProgress() {
  try {
    return JSON.parse(localStorage.getItem("aic-sign-steps") || "{}");
  } catch {
    return {};
  }
}

function sectionUpdates() {
  const u = state.updates || {};
  const build = state.build || {};
  const signed = build.signed && build.updaterReady;
  const done = signProgress();
  const statusNotice = signed
    ? h("div", { class: "notice ok", text: `자동 업데이트 켜짐 · v${build.version} — 서명된 새 버전을 자동으로 받습니다.` })
    : build.sourceRun
      ? h("div", { class: "notice", text: `소스(개발) 실행 중 · v${build.version} — 이 실행은 git으로 업데이트됩니다. 아래 서명 설정은 배포용 설치본을 위한 것입니다.` })
      : h("div", { class: "notice", text: `v${build.version} — 이 설치본은 앱 자체 자동 업데이트가 아직 준비되지 않았습니다. 새 버전은 GitHub의 Releases에서 설치 파일을 받으면 됩니다. AI 프로그램·플러그인·모델 업데이트는 아래 스위치대로 동작합니다.` });

  const steps = h(
    "ol",
    { class: "steps" },
    ...SIGN_STEPS.map((step) => {
      const item = h("li", { class: done[step.id] ? "done" : "" });
      const actions = h("div", { class: "row" });
      if (step.url) {
        const open = h("button", { class: "primary", text: step.name ? "열기 + 이름 복사" : "열기" });
        open.addEventListener("click", async () => {
          if (step.name) {
            const ok = await copy(step.name);
            toast(ok ? `'${step.name}' 복사됨 — Name 칸에 붙여넣으세요.` : `복사 실패: ${step.name}`, ok ? "ok" : "bad");
          }
          window.open(step.url, "_blank", "noopener");
        });
        actions.append(open);
      }
      if (step.name) {
        actions.append(h("button", { text: "이름만 복사", onclick: async () => toast((await copy(step.name)) ? `'${step.name}' 복사됨` : "복사 실패") }));
      }
      const mark = h("button", { text: done[step.id] ? "다시 하기" : "완료" });
      mark.addEventListener("click", () => {
        const next = signProgress();
        if (next[step.id]) delete next[step.id];
        else next[step.id] = true;
        localStorage.setItem("aic-sign-steps", JSON.stringify(next));
        render();
      });
      actions.append(mark);
      item.append(h("h4", { text: step.title }), step.name ? h("p", { class: "small" }, "이름: ", h("code", { text: step.name })) : null, h("ol", {}, ...step.lines.map((line) => h("li", { text: line }))), actions);
      return item;
    })
  );

  const save = async () => {
    state.updates = await api.post("/api/updates", {
      app: readField("upd-app"),
      clis: readField("upd-clis"),
      plugins: readField("upd-plugins"),
      models: readField("upd-models"),
      intervalHours: Math.min(168, Math.max(1, Math.round(Number(readField("upd-interval")) || 6))),
    });
  };

  return [
    ...header("updates", "자동 업데이트", "앱과 AI 프로그램을 알아서 최신으로 유지합니다. 문제가 생기면 이전 버전으로 되돌립니다. 기본값 그대로 두면 됩니다."),
    statusNotice,
    h(
      "div",
      { class: "card" },
      h("h3", { text: "무엇을 자동으로 업데이트할까요?" }),
      toggle("upd-app", "앱", "서명된 GitHub 릴리스만 설치합니다. 적용은 '지금 재시작'을 눌렀을 때.", u.app),
      toggle("upd-clis", "AI 프로그램 (Claude · Codex · Gemini · Cursor)", "설치된 것만 업데이트하고, 실패하면 되돌립니다.", u.clis),
      toggle("upd-plugins", "Claude 플러그인 · 스킬", "설치된 플러그인을 최신으로 유지합니다.", u.plugins),
      toggle("upd-models", "무료 모델 목록", "새로 나온 무료 모델을 하루 한 번 반영합니다.", u.models),
      numberField("upd-interval", "확인 간격 (시간)", "1~168", u.intervalHours || 6, 1, 168)
    ),
    h(
      "details",
      { class: "card" },
      h("summary", {}, h("strong", { text: "🛠 개발자용: 앱 서명 설정 — 일반 사용자는 열지 않아도 됩니다" })),
      h("p", { class: "muted small", text: "서명 키를 이미 받았다면 아래 순서대로 GitHub에 등록하세요. 개인키(.key)는 비밀번호처럼 다루고, 이 페이지나 채팅에는 절대 붙여넣지 마세요. 공개키(.key.pub)는 남이 봐도 됩니다." }),
      steps,
      h("p", { class: "muted small", text: "다음 버전부터는 package.json과 src-tauri/tauri.conf.json의 version 숫자를 올리고 '서명된 설치본 만들기'만 다시 하면 됩니다." })
    ),
    footer("updates", save),
  ];
}

function download(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = h("a", { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function sectionFinish() {
  const s = summary();
  const items = [
    [s.folder, "작업 폴더", "folder"],
    [s.freeKey, "무료 AI 키", "keys"],
    [s.handsFree, "무료 자동 모드 준비", "behavior"],
    [s.claude, "Claude 프로그램 (선택)", "accounts"],
    [s.signed || s.sourceRun, "앱 자동 업데이트 (선택)", "updates"],
  ];
  const exportButton = h("button", { class: "primary", text: "설정 백업 파일 받기" });
  exportButton.addEventListener("click", () =>
    busy(exportButton, async () => {
      const data = await api.get("/api/export");
      data.exportedAt = new Date().toISOString();
      download(`ai-character-settings-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 2));
      toast("백업 파일을 내려받았습니다. API 키는 포함되지 않습니다.", "ok");
    })
  );
  const file = h("input", { type: "file", accept: "application/json,.json", style: "display:none" });
  const importButton = h("button", { text: "백업 불러오기", onclick: () => file.click() });
  file.addEventListener("change", () =>
    busy(importButton, async () => {
      const chosen = file.files && file.files[0];
      file.value = "";
      if (!chosen) return;
      const data = JSON.parse(await chosen.text());
      const result = await api.post("/api/import", data);
      toast(`불러옴: ${result.applied.join(", ") || "변경 없음"}`, "ok");
      if (result.warning) toast(result.warning, "bad");
      await refreshState();
      render();
    }, "불러오는 중…")
  );
  const completed = state.setup && state.setup.completed;
  return [
    ...header("finish", completed ? "설정 완료 ✓" : "마무리 · 백업", "남은 항목을 확인하고 설정을 파일로 백업해 두세요. 새 컴퓨터에서도 같은 설정을 바로 불러올 수 있습니다."),
    completed ? h("div", { class: "notice ok", text: "처음 설정을 마쳤습니다. 이 창은 닫아도 됩니다. 나중에 트레이 메뉴의 '처음 설정 (웹)'이나 앱 설정에서 다시 열 수 있습니다." }) : null,
    h(
      "div",
      { class: "card" },
      h("h3", { text: "점검" }),
      ...items.map(([ok, label, target]) =>
        h("div", { class: "key-row row space" }, h("div", { class: "row" }, h("span", { class: `badge ${ok ? "ok" : "warn"}`, text: ok ? "완료" : "남음" }), label), ok ? null : h("button", { class: "link", text: "설정하러 가기 →", onclick: () => go(target) }))
      )
    ),
    h(
      "div",
      { class: "card" },
      h("h3", { text: "설정 백업" }),
      h("p", { class: "muted small", text: "동작 방식 · 알림 · 업데이트 · 작업 폴더를 JSON 파일로 저장합니다. API 키 같은 비밀 값은 넣지 않습니다." }),
      h("div", { class: "row", style: "margin-top:10px" }, exportButton, importButton, file)
    ),
    resetSettingsCard(),
    footer("finish"),
  ];
}

// ---------- local (installed) AI ----------

const localView = { data: null, loading: false, error: "", timer: null };
const VERDICTS = {
  good: ["ok", "잘 돌아감"],
  slow: ["warn", "느릴 수 있음"],
  no_ram: ["bad", "메모리 부족"],
  no_disk: ["bad", "저장공간 부족"],
  unknown: ["", "확인 불가"],
};

function localJobs() {
  return (localView.data && localView.data.jobs) || {};
}

function localBusy() {
  return Object.values(localJobs()).some((job) => !job.done);
}

async function loadLocal() {
  if (localView.loading) return;
  localView.loading = true;
  try {
    localView.data = await api.get("/api/local");
    localView.error = "";
  } catch (error) {
    localView.error = error.message || String(error);
  }
  localView.loading = false;
  if (current === "local" && !dirty.has("local")) render();
}

function scheduleLocal() {
  clearTimeout(localView.timer);
  localView.timer = setTimeout(async () => {
    localView.timer = null;
    if (current !== "local") return;
    if (!document.hidden) await loadLocal();
    scheduleLocal();
  }, localBusy() ? 1500 : 15000);
}

function gbText(value) {
  return value === null || value === undefined ? "알 수 없음" : `${Number(value).toFixed(value < 10 ? 1 : 0)}GB`;
}

function jobStatus(status) {
  if (!status) return "진행 중";
  if (status === "pulling manifest") return "목록 확인 중";
  if (status.startsWith("pulling")) return "받는 중";
  if (status.startsWith("verifying")) return "검사 중";
  if (status === "writing manifest" || status === "success") return "마무리 중";
  return status;
}

function jobBar(job, label) {
  if (!job) return null;
  if (job.error) return h("p", { class: "notice bad", text: `${label} 실패: ${job.error}` });
  if (job.done) return h("p", { class: "notice ok", text: `${label}: ${job.status || "완료"}` });
  const pct = job.total ? (job.completed / job.total) * 100 : 0;
  const text = job.total ? `${Math.round(pct)}% · ${gbText(job.completed / 1073741824)} / ${gbText(job.total / 1073741824)}` : jobStatus(job.status);
  return meterBar(`${label} — ${jobStatus(job.status)}`, text, pct);
}

async function localAction(button, path, body, message) {
  await busy(button, async () => {
    const result = await api.post(path, body);
    toast(result.message || message, "ok");
    dirty.delete("local");
    await loadLocal();
    scheduleLocal();
  }, "처리 중…");
}

function shortCpu(name) {
  return String(name).replace(/\((R|TM)\)/gi, "").replace(/\s*CPU\s*@.*$/i, "").replace(/\s+\d+-Core Processor$/i, "").replace(/\s+/g, " ").trim();
}

function systemCard(data) {
  const sys = data.system || {};
  const accel = sys.appleSilicon
    ? "Apple 칩"
    : sys.nvidiaGpu
      ? `NVIDIA${sys.vramGb ? ` ${gbText(sys.vramGb)}` : ""}`
      : sys.os === "macos"
        ? "없음 (Intel Mac)"
        : "없음 (CPU만)";
  const usable = (data.catalog || []).filter((m) => m.verdict === "good" || m.verdict === "slow");
  const best = (data.catalog || []).filter((m) => m.verdict === "good").sort((a, b) => b.sizeGb - a.sizeGb)[0];
  const verdict = best
    ? `이 컴퓨터는 ${best.label} 정도까지 무리 없이 돌릴 수 있습니다.`
    : usable.length
      ? "작은 모델은 돌아가지만 느릴 수 있습니다. 인터넷 무료 AI를 주로 쓰고, 설치형은 예비로만 쓰는 걸 추천합니다."
      : "이 컴퓨터 사양으로는 설치형 AI를 권하지 않습니다. 인터넷 무료 AI만으로도 충분합니다.";
  return h(
    "div",
    { class: "card" },
    h("h3", { text: "1. 이 컴퓨터 사양 확인" }),
    h("p", { class: "muted small", text: "지금 이 앱이 실행 중인 컴퓨터를 직접 검사한 결과입니다. 다른 컴퓨터(Windows·Mac·Linux)에 앱을 설치해 이 화면을 열면 그 컴퓨터 기준으로 다시 검사하고 판정합니다." }),
    h(
      "div",
      { class: "stats" },
      stat("칩", sys.cpu ? shortCpu(sys.cpu) : sys.arch || "알 수 없음", `${sys.os || ""} · ${sys.arch || ""}`),
      stat("메모리", gbText(sys.ramGb), "모델 크기를 좌우"),
      stat("남은 저장공간", gbText(sys.freeDiskGb), sys.modelsDir ? `모델 저장 위치: ${sys.modelsDir}` : "모델 파일이 들어갈 곳"),
      stat("그래픽 가속", accel, sys.gpus && sys.gpus.length ? sys.gpus.join(", ") : sys.appleSilicon ? "메모리를 그래픽과 함께 씀" : "")
    ),
    h("p", { class: `notice ${best ? "ok" : usable.length ? "warn" : "bad"}`, text: verdict })
  );
}

function diskCard(data) {
  const disks = data.disks || [];
  if (!disks.length) return null;
  const current = data.modelsDir || "";
  return h(
    "div",
    { class: "card stack" },
    h("h3", { text: "2. 모델 저장 위치 고르기 (내장 디스크 · 외장하드)" }),
    h("p", { class: "muted small", text: "모델 파일은 크기가 커서(2~20GB) 내장 디스크가 부족하면 외장하드에 두는 게 좋습니다. 연결된 디스크를 모두 보여 드려요. 판정과 '받기'는 여기서 고른 디스크의 남은 공간을 기준으로 합니다." }),
    data.modelsDirMissing ? h("p", { class: "notice bad", text: "저장 위치로 고른 외장하드가 지금 연결되어 있지 않습니다. 외장하드를 연결하거나 아래에서 다른 디스크를 고르세요. 연결되기 전까지는 설치형 AI가 모델을 찾지 못합니다." }) : null,
    ...disks.map((disk) => {
      const selected = disk.modelsDir === current;
      const pct = disk.totalGb ? ((disk.totalGb - disk.freeGb) / disk.totalGb) * 100 : 0;
      return h(
        "div",
        { class: "key-row stack" },
        h(
          "div",
          { class: "row space" },
          h("div", { class: "row" }, h("h4", { text: `${disk.external ? "💽" : "🖥️"} ${disk.label}` }), disk.external ? h("span", { class: "badge", text: "외장/추가 디스크" }) : h("span", { class: "badge", text: "기본" }), selected ? h("span", { class: "badge ok", text: "지금 저장 위치" }) : null),
          selected
            ? null
            : confirmButton("여기에 저장", "한 번 더 누르면 바꿈", (button) => localAction(button, "/api/local/disk", { dir: disk.modelsDir }, "저장 위치를 바꿨습니다."), "primary")
        ),
        meterBar("사용 중", `${gbText(disk.freeGb)} 남음 / 전체 ${gbText(disk.totalGb)}`, pct),
        h("p", { class: "muted small mono", text: disk.modelsDir ? `저장 폴더: ${disk.modelsDir}` : "저장 폴더: Ollama 기본 폴더 (홈 폴더/.ollama/models)" })
      );
    }),
    explain("외장하드에 저장할 때 알아 둘 점", [
      "외장하드를 빼면 그동안은 설치형 AI를 쓸 수 없습니다 (인터넷 무료 AI는 그대로 쓸 수 있어요). 다시 꽂으면 바로 돌아옵니다.",
      "저장 위치를 바꾸면 Ollama를 자동으로 다시 켭니다. 이미 받은 모델은 이전 위치에 남아 있으니, 새 위치에서 다시 받거나 이전 위치로 되돌리면 됩니다.",
      "USB 메모리나 느린 외장하드는 처음 모델을 불러올 때 몇십 초 걸릴 수 있습니다. 한 번 불러오면 속도는 같습니다.",
      "외장하드가 '읽기 전용'(NTFS 디스크를 Mac에 연결한 경우 등)이면 저장할 수 없다고 알려 드립니다.",
    ])
  );
}

function ollamaSection(data) {
  const ollama = data.ollama || {};
  const job = localJobs()["ollama-install"];
  const installing = job && !job.done;
  let badge;
  let actions = [];
  if (ollama.running) {
    badge = h("span", { class: "badge ok", text: `실행 중${ollama.version ? ` · v${ollama.version}` : ""}` });
  } else if (ollama.installed) {
    badge = h("span", { class: "badge warn", text: "설치됨 · 꺼져 있음" });
    const start = h("button", { class: "primary", text: "Ollama 켜기" });
    start.addEventListener("click", () => localAction(start, "/api/local/start", {}, "Ollama를 켜는 중입니다."));
    actions = [start];
  } else if (ollama.installCommand) {
    badge = h("span", { class: "badge", text: "설치 안 됨" });
    actions = [h("code", { text: ollama.installCommand }), h("button", { class: "link", text: "복사", onclick: () => copy(ollama.installCommand).then(() => toast("복사했습니다. 터미널에 붙여넣어 실행하세요.", "ok")) })];
  } else {
    badge = h("span", { class: "badge", text: "설치 안 됨" });
    if (!installing) {
      actions = [
        confirmButton("Ollama 설치 (무료)", "한 번 더 누르면 설치 시작", (button) => localAction(button, "/api/local/install", {}, "Ollama 설치를 시작했습니다."), "primary"),
        h("a", { href: "https://ollama.com/download", target: "_blank", rel: "noopener noreferrer", class: "small", text: "직접 받기 ↗" }),
      ];
    }
  }
  return h(
    "div",
    { class: "card stack" },
    h("div", { class: "row space" }, h("h3", { text: "3. Ollama 설치 (설치형 AI 실행 프로그램)" }), badge),
    h("p", { class: "muted small", text: "Ollama는 AI 모델을 이 컴퓨터에서 돌려 주는 무료 프로그램입니다. 설치 후에는 인터넷 AI가 모두 막혔을 때 마지막으로 여기서 답합니다. 대화 내용이 컴퓨터 밖으로 나가지 않습니다." }),
    !ollama.installed && ollama.installMethod ? h("p", { class: "small", text: `이 컴퓨터에서는: ${ollama.installMethod}` }) : null,
    actions.length ? h("div", { class: "row" }, ...actions) : null,
    jobBar(job, "Ollama 설치")
  );
}

function modelRow(model, data) {
  const [tone, verdictText] = VERDICTS[model.verdict] || VERDICTS.unknown;
  const job = localJobs()[model.id];
  const pulling = job && !job.done;
  const running = data.ollama && data.ollama.running;
  const inUse = data.preferred === model.id;
  const actions = [];
  if (model.installed) {
    if (inUse) actions.push(h("span", { class: "badge ok", text: "우선 사용 중" }));
    else {
      const use = h("button", { text: "이 모델 먼저 쓰기" });
      use.addEventListener("click", () => localAction(use, "/api/local/prefer", { model: model.id }, `${model.label}을 먼저 씁니다.`));
      actions.push(use);
    }
    actions.push(confirmButton("삭제", "한 번 더 누르면 삭제", (button) => localAction(button, "/api/local/delete", { model: model.id }, `${model.label}을 지웠습니다.`)));
  } else if (!pulling) {
    if (model.verdict === "no_ram" || model.verdict === "no_disk") {
      actions.push(h("button", { disabled: true, text: "이 컴퓨터에선 불가" }));
    } else if (!running) {
      actions.push(h("button", { disabled: true, text: data.ollama && data.ollama.installed ? "Ollama를 먼저 켜세요" : "Ollama를 먼저 설치하세요" }));
    } else {
      actions.push(confirmButton(`받기 (${gbText(model.sizeGb)})`, `한 번 더 누르면 ${gbText(model.sizeGb)} 다운로드`, (button) => localAction(button, "/api/local/pull", { model: model.id }, `${model.label} 다운로드를 시작했습니다.`), "primary"));
    }
  }
  return h(
    "div",
    { class: "key-row stack" },
    h(
      "div",
      { class: "row space" },
      h(
        "div",
        { class: "row" },
        h("h4", { text: model.label }),
        h("span", { class: "muted small", text: model.maker }),
        model.recommended ? h("span", { class: "badge free", text: "추천" }) : null,
        model.installed ? h("span", { class: "badge ok", text: "설치됨" }) : null
      ),
      h("span", { class: `badge ${tone}`, text: verdictText })
    ),
    h("p", { class: "muted small", text: `${model.note} · 파일 ${gbText(model.sizeGb)} · 메모리 최소 ${model.minRamGb}GB / 권장 ${model.recRamGb}GB` }),
    h("p", { class: "small", text: model.reason }),
    actions.length ? h("div", { class: "row" }, ...actions) : null,
    jobBar(job, "다운로드")
  );
}

function otherInstalled(data) {
  const known = new Set((data.catalog || []).map((m) => m.id));
  const others = ((data.ollama && data.ollama.models) || []).filter((m) => !known.has(m.name) && !known.has(m.name.replace(/:latest$/, "")));
  if (!others.length) return null;
  return h(
    "div",
    { class: "stack" },
    h("h4", { text: "그 밖에 설치된 모델" }),
    ...others.map((m) => {
      const use = data.preferred === m.name ? h("span", { class: "badge ok", text: "우선 사용 중" }) : h("button", { text: "이 모델 먼저 쓰기", onclick: (event) => localAction(event.currentTarget, "/api/local/prefer", { model: m.name }, `${m.name}을 먼저 씁니다.`) });
      return h(
        "div",
        { class: "row space" },
        h("span", {}, h("code", { text: m.name }), " ", h("span", { class: "muted small", text: gbText(m.sizeGb) })),
        h("div", { class: "row" }, use, confirmButton("삭제", "한 번 더 누르면 삭제", (button) => localAction(button, "/api/local/delete", { model: m.name }, `${m.name}을 지웠습니다.`)))
      );
    })
  );
}

function lmStudioCard(data) {
  const lm = data.lmstudio || {};
  return h(
    "details",
    { class: "card" },
    h("summary", { text: `LM Studio (다른 설치형 프로그램) — ${lm.running ? "서버 켜짐" : lm.installed ? "설치됨 · 서버 꺼짐" : "설치 안 됨"}` }),
    h("p", { class: "muted small", text: "화면에서 모델을 골라 받는 프로그램을 선호하면 LM Studio도 됩니다. LM Studio에서 'Developer → Start Server'를 켜 두면 Ollama 다음 순서로 자동으로 씁니다." }),
    lm.running && lm.models && lm.models.length ? h("p", { class: "small", text: `불러온 모델: ${lm.models.join(", ")}` }) : null,
    h("p", { class: "small" }, h("a", { href: "https://lmstudio.ai/download", target: "_blank", rel: "noopener noreferrer", text: "lmstudio.ai 에서 받기 ↗" }))
  );
}

function sectionLocal() {
  if (!localView.data && !localView.loading && !localView.error) setTimeout(loadLocal, 0);
  if (!localView.timer) scheduleLocal();
  const head = [
    h("div", { class: "eyebrow", text: "설치형" }),
    h("h2", { text: "내 컴퓨터 AI (설치형)" }),
    h("p", { class: "lead", text: "인터넷 없이 이 컴퓨터 안에서 돌아가는 AI입니다. 먼저 사양을 확인해 어떤 모델이 돌아갈지 알려 드리고, 설치는 버튼을 두 번 눌러 확인한 뒤에만 시작합니다." }),
  ];
  const data = localView.data;
  if (localView.error && !data) return [...head, h("p", { class: "notice bad", text: localView.error })];
  if (!data) return [...head, h("div", { class: "row muted" }, h("span", { class: "spinner" }), "이 컴퓨터 사양을 확인하는 중…")];
  const hasModel = ((data.ollama && data.ollama.models) || []).length > 0;
  return [
    ...head,
    localView.error ? h("p", { class: "notice bad", text: localView.error }) : null,
    guide(
      "🔰 처음이라면 이 순서대로 하세요 (약 10분)",
      [
        ["사양 확인 결과 보기", "아래 '1. 이 컴퓨터 사양 확인'의 초록/노란/빨간 안내를 읽어 보세요. 빨간색이면 설치형 대신 인터넷 무료 AI만 써도 충분합니다."],
        ["저장 위치 고르기", "'2. 모델 저장 위치'에서 남은 공간이 넉넉한 디스크를 고르세요. 내장 디스크에 20GB 이상 남아 있으면 그대로 둬도 됩니다."],
        ["Ollama 설치", "'3. Ollama 설치'의 파란 버튼을 두 번 누르세요. 한 번 누르면 확인 문구로 바뀌고, 한 번 더 눌러야 시작합니다. 몇 분 걸리고 끝나면 '실행 중'으로 바뀝니다."],
        ["모델 하나 받기", "'4. 모델 받기'에서 '추천'이 붙은 모델의 '받기'를 두 번 누르세요. 진행 막대가 100%가 되면 끝입니다. 하나만 받아도 충분합니다."],
        ["끝! 그냥 대화하면 됩니다", "따로 켤 필요 없습니다. 인터넷 AI가 모두 막혔을 때 앱이 알아서 이 컴퓨터의 AI로 답합니다."],
      ],
      { open: !hasModel, tip: "버튼을 잘못 눌러도 괜찮아요. 모든 설치·다운로드는 두 번 눌러야 시작하고, 받은 모델은 '삭제'로 언제든 지울 수 있습니다." }
    ),
    systemCard(data),
    diskCard(data),
    ollamaSection(data),
    h(
      "div",
      { class: "card stack" },
      h("h3", { text: "4. 모델 받기 (한국·중국 모델)" }),
      h("p", { class: "muted small", text: "판정은 이 컴퓨터의 메모리·저장공간·그래픽 가속을 기준으로 합니다. '추천'이 붙은 모델부터 하나만 받아도 충분합니다. 여러 개를 받으면 '먼저 쓰기'로 고른 모델을 우선 씁니다." }),
      ...(data.catalog || []).map((model) => modelRow(model, data)),
      otherInstalled(data)
    ),
    lmStudioCard(data),
    glossary(LOCAL_WORDS),
    faq("자주 묻는 질문", [
      ["설치형 AI는 언제 쓰이나요?", `대화는 Gemini → OpenRouter → ${FREE_ORDER_TEXT} 순서로 시도합니다. 설치형은 맨 마지막 예비라서, 인터넷 AI가 한도에 걸렸거나 인터넷이 끊겼을 때 답합니다.`],
      ["돈이 드나요?", "전혀 들지 않습니다. 모델과 Ollama 모두 무료이고, 사용 횟수 한도도 없습니다. 전기만 조금 더 씁니다."],
      ["인터넷 AI와 뭐가 다른가요?", "대화 내용이 컴퓨터 밖으로 나가지 않아 개인정보에 안전하고 한도가 없습니다. 대신 인터넷 AI보다 느리고 덜 똑똑합니다."],
      ["'느릴 수 있음'은 얼마나 느린가요?", "한 문장이 나오는 데 몇 초~몇십 초 걸릴 수 있습니다. 답답하면 더 작은 모델(2.4B, 4B)을 받거나 인터넷 무료 AI를 주로 쓰세요."],
      ["받는 중에 창을 닫아도 되나요?", "네. 이 페이지를 닫아도 앱이 계속 받습니다. 다시 열면 진행 막대가 보입니다. 단, AI Character 앱 자체를 끄면 멈춥니다."],
      ["컴퓨터가 버벅거려요.", "모델이 메모리를 많이 쓰고 있어서입니다. 더 작은 모델로 바꾸거나, 큰 모델은 '삭제'하세요. 설치형 AI는 쓰지 않을 때 몇 분 뒤 자동으로 메모리에서 내려갑니다."],
      ["다른 컴퓨터의 AI를 쓰고 싶어요.", "왼쪽 메뉴의 '🌐 다른 컴퓨터 AI (원격)'에서 성능 좋은 다른 컴퓨터를 연결해 쓸 수 있습니다."],
    ]),
    h("div", { class: "row" }, h("button", { class: "link", text: localView.loading ? "확인 중…" : "다시 확인", disabled: localView.loading, onclick: loadLocal })),
  ];
}

// ---------- remote (other computers) ----------

const remoteView = { data: null, loading: false, error: "", timer: null };

async function loadRemote() {
  if (remoteView.loading) return;
  remoteView.loading = true;
  try {
    const [remote, local] = await Promise.all([api.get("/api/remote"), api.get("/api/local")]);
    remoteView.data = remote;
    localView.data = local;
    remoteView.error = "";
  } catch (error) {
    remoteView.error = error.message || String(error);
  }
  remoteView.loading = false;
  if (current === "remote" && !dirty.has("remote")) render();
}

function scheduleRemote() {
  clearTimeout(remoteView.timer);
  const busyJobs = Object.values((remoteView.data && remoteView.data.jobs) || {}).some((job) => !job.done);
  remoteView.timer = setTimeout(async () => {
    remoteView.timer = null;
    if (current !== "remote") return;
    if (!document.hidden) await loadRemote();
    scheduleRemote();
  }, busyJobs ? 1500 : 20000);
}

async function remoteAction(button, path, body, message) {
  await busy(button, async () => {
    const result = await api.post(path, body);
    toast(result.message || message, "ok");
    // The action changed what the cards show; redraw even if a field was half-typed.
    dirty.delete("remote");
    await loadRemote();
    scheduleRemote();
  }, "처리 중…");
}

const shareView = { code: "", short: "", shortError: "", codeAt: 0, minutes: 10, viaRelay: false };

function codeBox(code) {
  const area = h("textarea", { class: "code-box", readonly: true, rows: 3, spellcheck: "false" });
  area.value = code;
  area.addEventListener("focus", () => area.select());
  return area;
}

function shareCodeBlock() {
  if (!shareView.code) return null;
  const left = Math.max(0, shareView.minutes - Math.floor((Date.now() - shareView.codeAt) / 60000));
  if (left <= 0) {
    shareView.code = "";
    shareView.short = "";
    return null;
  }
  const longCode = [
    codeBox(shareView.code),
    h(
      "div",
      { class: "row" },
      h("button", { text: "긴 코드 복사", onclick: () => copy(shareView.code).then(() => toast("복사했습니다. 메신저·메일로 내 다른 컴퓨터에 보내세요.", "ok")) })
    ),
  ];
  if (shareView.short) {
    return h(
      "div",
      { class: "stack code-panel" },
      h("p", { class: "small", text: `이 컴퓨터를 쓸 다른 컴퓨터의 'B. 다른 컴퓨터 연결하기'에 아래 6자리 숫자를 입력하세요. (약 ${left}분 안에, 한 번만 쓸 수 있습니다)` }),
      h("div", { class: "short-code", text: shareView.short }),
      h("p", { class: "muted small", text: "숫자는 중계 서버에 암호화된 상태로 잠깐 맡겨 두었다가, 한 번 쓰이면 바로 지워집니다. 숫자를 틀리게 여러 번 넣으면 서버가 그 인터넷 주소를 잠시 막습니다." }),
      h("details", { class: "stack" }, h("summary", { text: "숫자 대신 긴 코드로 보내기" }), ...longCode)
    );
  }
  return h(
    "div",
    { class: "stack code-panel" },
    h("p", { class: "small", text: `아래 연결 코드를 통째로 복사해서, 이 컴퓨터를 쓸 다른 컴퓨터의 'B. 다른 컴퓨터 연결하기'에 붙여 넣으세요. (약 ${left}분 안에, 한 번만 쓸 수 있습니다)` }),
    shareView.shortError ? h("p", { class: "notice warn", text: `6자리 코드는 만들지 못했습니다: ${shareView.shortError}` }) : null,
    codeBox(shareView.code),
    h(
      "div",
      { class: "row" },
      h("button", { class: "primary", text: "연결 코드 복사", onclick: () => copy(shareView.code).then(() => toast("복사했습니다. 메신저·메일로 내 다른 컴퓨터에 보내세요.", "ok")) }),
      h("span", { class: "muted small", text: shareView.viaRelay ? "중계 서버가 있어 밖에서도 연결됩니다." : "중계 서버가 없어 같은 공유기(와이파이) 안에서만 연결됩니다." })
    )
  );
}

function pairedRow(peer) {
  const added = peer.added ? new Date(peer.added * 1000).toLocaleDateString("ko-KR") : "";
  return h(
    "div",
    { class: "row space key-row" },
    h("div", { class: "row" }, h("strong", { text: `🖥️ ${peer.name}` }), added ? h("span", { class: "muted small", text: `${added} 연결` }) : null),
    confirmButton("연결 끊기", "한 번 더 누르면 끊음", (button) => remoteAction(button, "/api/share/unpair", { id: peer.id }, "연결을 끊었습니다."))
  );
}

function shareCard(local) {
  const share = (local && local.share) || {};
  const ollama = (local && local.ollama) || {};
  const paired = share.paired || [];
  const body = [];
  if (share.enabled) {
    const makeCode = h("button", { class: "primary", text: shareView.code ? "새 연결 코드 만들기" : "연결 코드 만들기" });
    makeCode.addEventListener("click", () =>
      busy(makeCode, async () => {
        const result = await api.post("/api/share/code", {});
        shareView.code = result.code;
        shareView.short = result.short || "";
        shareView.shortError = result.shortError || "";
        shareView.codeAt = Date.now();
        shareView.minutes = result.minutes || 10;
        shareView.viaRelay = !!result.viaRelay;
        localView.data = { ...(localView.data || {}), share: result.share };
        render();
      }, "만드는 중…")
    );
    body.push(
      h("p", { class: "notice ok", text: `공유 중입니다. 이 컴퓨터 이름: ${share.name || "?"}. 연결 코드로 허락한 컴퓨터만 쓸 수 있습니다.` }),
      !ollama.running ? h("p", { class: "notice warn", text: "Ollama가 꺼져 있어서 지금은 다른 컴퓨터가 AI를 쓸 수 없습니다. '내 컴퓨터 AI'에서 Ollama를 켜 주세요." }) : null,
      h("div", { class: "row" }, makeCode, h("span", { class: "muted small", text: share.relay ? "🌍 밖에서도 연결 가능" : "🏠 같은 공유기 안에서만 (밖에서도 쓰려면 아래 중계 서버 설정)" })),
      shareCodeBlock(),
      h("h4", { text: `이 컴퓨터를 쓰는 컴퓨터 (${paired.length}대)` }),
      paired.length ? h("div", { class: "stack" }, ...paired.map(pairedRow)) : h("p", { class: "muted small", text: "아직 없습니다. 연결 코드를 만들어 다른 컴퓨터에 넣어 주세요." }),
      h("div", { class: "row" }, confirmButton("공유 끄기", "한 번 더 누르면 공유 끔", (button) => remoteAction(button, "/api/share", { enabled: false }, "공유를 껐습니다.")))
    );
  } else {
    body.push(
      h("p", { class: "small", text: "켜면 '연결 코드'로 허락한 내 다른 컴퓨터만 이 컴퓨터의 설치형 AI를 쓸 수 있습니다. 끄면 바로 막힙니다." }),
      paired.length ? h("p", { class: "muted small", text: `전에 연결한 컴퓨터 ${paired.length}대는 공유를 다시 켜면 코드 없이 이어집니다.` }) : null,
      h("div", { class: "row" }, confirmButton("이 컴퓨터 공유 켜기", "한 번 더 누르면 공유 시작", (button) => remoteAction(button, "/api/share", { enabled: true }, "공유를 켰습니다."), "primary"))
    );
  }
  return h(
    "div",
    { class: "card stack" },
    h("div", { class: "row space" }, h("h3", { text: "A. 이 컴퓨터를 빌려주기 (AI가 설치된 컴퓨터에서)" }), h("span", { class: `badge ${share.enabled ? "ok" : ""}`, text: share.enabled ? "공유 중" : "꺼짐" })),
    ...body,
    explain("공유할 때 알아 둘 점 (보안)", [
      "모든 연결은 처음부터 끝까지 암호화됩니다. 중계 서버를 거쳐도 서버는 내용을 볼 수 없습니다.",
      "Ollama는 네트워크에 직접 열리지 않습니다. 연결 코드로 허락한 컴퓨터만, 대화·모델 목록·모델 받기 기능만 쓸 수 있고 모델 삭제 같은 기능은 막혀 있습니다.",
      "연결 코드(6자리 숫자 포함)는 10분 동안 한 번만 쓸 수 있습니다. 남에게 알려 주지 말고 내 컴퓨터에만 넣으세요. 잘못 보냈다면 10분 기다리거나 아래 목록에서 '연결 끊기'를 누르세요.",
      "다른 컴퓨터가 쓰는 동안 이 컴퓨터는 켜져 있어야 하고, 잠자기 모드에 들어가면 연결이 끊깁니다.",
    ])
  );
}

function relayCard(local) {
  const share = (local && local.share) || {};
  const url = h("input", { type: "text", class: "grow", placeholder: "중계 서버 주소 (예: relay.내도메인.com)", autocomplete: "off", spellcheck: "false" });
  url.value = share.relay ? share.relay.replace(/^https:\/\//, "").replace(/\/$/, "") : "";
  const token = h("input", { type: "password", class: "grow", placeholder: share.relayHasToken ? "접속 암호 저장됨 (바꿀 때만 입력)" : "접속 암호 (서버 설치 때 정한 값)", autocomplete: "off" });
  for (const input of [url, token]) input.addEventListener("input", () => dirty.add("remote"));
  const save = h("button", { class: "primary", text: "저장" });
  save.addEventListener("click", () =>
    busy(save, async () => {
      const body = { url: url.value };
      if (token.value.trim()) body.token = token.value.trim();
      const result = await api.post("/api/share/relay", body);
      dirty.delete("remote");
      toast(result.message, "ok");
      await loadRemote();
    }, "저장 중…")
  );
  const test = h("button", { text: "연결 확인", disabled: !share.relay });
  test.addEventListener("click", () =>
    busy(test, async () => {
      const result = await api.post("/api/share/relay/test", {});
      toast(result.message, "ok");
    }, "확인 중…")
  );
  return h(
    "div",
    { class: "card stack" },
    h("div", { class: "row space" }, h("h3", { text: "🌍 밖에서도 쓰기: 중계 서버" }), h("span", { class: `badge ${share.relay ? "ok" : ""}`, text: share.relay ? "설정됨" : "없음 (같은 공유기만)" })),
    h("p", { class: "small", text: "카페·회사처럼 다른 곳에서 집 컴퓨터 AI를 쓰려면, 두 컴퓨터를 이어 주는 '중계 서버'가 필요합니다. 별도 프로그램 'AI Character 중계 서버(aic-relay)'를 내 서버에 한 번만 설치해 두면 됩니다. 설치가 끝나면 화면에 나오는 주소와 접속 암호를 아래에 넣으세요." }),
    h("div", { class: "row" }, url),
    h("div", { class: "row" }, token, save, test),
    share.relay
      ? h("p", { class: "notice ok", text: `📱 휴대폰에서도 쓸 수 있습니다: 휴대폰 브라우저로 ${share.relay.replace(/\/$/, "")}/app 을 열고, 접속 암호와 'A'에서 만든 6자리 숫자를 넣으세요. 대화는 휴대폰과 이 컴퓨터 사이에서만 암호화되어 오갑니다.` })
      : null,
    h("p", { class: "muted small", text: "중계 서버가 있으면 'A'에서 연결 코드를 만들 때 긴 코드와 함께 6자리 숫자가 나옵니다. 빌려 쓰는 컴퓨터(B)에서 6자리 숫자를 쓰려면 B에도 같은 중계 서버를 저장해 두세요 (긴 코드는 중계 서버 정보가 들어 있어 B 설정 없이도 됩니다). 비워 두고 저장하면 같은 공유기 안에서만 연결합니다." })
  );
}

function remoteModelRow(remote, model, jobs) {
  const [tone, verdictText] = VERDICTS[model.verdict] || VERDICTS.unknown;
  const job = jobs[`remote|${remote.id}|${model.id}`];
  const pulling = job && !job.done;
  let action = null;
  if (model.installed) action = h("span", { class: "badge ok", text: "설치됨" });
  else if (!pulling && (model.verdict === "no_ram" || model.verdict === "no_disk")) action = h("button", { disabled: true, text: "그 컴퓨터에선 불가" });
  else if (!pulling && remote.ollama)
    action = confirmButton(`받기 (${gbText(model.sizeGb)})`, "한 번 더 누르면 그 컴퓨터에 다운로드", (button) => remoteAction(button, "/api/remote/pull", { id: remote.id, model: model.id }, "다운로드를 시작했습니다."), "primary");
  return h(
    "div",
    { class: "key-row stack" },
    h("div", { class: "row space" }, h("div", { class: "row" }, h("h4", { text: model.label }), h("span", { class: "muted small", text: model.maker }), model.recommended ? h("span", { class: "badge free", text: "추천" }) : null), h("span", { class: `badge ${tone}`, text: verdictText })),
    h("p", { class: "small", text: model.reason.replace("이 컴퓨터", "그 컴퓨터") }),
    action ? h("div", { class: "row" }, action) : null,
    jobBar(job, "다운로드")
  );
}

function remoteCard(remote, jobs) {
  const specs = remote.specs;
  const sys = specs && specs.system;
  const status = remote.ollama ? h("span", { class: "badge ok", text: `연결됨${remote.version ? ` · Ollama v${remote.version}` : ""}` }) : h("span", { class: "badge bad", text: remote.online === false ? "꺼져 있음" : "연결 안 됨" });
  const power = remote.online === true ? h("span", { class: "badge ok", text: "🟢 켜짐" }) : remote.online === false ? h("span", { class: "badge", text: "⚫ 꺼짐" }) : null;
  const route =
    remote.path === "direct"
      ? h("span", { class: "badge ok", title: "두 컴퓨터가 서로 바로 연결돼 가장 빠릅니다.", text: `⚡ 직접 연결${remote.rttMs != null ? ` · ${remote.rttMs}ms` : ""}` })
      : remote.path === "relay"
        ? h("span", { class: "badge", title: "공유기·회사망 때문에 중계 서버를 거쳐 전달합니다. 내용은 여전히 암호화돼 서버가 볼 수 없습니다.", text: `🔁 중계 서버 경유${remote.rttMs != null ? ` · ${remote.rttMs}ms` : ""}` })
        : null;
  return h(
    "div",
    { class: "card stack" },
    h(
      "div",
      { class: "row space" },
      h("div", { class: "row" }, h("h3", { text: `🖥️ ${remote.name}` }), h("span", { class: "muted small", text: remote.viaRelay ? "🌍 어디서나" : "🏠 같은 공유기" }), power, route),
      h("div", { class: "row" }, status, confirmButton("목록에서 빼기", "한 번 더 누르면 뺌", (button) => remoteAction(button, "/api/remote/remove", { id: remote.id }, "목록에서 뺐습니다.")))
    ),
    !remote.ollama
      ? h("p", { class: "notice warn", text: remote.error || "그 컴퓨터의 AI에 연결하지 못했습니다. ① 그 컴퓨터가 켜져 있는지 ② 그 컴퓨터에서 '공유 중'인지 ③ 그 컴퓨터의 Ollama가 켜져 있는지 확인하세요." })
      : h("p", { class: "small", text: remote.models && remote.models.length ? `설치된 모델: ${remote.models.map((m) => m.name).join(", ")} — 대화 중 다른 AI가 막히면 자동으로 씁니다.` : "연결은 됐지만 그 컴퓨터에 모델이 없습니다. 아래에서 받아 주세요." }),
    sys
      ? h("div", { class: "stats" }, stat("칩", sys.cpu ? shortCpu(sys.cpu) : sys.arch || "?", sys.os || ""), stat("메모리", gbText(sys.ramGb), ""), stat("남은 저장공간", gbText(sys.freeDiskGb), ""), stat("그래픽", sys.appleSilicon ? "Apple 칩" : sys.nvidiaGpu ? `NVIDIA${sys.vramGb ? ` ${gbText(sys.vramGb)}` : ""}` : "없음", ""))
      : null,
    specs && specs.catalog ? h("details", { class: "stack" }, h("summary", { text: "그 컴퓨터에 모델 받기 (사양 판정 포함)" }), ...specs.catalog.map((model) => remoteModelRow(remote, model, jobs))) : null
  );
}

function isShortCode(text) {
  return /^[\d\s-]+$/.test(text.trim()) && text.replace(/\D/g, "").length === 6;
}

function addRemoteCard(local) {
  const share = (local && local.share) || {};
  const knowsRelay = !!share.relay || ((remoteView.data && remoteView.data.remotes) || []).some((r) => r.viaRelay);
  const code = h("textarea", { class: "code-box", rows: 2, placeholder: "6자리 숫자 (예: 123 456) 또는 AIC1. 로 시작하는 긴 코드", autocomplete: "off", spellcheck: "false" });
  const name = h("input", { type: "text", class: "grow", placeholder: "이름 (비워 두면 그 컴퓨터 이름)", autocomplete: "off" });
  const relayUrl = h("input", { type: "text", class: "grow", placeholder: "중계 서버 주소 (예: relay.내도메인.com)", autocomplete: "off", spellcheck: "false" });
  const relayToken = h("input", { type: "password", class: "grow", placeholder: "접속 암호", autocomplete: "off" });
  for (const input of [name, code, relayUrl, relayToken]) input.addEventListener("input", () => dirty.add("remote"));
  const add = h("button", { class: "primary", text: "연결하기" });
  add.addEventListener("click", () =>
    busy(add, async () => {
      if (!code.value.trim()) throw new Error("6자리 숫자나 연결 코드를 넣어 주세요. AI가 설치된 컴퓨터의 'A' 카드에서 '연결 코드 만들기'를 누르면 나옵니다.");
      const body = { code: code.value, name: name.value };
      if (isShortCode(code.value) && relayUrl.value.trim()) Object.assign(body, { relay: relayUrl.value, token: relayToken.value });
      const result = await api.post("/api/remote/add", body);
      dirty.delete("remote");
      toast(result.message || "연결했습니다.", "ok");
      await loadRemote();
      scheduleRemote();
    }, "연결 중… (최대 15초)")
  );
  return h(
    "div",
    { class: "card stack" },
    h("h3", { text: "B. 다른 컴퓨터 연결하기 (지금 쓰는 컴퓨터에서)" }),
    h("p", { class: "small", text: "AI가 설치된 컴퓨터의 'A. 이 컴퓨터를 빌려주기'에 나온 6자리 숫자를 입력하거나, 긴 연결 코드를 통째로 붙여 넣으세요. 한 번 연결하면 다음부터는 자동으로 이어집니다." }),
    code,
    h("div", { class: "row" }, name, add),
    h(
      "details",
      { class: "stack", open: false },
      h("summary", { text: knowsRelay ? "다른 중계 서버의 6자리 숫자를 넣을 때" : "6자리 숫자를 쓰려면 (이 컴퓨터에 중계 서버 정보가 없을 때)" }),
      h("p", { class: "muted small", text: "6자리 숫자는 중계 서버를 거쳐 전달됩니다. A 컴퓨터에 넣은 것과 같은 중계 서버 주소와 접속 암호를 넣으세요. 여기 넣은 정보는 이번 연결에만 쓰고 저장하지 않습니다. 긴 코드를 쓰면 필요 없습니다." }),
      h("div", { class: "row" }, relayUrl),
      h("div", { class: "row" }, relayToken)
    )
  );
}

function sectionRemote() {
  if (!remoteView.data && !remoteView.loading && !remoteView.error) setTimeout(loadRemote, 0);
  if (!remoteView.timer) scheduleRemote();
  const data = remoteView.data;
  const remotes = (data && data.remotes) || [];
  const jobs = (data && data.jobs) || {};
  return [
    h("div", { class: "eyebrow", text: "원격" }),
    h("h2", { text: "다른 컴퓨터 AI (원격)" }),
    h("p", { class: "lead", text: "집에 성능 좋은 컴퓨터가 있다면, 노트북이나 다른 컴퓨터에서 그 컴퓨터의 설치형 AI를 빌려 쓸 수 있습니다. 무료이고, 대화 내용은 암호화되어 내 컴퓨터들 사이에서만 오갑니다." }),
    guide(
      "🔰 처음이라면 이 순서대로 하세요",
      [
        ["두 컴퓨터를 정합니다", "AI를 빌려줄 '성능 좋은 컴퓨터'(예: 거실 데스크톱)와, 빌려 쓸 '지금 컴퓨터'(예: 노트북)를 정하세요. 두 컴퓨터 모두 AI Character가 설치되어 있어야 합니다."],
        ["성능 좋은 컴퓨터에서: 설치형 AI 준비", "그 컴퓨터의 AI Character에서 '💻 내 컴퓨터 AI'를 열어 Ollama를 설치하세요. 모델은 나중에 여기서 받아도 됩니다."],
        ["성능 좋은 컴퓨터에서: 공유 켜고 코드 만들기", "그 컴퓨터에서 이 화면을 열고 'A. 이 컴퓨터를 빌려주기'의 '이 컴퓨터 공유 켜기'를 두 번 누른 뒤 '연결 코드 만들기'를 누르세요. 중계 서버를 설정했다면 큰 6자리 숫자가, 아니면 긴 연결 코드가 나옵니다 (긴 코드는 '복사'해서 메신저·메일로 보내세요)."],
        ["지금 컴퓨터에서: 숫자나 코드 넣기", "이 화면의 'B. 다른 컴퓨터 연결하기'에 6자리 숫자를 입력하거나 긴 코드를 붙여 넣고 '연결하기'를 누르세요. 아래에 그 컴퓨터 카드가 생기고 '연결됨'이 뜨면 성공입니다."],
        ["모델 받기 (아직 없다면)", "연결된 컴퓨터 카드의 '그 컴퓨터에 모델 받기'를 열면 그 컴퓨터 사양 기준으로 판정이 나옵니다. '추천' 모델을 받으세요. 파일은 그 컴퓨터에 저장됩니다."],
        ["끝! 그냥 대화하면 됩니다", "인터넷 무료 AI가 모두 막히면 앱이 자동으로 내 컴퓨터 → 다른 컴퓨터 순서로 설치형 AI를 씁니다."],
      ],
      { open: remotes.length === 0, tip: "중계 서버가 없으면 두 컴퓨터가 같은 와이파이(공유기)에 있어야 합니다. 밖에서도 쓰려면 아래 '밖에서도 쓰기: 중계 서버'를 한 번 설정하세요." }
    ),
    remoteView.error && !data ? h("p", { class: "notice bad", text: remoteView.error }) : null,
    shareCard(localView.data),
    relayCard(localView.data),
    addRemoteCard(localView.data),
    !data ? h("div", { class: "row muted" }, h("span", { class: "spinner" }), "연결된 컴퓨터를 확인하는 중…") : null,
    ...remotes.map((remote) => remoteCard(remote, jobs)),
    faq("문제 해결", [
      ["'연결 안 됨'이 떠요.", "① 그 컴퓨터가 켜져 있고 잠자기 상태가 아닌지 ② 그 컴퓨터에서 '공유 중'인지 ③ 그 컴퓨터의 Ollama가 켜져 있는지 ④ 중계 서버가 없다면 두 컴퓨터가 같은 와이파이인지 확인하세요."],
      ["'연결 코드가 맞지 않거나 만료됐다'고 나와요.", "연결 코드와 6자리 숫자는 10분 동안 한 번만 쓸 수 있습니다. 그 컴퓨터에서 '새 연결 코드 만들기'를 눌러 다시 만들어 주세요."],
      ["'6자리 코드를 찾지 못했다'고 나와요.", "숫자를 다시 확인하세요. 이미 한 번 썼거나 10분이 지났으면 사라집니다. 틀린 숫자를 여러 번 넣으면 중계 서버가 이 인터넷 주소를 30분 동안 막으니, 헷갈리면 새로 만드세요."],
      ["카드에 '⚫ 꺼짐'이 떠요.", "중계 서버가 보기에 그 컴퓨터가 지금 연결되어 있지 않다는 뜻입니다. 그 컴퓨터를 켜고(잠자기 해제) AI Character를 실행하면 1분 안에 '🟢 켜짐'으로 바뀝니다."],
      ["'⚡ 직접 연결'과 '🔁 중계 서버 경유'는 뭐가 달라요?", "직접 연결은 두 컴퓨터가 서로 바로 이어져 가장 빠릅니다. 회사망·일부 공유기에서는 바로 못 이어져 중계 서버를 거치는데, 조금 느릴 수 있지만 내용은 똑같이 암호화돼 서버가 볼 수 없습니다."],
      ["방화벽 창이 떠요.", "처음 연결할 때 Windows는 '방화벽 허용', Mac은 '들어오는 연결 허용?' 창을 띄울 수 있습니다. AI Character를 '허용'하세요(Windows는 '개인 네트워크' 체크)."],
      ["카페·회사에서 집 컴퓨터를 쓰고 싶어요.", "'밖에서도 쓰기: 중계 서버'를 집 컴퓨터(A)에서 설정한 뒤, 연결 코드를 새로 만들어 노트북에 넣으세요. 공유기 포트를 열 필요가 없습니다."],
      ["휴대폰에서도 쓸 수 있나요?", "중계 서버가 있으면 됩니다. 휴대폰 브라우저로 '중계 서버 주소/app' (예: relay.내도메인.com/app)을 열고, 접속 암호를 넣은 뒤 'A'에서 만든 6자리 숫자를 넣으세요. 앱 설치 없이 바로 대화할 수 있고, 홈 화면에 추가하면 앱처럼 쓸 수 있습니다. 휴대폰을 잃어버리면 'A' 카드 목록에서 그 휴대폰을 '연결 끊기' 하세요."],
      ["느려요.", "같은 공유기 안이거나 직접 연결되면 빠르고, 중계 서버를 거치면 조금 느릴 수 있습니다. 답을 만드는 속도는 그 컴퓨터 성능에 달려 있습니다."],
      ["안전한가요?", "모든 연결은 암호화되고, 연결 코드로 허락한 컴퓨터만 접속할 수 있습니다. 중계 서버도 내용을 볼 수 없고, 인터넷 AI 회사로 보내지 않습니다. 쓰지 않는 컴퓨터는 'A' 카드에서 '연결 끊기'를 누르세요."],
    ]),
    h("div", { class: "row" }, h("button", { class: "link", text: remoteView.loading ? "확인 중…" : "다시 확인", disabled: remoteView.loading, onclick: loadRemote })),
  ];
}

// ---------- help ----------

function sectionHelp() {
  return [
    h("div", { class: "eyebrow", text: "도움말" }),
    h("h2", { text: "사용 설명서 (처음 쓰는 분용)" }),
    h("p", { class: "lead", text: "대화는 ChatGPT 구독, 정보 찾기는 무료 Gemini, 파일 고치기는 Claude가 합니다. 처음이면 왼쪽 '꼭 필요한 설정' 1·2·3만 하세요." }),
    guide(
      "🚀 5분 만에 시작하기",
      [
        ["'시작하기'에서 '추천 설정 적용'", "왼쪽 메뉴 1번입니다. 무료로 안전하게 쓰는 설정이 한 번에 켜집니다."],
        ["'작업 폴더' 고르기", "AI가 읽고 고칠 폴더입니다. 문서·코드 작업을 안 한다면 아무 빈 폴더나 골라도 됩니다."],
        ["'AI 키 연결'에서 Gemini 키 넣기", "정보 찾기에 씁니다. 키 받는 곳을 열고 키를 붙여넣은 뒤 저장하세요. 대화와 파일 작업은 다음 단계의 ChatGPT·Claude 로그인입니다."],
        ["'마무리'에서 설정 완료", "이제 화면의 캐릭터를 클릭해 대화창을 열고 말을 걸면 됩니다."],
      ],
      { tip: "나머지 단계는 전부 '나중에 하기'를 눌러도 됩니다. 기본값이 안전하게 맞춰져 있어요." }
    ),
    guide(
      "🗺️ 각 메뉴는 무엇을 하나요?",
      [
        ["1. 시작하기", "지금 어떤 AI를 쓰고 있는지 한눈에 보고, 추천 설정을 한 번에 켭니다."],
        ["2. 작업 폴더", "AI가 파일을 읽고 고칠 폴더입니다. 원본은 내가 확인한 뒤에만 바뀝니다."],
        ["3. AI 키 연결", "인터넷 AI 서비스를 연결합니다. 무료 서비스만으로 충분하고, 많이 연결할수록 '한도 초과'로 막힐 일이 줄어듭니다."],
        ["4. 프로그램 · 로그인", "Claude·Codex처럼 월 구독 중인 AI 프로그램이 있으면 연결합니다. 없으면 건너뛰세요."],
        ["5. 동작 방식", "웹 검색을 할지, 유료 AI를 허용할지 등을 정합니다. 기본값 그대로 두면 돈이 나가지 않습니다."],
        ["6. 알림 · 비용 한도", "하루 비용 한도(기본 1달러)와 알림을 정합니다. 유료 AI를 안 쓰면 신경 쓰지 않아도 됩니다."],
        ["7. 자동 업데이트", "새 버전이 나오면 자동으로 받을지 정합니다."],
        ["8. 마무리 · 백업", "설정을 파일로 백업하거나 다른 컴퓨터로 옮깁니다(키는 들어가지 않아 안전)."],
        ["💻 내 컴퓨터 AI (설치형)", "인터넷 없이 이 컴퓨터 안에서 돌아가는 AI를 설치합니다. 사양을 먼저 검사해 알맞은 모델을 추천합니다."],
        ["🌐 다른 컴퓨터 AI (원격)", "집의 성능 좋은 컴퓨터에 설치한 AI를 노트북 등 다른 컴퓨터에서 빌려 씁니다."],
        ["📊 사용량 보기", "어떤 AI를 몇 번 썼는지, 돈이 나갔는지 그래프로 봅니다."],
      ],
      { open: false }
    ),
    guide(
      "🔁 AI는 어떤 순서로 쓰이나요?",
      [
        ["1순위: Google Gemini (무료)", "가장 똑똑하고 빠른 무료 AI라 먼저 씁니다."],
        ["2순위: OpenRouter 무료 모델", "Gemini가 한도에 걸리면 대신 씁니다."],
        ["3순위: 추가 무료 AI", `${FREE_ORDER_TEXT} 순서로, 연결해 둔 곳만 씁니다.`],
        ["마지막: 설치형 AI", "인터넷 AI가 모두 막혔을 때 내 컴퓨터 → 다른 컴퓨터의 설치형 AI가 답합니다."],
        ["유료 AI는?", "'동작 방식'에서 직접 허용하고, 매번 승인하고, 하루 한도 안에서만 씁니다. 기본은 꺼져 있어 돈이 나가지 않습니다."],
      ],
      { open: false }
    ),
    glossary([
      ["API 키", "AI 회사 서버를 앱이 대신 불러 쓰도록 허락하는 비밀번호 같은 글자입니다. 각 회사 사이트에서 무료로 받습니다. 남에게 보여 주지 마세요."],
      ["무료 한도", "무료 AI는 '분당 몇 번, 하루 몇 번'처럼 쓸 수 있는 양이 정해져 있습니다. 넘으면 잠시 막히고, 앱이 자동으로 다른 무료 AI로 넘어갑니다."],
      ...LOCAL_WORDS,
      ["연결 코드", "다른 컴퓨터 AI를 연결할 때 쓰는 AIC1. 로 시작하는 긴 코드입니다. 10분 동안 한 번만 쓸 수 있고, 내 컴퓨터끼리만 주고받으면 됩니다."],
      ["중계 서버", "집 밖에서도 내 컴퓨터끼리 연결되도록 이어 주는 서버입니다. 내용은 암호화되어 서버도 볼 수 없습니다. 같은 공유기 안에서는 없어도 됩니다."],
    ]),
    faq("자주 묻는 질문", [
      ["정말 돈이 안 드나요?", "기본 설정에서는 무료 AI만 씁니다. 유료 AI는 직접 허용하고 매번 승인해야만 쓰이고, 하루 한도를 넘으면 자동으로 막힙니다."],
      ["'한도 초과', '막힘'이 떠요.", "무료 AI의 사용량이 잠시 찼다는 뜻입니다. 보통 몇 분~하루 뒤 풀립니다. 'AI 키 연결'에서 무료 AI를 더 연결하거나 설치형 AI를 준비해 두면 막힐 일이 거의 없습니다."],
      ["키를 잘못 넣었어요.", "'AI 키 연결'에서 해당 키의 '삭제'를 두 번 누르고 다시 넣으세요. '연결 확인' 버튼으로 맞는 키인지 확인할 수 있습니다."],
      ["설정을 망친 것 같아요.", "'시작하기'의 '추천 설정 적용'을 다시 누르면 안전한 기본값으로 돌아옵니다. 스위치를 모두 풀고 처음부터 하려면 '마무리 · 백업'의 '설정 초기화'를 쓰세요."],
      ["이 페이지가 안 열려요 / 로그인 만료라고 나와요.", "메뉴 막대(Mac) 또는 작업 표시줄(Windows)의 AI Character 아이콘 → '처음 설정 (웹)'을 누르면 다시 열립니다."],
      ["새 컴퓨터로 옮기고 싶어요.", "'마무리 · 백업'에서 백업 파일을 받아 새 컴퓨터에서 불러오세요. API 키는 보안상 백업에 들어가지 않으니 다시 넣어야 합니다."],
      ["내 대화가 어디로 가나요?", "인터넷 AI를 쓸 땐 그 회사(Google 등)로 갑니다. 설치형 AI를 쓸 땐 내 컴퓨터(또는 내가 연결한 다른 컴퓨터) 밖으로 나가지 않습니다. 키나 비밀번호 같은 값은 자동으로 가려서 보냅니다."],
    ]),
  ];
}

// ---------- usage ----------

const PROVIDER_LABELS = {
  gemini_api: "Google Gemini",
  openrouter_api: "OpenRouter",
  openai_api: "OpenAI (유료)",
  anthropic_api: "Anthropic API",
  claude_cli: "Claude (구독)",
  claude: "Claude (구독)",
  codex: "Codex",
  jina_search: "Jina 검색",
  groq_api: "Groq",
  nvidia_api: "NVIDIA NIM",
  zai_api: "Z.ai GLM",
  sambanova_api: "SambaNova",
  cloudflare_api: "Cloudflare Workers AI",
  siliconflow_api: "SiliconFlow",
  skt_ax_api: "SKT A.X",
  hasa_api: "HASA 공공 AI 허브",
  hunyuan_api: "Tencent Hunyuan",
  ollama_local: "Ollama (내 컴퓨터)",
  lmstudio_local: "LM Studio (내 컴퓨터)",
  ollama_remote: "다른 컴퓨터 (Ollama)",
};
const COST_CLASS = { free: "무료", free_first: "무료 우선", paid: "유료", paid_opt_in: "유료(허용)", subscription: "구독", local: "로컬" };
const usageView = { days: 7, data: null, loading: false, error: "", timer: null };

function providerName(id) {
  return PROVIDER_LABELS[id] || id;
}

function fmtTokens(value) {
  const n = Number(value) || 0;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

function usd(value) {
  const n = Number(value) || 0;
  return n > 0 && n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

function toneFor(pct) {
  return pct >= 90 ? "bad" : pct >= 70 ? "warn" : "ok";
}

function meterBar(label, valueText, pct, note) {
  const safe = Math.max(0, Math.min(100, Number(pct) || 0));
  return h(
    "div",
    { class: "meter" },
    h("div", { class: "meter-row" }, h("span", { text: label }), h("b", { class: toneFor(safe), text: valueText })),
    h("div", { class: "meter-track" }, h("div", { class: `meter-fill ${toneFor(safe)}`, style: `width:${Math.max(1.5, safe)}%` })),
    note ? h("div", { class: "muted small", text: note }) : null
  );
}

function stat(label, value, sub) {
  return h("div", { class: "stat" }, h("div", { class: "stat-label", text: label }), h("div", { class: "stat-value", text: value }), sub ? h("div", { class: "stat-sub", text: sub }) : null);
}

/** Every day in the period, oldest first, so empty days still get a (zero) bar. */
function periodDays(today, days) {
  const [y, m, d] = today.split("-").map(Number);
  const out = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const date = new Date(y, m - 1, d - i);
    out.push(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`);
  }
  return out;
}

function barChart(title, days, rows, valueOf, labelOf) {
  const byDay = new Map(rows.map((row) => [row.day, row]));
  const values = days.map((day) => (byDay.has(day) ? valueOf(byDay.get(day)) : 0));
  const max = Math.max(1, ...values);
  const total = values.reduce((sum, v) => sum + v, 0);
  return h(
    "div",
    { class: "chart" },
    h("div", { class: "chart-title" }, h("span", { text: title }), h("span", { class: "muted small", text: `합계 ${labelOf(total)}` })),
    h(
      "div",
      { class: `bars ${days.length > 14 ? "dense" : ""}` },
      ...days.map((day, index) =>
        h(
          "div",
          { class: "bar", title: `${day}: ${labelOf(values[index])}` },
          h("div", { class: "bar-fill", style: `height:${values[index] ? Math.max(4, (values[index] / max) * 100) : 0}%` }),
          h("div", { class: "bar-label", text: days.length > 14 && index % 5 !== 0 && index !== days.length - 1 ? "" : day.slice(5).replace("-", "/") })
        )
      )
    )
  );
}

function table(headers, rows, empty) {
  if (!rows.length) return h("p", { class: "muted small", text: empty });
  return h(
    "div",
    { class: "table-wrap" },
    h("table", { class: "using data" }, h("thead", {}, h("tr", {}, ...headers.map((t) => h("th", { text: t })))), h("tbody", {}, ...rows.map((cells) => h("tr", {}, ...cells.map((c) => h("td", {}, c))))))
  );
}

function resetText(resetsAt) {
  if (!resetsAt) return "";
  const ms = resetsAt < 1e12 ? resetsAt * 1000 : resetsAt;
  const minutes = Math.round((ms - Date.now()) / 60000);
  if (minutes <= 0) return "곧 초기화";
  if (minutes < 60) return `${minutes}분 뒤 초기화`;
  if (minutes < 60 * 48) return `${Math.round(minutes / 60)}시간 뒤 초기화`;
  return `${new Date(ms).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "numeric" })} 초기화`;
}

async function loadUsage(days) {
  usageView.days = days;
  usageView.loading = true;
  usageView.error = "";
  if (current === "usage") render();
  try {
    usageView.data = await api.get(`/api/usage?days=${days}`);
  } catch (error) {
    usageView.error = error.message || String(error);
  }
  usageView.loading = false;
  if (current === "usage") render();
}

function usageToday(report) {
  const alerts = report.alerts;
  const items = [];
  if (alerts) {
    const limit = Number(alerts.dailyCostLimitUsd) || 0;
    items.push(
      limit > 0
        ? meterBar("오늘 유료 비용", `${usd(alerts.costUsd)} / $${limit}`, (alerts.costUsd / limit) * 100, alerts.paidBlocked ? "하루 한도를 넘어 유료 AI 호출을 막고 있습니다. '알림 · 비용 한도'에서 바꿀 수 있어요." : "한도에 닿으면 '막기' 설정에 따라 유료 AI 호출을 막습니다.")
        : h("p", { class: "muted small", text: `하루 유료 한도가 0달러라 유료 AI를 쓰지 않습니다. '알림 · 비용 한도'에서 금액을 정할 수 있어요.` })
    );
    const warn = Number(alerts.dailyCallWarn) || 0;
    if (warn > 0) items.push(meterBar("오늘 AI 호출", `${alerts.calls}회 / 경고 ${warn}회`, (alerts.calls / warn) * 100, `유료 호출 ${alerts.paidCalls}회 포함`));
    if (alerts.message) items.push(h("p", { class: `notice ${alerts.level === "over" ? "bad" : "warn"}`, text: alerts.message }));
  }
  for (const meter of (report.codex && report.codex.meters) || []) {
    items.push(meterBar(`Codex ${meter.label}`, `${Math.round(meter.pct)}%`, meter.pct, resetText(meter.resetsAt)));
  }
  return h("div", { class: "card" }, h("h3", { text: "오늘 한도" }), ...(items.length ? items : [h("p", { class: "muted small", text: "아직 오늘 사용 기록이 없습니다." })]));
}

function usageApp(report, days) {
  const app = report.app || {};
  if (!app.available) return h("div", { class: "card" }, h("h3", { text: "앱 AI 호출" }), h("p", { class: "muted small", text: "아직 사용 기록 데이터베이스가 없습니다. 대화를 한 번 하면 생깁니다." }));
  const summaryData = app.summary || {};
  const providers = summaryData.providers || [];
  const calls = providers.reduce((sum, p) => sum + p.calls, 0);
  const errors = providers.reduce((sum, p) => sum + p.errors, 0);
  const tokens = providers.reduce((sum, p) => sum + p.inputTokens + p.outputTokens, 0);
  return h(
    "div",
    { class: "card" },
    h("h3", { text: "앱이 부른 AI (Gemini · OpenRouter · Groq 등)" }),
    h("p", { class: "muted small", text: "대화·자동 작업에서 앱이 직접 부른 API 호출입니다. '절약액'은 같은 일을 유료 API로 했다면 냈을 추정 금액이에요." }),
    h(
      "div",
      { class: "stats" },
      stat("호출", `${calls.toLocaleString("ko-KR")}회`, errors ? `실패 ${errors}회` : "실패 없음"),
      stat("유료 비용", usd(summaryData.totalCostUsd), "실제로 청구된 금액"),
      stat("절약액(추정)", usd(summaryData.estimatedSavingsUsd), "무료·구독으로 대신한 금액"),
      stat("토큰", fmtTokens(tokens), "입력+출력")
    ),
    barChart("일별 호출", days, app.daily || [], (row) => row.calls, (v) => `${v}회`),
    h("h4", { text: "AI·모델별" }),
    table(
      ["AI", "모델", "종류", "호출", "성공률", "평균 속도", "토큰", "비용"],
      (app.models || []).map((m) => [
        providerName(m.provider),
        h("code", { text: m.model || "—" }),
        COST_CLASS[m.costClass] || m.costClass,
        String(m.calls),
        m.calls ? `${Math.round((m.ok / m.calls) * 100)}%` : "—",
        m.avgLatencyMs ? `${(m.avgLatencyMs / 1000).toFixed(1)}초` : "—",
        fmtTokens(m.inputTokens + m.outputTokens),
        usd(m.costUsd),
      ]),
      "이 기간에는 호출 기록이 없습니다."
    )
  );
}

function usageCli(title, lead, data, days, extra) {
  if (!data || !data.available) {
    return h("div", { class: "card" }, h("h3", { text: title }), h("p", { class: "muted small", text: "이 컴퓨터에서 사용 기록을 찾지 못했습니다. 설치·로그인 후 한 번 쓰면 여기에 나타납니다." }));
  }
  const total = data.total || { total: (data.models || []).reduce((s, m) => s + m.total, 0), count: (data.models || []).reduce((s, m) => s + m.count, 0) };
  return h(
    "div",
    { class: "card" },
    h("h3", { text: title }),
    h("p", { class: "muted small", text: lead }),
    h("div", { class: "stats" }, stat("오늘", fmtTokens(data.today && data.today.total), `응답 ${(data.today && data.today.count) || 0}회`), stat(`${usageView.days}일`, fmtTokens(total.total), `응답 ${total.count || 0}회`), ...(extra || [])),
    barChart("일별 토큰", days, data.days || [], (row) => row.tokens, fmtTokens),
    h("h4", { text: "모델별" }),
    table(
      ["모델", "응답", "입력", "출력", "캐시 읽기", "합계"],
      (data.models || []).sort((a, b) => b.total - a.total).map((m) => [h("code", { text: m.model }), String(m.count), fmtTokens(m.input), fmtTokens(m.output), fmtTokens(m.cacheRead), fmtTokens(m.total)]),
      "이 기간에는 기록이 없습니다."
    )
  );
}

function usageRecent(report) {
  const rows = ((report.app && report.app.recent) || []).map((r) => [
    new Date(r.createdAt).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }),
    providerName(r.provider),
    h("code", { text: r.model || "—" }),
    h("span", { class: `badge ${r.status === "ok" ? "ok" : "warn"}`, text: r.cacheHit ? "캐시" : r.status === "ok" ? "성공" : "실패", title: r.error || "" }),
    r.latencyMs ? `${(r.latencyMs / 1000).toFixed(1)}초` : "—",
    usd(r.costUsd),
  ]);
  return h("div", { class: "card" }, h("h3", { text: "최근 호출 25개" }), h("p", { class: "muted small", text: "실패 항목에 마우스를 올리면 이유가 보입니다 (키 같은 비밀 값은 가려져 있어요)." }), table(["시각", "AI", "모델", "결과", "속도", "비용"], rows, "아직 기록이 없습니다."));
}

function sectionUsage() {
  if (!usageView.data && !usageView.loading && !usageView.error) setTimeout(() => loadUsage(usageView.days), 0);
  if (!usageView.timer) {
    usageView.timer = setInterval(() => {
      if (current === "usage" && !document.hidden && !usageView.loading) loadUsage(usageView.days);
    }, 60000);
  }
  const periods = h(
    "div",
    { class: "row period" },
    ...[
      [1, "오늘"],
      [7, "7일"],
      [30, "30일"],
    ].map(([days, label]) => h("button", { class: usageView.days === days ? "primary" : "", text: label, onclick: () => loadUsage(days) })),
    h("button", { class: "link", text: usageView.loading ? "불러오는 중…" : "새로고침", disabled: usageView.loading, onclick: () => loadUsage(usageView.days) })
  );
  const head = [
    h("div", { class: "eyebrow", text: "사용량" }),
    h("h2", { text: "AI 사용량 자세히 보기" }),
    h("p", { class: "lead", text: "앱이 부른 무료·유료 AI, Claude 구독, Codex 사용을 한곳에서 봅니다. 1분마다 자동으로 새로 고칩니다. 대화창의 '사용량'은 오늘 요약만 보여 줍니다." }),
    periods,
  ];
  const report = usageView.data;
  if (usageView.error && !report) return [...head, h("p", { class: "notice bad", text: usageView.error })];
  if (!report) return [...head, h("p", { class: "muted", text: "사용량을 모으는 중…" })];
  const days = periodDays(report.today, report.days);
  const codex = report.codex || {};
  return [
    ...head,
    usageView.error ? h("p", { class: "notice bad", text: usageView.error }) : null,
    usageToday(report),
    usageApp(report, days),
    usageCli("Claude 구독 (Claude Code)", "Pro/Max 월정액이라 비용은 0이지만 5시간·주간 사용 한도가 있습니다. 토큰이 많이 쌓일수록 한도에 빨리 닿아요. 이 컴퓨터의 Claude Code 기록(~/.claude)에서 읽습니다.", report.claude, days),
    usageCli("Codex (ChatGPT 계정)", "ChatGPT 구독으로 쓰는 Codex입니다. 한도 %는 마지막 Codex 사용 시점 기준이에요. 이 컴퓨터의 기록(~/.codex)에서 읽습니다.", codex, days, codex.available ? [stat("세션", `${codex.sessions || 0}개`, "이 기간")] : []),
    usageRecent(report),
    explain("이 숫자들은 어디서 오나요?", [
      "앱 AI 호출: 앱 폴더의 사용 기록 데이터베이스(state.db). 호출할 때마다 한 줄씩 남깁니다.",
      "Claude·Codex: 각 프로그램이 이 컴퓨터에 남기는 대화 기록 파일의 토큰 수를 셉니다. 인터넷으로 조회하지 않습니다.",
      "오늘 유료 비용 한도와 호출 경고 횟수는 '알림·한도' 단계에서 바꿉니다.",
    ]),
    h("p", { class: "muted small", text: `${new Date(report.generatedAt).toLocaleTimeString("ko-KR")} 기준` }),
  ];
}

const BUILDERS = {
  usage: sectionUsage,
  local: sectionLocal,
  remote: sectionRemote,
  help: sectionHelp,
  welcome: sectionWelcome,
  folder: sectionFolder,
  keys: sectionKeys,
  accounts: sectionAccounts,
  behavior: sectionBehavior,
  alerts: sectionAlerts,
  updates: sectionUpdates,
  finish: sectionFinish,
};

function render() {
  if (!state) return;
  const main = document.getElementById("main");
  const fatal = document.getElementById("fatal");
  const same = main.querySelector(`section[data-section="${current}"]`);
  // Every input is rebuilt from saved state, so nothing typed survives a render.
  dirty.delete(current);
  const section = h("section", { "data-section": current, class: same ? "visible still" : "visible" }, ...BUILDERS[current]());
  section.addEventListener("input", () => dirty.add(current));
  if (same) {
    // Saving, polling and returning to the window all redraw the page; keep what the
    // user opened or folded and where they were scrolled instead of snapping back.
    const opened = foldState(same);
    for (const [key, details] of foldEntries(section)) if (opened.has(key)) details.open = opened.get(key);
    const scrollY = window.scrollY;
    main.replaceChildren(fatal, section);
    window.scrollTo(0, scrollY);
  } else {
    main.replaceChildren(fatal, section);
  }
  renderNav();
  const build = state.build || {};
  document.getElementById("version").textContent = `v${build.version || "?"} · ${state.platform}`;
}

/** Folded sections keyed by their title (plus position, for repeated titles). */
function foldEntries(root) {
  const seen = new Map();
  return [...root.querySelectorAll("details")].map((details) => {
    const summary = details.querySelector(":scope > summary");
    const title = summary ? summary.textContent.trim() : "";
    const count = seen.get(title) || 0;
    seen.set(title, count + 1);
    return [`${title}#${count}`, details];
  });
}

function foldState(root) {
  return new Map(foldEntries(root).map(([key, details]) => [key, details.open]));
}

function show(id) {
  current = BUILDERS[id] ? id : "welcome";
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function refreshState() {
  state = await api.get("/api/state");
}

window.addEventListener("hashchange", () => show(location.hash.slice(1)));
window.addEventListener("beforeunload", (event) => {
  if (dirty.size > 0) {
    event.preventDefault();
    event.returnValue = "";
  }
});
// Coming back from GitHub or a login window: pick up what changed without a manual reload.
window.addEventListener("focus", async () => {
  if (!state || dirty.has(current)) return;
  try {
    await refreshState();
    if (current === "accounts") runtimeStale = true;
    if (current === "usage" && !usageView.loading) loadUsage(usageView.days);
    else if (current === "local") loadLocal();
    else if (current === "remote") loadRemote();
    else render();
  } catch {
    // The 401 handler already explains how to reopen the page.
  }
});

(async () => {
  try {
    await refreshState();
    show(location.hash.slice(1) || "welcome");
  } catch (error) {
    showFatal(error.message || String(error));
  }
})();
