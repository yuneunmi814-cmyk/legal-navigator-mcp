// 모든 도구 응답에 붙는 면책 고지. declaw 에디션의 핵심 안전장치.
// 출처(원문 링크)·정직성(미확인 표기)·에스컬레이션(전문가/무료상담)을 항상 포함.
export const DISCLAIMER =
  "⚠️ 일반 법률·절차 정보이며 개별 법률 자문이 아닙니다. 인용된 법령·판례는 law.go.kr·casenote.kr 원문으로 확인하시고(없는 내용은 지어내지 않습니다), " +
  "기한이 임박했거나 중대·복잡한 사안은 변호사·공인노무사 또는 대한법률구조공단(국번없이 132)에 상담하세요.";

export function withDisclaimer(text: string): string {
  return `${text}\n\n———\n${DISCLAIMER}`;
}
