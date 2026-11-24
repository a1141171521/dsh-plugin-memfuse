// 记忆面板的**纯函数**层。
//
// 为什么单独一个文件（而不是全塞进 lib/index.js 或 lib/client.js）：
//
//   1. 面板要回答的问题（"哪些记忆在常驻"、"哪些排不进去"、"改成 P0 会挤掉谁"）
//      全是**派生计算**，不是运行时状态。把它们写成纯函数就能在 node 里直接测，
//      而浏览器半边（`lib/client.js`）在本仓库里跑不进 `node --test`。
//   2. 同一份计算宿主（`lib/index.js` 的 `memfuse/memories` 端点）与界面都要用。
//      两边各写一遍必然漂 —— 本项目已经因为"两侧各存一套"踩过坑（`skillSeen`）。
//   3. 关键路径零 LLM（README P3）：这些函数只碰记录本身，不调模型、不读盘。
//
// ⚠️ 不要在这里引入任何 `node:` 之外的依赖 —— 这个模块会被**宿主** import，
// 但它的语义是"纯数据变换"，将来若要复用进浏览器 bundle 也只需去掉 import。
//
// ── 「常驻」的口径（与 lib/recall.js 的 resident() 必须一致）────────────────
// 常驻 = `priority === 'P0'` 且 `lifecycle === 'active'`。没有第二个入口，
// P0 也永远不会被自动赋予（`policy.shouldPromote` 只升 P2 → P1）。
// 排序在 resident() 里做（按 `pinnedAt || updated` 倒序），这里只做**展示与溢出计算**。

/** 优先级从高到低的序（用于排序）。 */
export const PRIORITY_RANK = { P0: 0, P1: 1, P2: 2 };

/** 合法的优先级取值（写回时校验）。 */
export const VALID_PRIORITIES = ['P0', 'P1', 'P2'];

/** 面板默认一页多少条（记忆库可能有几百条，一次全塞给浏览器没意义）。 */
export const VIEW_PAGE_SIZE = 50;

/**
 * 「置顶时刻」：显式置顶优先，其次退回最近更新时间。
 *
 * 为什么需要显式字段：只按 `updated` 排序的话，用户**改不动顺序** ——
 * 任何一次"被召回续期"都会把条目顶到最前，用户想固定的那条会被挤走。
 * `pinnedAt` 只在用户从面板上按「置顶」时写入，之后不受召回影响。
 *
 * ⚠️ 没有 `pinnedAt` 的老记录**完全等价于旧行为**（按 updated 排），
 * 所以这条排序规则对既有数据是向后兼容的 —— 升级后常驻块内容不会突变。
 */
export function residentSortKey(rec) {
  const pinned = Date.parse(rec?.pinnedAt || 0);
  if (Number.isFinite(pinned) && pinned > 0) return pinned;
  const updated = Date.parse(rec?.updated || 0);
  return Number.isFinite(updated) ? updated : 0;
}

/** 常驻块的顺序：置顶时刻倒序（新的在前），同刻按 id 兜底求稳定。 */
export function compareResident(a, b) {
  const d = residentSortKey(b) - residentSortKey(a);
  if (d !== 0) return d;
  return String(a?.id ?? '').localeCompare(String(b?.id ?? ''));
}

/** 一条记录是不是「常驻」（与 recall.js 的 resident() 同一判据）。 */
export function isResident(rec) {
  return (rec?.lifecycle || 'active') === 'active' && rec?.priority === 'P0';
}

/**
 * 面板里的排序：**先按能不能常驻，再按优先级，再按新鲜度**。
 *
 * 用户打开面板最想看的是"我现在有哪些置顶、哪些 P1 值得提上去"，
 * 所以 P0 永远在最前；同一优先级内新的在前（与 `resident()` 的口径一致）。
 */
export function compareForPanel(a, b) {
  const pa = PRIORITY_RANK[a?.priority] ?? 9;
  const pb = PRIORITY_RANK[b?.priority] ?? 9;
  if (pa !== pb) return pa - pb;
  // active 在 dormant 之前：休眠条目还在磁盘上，但已经不参与注入
  const la = (a?.lifecycle || 'active') === 'active' ? 0 : 1;
  const lb = (b?.lifecycle || 'active') === 'active' ? 0 : 1;
  if (la !== lb) return la - lb;
  const ta = Date.parse(a?.updated || 0) || 0;
  const tb = Date.parse(b?.updated || 0) || 0;
  if (ta !== tb) return tb - ta;
  return String(a?.id ?? '').localeCompare(String(b?.id ?? ''));
}

/**
 * 把一条完整记录压成**面板行**。
 *
 * 刻意**不带正文**：记忆库可能有几百条，每条正文几千字，整个塞给浏览器
 * 既慢又没意义（用户要的是"有哪几条、哪条该置顶"）。正文只给字数，
 * 需要看全文时界面提示去用 `memfuse_recall`（或未来的详情抽屉）。
 */
export function toViewRow(rec) {
  const stats = rec?.stats || {};
  return {
    id: String(rec?.id ?? ''),
    title: String(rec?.title ?? ''),
    summary: String(rec?.summary ?? ''),
    anchor: String(rec?.anchor ?? ''),
    priority: String(rec?.priority ?? 'P2'),
    lifecycle: String(rec?.lifecycle ?? 'active'),
    scope: String(rec?.scope ?? 'workspace'),
    kind: String(rec?.kind ?? 'fact'),
    tags: Array.isArray(rec?.tags) ? rec.tags.slice(0, 12) : [],
    updated: String(rec?.updated ?? ''),
    created: String(rec?.created ?? ''),
    expires: rec?.expires ? String(rec.expires) : null,
    pinnedAt: rec?.pinnedAt ? String(rec.pinnedAt) : null,
    stale: rec?.stale === true,
    // 常驻 / 可复活 / 受保护 —— 界面据此决定摆哪些按钮，别让它自己再推一遍
    resident: isResident(rec),
    dormant: (rec?.lifecycle || 'active') === 'dormant',
    protected: rec?.priority === 'P0' || rec?.source === 'user' || rec?.managedBy === 'user',
    bodyChars: String(rec?.body ?? '').length,
    stats: {
      recalled: Number(stats.recalled) || 0,
      injected: Number(stats.injected) || 0,
      positive: Number(stats.positive) || 0,
      negative: Number(stats.negative) || 0,
    },
    sessionCount: Number(rec?.sessionCount) || 0,
  };
}

/** 统计（面板顶部那几行数字）。 */
export function computeStats(all, residentMaxEntries = 8) {
  const rows = Array.isArray(all) ? all : [];
  const by = { P0: 0, P1: 0, P2: 0 };
  const scopes = { workspace: 0, user: 0, global: 0 };
  const kinds = {};
  let active = 0;
  let dormant = 0;
  let stale = 0;
  for (const rec of rows) {
    const p = String(rec?.priority ?? 'P2');
    if (p in by) by[p] += 1;
    const scope = String(rec?.scope ?? 'workspace');
    if (scope in scopes) scopes[scope] += 1;
    const kind = String(rec?.kind ?? 'fact');
    kinds[kind] = (kinds[kind] || 0) + 1;
    if ((rec?.lifecycle || 'active') === 'dormant') dormant += 1;
    else active += 1;
    if (rec?.stale === true) stale += 1;
  }
  const cap = Number.isFinite(residentMaxEntries) ? Math.max(1, Math.trunc(residentMaxEntries)) : 8;
  return {
    total: rows.length,
    active,
    dormant,
    stale,
    byPriority: by,
    byScope: scopes,
    byKind: kinds,
    residentCap: cap,
    // 常驻**块**里真正能出现的条数 = min(P0 active 条数, 上限)。
    // 超过上限的那些仍带 P0 标记，但每轮注入看不到它们 —— 必须让用户知道（见 buildView）。
    residentCount: Math.min(by.P0, cap),
    residentOverflow: Math.max(0, by.P0 - cap),
  };
}

/**
 * 组装面板要的整份视图。
 *
 * @param all - `store.list()` 的全量记录
 * @param opts - `{ residentMaxEntries, page, pageSize, query, priority, lifecycle, scope }`
 * @returns `{ stats, resident, overflow, rows, page, totalMatches, filters }`
 *
 * ⚠️ `resident` / `overflow` 是**分开的两组 id**：
 *   前者是每轮真的会注入的那几条（顺序就是注入顺序），
 *   后者是"带着 P0 标记却挤不进去"的那几条 —— 这是当前实现的一个静默行为
 *   （`buildInjection` 里 `resident(all).slice(0, cfg.residentMaxEntries)` 之后
 *   多出来的直接丢掉，不报错、不提示）。面板必须把它显式说出来，否则用户
 *   会以为"我置顶了 12 条，那就 12 条都生效"。
 */
export function buildView(all, opts = {}) {
  const rows = (Array.isArray(all) ? all : []).map(toViewRow);
  rows.sort(compareForPanel);

  const residentRows = rows.filter((r) => r.resident).sort(compareResident);
  const cap = Number.isFinite(opts.residentMaxEntries)
    ? Math.max(1, Math.trunc(opts.residentMaxEntries))
    : 8;
  const resident = residentRows.slice(0, cap).map((r) => r.id);
  const overflow = residentRows.slice(cap).map((r) => r.id);

  const filtered = filterRows(rows, opts);
  const pageSize = Number.isFinite(opts.pageSize) ? Math.max(1, Math.trunc(opts.pageSize)) : VIEW_PAGE_SIZE;
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const page = Math.min(Math.max(1, Math.trunc(opts.page || 1) || 1), pageCount);
  const slice = filtered.slice((page - 1) * pageSize, page * pageSize);

  return {
    stats: computeStats(all, cap),
    resident,
    overflow,
    rows: slice,
    page,
    pageSize,
    pageCount,
    totalMatches: filtered.length,
    filters: {
      query: String(opts.query ?? ''),
      priority: String(opts.priority ?? ''),
      lifecycle: String(opts.lifecycle ?? ''),
      scope: String(opts.scope ?? ''),
    },
  };
}

/**
 * 过滤（纯字符串，不引正则 —— 用户输入里的 `(` `[` 不该让面板崩）。
 *
 * `query` 匹配 title / summary / anchor / tags，全小写比对。
 * 空条件 = 不筛。`priority: 'resident'` 是便捷项：只看常驻那几条。
 */
export function filterRows(rows, filters = {}) {
  const q = String(filters.query ?? '').trim().toLowerCase();
  const priority = String(filters.priority ?? '');
  const lifecycle = String(filters.lifecycle ?? '');
  const scope = String(filters.scope ?? '');
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    if (priority === 'resident') {
      if (!row.resident) return false;
    } else if (priority !== '' && row.priority !== priority) return false;
    if (lifecycle !== '' && row.lifecycle !== lifecycle) return false;
    if (scope !== '' && row.scope !== scope) return false;
    if (q === '') return true;
    const hay = [row.title, row.summary, row.anchor, ...(row.tags || [])].join('\n').toLowerCase();
    return hay.includes(q);
  });
}

/**
 * 规划一次优先级变更 —— **只算，不写**。
 *
 * 界面按这个结果先告诉用户"会发生什么"，再让他确认（这是本项目
 * "不许静默"在交互上的落地：置顶到第 9 条会挤掉最旧那条，不能在用户
 * 点完之后悄悄发生）。
 *
 * @returns `{ ok, error?, id, from, to, residentBefore, residentAfter, pushedOut: [id], revived }`
 *   或 `{ ok: false, error }`。
 */
export function planPriorityChange(all, id, nextPriority, opts = {}) {
  const rows = Array.isArray(all) ? all : [];
  if (!VALID_PRIORITIES.includes(nextPriority)) {
    return { ok: false, error: `优先级只能是 ${VALID_PRIORITIES.join(' / ')}，收到「${nextPriority}」` };
  }
  const target = rows.find((r) => String(r?.id) === String(id));
  if (!target) return { ok: false, error: `没有 id 为「${id}」的记忆` };

  const cap = Number.isFinite(opts.residentMaxEntries)
    ? Math.max(1, Math.trunc(opts.residentMaxEntries))
    : 8;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const before = rows.filter(isResident).sort(compareResident).map((r) => String(r.id));

  // 模拟改动后的常驻集合。降级要看目标本来在不在、升级要看会不会挤出别人。
  const nextRows = rows.map((r) => {
    if (String(r?.id) !== String(id)) return r;
    // 置顶时写 pinnedAt（这是"用户判定它最常用"的唯一证据，也是排到最前的依据；
    // 不写的话它只能按 updated 排，任何一次召回续期都会把它挤下去）。
    // 降级时清掉，免得以后又升回 P0 时带着一个旧的置顶时刻。
    if (nextPriority === 'P0') {
      const stamp = opts.pinnedAt || new Date(now).toISOString();
      return { ...r, priority: 'P0', pinnedAt: stamp };
    }
    return { ...r, priority: nextPriority, pinnedAt: null };
  });
  const after = nextRows.filter(isResident).sort(compareResident).map((r) => String(r.id));
  // ⚠️ 比对基准是 `before.slice(0, cap)` —— **原本真正可见的那几条**，不是"全部 P0"。
  // 用全部 P0 去比会把"本来就挤不进去的"也报成"被这次改动挤掉了"，
  // 而那是假消息：它一直都不在注入里（本函数第一版就错了这一处）。
  const visibleBefore = before.slice(0, cap);
  const visibleAfter = after.slice(0, cap);

  return {
    ok: true,
    id: String(id),
    from: String(target.priority ?? 'P2'),
    to: nextPriority,
    // 目标本来就在休眠：只改优先级**不会**让它回到注入里（那要 mode=revive）。
    // 如实告诉界面，否则用户会以为"改了 P0 就生效了"。
    dormant: (target.lifecycle || 'active') !== 'active',
    residentBefore: visibleBefore,
    residentAfter: visibleAfter,
    // 本次改动把谁挤出了常驻块（空数组 = 没挤掉任何"原来在里面的"）
    pushedOut: after.slice(cap).filter((x) => visibleBefore.includes(x)),
    // 仍在溢出区（本来就挤不进去）的总数，界面用来提示"还有 N 条 P0 看不见"
    stillOverflow: after.length - visibleAfter.length,
    enteredResident: visibleAfter.filter((x) => !visibleBefore.includes(x)),
    targetVisible: visibleAfter.includes(String(id)),
    cap,
  };
}

/**
 * 面板上"这条记忆为什么没生效"的一句话解释。
 *
 * 四种非正常态都存在，而且用户从列表上分辨不出来：
 *   - `overflow`：带 P0 标记但挤不进常驻块（**不再固定在开头**，仍可能走相关召回）
 *   - `dormant`：休眠，只在被高相关查询命中时才会自动唤醒
 *   - `stale`：已被新条目取代，仅作历史保留
 *   - `expired`：已过期（`expires` 早于现在），等待维护转休眠
 *
 * ⚠️ **溢出的措辞必须准确**（2026-11-23 自查更正）：第一版写的是
 * 「本轮的注入里看不到它」，**那是错的**。溢出条目虽然进不了常驻块（Block A），
 * 但 `recall.js:211` 明确给 P0 开了词法豁免（`l <= 0 && rec.priority !== 'P0'` 才跳过），
 * 而 P0 的零词法底分 = 0.18×1.0 + 0.12×conf + ... ≈ **0.34 > 阈值 0.18** ——
 * 所以它照样会从 Block B（相关召回）里进来，只是
 *   ① 不再保证每轮都在最前面；
 *   ② 还要跟别人抢 Block B 的 `relevantMaxEntries`（默认 4）个位置。
 * 把它写成"看不见"会让用户以为置顶名单之外的一律失效，那是假消息。
 *
 * @returns `null`（正常）或 `{ code, reason }`
 */
export function explainRow(row, now = Date.now()) {
  if (!row) return null;
  if (row.overflow) {
    return {
      code: 'overflow',
      reason: '已置顶，但超出常驻条数上限 —— 不再固定出现在每轮开头，只能靠在相关召回里被选中',
    };
  }
  if (row.dormant) return { code: 'dormant', reason: '休眠中，不参与注入；被高相关提问命中时会自动唤醒' };
  if (row.stale) return { code: 'stale', reason: '已被更新的条目取代，原文保留但不再注入' };
  if (row.expires) {
    const t = Date.parse(row.expires);
    if (Number.isFinite(t) && t <= now) return { code: 'expired', reason: '已过期，下次维护会转成休眠' };
  }
  return null;
}

/**
 * 给整份行数据补上 `overflow` 与 `reason`（界面直接渲染，不用再算一遍）。
 *
 * 单独一个函数是因为 `explainRow` 需要知道"谁在溢出区"，而那是整份视图的属性。
 */
export function annotateRows(view, now = Date.now()) {
  const overflow = new Set(Array.isArray(view?.overflow) ? view.overflow : []);
  return (Array.isArray(view?.rows) ? view.rows : []).map((row) => {
    const marked = { ...row, overflow: overflow.has(row.id) };
    return { ...marked, reason: explainRow(marked, now) };
  });
}