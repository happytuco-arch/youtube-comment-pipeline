#!/usr/bin/env node
// 명령줄 실행기. 유튜브 영상 댓글을 받아 분류·답글 초안을 만들고 CSV/JSON으로 저장합니다.
//
//   node cli.js                         샘플 댓글로 실행
//   node cli.js --file comments.txt     파일(한 줄에 댓글 하나)로 실행
//   node cli.js --video <영상ID 또는 URL> 실제 유튜브 댓글로 실행 (YOUTUBE_API_KEY 필요)
//
// 옵션: --channel 이름, --max 개수(기본 100), --out 폴더(기본 output)
const fs = require('fs');
const path = require('path');
const P = require('./src/pipeline.js');

const DEFAULT_MAX = 100;          // 유튜브에서 가져올 최대 댓글 수
const API_PAGE_SIZE = 100;        // commentThreads.list 한 번에 받을 수 있는 최대치

function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return o;
}

function loadEnv() {
  const f = path.join(__dirname, '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

function videoId(v) {
  const m = String(v).match(/(?:v=|youtu\.be\/|shorts\/)([\w-]{11})/);
  return m ? m[1] : v;
}

async function fetchYoutube(id, max, key) {
  const out = [];
  let pageToken = '';
  while (out.length < max) {
    const url = new URL('https://www.googleapis.com/youtube/v3/commentThreads');
    url.search = new URLSearchParams({
      part: 'snippet', videoId: id, key, textFormat: 'plainText', order: 'time',
      maxResults: String(Math.min(API_PAGE_SIZE, max - out.length)),
      ...(pageToken && { pageToken }),
    });
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) throw new Error(`YouTube API 오류 (${res.status}): ${data.error?.message || '알 수 없음'}`);
    for (const t of data.items) {
      const s = t.snippet.topLevelComment.snippet;
      out.push({ author: s.authorDisplayName.replace(/^@/, ''), text: s.textOriginal.replace(/\s*\n\s*/g, ' ') });
    }
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

async function main() {
  loadEnv();
  const o = args(process.argv.slice(2));
  const channel = o.channel || '내 채널';
  let raw, source;

  if (o.video) {
    const key = process.env.YOUTUBE_API_KEY;
    if (!key) throw new Error('YOUTUBE_API_KEY 가 없습니다. .env.example 을 .env 로 복사해 키를 넣어 주세요.');
    const id = videoId(o.video);
    raw = await fetchYoutube(id, Number(o.max) || DEFAULT_MAX, key);
    source = `유튜브 영상 ${id}`;
  } else if (o.file) {
    raw = P.parse(fs.readFileSync(o.file, 'utf8'));
    source = o.file;
  } else {
    raw = P.parse(P.SAMPLES);
    source = '샘플 댓글';
  }

  const r = P.run(raw, channel);
  const outDir = o.out || path.join(__dirname, 'output');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'comments.csv'), '﻿' + P.toCsv(r.comments));
  fs.writeFileSync(path.join(outDir, 'comments.json'), JSON.stringify(r.comments, null, 2));

  console.log(`\n[수집] ${source}: ${r.total}개`);
  console.log(`[정제] 중복 ${r.dup}개, 짧은 댓글 ${r.short}개 제외 → ${r.comments.length}개`);
  console.log('[분류] ' + P.CATEGORIES.map(c => `${c} ${r.comments.filter(x => x.cat === c).length}`).join(' · '));
  console.log('\n[답글 초안 — 검토 필요]');
  for (const c of r.comments) {
    console.log(`  (${c.cat}) ${c.author || '익명'}: ${c.text.slice(0, 40)}`);
    console.log(c.reply ? `     ↳ ${c.reply}` : '     ↳ 숨김 처리 권장');
  }
  console.log(`\n[저장] ${path.join(outDir, 'comments.csv')}, comments.json`);
}

main().catch(e => { console.error('오류:', e.message); process.exit(1); });
