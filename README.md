# 유튜브 댓글 자동화 파이프라인

## 실행 방법

**1) 웹 데모** — 설치 없이 `index.html`을 브라우저로 열거나, GitHub Pages 주소로 접속합니다.

**2) 명령줄 (Node 18 이상, 설치할 패키지 없음)**

```bash
npm start                                   # 샘플 댓글로 실행
node cli.js --file my-comments.txt          # 파일(한 줄에 '작성자 | 댓글')로 실행
node cli.js --video https://youtu.be/영상ID --channel "내 채널" --max 200
npm test                                    # 테스트 8개
```

실제 유튜브 댓글을 받으려면 Google Cloud Console에서 **YouTube Data API v3**를 켜고 API 키를 만든 뒤,
`.env.example`을 `.env`로 복사해 `YOUTUBE_API_KEY=` 뒤에 넣습니다. `.env`는 git에 올라가지 않습니다.
결과는 `output/comments.csv`, `output/comments.json`에 저장됩니다.

## 답글 게시 (post.js)

```bash
node cli.js --video https://youtu.be/영상ID --approve 질문,칭찬   # 수집·분류, 질문·칭찬 초안은 승인 상태로
#  → output/comments.json 을 열어 답글을 고치거나 status 를 "승인" / "보류" 로 조정
node post.js                # 미리보기: 무엇이 올라갈지만 보여줌
node post.js --yes          # 실제 게시 (첫 실행 때 브라우저에서 Google 로그인)
node post.js --yes --hide   # + 스팸·악성을 '검토 대기'로 숨김 (내 채널 영상만)
node post.js --logout       # 저장된 로그인 삭제
```

- `status`가 `"승인"`이고 실제 유튜브 댓글 ID가 있는 항목만 올립니다. 기본값은 미리보기이고, `--yes`를 붙여야 게시합니다.
- 올린 항목은 `comments.json`에 `postedId`가 기록되어, 다시 실행해도 같은 답글을 두 번 올리지 않습니다.
- 한 번에 최대 50개, 답글 사이 1.5초 간격. YouTube API 기본 할당량은 하루 10,000 unit이고 답글 1개가 50 unit입니다.

### 게시 설정 (처음 한 번)

1. [Google Cloud Console](https://console.cloud.google.com/)에서 프로젝트 → **YouTube Data API v3** 사용 설정
2. **OAuth 동의 화면** → 외부 / 테스트 모드 → 테스트 사용자에 채널 주인 Google 계정 추가
3. **사용자 인증 정보 → OAuth 클라이언트 ID → 데스크톱 앱** 생성
4. 받은 클라이언트 ID·보안 비밀을 `.env`의 `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`에 넣기

로그인 정보(refresh token)는 `.token.json`에 저장되며 git에 올라가지 않습니다. 테스트 모드에서는 7일마다 다시 로그인해야 합니다.

## 파일 구성

| 파일 | 역할 |
|---|---|
| `src/pipeline.js` | 정제·분류·답글 초안 로직 (웹과 명령줄이 함께 씀) |
| `index.html` | 사람 검토 화면 (승인/보류/숨김, 분류 수정, 내보내기) |
| `cli.js` | 유튜브 API 수집 + 일괄 처리 |
| `post.js` | 승인한 답글 게시 · 스팸 숨김 (OAuth) |
| `tests/pipeline.test.cjs` | 규칙 테스트 |

## 문제

작은 채널 운영자(예: 동네 카페 채널)는 댓글에 답하는 데 매일 시간을 씁니다. 질문은 묻히고,
스팸과 악성 댓글은 늦게 지워집니다.

## 파이프라인

| 단계 | 하는 일 | 데모에서 | 운영에서 |
|---|---|---|---|
| 1. 수집 | 영상의 댓글을 가져옴 | 붙여넣기 / 샘플 | YouTube Data API v3 `commentThreads.list` |
| 2. 정제 | 중복·빈 댓글 제거 | 작성자+내용 기준 중복, 2글자 미만 제외 | 동일 |
| 3. 분류 | 질문·칭찬·불만·스팸·악성·일반 | 규칙(정규식) 분류기, 근거 표시 | LLM 분류(아래 프롬프트) |
| 4. 답글 초안 | 유형별 톤으로 초안 작성 | 템플릿 | LLM 생성 |
| 5. 검토·게시 | 사람이 승인한 것만 게시, 악성·스팸은 숨김 | 승인/보류/숨김, 분류 수정, CSV·JSON 저장 | `post.js` — `comments.insert`, `comments.setModerationStatus` |

**사람 검토(Human-in-the-loop)를 빼지 않은 이유:** 자동 답글이 틀리면 채널 신뢰가 깎입니다.
자동화는 '초안과 분류'까지, 게시 결정은 사람이 합니다.

## 운영 전환 시 LLM 분류 프롬프트

```
너는 유튜브 채널 "{채널}"의 댓글 관리자다.
댓글을 질문/칭찬/불만/스팸/악성/일반 중 하나로 분류하고, 스팸·악성이 아니면 답글 초안을 쓴다.
규칙: 존댓말, 2문장 이내, 작성자 이름을 부른다, 확인되지 않은 약속(할인·일정)은 하지 않는다.
JSON으로만 답한다: {"category": "...", "reason": "...", "reply": "..."}
```

데모의 `classify()`와 `draft()` 두 함수만 이 호출로 바꾸면 나머지 단계는 그대로 씁니다.

## 한계

- 규칙 분류기는 반어법·신조어를 놓칩니다 → 사람이 분류를 고칠 수 있게 했습니다.
