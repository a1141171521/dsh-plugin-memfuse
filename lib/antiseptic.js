/**
 * dsh-memfuse — 反腐烂（G）：重复检测 + stale 标记。
 *
 * ## 为什么只做保守子集
 *
 * 完整方案是"相似度聚类 + 七条裁决标准 + 正文合并"。这里**刻意只做前半段**，
 * 三条理由都来自实测过的坑：
 *
 *   1. **不做正文合并**。合并会丢信息 —— evolve 的事故就是 `replace` 只传增量，
 *      其余段落被静默吞掉（靠 git 备份才找回）。这里只做"标记"，原文永远保留。
 *   2. **不自动设 `conflict`**。那个标记带 **−0.35** 的打分惩罚，用启发式去设
 *      太激进（会把正常条目压到阈值以下、等于静默屏蔽）。潜在冲突只**报告**。
 *   3. **相似度聚类暂缓**。B5 cosine/dice 已移出清单；先做**零新机制**的精确检测
 *      （归一化标题 / 归一化摘要），它已经能覆盖绝大多数真实重复。
 *
 * 这一层只做三件事：**发现 → 标记 → 报告**。永不删除。
 *
 * @module dsh-memfuse/antiseptic
 */
import { normalizeTitle } from './policy.js';

/** 去空白 + 小写，用于正文比对。 */
const normBody = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();

/** 按 updated 倒序（新的在前）。 */
const byNewest = (a, b) => String(b.updated || b.created || '').localeCompare(String(a.updated || a.created || ''));

/**
 * 找出重复簇。
 *
 * 三类：
 *   - `exact`   —— 归一化标题**与**归一化正文都相同 → 真的同一条写了两遍
 *   - `title`   —— 归一化标题相同、正文不同 → 疑似同一件事的不同版本（可 supersede）
 *   - `summary` —— 归一化摘要相同、标题不同 → 疑似重复
 *
 * @returns {Array<{key: string, kind: string, members: Array}>}
 */
export function findDuplicateClusters(memories, opts = {}) {
  const max = opts.max ?? 20;
  const minSummaryChars = opts.minSummaryChars ?? 12;
  const active = memories.filter((r) => (r.lifecycle || 'active') === 'active');
  const clusters = [];

  const byTitle = new Map();
  for (const r of active) {
    const key = normalizeTitle(r.title);
    if (!key) continue;
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(r);
  }
  for (const [key, members] of byTitle) {
    if (members.length < 2) continue;
    const sorted = [...members].sort(byNewest);
    const bodies = new Set(sorted.map((m) => normBody(m.body)));
    clusters.push({ key, kind: bodies.size === 1 ? 'exact' : 'title', members: sorted });
  }

  const bySummary = new Map();
  for (const r of active) {
    const key = normBody(r.summary);
    if (key.length < minSummaryChars) continue; // 太短的摘要没有区分度
    if (!bySummary.has(key)) bySummary.set(key, []);
    bySummary.get(key).push(r);
  }
  for (const [key, members] of bySummary) {
    if (members.length < 2) continue;
    const titles = new Set(members.map((m) => normalizeTitle(m.title)));
    if (titles.size === 1) continue; // 标题也相同 → 上面已经报过了
    clusters.push({ key, kind: 'summary', members: [...members].sort(byNewest) });
  }

  return clusters.slice(0, max);
}

/**
 * 计划把哪些条目标成 `stale`。
 *
 * **只动 `exact` 簇里除最新那条以外的**：标题与正文都逐字相同才敢自动动手。
 * `title` / `summary` 簇只报告 —— 它们可能是"同一件事的新旧版本"，
 * 也可能只是"标题起得像"，由人或模型判断。
 *
 * 标记而非删除：`score()` 会给 stale 条目 −0.20 的降权，条目仍在磁盘上、可回滚。
 */
export function planStale(clusters) {
  const out = [];
  for (const c of clusters) {
    if (c.kind !== 'exact') continue;
    for (const m of c.members.slice(1)) {
      out.push({ id: m.id, supersededBy: c.members[0].id, reason: 'exact-duplicate' });
    }
  }
  return out;
}

/** 把簇渲染成给人看的多行报告。 */
export function renderClusters(clusters, limit = 8) {
  const label = { exact: '完全重复', title: '同标题不同正文', summary: '同摘要不同标题' };
  return clusters.slice(0, limit).map((c) => {
    const head = `  - [${label[c.kind] || c.kind}] ${c.members[0].title}（${c.members.length} 条）`;
    const rows = c.members.map((m, i) => `      ${i === 0 ? '保留' : '  · '} ${m.id}  ${m.priority || 'P2'}  ${String(m.updated || '').slice(0, 10)}`);
    return [head, ...rows].join('\n');
  });
}

/**
 * 潜在冲突报告（**只报告，不设 `conflict` 标记**）。
 *
 * 判据保守：归一化标题相同、正文不同、且都是 active。这只是"值得看一眼"，
 * 不是"确定矛盾" —— 语义矛盾检测需要模型，而 `conflict` 的 −0.35 惩罚
 * 不该由启发式来设。
 */
export function renderPotentialConflicts(clusters, limit = 5) {
  const risky = clusters.filter((c) => c.kind === 'title');
  if (!risky.length) return [];
  return [
    '  以下是「同标题、不同正文」的条目 —— 可能是新旧版本，也可能是真矛盾，请人工裁决：',
    ...risky.slice(0, limit).map(
      (c) => `  - ${c.members[0].title}：${c.members.map((m) => m.id).join(' / ')}`,
    ),
  ];
}
