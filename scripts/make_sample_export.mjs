// 서식 내보내기 실물 만들기 — 사람이 한글/워드로 열어 배치를 눈으로 확인하는 용도.
// 브라우저가 만드는 것과 같은 바이트다(test/data.test.ts "브라우저에서 만든 결과가
// 서버 쪽 결과와 같다"가 보증). 채운 값이 있는 상태를 보려면 아래 FILL을 바꾼다.
//
//   node scripts/make_sample_export.mjs 보증금반환_내용증명 <출력폴더>

import { writeFileSync, mkdirSync } from "node:fs";
import { deflateRawSync } from "node:zlib";
import { join } from "node:path";
import { FORMS } from "../dist/data/index.js";
import { hwpxFiles } from "../dist/hwpx.js";
import { layoutParas } from "../dist/formlayout.js";

const key = process.argv[2] || "보증금반환_내용증명";
const outDir = process.argv[3] || ".";
const f = FORMS[key];
if (!f) throw new Error(`서식 없음: ${key}`);

// 사용자가 빈칸을 채운 상태를 흉내낸다 — 대괄호 자리에 순서대로 들어간다.
const FILL = ["윤은미", "서울시 마포구 ○○로 12", "010-1234-5678", "김임대", "서울시 종로구 ○○길 3",
  "서울 마포구 서교동 123-4 201호", "2024. 3. 2.", "150,000,000", "2년", "2026. 3. 1.",
  "150,000,000", "14", "국민은행 / 윤은미 / 123456-78-901234", "2026. 8. 22.", "윤은미"];
let fi = 0;

// 화면의 collect()가 만드는 것과 같은 문단·런 구조. 대괄호는 채워 넣는 빈칸(밑줄),
// 줄머리 대괄호는 굵은 라벨이다.
const paras = f.본문.split("\n").map((line) => {
  const runs = [];
  let rest = line;
  let atLineStart = true;
  while (rest.length) {
    const i = rest.indexOf("[");
    if (i < 0) {
      if (rest) runs.push({ t: rest });
      break;
    }
    const j = rest.indexOf("]", i);
    if (j < 0) {
      runs.push({ t: rest });
      break;
    }
    const before = rest.slice(0, i);
    if (before) runs.push({ t: before });
    const inner = rest.slice(i + 1, j);
    const 줄머리라벨 = atLineStart && before.trim() === "" && !/^[_\s]*$/.test(inner);
    if (줄머리라벨) runs.push({ t: inner, b: true });
    else runs.push({ t: FILL[fi++] || "        ", u: true });
    rest = rest.slice(j + 1);
    atLineStart = false;
  }
  return runs;
});

mkdirSync(outDir, { recursive: true });
const base = f.제목.replace(/\s*\([^()]*\)\s*$/, "").trim().replace(/\s+/g, "_");

// ZIP(무압축 STORE) — 서식 페이지의 zipStore와 같은 방식.
function zipStore(files) {
  const parts = [], central = [];
  let offset = 0;
  const u16 = (v) => Buffer.from([v & 255, (v >>> 8) & 255]);
  const u32 = (v) => Buffer.from([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]);
  const crcT = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (b) => { let c = 0xFFFFFFFF; for (const x of b) c = crcT[(c ^ x) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8"), data = Buffer.from(f.data, "utf8"), crc = crc32(data);
    const lh = Buffer.concat([Buffer.from([80, 75, 3, 4]), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0)]);
    parts.push(lh, name, data);
    central.push(Buffer.concat([Buffer.from([80, 75, 1, 2]), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset)]), name);
    offset += lh.length + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.concat([Buffer.from([80, 75, 5, 6]), u16(0), u16(0), u16(files.length), u16(files.length), u32(cd.length), u32(offset), u16(0)]);
  return Buffer.concat([...parts, cd, eocd]);
}

// ── .hwpx
const hwpxPath = join(outDir, base + ".hwpx");
writeFileSync(hwpxPath, zipStore(hwpxFiles(base, paras)));

// ── .docx (server.ts 의 docXml 과 같은 규칙)
const xe = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const body = layoutParas(paras).map((p) => {
  const st = p.s;
  const sz = st.size === "TITLE" ? 30 : st.size === "SUB" ? 26 : 23;
  const rs = p.r.map((r) => {
    const pr = `<w:rPr><w:rFonts w:ascii="Batang" w:eastAsia="Batang" w:hAnsi="Batang"/><w:sz w:val="${sz}"/>` +
      (r.b || st.bold ? "<w:b/>" : "") + (r.u ? '<w:u w:val="single"/>' : "") + "</w:rPr>";
    return `<w:r>${pr}<w:t xml:space="preserve">${xe(r.t)}</w:t></w:r>`;
  }).join("");
  const before = st.align === "RIGHT" ? 1200 : st.align === "CENTER" && !st.size ? 600 : 0;
  const after = st.size === "TITLE" ? 600 : 0;
  const ppr = `<w:spacing w:before="${before}" w:after="${after}" w:line="300" w:lineRule="auto"/>` +
    (st.align ? `<w:jc w:val="${st.align === "RIGHT" ? "right" : "center"}"/>` : "") +
    (st.hang ? '<w:ind w:left="400" w:hanging="400"/>' : "");
  return `<w:p><w:pPr>${ppr}</w:pPr>${rs}</w:p>`;
}).join("");
const docxPath = join(outDir, base + ".docx");
writeFileSync(docxPath, zipStore([
  { name: "[Content_Types].xml", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
  { name: "_rels/.rels", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
  { name: "word/document.xml", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + body + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>' },
]));

// 사람이 읽을 배치 요약
const 역할 = (s) => s.size === "TITLE" ? "제목(가운데·15pt)" : s.align === "RIGHT" ? "우측·13pt 굵게"
  : s.align === "CENTER" ? "가운데" : s.hang ? "내어쓰기" : "";
for (const p of layoutParas(paras)) {
  const t = p.r.map((r) => r.t).join("");
  if (t.trim()) console.log((역할(p.s) || "본문").padEnd(18) + " | " + t);
}
console.log("\n" + hwpxPath + "\n" + docxPath);
void deflateRawSync;
