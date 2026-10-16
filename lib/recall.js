// 本地检索层：零网络、零向量、零 LLM。
//
// 这是对 云端超级记忆 最关键的一处修正。云端超级记忆 的语义检索全在云端，
// 断网/欠费时向量搜索直接返回 []，只剩一张 ~30 词的 CJK 停用表做
// includes() 子串匹配——系统最弱的一环恰好是唯一的兜底。
//
// 这里改成：本地词法打分作为唯一必需路径。向量若将来要加，
// 只能是"增强"，永远不能是"唯一"。
import { LEXICAL_W, THRESHOLD, score } from './policy.js';

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
 * CJK **双字**虚词黑名单。
 *
 * 单字过滤（`CJK_STOP`）挡不住"什么 / 怎么 / 哪个"这类**双字功能词** ——
 * 它们的两个字都不在单字停用表里，于是成了合法 bigram，能造出假命中。
 *
 * 真机实测（spec §3.12 缺陷 3）：查询 `"今天午饭吃什么"` 里的 `"什么"` 命中了
 * 某条记忆 anchor 中的 `"用什么包管理器"`，而 BM25 按最大值归一化后
 * **唯一的命中就是满分（lexical=1.000）**，排序上直接压过真正相关的条目。
 *
 * 只收**纯功能词**：代词 / 疑问词 / 连词 / 助词组合 / 客套语。
 * 刻意**不收**"可以 / 需要 / 必须 / 问题 / 今天"这类有实义倾向的词 ——
 * 宁可漏过噪声，也不要误杀真查询（误杀是静默的，噪声至少看得见）。
 */
const CJK_STOP_BIGRAM = new Set([
  // 疑问
  '什么', '怎么', '怎样', '咋样', '为啥', '为何', '哪些', '哪个', '哪种', '多少', '是否',
  // 代词 / 指示
  '我们', '你们', '他们', '她们', '它们', '咱们',
  '这个', '那个', '这些', '那些', '这里', '那里', '这种', '那种', '这样', '那样',
  '自己', '大家', '别人',
  // 连词 / 关联
  '因为', '所以', '但是', '可是', '不过', '如果', '虽然', '然后', '而且', '并且',
  '或者', '还是', '由于', '因此', '于是', '否则', '即使', '无论', '不管',
  // 助词组合
  '的话', '了吗', '了呢', '了吧', '了啊', '而已', '罢了',
  // 客套 / 泛量
  '请问', '谢谢', '麻烦', '一下', '一些', '一点',
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
      // 双字虚词（什么 / 怎么 / 哪个 …）→ 丢弃。它们的单字都不在 CJK_STOP 里，
      // 只靠上面那条挡不住，会造出假命中（见 CJK_STOP_BIGRAM 的注释）
      if (CJK_STOP_BIGRAM.has(bg)) continue;
      out.push(bg);
    }
  }
  return out;
}

// ───────────────────────── 打分 ─────────────────────────

/** 按字符预算截断（recall 不依赖 inject，避免循环 import）。 */
function clip(s, max) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (max <= 0) return '';
  if (t.length <= max) return t;
  return max === 1 ? t.slice(0, 1) : `${t.slice(0, max - 1)}…`;
}

/**
 * BM25 打分（字段加权版）。
 *
 * 相对原先的 `hits / (K × 3)` 补上了两件事：
 *   - **IDF**：罕见词比常用词值钱（原来所有命中词同权，等于没有区分度）
 *   - **文档长度归一**：长正文不再天然占便宜（`k1=1.2, b=0.75`）
 * 字段权重沿用 `LEXICAL_W`：同一个词出现在 `anchor` 里比出现在正文里
 * 贡献更多 term frequency（anchor 是"何时该召回"的人工触发器描述）。
 *
 * 参照 dsh-memory 的 `kb.js:210-276`（标准 BM25；这里在其上加了字段权重）。
 *
 * @param {Array} pool       候选记忆
 * @param {string[]} qTokens 查询分词
 * @returns {number[]} 与 pool 同序，已按最大值归一化到 [0,1]
 */
export function bm25(pool, qTokens, { k1 = 1.2, b = 0.75 } = {}) {
  const N = pool.length;
  if (!N || !qTokens.length) return new Array(N).fill(0);

  const docs = pool.map((rec) => {
    const tf = new Map();
    for (const [field, w] of Object.entries(LEXICAL_W)) {
      const raw = field === 'tags' ? (rec.tags || []).join(' ') : rec[field];
      for (const t of tokenize(raw || '')) tf.set(t, (tf.get(t) || 0) + w);
    }
    let len = 0;
    for (const v of tf.values()) len += v;
    return { tf, len };
  });

  const avgdl = docs.reduce((s, d) => s + d.len, 0) / N || 1;
  const df = new Map();
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  const idf = (t) => Math.log(1 + (N - (df.get(t) || 0) + 0.5) / ((df.get(t) || 0) + 0.5));

  const unique = [...new Set(qTokens)];
  const raw = docs.map((d) => {
    let s = 0;
    for (const t of unique) {
      const f = d.tf.get(t);
      if (!f) continue;
      s += idf(t) * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (d.len / avgdl))));
    }
    return s;
  });

  const max = Math.max(...raw);
  return max > 0 ? raw.map((s) => s / max) : raw;
}

/**
 * 从正文里挑出与查询最相关的一行（参照 `kb.js:278-292`）。
 *
 * 比固定注入 `summary` 更贴题，也更省 token：摘要说的是"这条讲什么"，
 * 摘录给的是"和你现在问的这句最相关的那一行"。没有命中行时返回空串，
 * 由调用方回退到 summary。
 */
export function excerpt(rec, query, max = 160) {
  const qTokens = [...new Set(tokenize(query))];
  const body = String((rec && rec.body) || '');
  if (!qTokens.length || !body) return '';
  let best = '';
  let bestHits = 0;
  for (const raw of body.split(/\r?\n/)) {
    const lineText = raw.trim().replace(/^[-*>|\s]+/, '');
    if (!lineText || lineText.startsWith('#')) continue;
    const low = lineText.toLowerCase();
    let hits = 0;
    for (const t of qTokens) if (low.includes(t)) hits++;
    if (hits > bestHits) {
      bestHits = hits;
      best = lineText;
    }
  }
  return bestHits === 0 ? '' : clip(best, max);
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
  const lex = bm25(pool, qTokens);
  const scored = [];
  for (let i = 0; i < pool.length; i++) {
    const rec = pool[i];
    const l = lex[i];
    // 词法零命中且非高优先级 → 直接跳过，省得让噪声占预算
    if (l <= 0 && rec.priority !== 'P0') continue;
    const s = score(rec, l, now);
    if (s < minScore) continue;
    scored.push({ rec, s, lexical: l });
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
