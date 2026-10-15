/**
 * dsh-memfuse — 技能提炼（H）。
 *
 * ## 核心判断
 *
 * **skill 是记忆的「编译产物」，不是记忆的一种。**
 *
 *   记忆 = 事实 / 偏好（"这个仓库用 pnpm"）
 *   skill = 可复用的流程（"接手一个陌生仓库时，按这五步摸底"）
 *
 * 所以提炼的触发条件**不是"攒够 N 条记忆"，而是"同一类问题被解决了 ≥K 次"** ——
 * 重复性才是流程的证据。
 *
 * ## 分工
 *
 * - **候选识别是零 LLM 的**（打分 + 聚类），每次启动都能跑，结果进 `status.md`；
 * - **提炼才需要模型**，而且**只由工具显式触发** —— 技能会真实改变 AI 行为，
 *   不该在后台悄悄生成。
 *
 * 本模块全是纯函数或"注入 callModel"的形式，所以不需要真模型就能测。
 *
 * @module dsh-memfuse/distill
 */
import { buildSkillMd, isSkillName, slugifySkillName, validateSkill } from './skill.js';

/** 步骤性内容的标记（"先…再…" / "第一步" / 有序列表 …）。 */
const STEP_MARKERS = [
  /先.{0,12}再/,
  /第一步/,
  /步骤/,
  /流程/,
  /如果.{0,10}则/,
  /按以下/,
  /依次/,
  /^\s*\d+[.、)]\s/m,
];

/**
 * 给一条记忆打"值不值得固化成技能"的分。
 * @returns {{score: number, reasons: string[]}}
 */
export function scoreCandidate(rec, opts = {}) {
  const reasons = [];
  let score = 0;
  if (!rec) return { score: 0, reasons };

  if (rec.kind === 'skill' || rec.kind === 'experience') {
    score += 3;
    reasons.push('本身就是 skill/experience 类记忆');
  }

  const sessions = rec.sessionCount || 0;
  const minSessions = opts.minSessions ?? 3;
  if (sessions >= minSessions) {
    score += 2;
    reasons.push(`跨 ${sessions} 个会话被召回`);
  } else if (sessions >= 2) {
    score += 1;
    reasons.push(`跨 ${sessions} 个会话被召回`);
  }

  const hay = `${rec.title || ''}\n${rec.summary || ''}\n${rec.body || ''}`;
  if (STEP_MARKERS.some((re) => re.test(hay))) {
    score += 2;
    reasons.push('含步骤性内容');
  }

  const recalled = (rec.stats && rec.stats.recalled) || 0;
  if (recalled >= 3) {
    score += 1;
    reasons.push(`被召回 ${recalled} 次`);
  }
  if (rec.priority === 'P0') {
    score += 1;
    reasons.push('用户置顶');
  }
  return { score, reasons };
}

/**
 * 找出够格的候选（按分排序）。
 * @returns {Array<{rec: object, score: number, reasons: string[]}>}
 */
export function findCandidates(memories, opts = {}) {
  const minScore = opts.minScore ?? 4;
  const limit = opts.limit ?? 5;
  return memories
    .filter((r) => (r.lifecycle || 'active') === 'active')
    .map((rec) => ({ rec, ...scoreCandidate(rec, opts) }))
    .filter((x) => x.score >= minScore)
    .sort((a, b) => b.score - a.score || String(b.rec.updated).localeCompare(String(a.rec.updated)))
    .slice(0, limit);
}

/**
 * 以 seed 为中心聚一个簇：共享标签最多的邻居。
 *
 * 刻意不引入新的相似度机制 —— 标签是**人已经写好的**分组信息，
 * 比任何自动相似度都更可信、也更好解释（"它们都带 #pnpm 标签"）。
 */
export function clusterAround(seed, memories, max = 6) {
  const seedTags = new Set(seed.tags || []);
  if (!seedTags.size) return [seed];
  const mates = memories
    .filter((r) => r.id !== seed.id && (r.lifecycle || 'active') === 'active')
    .map((r) => ({ r, shared: (r.tags || []).filter((t) => seedTags.has(t)).length }))
    .filter((x) => x.shared > 0)
    .sort((a, b) => b.shared - a.shared || String(b.r.updated).localeCompare(String(a.r.updated)));
  return [seed, ...mates.slice(0, Math.max(0, max - 1)).map((x) => x.r)];
}

/** 把一个簇渲染成喂给模型的文本。 */
export function buildClusterText(cluster) {
  return cluster
    .map((r, i) =>
      [
        `### ${i + 1}. ${r.title}`,
        `kind: ${r.kind}  priority: ${r.priority}  confidence: ${r.confidence}`,
        r.anchor ? `何时该召回: ${r.anchor}` : '',
        r.summary ? `摘要: ${r.summary}` : '',
        r.body ? `正文:\n${r.body}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n\n');
}

/** 提炼用的系统提示词。 */
export const DISTILL_SYSTEM = [
  '你是技能提炼器。把给定的若干条记忆提炼成**一个可复用的技能**，只输出严格 JSON 对象。',
  '',
  '硬约束：',
  '1. 技能是「流程」，不是「事实」。只写"下次遇到同类任务该怎么做"的步骤。',
  '2. name 必须是 kebab-case 的**纯 ASCII**（小写字母/数字/连字符），如 repo-onboarding、pnpm-migration。',
  '3. description 必须一行写清「什么时候该用这个技能」，不要复述步骤。',
  '4. body 用 Markdown 分步骤写，每步具体到能照着做。',
  '5. 不要把项目专有事实（路径、IP、人名、凭据、公司名）写进技能 —— 技能要跨任务复用。',
  '6. 如果这些记忆凑不出一个真正的流程，输出 {"skip":"原因"}，不要硬凑。',
  '',
  '输出格式（只输出 JSON 对象，不要代码围栏，不要解释）：',
  '{"name":"kebab-case-name","description":"一句话：什么时候用","body":"## 步骤\\n1. ..."}',
].join('\n');

/**
 * 容错解析模型输出里的 JSON 对象（剥围栏、取首尾大括号）。
 *
 * ⚠️ **先试数组**：提示词要求输出对象，但真实模型经常包成 `[{…}]`
 * （真机实测 deepseek-flash 就是这么答的）。此时"取首尾大括号"的切法在
 * **多元素**数组下会切出 `{…},{…}` → `JSON.parse` 失败 → 报
 * 「无法解析为 JSON 对象」——而模型其实答得好好的。
 *
 * 取数组里的**第一个对象**最合理：提炼本来就是"给一个簇产出一个技能"。
 */
export function parseSkillObject(text) {
  let s = String(text || '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();

  const aStart = s.indexOf('[');
  const aEnd = s.lastIndexOf(']');
  if (aStart !== -1 && aEnd > aStart) {
    try {
      const arr = JSON.parse(s.slice(aStart, aEnd + 1));
      if (Array.isArray(arr)) {
        const first = arr.find((x) => x && typeof x === 'object' && !Array.isArray(x));
        if (first) return first;
      }
    } catch {
      /* 不是合法数组 —— 落到下面的对象分支 */
    }
  }

  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(s.slice(start, end + 1));
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}

/**
 * 跑一轮提炼。
 * @param {{cluster: Array, callModel: (input: string) => Promise<string>, maxBytes?: number}} opts
 * @returns {Promise<{ok: boolean, name?: string, content?: string, description?: string, error?: string, skipped?: boolean}>}
 */
export async function distillSkill({ cluster, callModel, maxBytes = 65536 }) {
  if (!Array.isArray(cluster) || !cluster.length) return { ok: false, error: '簇为空' };
  let raw = '';
  try {
    raw = await callModel(buildClusterText(cluster));
  } catch (e) {
    return { ok: false, error: `模型调用失败：${e.message}` };
  }
  const obj = parseSkillObject(raw);
  if (!obj) {
    return { ok: false, error: `模型输出无法解析为 JSON 对象（前 200 字：${String(raw).slice(0, 200)}）` };
  }
  if (obj.skip) return { ok: false, skipped: true, error: `模型判断这些记忆凑不出流程：${obj.skip}` };

  // 名字非法时**不整条丢弃**（那种静默丢弃正是我们要防的），而是退化成哈希名
  const name = isSkillName(obj.name) ? obj.name : slugifySkillName(obj.name || cluster[0].title, cluster[0].id);

  // 字段兜底：真实模型偶尔会漏 `description`（真机实测 deepseek-flash 会）。
  // **不整条丢弃** —— 那正是"静默失败"要防的形状。用簇里的信息补一个可读的，
  // 并且下面报错时把模型实际给的键带出来，免得下次又要猜。
  const description =
    String(obj.description || '').trim() ||
    `从 ${cluster.length} 条记忆提炼：${String(cluster[0].title || '').slice(0, 80)}`.slice(0, 160);
  const bodyText =
    String(obj.body || '').trim() || ['## 背景', '', ...cluster.map((r) => `- ${r.title}`)].join('\n');

  const content = buildSkillMd({ name, description, body: bodyText });
  const check = validateSkill({ name, content, maxBytes });
  if (!check.ok) {
    return {
      ok: false,
      error: `${check.error}｜模型给的键：${Object.keys(obj).join(',') || '(无)'}`,
    };
  }
  return { ok: true, name, content, description: check.parsed.description };
}
