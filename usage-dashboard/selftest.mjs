// 대시보드 동작 확인: 임시 포트로 서버를 띄우고 페이지와 API를 검사한 뒤 종료합니다.
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const PORT = 4399;
const TOKEN = 'selftest-usage-token';
const ledgerDir = mkdtempSync(join(tmpdir(), 'aic-ledger-'));
const ledgerDb = join(ledgerDir, 'state.db');
{
  const db = new DatabaseSync(ledgerDb);
  const now = Date.now();
  db.exec(`CREATE TABLE api_usage (provider TEXT, model TEXT, cost_class TEXT, input_tokens INTEGER, output_tokens INTEGER,
      cached_tokens INTEGER, cost_usd REAL, estimated_paid_usd REAL, latency_ms INTEGER, retries INTEGER, cache_hit INTEGER,
      status TEXT, created_at INTEGER);
    CREATE TABLE paid_approvals (id INTEGER PRIMARY KEY, provider TEXT, session_id TEXT, reason TEXT, approved INTEGER,
      max_calls INTEGER, used_calls INTEGER, created_at INTEGER, expires_at INTEGER);
    CREATE TABLE test_results (agent TEXT, passed INTEGER, created_at INTEGER);
    CREATE TABLE update_history (id INTEGER PRIMARY KEY, category TEXT, target TEXT, from_version TEXT, to_version TEXT,
      status TEXT, message TEXT, created_at INTEGER);
    CREATE TABLE scheduled_jobs (id TEXT, title TEXT, kind TEXT, interval_minutes INTEGER, enabled INTEGER, last_run_at INTEGER, last_status TEXT);`);
  const usage = db.prepare(`INSERT INTO api_usage VALUES (?, ?, ?, 10, 5, 0, ?, ?, 100, 0, 0, ?, ?)`);
  usage.run('gemini_api', 'gemini-2.5-flash', 'free', 0, 0.5, 'ok', now);
  usage.run('openai_api', 'gpt-5', 'paid', 0.2, 0.2, 'error', now);
  db.prepare(`INSERT INTO paid_approvals VALUES (1, 'risky_action', NULL, ?, 0, 0, 0, ?, ?)`)
    .run('대량 삭제 적용: key sk-abcdefghijklmnopqrstuvwxyz', now, now);
  db.prepare(`INSERT INTO test_results VALUES ('codex', 1, ?), ('codex', 0, ?)`).run(now, now);
  db.prepare(`INSERT INTO update_history VALUES (1, 'cli', 'claude', '1.0', '1.1', 'updated', ?, ?)`)
    .run('auth Bearer abcdefghijklmnop github_pat_11ABCDEFGHIJKLMNOPQRSTUV GITHUB_TOKEN=plainsecret123', now);
  db.prepare(`INSERT INTO scheduled_jobs VALUES ('daily-report', '일일 변경 보고서', 'usage_report', 1440, 1, NULL, NULL)`).run();
  db.close();
}
const keysFile = join(ledgerDir, 'keys.env');
writeFileSync(keysFile, '# test\nOPENROUTER_API_KEY=sk-or-v1-selftestselftestselftest\nGEMINI_API_KEY=\n');
const server = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'server.mjs')], {
  env: {
    ...process.env,
    PORT: String(PORT),
    AI_CHARACTER_USAGE_TOKEN: TOKEN,
    AI_CHARACTER_STATE_DB: ledgerDb,
    AI_CHARACTER_KEYS_FILE: keysFile,
  },
  stdio: ['ignore', 'pipe', 'inherit'],
});
let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '통과' : '실패'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed++;
};

try {
  await new Promise((ok, fail) => {
    server.stdout.on('data', (d) => d.toString().includes('http://') && ok());
    server.on('exit', (code) => fail(new Error(`서버가 시작되지 않았습니다 (종료 코드 ${code})`)));
    setTimeout(() => fail(new Error('서버 시작 시간 초과')), 10000);
  });
  const base = `http://127.0.0.1:${PORT}`;

  const page = await fetch(base + '/');
  check('페이지 열림', page.status === 200, `HTTP ${page.status}`);

  const denied = await fetch(base + '/api/usage');
  check('토큰 없으면 API 거부', denied.status === 401, `HTTP ${denied.status}`);
  check('CORS * 없음', denied.headers.get('access-control-allow-origin') !== '*');
  check('쿼리 토큰은 API에서 거부', (await fetch(`${base}/api/usage?t=${TOKEN}`)).status === 401);

  const auth = await fetch(`${base}/auth?t=${TOKEN}`, { redirect: 'manual' });
  check('auth 부트스트랩 리다이렉트', auth.status === 302, `HTTP ${auth.status}`);
  const cookie = String(auth.headers.get('set-cookie') || '');
  check('auth 쿠키 설정', cookie.includes('ai_character_usage='));

  const viaCookie = await fetch(base + '/api/usage', { headers: { Cookie: `ai_character_usage=${TOKEN}` } });
  check('쿠키 토큰으로 API 허용', viaCookie.status === 200, `HTTP ${viaCookie.status}`);

  const cross = await fetch(base + '/api/usage', {
    headers: { Origin: 'https://evil.example', 'X-AI-Character-Token': TOKEN },
  });
  check('외부 Origin 거부', cross.status === 403, `HTTP ${cross.status}`);

  const res = await fetch(base + '/api/usage', {
    headers: { 'X-AI-Character-Token': TOKEN },
  });
  check('API 응답', res.status === 200, `HTTP ${res.status}`);
  const text = await res.text();
  const data = JSON.parse(text);
  check('앱 데이터', data.app && (!data.app.error || Array.isArray(data.app.runs)), data.app?.error ?? '');
  check('Claude 사용량', !!data.claude);
  check('Codex 사용량', !!data.codex);
  check('providers 배열', Array.isArray(data.providers) && data.providers.length >= 4, `${data.providers?.length ?? 0}개`);
  const ids = (data.providers || []).map((p) => p.id);
  check('Cursor provider', ids.includes('cursor'));
  check('Antigravity provider', ids.includes('antigravity'));
  check('provider headline', data.providers.every((p) => p.headline && p.label));
  check('키 상태 목록', Array.isArray(data.keys), `${data.keys?.length ?? 0}개, 설정됨: ${data.keys?.filter((k) => k.configured).map((k) => k.label).join(', ') || '없음'}`);
  check('계정은 연결 여부만', data.accounts?.claude && data.accounts.claude.connected !== undefined && data.accounts.claude.email == null);
  check('키 끝자리 없음', (data.keys || []).every((k) => !k.hint));
  check('앱 경로 없음', !data.appDir);
  check('로그인 토큰이 응답에 없음', !/eyJ[A-Za-z0-9_-]{20,}|access_token|refresh_token|id_token/.test(text));
  check('키 값이 응답에 없음', !/sk-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{20,}/.test(text));
  const ledger = data.ledger || {};
  check('사용량 장부', ledger.available === true, ledger.error ?? '');
  check('실제 청구 비용 분리', Math.abs((ledger.totals?.billedUsd ?? -1) - 0.2) < 1e-9, String(ledger.totals?.billedUsd));
  check('절감 추정치 분리', Math.abs((ledger.totals?.estimatedSavingsUsd ?? -1) - 0.5) < 1e-9, String(ledger.totals?.estimatedSavingsUsd));
  check('모델별 성공률', ledger.models?.find((m) => m.model === 'gpt-5')?.successRate === 0);
  check('테스트 통과율', ledger.totals?.testPassRate === 50);
  check('승인 내역 마스킹', ledger.approvals?.[0]?.reason?.includes('sk-***'));
  check('업데이트 이력', ledger.updates?.[0]?.target === 'claude');
  const updateMessage = String(ledger.updates?.[0]?.message ?? '');
  check('Bearer·PAT·KEY=값 마스킹', !/abcdefghijklmnop|github_pat_11|plainsecret123/.test(updateMessage), updateMessage);
  const openrouter = (data.keys || []).find((k) => k.env === 'OPENROUTER_API_KEY');
  check('앱 키 파일 경로 사용', openrouter?.configured === true && (data.keys || []).length === 6);
  check('키 파일 값이 응답에 없음', !text.includes('selftestselftest'));
  check('예약 작업', ledger.jobs?.[0]?.id === 'daily-report');
} catch (err) {
  check('실행', false, err.message);
} finally {
  server.kill();
  rmSync(ledgerDir, { recursive: true, force: true });
}
console.log(failed ? `\n${failed}개 실패` : '\n모두 통과');
process.exit(failed ? 1 : 0);
