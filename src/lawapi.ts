// 국가법령정보 공동활용 Open API (open.law.go.kr) 클라이언트 — 선택적(roadmap).
//
// 활성화: open.law.go.kr 에서 무료 OC(이메일 ID) 발급 → 환경변수 LAW_OC=내OC 로 실행.
// ⚠️ PlayMCP 응답속도 요건(평균 100ms)이 있으므로, 이 라이브 호출은 도구 핫패스에서 직접
//    쓰지 말 것. 시작 시 1회 프리로드(법령 링크 검증/캐싱)나 개인용 풀버전에서만 사용.
// ⚠️ OC 키가 없어 라이브 응답은 미검증 상태. (fallback 경로만 검증됨)

const OC = process.env.LAW_OC;
const BASE = "https://www.law.go.kr/DRF";

export function isLawApiEnabled(): boolean {
  return !!OC;
}

export interface LawHit {
  명칭?: string;
  법령ID?: string;
  공포일자?: string;
  링크?: string;
}

// 법령명 키워드 검색 → 법령 목록. 문서: lawSearch.do (target=law)
export async function searchLaw(query: string): Promise<LawHit[]> {
  if (!OC) throw new Error("LAW_OC 미설정 — open.law.go.kr에서 OC 발급 후 환경변수 설정");
  const url = `${BASE}/lawSearch.do?OC=${encodeURIComponent(OC)}&target=law&type=JSON&query=${encodeURIComponent(query)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
  if (!res.ok) throw new Error(`법제처 API 오류 ${res.status}`);
  const data: any = await res.json();
  const raw = data?.LawSearch?.law ?? [];
  const items = Array.isArray(raw) ? raw : [raw];
  return items.map((x: any) => ({
    명칭: x?.법령명한글,
    법령ID: x?.법령ID,
    공포일자: x?.공포일자,
    링크: x?.법령상세링크 ? `https://www.law.go.kr${x.법령상세링크}` : undefined,
  }));
}
