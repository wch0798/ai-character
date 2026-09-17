// AI-Character 계정 사용량 대시보드 서버 (의존성 없음, Node 22.5+)
// 실행: usage-dashboard 폴더 안에서 node server.mjs  →  http://localhost:4318
//
// 새 AI를 추가하려면 PROVIDERS 배열에 collect 함수만 등록하면 됩니다.
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();
function resolveAppDir() {
  if (process.env.AI_CHARACTER_DIR) return process.env.AI_CHARACTER_DIR;
  const siblings = [
    join(HERE, '..', '.ai-character'),
    join(HERE, '..', '..', '.ai-character'),
  ];
  for (const candidate of siblings) {
    if (existsSync(candidate)) return candidate;
  }
  const legacy = '/Volumes/백업/테스트/.ai-character';
  if (existsSync(legacy)) return legacy;
  return siblings[0];
}
const APP_DIR = resolveAppDir();
const CLAUDE_HOME = process.env.CLAUDE_CONFIG_DIR || join(HOME, '.claude');
const CLAUDE_DIR = join(CLAUDE_HOME, 'projects');
const CODEX_HOME = process.env.CODEX_HOME || join(HOME, '.codex');
const CODEX_DIR = join(CODEX_HOME, 'sessions');
const CURSOR_HOME = process.env.CURSOR_HOME || join(HOME, '.cursor');
const ANTIGRAVITY_HOME = process.env.ANTIGRAVITY_HOME || join(HOME, '.antigravity');
const PORT = Number(process.env.PORT || 4318);

async function walkJsonl(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walkJsonl(p));
    else if (entry.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

async function readLines(file) {
  const rows = [];
  for (const line of (await readFile(file, 'utf8')).split('\n')) {
    if (!line) continue;
    try { rows.push(JSON.parse(line)); } catch { /* 잘린 줄은 건너뜀 */ }
  }
  return rows;
}

async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

const dayOf = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const projectLabel = (name) => name.match(/conversations-([0-9a-f-]{36})-project/)?.[1] ?? name;

function emptyTokens() {
  return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, messages: 0 };
}

function sumTokens(bucket) {
  return Object.values(bucket).reduce((s, m) => s + (m.input ?? 0) + (m.output ?? 0) + (m.cacheWrite ?? 0) + (m.cacheRead ?? 0), 0);
}

function appRunsFor(agentId, app) {
  const runs = (app.runs ?? []).filter((r) => String(r.agent || '').toLowerCase() === agentId);
  const byStatus = runs.reduce((a, r) => (a[r.status] = (a[r.status] || 0) + 1, a), {});
  return { total: runs.length, byStatus, runs };
}

function providerShell({ id, label, available, account, headline, chart, modelTable, projectTable, meters, note, raw }) {
  return {
    id,
    label,
    available: !!available,
    account: account ?? { email: null },
    headline: headline ?? null,
    chart: chart ?? null,
    modelTable: modelTable ?? null,
    projectTable: projectTable ?? null,
    meters: meters ?? null,
    note: note ?? null,
    // 하위 호환·디버그용 원시 집계 (UI는 providers 메타만 씀)
    raw: raw ?? null,
  };
}

async function collectClaude(ctx) {
  const seen = new Set();
  const byModel = {}, byDay = {}, byProject = {};
  let lastActivity = 0;
  for (const file of await walkJsonl(CLAUDE_DIR)) {
    const project = projectLabel(file.slice(CLAUDE_DIR.length + 1).split('/')[0]);
    for (const row of await readLines(file)) {
      const u = row.message?.usage;
      if (!u || row.type !== 'assistant') continue;
      const key = row.message.id ?? row.uuid;
      if (seen.has(key)) continue;
      seen.add(key);
      const t = {
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
      };
      const ts = Date.parse(row.timestamp) || 0;
      lastActivity = Math.max(lastActivity, ts);
      const model = row.message.model ?? 'unknown';
      if (model === '<synthetic>') continue;
      for (const [bucket, k] of [[byModel, model], [byDay, dayOf(ts)], [byProject, project]]) {
        const b = bucket[k] ??= emptyTokens();
        b.input += t.input; b.output += t.output; b.cacheWrite += t.cacheWrite; b.cacheRead += t.cacheRead; b.messages++;
      }
    }
  }
  const total = sumTokens(byModel);
  const messages = Object.values(byModel).reduce((s, m) => s + m.messages, 0);
  const account = ctx.accounts.claude;
  const runs = appRunsFor('claude', ctx.app);
  return providerShell({
    id: 'claude',
    label: 'Claude (Anthropic)',
    available: existsSync(CLAUDE_DIR),
    account,
    headline: {
      label: 'Claude 총 토큰',
      value: total,
      detail: `응답 ${messages}회 · 앱 실행 ${runs.total}회`,
    },
    chart: {
      title: 'Claude — 날짜별 토큰 (입력+캐시+출력)',
      seriesLabel: '토큰',
      points: Object.entries(byDay).sort().map(([day, b]) => ({
        label: day,
        value: b.input + b.output + b.cacheWrite + b.cacheRead,
        tip: [
          `입력 ${b.input}`,
          `캐시 쓰기 ${b.cacheWrite}`,
          `캐시 읽기 ${b.cacheRead}`,
          `출력 ${b.output}`,
          `응답 ${b.messages}회`,
        ],
      })),
    },
    modelTable: {
      title: 'Claude 모델별',
      columns: [
        { key: 'model', label: '모델' },
        { key: 'messages', label: '응답', num: true },
        { key: 'input', label: '입력', num: true, fmt: true },
        { key: 'cacheWrite', label: '캐시 쓰기', num: true, fmt: true },
        { key: 'cacheRead', label: '캐시 읽기', num: true, fmt: true },
        { key: 'output', label: '출력', num: true, fmt: true },
      ],
      rows: Object.entries(byModel).map(([model, v]) => ({ model, ...v })),
    },
    projectTable: {
      title: 'Claude 대화 폴더별',
      columns: [
        { key: 'project', label: '대화 폴더', shortId: true },
        { key: 'messages', label: '응답', num: true },
        { key: 'total', label: '총 토큰', num: true, fmt: true },
        { key: 'output', label: '출력', num: true, fmt: true },
      ],
      rows: Object.entries(byProject)
        .map(([project, v]) => ({
          project,
          messages: v.messages,
          total: v.input + v.output + v.cacheWrite + v.cacheRead,
          output: v.output,
        }))
        .sort((a, b) => b.messages - a.messages),
    },
    raw: { byModel, byDay, byProject, lastActivity, messages, total },
  });
}

async function collectCodex(ctx) {
  const byDay = {}, byModel = {};
  let latestLimits = null, latestTs = 0, sessions = 0;
  for (const file of await walkJsonl(CODEX_DIR)) {
    let model = 'unknown', last = null, lastTs = 0;
    for (const row of await readLines(file)) {
      if (row.type === 'turn_context' && row.payload?.model) model = row.payload.model;
      if (row.payload?.type !== 'token_count') continue;
      const ts = Date.parse(row.timestamp) || 0;
      if (row.payload.info?.total_token_usage) { last = row.payload.info.total_token_usage; lastTs = ts; }
      if (row.payload.rate_limits && ts >= latestTs) { latestLimits = row.payload.rate_limits; latestTs = ts; }
    }
    if (!last) continue;
    sessions++;
    for (const [bucket, k] of [[byDay, dayOf(lastTs)], [byModel, model]]) {
      const b = bucket[k] ??= { input: 0, cachedInput: 0, output: 0, reasoning: 0, sessions: 0 };
      b.input += last.input_tokens ?? 0; b.cachedInput += last.cached_input_tokens ?? 0;
      b.output += last.output_tokens ?? 0; b.reasoning += last.reasoning_output_tokens ?? 0; b.sessions++;
    }
  }
  const total = Object.values(byModel).reduce((s, m) => s + m.input + m.output, 0);
  const account = ctx.accounts.codex;
  const runs = appRunsFor('codex', ctx.app);
  const meters = [];
  if (latestLimits?.primary) {
    meters.push({
      label: '단기 한도',
      pct: latestLimits.primary.used_percent,
      windowMin: latestLimits.primary.window_minutes,
      resetsAt: latestLimits.primary.resets_at,
    });
  }
  if (latestLimits?.secondary) {
    meters.push({
      label: '주간 한도',
      pct: latestLimits.secondary.used_percent,
      windowMin: latestLimits.secondary.window_minutes,
      resetsAt: latestLimits.secondary.resets_at,
    });
  }
  return providerShell({
    id: 'codex',
    label: 'Codex (ChatGPT)',
    available: existsSync(CODEX_DIR),
    account,
    headline: {
      label: 'Codex 총 토큰',
      value: total,
      detail: `세션 ${sessions}개 · 앱 실행 ${runs.total}회`,
    },
    chart: {
      title: 'Codex — 날짜별 토큰',
      seriesLabel: '토큰',
      points: Object.entries(byDay).sort().map(([day, b]) => ({
        label: day,
        value: b.input + b.output,
        tip: [
          `입력 ${b.input} (캐시 ${b.cachedInput})`,
          `출력 ${b.output}`,
          `세션 ${b.sessions}개`,
        ],
      })),
    },
    modelTable: {
      title: 'Codex 모델별',
      columns: [
        { key: 'model', label: '모델' },
        { key: 'sessions', label: '세션', num: true },
        { key: 'input', label: '입력', num: true, fmt: true },
        { key: 'cachedInput', label: '캐시 입력', num: true, fmt: true },
        { key: 'output', label: '출력', num: true, fmt: true },
        { key: 'reasoning', label: '추론', num: true, fmt: true },
      ],
      rows: Object.entries(byModel).map(([model, v]) => ({ model, ...v })),
    },
    meters: meters.length ? {
      title: 'Codex(ChatGPT) — 사용 한도',
      items: meters,
      note: latestTs
        ? `${new Date(latestTs).toLocaleString('ko-KR')} Codex 사용 시점에 기록된 값이에요. 이후 사용량은 반영되지 않아요.`
        : null,
    } : null,
    raw: { byDay, byModel, sessions, rateLimits: latestLimits, rateLimitsAt: latestTs, total },
  });
}

function openSqliteReadonly(path) {
  if (!existsSync(path)) return null;
  try {
    return new DatabaseSync(path, { readOnly: true });
  } catch {
    return null;
  }
}

async function collectCursor(ctx) {
  const trackingDb = join(CURSOR_HOME, 'ai-tracking', 'ai-code-tracking.db');
  const byDay = {}, byModel = {}, byExt = {};
  let codeEvents = 0, conversations = 0, requests = 0, lastActivity = 0;
  const db = openSqliteReadonly(trackingDb);
  if (db) {
    try {
      const rows = db.prepare(`
        SELECT timestamp, model, fileExtension, conversationId, requestId
        FROM ai_code_hashes
      `).all();
      const conv = new Set(), req = new Set();
      for (const row of rows) {
        codeEvents++;
        const ts = Number(row.timestamp) || Number(row.createdAt) || 0;
        if (ts) lastActivity = Math.max(lastActivity, ts);
        const day = ts ? dayOf(ts) : 'unknown';
        const model = row.model || 'unknown';
        const ext = row.fileExtension || '(none)';
        if (row.conversationId) conv.add(row.conversationId);
        if (row.requestId) req.add(row.requestId);
        const d = byDay[day] ??= { events: 0, conversations: new Set(), requests: new Set() };
        d.events++;
        if (row.conversationId) d.conversations.add(row.conversationId);
        if (row.requestId) d.requests.add(row.requestId);
        const m = byModel[model] ??= { events: 0 };
        m.events++;
        const e = byExt[ext] ??= { events: 0 };
        e.events++;
      }
      conversations = conv.size;
      requests = req.size;
      for (const day of Object.keys(byDay)) {
        byDay[day] = {
          events: byDay[day].events,
          conversations: byDay[day].conversations.size,
          requests: byDay[day].requests.size,
        };
      }
    } finally {
      db.close();
    }
  }

  const account = ctx.accounts.cursor;
  const runs = appRunsFor('cursor', ctx.app);
  const cursorCfg = await readJson(join(CURSOR_HOME, 'cli-config.json'));
  const selectedModel = cursorCfg?.selectedModel ?? cursorCfg?.model ?? null;

  return providerShell({
    id: 'cursor',
    label: 'Cursor',
    available: existsSync(CURSOR_HOME),
    account: {
      ...account,
      linesExtra: [
        selectedModel && `선택 모델: ${typeof selectedModel === 'string' ? selectedModel : JSON.stringify(selectedModel)}`,
        codeEvents ? `코드 추적 ${codeEvents.toLocaleString('ko-KR')}건` : '로컬 코드 추적 없음',
        requests ? `요청 ${requests}회 · 대화 ${conversations}개` : null,
      ].filter(Boolean),
    },
    headline: {
      label: 'Cursor 코드 추적',
      value: codeEvents,
      detail: `요청 ${requests}회 · 대화 ${conversations}개 · 앱 실행 ${runs.total}회`,
    },
    chart: {
      title: 'Cursor — 날짜별 코드 변경 추적',
      seriesLabel: '이벤트',
      points: Object.entries(byDay).sort().map(([day, b]) => ({
        label: day,
        value: b.events,
        tip: [
          `추적 ${b.events}건`,
          `요청 ${b.requests}회`,
          `대화 ${b.conversations}개`,
        ],
      })),
    },
    modelTable: {
      title: 'Cursor 모델별 코드 추적',
      columns: [
        { key: 'model', label: '모델' },
        { key: 'events', label: '추적', num: true, fmt: true },
      ],
      rows: Object.entries(byModel)
        .map(([model, v]) => ({ model, ...v }))
        .sort((a, b) => b.events - a.events),
    },
    projectTable: {
      title: 'Cursor 확장자별',
      columns: [
        { key: 'ext', label: '확장자' },
        { key: 'events', label: '추적', num: true, fmt: true },
      ],
      rows: Object.entries(byExt)
        .map(([ext, v]) => ({ ext, ...v }))
        .sort((a, b) => b.events - a.events)
        .slice(0, 20),
    },
    note: 'Cursor는 로컬에 토큰 수를 남기지 않습니다. Composer 코드 추적(DB)과 앱 실행 기록을 합쳐 표시합니다.',
    raw: { byDay, byModel, byExt, codeEvents, conversations, requests, lastActivity, trackingDb },
  });
}

async function collectAntigravity(ctx) {
  const available = existsSync(ANTIGRAVITY_HOME) || existsSync(join(HOME, '.agy'));
  const runs = appRunsFor('antigravity', ctx.app);
  const byDay = {};
  for (const r of runs.runs) {
    const day = dayOf(r.started_at || 0);
    const b = byDay[day] ??= { runs: 0, completed: 0, failed: 0 };
    b.runs++;
    if (r.status === 'completed') b.completed++;
    if (r.status === 'failed') b.failed++;
  }
  const byModel = {};
  for (const r of runs.runs) {
    const model = r.model || '기본';
    const b = byModel[model] ??= { runs: 0, completed: 0, failed: 0 };
    b.runs++;
    if (r.status === 'completed') b.completed++;
    if (r.status === 'failed') b.failed++;
  }
  return providerShell({
    id: 'antigravity',
    label: 'Antigravity',
    available: available || runs.total > 0,
    account: ctx.accounts.antigravity,
    headline: {
      label: 'Antigravity 앱 실행',
      value: runs.total,
      detail: `완료 ${runs.byStatus.completed || 0} · 실패 ${runs.byStatus.failed || 0}`,
    },
    chart: {
      title: 'Antigravity — 날짜별 앱 실행',
      seriesLabel: '실행',
      points: Object.entries(byDay).sort().map(([day, b]) => ({
        label: day,
        value: b.runs,
        tip: [`실행 ${b.runs}회`, `완료 ${b.completed}`, `실패 ${b.failed}`],
      })),
    },
    modelTable: {
      title: 'Antigravity 모델별 앱 실행',
      columns: [
        { key: 'model', label: '모델' },
        { key: 'runs', label: '실행', num: true },
        { key: 'completed', label: '완료', num: true },
        { key: 'failed', label: '실패', num: true },
      ],
      rows: Object.entries(byModel).map(([model, v]) => ({ model, ...v })),
    },
    note: available
      ? '로컬 Antigravity 토큰 로그가 없어 앱 실행 기록 중심으로 표시합니다. 데이터 소스가 생기면 같은 provider 슬롯에 붙이면 됩니다.'
      : '아직 로컬 설치/실행 기록이 없습니다. 이후 추가되는 AI도 이 자리처럼 provider로 등록됩니다.',
    raw: { byDay, byModel, runs },
  });
}

/** 새 AI는 여기 한 줄만 추가하면 API·UI에 자동 반영됩니다. */
const PROVIDERS = [
  { id: 'claude', collect: collectClaude },
  { id: 'codex', collect: collectCodex },
  { id: 'cursor', collect: collectCursor },
  { id: 'antigravity', collect: collectAntigravity },
];

function appData() {
  const dbPath = join(APP_DIR, 'state.db');
  if (!existsSync(dbPath)) return { available: false, runs: [], conversations: [] };
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (err) {
    return { available: false, runs: [], conversations: [], error: String(err?.message ?? err) };
  }
  try {
    const runs = db.prepare(`SELECT task_id, conversation_id, agent, model, status, started_at, finished_at, duration_ms, error_summary
                             FROM agent_runs ORDER BY started_at DESC`).all();
    const stateRow = db.prepare(`SELECT value FROM app_state WHERE key = 'ui.local_storage.v1'`).get();
    let conversations = [], selectedModel = null, character = null;
    if (stateRow) {
      const ls = JSON.parse(stateRow.value);
      const history = ls['ai-character-chat-history-v1'] ? JSON.parse(ls['ai-character-chat-history-v1']) : { conversations: [] };
      selectedModel = ls['ai-character-model'] ?? null;
      character = ls['selected-live2d-name'] ?? null;
      conversations = history.conversations.map((c) => ({
        id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt,
        userMessages: c.messages.filter((m) => m.role === 'user').length,
        assistantMessages: c.messages.filter((m) => m.role === 'assistant').length,
        characters: c.messages.reduce((n, m) => n + (m.content?.length ?? 0), 0),
      }));
    }
    return { available: true, runs, conversations, selectedModel, character };
  } catch (err) {
    return { available: false, runs: [], conversations: [], error: String(err?.message ?? err) };
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

async function keyStatus() {
  const names = { GEMINI_API_KEY: 'Gemini API', OPENAI_API_KEY: 'OpenAI API', JINA_API_KEY: 'Jina 검색' };
  const file = join(APP_DIR, 'keys.env');
  const configured = {};
  if (existsSync(file)) {
    for (const line of (await readFile(file, 'utf8')).split('\n')) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/);
      const v = m && names[m[1]] ? m[2].trim().replace(/^["']|["']$/g, '') : '';
      if (v) configured[m[1]] = '…' + v.slice(-4);
    }
  }
  return Object.entries(names).map(([env, label]) => ({ env, label, configured: !!configured[env], hint: configured[env] ?? null }));
}

async function accountInfo() {
  const claudeFile = process.env.CLAUDE_CONFIG_DIR ? join(CLAUDE_HOME, '.claude.json') : join(HOME, '.claude.json');
  const o = (await readJson(claudeFile))?.oauthAccount;
  const claude = o ? {
    source: claudeFile, email: o.emailAddress ?? null, name: o.displayName ?? o.fullName ?? null,
    organization: o.organizationName ?? null, plan: o.organizationType ?? null, role: o.organizationRole ?? null,
  } : { source: claudeFile, email: null };

  const codexFile = join(CODEX_HOME, 'auth.json');
  const auth = await readJson(codexFile);
  let codex = { source: codexFile, email: null };
  if (auth?.tokens?.id_token) {
    try {
      const jwt = JSON.parse(Buffer.from(auth.tokens.id_token.split('.')[1], 'base64url').toString('utf8'));
      const oa = jwt['https://api.openai.com/auth'] ?? {};
      codex = {
        source: codexFile, mode: auth.auth_mode ?? 'chatgpt', email: jwt.email ?? null, name: jwt.name ?? null,
        loginWith: jwt.auth_provider ?? null, plan: oa.chatgpt_plan_type ?? null,
        accountId: auth.tokens.account_id ?? oa.chatgpt_account_id ?? null,
      };
    } catch { /* 토큰 형식이 다르면 이메일 없이 표시 */ }
  } else if (auth?.OPENAI_API_KEY) {
    codex = { source: codexFile, mode: 'apikey', email: null, keyHint: '…' + auth.OPENAI_API_KEY.slice(-4) };
  }

  const cursorFile = join(CURSOR_HOME, 'cli-config.json');
  const cursorCfg = await readJson(cursorFile);
  const ai = cursorCfg?.authInfo;
  const cursor = ai ? {
    source: cursorFile,
    email: ai.email ?? null,
    name: ai.displayName ?? null,
    userId: ai.userId ?? null,
    plan: ai.membershipType ?? ai.subscriptionStatus ?? null,
  } : { source: cursorFile, email: null };

  const agyCandidates = [
    join(ANTIGRAVITY_HOME, 'auth.json'),
    join(HOME, '.agy', 'auth.json'),
  ];
  let antigravity = { source: agyCandidates[0], email: null };
  for (const file of agyCandidates) {
    const data = await readJson(file);
    if (!data) continue;
    antigravity = {
      source: file,
      email: data.email ?? data.user?.email ?? null,
      name: data.name ?? data.user?.name ?? null,
      plan: data.plan ?? null,
    };
    break;
  }

  return { claude, codex, cursor, antigravity };
}

async function snapshot() {
  const [keys, accounts, app] = await Promise.all([keyStatus(), accountInfo(), Promise.resolve(appData())]);
  const ctx = { app, accounts, keys };
  const providers = [];
  for (const def of PROVIDERS) {
    try {
      providers.push(await def.collect(ctx));
    } catch (err) {
      providers.push(providerShell({
        id: def.id,
        label: def.id,
        available: false,
        account: accounts?.[def.id] ?? { email: null },
        headline: { label: `${def.id} 오류`, value: 0, detail: String(err?.message ?? err) },
        note: `이 provider를 읽는 중 오류가 났습니다: ${String(err?.message ?? err)}`,
      }));
    }
  }

  // 하위 호환: 예전 필드 유지 (selftest / 외부 스크립트)
  const claudeP = providers.find((p) => p.id === 'claude');
  const codexP = providers.find((p) => p.id === 'codex');
  return {
    generatedAt: Date.now(),
    appDir: APP_DIR,
    app,
    keys,
    accounts,
    providers,
    providerIds: providers.map((p) => p.id),
    claude: {
      available: claudeP?.available,
      ...(claudeP?.raw ?? {}),
    },
    codex: {
      available: codexP?.available,
      ...(codexP?.raw ?? {}),
    },
  };
}

createServer(async (req, res) => {
  try {
    // 로컬호스트 외 Host 요청 거부 (실수로 외부 공개된 경우 보호)
    const host = String(req.headers.host ?? '').split(':')[0].toLowerCase();
    if (host && host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]') {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Forbidden: local only');
      return;
    }

    if (req.url === '/api/usage') {
      const payload = JSON.stringify(await snapshot());
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(payload);
    }
    if (req.url === '/' || req.url === '/index.html') {
      const html = await readFile(join(HERE, 'public', 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    res.writeHead(404).end('not found');
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    }
    try { res.end(String(err?.message ?? err)); } catch { /* ignore */ }
  }
}).on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`포트 ${PORT}을(를) 이미 다른 프로그램이 쓰고 있습니다.`);
    console.error(`  이미 켜 둔 대시보드라면 그대로 http://localhost:${PORT} 을 여세요.`);
    console.error(`  끄려면: lsof -ti tcp:${PORT} | xargs kill`);
    console.error(`  다른 포트로 켜려면: PORT=4319 node server.mjs`);
    process.exit(1);
  }
  throw err;
}).listen(PORT, '127.0.0.1', () => console.log(`사용량 대시보드: http://localhost:${PORT}  (끄려면 Ctrl+C)`));
