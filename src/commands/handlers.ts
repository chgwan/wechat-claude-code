import type { CommandContext, CommandResult } from './router.js';
import { scanAllSkills, formatSkillList, findSkill, type SkillInfo } from '../claude/skill-scanner.js';
import { loadConfig, saveConfig, applyBackendEnv, type Backend } from '../config.js';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HELP_TEXT = `Available commands:

Session:
  /help             Show this help
  /clear            Clear the current session
  /reset            Full reset (including working directory)
  /status           Show current session status
  /compact          Compact context (start a new SDK session, keep history)
  /history [n]      Show conversation history (default: last 20)
  /undo [n]         Undo recent messages (default: 1)
  /resume [ID]      List or resume Claude Code sessions for the current cwd

Configuration:
  /cwd [path]       Show or change working directory
  /model [name]     Show or change Claude model
  /permission [mode] Show or change permission mode
  /backend [name]   Show or switch backend (claude / glm)
  /prompt [text]    Show or set system prompt (applies globally)

Other:
  /skills [full]    List installed skills (full = with descriptions)
  /version          Show version info
  /<skill> [args]   Trigger an installed skill

Send any plain text to chat with Claude Code`;

// 缓存 skill 列表，避免每次命令都扫描文件系统
let cachedSkills: SkillInfo[] | null = null;
let lastScanTime = 0;
const CACHE_TTL = 60_000; // 60秒

function getSkills(): SkillInfo[] {
  const now = Date.now();
  if (!cachedSkills || now - lastScanTime > CACHE_TTL) {
    cachedSkills = scanAllSkills();
    lastScanTime = now;
  }
  return cachedSkills;
}

/** 清除缓存，用于 /skills 命令强制刷新 */
export function invalidateSkillCache(): void {
  cachedSkills = null;
}

export function handleHelp(_args: string): CommandResult {
  return { reply: HELP_TEXT, handled: true };
}

export function handleClear(ctx: CommandContext): CommandResult {
  // Reject any pending permission to avoid orphaned promise corrupting new session
  ctx.rejectPendingPermission?.();
  const newSession = ctx.clearSession();
  Object.assign(ctx.session, newSession);
  return { reply: '✅ Session cleared. The next message will start a new session.', handled: true };
}

export function handleCwd(ctx: CommandContext, args: string): CommandResult {
  if (!args) {
    return { reply: `Current working directory: ${ctx.session.workingDirectory}\nUsage: /cwd <path>`, handled: true };
  }
  ctx.updateSession({ workingDirectory: args });
  return { reply: `✅ Working directory changed to: ${args}`, handled: true };
}

export function handleModel(ctx: CommandContext, args: string): CommandResult {
  if (!args) {
    return { reply: 'Usage: /model <model-name>\nExample: /model claude-sonnet-4-6', handled: true };
  }
  ctx.updateSession({ model: args });
  return { reply: `✅ Model changed to: ${args}`, handled: true };
}

const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto'] as const;
const PERMISSION_DESCRIPTIONS: Record<string, string> = {
  default: 'Manual approval required for every tool use',
  acceptEdits: 'Auto-approve file edits; manual approval for everything else',
  plan: 'Read-only mode — no tools allowed',
  auto: 'Auto-approve all tools (dangerous mode)',
};

export function handlePermission(ctx: CommandContext, args: string): CommandResult {
  if (!args) {
    const current = ctx.session.permissionMode ?? 'default';
    const lines = [
      '🔒 Current permission mode: ' + current,
      '',
      'Available modes:',
      ...PERMISSION_MODES.map(m => `  ${m} — ${PERMISSION_DESCRIPTIONS[m]}`),
      '',
      'Usage: /permission <mode>',
    ];
    return { reply: lines.join('\n'), handled: true };
  }
  const mode = args.trim();
  if (!PERMISSION_MODES.includes(mode as any)) {
    return {
      reply: `Unknown mode: ${mode}\nAvailable: ${PERMISSION_MODES.join(', ')}`,
      handled: true,
    };
  }
  ctx.updateSession({ permissionMode: mode as any });
  const warning = mode === 'auto' ? '\n\n⚠️ Dangerous mode enabled: all tool calls will be auto-approved without confirmation.' : '';
  return { reply: `✅ Permission mode changed to: ${mode}\n${PERMISSION_DESCRIPTIONS[mode]}${warning}`, handled: true };
}

const BACKENDS: Backend[] = ['claude', 'glm'];
const BACKEND_DESCRIPTIONS: Record<string, string> = {
  claude: 'Official Anthropic Claude (default)',
  glm: 'GLM backend via open.bigmodel.cn',
};

export function handleBackend(_ctx: CommandContext, args: string): CommandResult {
  const config = loadConfig();

  if (!args) {
    const current = config.backend ?? 'claude';
    const lines = [
      '🔌 Current backend: ' + current,
      '',
      'Available backends:',
      ...BACKENDS.map(b => {
        const marker = b === current ? ' ←' : '';
        return `  ${b} — ${BACKEND_DESCRIPTIONS[b]}${marker}`;
      }),
      '',
      'Usage: /backend <name>',
    ];
    return { reply: lines.join('\n'), handled: true };
  }

  const backend = args.trim().toLowerCase() as Backend;
  if (!BACKENDS.includes(backend)) {
    return {
      reply: `Unknown backend: ${backend}\nAvailable: ${BACKENDS.join(', ')}`,
      handled: true,
    };
  }

  config.backend = backend;

  if (backend === 'glm' && !config.glmAuthToken) {
    return {
      reply: '⚠️ GLM auth token not configured.\n\nSet it in ~/.wechat-claude-code/config.env:\n  glmAuthToken=<your-token>',
      handled: true,
    };
  }

  saveConfig(config);
  applyBackendEnv(config);

  return {
    reply: `✅ Backend changed to: ${backend}\n${BACKEND_DESCRIPTIONS[backend]}`,
    handled: true,
  };
}

export function handleStatus(ctx: CommandContext): CommandResult {
  const s = ctx.session;
  const mode = s.permissionMode ?? 'default';
  const config = loadConfig();
  const backend = config.backend ?? 'claude';
  const lines = [
    '📊 Session status',
    '',
    `Working directory: ${s.workingDirectory}`,
    `Backend: ${backend}`,
    `Model: ${s.model ?? 'default'}`,
    `Permission mode: ${mode}`,
    `Session ID: ${s.sdkSessionId ?? 'none'}`,
    `State: ${s.state}`,
  ];
  return { reply: lines.join('\n'), handled: true };
}

export function handleSkills(args: string): CommandResult {
  invalidateSkillCache();
  const skills = getSkills();
  if (skills.length === 0) {
    return { reply: 'No installed skills found.', handled: true };
  }

  const showFull = args.trim().toLowerCase() === 'full';
  if (showFull) {
    const lines = skills.map(s => `/${s.name}\n   ${s.description}`);
    return { reply: `📋 Installed skills (${skills.length}):\n\n${lines.join('\n\n')}`, handled: true };
  }
  const lines = skills.map(s => `/${s.name}`);
  return { reply: `📋 Installed skills (${skills.length}):\n\n${lines.join('\n')}\n\nUse /skills full to see descriptions`, handled: true };
}

const MAX_HISTORY_LIMIT = 100;

export function handleHistory(ctx: CommandContext, args: string): CommandResult {
  const limit = args ? parseInt(args, 10) : 20;
  if (isNaN(limit) || limit <= 0) {
    return { reply: 'Usage: /history [n]\nExample: /history 50 (show the last 50 messages)', handled: true };
  }
  const effectiveLimit = Math.min(limit, MAX_HISTORY_LIMIT);

  const historyText = ctx.getChatHistoryText?.(effectiveLimit) || 'No conversation history yet';

  return { reply: `📝 Conversation history (last ${effectiveLimit}):\n\n${historyText}`, handled: true };
}

/** 完全重置会话（包括工作目录等设置） */
export function handleReset(ctx: CommandContext): CommandResult {
  ctx.rejectPendingPermission?.();
  const newSession = ctx.clearSession();
  newSession.workingDirectory = process.cwd();
  newSession.model = undefined;
  newSession.permissionMode = undefined;
  Object.assign(ctx.session, newSession);
  return { reply: '✅ Session fully reset. All settings restored to defaults.', handled: true };
}

/** 压缩上下文 — 清除 SDK 会话 ID，开始新上下文但保留聊天历史 */
export function handleCompact(ctx: CommandContext): CommandResult {
  const currentSessionId = ctx.session.sdkSessionId;
  if (!currentSessionId) {
    return { reply: 'ℹ️ No active SDK session to compact.', handled: true };
  }
  ctx.updateSession({
    previousSdkSessionId: currentSessionId,
    sdkSessionId: undefined,
  });
  return {
    reply: '✅ Context compacted.\n\nThe next message will start a new SDK session (tokens reset to 0).\nChat history is preserved — use /history to view.',
    handled: true,
  };
}

/** Claude Code 使用的 cwd → 项目目录名编码：所有非字母数字字符替换为 `-` */
function encodeCwdForProjects(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

function resolveCwd(p: string): string {
  return p.replace(/^~/, process.env.HOME || homedir());
}

/** 列出/恢复 Claude Code SDK 会话（按当前工作目录） */
export function handleResume(ctx: CommandContext, args: string): CommandResult {
  const cwd = resolveCwd(ctx.session.workingDirectory);
  const projectsDir = join(homedir(), '.claude', 'projects', encodeCwdForProjects(cwd));

  if (!args) {
    if (!existsSync(projectsDir)) {
      return {
        reply: `📂 No resumable sessions for the current working directory\n  Dir: ${cwd}\n  Expected storage: ${projectsDir}`,
        handled: true,
      };
    }
    let entries: { id: string; mtime: Date }[] = [];
    try {
      entries = readdirSync(projectsDir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => ({
          id: f.replace(/\.jsonl$/, ''),
          mtime: statSync(join(projectsDir, f)).mtime,
        }))
        .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
        .slice(0, 20);
    } catch (err) {
      return { reply: `❌ Failed to read sessions directory: ${(err as Error).message}`, handled: true };
    }
    if (entries.length === 0) {
      return { reply: `📂 No sessions for the current working directory\n  Dir: ${cwd}`, handled: true };
    }
    const lines = [
      `📂 Sessions for the current working directory (latest ${entries.length}):`,
      `  Dir: ${cwd}`,
      '',
      ...entries.map((e) => {
        const t = e.mtime.toLocaleString('en-US');
        return `  ${e.id}\n    Updated ${t}`;
      }),
      '',
      'Usage: /resume <session-id>',
    ];
    return { reply: lines.join('\n'), handled: true };
  }

  const newId = args.trim();
  const sessionFile = join(projectsDir, `${newId}.jsonl`);
  const exists = existsSync(sessionFile);

  ctx.rejectPendingPermission?.();
  ctx.updateSession({
    previousSdkSessionId: ctx.session.sdkSessionId,
    sdkSessionId: newId,
  });

  const warn = exists
    ? ''
    : `\n\n⚠️ Session file not found in the current working directory:\n  ${sessionFile}\nIf the session belongs to a different directory, run /cwd to switch first.`;
  return {
    reply: `✅ The next message will resume session: ${newId}${warn}\n\nNote: /history shows the bridge's own chat log, which is separate from the SDK session.`,
    handled: true,
  };
}

/** 撤销最近 N 条对话 */
export function handleUndo(ctx: CommandContext, args: string): CommandResult {
  const count = args ? parseInt(args, 10) : 1;
  if (isNaN(count) || count <= 0) {
    return { reply: 'Usage: /undo [n]\nExample: /undo 2 (undo the last 2 messages)', handled: true };
  }
  const history = ctx.session.chatHistory || [];
  if (history.length === 0) {
    return { reply: '⚠️ No messages to undo', handled: true };
  }
  const actualCount = Math.min(count, history.length);
  ctx.session.chatHistory = history.slice(0, -actualCount);
  ctx.updateSession({ chatHistory: ctx.session.chatHistory });
  return { reply: `✅ Undid the last ${actualCount} message(s)`, handled: true };
}

/** 查看版本信息 */
export function handleVersion(): CommandResult {
  try {
    const __dirname = fileURLToPath(new URL('.', import.meta.url));
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8'));
    const version = pkg.version || 'unknown';
    return { reply: `wechat-claude-code v${version}`, handled: true };
  } catch {
    return { reply: 'wechat-claude-code (version unknown)', handled: true };
  }
}

export function handlePrompt(_ctx: CommandContext, args: string): CommandResult {
  const config = loadConfig();
  if (!args) {
    const current = config.systemPrompt;
    if (current) {
      return { reply: `📝 Current system prompt:\n${current}\n\nUsage:\n/prompt <text>  — set\n/prompt clear   — clear`, handled: true };
    }
    return { reply: '📝 No system prompt set.\n\nUsage: /prompt <text>\nExample: /prompt Always answer in English', handled: true };
  }
  if (args.trim().toLowerCase() === 'clear') {
    config.systemPrompt = undefined;
    saveConfig(config);
    return { reply: '✅ System prompt cleared', handled: true };
  }
  config.systemPrompt = args.trim();
  saveConfig(config);
  return { reply: `✅ System prompt set:\n${config.systemPrompt}`, handled: true };
}

export function handleUnknown(cmd: string, args: string): CommandResult {
  const skills = getSkills();
  const skill = findSkill(skills, cmd);

  if (skill) {
    const prompt = args ? `Use the ${skill.name} skill: ${args}` : `Use the ${skill.name} skill`;
    return { handled: true, claudePrompt: prompt };
  }

  return {
    handled: true,
    reply: `Unknown skill: ${cmd}\nUse /skills to list available skills`,
  };
}
