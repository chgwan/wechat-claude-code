# Backend Env Preservation Fix

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix `applyBackendEnv` so it doesn't destroy pre-existing env vars when switching to or from the GLM backend.

**Architecture:** Snapshot the original values of the affected env vars on first call, then restore them when switching back to `claude` instead of deleting.

**Tech Stack:** TypeScript, Node.js

---

### Task 1: Fix `applyBackendEnv` to preserve original env vars

**Files:**
- Modify: `src/config.ts:114-138`

- [ ] **Step 1: Replace `GLM_ENV_VARS` constant and `applyBackendEnv` function**

Replace lines 114–138 of `src/config.ts` with the following:

```typescript
const GLM_MANAGED_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "API_TIMEOUT_MS",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
];

let savedEnv: Record<string, string | undefined> | null = null;

/** Apply or clear backend-specific env vars on process.env. */
export function applyBackendEnv(config: Config): void {
  // On first call, snapshot any pre-existing values so we can restore them later.
  if (savedEnv === null) {
    savedEnv = {};
    for (const key of GLM_MANAGED_KEYS) {
      if (key in process.env) {
        savedEnv[key] = process.env[key];
      }
    }
  }

  // Clear only the keys we manage.
  for (const key of GLM_MANAGED_KEYS) {
    delete process.env[key];
  }

  // Restore original values for keys that existed before our first call.
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value !== undefined) {
      process.env[key] = value;
    }
  }

  // Overlay GLM-specific values when that backend is active.
  if (config.backend === "glm") {
    process.env.ANTHROPIC_BASE_URL = config.glmBaseUrl || "https://open.bigmodel.cn/api/anthropic";
    process.env.API_TIMEOUT_MS = "3000000";
    process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
    if (config.glmAuthToken) {
      process.env.ANTHROPIC_AUTH_TOKEN = config.glmAuthToken;
    }
  }
}
```

- [ ] **Step 2: Build and verify no errors**

Run: `cd ~/.claude/skills/wechat-claude-code && npm run build`
Expected: clean build, no TypeScript errors

- [ ] **Step 3: Commit**

```bash
git add src/config.ts
git commit -m "fix: preserve pre-existing env vars when switching backends"
```
