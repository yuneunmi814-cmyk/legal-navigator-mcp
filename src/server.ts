import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { withDisclaimer } from "./disclaimer.js";
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
} from "./data/index.js";
import {
  calcUnpaidWages,
  calcSeverance,
  calcWeeklyHolidayPay,
  calcDelayInterest,
} from "./calc.js";

// 서비스명 — PlayMCP 개발가이드: description에 영문/국문 병기 서비스명 포함 필수
const SVC = "법률 절차 길잡이(Legal Navigator)";

const SERVER_INSTRUCTIONS =
  "이 서버는 한국 생활법률 36개 분야 168개 주제(노동·임대차·상가·돈거래/사기·소비자·교통사고·민사/형사 절차·가정폭력·성범죄·스토킹·가사/상속·채무조정·금융사기·산재·행정·의료·조세·계약·부동산·출입국·보험·지식재산·학대·고용보험·통신/개인정보·군·선거·환경·반려동물 등)에 대한 " +
  "법률 정보·대응 절차·표준 서식·금액 계산·법령/판례 안내를 제공하는 정보 도구입니다. " +
  "권장 흐름: ① 사용자가 상황을 일상어로 설명하면 search_topics(자연어)로 주제 키를 찾고, 주제명을 알면 list_topics로 확인 → ② 그 키로 get_procedure·get_checklist·get_form_template·get_precedent 호출 → ③ 판례·법령 인용을 확인할 땐 verify_citation, 최근 법 개정·시행일은 law_updates로 검증. " +
  "중요(declaw): 이 도구는 개별 법률 자문이 아닙니다. 특정 사건의 법적 결론(승소·유무죄 등)을 단정하지 말고 정보 제공에 그치며, " +
  "표준서식은 사용자가 제공한 사실로 공란을 채우는 수준까지만 돕고 법적 주장·전략 작성은 하지 마세요. 없는 판례·법령은 지어내지 말고, 중대·복잡·기한임박 사안은 변호사·공인노무사·대한법률구조공단(132) 상담을 권하세요.";

const READONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const 항목값 = ["체불임금", "퇴직금", "주휴수당", "지연이자"] as const;
const TOPIC_DESC = "주제 키. 카테고리: 노동·주택임대차·돈거래·소비자·교통사고·형사·민사절차. 모르면 list_topics로 목록을 먼저 확인.";

function 절차텍스트(key: string): string {
  const p = PROCEDURES[key];
  return [
    `📋 [${p.category}] ${p.제목}`,
    "",
    `• 적용대상: ${p.적용대상}`,
    `• 기한: ${p.기한}`,
    `• 관할기관: ${p.관할기관}`,
    `• 접수: ${p.온라인접수}`,
    "",
    "진행 단계",
    ...p.단계.map((s) => `  ${s}`),
    "",
    "근거 법령",
    ...p.근거법.map((s) => `  - ${s}`),
    "",
    `참고: ${p.비고}`,
  ].join("\n");
}

// 자연어 질의 → 관련 주제 키 랭킹(동의어군 + 메타데이터 가중). search_topics·triage 공용.
function rankTopics(query: string): string[] {
  const Q = query.replace(/\s+/g, " ").trim();
  const nQ = Q.replace(/\s/g, "");
  const words = [...new Set(Q.split(/\s+/).filter((w) => w.length >= 2))];
  const score = new Map<string, number>();
  const add = (k: string, n: number) => {
    if (PROCEDURES[k]) score.set(k, (score.get(k) ?? 0) + n);
  };
  for (const syn of SEARCH_SYNONYMS) {
    if (syn.q.some((ph) => nQ.includes(ph.replace(/\s/g, "")) || Q.includes(ph))) {
      for (const t of syn.topics) add(t, 5);
    }
  }
  for (const k of TOPIC_KEYS) {
    const p = PROCEDURES[k];
    if (nQ.includes(k) || k.includes(nQ)) add(k, 6);
    const hay = `${p.적용대상} ${p.근거법.join(" ")}`;
    for (const w of words) {
      if (p.제목.includes(w)) add(k, 4);
      else if (p.category.includes(w)) add(k, 3);
      else if (hay.includes(w)) add(k, 2);
    }
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
}

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "legal-navigator", version: "0.3.0", title: "법률 절차 길잡이" },
    { instructions: SERVER_INSTRUCTIONS },
  );

  server.registerTool(
    "list_topics",
    {
      title: "주제 목록",
      description: `Lists available legal topics (key·category·title), optionally filtered by category. Call this first to find the right topic key. Service: ${SVC}.`,
      inputSchema: {
        category: z.enum(CATEGORIES as [string, ...string[]]).optional().describe("노동 | 주택임대차 | 돈거래 | 소비자 | 교통사고 | 형사 | 민사절차 (비우면 전체)"),
      },
      annotations: { title: "주제 목록", ...READONLY },
    },
    async ({ category }) => {
      const list = category ? TOPICS.filter((t) => t.category === category) : TOPICS;
      const byCat = new Map<string, string[]>();
      for (const t of list) {
        if (!byCat.has(t.category)) byCat.set(t.category, []);
        byCat.get(t.category)!.push(`  - ${t.key} : ${t.제목}`);
      }
      const body = [...byCat.entries()].map(([c, items]) => `[${c}]\n${items.join("\n")}`).join("\n\n");
      return { content: [{ type: "text", text: withDisclaimer(`🗂️ 주제 목록 (${list.length}개)\n\n${body}`) }] };
    },
  );

  server.registerTool(
    "get_procedure",
    {
      title: "절차 안내",
      description: `Returns the official response procedure, competent authority, deadline, online filing channel, and legal basis for a Korean everyday-law topic (labor, housing lease, debt/fraud, consumer, traffic accident, criminal, civil procedure). Information only. Service: ${SVC}.`,
      inputSchema: { topic: z.enum(TOPIC_KEYS).describe(TOPIC_DESC) },
      annotations: { title: "절차 안내", ...READONLY },
    },
    async ({ topic }) => ({
      content: [{ type: "text", text: withDisclaimer(절차텍스트(topic)) }],
    }),
  );

  server.registerTool(
    "get_checklist",
    {
      title: "필요 서류·증거 체크리스트",
      description: `Returns a checklist of evidence to gather and documents to prepare when filing, by Korean everyday-law topic. Information only. Service: ${SVC}.`,
      inputSchema: { topic: z.enum(TOPIC_KEYS).describe(TOPIC_DESC) },
      annotations: { title: "필요 서류·증거 체크리스트", ...READONLY },
    },
    async ({ topic }) => {
      const c = CHECKLISTS[topic];
      if (!c) {
        return { content: [{ type: "text", text: withDisclaimer(`'${topic}' 주제의 체크리스트가 없습니다. list_topics로 확인하세요.`) }] };
      }
      const text = [
        `🗂️ ${PROCEDURES[topic]?.제목 ?? topic} — 준비 체크리스트`,
        "",
        "모아둘 증거",
        ...c.증거.map((s) => `  ☐ ${s}`),
        "",
        "접수용 준비서류",
        ...c.준비서류.map((s) => `  ☐ ${s}`),
      ].join("\n");
      return { content: [{ type: "text", text: withDisclaimer(text) }] };
    },
  );

  server.registerTool(
    "get_form_template",
    {
      title: "표준 서식 제공",
      description: `Provides a blank standard document template (complaint/내용증명/신청서/소장/고소장/합의서 etc.) with [blank] fields and writing tips. Fill blanks only with facts the user provides; do NOT draft legal arguments. Service: ${SVC}.`,
      inputSchema: { form: z.enum(FORM_KEYS).describe("서식 키. get_procedure/list_topics에서 안내된 서식명을 사용") },
      annotations: { title: "표준 서식 제공", ...READONLY },
    },
    async ({ form }) => {
      const f = FORMS[form];
      if (!f) {
        return { content: [{ type: "text", text: withDisclaimer(`'${form}' 서식이 없습니다.`) }] };
      }
      const text = [
        `📝 ${f.제목}`,
        `용도: ${f.용도}`,
        "",
        "─── 서식 시작 ───",
        f.본문,
        "─── 서식 끝 ───",
        "",
        "작성요령",
        ...f.작성요령.map((s) => `  - ${s}`),
      ].join("\n");
      return { content: [{ type: "text", text: withDisclaimer(text) }] };
    },
  );

  server.registerTool(
    "get_precedent",
    {
      title: "판례 조회",
      description: `Looks up verified Korean court precedents (case number + holding) by keyword or topic key. Only real, verified cases are stored. Service: ${SVC}.`,
      inputSchema: {
        keyword: z.string().optional().describe("주제 키 또는 검색어(예: 전세보증금반환, 사기, 해고, 지급명령). 비우면 판례가 있는 주제 목록"),
      },
      annotations: { title: "판례 조회", ...READONLY },
    },
    async ({ keyword }) => {
      const entries = Object.entries(PRECEDENTS).filter(([, v]) => v.length > 0);
      if (!keyword) {
        const topics = entries.map(([k]) => `  - ${k} (${PROCEDURES[k]?.제목 ?? ""})`).join("\n");
        return { content: [{ type: "text", text: withDisclaimer(`⚖️ 판례가 등록된 주제\n\n${topics}\n\n키워드를 넣으면 해당 판례를 보여드립니다.`) }] };
      }
      const matched = entries
        .filter(([k, v]) => k.includes(keyword) || v.some((p) => p.요지.includes(keyword) || p.사건번호.includes(keyword) || p.법원.includes(keyword)))
        .flatMap(([, v]) => v);
      if (!matched.length) {
        return { content: [{ type: "text", text: withDisclaimer(`'${keyword}'에 해당하는 등록 판례를 찾지 못했습니다. (등록된 판례만 조회되며, 없는 판례는 지어내지 않습니다.)`) }] };
      }
      const body = matched.map((p) => `• ${p.법원} ${p.사건번호}\n  ${p.요지}`).join("\n\n");
      return { content: [{ type: "text", text: withDisclaimer(`⚖️ 판례 (검색: ${keyword})\n\n${body}\n\n원문 확인: https://www.law.go.kr 또는 https://casenote.kr`) }] };
    },
  );

  server.registerTool(
    "calculate_amount",
    {
      title: "금액 계산기",
      description: `Estimates Korean labor amounts: unpaid wages, severance pay, weekly holiday allowance, or delay interest. Provide the numbers matching the chosen item. Estimates only. Service: ${SVC}.`,
      inputSchema: {
        item: z.enum(항목값).describe("체불임금 | 퇴직금 | 주휴수당 | 지연이자"),
        monthly_wage: z.number().optional().describe("[체불임금] 월 정상 임금(원)"),
        unpaid_months: z.number().optional().describe("[체불임금] 미지급 개월 수"),
        other_unpaid: z.number().optional().describe("[체불임금] 기타 미지급액(원)"),
        daily_avg_wage: z.number().optional().describe("[퇴직금] 1일 평균임금(원)"),
        tenure_days: z.number().optional().describe("[퇴직금] 총 재직일수"),
        weekly_hours: z.number().optional().describe("[주휴수당] 1주 소정근로시간"),
        hourly_wage: z.number().optional().describe("[주휴수당] 시급(원)"),
        principal: z.number().optional().describe("[지연이자] 미지급 원금(원)"),
        delay_days: z.number().optional().describe("[지연이자] 지연 일수"),
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
        }
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: (e as Error).message }] };
      }
      const text = [
        `🧮 ${a.item} 계산 결과`,
        "",
        `결과: ${r!.결과}`,
        `계산식: ${r!.계산식}`,
        r!.비고 ? `비고: ${r!.비고}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      return { content: [{ type: "text", text: withDisclaimer(text) }] };
    },
  );

  server.registerTool(
    "get_statute",
    {
      title: "법령 요지 조회",
      description: `Looks up summaries of key Korean statutes across everyday-law areas with an optional keyword filter. See law.go.kr for full text. Service: ${SVC}.`,
      inputSchema: { keyword: z.string().optional().describe("예: 해고, 보증금, 소멸시효, 청약철회, 사기, 지급명령 (비우면 전체)") },
      annotations: { title: "법령 요지 조회", ...READONLY },
    },
    async ({ keyword }) => {
      const list = keyword
        ? STATUTES.filter((s) => s.요지.includes(keyword) || s.조문.includes(keyword) || s.법령.includes(keyword))
        : STATUTES;
      if (!list.length) {
        return { content: [{ type: "text", text: withDisclaimer(`'${keyword}'에 해당하는 조문을 찾지 못했습니다.`) }] };
      }
      const body = list.map((s) => `• ${s.법령} ${s.조문} — ${s.요지}`).join("\n");
      const laws = [...new Set(list.map((s) => s.법령))];
      const links = laws.map((n) => `  - ${n}: https://www.law.go.kr/법령/${encodeURIComponent(n)}`).join("\n");
      const text = `⚖️ 법령 요지${keyword ? ` (검색: ${keyword})` : ""}\n\n${body}\n\n원문(국가법령정보센터):\n${links}`;
      return { content: [{ type: "text", text: withDisclaimer(text) }] };
    },
  );

  // 자연어 통합검색 — 일상어 상황 설명을 주제 키로 매핑(접근성).
  server.registerTool(
    "search_topics",
    {
      title: "자연어 주제 검색",
      description: `Maps a natural-language description of a problem (everyday Korean) to the most relevant legal topic keys. Use when the user describes a situation rather than naming a topic; pass the returned keys to get_procedure/get_checklist/get_form_template/get_precedent. Service: ${SVC}.`,
      inputSchema: {
        query: z.string().describe("자연어 상황 설명 (예: 월세 보증금을 못 돌려받고 있어요 / 회사가 갑자기 나가라고 해요 / 보이스피싱으로 돈을 송금했어요)"),
      },
      annotations: { title: "자연어 주제 검색", ...READONLY },
    },
    async ({ query }) => {
      const ranked = rankTopics(query).slice(0, 12);
      if (!ranked.length) {
        return { content: [{ type: "text", text: withDisclaimer(`'${query}'에 맞는 주제를 바로 찾지 못했습니다. list_topics로 전체 목록(36개 분야)을 확인하거나, 더 구체적인 표현으로 다시 검색해 주세요.`) }] };
      }
      const body = ranked.map((k) => `  - ${k} [${PROCEDURES[k].category}] : ${PROCEDURES[k].제목}`).join("\n");
      return { content: [{ type: "text", text: withDisclaimer(`🔎 '${query}' 관련 주제 (관련도순)\n\n${body}\n\n→ 위 주제 키로 get_procedure(절차)·get_checklist(서류)·get_form_template(서식)·get_precedent(판례)를 호출하세요.`) }] };
    },
  );

  // 판례·법령 인용 검증(+유효성) — 환각 차단. 우리 저장소에 실재하는지 확인하고 폐기·하급심 등 주의를 표시.
  server.registerTool(
    "verify_citation",
    {
      title: "판례·법령 인용 검증",
      description: `Verifies whether a cited Korean case number or statute article actually exists in this service's verified store and flags validity caveats (overruled, lower-court, sunset, amended). Never fabricates: unknown citations are reported as unverified with official lookup links (law.go.kr, casenote.kr). Service: ${SVC}.`,
      inputSchema: {
        citation: z.string().describe("검증할 사건번호 또는 법령 조문 (예: 2020다247190 / 대법원 2024도10141 / 민법 제759조 / 상가건물 임대차보호법 제10조의4)"),
      },
      annotations: { title: "판례·법령 인용 검증", ...READONLY },
    },
    async ({ citation }) => {
      const raw = citation.trim();
      const nq = raw.replace(/\s|\(.*?\)/g, "");
      const lines: string[] = [];
      // 1) 판례(사건번호) 매칭
      const seen = new Set<string>();
      for (const [k, arr] of Object.entries(PRECEDENTS)) {
        for (const p of arr) {
          const core = p.사건번호.replace(/\s|\(.*?\)/g, "").split(",")[0];
          if (core && (nq.includes(core) || core.includes(nq)) && !seen.has(p.사건번호 + k)) {
            seen.add(p.사건번호 + k);
            lines.push(`✅ [판례·수록확인] ${p.법원} ${p.사건번호} (주제: ${k})\n   ${p.요지}`);
          }
        }
      }
      // 2) 법령 조문 매칭(조문 일치 + 법령명 일부 일치로 오탐 방지)
      const joMatch = raw.match(/제\s*\d+\s*조(\s*의\s*\d+)?/);
      if (joMatch) {
        const joN = joMatch[0].replace(/\s/g, "");
        for (const s of STATUTES) {
          const lawTokens = s.법령.replace(/\s/g, "");
          const nameHit = [...lawTokens].some((_, i) => raw.replace(/\s/g, "").includes(lawTokens.slice(i, i + 2)) && lawTokens.length >= 2);
          if (s.조문.replace(/\s/g, "") === joN && (nameHit || !/\d{2,4}[가-힣]/.test(nq))) {
            lines.push(`✅ [법령·수록확인] ${s.법령} ${s.조문} — ${s.요지}`);
          }
        }
      }
      // 3) 유효성 주의(폐기·하급심·헌법불합치 등) — 질의한 번호 또는 매칭된 번호 모두 점검
      const statusKeys = Object.keys(CITATION_STATUS).filter((no) => nq.includes(no) || [...seen].some((s) => s.includes(no)));
      for (const no of statusKeys) {
        const st = CITATION_STATUS[no];
        lines.push(`⚠️ [유효성] ${no} — ${st.라벨}: ${st.설명}`);
      }
      if (!lines.length) {
        const enc = encodeURIComponent(raw);
        return { content: [{ type: "text", text: withDisclaimer(`🔍 '${raw}'은(는) 이 서비스의 검증된 저장소에서 확인되지 않았습니다.\n없는 판례·법령은 지어내지 않으니, 아래에서 직접 확인하세요:\n  - 국가법령정보센터: https://www.law.go.kr/precScListR.do?menuId=1&query=${enc}\n  - CaseNote: https://casenote.kr/search/?q=${enc}`) }] };
      }
      return { content: [{ type: "text", text: withDisclaimer(`🔍 인용 검증: '${raw}'\n\n${lines.join("\n\n")}\n\n원문 확인: https://www.law.go.kr · https://casenote.kr`) }] };
    },
  );

  // 시점법 — 최근 법령·판례 변경과 시행일(사건 발생 시점에 적용되는 법이 다를 수 있음).
  server.registerTool(
    "law_updates",
    {
      title: "최근 법령·판례 변경(시점법)",
      description: `Returns recent significant Korean statutory or precedent changes and their effective dates relevant to a keyword/topic, so guidance reflects the law applicable at the right time. Information only. Service: ${SVC}.`,
      inputSchema: {
        keyword: z.string().optional().describe("예: 스토킹 / 통상임금 / 유류분 / 임대차 / 개인정보 / 출퇴근 (비우면 최근 변경 전체)"),
      },
      annotations: { title: "최근 법령·판례 변경", ...READONLY },
    },
    async ({ keyword }) => {
      const kw = keyword?.trim();
      const list = kw
        ? LAW_TIMELINE.filter((c) => c.법령.includes(kw) || c.요지.includes(kw) || c.키워드.some((x) => x.includes(kw) || kw.includes(x)))
        : LAW_TIMELINE;
      if (!list.length) {
        return { content: [{ type: "text", text: withDisclaimer(`'${kw}' 관련 최근 변경 정보가 없습니다. 다른 키워드로 검색하거나 비우고 전체를 확인하세요.`) }] };
      }
      const body = list.map((c) => `• ${c.법령} — ${c.변경}\n  시행/적용: ${c.시행일}\n  ${c.요지}`).join("\n\n");
      return { content: [{ type: "text", text: withDisclaimer(`🕒 최근 법령·판례 변경${kw ? ` (검색: ${kw})` : ""}\n\n${body}\n\n※ 사건 발생 시점에 적용되는 법이 다를 수 있습니다. 정확한 시행일·경과규정은 law.go.kr에서 확인하세요.`) }] };
    },
  );

  // 빠른 진단(트리아지) — 상황 설명을 받아 가장 가까운 절차의 '기한·첫 단계·확보할 증거·도움처'를 한 장으로 안내.
  // declaw: 특정 결론·행동을 권하지 않고 '선택지·다음 단계' 정보만 제공(경로 안내). 빈칸 채움형 서식은 get_form_template로 연결.
  server.registerTool(
    "triage",
    {
      title: "빠른 진단·다음 단계",
      description: `Triage a free-text everyday-law situation: returns the closest topic's key deadline, the first action steps, the evidence to secure now, and where to get help, plus other candidate topics to confirm. Path-guidance and information only — does NOT give a verdict or recommend a specific legal action. Service: ${SVC}.`,
      inputSchema: {
        situation: z.string().describe("처한 상황을 일상어로 설명 (예: 전세 만기인데 집주인이 보증금을 안 줘요 / 어제 보이스피싱으로 500만원 보냈어요 / 직장 상사가 계속 폭언해요)"),
      },
      annotations: { title: "빠른 진단·다음 단계", ...READONLY },
    },
    async ({ situation }) => {
      const ranked = rankTopics(situation);
      if (!ranked.length) {
        return { content: [{ type: "text", text: withDisclaimer(`'${situation}'에 맞는 주제를 바로 찾지 못했습니다. search_topics로 다시 검색하거나 list_topics로 전체 분야를 확인해 주세요.`) }] };
      }
      const top = ranked[0];
      const p = PROCEDURES[top];
      const c = CHECKLISTS[top];
      const steps = p.단계.slice(0, 3).map((s) => `  ${s}`).join("\n");
      const evid = (c?.증거 ?? []).slice(0, 3).map((s) => `  - ${s}`).join("\n");
      const others = ranked.slice(1, 5).map((k) => `  · ${k} [${PROCEDURES[k].category}] ${PROCEDURES[k].제목}`).join("\n");
      const hasPrec = (PRECEDENTS[top]?.length ?? 0) > 0;
      const parts = [
        `🧭 빠른 진단: '${situation}'`,
        `※ 특정 결론·행동을 권하는 것이 아니라, 가장 가까운 절차의 기한·단계 정보를 안내합니다.`,
        ``,
        `▶ 가장 가까운 주제: ${top} [${p.category}] ${p.제목}`,
        ``,
        `⏰ 기한(놓치면 권리 소멸 위험): ${p.기한}`,
        ``,
        `✅ 지금 할 일(첫 단계)`,
        steps,
      ];
      if (evid) parts.push(``, `📎 먼저 확보할 증거`, evid);
      parts.push(``, `📞 접수·도움받을 곳: ${p.온라인접수}`);
      if (others) parts.push(``, `※ 상황이 아래에 더 가깝다면 그 주제로 다시 진단/조회하세요:`, others);
      parts.push(
        ``,
        `→ 더 자세히: get_procedure("${top}") · 서류 get_checklist("${top}") · 표준서식 get_form_template · 기한계산 calculate_amount${hasPrec ? ` · 판례 get_precedent("${top}")` : ""}`,
      );
      return { content: [{ type: "text", text: withDisclaimer(parts.join("\n")) }] };
    },
  );

  return server;
}

const app = express();
app.use(express.json());

app.get("/", (_req, res) => {
  res.type("text/plain").send("법률 절차 길잡이 MCP 서버 — POST /mcp (Streamable HTTP)");
});

app.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/mcp", async (req, res) => {
  const server = createServer();
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
app.listen(PORT, () => {
  console.error(`법률 절차 길잡이 MCP listening on http://localhost:${PORT}/mcp`);
});
