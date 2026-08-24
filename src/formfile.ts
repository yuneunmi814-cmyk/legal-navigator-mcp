// 서버에서 바로 내려주는 서식 파일 — GET /forms/:key.hwpx · .docx
//
// 왜 필요한가
//   위젯의 "서식 다운로드"가 페이지를 열고 거기서 다시 메뉴를 눌러야 파일이 나왔다.
//   카톡에서 서식을 찾은 사람에게는 한 번에 파일이 떨어지는 쪽이 맞다(8/23 은미 님).
//
// 채운 값은 여기로 오지 않는다
//   이 경로가 만드는 건 **빈 서식**이다. 사용자가 입력한 값은 브라우저 밖으로 나가지 않는다
//   — 채워서 받는 건 지금처럼 서식 페이지에서 하고, 서버는 원본만 준다.
//   "수집하는 개인정보 0"이 이 구분 덕에 유지된다.
//
// 배치는 화면과 같은 규칙(formlayout)을 쓴다. 브라우저에서 받은 파일과 서버에서 받은 파일이
// 다르게 생기면 그게 더 이상하다.

import { deflateRawSync } from "node:zlib";
import { hwpxFiles, HWPX_ZIP_MIME, type HwpxRun } from "./hwpx.js";
import { layoutParas } from "./formlayout.js";

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(b: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * ZIP 하나로 묶는다. `store` 목록에 든 이름은 무압축으로 넣는다 —
 * HWPX는 첫 항목 `mimetype`이 반드시 무압축이어야 한다(ODF와 같은 규칙).
 */
export function zip(files: { name: string; data: string }[], store: string[] = []): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const raw = Buffer.from(f.data, "utf8");
    const stored = store.includes(f.name);
    const data = stored ? raw : deflateRawSync(raw);
    const crc = crc32(raw);
    const method = stored ? 0 : 8;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(name.length, 26);
    local.push(lh, name, data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);

    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, eocd]);
}

const xe = (s: string) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * 서식 본문 텍스트 → 문단 배열. 빈 줄은 빈 문단으로 남긴다(줄 간격이 무너지지 않게).
 *
 * ⚠️ 본문만 넣는다. 서식 이름을 앞에 끼워 넣으면 안 된다 —
 * layoutParas는 **첫 문단을 제목으로 보고 가운데 큰 글씨로** 만든다.
 * 안내문("… (표준 서식 예시 — 공란을 직접 채워 사용)")을 앞에 붙였더니
 * 그게 제목 자리를 차지하고 정작 "진 정 서"가 왼쪽으로 밀렸다 —
 * 브라우저에서 받은 파일과 서버에서 받은 파일이 달라졌다(2026-08-24 확인).
 * 브라우저 쪽은 화면의 본문만 읽으므로, 여기도 본문만 넣어야 둘이 같아진다.
 */
export function bodyToParas(_제목: string, 본문: string): HwpxRun[][] {
  const paras: HwpxRun[][] = [];
  for (const line of String(본문).split("\n")) paras.push(line.trim() ? [{ t: line }] : []);
  return paras;
}

export function hwpxBuffer(title: string, paras: HwpxRun[][]): Buffer {
  return zip(hwpxFiles(title, paras), ["mimetype"]);
}

/** 화면·브라우저 내보내기와 같은 배치 규칙으로 .docx를 만든다. */
export function docxBuffer(paras: HwpxRun[][]): Buffer {
  const body = layoutParas(paras)
    .map((p) => {
      const st = p.s;
      const sz = st.size === "TITLE" ? 30 : st.size === "SUB" ? 26 : 23;
      const rs = p.r
        .map((r) => {
          const pr =
            `<w:rPr><w:rFonts w:ascii="Batang" w:eastAsia="Batang" w:hAnsi="Batang"/><w:sz w:val="${sz}"/>` +
            (r.b || st.bold ? "<w:b/>" : "") +
            (r.u ? '<w:u w:val="single"/>' : "") +
            "</w:rPr>";
          return `<w:r>${pr}<w:t xml:space="preserve">${xe(r.t)}</w:t></w:r>`;
        })
        .join("");
      const before = st.align === "RIGHT" ? 1200 : st.align === "CENTER" && !st.size ? 600 : 0;
      const after = st.size === "TITLE" ? 600 : 0;
      const ppr =
        `<w:spacing w:before="${before}" w:after="${after}" w:line="300" w:lineRule="auto"/>` +
        (st.align ? `<w:jc w:val="${st.align === "RIGHT" ? "right" : "center"}"/>` : "") +
        (st.hang ? '<w:ind w:left="400" w:hanging="400"/>' : "");
      return `<w:p><w:pPr>${ppr}</w:pPr>${rs}</w:p>`;
    })
    .join("");
  return zip([
    {
      name: "[Content_Types].xml",
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    },
    {
      name: "_rels/.rels",
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    },
    {
      name: "word/document.xml",
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
        body +
        '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>',
    },
  ]);
}

export const MIME = {
  hwpx: HWPX_ZIP_MIME,
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
} as const;

/** 파일 이름 — 한글 그대로 쓰되 파일시스템이 싫어하는 글자만 뺀다. */
export const safeName = (제목: string) =>
  제목.replace(/\s*\([^()]*\)\s*$/, "").trim().replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, "_");
