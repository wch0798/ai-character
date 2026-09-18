// 대시보드 동작 확인: 임시 포트로 서버를 띄우고 페이지와 API를 검사한 뒤 종료합니다.
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 4399;
const TOKEN = 'selftest-usage-token';
const server = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'server.mjs')], {
  env: { ...process.env, PORT: String(PORT), AI_CHARACTER_USAGE_TOKEN: TOKEN },
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
} catch (err) {
  check('실행', false, err.message);
} finally {
  server.kill();
}
console.log(failed ? `\n${failed}개 실패` : '\n모두 통과');
process.exit(failed ? 1 : 0);
