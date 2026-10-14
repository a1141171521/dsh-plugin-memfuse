// 本地检索层：零网络、零向量、零 LLM。
//
// 这是对 Breezell 最关键的一处修正。Breezell 的语义检索全在云端，
// 断网/欠费时向量搜索直接返回 []，只剩一张 ~30 词的 CJK 停用表做
// includes() 子串匹配——系统最弱的一环恰好是唯一的兜底。
//
// 这里改成：本地词法打分作为唯一必需路径。向量若将来要加，
// 只能是"增强"，永远不能是"唯一"。
import { LEXICAL_W, SCORE, THRESHOLD, score, utility } from './policy.js';

// ───────────────────────── 分词 ─────────────────────────

const CJK = /[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/;

/** CJK 常用虚词：单字层面过滤，不参与 bigram —— 比维护停用词表稳健 */
const CJK_STOP = new Set([
  '的', '了', '是', '在', '有', '和', '与', '或', '这', '那', '个', '把', '被',
  '让', '给', '从', '到', '对', '着', '过', '吗', '呢', '吧', '啊', '哦', '嗯',
  '我', '你', '他', '她', '它', '们', '也', '就', '都', '还', '而', '但', '很',
  'の', 'は', 'が', 'を', 'に', 'で', 'と', 'も', 'へ', 'や', 'ね', 'よ',
]);

/**
 * 分词：
 *  - 拉丁字母/数字：按词
 *  - CJK：按 bigram（中文无需词典，bigram 召回率远高于子串匹配）
 *  - 过滤纯虚词构成的 bigram
 */
export function tokenize(text) {
  const s = String(text || '').toLowerCase();
  const out = [];

  for (const m of s.matchAll(/[a-z0-9][a-z0-9_.+\-]*/g)) out.push(m[0]);

  const runs = s.match(/[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]+/g) || [];
  for (const run of runs) {
    if (run.length === 1) {
      if (!CJK_STOP.has(run)) out.push(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i++) {
      const bg = run.slice(i, i + 2);
      // 两个字符都是虚词 → 丢弃
      if (CJK_STOP.has(bg[0]) && CJK_STOP.has(bg[1])) continue;
      out.push(bg);
    }
  }
  return out;
}

// ───────────────────────── 词法打分 ─────────────────────────

/**
 * 字段加权词法分，归一化到 [0,1]。
 * anchor 权重最高（3）—— 它是"何时该召回"的人工触发器描述，
 * 是 query-side 语义最廉价的替代物。
 */
export function lexicalScore(rec, queryTokens) {
  if (!queryTokens.length) return 0;

  const fields = {
    anchor: tokenize(rec.anchor || ''),
    tags: (rec.tags || []).flatMap((t) => tokenize(t)),
    title: tokenize(rec.title || ''),
    summary: tokenize(rec.summary || ''),
    body: tokenize(rec.body || ''),
  };

  let hits = 0;
  const K = queryTokens.length;
  for (const qt of new Set(queryTokens)) {
    for (const [name, toks] of Object.entries(fields)) {
      if (!toks.length) continue;
      if (toks.includes(qt)) {
        hits += LEXICAL_W[name] ?? 0.5;
        break; // 同一个 query token 只计一次（取最高权重字段）
      }
    }
  }

  const maxPerToken = Math.max(...Object.values(LEXICAL_W));
  return Math.max(0, Math.min(1, hits / Math.max(1, K * maxPerToken)));
}

// ───────────────────────── 检索 ─────────────────────────

/**
 * @param all        全部记忆（MemoryStore.list() 的结果）
 * @param query      用户当前输入
 * @param opts       { minScore, maxEntries, now }
 */
export function recall(all, query, opts = {}) {
  const now = opts.now ?? Date.now();
  const minScore = opts.minScore ?? THRESHOLD;
  const max = opts.maxEntries ?? 6;

  const pool = all.filter((r) => (r.lifecycle || 'active') === 'active');

  // 无 query：按优先级 + 效用返回（用于"常驻块"构建）
  if (!query || !String(query).trim()) {
    const rank = { P0: 0, P1: 1, P2: 2 };
    return pool
      .map((r) => ({ rec: r, s: score(r, 0, now), lexical: 0 }))
      .sort((a, b) => rank[a.rec.priority] - rank[b.rec.priority] || b.s - a.s)
      .slice(0, max);
  }

  const qTokens = tokenize(query);
  const scored = [];
  for (const rec of pool) {
    const lex = lexicalScore(rec, qTokens);
    // 词法零命中且非高优先级 → 直接跳过，省得让噪声占预算
    if (lex <= 0 && !(rec.priority === 'P0')) continue;
    const s = score(rec, lex, now);
    if (s < minScore) continue;
    scored.push({ rec, s, lexical: lex });
  }

  scored.sort((a, b) => b.s - a.s || b.lexical - a.lexical);

  // 同主题去重：kind + 归一化标题 只保留最高分
  const seen = new Set();
  const out = [];
  for (const item of scored) {
    const key = item.rec.kind + '\0' + String(item.rec.title || '').toLowerCase().replace(/\s+/g, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= max) break;
  }
  return out;
}

/** 常驻块：P0 且 active */
export function resident(all) {
  return all
    .filter((r) => (r.lifecycle || 'active') === 'active' && r.priority === 'P0')
    .sort((a, b) => Date.parse(b.updated || 0) - Date.parse(a.updated || 0));
}

export { tokenize as _tokenize };
