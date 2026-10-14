// 记忆策略层：准入、生命周期、打分权重、反腐烂。
//
// 全部是纯函数，不依赖 DSH 运行时 —— 便于单测，也保证核心逻辑
// 在任何宿主里都能跑（README P3：LLM/宿主在侧路，不在关键路径）。
//
// 主要借鉴 Breezell 的 memoryPolicyService / memoryInjectionPolicy，
// 因为那是三家产品里唯一真正把"记忆会腐烂"当问题解决的实现。

// ───────────────────────── 打分权重 ─────────────────────────
// 与 Breezell 的原始系数相比，此处上调了 priority / confidence，
// 下调了纯词法占比：因为我们是本地检索，词法噪声更大，
// 需要让显式的用户信号（优先级）和证据强度承担更多权重。

export const SCORE = {
  lexical: 0.55,
  priority: 0.18,
  confidence: 0.12,
  utility: 0.08,
  freshness: 0.07,
  stalePenalty: 0.20,
  conflictPenalty: 0.35,
};

export const PRIORITY_W = { P0: 1.0, P1: 0.78, P2: 0.3 };
export const DEFAULT_PRIORITY_W = 0.2;

/** 字段权重：anchor（"何时该召回"）权重最高。
 *  这是 Breezell 最巧妙的一个设计——用人工写的触发器描述，
 *  作为 query-side 向量语义的廉价替代物。 */
export const LEXICAL_W = {
  anchor: 3,
  tags: 3,
  title: 2,
  summary: 1,
  body: 0.5,
};

export const THRESHOLD = 0.18;

/** 准入阈值 */
export const ADMIT = {
  durableMin: 0.75, // durable 且置信度≥此值 → P1
  reusableMin: 0.6, // 置信度≥此值 或 evidence∈{repeated,explicit} → P2
};

/** 生效的最小耐久度取值 */
export const DURABILITY = new Set(['durable', 'temporary', 'turn_local']);
export const EVIDENCE = new Set(['explicit', 'implicit', 'repeated', 'resolved_outcome']);

// ───────────────────────── 生命周期 ─────────────────────────

/** P0 永不过期；P1/P2 按配置天数 */
export function computeExpiry(priority, cfg = {}, now = Date.now()) {
  if (priority === 'P0') return null;
  const days = priority === 'P1' ? (cfg.p1Days ?? 30) : (cfg.p2Days ?? 7);
  return new Date(now + days * 86400000).toISOString();
}

/** 被召回时的"弱续期"：只小幅延长，取 max(现有, 新) */
export function weakRenew(priority, cfg = {}, currentExpires = null, now = Date.now()) {
  if (priority === 'P0') return null;
  const days = priority === 'P1' ? (cfg.p1WeakRenewDays ?? 3) : (cfg.p2WeakRenewDays ?? 1);
  const next = now + days * 86400000;
  const cur = currentExpires ? Date.parse(currentExpires) : 0;
  return new Date(Math.max(Number.isFinite(cur) ? cur : 0, next)).toISOString();
}

/** 反馈驱动的效用分：负面权重 1.5×（保守，宁缺毋滥） */
export function utility(stats = {}) {
  const p = stats.positive || 0;
  const n = stats.negative || 0;
  const denom = p + n * 1.5;
  if (denom <= 0) return 0;
  return Math.max(-1, Math.min(1, (p - n * 1.5) / denom));
}

/** 新鲜度：90 天线性衰减 */
export function freshness(updatedAt, now = Date.now()) {
  const t = Date.parse(updatedAt || 0);
  if (!Number.isFinite(t)) return 0.5;
  const days = (now - t) / 86400000;
  return Math.max(0, Math.min(1, 1 - days / 90));
}

// ───────────────────────── 打分 ─────────────────────────

/**
 * @param rec        记忆记录
 * @param lexical    归一化词法分 [0,1]
 */
export function score(rec, lexical, now = Date.now()) {
  const pw = PRIORITY_W[rec.priority] ?? DEFAULT_PRIORITY_W;
  const conf = clamp01(rec.confidence ?? 0.5);
  const util = utility(rec.stats);
  const fresh = freshness(rec.updated, now);

  let s =
    SCORE.lexical * lexical +
    SCORE.priority * pw +
    SCORE.confidence * conf +
    SCORE.utility * ((util + 1) / 2) +
    SCORE.freshness * fresh;

  if (rec.stale) s -= SCORE.stalePenalty;
  if (rec.conflict) s -= SCORE.conflictPenalty;

  return Math.max(0, Math.min(1, s));
}

function clamp01(x) {
  return Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));
}

// ───────────────────────── 准入（借鉴 Breezell，已简化）─────────────────────────

/**
 * 决定一条候选记忆的去向。
 * 关键原则：LLM 只判断语义（durability / confidence / evidence），
 * 优先级由代码规则决定，P0 只有用户能给。
 */
export function classify(candidate) {
  const c = normalize(candidate);
  if (!c) return { action: 'discard', reason: 'invalid_candidate' };

  if (c.durability === 'turn_local') {
    return { action: 'discard', reason: 'turn_local', candidate: c };
  }
  if (c.durability === 'durable' && c.confidence >= ADMIT.durableMin) {
    return { action: 'create', priority: 'P1', reason: 'durable_high_confidence', candidate: c };
  }
  if (c.confidence >= ADMIT.reusableMin || c.evidence === 'repeated' || c.evidence === 'explicit') {
    return { action: 'create', priority: 'P2', reason: 'reusable_candidate', candidate: c };
  }
  return { action: 'discard', reason: 'low_confidence', candidate: c };
}

/** 字段归一化 + 长度钳制 */
export function normalize(candidate) {
  if (!candidate || typeof candidate !== 'object') return null;
  const kind = String(candidate.kind || 'fact');
  if (!['fact', 'convention', 'decision', 'constraint', 'skill', 'experience'].includes(kind)) return null;
  if (!DURABILITY.has(candidate.durability)) return null;
  if (!EVIDENCE.has(candidate.evidence)) return null;

  const confidence = Number(candidate.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;

  const title = String(candidate.title || '').trim();
  const summary = String(candidate.summary || '').trim();
  const body = String(candidate.body || '').trim();
  if (!title || !body) return null;

  return {
    kind,
    title: title.slice(0, 80),
    summary: summary.slice(0, 300),
    body: body.slice(0, 8000),
    durability: candidate.durability,
    confidence,
    evidence: candidate.evidence,
    anchor: candidate.anchor ? String(candidate.anchor).trim().slice(0, 300) : '',
    tags: Array.isArray(candidate.tags)
      ? [...new Set(candidate.tags.filter((t) => typeof t === 'string').map((t) => t.trim()).filter(Boolean))].slice(0, 12)
      : [],
    scope: candidate.scope === 'global' ? 'global' : 'workspace',
  };
}

/** 批次内去重键：scope + kind + 归一化标题 */
export function dedupeKey(c) {
  return [c.scope, c.kind, normalizeTitle(c.title)].join('\0');
}

export function normalizeTitle(t) {
  return String(t || '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。！？、；：""''（）《》【】·,.;:!?"'()<>[\]{}]/g, '')
    .trim();
}

/** 批次内去重，保留高置信度 */
export function dedupeBatch(candidates, max = 6) {
  const seen = new Map();
  for (const c of candidates.slice(0, max * 2)) {
    const n = normalize(c);
    if (!n) continue;
    const k = dedupeKey(n);
    const prev = seen.get(k);
    if (!prev || n.confidence > prev.confidence) seen.set(k, n);
  }
  return [...seen.values()].slice(0, max);
}

// ───────────────────────── 反腐烂 ─────────────────────────

/** 合并丢失熔断：合并后正文不得短于原文的比例 */
export function mergeAllowed(oldBody, newBody, floor = 0.7) {
  const oldLen = (oldBody || '').length;
  if (oldLen === 0) return true;
  return (newBody || '').length >= oldLen * floor;
}

/** 用户资产：不可被自动合并/删除/淘汰 */
export function isProtected(rec) {
  return rec.priority === 'P0' || rec.source === 'user' || rec.managedBy === 'user';
}

/** 淘汰排序：P2 先出局，其次效用低、反馈少、久未确认 */
export function compareForDormancy(a, b) {
  const prot = (r) => (isProtected(r) ? 1 : 0);
  const d0 = prot(a) - prot(b);
  if (d0 !== 0) return d0;

  const rank = (r) => (r.priority === 'P2' ? 0 : r.priority === 'P1' ? 1 : 2);
  const d1 = rank(a) - rank(b);
  if (d1 !== 0) return d1;

  const d2 = utility(a.stats) - utility(b.stats);
  if (d2 !== 0) return d2;

  const ta = Date.parse(a.updated || a.created || 0) || 0;
  const tb = Date.parse(b.updated || b.created || 0) || 0;
  if (ta !== tb) return ta - tb;

  return String(a.id).localeCompare(String(b.id));
}

/**
 * 预算淘汰：超出上限时把最该遗忘的转为 dormant。
 * 返回应转 dormant 的 id 列表。
 */
export function planEviction(all, budget = {}) {
  const active = all.filter((r) => (r.lifecycle || 'active') === 'active');
  const byBucket = { memories: [], skills: [] };
  for (const r of active) {
    const b = r.kind === 'skill' || r.kind === 'experience' ? 'skills' : 'memories';
    byBucket[b].push(r);
  }
  const out = [];
  const limits = { memories: budget.maxMemories ?? 400, skills: budget.maxSkills ?? 200 };
  for (const [bucket, rows] of Object.entries(byBucket)) {
    const over = rows.length - limits[bucket];
    if (over <= 0) continue;
    const evictable = rows.filter((r) => !isProtected(r)).sort(compareForDormancy);
    out.push(...evictable.slice(0, over).map((r) => r.id));
  }
  return out;
}

/**
 * 物理删除计划：dormant 且零反馈、且休眠超过阈值。
 * 受保护的记录永不出现在结果里。
 */
export function planPurge(all, cfg = {}, now = Date.now()) {
  const days = cfg.purgeDormantAfterDays ?? 30;
  const cutoff = now - days * 86400000;
  return all
    .filter((r) => (r.lifecycle || 'active') === 'dormant')
    .filter((r) => !isProtected(r))
    .filter((r) => ((r.stats?.positive || 0) + (r.stats?.negative || 0)) === 0)
    .filter((r) => {
      const t = Date.parse(r.dormantAt || r.updated || 0);
      return Number.isFinite(t) && t <= cutoff;
    })
    .map((r) => r.id);
}
