#!/usr/bin/env node
// 게시 단계. output/comments.json 에서 사람이 '승인'한 답글만 유튜브에 답니다.
//
//   node post.js                  미리보기 — 무엇을 올릴지 보여주기만 함 (기본)
//   node post.js --yes            실제로 답글 게시
//   node post.js --yes --hide     + '숨김' 댓글을 검토 대기(heldForReview)로 돌림 (내 채널 영상만 가능)
//   node post.js --logout         저장된 로그인 지우기
//
// 처음 --yes 로 실행하면 브라우저로 Google 로그인 화면을 엽니다(채널 주인 계정으로).
// 필요한 값: .env 의 GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET (README 참고)
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFile } = require('child_process');
const P = require('./src/pipeline.js');

const OAUTH_PORT = 53682;                 // 로그인 후 돌아올 로컬 주소의 포트
const POST_DELAY_MS = 1500;               // 답글 사이 간격 (스팸 판정·할당량 보호)
const MAX_POSTS_PER_RUN = 50;             // 한 번에 올릴 최대 답글 수 (할당량: 답글 1개 = 50 unit)
const SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';
const TOKEN_FILE = path.join(__dirname, '.token.json');   // .gitignore 에 포함
const REDIRECT = `http://127.0.0.1:${OAUTH_PORT}/callback`;

function loadEnv() {
  const f = path.join(__dirname, '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  execFile(cmd[0], cmd[1], () => {});
}

async function tokenRequest(params) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`로그인 토큰 오류: ${data.error_description || data.error}`);
  return data;
}

// 설치형 앱용 OAuth(루프백 + PKCE). 받은 refresh_token 은 .token.json 에 저장해 다음부터 재사용
async function login(clientId, clientSecret) {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(16).toString('hex');
  const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: clientId, redirect_uri: REDIRECT, response_type: 'code', scope: SCOPE,
    access_type: 'offline', prompt: 'consent', state, code_challenge: challenge, code_challenge_method: 'S256',
  });

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, REDIRECT);
      if (u.pathname !== '/callback') { res.writeHead(404).end(); return; }
      const ok = u.searchParams.get('state') === state && u.searchParams.get('code');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        .end(ok ? '<h2>로그인 완료. 이 창을 닫고 터미널로 돌아가세요.</h2>' : '<h2>로그인 실패</h2>');
      server.close();
      ok ? resolve(u.searchParams.get('code')) : reject(new Error(u.searchParams.get('error') || '로그인 상태값 불일치'));
    }).listen(OAUTH_PORT, '127.0.0.1', () => {
      console.log('\n브라우저에서 Google 로그인을 진행하세요. 창이 안 열리면 아래 주소를 직접 여세요:\n' + url + '\n');
      openBrowser(url);
    });
    server.on('error', reject);
  });

  const t = await tokenRequest({
    code, client_id: clientId, client_secret: clientSecret, redirect_uri: REDIRECT,
    grant_type: 'authorization_code', code_verifier: verifier,
  });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({ refresh_token: t.refresh_token }, null, 2));
  return t.access_token;
}

async function accessToken() {
  const id = process.env.GOOGLE_CLIENT_ID, secret = process.env.GOOGLE_CLIENT_SECRET;
  if (!id || !secret) throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET 가 .env 에 없습니다. README 의 "게시 설정"을 보세요.');
  if (fs.existsSync(TOKEN_FILE)) {
    const { refresh_token } = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    if (refresh_token) {
      try {
        return (await tokenRequest({ refresh_token, client_id: id, client_secret: secret, grant_type: 'refresh_token' })).access_token;
      } catch { console.log('저장된 로그인이 만료되어 다시 로그인합니다.'); }
    }
  }
  return login(id, secret);
}

async function yt(token, method, endpoint, query, body) {
  const url = `https://www.googleapis.com/youtube/v3/${endpoint}?` + new URLSearchParams(query);
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body && { 'Content-Type': 'application/json' }) },
    body: body && JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`(${res.status}) ${data.error?.message || '알 수 없는 오류'}`);
  return data;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  loadEnv();
  const argv = process.argv.slice(2);
  const has = f => argv.includes(f);
  const fileArg = argv.indexOf('--file');
  const file = fileArg > -1 ? argv[fileArg + 1] : path.join(__dirname, 'output', 'comments.json');

  if (has('--logout')) { fs.rmSync(TOKEN_FILE, { force: true }); console.log('로그인 정보를 지웠습니다.'); return; }
  if (!fs.existsSync(file)) throw new Error(`${file} 가 없습니다. 먼저 node cli.js --video <영상> 을 실행하세요.`);

  const comments = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { reply, hide } = P.plan(comments);
  const toPost = reply.slice(0, MAX_POSTS_PER_RUN);
  const noId = comments.filter(c => c.status === '승인' && !c.commentId).length;

  console.log(`\n[게시 계획] 답글 ${toPost.length}개` + (has('--hide') ? `, 숨김 ${hide.length}개` : ''));
  if (reply.length > MAX_POSTS_PER_RUN) console.log(`  (한 번에 ${MAX_POSTS_PER_RUN}개까지. 나머지는 다시 실행하면 이어서 올립니다)`);
  if (noId) console.log(`  유튜브 댓글 ID 가 없는 승인 항목 ${noId}개는 건너뜁니다(샘플·파일 입력).`);
  for (const c of toPost) console.log(`  → ${c.author}: ${c.text.slice(0, 30)}\n     ↳ ${c.reply}`);
  if (has('--hide')) for (const c of hide) console.log(`  ✕ 숨김: ${c.author}: ${c.text.slice(0, 30)}`);

  if (!has('--yes')) { console.log('\n미리보기만 했습니다. 실제로 올리려면: node post.js --yes'); return; }
  if (!toPost.length && !(has('--hide') && hide.length)) { console.log('\n올릴 것이 없습니다.'); return; }

  const token = await accessToken();
  let ok = 0, fail = 0;
  for (const c of toPost) {
    try {
      const r = await yt(token, 'POST', 'comments', { part: 'snippet' },
        { snippet: { parentId: c.commentId, textOriginal: c.reply } });
      c.postedId = r.id; c.postedAt = new Date().toISOString(); c.status = '게시됨'; ok++;
      console.log(`  ✓ ${c.author}`);
    } catch (e) { c.error = e.message; fail++; console.log(`  ✗ ${c.author}: ${e.message}`); }
    fs.writeFileSync(file, JSON.stringify(comments, null, 2));   // 중간에 멈춰도 중복 게시 안 되게 매번 저장
    await sleep(POST_DELAY_MS);
  }
  if (has('--hide') && hide.length) {
    try {
      await yt(token, 'POST', 'comments/setModerationStatus', { id: hide.map(c => c.commentId).join(','), moderationStatus: 'heldForReview' });
      hide.forEach(c => { c.hiddenAt = new Date().toISOString(); });
      console.log(`  ✓ 숨김 ${hide.length}개 (YouTube Studio → 댓글 → 검토 대기에서 확인)`);
    } catch (e) { console.log(`  ✗ 숨김 실패: ${e.message} (내 채널 영상의 댓글만 숨길 수 있습니다)`); }
    fs.writeFileSync(file, JSON.stringify(comments, null, 2));
  }
  console.log(`\n[완료] 게시 ${ok}개, 실패 ${fail}개. 결과는 ${file} 에 기록했습니다.`);
}

main().catch(e => { console.error('오류:', e.message); process.exit(1); });
