# HANDOFF — 법률 절차 길잡이 MCP

- **마지막 갱신**: 2026-08-31 21:47 · 클로드코드
- **지금 하는 일**: 본선 개발 완료 마감(8/31 23:59) 마무리 — **완료됨**. 다음 구간은 카카오 QA(9/1~9/11) 대응.

## 어디까지 했나 (사실만)

- **개발 완료 제출 상태**: 라이브 서버 `legal-navigator-kakaotools` = `b7027dc`+`a617e49` (origin/main과 일치, ahead 0). 툴 16 · 주제 268 · 서식 121 · 응답 70~90ms. 테스트 225개 전부 통과.
- **콘솔 메타정보 저장 완료**(은미님 확인): 설명 412/500 · 대화예시 3개(월급/전세/유튜브 가짜뉴스) · 소개문구 「법을 몰라도, 절차부터 서식까지」(17자) · **소개 이미지 5장 업로드** · 임시등록(심사 전) 유지.
- 오늘 잡은 버그 3건 (전부 라이브 반영 확인):
  - `01ddee4` — 코덱스 `5e1ecbc`가 지운 `for_assistant` 복구. 이거 없으면 카드만 뜨고 모델이 서식 본문을 몰라 **지어낸다**. 8/26 카카오 프리뷰에서 이 필드 실린 카드가 정상 렌더됨을 실물 확인했음.
  - `d15fa62` — 입력칸 너비 ch→em (ch는 한글을 절반으로 잼) + 카카오 렌더러가 배지 Row를 줄바꿈 안 해 판례 배지가 잘리던 것(배지 축약 + 기한·관할은 본문 줄로).
  - `b7027dc` — **서식 겹침("본인옯사일")의 진짜 원인**: `.ln-h{text-indent:-1.5em}`이 상속 속성이라 inline-block 입력칸 안까지 내려가 글자가 22.5px 왼쪽에 그려짐. `.fld,.cbx{text-indent:0}`으로 상속 차단. 레이아웃 좌표는 정상이고 페인트만 어긋나는 버그라 좌표 검사로는 안 잡힘.
- 예시 이미지 5장: `assets/kakao-tools-examples/` (960×960·투명배경·폰 목업·Pretendard 규격, 가이드 v1.1 "답변 요소 재작업" 경로). 사본 `~/Downloads/카카오툴즈_소개이미지/`.
- 프리뷰 실검증(은미님 계정): 서식 카드·민감번호 안내·이름/금액 인식 확인. 단 **"채운 초안을 화면에 먼저 보여주기"는 for_assistant 복구 후 아직 프리뷰 재확인 안 됨**.

## 다음에 할 일

1. **9/1~ 카카오 QA 피드백 감시**: 팀별 디스코드(#법률-절차-길잡이) 확인, 지적 오면 **해당 영역만** 수정 → `npm test`(225개) → push → 재배포 → 라이브 재확인. 재배포는 Active 후에도 수십 초 걸리니 시간 두고 검증.
2. 프리뷰에서 초안 흐름 재확인: `임금체불 진정서 양식 보여줘` → `제 이름 홍길동이고 3개월치 300만원 못 받았어요. 채워서 보여줘` — 채운 초안이 코드블록으로 먼저 나오는지. 안 나오면 `src/server.ts`의 `작성지침` 첫 두 불릿 문구 조정.
3. ListView 검증(선택): `LISTVIEW=on`이면 find_legal_aid가 ListView로 나감(현재 off). 프리뷰에서 목록 렌더+줄 눌러 전화 확인되면 기본값 전환 검토. 코드: `src/server.ts` `listViewOn()`.
4. **9/14 코드 프리징** 전 최종 태그. 이후 수정 금지.
5. 구글시트(`ka_mcp_법률절차길잡이`, 용우님 소유) 은미님 항목 상태 갱신 — 8/28 이후 멈춰 있음.

## 막힌 것 / 결정 대기

- 없음. (ListView 기본값 전환 여부만 프리뷰 결과 보고 은미님 결정)

## 손대면 안 되는 것

- ⛔ **「등록 및 심사 요청」 버튼** — 누르면 거절 처리 (공지 명시). 임시등록 유지.
- ⛔ **예선 서버 `legal-navigator-full`** — 삭제·중지·재배포 금지, 운영 상태 유지.
- ⛔ **`for_assistant` 필드 제거 금지** — 카카오 가이드에 없는 필드지만 프리뷰 실물 검증 완료. 지우면 서식 초안 기능이 죽는다. 봉투 검사 테스트(test/server.test.ts)에 근거 주석 있음.
- ⛔ 주민등록번호 등 민감번호 6종을 채팅으로 받는 코드 금지 (개발가이드 §5.3).
- 9/16 전 "카카오톡에서 써보세요" 홍보 금지. 계약 제9조: 공모전 언급은 "본선 진출작"까지만.

## 관련 파일·링크

- 레포: `~/Projects/legal-navigator-mcp` (github.com/yuneunmi814-cmyk/legal-navigator-mcp, main)
- 마감 체크리스트: `KAKAO_TOOLS_FINAL.md` (단, 소개문구·대화예시는 콘솔 저장본이 최신 — 이 인계장 기준)
- 콘솔: playmcp.kakao.com/console · 프리뷰: preview-chatgpt.kakao.com (은미님 계정 필요)
- 본선 Endpoint: `https://legal-navigator-kakaotools.playmcp-endpoint.kakaocloud.io/mcp`
- 명령: `npm test` · `npm run typecheck` · `npm run build` · 로컬 `WIDGETS=on PORT=4188 node dist/server.js`
- 위젯 로컬 미리보기: `/widgets/{form|triage|calc|aid|procedure|checklist|deadline}` (aid는 `?lv=1`로 ListView 비교)
