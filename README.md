# 법률 절차 길잡이 (legal-navigator-mcp)

일반인을 위한 **생활법률 정보·절차·표준서식·법령·판례 안내 MCP 서버**.
**36개 분야 · 168개 주제** — 노동·주택/상가임대차·돈거래/사기·소비자·교통사고·민사/형사 절차·가정폭력·성범죄·스토킹·디지털성범죄·명예훼손·가사/상속·채무조정·금융사기·학교폭력·산업재해·행정·의료·조세·계약·부동산·출입국·보험·지식재산·아동/노인학대·고용보험·공동주택·통신/개인정보·군·선거·환경·반려동물 등.

> ⚠️ 개별 법률 자문 도구가 아닙니다. 정보·절차·표준서식·법령·검증된 판례 안내만 제공합니다(declaw). → [BOUNDARIES.md](./BOUNDARIES.md)

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

## 도구 (14종)

PlayMCP 규격 준수: 영문 tool name · annotations 5종 · 영문 description(서비스명 병기) · ≤1024자. 전부 인메모리(외부 API 핫패스 미사용).

| name | title | 설명 |
|---|---|---|
| `triage` | 빠른 진단·다음 단계 | 상황(자연어)→가장 가까운 절차의 **기한·첫 단계·확보할 증거·도움처**를 한 장으로(경로 안내, 권고 아님) |
| `search_topics` | 자연어 주제 검색 | 일상어 상황 설명 → 관련 주제 키 랭킹(동의어 매핑 + 메타데이터 가중) |
| `list_topics` | 주제 목록 | 분야별 주제 키·제목 목록(카테고리 필터) |
| `get_procedure` | 절차 안내 | 유형별 공식 대응 절차·관할기관·기한·접수처·근거 법령 |
| `get_checklist` | 필요 서류·증거 | 모아둘 증거 + 접수용 준비서류 체크리스트 |
| `get_form_template` | 표준 서식 | 진정서·내용증명·신청서 빈 서식 + 작성요령 (자동작성 아님, 빈칸 채움형) |
| `get_precedent` | 판례 조회 | 검증된 사건번호·요지(키워드/주제 검색) — **187건, 실재 판례만** |
| `verify_citation` | 인용 검증 | 사건번호·법령조문 실재 대조 + 유효성 경고(폐기·하급심·헌법불합치·법개정). 없으면 지어내지 않고 law.go.kr/casenote 링크 |
| `law_updates` | 시점법 | 최근 법령·판례 변경과 시행일(사건 시점에 적용되는 법 확인) |
| `get_statute` | 법령 요지 | 핵심 법조문 요지 + 국가법령정보센터 공식 deep-link |
| `calculate_amount` | 금액 계산기 | 체불임금·퇴직금·주휴수당·지연이자 개략 계산 |
| `calculate_court_cost` | 소송비용 계산기 | 인지대(인지법 구간식·전자소송 감액·심급 배수)+송달료 개략 |
| `calculate_deadline` | 기한·소멸시효 계산기 | 기준일+법정기간→마감일·D-day, 기산점·중단/예외 경고 |
| `find_legal_aid` | 무료 법률지원·구제 연결 | 법률구조공단(132)·무료소송대리·소송구조·범죄피해구조금·대지급금·핫라인 라우팅 |

모든 응답에 면책 고지(출처 원문 링크 + 전문가/법률구조공단 132 에스컬레이션)가 자동으로 붙는다.

### 데이터 규모

- **168개 주제** / 36개 분야 — `src/data/*.ts`(분야별 분리) → `index.ts` 병합
- **판례 187건**(고유 178, 판례 보유 주제 146/168, 2020년 이후 69건). 각 사건번호는 law.go.kr·casenote.kr 판결문 실열람 검증분만 수록 — **미검증·없는 판례는 지어내지 않음**
- 법령 요지 191건 · 시점법 타임라인 12건 · 인용 유효성 플래그 14건(`src/data/legal_updates.ts`)

## 권장 사용 흐름

```
사용자 상황(자연어) → triage / search_topics 로 주제 식별
  → get_procedure(절차·기한) · get_checklist(서류) · get_form_template(빈 서식)
  → get_precedent(판례) · verify_citation(인용 진위) · law_updates(시점법)
  → calculate_amount(금액) · calculate_court_cost(소송비용) · calculate_deadline(기한)
  → find_legal_aid(무료 변호사·구제금 연결)
```

## PlayMCP 규격 준수 체크 (개발가이드 2026.06.12)

- ✅ Streamable HTTP · Remote · **Stateless(no session)**
- ✅ 프로토콜 2025-06-18 (허용 범위 2025-03-26 ~ 2025-11-25)
- ✅ tool name 영문/숫자/`-`/`_`, 중복 없음, 14개(권장 3~10 상회 — 응집된 법률 어시스턴트)
- ✅ annotations(title·readOnlyHint·destructiveHint·openWorldHint·idempotentHint) 전부 지정
- ✅ description 영문 + 서비스명 병기, 1024자 이내
- ✅ 이름에 'kakao' 미포함
- ✅ 응답 인메모리 → 평균 <100ms (외부 API는 핫패스에서 미사용)

## 동작 확인 (curl)

```bash
curl -s -X POST http://localhost:4100/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"triage","arguments":{"situation":"전세 만기인데 집주인이 보증금을 안 줘요"}}}'
```

제출 전 [MCP Inspector](https://github.com/modelcontextprotocol/inspector)로 표준 준수 최종 점검 권장:
`npx @modelcontextprotocol/inspector` → URL `http://localhost:4100/mcp`.

## 배포 (PlayMCP in KC)

카카오 클라우드 `PlayMCP in KC`에 **Git 소스(이 레포 + `Dockerfile`)** 또는 컨테이너 이미지로 등록 → Endpoint URL 획득.
로컬 검증:

```bash
docker build -t legal-navigator-mcp .          # 또는
npm run build && PORT=8080 node dist/server.js  # 컨테이너 CMD와 동일
```

자세한 등록·심사·접수 단계 → [SUBMISSION.md](./SUBMISSION.md)

## 로드맵

- [x] 생활법률 전 분야 확장 — 36개 분야 168개 주제
- [x] 검증된 판례 DB(`get_precedent`) — 187건, law.go.kr/casenote 실열람 검증
- [x] 법령 공식 deep-link grounding (`get_statute`)
- [x] 자연어 검색·트리아지(`search_topics`·`triage`)
- [x] 인용 검증·시점법(`verify_citation`·`law_updates`) — 환각 차단
- [~] 법제처 국가법령정보 Open API 라이브(`src/lawapi.ts`, `LAW_OC` 키 필요·선택, 응답속도 위해 핫패스 미사용)
- [ ] 가이드형 서식 작성 인터뷰(빈칸 채움 한정, declaw 경계 유지)
