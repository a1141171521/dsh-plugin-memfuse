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
 * 「方法类」记忆的标记：审查要点、检查清单、原则、教训、坑。
 *
 * 2026-11-24 用户反馈：一直在写概要设计，提炼出来的"技能"全是某次改稿的
 * 一步步修改（"6.6 改为状态通知"这种），不是可复用方法。
 * 根因是候选只看「跨会话 + 含步骤词」，而设计修订记录天然带"第一步/修改"。
 * 现在候选必须先是**方法**（能脱离这份文档讲"下次怎么做"），
 * 纯修订记录（改哪一节、删哪个字段）不进候选。
 */
const METHOD_MARKERS = [
  /审查|检查|核对|清单|要点|原则|教训|坑|反直觉|高频缺陷|典型缺陷|易错|陷阱|铁律/,
];

/**
 * 标题里的「方法信号」。只看标题，不看正文 —— 正文里到处都是"核对""清单"
 * （"回改清单""核对 PRD 规则 6 时召回"），拿正文判会把决策记录全放进来。
 */
const METHOD_TITLE = /审查|检查|清单|要点|原则|教训|坑|铁律|流程|步骤|做法|方法/;

/** 标题带日期（多半是"某次评审/某天改完"的修订记录）。 */
const DATED_REVIEW_TITLE = /[（(]\s*\d{4}-\d{2}-\d{2}[^）)]*[）)]/;

/** 标题直接写"改为/删除/新增"：这是某次改稿动作，不是方法。 */
const CHURN_TITLE = /改为|改成|删掉|删除|新增|补充|调整为|更新为|修订|回改|对齐/;

/** 修订痕迹（评分用）：出现得越多，越像"这次改了什么"。 */
const CHURN_MARKERS = [
  /改为|改成|删掉|删除|新增|补充|调整为|更新为|修订|回改|对齐原型|定稿/,
];

/** 具体文档坐标（章节号 / 条款号 / 本次 / 评审）—— 方法里不该绑死这些。 */
const DOC_COORD_MARKERS = [
  /《[^》]+》/,
  /\b\d+(\.\d+){1,3}\b/,
  /第\s*\d+\s*[节条]/,
  /\b[A-Z]{1,3}-\d{2,3}\b/,
  /本次|这一轮|这版/,
];

/**
 * 这条记忆是不是「可复用方法」，而不是「某次文档修订记录」。
 *
 * 判据放在**标题**上（2026-11-24 实测）：
 *   - "6.6 改为状态通知：…（2026-11-04 评审）"   → 改稿动作 + 日期 → false
 *   - "标记完成提示语按原型原文对齐（2026-11-14 评审）" → 日期评审 → false
 *   - "配方申请概要设计审查：一码两义/…"          → 标题含"审查" → true
 *   - "部署要走 scripts/deploy.sh"                → 无修订痕迹 → true
 * 正文不参与判定：设计文档正文天然含"清单/核对/流程"，用正文判会误杀不准。
 */
export function isMethodMemory(rec) {
  if (!rec) return false;
  const title = String(rec.title || '');
  if (METHOD_TITLE.test(title)) return true;
  if (DATED_REVIEW_TITLE.test(title)) return false;
  if (CHURN_TITLE.test(title)) return false;
  return true;
}

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

  // 方法类记忆额外加分：审查清单 / 原则 / 踩坑教训 才是能复用的东西
  if (METHOD_MARKERS.some((re) => re.test(hay))) {
    score += 2;
    reasons.push('是可复用方法（审查要点/原则/教训）');
  }
  // 修订记录减分：改哪一节、删哪个字段，不是技能
  const churn = CHURN_MARKERS.filter((re) => re.test(hay)).length;
  const coords = DOC_COORD_MARKERS.filter((re) => re.test(hay)).length;
  if (churn >= 2 && coords >= 1) {
    score -= 2;
    reasons.push('更像文档修订记录，不是可复用方法');
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
  // 种子是方法类时，只把**同样是方法类**的邻居聚进来（2026-11-24）：
  // 否则一条"审查要点"会把 5 条"某次改稿记录"带进簇，提炼出来就是修订流水账。
  const methodSeed = isMethodMemory(seed);
  const mates = memories
    .filter((r) => r.id !== seed.id && (r.lifecycle || 'active') === 'active')
    .filter((r) => (methodSeed ? isMethodMemory(r) : true))
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
  '你是「可复用方法」提炼器。把给定的若干条记忆提炼成**一个能脱离具体项目复用的方法**，只输出严格 JSON 对象。',
  '',
  '要什么（2026-11-24 用户纠正后的方向）：',
  '- 操作流程：下次遇到同类任务，按哪几步做；',
  '- 审查清单：审这类文档/代码时，逐项检查什么；',
  '- 避坑规则：出现什么症状 → 根因是什么 → 该怎么处理。',
  '',
  '不要什么：',
  '- 不要「这次这份文档改了什么」：某章节改成什么、某字段新增/删除、某次评审的结论 —— 那是修订记录，不是技能。',
  '- 不要把具体文档的编号、条款号、版本号写进步骤里。',
  '',
  '硬约束：',
  '1. 读者只看 body 就能照着做，不需要看你提的那几份文档。',
  '2. body 用 Markdown 分三节：## 适用场景 / ## 步骤（或 ## 检查清单） / ## 验收与反例。',
  '3. 每步要写「做什么 + 为什么/判据」，不要只写"修改 X 为 Y"。',
  '4. description 一行写清「什么时候该用这个技能」，不要复述步骤。',
  '5. name 必须是 kebab-case 的**纯 ASCII**（小写字母/数字/连字符），如 design-review-checklist。',
  '6. 不要把项目专有事实（路径、IP、人名、凭据、公司名）写进技能 —— 技能要跨任务复用。',
  '7. 如果这组记忆主要是某个文档/某次评审的修订记录，或者凑不出可复用方法，输出 {"skip":"原因"}，不要硬凑成步骤。',
  '',
  '输出格式（只输出 JSON 对象，不要代码围栏，不要解释）：',
  '{"name":"kebab-case-name","description":"一句话：什么时候用","body":"## 适用场景\\n...\\n## 步骤\\n1. ...\\n## 验收与反例\\n..."}',
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

// ───────────────────── 建议（零 LLM）─────────────────────
//
// 目标：让插件在"有东西够格提炼"时**主动提示**用户，并且**零模型调用**。
//
// 为什么不在这里调模型生成技能正文：注入是每轮都跑的关键路径，
// 一旦在这里调模型，就同时违反三条纪律 —— 关键路径零 LLM、
// 不该在后台悄悄生成技能、以及每轮都烧 token。
//
// 所以"预览"给的是**簇级别的语义**（这组记忆在讲什么、什么时候该用、
// 为什么够格），足以让用户判断要不要提炼；真正生成 SKILL.md 正文
// 要等用户点头之后（`memfuse_skill action=distill`）。

/**
 * 簇的稳定身份：**种子 id**（`clusterAround` 的契约：`cluster[0]` 永远是种子）。
 *
 * 为什么不再用「成员 id 排序后拼接」（缺陷 42）：那个 key 会随**簇内成员churn**变化 ——
 * `clusterAround` 只取共享标签最多的前 5 个邻居，新记忆一进来就把末尾的邻居挤掉，
 * 于是同一个话题每隔十几分钟就换一个 key。用户点「不用」记的是旧 key，
 * 下一张卡换 key 后照样弹（现场 15 次「不用」、6 个 key 只差 1–2 个成员）。
 *
 * 现在的语义：**一个候选（种子）就是一个话题身份**。只要还是这条记忆在驱动建议，
 * 无论簇里又长进来多少邻居，key 都不变 → 「不用」是真的不用；
 * 换了一条记忆成为候选（新种子）才会得到新 key，再提一次。
 */
export function clusterKey(cluster) {
  const seed = Array.isArray(cluster) ? cluster[0] : null;
  return seed && seed.id ? `seed:${seed.id}` : '';
}

/** 从簇推导主题标签：成员共享的标签（越多成员带它越可信）。 */
export function sharedTags(cluster) {
  if (!cluster.length) return [];
  const counts = new Map();
  for (const r of cluster) {
    for (const t of new Set(r.tags || [])) counts.set(t, (counts.get(t) || 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= Math.max(2, Math.ceil(cluster.length / 2)))
    .sort((a, b) => b[1] - a[1])
    .map(([t]) => t)
    .slice(0, 4);
}

/**
 * 把候选种子 + 邻居簇整理成一条建议。
 *
 * `useWhen` 直接取种子的 `anchor` —— 它的语义本来就是
 * "未来什么情况下该召回我"，正好回答了"这个技能是干什么用的"，
 * 而且不需要任何模型参与。
 */
export function buildSuggestion(seed, cluster, score, reasons) {
  const tags = sharedTags(cluster);
  return {
    key: clusterKey(cluster),
    seedId: seed.id,
    seedTitle: seed.title,
    score,
    reasons: reasons || [],
    tags,
    useWhen: String(seed.anchor || '').trim(),
    members: cluster.map((r) => ({ id: r.id, title: r.title, kind: r.kind })),
  };
}

/**
 * 生成全部建议，并**滤掉已被用户忽略的**。
 *
 * @param memories   全部记忆
 * @param opts       { minScore, minSessions, limit, perClusterMax }
 * @param dismissed  已忽略表 { [clusterKey]: true }
 */
export function buildSuggestions(memories, opts = {}, dismissed = {}) {
  const limit = opts.limit ?? 5;
  // 种子先扫全量合格记忆，数量上限留到聚簇、去重和忽略过滤之后。
  // 否则前五颗种子已忽略/同簇，就会把后面真正的新建议永久挡住。
  const seeds = findCandidates(memories, { ...opts, limit: memories.length });
  const out = [];
  // 去重口径跟着 key 一起改（缺陷 42）：key 现在是「种子」，不再等于「整簇成员」，
  // 所以不能再用 key 判重 —— 同一簇里的两个种子会得到两个 key，卡片就重复了。
  // 这里按**成员重叠**判重：种子已经出现在前面某一簇里，就说明是同一个话题。
  const usedMembers = new Set();
  for (const { rec, score, reasons } of seeds) {
    // 只收「可复用方法」：文档修订记录（改哪一节、删哪个字段）不进候选。
    // 用户原话（2026-11-24）："提取的技能内容都是我在调整概要设计时一步一步修改的内容"。
    if (!isMethodMemory(rec)) continue;
    if (usedMembers.has(rec.id)) continue;
    const cluster = clusterAround(rec, memories, opts.perClusterMax ?? 6);
    for (const r of cluster) usedMembers.add(r.id);
    const s = buildSuggestion(rec, cluster, score, reasons);
    // 已忽略 —— 不再骚扰。注意：成员已经标记为 used，所以同一话题不会换个种子又弹。
    if (dismissed[s.key]) continue;
    out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 把建议渲染成注入用的文本行（零 LLM，纯字符串拼装）。
 * @returns {string[]}
 */
export function renderSuggestions(list, max = 1) {
  const picked = list.slice(0, Math.max(1, max));
  if (!picked.length) return [];
  const lines = [];
  for (const s of picked) {
    const tagText = s.tags.length ? `（共享标签 ${s.tags.map((t) => `#${t}`).join(' ')}）` : '';
    lines.push(`**${s.seedTitle}**${tagText} —— 共 ${s.members.length} 条方法类记忆（只提炼可复用的方法/清单，不收「这次改了什么」）`);
    if (s.useWhen) lines.push(`· 作用：${s.useWhen}`);
    const members = s.members
      .slice(0, 4)
      .map((m) => m.title)
      .join(' / ');
    if (members) lines.push(`· 成员：${members}${s.members.length > 4 ? ` 等 ${s.members.length} 条` : ''}`);
    if (s.reasons.length) lines.push(`· 够格理由：${s.reasons.slice(0, 3).join('；')}`);
  }
  if (list.length > picked.length) {
    lines.push(`（另有 ${list.length - picked.length} 组同类候选，用 memfuse_skill action=list 查看）`);
  }
  lines.push(
    '要提炼就说"提炼"，我会生成草稿给你过目（真正装进技能库仍需你确认）；' +
      '不想要就说"不用"，我不会再提这一组。',
  );
  return lines;
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
    // ── 兜底（2026-11-24，缺陷 40）────────────────────────────────────────
    // 模型有时不按 JSON 返回，只写一段人话/思考。**别让用户什么都看不到**：
    // 只要它确实写了足够长的正文，就把原文当成草稿给用户过目（标记 `salvaged`，
    // 界面会说明"这是模型原文、不是按格式提炼的"，装不装由用户决定）。
    // 草稿本来就要人点「装进技能库」，所以这里不会污染技能库。
    const body = String(raw || '').trim();
    if (body.length >= 40) {
      const name = slugifySkillName(cluster[0].title, cluster[0].id);
      const description = `从 ${cluster.length} 条记忆提炼（模型没按格式返回，正文是它的原文）`;
      const content = buildSkillMd({ name, description, body });
      const check = validateSkill({ name, content, maxBytes });
      if (check.ok) return { ok: true, name, description, content, salvaged: true };
      return { ok: false, salvaged: true, error: `模型没按格式返回，兜底草稿也没通过校验：${check.error}` };
    }
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

  // 兜底校验（2026-11-24）：提示词说了"不要修订记录"，但模型可能照旧把
  // "6.6 改为状态通知 / 新增字段 X" 写成步骤。这里按修订动词 + 章节坐标计数，
  // 命中太多就明确拒绝（skipped），而不是把流水账装进技能库。
  const churnHits = (bodyText.match(/改为|改成|删掉|删除|新增|补充|调整为|更新为|修订|回改/g) || []).length;
  const coordHits = (bodyText.match(/\b\d+(\.\d+){1,3}\b|第\s*\d+\s*[节条]|\b[A-Z]{1,3}-\d{2,3}\b/g) || []).length;
  if (churnHits >= 3 || (churnHits >= 2 && coordHits >= 2)) {
    return {
      ok: false,
      skipped: true,
      error: `提炼结果更像这份文档这次的修订记录（修订动词 ${churnHits} 处 / 章节编号 ${coordHits} 处），不是可复用方法 —— 换个角度提炼，或先把记忆整理成「审查清单 / 步骤」`,
    };
  }

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
