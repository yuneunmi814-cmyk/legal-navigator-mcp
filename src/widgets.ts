// 카카오 툴즈 위젯 — OpenAI ChatKit 위젯 스펙 + 카카오 전용 스펙(개발가이드 v1.0.0 확정 반영).
// 참조: github.com/openai/chatkit-js packages/chatkit/types/widgets.d.ts + [AGENTIC PLAYER 10] Kakao Tools 개발 가이드 §3.
// 카카오 확정 스펙: ① 전체를 `widget` 프로퍼티로 감싸기 ② 카톡 공유용은 `copy_text`(간단 Markdown)
// ③ status 프로퍼티 사용 금지(카카오가 로고·서비스명 표기에 사용) ④ 버튼 URL은 onClickAction.payload.target.url(+선택 pcUrl)
// ⑤ tools/call 응답은 text content에 JSON.stringify({widget, copy_text, name}) 형태.

// ── ChatKit 위젯 타입(사용하는 부분집합만) ─────────────────────────────
// 가이드 샘플 기준: onClickAction은 payload.target.url(+pcUrl)만으로 동작(type 생략).
export type ActionConfig = { type?: string; payload?: Record<string, unknown> };

export interface Title { type: "Title"; value: string; size?: "sm" | "md" | "lg" }
export interface Caption { type: "Caption"; value: string }
export interface TextC { type: "Text"; value: string; size?: string; italic?: boolean }
export interface Markdown { type: "Markdown"; value: string }
export interface Badge {
  type: "Badge";
  label: string;
  color?: "secondary" | "success" | "danger" | "warning" | "info" | "discovery";
  variant?: "solid" | "soft" | "outline";
  pill?: boolean;
}
export interface Button {
  type: "Button";
  label: string;
  onClickAction: ActionConfig;
  style?: "primary" | "secondary";
  block?: boolean;
}
export interface Divider { type: "Divider" }
export interface Row { type: "Row"; children: WidgetComponent[]; gap?: number }
export interface Col { type: "Col"; children: WidgetComponent[]; gap?: number }
export type WidgetComponent = Title | Caption | TextC | Markdown | Badge | Button | Divider | Row | Col;
export interface Card {
  type: "Card";
  children: WidgetComponent[];
  size?: "sm" | "md" | "lg" | "full";
}
export type WidgetRoot = Card;

// 카카오 확정 봉투(개발가이드 §3) — 전체를 'widget'으로 감싸고, 카톡 공유용은 copy_text(간단 Markdown).
export interface KakaoWidget {
  widget: WidgetRoot;
  copy_text?: string;
  name?: string; // 별첨 예시의 응답 name 필드(도구 식별)
  // 카카오 스펙 외 추가 필드 — 렌더러는 무시하고 호스트 LLM만 읽는 어시스턴트용 지침(서식 초안 작성 보조).
  // ⚠️ 카카오 가이드 §3에 없는 필드이므로 프리뷰(preview-chatgpt.kakao.com)에서 카드 렌더 정상 여부 필수 확인.
  for_assistant?: string;
}

// 버튼 URL 액션 — 카카오 확정 스펙: onClickAction.payload.target.url (+선택 pcUrl, PC 카카오톡용 대체 URL).
const openUrl = (url: string, pcUrl?: string): ActionConfig => ({
  payload: { target: pcUrl ? { url, pcUrl } : { url } },
});

const trunc = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// tools/call 위젯 응답 직렬화 — 가이드 별첨: text content에 JSON.stringify({widget, copy_text, name}).
export function kakaoWidgetText(kw: KakaoWidget): string {
  return JSON.stringify(kw);
}

// ── 1) 서식 카드 — get_form_template용: '보이는 문서' 한 장 + 빈칸 채우기/다운로드 버튼 ──
export function buildFormWidget(
  formKey: string,
  f: { 제목: string; 용도: string; 공식양식?: string },
  baseUrl: string,
  // 8/11 회의 결정: 서식을 채운 뒤 '어디에 내는지'를 카드에 함께 — 주제의 검증된 접수처 데이터 재사용.
  // url이 없으면(방문·서면 접수) 버튼 없이 제출처 캡션만 표시.
  submit?: { url?: string | null; 관할: string },
): KakaoWidget {
  const previewUrl = `${baseUrl}/forms/${encodeURIComponent(formKey)}`;
  // 8/21: "텍스트 파일로 받기"를 없애고 서식 파일 받기로 바꿨다.
  // 8/23: 페이지를 거치지 않고 **파일이 바로 떨어지게** 바꿨다 — 카톡에서 서식을 찾은
  // 사람에게 "페이지 열고 → 메뉴 열고 → 형식 고르고"는 세 단계나 된다.
  // 한글(.hwpx)로 준다. 관공서 제출 서식이라 워드보다 이쪽이 기본값이고,
  // 워드·채워서 받기는 '빈칸 바로 채우기' 화면에 그대로 있다.
  const hwpUrl = `${previewUrl}.hwpx`;
  const children: WidgetComponent[] = [
    { type: "Title", value: trunc(f.제목.replace(/\s*\(.*?\)\s*$/, ""), 40) },
    { type: "Caption", value: trunc(f.용도, 90) },
    {
      type: "Row",
      gap: 8,
      children: [
        { type: "Badge", label: "빈칸 채움형", color: "info", variant: "soft" },
        ...(f.공식양식 ? [{ type: "Badge", label: "공식양식 안내 포함", color: "success", variant: "soft" } as Badge] : []),
      ],
    },
    { type: "Divider" },
    { type: "Button", label: "🖊️ 빈칸 바로 채우기 (미리보기·PDF)", onClickAction: openUrl(previewUrl), style: "primary", block: true },
    ...(submit?.url
      ? [{ type: "Button", label: "🏛️ 접수처 바로가기", onClickAction: openUrl(submit.url), style: "secondary", block: true } as Button]
      : []),
    { type: "Button", label: "📄 한글 서식 바로 받기 (.hwpx)", onClickAction: openUrl(hwpUrl), style: "secondary", block: true },
    ...(submit ? [{ type: "Caption", value: trunc(`🏛️ 제출: ${submit.관할}`, 70) } as Caption] : []),
    { type: "Caption", value: "일반 정보이며 개별 법률 자문이 아닙니다 · 법률 절차 길잡이" },
  ];
  return {
    widget: { type: "Card", size: "md", children },
    copy_text:
      `${f.제목}\n빈칸을 탭해서 바로 채우고 인쇄·PDF·한글(.hwpx)·워드(.docx)로 받기: ${previewUrl}` +
      (submit ? `\n제출처: ${submit.관할}` : "") +
      `\n— 법률 절차 길잡이`,
  };
}

// 접수처 자유 텍스트에서 첫 URL/도메인 추출 — 진단 카드·서식 카드 공용.
// URL에 쓰일 수 있는 ASCII만 받는다. 이전 정규식은 '공백·닫는괄호'만 경계로 삼아
// "bokjiro.go.kr(서비스신청→…" "animal.go.kr·qia.go.kr"처럼 한글·여는괄호·가운뎃점까지
// 주소에 붙여버렸다(버튼 113개 중 60개가 죽은 링크). 경계를 문자 집합으로 막는다.
const URL_CHARS = "A-Za-z0-9\\-._~%/?#=&+@:";
const SUBMIT_URL_RE = new RegExp(
  // ① 스킴이 있는 주소 ② 스킴 없는 맨 도메인(go.kr·or.kr·kr·com). 앞에 @·영숫자가 붙은 것은
  //    이메일 도메인이거나 토큰 중간이므로 제외.
  `https?://[${URL_CHARS}]+` +
    `|(?<![${URL_CHARS}])[A-Za-z0-9][A-Za-z0-9\\-]*(?:\\.[A-Za-z0-9\\-]+)*\\.(?:go\\.kr|or\\.kr|kr|com)(?:/[${URL_CHARS}]*)?`,
);

export function extractSubmitUrl(온라인접수: string): string | null {
  const m = 온라인접수.match(SUBMIT_URL_RE);
  if (!m) return null;
  // 문장 부호로 끝나면(…go.kr. / …go.kr, ) 주소에서 떼어낸다.
  const raw = m[0].replace(/[.,;:?!/#]+$/, "");
  return raw.startsWith("http") ? raw : `https://${raw}`;
}

// ── 2) 진단 카드 — triage용: 주제·기한 경고·첫 단계 3개·접수처 버튼 ──
export function buildTriageWidget(
  situation: string,
  topic: { key: string; category: string; 제목: string; 기한: string; 단계: string[]; 온라인접수: string; 근거법?: string[] },
): KakaoWidget {
  // 접수처 자유 텍스트에서 첫 URL/도메인 추출(있으면 버튼 제공)
  const url = extractSubmitUrl(topic.온라인접수);
  const steps = topic.단계.slice(0, 3).map(
    (s): TextC => ({ type: "Text", value: trunc(s.replace(/^\d+[)\-]?\s*/, "• "), 70), size: "sm" }),
  );
  const children: WidgetComponent[] = [
    { type: "Caption", value: `빠른 진단 · ${trunc(situation, 30)}` },
    { type: "Title", value: trunc(topic.제목, 40) },
    {
      type: "Row",
      gap: 8,
      children: [
        { type: "Badge", label: topic.category, color: "secondary", variant: "soft" },
        { type: "Badge", label: `⏰ ${trunc(topic.기한, 28)}`, color: "danger", variant: "soft" },
      ],
    },
    { type: "Divider" },
    { type: "Text", value: "✅ 지금 할 일" },
    ...steps,
    ...(url
      ? [{ type: "Button", label: "🏛️ 접수처 바로가기", onClickAction: openUrl(url), style: "primary", block: true } as Button]
      : []),
    ...(topic.근거법?.length
      ? [{ type: "Caption", value: trunc(`⚖️ ${topic.근거법.join(" · ")}`, 70) } as Caption]
      : []),
    { type: "Caption", value: "결론 아님·경로 안내 · 무료상담 132 · 법률 절차 길잡이" },
  ];
  return {
    widget: { type: "Card", size: "md", children },
    copy_text: `[${topic.category}] ${topic.제목}\n⏰ ${topic.기한}${topic.근거법?.length ? `\n⚖️ ${topic.근거법.join(" · ")}` : ""}\n무료상담: 대한법률구조공단 132 — 법률 절차 길잡이`,
  };
}

// ── 3) 계산 결과 카드 — calculate_* 용: 결과 크게, 산식은 작게 ──
export function buildCalcWidget(item: string, r: { 결과: string; 계산식: string; 비고?: string }): KakaoWidget {
  const children: WidgetComponent[] = [
    { type: "Caption", value: `🧮 ${item}` },
    { type: "Title", value: trunc(r.결과, 40), size: "lg" },
    { type: "Divider" },
    { type: "Text", value: `계산식: ${trunc(r.계산식, 90)}`, size: "sm" },
    ...(r.비고 ? [{ type: "Text", value: trunc(`💡 ${r.비고}`, 110), size: "sm", italic: true } as TextC] : []),
    { type: "Caption", value: "개략 계산 · 법률 절차 길잡이" },
  ];
  return {
    widget: { type: "Card", size: "sm", children },
    copy_text: `${item}: ${r.결과} (${r.계산식}) — 법률 절차 길잡이`,
  };
}

// ── 4) 무료 법률지원 카드 — find_legal_aid용: 지금 걸 수 있는 번호를 버튼으로 ──
// 이 서비스 사용자가 가장 자주 막히는 지점은 "그래서 어디에 물어보나"다.
// 카카오 가이드 §3.3은 버튼 URL이 AppScheme도 받는다고 명시한다 → tel:로 바로 걸리게 한다.
// ⚠️ 순서가 전부다. 짧은 것부터 맞추면 1588-0075가 '1588'로 잘려 전화가 안 걸린다
// (2026-08-26 미리보기에서 실제로 그렇게 나왔다). 긴 형태부터 차례로 시도한다.
const 전화형태 = [
  /\b(1[5-9]\d{2}[-\s]?\d{4})\b/,          // 1588-0075 · 1899-xxxx
  /\b(0\d{1,2}[-\s]?\d{3,4}[-\s]?\d{4})\b/, // 02-3476-6515 · 031-xxx-xxxx
  /\b(1[0-9]{2,3})\b/,                       // 132 · 112 · 129 · 1350 · 1366
];
// tel: 에는 숫자만, 화면에는 사람이 읽는 모양(1588-0075) 그대로 보여준다.
const 전화추출 = (연락: string): { tel: string; 표시: string } | null => {
  const 정리 = 연락.replace(/국번없이\s*/g, "").replace(/[☎️☏]/g, " ");
  for (const re of 전화형태) {
    const m = re.exec(정리);
    if (m) return { tel: m[1].replace(/[-\s]/g, ""), 표시: m[1].replace(/\s/g, "-") };
  }
  return null;
};

export function buildLegalAidWidget(
  keyword: string | undefined,
  programs: { 명칭: string; 대상: string; 내용: string; 연락: string }[],
  hotlines: { 번호: string; 기관: string; 용도: string }[],
): KakaoWidget {
  const shown = programs.slice(0, 3);
  const 프로그램줄: WidgetComponent[] = shown.flatMap((p): WidgetComponent[] => [
    { type: "Text", value: trunc(p.명칭, 44) },
    { type: "Caption", value: trunc(`대상: ${p.대상}`, 62) },
  ]);

  // 전화 버튼 — 프로그램에서 뽑은 번호를 앞에, 132는 언제나 마지막 보루로 남긴다.
  // ⚠️ 핫라인을 앞에서부터 그냥 집으면 임금체불 질문에 '112 경찰'이 뜬다(2026-08-26 미리보기에서 확인).
  //    상관없는 번호를 내미는 건 도움이 아니라 소음이므로, 키워드와 맞물리는 것만 남긴다.
  const 번호들: { label: string; tel: string }[] = [];
  const 담기 = (이름: string, 전화: { tel: string; 표시: string } | null) => {
    if (전화 && !번호들.some((x) => x.tel === 전화.tel)) {
      번호들.push({ label: `📞 ${전화.표시} ${trunc(이름, 16)}`, tel: 전화.tel });
    }
  };
  for (const p of shown) 담기(p.명칭, 전화추출(p.연락));
  if (keyword) {
    const kw = keyword.trim();
    for (const h of hotlines) {
      const 맞물림 = h.용도.includes(kw) || h.기관.includes(kw) || kw.includes(h.기관);
      if (맞물림) 담기(h.기관, 전화추출(h.번호));
    }
  }
  담기("무료 법률상담", { tel: "132", 표시: "132" });

  const 버튼: Button[] = 번호들.slice(0, 3).map((b, i) => ({
    type: "Button",
    label: b.label,
    onClickAction: openUrl(`tel:${b.tel}`),
    style: i === 0 ? "primary" : "secondary",
    block: true,
  }));

  const children: WidgetComponent[] = [
    { type: "Caption", value: keyword ? `무료 법률지원 · ${trunc(keyword, 24)}` : "무료 법률지원" },
    { type: "Title", value: shown.length ? trunc(shown[0].명칭, 40) : "무료 법률상담" },
    ...(shown.length ? [{ type: "Text", value: trunc(shown[0].내용, 90), size: "sm" } as TextC] : []),
    ...(programs.length > 1
      ? ([{ type: "Divider" }, { type: "Caption", value: `함께 볼 곳 ${programs.length - 1}개` }, ...프로그램줄.slice(2)] as WidgetComponent[])
      : []),
    { type: "Divider" },
    { type: "Text", value: "📞 지금 걸 수 있는 곳" },
    ...버튼,
    { type: "Caption", value: "자격은 기관에서 최종 확인 · 법률 절차 길잡이" },
  ];
  return {
    widget: { type: "Card", size: "md", children },
    copy_text: [
      keyword ? `**무료 법률지원 — ${keyword}**` : "**무료 법률지원**",
      ...shown.map((p) => `- ${p.명칭} (${p.연락})`),
      "- 무료상담: 대한법률구조공단 132",
    ].join("\n"),
  };
}

// ── 5) 절차 카드 — get_procedure용: 기한을 맨 위에, 단계는 번호를 붙여 ──
export function buildProcedureWidget(
  topic: { 제목: string; 기한: string; 관할기관: string; 단계: string[]; 온라인접수: string; 근거법?: string[] },
): KakaoWidget {
  const url = extractSubmitUrl(topic.온라인접수);
  // 원본 단계는 "1) …"로 시작하는 것과 아닌 것이 섞여 있다. 한 곳에서 떼어내
  // 카드와 copy_text가 같은 문자열을 쓰게 한다(따로 처리하면 "1. 1) …"가 된다).
  const 벗긴단계 = topic.단계.map((s) => s.replace(/^\d+[)\-.]?\s*/, ""));
  const 단계: TextC[] = 벗긴단계.slice(0, 5).map((s, i) => ({
    type: "Text",
    value: trunc(`${i + 1}. ${s}`, 74),
    size: "sm",
  }));
  const children: WidgetComponent[] = [
    { type: "Caption", value: "절차 안내" },
    { type: "Title", value: trunc(topic.제목, 40) },
    {
      type: "Row",
      gap: 8,
      children: [
        { type: "Badge", label: `⏰ ${trunc(topic.기한, 26)}`, color: "danger", variant: "soft" },
        { type: "Badge", label: trunc(topic.관할기관, 20), color: "secondary", variant: "soft" },
      ],
    },
    { type: "Divider" },
    ...단계,
    ...(topic.단계.length > 5 ? [{ type: "Caption", value: `외 ${topic.단계.length - 5}단계` } as Caption] : []),
    ...(url
      ? [{ type: "Button", label: "🏛️ 접수처 바로가기", onClickAction: openUrl(url), style: "primary", block: true } as Button]
      : []),
    { type: "Button", label: "📞 132 무료 법률상담", onClickAction: openUrl("tel:132"), style: "secondary", block: true },
    { type: "Caption", value: "경로 안내 · 결론 아님 · 법률 절차 길잡이" },
  ];
  return {
    widget: { type: "Card", size: "md", children },
    copy_text: `**${topic.제목}**\n⏰ ${topic.기한}\n${벗긴단계.slice(0, 3).map((s, i) => `${i + 1}. ${s}`).join("\n")}\n무료상담 132 — 법률 절차 길잡이`,
  };
}

// ── 6) 체크리스트 카드 — get_checklist용: 빠뜨린 것이 눈에 보이게 ──
export function buildChecklistWidget(
  제목: string,
  c: { 증거: string[]; 준비서류: string[] },
): KakaoWidget {
  const 줄 = (items: string[], n: number): TextC[] =>
    items.slice(0, n).map((s) => ({ type: "Text", value: trunc(`☐ ${s}`, 72), size: "sm" }));
  const children: WidgetComponent[] = [
    { type: "Caption", value: "준비 체크리스트" },
    { type: "Title", value: trunc(제목, 40) },
    { type: "Divider" },
    { type: "Text", value: `🔍 모아둘 증거 ${c.증거.length}가지` },
    ...줄(c.증거, 4),
    ...(c.증거.length > 4 ? [{ type: "Caption", value: `외 ${c.증거.length - 4}가지` } as Caption] : []),
    { type: "Divider" },
    { type: "Text", value: `📎 접수용 서류 ${c.준비서류.length}가지` },
    ...줄(c.준비서류, 4),
    ...(c.준비서류.length > 4 ? [{ type: "Caption", value: `외 ${c.준비서류.length - 4}가지` } as Caption] : []),
    { type: "Caption", value: "빠진 게 있으면 접수가 되돌아옵니다 · 법률 절차 길잡이" },
  ];
  return {
    widget: { type: "Card", size: "md", children },
    copy_text: `**${제목} — 준비 체크리스트**\n증거: ${c.증거.slice(0, 3).join(" · ")}\n서류: ${c.준비서류.slice(0, 3).join(" · ")}\n— 법률 절차 길잡이`,
  };
}

// ── 7) 기한 카드 — calculate_deadline용: 남은 날을 제일 크게 ──
// 기한은 놓치면 권리가 사라진다. 계산식보다 'D-5'가 먼저 보여야 한다.
export function buildDeadlineWidget(
  종류: string,
  r: { 마감일: string; 남은일수: number },
  meta: { 기준일: string; 기간표시: string; 기산: string; 경고: string },
): KakaoWidget {
  const 지남 = r.남은일수 < 0;
  const 오늘 = r.남은일수 === 0;
  const 큰글씨 = 지남 ? `기한 지남 (${-r.남은일수}일)` : 오늘 ? "오늘이 마감일" : `D-${r.남은일수}`;
  const 색: Badge["color"] = 지남 ? "danger" : r.남은일수 <= 7 ? "danger" : r.남은일수 <= 30 ? "warning" : "success";
  const children: WidgetComponent[] = [
    // 기한 종류는 내부 키(상속포기_한정승인)라 밑줄이 그대로 보인다. 읽는 모양으로 바꿔 준다.
    { type: "Caption", value: `⏰ ${trunc(종류.replace(/_/g, " · "), 30)}` },
    { type: "Title", value: 큰글씨, size: "lg" },
    {
      type: "Row",
      gap: 8,
      children: [
        { type: "Badge", label: `마감 ${r.마감일}`, color: 색, variant: "solid" },
        { type: "Badge", label: `${meta.기준일} + ${meta.기간표시}`, color: "secondary", variant: "soft" },
      ],
    },
    { type: "Divider" },
    { type: "Text", value: trunc(`기산점: ${meta.기산}`, 96), size: "sm" },
    { type: "Text", value: trunc(`⚠️ ${meta.경고}`, 110), size: "sm", italic: true },
    ...(지남 || r.남은일수 <= 30
      ? [{ type: "Button", label: "📞 132 무료 법률상담", onClickAction: openUrl("tel:132"), style: "primary", block: true } as Button]
      : []),
    { type: "Caption", value: "중단·정지 사유로 달라질 수 있음 · 법률 절차 길잡이" },
  ];
  return {
    widget: { type: "Card", size: "sm", children },
    copy_text: `**${종류.replace(/_/g, " · ")}** — ${큰글씨}\n마감일 ${r.마감일} (${meta.기준일} + ${meta.기간표시})\n기산점: ${meta.기산}\n무료상담 132 — 법률 절차 길잡이`,
  };
}

// ── 로컬 시각 미리보기 렌더러 — 카카오 프리뷰 권한이 없는 동안 팀·데모용 근사 렌더 ──
const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const BADGE_BG: Record<string, string> = {
  secondary: "#eef0f4;color:#4a5164", success: "#e6f5ef;color:#1f8a5f", danger: "#fdeceb;color:#c6423a",
  warning: "#fdf3e2;color:#b07305", info: "#e9f1fd;color:#2b62c9", discovery: "#f2ecfd;color:#7b4dd6",
};

function nodeHtml(c: WidgetComponent): string {
  switch (c.type) {
    case "Title": return `<div class="w-title${c.size === "lg" ? " lg" : ""}">${esc(c.value)}</div>`;
    case "Caption": return `<div class="w-cap">${esc(c.value)}</div>`;
    case "Text": return `<div class="w-text${c.size === "sm" ? " sm" : ""}${c.italic ? " it" : ""}">${esc(c.value)}</div>`;
    case "Markdown": return `<div class="w-text">${esc(c.value)}</div>`;
    case "Badge": return `<span class="w-badge" style="background:${BADGE_BG[c.color ?? "secondary"] ?? BADGE_BG.secondary}">${esc(c.label)}</span>`;
    case "Button": {
      const target = (c.onClickAction.payload as { target?: { url?: string } } | undefined)?.target;
      const url = String(target?.url ?? "#");
      return `<a class="w-btn ${c.style === "primary" ? "pri" : "sec"}" href="${esc(url)}">${esc(c.label)}</a>`;
    }
    case "Divider": return `<hr class="w-div">`;
    case "Row": return `<div class="w-row">${c.children.map(nodeHtml).join("")}</div>`;
    case "Col": return `<div class="w-col">${c.children.map(nodeHtml).join("")}</div>`;
  }
}

export function renderWidgetHtml(kw: KakaoWidget, heading: string): string {
  const card = kw.widget;
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>위젯 미리보기 · ${esc(heading)}</title>
<style>
body{margin:0;background:#aebdcb;font-family:"Apple SD Gothic Neo",Pretendard,sans-serif;display:flex;flex-direction:column;align-items:center;gap:14px;padding:28px 14px;}
.note{font-size:12px;color:#3d4a57;background:#ffffffaa;border-radius:8px;padding:6px 12px;max-width:360px;text-align:center}
.chat{width:min(94vw,380px)}
.bubble-q{background:#ffe94a;border-radius:14px 14px 3px 14px;padding:9px 13px;font-size:13.5px;margin:0 0 10px auto;width:fit-content;max-width:80%;}
.w-card{background:#fff;border-radius:16px;box-shadow:0 2px 10px rgba(0,0,0,.12);padding:16px;display:flex;flex-direction:column;gap:9px;}
.w-title{font-size:16.5px;font-weight:800;color:#1c2230;line-height:1.3}
.w-title.lg{font-size:21px}
.w-cap{font-size:11.5px;color:#8a93a3}
.w-text{font-size:13.5px;color:#333c4b;line-height:1.45}
.w-text.sm{font-size:12.5px;color:#4a5464}
.w-text.it{font-style:italic}
.w-badge{font-size:11px;font-weight:700;padding:3px 9px;border-radius:100px;display:inline-block}
.w-btn{display:block;text-align:center;font-size:14px;font-weight:700;padding:11px 12px;border-radius:10px;text-decoration:none}
.w-btn.pri{background:#1c2230;color:#fff}
.w-btn.sec{background:#f1f3f6;color:#1c2230}
.w-div{border:none;border-top:1px solid #eceff3;margin:2px 0}
.w-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.w-col{display:flex;flex-direction:column;gap:8px}
.copy{width:min(94vw,380px);font-size:11.5px;color:#3d4a57;background:#ffffffaa;border-radius:8px;padding:8px 12px;white-space:pre-wrap}
.copy b{display:block;margin-bottom:3px}
</style></head><body>
<p class="note">⚠️ 로컬 근사 미리보기입니다 — 실제 렌더는 카카오 툴즈 프리뷰에서 확인 (ChatKit 스펙 기반 프로토타입)</p>
<div class="chat">
  <div class="bubble-q">${esc(heading)}</div>
  <div class="w-card">${card.children.map(nodeHtml).join("")}</div>
</div>
${kw.copy_text ? `<div class="copy"><b>📤 카톡 공유 시 copy_text:</b>${esc(kw.copy_text)}</div>` : ""}
</body></html>`;
}
