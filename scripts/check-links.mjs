/**
 * 접수처 링크 죽었는지 전수 점검
 *
 *   npm run audit:links
 *
 * 왜 필요한가 — 서식과 절차 안내에 걸어둔 기관 주소는 우리가 못 고치는 사이에
 * 조용히 죽는다. 2026-08-17에 13건이 응답하지 않는 걸 발견했다(대부분 apex
 * 도메인에 www 가 빠진 경우, 일부는 사이트 자체가 내려감). 이용자가 링크를
 * 눌렀는데 안 열리는 건 우리 서비스에서 가장 나쁜 실패다.
 *
 * 한국 정부·공공 사이트는 해외에서 막는 경우가 있으니, 여기서 죽은 것으로
 * 나와도 국내망에서 한 번 더 확인할 것.
 */
import { readdir, readFile } from "node:fs/promises";

const DIR = "src/data";
const CONCURRENCY = 6;
const TIMEOUT_MS = 10_000;
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

/** 이미 죽은 걸 알고 있고, 대체 경로를 함께 안내해 둔 것들. 살아나면 지운다. */
const KNOWN_DOWN = new Map([
  ["lost112.go.kr", "2026-08-17 확인 — 경찰민원24 minwon24.police.go.kr 로 안내 중"],
  ["www.kcdrc.kr", "2026-08-17 확인 — 전화 1588-2594·소비자24 로 안내 중"],
]);

async function collect() {
  const files = (await readdir(DIR)).filter((f) => f.endsWith(".ts"));
  const found = new Set();
  for (const f of files) {
    const text = await readFile(`${DIR}/${f}`, "utf8");
    for (const m of text.matchAll(/\b[a-z0-9][a-z0-9.-]*\.(?:go\.kr|or\.kr|re\.kr|kr|com|net)\b/g)) {
      found.add(m[0]);
    }
  }
  return [...found].sort();
}

/**
 * 우리가 알고 싶은 건 "이용자 브라우저에서 열리느냐"지 "Node 가 만족하느냐"가 아니다.
 * 한국 공공 사이트는 두 가지로 Node 만 실패시키는데, 둘 다 브라우저에선 잘 열린다.
 *
 *   UNABLE_TO_VERIFY_LEAF_SIGNATURE  인증서 중간체를 빼먹고 준다(브라우저는 알아서 보충)
 *   redirect count exceeded          쿠키 없는 클라이언트를 리다이렉트로 돌린다
 *
 * 그래서 연결 자체가 안 되는 것만 죽은 것으로 센다.
 */
const DEAD_CODES = new Set(["ENOTFOUND", "ECONNREFUSED", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "ECONNRESET"]);

async function probe(host) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    await fetch(`https://${host}`, { redirect: "follow", signal: ctl.signal, headers: { "user-agent": UA } });
    return true;
  } catch (e) {
    if (e.name === "AbortError" || e.name === "TimeoutError") return false; // 응답 없음
    const code = e.cause?.code ?? e.code;
    if (DEAD_CODES.has(code)) return false;
    return true; // TLS 체인·리다이렉트 문제 — 서버는 살아 있다
  } finally {
    clearTimeout(t);
  }
}

const hosts = await collect();
const dead = [];
const queue = [...hosts];

await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const h = queue.shift();
      if (!(await probe(h))) dead.push(h);
    }
  })
);

const unexpected = dead.filter((h) => !KNOWN_DOWN.has(h));
const expected = dead.filter((h) => KNOWN_DOWN.has(h));

console.log(`도메인 ${hosts.length}개 점검 · 응답 없음 ${dead.length}건`);

if (expected.length) {
  console.log(`\n이미 알고 있는 것 (대체 경로 안내 중)`);
  for (const h of expected) console.log(`  · ${h} — ${KNOWN_DOWN.get(h)}`);
}

if (unexpected.length) {
  console.error(`\n❌ 새로 죽은 링크 ${unexpected.length}건`);
  for (const h of unexpected) console.error(`  · ${h}`);
  console.error(`\n대부분 www. 를 붙이면 살아납니다. 확인 후 src/data/ 에서 고치세요.`);
  process.exitCode = 1;
} else {
  console.log(`\n새로 죽은 링크 없음`);
}
