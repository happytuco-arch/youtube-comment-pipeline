// 댓글 파이프라인의 핵심 로직. 브라우저(index.html)와 Node(cli.js)가 같은 파일을 씁니다.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Pipeline = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // ───── 설정값 (숫자는 이름 붙인 상수로) ─────
  const MIN_LENGTH = 2;          // 이보다 짧은 댓글은 정제 단계에서 제외
  const SPAM_LINK_LIMIT = 1;     // 링크가 이 개수 이상이면 스팸
  const REPEAT_CHAR_LIMIT = 6;   // 같은 글자가 이만큼 연속되면 스팸

  const CATEGORIES = ['질문', '칭찬', '불만', '스팸', '악성', '일반'];
  const HIDDEN = ['스팸', '악성'];

  const RULES = {
    악성: [/꺼져/, /병신|ㅂㅅ|시발|씨발|ㅅㅂ|좆|개새/, /죽어/, /쓰레기/],
    스팸: [/구독\s*(반사|맞구독)/, /수익|부업|코인|카톡\s*문의|텔레/, /제\s*채널/],
    질문: [/\?|？/, /(어디|언제|어떻게|뭐|무슨|몇|얼마|있나요|되나요|인가요|할까요|궁금)/],
    불만: [/별로|실망|아쉽|불편|비싸|느리|최악|짜증|환불|광고\s*너무/],
    칭찬: [/좋아요|좋네|최고|대박|맛있|감사|사랑|멋져|예뻐|굿|👍|❤|잘\s*봤|힐링/],
  };

  // '작성자 | 댓글' 또는 '댓글' 한 줄씩
  function parse(textBlock) {
    return textBlock.split('\n').map(l => l.trim()).filter(Boolean).map(line => {
      const i = line.indexOf('|');
      return i > -1
        ? { author: line.slice(0, i).trim(), text: line.slice(i + 1).trim() }
        : { author: '', text: line };
    });
  }

  function clean(raw) {
    const seen = new Set();
    let dup = 0, short = 0;
    const kept = raw.filter(c => {
      const t = c.text.replace(/\s+/g, ' ');
      // 'ㅋㅋㅋ'처럼 웃음 자모만 있는 댓글도 내용이 없는 것으로 본다
      if (t.replace(/[ㄱ-ㅎㅏ-ㅣ]/g, '').replace(/[^\p{L}\p{N}]/gu, '').length < MIN_LENGTH) { short++; return false; }
      const key = (c.author + '|' + t).toLowerCase();
      if (seen.has(key)) { dup++; return false; }
      seen.add(key);
      return true;
    });
    return { kept, dup, short };
  }

  // 규칙 기반 분류기. 운영 시 이 함수만 LLM 호출로 바꾸면 된다.
  function classify(text) {
    const links = (text.match(/https?:\/\//gi) || []).length;
    if (RULES.악성.some(r => r.test(text))) return { cat: '악성', why: '욕설·공격 표현' };
    if (links >= SPAM_LINK_LIMIT || RULES.스팸.some(r => r.test(text))) return { cat: '스팸', why: '링크·홍보 문구' };
    const repeat = new RegExp(`(.)\\1{${REPEAT_CHAR_LIMIT - 1},}`);
    if (repeat.test(text.replace(/[ㅋㅎㅠㅜ!.~]/g, ''))) return { cat: '스팸', why: '같은 글자 반복' };
    if (RULES.질문.some(r => r.test(text))) return { cat: '질문', why: '물음표·의문 표현' };
    if (RULES.불만.some(r => r.test(text))) return { cat: '불만', why: '부정 표현' };
    if (RULES.칭찬.some(r => r.test(text))) return { cat: '칭찬', why: '긍정 표현' };
    return { cat: '일반', why: '해당 규칙 없음' };
  }

  // 톤 규칙: 짧게, 존댓말, 이름 부르기, 약속은 하지 않기
  function draft(c, channel) {
    const who = c.author ? `${c.author}님` : '시청자님';
    switch (c.cat) {
      case '질문': return `${who}, 좋은 질문 감사합니다! 확인해서 고정 댓글이나 다음 영상 설명란에 정리해 둘게요. — ${channel}`;
      case '칭찬': return `${who}, 따뜻한 말씀 감사합니다 😊 다음 영상도 재미있게 준비할게요!`;
      case '불만': return `${who}, 솔직한 의견 감사합니다. 말씀하신 부분 팀에서 꼭 살펴보겠습니다.`;
      case '일반': return `${who}, 댓글 남겨 주셔서 감사해요!`;
      default: return ''; // 스팸·악성은 답글 없음
    }
  }

  function run(raw, channel) {
    const { kept, dup, short } = clean(raw);
    const comments = kept.map((c, i) => {
      const item = { id: i + 1, ...c, ...classify(c.text) };
      item.reply = draft(item, channel);
      item.status = HIDDEN.includes(item.cat) ? '숨김' : '보류';
      return item;
    });
    return { comments, total: raw.length, dup, short };
  }

  function toCsv(comments) {
    const q = v => `"${String(v).replace(/"/g, '""')}"`;
    return ['id,작성자,댓글,분류,근거,답글초안,상태',
      ...comments.map(c => [c.id, c.author, c.text, c.cat, c.why, c.reply, c.status].map(q).join(','))].join('\n');
  }

  const SAMPLES = `민지 | 이 카페 위치가 어디인가요? 주말에도 여나요?
커피러버 | 영상 분위기 너무 좋아요 힐링됩니다 ❤
ㅇㅇ | 라떼 가격이 너무 비싸네요 좀 실망
부업왕 | 하루 30분 부업으로 월 300 버는 법 https://bit.ly/xxxx
지훈 | 원두는 어디서 구매하시나요?
커피러버 | 영상 분위기 너무 좋아요 힐링됩니다 ❤
익명 | 꺼져 이런 영상 왜 올림
소라 | 브금 정보 알 수 있을까요?
맞구독해요 | 구독 반사 해요~ 제 채널도 와주세요
하늘 | 오늘도 잘 봤습니다 최고!
도윤 | 중간에 광고 너무 길어서 불편했어요
.
수아 | 다음엔 디저트 메뉴도 보여주세요
ㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋ
태오 | 바리스타님 손이 진짜 빠르시네요 대박`;

  return { CATEGORIES, HIDDEN, MIN_LENGTH, parse, clean, classify, draft, run, toCsv, SAMPLES };
});
