/**
 * dsh-memfuse — stage1 抽取管线（F2）。
 *
 * ## 设计原则
 *
 * **LLM 在侧路，不在关键路径。** 读 / 写 / 注入 / 检索全都不需要模型；
 * 只有这个模块需要，而且关掉它（`extract.model` 留空）一切照常 ——
 * 这正是 Codex 缺的韧性（它的管线死了三周，什么都不剩）。
 *
 * ## 素材来源
 *
 * 不直接读会话，而是读 `sessions/<date>.md` —— 那是 F1 的零 LLM 兜底捕获
 * 落下来的原始问答。这样即使模型永远不可用，素材也已经躺在磁盘上。
 *
 * ## 本模块只做纯逻辑
 *
 * 提示词、解析、准入、偏好识别、去重 —— 全部是纯函数或"注入 callModel"
 * 的形式，所以**不需要真模型就能测**。真正的 `ctx.llm.stream(...)` 调用
 * 在 index.js 里。
 *
 * @module dsh-memfuse/extract
 */
import * as policy from './policy.js';
import { scanThreat } from './guard.js';

/**
 * 偏好句模式。
 *
 * 偏好是"懂我"的核心 —— 事实谁都能查，但"以后都别用 npm"这种只有用户能给。
 * 命中即提高置信度并允许升到 P1（**P0 仍然只能由用户给**）。
 */
const PREFERENCE_PATTERNS = [
  /以后都/, /不要再/, /不要用/, /别用/, /我习惯/, /我通常/, /我更(?:喜欢|倾向)/,
  /记住/, /一律/, /统一用/, /从现在起/, /下次/, /禁止/,
  /\balways\b/i, /\bnever\b/i, /\bprefer\b/i, /from now on/i,
];

/** 文本是否像"用户在表达偏好"。 */
export function looksLikePreference(text) {
  const s = String(text || '');
  return PREFERENCE_PATTERNS.some((re) => re.test(s));
}

/** 抽取用的系统提示词。硬约束借鉴三家产品的教训。 */
export const EXTRACT_SYSTEM = [
  '你是记忆抽取器。从给定的对话片段里抽取「跨会话仍然有用」的内容，只输出严格 JSON。',
  '',
  '硬约束：',
  '1. 只抽跨会话仍然有用的内容。一次性指令（"这次先跳过 lint"）、临时状态（"正在跑测试"）必须丢弃。',
  '2. 不要分配优先级 —— 优先级由宿主代码按 durability + confidence 决定；只有用户能确认 P0。',
  '3. 用对话的主导语言书写，不要翻译。',
  '4. 必须给出 anchor（"未来什么情况下该召回它"），不要复制内容。',
  '5. 偏好类内容（"以后都…" / "不要…" / "我习惯…"）单独抽成一条，kind 用 convention。',
  '6. 不要抽取任何凭据、密钥、口令、内网地址、连接串。',
  '',
  '输出格式（只输出 JSON 数组，不要代码围栏，不要任何解释）：',
  '[{"kind":"fact|convention|decision|constraint|skill|experience",',
  '  "title":"一行标题，≤80字",',
  '  "summary":"一句话摘要，≤300字",',
  '  "body":"完整正文",',
  '  "anchor":"未来什么情况下该召回它",',
  '  "tags":["..."],',
  '  "durability":"durable|temporary|turn_local",',
  '  "confidence":0.0,',
  '  "evidence":"explicit|implicit|repeated|resolved_outcome"}]',
].join('\n');

/**
 * 解析模型输出里的 JSON 数组（容错）。
 * 剥代码围栏、截取首个 `[` 到末个 `]` —— 模型多写一段解释是常态。
 */
export function parseCandidates(text) {
  let s = String(text || '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return [];
  try {
    const arr = JSON.parse(s.slice(start, end + 1));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/**
 * 模型是否**明确**回答"本轮没有值得记的"（一个合法的空数组）。
 *
 * 必须与"解析失败"分开：前者是正常结果，后者是管线故障。
 * 混在一起（都返回 `[]`）会让**每一轮空结果都写 `lastExtractError`**，
 * 攒够时间后触发 Block D 的假告警"⚠️ 自动抽取已停止 N 天" ——
 * 假故障和静默失败一样有害，而"失败可见"正是本插件的差异化之一。
 */
export function isExplicitEmptyArray(text) {
  let s = String(text || '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  if (!s.startsWith('[') || !s.endsWith(']')) return false;
  try {
    const arr = JSON.parse(s);
    return Array.isArray(arr) && arr.length === 0;
  } catch {
    return false;
  }
}

/**
 * 输出看着像**被截断**吗？（结尾没有 `]` / `}` 收尾）
 *
 * 真机实测（2026-10-15）：模型把 JSON 写到一半就撞上 `maxTokens`，
 * 消息里那"前 200 字"看着完全合法，整段却是坏的 —— 只说"无法解析"，
 * 用户会以为是模型乱答，而不是"预算不够"。**提示必须能把人引向正确的下一步。**
 */
function truncationHint(text) {
  const trimmed = String(text || '').trim();
  if (trimmed === '') return '';
  if (trimmed.endsWith(']') || trimmed.endsWith('}')) return '';
  return ' —— 输出像是**被截断**了（结尾不是 ] 或 }）：多半是 maxTokens 不够；重试一次，或给抽取换一个不"先想很久"的模型';
}

/**
 * 跑一轮抽取。
 *
 * @param {object} opts
 * @param {string} opts.text        原始问答文本（来自 sessions/*.md）
 * @param {(input: string) => Promise<string>} opts.callModel 注入的模型调用
 * @param {number} [opts.maxCandidates]
 * @returns {Promise<{candidates: Array, error: string|null, raw: string}>}
 */
export async function extractCandidates({ text, callModel, maxCandidates = 6 }) {  const input = String(text || '').slice(0, 12000);
  if (!input.trim()) return { candidates: [], error: null, raw: '' };

  let raw = '';
  try {
    raw = await callModel(input);
  } catch (e) {
    return { candidates: [], error: `模型调用失败：${e.message}`, raw: '' };
  }

  const parsed = parseCandidates(raw);
  if (!parsed.length) {
    // 模型**明确**返回空数组（"本轮没有值得记的"）是正常结果，不是故障。
    // 只有真的解析不出数组才算失败 —— 否则每轮空结果都写 lastExtractError，
    // 最终触发 Block D 的假告警（假故障和静默失败一样有害）。
    if (isExplicitEmptyArray(raw)) return { candidates: [], error: null, raw };
    return {
      candidates: [],
      error: `模型输出无法解析为候选数组（前 200 字：${String(raw).slice(0, 200)}）${truncationHint(raw)}`,
      raw,
    };
  }

  // ① 字段归一化 + 准入（这两步原来都是死代码：normalize/classify 从没被调用过）
  const admitted = [];
  let droppedThreat = 0;
  for (const c of parsed.slice(0, maxCandidates * 2)) {
    const norm = policy.normalize(c);
    if (!norm) continue;
    // 防"把凭据抽进记忆"（Breezell 就是这么把 25 条内网 IP、8 条口令写进库的）
    if (scanThreat([norm.title, norm.summary, norm.body, norm.anchor].join('\n'))) {
      droppedThreat++;
      continue;
    }
    const verdict = policy.classify(norm);
    if (verdict.action !== 'create') continue;
    admitted.push({ ...norm, priority: verdict.priority, _reason: verdict.reason });
  }

  // ② 批次内去重（同 scope + kind + 归一化标题，保留高置信）
  const seen = new Map();
  for (const c of admitted) {
    const key = policy.dedupeKey(c);
    const prev = seen.get(key);
    if (!prev || c.confidence > prev.confidence) seen.set(key, c);
  }

  // ③ 偏好句加成：命中即升 P1（P0 仍只归用户）
  const candidates = [...seen.values()].slice(0, maxCandidates).map((c) => {
    const isPref = looksLikePreference(`${c.title}\n${c.summary}\n${c.body}`);
    if (!isPref) return { ...c, _preference: false };
    return {
      ...c,
      kind: c.kind === 'fact' ? 'convention' : c.kind,
      confidence: Math.max(c.confidence, 0.9),
      priority: 'P1',
      _preference: true,
    };
  });

  return { candidates, error: null, raw, droppedThreat };
}

/**
 * 把候选转成待确认项（E6 队列里的形状）。
 * @param {Array} candidates
 * @param {string} source 来源文件（便于追溯是哪天的会话抽出来的）
 */
export function toPendingItems(candidates, source) {
  const now = new Date().toISOString();
  return candidates.map((c, i) => ({
    id: `p_${Date.now().toString(36)}_${i}_${Math.random().toString(36).slice(2, 6)}`,
    kind: c.kind,
    priority: c.priority,
    confidence: c.confidence,
    title: c.title,
    summary: c.summary,
    body: c.body,
    anchor: c.anchor,
    tags: c.tags || [],
    scope: c.scope || 'workspace',
    source: 'extract',
    sourceFile: source,
    preference: c._preference === true,
    reason: c._reason || '',
    createdAt: now,
  }));
}
