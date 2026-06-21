// 모든 도구 응답에 붙는 면책 고지. declaw 에디션의 핵심 안전장치.
export const DISCLAIMER =
  "⚠️ 일반 법률·절차 정보이며 법률 자문이 아닙니다. 구체적 사안은 변호사·공인노무사 상담을 권하며, 최신 법령·서식은 law.go.kr에서 확인하세요.";

export function withDisclaimer(text: string): string {
  return `${text}\n\n———\n${DISCLAIMER}`;
}
