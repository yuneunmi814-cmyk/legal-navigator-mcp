import express from "express";
import { timingSafeEqual, createHash, scryptSync } from "node:crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { withDisclaimer } from "./disclaimer.js";
import { normalizeLawName, matchLawName, parseArticle, extractCaseNumbers, matchCaseNumber, caseCore } from "./citation.js";
import {
  PROCEDURES,
  CHECKLISTS,
  FORMS,
  STATUTES,
  PRECEDENTS,
  TOPIC_KEYS,
  FORM_KEYS,
  TOPICS,
  CATEGORIES,
  CITATION_STATUS,
  LAW_TIMELINE,
  SEARCH_SYNONYMS,
  DEADLINES,
  SUPPORT_PROGRAMS,
  HOTLINES,
  APPLICATION_GUIDE,
  DOCUMENT_GUIDE,
  DOC_TIPS,
  GLOSSARY,
  ELEMENTS,
  ELEMENT_KEYS,
  FORM_TOPIC,
} from "./data/index.js";
import {
  calcUnpaidWages,
  calcSeverance,
  calcWeeklyHolidayPay,
  calcDelayInterest,
  calcSelfCancelRegistryCost,
  calcInheritanceRegistryCost,
  calcCourtCost,
  calcDeadline,
} from "./calc.js";
import { buildFormWidget, buildTriageWidget, buildCalcWidget, renderWidgetHtml, kakaoWidgetText, extractSubmitUrl } from "./widgets.js";
import { logCall, recentLogs, debugLogEnabled, setCollecting, collectingBy } from "./debugLog.js";
import { hwpxClientScript } from "./hwpx.js";
import { bodyToParas, hwpxBuffer, docxBuffer, MIME, safeName } from "./formfile.js";
import { formLayoutClientScript, layoutParas } from "./formlayout.js";

// 위젯 응답 스위치 — 카카오 툴즈(본선 서버)에서만 켠다. 위젯 반환 시 LLM이 가공하지 않고 카드가 곧 답변이 됨(가이드 §3).
// 기본: 프로덕션 on / 테스트 off. WIDGETS=on|off 로 강제 가능(호출 시점 평가라 테스트에서 토글 가능).
const widgetsOn = (): boolean =>
  process.env.WIDGETS === "on" || (process.env.WIDGETS !== "off" && process.env.NODE_ENV !== "test");

// 서비스명 — PlayMCP 개발가이드: description에 영문/국문 병기 서비스명 포함 필수
const SVC = "법률 절차 길잡이(Legal Navigator)";

// 자유 텍스트 입력 안전화 — ①과도한 길이로 응답이 부풀지 않게 자르고, ②응답에 그대로 반사될 때
// 진행 지침 주석(<!-- ... -->)의 경계를 사용자 입력으로 위조해 끼어들 수 없도록 주석 마커를 무력화한다.
const MAX_FREE_TEXT = 200;
function safeInput(s: string): string {
  return s.trim().slice(0, MAX_FREE_TEXT).replace(/<!--/g, "‹!--").replace(/-->/g, "--›");
}

const SERVER_INSTRUCTIONS =
  `한국 생활법률 ${TOPIC_KEYS.length}개 주제(노동·임대차·돈거래/사기·소비자·교통사고·민사/형사 절차·가정폭력/성범죄/스토킹·가사/상속·채무조정·산재·행정·의료·조세·부동산·출입국·복지/급여 등)의 절차·기한·표준 서식·금액 계산·법령/판례를 제공합니다. ` +
  "[호출 규칙] 법률·행정 상황 질문에는 모델 지식으로 먼저 답하지 말고 triage(상황 진단)·search_topics(주제 찾기)를, 해당 여부('이것도 스토킹인가요?' '처벌 가능한가요?' '신고 되나요?' '성립되나요?' '이거 보이스피싱인가요?')는 check_elements를 먼저 호출하세요 — 한국 법령·기한은 자주 바뀝니다. " +
  "흐름: 주제 키를 찾고 → get_procedure·get_checklist·get_form_template로 이어가며, 인용 확인은 verify_citation, 개정·시행일은 law_updates. " +
  // 답을 한 번에 쏟으면 카톡 화면에서 아무도 안 읽는다. 그렇다고 질문부터 던지면 귀찮아서 떠난다.
  // 그래서 순서를 못 박는다 — 먼저 답을 주고, 그 다음에 한 가지만 묻는다(8/20 회의 결정).
  "[답변 방식] 먼저 알아야 할 것(기한·지금 할 일·접수처)을 짧게 answer하고, 그 다음에 확인 질문을 **한 번에 하나만** 합니다. " +
  "선택지는 ①②③처럼 번호로 주고 **마지막 항목은 항상 '직접 입력'** 으로 열어 둡니다. 번호만 답해도 된다고 안내하세요. " +
  "사용자가 번호로 답하면 그 뜻으로 받아들이고 되묻지 마세요. " +
  // 3번은 복잡한 사안에 모자라고, 상한만 늘리면 다시 우다다 묻는다. 개수가 아니라
  // '답이 갈리는 지점인가'를 기준으로 준다.
  "질문은 **3~5번 사이**에서 사안에 맞게 조절하되, **답이 절차·기한·서식을 실제로 가르는 것만** 물으세요. " +
  "궁금해서 묻는 질문, 이미 알 수 있는 것을 되묻는 질문은 하지 마세요. 5번을 채울 필요는 없습니다. " +
  // 인터뷰의 끝을 눈에 보이는 신호로 만든다. 끝을 모호하게 두면 모델이 계속 묻거나
  // 반대로 말로만 정리하고 끝내버린다(2026-08-22 프리뷰 확인).
  "마지막 질문은 반드시 \"마지막으로\"로 시작하세요. 사용자가 그 질문에 답하면 인터뷰는 끝입니다. " +
  // 전체 흐름을 한 줄로 고정한다. 이게 없으면 매 호출마다 답변 모양이 달라진다.
  "[전체 흐름] 상황 접수 → 확인 질문 3~5회 → **마무리: 상황 정리 한 줄 + 관련 법령 + 접수처 + 서식 카드(get_form_template 호출)**. " +
  // 한 대화에서 진단은 한 번뿐이다. 인터뷰 중 재진단은 맥락을 잃는다.
  "**진단(triage)은 대화 한 건에 한 번만 합니다.** 인터뷰를 진행하는 중에는 다시 호출하지 마세요 — " +
  "요약해서 다시 넣는 과정에서 처음 말한 맥락이 사라져 전혀 다른 주제가 나옵니다. 사용자가 새로운 문제를 꺼냈을 때만 다시 진단합니다. " +
  "관련 법령과 접수처는 첫 답변에 쏟지 말고 마무리 턴에서 꺼내세요 — 처음부터 다 보여주면 길어서 아무도 읽지 않습니다. " +
  "질문에 답하지 않고 넘어가도 안내는 이어져야 합니다 — 질문은 관문이 아니라 선택입니다. " +
  "도구가 돌려준 '진행 지침' 주석은 당신에게 주는 지시입니다. 사용자에게 읽어주지 말고, 도구 이름도 화면에 노출하지 마세요. " +
  "declaw: 개별 법률 자문이 아닙니다. 사건의 결론(승소·유무죄)을 단정하지 말고, 서식은 사용자가 말한 사실로 공란을 채우는 수준까지만 도우며 법적 주장은 작성하지 마세요. 없는 판례·법령은 지어내지 말고, 중대·기한임박 사안은 변호사·대한법률구조공단(132) 상담을 권하세요.";

const READONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const 항목값 = ["체불임금", "퇴직금", "주휴수당", "지연이자", "셀프등기절감액", "상속등기비용"] as const;
const TOPIC_DESC = "주제 키. 카테고리: 노동·주택임대차·돈거래·소비자·교통사고·형사·민사절차. 모르면 search_topics로 먼저 확인(query 없이 호출하면 전체 목록).";

// 서식의 접수처 — 매핑된 주제의 검증된 관할기관·온라인접수를 재사용(새 URL 창작 금지). 8/11 회의 결정.
function formSubmitInfo(form: string): { 관할: string; 온라인접수: string; url: string | null } | null {
  const topic = FORM_TOPIC[form];
  const p = topic ? PROCEDURES[topic] : undefined;
  if (!p) return null;
  return { 관할: p.관할기관, 온라인접수: p.온라인접수, url: extractSubmitUrl(p.온라인접수) };
}

// 주제 → 그 주제의 표준 서식 키들. FORM_TOPIC(서식→주제)의 역방향.
// 이게 없어서 응답이 "표준서식 get_form_template"이라고만 하고 **어떤 서식인지 키를 안 줬다**.
// 키를 모르면 호출을 못 하니 모델이 서식을 직접 지어내는 쪽으로 샌다(2026-08-18 캡쳐).
const TOPIC_FORMS: Record<string, string[]> = (() => {
  const m: Record<string, string[]> = {};
  for (const [form, topic] of Object.entries(FORM_TOPIC)) (m[topic] ??= []).push(form);
  return m;
})();

// 절차 데이터의 단계 문장에는 모델용 힌트가 섞여 있다 —
// "2주 기한 계산(calculate_deadline: 지급명령_이의신청)" 같은 것. 5개 주제에서
// 이게 사용자 화면에 그대로 나갔다(2026-08-22 전수 확인). 힌트는 진행 지침으로 살리고
// 화면에서는 걷어낸다.
const 도구힌트 = /[（(]\s*(?:calculate_deadline|calculate_amount|calculate_court_cost|get_form_template|get_procedure|get_checklist|get_precedent|get_statute|search_topics|triage|check_elements|verify_citation|law_updates|find_legal_aid|how_to_get_document|explain_term)\s*[:：][^)）]*[)）]/g;

function 사용자문장(s: string): string {
  return s
    .replace(/^\d+\)\s*/, "")
    .replace(도구힌트, "")
    // 괄호 안 뒤쪽에 붙은 것도 있다 — "(7일 기한, calculate_deadline: 약식명령_정식재판청구)".
    // 앞의 실제 안내("7일 기한")는 살리고 도구 부분만 떼어낸다.
    .replace(/[（(]([^)）]*?)[,·]\s*(?:calculate_deadline|calculate_amount|calculate_court_cost|get_form_template|get_procedure|get_checklist|get_precedent|get_statute|search_topics|triage|check_elements|verify_citation|law_updates|find_legal_aid|how_to_get_document|explain_term)\s*[:：][^)）]*[)）]/g, "($1)")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.])/g, "$1")
    .replace(/[(（]\s*[)）]/g, "")
    .trim();
}

/** 단계 문장에 박힌 도구 힌트만 뽑아 모델 지침으로 되돌린다. */
function 단계도구힌트(단계: string[]): string[] {
  return 단계.flatMap((s) => s.match(도구힌트) ?? []).map((h) => h.replace(/^[（(]|[)）]$/g, "").trim());
}

/**
 * 기한 문장에서 기산점만 뽑는다. "받지 못한 임금이 발생한 날부터 3년" → "받지 못한 임금이 발생한 날".
 *
 * 느슨하게 뽑으면 앞 절까지 끌고 와 문장이 깨진다 —
 * "무자가 빚을 인정(채무승인)하면 시효가 그때" 같은 게 그대로 질문이 됐다(2026-08-22 확인).
 * 그래서 **시점 명사로 끝나는 짧은 구**만 받고, 조건절이 섞이면 버린다. 버리면 증거 질문으로 간다.
 */
export function 기산점(기한: string): string | null {
  const i = 기한.search(/(?:부터|로부터)/);
  if (i < 0) return null;
  // 글자 수로 자르면 단어 중간이 끊긴다("받지 못한" → "지 못한"). 토큰 단위로 뒤에서부터 붙인다.
  const toks = 기한.slice(0, i).split(/[\s()·—,]+/).filter(Boolean);
  let best: string | null = null;
  for (let n = 1; n <= Math.min(5, toks.length); n++) {
    const add = toks[toks.length - n];
    // 왼쪽으로 붙이다 기간 표기("3년"·"14일")·강조 기호(★)·구분자를 만나면 거기서 멈춘다.
    // 안 그러면 "★ 해고일"·"10년. 민사 손해배상은 안 날"처럼 앞 문장이 딸려 온다.
    if (n > 1 && /[0-9★/]|^(?:그|이|위|해당|는|은|의)$/.test(add)) break;
    const s = toks.slice(-n).join(" ");
    if (s.length > 18) break;
    if (!/(?:날|일|때|시점|일자)$/.test(s)) continue; // 시점 명사로 끝나야 한다
    if (/(?:하면|되면|경우|이상|미만|한다|합니다)/.test(s)) continue; // 조건절이 섞였다
    if (/(?:그때|그날)$/.test(s)) continue; // "시효가 그때" 같은 지시어는 질문이 안 된다
    if (s.length >= 3) best = s; // 더 길게 붙일 수 있으면 문맥이 살아난다
  }
  // 첫 토큰부터 노이즈면(★해고일) 그것만 남는다 — 기호를 떼고 다시 본다.
  if (best) best = best.replace(/^[★·/\s]+/, "").trim();
  if (!best || best.length < 3) return null;
  if (/[0-9★/]/.test(best)) return null; // "신청/선고일"처럼 한 토큰 안에 기호가 있는 경우
  if (/안\s*알/.test(best)) return null; // "안 알 수 있었던 날" — 문장이 깨진 것
  // '안 날'은 법조문 표현이다. 그대로 물으면 일반인은 무슨 날인지 모른다.
  return best.replace(/안 날$/, "그 사실을 알게 된 날").trim();
}

/**
 * 계산 카드용 지침. 카드에 숫자·계산식이 이미 그려져 있는데 모델이 그걸 다시 받아쓰면
 * 같은 내용이 두 번 나온다 — 카드를 되풀이하지 말고 다음 행동만 잇게 한다.
 */
const 계산보조지침 =
  "계산 결과 카드가 화면에 이미 표시된다. 숫자와 계산식을 다시 나열하지 말고, " +
  "이 금액이 무엇을 뜻하는지 한 문장으로만 짚고 다음 행동으로 잇는다. " +
  "금액은 개략 추정이며 확정액이 아니라는 점을 밝힌다. " +
  "청구·신청 문서가 필요해지면 get_form_template을 호출한다 — 서식 본문을 직접 지어내지 말 것. " +
  "도구 이름을 사용자 화면에 노출하지 말 것.";

/**
 * 확인 질문 한 개. 주제가 259개라 질문을 손으로 쓸 수 없어 데이터에서 만든다.
 *
 * 1순위는 기한의 **기산점**이다. "받지 못한 임금이 발생한 날부터 3년"처럼 거의 모든 주제의
 * 기한 문장이 '~부터'를 갖고 있고, 그 시점이 곧 권리가 살아 있는지를 가른다 — 가장 먼저
 * 물어야 할 것이 그것이다. 기산점을 못 뽑으면 준비 서류 보유 여부로 물러선다.
 */
function 확인질문(topic: string, p: { 기한: string }, c?: { 증거?: string[] }): string {
  const 기산 = 기산점(p.기한);
  const 끝 = `\n\n_번호만 답하셔도 되고, 편하게 적어주셔도 됩니다._`;
  if (기산) {
    return (
      `**하나만 확인할게요 — ${기산}이 언제쯤인가요?**\n\n` +
      `① 최근 1개월 안\n② 6개월 안\n③ 그보다 오래됐어요\n④ 직접 입력` +
      끝
    );
  }
  const ev = (c?.증거 ?? []).slice(0, 2);
  if (ev.length) {
    return (
      `**하나만 확인할게요 — 아래 중 갖고 계신 게 있나요?**\n\n` +
      ev.map((e, i) => `${"①②"[i]} ${e}`).join("\n") +
      `\n③ 둘 다 없어요\n④ 직접 입력` +
      끝
    );
  }
  return `**어떤 부분이 가장 궁금하신가요?**\n\n① 지금 당장 할 일\n② 필요한 서류\n③ 서식(양식) 받기\n④ 직접 입력` + 끝;
}

/**
 * 모델에게만 주는 지시 블록. 텍스트 응답에는 위젯의 `for_assistant` 같은 통로가 없어
 * 본문 끝에 HTML 주석으로 붙인다. 예전처럼 `get_procedure("임금체불")`를 사용자 문장
 * 속에 흘리지 않고 전부 여기로 모은다.
 */
function 진단보조지침(topic: string): string {
  const forms = TOPIC_FORMS[topic] ?? [];
  const p = PROCEDURES[topic];
  const c = CHECKLISTS[topic];
  const l: string[] = [];
  // 흐름: 상황 접수 → 인터뷰 2~3스텝 → 마무리(관련 법 + 제출 방법 + 서식 카드).
  // 3~5스텝은 프리뷰에서 "마지막으로가 나오기까지 너무 길다"는 지적을 받았다(2026-08-23).
  // 상한을 줄이는 것만으로는 부족해 "모르면 묻지 말고 가정하고 진행"을 함께 준다 — 질문을 줄이는
  // 실제 지렛대는 개수 제한이 아니라 "안 물어도 되는 것"의 기준이다.
  // 관련 법과 제출 방법은 빼는 게 아니라 **마무리 턴으로 미루는** 것이다. 첫 화면에 다 쏟으면
  // 1,000자가 되어 아무도 안 읽었다 — 전달했다고 볼 수 없었다(8/9 결정의 실제 이행).
  // 단계 문장에서 걷어낸 도구 힌트를 여기로 되돌린다 — 화면에서만 지우고 모델은 알아야 한다.
  const 힌트 = p?.단계 ? 단계도구힌트(p.단계) : [];
  if (힌트.length) l.push(`- 이 주제에서 쓸 도구: ${힌트.join(" / ")}`);
  l.push("[마무리 턴에 쓸 재료 — 지금 쏟지 말 것]");
  if (c?.증거?.length) l.push(`- 모아둘 증거: ${c.증거.slice(0, 5).join(" · ")}`);
  if (p?.온라인접수) l.push(`- 접수처: ${p.온라인접수}`);
  if (p?.근거법?.length) l.push(`- 근거 법령: ${p.근거법.join(" · ")}`);
  l.push(
    "",
    "[진행 규칙]",
    // 실제 사고: 스토킹 상담으로 시작해 인터뷰를 잘 진행하고는, 마지막 답을 받은 뒤
    // triage를 다시 호출했다. 그때 넣은 요약에 '스토킹'이 빠져 상속재산분할이 나왔다
    // (2026-08-22 실사용). 주제는 첫 호출에서 이미 정해졌다 — 다시 묻지 않는다.
    `- **주제는 이미 "${topic}"으로 정해졌다. 이 대화에서 triage나 search_topics를 다시 호출하지 말 것.**` +
      " 인터뷰 중에 다시 부르면 사용자가 말한 맥락이 요약되면서 사라져 엉뚱한 주제로 바뀐다." +
      " 사용자가 전혀 다른 문제를 새로 꺼냈을 때만 다시 진단한다.",
    "- 한 번에 한 가지만 묻는다. 선택지는 ①②③로 주고 마지막은 항상 '직접 입력'으로 열어 둔다.",
    "- 질문은 2~3번으로 끝낸다. 최대 4번을 넘지 않는다."
      + " 답이 **절차·기한·서식 중 무엇이 달라지는지 한 문장으로 말할 수 없으면 묻지 않는다.**"
      + " 확인용·배경용 질문은 하지 않는다. 한 번에 끝낼 수 있으면 첫 질문이 곧 마지막 질문이어도 된다.",
    "- 모르는 값은 묻지 말고 가장 흔한 경우로 가정하고 진행한 뒤, 마무리에서 \"◯◯로 보고 안내드렸어요\"라고 한 줄로 밝힌다."
      + " 사용자가 다르면 그때 고치면 된다 — 먼저 다 캐묻는 것보다 빠르다.",
    "- 사용자가 번호로 답하면 그 뜻으로 받아들이고 되묻지 않는다.",
  );
  // 인터뷰의 끝을 눈에 보이는 신호로 만든다. 모호하게 두면 모델이 계속 묻거나
  // 반대로 말로만 정리하고 끝낸다. 이 규칙은 서식이 있든 없든 모든 주제에 적용된다 —
  // 전에는 서식 있는 주제에만 넣어서 154개 주제가 끝나는 방법을 몰랐다(2026-08-22 전수 확인).
  l.push(
    "- 더 물을 것이 없다고 판단하면, 그 마지막 질문은 반드시 **\"마지막으로\"** 로 시작한다." +
      " 예: \"마지막으로, 지금 재직 중이신가요? ① 재직 중 ② 퇴사함 ③ 직접 입력\"",
  );
  if (forms.length) {
    l.push(
      // 키만 나열하면 여러 개일 때 아무거나 고른다. 임금체불은 진정서·내용증명·대지급금
      // 셋인데 상황이 전혀 다르다. 무엇에 쓰는 서식인지 함께 줘야 맞는 걸 고른다.
      `- 이 주제의 표준 서식(용도가 다르니 상황에 맞는 것 하나를 고른다):`,
      ...forms.map((f) => `    · \`${f}\` — ${FORMS[f]?.용도 ?? FORMS[f]?.제목 ?? ""}`),
      "- 사용자가 말한 상황에 맞는 서식이 위에 없으면 **호출하지 말고**, 없다고 밝힌다." +
        " 비슷해 보인다고 아무거나 내밀지 말 것 — 잘못된 서식은 없는 것보다 나쁘다.",
      // 마무리 턴의 형식을 고정한다. 안 그러면 매번 다른 모양으로 나와 품질이 들쑥날쑥해진다.
      "- **사용자가 그 '마지막으로' 질문에 답하면 그 턴이 마무리다. 아래 순서를 그대로 지킨다:**" +
        " ① 확인된 상황을 한 줄로 정리 →" +
        " ② 위 '근거 법령'을 제시(여기서 처음 꺼낸다) →" +
        " ③ 위 '접수처'로 어디에 어떻게 내는지 →" +
        " ④ **위 키로 get_form_template을 호출**해 서식 카드를 띄운다.",
      "- ④를 말로 대신하지 말 것. 서식 카드가 떠야 사용자가 빈칸을 채우고 인쇄·다운로드할 수 있다.",
      "- 그 전이라도 사용자가 서식·양식·신청서·진정서·내용증명을 요구하거나 대화가" +
        " '어떻게 접수하느냐'로 넘어가면 즉시 호출한다. 서식 본문을 직접 지어내지 말 것.",
    );
  } else {
    // 이 주제에는 표준 서식이 없다. 없는 서식을 지어내게 두면 안 되고, 그렇다고
    // 마무리 형식을 비워 두면 매번 다른 모양이 된다 — 서식 자리에 '가져갈 것'을 넣는다.
    l.push(
      "- 이 주제에는 제공할 표준 서식이 없다. get_form_template을 호출하지 말고, 서식을 지어내지도 말 것.",
      "- **사용자가 그 '마지막으로' 질문에 답하면 그 턴이 마무리다. 아래 순서를 그대로 지킨다:**" +
        " ① 확인된 상황을 한 줄로 정리 →" +
        " ② 위 '근거 법령'을 제시(여기서 처음 꺼낸다) →" +
        " ③ 위 '접수처'로 어디에 어떻게 내는지 →" +
        " ④ 위 '모아둘 증거'에서 지금 챙길 것을 짚어 마무리한다.",
    );
  }
  l.push(
    `- 상세 절차는 get_procedure("${topic}"), 준비 서류는 get_checklist("${topic}").`,
    (PRECEDENTS[topic]?.length ?? 0) > 0 ? `- 판례를 물으면 get_precedent("${topic}").` : "",
    "- 도구 이름을 사용자 화면에 그대로 노출하지 말 것.",
  );
  return l.filter(Boolean).join("\n");
}

/**
 * 텍스트 응답용 포장. `for_assistant` 필드가 없는 경로에서만 쓴다 —
 * 위젯 응답은 지침을 필드로 직접 넘기므로, 거기까지 주석 마커를 붙이면
 * 모델이 "주석이니 무시해도 되는 것"으로 읽을 수 있다.
 */
function 지침주석(본문: string): string {
  return `\n\n<!-- 진행 지침 (사용자에게 읽어주지 말 것)\n${본문}\n-->`;
}

// 응답은 마크다운(카카오 툴즈 가이드: 텍스트 답변은 정제된 마크다운 권장).
function 절차텍스트(key: string): string {
  const p = PROCEDURES[key];
  return [
    `## 📋 ${p.제목}`,
    `_분야: ${p.category}_`,
    "",
    `- **적용대상**: ${p.적용대상}`,
    `- **기한**: ${p.기한}`,
    `- **관할기관**: ${p.관할기관}`,
    `- **접수**: ${p.온라인접수}`,
    "",
    "### 진행 단계",
    ...p.단계.map((s) => `- ${s}`),
    "",
    "### 근거 법령",
    ...p.근거법.map((s) => `- ${s}`),
    "",
    `> 💡 ${p.비고}`,
  ].join("\n");
}

// 자연어 질의 → 관련 주제 키 랭킹(동의어군 + 메타데이터 가중). search_topics·triage 공용.
// 주제엔 없는데 서식 이름엔 있는 말이 있다. "내용증명"·"차용증"·"합의서"처럼
// **문서 이름으로 찾는 사람**이 그렇다 — 내용증명 서식이 12종이나 있는데
// '내용증명' 한 단어로는 0건이었다(2026-08-21 확인). 주제 검색이 비면 서식 이름에서 한 번 더 찾는다.
export function matchFormsByName(query: string): string[] {
  const n = (x: string) => x.replace(/[\s_·\-]/g, "");
  const nq = n(query);
  if (nq.length < 2) return [];
  const toks = query.split(/[\s_·\-]+/).map(n).filter((t) => t.length >= 2);
  const hit: string[] = [];
  for (const key of FORM_KEYS) {
    const hay = n(key + (FORMS[key]?.제목 ?? ""));
    if (hay.includes(nq) || (toks.length > 0 && toks.every((t) => hay.includes(t)))) hit.push(key);
  }
  return hit;
}

function rankTopics(query: string): string[] {
  const Q = query.replace(/\s+/g, " ").trim();
  const nQ = Q.replace(/\s/g, "");
  const words = [...new Set(Q.split(/\s+/).filter((w) => w.length >= 2))];
  const score = new Map<string, number>();
  // 점수만으로는 "무엇 때문에 뽑혔는지"를 알 수 없다. 제목에 흔한 낱말 하나가 걸려 4점을 먹으면
  // 그것만으로 1등이 됐다 — "친하지 않은 사람이 계속 친한 척 연락함"이 '계속'이라는 두 글자로
  // 헬스장 중도해지 환불로, '연락'이 불법추심으로 갔다(2026-08-22 실사용 확인).
  // 그래서 근거의 **종류**를 함께 센다. 강한 근거(동의어·주제키·법령명)가 하나라도 있거나,
  // 약한 근거(낱말 일치)가 둘 이상 겹칠 때만 답한다.
  const strong = new Map<string, number>();
  const weak = new Map<string, number>();
  const add = (k: string, n: number, kind: "강" | "약" = "강") => {
    if (!PROCEDURES[k]) return;
    score.set(k, (score.get(k) ?? 0) + n);
    const m = kind === "강" ? strong : weak;
    m.set(k, (m.get(k) ?? 0) + 1);
  };
  for (const syn of SEARCH_SYNONYMS) {
    if (syn.q.some((ph) => nQ.includes(ph.replace(/\s/g, "")) || Q.includes(ph))) {
      for (const t of syn.topics) add(t, 5);
    }
  }
  for (const k of TOPIC_KEYS) {
    const p = PROCEDURES[k];
    if (nQ.includes(k) || k.includes(nQ)) add(k, 6);
    // 법률명을 통째로 친 경우("스토킹범죄의 처벌 등에 관한 법률") — 그 법을 근거로 삼는
    // 주제가 이겨야 한다. 단어 단위로만 재면 '처벌'·'법률' 같은 흔한 조각이 이겨버린다.
    for (const law of p.근거법) {
      const nLaw = law.replace(/\s/g, "");
      if (nLaw.length >= 6 && nQ.includes(nLaw)) add(k, 7);
    }
    const hay = `${p.적용대상} ${p.근거법.join(" ")}`;
    for (const w of words) {
      if (p.제목.includes(w)) add(k, 4, "약");
      else if (p.category.includes(w)) add(k, 3, "약");
      else if (hay.includes(w)) add(k, 2, "약");
    }
  }
  const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]);
  // 근거가 약하면 답하지 않는다. 흔한 단어 하나가 2점 먹고 1등이 되면 그게 답이 되던 구조라,
  // "업무누락 반복하는 실장급 직원"이 '검찰 사칭 보이스피싱'으로 갔다(2026-08-19 발화 감사).
  // 법률 안내에서 근거 없이 확신하는 것보다 못 찾았다고 하는 편이 낫다.
  // 컷은 1등만이 아니라 목록 전체에 적용한다. 1등만 걸러도 뒤에 붙는 2점짜리가
  // triage의 '더 가까운 주제' 후보로 그대로 나갔다 — "월급을 못 받았어"에 모욕·난민신청이
  // 붙어 나왔고(2026-08-22 확인), 그 텍스트가 그대로 LLM 입력이 되니 엉뚱한 데로 샌다.
  // 점수 컷에 더해 근거의 종류를 본다. 낱말 하나만 걸린 것으로는 법률 주제를 단정하지 않는다.
  return ranked
    .filter(([k, s]) => s >= 4 && ((strong.get(k) ?? 0) > 0 || (weak.get(k) ?? 0) >= 2))
    .map(([k]) => k);
}

export function createServer(baseUrl?: string): McpServer {
  const server = new McpServer(
    { name: "legal-navigator", version: "0.4.0", title: "법률 절차 길잡이" },
    { instructions: SERVER_INSTRUCTIONS },
  );

  // 도구 호출 기록 — registerTool을 여기서 한 번만 감싸 아래 16개 도구에 자동 적용한다(개별 도구는 그대로).
  // 남기는 것: 도구명·소요시간·성공여부·인자의 키 이름. 남기지 않는 것: 인자의 값(자유 텍스트).
  // 예외적으로 응답이 "찾지 못했습니다"인 매칭 실패만 원인 파악을 위해 값을 남긴다(마스킹·200자 제한은 debugLog.ts).
  // 켜고 끄기·저장 범위는 전부 debugLog.ts가 판단한다 — 여기서는 무엇이 일어났는지만 넘긴다.
  // SDK의 registerTool은 인자 스키마별 제네릭 오버로드가 많아 타입을 그대로 흉내 내기 어렵다 →
  // 런타임 동작만 필요하므로 any로 우회한다(감싸는 지점이 이 한 곳뿐이라 영향 범위가 좁다).
  const rawRegisterTool = server.registerTool.bind(server) as (...a: any[]) => any;
  (server as any).registerTool = (name: string, config: any, handler: (...a: any[]) => any) =>
    rawRegisterTool(name, config, async (...a: any[]) => {
      const t0 = Date.now();
      try {
        const result = await handler(...a);
        const text = (result?.content ?? [])
          .filter((c: any) => c?.type === "text")
          .map((c: any) => c?.text ?? "")
          .join("\n");
        logCall({
          tool: name,
          args: a[0],
          ms: Date.now() - t0,
          ok: true,
          flag: text.includes("찾지 못했습니다") ? "no_match" : undefined,
        });
        return result;
      } catch (err) {
        logCall({ tool: name, args: a[0], ms: Date.now() - t0, ok: false, error: err instanceof Error ? err.message : String(err) });
        throw err;
      }
    });

  // 자연어 통합검색 — 일상어 상황 설명을 주제 키로 매핑(접근성).
  server.registerTool(
    "search_topics",
    {
      title: "자연어 주제 검색·주제 목록",
      description:
        `주제를 찾아보거나 전체 목록을 볼 때. 일상어·속어(떼인 돈·깡통전세·갑질)로 주제 키를 찾습니다. 사용자가 자기 상황을 이야기하면 이 도구가 아니라 triage를 호출하세요. 한국 생활법률 ${TOPIC_KEYS.length}개 주제. query 없이 호출하면 전체 목록. 반환된 키를 get_procedure·get_checklist·get_form_template에 사용.\n` +
        `[트리거 예시] "층간소음 문제 어떻게 해요?" / "떼인 돈 받는 법" / "직장 내 괴롭힘 관련해서 알아봐줘" / "청년월세 지원 같은 거 있어?" / "무슨 법률 문제 도와줄 수 있어?"\n` +
        `[EN] Finds the matching topic key from everyday Korean wording; call with no query to browse all topics by category.\n` +
        `Service: ${SVC}.`,
      inputSchema: {
        query: z
          .string()
          .max(200)
          .optional()
          .describe(
            "문제 유형을 요약한 키워드/짧은 문구 (예: 월세 보증금 미반환 / 갑작스러운 해고 / 보이스피싱 송금). "
            + "사용자의 발화 원문 대신, 개인정보를 제외한 요약 키워드로 전달하세요. "
            + "확실하지 않아도 됩니다 — 짧게 적어 호출하면 이 도구가 찾아줍니다. 비우면 전체 주제 목록 반환.",
          ),
        category: z
          .enum(CATEGORIES as [string, ...string[]])
          .optional()
          .describe("[목록 조회용] 카테고리 필터 — query 없이 목록을 볼 때 사용 (비우면 전체)"),
      },
      annotations: { title: "자연어 주제 검색·주제 목록", ...READONLY },
    },
    async ({ query, category }) => {
      const q = query ? safeInput(query) : query;
      if (!q) {
        const list = category ? TOPICS.filter((t) => t.category === category) : TOPICS;
        const byCat = new Map<string, string[]>();
        for (const t of list) {
          if (!byCat.has(t.category)) byCat.set(t.category, []);
          byCat.get(t.category)!.push(`- \`${t.key}\` — ${t.제목}`);
        }
        const catBody = [...byCat.entries()].map(([c, items]) => `### ${c}\n${items.join("\n")}`).join("\n\n");
        return { content: [{ type: "text", text: withDisclaimer(`## 🗂️ 주제 목록 (${list.length}개)\n\n${catBody}`) }] };
      }
      const ranked = rankTopics(q).slice(0, 12);
      if (!ranked.length) {
        // 주제로는 못 찾아도 서식 이름이면 찾을 수 있다 — 빈손으로 돌려보내기 전에 한 번 더.
        const forms = matchFormsByName(q).slice(0, 12);
        if (forms.length) {
          const list = forms.map((k) => `- \`${k}\` — ${FORMS[k].제목}`).join("\n");
          return {
            content: [
              {
                type: "text",
                text: withDisclaimer(
                  `## 📄 '${q}' 서식 ${forms.length}종\n\n주제로는 못 찾았지만 이름이 맞는 서식이 있습니다.\n\n${list}\n\n→ 위 서식 키로 \`get_form_template\`을 호출하면 빈칸 채움형 서식을 바로 받습니다.`,
                ),
              },
            ],
          };
        }
        return { content: [{ type: "text", text: withDisclaimer(`'${q}'에 맞는 주제를 바로 찾지 못했습니다. query 없이 호출하면 전체 목록(56개 분야)을 볼 수 있습니다. 더 구체적인 표현으로 다시 검색해 주세요.`) }] };
      }
      const body = ranked.map((k) => `- \`${k}\` — [${PROCEDURES[k].category}] ${PROCEDURES[k].제목}`).join("\n");
      // 도구 이름은 사용자 화면에서 걷어내고 모델용 주석으로 내린다.
      return {
        content: [
          {
            type: "text",
            text:
              withDisclaimer(`## 🔎 '${q}' 관련 주제\n\n${body}`) +
              `\n\n<!-- 진행 지침 (사용자에게 읽어주지 말 것)\n` +
              `- 사용자 상황에 가장 가까운 주제 하나를 고르고, 그 키로 get_procedure(절차)·get_checklist(서류)·get_precedent(판례)를 이어 호출한다.\n` +
              `- 서식이 필요해지면 get_form_template. 서식 본문을 직접 지어내지 말 것.\n` +
              `- 목록을 그대로 나열하지 말고, 무엇에 해당하는지 한 가지를 확인하는 질문을 ①②③(마지막은 '직접 입력')으로 던진다.\n` +
              `- 도구 이름을 사용자 화면에 노출하지 말 것.\n-->`,
          },
        ],
      };
    },
  );

  // 빠른 진단(트리아지) — 상황 설명을 받아 가장 가까운 절차의 '기한·첫 단계·확보할 증거·도움처'를 한 장으로 안내.
  // declaw: 특정 결론·행동을 권하지 않고 '선택지·다음 단계' 정보만 제공(경로 안내). 빈칸 채움형 서식은 get_form_template로 연결.
  server.registerTool(
    "triage",
    {
      title: "빠른 진단·다음 단계",
      description:
        // 호출 규칙을 맨 앞에 둔다. 예전엔 "무엇을 제공하는가"로 시작하고 규칙이 문장 중간에
        // 묻혀 있었는데, 그때 "회사에서 돈을 안 줍니다" 같은 평범한 말에는 호출이 아예 안 됐다
        // (2026-08-22 프리뷰 확인). 모델은 description 앞부분을 더 크게 본다.
        `**법률·생활 문제 상황을 말하면 무조건 이 도구부터 호출하세요.** 답을 먼저 지어내지 마세요. ` +
        `사용자가 법률 용어를 쓰지 않아도, 반말이나 한 마디로 말해도 마찬가지입니다. ` +
        `한국 법령·기한은 자주 바뀌어 모델 지식은 틀립니다.\n` +
        `상황 한 줄을 넣으면 가장 가까운 절차의 기한·오늘 할 일·확보할 증거·도움처를 한 장으로 돌려줍니다. 결론 아님·경로 안내.\n` +
        // 실제로 사람들은 존댓말 완성문으로 말하지 않는다. 반말·짧은 말·욕설 섞인 하소연이 대부분이다.
        `[트리거 예시] "나 월급을 못받고 있어" / "회사에서 돈을 안 줍니다" / "야 나 잘렸어 어떡할까" / ` +
        `"집주인이 보증금을 안 줘" / "친구한테 빌려준 돈 못 받았어" / "전 남친이 계속 연락해" / ` +
        `"법원에서 뭐가 날아왔는데" / "사기당한 것 같아" / "보일러 고장났는데 집주인이 나보고 고치래" / ` +
        `"월급을 두 달째 못 받고 있어요" / "살고 있는 집이 경매에 넘어갔어요"\n` +
        `[EN] Triages a described situation into the closest Korean legal procedure - deadline, first steps, evidence to secure, and where to file.\n` +
        `Service: ${SVC}.`,
      inputSchema: {
        situation: z
          .string()
          .max(200)
          .describe(
            "상황의 핵심을 요약한 키워드/짧은 문구 (예: 전세 보증금 미반환 / 보이스피싱 송금 피해 / 직장 상사 폭언). "
            + "사용자의 발화 원문을 그대로 넣지 말고, 이름·연락처 등 개인정보를 제외하고 문제 유형 중심으로 요약해 전달하세요. "
            // 요약을 완벽히 해내야 부를 수 있다고 읽히면 모델이 스스로 분류를 시도하다 그냥 답해버린다.
            // 분류는 이 도구가 한다는 걸 명시해 호출 문턱을 낮춘다(2026-08-22 프리뷰 확인).
            + "어떤 유형인지 확실하지 않아도 됩니다 — 들은 문제를 짧게 적어 그대로 호출하세요. 정확한 분류는 이 도구가 합니다.",
          ),
      },
      annotations: { title: "빠른 진단·다음 단계", ...READONLY },
    },
    async ({ situation: rawSituation }) => {
      const situation = safeInput(rawSituation);
      const ranked = rankTopics(situation);
      if (!ranked.length) {
        return { content: [{ type: "text", text: withDisclaimer(`'${situation}'에 딱 맞는 주제를 찾지 못했습니다. 조금 더 구체적으로 알려주시면 다시 찾아볼게요.

<!-- 진행 지침: search_topics를 query 없이 호출하면 전체 분야 목록을 받는다. 도구 이름은 노출하지 말 것. -->`) }] };
      }
      const top = ranked[0];
      const p = PROCEDURES[top];
      const c = CHECKLISTS[top];
      // 카카오 툴즈: 진단 카드 위젯(기한 배지·첫 단계·접수처 버튼).
      // 위젯을 반환하면 이 아래 마크다운은 모델에게 가지 않는다. 그래서 진행 지침을
      // for_assistant로 함께 실어 보낸다 — 이게 없으면 모델이 서식 존재를 모른 채 답한다.
      if (widgetsOn()) {
        const kw = buildTriageWidget(situation, { key: top, category: p.category, 제목: p.제목, 기한: p.기한, 단계: p.단계, 온라인접수: p.온라인접수, 근거법: p.근거법 });
        return { content: [{ type: "text", text: kakaoWidgetText({ ...kw, name: "triage", for_assistant: 진단보조지침(top) }) }] };
      }
      // 사용자에게는 주제 '키'가 아니라 제목을 보여준다. 키는 `외국인근로자_임금체불`처럼
      // 언더바가 든 내부 식별자라 화면에 그대로 나가면 읽히지 않는다.
      const others = ranked.slice(1, 4).map((k) => PROCEDURES[k].제목).join(" · ");
      // 한 번에 다 쏟지 않는다. 카톡 화면에서 1,000자를 스크롤하게 만들면 아무도 안 읽는다.
      // 기한(놓치면 끝나는 것) → 지금 당장 할 일 하나 → 확인 질문 하나. 나머지는 다음 턴에.
      const parts = [
        `## ${p.제목}`,
        ``,
        `⏰ **${p.기한}**`,
        ``,
        `**지금 먼저** — ${사용자문장(p.단계[0])}`,
      ];
      // 접수처는 '다음 행동'이라 빼지 않는다(8/9 결정: 문제 상황 → 관련 법 + 제출 방법).
      // 다만 섹션 제목을 달아 늘리지 않고 한 줄로 접는다.
      // 첫 화면은 여기까지다. 증거·접수처·근거법령까지 얹으면 다시 우다다가 된다
      // (2026-08-22 판단). 빼는 게 아니라 아래 진행 지침으로 내려, 모델이 들고 있다가
      // 대화가 그 지점에 왔을 때 꺼내게 한다.
      if (others) parts.push(``, `_상황이 다르다면: ${others}_`);
      parts.push(``, `---`, ``, 확인질문(top, p, c));
      return { content: [{ type: "text", text: withDisclaimer(parts.join("\n")) + 지침주석(진단보조지침(top)) }] };
    },
  );


  // 성립요건 안내 — "이것도 ○○에 해당하나요?" 질문 대응. 피해자·피신고자 양면 동선.
  // declaw: 해당 여부를 단정하지 않고 법령상 요건·정황 대조 정보만 제공. 최종 판단은 수사기관·법원.
  server.registerTool(
    "check_elements",
    {
      title: "해당 여부 기준 안내 (성립요건)",
      description:
        `"이것도 ○○에 해당하나요?" 신고 전 자가진단 — ${ELEMENT_KEYS.length}개 유형의 법률상 성립요건 + 해당/비해당 정황 + 신고하려는 쪽·신고당한 쪽 양면 다음 단계. 해당 여부를 묻는 질문에는 모델 지식으로 답하지 말고 이 도구를 호출하세요. 단정 아님 — 최종 판단은 수사기관·법원.\n` +
        `[트리거 예시] "인스타 스토리 염탐도 스토킹으로 처벌 가능한가요?" / "빌려준 돈 신고 가능할까요?" / "수습기간 중 해고당했는데 부당해고에 해당되는지 궁금합니다" / "전세사기 집을 중개한 부동산 처벌 가능한가요?" / "잘못 신고하면 저도 처벌받나요?"\n` +
        `[EN] Explains the statutory elements of an offence or claim so the user can self-check whether their situation may qualify. Not a determination.\n` +
        `Service: ${SVC}.`,
      inputSchema: {
        issue: z.enum(ELEMENT_KEYS).describe("확인할 유형: " + ELEMENT_KEYS.join(" | ")),
        perspective: z.enum(["피해측", "피신고측", "중립"]).optional().describe("사용자 입장 — 신고·대응을 고민하는 쪽=피해측, 신고당했거나 걱정되는 쪽=피신고측. 모르면 중립(기본)"),
      },
      annotations: { title: "해당 여부 기준 안내", ...READONLY },
    },
    async ({ issue, perspective }) => {
      const g = ELEMENTS[issue];
      const p = perspective ?? "중립";
      const parts = [
        `## ⚖️ ${g.제목} — 법에서는 이렇게 봅니다`,
        "",
        "### 법률상 성립요건",
        ...g.요건.map((s) => `- ${s}`),
        "",
        "### ✅ 해당 가능성을 높이는 정황",
        ...g.해당가능정황.map((s) => `- ${s}`),
        "",
        "### ❌ 해당이 어렵거나 다른 문제로 다뤄질 수 있는 정황",
        ...g.비해당가능정황.map((s) => `- ${s}`),
        "",
      ];
      if (p !== "피신고측") {
        parts.push("### 🙋 신고·대응을 고민하는 쪽이라면", ...g.피해자다음단계.map((s) => `- ${s}`), "");
      }
      if (p !== "피해측") {
        parts.push("### 🛡️ 신고당했거나 걱정되는 쪽이라면", ...g.피신고자다음단계.map((s) => `- ${s}`), "");
      }
      parts.push(
        "### 근거 법령",
        ...g.근거법.map((s) => `- ${s}`),
        "",
        "> ⚠️ 위 내용은 요건 '기준' 안내입니다. 실제 해당 여부는 구체적 사실관계에 따라 달라지며 **최종 판단은 수사기관·법원의 몫**입니다. 판단이 어렵거나 사안이 중대하면 대한법률구조공단 ☎132(무료)·변호사 상담을 권합니다.",
      );
      return { content: [{ type: "text", text: withDisclaimer(parts.join("\n")) }] };
    },
  );

  // 무료 법률지원·구제 연결 — 무료상담/소송대리/소송구조/구제금/핫라인 라우팅(자격 단정 아님).
  server.registerTool(
    "find_legal_aid",
    {
      title: "무료 법률지원·구제 연결",
      description:
        `무료 법률지원·구제 연결 — 대한법률구조공단(132) 무료상담·소송구조·범죄피해구조금·대지급금·상황별 핫라인(여성긴급 1366 등). 자격 판정이 아닌 안내.\n` +
        `[트리거 예시] "변호사 살 돈이 없어요" / "무료로 법률 상담 받을 수 있는 곳 있어요?" / "국가에서 대신 받아주는 제도 있다던데" / "이주여성인데 도움받을 곳 있나요?"\n` +
        `[EN] Routes to free legal aid, victim compensation and welfare benefits, with how to apply and what to bring.\n` +
        `Service: ${SVC}.`,
      inputSchema: {
        keyword: z.string().max(200).optional().describe("상황·필요(예: 무료변호사, 체불, 범죄피해, 소송비용, 상담). 비우면 전체"),
      },
      annotations: { title: "무료 법률지원·구제 연결", ...READONLY },
    },
    async ({ keyword }) => {
      const kw = keyword ? safeInput(keyword) : keyword;
      const hot = HOTLINES.map((h) => `- **${h.번호}** — ${h.기관} (${h.용도})`).join("\n");
      const detail = (p: (typeof SUPPORT_PROGRAMS)[number]) => {
        const base = `### ${p.명칭}\n- **대상**: ${p.대상}\n- **내용**: ${p.내용}\n- **연락**: ${p.연락}`;
        const g = APPLICATION_GUIDE[p.명칭];
        if (!g) return base;
        const steps = g.절차.map((s, i) => `${i + 1}) ${s}`).join(" ");
        return `${base}\n- **📝 신청절차**: ${steps}\n- **📎 준비서류**: ${g.준비물.join(" · ")}`;
      };
      const 꼬리 = `\n\n> 위는 제도·기준 안내이며 자격을 확정하지 않습니다. 실제 지원 여부는 해당 기관(특히 대한법률구조공단 132)에서 확인하세요.`;
      if (!kw) {
        // 키워드 없으면 전체 색인(명칭 + 대표 키워드) + 핫라인
        const idx = SUPPORT_PROGRAMS.map((p) => `- ${p.명칭} [${p.키워드.slice(0, 3).join("·")}]`).join("\n");
        const text = `## 📑 무료 법률지원·구제 프로그램 ${SUPPORT_PROGRAMS.length}개\n상황 키워드로 검색하세요 — 예: 성폭력 / 전세사기 / 의료사고 / 체불 / 장애인 / 채무 / 양육비 / 통신\n\n${idx}\n\n### 📞 24시간·대표 핫라인\n${hot}${꼬리}`;
        return { content: [{ type: "text", text: withDisclaimer(text) }] };
      }
      const matched = SUPPORT_PROGRAMS.filter((p) => p.명칭.includes(kw) || p.대상.includes(kw) || p.내용.includes(kw) || p.키워드.some((k) => k.includes(kw) || kw.includes(k)));
      if (!matched.length) {
        const text = `'${kw}'에 딱 맞는 프로그램을 못 찾았습니다. 우선 아래로 문의하세요:\n\n${detail(SUPPORT_PROGRAMS[0])}\n\n다른 키워드(예: 성폭력·전세사기·의료사고·체불·장애인·채무)로 다시 검색하거나, 비우면 전체 목록을 봅니다.\n\n### 📞 핫라인\n${hot}${꼬리}`;
        return { content: [{ type: "text", text: withDisclaimer(text) }] };
      }
      const shown = matched.slice(0, 8);
      const more = matched.length > 8 ? `\n\n_(외 ${matched.length - 8}개 — 키워드를 더 좁혀보세요)_` : "";
      const text = `## 🤝 '${kw}' 관련 무료 법률지원·구제 (${matched.length}개)\n\n${shown.map(detail).join("\n\n")}${more}${꼬리}`;
      return { content: [{ type: "text", text: withDisclaimer(text) }] };
    },
  );
  server.registerTool(
    "get_procedure",
    {
      title: "절차 안내",
      description:
        `주제별 공식 대응 절차 — 관할기관·법정기한·온라인 접수처·순서대로의 단계·근거 법령(law.go.kr 대조). "어떻게 하나요/어디에 신고하나요" 질문에 사용.\n` +
        `[트리거 예시] "임금체불 신고 절차 알려줘" / "상속포기 어떻게 하나요?" / "전세보증금 반환 소송 절차가 궁금해요" / "장애인 등록은 어디서 하나요?"\n` +
        `[EN] Step-by-step procedure for a topic - deadlines, competent authority, governing statutes, and online filing.\n` +
        `Service: ${SVC}.`,
      inputSchema: { topic: z.enum(TOPIC_KEYS).describe(TOPIC_DESC) },
      annotations: { title: "절차 안내", ...READONLY },
    },
    async ({ topic }) => ({
      // 절차를 본 다음 대개 서식이 필요해진다. 어떤 서식인지 키를 함께 주지 않으면
      // 모델이 서식을 직접 지어내는 쪽으로 샌다 — 진행 지침에 키와 호출 시점을 싣는다.
      content: [{ type: "text", text: withDisclaimer(절차텍스트(topic)) + 지침주석(진단보조지침(topic)) }],
    }),
  );

  server.registerTool(
    "get_checklist",
    {
      title: "필요 서류·증거 체크리스트",
      description:
        `주제별로 모아둘 증거 + 접수용 준비서류 체크리스트.\n` +
        `[트리거 예시] "임금체불 신고하려면 뭘 준비해야 해요?" / "전세금 소송에 필요한 증거가 뭐예요?" / "고소하려면 어떤 서류가 필요해요?"\n` +
        `[EN] Documents and evidence to prepare for a topic, and where each one is issued.\n` +
        `Service: ${SVC}.`,
      inputSchema: { topic: z.enum(TOPIC_KEYS).describe(TOPIC_DESC) },
      annotations: { title: "필요 서류·증거 체크리스트", ...READONLY },
    },
    async ({ topic }) => {
      const c = CHECKLISTS[topic];
      if (!c) {
        return { content: [{ type: "text", text: withDisclaimer(`'${topic}' 주제의 준비 서류 목록은 아직 없습니다.

<!-- 진행 지침: search_topics로 주제 키를 다시 확인한다. 도구 이름은 노출하지 말 것. -->`) }] };
      }
      const text = [
        `## 🗂️ ${PROCEDURES[topic]?.제목 ?? topic} — 준비 체크리스트`,
        "",
        "### 모아둘 증거",
        ...c.증거.map((s) => `- [ ] ${s}`),
        "",
        "### 접수용 준비서류",
        ...c.준비서류.map((s) => `- [ ] ${s}`),
      ].join("\n");
      // 준비서류를 확인한 사용자의 다음 행동은 거의 서식 작성이다. 여기서 키를 놓치면 흐름이 끊긴다.
      return { content: [{ type: "text", text: withDisclaimer(text) + 지침주석(진단보조지침(topic)) }] };
    },
  );

  server.registerTool(
    "get_form_template",
    {
      title: "표준 서식 제공",
      description:
        // 이 도구의 inputSchema enum에 서식 114종 이름이 그대로 실려 모델 컨텍스트에 들어간다.
        // 그래서 모델이 "나는 이미 목록을 안다"고 판단해 호출하지 않고 이름만 나열해 버린다 —
        // "임대차 서식 내놔"에 서식 4종을 말로만 읊고, "1번"이라고 찍어줘야 그제서야 불렀다
        // (2026-08-22 프리뷰 확인). 그래서 "나열하지 말고 즉시 호출"을 맨 앞에 못 박는다.
        `**서식·양식 이야기가 나오면 목록을 말로 나열하지 말고 즉시 이 도구를 호출하세요.** ` +
        `어떤 서식인지 되묻지 말고, 대화 맥락에서 가장 가까운 서식 하나로 먼저 호출하면 됩니다. ` +
        `카드가 떠야 사용자가 빈칸을 채우고 인쇄·다운로드할 수 있습니다 — 이름만 알려주는 것은 쓸모가 없습니다.\n` +
        `표준 서식 ${FORM_KEYS.length}종의 빈칸 채움 골격 + 작성요령 + 공식 양식 출처 + 제출 접수처. 모바일 미리보기(빈칸을 탭해 입력·인쇄/PDF 저장)와 한글(.hwpx)·워드(.docx)·텍스트 다운로드 제공.\n` +
        `[트리거 예시] "내용증명 양식 줘" / "고소장 어떻게 써요?" / "차용증 써야 하는데" / "기초연금 신청서 양식 있어?" / "월급 못 받은 거 내용증명 보내고 싶어요"\n` +
        // 이 서비스의 핵심 산출물이다. 사용자가 '양식'이라는 단어를 쓸 때만 부르면 대부분 놓친다 —
        // 실제로는 확인 질문이 끝나고 안내를 마무리하는 시점에 필요해진다. 그 시점을 명시한다.
        `[호출 시점] 사용자가 서식·양식·신청서·진정서·고소장·내용증명·계약서를 요구할 때는 물론, ` +
        `확인 질문이 끝나 안내를 마무리할 때, 대화가 '어떻게 접수하느냐/뭘 써서 내느냐'로 넘어갈 때도 호출하세요. ` +
        `서식 키는 triage·get_procedure·get_checklist가 돌려준 진행 지침에 실려 옵니다. ` +
        `서식 본문을 직접 지어내지 말고 반드시 이 도구로 받으세요.\n` +
        `[EN] Returns a fill-in-the-blank Korean official form template with drafting notes and download links. Not auto-filled.\n` +
        `Service: ${SVC}.`,
      inputSchema: { form: z.enum(FORM_KEYS).describe("서식 키. get_procedure/search_topics에서 안내된 서식명을 사용") },
      annotations: { title: "표준 서식 제공", ...READONLY },
    },
    async ({ form }) => {
      const f = FORMS[form];
      if (!f) {
        return { content: [{ type: "text", text: withDisclaimer(`'${form}' 서식이 없습니다.`) }] };
      }
      const submit = formSubmitInfo(form);
      // 카카오 툴즈: 서식 카드 위젯(빈칸 채우기·접수처·txt 버튼) — 본문·작성요령은 미리보기 페이지가 담당.
      // for_assistant: 카드에는 본문이 없어 호스트 AI가 초안을 못 만들므로, 렌더러가 무시하는 별도 필드로 본문+지침 동봉.
      if (widgetsOn() && baseUrl) {
        return { content: [{ type: "text", text: kakaoWidgetText({ ...buildFormWidget(form, f, baseUrl, submit ?? undefined), name: "get_form_template", for_assistant: 작성보조지침(f) }) }] };
      }
      const head = [`## 📝 ${f.제목}`, `**용도**: ${f.용도}`];
      if (f.공식양식) head.push(`**📄 공식 양식 받는 곳**: ${f.공식양식}`);
      if (submit) head.push(`**🏛️ 어디에 내나요(접수처)**: ${submit.관할} — ${submit.온라인접수}`);
      const tail = ["### ✍️ 작성요령", ...f.작성요령.map((s) => `- ${s}`), "", 작성지침(f)];
      if (baseUrl) {
        tail.push(
          "",
          `**🖊️ 빈칸 바로 채우기(모바일 미리보기·인쇄/PDF 저장)**: ${baseUrl}/forms/${encodeURIComponent(form)}`,
          "링크를 누르면 이 서식이 문서 화면으로 열립니다 — [빈칸]을 탭해 본인 정보를 직접 입력하고 인쇄·PDF로 저장하세요.",
          `**📎 서식 다운로드(한글·워드·텍스트)**: ${baseUrl}/forms/${encodeURIComponent(form)}#save` +
            (f.공식양식 ? " (관공서 제출본은 위 '공식 양식 받는 곳'에서 정식 서식을 받아 작성)" : ""),
        );
      }
      // 서식 본문은 코드블록으로 감싸 마크다운 해석(대괄호·번호목록 변형)을 차단하고 원형 유지.
      const text = [...head, "", "```", f.본문, "```", "", ...tail].join("\n");
      return { content: [{ type: "text", text: withDisclaimer(text) + `

<!-- 진행 지침: 서식 전문을 다시 출력하지 말고, 사용자가 말한 사실로 채운 초안이나 확인 질문만 제시한다. 도구 이름은 노출하지 말 것. -->` }] };
    },
  );

  server.registerTool(
    "get_precedent",
    {
      title: "판례 조회",
      description:
        `검증된 판례 조회(사건번호·요지·casenote 링크) — 실재 확인된 것만 수록하며 없으면 없다고 답합니다.\n` +
        `[트리거 예시] "비슷한 판례 있어요?" / "보일러 수리비 관련 판례 알려줘" / "법원이 이런 경우 어떻게 판단했어요?" / "전세보증금 판례 찾아줘"\n` +
        `[EN] Looks up verified Korean court decisions by keyword or topic; returns nothing rather than inventing a case.\n` +
        `Service: ${SVC}.`,
      inputSchema: {
        keyword: z.string().max(200).optional().describe("주제 키 또는 검색어(예: 전세보증금반환, 사기, 해고, 지급명령). 비우면 판례가 있는 주제 목록"),
      },
      annotations: { title: "판례 조회", ...READONLY },
    },
    async ({ keyword: rawKeyword }) => {
      const keyword = rawKeyword ? safeInput(rawKeyword) : rawKeyword;
      const entries = Object.entries(PRECEDENTS).filter(([, v]) => v.length > 0);
      if (!keyword) {
        const topics = entries.map(([k]) => `- \`${k}\` — ${PROCEDURES[k]?.제목 ?? ""}`).join("\n");
        return { content: [{ type: "text", text: withDisclaimer(`## ⚖️ 판례가 등록된 주제\n\n${topics}\n\n키워드를 넣으면 해당 판례를 보여드립니다.`) }] };
      }
      const matchedAll = entries
        .filter(([k, v]) => k.includes(keyword) || v.some((p) => p.요지.includes(keyword) || p.사건번호.includes(keyword) || p.법원.includes(keyword)))
        .flatMap(([, v]) => v);
      if (!matchedAll.length) {
        return { content: [{ type: "text", text: withDisclaimer(`'${keyword}'에 해당하는 등록 판례를 찾지 못했습니다. (등록된 판례만 조회되며, 없는 판례는 지어내지 않습니다.)`) }] };
      }
      // 결과가 너무 많으면 응답이 비대해지고 모델 컨텍스트도 낭비된다 — 상위 20건만 보여주고 더 좁혀 재검색하도록 안내.
      const RESULT_CAP = 20;
      const matched = matchedAll.slice(0, RESULT_CAP);
      const more = matchedAll.length > RESULT_CAP ? `\n\n_총 ${matchedAll.length}건 중 ${RESULT_CAP}건 표시 — 더 구체적인 키워드로 다시 검색해 주세요._` : "";
      const body = matched.map((p) => `- **${p.법원} ${p.사건번호}**\n  ${p.요지}`).join("\n") + more;
      const caseNos = [...new Set(matched.map((p) => p.사건번호.replace(/\s|\(.*?\)/g, "").split(",")[0]).filter(Boolean))].slice(0, 5);
      const caseLinks = caseNos.map((no) => `- [${no}](https://casenote.kr/search/?q=${encodeURIComponent(no)})`).join("\n");
      return { content: [{ type: "text", text: withDisclaimer(`## ⚖️ 판례 (검색: ${keyword})\n\n${body}\n\n### 원문 (사건번호로 바로 검색)\n${caseLinks}\n\n또는 [국가법령정보센터](https://www.law.go.kr) · [CaseNote](https://casenote.kr)`) }] };
    },
  );

  server.registerTool(
    "calculate_amount",
    {
      title: "금액 계산기",
      description:
        `금액 계산(같은 입력 → 같은 결과, 추정 금지) — 체불임금·퇴직금·주휴수당·지연이자(연 20%)·셀프등기 절감액·상속등기 비용. 개략 계산입니다.\n` +
        `[트리거 예시] "퇴직금 얼마 받을 수 있어요? 월급 300에 3년 일했어요" / "밀린 월급 지연이자까지 계산해줘" / "주휴수당 계산해줘" / "근저당 말소 셀프로 하면 얼마 들어요?"\n` +
        `[EN] Deterministic money calculations - unpaid wages, severance, weekly holiday allowance, late interest, self-registration savings.\n` +
        `Service: ${SVC}.`,
      inputSchema: {
        item: z.enum(항목값).describe("체불임금 | 퇴직금 | 주휴수당 | 지연이자 | 셀프등기절감액"),
        monthly_wage: z.number().finite().nonnegative().optional().describe("[체불임금] 월 정상 임금(원)"),
        unpaid_months: z.number().finite().nonnegative().optional().describe("[체불임금] 미지급 개월 수"),
        other_unpaid: z.number().finite().nonnegative().optional().describe("[체불임금] 기타 미지급액(원)"),
        daily_avg_wage: z.number().finite().nonnegative().optional().describe("[퇴직금] 1일 평균임금(원)"),
        tenure_days: z.number().finite().nonnegative().optional().describe("[퇴직금] 총 재직일수"),
        weekly_hours: z.number().finite().nonnegative().optional().describe("[주휴수당] 1주 소정근로시간"),
        hourly_wage: z.number().finite().nonnegative().optional().describe("[주휴수당] 시급(원)"),
        principal: z.number().finite().nonnegative().optional().describe("[지연이자] 미지급 원금(원)"),
        delay_days: z.number().finite().nonnegative().optional().describe("[지연이자] 지연 일수"),
        property_count: z.number().int().positive().optional().describe("[셀프등기절감액·상속등기비용] 부동산 개수 — 아파트 등 집합건물 1, 단독주택 토지+건물 2 (기본 1)"),
        e_filing: z.boolean().optional().describe("[셀프등기절감액·상속등기비용] 인터넷등기소 전자신청(e-Form) 여부 — 수수료가 낮아짐 (기본 false)"),
        assessed_value: z.number().finite().nonnegative().optional().describe("[상속등기비용] 상속 부동산의 시가표준액(공시가격, 원) — 취득세 계산 기준"),
        farmland: z.boolean().optional().describe("[상속등기비용] 농지 여부 — true면 취득세 2.3%, false면 2.8% (기본 false)"),
      },
      annotations: { title: "금액 계산기", ...READONLY },
    },
    async (a) => {
      const need = (cond: boolean, msg: string) => {
        if (!cond) throw new Error(`입력값이 부족합니다: ${msg}`);
      };
      let r;
      try {
        switch (a.item) {
          case "체불임금":
            need(a.monthly_wage != null && a.unpaid_months != null, "monthly_wage, unpaid_months");
            r = calcUnpaidWages(a.monthly_wage!, a.unpaid_months!, a.other_unpaid ?? 0);
            break;
          case "퇴직금":
            need(a.daily_avg_wage != null && a.tenure_days != null, "daily_avg_wage, tenure_days");
            r = calcSeverance(a.daily_avg_wage!, a.tenure_days!);
            break;
          case "주휴수당":
            need(a.weekly_hours != null && a.hourly_wage != null, "weekly_hours, hourly_wage");
            r = calcWeeklyHolidayPay(a.weekly_hours!, a.hourly_wage!);
            break;
          case "지연이자":
            need(a.principal != null && a.delay_days != null, "principal, delay_days");
            r = calcDelayInterest(a.principal!, a.delay_days!);
            break;
          case "셀프등기절감액":
            r = calcSelfCancelRegistryCost(a.property_count ?? 1, a.e_filing ?? false);
            break;
          case "상속등기비용":
            need(a.assessed_value != null, "assessed_value(시가표준액)");
            r = calcInheritanceRegistryCost(a.assessed_value!, a.property_count ?? 1, a.farmland ?? false, a.e_filing ?? false);
            break;
        }
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: withDisclaimer((e as Error).message) }] };
      }
      if (widgetsOn()) {
        return { content: [{ type: "text", text: kakaoWidgetText({ ...buildCalcWidget(a.item, r!), name: "calculate_amount", for_assistant: 계산보조지침 }) }] };
      }
      const text = [
        `## 🧮 ${a.item} 계산 결과`,
        "",
        `- **결과**: ${r!.결과}`,
        `- **계산식**: ${r!.계산식}`,
        r!.비고 ? `- **비고**: ${r!.비고}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      return { content: [{ type: "text", text: withDisclaimer(text) + `

<!-- 진행 지침: ${계산보조지침} -->` }] };
    },
  );

  server.registerTool(
    "get_statute",
    {
      title: "법령 요지 조회",
      description:
        `주요 조문의 쉬운 요지 + 국가법령정보센터 원문 링크.\n` +
        `[트리거 예시] "임대인 수선의무 법 조항이 뭐예요?" / "사기죄 처벌 조항 알려줘" / "무슨 법에 근거가 있어요?"\n` +
        `[EN] Plain-language summaries of key Korean statutory provisions with links to the official law database.\n` +
        `Service: ${SVC}.`,
      inputSchema: { keyword: z.string().max(200).optional().describe("예: 해고, 보증금, 소멸시효, 청약철회, 사기, 지급명령 (비우면 전체)") },
      annotations: { title: "법령 요지 조회", ...READONLY },
    },
    async ({ keyword: rawKeyword }) => {
      const keyword = rawKeyword ? safeInput(rawKeyword) : rawKeyword;
      const listAll = keyword
        ? STATUTES.filter((s) => s.요지.includes(keyword) || s.조문.includes(keyword) || s.법령.includes(keyword))
        : STATUTES;
      if (!listAll.length) {
        return { content: [{ type: "text", text: withDisclaimer(`'${keyword}'에 해당하는 조문을 찾지 못했습니다.`) }] };
      }
      // keyword 없이 호출(전체 조회)하거나 흔한 단어로 검색하면 목록이 커질 수 있어 상위 20건만 보여준다.
      const RESULT_CAP = 20;
      const list = listAll.slice(0, RESULT_CAP);
      const more = listAll.length > RESULT_CAP ? `\n\n_총 ${listAll.length}건 중 ${RESULT_CAP}건 표시 — 키워드로 좁혀 다시 조회해 주세요._` : "";
      const body = list.map((s) => `- **${s.법령} ${s.조문}** — ${s.요지}`).join("\n") + more;
      const laws = [...new Set(list.map((s) => s.법령))];
      const links = laws.map((n) => `- [${n}](https://www.law.go.kr/법령/${encodeURIComponent(n)})`).join("\n");
      const text = `## ⚖️ 법령 요지${keyword ? ` (검색: ${keyword})` : ""}\n\n${body}\n\n### 원문 (국가법령정보센터)\n${links}\n\n> 조문 전문·신구조문·관련 판례 등 더 깊은 원문은 국가법령정보센터(law.go.kr)·찾기쉬운 생활법령정보(easylaw.go.kr)에서 확인하세요.`;
      return { content: [{ type: "text", text: withDisclaimer(text) }] };
    },
  );


  // 판례·법령 인용 검증(+유효성) — 환각 차단. 우리 저장소에 실재하는지 확인하고 폐기·하급심 등 주의를 표시.
  server.registerTool(
    "verify_citation",
    {
      title: "판례·법령 인용 검증",
      description:
        `사건번호·법령 조문이 실재하는지 대조하고 폐기·하급심·법개정 등 주의를 표시. 모르는 인용은 지어내지 않고 공식 조회 링크로 안내(환각 차단).\n` +
        `[트리거 예시] "대법원 94다34692 진짜 있는 판례야?" / "이 판례 믿어도 돼요?" / "민법 623조가 맞는 조문인지 확인해줘"\n` +
        `[EN] Checks whether a cited case number or statutory article actually exists, and flags overruled, lower-court or amended ones.\n` +
        `Service: ${SVC}.`,
      inputSchema: {
        citation: z.string().max(200).describe("검증할 사건번호 또는 법령 조문 (예: 2020다247190 / 대법원 2024도10141 / 민법 제759조 / 상가건물 임대차보호법 제10조의4)"),
      },
      annotations: { title: "판례·법령 인용 검증", ...READONLY },
    },
    async ({ citation: rawCitation }) => {
      const raw = safeInput(rawCitation);
      const lines: string[] = [];
      const notes: string[] = [];

      // 1) 판례(사건번호) — 질의에서 사건번호를 뽑아 정확 대조.
      //    종전엔 질의 문자열의 부분포함으로 봤는데, 그러면 "2020"만 쳐도 2020년 판례가 전부 확인됐다.
      const queried = extractCaseNumbers(raw);
      const matchedNos = new Set<string>();
      const seen = new Set<string>();
      for (const [k, arr] of Object.entries(PRECEDENTS)) {
        for (const p of arr) {
          if (!queried.some((q) => matchCaseNumber(q, p.사건번호)) || seen.has(p.사건번호 + k)) continue;
          seen.add(p.사건번호 + k);
          matchedNos.add(caseCore(p.사건번호));
          lines.push(`✅ [판례·수록확인] ${p.법원} ${p.사건번호} (주제: ${k})\n   ${p.요지}`);
        }
      }

      // 2) 법령 조문 — 법령명을 명시적으로 뽑아 대조.
      //    법령명이 안 뽑히면 조문만으로 확인해주지 않는다(어느 법인지 모른 채 ✅는 오답이다).
      const art = parseArticle(raw);
      if (art) {
        const sameJo = STATUTES.filter((s) => normalizeLawName(s.조문) === art.display);
        if (art.lawName) {
          const hits = sameJo.filter((s) => matchLawName(art.lawName!, s.법령));
          for (const s of hits) lines.push(`✅ [법령·수록확인] ${s.법령} ${s.조문} — ${s.요지}`);
          if (!hits.length) {
            notes.push(
              `ℹ️ **'${art.lawName} ${art.display}' — 이 서비스 저장소에서 확인되지 않았습니다.** 저장소는 생활법률 중심 발췌본이라 미수록이 곧 '없는 조문'이라는 뜻은 아닙니다. 아래 원문에서 확인하세요.`,
            );
          }
        } else if (sameJo.length) {
          // 법령명 불명확 — 확인이 아니라 후보 제시. 어느 법인지는 사용자가 골라야 한다.
          notes.push(
            `⚠️ **법령명을 특정할 수 없어 조문 실존은 확인하지 못했습니다.** ('${art.display}'만 인용됨) 저장소에서 같은 조문 번호를 쓰는 법령은 다음과 같습니다 — 어느 법인지 알려주시면 대조해 드립니다:\n` +
              sameJo
                .slice(0, 8)
                .map((s) => `   - ${s.법령} ${s.조문} — ${s.요지}`)
                .join("\n") +
              (sameJo.length > 8 ? `\n   - …외 ${sameJo.length - 8}건` : ""),
          );
        }
      }

      // 3) 유효성 주의(폐기·하급심·헌법불합치 등) — 질의한 번호 또는 매칭된 번호 모두 점검
      const statusKeys = Object.keys(CITATION_STATUS).filter(
        (no) => queried.some((q) => matchCaseNumber(q, no)) || matchedNos.has(caseCore(no)),
      );
      for (const no of statusKeys) {
        const st = CITATION_STATUS[no];
        lines.push(`⚠️ [유효성] ${no} — ${st.라벨}: ${st.설명}`);
      }

      const enc = encodeURIComponent(raw);
      const 원문 = `- [국가법령정보센터에서 검색](https://www.law.go.kr/precScListR.do?menuId=1&query=${enc})\n- [CaseNote에서 검색](https://casenote.kr/search/?q=${enc})`;
      if (!lines.length) {
        const head = notes.length
          ? notes.join("\n\n")
          : "**이 서비스의 검증된 저장소에서 확인되지 않았습니다.**\n없는 판례·법령은 지어내지 않으니, 아래에서 직접 확인하세요:";
        return { content: [{ type: "text", text: withDisclaimer(`## 🔍 인용 검증: '${raw}'\n\n${head}\n\n${원문}`) }] };
      }
      const body = [lines.map((l) => `- ${l}`).join("\n"), ...notes].join("\n\n");
      return { content: [{ type: "text", text: withDisclaimer(`## 🔍 인용 검증: '${raw}'\n\n${body}\n\n원문 확인: [law.go.kr](https://www.law.go.kr) · [casenote.kr](https://casenote.kr)`) }] };
    },
  );

  // 시점법 — 최근 법령·판례 변경과 시행일(사건 발생 시점에 적용되는 법이 다를 수 있음).
  server.registerTool(
    "law_updates",
    {
      title: "최근 법령·판례 변경(시점법)",
      description:
        `최근 법 개정·시행일 확인(시점법) — 사건 당시 어느 법이 적용되는지 판단할 때.\n` +
        `[트리거 예시] "임대차법 최근 개정된 거 있어요?" / "스토킹처벌법 언제부터 시행됐어요?" / "작년 사건인데 지금 법이 적용되나요?"\n` +
        `[EN] Recent Korean statutory and case-law changes with effective dates, so the law applicable at the time can be identified.\n` +
        `Service: ${SVC}.`,
      inputSchema: {
        keyword: z.string().max(200).optional().describe("예: 스토킹 / 통상임금 / 유류분 / 임대차 / 개인정보 / 출퇴근 (비우면 최근 변경 전체)"),
      },
      annotations: { title: "최근 법령·판례 변경", ...READONLY },
    },
    async ({ keyword }) => {
      const kw = keyword ? safeInput(keyword) : keyword;
      const list = kw
        ? LAW_TIMELINE.filter((c) => c.법령.includes(kw) || c.요지.includes(kw) || c.키워드.some((x) => x.includes(kw) || kw.includes(x)))
        : LAW_TIMELINE;
      if (!list.length) {
        return { content: [{ type: "text", text: withDisclaimer(`'${kw}' 관련 최근 변경 정보가 없습니다. 다른 키워드로 검색하거나 비우고 전체를 확인하세요.`) }] };
      }
      const body = list.map((c) => `- **${c.법령}** — ${c.변경}\n  - 시행/적용: ${c.시행일}\n  - ${c.요지}`).join("\n");
      return { content: [{ type: "text", text: withDisclaimer(`## 🕒 최근 법령·판례 변경${kw ? ` (검색: ${kw})` : ""}\n\n${body}\n\n> 사건 발생 시점에 적용되는 법이 다를 수 있습니다. 정확한 시행일·경과규정은 law.go.kr에서 확인하세요.`) }] };
    },
  );


  // 소송비용 계산기 — 민사 인지대·송달료(전자소송 감액·심급 배수 포함). 공시 산식 기반.
  server.registerTool(
    "calculate_court_cost",
    {
      title: "소송비용 계산기 (인지대·송달료)",
      description:
        `민사 소송비용(인지대·송달료) 법정 산식 계산 — 소가·당사자 수·절차 종류·전자소송 감액 반영. 개략 계산입니다.\n` +
        `[트리거 예시] "500만원 소송하면 비용이 얼마나 들어요?" / "소액재판 인지대 계산해줘" / "소송 비용 부담돼서 고민이에요"\n` +
        `[EN] Calculates court filing fees and service costs for a given claim amount.\n` +
        `Service: ${SVC}.`,
      inputSchema: {
        claim_amount: z.number().finite().nonnegative().describe("소가(청구금액, 원). 금전청구는 청구액"),
        parties: z.number().int().min(2).describe("당사자 수(원고 수 + 피고 수, 최소 2)"),
        track: z.enum(["소액", "단독", "합의", "지급명령", "조정", "항소", "상고", "보전"]).describe("절차 종류(소액=3천만↓ / 단독 / 합의 / 지급명령 / 조정 / 항소 / 상고 / 보전=가압류·가처분)"),
        e_litigation: z.boolean().optional().describe("전자소송 여부(true면 인지대 10% 감액). 기본 false"),
      },
      annotations: { title: "소송비용 계산기", ...READONLY },
    },
    async ({ claim_amount, parties, track, e_litigation }) => {
      const r = calcCourtCost(claim_amount, parties, track, e_litigation ?? false);
      if (widgetsOn()) {
        return { content: [{ type: "text", text: kakaoWidgetText({ ...buildCalcWidget("소송비용(개략)", r), name: "calculate_court_cost", for_assistant: 계산보조지침 }) }] };
      }
      const text = `## 🧮 소송비용(개략)\n\n- **결과**: ${r.결과}\n- **계산식**: ${r.계산식}\n\n> 💡 ${r.비고}`;
      return { content: [{ type: "text", text: withDisclaimer(text) + `

<!-- 진행 지침: ${계산보조지침} -->` }] };
    },
  );

  // 기한/소멸시효 계산기 — 기준일 + 법정기간 → 마감일·남은일수. 기산점·중단/예외 경고 포함.
  server.registerTool(
    "calculate_deadline",
    {
      title: "기한·소멸시효 계산기",
      description:
        `기한·소멸시효 D-day 계산(상속포기 3개월·항소 2주·부당해고 구제 3개월·임금채권 3년 등). 사용자가 "언제까지"를 묻거나 경과 시간("두 달 지났는데")을 말하면 호출하세요 — 기한을 놓치면 권리가 사라집니다. 기산점은 사실관계에 따라 확인 필요.\n` +
        `[트리거 예시] "아버지가 돌아가신 지 두 달인데 상속포기 아직 돼요?" / "해고당한 게 언제까지 신고 가능해요?" / "빌려준 지 9년 됐는데 너무 늦었나요?"\n` +
        `[EN] Calculates statutory deadlines and limitation periods from a given start date.\n` +
        `Service: ${SVC}.`,
      inputSchema: {
        start_date: z.string().describe("기산 기준일 (YYYY-MM-DD). 예: 해고일, 사고일, 송달받은 날"),
        deadline_type: z.enum(Object.keys(DEADLINES) as [string, ...string[]]).describe("기한 종류(예: 부당해고_구제신청, 불법행위_손해배상시효, 민사_항소, 상속포기_한정승인 등)"),
      },
      annotations: { title: "기한·소멸시효 계산기", ...READONLY },
    },
    async ({ start_date, deadline_type }) => {
      const rule = DEADLINES[deadline_type];
      const r = calcDeadline(start_date, rule.기간);
      if (!r) {
        return { content: [{ type: "text", text: withDisclaimer(`날짜 형식이 올바르지 않습니다. 기준일을 YYYY-MM-DD 형식(예: 2026-06-23)으로 입력하세요.`) }] };
      }
      const 기간표시 = rule.기간.년 ? `${rule.기간.년}년` : rule.기간.월 ? `${rule.기간.월}개월` : `${rule.기간.일}일`;
      const status = r.남은일수 < 0 ? `⛔ 기한 경과 (${-r.남은일수}일 지남)` : r.남은일수 === 0 ? "⚠️ 오늘이 마감일" : `⏳ D-${r.남은일수} (${r.남은일수}일 남음)`;
      if (widgetsOn()) {
        const kw = buildCalcWidget(`⏰ ${deadline_type}`, {
          결과: `${r.마감일} · ${status}`,
          계산식: `기준일 ${start_date} + ${기간표시}`,
          비고: `기산점: ${rule.기산} / ${rule.경고}`,
        });
        // 기한은 놓치면 권리가 사라진다 — 남은 일수를 흐리게 말하지 않도록 따로 못 박는다.
        return {
          content: [
            {
              type: "text",
              text: kakaoWidgetText({
                ...kw,
                name: "calculate_deadline",
                for_assistant:
                  `${계산보조지침} 기한이 지났거나 임박했으면(D-30 이내) 그 사실을 첫 문장에서 분명히 말하고, ` +
                  "지금 당장 할 수 있는 것 한 가지를 제시한다.",
              }),
            },
          ],
        };
      }
      const text = [
        `## ⏰ 기한 계산: ${deadline_type}`,
        ``,
        `- **기준일**: ${start_date} + ${기간표시}`,
        `- **마감일**: ${r.마감일}`,
        `- **상태**: ${status}`,
        ``,
        `- **기산점**: ${rule.기산}`,
        `- **주의**: ${rule.경고}`,
        ``,
        `> 기산점·중단(청구·압류·승인)·정지 사유에 따라 실제 기한이 달라질 수 있으니 반드시 확인하세요.`,
      ].join("\n");
      return { content: [{ type: "text", text: withDisclaimer(text) + `

<!-- 진행 지침: ${계산보조지침} 기한이 지났거나 D-30 이내면 첫 문장에서 분명히 말하고 지금 할 수 있는 것 한 가지를 제시한다. -->` }] };
    },
  );


  // 증빙서류 발급 안내 — 준비서류를 '어디서 어떻게' 떼는지(발급처·온라인·수수료·팁) + 절약 꿀팁.
  server.registerTool(
    "how_to_get_document",
    {
      title: "증빙서류 발급 안내",
      description:
        `증빙서류 발급처·온라인 경로·수수료 안내(등기부등본·가족관계증명서·소득금액증명·진단서 등).\n` +
        `[트리거 예시] "등기부등본 어디서 떼요?" / "가족관계증명서 인터넷으로 발급돼요?" / "소송에 낼 서류들 발급처 알려줘"\n` +
        `[EN] Where and how to obtain supporting documents - issuing office, online link, fee, and practical tips.\n` +
        `Service: ${SVC}.`,
      inputSchema: {
        document: z.string().max(200).optional().describe("서류명/키워드(예: 등기부등본, 가족관계증명서, 소득금액증명, 진단서, 부채증명, 전입세대확인서). 비우면 전체 목록 + 준비 꿀팁"),
      },
      annotations: { title: "증빙서류 발급 안내", ...READONLY },
    },
    async ({ document }) => {
      const kw = document ? safeInput(document) : document;
      const tips = DOC_TIPS.map((t) => `- ${t}`).join("\n");
      const detail = (k: string) => {
        const g = DOCUMENT_GUIDE[k];
        return `### 📄 ${k}\n- **발급처**: ${g.발급처}\n- **온라인**: ${g.온라인}\n- **수수료**: ${g.수수료}\n- **팁**: ${g.팁}`;
      };
      if (!kw) {
        const idx = Object.keys(DOCUMENT_GUIDE).map((k) => `- ${k}`).join("\n");
        const text = `## 📑 증빙서류 발급 안내 (서류명으로 검색하세요)\n\n${idx}\n\n### ★ 서류 준비 꿀팁\n${tips}`;
        return { content: [{ type: "text", text: withDisclaimer(text) }] };
      }
      const matched = Object.keys(DOCUMENT_GUIDE).filter((k) => k.includes(kw) || DOCUMENT_GUIDE[k].별칭.some((a) => a.includes(kw) || kw.includes(a)));
      if (!matched.length) {
        const text = `'${kw}' 서류 발급 안내가 목록에 없습니다. 대부분의 행정서류는 정부24(gov.kr), 부동산 등기는 인터넷등기소(iros.go.kr), 세금 관련은 홈택스(hometax.go.kr)에서 발급됩니다.\n\n### ★ 서류 준비 꿀팁\n${tips}`;
        return { content: [{ type: "text", text: withDisclaimer(text) }] };
      }
      const text = `## 🗂️ '${kw}' 서류 발급 안내\n\n${matched.slice(0, 5).map(detail).join("\n\n")}\n\n### ★ 서류 준비 꿀팁\n${tips}`;
      return { content: [{ type: "text", text: withDisclaimer(text) }] };
    },
  );

  // 법률용어 풀이 — 일상어↔법률어 + 자주 보는 법정용어 뜻(정의만, declaw). 큐레이션·인메모리·키 불요.
  server.registerTool(
    "explain_term",
    {
      title: "법률용어 풀이",
      description:
        `법률용어·일상어 뜻풀이(각하/기각·가압류·공시송달·떼인 돈·빨간딱지 등). 정의만 제공.\n` +
        `[트리거 예시] "가압류가 뭐예요?" / "각하랑 기각이 뭐가 달라요?" / "공시송달이 무슨 뜻이에요?" / "내용증명이 뭔가요?"\n` +
        `[EN] Explains Korean legal terms in plain language, including commonly confused pairs. Definition only.\n` +
        `Service: ${SVC}.`,
      inputSchema: {
        term: z.string().max(200).describe("뜻이 궁금한 단어(법률용어 또는 일상어). 예: 각하, 가압류, 공시송달, 통상임금, 떼인 돈, 빨간딱지"),
      },
      annotations: { title: "법률용어 풀이", ...READONLY },
    },
    async ({ term }) => {
      const kw = safeInput(term);
      const nkw = kw.replace(/\s/g, "");
      if (nkw.length < 2) {
        return { content: [{ type: "text", text: withDisclaimer(`'${kw}'은(는) 너무 짧아 검색이 어렵습니다. 두 글자 이상으로 입력해 주세요(예: 각하, 압류, 통상임금).`) }] };
      }
      const matched = GLOSSARY.filter((t) => {
        const u = t.용어.replace(/\s/g, "");
        if (u.includes(nkw) || nkw.includes(u)) return true;
        // 별칭은 '질의가 별칭을 포함(또는 동일)'할 때만 — '대법원'이 별칭 '대법원 상고'에 부분일치해 상고로 오매칭되던 문제 방지.
        return (t.별칭 ?? []).some((a) => {
          const na = a.replace(/\s/g, "");
          return na.length >= 2 && nkw.includes(na);
        });
      }).slice(0, 6);
      if (!matched.length) {
        return { content: [{ type: "text", text: withDisclaimer(`'${kw}'은(는) 용어사전에 없습니다. 비슷한 말로 다시 찾거나, 상황 설명이면 search_topics("${kw}")로 관련 절차를 찾아보세요.\n공식 용어: 찾기쉬운 생활법령정보(https://www.easylaw.go.kr) · 국가법령정보센터 법령용어(https://www.law.go.kr)`) }] };
      }
      const body = matched
        .map((t) => {
          const lines = [`### 📖 ${t.용어} _[${t.분류}]_`, t.풀이];
          if (t.헷갈림) lines.push(`- **⚖ 구별**: ${t.헷갈림}`);
          if (t.별칭?.length) lines.push(`- **다른 말**: ${t.별칭.join(", ")}`);
          return lines.join("\n");
        })
        .join("\n\n");
      const tail =
        `\n\n더 깊은 원문은 국가법령정보센터(law.go.kr)·생활법령(easylaw.go.kr)에서 볼 수 있습니다.` +
        `\n\n<!-- 진행 지침 (사용자에게 읽어주지 말 것)\n` +
        `- 용어만 묻고 끝나는 경우는 드물다. 이 용어가 걸린 상황이 있어 보이면 search_topics("${kw}")로 이어간다.\n` +
        `- 도구 이름을 사용자 화면에 노출하지 말 것.\n-->`;
      return { content: [{ type: "text", text: withDisclaimer(`## 🔎 '${kw}' 뜻풀이 (${matched.length}건)\n\n${body}${tail}`) }] };
    },
  );

  return server;
}

export const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // 관리자 로그인 폼(/admin/login) 파싱용

app.get("/", (_req, res) => {
  res.type("text/plain").send("법률 절차 길잡이 MCP 서버 — POST /mcp (Streamable HTTP)");
});

app.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

// X-Forwarded-Host/Host는 클라이언트가 보내는 값이라 그대로 믿으면 공격자가 헤더를 조작해
// 서식·위젯 응답에 자기 도메인 링크를 심을 수 있다(오픈 리다이렉트류). PUBLIC_BASE_URL이 최우선이고,
// 없을 때만 헤더를 쓰되 허용 목록에 없는 호스트는 링크를 아예 비워 안전한 쪽으로 fallback한다.
// 알려진 배포 호스트 두 개(SUBMISSION.md의 KC 서버 + 카카오 툴즈용) 모두 허용 — 운영에서 다른 호스트를
// 추가/교체하려면 ALLOWED_HOSTS 환경변수로 override.
const ALLOWED_HOSTS = (
  process.env.ALLOWED_HOSTS ??
  "legal-navigator-full.playmcp-endpoint.kakaocloud.io,legal-navigator-kakaotools.playmcp-endpoint.kakaocloud.io"
)
  .split(",")
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

// 요청에서 공개 베이스 URL 도출(프록시 뒤에서도 정확하도록 X-Forwarded-* 우선, PUBLIC_BASE_URL로 강제 가능).
function getBaseUrl(req: express.Request): string {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, "");
  const xfproto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim();
  const xfhost = (req.headers["x-forwarded-host"] as string | undefined)?.split(",")[0]?.trim();
  const rawHost = xfhost || req.headers.host || "";
  if (!rawHost) return "";
  // host.split(":")[0]로 호스트명만 봤더니 "허용도메인:443@evil.example" 같은 값이 앞부분만
  // 검사에 걸려 통과했다(2026-08-22 코덱스 지적) — URL에서 @ 앞은 userinfo이지 호스트가 아니라,
  // 실제로 링크가 가리키는 곳은 evil.example이었다. new URL()로 제대로 파싱해서 진짜 hostname을 본다.
  let hostname: string;
  let port: string;
  try {
    const u = new URL(`http://${rawHost}`);
    hostname = u.hostname.toLowerCase();
    port = u.port;
  } catch {
    return ""; // 파싱조차 안 되는 값은 신뢰하지 않는다.
  }
  const isLocal = ["localhost", "127.0.0.1", "0.0.0.0", "::1"].includes(hostname);
  if (!isLocal && !ALLOWED_HOSTS.includes(hostname)) return ""; // 모르는 호스트 — 링크를 비워 조작된 도메인을 심지 않는다.
  const proto = isLocal ? xfproto || req.protocol || "http" : "https";
  // ★배포 도메인은 무조건 https — kakaocloud 프록시가 내부 홉에서 x-forwarded-proto: http를 보내와도
  //   신뢰하면 안 됨(도메인의 80포트는 응답조차 없어 링크가 죽고, https 채팅창에선 혼합콘텐츠 차단).
  //   로컬(localhost 등)에서만 실제 프로토콜을 따른다.
  // 반환 URL은 검증된 hostname·port로 다시 조립한다 — 원본 헤더 문자열을 그대로 잇지 않는다.
  const hostForUrl = port ? `${hostname}:${port}` : hostname;
  return `${proto}://${hostForUrl}`;
}

const htmlEscape = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ── 어시스턴트 작성 보조 — 호스트 AI가 대화 맥락으로 [빈칸] 초안을 제안하게 하는 지침 ──
// 개인정보는 서버로 오지 않고(무상태 유지) 호스트 대화 안에서만 채워진다.
// 변호사법 경계: 사용자가 말한 사실만 옮겨 적는 '작성 보조'이며 최종 확인·작성은 본인 — 사실 창작·법률 주장 금지.

// 본문에서 채울 항목을 추출(본문HTML과 동일 규칙: 줄머리 대괄호=섹션 라벨 제외, [_/공백]=이름 없는 빈칸,
// 대괄호 밖의 ○○=기관·법원명 자리)
function 빈칸항목(bodyRaw: string): { named: string[]; blanks: number; circles: number } {
  const named = new Set<string>();
  let blanks = 0;
  let circles = 0;
  for (const line of bodyRaw.split("\n")) {
    let rest = line;
    const lbl = rest.match(/^[ \t]*\[([^\]]+)\]/);
    if (lbl && !/^[_\s]*$/.test(lbl[1])) rest = rest.slice(lbl[0].length);
    for (const m of rest.matchAll(/\[([^\]]*)\]/g)) {
      if (/[☐□☑☒]/.test(m[1])) continue; // 선택지 묶음 — 채워 넣는 항목이 아니다(본문HTML과 같은 규칙)
      if (/^[_\s]*$/.test(m[1])) blanks += 1;
      else named.add(m[1].trim());
    }
    // 대괄호 안의 ○는 예시라 세지 않는다 — 본문HTML과 같은 규칙
    대괄호밖(rest, (seg) => {
      circles += (seg.match(동그라미자리) || []).length;
      return seg;
    });
  }
  return { named: [...named], blanks, circles };
}

function 작성지침(f: { 본문: string }): string {
  const { named, blanks, circles } = 빈칸항목(f.본문);
  const items =
    (named.length ? named.slice(0, 25).join(" · ") : "") +
    (blanks ? `${named.length ? " " : ""}(이름 없는 빈칸 ${blanks}곳)` : "") +
    (circles ? `${named.length || blanks ? " " : ""}(○○ = 법원·기관 이름 ${circles}곳)` : "");
  return [
    "### 🤖 어시스턴트 작성 보조 지침",
    "- 사용자가 이 대화에서 **이미 말한 사실**(이름·날짜·금액·주소 등)이 있으면 해당 [빈칸]을 채운 **초안**을 만들어 보여주세요. 모르는 칸은 [빈칸] 그대로 두고, 필요한 정보를 2~3개씩 질문하세요.",
    "- 사실을 지어내거나 법률적 주장·문구를 창작하지 마세요 — 사용자가 말한 사실만 옮겨 적습니다.",
    "- 초안은 '예시'임을 밝히고, 최종 확인·수정·인쇄는 사용자 본인이 미리보기 링크에서 직접 하도록 안내하세요.",
    ...(items ? [`- **채울 항목**: ${items}`] : []),
  ].join("\n");
}

// 위젯 카드에는 서식 본문이 없어 호스트 AI가 초안을 못 만든다 → 본문·작성요령·지침을 for_assistant로 동봉
function 작성보조지침(f: { 본문: string; 작성요령: string[] }): string {
  return [
    작성지침(f),
    "",
    "[서식 본문 — 초안 작성용 원문. 위젯 카드가 이미 표시되므로 전문을 다시 출력하지 말고, 채운 초안 또는 질문만 제시]",
    f.본문,
    "",
    "[작성요령]",
    ...f.작성요령.map((s) => `- ${s}`),
  ].join("\n");
}

// 관공서 서식의 '○○' 자리(○○지방법원·○○경찰서장·○○고용센터장 등) — 기관·법원 이름이 들어갈 곳.
// 단, 대괄호 안의 ○는 건드리지 않는다: 그 대괄호가 이미 통째로 빈칸 하나이고,
// 안의 ○는 쓰는 법을 보여주는 예시다([○○은행 등]·[○○지방법원 20○○가소○○○○ 판결정본]).
// ㅇ(한글)로 적힌 서식이 뒤에 추가될 수 있어 2자 이상 연속일 때만 함께 인정한다(홑 ㅇ은 실제 글자).
const 동그라미자리 = /[○◯〇]+|ㅇ{2,}/g;

// 대괄호 밖 구간에만 함수를 적용 — split의 캡처 그룹 덕에 홀수 인덱스가 대괄호 자신이 된다.
function 대괄호밖(s: string, fn: (seg: string) => string): string {
  return s
    .split(/(\[[^\]]*\])/)
    .map((seg, i) => (i % 2 === 1 ? seg : fn(seg)))
    .join("");
}

// 서식 본문을 '탭해서 채우는' 문서로 변환.
//  · 줄머리 대괄호(예 [신청인]·[재산내역]) → 섹션 라벨(굵게, 입력 불가)
//  · 그 외 대괄호([성명]·[______]·[   ]) → 채울 빈칸 입력 필드
//  · 대괄호 밖의 ○○(○○지방법원 등) → 채울 빈칸 입력 필드
//  · ☐ → 탭 토글 체크박스.  (사용자가 본인 사실만 입력 — AI 대필 아님)
const wideCls = (minw: number) => (minw >= 20 ? " wide" : "");

function 본문HTML(bodyRaw: string): string {
  let s = htmlEscape(bodyRaw);
  // 0) ○○ → 입력 필드. 반드시 대괄호 처리보다 먼저 — 나중에 하면 생성된 필드의
  //    data-ph 속성값 안에 든 ○까지 다시 치환해 HTML이 깨진다.
  s = 대괄호밖(s, (seg) =>
    seg.replace(동그라미자리, (m) => {
      const minw = Math.min(Math.max(m.length, 4), 28);
      return `<span class="fld${wideCls(minw)}" contenteditable="true" role="textbox" data-ph="${m}" style="min-width:${minw}ch"></span>`;
    }),
  );
  // 넓은 칸(20ch 이상)은 좁은 화면에서 제 줄을 차지하게 표시해 둔다.
  // 28ch면 16px 기준 약 286px인데, 폰 문서 폭이 296px이라 앞 글자 뒤에 붙는 순간
  // 화면 밖으로 나가 가로 스크롤이 생긴다(320px 전수 검사에서 3종 적발, 8/24).
  // 0-2) 대괄호 밖에 남은 밑줄(____)도 입력 가능하게 — 종이 서식의 빈칸 관행(8/11 회의 결정 ②).
  //    ○○와 같은 이유로 대괄호 처리보다 먼저·대괄호 밖에서만. 뒤로 미루면 3)이 만든
  //    data-ph 안의 밑줄까지 치환한다(예: 항소장 "[○○지방법원 20 가단 ____ … 선고]").
  s = 대괄호밖(s, (seg) =>
    seg.replace(/_{3,}/g, (m) => {
      const minw = Math.min(Math.max(m.length, 4), 28);
      return `<span class="fld${wideCls(minw)}" contenteditable="true" role="textbox" data-ph="" style="min-width:${minw}ch"></span>`;
    }),
  );
  // 1) 줄머리 라벨: 줄 시작(공백 허용) 직후의 대괄호 — 단, 밑줄/공백만 든 빈칸은 제외
  s = s.replace(/(^|\n)([ \t]*)\[([^\]]+)\]/g, (m, br: string, sp: string, inner: string) => {
    if (/^[_\s]*$/.test(inner)) return m; // 실제 빈칸이면 라벨로 만들지 않음
    return `${br}${sp}<span class="lbl">${inner}</span>`;
  });
  // 2) 체크박스
  s = s
    .replace(/[☐□]/g, '<span class="cbx" role="checkbox" aria-checked="false" tabindex="0">☐</span>')
    .replace(/[☑☒]/g, '<span class="cbx" role="checkbox" aria-checked="true" tabindex="0">☑</span>');
  // 3) 남은 대괄호 → 입력 필드
  //    긴 서술형(경위·사실관계·목록 등)은 줄 안에서 부풀어 앞의 항목명을 밀어내므로
  //    '.big' 블록 입력칸으로 분리 — 항목명은 그 줄에 고정되고 입력은 아래 칸에서 한다(8/11 회의 결정 ②).
  s = s.replace(/\[([^\]]*)\]/g, (_m, innerRaw: string) => {
    const inner = String(innerRaw); // 이미 htmlEscape됨 → 텍스트/속성값 모두 안전
    // 대괄호 안이 선택지 묶음이면([☐정기신청 ☐기한 후 신청]) 채워 넣는 빈칸이 아니다.
    // 이걸 필드로 만들면 체크박스 마크업이 data-ph 속성값 안으로 들어가 화면이 깨진다.
    if (inner.includes('class="cbx"')) return _m;
    const isBlank = /^[_\s]*$/.test(inner);
    const ph = isBlank ? "" : inner;
    if (!isBlank && inner.length >= 12) {
      return `<span class="fld big" contenteditable="true" role="textbox" data-ph="${ph}"></span>`;
    }
    const width = isBlank ? (inner.match(/_/g) || []).length : inner.length;
    const minw = Math.min(Math.max(width, 4), 28);
    return `<span class="fld${wideCls(minw)}" contenteditable="true" role="textbox" data-ph="${ph}" style="min-width:${minw}ch"></span>`;
  });
  // 4) 줄 단위로 감싸며 관공서 배치를 화면에도 입힌다.
  //    내려받는 파일에만 배치가 걸리고 화면은 왼쪽 정렬 평문이라, 받아보기 전엔 결과를 알 수 없었다
  //    (2026-08-23 예은님 요청 — "여기 보이는 걸 그대로 받게 해달라").
  //    배치는 내보내기와 같은 layoutParas 를 쓴다 — 화면과 파일이 어긋날 여지를 만들지 않는다.
  const laid = layoutParas(bodyRaw.split("\n").map((t) => [{ t }]));
  const cls = (st: { align?: string; size?: string; bold?: boolean; hang?: boolean }) =>
    ["ln",
     st.align === "CENTER" ? "ln-c" : st.align === "RIGHT" ? "ln-r" : "",
     st.size === "TITLE" ? "ln-t" : st.size === "SUB" ? "ln-s" : "",
     st.hang ? "ln-h" : ""].filter(Boolean).join(" ");
  // 한 줄이 여러 조각으로 갈릴 수 있다(마무리 줄 — 작성일자 / 신청인(인) / ○○법원 귀중).
  // 내보내기가 넓은 공백에서 끊는 것과 같은 자리에서 화면도 끊어야 배치가 일치한다.
  const 조각 = new Map<number, ParaStyleLike[]>();
  for (const p of laid) {
    const arr = 조각.get(p.i) ?? [];
    arr.push(p.s as ParaStyleLike);
    조각.set(p.i, arr);
  }
  return s.split("\n").map((line, i) => {
    const sts = 조각.get(i) ?? [{}];
    if (sts.length <= 1) return `<div class="${cls(sts[0])}">${line || "<br>"}</div>`;
    // 태그 밖의 넓은 공백(2칸 이상)에서만 끊는다 — 입력칸·체크박스 마크업을 가르면 화면이 깨진다.
    const parts = 태그밖넓은공백으로쪼개기(line);
    if (parts.length !== sts.length) return `<div class="${cls(sts[0])}">${line || "<br>"}</div>`;
    return parts.map((part, k) => `<div class="${cls(sts[k])}">${part || "<br>"}</div>`).join("");
  }).join("");
}

type ParaStyleLike = { align?: string; size?: string; bold?: boolean; hang?: boolean };

/** HTML 한 줄을 태그 밖의 2칸 이상 공백에서 쪼갠다(태그 안 공백·속성값은 건드리지 않는다). */
function 태그밖넓은공백으로쪼개기(line: string): string[] {
  const out: string[] = [];
  let buf = "";
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "<") depth++;
    if (ch === ">" && depth > 0) depth--;
    if (depth === 0 && ch === " " && line[i + 1] === " ") {
      let j = i;
      while (line[j] === " ") j++;
      if (buf.trim()) out.push(buf);
      buf = "";
      i = j - 1;
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) out.push(buf);
  return out.length ? out : [line];
}

// 검색엔진에 알릴 '원본' 주소. 도메인을 붙이면 여기만 바꾸면 된다.
const CANONICAL_SITE = (process.env.CANONICAL_SITE || "https://legalnavi.pages.dev").replace(/\/$/, "");

// 서식 시각화 미리보기 — 모바일(카카오톡 인앱)에서 빈칸을 직접 채우고 인쇄/PDF로 저장. 자족적 HTML(외부 의존 0).
function renderFormHtml(key: string, f: (typeof FORMS)[string], baseUrl: string): string {
  // 제목 끝의 서식 성격 꼬리표("… 공란 채움" · "… 예시 — 공란을 직접 채워 사용" · "… 상담 시 작성" 등)는
  // 제목에서 떼어내 작은 배지로 — 모바일에서 제목이 두세 줄을 먹던 문제
  const 꼬리표 = /\s*\(([^()]*(?:공란|채움|골격|예시|서식|작성|입력 항목)[^()]*)\)\s*$/.exec(f.제목);
  const title = htmlEscape(꼬리표 ? f.제목.slice(0, 꼬리표.index).trim() : f.제목);
  const kind = 꼬리표 ? htmlEscape(꼬리표[1]) : "";
  const purpose = htmlEscape(f.용도);
  const official = f.공식양식 ? htmlEscape(f.공식양식) : "";
  const tips = f.작성요령.map((t) => `<li>${htmlEscape(t)}</li>`).join("");
  const body = 본문HTML(f.본문);
  // 어디에 내는지는 위젯에만 두면 안 된다 — 위젯이 뜰 때가 있고 안 뜰 때가 있다(8/18 회의).
  // 서식 자체에 박아두면 인쇄해서 들고 가도 보인다.
  const sub = formSubmitInfo(key);
  const submitBlock = sub
    ? `<div class="submit">
    <h3>다 채우셨으면, 여기에 내세요</h3>
    <div><b>접수처</b> · ${htmlEscape(sub.관할)}</div>
    <div><b>접수 방법</b> · ${htmlEscape(sub.온라인접수)}</div>
    ${sub.url ? `<div style="margin-top:9px"><a class="btn" href="${sub.url}" target="_blank" rel="noopener">접수처 바로가기</a></div>` : ""}
  </div>`
    : "";
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · 법률 절차 길잡이</title>
<!-- 같은 서식이 두 주소(여기 + 랜딩 도메인)에 있다. 검색엔진이 둘로 갈라 세지 않도록
     원본은 우리 도메인 쪽이라고 알려준다. 카카오클라우드 주소는 공모전이 내준 것이라
     영구적이지 않다. -->
<link rel="canonical" href="${CANONICAL_SITE}/forms/${encodeURIComponent(key)}">
<style>
/* 랜딩(legal-navigator-web index.html :root)과 같은 값. 두 화면이 한 서비스로 보이려면 갈리면 안 된다.
   --fld 계열(빈칸의 노란 표시)만 기능색이라 별도 유지. */
:root{--bg:#f4f6f9;--paper:#fff;--ink:#191f28;--ink2:#4e5968;--line:#e5e8eb;--accent:#3182f6;--accent-ink:#fff;--fld:#fff7e6;--fld-line:#d9a534;--fld-ink:#8a5a00;--ph:#8b95a1;--tip-bg:#f4f6f9;--foot:#8b95a1;}
@media (prefers-color-scheme:dark){:root{--bg:#0e1116;--paper:#171b22;--ink:#e6e9f0;--ink2:#a2aabb;--line:#2a2f3a;--accent:#4c8dff;--fld:#2a2410;--fld-line:#6f5a1f;--fld-ink:#e7c877;--ph:#6b7488;--tip-bg:#141b2b;--foot:#7a8398;}}
*{box-sizing:border-box}
/* hidden 속성은 display를 지정한 요소에서 밀린다. 랜딩에서 서식 114개가 한꺼번에
   그려진 적이 있고, 다운로드 메뉴도 같은 이유로 열린 채 떴다(8/21). */
[hidden]{display:none!important}
html,body{margin:0}
body{background:var(--bg);color:var(--ink);font-family:"Apple SD Gothic Neo",Pretendard,"Malgun Gothic",system-ui,-apple-system,sans-serif;line-height:1.62;-webkit-text-size-adjust:100%;}
.bar{position:sticky;top:0;z-index:5;display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:10px 14px;background:color-mix(in srgb,var(--bg) 86%,transparent);backdrop-filter:blur(8px);border-bottom:1px solid var(--line);}
.bar .sp{flex:1}
.btn{font:inherit;font-size:14px;font-weight:700;border:1px solid var(--line);background:var(--paper);color:var(--ink);border-radius:10px;padding:9px 13px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;text-decoration:none;}
.btn.pri{background:var(--accent);color:var(--accent-ink);border-color:transparent;}
.btn:active{transform:translateY(1px)}
.wrap{max-width:760px;margin:0 auto;padding:18px 14px 60px;}
.hd{margin:6px 2px 14px}
.hd h1{font-size:clamp(19px,4.6vw,26px);margin:0 0 8px;letter-spacing:-.01em;line-height:1.25;text-wrap:balance;word-break:keep-all;}
.hd .kind{display:inline-block;font-size:11.5px;font-weight:700;color:var(--ink2);background:var(--tip-bg);border:1px solid var(--line);border-radius:999px;padding:3px 10px;margin:0 0 8px}
.hd .use{font-size:13.5px;color:var(--ink2);margin:0;word-break:keep-all}
.submit{margin:20px 0 0;padding:14px 16px;background:var(--tip-bg);border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:10px;font-size:13.5px;color:var(--ink2);line-height:1.7}
.submit h3{margin:0 0 7px;font-size:14px;color:var(--ink);letter-spacing:-.02em}
.submit b{color:var(--ink)}
.submit a{color:var(--accent);word-break:break-all}
.share{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0 0;justify-content:flex-end}
.share .btn{font-size:13px;padding:9px 14px;display:inline-flex;align-items:center;gap:6px}
.share .btn svg{width:15px;height:15px;flex:0 0 auto}
.share .share-k{background:#FEE500;color:#3C1E1E;border-color:#FEE500;font-weight:700}
.share .share-k:hover{background:#F2DA00}
/* 서식 다운로드 드롭다운 — 형식이 넷이라 버튼을 늘어놓으면 바가 길어진다.
   인쇄·PDF만 밖에 남긴다: 그건 파일이 떨어지는 게 아니라 인쇄 대화상자가 뜨는 다른 동작이고,
   서식에서 가장 많이 쓰는 버튼이라 한 번 더 누르게 하면 안 된다. */
.dd{position:relative;display:inline-flex}
/* 탭할 때 글자가 파랗게 선택되는 것 방지 — 폰에서 버튼을 누르면 그렇게 된다 */
.bar .btn,.menu button{-webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent}
.dd .chev{margin-left:6px;transition:transform .16s ease}
.dd[data-open="1"] .chev{transform:rotate(180deg)}
.dd[data-open="1"]>.btn{border-color:var(--accent);color:var(--accent)}
.menu{position:absolute;z-index:70;top:calc(100% + 7px);left:0;min-width:236px;padding:6px;background:var(--paper);border:1px solid var(--line);border-radius:14px;box-shadow:0 2px 6px rgba(0,0,0,.05),0 18px 44px -18px rgba(0,0,0,.34);display:flex;flex-direction:column;gap:2px}
.menu button{display:flex;align-items:center;gap:11px;width:100%;padding:9px 10px;border:0;border-radius:10px;background:transparent;color:var(--ink);font:inherit;font-size:14px;font-weight:600;text-align:left;cursor:pointer}
.menu button:hover{background:var(--tip-bg)}
.menu button:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.menu .ext{margin-left:auto;font-size:12px;font-weight:500;color:var(--ph);font-variant-numeric:tabular-nums}
.menu .ic{width:26px;height:26px;flex:none;border-radius:7px;display:grid;place-items:center;font-size:12px;font-weight:800;color:#fff;letter-spacing:-.02em}
.ic-h{background:#1f6feb}.ic-w{background:#2b579a}.ic-m{background:#4e5968}.ic-t{background:#8b95a1}
@media print{.share{display:none}}
.official{margin:12px 0 0;font-size:13px;background:var(--tip-bg);border:1px solid var(--line);border-radius:10px;padding:10px 12px;color:var(--ink2)}
.official b{color:var(--ink)}
/* 안내문은 한 덩어리 문장으로 흐르게 — flex로 두면 조각조각 칼럼처럼 쪼개져 읽기 어려움 */
.hint{display:block;margin:16px 2px 8px;font-size:12.5px;color:var(--ink2);line-height:1.9;word-break:keep-all}
.hint .k{background:var(--fld);border:1px dashed var(--fld-line);color:var(--fld-ink);border-radius:6px;padding:1px 7px;font-weight:700;white-space:nowrap}
.doc{background:var(--paper);border:1px solid var(--line);border-radius:14px;box-shadow:0 1px 2px rgba(0,0,0,.04),0 14px 40px -22px rgba(0,0,0,.3);padding:clamp(18px,5vw,34px);word-break:keep-all;overflow-wrap:anywhere;font-size:15px;line-height:1.95;}
/* 관공서 배치 — 내보내기(layoutParas)와 같은 판정을 화면에도 그대로 입힌다. */
.doc .ln{white-space:pre-wrap}
.doc .ln-c{text-align:center}
.doc .ln-r{text-align:right}
.doc .ln-t{text-align:center;font-size:1.5em;font-weight:800;letter-spacing:.28em;margin:.2em 0 1.1em;line-height:1.5}
.doc .ln-s{font-size:1.12em;font-weight:700;margin-top:.5em}
.doc .ln-h{padding-left:1.5em;text-indent:-1.5em}
/* vertical-align은 baseline이어야 한다. top으로 두면 칸이 줄 맨 위에 붙고 글자는 기준선에
   앉아서, 같은 줄인데도 칸마다 세로 위치가 -5px·-2px로 들쭉날쭉해진다. 좁은 화면에서는
   그게 "글자에 칸이 올라탄" 것처럼 보인다(8/24 예은님 폰 제보 → 320px에서 22곳 재현).
   좌우 여백도 1px은 너무 붙는다 — 앞 글자와 칸이 한 덩어리로 읽힌다.
   max-width는 여백을 빼고 잡아야 한다. 100%로 두면 넓은 칸이 좌우 여백만큼
   문서 밖으로 밀려 가로 스크롤이 생긴다(320px 전수 검사에서 3종 적발). */
.fld{display:inline-block;max-width:calc(100% - 6px);border:none;border-bottom:1.6px solid var(--fld-line);background:var(--fld);color:var(--fld-ink);border-radius:4px 4px 0 0;padding:0 5px;margin:0 3px;min-height:1.5em;line-height:1.5;font-weight:600;outline:none;vertical-align:baseline;font-family:inherit;}
.fld:focus{box-shadow:0 0 0 2px color-mix(in srgb,var(--fld-line) 45%,transparent);background:color-mix(in srgb,var(--fld) 70%,var(--paper));}
.fld:empty::before{content:attr(data-ph);color:var(--ph);font-weight:400}
/* 긴 서술형 칸 — 항목명(예: "- 경위:")은 윗줄에 그대로 두고, 입력은 아래 전용 칸에서.
   인라인으로 두면 글을 쓸수록 칸이 부풀어 앞 항목명이 밀려 내려간다(8/11 회의 결정 ②). */
.fld.big{display:block;width:100%;min-width:0;margin:6px 0 4px;padding:10px 12px;min-height:4.2em;
  border:1.5px dashed var(--fld-line);border-radius:10px;line-height:1.7;font-weight:500;white-space:pre-wrap;}
.fld.big:empty::before{content:attr(data-ph);color:var(--ph);font-weight:400;font-size:.94em}
.lbl{font-weight:800;background:color-mix(in srgb,var(--accent) 11%,transparent);color:var(--ink);padding:1px 8px;border-radius:6px;letter-spacing:-.01em;}
.cbx{display:inline-block;cursor:pointer;user-select:none;font-size:1.3em;line-height:1;padding:2px 5px;margin:0 3px;color:var(--accent);vertical-align:-.12em;border-radius:5px}
.cbx:hover{background:color-mix(in srgb,var(--accent) 12%,transparent)}
.cbx:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.cbx:focus{outline:2px solid var(--accent);outline-offset:2px;border-radius:3px}
.tips{margin:22px 0 0;background:var(--tip-bg);border:1px solid var(--line);border-radius:14px;padding:16px 18px}
.tips h2{font-size:14px;margin:0 0 10px;display:flex;align-items:center;gap:7px}
.tips ol{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:7px;font-size:13.5px;color:var(--ink2)}
.foot{margin:26px 4px 0;font-size:11.5px;color:var(--foot);line-height:1.6}
.foot a{color:var(--foot)}
/* 좁은 화면 — 인쇄는 한 줄 전체, 그 아래 [서식 다운로드 ▾] | [빈칸 비우기] */
@media (max-width:520px){
  .bar{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:9px 12px}
  .bar #printBtn{grid-column:1/-1}
  .bar .dd{width:100%}
  .bar .dd>.btn{width:100%}
  .menu{min-width:0;width:max(100%,220px)}
  .bar .sp{display:none}
  /* 넓은 빈칸은 폰에서 제 줄을 차지한다. 앞 글자 뒤에 붙여두면 화면 밖으로 나간다. */
  /* min-width는 렌더러가 인라인으로 박아서(밑줄 길이 → ch) 스타일시트로는 못 이긴다.
     좁은 화면에서만 !important로 덮는다 — 안 그러면 칸이 문서 밖으로 26px 밀린다. */
  .doc .fld.wide{display:block;width:100%;min-width:0!important;margin:6px 0 4px}
  .btn{padding:11px 8px;font-size:13.5px;justify-content:center}
  .wrap{padding:16px 12px 56px}
  /* 16px 미만이면 iOS가 빈칸을 탭할 때마다 화면을 확대해 버린다. 서식은 빈칸을
     스무 번씩 눌러 채우는 문서라 그때마다 확대되면 못 쓴다. 읽기에도 14.5px은 작다. */
  .doc{line-height:1.9;font-size:16px}
  .fld{padding:1px 6px;min-height:1.7em}
  .fld.big{min-height:5em}
  .tips{padding:15px 16px}
}
/* 인쇄 — A4 관공서 문서 규격. 화면용 카드·색·버튼은 전부 걷어내고 본문만 종이에 앉힌다. */
@page{size:A4;margin:20mm 20mm 22mm}
@media print{
  html,body{background:#fff;color:#000}
  .bar,.hint,.tips,.foot,.hd{display:none!important}
  .wrap{max-width:none;padding:0;margin:0}
  .doc{border:none;box-shadow:none;border-radius:0;padding:0;font-size:11.5pt;line-height:1.75;
       font-family:"Batang","바탕","Nanum Myeongjo","Apple SD Gothic Neo","Malgun Gothic",serif;
       orphans:3;widows:3;color:#000}
  .fld{background:transparent;border-bottom:1px solid #000;color:#000;border-radius:0}
  .fld:empty::before{content:""}
  .fld.big{border:1px solid #000;background:transparent;color:#000;min-height:3.2em;border-radius:0;
           break-inside:avoid;page-break-inside:avoid}
  .fld.big:empty::before{content:""}
  .lbl{background:transparent;padding:0;font-weight:700}
  .cbx{color:#000}
  .official{background:transparent}
  a{color:#000;text-decoration:none}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
</style></head><body>
<div class="bar" id="save">
  <button class="btn pri" id="printBtn" type="button">인쇄 · PDF로 저장</button>
  <div class="dd" id="dd">
    <button class="btn" id="saveBtn" type="button" aria-haspopup="true" aria-expanded="false" aria-controls="saveMenu">서식 다운로드<svg class="chev" width="11" height="11" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.6 4.4 6 7.8l3.4-3.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
    <div class="menu" id="saveMenu" role="menu" aria-labelledby="saveBtn" hidden>
      <button type="button" role="menuitem" data-fmt="hwpx"><span class="ic ic-h" aria-hidden="true">한</span>한글<span class="ext">.hwpx</span></button>
      <button type="button" role="menuitem" data-fmt="docx"><span class="ic ic-w" aria-hidden="true">W</span>워드<span class="ext">.docx</span></button>
      <button type="button" role="menuitem" data-fmt="md"><span class="ic ic-m" aria-hidden="true">M</span>마크다운<span class="ext">.md</span></button>
      <button type="button" role="menuitem" data-fmt="txt"><span class="ic ic-t" aria-hidden="true">T</span>텍스트<span class="ext">.txt</span></button>
    </div>
  </div>
  <span class="sp"></span>
  <button class="btn" id="resetBtn" type="button">빈칸 비우기</button>
</div>
<div class="wrap">
  <div class="hd">
    ${kind ? `<div class="kind">${kind}</div>` : ""}
    <h1>${title}</h1>
    <p class="use">${purpose}</p>
    ${official ? `<p class="official"><b>공식 양식 받는 곳</b> · ${official}</p>` : ""}
  </div>
  <div class="hint"><span class="k">[빈칸]</span> 과 <span class="k">○○</span>(법원·기관 이름) 을 탭해 입력하고, <b>☐</b> 는 탭하면 체크됩니다. 경위·사유처럼 길게 쓰는 항목은 <b>아래 넓은 칸</b>에 적으면 됩니다. 다 채우면 <b>인쇄·PDF로 저장</b>하거나, <b>서식 다운로드</b>에서 작성한 내용을 파일로 받아 이어서 편집할 수 있습니다. 한글(<b>.hwpx</b> — 한글 2014 이상)·워드(<b>.docx</b>)·마크다운·텍스트 중에 고르시면 됩니다.</div>
  <div class="doc" id="doc">${body}</div>
  <div class="tips">
    <h2>작성요령</h2>
    <ol>${tips}</ol>
  </div>
  ${submitBlock}
  <div class="share">
    <button class="btn share-k" id="shareBtn" type="button" hidden>
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3C6.9 3 2.8 6.3 2.8 10.3c0 2.6 1.7 4.8 4.3 6.1l-1 3.6c-.1.3.2.5.5.4l4.2-2.8c.4 0 .8.1 1.2.1 5.1 0 9.2-3.3 9.2-7.4S17.1 3 12 3z"/></svg>카카오톡 공유</button>
    <button class="btn" id="copyBtn" type="button">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>링크 복사</button>
  </div>
  <p class="foot">※ 일반 법률·절차 정보이며 개별 법률 자문이 아닙니다. 입력 내용은 이 탭을 닫기 전까지만 자동 저장되며 서버로 전송되지 않습니다(빈칸 비우기를 누르면 즉시 삭제). ${official ? "관공서 제출본은 위 ‘공식 양식 받는 곳’에서 정식 서식을 받아 작성하세요." : "제출 전 해당 기관의 최신 서식과 접수요건을 확인하세요."} · 법률 절차 길잡이(Legal Navigator)</p>
</div>
<script>
(function(){
  var doc=document.getElementById("doc");
  // 입력값 자동 저장·복원 — 현재 탭의 sessionStorage에만 저장, 탭을 닫으면 삭제되고 서버 전송 없음.
  var KEY="lnform:"+location.pathname;
  function save(){
    try{
      var d={f:[],c:[]};
      doc.querySelectorAll(".fld").forEach(function(x){d.f.push(x.textContent||"");});
      doc.querySelectorAll(".cbx").forEach(function(c){d.c.push(c.getAttribute("aria-checked")==="true");});
      sessionStorage.setItem(KEY,JSON.stringify(d));
    }catch(e){}
  }
  function restore(){
    try{
      var raw=sessionStorage.getItem(KEY); if(!raw) return;
      var d=JSON.parse(raw);
      doc.querySelectorAll(".fld").forEach(function(x,i){if(d.f&&d.f[i])x.textContent=d.f[i];});
      doc.querySelectorAll(".cbx").forEach(function(c,i){if(d.c&&d.c[i]){c.setAttribute("aria-checked","true");c.textContent="☑";}});
    }catch(e){}
  }
  doc.querySelectorAll(".cbx").forEach(function(c){
    function tog(){var on=c.getAttribute("aria-checked")==="true";c.setAttribute("aria-checked",String(!on));c.textContent=on?"☐":"☑";save();}
    c.addEventListener("click",tog);
    c.addEventListener("keydown",function(e){if(e.key===" "||e.key==="Enter"){e.preventDefault();tog();}});
  });
  // 짧은 빈칸이라도 길게 쓰면 넓은 칸으로 승격 — 좁고 긴 세로 칸이 되는 것을 막는다(8/16 은미 피드백).
  function autoGrow(el){
    if(!el||!el.classList||!el.classList.contains("fld"))return;
    var long=(el.textContent||"").length>=40;
    if(long!==el.classList.contains("big")){
      if(el.dataset.wasBig==="1"||long)el.classList.toggle("big",long);
      if(long)el.dataset.wasBig="1";
    }
  }
  doc.addEventListener("input",function(e){autoGrow(e.target);save();});
  restore();
  document.getElementById("printBtn").addEventListener("click",function(){window.print();});
  // 한글·워드로 내보내기 — 채운 값 그대로 담은 진짜 .hwpx / .docx를 브라우저에서 만들어 내려받는다.
  // 둘 다 ZIP+XML이라 같은 zipStore를 쓴다. .hwp(비공개 바이너리)는 만들 수 없어
  // 한글 쪽은 국가표준 .hwpx로 낸다 — 한글 2014 이상에서 그대로 열린다(2026-08-20 회의 지적).
  // 서버로는 아무것도 보내지 않는다(개인정보 미수집 원칙).
  // .doc(HTML) 방식은 Word 없는 환경(맥 미리보기·텍스트편집기)에서 소스가 그대로 보여 폐기했다.
  // DOCX = ZIP(무압축 저장) + 최소 3파트. 외부 라이브러리 없이 CRC32·ZIP을 직접 만든다.
  (function(){
    var crcT=(function(){var t=new Uint32Array(256);for(var n=0;n<256;n++){var c=n;for(var k=0;k<8;k++)c=(c&1)?(0xEDB88320^(c>>>1)):(c>>>1);t[n]=c>>>0;}return t;})();
    function crc32(u8){var c=0xFFFFFFFF;for(var i=0;i<u8.length;i++)c=crcT[(c^u8[i])&0xFF]^(c>>>8);return (c^0xFFFFFFFF)>>>0;}
    function zipStore(files,mime){
      var enc=new TextEncoder(),parts=[],central=[],offset=0;
      function u32(v){return [v&255,(v>>>8)&255,(v>>>16)&255,(v>>>24)&255];}
      function u16(v){return [v&255,(v>>>8)&255];}
      files.forEach(function(f){
        var name=enc.encode(f.name),data=enc.encode(f.data),crc=crc32(data);
        var lh=[80,75,3,4].concat(u16(20),u16(0),u16(0),u16(0),u16(0),u32(crc),u32(data.length),u32(data.length),u16(name.length),u16(0));
        parts.push(new Uint8Array(lh),name,data);
        central.push(new Uint8Array([80,75,1,2].concat(u16(20),u16(20),u16(0),u16(0),u16(0),u16(0),u32(crc),u32(data.length),u32(data.length),u16(name.length),u16(0),u16(0),u16(0),u16(0),u32(0),u32(offset))),name);
        offset+=lh.length+name.length+data.length;
      });
      var cdSize=central.reduce(function(a,b){return a+b.length;},0);
      var eocd=[80,75,5,6].concat(u16(0),u16(0),u16(files.length),u16(files.length),u32(cdSize),u32(offset),u16(0));
      return new Blob(parts.concat(central,[new Uint8Array(eocd)]),{type:mime});
    }
    function xe(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}
${formLayoutClientScript()}
    // 화면의 서식(빈칸·체크박스·굵은 라벨)을 문단·런 구조로 옮긴다.
    function collect(){
      var paras=[[]];
      function push(text,style){
        String(text).split("\\n").forEach(function(seg,i){
          if(i>0)paras.push([]);
          if(seg)paras[paras.length-1].push({t:seg,s:style||{}});
        });
      }
      // 본문이 줄 단위 .ln 으로 감싸여 있으면 그 안을 훑는다(화면 배치를 입히며 구조가 바뀌었다).
      // 감싸기 전 구조(평평한 텍스트+span)도 그대로 처리되도록 both 를 지원한다.
      var nodes=[];
      doc.childNodes.forEach(function(n){
        if(n.nodeType===1&&n.classList&&n.classList.contains("ln")){
          if(nodes.length)nodes.push({nodeType:3,textContent:"\\n"});
          n.childNodes.forEach(function(c){nodes.push(c);});
        } else nodes.push(n);
      });
      nodes.forEach(function(n){
        if(n.nodeType===3){push(n.textContent);return;}
        if(n.nodeType!==1)return;
        if(n.classList.contains("fld")){
          var v=n.textContent||"";
          if(n.classList.contains("big")){
            paras.push([]); push(v||" ",{u:true}); paras.push([]);
          } else push(v||"        ",{u:true});
        } else if(n.classList.contains("cbx")){
          push(n.getAttribute("aria-checked")==="true"?"☑":"☐");
        } else if(n.classList.contains("lbl")){
          push(n.textContent,{b:true});
        } else push(n.textContent);
      });
      return paras;
    }
    // w:sz 는 1/2pt 단위 — 23=11.5pt(본문), 30=15pt(제목), 26=13pt(귀중).
    // w:before / w:after 는 1/20pt — 1200=60pt(귀중 위 여백), 600=30pt.
    function docXml(paras){
      var body=layoutParas(paras).map(function(p){
        var st=p.s;
        var sz=st.size==="TITLE"?30:st.size==="SUB"?26:23;
        var rs=p.r.map(function(r){
          var pr='<w:rPr><w:rFonts w:ascii="Batang" w:eastAsia="Batang" w:hAnsi="Batang"/><w:sz w:val="'+sz+'"/>'+((r.s&&r.s.b)||st.bold?"<w:b/>":"")+(r.s&&r.s.u?'<w:u w:val="single"/>':"")+"</w:rPr>";
          return "<w:r>"+pr+'<w:t xml:space="preserve">'+xe(r.t)+"</w:t></w:r>";
        }).join("");
        var before=st.align==="RIGHT"?1200:st.align==="CENTER"&&!st.size?600:0;
        var after=st.size==="TITLE"?600:0;
        var ppr='<w:spacing w:before="'+before+'" w:after="'+after+'" w:line="300" w:lineRule="auto"/>'+
          (st.align?'<w:jc w:val="'+(st.align==="RIGHT"?"right":"center")+'"/>':"")+
          (st.hang?'<w:ind w:left="400" w:hanging="400"/>':"");
        return '<w:p><w:pPr>'+ppr+'</w:pPr>'+rs+"</w:p>";
      }).join("");
      return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'+body+
        '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>';
    }
${hwpxClientScript()}
    var FNAME=${JSON.stringify(f.제목.replace(/\s*\([^()]*\)\s*$/, "").trim())};
    function saveBlob(blob,ext){
      var a=document.createElement("a");
      a.href=URL.createObjectURL(blob);
      a.download=FNAME.replace(/[\\/:*?"<>|]/g,"").replace(/\\s+/g,"_")+ext;
      document.body.appendChild(a);a.click();
      setTimeout(function(){URL.revokeObjectURL(a.href);a.remove();},1000);
    }
    // 서식을 글자로 옮긴다. md면 굵은 라벨을 **굵게**로 살린다.
    function asLines(md){
      var NL=String.fromCharCode(10);
      return collect().map(function(runs){
        return runs.map(function(r){
          var t=r.t;
          if(md&&r.s&&r.s.b&&t.trim()) return "**"+t.trim()+"**";
          return t;
        }).join("");
      }).join(NL);
    }
    function textBlob(md){
      var NL=String.fromCharCode(10);
      var body=asLines(md);
      if(md) body="# "+FNAME+NL+NL+body;
      return new Blob([body],{type:md?"text/markdown;charset=utf-8":"text/plain;charset=utf-8"});
    }
    function makeDocx(){
      return zipStore([
        {name:"[Content_Types].xml",data:'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'},
        {name:"_rels/.rels",data:'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'},
        {name:"word/document.xml",data:docXml(collect())}
      ],"application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    }

    // ── 서식 다운로드 메뉴 ────────────────────────────
    var dd=document.getElementById("dd"),saveBtn=document.getElementById("saveBtn"),saveMenu=document.getElementById("saveMenu");
    var items=[].slice.call(saveMenu.querySelectorAll("[data-fmt]"));
    function openMenu(v){
      saveMenu.hidden=!v;
      dd.setAttribute("data-open",v?"1":"0");
      saveBtn.setAttribute("aria-expanded",v?"true":"false");
      if(v&&items[0]) items[0].focus();
    }
    saveBtn.addEventListener("click",function(e){e.stopPropagation();openMenu(saveMenu.hidden);});
    document.addEventListener("click",function(e){if(!dd.contains(e.target))openMenu(false);});
    document.addEventListener("keydown",function(e){
      if(e.key==="Escape"&&!saveMenu.hidden){openMenu(false);saveBtn.focus();}
    });
    saveMenu.addEventListener("keydown",function(e){
      var i=items.indexOf(document.activeElement);
      if(e.key==="ArrowDown"){e.preventDefault();items[(i+1)%items.length].focus();}
      else if(e.key==="ArrowUp"){e.preventDefault();items[(i-1+items.length)%items.length].focus();}
    });
    // 위젯의 "서식 다운로드"는 이 페이지의 #save로 들어온다. 받는 쪽이 없으면
    // '빈칸 바로 채우기'와 글자 하나 다르지 않은 화면이 뜬다 — 눌러놓고 뭐가 달라졌는지
    // 알 수가 없다(8/22 은미님 지적). 들어오자마자 다운로드 메뉴를 펴준다.
    function openFromHash(){ if(location.hash==="#save") openMenu(true); }
    openFromHash();
    window.addEventListener("hashchange",openFromHash);

    items.forEach(function(btn){
      btn.addEventListener("click",function(){
        var f=btn.getAttribute("data-fmt");
        if(f==="hwpx") saveBlob(zipStore(hwpxFiles(FNAME,collect()),"application/vnd.hancom.hwpx"),".hwpx");
        else if(f==="docx") saveBlob(makeDocx(),".docx");
        else if(f==="md") saveBlob(textBlob(true),".md");
        else saveBlob(textBlob(false),".txt");
        openMenu(false);
      });
    });
  })();
  document.getElementById("resetBtn").addEventListener("click",function(){
    doc.querySelectorAll(".fld").forEach(function(x){x.textContent="";});
    doc.querySelectorAll(".cbx").forEach(function(c){c.setAttribute("aria-checked","false");c.textContent="☐";});
    try{sessionStorage.removeItem(KEY);}catch(e){}
  });

  // ── 공유 (8/18 회의 결정 ③) ─────────────────────────
  // 카카오톡 공유 SDK는 외부 스크립트와 앱 키가 필요해 이 페이지의 '외부 의존 0'을 깬다.
  // Web Share API를 쓰면 폰의 기본 공유 시트가 뜨고 거기에 카카오톡이 그대로 들어 있다.
  var pageUrl=location.href.split("#")[0];
  var pageTitle=(document.querySelector("h1")||{}).textContent||"법률 절차 길잡이";
  var shareText=pageTitle+" — 빈칸만 채우면 되는 서식입니다.";

  var shareBtn=document.getElementById("shareBtn");
  if(shareBtn&&navigator.share){
    shareBtn.hidden=false;
    shareBtn.addEventListener("click",function(){
      navigator.share({title:pageTitle,text:shareText,url:pageUrl}).catch(function(){});
    });
  }

  var copyBtn=document.getElementById("copyBtn");
  if(copyBtn) copyBtn.addEventListener("click",function(){
    function done(){
      var old=copyBtn.textContent;
      copyBtn.textContent="복사됨";
      setTimeout(function(){copyBtn.textContent=old;},1500);
    }
    if(navigator.clipboard&&navigator.clipboard.writeText){
      navigator.clipboard.writeText(pageUrl).then(done).catch(fallback);
    }else fallback();
    function fallback(){
      var ta=document.createElement("textarea");
      ta.value=pageUrl;ta.setAttribute("readonly","");
      ta.style.cssText="position:fixed;top:-1000px";
      document.body.appendChild(ta);ta.select();
      try{document.execCommand("copy");done();}catch(e){}
      document.body.removeChild(ta);
    }
  });
})();
</script>
</body></html>`;
}

// ── 관리자 인증 ────────────────────────────────────────────────────────────────
// 아이디 없이 비밀번호 하나. 계정 저장소도 세션 저장소도 만들지 않는다 —
// 맞으면 "비밀번호의 해시"를 쿠키에 넣고, 요청마다 그 값과 대조할 뿐이다(무상태 유지).
//
// 비밀번호는 ADMIN_PASS 환경변수에서만 온다. 기본값을 두지 않는다 — 이 저장소는 공개라
// 소스에 적힌 기본 비밀번호는 곧 비밀번호가 없는 것과 같다. 환경변수가 없으면 관리자 화면을
// 아예 열지 않는다(503). 비밀번호를 모르는 사람이 못 들어오는 게 아니라, 문 자체가 없는 상태.
const ADMIN_COOKIE = "admin";
function timingSafeStrEqual(a: string, b: string): boolean {
  // 길이·내용이 다를 때 응답 시간 차이로 비밀번호를 한 글자씩 알아내지 못하도록 상수시간 비교.
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  return aBuf.length === bBuf.length && timingSafeEqual(aBuf, bBuf);
}
// 배포 환경(PlayMCP in KC)이 ①만든 뒤에는 환경변수를 못 받고 ②컨테이너 로그를 볼 수 없다
// (모니터링 탭은 요청 수 그래프뿐 — 2026-08-24 확인). 그래서 비밀번호를 밖에서 넣을 수도,
// 안에서 알려줄 수도 없다.
//
// 해결: 비밀번호가 아니라 **비밀번호의 지문(scrypt 해시)** 을 저장소에 둔다. 지문으로는
// 원래 값을 되돌릴 수 없고, scrypt 는 일부러 느려서 무차별 대입도 현실적이지 않다.
// 실제 서비스가 비밀번호를 보관하는 방식과 같다 — 공개 저장소에 있어도 안전하다.
// 비밀번호 자체는 은미님 비밀번호 관리자에만 있다.
//
// ADMIN_PASS 환경변수를 줄 수 있는 환경에서는 그 값이 우선한다(지문 대조를 건너뛴다).
const ADMIN_HASH_SALT = "3e0d6e14320b56787fbb9d91a19cf723";
const ADMIN_HASH = "82724dd11af7faaf315c0e1dfab3fe5019a81123c6044b1412d36812556c4634";

// 로그인 성공 표식. 비밀번호에서 파생하지 않는다 — 지문 방식에선 서버도 원래 비밀번호를 모르기 때문.
// 실행마다 달라져 재배포하면 기존 로그인이 풀린다.
const ADMIN_COOKIE_TOKEN = createHash("sha256").update(ADMIN_HASH + ":" + Date.now() + ":" + Math.random()).digest("hex");

/** 입력한 비밀번호가 저장된 지문과 맞는지. scrypt 파라미터는 지문을 만들 때와 같아야 한다. */
function 지문이맞나(given: string): boolean {
  try {
    const dk = scryptSync(given, Buffer.from(ADMIN_HASH_SALT, "hex"), 32, { N: 16384, r: 8, p: 1 });
    return timingSafeEqual(dk, Buffer.from(ADMIN_HASH, "hex"));
  } catch {
    return false;
  }
}

/** 관리자 화면이 열려 있는가. 지문이 박혀 있으므로 항상 열려 있다(비밀번호를 아는 사람만 통과). */
function adminEnabled(): boolean {
  return Boolean(process.env.ADMIN_PASS?.trim()) || ADMIN_HASH.length > 0;
}

/** 비밀번호 검사. 환경변수가 있으면 그 값과, 없으면 저장된 지문과 대조한다. */
function 비밀번호맞나(given: string): boolean {
  const envPass = process.env.ADMIN_PASS?.trim();
  if (envPass) return timingSafeStrEqual(given, envPass);
  return 지문이맞나(given);
}

/** 쿠키에 넣을 값 — 비밀번호를 그대로 두지 않는다. */
function adminCookieFor(given: string): string {
  return createHash("sha256").update(ADMIN_HASH_SALT + given).digest("hex");
}

function getCookie(req: express.Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}
function isAdminAuthed(req: express.Request): boolean {
  if (!adminEnabled()) return false;
  const token = getCookie(req, ADMIN_COOKIE);
  if (!token) return false;
  // 환경변수를 쓰면 그 값에서 파생한 쿠키와, 아니면 이번 실행의 로그인 표식과 대조한다.
  const envPass = process.env.ADMIN_PASS?.trim();
  return timingSafeStrEqual(token, envPass ? adminCookieFor(envPass) : ADMIN_COOKIE_TOKEN);
}
function isLocalHost(req: express.Request): boolean {
  const host = (req.headers.host || "").split(":")[0].toLowerCase();
  return ["localhost", "127.0.0.1", "0.0.0.0", "::1"].includes(host);
}

// 관리자 화면 공통 스타일 — 서식 화면(renderFormHtml)과 같은 색 토큰을 쓴다.
const ADMIN_CSS = `
:root{--bg:#f4f6f9;--paper:#fff;--ink:#191f28;--ink2:#4e5968;--line:#e5e8eb;--accent:#3182f6;}
@media (prefers-color-scheme:dark){:root{--bg:#0e1116;--paper:#171b22;--ink:#e6e9f0;--ink2:#a2aabb;--line:#2a2f3a;--accent:#4c8dff;}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:"Apple SD Gothic Neo",Pretendard,"Malgun Gothic",system-ui,-apple-system,sans-serif;line-height:1.6;}
.wrap{max-width:1000px;margin:0 auto;padding:24px 16px 60px;}
h1{font-size:22px;margin:0 0 6px}
.sub{color:var(--ink2);font-size:13.5px;margin:0 0 20px}
a{color:var(--accent)}`;

function renderAdminLoginHtml(error?: string): string {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>관리자 로그인 · 법률 절차 길잡이</title>
<style>${ADMIN_CSS}
body{min-height:100vh;display:flex;align-items:center;justify-content:center}
form{background:var(--paper);border:1px solid var(--line);border-radius:14px;padding:28px 26px;width:min(320px,90vw);text-align:center;}
h1{font-size:16px;margin:0 0 16px}
input{width:100%;font:inherit;font-size:15px;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);margin:0 0 10px}
button{width:100%;font:inherit;font-size:14px;font-weight:700;padding:10px;border:none;border-radius:8px;background:var(--accent);color:#fff;cursor:pointer}
.err{color:#e0392b;font-size:12.5px;margin:0 0 10px}
</style>
</head><body>
<form method="post" action="/admin/login">
<h1>비밀번호를 입력하세요</h1>
${error ? `<p class="err">${htmlEscape(error)}</p>` : ""}
<input type="password" name="pw" autofocus required>
<button type="submit">입장</button>
</form>
</body></html>`;
}

// ADMIN_PASS가 없을 때 관리자 화면 대신 내보내는 안내. 503(서비스 이용 불가) —
// 잘못 들어온 요청이 아니라 서버 쪽 설정이 빠져서 못 여는 것이므로 401/404가 아니라 503이 맞다.
function renderAdminDisabledHtml(): string {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>관리자 화면이 꺼져 있습니다 · 법률 절차 길잡이</title>
<style>${ADMIN_CSS}
.note{background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:18px 20px;font-size:14px;color:var(--ink2)}
.note p{margin:0 0 10px}.note p:last-child{margin-bottom:0}
code{background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:1px 6px;font-size:13px}
</style>
</head><body><div class="wrap">
<h1>관리자 화면이 꺼져 있습니다</h1>
<div class="note">
<p>관리자 비밀번호가 설정되지 않아 이 화면을 열지 않습니다.</p>
<p>열려면 서버 환경변수에 <code>ADMIN_PASS</code>를 주고 서버를 다시 시작하세요.</p>
<p>비밀번호 기본값은 일부러 두지 않았습니다 — 소스 코드에 적힌 비밀번호는 저장소를 볼 수 있는 사람 모두가 아는 값이라 비밀번호가 아닙니다.</p>
</div>
</div></body></html>`;
}

/** 관리자 화면 공통 관문. 열 수 없으면 응답을 보내고 true를 돌려준다(라우트는 거기서 끝낸다). */
function blockAdmin(req: express.Request, res: express.Response): boolean {
  if (!adminEnabled()) {
    res.status(503).type("text/html; charset=utf-8").send(renderAdminDisabledHtml());
    return true;
  }
  if (!isAdminAuthed(req)) {
    res.status(401).type("text/html; charset=utf-8").send(renderAdminLoginHtml());
    return true;
  }
  return false;
}

// 로그인 처리 — /forms와 /admin/logs가 같은 비밀번호를 쓴다(관리자 화면은 하나의 문으로 들어간다).
app.post("/admin/login", (req, res) => {
  if (!adminEnabled()) {
    res.status(503).type("text/html; charset=utf-8").send(renderAdminDisabledHtml());
    return;
  }
  const given = typeof req.body?.pw === "string" ? req.body.pw : "";
  if (!비밀번호맞나(given)) {
    res.status(401).type("text/html; charset=utf-8").send(renderAdminLoginHtml("비밀번호가 올바르지 않습니다."));
    return;
  }
  const envPass = process.env.ADMIN_PASS?.trim();
  res.cookie(ADMIN_COOKIE, envPass ? adminCookieFor(envPass) : ADMIN_COOKIE_TOKEN, {
    httpOnly: true,
    sameSite: "lax",
    secure: !isLocalHost(req), // 로컬 개발(http)에서는 secure를 끄지 않으면 쿠키가 저장되지 않는다
    maxAge: 1000 * 60 * 60 * 12,
  });
  const to = typeof req.body?.next === "string" && req.body.next.startsWith("/") ? req.body.next : "/forms";
  res.redirect(303, to);
});

// 서식 전체 목록 — 관리자가 링크만 눌러 들어가는 인덱스. 읽기전용·무상태.
function renderFormsIndexHtml(baseUrl: string): string {
  const byCategory = new Map<string, { key: string; title: string }[]>();
  for (const key of FORM_KEYS) {
    const topic = FORM_TOPIC[key];
    const cat = (topic ? PROCEDURES[topic]?.category : undefined) || "기타";
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push({ key, title: FORMS[key].제목 });
  }
  const sections = [...CATEGORIES, "기타"]
    .filter((cat) => byCategory.has(cat))
    .map((cat) => {
      const items = byCategory.get(cat)!;
      const lis = items
        .map(({ key, title }) => `<li><a href="${baseUrl}/forms/${encodeURIComponent(key)}">${htmlEscape(title)}</a></li>`)
        .join("");
      return `<section><h2>${htmlEscape(cat)} <span class="cnt">${items.length}</span></h2><ul>${lis}</ul></section>`;
    })
    .join("");
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>서식 전체 목록 · 법률 절차 길잡이</title>
<style>${ADMIN_CSS}
.wrap{max-width:820px}
section{background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:14px 18px;margin:0 0 14px}
h2{font-size:15px;margin:0 0 8px;display:flex;align-items:center;gap:8px}
.cnt{font-size:12px;font-weight:400;color:var(--ink2);background:var(--bg);border-radius:999px;padding:1px 8px}
ul{margin:0;padding:0;list-style:none;display:grid;gap:2px}
li a{display:block;padding:7px 4px;color:var(--ink);text-decoration:none;font-size:14px;border-radius:6px}
li a:hover{background:var(--bg);color:var(--accent)}
</style>
</head><body><div class="wrap">
<h1>서식 전체 목록</h1>
<p class="sub">총 ${FORM_KEYS.length}개 · 클릭하면 빈칸 채우기 미리보기로 이동</p>
<p class="sub"><a href="/admin/logs">도구 호출 디버그 로그 보기 →</a></p>
${sections}
</div></body></html>`;
}

app.get("/forms", (req, res) => {
  if (blockAdmin(req, res)) return;
  res.type("text/html; charset=utf-8").send(renderFormsIndexHtml(getBaseUrl(req)));
});

// ── 도구 호출 디버그 로그 화면 ─────────────────────────────────────────────────
// 정상 호출 줄에는 인자의 "키 이름"만 뜬다. 사용자가 쓴 문장은 매칭 실패 줄에만,
// 그것도 마스킹·200자 제한을 거친 뒤에 뜬다(이유는 debugLog.ts 머리말 참고).
/** 로그 화면 상단의 스위치 안내. 화면에서 켠 경우에만 '끄기' 버튼을 보여준다.
 *  (템플릿 리터럴 안에 중첩 백틱을 두지 않으려고 함수로 뺐다.) */
function 수집스위치안내(): string {
  if (collectingBy() === "screen") {
    return (
      '<form method="post" action="/admin/logs/toggle">' +
      '<button class="btn" type="submit" name="on" value="0">수집 끄기</button>' +
      '<span class="sub"> 화면에서 켠 상태입니다 — 서버가 다시 뜨면 저절로 꺼집니다.</span></form>'
    );
  }
  return '<p class="sub">환경변수 <code>DEBUG_LOG=on</code> 으로 켜져 있습니다. 끄려면 그 값을 지우고 다시 시작하세요.</p>';
}

function renderAdminLogsHtml(): string {
  const logs = recentLogs(200);
  const errors = logs.filter((l) => !l.ok);
  const noMatches = logs.filter((l) => l.flag === "no_match");
  const row = (l: (typeof logs)[number]) => {
    const badge = !l.ok
      ? `<span class="bad">에러</span>`
      : l.flag === "no_match"
        ? `<span class="warn">매칭실패</span>`
        : `<span class="ok">성공</span>`;
    const free = l.error ?? (l.args ? JSON.stringify(l.args) : "");
    return `<tr><td>${htmlEscape(l.ts)}</td><td>${htmlEscape(l.tool)}</td><td>${badge}</td><td>${l.ms}ms</td><td>${htmlEscape(l.argKeys.join(", "))}</td><td class="detail">${htmlEscape(free)}</td></tr>`;
  };
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>디버그 로그 · 법률 절차 길잡이</title>
<style>${ADMIN_CSS}
.stats{display:flex;gap:10px;margin:0 0 20px;flex-wrap:wrap}
.stat{background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:10px 16px;font-size:13px}
.stat b{display:block;font-size:20px}
.tablewrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;background:var(--paper);border:1px solid var(--line);border-radius:12px;overflow:hidden;font-size:12.5px}
th,td{padding:7px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top;white-space:nowrap}
td.detail{max-width:420px;white-space:normal;word-break:break-all;color:var(--ink2)}
.ok{color:#0a9;font-weight:600}.warn{color:#e0952b;font-weight:600}.bad{color:#e0392b;font-weight:600}
.note{background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:14px 18px;font-size:13px;color:var(--ink2)}
</style>
</head><body><div class="wrap">
<h1>디버그 로그</h1>
<p class="sub">최근 ${logs.length}건 · 메모리에만 보관하므로 재배포하면 사라집니다 · <a href="/admin/logs?format=json">JSON으로 보기</a> · <a href="/forms">서식 목록으로</a></p>
${수집스위치안내()}
<div class="stats">
<div class="stat"><b>${logs.length}</b>전체 호출</div>
<div class="stat"><b>${errors.length}</b>에러</div>
<div class="stat"><b>${noMatches.length}</b>주제 매칭 실패</div>
</div>
<div class="tablewrap">
<table><thead><tr><th>시각</th><th>도구</th><th>결과</th><th>소요</th><th>인자 키</th><th>매칭실패 내용 / 에러</th></tr></thead>
<tbody>${logs.map(row).join("") || `<tr><td colspan="6">아직 기록된 호출이 없습니다.</td></tr>`}</tbody></table>
</div>
<p class="sub" style="margin-top:16px">사용자가 쓴 문장은 ‘매칭실패’ 줄에만 남고, 그것도 주민번호·전화번호·이메일을 가리고 200자로 잘라 저장합니다. 정상 호출은 인자의 키 이름만 남습니다.</p>
</div></body></html>`;
}

function renderLogsOffHtml(): string {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>디버그 로그 · 법률 절차 길잡이</title>
<style>${ADMIN_CSS}
.note{background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:18px 20px;font-size:14px;color:var(--ink2)}
code{background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:1px 6px;font-size:13px}
</style>
</head><body><div class="wrap">
<h1>디버그 로그가 꺼져 있습니다</h1>
<p class="sub"><a href="/forms">서식 목록으로</a></p>
<div class="note">
<p>지금은 도구 호출을 <b>수집하지도, 보여주지도 않습니다.</b> 심사·투표 기간처럼 기록을 남기지 않아야 할 때의 기본 상태입니다.</p>
<form method="post" action="/admin/logs/toggle"><button class="btn" type="submit" name="on" value="1">지금 켜기</button></form>
<p>켜면 이 서버가 다시 시작될 때까지만 수집합니다 — 켠 채로 잊더라도 재배포하면 저절로 꺼집니다.
환경변수를 쓸 수 있는 환경이라면 <code>DEBUG_LOG=on</code> 을 줘도 됩니다.</p>
<p>기록은 메모리에만 쌓이므로 서버를 다시 시작하면 그때까지의 기록도 함께 사라집니다.</p>
</div>
</div></body></html>`;
}

// 관리자 화면에서 수집을 켜고 끈다. 환경변수를 못 쓰는 배포 환경 때문에 둔 스위치라,
// 켠 상태는 메모리에만 있고 서버가 다시 뜨면 꺼진 상태로 돌아간다.
app.post("/admin/logs/toggle", (req, res) => {
  if (blockAdmin(req, res)) return;
  setCollecting(req.body?.on === "1");
  res.redirect(303, "/admin/logs");
});

app.get("/admin/logs", (req, res) => {
  if (blockAdmin(req, res)) return;
  // 꺼져 있으면 조회도 하지 않는다 — 화면에는 "꺼져 있음"만 안내한다.
  if (!debugLogEnabled()) {
    if (req.query.format === "json") {
      res.json({ enabled: false, entries: [] });
      return;
    }
    res.type("text/html; charset=utf-8").send(renderLogsOffHtml());
    return;
  }
  if (req.query.format === "json") {
    res.json({ enabled: true, entries: recentLogs(500) });
    return;
  }
  res.type("text/html; charset=utf-8").send(renderAdminLogsHtml());
});

// 서식 라우트 — 확장자 없음/.html은 시각화 미리보기(빈칸 채움),
// .txt/.hwpx/.docx는 파일이 바로 떨어진다(빈 서식). 읽기전용·무상태·인메모리.
app.get("/forms/:key", (req, res) => {
  const raw = req.params.key; // Express 5가 params를 이미 디코드(이중 디코딩 금지)
  const m = /\.(txt|hwpx|docx|html?)$/i.exec(raw);
  const ext = m ? m[1].toLowerCase() : "";
  const key = m ? raw.slice(0, m.index) : raw;
  const f = FORMS[key];
  if (!f) {
    if (ext === "txt") {
      res.status(404).type("text/plain; charset=utf-8").send("서식을 찾을 수 없습니다. get_form_template의 서식 키를 확인하세요.");
    } else {
      res
        .status(404)
        .type("text/html; charset=utf-8")
        .send('<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:40px;text-align:center"><h2>서식을 찾을 수 없습니다</h2><p>get_form_template의 서식 키를 확인하세요.</p></body>');
    }
    return;
  }
  // .hwpx / .docx → 빈 서식 파일을 그 자리에서 만들어 내려준다.
  // 위젯에서 누르면 페이지를 거치지 않고 파일이 바로 받아진다(8/23).
  if (ext === "hwpx" || ext === "docx") {
    const paras = bodyToParas(f.제목, f.본문);
    const buf = ext === "hwpx" ? hwpxBuffer(f.제목, paras) : docxBuffer(paras);
    const name = `${safeName(f.제목)}.${ext}`;
    res
      .type(MIME[ext])
      // filename*=UTF-8'' 이 없으면 한글 파일명이 깨져서 저장된다.
      .set("Content-Disposition", `attachment; filename="form.${ext}"; filename*=UTF-8''${encodeURIComponent(name)}`)
      .set("Cache-Control", "public, max-age=3600")
      .send(buf);
    return;
  }
  if (ext !== "txt") {
    // 확장자 없음 / .html → 시각화 미리보기
    res.type("text/html; charset=utf-8").send(renderFormHtml(key, f, getBaseUrl(req)));
    return;
  }
  const lines = [f.제목, `용도: ${f.용도}`];
  if (f.공식양식) lines.push(`공식 양식 받는 곳: ${f.공식양식}`);
  lines.push(
    "",
    "─── 서식 시작 ───",
    f.본문,
    "─── 서식 끝 ───",
    "",
    "[작성요령]",
    ...f.작성요령.map((s) => `- ${s}`),
    "",
    "────────────────────",
    f.공식양식
      ? "※ 일반 법률·절차 정보이며 개별 법률 자문이 아닙니다. 관공서 제출본은 위 '공식 양식 받는 곳'에서 정식 서식을 받아 작성하세요."
      : "※ 일반 법률·절차 정보이며 개별 법률 자문이 아닙니다. 제출 전 해당 기관의 최신 서식과 접수요건을 확인하세요.",
  );
  const filename = `${f.제목.replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, "_")}.txt`;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="legal-form.txt"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.send("\uFEFF" + lines.join("\n")); // BOM: Windows 메모장 UTF-8 호환
});

// 위젯 프로토타입 미리보기 — 카카오 툴즈 위젯(ChatKit 스펙)의 로컬 근사 렌더. 읽기전용·무상태.
// /widgets/form?key=서식키 · /widgets/triage?q=상황 · /widgets/calc — ?json=1이면 위젯 JSON 원본.
app.get("/widgets/:kind", (req, res) => {
  const kind = req.params.kind;
  const baseUrl = getBaseUrl(req);
  let built: ReturnType<typeof buildFormWidget> | null = null;
  let heading = "";
  if (kind === "form") {
    const key = (req.query.key as string) || "금전소비대차계약서";
    const f = FORMS[key];
    if (!f) {
      res.status(404).type("text/plain; charset=utf-8").send("서식 키를 확인하세요 (?key=서식키)");
      return;
    }
    const sub = formSubmitInfo(key);
    built = buildFormWidget(key, f, baseUrl, sub ?? undefined);
    heading = "차용증 양식 좀 만들어줘";
  } else if (kind === "triage") {
    const q = safeInput((req.query.q as string) || "월급을 3개월째 못 받았어요");
    const top = rankTopics(q)[0];
    if (!top) {
      res.status(404).type("text/plain; charset=utf-8").send("진단할 수 없는 상황입니다 (?q=상황설명)");
      return;
    }
    const p = PROCEDURES[top];
    built = buildTriageWidget(q, { key: top, category: p.category, 제목: p.제목, 기한: p.기한, 단계: p.단계, 온라인접수: p.온라인접수, 근거법: p.근거법 });
    heading = q;
  } else if (kind === "calc") {
    built = buildCalcWidget("퇴직금", calcSeverance(100_000, 1095)); // 일평균 10만원(월 300), 3년 재직
    heading = "월급 300에 3년 일했는데 퇴직금 얼마예요?";
  } else {
    res.status(404).type("text/plain; charset=utf-8").send("지원: /widgets/form · /widgets/triage · /widgets/calc");
    return;
  }
  if (req.query.json) {
    res.json(built);
    return;
  }
  res.type("text/html; charset=utf-8").send(renderWidgetHtml(built, heading));
});

app.post("/mcp", async (req, res) => {
  const server = createServer(getBaseUrl(req));
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP 요청 처리 오류:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

app.get("/mcp", (_req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method Not Allowed (stateless: use POST)" },
    id: null,
  });
});

const PORT = Number(process.env.PORT ?? 4100);
// 테스트(NODE_ENV=test)에서는 자동 listen을 막아, 테스트가 임의 포트로 app을 직접 띄울 수 있게 한다.
if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, () => {
    console.error(`법률 절차 길잡이 MCP listening on http://localhost:${PORT}/mcp`);
  });
}
