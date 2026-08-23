// HWPX(.hwpx) 생성기 — "한글로 내보내기".
//
// 왜 .hwp가 아니라 .hwpx인가
//   .hwp는 한컴오피스의 비공개 바이너리(OLE 복합문서)라 브라우저에서 만들 수 없다.
//   .hwpx는 같은 한글 문서를 담는 **국가표준(KS X 6101, OWPML)** 이고 구조가 ZIP + XML이라
//   .docx를 만들던 방식 그대로 만들 수 있다. 한글 2014 이상에서 그냥 열린다.
//
// 구조의 출처
//   추측이 아니라 **실물 .hwpx를 뜯어서** 맞췄다(제천시 공고 원본, 한컴오피스 11 저장본).
//   태그 순서·속성 집합·네임스페이스를 그대로 따랐고, container.xml·manifest.xml·container.rdf는
//   바이트 단위로 동일하다. 검증은 독립 파서(PyPI python-hwpx)로 정부 원본과 우리 산출물을
//   같은 코드에 통과시켜 확인했다.
//
// 주의
//   ZIP의 첫 항목은 반드시 `mimetype`이고 무압축이어야 한다(ODF와 같은 규칙).
//   refList 안의 순서도 스키마가 정한 순서다: fontfaces → borderFills → charProperties
//   → tabProperties → numberings → paraProperties → styles.

import { layoutParas, type ParaStyle } from "./formlayout.js";

const XD = '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>';

const NS =
  'xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" ' +
  'xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" ' +
  'xmlns:hp10="http://www.hancom.co.kr/hwpml/2016/paragraph" ' +
  'xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" ' +
  'xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" ' +
  'xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" ' +
  'xmlns:hhs="http://www.hancom.co.kr/hwpml/2011/history" ' +
  'xmlns:hm="http://www.hancom.co.kr/hwpml/2011/master-page" ' +
  'xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf" ' +
  'xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
  'xmlns:opf="http://www.idpf.org/2007/opf/" ' +
  'xmlns:ooxmlchart="http://www.hancom.co.kr/hwpml/2016/ooxmlchart" ' +
  'xmlns:hwpunitchar="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar" ' +
  'xmlns:epub="http://www.idpf.org/2007/ops" ' +
  'xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"';

const LANGS = ["HANGUL", "LATIN", "HANJA", "JAPANESE", "OTHER", "SYMBOL", "USER"];

// 글꼴 하나(바탕)를 7개 언어 슬롯에 모두 물린다. 서식은 한글·숫자·기호뿐이라 이걸로 충분하다.
const FONTFACES =
  '<hh:fontfaces itemCnt="7">' +
  LANGS.map(
    (l) =>
      `<hh:fontface lang="${l}" fontCnt="1"><hh:font id="0" face="바탕" type="TTF" isEmbedded="0">` +
      '<hh:typeInfo familyType="FCAT_MYUNGJO" weight="6" proportion="0" contrast="0" strokeVariation="0"' +
      ' armStyle="0" letterform="0" midline="0" xHeight="0"/></hh:font></hh:fontface>',
  ).join("") +
  "</hh:fontfaces>";

const borderFill = (id: number) =>
  `<hh:borderFill id="${id}" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0">` +
  '<hh:slash type="NONE" Crooked="0" isCounter="0"/><hh:backSlash type="NONE" Crooked="0" isCounter="0"/>' +
  '<hh:leftBorder type="NONE" width="0.1 mm" color="#000000"/><hh:rightBorder type="NONE" width="0.1 mm" color="#000000"/>' +
  '<hh:topBorder type="NONE" width="0.1 mm" color="#000000"/><hh:bottomBorder type="NONE" width="0.1 mm" color="#000000"/>' +
  '<hh:diagonal type="SOLID" width="0.1 mm" color="#000000"/></hh:borderFill>';

// id 0=보통, 1=굵게(라벨), 2=밑줄(채워 넣은 빈칸) — 화면의 .lbl / .fld 와 짝이 맞는다.
// id 3=제목(15pt 굵게), 4='○○법원 귀중'(13pt 굵게) — formlayout.ts 의 size 와 짝이 맞는다.
const charPr = (id: number, bold: boolean, underline: boolean, height = 1000) =>
  `<hh:charPr id="${id}" height="${height}" textColor="#000000" shadeColor="none" useFontSpace="0"` +
  ' useKerning="0" symMark="NONE" borderFillIDRef="2">' +
  '<hh:fontRef hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>' +
  '<hh:ratio hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/>' +
  '<hh:spacing hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>' +
  '<hh:relSz hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/>' +
  '<hh:offset hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>' +
  (bold ? "<hh:bold/>" : "") +
  `<hh:underline type="${underline ? "BOTTOM" : "NONE"}" shape="SOLID" color="#000000"/>` +
  '<hh:strikeout shape="NONE" color="#000000"/><hh:outline type="NONE"/>' +
  '<hh:shadow type="NONE" color="#B2B2B2" offsetX="10" offsetY="10"/></hh:charPr>';

// HWPUNIT = 1/7200인치, 1pt = 100.
const MARGIN = (intent: number, left: number, prev: number, next: number) =>
  `<hh:margin><hc:intent value="${intent}" unit="HWPUNIT"/><hc:left value="${left}" unit="HWPUNIT"/>` +
  `<hc:right value="0" unit="HWPUNIT"/><hc:prev value="${prev}" unit="HWPUNIT"/>` +
  `<hc:next value="${next}" unit="HWPUNIT"/></hh:margin>` +
  '<hh:lineSpacing type="PERCENT" value="160" unit="HWPUNIT"/>';

// formlayout.ts 의 배치와 1:1 —
//  0 본문(왼쪽) · 1 가운데(날짜·서명, 위 12pt) · 2 우측(귀중, 위 60pt)
//  3 내어쓰기(번호 항목) · 4 제목(가운데, 아래 30pt)
const paraPr = (id: number, align: string, intent: number, left: number, prev: number, next: number) =>
  `<hh:paraPr id="${id}" tabPrIDRef="0" condense="0" fontLineHeight="0" snapToGrid="1"` +
  ` suppressLineNumbers="0" checked="0"><hh:align horizontal="${align}" vertical="BASELINE"/>` +
  '<hh:heading type="NONE" idRef="0" level="0"/>' +
  '<hh:breakSetting breakLatinWord="KEEP_WORD" breakNonLatinWord="KEEP_WORD" widowOrphan="0"' +
  ' keepWithNext="0" keepLines="0" pageBreakBefore="0" lineWrap="BREAK"/>' +
  '<hh:autoSpacing eAsianEng="0" eAsianNum="0"/>' +
  '<hp:switch><hp:case hp:required-namespace="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar">' +
  MARGIN(intent, left, prev, next) +
  "</hp:case><hp:default>" +
  MARGIN(intent, left, prev, next) +
  "</hp:default></hp:switch>" +
  '<hh:border borderFillIDRef="2" offsetLeft="0" offsetRight="0" offsetTop="0" offsetBottom="0"' +
  ' connect="0" ignoreMargin="0"/></hh:paraPr>';

const PARAPRS =
  paraPr(0, "LEFT", 0, 0, 0, 0) +
  paraPr(1, "CENTER", 0, 0, 1200, 0) +
  paraPr(2, "RIGHT", 0, 0, 6000, 0) +
  paraPr(3, "LEFT", -1400, 1400, 0, 0) +
  paraPr(4, "CENTER", 0, 0, 0, 3000);

// secPr이 outlineShapeIDRef="1"로 이걸 가리킨다. 없으면 열리지 않는다.
const NUMBERING =
  '<hh:numbering id="1" start="0">' +
  [1, 2, 3, 4, 5, 6, 7]
    .map(
      (lv) =>
        `<hh:paraHead start="1" level="${lv}" align="LEFT" useInstWidth="1" autoIndent="1"` +
        ' widthAdjust="0" textOffsetType="PERCENT" textOffset="50" numFormat="DIGIT"' +
        ` charPrIDRef="4294967295" checkable="0">^${lv}.</hh:paraHead>`,
    )
    .join("") +
  "</hh:numbering>";

export const HWPX_HEADER_XML =
  XD +
  `<hh:head ${NS} version="1.4" secCnt="1">` +
  '<hh:beginNum page="1" footnote="1" endnote="1" pic="1" tbl="1" equation="1"/><hh:refList>' +
  FONTFACES +
  '<hh:borderFills itemCnt="2">' + borderFill(1) + borderFill(2) + "</hh:borderFills>" +
  '<hh:charProperties itemCnt="5">' +
  charPr(0, false, false) + charPr(1, true, false) + charPr(2, false, true) +
  charPr(3, true, false, 1500) + charPr(4, true, false, 1300) +
  "</hh:charProperties>" +
  '<hh:tabProperties itemCnt="1"><hh:tabPr id="0" autoTabLeft="0" autoTabRight="0"/></hh:tabProperties>' +
  '<hh:numberings itemCnt="1">' + NUMBERING + "</hh:numberings>" +
  '<hh:paraProperties itemCnt="5">' + PARAPRS + "</hh:paraProperties>" +
  '<hh:styles itemCnt="1"><hh:style id="0" type="PARA" name="바탕글" engName="Normal" paraPrIDRef="0"' +
  ' charPrIDRef="0" nextStyleIDRef="0" langID="1042" lockForm="0"/></hh:styles></hh:refList>' +
  '<hh:compatibleDocument targetProgram="HWP201X"><hh:layoutCompatibility/></hh:compatibleDocument>' +
  '<hh:docOption><hh:linkinfo path="" pageInherit="0" footnoteInherit="0"/></hh:docOption>' +
  "</hh:head>";

// A4 세로, 사방 여백 4252 HWPUNIT(약 15mm) — 화면 인쇄용 CSS와 같은 여백.
export const HWPX_SECPR =
  '<hp:secPr id="" textDirection="HORIZONTAL" spaceColumns="1134" tabStop="8000" tabStopVal="4000"' +
  ' tabStopUnit="HWPUNIT" outlineShapeIDRef="1" memoShapeIDRef="0" textVerticalWidthHead="0"' +
  ' masterPageCnt="0"><hp:grid lineGrid="0" charGrid="0" wonggojiFormat="0"/>' +
  '<hp:startNum pageStartsOn="BOTH" page="0" pic="0" tbl="0" equation="0"/>' +
  '<hp:visibility hideFirstHeader="0" hideFirstFooter="0" hideFirstMasterPage="0" border="SHOW_ALL"' +
  ' fill="SHOW_ALL" hideFirstPageNum="0" hideFirstEmptyLine="0" showLineNumber="0"/>' +
  '<hp:lineNumberShape restartType="0" countBy="0" distance="0" startNumber="0"/>' +
  '<hp:pagePr landscape="WIDELY" width="59528" height="84188" gutterType="LEFT_ONLY">' +
  '<hp:margin header="4252" footer="4252" gutter="0" left="4252" right="4252" top="4252" bottom="4252"/>' +
  "</hp:pagePr>" +
  '<hp:footNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/>' +
  '<hp:noteLine length="-1" type="SOLID" width="0.12 mm" color="#000000"/>' +
  '<hp:noteSpacing betweenNotes="283" belowLine="567" aboveLine="850"/>' +
  '<hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="EACH_COLUMN" beneathText="0"/>' +
  "</hp:footNotePr>" +
  '<hp:endNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/>' +
  '<hp:noteLine length="14692344" type="SOLID" width="0.12 mm" color="#000000"/>' +
  '<hp:noteSpacing betweenNotes="0" belowLine="567" aboveLine="850"/>' +
  '<hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="END_OF_DOCUMENT" beneathText="0"/>' +
  "</hp:endNotePr>" +
  ["BOTH", "EVEN", "ODD"]
    .map(
      (t) =>
        `<hp:pageBorderFill type="${t}" borderFillIDRef="1" textBorder="PAPER" headerInside="0"` +
        ' footerInside="0" fillArea="PAPER">' +
        '<hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill>',
    )
    .join("") +
  "</hp:secPr>";

export const HWPX_VERSION_XML =
  XD +
  '<hv:HCFVersion xmlns:hv="http://www.hancom.co.kr/hwpml/2011/version" tagetApplication="WORDPROCESSOR"' +
  ' major="5" minor="1" micro="0" buildNumber="0" os="1" xmlVersion="1.4"' +
  ' application="법률 절차 길잡이" appVersion="1.0"/>';

export const HWPX_SETTINGS_XML =
  XD +
  '<ha:HWPApplicationSetting xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app"' +
  ' xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0">' +
  '<ha:CaretPosition listIDRef="0" paraIDRef="0" pos="0"/></ha:HWPApplicationSetting>';

export const HWPX_CONTAINER_XML =
  XD +
  '<ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container"' +
  ' xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf"><ocf:rootfiles>' +
  '<ocf:rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/>' +
  '<ocf:rootfile full-path="Preview/PrvText.txt" media-type="text/plain"/>' +
  '<ocf:rootfile full-path="META-INF/container.rdf" media-type="application/rdf+xml"/>' +
  "</ocf:rootfiles></ocf:container>";

export const HWPX_MANIFEST_XML =
  XD + '<odf:manifest xmlns:odf="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>';

const PKG = "http://www.hancom.co.kr/hwpml/2016/meta/pkg#";
export const HWPX_CONTAINER_RDF =
  XD +
  '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
  `<rdf:Description rdf:about=""><ns0:hasPart xmlns:ns0="${PKG}" rdf:resource="Contents/header.xml"/></rdf:Description>` +
  `<rdf:Description rdf:about="Contents/header.xml"><rdf:type rdf:resource="${PKG}HeaderFile"/></rdf:Description>` +
  `<rdf:Description rdf:about=""><ns0:hasPart xmlns:ns0="${PKG}" rdf:resource="Contents/section0.xml"/></rdf:Description>` +
  `<rdf:Description rdf:about="Contents/section0.xml"><rdf:type rdf:resource="${PKG}SectionFile"/></rdf:Description>` +
  `<rdf:Description rdf:about=""><rdf:type rdf:resource="${PKG}Document"/></rdf:Description></rdf:RDF>`;

export const HWPX_MIMETYPE = "application/hwp+zip";
export const HWPX_ZIP_MIME = "application/vnd.hancom.hwpx";

export type HwpxRun = { t: string; b?: boolean; u?: boolean };

const xe = (s: string) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const LINESEG =
  '<hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="1000" textheight="1000"' +
  ' baseline="850" spacing="600" horzpos="0" horzsize="51024" flags="393216"/></hp:linesegarray>';

/** 배치(formlayout) → header.xml 의 paraPr / charPr id. 브라우저 사본과 같은 값을 쓴다. */
export const ppRef = (st: ParaStyle) =>
  st.size === "TITLE" ? 4 : st.align === "RIGHT" ? 2 : st.align === "CENTER" ? 1 : st.hang ? 3 : 0;
export const cpRef = (st: ParaStyle, r: { b?: boolean; u?: boolean }) =>
  st.size === "TITLE" ? 3 : st.size === "SUB" ? 4 : r.b ? 1 : r.u ? 2 : 0;

/** 문단 배열 → Contents/section0.xml. 첫 문단의 첫 run에 secPr이 들어간다(HWPX 규칙). */
export function hwpxSectionXml(paras: HwpxRun[][]): string {
  const body = layoutParas(paras)
    .map((p, n) => {
      const st = p.s;
      let rs =
        n === 0
          ? '<hp:run charPrIDRef="0">' +
            HWPX_SECPR +
            '<hp:ctrl><hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="1" sameSz="1" sameGap="0"/></hp:ctrl>' +
            "</hp:run>"
          : "";
      if (!p.r.length) rs += '<hp:run charPrIDRef="0"><hp:t></hp:t></hp:run>';
      for (const r of p.r) {
        rs += `<hp:run charPrIDRef="${cpRef(st, r)}"><hp:t>${xe(r.t)}</hp:t></hp:run>`;
      }
      return `<hp:p id="${n}" paraPrIDRef="${ppRef(st)}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">${rs}${LINESEG}</hp:p>`;
    })
    .join("");
  return XD + `<hs:sec ${NS}>` + body + "</hs:sec>";
}

export function hwpxContentHpf(title: string): string {
  return (
    XD +
    `<opf:package ${NS} version="" unique-identifier="" id=""><opf:metadata>` +
    `<opf:title>${xe(title)}</opf:title><opf:language>ko</opf:language>` +
    '<opf:meta name="creator" content="text">법률 절차 길잡이</opf:meta></opf:metadata><opf:manifest>' +
    '<opf:item id="header" href="Contents/header.xml" media-type="application/xml"/>' +
    '<opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/>' +
    '<opf:item id="settings" href="settings.xml" media-type="application/xml"/></opf:manifest>' +
    '<opf:spine><opf:itemref idref="header" linear="yes"/>' +
    '<opf:itemref idref="section0" linear="yes"/></opf:spine></opf:package>'
  );
}

/** ZIP에 담을 엔트리 목록. mimetype이 반드시 첫 번째. */
export function hwpxFiles(title: string, paras: HwpxRun[][]): { name: string; data: string }[] {
  const prv = layoutParas(paras).map((p) => p.r.map((x) => x.t).join("")).join("\n").slice(0, 1000);
  return [
    { name: "mimetype", data: HWPX_MIMETYPE },
    { name: "version.xml", data: HWPX_VERSION_XML },
    { name: "settings.xml", data: HWPX_SETTINGS_XML },
    { name: "Contents/header.xml", data: HWPX_HEADER_XML },
    { name: "Contents/section0.xml", data: hwpxSectionXml(paras) },
    { name: "Contents/content.hpf", data: hwpxContentHpf(title) },
    { name: "META-INF/container.xml", data: HWPX_CONTAINER_XML },
    { name: "META-INF/manifest.xml", data: HWPX_MANIFEST_XML },
    { name: "META-INF/container.rdf", data: HWPX_CONTAINER_RDF },
    { name: "Preview/PrvText.txt", data: prv },
  ];
}

/**
 * 서식 페이지 안에서 도는 클라이언트 코드.
 * 고정 XML 조각은 여기서 JSON 문자열로 심고, 문단 조립만 브라우저에서 한다.
 * ⚠️ 이 문자열은 server.ts의 템플릿 리터럴 안으로 들어간다 — 역슬래시 이스케이프를 쓰지 말 것.
 */
export function hwpxClientScript(): string {
  const S = (v: string) => JSON.stringify(v);
  return `
  // ── 한글(.hwpx)로 내보내기 ─────────────────────────
  // .hwp는 비공개 바이너리라 못 만든다. .hwpx는 국가표준(KS X 6101)이고 ZIP+XML이라
  // .docx와 같은 방식으로 만든다. 한글 2014 이상에서 그대로 열린다.
  var HWPX_XD=${S(XD)},HWPX_NS=${S(NS)},HWPX_SECPR=${S(HWPX_SECPR)},HWPX_LS=${S(LINESEG)};
  // 배치 id 는 header.xml 의 paraPr / charPr 표와 짝 — src/hwpx.ts 의 ppRef/cpRef 와 같은 값.
  function ppRef(st){return st.size==="TITLE"?4:st.align==="RIGHT"?2:st.align==="CENTER"?1:st.hang?3:0;}
  function cpRef(st,r){
    if(st.size==="TITLE")return 3;
    if(st.size==="SUB")return 4;
    return (r.s&&r.s.b)||r.b?1:((r.s&&r.s.u)||r.u?2:0);
  }
  function hwpxFiles(title,paras){
    var body="",prv=[];
    layoutParas(paras).forEach(function(p,n){
      var st=p.s;
      var rs=n===0?'<hp:run charPrIDRef="0">'+HWPX_SECPR+'<hp:ctrl><hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="1" sameSz="1" sameGap="0"/></hp:ctrl></hp:run>':"";
      if(!p.r.length) rs+='<hp:run charPrIDRef="0"><hp:t></hp:t></hp:run>';
      var line="";
      p.r.forEach(function(r){
        rs+='<hp:run charPrIDRef="'+cpRef(st,r)+'"><hp:t>'+xe(r.t)+"</hp:t></hp:run>";
        line+=r.t;
      });
      prv.push(line);
      body+='<hp:p id="'+n+'" paraPrIDRef="'+ppRef(st)+'" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">'+rs+HWPX_LS+"</hp:p>";
    });
    return [
      {name:"mimetype",data:${S(HWPX_MIMETYPE)}},
      {name:"version.xml",data:${S(HWPX_VERSION_XML)}},
      {name:"settings.xml",data:${S(HWPX_SETTINGS_XML)}},
      {name:"Contents/header.xml",data:${S(HWPX_HEADER_XML)}},
      {name:"Contents/section0.xml",data:HWPX_XD+"<hs:sec "+HWPX_NS+">"+body+"</hs:sec>"},
      {name:"Contents/content.hpf",data:HWPX_XD+'<opf:package '+HWPX_NS+' version="" unique-identifier="" id=""><opf:metadata><opf:title>'+xe(title)+"</opf:title><opf:language>ko</opf:language>"+'<opf:meta name="creator" content="text">법률 절차 길잡이</opf:meta></opf:metadata><opf:manifest><opf:item id="header" href="Contents/header.xml" media-type="application/xml"/><opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/><opf:item id="settings" href="settings.xml" media-type="application/xml"/></opf:manifest><opf:spine><opf:itemref idref="header" linear="yes"/><opf:itemref idref="section0" linear="yes"/></opf:spine></opf:package>'},
      {name:"META-INF/container.xml",data:${S(HWPX_CONTAINER_XML)}},
      {name:"META-INF/manifest.xml",data:${S(HWPX_MANIFEST_XML)}},
      {name:"META-INF/container.rdf",data:${S(HWPX_CONTAINER_RDF)}},
      {name:"Preview/PrvText.txt",data:prv.join(String.fromCharCode(10)).slice(0,1000)}
    ];
  }`;
}
