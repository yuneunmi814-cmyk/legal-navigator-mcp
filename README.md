# 법률 절차 길잡이 (legal-navigator-mcp)

일반인을 위한 **생활법률 정보·절차·표준서식·법령·판례 안내 MCP 서버**.
**52개 분야 · 207개 주제** — 노동·주택/상가임대차·돈거래/사기·소비자·교통사고·민사/형사 절차·가정폭력·성범죄·스토킹·디지털성범죄·명예훼손·가사/상속·채무조정·금융사기·학교폭력·산업재해·행정·의료·조세·계약·부동산·출입국·보험·지식재산·아동/노인학대·고용보험·공동주택·통신/개인정보·군·선거·환경·반려동물·**외국인/이주민·청소년/미성년·장애인·북한이탈주민·플랫폼/특수고용·국가유공자/보훈·복지/취약가구·농어업인·노인/고령·정신건강·범죄피해자·자살예방/유족·재난/안전·소상공인(폐업·재기)·출소자/갱생보호·위기임신/보호출산(취약계층·위기)** 등.

> ⚠️ 개별 법률 자문 도구가 아닙니다. 정보·절차·표준서식·법령·검증된 판례 안내만 제공합니다(declaw). → [BOUNDARIES.md](./BOUNDARIES.md)

카카오 **AGENTIC PLAYER 10**(MCP 공모전) 출품용. 표준 **원격 MCP(Streamable HTTP, stateless)** 라
PlayMCP 개발가이드 규격을 준수하며 Claude·ChatGPT·카카오톡(PlayMCP)에 그대로 붙는다.
제출 절차·등록값·비즈폼 답안 → [SUBMISSION.md](./SUBMISSION.md)

## 실행

```bash
npm install
npm run dev          # http://localhost:4100/mcp  (Streamable HTTP, stateless)
npm run typecheck
npm test             # vitest 63개 (계산 결정성·데이터 불변식·인용검증 회귀·통합)
npm run build && npm start
```

## 도구 (16종)

PlayMCP 규격 준수: 영문 tool name · annotations 5종 · 영문 description(서비스명 병기) · ≤1024자. 전부 인메모리(외부 API 핫패스 미사용).

| name | title | 설명 |
|---|---|---|
| `triage` | 빠른 진단·다음 단계 | 상황(자연어)→가장 가까운 절차의 **기한·첫 단계·확보할 증거·도움처**를 한 장으로(경로 안내, 권고 아님) |
| `search_topics` | 자연어 주제 검색 | 일상어 상황 설명 → 관련 주제 키 랭킹(동의어 매핑 + 메타데이터 가중) |
| `list_topics` | 주제 목록 | 분야별 주제 키·제목 목록(카테고리 필터) |
| `get_procedure` | 절차 안내 | 유형별 공식 대응 절차·관할기관·기한·접수처·근거 법령 |
| `get_checklist` | 필요 서류·증거 | 모아둘 증거 + 접수용 준비서류 체크리스트 |
| `get_form_template` | 표준 서식 | 진정서·내용증명·고소장·지급명령·가압류 등 + **무료지원·구제 신청서 19종**(소송구조·재산관계진술서·범죄피해구조금·간이대지급금·분쟁조정·디성센터 삭제지원·양육비이행·전세사기 결정·채무조정·사회보장급여·자립수당·국가유공자 등록·산재 요양급여·외국인 사업장변경·**노란우산 공제금·갱생보호·행정심판 청구·정보공개 청구·의료분쟁 조정**) 빈칸 채움 골격 + 작성요령·**공식 양식 받는 곳** + **`.txt` 파일 다운로드 링크**(드라이브·카톡 '나에게 보내기'로 공유) (자동작성 아님) |
| `get_precedent` | 판례 조회 | 검증된 사건번호·요지(키워드/주제 검색) — **194건, 실재 판례만**(전수 재검증) + 사건번호별 casenote 딥링크 |
| `verify_citation` | 인용 검증 | 사건번호·법령조문 실재 대조 + 유효성 경고(폐기·하급심·헌법불합치·법개정). 없으면 지어내지 않고 law.go.kr/casenote 링크 |
| `law_updates` | 시점법 | 최근 법령·판례 변경과 시행일(사건 시점에 적용되는 법 확인) |
| `get_statute` | 법령 요지 | 핵심 법조문 요지 + 국가법령정보센터 공식 deep-link |
| `calculate_amount` | 금액 계산기 | 체불임금·퇴직금·주휴수당·지연이자 개략 계산 |
| `calculate_court_cost` | 소송비용 계산기 | 인지대(인지법 구간식·전자소송 감액·심급 배수)+송달료 개략 |
| `calculate_deadline` | 기한·소멸시효 계산기 | 기준일+법정기간→마감일·D-day, 기산점·중단/예외 경고 |
| `find_legal_aid` | 무료 법률지원·구제 연결 | **76개 주제별 무료 변호사·전담기관** 라우팅 + **신청절차·준비서류**(APPLICATION_GUIDE 25) — 피해자 국선변호사(성폭력·아동·스토킹)·한국여성변호사회·해바라기/디성센터·법률구조공단(132)·소송구조·범죄피해구조금·대지급금·분야별 분쟁조정·전세피해센터·양육비이행관리원·법무보호복지공단·위기임산부 상담(1308)·핫라인 38 |
| `how_to_get_document` | 증빙서류 발급 안내 | 준비서류를 **어디서·어떻게**(발급처·온라인 URL·수수료·팁) — 등기부·가족관계·소득증명·진단서·부채증명 등 16종 + 절약 꿀팁(행정정보 공동이용 동의 등) |
| `explain_term` | 법률용어 풀이 | **일상어↔법률어 + 자주 보는 법정용어 뜻 125개**(각하/기각·가압류/가처분·통상임금/평균임금·대항력/우선변제·선고유예/집행유예 등 헷갈리는 쌍 구별 / 떼인 돈→대여금·빨간딱지→압류). 정의만(declaw), 인메모리·키 불요 |

모든 응답에 면책 고지(출처 원문 링크 + 전문가/법률구조공단 132 에스컬레이션)가 자동으로 붙는다.

### 데이터 규모

- **207개 주제** / 52개 분야 — `src/data/*.ts`(분야별 분리) → `index.ts` 병합
- **판례 194건**(고유 184, 판례 보유 주제 154/207, 2020년 이후 72건). 각 사건번호는 law.go.kr·casenote.kr 판결문 실열람 검증분만 수록 — **미검증·없는 판례는 지어내지 않음**. ★전 사건번호를 casenote·law.go.kr로 **전수 재검증**해 미실존 3건 제거·오기 2건 정정(자동 회귀 테스트로 재발 차단)
- **법률용어 125개**(`src/data/glossary.ts`, 9개 분류 — easylaw.go.kr·law.go.kr·대법원·헌재 본문 검증, 형제자매 유류분 위헌 등 최신 반영)
- 표준서식 82종(무료지원·구제 신청서 19종 포함) · 법령 요지 222건 · 시점법 타임라인 12건 · 인용 유효성 플래그 14건

## 권장 사용 흐름

```
사용자 상황(자연어) → triage / search_topics 로 주제 식별
  → get_procedure(절차·기한) · get_checklist(서류) · get_form_template(빈 서식)
  → get_precedent(판례) · verify_citation(인용 진위) · law_updates(시점법)
  → calculate_amount(금액) · calculate_court_cost(소송비용) · calculate_deadline(기한)
  → find_legal_aid(무료 변호사·구제금 연결 + 신청절차·준비서류) · how_to_get_document(준비서류 떼는 법)
  → 모르는 용어가 나오면 explain_term(법률용어 풀이 — 각하·가압류·통상임금, 떼인 돈→대여금)
```

## PlayMCP 규격 준수 체크 (개발가이드 2026.06.12)

- ✅ Streamable HTTP · Remote · **Stateless(no session)**
- ✅ 프로토콜 2025-06-18 (허용 범위 2025-03-26 ~ 2025-11-25)
- ✅ tool name 영문/숫자/`-`/`_`, 중복 없음, 16개(권장 3~10 상회 — 응집된 법률 어시스턴트)
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

- [x] 생활법률 전 분야 확장 — 52개 분야 207개 주제(외국인노동자·이주여성·청소년·장애인·북한이탈주민·플랫폼특수고용·국가유공자·기초생활·한부모·농어업인·노인·정신건강·범죄피해자·자살예방/유족·재난안전·소상공인폐업·출소자갱생보호·위기임신보호출산 등 취약계층·위기 39주제 포함)
- [x] 검증된 판례 DB(`get_precedent`) — 194건, law.go.kr/casenote 실열람 검증(전 사건번호 전수 재검증)
- [x] 법령 공식 deep-link grounding (`get_statute`)
- [x] 자연어 검색·트리아지(`search_topics`·`triage`)
- [x] 인용 검증·시점법(`verify_citation`·`law_updates`) — 환각 차단
- [x] 무료지원·구제 신청서 빈칸 채움 골격 19종(`src/data/apply_forms.ts`) — 소송구조·구조금·대지급금·분쟁조정·전세사기·채무조정 + 사회보장급여·자립수당·국가유공자 등록·산재 요양급여·외국인 사업장변경 + 노란우산 공제금·갱생보호·행정심판 청구·정보공개 청구·의료분쟁 조정. declaw 경계 유지, 공식양식 출처·작성요령 동봉
- [x] 서식 파일 내보내기 — `GET /forms/:key.txt`(읽기전용·무상태) + `get_form_template` 응답의 `📎 파일로 저장·공유` 링크. 받은 `.txt`를 구글 드라이브·카카오톡 '나에게 보내기'·메일로 공유. 링크 호스트는 요청에서 도출(`X-Forwarded-*`/`PUBLIC_BASE_URL`)
- [x] 법률용어 풀이 사전(`src/data/glossary.ts`, 125개·9분류) — 일상어↔법률어 + 헷갈리는 쌍 구별, easylaw·law.go.kr·대법원·헌재 검증. `explain_term` 도구
- [x] 원문 연결 강화 — `get_precedent` 사건번호별 casenote 딥링크, `get_statute`에 더 깊은 원문(조문 전문·신구조문) 안내
- [x] 자동 테스트(`test/`, vitest 63개) — 계산 결정성·데이터 정합성 불변식·할루시네이션 재발 가드(미실존 사건번호·비표준 조문)·코드리뷰가 잡은 버그 회귀·통합(도구 규격·면책·다운로드)
- [x] 판례 전수 재검증 — 전 사건번호를 casenote·law.go.kr로 대조(미실존 3건 제거·오기 2건 정정), 회귀 테스트로 재발 차단
- [~] 법제처 국가법령정보 Open API 라이브(`src/lawapi.ts`, `LAW_OC` 키 필요·선택, 응답속도 위해 핫패스 미사용)
- [ ] 가이드형 서식 작성 인터뷰(대화로 빈칸 한 칸씩 채우기, declaw 경계 유지)
