# 법률 절차 길잡이 (legal-navigator-mcp)

일반인을 위한 **생활법률 정보·절차·표준서식 안내 MCP 서버**.
도메인: **노동 분쟁**(임금체불·부당해고·퇴직금 미지급·직장 내 괴롭힘).

> ⚠️ 법률 자문 도구가 아닙니다. 정보·절차·서식 안내만 제공합니다. → [BOUNDARIES.md](./BOUNDARIES.md)

카카오 **AGENTIC PLAYER 10**(MCP 공모전) 출품용. 표준 **원격 MCP(Streamable HTTP, stateless)** 라
PlayMCP 개발가이드 규격을 준수하며 Claude·ChatGPT·카카오톡(PlayMCP)에 그대로 붙는다.
제출 절차·등록값·비즈폼 답안 → [SUBMISSION.md](./SUBMISSION.md)

## 실행

```bash
npm install
npm run dev          # http://localhost:4100/mcp  (Streamable HTTP, stateless)
npm run typecheck
npm run build && npm start
```

## 도구 (5종)

PlayMCP 규격 준수: 영문 tool name · annotations 5종 · 영문 description(서비스명 병기) · ≤1024자.

| name | title | 설명 |
|---|---|---|
| `get_procedure` | 절차 안내 | 유형별 공식 대응 절차·관할기관·기한·접수처·근거 법령 |
| `get_checklist` | 필요 서류·증거 | 모아둘 증거 + 접수용 준비서류 체크리스트 |
| `get_form_template` | 표준 서식 | 진정서·내용증명·구제신청서 빈 서식 + 작성요령 (자동작성 아님) |
| `calculate_amount` | 금액 계산기 | 체불임금·퇴직금·주휴수당·지연이자 개략 계산 |
| `get_statute` | 법령 요지 | 노동 핵심 법조문 요지 + 국가법령정보센터 공식 deep-link |

모든 응답에 면책 고지가 자동으로 붙는다.

## PlayMCP 규격 준수 체크 (개발가이드 2026.06.12)

- ✅ Streamable HTTP · Remote · **Stateless(no session)**
- ✅ 프로토콜 2025-06-18 (허용 범위 2025-03-26 ~ 2025-11-25)
- ✅ tool name 영문/숫자/`-`/`_`, 중복 없음, 5개(권장 3~10)
- ✅ annotations(title·readOnlyHint·destructiveHint·openWorldHint·idempotentHint) 전부 지정
- ✅ description 영문 + 서비스명 병기, 1024자 이내
- ✅ 이름에 'kakao' 미포함
- ✅ 응답 인메모리 → 평균 <100ms (외부 API는 핫패스에서 미사용)

## 동작 확인 (curl)

```bash
curl -s -X POST http://localhost:4100/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_procedure","arguments":{"dispute_type":"부당해고"}}}'
```

제출 전 [MCP Inspector](https://github.com/modelcontextprotocol/inspector)로 표준 준수 최종 점검 권장:
`npx @modelcontextprotocol/inspector` → URL `http://localhost:4100/mcp`.

## 배포 (PlayMCP in KC)

카카오 클라우드 `PlayMCP in KC`에 **컨테이너 이미지** 또는 **Git 소스(이 레포 + `Dockerfile`)**로 등록 → Endpoint URL 획득.
로컬 검증:

```bash
docker build -t legal-navigator-mcp .          # 또는
npm run build && PORT=8080 node dist/server.js  # 컨테이너 CMD와 동일
```

자세한 등록·심사·접수 단계 → [SUBMISSION.md](./SUBMISSION.md)

## 로드맵

- [x] 법령 공식 deep-link grounding (`get_statute`)
- [~] 법제처 국가법령정보 Open API 라이브 (`src/lawapi.ts`, `LAW_OC` 키 필요·선택, 응답속도 위해 핫패스 미사용)
- [ ] 판례 검색 도구(케이스노트/법제처)
- [ ] 생활법률 도메인 확장(전월세·교통사고·소액사기 등) — 본선 대중 투표 소구력
