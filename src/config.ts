import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

export type Backend = "claude" | "glm";

export interface Config {
  workingDirectory: string;
  model?: string;
  permissionMode?: "default" | "acceptEdits" | "plan" | "auto";
  systemPrompt?: string;
  backend?: Backend;
  glmAuthToken?: string;
  glmBaseUrl?: string;
}

const CONFIG_DIR = join(homedir(), ".wechat-claude-code");
const CONFIG_PATH = join(CONFIG_DIR, "config.env");

const DEFAULT_CONFIG: Config = {
  workingDirectory: process.cwd(),
};

const VALID_BACKENDS: Backend[] = ["claude", "glm"];

const GLM_DEFAULT_BASE_URL = "https://open.bigmodel.cn/api/anthropic";

function ensureConfigDir(): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
}

function parseConfigFile(content: string): Config {
  const config: Config = { ...DEFAULT_CONFIG };
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    switch (key) {
      case "workingDirectory":
        config.workingDirectory = value;
        break;
      case "model":
        config.model = value;
        break;
      case "permissionMode":
        if (
          value === "default" ||
          value === "acceptEdits" ||
          value === "plan" ||
          value === "auto"
        ) {
          config.permissionMode = value;
        }
        break;
      case "systemPrompt":
        config.systemPrompt = value;
        break;
      case "backend":
        if (VALID_BACKENDS.includes(value as Backend)) {
          config.backend = value as Backend;
        }
        break;
      case "glmAuthToken":
        config.glmAuthToken = value;
        break;
      case "glmBaseUrl":
        config.glmBaseUrl = value;
        break;
    }
  }
  return config;
}

export function loadConfig(): Config {
  try {
    const content = readFileSync(CONFIG_PATH, "utf-8");
    return parseConfigFile(content);
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: Config): void {
  ensureConfigDir();
  const lines: string[] = [];
  lines.push(`workingDirectory=${config.workingDirectory}`);
  if (config.model) {
    lines.push(`model=${config.model}`);
  }
  if (config.permissionMode) {
    lines.push(`permissionMode=${config.permissionMode}`);
  }
  if (config.systemPrompt) {
    lines.push(`systemPrompt=${config.systemPrompt}`);
  }
  if (config.backend) {
    lines.push(`backend=${config.backend}`);
  }
  if (config.glmAuthToken) {
    lines.push(`glmAuthToken=${config.glmAuthToken}`);
  }
  if (config.glmBaseUrl) {
    lines.push(`glmBaseUrl=${config.glmBaseUrl}`);
  }
  writeFileSync(CONFIG_PATH, lines.join("\n") + "\n", "utf-8");
  if (process.platform !== 'win32') {
    chmodSync(CONFIG_PATH, 0o600);
  }
}

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
    process.env.ANTHROPIC_BASE_URL = config.glmBaseUrl || GLM_DEFAULT_BASE_URL;
    process.env.API_TIMEOUT_MS = "3000000";
    process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
    if (config.glmAuthToken) {
      process.env.ANTHROPIC_AUTH_TOKEN = config.glmAuthToken;
    }
  }
}
