/**
 * dsh-memfuse — 写入前的凭据 / 敏感信息扫描。
 *
 * ## 动机
 *
 * 云端超级记忆 的自动抽取把 **25 条内网 IP、8 条疑似口令**写进了本地记忆库。
 * 记忆是这个系统里**扩散性最强**的东西：它每轮被注入上下文、进 git 提交、
 * 进 status.md、进 usage 日志、还可能被抽成技能。把凭据写进去，等于把它
 * 复制到上面每一个地方，而且**你永远不会知道**。
 *
 * ## 策略
 *
 * - 显式写入（`memfuse_write`）：**拒绝**，并指出命中了哪一类 —— 不回显命中内容本身
 *   （回显等于把凭据再打印一遍到对话和日志里）。
 * - 自动捕获（turn/end 原始问答落盘）：**替换**成占位符而不是整轮丢弃 ——
 *   丢掉整轮会连带丢掉同一轮里其他有价值的信息。
 *
 * 宁可误拒一条记忆，也不要静默泄露一次凭据。
 *
 * @module dsh-memfuse/guard
 */

/** 命中即视为敏感的模式表。label 会出现在拒绝理由里，所以不要写成泄密提示。 */
const PATTERNS = [
  ['私钥块', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['OpenAI 风格密钥', /\bsk-[A-Za-z0-9_-]{16,}\b/],
  ['AWS Access Key', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub Token', /\bgh[pousr]_[A-Za-z0-9]{20,}\b/],
  ['Bearer Token', /\bBearer\s+[A-Za-z0-9._-]{20,}/i],
  ['连接串内含凭据', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]{3,}@/i],
  ['凭据赋值', /\b(pass(?:word|wd)?|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*[^\s]{6,}/i],
  ['中文口令赋值', /(密码|口令|密钥|令牌)\s*[:：=]\s*[^\s，。；]{4,}/],
];

/**
 * 扫描文本里是否含疑似凭据。
 * @param {string} text - 待检查的文本（标题 / 摘要 / 锚点 / 正文拼起来）。
 * @returns {string | null} 命中的类别名，未命中返回 null。
 */
export function scanThreat(text) {
  const s = String(text || '');
  if (!s) return null;
  for (const [label, re] of PATTERNS) {
    if (re.test(s)) return label;
  }
  return null;
}

/**
 * 把所有命中的片段替换成占位符（用于自动捕获，不丢整轮内容）。
 * @param {string} text - 原文。
 * @returns {{text: string, hits: string[]}} 替换后的文本与命中的类别列表。
 */
export function redactThreats(text) {
  let out = String(text || '');
  const hits = [];
  for (const [label, re] of PATTERNS) {
    const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
    const global = new RegExp(re.source, flags);
    if (global.test(out)) {
      hits.push(label);
      out = out.replace(new RegExp(re.source, flags), `[已过滤：${label}]`);
    }
  }
  return { text: out, hits };
}

export { PATTERNS as _patterns };
