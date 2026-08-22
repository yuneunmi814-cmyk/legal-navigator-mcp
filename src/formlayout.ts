// 서식 내보내기(.hwpx / .docx)의 문단 배치.
//
// 내보낸 파일이 밑줄 친 평문 나열로 나와 실제 관공서 서식과 안 닮았던 문제를 고친다.
// 기준은 법원 공식 서식(지급명령에 대한 이의신청서 원본)의 배치다:
//   제목은 가운데 큰 글씨, 날짜와 서명은 가운데, '○○법원 귀중'은 우측에 굵게,
//   번호 항목은 둘째 줄이 번호 밑으로 내려가지 않게 내어쓰기.
//
// 배치는 문단 텍스트에서 추론하므로 서식 데이터(src/data)는 손대지 않아도 되고
// 서식 전종에 그대로 적용된다.
//
// ⚠️ 아래 clientScript() 문자열은 server.ts의 템플릿 리터럴 안으로 들어간다 —
//    역슬래시 이스케이프를 쓰지 말 것. 그래서 정규식 없이 문자열 연산만 쓴다
//    (TS 쪽도 같은 방식으로 맞춰 둬야 둘이 어긋나지 않는다).

/** 문단 하나에 매길 배치. 없으면 본문(왼쪽·기본 크기). */
export type ParaStyle = {
  align?: "CENTER" | "RIGHT";
  /** TITLE=15pt, SUB=13pt. 없으면 본문 크기 */
  size?: "TITLE" | "SUB";
  bold?: boolean;
  /** 번호 항목 내어쓰기 */
  hang?: boolean;
};

export type LaidPara<R> = { r: R[]; s: ParaStyle };

const 끝맺음 = (t: string) => {
  const s = t.trim();
  return s.endsWith("귀중") || s.endsWith("귀하");
};
const 도장 = (t: string) => t.indexOf("(인)") >= 0 || t.indexOf("(서명") >= 0;
const 날짜 = (t: string) => {
  const s = t.trim();
  return s.indexOf("작성일") === 0 || s.indexOf("신청일") === 0 || s.indexOf("20") === 0;
};
/** '1.' '2)' '가.' 처럼 번호가 붙은 항목인가 */
const 번호항목 = (t: string) => {
  let i = 0;
  while (t.charAt(i) === " ") i++;
  const head = t.charAt(i);
  if (head >= "0" && head <= "9") {
    while (t.charAt(i) >= "0" && t.charAt(i) <= "9") i++;
  } else if ("가나다라마바사아자차".indexOf(head) >= 0 && head !== "") {
    i++;
  } else return false;
  const mark = t.charAt(i);
  return (mark === "." || mark === ")") && t.charAt(i + 1) === " ";
};

const ltrim = (s: string) => { let i = 0; while (s.charAt(i) === " ") i++; return s.slice(i); };
const rtrim = (s: string) => { let i = s.length; while (i > 0 && s.charAt(i - 1) === " ") i--; return s.slice(0, i); };

/**
 * 한 줄에 뭉쳐 있는 마무리 줄을 공백 2칸 이상에서 끊는다.
 * 데이터에 "작성일자 [YYYY-MM-DD]   신청인 [성명] (인)   ○○지방법원 귀중" 처럼
 * 세 덩어리가 한 줄로 들어 있어서, 이걸 끊어야 각각 제 자리에 앉힐 수 있다.
 * 사용자가 채운 값(밑줄 런)은 쪼개지 않는다.
 */
function 넓은공백으로쪼개기<R extends { t: string }>(runs: R[]): R[][] {
  const g: R[][] = [[]];
  for (const r of runs) {
    const u = (r as { u?: boolean }).u || ((r as { s?: { u?: boolean } }).s || {}).u;
    if (u) {
      g[g.length - 1].push(r);
      continue;
    }
    // 끊긴 자리에 붙은 공백만 떼고, 런 사이의 한 칸 띄어쓰기는 살린다
    // ("작성일자 " + [채운 값] 이 "작성일자2026..."으로 붙어버리던 문제).
    const parts = r.t.split("  ");
    for (let i = 0; i < parts.length; i++) {
      let v = parts[i];
      if (i > 0) v = ltrim(v);
      if (i < parts.length - 1) v = rtrim(v);
      if (!v) continue;
      if (i > 0 && g[g.length - 1].length) g.push([]);
      g[g.length - 1].push(Object.assign({}, r, { t: v }));
    }
  }
  return g.filter((x) => x.length);
}

const 글 = (runs: { t: string }[]) => runs.map((r) => r.t).join("");

/** 문단 배열 → 배치가 매겨진 문단 배열. 끊긴 마무리 줄 때문에 개수가 늘 수 있다. */
export function layoutParas<R extends { t: string }>(paras: R[][]): LaidPara<R>[] {
  const out: LaidPara<R>[] = [];
  let titled = false;
  // 마무리 블록은 문서 끝에만 있다. 본문 중간의 '(인)'(상속재산분할협의서 당사자란 등)까지
  // 끊고 가운데로 밀지 않도록 끝 6문단으로 범위를 좁힌다.
  const tail = paras.length - 6;
  paras.forEach((runs, i) => {
    const t = 글(runs);
    const 끝 = i >= tail;
    const 쪼갤값 = 끝 && (끝맺음(t) || 도장(t) || 날짜(t)) && t.indexOf("  ") >= 0;
    const group = 쪼갤값 ? 넓은공백으로쪼개기(runs) : [runs];
    for (const rs of group) {
      const s = 글(rs);
      let st: ParaStyle = {};
      if (!s.trim()) {
        out.push({ r: rs, s: {} });
        continue;
      }
      if (!titled) {
        titled = true;
        st = { align: "CENTER", size: "TITLE", bold: true };
      } else if (끝 && 끝맺음(s)) st = { align: "RIGHT", size: "SUB", bold: true };
      else if (끝 && (도장(s) || 날짜(s))) st = { align: "CENTER" };
      else if (번호항목(s)) st = { hang: true };
      out.push({ r: rs, s: st });
    }
  });
  return out;
}

/**
 * 위와 같은 일을 하는 브라우저용 사본. server.ts의 서식 페이지 안으로 들어간다.
 * 내보내기는 브라우저에서 일어나므로(서버로 입력값을 보내지 않는 원칙) 사본이 필요하다.
 * TS 쪽을 고치면 여기도 같이 고칠 것 — test/export.test.ts가 둘을 같은 입력으로
 * 돌려 결과가 어긋나면 실패한다.
 */
export function formLayoutClientScript(): string {
  return `
  // ── 관공서 서식 배치 (src/formlayout.ts 의 브라우저 사본) ─────────
  function 끝맺음(t){var s=t.trim();return s.slice(-2)==="귀중"||s.slice(-2)==="귀하";}
  function 도장(t){return t.indexOf("(인)")>=0||t.indexOf("(서명")>=0;}
  function 날짜(t){var s=t.trim();return s.indexOf("작성일")===0||s.indexOf("신청일")===0||s.indexOf("20")===0;}
  function 번호항목(t){
    var i=0;while(t.charAt(i)===" ")i++;
    var head=t.charAt(i);
    if(head>="0"&&head<="9"){while(t.charAt(i)>="0"&&t.charAt(i)<="9")i++;}
    else if(head&&"가나다라마바사아자차".indexOf(head)>=0)i++;
    else return false;
    var mark=t.charAt(i);
    return (mark==="."||mark===")")&&t.charAt(i+1)===" ";
  }
  function 글(runs){return runs.map(function(r){return r.t;}).join("");}
  function ltrim(s){var i=0;while(s.charAt(i)===" ")i++;return s.slice(i);}
  function rtrim(s){var i=s.length;while(i>0&&s.charAt(i-1)===" ")i--;return s.slice(0,i);}
  function 넓은공백으로쪼개기(runs){
    var g=[[]];
    runs.forEach(function(r){
      if(r.u||(r.s&&r.s.u)){g[g.length-1].push(r);return;}
      var parts=r.t.split("  ");
      parts.forEach(function(part,i){
        var v=part;
        if(i>0)v=ltrim(v);
        if(i<parts.length-1)v=rtrim(v);
        if(!v)return;
        if(i>0&&g[g.length-1].length)g.push([]);
        var c={};for(var k in r)c[k]=r[k];c.t=v;
        g[g.length-1].push(c);
      });
    });
    return g.filter(function(x){return x.length;});
  }
  function layoutParas(paras){
    var out=[],titled=false,tail=paras.length-6;
    paras.forEach(function(runs,i){
      var t=글(runs),끝=i>=tail;
      var group=(끝&&(끝맺음(t)||도장(t)||날짜(t))&&t.indexOf("  ")>=0)?넓은공백으로쪼개기(runs):[runs];
      group.forEach(function(rs){
        var s=글(rs),st={};
        if(!s.trim()){out.push({r:rs,s:{}});return;}
        if(!titled){titled=true;st={align:"CENTER",size:"TITLE",bold:true};}
        else if(끝&&끝맺음(s))st={align:"RIGHT",size:"SUB",bold:true};
        else if(끝&&(도장(s)||날짜(s)))st={align:"CENTER"};
        else if(번호항목(s))st={hang:true};
        out.push({r:rs,s:st});
      });
    });
    return out;
  }`;
}
