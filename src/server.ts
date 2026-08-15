import express from "express";
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

// 위젯 응답 스위치 — 카카오 툴즈(본선 서버)에서만 켠다. 위젯 반환 시 LLM이 가공하지 않고 카드가 곧 답변이 됨(가이드 §3).
// 기본: 프로덕션 on / 테스트 off. WIDGETS=on|off 로 강제 가능(호출 시점 평가라 테스트에서 토글 가능).
const widgetsOn = (): boolean =>
  process.env.WIDGETS === "on" || (process.env.WIDGETS !== "off" && process.env.NODE_ENV !== "test");

// 서비스명 — PlayMCP 개발가이드: description에 영문/국문 병기 서비스명 포함 필수
const SVC = "법률 절차 길잡이(Legal Navigator)";

const SERVER_INSTRUCTIONS =
  `한국 생활법률 ${TOPIC_KEYS.length}개 주제(노동·임대차·돈거래/사기·소비자·교통사고·민사/형사 절차·가정폭력/성범죄/스토킹·가사/상속·채무조정·산재·행정·의료·조세·부동산·출입국·복지/급여 등)의 절차·기한·표준 서식·금액 계산·법령/판례를 제공합니다. ` +
  "[호출 규칙] 법률·행정 상황 질문에는 모델 지식으로 먼저 답하지 말고 triage(상황 진단)·search_topics(주제 찾기)를, 해당 여부('이것도 스토킹인가요?' '처벌 가능한가요?' '신고 되나요?' '성립되나요?' '이거 보이스피싱인가요?')는 check_elements를 먼저 호출하세요 — 한국 법령·기한은 자주 바뀝니다. " +
  "흐름: 주제 키를 찾고 → get_procedure·get_checklist·get_form_template로 이어가며, 인용 확인은 verify_citation, 개정·시행일은 law_updates. " +
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

export function createServer(baseUrl?: string): McpServer {
  const server = new McpServer(
    { name: "legal-navigator", version: "0.4.0", title: "법률 절차 길잡이" },
    { instructions: SERVER_INSTRUCTIONS },
  );


  // 자연어 통합검색 — 일상어 상황 설명을 주제 키로 매핑(접근성).
  server.registerTool(
    "search_topics",
    {
      title: "자연어 주제 검색·주제 목록",
      description:
        `일상어 상황 설명을 법률 주제 키로 매핑(속어 포함: 떼인 돈·깡통전세·갑질). 한국 생활법률 ${TOPIC_KEYS.length}개 주제. query 없이 호출하면 전체 목록. 반환된 키를 get_procedure·get_checklist·get_form_template에 사용.\n` +
        `[트리거 예시] "층간소음 문제 어떻게 해요?" / "떼인 돈 받는 법" / "직장 내 괴롭힘 관련해서 알아봐줘" / "청년월세 지원 같은 거 있어?" / "무슨 법률 문제 도와줄 수 있어?"\n` +
        `Service: ${SVC}.`,
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe(
            "문제 유형을 요약한 키워드/짧은 문구 (예: 월세 보증금 미반환 / 갑작스러운 해고 / 보이스피싱 송금). 사용자의 발화 원문 대신, 개인정보를 제외한 요약 키워드로 전달하세요. 비우면 전체 주제 목록 반환.",
          ),
        category: z
          .enum(CATEGORIES as [string, ...string[]])
          .optional()
          .describe("[목록 조회용] 카테고리 필터 — query 없이 목록을 볼 때 사용 (비우면 전체)"),
      },
      annotations: { title: "자연어 주제 검색·주제 목록", ...READONLY },
    },
    async ({ query, category }) => {
      const q = query?.trim();
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
        return { content: [{ type: "text", text: withDisclaimer(`'${q}'에 맞는 주제를 바로 찾지 못했습니다. query 없이 호출하면 전체 목록(56개 분야)을 볼 수 있습니다. 더 구체적인 표현으로 다시 검색해 주세요.`) }] };
      }
      const body = ranked.map((k) => `- \`${k}\` — [${PROCEDURES[k].category}] ${PROCEDURES[k].제목}`).join("\n");
      return { content: [{ type: "text", text: withDisclaimer(`## 🔎 '${q}' 관련 주제 (관련도순)\n\n${body}\n\n→ 위 주제 키로 get_procedure(절차)·get_checklist(서류)·get_form_template(서식)·get_precedent(판례)를 호출하세요.`) }] };
    },
  );

  // 빠른 진단(트리아지) — 상황 설명을 받아 가장 가까운 절차의 '기한·첫 단계·확보할 증거·도움처'를 한 장으로 안내.
  // declaw: 특정 결론·행동을 권하지 않고 '선택지·다음 단계' 정보만 제공(경로 안내). 빈칸 채움형 서식은 get_form_template로 연결.
  server.registerTool(
    "triage",
    {
      title: "빠른 진단·다음 단계",
      description:
        `상황 한 줄 → 가장 가까운 절차의 기한·오늘 할 일·확보할 증거·도움처를 한 장으로. 생활 문제(돈·직장·집·가족·사기·사고·법원 서류·복지) 서술에는 모델 지식 대신 이 도구를 먼저 호출하세요 — 한국 법령·기한은 자주 바뀝니다. 결론 아님·경로 안내.\n` +
        `[트리거 예시] "회사가 법정관리에 들어갔는데 제 월급 못 받는걸까요?" / "도와주세요. 전세보증금 미반환, 받을수있을까요?" / "4천원 사기 당했어요 신고 가능한가요" / "법원에서 소장(지급명령)이 왔어요" / "갑자기 해고됐어요" / "살고 있는 집이 경매에 넘어갔어요"\n` +
        `Service: ${SVC}.`,
      inputSchema: {
        situation: z
          .string()
          .describe(
            "상황의 핵심을 요약한 키워드/짧은 문구 (예: 전세 보증금 미반환 / 보이스피싱 송금 피해 / 직장 상사 폭언). 사용자의 발화 원문을 그대로 넣지 말고, 이름·연락처 등 개인정보를 제외하고 문제 유형 중심으로 요약해서 전달하세요.",
          ),
      },
      annotations: { title: "빠른 진단·다음 단계", ...READONLY },
    },
    async ({ situation }) => {
      const ranked = rankTopics(situation);
      if (!ranked.length) {
        return { content: [{ type: "text", text: withDisclaimer(`'${situation}'에 맞는 주제를 바로 찾지 못했습니다. search_topics로 다시 검색하거나 search_topics를 query 없이 호출해 전체 분야를 확인해 주세요.`) }] };
      }
      const top = ranked[0];
      const p = PROCEDURES[top];
      const c = CHECKLISTS[top];
      // 카카오 툴즈: 진단 카드 위젯(기한 배지·첫 단계·접수처 버튼).
      if (widgetsOn()) {
        const kw = buildTriageWidget(situation, { key: top, category: p.category, 제목: p.제목, 기한: p.기한, 단계: p.단계, 온라인접수: p.온라인접수, 근거법: p.근거법 });
        return { content: [{ type: "text", text: kakaoWidgetText({ ...kw, name: "triage" }) }] };
      }
      const steps = p.단계.slice(0, 3).map((s) => `- ${s}`).join("\n");
      const evid = (c?.증거 ?? []).slice(0, 3).map((s) => `- ${s}`).join("\n");
      const others = ranked.slice(1, 5).map((k) => `- ${k} — [${PROCEDURES[k].category}] ${PROCEDURES[k].제목}`).join("\n");
      const hasPrec = (PRECEDENTS[top]?.length ?? 0) > 0;
      const parts = [
        `## 🧭 빠른 진단: '${situation}'`,
        `_특정 결론·행동을 권하는 것이 아니라, 가장 가까운 절차의 기한·단계 정보를 안내합니다._`,
        ``,
        `**가장 가까운 주제**: ${top} — [${p.category}] ${p.제목}`,
        ``,
        `### ⏰ 기한 (놓치면 권리 소멸 위험)`,
        p.기한,
        ``,
        `### ✅ 지금 할 일 (첫 단계)`,
        steps,
      ];
      if (evid) parts.push(``, `### 📎 먼저 확보할 증거`, evid);
      parts.push(``, `### 📞 접수·도움받을 곳`, p.온라인접수);
      parts.push(``, `### ⚖️ 근거 법령`, p.근거법.join(" · "));
      if (others) parts.push(``, `**상황이 아래에 더 가깝다면 그 주제로 다시 진단/조회하세요:**`, others);
      parts.push(
        ``,
        `→ 더 자세히: get_procedure("${top}") · 서류 get_checklist("${top}") · 표준서식 get_form_template · 기한계산 calculate_amount${hasPrec ? ` · 판례 get_precedent("${top}")` : ""}`,
      );
      return { content: [{ type: "text", text: withDisclaimer(parts.join("\n")) }] };
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
        `Service: ${SVC}.`,
      inputSchema: {
        keyword: z.string().optional().describe("상황·필요(예: 무료변호사, 체불, 범죄피해, 소송비용, 상담). 비우면 전체"),
      },
      annotations: { title: "무료 법률지원·구제 연결", ...READONLY },
    },
    async ({ keyword }) => {
      const kw = keyword?.trim();
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
        `Service: ${SVC}.`,
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
      description:
        `주제별로 모아둘 증거 + 접수용 준비서류 체크리스트.\n` +
        `[트리거 예시] "임금체불 신고하려면 뭘 준비해야 해요?" / "전세금 소송에 필요한 증거가 뭐예요?" / "고소하려면 어떤 서류가 필요해요?"\n` +
        `Service: ${SVC}.`,
      inputSchema: { topic: z.enum(TOPIC_KEYS).describe(TOPIC_DESC) },
      annotations: { title: "필요 서류·증거 체크리스트", ...READONLY },
    },
    async ({ topic }) => {
      const c = CHECKLISTS[topic];
      if (!c) {
        return { content: [{ type: "text", text: withDisclaimer(`'${topic}' 주제의 체크리스트가 없습니다. search_topics로 주제 키를 확인하세요.`) }] };
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
      return { content: [{ type: "text", text: withDisclaimer(text) }] };
    },
  );

  server.registerTool(
    "get_form_template",
    {
      title: "표준 서식 제공",
      description:
        `표준 서식 ${FORM_KEYS.length}종의 빈칸 채움 골격 + 작성요령 + 공식 양식 출처 + 제출 접수처. 모바일 미리보기(빈칸을 탭해 입력·인쇄/PDF 저장)와 .txt 다운로드 링크 제공. 문서를 써야 하거나 보내야 할 때 사용.\n` +
        `[트리거 예시] "내용증명 양식 줘" / "고소장 어떻게 써요?" / "차용증 써야 하는데" / "기초연금 신청서 양식 있어?" / "월급 못 받은 거 내용증명 보내고 싶어요"\n` +
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
          `**📎 텍스트 파일로 저장·공유**: ${baseUrl}/forms/${encodeURIComponent(form)}.txt` +
            (f.공식양식 ? " (관공서 제출본은 위 '공식 양식 받는 곳'에서 정식 서식을 받아 작성)" : ""),
        );
      }
      // 서식 본문은 코드블록으로 감싸 마크다운 해석(대괄호·번호목록 변형)을 차단하고 원형 유지.
      const text = [...head, "", "```", f.본문, "```", "", ...tail].join("\n");
      return { content: [{ type: "text", text: withDisclaimer(text) }] };
    },
  );

  server.registerTool(
    "get_precedent",
    {
      title: "판례 조회",
      description:
        `검증된 판례 조회(사건번호·요지·casenote 링크) — 실재 확인된 것만 수록하며 없으면 없다고 답합니다.\n` +
        `[트리거 예시] "비슷한 판례 있어요?" / "보일러 수리비 관련 판례 알려줘" / "법원이 이런 경우 어떻게 판단했어요?" / "전세보증금 판례 찾아줘"\n` +
        `Service: ${SVC}.`,
      inputSchema: {
        keyword: z.string().optional().describe("주제 키 또는 검색어(예: 전세보증금반환, 사기, 해고, 지급명령). 비우면 판례가 있는 주제 목록"),
      },
      annotations: { title: "판례 조회", ...READONLY },
    },
    async ({ keyword }) => {
      const entries = Object.entries(PRECEDENTS).filter(([, v]) => v.length > 0);
      if (!keyword) {
        const topics = entries.map(([k]) => `- \`${k}\` — ${PROCEDURES[k]?.제목 ?? ""}`).join("\n");
        return { content: [{ type: "text", text: withDisclaimer(`## ⚖️ 판례가 등록된 주제\n\n${topics}\n\n키워드를 넣으면 해당 판례를 보여드립니다.`) }] };
      }
      const matched = entries
        .filter(([k, v]) => k.includes(keyword) || v.some((p) => p.요지.includes(keyword) || p.사건번호.includes(keyword) || p.법원.includes(keyword)))
        .flatMap(([, v]) => v);
      if (!matched.length) {
        return { content: [{ type: "text", text: withDisclaimer(`'${keyword}'에 해당하는 등록 판례를 찾지 못했습니다. (등록된 판례만 조회되며, 없는 판례는 지어내지 않습니다.)`) }] };
      }
      const body = matched.map((p) => `- **${p.법원} ${p.사건번호}**\n  ${p.요지}`).join("\n");
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
        return { content: [{ type: "text", text: kakaoWidgetText({ ...buildCalcWidget(a.item, r!), name: "calculate_amount" }) }] };
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
      return { content: [{ type: "text", text: withDisclaimer(text) }] };
    },
  );

  server.registerTool(
    "get_statute",
    {
      title: "법령 요지 조회",
      description:
        `주요 조문의 쉬운 요지 + 국가법령정보센터 원문 링크.\n` +
        `[트리거 예시] "임대인 수선의무 법 조항이 뭐예요?" / "사기죄 처벌 조항 알려줘" / "무슨 법에 근거가 있어요?"\n` +
        `Service: ${SVC}.`,
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
      const body = list.map((s) => `- **${s.법령} ${s.조문}** — ${s.요지}`).join("\n");
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
        `Service: ${SVC}.`,
      inputSchema: {
        citation: z.string().describe("검증할 사건번호 또는 법령 조문 (예: 2020다247190 / 대법원 2024도10141 / 민법 제759조 / 상가건물 임대차보호법 제10조의4)"),
      },
      annotations: { title: "판례·법령 인용 검증", ...READONLY },
    },
    async ({ citation }) => {
      const raw = citation.trim();
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
        `Service: ${SVC}.`,
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
        return { content: [{ type: "text", text: kakaoWidgetText({ ...buildCalcWidget("소송비용(개략)", r), name: "calculate_court_cost" }) }] };
      }
      const text = `## 🧮 소송비용(개략)\n\n- **결과**: ${r.결과}\n- **계산식**: ${r.계산식}\n\n> 💡 ${r.비고}`;
      return { content: [{ type: "text", text: withDisclaimer(text) }] };
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
        return { content: [{ type: "text", text: kakaoWidgetText({ ...kw, name: "calculate_deadline" }) }] };
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
      return { content: [{ type: "text", text: withDisclaimer(text) }] };
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
        `Service: ${SVC}.`,
      inputSchema: {
        document: z.string().optional().describe("서류명/키워드(예: 등기부등본, 가족관계증명서, 소득금액증명, 진단서, 부채증명, 전입세대확인서). 비우면 전체 목록 + 준비 꿀팁"),
      },
      annotations: { title: "증빙서류 발급 안내", ...READONLY },
    },
    async ({ document }) => {
      const kw = document?.trim();
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
        `Service: ${SVC}.`,
      inputSchema: {
        term: z.string().describe("뜻이 궁금한 단어(법률용어 또는 일상어). 예: 각하, 가압류, 공시송달, 통상임금, 떼인 돈, 빨간딱지"),
      },
      annotations: { title: "법률용어 풀이", ...READONLY },
    },
    async ({ term }) => {
      const kw = term.trim();
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
      const tail = `\n\n→ 관련 절차는 search_topics("${kw}"), 더 깊은 원문은 국가법령정보센터(law.go.kr) 법령용어·생활법령(easylaw.go.kr).`;
      return { content: [{ type: "text", text: withDisclaimer(`## 🔎 '${kw}' 뜻풀이 (${matched.length}건)\n\n${body}${tail}`) }] };
    },
  );

  return server;
}

export const app = express();
app.use(express.json());

app.get("/", (_req, res) => {
  res.type("text/plain").send("법률 절차 길잡이 MCP 서버 — POST /mcp (Streamable HTTP)");
});

app.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

// 요청에서 공개 베이스 URL 도출(프록시 뒤에서도 정확하도록 X-Forwarded-* 우선, PUBLIC_BASE_URL로 강제 가능).
function getBaseUrl(req: express.Request): string {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, "");
  const xfproto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim();
  const xfhost = (req.headers["x-forwarded-host"] as string | undefined)?.split(",")[0]?.trim();
  const host = xfhost || req.headers.host || "";
  // ★배포 도메인은 무조건 https — kakaocloud 프록시가 내부 홉에서 x-forwarded-proto: http를 보내와도
  //   신뢰하면 안 됨(도메인의 80포트는 응답조차 없어 링크가 죽고, https 채팅창에선 혼합콘텐츠 차단).
  //   로컬(localhost 등)에서만 실제 프로토콜을 따른다.
  const hostname = host.split(":")[0].toLowerCase();
  const isLocal = ["localhost", "127.0.0.1", "0.0.0.0", "::1"].includes(hostname);
  const proto = isLocal ? xfproto || req.protocol || "http" : "https";
  return host ? `${proto}://${host}` : "";
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
function 본문HTML(bodyRaw: string): string {
  let s = htmlEscape(bodyRaw);
  // 0) ○○ → 입력 필드. 반드시 대괄호 처리보다 먼저 — 나중에 하면 생성된 필드의
  //    data-ph 속성값 안에 든 ○까지 다시 치환해 HTML이 깨진다.
  s = 대괄호밖(s, (seg) =>
    seg.replace(동그라미자리, (m) => {
      const minw = Math.min(Math.max(m.length, 4), 28);
      return `<span class="fld" contenteditable="true" role="textbox" data-ph="${m}" style="min-width:${minw}ch"></span>`;
    }),
  );
  // 0-2) 대괄호 밖에 남은 밑줄(____)도 입력 가능하게 — 종이 서식의 빈칸 관행(8/11 회의 결정 ②).
  //    ○○와 같은 이유로 대괄호 처리보다 먼저·대괄호 밖에서만. 뒤로 미루면 3)이 만든
  //    data-ph 안의 밑줄까지 치환한다(예: 항소장 "[○○지방법원 20 가단 ____ … 선고]").
  s = 대괄호밖(s, (seg) =>
    seg.replace(/_{3,}/g, (m) => {
      const minw = Math.min(Math.max(m.length, 4), 28);
      return `<span class="fld" contenteditable="true" role="textbox" data-ph="" style="min-width:${minw}ch"></span>`;
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
    return `<span class="fld" contenteditable="true" role="textbox" data-ph="${ph}" style="min-width:${minw}ch"></span>`;
  });
  return s;
}

// 서식 시각화 미리보기 — 모바일(카카오톡 인앱)에서 빈칸을 직접 채우고 인쇄/PDF로 저장. 자족적 HTML(외부 의존 0).
function renderFormHtml(key: string, f: (typeof FORMS)[string], baseUrl: string): string {
  const txtHref = `${baseUrl || ""}/forms/${encodeURIComponent(key)}.txt`;
  // 제목 끝의 서식 성격 꼬리표("… 공란 채움" · "… 예시 — 공란을 직접 채워 사용" · "… 상담 시 작성" 등)는
  // 제목에서 떼어내 작은 배지로 — 모바일에서 제목이 두세 줄을 먹던 문제
  const 꼬리표 = /\s*\(([^()]*(?:공란|채움|골격|예시|서식|작성|입력 항목)[^()]*)\)\s*$/.exec(f.제목);
  const title = htmlEscape(꼬리표 ? f.제목.slice(0, 꼬리표.index).trim() : f.제목);
  const kind = 꼬리표 ? htmlEscape(꼬리표[1]) : "";
  const purpose = htmlEscape(f.용도);
  const official = f.공식양식 ? htmlEscape(f.공식양식) : "";
  const tips = f.작성요령.map((t) => `<li>${htmlEscape(t)}</li>`).join("");
  const body = 본문HTML(f.본문);
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · 법률 절차 길잡이</title>
<style>
/* 랜딩(legal-navigator-web index.html :root)과 같은 값. 두 화면이 한 서비스로 보이려면 갈리면 안 된다.
   --fld 계열(빈칸의 노란 표시)만 기능색이라 별도 유지. */
:root{--bg:#f4f6f9;--paper:#fff;--ink:#191f28;--ink2:#4e5968;--line:#e5e8eb;--accent:#3182f6;--accent-ink:#fff;--fld:#fff7e6;--fld-line:#d9a534;--fld-ink:#8a5a00;--ph:#8b95a1;--tip-bg:#f4f6f9;--foot:#8b95a1;}
@media (prefers-color-scheme:dark){:root{--bg:#0e1116;--paper:#171b22;--ink:#e6e9f0;--ink2:#a2aabb;--line:#2a2f3a;--accent:#4c8dff;--fld:#2a2410;--fld-line:#6f5a1f;--fld-ink:#e7c877;--ph:#6b7488;--tip-bg:#141b2b;--foot:#7a8398;}}
*{box-sizing:border-box}
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
.official{margin:12px 0 0;font-size:13px;background:var(--tip-bg);border:1px solid var(--line);border-radius:10px;padding:10px 12px;color:var(--ink2)}
.official b{color:var(--ink)}
/* 안내문은 한 덩어리 문장으로 흐르게 — flex로 두면 조각조각 칼럼처럼 쪼개져 읽기 어려움 */
.hint{display:block;margin:16px 2px 8px;font-size:12.5px;color:var(--ink2);line-height:1.9;word-break:keep-all}
.hint .k{background:var(--fld);border:1px dashed var(--fld-line);color:var(--fld-ink);border-radius:6px;padding:1px 7px;font-weight:700;white-space:nowrap}
.doc{background:var(--paper);border:1px solid var(--line);border-radius:14px;box-shadow:0 1px 2px rgba(0,0,0,.04),0 14px 40px -22px rgba(0,0,0,.3);padding:clamp(18px,5vw,34px);white-space:pre-wrap;word-break:keep-all;overflow-wrap:anywhere;font-size:15px;line-height:1.95;}
.fld{display:inline-block;max-width:100%;border:none;border-bottom:1.6px solid var(--fld-line);background:var(--fld);color:var(--fld-ink);border-radius:4px 4px 0 0;padding:0 5px;margin:0 1px;min-height:1.5em;line-height:1.5;font-weight:600;outline:none;vertical-align:baseline;font-family:inherit;}
.fld:focus{box-shadow:0 0 0 2px color-mix(in srgb,var(--fld-line) 45%,transparent);background:color-mix(in srgb,var(--fld) 70%,var(--paper));}
.fld:empty::before{content:attr(data-ph);color:var(--ph);font-weight:400}
/* 긴 서술형 칸 — 항목명(예: "- 경위:")은 윗줄에 그대로 두고, 입력은 아래 전용 칸에서.
   인라인으로 두면 글을 쓸수록 칸이 부풀어 앞 항목명이 밀려 내려간다(8/11 회의 결정 ②). */
.fld.big{display:block;width:100%;min-width:0;margin:6px 0 4px;padding:10px 12px;min-height:4.2em;
  border:1.5px dashed var(--fld-line);border-radius:10px;line-height:1.7;font-weight:500;white-space:pre-wrap;}
.fld.big:empty::before{content:attr(data-ph);color:var(--ph);font-weight:400;font-size:.94em}
.lbl{font-weight:800;background:color-mix(in srgb,var(--accent) 11%,transparent);color:var(--ink);padding:1px 8px;border-radius:6px;letter-spacing:-.01em;}
.cbx{display:inline-block;cursor:pointer;user-select:none;font-size:1.15em;line-height:1;padding:0 2px;color:var(--accent);vertical-align:-.05em}
.cbx:focus{outline:2px solid var(--accent);outline-offset:2px;border-radius:3px}
.tips{margin:22px 0 0;background:var(--tip-bg);border:1px solid var(--line);border-radius:14px;padding:16px 18px}
.tips h2{font-size:14px;margin:0 0 10px;display:flex;align-items:center;gap:7px}
.tips ol{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:7px;font-size:13.5px;color:var(--ink2)}
.foot{margin:26px 4px 0;font-size:11.5px;color:var(--foot);line-height:1.6}
.foot a{color:var(--foot)}
/* 좁은 화면 — 버튼 4개를 2×2로. 위 줄은 내보내기(PDF·한글), 아래 줄은 보조(텍스트·비우기) */
@media (max-width:520px){
  .bar{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:9px 12px}
  .bar .sp{display:none}
  .btn{padding:11px 8px;font-size:13.5px;justify-content:center}
  .wrap{padding:16px 12px 56px}
  .doc{line-height:1.85;font-size:14.5px}
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
<div class="bar">
  <button class="btn pri" id="printBtn" type="button">인쇄 · PDF로 저장</button>
  <button class="btn" id="docBtn" type="button">한글 · 워드로 가져가기</button>
  <a class="btn" href="${txtHref}">텍스트 파일</a>
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
  <div class="hint"><span class="k">[빈칸]</span> 과 <span class="k">○○</span>(법원·기관 이름) 을 탭해 입력하고, <b>☐</b> 는 탭하면 체크됩니다. 경위·사유처럼 길게 쓰는 항목은 <b>아래 넓은 칸</b>에 적으면 됩니다. 다 채우면 <b>인쇄·PDF로 저장</b>하거나, <b>한글·워드로 가져가기</b>로 작성한 내용을 문서 파일로 받아 이어서 편집할 수 있습니다.</div>
  <div class="doc" id="doc">${body}</div>
  <div class="tips">
    <h2>작성요령</h2>
    <ol>${tips}</ol>
  </div>
  <p class="foot">※ 일반 법률·절차 정보이며 개별 법률 자문이 아닙니다. 입력 내용은 이 기기 브라우저에만 자동 저장되며 서버로 전송되지 않습니다(빈칸 비우기를 누르면 삭제). 관공서 제출본은 위 ‘공식 양식 받는 곳’에서 정식 서식을 받아 작성하세요. · 법률 절차 길잡이(Legal Navigator)</p>
</div>
<script>
(function(){
  var doc=document.getElementById("doc");
  // 입력값 자동 저장·복원 — 이 기기 브라우저(localStorage)에만 저장, 서버 전송 없음.
  var KEY="lnform:"+location.pathname;
  function save(){
    try{
      var d={f:[],c:[]};
      doc.querySelectorAll(".fld").forEach(function(x){d.f.push(x.textContent||"");});
      doc.querySelectorAll(".cbx").forEach(function(c){d.c.push(c.getAttribute("aria-checked")==="true");});
      localStorage.setItem(KEY,JSON.stringify(d));
    }catch(e){}
  }
  function restore(){
    try{
      var raw=localStorage.getItem(KEY); if(!raw) return;
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
  doc.addEventListener("input",save);
  restore();
  document.getElementById("printBtn").addEventListener("click",function(){window.print();});
  // 한글·워드로 가져가기 — 채운 값 그대로 담은 .doc(웹문서)을 브라우저에서 만들어 내려받는다.
  // 서버로는 아무것도 보내지 않는다(개인정보 미수집 원칙). 한글·워드·리브레오피스에서 열리며
  // 이어서 편집·인쇄 가능. '제출본 생성'이 아니라 '작성한 내용의 반출'이 목적.
  document.getElementById("docBtn").addEventListener("click",function(){
    function esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}
    var out=[];
    doc.childNodes.forEach(function(n){
      if(n.nodeType===3){out.push(esc(n.textContent));return;}
      if(n.nodeType!==1)return;
      if(n.classList.contains("fld")){
        var v=n.textContent||"";
        if(n.classList.contains("big")){out.push('<div style="border:1px solid #000;padding:6pt;margin:4pt 0;min-height:36pt;white-space:pre-wrap">'+(v?esc(v):"")+"</div>");}
        else out.push('<u>'+(v?esc(v):"      ")+"</u>");
      }else if(n.classList.contains("cbx")){out.push(n.getAttribute("aria-checked")==="true"?"☑":"☐");}
      else if(n.classList.contains("lbl")){out.push("<b>"+esc(n.textContent)+"</b>");}
      else out.push(esc(n.textContent));
    });
    var title=${JSON.stringify(f.제목)}, fname=${JSON.stringify(f.제목.replace(/\s*\([^()]*\)\s*$/, "").trim())};
    var html='<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"><title>'+esc(title)+'</title>'
      +'<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom></w:WordDocument></xml><![endif]-->'
      +'<style>@page{size:A4;margin:20mm} body{font-family:"Batang","바탕","Malgun Gothic",serif;font-size:11.5pt;line-height:1.75;color:#000} u{text-decoration:underline}</style></head>'
      +'<body><div style="white-space:pre-wrap">'+out.join("")+"</div></body></html>";
    var blob=new Blob([String.fromCharCode(0xFEFF)+html],{type:"application/msword;charset=utf-8"});
    var a=document.createElement("a");
    a.href=URL.createObjectURL(blob);
    a.download=fname.replace(/[\\\\/:*?"<>|]/g,"").replace(/\\s+/g,"_")+".doc";
    document.body.appendChild(a);a.click();
    setTimeout(function(){URL.revokeObjectURL(a.href);a.remove();},1000);
  });
  document.getElementById("resetBtn").addEventListener("click",function(){
    doc.querySelectorAll(".fld").forEach(function(x){x.textContent="";});
    doc.querySelectorAll(".cbx").forEach(function(c){c.setAttribute("aria-checked","false");c.textContent="☐";});
    try{localStorage.removeItem(KEY);}catch(e){}
  });
})();
</script>
</body></html>`;
}

// 서식 라우트 — 확장자 없음/.html은 시각화 미리보기(빈칸 채움), .txt는 파일 다운로드. 읽기전용·무상태·인메모리.
app.get("/forms/:key", (req, res) => {
  const raw = req.params.key; // Express 5가 params를 이미 디코드(이중 디코딩 금지)
  const m = /\.(txt|html?)$/i.exec(raw);
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
    "※ 일반 법률·절차 정보이며 개별 법률 자문이 아닙니다. 관공서 제출본은 위 '공식 양식 받는 곳'에서 정식 서식을 받아 작성하세요.",
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
    const q = (req.query.q as string) || "월급을 3개월째 못 받았어요";
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
