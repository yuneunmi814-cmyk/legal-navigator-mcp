// 데이터 정합성 불변식. index.ts import 자체가 mergeStrict(키 충돌 시 throw)를 실행 → 충돌 시 이 파일이 실패.
import { describe, it, expect } from "vitest";
import { hwpxFiles, hwpxClientScript, type HwpxRun } from "../src/hwpx.js";
import {
  SEARCH_SYNONYMS,
  CHECKLISTS,
  PROCEDURES,
  FORMS,
  FORM_KEYS,
  TOPIC_KEYS,
  PRECEDENTS,
  STATUTES,
  GLOSSARY,
  CATEGORIES,
  TOPICS,
} from "../src/data/index.js";

describe("데이터 정합성", () => {
  it("모든 주제에 체크리스트가 있다", () => {
    expect(TOPIC_KEYS.filter((k) => !CHECKLISTS[k])).toEqual([]);
  });

  it("모든 주제의 카테고리가 유효하다", () => {
    const cats = new Set<string>(CATEGORIES);
    expect(TOPICS.filter((t) => !cats.has(t.category)).map((t) => t.key)).toEqual([]);
  });

  it("고아 판례 키(주제가 아닌 키)가 없다", () => {
    const orphan = Object.keys(PRECEDENTS).filter((k) => PRECEDENTS[k].length > 0 && !TOPIC_KEYS.includes(k));
    expect(orphan).toEqual([]);
  });

  it("같은 주제 키 안에 사건번호 중복이 없다(concat 병합 무결성)", () => {
    const dups: string[] = [];
    for (const [k, arr] of Object.entries(PRECEDENTS)) {
      const seen = new Set<string>();
      for (const p of arr) {
        if (seen.has(p.사건번호)) dups.push(`${k}:${p.사건번호}`);
        seen.add(p.사건번호);
      }
    }
    expect(dups).toEqual([]);
  });

  it("용어사전에 중복 용어가 없다", () => {
    const seen = new Set<string>();
    const dup: string[] = [];
    for (const g of GLOSSARY) {
      if (seen.has(g.용어)) dup.push(g.용어);
      seen.add(g.용어);
    }
    expect(dup).toEqual([]);
  });

  it("할루시네이션 검증에서 제거된 사건번호가 다시 들어오지 않는다", () => {
    const all = Object.values(PRECEDENTS).flat().map((p) => p.사건번호);
    for (const bad of ["99다41618", "2013므2243", "2024다33556", "분쟁조정 결정사례(공개 사례)"]) {
      expect(all).not.toContain(bad);
    }
  });

  it("모든 판례 사건번호가 형식상 유효(법원 부호 포함)", () => {
    const all = Object.values(PRECEDENTS).flat();
    // 한국 사건번호: 연도(2~4자리) + 부호(가~힣) + 번호. 헌재는 'YYYY헌X' 형태.
    const valid = /(\d{2,4}\s?[가-힣]{1,3}\s?\d|헌[가-힣])/;
    const bad = all.filter((p) => !valid.test(p.사건번호));
    expect(bad.map((p) => p.사건번호)).toEqual([]);
  });

  it("모든 법령 조문이 '제N조' 형식이다(라벨 표기 금지)", () => {
    const bad = STATUTES.filter((s) => !/^제\d+조/.test(s.조문));
    expect(bad.map((s) => `${s.법령} ${s.조문}`)).toEqual([]);
  });

  it("FORM_TOPIC 매핑 정합성 — 서식 접수처는 검증된 주제 데이터만 참조", async () => {
    const { FORM_TOPIC } = await import("../src/data/form_topic.js");
    for (const [form, topic] of Object.entries(FORM_TOPIC)) {
      expect(FORM_KEYS).toContain(form);
      expect(TOPIC_KEYS).toContain(topic);
    }
    // 개인 간 계약서 등 제출처 없는 서식 3종만 의도적 제외
    const unmapped = FORM_KEYS.filter((k) => !FORM_TOPIC[k]);
    expect(unmapped.sort()).toEqual(["금전소비대차계약서", "분쟁조정_신청서", "채무변제확인서"]);
  });

  it("생활밀착 커버리지 확대 8/9 — 택배·항공·환불·누수·중고차·사망후·화재", () => {
    for (const k of ["택배분실파손", "항공지연결항피해", "헬스장학원환불", "중고차매매피해", "세대간누수분쟁", "사망후행정처리", "화재피해대응"]) {
      expect(TOPIC_KEYS).toContain(k);
      expect(CHECKLISTS[k]).toBeTruthy();
    }
    expect(CATEGORIES).toContain("화재·소방");
  });

  it("생활밀착 커버리지 확대 2차 — 사실혼·유실물·동물학대·계정해킹·이사·상조", () => {
    for (const k of ["사실혼해소", "유실물분실습득", "동물학대신고", "계정해킹도용대응", "포장이사파손분쟁", "상조서비스분쟁"]) {
      expect(TOPIC_KEYS).toContain(k);
      expect(CHECKLISTS[k]).toBeTruthy();
    }
  });

  it("신규 취약·위기 주제·서식·분야가 등록되어 있다(신청 절차+신청서 한 동선)", () => {
    for (const k of ["소상공인_폐업재기", "노란우산공제_폐업", "출소자_갱생보호", "위기임신_보호출산"]) {
      expect(TOPIC_KEYS).toContain(k);
      expect(CHECKLISTS[k]).toBeTruthy();
    }
    for (const f of ["노란우산_공제금청구서", "갱생보호_신청서", "행정심판_청구서", "정보공개_청구서", "의료분쟁_조정신청서"]) {
      expect(FORM_KEYS).toContain(f);
    }
    for (const c of ["소상공인", "출소자·갱생보호", "위기임신·보호출산"] as const) {
      expect(CATEGORIES).toContain(c);
    }
  });

  it("사회보장 급여 신청 주제·서식·분야가 등록되어 있다(혼자 신청하기)", () => {
    for (const k of ["장애인_등록활동지원", "국민연금_유족장애연금", "근로자녀장려금", "재난적의료비_본인부담상한"]) {
      expect(TOPIC_KEYS).toContain(k);
      expect(CHECKLISTS[k]).toBeTruthy();
    }
    for (const f of ["장애인등록_신청서", "국민연금_급여청구서", "근로자녀장려금_신청서", "재난적의료비_지원신청서"]) {
      expect(FORM_KEYS).toContain(f);
    }
    expect(CATEGORIES).toContain("공적연금·사회보험");
  });

  it("생활밀착 급여·민원 주제·서식·분야가 등록되어 있다", () => {
    for (const k of ["국민취업지원제도", "노인장기요양_등급신청", "개명_성본변경", "주거급여_공공임대", "아동수당_부모급여"]) {
      expect(TOPIC_KEYS).toContain(k);
      expect(CHECKLISTS[k]).toBeTruthy();
    }
    for (const f of ["육아휴직_급여신청서", "구직급여_수급자격신청서", "장기요양인정_신청서", "개명허가_신청서"]) {
      expect(FORM_KEYS).toContain(f);
    }
    for (const c of ["육아·보육", "주거복지"] as const) {
      expect(CATEGORIES).toContain(c);
    }
  });

  it("권리구제·기록정리 주제·서식이 등록되어 있다", () => {
    for (const k of ["운전면허_행정처분구제", "형실효_범죄경력", "국가배상신청", "안심상속_재산조회"]) {
      expect(TOPIC_KEYS).toContain(k);
      expect(CHECKLISTS[k]).toBeTruthy();
    }
    for (const f of ["운전면허_이의신청서", "범죄경력회보서_발급신청서", "국가배상_신청서", "개인회생_개시신청서", "안심상속_재산조회신청서"]) {
      expect(FORM_KEYS).toContain(f);
    }
  });

  it("의료·돌봄·주거·금융 급여 주제·서식이 등록되어 있다", () => {
    for (const k of ["중증질환_산정특례", "장애인연금_장애수당", "청년월세_주거지원", "난임부부_시술비지원", "숨은돈_찾기"]) {
      expect(TOPIC_KEYS).toContain(k);
      expect(CHECKLISTS[k]).toBeTruthy();
    }
    for (const f of ["산정특례_등록신청서", "청년월세_지원신청서", "난임시술비_지원신청서"]) {
      expect(FORM_KEYS).toContain(f);
    }
  });

  it("노동·교육·복지·육아 급여 주제·서식·분야가 등록되어 있다", () => {
    for (const k of ["직장내성희롱", "국가장학금_학자금대출", "에너지바우처_요금감면", "출산전후_바우처의료비"]) {
      expect(TOPIC_KEYS).toContain(k);
      expect(CHECKLISTS[k]).toBeTruthy();
    }
    for (const f of ["성희롱_신고진정서", "국가장학금_신청서", "에너지바우처_신청서"]) {
      expect(FORM_KEYS).toContain(f);
    }
    expect(CATEGORIES).toContain("교육·학자금");
  });

  it("고용·금융·청소년·육아 주제·서식이 등록되어 있다", () => {
    for (const k of ["국민내일배움카드", "청년자산형성", "소년보호사건", "돌봄_산후조리바우처"]) {
      expect(TOPIC_KEYS).toContain(k);
      expect(CHECKLISTS[k]).toBeTruthy();
    }
    for (const f of ["내일배움카드_발급신청서", "소년보호_보조인선임서"]) {
      expect(FORM_KEYS).toContain(f);
    }
  });

  it("규모 스냅샷(회귀 감지)", () => {
    expect(TOPIC_KEYS.length).toBe(259);
    expect(CATEGORIES.length).toBe(57);
    expect(FORM_KEYS.length).toBe(114);
    expect(GLOSSARY.length).toBe(125);
    expect(Object.values(PRECEDENTS).flat().length).toBe(194);
  });

  it("나홀로 송무·법무 패키지(피고 대응·셀프 법무) 등록", () => {
    for (const t of ["소장받았을때", "지급명령받았을때", "변제공탁", "근저당말소등기", "임차인경매대응", "나의사건검색", "약식명령받았을때", "상속등기", "국선변호인신청"]) {
      expect(TOPIC_KEYS).toContain(t);
    }
    for (const f of ["민사_답변서", "지급명령_이의신청서", "변제공탁서", "경매_권리신고및배당요구신청서", "정식재판청구서", "국선변호인선정청구서"]) {
      expect(FORM_KEYS).toContain(f);
    }
  });

  it("셀프등기 네비게이터(근저당 말소·상속등기) 등록", () => {
    expect(FORM_KEYS).toContain("근저당권말소등기신청서");
    expect(FORM_KEYS).toContain("상속등기신청서");
    const 말소 = PROCEDURES["근저당말소등기"];
    expect(말소.단계.join(" ")).toContain("셀프등기절감액");
    expect(말소.단계.join(" ")).toContain("근저당권말소등기신청서");
    const 상속 = PROCEDURES["상속등기"];
    expect(상속.단계.join(" ")).toContain("상속등기비용");
    expect(상속.단계.join(" ")).toContain("상속등기신청서");
    expect(TOPIC_KEYS).toContain("전세권임차권말소");
    expect(FORM_KEYS).toContain("전세권말소등기신청서");
    const 말소2 = PROCEDURES["전세권임차권말소"];
    expect(말소2.단계.join(" ")).toContain("셀프등기절감액");
    expect(말소2.단계.join(" ")).toContain("전세권말소등기신청서");
    expect(말소2.단계.join(" ")).toContain("취소");
  });

  it("차용증·채무확인서 서식(가족·지인 간 대여) 등록", () => {
    for (const f of ["금전소비대차계약서", "채무변제확인서"]) {
      expect(FORM_KEYS).toContain(f);
    }
  });
});

// 접수처 바로가기 버튼(8/11 회의 결정)의 URL 품질 — 링크가 죽으면 '편의성' 심사축에 직격.
describe("접수처 버튼 URL", () => {
  it("자유 텍스트에서 한글·괄호·가운뎃점을 주소에 붙이지 않는다", async () => {
    const { extractSubmitUrl } = await import("../src/widgets.js");
    // 실제 데이터에서 이전 정규식이 통째로 삼켰던 형태들
    expect(extractSubmitUrl("복지로 bokjiro.go.kr(서비스신청→복지급여→청년월세, 읍·면·동)")).toBe(
      "https://bokjiro.go.kr",
    );
    expect(extractSubmitUrl("동물보호관리시스템 animal.go.kr·qia.go.kr")).toBe("https://animal.go.kr");
    expect(extractSubmitUrl("금융감독원 fine.fss.or.kr·☎1332")).toBe("https://fine.fss.or.kr");
    expect(extractSubmitUrl("대법원 전자소송 ecfs.scourt.go.kr → '지급명령(독촉)신청'")).toBe(
      "https://ecfs.scourt.go.kr",
    );
    // 스킴이 있는 주소·경로도 그대로 살린다
    expect(extractSubmitUrl("신청 https://www.kca.go.kr/odr/pg/ma/pgProcssInfo2.do 에서")).toBe(
      "https://www.kca.go.kr/odr/pg/ma/pgProcssInfo2.do",
    );
    // 접수 창구가 전화뿐이면 버튼을 만들지 않는다
    expect(extractSubmitUrl("검찰 피해자지원 1301 / 경찰 182")).toBeNull();
  });

  it("모든 주제의 접수처 URL이 ASCII 주소로만 추출된다", async () => {
    const { extractSubmitUrl } = await import("../src/widgets.js");
    const bad: string[] = [];
    for (const k of TOPIC_KEYS) {
      const url = extractSubmitUrl(PROCEDURES[k].온라인접수);
      if (url && !/^https?:\/\/[A-Za-z0-9\-._~%/?#=&+@:]+$/.test(url)) bad.push(`${k} → ${url}`);
    }
    expect(bad).toEqual([]);
  });

  it("apex에 DNS가 없어 www가 필요한 기관 도메인은 www로 적는다", () => {
    // 2026-08-12 전수 확인: 아래 도메인은 apex가 NXDOMAIN이라 버튼이 열리지 않았다.
    const wwwOnly = ["courtauction.go.kr", "iros.go.kr", "k-apt.go.kr", "nhis.or.kr", "noiseinfo.or.kr", "tdrc.kr", "fbo.or.kr", "myhome.go.kr"];
    const bad: string[] = [];
    for (const k of TOPIC_KEYS) {
      const t = PROCEDURES[k].온라인접수;
      for (const d of wwwOnly) {
        if (new RegExp(`(?<![A-Za-z0-9.\\-/])${d.replace(/\./g, "\\.")}`).test(t)) bad.push(`${k}: ${d}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("채워야 할 칸이 줄머리 대괄호라 라벨로 굳어버리지 않는다", () => {
    // 렌더러(본문HTML)는 줄 시작의 [대괄호]를 섹션 라벨로 바꾼다. 그래서 [작성일자]처럼
    // 사용자가 채워야 하는 항목이 줄머리에 오면 회색 글씨가 되고 입력이 안 된다.
    // 2026-08-18 회의에서 "작성일자·계좌번호가 입력이 안 된다"로 보고된 실제 사고 —
    // 서식 48종이 날짜를 쓸 수 없는 상태였다. 항목명을 앞에 붙여 줄머리를 벗어나게 고쳤다.
    const 채우는칸 = /^(작성일자|작성일|일자|날짜|계좌|은행|예금|서명|날인|예\)|등기부등본)/;
    const bad: string[] = [];
    for (const k of FORM_KEYS) {
      for (const line of String(FORMS[k].본문 ?? "").split("\n")) {
        const m = /^[ \t]*\[([^\]]+)\]/.exec(line);
        if (!m || /^[_\s]*$/.test(m[1])) continue;
        if (채우는칸.test(m[1])) bad.push(`${k}: ${line.trim().slice(0, 50)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("빌려준 돈과 물품·용역 대금이 섞이지 않는다 (소멸시효 10년 vs 3년)", () => {
    // 2026-08-19 아린 님(PlayMCP)이 "법률은 해석 여지가 다양하다"며 든 예시
    // ("돈거래 했는데" / "하기로 했는데")를 실제로 던져보니, '돈거래'라는 말이
    // 동의어 표에 없어 '물건값 미수금'으로 잘못 떨어지고 있었다.
    // 반대로 '물건값·공사대금'은 아예 매칭에 실패했다.
    // 둘은 소멸시효가 10년 / 3년으로 달라 잘못 가면 안내가 통째로 틀린다.
    const find = (w: string) =>
      SEARCH_SYNONYMS.filter((e) => e.q.some((x) => w.includes(x))).flatMap((e) => e.topics);
    for (const w of ["돈거래", "금전거래", "빌려준 돈", "떼인 돈"])
      expect(find(w), `${w} → 대여금`).toContain("대여금미반환");
    for (const w of ["물건값", "공사대금", "납품대금", "용역대금", "미수금"])
      expect(find(w), `${w} → 미수금`).toContain("물품용역대금미수금");
    // 서로 넘어가지 않아야 한다
    expect(find("돈거래")).not.toContain("물품용역대금미수금");
    expect(find("공사대금")).not.toContain("대여금미반환");
  });

  it("법률 정식명칭과 줄임말로도 주제를 찾는다", () => {
    // 2026-08-19 실사용 발화 628건 감사 — 근거법이 약칭("스토킹처벌법")으로 적혀 있어
    // 정식 명칭을 그대로 친 질문이 엉뚱한 주제로 갔다. 사람들은 법률명으로도 검색한다.
    const find = (w: string) =>
      SEARCH_SYNONYMS.filter((e) => e.q.some((x) => w.includes(x))).flatMap((e) => e.topics);
    expect(find("스토킹범죄의 처벌 등에 관한 법률")).toContain("스토킹신고응급조치");
    expect(find("스토킹방지 및 피해자보호 등에 관한 법률")).toContain("스토킹신고응급조치");
    expect(find("통매음")).toContain("촬영물협박강요");
  });
});

// ── HWPX(한글) 내보내기 ─────────────────────────────────────────────
// 실물 .hwpx(정부 공고문)를 뜯어 맞춘 구조다. 한 글자만 어긋나도 한글이 "열 수 없는 파일"이라 한다.
// 여기서 막지 못하면 사용자 폰에서야 알게 된다.
describe("HWPX 내보내기", () => {
  const paras: HwpxRun[][] = [
    [{ t: "임 금 체 불 진 정 서", b: true }],
    [],
    [{ t: "진정인 성명: " }, { t: "윤은미", u: true }],
    [{ t: "☑ 임금 미지급  ☐ 퇴직금 미지급" }],
  ];

  it("ZIP 첫 항목은 mimetype이어야 한다 (HWPX 규칙)", () => {
    const files = hwpxFiles("임금체불 진정서", paras);
    expect(files[0].name).toBe("mimetype");
    expect(files[0].data).toBe("application/hwp+zip");
  });

  it("한글이 요구하는 파트가 모두 들어 있다", () => {
    const names = hwpxFiles("t", paras).map((f) => f.name);
    for (const need of [
      "version.xml",
      "settings.xml",
      "Contents/header.xml",
      "Contents/section0.xml",
      "Contents/content.hpf",
      "META-INF/container.xml",
      "META-INF/manifest.xml",
      "META-INF/container.rdf",
      "Preview/PrvText.txt",
    ]) {
      expect(names).toContain(need);
    }
  });

  it("모든 XML 파트의 태그가 짝이 맞는다", () => {
    for (const f of hwpxFiles("따옴표 & <꺾쇠> 제목", paras)) {
      if (f.name === "mimetype" || f.name.endsWith(".txt")) continue;
      const stack: string[] = [];
      for (const m of f.data.matchAll(/<(\/?)([A-Za-z0-9:_.-]+)([^>]*?)(\/?)>/g)) {
        const [, close, name, , self] = m;
        if (f.data.slice(m.index!, m.index! + 2) === "<?") continue;
        if (close) expect(stack.pop(), `${f.name}: </${name}> 짝 안 맞음`).toBe(name);
        else if (!self) stack.push(name);
      }
      expect(stack, `${f.name}: 안 닫힌 태그 ${stack.join(",")}`).toHaveLength(0);
    }
  });

  it("본문의 모든 ID 참조가 header에 정의돼 있다", () => {
    const files = hwpxFiles("t", paras);
    const pick = (n: string) => files.find((f) => f.name === n)!.data;
    const header = pick("Contents/header.xml");
    const section = pick("Contents/section0.xml");
    const defined = (tag: string, src: string) =>
      new Set([...src.matchAll(new RegExp(`<${tag} id="(\\d+)"`, "g"))].map((m) => m[1]));
    const used = (attr: string, src: string) =>
      new Set([...src.matchAll(new RegExp(`${attr}="(\\d+)"`, "g"))].map((m) => m[1]).filter((v) => v !== "4294967295"));

    for (const [attr, tag, src] of [
      ["charPrIDRef", "hh:charPr", section],
      ["paraPrIDRef", "hh:paraPr", section],
      ["styleIDRef", "hh:style", section],
      ["outlineShapeIDRef", "hh:numbering", section],
      ["borderFillIDRef", "hh:borderFill", header + section],
      ["tabPrIDRef", "hh:tabPr", header],
    ] as const) {
      const have = defined(tag, header);
      for (const id of used(attr, src)) {
        expect(have.has(id), `${attr}="${id}" 인데 ${tag} id=${id} 이 header에 없다`).toBe(true);
      }
    }
  });

  it("refList 자식 순서가 스키마 순서와 같다", () => {
    const header = hwpxFiles("t", paras).find((f) => f.name === "Contents/header.xml")!.data;
    const order = ["hh:fontfaces", "hh:borderFills", "hh:charProperties", "hh:tabProperties", "hh:numberings", "hh:paraProperties", "hh:styles"];
    const at = order.map((t) => header.indexOf("<" + t));
    expect(at.every((v) => v > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("본문 글자가 XML 이스케이프된다", () => {
    const sec = hwpxFiles("t", [[{ t: "채권자 & 채무자 <갑>" }]]).find((f) => f.name === "Contents/section0.xml")!.data;
    expect(sec).toContain("채권자 &amp; 채무자 &lt;갑&gt;");
    expect(sec).not.toContain("<갑>");
  });

  it("빈 문단도 문단으로 남는다 (서식의 줄 간격이 무너지지 않게)", () => {
    const sec = hwpxFiles("t", paras).find((f) => f.name === "Contents/section0.xml")!.data;
    expect([...sec.matchAll(/<hp:p /g)]).toHaveLength(paras.length);
  });

  // 8/16·8/19에 템플릿 리터럴 안에 직접 적은 "\\n"이 실제 줄바꿈으로 치환되면서 서식 페이지
  // 스크립트가 통째로 죽은 적이 두 번 있다. 이 스크립트는 런타임에 끼워 넣는 값이라 그 함정은
  // 없지만, 결과물이 실제로 돌아가는지는 여기서 확인한다(페이지 전체는 server.test.ts가 본다).
  it("클라이언트 스크립트가 문법적으로 살아있다", () => {
    expect(() => new Function("xe", hwpxClientScript() + "; return hwpxFiles;")).not.toThrow();
  });

  it("브라우저에서 만든 결과가 서버 쪽 결과와 같다", () => {
    const make = new Function("xe", hwpxClientScript() + "; return hwpxFiles;")(
      (s: string) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
    );
    const browser = make("임금체불 진정서", paras.map((r) => r.map((x) => ({ t: x.t, s: { b: x.b, u: x.u } }))));
    const server = hwpxFiles("임금체불 진정서", paras);
    expect(browser.map((f: { name: string }) => f.name)).toEqual(server.map((f) => f.name));
    for (let i = 0; i < server.length; i++) {
      expect(browser[i].data, `${server[i].name} 불일치`).toBe(server[i].data);
    }
  });
});
