// dsh-memory 插件入口。
//
// ⚠️ 关于 DSH 服务 API 的说明：
// 本文件对 DSH 的服务名与注册接口采用**防御式探测**——因为各版本差异较大，
// 硬编码单一形状会在升级后整块失效（正是我们在 Codex 记忆里看到的失败模式）。
// 插件启动时会把探测结果写进 status.md，便于确认实际可用的接线点。
//
// 已验证的：
//   - Cordis 插件形状（name / inject / apply）—— 与 dsh-breaker 一致
//   - inject = ["tools"] —— 与 dsh-breaker 一致
// 未验证（探测 + 降级）：
//   - 工具注册的具体方法名
//   - 指令/提示词注入的服务名
import path from 'node:path';
import fsp from 'node:fs/promises';
import { MemoryStore } from './store.js';
import * as policy from './policy.js';
import { recall, resident } from './recall.js';
import { buildInjection, estimateTokens } from './inject.js';

export const name = 'dsh-memory';
export const inject = ['tools'];

const DEFAULT_CONFIG = {
  enabled: true,
  root: null,
  git: true,
  inject: {
    enabled: true,
    residentMaxEntries: 8,
    residentMaxChars: 1200,
    relevantMaxEntries: 4,
    relevantMaxChars: 1800,
    indexThreshold: 20,
    minScore: 0.18,
    trustBoundary: true,
  },
  lifecycle: {
    p1Days: 30,
    p2Days: 7,
    p1WeakRenewDays: 3,
    p2WeakRenewDays: 1,
    budget: { maxMemories: 400, maxSkills: 200 },
    purgeDormantAfterDays: 30,
    autoRunOnStart: true,
  },
  extract: {
    model: null,
    idleMinutes: 30,
    maxPerStartup: 3,
    maxCandidates: 6,
    minTurns: 3,
    maxRetries: 2,
    consolidateAfterHours: 20,
    maxRawForConsolidation: 40,
  },
  antiseptic: {
    mergeLossFloor: 0.7,
    revisionHistory: 3,
    dedupeByTitle: true,
  },
  verbose: false,
};

function deepMerge(base, over) {
  if (!over || typeof over !== 'object') return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base?.[k] && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

function newId() {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `m_${t}_${r}`;
}

/** 从任意来源的文本里剥掉思考标签 */
export function stripThink(s) {
  return String(s || '')
    .replace(/<think[^>]*>[\s\S]*?<\/think>/gi, '')
    .replace(/^[\s\S]*?<\/think>/i, '')
    .trim();
}

// ───────────────────────── 健康状态 ─────────────────────────

async function readState(store) {
  try {
    return JSON.parse(await fsp.readFile(store.root.state, 'utf8'));
  } catch {
    return { version: 1, lastExtractSuccess: null, lastExtractError: null, lastErrorAt: null };
  }
}

async function writeState(store, state) {
  const tmp = `${store.root.state}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await fsp.rename(tmp, store.root.state);
}

/** 计算管线健康度 → 供 Block D 使用 */
export function healthOf(state, now = Date.now()) {
  const model = state.extractModel;
  if (!model) {
    return { ok: true, disabled: true, reason: '未配置 extract.model（自动抽取关闭）' };
  }
  const lastOk = state.lastExtractSuccess ? Date.parse(state.lastExtractSuccess) : null;
  const lastErr = state.lastErrorAt ? Date.parse(state.lastErrorAt) : null;

  if (lastErr && (!lastOk || lastErr > lastOk)) {
    const days = Math.floor((now - lastErr) / 86400000);
    return { ok: false, sinceDays: days, reason: state.lastExtractError || '未知错误' };
  }
  return { ok: true };
}

// ───────────────────────── 生命周期维护 ─────────────────────────

export async function runMaintenance(store, cfg, logger = console) {
  const all = await store.list();
  const now = Date.now();
  const lc = cfg.lifecycle;
  let expired = 0;
  let dormant = 0;

  // 1) 过期 → dormant（P0 与用户资产豁免）
  for (const rec of all) {
    if (policy.isProtected(rec)) continue;
    if ((rec.lifecycle || 'active') !== 'active') continue;
    if (!rec.expires) continue;
    const t = Date.parse(rec.expires);
    if (Number.isFinite(t) && t <= now) {
      await store.write({ ...rec, lifecycle: 'dormant', dormantAt: new Date(now).toISOString() });
      dormant++;
    }
  }

  // 2) 预算淘汰
  const refreshed = await store.list();
  for (const id of policy.planEviction(refreshed, lc.budget)) {
    const rec = refreshed.find((r) => r.id === id);
    if (!rec) continue;
    await store.write({ ...rec, lifecycle: 'dormant', dormantAt: new Date(now).toISOString() });
    dormant++;
  }

  // 3) 物理删除（dormant + 零反馈 + 超期 + 非保护）
  const after = await store.list();
  const purgeIds = policy.planPurge(after, lc, now);
  for (const id of purgeIds) {
    const rec = after.find((r) => r.id === id);
    if (rec) await store.remove(rec.id, rec.kind);
  }

  // 4) 重建索引
  await store.rebuildIndex();

  if (dormant || purgeIds.length || expired) {
    logger.log?.(`[dsh-memory] maintenance: dormant=${dormant} purged=${purgeIds.length}`);
  }
  return { dormant, purged: purgeIds.length, total: after.length };
}

async function writeStatus(store, cfg, state, probe) {
  const all = await store.list();
  const health = healthOf(state);
  const active = all.filter((r) => (r.lifecycle || 'active') === 'active').length;
  const dormantCount = all.length - active;
  const counts = { P0: 0, P1: 0, P2: 0 };
  for (const r of all) counts[r.priority] = (counts[r.priority] || 0) + 1;

  const lines = [
    '# dsh-memory status',
    '',
    `生成时间: ${new Date().toISOString()}`,
    `仓库: ${store.root.root}`,
    '',
    '## 记忆统计',
    '',
    `- 总数: ${all.length}（active ${active} / dormant ${dormantCount}）`,
    `- 优先级: P0=${counts.P0} P1=${counts.P1} P2=${counts.P2}`,
    '',
    '## 抽取管线',
    '',
    `- 模型: ${state.extractModel || '(未配置 — 自动抽取关闭)'}`,
    `- 最近成功: ${state.lastExtractSuccess || '从未'}`,
    `- 最近错误: ${state.lastExtractError || '无'}`,
    `- 健康: ${health.ok ? '✅ 正常' : `❌ 故障 — ${health.reason}`}`,
    '',
  ];

  if (probe) {
    lines.push('## 宿主探测', '', '```', ...probe.map((l) => String(l)), '```', '');
  }

  await fsp.writeFile(store.root.status, lines.join('\n'), 'utf8');
  return lines.join('\n');
}

// ───────────────────────── 宿主探测 ─────────────────────────

/**
 * 探测可用的 DSH 服务。刻意不抛异常——探测失败不应该让插件加载失败。
 * 结果写入 status.md 供人工确认接线点。
 */
function probeHost(ctx) {
  const out = [];
  const tryGet = (key) => {
    try {
      const v = ctx?.[key];
      if (v) {
        out.push(`  ${key}: <available> (${typeof v})`);
        return v;
      }
      out.push(`  ${key}: (absent)`);
    } catch (e) {
      out.push(`  ${key}: (error: ${e.message})`);
    }
    return null;
  };

  out.push('ctx 上的服务:');
  for (const k of ['tools', 'llm', 'jobs', 'storage', 'instructions', 'systemPrompt', 'scope', 'tokenMeter', 'sessions', 'settings']) {
    tryGet(k);
  }

  // 工具注册接口形状探测
  const tools = (() => {
    try {
      return ctx?.tools;
    } catch {
      return null;
    }
  })();
  if (tools) {
    out.push('tools 上的方法:');
    for (const m of ['register', 'add', 'define', 'provide', 'create', 'tool']) {
      out.push(`  tools.${m}: ${typeof tools[m] === 'function' ? '<function>' : `(${typeof tools[m]})`}`);
    }
  }
  return out;
}

/** 注册一个工具，尝试多种可能的注册接口形状 */
function registerTool(tools, def, logger) {
  if (!tools) return { ok: false, reason: 'no tools service' };
  const attempts = [
    ['register', () => tools.register(def)],
    ['add', () => tools.add(def)],
    ['define', () => tools.define(def)],
    ['provide', () => tools.provide(def)],
    ['create', () => tools.create(def)],
  ];
  for (const [name, fn] of attempts) {
    if (typeof tools[name] !== 'function') continue;
    try {
      fn();
      return { ok: true, via: name };
    } catch (e) {
      logger.warn?.(`[dsh-memory] tools.${name} failed: ${e.message}`);
    }
  }
  return { ok: false, reason: 'no known registration method' };
}

// ───────────────────────── 插件主体 ─────────────────────────

export function apply(ctx, userConfig = {}) {
  const cfg = deepMerge(DEFAULT_CONFIG, userConfig);
  if (cfg.enabled === false) return;

  const logger = cfg.verbose ? console : { log() {}, warn: console.warn, error: console.error };
  const store = new MemoryStore(cfg, logger);
  const probe = probeHost(ctx);

  // 延迟初始化：不阻塞宿主启动
  const ready = (async () => {
    await store.init();
    const state = await readState(store);
    state.extractModel = cfg.extract.model || null;

    if (cfg.lifecycle.autoRunOnStart) {
      try {
        await runMaintenance(store, cfg, logger);
      } catch (e) {
        logger.warn?.(`[dsh-memory] maintenance failed: ${e.message}`);
      }
    }
    await writeStatus(store, cfg, state, probe);
    return { store, state };
  })();

  // ── 工具：memory_recall ────────────────────────────────
  const recallTool = {
    name: 'memory_recall',
    description:
      '检索长期记忆（跨会话持久的事实 / 约定 / 决策 / 经验）。' +
      '省略 query 列出全部；level=l0 只返回标题索引，level=l2 返回完整正文（默认 l1 摘要）。' +
      '每次调用请与上一次不同——拿到摘要后就去行动，不要反复检索。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '自然语言查询，省略则列出全部。' },
        level: { type: 'string', enum: ['l0', 'l1', 'l2'], description: '详情层级，默认 l1。' },
        limit: { type: 'number', description: '最多返回条数，默认 6。' },
      },
    },
    async handler({ query = '', level = 'l1', limit = 6 } = {}) {
      const { store: st } = await ready;
      const all = await st.list();
      const hits = recall(all, query, { maxEntries: Math.max(1, Math.min(20, limit)) });
      const rows = hits.map(({ rec, s }) => {
        const base = { id: rec.id, priority: rec.priority, score: Number(s.toFixed(3)), title: rec.title };
        if (level === 'l0') return base;
        if (level === 'l2') return { ...base, summary: rec.summary, body: rec.body };
        return { ...base, summary: rec.summary };
      });
      return JSON.stringify({ count: rows.length, total: all.length, results: rows }, null, 2);
    },
  };

  // ── 工具：memory_write ─────────────────────────────────
  const writeTool = {
    name: 'memory_write',
    description:
      '写入 / 修正 / 删除长期记忆。**唯一的写入路径，不要手工编辑记忆文件。**' +
      'mode: add（默认）/ replace（按 title 精确匹配重写）/ delete。' +
      '只在用户要求"记住 / 更正 / 忘掉"时调用；系统也会在后台自动抽取。',
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['add', 'replace', 'delete'], description: '默认 add。' },
        scope: { type: 'string', enum: ['workspace', 'global'], description: '默认 workspace。' },
        kind: { type: 'string', enum: ['fact', 'convention', 'decision', 'constraint', 'skill', 'experience'] },
        priority: { type: 'string', enum: ['P0', 'P1', 'P2'], description: 'P0 = 用户置顶，永不过期。' },
        title: { type: 'string', description: '一行标题，≤ 80 字。' },
        summary: { type: 'string', description: '一句话摘要，≤ 300 字。' },
        body: { type: 'string', description: '完整正文（Markdown）。' },
        tags: { type: 'array', items: { type: 'string' } },
        anchor: { type: 'string', description: '未来什么情况下该召回它（不要复制内容）。' },
        match: { type: 'string', description: 'replace / delete 时按此标题精确匹配。' },
      },
      required: ['mode'],
    },
    async handler(args = {}) {
      const { store: st, state } = await ready;
      const mode = args.mode || 'add';
      const now = new Date().toISOString();

      if (mode === 'delete' || mode === 'replace') {
        const all = await st.list();
        const target = all.find((r) => r.title === (args.match || args.title));
        if (!target) return JSON.stringify({ ok: false, error: `未找到标题为「${args.match || args.title}」的记忆` });
        if (mode === 'delete') {
          await st.remove(target.id, target.kind);
          await st.rebuildIndex();
          Object.assign(state, {});
          await writeState(st, state);
          await st.commit(`memory: delete ${target.id}`);
          return JSON.stringify({ ok: true, deleted: target.id });
        }
        // replace
        const next = {
          ...target,
          title: args.title || target.title,
          summary: args.summary ?? target.summary,
          body: args.body ?? target.body,
          tags: args.tags ?? target.tags,
          anchor: args.anchor ?? target.anchor,
          priority: args.priority || target.priority,
          updated: now,
          expires: policy.computeExpiry(args.priority || target.priority, cfg.lifecycle),
        };
        await st.write(next);
        await st.rebuildIndex();
        await st.commit(`memory: replace ${target.id}`);
        return JSON.stringify({ ok: true, replaced: target.id });
      }

      // add
      const rec = {
        id: newId(),
        scope: args.scope === 'global' ? 'global' : 'workspace',
        kind: args.kind || 'fact',
        priority: args.priority || 'P2',
        confidence: 1.0, // 用户/模型显式写入 → 最高置信
        title: String(args.title || '(无标题)').slice(0, 80),
        summary: String(args.summary || '').slice(0, 300),
        anchor: String(args.anchor || '').slice(0, 300),
        tags: Array.isArray(args.tags) ? args.tags.slice(0, 12) : [],
        source: 'user',
        managedBy: 'user',
        lifecycle: 'active',
        created: now,
        updated: now,
        expires: policy.computeExpiry(args.priority || 'P2', cfg.lifecycle),
        stats: { recalled: 0, injected: 0, positive: 0, negative: 0 },
        body: String(args.body || args.summary || args.title || ''),
      };
      await st.write(rec);
      await st.rebuildIndex();
      await st.commit(`memory: add ${rec.id}`);
      return JSON.stringify({ ok: true, id: rec.id, priority: rec.priority, expires: rec.expires });
    },
  };

  // ── 工具：memory_status ────────────────────────────────
  const statusTool = {
    name: 'memory_status',
    description: '查看记忆系统健康状态：条数、优先级分布、抽取管线是否正常。',
    parameters: { type: 'object', properties: {} },
    async handler() {
      const { store: st, state } = await ready;
      const all = await st.list();
      const health = healthOf(state);
      return JSON.stringify(
        {
          root: st.root.root,
          total: all.length,
          active: all.filter((r) => (r.lifecycle || 'active') === 'active').length,
          priorities: all.reduce((a, r) => ((a[r.priority] = (a[r.priority] || 0) + 1), a), {}),
          extract: { model: state.extractModel, lastSuccess: state.lastExtractSuccess, lastError: state.lastExtractError },
          health,
        },
        null,
        2,
      );
    },
  };

  // 注册（形状探测，失败不阻断插件加载）
  const results = [
    registerTool(ctx?.tools, recallTool, logger),
    registerTool(ctx?.tools, writeTool, logger),
    registerTool(ctx?.tools, statusTool, logger),
  ];

  // 暴露给宿主 / 测试
  const api = {
    store,
    ready,
    config: cfg,
    recall: async (q, o) => recall(await store.list(), q, o),
    resident: async () => resident(await store.list()),
    buildInjection: async (q) => {
      const { state } = await ready;
      return buildInjection(await store.list(), q, healthOf(state), cfg.inject);
    },
    maintenance: () => runMaintenance(store, cfg, logger),
    status: async () => writeStatus(store, cfg, await readState(store), probe),
    probe,
    registerResults: results,
    estimateTokens,
  };

  try {
    ctx?.set?.('memory', api);
  } catch {
    /* 宿主无 set 接口时忽略 */
  }

  return api;
}

export default { name, inject, apply };
