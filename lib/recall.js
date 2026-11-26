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
 * 拉丁**停用词**：只收纯功能词。
 *
 * `excerpt()` 以前用 `low.includes(t)` 做子串匹配，查询 "what is a good build"
 * 里的单字母 `a` 会命中 "A quick note…" 的第一行 —— 摘录恒为无关内容（F-RC-03）。
 * 这里只服务摘录与「实义词命中」判断，不改 BM25 的 idf（那些词在 BM25 里本来就低权）。
 */
const LATIN_STOP = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'of', 'to', 'in', 'on', 'at', 'for', 'and', 'or', 'but', 'if', 'then',
  'it', 'its', 'this', 'that', 'these', 'those', 'as', 'by', 'from', 'with',
  'i', 'you', 'we', 'they', 'he', 'she', 'my', 'your', 'our', 'their',
]);

/**
 * 分词：
 *  - 拉丁字母/数字：按词（**词尾句读必须剥掉**，见下）
 *  - CJK：按 bigram（中文无需词典，bigram 召回率远高于子串匹配）
 *  - 过滤纯虚词构成的 bigram
 */
export function tokenize(text) {
  const s = String(text || '').toLowerCase();
  const out = [];

  // 拉丁分词：`.` 只有在**后面还跟字母数字**时才算词内（`node.js` / `state.json`）。
  // 旧写法 `[a-z0-9][a-z0-9_.+\-]*` 会把句末句号吞进 token：
  // `"This is memory."` → `["this","is","memory."]`，而查询侧一般写 `memory`
  // → 英文记忆**永远召回不到**，且没有任何日志（F-RC-02）。
  for (const m of s.matchAll(/[a-z0-9](?:[a-z0-9_+\-]|\.(?=[a-z0-9]))*/g)) out.push(m[0]);

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
 * 把一条记忆的五个字段各自分词（带字段权重），返回 { tf, len }。
 * 抽出来是为了「全库只分词一次」——`recall()` 每轮都会被调用，以前每次重算（F-RC-07）。
 */
function tokenizedDoc(rec) {
  const tf = new Map();
  for (const [field, w] of Object.entries(LEXICAL_W)) {
    const raw = field === 'tags' ? (rec.tags || []).join(' ') : rec[field];
    for (const t of tokenize(raw || '')) tf.set(t, (tf.get(t) || 0) + w);
  }
  let len = 0;
  for (const v of tf.values()) len += v;
  return { tf, len };
}

/**
 * 在**一个共享池**上建一份词法索引。
 *
 * 为什么要共享：旧 `bm25(pool, q)` 把每个池（active / dormant）各自按本池最大值
 * 归一化 —— 于是「池里只有 1 条、只要命中一个 bigram = 满分 1.0」，休眠的
 * `lexical >= 0.5` 门槛形同虚设；同一份内容在两个池里还会得到两个不同的分数（F-RC-01）。
 * 现在 IDF / 平均长度 / 归一化最大值全部来自**全库（active + dormant 合并）**，
 * 同一把尺子量所有条目。
 *
 * 同时给出 `coverage`（查询里有多少比例的 token 真的命中），供休眠门槛使用 ——
 * 它是**绝对证据强度**，不随池子大小漂移。
 */
export function lexicalIndex(pool, qTokens, { k1 = 1.2, b = 0.75 } = {}) {
  const N = pool.length;
  const docsByRec = new Map();
  for (const rec of pool) docsByRec.set(rec, tokenizedDoc(rec));
  const avgdl = N ? pool.reduce((s, r) => s + docsByRec.get(r).len, 0) / N || 1 : 1;

  const df = new Map();
  for (const rec of pool) {
    for (const t of docsByRec.get(rec).tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  }
  const idf = (t) => Math.log(1 + (N - (df.get(t) || 0) + 0.5) / ((df.get(t) || 0) + 0.5));

  const unique = [...new Set(qTokens)];
  const rawByRec = new Map();
  for (const rec of pool) {
    const d = docsByRec.get(rec);
    let s = 0;
    for (const t of unique) {
      const f = d.tf.get(t);
      if (!f) continue;
      s += idf(t) * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (d.len / avgdl))));
    }
    rawByRec.set(rec, s);
  }
  const maxRaw = Math.max(0, ...rawByRec.values());

  return {
    N,
    maxRaw,
    /** 全库归一化到 [0,1] 的词法分（同一份内容只有一个分数，与它在哪个池无关） */
    lexical(rec) {
      return maxRaw > 0 ? (rawByRec.get(rec) || 0) / maxRaw : 0;
    },
    /** 查询 token 的覆盖率 [0,1] —— 绝对证据强度，用于休眠门槛 */
    coverage(rec) {
      const d = docsByRec.get(rec);
      if (!d || !unique.length) return 0;
      let hit = 0;
      for (const t of unique) if (d.tf.has(t)) hit++;
      return hit / unique.length;
    },
    /** 原始 BM25 分（未归一化），排障用 */
    raw(rec) {
      return rawByRec.get(rec) || 0;
    },
  };
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
 * 单独调用时仍是「本池归一化」（冒烟测试用它比较字段权重）；`recall()` 走
 * `lexicalIndex()` 拿**全库**尺度。传 `opts.index` 可复用一份共享索引。
 *
 * @param {Array} pool       候选记忆
 * @param {string[]} qTokens 查询分词
 * @returns {number[]} 与 pool 同序，已归一化到 [0,1]
 */
export function bm25(pool, qTokens, opts = {}) {
  const index = opts.index ?? lexicalIndex(pool, qTokens, opts);
  return pool.map((rec) => index.lexical(rec));
}

/**
 * 从正文里挑出与查询最相关的一行（参照 `kb.js:278-292`）。
 *
 * 比固定注入 `summary` 更贴题，也更省 token：摘要说的是"这条讲什么"，
 * 摘录给的是"和你现在问的这句最相关的那一行"。没有命中行时返回空串，
 * 由调用方回退到 summary。
 */
export function excerpt(rec, query, max = 160) {
  // 停用词不参与摘录打分：否则查询里的 `a` / `is` 会让任何一行都算"命中"（F-RC-03）。
  const qTokens = [...new Set(tokenize(query))].filter((t) => !LATIN_STOP.has(t));
  const body = String((rec && rec.body) || '');
  if (!qTokens.length || !body) return '';
  let best = '';
  let bestScore = 0;
  for (const raw of body.split(/\r?\n/)) {
    const lineText = raw.trim().replace(/^[-*>|\s]+/, '');
    if (!lineText || lineText.startsWith('#')) continue;
    // **token 边界匹配**，不是子串包含：`a` 不该命中 "about"，`build` 也不该命中 "rebuild"。
    const lineTokens = new Set(tokenize(lineText));
    let hits = 0;
    let weight = 0;
    for (const t of qTokens) {
      if (!lineTokens.has(t)) continue;
      hits++;
      weight += t.length; // 长 token 更稀有：平局时偏向含实义词更多的那行
    }
    if (!hits) continue;
    const score = hits * 100 + weight;
    if (score > bestScore) {
      bestScore = score;
      best = lineText;
    }
  }
  return bestScore === 0 ? '' : clip(best, max);
}

// ───────────────────────── 检索 ─────────────────────────

/** 休眠条目进相关召回的最低**查询覆盖率**（绝对证据强度，不是池内相对分）。 */
export const DORMANT_MIN_COVERAGE = 0.5;

/**
 * @param all        全部记忆（MemoryStore.list() 的结果）
 * @param query      用户当前输入
 * @param opts       { minScore, minLexical, maxEntries, now, includeDormant }
 */
export function recall(all, query, opts = {}) {
  const now = opts.now ?? Date.now();
  const minScore = opts.minScore ?? THRESHOLD;
  // 注入用的**词法**门槛（inject.minScore）。与 score 的绝对底分分开：
  // 后者低于所有优先级的底分，调它等于没调（F-RC-06）。
  const minLexical = opts.minLexical ?? 0;
  const max = opts.maxEntries ?? 6;

  // 休眠不是死亡：过期只应降低默认在场率，不该让一条记忆永远不可达。
  // 老实现只把 active 放进池子，于是条目一旦过期就再也召不回来 ——
  // 而反馈/弱续期都挂在"被召回"上，信号恒为零 → 30 天后必被物理删除（单向棘轮）。
  // 现在休眠条目仍参与检索，但**必须靠词法证据**（休眠不该靠 P0/P1 底分复活）。
  const activePool = all.filter((r) => (r.lifecycle || 'active') === 'active');
  const dormantPool = opts.includeDormant === false ? [] : all.filter((r) => r.lifecycle === 'dormant');

  // 无 query：按优先级 + 效用返回（用于"常驻块"构建）
  if (!query || !String(query).trim()) {
    const rank = { P0: 0, P1: 1, P2: 2 };
    return activePool
      .map((r) => ({ rec: r, s: score(r, 0, now), lexical: 0, coverage: 0 }))
      .sort((a, b) => rank[a.rec.priority] - rank[b.rec.priority] || b.s - a.s)
      .slice(0, max);
  }

  const qTokens = tokenize(query);
  // 全库共享尺度：IDF / 平均长度 / 归一化最大值都来自 active + dormant 合并池（F-RC-01）
  const index = lexicalIndex(all, qTokens);
  const scored = [];

  const collect = (pool, { requireCoverage, poolName }) => {
    if (!pool.length) return;
    for (const rec of pool) {
      const l = index.lexical(rec);
      const cov = index.coverage(rec);
      if (requireCoverage) {
        // 休眠条目必须**真的**覆盖查询的一半以上 —— 池里只有它一条也不会变成满分
        if (cov < DORMANT_MIN_COVERAGE) continue;
      } else {
        // 活跃条目：词法零命中且非 P0 → 跳过，省得噪声占预算。
        // P0 的零命中豁免是有意设计（面板溢出文案依赖它，见 memory-view.explainRow）。
        if (l <= 0 && rec.priority !== 'P0') continue;
        // 词法门槛只作用于**有命中**的条目：0.18→0.31 的调整必须真的改变结果（F-RC-06）
        if (l > 0 && minLexical > 0 && l < minLexical) continue;
      }
      const s = score(rec, l, now);
      if (s < minScore) continue;
      scored.push({ rec, s, lexical: l, coverage: cov, pool: poolName });
    }
  };

  collect(activePool, { requireCoverage: false, poolName: 'active' });
  collect(dormantPool, { requireCoverage: true, poolName: 'dormant' });

  // 排序：分数优先，同分时活跃优先于休眠，再比词法
  scored.sort(
    (a, b) =>
      b.s - a.s ||
      (a.pool === b.pool ? 0 : a.pool === 'active' ? -1 : 1) ||
      b.lexical - a.lexical,
  );

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

/**
 * 常驻块：P0 且 active，**按"置顶时刻"倒序**。
 *
 * 判据只有 `priority === 'P0'` 一条 —— P0 永远不会被自动赋予
 * （`policy.shouldPromote` 只升 P2 → P1），所以这一块里的每一条都是用户显式置顶的。
 *
 * 排序为什么不是只按 `updated`（那正是原来那版）：
 *   1. 用户在面板上点「置顶」之后，**顺序必须稳定** —— 只按 `updated` 的话，
 *      任何一次"被召回续期"都会把那条顶走，用户改不动。
 *   2. `pinnedAt` 只在用户显式置顶时写入；没有它的老记录完全等价于旧行为
 *      （按 `updated` 排），所以升级后常驻块内容不会突变。
 *
 * 排序口径与 `lib/memory-view.js` 的 `compareResident()` 必须一致
 * （面板展示的顺序就是实际注入的顺序，两边不一致会让人以为面板错了）。
 */
export function resident(all) {
  const rows = all.filter((r) => (r.lifecycle || 'active') === 'active' && r.priority === 'P0');
  return rows.sort((a, b) => {
    const d = residentStamp(b) - residentStamp(a);
    return d !== 0 ? d : String(a.id ?? '').localeCompare(String(b.id ?? ''));
  });
}

/** 置顶时刻：显式 `pinnedAt` 优先，否则退回 `updated`（= 旧行为）。 */
function residentStamp(rec) {
  const pinned = Date.parse(rec?.pinnedAt || 0);
  if (Number.isFinite(pinned) && pinned > 0) return pinned;
  const updated = Date.parse(rec?.updated || 0);
  return Number.isFinite(updated) ? updated : 0;
}

export { tokenize as _tokenize };
