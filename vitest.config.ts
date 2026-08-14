import { defineConfig } from "vitest/config";

// 워크트리(.claude/worktrees/*)에도 같은 테스트 파일이 있어 vitest가 중복 수집한다.
// 총계가 부풀어(156 → 286) 회귀 판단이 흐려지므로 제외한다.
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/.claude/**"],
  },
});
