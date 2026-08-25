# 법률 절차 길잡이 (legal-navigator-mcp) — 작업 규칙

생활법률 정보·절차·표준서식·법령·판례 안내 **MCP 서버**(원격, Streamable HTTP).
카카오 **AGENTIC PLAYER 10 본선 진출작** — ⏰개발 ~8/27, 대국민 투표 ~9/28,
이후 **카카오 툴즈 입점**(챗gpt 폴 카카오 안에서 실사용). 배포·등록값은 `SUBMISSION.md`.

**뭘 하는 서비스인지·경계는 `README.md`와 `BOUNDARIES.md`를 먼저 읽는다.**
⚠️ 개별 법률 자문 도구가 아니다. 정보·절차·서식·검증된 인용만 안내한다(declaw).

## 절대 규칙 — 이 레포의 정체성은 "검증"이다

1. **법령·판례 인용은 지어내지 않는다.** 응답은 3단으로만: ✅수록 확인 / ℹ️미수록 /
   ⚠️법령명 불특정 → 후보 제시. 모르면 모른다고 답하게 만든 구조를 깨지 말 것.
2. **조문 데이터를 고치면 반드시 `npm run audit:law`를 돌린다** — 법제처 원문과
   조문 258개 전수 대조. **하나라도 어긋나면 배포하지 않는다.** 이 원칙으로 오탐 4종
   (앞글자 매칭·모법/시행령 혼동·연도만 매칭·'제' 생략 시 미검증)을 잡은 전적이 있다.
3. ⛔ **판례DB 전수 수집·"환각 없는 AI" 표방은 하지 않는다** — 로앤컴퍼니와 싸우는
   자리가 아니다. 우리 자리는 상담원용 1차 도구·서식 실물·카톡 접근성.
4. 하급심 판례는 법제처 DB에 없다 — "없는 판례"가 아니라 **"이 방법으로는 확인이
   안 되는 판례"**로 표시한다(UNCERTAIN 유보). 확인 안 된 걸 맞다고 바꾸지 말 것.

## 명령어

```bash
npm run dev          # tsx watch src/server.ts
npm run build        # tsc → dist/
npm run typecheck
npm test             # vitest
npm run audit:law    # ★ 조문 258개 법제처 전수 대조 (데이터 변경 시 필수)
npm run audit:links  # 링크 생존 확인
```

## 폴더

```
src/server.ts     MCP 서버 본체 (도구 등록·라우팅)
src/lawapi.ts     법제처 API 연동 — factagora-legal-demo도 이 코드를 재사용했다
src/citation.ts   인용 검증 (위 3단 구조의 구현)
src/formfile.ts · formlayout.ts · hwpx.ts   표준서식 생성 (HWPX)
src/data/         분야·주제·절차 데이터 (57분야 259주제)
scripts/verify-statutes.ts   audit:law의 실체
audit/            검증 결과 기록
```

## 관련 레포·주의

- 웹 상담창은 **별도 워커**(`legal-navigator-chat`), 웹은 `legal-navigator-web` — 여기 아님
- ⚠️ 이 레포에 세션 여러 개가 동시에 커밋하다 사고 난 전적 있음 —
  **같은 시간에 한 세션만 커밋, `git add -A` 금지, 파일 지정으로 add**
