const test = require('node:test');
const assert = require('node:assert');
const P = require('../src/pipeline.js');

test('작성자 | 댓글 형식을 나눈다', () => {
  assert.deepStrictEqual(P.parse('민지 | 안녕하세요\n그냥 댓글'), [
    { author: '민지', text: '안녕하세요' }, { author: '', text: '그냥 댓글' }]);
});

test('중복과 내용 없는 댓글을 거른다', () => {
  const r = P.clean(P.parse('a | 좋아요\na | 좋아요\n.\nㅋㅋㅋㅋㅋ'));
  assert.strictEqual(r.kept.length, 1);
  assert.strictEqual(r.dup, 1);
  assert.strictEqual(r.short, 2);
});

test('유형별로 분류한다', () => {
  const cases = {
    '위치가 어디인가요?': '질문',
    '정말 최고예요': '칭찬',
    '가격이 너무 비싸요': '불만',
    '여기 보세요 https://x.y': '스팸',
    '구독 반사 해요': '스팸',
    '꺼져라': '악성',
    '디저트도 보여주세요': '일반',
  };
  for (const [text, cat] of Object.entries(cases)) assert.strictEqual(P.classify(text).cat, cat, text);
});

test('스팸·악성은 답글 없이 숨김 상태가 된다', () => {
  const { comments } = P.run(P.parse('x | 꺼져\ny | 부업 문의 https://a.b\nz | 좋아요'), '채널');
  assert.deepStrictEqual(comments.map(c => c.status), ['숨김', '숨김', '보류']);
  assert.strictEqual(comments[0].reply, '');
  assert.ok(comments[2].reply.includes('z님'));
});

test('CSV는 따옴표를 이스케이프한다', () => {
  const csv = P.toCsv([{ id: 1, author: 'a', text: '그는 "좋다"', cat: '칭찬', why: '', reply: '', status: '보류' }]);
  assert.ok(csv.includes('"그는 ""좋다"""'));
});

test('샘플 15개 → 12개 처리', () => {
  const r = P.run(P.parse(P.SAMPLES), '채널');
  assert.strictEqual(r.total, 15);
  assert.strictEqual(r.comments.length, 12);
});
