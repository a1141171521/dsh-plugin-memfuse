// dsh-memfuse 插件入口。
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
import { scanThreat, redactThreats } from './guard.js';
import { extractCandidates, toPendingItems, EXTRACT_SYSTEM } from './extract.js';
import { listPending, putPending, findPending, dropPending } from './queue.js';
import {
  listSkills, readSkill, verifySkill, approvePendingSkill, rejectPendingSkill,
  writeSkill, validateSkill,
} from './skill.js';
import { findCandidates, clusterAround, distillSkill, buildSuggestions, clusterKey } from './distill.js';
import { installRemoteHost } from './remote.js';
import * as antiseptic from './antiseptic.js';
import { dshHome } from './paths.js';
import { Config } from './config.js';

// 导出 Config 让 DSH 的 `ctx.settings` 能把配置渲染成设置页。
//
// ⚠️ 这里刻意用 `export { Config }`（**在入口文件里再导出一次**）而不是
// 只写成 `export { Config } from './config.js'`，是为了让 `runtime.Config`
// 在 cordis 构造插件对象时就能被读到 —— 这是 official 插件（如
// ui-settings-general）用的形状。设置页的可见性完全依赖它：
// `dsh-settings` 的 describe() 第一件事就是取 `entry.fiber.runtime.Config`，
// 取到 undefined 就直接 `return []`，插件再正常也不会有设置页。
export { Config };

export const name = 'dsh-memfuse';
// 宿主只提供 ctx.tools.register（不存在 add/define/provide/create），
// 且每轮注入必须挂到 systemPrompt.context —— 两者都要在 inject 里声明。
export const inject = ['tools', 'systemPrompt'];

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
    // **总开关，默认关闭**：关着的时候整条抽取管线不跑（记忆的读写注入照常）。
    // 这是 UI 上那个「开启自动抽取」的按钮 —— 打开之后才看 provider/model/跟随。
    enabled: false,
    // provider 与 model **两者缺一不可**（宿主 GenerateOptions 里两个都是必填）。
    provider: null,
    model: null,
    // 勾上就跟随「对话主模型」（你在对话框里选的那个），不必在这里再选一遍。
    // 与上面两项互斥：followConversation 优先，显式配置退化成它的降级目标。
    followConversation: false,
    // 抽取模型**不可用**时的策略。两种形态都算不可用：
    //   ① 静态：provider/model 在宿主注册表里查不到（名字写错、provider 插件没装）
    //   ② 动态：真调了但失败（限流 / 鉴权 / 定价 / 服务端不认这个模型名）
    // 'stop'（默认）= 记失败、不再尝试 —— 失败进 lastExtractError，Block D 会报出来
    // 'fallback'    = 改用降级目标继续（降级目标只试一次，不来回横跳）
    onUnavailable: 'stop',
    // 降级目标。**两个都留空 = 跟随「对话主模型」**（agentDefaultModel 服务的当前选择）——
    // 用户已经在别处选过一次主模型，没必要为「抽取失败时用哪个」再选一遍。
    fallbackProvider: null,
    fallbackModel: null,
    // 'suggest'（默认）= 候选进待确认队列，等用户 approve/reject
    // 'auto'             = 直接写入（省事但风险自负）
    mode: 'suggest',
    autoRunOnStart: true,
    maxPerStartup: 3,
    maxCandidates: 6,
    // 新增内容少于这个字符数就跳过（省一次模型调用）
    minChars: 200,
    maxInputChars: 12000,
    maxRetries: 2,
    consolidateAfterHours: 20,
    maxRawForConsolidation: 40,
  },
  antiseptic: {
    mergeLossFloor: 0.7,
    revisionHistory: 3,
    dedupeByTitle: true,
  },
  // 零 LLM 兜底捕获：把每轮最终问答原文追加进 sessions/<date>.md。
  // 目的：即使 extract.model 永远不配置，原始素材也已经落盘、可被检索。
  capture: {
    enabled: true,
    minPromptLength: 10,
    maxChars: 4000,
  },
  // 学习闭环。promoteMinSessions 是"跨几个不同会话被召回才允许自动升级"。
  learn: {
    promoteMinSessions: 3,
  },
  // 技能提炼（H）。默认技能库 = <DSH_HOME>/skills（全局技能，装完**当轮即生效**，不用重启）。
  skill: {
    enabled: true,
    dir: null,
    maxBytes: 65536,
    // 候选识别门槛（零 LLM，每次启动都跑）
    minScore: 4,
    minSessions: 3,
    maxPerRun: 2,
    // 够格时主动提示（**零 LLM**：只预告簇语义，不生成技能正文）
    suggest: true,
    suggestMax: 1,
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

/**
 * 运行期故障的中文标签 —— `healthOf()` 拼告警文案时用。
 *
 * 这些分支原来只 `console.warn`（在 Web UI 里等于静默）：用户看到的现象是
 * "没有记忆"，而不是"记忆坏了"。而"失败可见"是本项目的差异化之一，
 * 所以它们必须能被 Block D / status.md 报出来。
 */
const FAULT_LABEL = {
  injectFail: '注入装配失败',
  contextFail: '注入挂载失败',
  registerFail: '工具注册失败',
  writeFail: '记忆写入失败',
  captureFail: '会话捕获失败',
  llmFail: 'llm 注入失败',
  remoteFail: '界面数据通道（Remote）未装上',
};

/** 记一笔运行期故障（记账本身失败绝不能反过来影响主流程）。 */
function noteFault(faults, kind, message) {
  try {
    if (!faults) return;
    faults[kind] = { at: new Date().toISOString(), message: String(message || '原因未知').slice(0, 180) };
  } catch {
    /* 记账失败就放弃记账，不要因此让记忆功能挂掉 */
  }
}

/**
 * 计算管线健康度 → 供 Block D 使用。
 *
 * ⚠️ **运行期故障优先**：`extract.*` 只反映"抽取管线"，而**记忆功能本身坏掉**
 * （写不进去 / 注入装配失败 / 注入 provider 没挂上）更严重 —— 那些分支以前只
 * `console.warn`，用户根本发现不了。现在它们统一记进 `state.runtimeFaults`，
 * 在这里一并报出来。
 */
export function healthOf(state, now = Date.now()) {
  const faults = state && state.runtimeFaults;
  if (faults && typeof faults === 'object') {
    const keys = Object.keys(faults).filter((k) => faults[k] && faults[k].message);
    if (keys.length) {
      return {
        ok: false,
        sinceDays: 0,
        runtime: true,
        reason: keys.map((k) => `${FAULT_LABEL[k] || k}（${faults[k].message}）`).join('；'),
      };
    }
  }

  const model = state.extractModel;
  if (!model) {
    // 开关开着却没有模型 = **真故障**（用户明明打开了开关，抽取却无从下手）。
    // 不能再说"未配置（自动抽取关闭）"—— 那句话会让人以为是自己没开。
    // 错误文案里已经写了差什么，这里把它带出来（带记录时间，见下）。
    if (state.extractEnabled === true) {
      return {
        ok: false,
        sinceDays: 0,
        staleError: Boolean(state.lastErrorAt),
        reason: state.lastExtractError
          ? `${state.lastExtractError}（记录于 ${state.lastErrorAt}）`
          : '开关开着，但还没选到可用的模型 —— 去「插件 → dsh-memfuse → 配置」挑一个，或勾「跟随对话模型」。',
      };
    }
    return { ok: true, disabled: true, reason: '总开关没开（自动抽取关闭，这是默认状态）' };
  }
  const lastOk = state.lastExtractSuccess ? Date.parse(state.lastExtractSuccess) : null;
  const lastErr = state.lastErrorAt ? Date.parse(state.lastErrorAt) : null;

  if (lastErr && (!lastOk || lastErr > lastOk)) {
    const days = Math.floor((now - lastErr) / 86400000);
    // ⚠️ 必须带**时间戳**。`lastExtractError` 是持久化的历史字符串，代码修好之后
    // 它不会自己消失（要等下一次成功抽取才被覆盖）—— 实测踩过：Block D 里那行
    // `provider "[object Object]"` 是 4 小时前那次调用留下的，而新代码早已修好，
    // 却被当成"现在还坏着"。没有时间戳就没法判断新旧。
    return {
      ok: false,
      sinceDays: days,
      staleError: true,
      reason: `${state.lastExtractError || '未知错误'}（记录于 ${state.lastErrorAt}）`,
    };
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
  const drift = [];

  /** 写回一条记忆；被 drift guard 拒绝时只记账，不中断整批维护。 */
  const markDormant = async (rec) => {
    try {
      await store.write({ ...rec, lifecycle: 'dormant', dormantAt: new Date(now).toISOString() });
      dormant++;
      return true;
    } catch (e) {
      if (e && e.name === 'DriftError') {
        drift.push(rec.id);
        return false;
      }
      throw e;
    }
  };

  // 1) 过期 → dormant（P0 与用户资产豁免）
  for (const rec of all) {
    if (policy.isProtected(rec)) continue;
    if ((rec.lifecycle || 'active') !== 'active') continue;
    if (!rec.expires) continue;
    const t = Date.parse(rec.expires);
    if (Number.isFinite(t) && t <= now) {
      expired++;
      await markDormant(rec);
    }
  }

  // 2) 预算淘汰
  const refreshed = await store.list();
  for (const id of policy.planEviction(refreshed, lc.budget)) {
    const rec = refreshed.find((r) => r.id === id);
    if (!rec) continue;
    await markDormant(rec);
  }

  // 2b) 超限但动不了的情况必须留痕 —— 原实现在"保护项占满预算"时
  //     返回空数组且零告警，看起来像"没有需要淘汰的"。
  const pressure = policy.evictionPressure(await store.list(), lc.budget);
  for (const [bucket, info] of Object.entries(pressure)) {
    logger.warn?.(
      `[dsh-memfuse] 预算超限 ${bucket}：超 ${info.over} 条，可淘汰 ${info.evictable} 条` +
        (info.blocked ? '（被 P0/用户资产堵死，无法自动淘汰）' : ''),
    );
  }

  // 3) 物理删除（dormant + **从未被召回** + 零反馈 + 超期 + 非保护）
  const after = await store.list();
  const purgeIds = policy.planPurge(after, lc, now);
  let purged = 0;
  for (const id of purgeIds) {
    const rec = after.find((r) => r.id === id);
    if (rec && (await store.remove(rec.id, rec.kind))) purged++;
  }

  // 4) 反腐烂：重复检测 → **只对「完全重复」标 stale**（标记而非删除，可回滚）。
  //    「同标题不同正文」只报告 —— 可能是新旧版本，也可能是真矛盾，由人裁决。
  const forDup = await store.list();
  const dupClusters = antiseptic.findDuplicateClusters(forDup);
  const stalePlan = antiseptic.planStale(dupClusters);
  let staled = 0;
  for (const p of stalePlan) {
    const rec = forDup.find((r) => r.id === p.id);
    if (!rec || rec.stale === true) continue;
    try {
      await store.write({ ...rec, stale: true, supersededBy: p.supersededBy });
      staled++;
    } catch (e) {
      if (e && e.name === 'DriftError') drift.push(rec.id);
      else throw e;
    }
  }

  // 5) 重建索引
  await store.rebuildIndex();

  if (dormant || purged || expired || drift.length || staled) {
    logger.log?.(
      `[dsh-memfuse] maintenance: expired=${expired} dormant=${dormant} purged=${purged}` +
        ` staled=${staled}` +
        (drift.length ? ` drift=${drift.length}` : ''),
    );
  }
  // total 用删除前的长度减去实际删掉的条数（原实现返回删除前的长度，含已删项）
  return {
    expired,
    dormant,
    purged,
    staled,
    drift,
    total: after.length - purged,
    dupClusters: dupClusters.length,
    dupReport: antiseptic.renderClusters(dupClusters),
    conflictReport: antiseptic.renderPotentialConflicts(dupClusters),
  };
}

async function writeStatus(store, cfg, state, probe) {
  const all = await store.list();
  const health = healthOf(state);
  const active = all.filter((r) => (r.lifecycle || 'active') === 'active').length;
  const dormantCount = all.length - active;
  const counts = { P0: 0, P1: 0, P2: 0 };
  for (const r of all) counts[r.priority] = (counts[r.priority] || 0) + 1;
  const sum = (k) => all.reduce((a, r) => a + ((r.stats && r.stats[k]) || 0), 0);
  const promoted = all.filter((r) => r.promotedAt).length;
  const pending = await listPending(store.root).catch(() => []);
  const m = state.lastMaintenance || {};
  // 捕获进度与素材文件清单 —— **从磁盘派生**（读不到就当 0，绝不影响 status.md 生成）
  const sessionFiles = (await fsp.readdir(store.root.sessions).catch(() => []))
    .filter((f) => f.endsWith('.md'))
    .sort();
  let capturedTurns = 0;
  for (const f of sessionFiles) {
    const body = await fsp.readFile(path.join(store.root.sessions, f), 'utf8').catch(() => '');
    capturedTurns += (body.match(/=== 本轮最终问答/g) || []).length;
  }

  const lines = [
    '# dsh-memfuse status',
    '',
    `生成时间: ${new Date().toISOString()}`,
    `仓库: ${store.root.root}`,
    `代码版本: 2026-10-17-capture-multisession`,
    '',
    '## 记忆统计',
    '',
    `- 总数: ${all.length}（active ${active} / dormant ${dormantCount}）`,
    `- 优先级: P0=${counts.P0} P1=${counts.P1} P2=${counts.P2}`,
    '',
    '## 学习状态',
    '',
    `- 召回 ${sum('recalled')} 次 / 注入 ${sum('injected')} 次`,
    `- 反馈: 正面 ${sum('positive')} / 负面 ${sum('negative')}`,
    `- 跨会话自动升级: ${promoted} 条`,
    '',
    '## 待确认队列',
    '',
    pending.length
      ? `- ${pending.length} 条待处理（用 memfuse_write mode=approve/reject 处理）`
      : '- 空',
    ...pending.slice(0, 5).map((p) => `  - [${p.priority || 'P2'}] ${p.title}`),
    '',
    '## 抽取管线',
    '',
    `- 开关: ${state.extractEnabled === true ? '✅ 已开启' : '⬜ 未开启（默认）'}`,
    `- 模型: ${state.extractModel || '(未选到模型)'}`,
    `- provider: ${state.extractProvider || '(未选到)'}`,
    `- 来源: ${state.extractSource || (state.extractModel ? '显式配置' : '关闭')}${state.extractSource === '对话主模型' ? '（跟随对话框里选的那个，会随它变）' : ''}`,
    `- 模式: ${cfg.extract.mode}${cfg.extract.mode === 'suggest' ? '（候选进待确认队列）' : '（直接写入）'}`,
    `- 最近成功: ${state.lastExtractSuccess || '从未'}`,
    // "没新素材"必须和"成功"分开说（缺陷 29）：一次模型都没调的跳过，
    // 如果写成"成功"，真故障会被它盖掉（实测盖了两次，查了两轮）。
    ...(state.lastExtractSkippedAt
      ? [`- 最近一次: ${state.lastExtractSkippedAt} 无新素材，跳过（这次没调模型，不算成功也不算失败）`]
      : []),
    // 带时间戳：这是**历史**错误字符串，代码修好后不会自动消失（等下一次成功抽取覆盖）。
    // 没有时间戳时，"状态文件里还写着报错"会被误读成"现在还坏着"（实测踩过）。
    `- 最近错误: ${state.lastExtractError ? `${state.lastExtractError}（记录于 ${state.lastErrorAt || '未知'}）` : '无'}`,
    `- 健康: ${health.ok ? '✅ 正常' : `❌ 故障 — ${health.reason}`}` + (health.staleError ? '　← 这是**历史**记录，下一次成功抽取会覆盖它' : ''),
    '',
    '## 零 LLM 捕获（抽取管线的原料）',
    '',
    // 这一节存在的理由：`session.events` 那次事故里，捕获**整条路径死了**，
    // 而 status.md 上什么都看不出来（sessions/ 是空的 ≠ 出错了）。
    //
    // ⚠️ 计数**从磁盘派生**（真源是 sessions/*.md，数字只是视图）。
    // 早先用内存计数器 → 短命进程上会撒谎：headless 一轮跑完就退出，
    // 而计数只在 pre-step 的 flushInjected 里落盘，退出前那一次永远刷不到 ——
    // 实测就是"素材文件 1 个"旁边写着"已捕获轮次: 0"。
    `- 已捕获轮次: ${capturedTurns}${capturedTurns ? '' : '（从未）'}`,
    `- 捕获开关: ${cfg.capture && cfg.capture.enabled === false ? '❌ 已关闭' : '开启'}${capturedTurns ? '' : '　← 一直 0 时先看下面的「运行期故障」'}`,
    `- 素材文件: ${sessionFiles.length} 个${sessionFiles.length ? `（最近 ${sessionFiles[sessionFiles.length - 1]}）` : ''}`,
    '',
    '## 运行期故障',
    '',
    // 这些分支原来只 console.warn（Web UI 里等于静默）：用户看到的是
    // "没有记忆"，而不是"记忆坏了"。现在在 status.md 里也留痕。
    ...(state.runtimeFaults && Object.keys(state.runtimeFaults).length
      ? Object.entries(state.runtimeFaults).map(
          ([k, v]) => `- ❌ ${FAULT_LABEL[k] || k}：${v.message}（${v.at}）`,
        )
      : ['- 无']),
    '',
    '## 反腐烂',
    '',
    `- 上次维护: 过期 ${m.expired ?? '—'} / 转休眠 ${m.dormant ?? '—'} / 物理删除 ${m.purged ?? '—'} / 标 stale ${m.staled ?? '—'}`,
    ...(Array.isArray(m.dupReport) && m.dupReport.length ? ['- 重复簇:', ...m.dupReport] : ['- 重复簇: 无']),
    ...(Array.isArray(m.conflictReport) ? m.conflictReport : []),
    '',
  ];

  // 技能节（H）：候选 / 待确认 / 已装，并标出"会被 DSH 静默跳过"的那些
  const liveSkills = await listSkills(skillDirOf(cfg)).catch(() => []);
  const pendingSkills = await listSkills(store.root.pendingSkills).catch(() => []);
  const badSkills = liveSkills.filter((s) => !s.loadable);
  const candidates = Array.isArray(state.skillCandidates) ? state.skillCandidates : [];
  lines.push(
    '## 技能',
    '',
    `- 技能库: ${skillDirOf(cfg)}`,
    `- 已装: ${liveSkills.length} 个${badSkills.length ? `（⚠️ 其中 ${badSkills.length} 个会被 DSH 静默跳过）` : ''}`,
    ...liveSkills.slice(0, 8).map((s) => `  - ${s.loadable ? '✅' : '⚠️'} ${s.name}${s.problem ? ` — ${s.problem}` : ''}`),
    pendingSkills.length
      ? `- 待确认: ${pendingSkills.length} 个（memfuse_skill action=approve 安装）`
      : '- 待确认: 空',
    ...pendingSkills.map((s) => `  - ${s.name}`),
    candidates.length
      ? '- 候选（零 LLM 打分；memfuse_skill action=distill 提炼）:'
      : '- 候选: 无',
    ...candidates.map((c) => `  - ${c.score} 分 · ${c.title}（${(c.reasons || []).join('、')}）`),
    // 界面那侧的可见性：卡片读的就是这条通道；装上失败要看得见（否则只是"卡片不出现"）
    state.remoteChannel && state.remoteChannel.failed
      ? `- 界面通道（Remote）: ❌ 未装上 —— ${state.remoteChannel.failed}`
      : `- 界面通道（Remote）: ✅ 已装上（${(state.remoteChannel && state.remoteChannel.endpoints) || 0} 个端点；界面卡片读它）`,
    `- 界面已看过（skillSeen）: ${Object.keys(state.skillSeen || {}).length} 组 · 用户点过「提炼」待办: ${(Array.isArray(state.distillRequests) ? state.distillRequests : []).length} 条`,
    `- 用户已忽略（skillDismissed）: ${Object.keys(state.skillDismissed || {}).length} 组`,
    '',
  );

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

/**
 * 工具级超时（毫秒）。**必须声明**（缺陷 28），但它**救不了"永不返回"**（缺陷 29）。
 *
 * 读 `dsh-tool-call-timeout-policy` 的源码才看清它的真实语义：
 *
 *     const result = await next();                        // 先无条件等工具跑完
 *     if (timeoutOf(d.signal, 'TOOL_TIMEOUT') !== void 0) // 跑完才问"刚才超时没"
 *       return toolTimeoutResult(timeoutMs);
 *
 * 也就是说它是**协作式**的，两条推论都很要命：
 *   ① 工具不返回 ⇒ 它照样一直等。声明了也白搭（README 原文：
 *      「永不完成的下游调用无法产生超时结果」）。
 *   ② 工具跑超了却**成功返回** ⇒ 结果仍会被替换成 `tool call timed out after Nms`。
 *      所以这个值**必须大于我们自己的全部内部预算**，否则一次正常但偏慢的抽取
 *      会被宿主误报成超时 —— 把成功说成失败，同样是撒谎。
 *
 * 真正的兜底是下面那几个自己的预算（`MODEL_CALL_TIMEOUT_MS` / `EXTRACT_BUDGET_MS`）。
 */
export const TOOL_TIMEOUT_MS = 120000;

/**
 * 启动初始化预算（毫秒）。见 `ready` 那段：超了就降级放行，绝不吊死工具。
 * 比 `TOOL_TIMEOUT_MS` 小，让插件自己先降级、先报故障，别等宿主替我们超时。
 */
export const STARTUP_BUDGET_MS = 12000;

/**
 * 预检预算（毫秒）。
 *
 * `probeTarget()` 会调 `llm.listProviders()` / `llm.listModels()`，而宿主把它们
 * **转交给 adapter**（`dsh-llm/lib/index.js` 的 `listModels` → `adapter.listModels(provider)`）
 * —— 对 OpenAI 兼容中转站，这就是一次 `/v1/models` 网络请求。
 *
 * 真机实测（缺陷 29）：同一台机器、同一个 provider，一次 **52 秒**、一次 **12 毫秒**。
 * 而它只是个"省一次 API 调用"的预检。让它拖住用户几分钟毫无道理 ——
 * 超时一律按"查不动"放行（和"宿主没提供 listModels"同一种处理），并记一条运行期故障。
 */
export const PROBE_BUDGET_MS = 2000;

/**
 * 单次模型调用的**无进展窗口**（毫秒）：多久收不到新 chunk 就判"卡住了"。
 *
 * ⚠️ 是"多久没动静"，**不是"整次调用多久"**。判据搞错会腰斩正常的长回答
 * （每 10 秒吐一块、健康跑 100 秒的那种），还会把它报成"没有任何推进" ——
 * 又一次把成功说成失败。总时长由调用方的 `absDeadline` 兜底（见 `drainStream`）。
 *
 * 推理型模型 + 4000 输出 token，正常在 40~90 秒出完。卡住的那种是**一个 chunk 都不来**，
 * 所以这个窗口一到就直接放弃等待（`llm.stream` 的 `GenerateOptions` 没有 `signal` 字段，
 * 掐不断上游，只能不再等它）。
 */
export const MODEL_CALL_TIMEOUT_MS = 90000;

/**
 * 单次 `memfuse_extract` 工具调用的总预算（毫秒）。到点就把**已完成的部分**返回，
 * 并在 `errors` 里说明剩下的没跑 —— 小于 `TOOL_TIMEOUT_MS`，保证由我们报告，
 * 而不是让宿主把一次成功的抽取改写成超时。
 */
export const EXTRACT_BUDGET_MS = 100000;

/**
 * 启动抽取的总预算（毫秒）。后台跑、没人在等，可以比工具宽松；
 * 但仍然有界，免得一次挂住的上游永远占着一个 pending promise。
 */
export const STARTUP_EXTRACT_BUDGET_MS = 240000;

/**
 * 给一个 promise 加预算：到点就 resolve `null`，永不悬挂。
 *
 * 为什么不用 `AbortSignal`：这里要防的是"某个宿主调用永不 settle"，
 * 而挂住的 promise 不响应 abort —— 只能**不依赖它**，用 race 自己往下走。
 *
 * @param promise 要设预算的 promise
 * @param timeoutMs 预算（毫秒）
 * @param onTimeout 到点时的回调（用来记运行期故障 —— 不许静默）
 * @returns 原值，或超时时的 `null`
 */
export function withBudget(promise, timeoutMs, onTimeout) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.resolve(promise);
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {
        /* 记故障本身失败也不能影响降级 */
      }
      resolve(null);
    }, timeoutMs);
    // ⚠️ **不要 `unref()`**：这个定时器就是"到点放行"的唯一凭据。
    // unref 掉之后，如果此刻事件循环没别的事可做（测试里很常见 / 应用正在退出），
    // 定时器还没响循环就空了 —— `node --test` 直接报
    // `Promise resolution is still pending but the event loop has already resolved`。
    // 正确做法是反过来：**竞速结束后清掉它**（见下面的 finally）。
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

/**
 * 按 ctx 存"运行期故障表"的引用。
 *
 * `probeTarget()` / `runExtraction()` 这些是**模块级函数**，只拿得到 `ctx`，
 * 拿不到 apply 里的 `runtimeFaults`。和 `llmByCtx` 同一套理由（不泄漏、不改签名）。
 */
const faultsByCtx = new WeakMap();

/** 读某个 ctx 的故障表；没有就返回 null（不抛错）。 */
function faultsFor(ctx) {
  try {
    return faultsByCtx.get(ctx) || null;
  } catch {
    return null;
  }
}

/**
 * 把模型流"边收边等"，**只在"没有进展"时放弃**，并且能响应取消。
 *
 * 为什么不能直接 `for await (const chunk of stream)`（缺陷 29 的真凶）：
 * 宿主那边 `llm.stream()` 的返回值是一个 async generator，背后是网络请求。
 * 上游光连不吐（中转站限流 / 连接半开 / 代理挂住）时，`for await` 会**永远挂着** ——
 * 而且 `GenerateOptions` 里没有 `signal` 字段，我们掐不断它，只能**不再等它**。
 *
 * ⚠️ 判据必须是「**多久没有新 chunk**」，不是「整次调用多久」：
 * 拿总时长当判据的话，一个每 10 秒吐一块、健康跑满 100 秒的长回答会被腰斩，
 * 还会被报成"没有任何推进" —— 那是**把成功说成失败**，和缺陷 29 里那条假成功一样有害。
 * 所以每收到一块就重新上弦；总时长由调用方用 `absDeadline` 兜底（绝对截止时间）。
 *
 *   - 无进展到点 → 抛可读错误（经 `extractCandidates` 记进 `lastExtractError` → Block D）
 *   - 被取消 → 抛取消错误，工具立刻返回（顶栏的「停止」终于点得动了）
 *   - 放弃时 `return()` 关掉流，别把连接和上游 token 一起晾着
 *
 * 定时器同样**不 unref**，并在 `finally` 清掉（`withBudget` 那段踩过的坑）。
 *
 * @param {AsyncIterable} stream 宿主的模型流
 * @param {number} idleMs 多久没有新 chunk 就算"没进展"
 * @param {{onTimeout?: Function, signal?: AbortSignal, onAbort?: Function, absDeadline?: number}} [opts]
 */
export async function* drainStream(stream, idleMs, opts = {}) {
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
    throw new Error('宿主没有返回可迭代的模型流（llm.stream 的契约可能变了）');
  }
  const it = stream[Symbol.asyncIterator]();
  const absDeadline = Number.isFinite(opts.absDeadline) ? opts.absDeadline : Infinity;

  let timer = null;
  let gaveUp = false;
  let onAbort = null;

  /** 上一根弦：从**现在**开始算 idleMs。每次收到 chunk 都重新来一遍。 */
  const arm = () =>
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        gaveUp = true;
        try {
          opts.onTimeout?.();
        } catch {
          /* 记故障失败不能影响"放弃等待"本身 */
        }
        reject(
          new Error(
            `模型调用超过 ${Math.round(idleMs / 1000)} 秒没有任何推进 —— 已放弃等待` +
              '（上游可能还在跑，但不再拖住本轮）',
          ),
        );
      }, idleMs);
    });
  let expire = arm();
  // 预算是唯一凭据，绝不 unref；每次重新上弦前先清，收尾时也清（见 finally）

  const cancel = new Promise((_, reject) => {
    if (!opts.signal) return; // 没给信号就永远不会 settle —— 但 Promise.race 里这是安全的
    onAbort = () => {
      try {
        opts.onAbort?.();
      } catch {
        /* 同上 */
      }
      reject(new Error('工具调用已取消（用户停止 / 回合结束）'));
    };
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  });

  try {
    for (;;) {
      if (Date.now() > absDeadline) {
        gaveUp = true;
        throw new Error(
          '本次抽取的总时间预算已用完 —— 已收尾，没处理完的会话文件下次接着跑（素材不会丢）',
        );
      }
      const step = await Promise.race([it.next(), expire, cancel]);
      if (step.done) return;
      // 收到一块 = 上游还活着 → 重新上弦（见上面"判据必须是无进展"那段）
      if (timer !== null) clearTimeout(timer);
      expire = arm();
      yield step.value;
    }
  } finally {
    if (timer !== null) clearTimeout(timer);
    if (onAbort && opts.signal) {
      try {
        opts.signal.removeEventListener('abort', onAbort);
      } catch {
        /* 老运行时不支持也行 */
      }
    }
    // 没人再等这两个"输掉竞速"的 promise，挂个空的 catch，
    // 否则它们后面 reject 时会变成 unhandledRejection。
    expire.catch(() => {});
    cancel.catch(() => {});
    if (gaveUp) {
      try {
        await it.return?.();
      } catch {
        /* 上游已经断了也算正常 */
      }
    }
  }
}

/** 工具返回值的统一形状。宿主用 output.schema 校验 execute 的返回值。 */
const textOutput = (description) => ({
  schema: { type: 'string', description },
  render: (_args, value) => [
    { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
  ],
});

/**
 * 注册一个工具。
 *
 * 宿主 API 已核实（@deepseek-ai/dsh-tools）：
 *   - `ctx.tools` 只有 register / restrict / guard / get / schemas / execute，
 *     **不存在** add / define / provide / create。早先那套"五形状探测"是死代码，
 *     而且它把 register 的真实报错吞成 warn → 五个形状全失败 → 插件"加载成功"
 *     但一个工具都没注册，status.md 只留一句误导性的 "no known registration method"。
 *   - `output` 是**注册时**的强制项，缺了会同步抛
 *     `TypeError: tool "X" must declare output { schema, render, presentationMeta? }`，
 *     且 `output.render` 是必需函数（不是只有 schema 就够）。
 *   - 调用键是 `execute`，不是 `handler`。
 *   - register 返回 disposer，必须收好并在卸载时释放。
 */
function registerTool(tools, def, logger, disposers) {
  if (!tools || typeof tools.register !== 'function') {
    return { ok: false, reason: 'no tools service' };
  }
  // 宿主 0.2.1-rc.1 支持 `timeoutMs`，且**不会**强杀已经在跑的 execute（见 TOOL_TIMEOUT_MS）。
  // 统一在这里补上，别指望六处都记得写。
  if (def && def.timeoutMs === undefined) def.timeoutMs = TOOL_TIMEOUT_MS;
  try {
    const dispose = tools.register(def);
    if (typeof dispose === 'function') disposers.push(dispose);
    return { ok: true, via: 'register' };
  } catch (e) {
    logger.warn?.(`[dsh-memfuse] register ${def.name} failed: ${e.message}`);
    return { ok: false, reason: e.message };
  }
}

/** 从一条消息 payload 里取纯文本（兼容 data 与 data.message 两种形状）。 */
function textOfMessage(message) {
  const m = message && typeof message === 'object' && message.message && typeof message.message === 'object'
    ? message.message
    : message;
  if (!m || !Array.isArray(m.content)) return '';
  return m.content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/**
 * 提交并检查返回值。
 * 早期版本把 `store.commit()` 的返回值在三个调用点全丢掉了——`.git/index.lock`
 * 冲突或 git 未安装时提交失败**零留痕**，用户以为记忆已入库。
 */
async function commitOrWarn(store, logger, message) {
  const r = await store.commit(message);
  if (r && r.ok === false && r.reason !== 'disabled' && r.reason !== 'no-change') {
    logger.warn?.(`[dsh-memfuse] git commit 失败（${r.err || r.reason}）：${message}`);
  }
  return r;
}

/**
 * 召回 / 注入 / 反馈计数 + 弱续期 + 跨会话模式识别 —— **学习闭环的生产端**。
 *
 * 没有它：`stats` 恒为 0 → `policy.utility()` 恒返回 0 → 打分公式里 8% 的
 * utility 权重等于没写；`dormant` 的"零反馈"判据也永远成立（会被误删）。
 *
 * @param {string|null} sessionId 本轮会话 id —— 用于**跨会话**去重计数
 *   （同一会话里召回 10 次只算 1 次；否则长会话会把噪声刷成 P1）。
 */
async function touchMemory(store, rec, delta, cfg, logger, sessionId = null) {
  try {
    const fresh = await store.read(rec.id, rec.kind);
    if (!fresh) return false;
    const s = fresh.stats || {};
    const next = {
      ...fresh,
      stats: {
        recalled: (s.recalled || 0) + (delta.recalled || 0),
        injected: (s.injected || 0) + (delta.injected || 0),
        positive: (s.positive || 0) + (delta.positive || 0),
        negative: (s.negative || 0) + (delta.negative || 0),
      },
    };

    // 被召回：弱续期（与有没有 session 无关）+ 跨会话去重计数（这个才需要 session）
    if ((delta.recalled || 0) > 0) {
      // C4：被召回就小幅续期（P0 返回 null = 永不过期）
      const renewed = policy.weakRenew(fresh.priority, cfg.lifecycle, fresh.expires);
      if (renewed) next.expires = renewed;
      // E4：同一会话里召回 10 次只算 1 次 —— 否则长会话会把噪声刷成 P1
      if (sessionId) {
        const seen = Array.isArray(fresh.sessions) ? fresh.sessions : [];
        if (!seen.includes(sessionId)) {
          next.sessions = [...seen, sessionId].slice(-20); // 只留最近 20 个，防膨胀
          next.sessionCount = (fresh.sessionCount || 0) + 1;
        }
      }
    }

    // E5：模式识别 —— 跨会话被反复召回就升级（P0 永不自动升）
    if (policy.shouldPromote(next, cfg.learn && cfg.learn.promoteMinSessions)) {
      next.priority = 'P1';
      next.expires = policy.computeExpiry('P1', cfg.lifecycle);
      next.promotedAt = new Date().toISOString();
      next.promotedFrom = 'P2';
      await store.appendUsage({
        type: 'promote',
        id: next.id,
        from: 'P2',
        to: 'P1',
        sessionCount: next.sessionCount,
      });
      logger.log?.(
        `[dsh-memfuse] 自动升级 P2→P1：${next.title}（跨 ${next.sessionCount} 个会话被召回）`,
      );
    }

    // E2：反馈直接改置信度（正面微升 / 负面明显下调）
    if (delta.positive || delta.negative) {
      next.confidence = policy.applyFeedback(fresh, delta.negative ? 'negative' : 'positive');
    }

    await store.write(next);
    return true;
  } catch (e) {
    logger.warn?.(`[dsh-memfuse] 更新统计失败 ${rec.id}：${e.message}`);
    return false;
  }
}

/**
 * 把一段写操作放进锁里执行，并把 DriftError 转成结构化返回
 * （而不是把栈抛给模型）。返回 null 表示成功。
 */
async function mutate(store, logger, label, fn) {
  try {
    await store.locked(fn);
    return null;
  } catch (e) {
    if (e && e.name === 'DriftError') {
      logger.warn?.(`[dsh-memfuse] ${label} 被 drift guard 拒绝：${e.message}`);
      return { ok: false, drift: true, error: e.message, backup: e.backup };
    }
    logger.warn?.(`[dsh-memfuse] ${label} 失败：${e.message}`);
    // 写不进去必须记账 —— 否则用户以为记住了，其实磁盘上根本没有。
    noteFault(store && store.runtimeFaults, 'writeFail', `${label}: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

/** 技能库目录：默认 `<DSH_HOME>/skills`（全局技能，装完当轮即生效，无需重启）。 */
function skillDirOf(cfg) {
  return (cfg.skill && cfg.skill.dir) || path.join(dshHome(), 'skills');
}

/** 「已忽略」表最多记多少组 —— 防 state.json 无界膨胀。 */
const DISMISS_MAX = 200;

/**
 * 算技能建议（**零 LLM**）。
 *
 * 只做簇级预告：这组记忆在讲什么、什么时候用、为什么够格。
 * **不调模型** —— 注入是每轮关键路径，在这里调模型会同时违反
 * "关键路径零 LLM" 与"不该在后台悄悄生成技能"两条纪律。
 *
 * 返回已滤掉"用户已忽略"的组；任何异常都降级成空数组
 * （建议算不出来不该影响主流程）。
 */
export function computeSuggestions(memories, state, cfg) {
  if (!cfg || !cfg.skill || cfg.skill.enabled === false || cfg.skill.suggest === false) return [];
  try {
    return buildSuggestions(
      memories,
      {
        minScore: cfg.skill.minScore ?? 4,
        minSessions: cfg.skill.minSessions ?? 3,
        limit: 5,
      },
      (state && state.skillDismissed) || {},
    );
  } catch {
    return [];
  }
}

/**
 * 从全部建议里挑出"界面卡片要显示的那几组"。
 *
 * 口径与 Block E **一致**：`skill.suggestMax`（默认 1）—— 注入里最多提几组，
 * 卡片上就最多几行。一屏摆五行候选是真机反馈的问题（"太多了，默认 1 组就可以"）。
 *
 * 其余组一并交回去（`restKeys`）：卡片渲染时**把它们一起记成"看过"** ——
 * 否则下一轮又会冒出一行新的，等于换个方式刷屏。它们并没有丢：
 * Block E（注入）与 `memfuse_skill action=list` 里照样能看到、能提炼。
 */
export function selectUiSuggestions(suggestions, seen, pending, max = 1) {
  const limit = Number.isFinite(max) ? Math.max(1, Math.trunc(max)) : 1;
  const fresh = (suggestions || []).filter((s) => !(seen || {})[s.key] && !(pending || []).includes(s.key));
  return { shown: fresh.slice(0, limit), restKeys: fresh.slice(limit).map((s) => s.key) };
}

/**
 * 记住"用户忽略了这一组"，返回当前表大小。
 * 裁剪按**时间戳**删最旧的，而不是靠对象键序 —— 后者依赖实现细节。
 */
export async function dismissSuggestion(store, state, key) {
  const map = { ...((state && state.skillDismissed) || {}) };
  map[key] = new Date().toISOString();
  const entries = Object.entries(map);
  if (entries.length > DISMISS_MAX) {
    entries.sort((a, b) => String(a[1]).localeCompare(String(b[1])));
    state.skillDismissed = Object.fromEntries(entries.slice(entries.length - DISMISS_MAX));
  } else {
    state.skillDismissed = map;
  }
  await writeState(store, state);
  return Object.keys(state.skillDismissed).length;
}

/**
 * 用户"已经看到过这一组"（界面上卡片渲染过）→ 记进 `state.skillSeen`。
 *
 * 与 `dismiss` 的区别（这是"不能一直提示"的关键）：
 *   - `skillDismissed` = 明确"不用"，**prompt 与卡片都不再提**；
 *   - `skillSeen` = "看见过了"，只让**卡片**不再重复出现（组员变化 → key 变 → 重新提）。
 * 两者都落在 state.json 里，宿主与界面**共用同一份状态**
 * （两边各存一套的话，UI 点了"不用"下轮 prompt 还在 —— 正是要避免的"一直提示"）。
 */
export async function markSuggestionsSeen(store, state, keys) {
  const map = { ...((state && state.skillSeen) || {}) };
  const at = new Date().toISOString();
  for (const key of keys) map[key] = at;
  const entries = Object.entries(map);
  if (entries.length > DISMISS_MAX) {
    entries.sort((a, b) => String(a[1]).localeCompare(String(b[1])));
    state.skillSeen = Object.fromEntries(entries.slice(entries.length - DISMISS_MAX));
  } else {
    state.skillSeen = map;
  }
  await writeState(store, state);
  return Object.keys(state.skillSeen).length;
}

/**
 * 用户在界面上点了「提炼」→ 记一笔**待办**，让下一轮注入里的 Block E 催模型去调
 * `memfuse_skill action=distill`（零 LLM：这里只是记一条意愿，真正的提炼仍由模型+工具做）。
 */
export async function requestDistillKey(store, state, key) {
  const list = Array.isArray(state.distillRequests) ? state.distillRequests.slice() : [];
  if (!list.includes(key)) list.push(key);
  state.distillRequests = list.slice(-DISMISS_MAX);
  state.distillRequestsAt = { ...(state.distillRequestsAt || {}), [key]: new Date().toISOString() };
  await writeState(store, state);
  return state.distillRequests.length;
}

/** 提炼成功后把待办划掉（否则每轮都在催）。 */
export async function clearDistillRequest(store, state, key) {
  const list = Array.isArray(state.distillRequests) ? state.distillRequests : [];
  if (!list.includes(key)) return list.length;
  state.distillRequests = list.filter((k) => k !== key);
  if (state.distillRequestsAt) delete state.distillRequestsAt[key];
  await writeState(store, state);
  return state.distillRequests.length;
}

/** 读「技能 ← 记忆」来源映射（derived-into 反向标记用）。 */
async function readSkillSources(store) {
  try {
    return JSON.parse(await fsp.readFile(store.root.skillSources, 'utf8'));
  } catch {
    return {};
  }
}

/** 写来源映射（原子）。 */
async function writeSkillSources(store, map) {
  const tmp = `${store.root.skillSources}.tmp-${process.pid}`;
  await fsp.writeFile(tmp, JSON.stringify(map, null, 2), 'utf8');
  await fsp.rename(tmp, store.root.skillSources);
}

// ── 技能提炼 / 安装：**工具与界面共用同一份实现** ────────────────────────
//
// 为什么非要抽出来（缺陷 25）：界面上的「提炼成技能」以前只记一条待办
// （`requestDistill`），真正的提炼靠下一轮注入里的 Block E 催模型去调工具。
// 于是用户点完按钮**什么都看不到** —— 卡片那一行被 `unpinRow` 去掉，没有第二阶段。
// 现在界面自己就能提炼，但它**不能有第二份实现**：两条路径各写一遍，
// 迟早一条改了另一条没改（本项目"功能存在但只在一条路径生效"已经踩过好几次，
// 见缺陷 12b / 真机那次 `ghost-provider` 降级）。

/**
 * 待确认队列里的技能草稿 —— 界面要连 **SKILL.md 原文** 一起看，所以这里直接读出来。
 *
 * 界面据此渲染"提示词 + 作用 + 装不装"，也是**刷新页面后草稿还在**的原因
 * （草稿的真源是磁盘上的 `pending-skills/`，不是浏览器内存）。
 */
export async function pendingSkillDrafts(store, cfg) {
  const pendingDir = store.root.pendingSkills;
  const installDir = skillDirOf(cfg);
  const out = [];
  for (const s of await listSkills(pendingDir)) {
    const content = await readSkill(pendingDir, s.name);
    if (content === undefined) continue; // 读不到就不列（listSkills 已经把 problem 标出来了）
    out.push({
      name: s.name,
      description: s.description || '',
      content,
      loadable: s.loadable !== false,
      problem: s.problem ?? null,
      installPath: path.join(installDir, s.name, 'SKILL.md'),
    });
  }
  return out;
}

/**
 * 把一个候选簇提炼成待确认技能（写进 `pending-skills/`，**不**装进技能库）。
 *
 * @param opts.match  - 按记忆 id / 标题挑种子（`memfuse_skill` 工具那条路用）
 * @param opts.seedId - 按记忆 id 挑种子（界面那条路用：它手里只有候选 key）
 * @param opts.opt    - 目标覆盖（`exec.agent.options`，用来支持「跟随对话模型」）
 */
export async function distillCluster({
  store,
  cfg,
  state,
  ctx,
  logger,
  match = '',
  seedId = '',
  opt = {},
  deadline,
  signal,
}) {
  // 和抽取共用同一个目标解析：跟随对话模型 / 显式配置 / 关闭
  const target = extractTarget(ctx, cfg.extract || {}, opt);
  if (!target.ok) {
    return {
      ok: false,
      disabled: target.disabled === true,
      error: `${target.reason}（技能**候选识别**不需要模型，已经跑过了）`,
    };
  }
  const all = await store.list();
  const cands = findCandidates(all, {
    minScore: cfg.skill.minScore,
    minSessions: cfg.skill.minSessions,
    limit: 5,
  });
  if (!cands.length) {
    return { ok: false, error: '没有够格的候选（门槛见 status.md 的「技能候选」节）' };
  }
  const bySeed = seedId ? all.find((r) => r.id === seedId) : null;
  const pick = bySeed
    ? { rec: bySeed }
    : (match && cands.find((c) => c.rec.id === match || c.rec.title === match)) || cands[0];
  const cluster = clusterAround(pick.rec, all, 6);

  const res = await runWithTarget(
    ctx,
    cfg,
    logger,
    target.provider,
    target.model,
    (callModel) => distillSkill({ cluster, callModel, maxBytes: cfg.skill.maxBytes }),
    // 技能提炼也是一次模型调用，同样要有总预算 + 取消信号（缺陷 29）
    { deadline, signal },
  );
  if (res.targetError) {
    state.lastSkillError = res.targetError;
    await writeState(store, state);
    return { ok: false, error: res.targetError, cluster: cluster.map((c) => c.title) };
  }
  if (!res.ok) {
    state.lastSkillError = res.error;
    await writeState(store, state);
    return { ok: false, error: res.error, skipped: res.skipped === true, cluster: cluster.map((c) => c.title) };
  }

  const pendingDir = store.root.pendingSkills;
  await writeSkill(pendingDir, res.name, res.content);
  // 坑 4 的对策：写完立刻自校验。不过就删掉，绝不留一个静默无效的技能。
  const check = await verifySkill(pendingDir, res.name);
  if (!check.ok) {
    await rejectPendingSkill(pendingDir, res.name);
    state.lastSkillError = `写完自校验失败：${check.problem}`;
    await writeState(store, state);
    return { ok: false, error: `写完自校验失败：${check.problem}`, name: res.name };
  }

  const sources = await readSkillSources(store);
  sources[res.name] = cluster.map((c) => c.id);
  await writeSkillSources(store, sources);
  state.lastSkillSuccess = new Date().toISOString();
  state.lastSkillError = null;
  // 界面点过「提炼」的待办到此为止 —— 不划掉的话每轮 Block E 都会催。
  // key 用插件自己的 clusterKey 算（簇身份的唯一来源，别在别处重新实现）。
  await clearDistillRequest(store, state, clusterKey(cluster));
  await writeState(store, state);
  await store.appendUsage({ type: 'skill-distill', name: res.name, cluster: cluster.map((c) => c.id) });
  return {
    ok: true,
    name: res.name,
    description: res.description,
    content: res.content,
    cluster: cluster.map((c) => c.title),
    installPath: path.join(skillDirOf(cfg), res.name, 'SKILL.md'),
  };
}

/**
 * 装进技能库（= 把 `pending-skills/<name>` 移到技能目录）。
 * 装完立刻自校验 + `derived-into` 反向标记 + 回读宿主 `skills` 服务交叉验证。
 */
export async function approveSkill({ store, cfg, state, ctx, name }) {
  const dir = skillDirOf(cfg);
  const moved = await approvePendingSkill(store.root.pendingSkills, dir, name);
  if (!moved.ok) return moved;
  const check = await verifySkill(dir, name);
  if (!check.ok) {
    state.lastSkillError = `安装后自校验失败：${check.problem}`;
    await writeState(store, state);
    return { ok: false, error: `安装后自校验失败：${check.problem}`, path: moved.path };
  }
  // derived-into 反向标记：技能 ↔ 记忆双向可追溯，防"同一件事两处各写一遍"
  const sources = await readSkillSources(store);
  let marked = 0;
  for (const id of sources[name] || []) {
    try {
      const rec = await store.read(id);
      if (!rec) continue;
      await store.write({ ...rec, derivedInto: name });
      marked++;
    } catch {
      /* drift guard 拒绝等：跳过，不影响技能安装 */
    }
  }
  delete sources[name];
  await writeSkillSources(store, sources);
  await store.appendUsage({ type: 'skill-approve', name, marked });

  // 交叉验证：DSH 是否真的认到这个技能（宿主有 skills 服务时）
  let visibleInHost = null;
  try {
    const svc = typeof ctx?.get === 'function' ? ctx.get('skills') : null;
    if (svc && typeof svc.list === 'function') {
      const list = await svc.list({});
      visibleInHost = Array.isArray(list) && list.some((s) => s.name === name);
    }
  } catch {
    /* 宿主没暴露 skills 服务：跳过，不算失败 */
  }
  return { ok: true, name, path: moved.path, markedSources: marked, visibleInHost };
}

/** 丢掉一份待确认草稿（用户在卡片上按「丢掉」）。 */
export async function rejectSkill({ store, name }) {
  const out = await rejectPendingSkill(store.root.pendingSkills, name);
  if (out.ok) await store.appendUsage({ type: 'skill-reject', name });
  return out;
}

/**
 * read-before-write 证据检查。
 *
 * 要求调用方**自己的会话事件**里存在 `memfuse_skill action=show <name>` 的
 * `tool/call` 记录。防的是"凭记忆瞎改一个自己从没读过的技能" ——
 * 技能是注入即生效的指令，改错会永久影响每一次会话。
 *
 * 会话日志就是权威的重建边界（借用 evolve 的判据）。
 *
 * ⚠️ 事件来源走 `sessionEvents()`：真机上没有 `session.events`（见那里的注释）。
 * 早先直接读 `session.events` → 这个闸门**永远拿不到证据**，`patch` 永远被拒。
 */
export function hasShownSkill(exec, toolName, name) {
  const { events } = sessionEvents(exec && exec.agent && exec.agent.session);
  if (!events.length) return false;
  for (const ev of events) {
    if (!ev || ev.type !== 'tool/call') continue;
    if (!ev.data || ev.data.name !== toolName) continue;
    try {
      const a = JSON.parse(ev.data.arguments);
      if (a && a.action === 'show' && a.name === name) return true;
    } catch {
      /* 参数不是合法 JSON：忽略这一条 */
    }
  }
  return false;
}

// ───────────────────── 零 LLM 兜底捕获（F1）─────────────────────

const pad2 = (n) => String(n).padStart(2, '0');
const localDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const hhmm = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

/**
 * 这条 `user/message` 是不是**真人**输入？
 *
 * 真机上 `user/message` 是个大杂烩。本机全部会话日志累计统计（source.kind）：
 *
 *     user=341  runtime-context=196  skill-catalog=75  agent-instructions=49
 *     subagent-settled=32  tool-jobs=30  user-approval=20  agent-message=18
 *     model-selection=14  compact-checkpoint=8  plugin=7  repeat-tool-reminder=6 …
 *
 * 也就是说"向后扫到的最后一条用户消息"**大概率是系统注入**（运行时上下文快照、
 * 技能目录、工作区指令、审批策略变更通知……）。早先只挡了 `kind === 'plugin'`
 * 一种；等 `session.events` 修好、捕获真的开始工作之后，这些模板就会被当成
 * "真人说过的话"落盘，抽取出来全是"本轮运行环境快照"这类垃圾记忆 ——
 * 一个静默死掉的功能，修活之后立刻变成一台制造噪声的机器。
 *
 * 所以这里用**白名单**：只有 `kind === 'user'`（以及没有 source 的兼容形状）
 * 才算真人输入。跳过而不是中断 —— 扫描方向是从后往前，跳过注入块才能继续
 * 找到本轮真正的用户提问。
 */
function isHumanMessage(data) {
  const source = data && data.source;
  if (!source || typeof source !== 'object') return true; // 兼容没有 source 的旧形状
  return source.kind === 'user';
}

/**
 * 从会话事件里取「最后一条真人用户消息 + 最后一条 assistant 文本消息」。
 *
 * **自引用防护**：插件自己注入的内容（Block A–D，`source.kind === 'plugin'`）
 * 以及宿主的各种系统注入（见 `isHumanMessage`）都必须跳过 —— 否则注入的记忆块
 * 会被当成用户输入再存一遍，形成自我复制。
 */
export function extractExchange(events, opts = {}) {
  const beforeTurn = opts.beforeTurn;
  const requireTurnEnd = opts.requireTurnEnd === true;

  // ① **先定位 assistant 正文**，② 再从它往前配对同一轮的 user 消息。
  // 顺序不能反：先找 user 再找 assistant 时，一旦 assistant 被过滤掉（见下），
  // 就会把"这一轮的提问"和"上一轮的回答"拼成一条 —— 静默的数据错配。
  let assistantText = '';
  let assistantSeq;
  let assistantAt = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (!ev || typeof ev !== 'object') continue;
    if (ev.type !== 'assistant/message') continue;
    // ⚠️ 这一轮**还没结束**：半截回答不许记。
    // `pre-step` 触发点会在一轮的每个 step 之前都跑到，不加这道门就会把同一条提问
    // 记成好几块（真机现场：同一个"我重启了…"被记了两遍，回复还各是半截）。
    if (beforeTurn !== undefined && ev.data && ev.data.turn === beforeTurn) continue;
    // **更硬的判据，不依赖任何 payload 字段**：这条 assistant 消息之后必须出现过
    // `turn/end`，才算"这一轮已经收尾"。真机踩过 —— `agent/pre-step` 的 payload 里
    // 根本没有 `agent`（宿主派发的是 `{messages, ...position, signal}`），
    // 所以按 payload 的 turn 过滤是死路；按**事件流**判断才可靠。
    if (requireTurnEnd) {
      const end = events.find((e) => e && e.type === 'turn/end' && e.seq > ev.seq);
      // 只认**正常收尾**的轮次（缺陷 33b）：报错 / 被用户中断 / 被 fork 的轮次里，
      // assistant 正文是半截、甚至是错误回显，记进记忆库就是脏数据。
      // 真机现场：16:33 那块就是一个 400「model is unavailable」回合。
      if (!end || !isCapturableTurnEnd(end)) continue;
    }
    const t = textOfMessage(ev.data);
    if (!t) continue;
    assistantText = t;
    assistantSeq = ev.seq;
    assistantAt = i;
    break;
  }
  if (assistantAt < 0) return { userText: '', assistantText: '', assistantSeq: undefined };

  let userText = '';
  for (let i = assistantAt; i >= 0; i--) {
    const ev = events[i];
    if (!ev || typeof ev !== 'object') continue;
    if (ev.type !== 'user/message') continue;
    if (!isHumanMessage(ev.data)) continue;
    userText = textOfMessage(ev.data);
    if (userText) break;
  }
  return { userText, assistantText, assistantSeq };
}

/**
 * 读一个 session 对象上的事件流 —— **以真机形状为准**。
 *
 * ⚠️ 真机上**没有** `session.events`。`dsh-session` 的 `Session` 类把事件放在私有
 * 字段 `log` 里，公开访问器只有 `ownEvents()` / `snapshotEvents()` / `eventAt()`。
 * 本机探针实测（见 spec §3.12 缺陷 12）：
 *
 *     ('events' in session) === false
 *     原型成员 = constructor, surface, id, eventAt, snapshotEvents, ownEvents,
 *                isOwnSeq, seq, append, requestHeader, requestContext, toolHistory,
 *                deriveMessages, deriveEventMessage
 *
 * 早先照文档猜的 `session.events` 让**兜底捕获整条路径静默死掉**：`turn/end` 每轮
 * 都在 `Array.isArray(session.events)` 那一行 return，`sessions/` 永远是空的，
 * 而且没有任何故障留痕 —— 正是本项目最怕的"功能存在但从不生效"。
 * 同一个字段还被 `hasShownSkill()` 用来做技能的 read-before-write 闸门，
 * 于是 `memfuse_skill action=patch` 也变成**永远拒绝**（show 过也没用）。
 *
 * 优先顺序：`ownEvents()`（只取本会话自己的事件 —— 最窄，fork 场景不会把父会话
 * 的内容再存一遍）→ `events`（旧的假 ctx / 别的宿主实现可能只有这个）→
 * `snapshotEvents()`（兜底；含继承来的历史，能用但最宽）。
 *
 * 用 `.call(session)` 而不是 `session.ownEvents()`：保持 `this` 绑定，
 * 也避免把访问器解构出来之后调用（那样 this 会丢）。
 *
 * @returns {{ events: readonly object[], via: string|null }} `via === null` 表示这个
 *   对象上**没有任何**可读的事件访问器 —— 调用方必须把这件事记成故障，不能静默跳过。
 */
export function sessionEvents(session) {
  if (!session || typeof session !== 'object') return { events: [], via: null };
  for (const key of ['ownEvents', 'events', 'snapshotEvents']) {
    let value;
    try {
      value = session[key];
    } catch {
      continue; // 访问器本身抛错（未注入的服务之类）：换下一个
    }
    if (Array.isArray(value)) return { events: value, via: key };
    if (typeof value === 'function') {
      try {
        const out = value.call(session);
        if (Array.isArray(out)) return { events: out, via: `${key}()` };
      } catch {
        /* 这一个读不出来，试下一个 */
      }
    }
  }
  return { events: [], via: null };
}

/**
 * `turn/end` 事件的收尾原因（`data.reason`）。
 *
 * 宿主真实形状是**对象**（`{ kind: 'completed' }` 等，见 `TurnEndReasonMap`），
 * 但早先的测试夹具用的是字符串 `'stop'`。两种都认，认不出来返回 `null`。
 */
export function turnEndKind(event) {
  const reason = event && event.data ? event.data.reason : undefined;
  if (!reason) return null;
  if (typeof reason === 'string') return reason;
  if (typeof reason === 'object' && typeof reason.kind === 'string') return reason.kind;
  return null;
}

/**
 * 这些收尾原因说明**这一轮没说完**，里面的 assistant 正文不能当"最终回答"记下来。
 *
 * `error` = 模型/网络报错（真机上出现过 400 model-unavailable），
 * `aborted` = 用户点了停止，`interrupted` = 被上游打断，
 * `forked` = 这一轮被压缩/fork 截断，`blocked` = 被策略拦住。
 *
 * 判据是**黑名单**而不是白名单：宿主契约里以后多出别的 kind 时，宁可多记一轮，
 * 也不能因为一个没见过的字符串让捕获静默停摆 —— 那正是缺陷 30 的形态（fail-open）。
 */
const NON_CAPTURABLE_TURN_ENDS = new Set(['error', 'aborted', 'interrupted', 'forked', 'blocked']);

/** 这一轮的收尾方式是否值得捕获（认不出来的原因一律当"可以"）。 */
export function isCapturableTurnEnd(event) {
  const kind = turnEndKind(event);
  return kind === null || !NON_CAPTURABLE_TURN_ENDS.has(kind);
}

/**
 * 这个会话是不是**子代理（委派）会话**。
 *
 * 宿主给每个会话一个不可变的 `SessionHeader`，里面 `origin: 'subagent'` 明确标出
 * 委派来源（见 host `SessionHeader` 契约）。子代理会话不是人机对话：它的
 * `user/message` 全是运行时注入（`source.kind` 是 `runtime-context` 之类），永远
 * 配不出"真人提问 + 最终回答"。
 *
 * 早先没有这道判据，`agent/pre-step` 的兜底捕获会去抓"最后一个发事件的会话"——
 * 子代理一跑就把目标抢走，于是每步报一次「本轮没找到真人输入」的假告警，
 * 而真正该抓的主会话一次也没抓（缺陷 33，真机现场）。
 */
export function isSubagentSession(session) {
  try {
    return Boolean(session && session.header && session.header.origin === 'subagent');
  } catch {
    return false;
  }
}

/**
 * 事件流里有没有**任何一条**真人输入。
 *
 * 用来把两种完全不同的情况分开：① 这个会话本来就没有人机对话（子代理 / 纯系统会话）
 * —— 没有可捕获的东西，不是故障；② 有真人提问、但这一轮还没收尾 —— pre-step 在一轮的
 * 每个 step 前都会到，此时当然还没收尾，也不是故障。
 */
export function hasHumanMessage(events) {
  if (!Array.isArray(events)) return false;
  for (const ev of events) {
    if (!ev || ev.type !== 'user/message') continue;
    if (!isHumanMessage(ev.data)) continue;
    if (textOfMessage(ev.data)) return true;
  }
  return false;
}

/**
 * 把本轮最终问答原文追加到 `sessions/<date>.md`。
 *
 * DSH 是常驻 web 应用、没有"会话结束"钩子，所以用 `turn/end` 作为捕获时机
 * （参照 dsh-memsearch）。落盘前过一遍凭据过滤 —— 这里用**替换**而不是拒绝，
 * 因为整轮丢弃会连带丢掉同一轮里其他有价值的信息。
 * @param {object} [opts]
 * @param {number|string} [opts.beforeTurn] 当前进行中的轮次 id。给了它，
 *   就只捕获**更早的**轮次 —— pre-step 触发点必须传，否则会把半截回答记下来。
 */
async function captureTurn(store, cfg, logger, session, lastSeq, opts = {}) {
  const cap = cfg.capture || {};
  if (cap.enabled === false) return null;
  const view = sessionEvents(session);
  if (!view.via) {
    noteFault(
      store && store.runtimeFaults,
      'captureFail',
      '宿主 session 对象上没有可读的事件访问器（events / ownEvents / snapshotEvents 都没有）—— 兜底捕获无法工作',
    );
    return null;
  }
  const { userText, assistantText, assistantSeq } = extractExchange(view.events, {
    // pre-step 触发点要告诉它"当前这一轮还没结束"，别把半截回答记下来
    beforeTurn: opts.beforeTurn,
    requireTurnEnd: opts.requireTurnEnd === true,
  });
  // ⚠️ 下面这几个 return 以前是**完全静默**的（缺陷 30）：真机上捕获停了整整一小时，
  // status.md 依旧写「健康 ✅」，因为"没找到真人输入 / 没找到正文"既不报错也不留痕。
  // 但留痕也不能乱留 —— **假故障和静默失败一样有害**（缺陷 32、33 各踩一次）。
  // 现在按"这是不是真异常"分档：正常情况静默跳过，异常才记 captureFail。
  if (!userText) {
    // ① 这个会话里从来没有真人输入：子代理 / 纯系统会话，本来就没东西可捕。
    if (!hasHumanMessage(view.events)) return null;
    // ② 有真人提问，但这一轮还没走到 `turn/end`：`agent/pre-step` 在一轮的**每个 step**
    //    之前都会到，此时本轮当然还没收尾。这是正常，不是故障（缺陷 33）。
    if (opts.quietNoExchange === true) return null;
    // ③ 有真人提问、轮次也收尾了，却配不出问答 —— 这才是真异常，必须留痕。
    //    消息里刻意**不写事件条数**：pre-step 每个 step 都会重算，条数一变告警文案就跟着抖
    //    （真机现场 35→64→70→86→94 条，看着像出了大事，其实只是我多调了几个工具）。
    noteFault(
      store && store.runtimeFaults,
      'captureFail',
      `捕获跳过：有真人输入但配不出这一轮的问答（via=${view.via}）`,
    );
    return null;
  }
  if (userText.length < (cap.minPromptLength ?? 10)) {
    // ⚠️ **正常跳过，不是故障**：用户就说了句「重启了」（3 个字），
    // 不到 `minPromptLength` 的门槛，本来就不该记。
    // 以前这里和"根本没找到真人输入"共用同一个分支，于是每遇到一次短消息，
    // 注入块里就挂一条假的「记忆功能部分不可用」—— **假故障和静默失败一样有害**，
    // 会把真正的问题淹掉（真机现场就是这么冒出假告警的）。
    return null;
  }
  if (assistantSeq === undefined) {
    noteFault(
      store && store.runtimeFaults,
      'captureFail',
      `捕获跳过：本轮没找到带正文的 assistant 消息（via=${view.via}）`,
    );
    return null;
  }
  if (lastSeq.get(session.id) === assistantSeq) return null; // 同一轮不写两次（正常去重，不留痕）
  lastSeq.set(session.id, assistantSeq);

  const now = new Date();
  const max = cap.maxChars ?? 4000;
  const cut = (t) => {
    const s = String(t || '');
    const clipped = s.length > max ? `${s.slice(0, max)}…（已截断）` : s;
    return redactThreats(clipped).text;
  };
  // ── 内容级去重（缺陷 30c）──
  // 内存里的 `lastCapturedSeq` 只管"这一个进程实例"。
  // 真机上出现过：同一轮的块被写了好几遍 —— 因为插件在文件改动后被**重载**，
  // `apply()` 跑了多次，`session/event` 监听器叠了多份；重启后 seq 去重也会归零。
  // 所以再加一道**不依赖注册次数、也不依赖进程**的判据：看块里的标记是不是已经写过了。
  //
  // 标记必须带上 `session.id`：不同会话里出现**一模一样**的问答是正常的
  // （测试和真实场景都有），只按文本去重会把它们误杀掉。
  // 用 HTML 注释包起来，Markdown 渲染时不可见，对模型的干扰也最小。
  const mark = `<!-- cap:${String(session.id ?? 'unknown')}:${assistantSeq} -->`;
  const file = path.join(store.root.sessions, `${localDate(now)}.md`);

  try {
    const prev = await fsp.readFile(file, 'utf8');
    if (prev.includes(mark)) {
      lastSeq.set(session.id, assistantSeq);
      return null;
    }
  } catch {
    /* 文件还不存在（今天第一次写）—— 正常，继续追加 */
  }

  const block =
    `\n### ${hhmm(now)}\n` +
    '=== 本轮最终问答（原始记录，未经提炼）===\n' +
    `[User]: ${cut(userText)}\n` +
    `[DSH]: ${cut(assistantText || '(无文本回复)')}\n` +
    `${mark}\n`;

  try {
    await store.locked(() => fsp.appendFile(file, block, 'utf8'));
    return file;
  } catch (e) {
    // 落盘失败以前只 `logger.warn` —— 而 desktop 的 console 用户看不见，
    // 于是"捕获停了"在界面上等于没发生（缺陷 30）。必须进运行期故障表。
    noteFault(store && store.runtimeFaults, 'captureFail', `捕获落盘失败：${e.message}`);
    logger.warn?.(`[dsh-memfuse] 捕获落盘失败：${e.message}`);
    return null;
  }
}

// ───────────────────── stage1 抽取（F2）─────────────────────

/**
 * 用宿主 `ctx.llm` 调一次模型，把 `text-delta` 块拼起来。
 *
 * 宿主 API（已核实）：`stream(options: GenerateOptions): AsyncIterable<StreamChunk>`，
 * `GenerateOptions` 的 `provider` / `model` 都是必填；chunk 形如
 * `{ type: 'text-delta', text }`。这里刻意只取 text-delta ——
 * reasoning-delta 是思考过程，不该进记忆。
 */
/**
 * ctx → llm 服务。由 `apply()` 里的**可选注入**填充（见那里的注释）。
 *
 * 为什么用 WeakMap 而不是闭包变量：`runExtraction()` 这些走模型的路径是
 * **模块级函数**，它们只拿得到 `ctx`，拿不到 apply 的局部变量。
 * 用 ctx 做键既不用改这些函数的签名，也不会在 ctx 释放后泄漏。
 */
const llmByCtx = new WeakMap();

/** 读某个 ctx 的 llm 服务；没注入过就返回 null（**不抛错**）。 */
function llmFor(ctx) {
  try {
    return llmByCtx.get(ctx) || null;
  } catch {
    return null;
  }
}

/**
 * 空正文的原因描述 —— **这个字符串就是排查现场**。
 *
 * 真机踩过：抽取报「模型输出无法解析为候选数组（前 200 字：）」——括号后面什么都没有，
 * 等于一点线索都没留下（用户和我都无从下手）。真实成因通常是这三种之一：
 *   ① 推理型模型把 maxTokens 全用在"思考"上 → `finish=max-tokens`、零个文本增量；
 *   ② 上游只回了个空的 stop（中转站抽风 / 参数被吞）；
 *   ③ 我们的 chunk 处理漏了某个字段（所以要打 chunk 类型直方图 —— 一眼看得出）。
 */
function emptyOutputReason({ finishKind, seen, reasoning, usage, maxTokens }) {
  const parts = [];
  if (finishKind === 'max-tokens') parts.push(`输出被 maxTokens(${maxTokens}) 截断`);
  parts.push(`finish=${finishKind ?? '(没收到 finish)'}`);
  parts.push(`文本增量 0 个${reasoning ? `，但收到推理增量 ${reasoning.length} 字` : ''}`);
  if (usage) {
    const used = [`输出 ${usage.outputTokens ?? '?'} tokens`];
    if (usage.reasoningTokens) used.push(`其中推理 ${usage.reasoningTokens}`);
    parts.push(`用量：${used.join('，')}`);
  }
  const kinds = [...(seen ?? new Map()).entries()].map(([kind, count]) => `${kind}×${count}`).join(' ');
  if (kinds) parts.push(`收到的 chunk：${kinds}`);
  const hint = reasoning
    ? '；看着是推理型模型 —— 给抽取换一个非推理模型，或把「跟随对话模型」关掉手选一个'
    : '；可能是上游返回了空响应，重试一次或换一个模型';
  return `模型没有返回任何正文（${parts.join('；')}）${hint}`;
}

function makeModelCaller(ctx, provider, model, opts = {}) {
  /**
   * 本轮还剩多少预算（毫秒）；`opts.deadline` 是绝对时间戳。
   *
   * 有了它，一次 `memfuse_extract` 处理三个会话文件时才不会"每个各等 90 秒"
   * （那会顶穿宿主窗口，把一次成功的抽取改写成超时）。用完就明确报错，
   * 没处理完的文件水位线不动，下次接着跑 —— 不会丢素材。
   */
  const remaining = () => {
    if (!Number.isFinite(opts.deadline)) return MODEL_CALL_TIMEOUT_MS;
    const left = opts.deadline - Date.now();
    if (left <= 1000) {
      throw new Error('本次抽取的时间预算已用完（还没处理的会话文件下次会接着跑，素材不会丢）');
    }
    return Math.min(MODEL_CALL_TIMEOUT_MS, left);
  };

  /** 跑一次流式调用，把**现场**（chunk 直方图 / finish / 用量）一起收回来。 */
  const runOnce = async (llm, input, maxTokens) => {
    let text = '';
    let reasoning = '';
    let failure = null;
    let finishKind = null;
    let usage = null;
    // chunk 类型直方图：出问题时这是**唯一的现场**（见 emptyOutputReason）。
    const seen = new Map();
    const budget = remaining();
    const stream = llm.stream({
      provider,
      model,
      system: EXTRACT_SYSTEM,
      messages: [{ role: 'user', content: [{ type: 'text', text: input }] }],
      maxTokens,
      temperature: 0.2,
    });
    // ⚠️ **不能**直接 `for await (const chunk of stream)`（缺陷 29）：
    // 上游光连不吐时它会永远挂着，而 `GenerateOptions` 没有 `signal` 字段掐不断它。
    // `drainStream` 加的是"无进展窗口"（见它的注释），并响应工具的取消信号。
    for await (const chunk of drainStream(stream, budget, {
      signal: opts.signal,
      // 绝对截止时间：只要还在推进就不腰斩，但整次抽取不能无限长
      absDeadline: opts.deadline,
      onTimeout: () => {
        const faults = faultsFor(ctx);
        if (faults) {
          noteFault(
            faults,
            'modelTimeout',
            `${provider}/${model} 超过 ${Math.round(budget / 1000)} 秒没有任何推进 —— 已放弃等待（上游可能还在跑）`,
          );
        }
      },
    })) {
      const kind = chunk && typeof chunk.type === 'string' ? chunk.type : '(无 type)';
      seen.set(kind, (seen.get(kind) ?? 0) + 1);
      if (kind === 'text-delta' && typeof chunk.text === 'string') text += chunk.text;
      // 推理增量单独收着：它不算正文，但**空正文时它就是关键证据**。
      if (kind === 'reasoning-delta' && typeof chunk.text === 'string') reasoning += chunk.text;
      if (kind === 'usage' && chunk.usage) usage = chunk.usage;

      // ⚠️ 宿主**不抛错** —— 模型失败被编码进 finish chunk 的 reason.failure。
      // 真机实测（中转站返回 HTTP 400「模型价格未配置」）：
      //   { type:'finish', reason:{ kind:'error', failure:{ message:'400: {...}' } } }
      // 不检查它的话，**任何**模型失败（限流 / 鉴权 / 定价 / 模型不存在）都会被
      // 伪装成"模型输出无法解析为候选数组" —— 真实原因全丢。
      // 而"失败可见"正是本插件的差异化之一（HANDOFF §4.4）。
      //
      // `FinishReason` 按宿主契约有 5 种：stop / tool-calls / max-tokens / aborted / error，
      // 其中带 `failure` 的是 **aborted 与 error 两种** —— 都要当失败。
      if (kind === 'finish') {
        finishKind = chunk.reason?.kind ?? null;
        if (finishKind === 'error' || finishKind === 'aborted') {
          failure = chunk.reason.failure?.message || '未提供原因';
        }
      }
    }
    return { text, reasoning, failure, finishKind, usage, seen, maxTokens };
  };

  return async (input) => {
    // llm 是**可选**服务，用 llmFor() 读。
    // 不能直接写 `!ctx.llm` —— cordis 对未声明服务的属性访问**会抛错**
    // （`cannot get property "llm" without inject`），守卫本身就会炸。
    const llm = llmFor(ctx);
    if (!llm || typeof llm.stream !== 'function') {
      throw new Error('宿主未提供 llm 服务（该 profile 未装 llm 插件），无法调用模型');
    }
    // 4000 而不是 2000：推理型模型会先花一大截 token "思考"，给正文留出余量。
    let attempt = await runOnce(llm, input, 4000);

    // 撞上 maxTokens 就**加倍重试一次** —— 只在有这个证据时重试，不做无条件重试。
    // ⚠️ 判定条件是 `finish=max-tokens`，**不要求正文为空**：真机上更常见的是
    // "写了一半的 JSON"（前 200 字看着完全合法、整段却是坏的）。只按"空正文"判定会漏掉它。
    // 两次都取更长的那个文本 —— 截断场景下"更长"就是"更接近完整输出"。
    if (!attempt.failure && attempt.finishKind === 'max-tokens') {
      const retry = await runOnce(llm, input, 8000);
      // `>=` 而不是 `>`：两次都空时保留**重试的那次**，错误消息里的 maxTokens 才是
      // 我们真正试过的最后一个值（报 4000 会让人以为没重试过）。
      if (!retry.failure && retry.text.length >= attempt.text.length) attempt = retry;
    }

    // 只抛**服务端给的原始原因**。上层（extract.js / distill.js）已经会加
    // 「模型调用失败：」前缀，这里再加一次会变成
    // 「模型调用失败：模型调用失败：400: …」。
    if (attempt.failure) throw new Error(String(attempt.failure).slice(0, 300));
    // 空正文**在这里**就报，别让它一路飘到"无法解析为候选数组"那里
    // （那时候上下文全丢了，报出来的东西没有任何信息量）。
    if (attempt.text.trim() === '') throw new Error(emptyOutputReason(attempt));
    return attempt.text;
  };
}

/** 把一个候选（队列项或 auto 模式的产出）写成真记忆。 */
async function writeCandidate(store, cfg, logger, item) {
  const now = new Date().toISOString();
  const rec = {
    id: newId(),
    scope: item.scope === 'global' ? 'global' : 'workspace',
    kind: item.kind || 'fact',
    priority: item.priority || 'P2',
    confidence: typeof item.confidence === 'number' ? item.confidence : 0.7,
    title: String(item.title || '(无标题)').slice(0, 80),
    summary: String(item.summary || '').slice(0, 300),
    anchor: String(item.anchor || '').slice(0, 300),
    tags: Array.isArray(item.tags) ? item.tags.slice(0, 12) : [],
    // 自动抽取的产物**不是**用户资产：它应该能被淘汰、能被自动升级
    source: 'auto',
    managedBy: 'auto',
    lifecycle: 'active',
    created: now,
    updated: now,
    expires: policy.computeExpiry(item.priority || 'P2', cfg.lifecycle),
    stats: { recalled: 0, injected: 0, positive: 0, negative: 0 },
    body: String(item.body || item.summary || item.title || ''),
  };
  const bad = await mutate(store, logger, 'extract-write', async () => {
    await store.write(rec);
    await store.rebuildIndex();
    await commitOrWarn(store, logger, `memfuse: extract add ${rec.id}`);
  });
  return bad ? null : rec;
}

/**
 * 跑一轮抽取。
 *
 * 素材来自 `sessions/*.md`（F1 的零 LLM 兜底捕获）。水位线 `state.extracted`
 * 记录每个文件已处理到的**字符数**，只处理新增部分；**只有成功才推进水位线**，
 * 失败的文件下次会重试同一段。
 *
 * 失败会写 `state.lastExtractError` / `lastErrorAt` —— 这让 Block D 的
 * 「抽取管线故障」分支第一次有了真实数据源（原来无人写这两个字段）。
 */
// ───────────────────── 抽取目标的可用性（静态预检 + 降级）─────────────────────

/**
 * 预检抽取目标：provider 与 model 是否真的存在于宿主注册表里。
 *
 * 为什么值得多查一次：模型名写错 / provider 插件没装时，**每次抽取都会白跑一趟
 * API**（延迟、配额、日志噪音），而答案其实是静态可查的。真机就踩过：
 * `deepseek-official` 在 web profile 里根本不存在 → 4ms 空返回，看起来像"模型乱答"。
 *
 * **查不动时返回 ok:true** —— 宿主没提供 listProviders/listModels 就当作"查不了"，
 * 绝不因为查不了而拦下抽取（那是把工具的错误变成用户的损失）。
 */
async function probeTarget(ctx, provider, model) {
  const llm = llmFor(ctx);
  if (!llm) return { ok: true, unchecked: true };
  if (typeof llm.listProviders !== 'function') return { ok: true, unchecked: true };

  // 这两个调用会走 adapter → 可能是网络（对 OpenAI 兼容中转站就是 `/v1/models`）。
  // **必须设预算**：真机实测同一条路一次 52 秒、一次 12 毫秒（缺陷 29）。
  // 超时按"查不动"放行 —— 预检只是省一次调用，绝不能让它把人拖住。
  const faults = faultsFor(ctx);
  const onSlow = (what) => {
    if (!faults) return;
    noteFault(
      faults,
      'probeTimeout',
      `${what} 超过 ${PROBE_BUDGET_MS}ms 没返回 —— 已按"查不动"放行，继续抽取（预检只是省一次调用，不该拖住用户）`,
    );
  };

  let provs;
  try {
    provs = await withBudget(Promise.resolve(llm.listProviders()), PROBE_BUDGET_MS, () =>
      onSlow('llm.listProviders()'),
    );
  } catch {
    return { ok: true, unchecked: true };
  }
  if (provs === null) return { ok: true, unchecked: true, slow: true };
  if (!Array.isArray(provs) || !provs.length) return { ok: true, unchecked: true };
  if (!provs.some((p) => p && p.id === provider)) {
    const avail = provs.map((p) => p.id).join(', ') || '无';
    return { ok: false, reason: `provider "${provider}" 不在宿主注册表里（可用：${avail}）` };
  }

  if (typeof llm.listModels !== 'function') return { ok: true, unchecked: true };
  let models;
  try {
    models = await withBudget(Promise.resolve(llm.listModels(provider)), PROBE_BUDGET_MS, () =>
      onSlow(`llm.listModels("${provider}")`),
    );
  } catch {
    return { ok: true, unchecked: true };
  }
  if (models === null) return { ok: true, unchecked: true, slow: true };
  if (!Array.isArray(models) || !models.length) return { ok: true, unchecked: true };
  if (!models.some((m) => m && m.id === model)) {
    const avail = models.map((m) => m.id).join(', ') || '无';
    return { ok: false, reason: `模型 "${model}" 不在 provider "${provider}" 下（可用：${avail}）` };
  }
  return { ok: true };
}

/**
 * 拿「对话主模型」：`agentDefaultModel` 是宿主的一个 cordis Service，
 * `currentSelection()` 返回 `{ provider, model, reasoningEffort? }` ——
 * 也就是用户在对话框里选的那个。
 *
 * 读不到就返回 null（宿主没装这个服务 / 还没选模型），**不抛错**：
 * "跟随对话模型"失败不该把整条路径炸掉。
 */
function conversationTarget(ctx) {
  if (!ctx || typeof ctx.get !== 'function') return null;
  let sel = null;
  try {
    const svc = ctx.get('agentDefaultModel');
    sel = svc && typeof svc.currentSelection === 'function' ? svc.currentSelection() : null;
  } catch {
    return null;
  }
  return sel && sel.provider && sel.model ? { provider: sel.provider, model: sel.model } : null;
}

/**
 * 决定这条路径用哪个 (provider, model) —— **三种形态，一个出口**。
 *
 *   ① `extract.followConversation = true` → 跟随「对话主模型」（对话框里选的那个）。
 *      这是 UI 上的勾选项，用户不必在这里再选一遍；读不到就明确报错，不静默退化。
 *   ② 显式 `provider` + `model`（UI 里用模型选择器挑的）。
 *   ③ 两者都没有 ⇒ **抽取关闭**。这是**默认状态**：
 *      "不使用 LLM"是一等公民，记忆的读写、注入、检索、技能判定全部照常。
 *
 * 抽出来共用是因为它有四个调用点（启动抽取 / memfuse_extract / dryRun / 技能提炼）——
 * 只在其中一处写，必然有漏网的（缺陷 10 就是这么来的）。
 *
 * @returns `{ ok: true, provider, model, source }` 或
 *   `{ ok: false, disabled?: true, reason }`（disabled = 用户没配，不是故障）
 */
function extractTarget(ctx, ex, override = {}) {
  const p = override.provider || ex.provider;
  const m = override.model || ex.model;

  // ① 总开关：**默认关闭**。关着的时候连"勾了跟随"都不看 —— 一个按钮说了算。
  if (!isOn(ex.enabled)) {
    return {
      ok: false,
      disabled: true,
      reason:
        '自动抽取没开启（**默认关闭**）。想开启：打开「插件 → dsh-memfuse → 配置」里的开关，' +
        '再挑一个模型或勾「跟随对话模型」。关着的时候记忆的读写、注入、检索、技能判定全部照常。',
    };
  }

  // ② 用哪个模型：跟随对话主模型 → 显式挑选
  if (isOn(ex.followConversation)) {
    const conv = conversationTarget(ctx);
    if (conv) return { ok: true, provider: conv.provider, model: conv.model, source: '对话主模型' };
    return {
      ok: false,
      reason:
        '开关开着、也勾了「跟随对话模型」，但读不到 agentDefaultModel.currentSelection()' +
        '（宿主没装这个服务，或还没选模型）—— 先在对话框里选一个模型，或改成手工指定。',
    };
  }
  if (p && m) return { ok: true, provider: p, model: m, source: override.provider ? '工具参数' : '显式配置' };

  // ③ 开了开关却没得用：这是**真故障**（用户明明开了），要报出来而不是静默
  return {
    ok: false,
    reason:
      '开关开着，但既没挑模型也没勾「跟随对话模型」—— 抽取无从下手。' +
      '去「插件 → dsh-memfuse → 配置」挑一个模型，或勾上「跟随对话模型」。',
  };
}

/**
 * 拿降级目标：显式配的优先，否则跟随「对话主模型」。
 */
function fallbackTarget(ctx, ex) {
  const p = ex.fallbackProvider;
  const m = ex.fallbackModel;
  if (p && m) return { provider: p, model: m, source: '显式配置' };
  const conv = conversationTarget(ctx);
  return conv ? { provider: conv.provider, model: conv.model, source: '对话主模型' } : null;
}

/**
 * 「跟随对话模型」模式下，**显式配置的那对**就是它的降级目标（反之亦然）。
 *
 * ⚠️ 必须从配置里重新取，不能拿去解析后的那对：跟随模式下 `ex.provider/model`
 * 已经被换成对话主模型了，直接拿来当降级目标就是在原地打转（测试抓出来的）。
 *
 * @returns `undefined` = 非跟随模式，按老规矩算；`null` = 跟随但没得降。
 */
function followFallback(ex, followed) {
  if (!followed) return undefined;
  return ex.provider && ex.model ? { provider: ex.provider, model: ex.model, source: '显式配置' } : null;
}

/**
 * 决定本轮抽取用哪个 (provider, model)。
 *
 * 对应真机上「模型不可用」的两种形态中的**第一种**：
 *   - **静态不可用**（名字错 / provider 没装）→ 这里就能查出来，不必白跑 API
 *   - **动态不可用**（限流 / 鉴权 / 定价）→ 只有真调了才知道，由调用处按同一策略处理
 *
 * `onUnavailable: 'stop'` ⇒ 直接失败（失败会写 `lastExtractError` → Block D 报出来）。
 * `onUnavailable: 'fallback'` ⇒ 换降级目标；**降级目标自己也要过预检**，
 * 否则只是把一次无效调用换成另一次。
 */
async function pickTarget(ctx, ex, fallback) {
  const primary = await probeTarget(ctx, ex.provider, ex.model);
  if (primary.ok) return { ok: true, provider: ex.provider, model: ex.model };

  if (ex.onUnavailable !== 'fallback') {
    return {
      ok: false,
      reason: `${primary.reason}；onUnavailable=stop → 不再尝试（想让它自动改用对话主模型就设 'fallback'）`,
    };
  }

  const fb = fallback === undefined ? fallbackTarget(ctx, ex) : fallback;
  if (!fb) {
    return {
      ok: false,
      reason: `${primary.reason}；且拿不到降级目标（未配 fallbackProvider/Model，也读不到 agentDefaultModel）`,
    };
  }
  const check = await probeTarget(ctx, fb.provider, fb.model);
  if (!check.ok) {
    return { ok: false, reason: `${primary.reason}；降级目标（${fb.source}）也不可用 —— ${check.reason}` };
  }
  return {
    ok: true,
    provider: fb.provider,
    model: fb.model,
    viaFallback: true,
    reason: `${primary.reason} → 已降级到${fb.source} ${fb.provider}/${fb.model}`,
  };
}

/**
 * 跑一次**一次性**的模型调用（dryRun / 技能提炼这种），按 onUnavailable 策略处理不可用：
 * 静态不可用在调用前拦下（不白跑 API），动态失败在事后换目标**重试一次**。
 *
 * ⚠️ 为什么必须共用一个包装器：`makeModelCaller` 有三个调用点
 * （抽取循环 / extract 的 dryRun / skill 的 distill）。策略只在抽取那条上写一遍的话，
 * 必然会有漏网的路径 —— **真机实测就是这样**：抽取成功降级了，
 * 技能提炼却仍然撞在坏 provider 上，报 `no adapter registered for provider "ghost-provider"`。
 * 一条策略只在一个地方实现，才不会有漏。
 *
 * @param {(caller: Function) => Promise<any>} fn 拿到 caller 之后怎么用
 * @returns fn 的返回值；或 `{ targetError }`（目标彻底不可用时）
 */
async function runWithTarget(ctx, cfg, logger, provider, model, fn, opts = {}) {
  const ex = cfg.extract || {};
  const target = await pickTarget(
    ctx,
    { ...ex, provider, model },
    followFallback(ex, isOn(ex.followConversation)),
  );
  if (!target.ok) return { targetError: target.reason };
  if (target.viaFallback) logger.warn?.(`[dsh-memfuse] 抽取降级：${target.reason}`);

  const first = await fn(makeModelCaller(ctx, target.provider, target.model, opts));
  if (!first || !first.error) return first;
  if (target.viaFallback || ex.onUnavailable !== 'fallback') return first;

  const fb = fallbackTarget(ctx, ex);
  if (!fb) return first;
  if (fb.provider === target.provider && fb.model === target.model) return first;
  const chk = await probeTarget(ctx, fb.provider, fb.model);
  if (!chk.ok) return first;

  logger.warn?.(
    `[dsh-memfuse] 调用失败，降级到${fb.source} ${fb.provider}/${fb.model}：${first.error}`,
  );
  const retry = await fn(makeModelCaller(ctx, fb.provider, fb.model, opts));
  return retry || first;
}

async function runExtraction(store, cfg, logger, ctx, state, opts = {}) {
  const ex = cfg.extract || {};
  // 目标解析只有这一个出口：跟随对话模型 / 显式配置 / 关闭（默认）
  const picked = extractTarget(ctx, ex, opts);
  if (!picked.ok) {
    if (picked.disabled) return { ok: false, disabled: true, reason: picked.reason, candidates: 0, queued: 0, written: 0 };
    state.lastExtractError = picked.reason;
    state.lastErrorAt = new Date().toISOString();
    logger.warn?.(`[dsh-memfuse] 抽取目标不可用：${picked.reason}`);
    return { ok: false, reason: picked.reason, candidates: 0, queued: 0, written: 0, targetError: true };
  }
  const provider = picked.provider;
  const model = picked.model;
  state.extractSource = picked.source;
  state.extractProvider = provider;
  state.extractModel = model;

  // 预检 + 降级决策：静态不可用在这里就处理掉，不白跑一次 API
  const target = await pickTarget(ctx, { ...ex, provider, model }, followFallback(ex, isOn(ex.followConversation)));
  if (!target.ok) {
    state.lastExtractError = target.reason;
    state.lastErrorAt = new Date().toISOString();
    logger.warn?.(`[dsh-memfuse] 抽取目标不可用：${target.reason}`);
    return { ok: false, reason: target.reason, candidates: 0, queued: 0, written: 0, targetError: true };
  }
  if (target.viaFallback) {
    logger.warn?.(`[dsh-memfuse] 抽取降级：${target.reason}`);
  }

  const dir = store.root.sessions;
  let files = [];
  try {
    files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.md')).sort();
  } catch {
    files = [];
  }
  if (opts.file) files = files.filter((f) => f === opts.file || f === `${opts.file}.md`);
  if (!files.length) return { ok: true, candidates: 0, queued: 0, written: 0, files: 0 };

  const callerOpts = { deadline: opts.deadline, signal: opts.signal };
  let caller = makeModelCaller(ctx, target.provider, target.model, callerOpts);
  // 已经降过一次就不再降 —— 否则一个坏掉的账号能让每次抽取都白跑两趟
  let usedFallback = !!target.viaFallback;
  const watermark = state.extracted && typeof state.extracted === 'object' ? state.extracted : {};
  const limit = Math.max(1, Number(opts.limit) || Number(ex.maxPerStartup) || 3);
  let processed = 0;
  let candidates = 0;
  let queued = 0;
  let written = 0;
  const errors = [];
  /** 总预算到点没有 —— 到了就收尾，别让第 2、3 个文件各再等一整个模型预算。 */
  const outOfBudget = () => Number.isFinite(opts.deadline) && Date.now() >= opts.deadline;

  for (const name of files) {
    if (processed >= limit) break;
    if (outOfBudget()) {
      errors.push('时间预算用完，还没处理的会话文件本轮跳过了（下次会接着跑，素材不会丢）');
      break;
    }
    // ⚠️ 以前这里是 `.catch(() => '')`：读失败变成空字符串 → 被当成"没有新内容"跳过，
    // 整轮还照样报成功。等于**静默丢素材**，直接违反硬规则 4（不许静默失败）。
    let full = '';
    try {
      full = await fsp.readFile(path.join(dir, name), 'utf8');
    } catch (e) {
      errors.push(`${name}: 读取失败 ${e.message}`);
      continue;
    }
    const alreadyRaw = Number(watermark[name]) || 0;
    let already = alreadyRaw;
    if (alreadyRaw > full.length) {
      // ⚠️ 水位线越界（缺陷 31）：`sessions/*.md` 被**人工清理 / 截断**过，
      // 或者两处写入打架，水位就会比文件还长。此时 `full.slice(already)` 恒为空，
      // 于是每一轮都"没有新素材"—— 抽取**静默停摆**，而且 status.md 还写「健康 ✅」。
      // 这和缺陷 29 里那个"假成功"是同一类病，不能放过。
      //
      // 处理：按"已抽过的部分仍算已抽"夹到文件尾 —— **宁可漏掉这一段**
      // （下一段新素材照样能抽），也不要整篇重抽一遍，
      // 那会在 auto 模式下把同一批候选**重复写进记忆库**。
      // 但要留痕：这是"数据被改过"，不是正常状态。
      already = full.length;
      watermark[name] = already;
      noteFault(
        store && store.runtimeFaults,
        'extractWatermark',
        `${name}: 抽取水位线(${alreadyRaw}) 超过文件长度(${full.length}) —— ` +
          '文件被清理/截断过，已按"已抽取"夹到文件尾（这段内容不会重抽，避免重复写入记忆库）',
      );
    }
    const fresh = full.slice(already);
    if (fresh.length < (ex.minChars || 200)) continue; // 新增太少，省一次调用
    processed++;

    const chunk = fresh.slice(0, ex.maxInputChars || 12000);
    let res = await extractCandidates({
      text: chunk,
      callModel: caller,
      maxCandidates: ex.maxCandidates || 6,
    });

    // 动态不可用（只有真调了才知道的那种）：限流 / 鉴权 / 定价 / 服务端不认模型名。
    // 按同一策略处理 —— 'stop' 走下面的失败路径；'fallback' 换目标**再试一次**。
    if (res.error && !usedFallback && ex.onUnavailable === 'fallback') {
      const fb = fallbackTarget(ctx, ex);
      if (fb && (fb.provider !== target.provider || fb.model !== target.model)) {
        const chk = await probeTarget(ctx, fb.provider, fb.model);
        if (chk.ok) {
          const prev = res.error;
          caller = makeModelCaller(ctx, fb.provider, fb.model, callerOpts);
          usedFallback = true;
          // status.md 的「抽取管线」要反映**实际**在用的模型，而不是配置里那个坏的
          state.extractProvider = fb.provider;
          state.extractModel = fb.model;
          logger.warn?.(
            `[dsh-memfuse] 抽取调用失败，降级到${fb.source} ${fb.provider}/${fb.model}：${prev}`,
          );
          res = await extractCandidates({
            text: chunk,
            callModel: caller,
            maxCandidates: ex.maxCandidates || 6,
          });
        }
      }
    }

    if (res.error) {
      errors.push(`${name}: ${res.error}`);
      continue; // 不推进水位线 → 下次重试同一段
    }
    watermark[name] = full.length; // 只有成功才推进
    candidates += res.candidates.length;

    for (const item of toPendingItems(res.candidates, name)) {
      if (ex.mode === 'auto') {
        if (await writeCandidate(store, cfg, logger, item)) written++;
      } else {
        await putPending(store.root, item);
        queued++;
      }
    }
  }

  state.extracted = watermark;
  if (errors.length) {
    state.lastExtractError = errors.join(' | ').slice(0, 500);
    state.lastErrorAt = new Date().toISOString();
    logger.warn?.(`[dsh-memfuse] 抽取失败：${state.lastExtractError}`);
  } else if (processed > 0) {
    state.lastExtractSuccess = new Date().toISOString();
    state.lastExtractError = null;
  } else {
    // ⚠️ `processed === 0` 是"**没有任何新素材**"，不是"抽取成功"（缺陷 29）。
    // 以前这里直接落进 else：一次模型都没调，也给 `lastExtractSuccess` 盖了个当前时间戳，
    // 于是 status.md 上写着「最近成功：刚刚 / 健康 ✅ 正常」—— 假成功，
    // 把真故障（今天那次卡住的抽取）盖得干干净净，查了两轮才看出来。
    // 现在单独记一个时间戳，status.md 会照实写"无新素材（跳过）"。
    state.lastExtractSkippedAt = new Date().toISOString();
  }
  await writeState(store, state);
  return {
    ok: errors.length === 0,
    candidates,
    queued,
    written,
    files: processed,
    skipped: processed === 0 && errors.length === 0,
    errors,
  };
}

// ───────────────────────── 插件主体 ─────────────────────────

/**
 * 把配置整棵树拍平成纯值，解开 schemastery 的 volatile 引用。
 *
 * `.volatile()` 字段被解析成**引用对象**（读值要 `.get()`）—— 这是设置页
 * 改动能实时生效的代价（见 config.js 里的说明）。而插件内部一律按普通值
 * 使用配置，所以进 apply 之前先把引用解开。
 *
 * ⚠️ 判定方式是**显式检查 `.get`**，照 `dsh-settings` 的 `plainConfig`：
 *     if (isVolatile(value)) return plainConfig(value.get());
 *
 * 早先图省事写成 `JSON.parse(JSON.stringify(cfg))`，结果引用对象没被拆开
 * —— `extract.provider` 一路是对象，最终在真机上炸成
 * `provider "[object Object]" 不在宿主注册表里`（Block D 报出来的）。
 * 序列化能不能拆开它取决于引用对象的 `toJSON()`，而那并不是契约的一部分。
 */
function plainify(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(plainify);
  if (typeof value.get === 'function') return plainify(value.get());
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = plainify(v);
  return out;
}

/**
 * 布尔配置的**宽松读取**：`true` / `'true'` / volatile 引用（`{ get() }`）都算开。
 *
 * 为什么不能直接 `=== true`：volatile 引用在配置里到处可能漏出来（缺陷 11 的教训 ——
 * `provider` 就那样变成过 `"[object Object]"`）。开关判断要是被一个对象噎住，
 * 表现就是"用户明明打开了，插件以为关着"—— 又一个静默失败。
 */
function isOn(value) {
  if (value === true || value === 'true') return true;
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    const raw = value.get();
    return raw === true || raw === 'true';
  }
  return false;
}

export function apply(ctx, userConfig = {}) {  const cfg = deepMerge(DEFAULT_CONFIG, plainify(userConfig));
  if (cfg.enabled === false) return;

  const logger = cfg.verbose ? console : { log() {}, warn: console.warn, error: console.error };
  const store = new MemoryStore(cfg, logger);

  // ── settings：让配置出现在「设置 → 插件」里（**可选**依赖）──────
  // 声明并导出 Config 之后，DSH 会把它渲染成设置页（条目 status 从 "absent" 变 "schema"）。
  // 与 llm 同理：没有 settings 服务的宿主上必须照常工作，所以用 ctx.inject()
  // 做运行时可选注入，而不是硬依赖。
  if (typeof ctx?.inject === 'function') {
    try {
      ctx.inject(['settings'], (child) => {
        // 照 official 插件的写法：disposer 交给 cordis 的 effect 管理，
        // 不自己存 —— 插件卸载时它会被自动释放。
        child.effect(() => child.settings.configure({ auto: true }, ctx.fiber));
      });
    } catch (e) {
      // 注册不上不该拖垮插件：配置仍可通过 cordis.patch.yml 设置。
      logger.warn?.(`[dsh-memfuse] settings 可选注入失败：${e.message}`);
    }
  }

  // 运行期故障账本：那些原本"只 console.warn"的 fail-safe 分支把故障记在这里，
  // 由 healthOf() 读出来送进 Block D / status.md。
  // 不这样做的话，注入挂载失败 / 写入失败在 Web UI 里就是静默的 ——
  // 用户看到的现象是"没有记忆"，而不是"记忆坏了"。
  const runtimeFaults = {};
  // 挂到 store 上：模块级的 fail-safe 分支（touchMemory / captureTurn 等）
  // 拿不到 apply 的局部变量，但都有 store。
  store.runtimeFaults = runtimeFaults;
  // 也按 ctx 挂一份：`probeTarget` / `makeModelCaller` 这些模块级函数只有 ctx
  // （缺陷 29 —— 预检超时、模型调用超时都要能留痕，不许静默）。
  faultsByCtx.set(ctx, runtimeFaults);
  const probe = probeHost(ctx);

  // ── llm：**可选**依赖 ──────────────────────────────────────
  // 抽取（F2）与技能提炼（H2）需要它，但记忆的读 / 写 / 注入 / 检索
  // 必须在没有它的宿主上照常工作（HANDOFF §4.1：不因缺依赖整块失效）。
  // cordis 的 `inject` 数组是**硬依赖**（缺服务整个插件起不来，且没有 optional 语法），
  // 所以这里用 ctx.inject() 做运行时可选注入 —— 服务可用时才回调。
  if (typeof ctx?.inject === 'function') {
    try {
      ctx.inject(['llm'], (llmCtx) => {
        llmByCtx.set(ctx, llmCtx.llm);
        llmCtx.effect(() => () => {
          llmByCtx.delete(ctx);
        }, 'dsh-memfuse:llm-ref');
      });
    } catch (e) {
      logger.warn?.(`[dsh-memfuse] llm 可选注入失败：${e.message}`);
    }
  }

  /**
   * 等可选的 llm 注入落定（缺陷 28）。
   *
   * 真机记录：启动抽取报「宿主未提供 llm 服务（该 profile 未装 llm 插件）」——
   * 而那个 profile **装了**模型服务。原因是 `ctx.inject(['llm'], …)` 的回调是
   * **异步**到达的（新版本装配顺序变了，回调晚于 `apply()` 返回），启动抽取抢跑
   * 就会误判成"宿主没有 llm"，把人往错方向带。
   *
   * 所以开跑之前等一小会儿（默认 2s，够注入落定）；等不到就按"真没有"处理。
   */
  async function waitForLlm(ms = 2000) {
    if (llmFor(ctx)) return true;
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      // 同样不 unref：这个等待本身要能撑住事件循环（否则测试里会提前"空转结束"）
      await new Promise((resolve) => setTimeout(resolve, 40));
      if (llmFor(ctx)) return true;
    }
    return false;
  }

  // 延迟初始化：不阻塞宿主启动
  let readyState = null;
  const initTask = (async () => {
    await store.init();
    const state = await readState(store);
    readyState = state;
    // status.md / Block D 要反映**实际会用**的模型：勾了「跟随对话模型」时，
    // 配置里那两项是空的，但管道是开着的 —— 只写配置值会让人以为抽取是关的。
    const effective = extractTarget(ctx, cfg.extract || {});
    state.extractEnabled = isOn(cfg.extract.enabled);
    state.extractSource = effective.ok ? effective.source : '关闭';
    state.extractProvider = effective.ok ? effective.provider : cfg.extract.provider || null;
    state.extractModel = effective.ok ? effective.model : cfg.extract.model || null;
    // 让 healthOf() 能读到运行期故障（同一个对象引用 —— apply 里各处随时往里写）
    state.runtimeFaults = runtimeFaults;

    if (cfg.lifecycle.autoRunOnStart) {
      try {
        state.lastMaintenance = await runMaintenance(store, cfg, logger);
      } catch (e) {
        logger.warn?.(`[dsh-memfuse] maintenance failed: ${e.message}`);
      }
    }
    // ⚠️ 启动抽取**不在关键路径上**（缺陷 28）：它要调模型，可能几十秒、甚至不返回。
    // 以前它就在这儿 `await` —— 一旦卡住，`ready` 永不 settle，六个工具全部挂在
    // `await ready` 上，整轮对话连"停止"都停不下来（0.2.1-rc.1 真机现象）。
    // 现在挪到 `ready` 之后 fire-and-forget，见下面的 `void ready.then(...)`。
    // 技能候选识别（H1，**零 LLM**）：每次启动跑一遍，结果进 state 与 status.md。
    // 刻意只做识别不做提炼 —— 技能会真实改变 AI 行为，提炼必须显式触发。
    if (cfg.skill.enabled) {
      try {
        const all = await store.list();
        const cands = findCandidates(all, {
          minScore: cfg.skill.minScore,
          minSessions: cfg.skill.minSessions,
          limit: 5,
        });
        state.skillCandidates = cands.map((c) => ({
          id: c.rec.id,
          title: c.rec.title,
          score: c.score,
          reasons: c.reasons,
        }));
        if (cands.length) {
          logger.log?.(`[dsh-memfuse] 技能候选 ${cands.length} 个（用 memfuse_skill action=distill 提炼）`);
        }
      } catch (e) {
        logger.warn?.(`[dsh-memfuse] 技能候选识别失败：${e.message}`);
      }
    }
    // ── 界面数据通道（Remote）：客户端 UI 靠它读候选、用户靠它点「不用 / 提炼」──
    // 契约与"为什么手写描述符"见 lib/remote.js 顶部。装上失败**必须留痕**：
    // 只表现为"卡片不出现"是最难查的那种失败（本项目硬规则 4）。
    //
    // ⚠️ 每个写操作之后都要顺手刷一次 status.md（缺陷 21）：`markSuggestionsSeen` 等只写
    // state.json，于是 status.md 那行「界面已看过（skillSeen）: N 组」会一直停在旧值 ——
    // 而 status.md 是给人看的审计面，写晚了就是误导（真机上出现过"state.json 已有 5 组、
    // status.md 还写着 0 组"）。
    const refreshStatusAfterUi = async () => {
      try {
        await writeStatus(store, cfg, state, probe);
      } catch (e) {
        logger.warn?.(`[dsh-memfuse] 界面操作后刷新 status.md 失败：${e.message}`);
      }
    };
    const remoteInstall = installRemoteHost(ctx, {
      list: async () => {
        const all = await store.list();
        const seen = state.skillSeen || {};
        const pending = Array.isArray(state.distillRequests) ? state.distillRequests : [];
        // 卡片上最多几行 = `skill.suggestMax`（与 Block E 同一口径，默认 1）；
        // 没显示的组把 key 一起交回去，让卡片顺手记成"看过"，别改成排队刷屏。
        const { shown, restKeys } = selectUiSuggestions(
          computeSuggestions(all, state, cfg),
          seen,
          pending,
          cfg.skill.suggestMax,
        );
        const groups = shown.map((s) => ({
          key: s.key,
          seedTitle: s.seedTitle,
          members: s.members.length,
          memberTitles: s.members.slice(0, 4).map((m) => m.title),
          score: s.score,
          reasons: s.reasons.slice(0, 3),
          tags: s.tags,
          useWhen: s.useWhen ?? null,
          seen: Boolean(seen[s.key]),
        }));
        return {
          groups,
          restCount: restKeys.length,
          restKeys,
          seen: Object.keys(seen).length,
          dismissed: Object.keys(state.skillDismissed || {}).length,
          pendingDistill: pending,
          // 待确认的技能草稿（含 SKILL.md 原文）：界面据此渲染"提示词 + 作用 + 装不装"。
          // 从**磁盘**读，所以刷新页面后草稿照样在（缺陷 25 的另一半）。
          pendingSkills: await pendingSkillDrafts(store, cfg),
        };
      },
      dismiss: async (key) => {
        const dismissed = await dismissSuggestion(store, state, key);
        await refreshStatusAfterUi();
        return { ok: true, dismissed, key };
      },
      markSeen: async (keys) => {
        const seen = await markSuggestionsSeen(store, state, keys);
        await refreshStatusAfterUi();
        return { ok: true, seen, keys };
      },
      requestDistill: async (key) => {
        const pending = await requestDistillKey(store, state, key);
        await refreshStatusAfterUi();
        return { ok: true, pending, key };
      },
      // ── 缺陷 25：界面上的「提炼成技能」真的把 SKILL.md 写出来 ──────────────
      //
      // 以前这条路只记一条待办，真正的提炼等下一轮 Block E 催模型调工具 ——
      // 用户点完按钮什么都看不到（卡片那一行被去掉，没有第二阶段）。
      // 现在界面自己就能提炼；失败（没模型 / 模型报错 / 自校验不过）**如实带回界面**，
      // 由卡片写出来，绝不假装成功（硬规则 4）。
      distill: async (key) => {
        const all = await store.list();
        const s = computeSuggestions(all, state, cfg).find((x) => x.key === key);
        if (!s) {
          return { ok: false, error: `这一组候选已经不在列表里了（key=${key}）—— 下一轮再看一次卡片` };
        }
        // 界面这条路没有工具信号，但同样要有总预算 —— 不能因为上游卡住
        // 就把整个界面（以及最后那个回合）吊在那儿（缺陷 29）。
        const res = await distillCluster({
          store,
          cfg,
          state,
          ctx,
          logger,
          seedId: s.seedId,
          deadline: Date.now() + EXTRACT_BUDGET_MS,
        });
        await refreshStatusAfterUi();
        return res;
      },
      approve: async (name) => {
        const res = await approveSkill({ store, cfg, state, ctx, name });
        await refreshStatusAfterUi();
        return res;
      },
      reject: async (name) => {
        const res = await rejectSkill({ store, name });
        await refreshStatusAfterUi();
        return res;
      },
    });
    state.remoteChannel = remoteInstall.ok ? { endpoints: 7 } : { failed: remoteInstall.reason };
    if (!remoteInstall.ok) {
      noteFault(runtimeFaults, 'remoteFail', remoteInstall.reason);
      logger.warn?.(`[dsh-memfuse] 界面数据通道没装上：${remoteInstall.reason}`);
    }
    if (remoteInstall.ok && typeof remoteInstall.dispose === 'function') {
      ctx.effect(() => () => remoteInstall.dispose(), 'dsh-memfuse: remote contribution');
    }

    // 首次启动就把 state 落盘（水位线 / 抽取进度 / 上次维护 / 技能候选）。
    // 之前只在 runExtraction / flushInjected 里写 —— 首次启动且尚无会话时
    // state.json 根本不存在，status.md 的「上次维护 / 抽取进度」重启后就丢了。
    await writeState(store, state);
    await writeStatus(store, cfg, state, probe);
    return { store, state };
  })();

  /**
   * 启动初始化**一律带预算**（缺陷 28 —— 0.2.1-rc.1 兼容性事故的根修）。
   *
   * 现场：`memfuse_status` 调下去再也不返回，连「停止对话」都点不动。
   * 原因是两条叠在一起：
   *   ① 新宿主的 `ToolDefinition` 对**已经在跑**的 `execute` 是 **drain** 语义
   *      （"already-started work is still drained"）—— 我们不放，它就一直等；
   *   ② 六个工具的 `execute` 第一行都是 `await ready`，而 `ready` 里串着
   *      宿主侧调用（可选注入、Remote 挂载、启动抽取）。其中任何一个永不 settle，
   *      全体工具立刻死锁，且**没有任何超时能救**（我们自己没声明 `timeoutMs`）。
   *
   * 所以这里给启动链一个上限：到点降级放行（工具照常可用，读到的是上次落盘的
   * state），同时把故障记进 `runtimeFaults` → Block D / status.md（硬规则 4，
   * 不许静默）。之后要不要继续等，交给用户下次调用时自然重试。
   */
  const ready = withBudget(initTask, STARTUP_BUDGET_MS, () => {
    noteFault(
      runtimeFaults,
      'startupTimeout',
      `启动初始化超过 ${STARTUP_BUDGET_MS}ms 没完成 —— 工具已降级放行（记忆本体仍可读写）`,
    );
    logger.warn?.(`[dsh-memfuse] 启动初始化超预算（${STARTUP_BUDGET_MS}ms），工具降级可用`);
  }).then((r) => r ?? { store, state: readyState ?? { runtimeFaults } })
    .catch((error) => {
      // 初始化真的抛了（不是挂住）：留痕后**照样把错误抛回去**，别假装正常 ——
      // 工具会立刻返回一条看得见的错误，比"卡住"好一万倍。
      const message = String(error && error.message ? error.message : error);
      noteFault(runtimeFaults, 'startupFail', `启动初始化失败：${message}`);
      throw new Error(`记忆系统初始化失败：${message}（详见 status.md「运行期故障」）`);
    });

  // 启动抽取挪出关键路径：不 await、失败只留痕（它本来就有自己的 try/catch）。
  // 总预算比工具那条宽松（后台跑、没人在等），但**仍然有界** ——
  // 一次挂住的上游不该永远占着一个 pending promise（缺陷 29）。
  void ready.then(async (r) => {
    if (!cfg.extract.autoRunOnStart) return;
    try {
      // 新版本里可选注入是异步到达的，抢跑会误报"宿主未提供 llm 服务"（缺陷 28）
      await waitForLlm();
      const res = await runExtraction(store, cfg, logger, ctx, r.state, {
        deadline: Date.now() + STARTUP_EXTRACT_BUDGET_MS,
      });
      if (res.candidates) {
        logger.log?.(
          `[dsh-memfuse] 启动抽取：候选 ${res.candidates}，入队 ${res.queued}，直写 ${res.written}`,
        );
      }
    } catch (e) {
      logger.warn?.(`[dsh-memfuse] 启动抽取失败：${e.message}`);
    }
  });

  // ── 工具：memory_recall ────────────────────────────────
  const recallTool = {
    name: 'memfuse_recall',
    description:
      '检索长期记忆（跨会话持久的事实 / 约定 / 决策 / 经验）。' +
      'level=l0 只返回标题索引，level=l2 返回完整正文（默认 l1 摘要）。' +
      '省略 query 时按优先级返回最靠前的若干条（受 limit 限制，不是"全部"）。' +
      '每次调用请与上一次不同——拿到摘要后就去行动，不要反复检索。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '自然语言查询，省略则按优先级列出。' },
        level: { type: 'string', enum: ['l0', 'l1', 'l2'], description: '详情层级，默认 l1。' },
        limit: { type: 'number', description: '最多返回条数，默认 6，上限 20。' },
      },
    },
    output: textOutput('渲染好的记忆检索结果（JSON 文本）'),
    async execute({ query = '', level = 'l1', limit = 6 } = {}, exec) {
      const { store: st } = await ready;
      const all = await st.list();
      const hits = recall(all, query, { maxEntries: Math.max(1, Math.min(20, limit)) });
      // 生产端：召回计数 + 弱续期 + 跨会话模式识别（utility 的唯一数据来源）
      const sid = (exec && exec.agent && exec.agent.session && exec.agent.session.id) || currentSessionId || null;
      for (const h of hits) {
        await touchMemory(st, h.rec, { recalled: 1 }, cfg, logger, sid);
      }
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
    name: 'memfuse_write',
    description:
      '写入 / 修正 / 删除长期记忆，以及处理「待确认队列」。**唯一的写入路径，不要手工编辑记忆文件。**' +
      'mode: add（默认）/ replace（按 title 精确匹配重写）/ delete / revive（唤醒休眠记忆）/ ' +
      'approve（采纳一条抽取候选）/ reject（丢弃一条抽取候选）。' +
      '只在用户要求"记住 / 更正 / 忘掉"，或对抽取候选表态时调用。',
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['add', 'replace', 'delete', 'revive', 'approve', 'reject', 'duplicates', 'supersede'],
          description:
            '默认 add。revive = 唤醒休眠记忆；approve / reject = 处理抽取候选；' +
            'duplicates = 列出重复簇；supersede = 把旧条目归档（标 stale + 转休眠，原文保留）。',
        },
        scope: { type: 'string', enum: ['workspace', 'global'], description: '默认 workspace。' },
        kind: { type: 'string', enum: ['fact', 'convention', 'decision', 'constraint', 'skill', 'experience'] },
        priority: { type: 'string', enum: ['P0', 'P1', 'P2'], description: 'P0 = 用户置顶，永不过期。' },
        title: { type: 'string', description: '一行标题，≤ 80 字。' },
        summary: { type: 'string', description: '一句话摘要，≤ 300 字。' },
        body: { type: 'string', description: '完整正文（Markdown）。' },
        tags: { type: 'array', items: { type: 'string' } },
        anchor: { type: 'string', description: '未来什么情况下该召回它（不要复制内容）。' },
        match: { type: 'string', description: 'replace / delete / revive / supersede 时按此标题精确匹配。' },
        by: { type: 'string', description: 'supersede 时指定"保留哪一条"的标题。' },
      },
      required: ['mode'],
    },
    output: textOutput('写入 / 修正 / 删除的结果（JSON 文本）'),
    async execute(args = {}) {
      const { store: st, state } = await ready;
      const mode = args.mode || 'add';
      const now = new Date().toISOString();

      // F4：凭据过滤。记忆会被注入每一轮上下文、进 git、进 status.md、进 usage 日志，
      // 把凭据写进去等于把它扩散到上面每一处，而且你永远不会知道。
      // 拒绝而不是替换：显式写入是用户/模型有意识的行为，应该明确报错让它改。
      if (mode === 'add' || mode === 'replace') {
        const haystack = [args.title, args.summary, args.body, args.anchor].filter(Boolean).join('\n');
        const threat = scanThreat(haystack);
        if (threat) {
          return JSON.stringify({
            ok: false,
            error: `内容疑似包含凭据（命中「${threat}」），已拒绝写入。请改为记录"凭据放在哪里"，而不是内容本身。`,
          });
        }
      }

      // ── 待确认队列：approve / reject（不需要先 list 全库）──
      if (mode === 'approve' || mode === 'reject') {
        const match = args.match || args.title;
        const item = await findPending(st.root, match);
        if (!item) {
          return JSON.stringify({ ok: false, error: `待确认队列里没有「${match || '(空)'}」` });
        }
        if (mode === 'reject') {
          await dropPending(st.root, item._file);
          await st.appendUsage({ type: 'queue-reject', id: item.id, title: item.title });
          return JSON.stringify({ ok: true, rejected: item.id, title: item.title });
        }
        const rec = await writeCandidate(st, cfg, logger, item);
        if (!rec) return JSON.stringify({ ok: false, error: '写入失败（可能是 drift guard 拒绝，详见 status.md）' });
        await dropPending(st.root, item._file);
        await st.appendUsage({
          type: 'queue-approve',
          id: item.id,
          title: item.title,
          priority: item.priority,
          preference: item.preference === true,
        });
        return JSON.stringify({ ok: true, approved: item.id, memoryId: rec.id, title: item.title, priority: rec.priority });
      }

      // ── 反腐烂：列出重复簇 ──
      if (mode === 'duplicates') {
        const all = await st.list();
        const clusters = antiseptic.findDuplicateClusters(all);
        return JSON.stringify(
          {
            ok: true,
            count: clusters.length,
            clusters: clusters.map((c) => ({
              kind: c.kind,
              title: c.members[0].title,
              members: c.members.map((x) => ({
                id: x.id,
                priority: x.priority,
                updated: String(x.updated || '').slice(0, 10),
                stale: x.stale === true,
              })),
            })),
            note: '用 memfuse_write mode=supersede match="旧标题" by="保留标题" 归档旧条目',
          },
          null,
          2,
        );
      }

      // ── 反腐烂：归档旧条目（标记，不删除、不合并正文）──
      if (mode === 'supersede') {
        const oldTitle = args.match || args.title;
        const keepTitle = args.by;
        const all = await st.list();
        const oldRec = all.find((r) => r.title === oldTitle);
        const keepRec = keepTitle ? all.find((r) => r.title === keepTitle) : null;
        if (!oldRec) return JSON.stringify({ ok: false, error: `未找到要归档的标题「${oldTitle}」` });
        if (keepTitle && !keepRec) return JSON.stringify({ ok: false, error: `未找到要保留的标题「${keepTitle}」` });
        const next = {
          ...oldRec,
          stale: true,
          supersededBy: keepRec ? keepRec.id : null,
          lifecycle: 'dormant', // 不再注入，但仍在磁盘上、可 revive
          dormantAt: now,
        };
        const bad = await mutate(st, logger, 'supersede', async () => {
          await st.write(next);
          await st.rebuildIndex();
          await commitOrWarn(st, logger, `memfuse: supersede ${oldRec.id}`);
        });
        if (bad) return JSON.stringify(bad);
        await st.appendUsage({ type: 'supersede', id: oldRec.id, by: keepRec ? keepRec.id : null });
        return JSON.stringify({
          ok: true,
          superseded: oldRec.id,
          by: keepRec ? keepRec.id : null,
          note: '原文保留在磁盘上，可用 mode=revive 唤醒；没有做正文合并（合并会丢信息）',
        });
      }

      if (mode === 'delete' || mode === 'replace' || mode === 'revive') {
        const all = await st.list();
        const target = all.find((r) => r.title === (args.match || args.title));
        if (!target) return JSON.stringify({ ok: false, error: `未找到标题为「${args.match || args.title}」的记忆` });
        if (mode === 'delete') {
          const bad = await mutate(st, logger, 'delete', async () => {
            await st.remove(target.id, target.kind);
            await st.rebuildIndex();
            await commitOrWarn(st, logger, `memfuse: delete ${target.id}`);
          });
          if (bad) return JSON.stringify(bad);
          return JSON.stringify({ ok: true, deleted: target.id });
        }
        if (mode === 'revive') {
          // dormant 是单向棘轮：recall 只取 active，休眠后永远不会再被召回，
          // 信号恒为零 → 30 天后必被物理删除。这条路径给用户手动唤醒的主动权。
          if ((target.lifecycle || 'active') === 'active') {
            return JSON.stringify({ ok: true, revived: target.id, note: '本来就是 active，无需唤醒' });
          }
          const back = policy.revive(target, cfg.lifecycle);
          const bad = await mutate(st, logger, 'revive', async () => {
            await st.write(back);
            await st.rebuildIndex();
            await commitOrWarn(st, logger, `memfuse: revive ${target.id}`);
          });
          if (bad) return JSON.stringify(bad);
          return JSON.stringify({ ok: true, revived: target.id, expires: back.expires });
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
        const bad = await mutate(st, logger, 'replace', async () => {
          await st.write(next);
          await st.rebuildIndex();
          await commitOrWarn(st, logger, `memfuse: replace ${target.id}`);
        });
        if (bad) return JSON.stringify(bad);
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
      const bad = await mutate(st, logger, 'add', async () => {
        await st.write(rec);
        await st.rebuildIndex();
        await commitOrWarn(st, logger, `memfuse: add ${rec.id}`);
      });
      if (bad) return JSON.stringify(bad);
      return JSON.stringify({ ok: true, id: rec.id, priority: rec.priority, expires: rec.expires });
    },
  };

  // ── 工具：memory_status ────────────────────────────────
  const statusTool = {
    name: 'memfuse_status',
    description: '查看记忆系统健康状态：条数、优先级分布、抽取管线是否正常。',
    parameters: { type: 'object', properties: {} },
    output: textOutput('记忆系统健康状态（JSON 文本）'),
    async execute() {
      const { store: st, state } = await ready;
      const all = await st.list();
      const health = healthOf(state);
      const pending = await listPending(st.root);
      const sum = (k) => all.reduce((a, r) => a + ((r.stats && r.stats[k]) || 0), 0);
      return JSON.stringify(
        {
          root: st.root.root,
          total: all.length,
          active: all.filter((r) => (r.lifecycle || 'active') === 'active').length,
          dormant: all.filter((r) => (r.lifecycle || 'active') === 'dormant').length,
          priorities: all.reduce((a, r) => ((a[r.priority] = (a[r.priority] || 0) + 1), a), {}),
          // 学习状态：这几个数字是"越用越懂我"的可观测证据
          learning: {
            recalled: sum('recalled'),
            injected: sum('injected'),
            positive: sum('positive'),
            negative: sum('negative'),
            promoted: all.filter((r) => r.promotedAt).length,
          },
          pendingQueue: {
            count: pending.length,
            titles: pending.slice(0, 10).map((p) => `${p.priority || 'P2'} ${p.title}`),
          },
          extract: {
            provider: cfg.extract.provider || null,
            model: cfg.extract.model || null,
            mode: cfg.extract.mode,
            lastSuccess: state.lastExtractSuccess || null,
            // 最近一次"没有新素材"的跳过时间（缺陷 29）：它既不是成功也不是失败，
            // 但必须能看见 —— 否则"最近成功"看起来像刚跑过一轮模型，实则一次都没调。
            lastSkipped: state.lastExtractSkippedAt || null,
            lastError: state.lastExtractError || null,
          },
          health,
        },
        null,
        2,
      );
    },
  };

  // ── 工具：memfuse_feedback ─────────────────────────────
  const feedbackTool = {
    name: 'memfuse_feedback',
    description:
      '回报一条记忆本轮到底有没有用。**这是记忆系统唯一的学习信号来源** —— ' +
      'negative 会下调它的置信度、影响以后排序，并降低它被自动删除的门槛判断；' +
      '跨多个会话被反复召回的条目会自动升优先级。' +
      '只在用户明确表态时调用（"这条不对" / "这个我早说过" / "对，就是这样"）；' +
      '用户没表态就不要乱调，噪声会污染统计。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '记忆 id（memfuse_recall 返回结果里的 id 字段）。' },
        sign: { type: 'string', enum: ['positive', 'negative'], description: 'positive = 有用；negative = 没用或误导。' },
        reason: { type: 'string', description: '一句话原因（可选）。' },
        category: { type: 'string', description: '工作分类，如 编程/前端/小程序（可选，用于按类统计满意度）。' },
        quote: { type: 'string', description: '用户原话摘录（可选，程序会截断到 20 字）。' },
      },
      required: ['id', 'sign'],
    },
    output: textOutput('反馈结果（JSON 文本）'),
    async execute(args = {}, exec) {
      const { store: st } = await ready;
      const id = String(args.id || '').trim();
      if (!id) return JSON.stringify({ ok: false, error: '缺少 id' });
      const sign = args.sign === 'negative' ? 'negative' : 'positive';
      const rec = await st.read(id);
      if (!rec) return JSON.stringify({ ok: false, error: `未找到 id 为 ${id} 的记忆` });

      const sid = (exec && exec.agent && exec.agent.session && exec.agent.session.id) || currentSessionId || null;
      const ok = await touchMemory(
        st,
        rec,
        sign === 'negative' ? { negative: 1 } : { positive: 1 },
        cfg,
        logger,
        sid,
      );
      await st.appendUsage({
        type: 'feedback',
        id,
        sign,
        reason: args.reason ? String(args.reason).slice(0, 200) : '',
        category: args.category ? String(args.category).slice(0, 80) : '',
        quote: args.quote ? String(args.quote).slice(0, 20) : '',
        session: sid,
      });
      const after = await st.read(id);
      return JSON.stringify({
        ok,
        id,
        sign,
        title: rec.title,
        confidence: after ? after.confidence : null,
        stats: after ? after.stats : null,
        utility: after ? Number(policy.utility(after.stats).toFixed(3)) : null,
      });
    },
  };

  // ── 工具：memfuse_extract ──────────────────────────────
  const extractTool = {
    name: 'memfuse_extract',
    description:
      '把最近的会话原文提炼成长期记忆。素材来自 sessions/ 里每轮自动落盘的原始问答。' +
      '默认模式下抽取结果进「待确认队列」，由用户用 memfuse_write mode=approve / reject 处理；' +
      '也可以只查看不落库（dryRun）。需要 extract.provider + extract.model，' +
      '未配置时会明确报错而不是静默跳过。用户说"把这几天的对话整理成记忆"时调用。',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '只处理某个会话文件（如 2026-10-15），省略则按水位线处理未处理的。' },
        limit: { type: 'number', description: '本次最多处理几个文件，默认 3。' },
        dryRun: { type: 'boolean', description: 'true = 只返回候选不落库，用于先看效果。' },
      },
    },
    output: textOutput('抽取结果（JSON 文本）'),
    async execute(args = {}, exec) {
      const { store: st, state } = await ready;
      const opt = (exec && exec.agent && exec.agent.options) || {};
      const target = extractTarget(ctx, cfg.extract || {}, opt);
      // 整次调用的总预算 + 取消信号（缺陷 29）。
      // 宿主 0.2.1 的 `timeoutMs` 是**协作式**的：它不会强制返回，只会在 25 秒后把
      // `exec.signal` 置成 aborted —— 工具自己理会它，顶栏的「停止」才真的点得动。
      const runOpts = {
        deadline: Date.now() + EXTRACT_BUDGET_MS,
        signal: exec && exec.signal,
      };

      if (args.dryRun) {
        // dryRun 走一遍完整管线但不落盘、不推进水位线
        const dir = st.root.sessions;
        const names = (await fsp.readdir(dir).catch(() => [])).filter((f) => f.endsWith('.md')).sort();
        const picked = args.file ? names.filter((f) => f === args.file || f === `${args.file}.md`) : names.slice(-1);
        if (!picked.length) return JSON.stringify({ ok: true, candidates: [], note: 'sessions/ 里没有可处理的文件' });
        if (!target.ok) return JSON.stringify({ ok: false, disabled: target.disabled === true, reason: target.reason });
        // 读失败不许静默变成空文本（那样会走成"模型没有返回任何正文"，误导方向）
        let text = '';
        try {
          text = await fsp.readFile(path.join(dir, picked[picked.length - 1]), 'utf8');
        } catch (e) {
          return JSON.stringify({ ok: false, file: picked[picked.length - 1], reason: `读取会话文件失败：${e.message}` });
        }
        const res = await runWithTarget(
          ctx,
          cfg,
          logger,
          target.provider,
          target.model,
          (callModel) =>
            extractCandidates({
              text,
              callModel,
              maxCandidates: cfg.extract.maxCandidates || 6,
            }),
          runOpts,
        );
        if (res.targetError) return JSON.stringify({ ok: false, reason: res.targetError }, null, 2);
        return JSON.stringify(
          { ok: !res.error, file: picked[picked.length - 1], usedModel: `${target.provider}/${target.model}`, error: res.error, candidates: res.candidates },
          null,
          2,
        );
      }

      const out = await runExtraction(st, cfg, logger, ctx, state, {
        file: args.file,
        limit: args.limit,
        ...runOpts,
      });
      return JSON.stringify(out, null, 2);
    },
  };

  // ── 工具：memfuse_skill ────────────────────────────────
  const skillTool = {
    name: 'memfuse_skill',
    description:
      '把积累的记忆提炼成可复用技能，并管理技能库。' +
      'action: list（列技能库 / 待确认 / 候选 / 建议）/ show（读一份技能全文）/ ' +
      'distill（把某个候选记忆簇提炼成技能，进待确认队列）/ approve（装进技能库）/ ' +
      'reject（丢弃候选）/ dismiss（忽略这组建议，以后不再提示）/ ' +
      'patch（改写已有技能，**必须先 show 过**）。' +
      '技能会真实改变 AI 行为，所以 distill 只产候选、approve 才真正安装。' +
      '注入里出现「可提炼成技能」一节时，**主动把那一节转述给用户并问他要不要提炼**；' +
      '用户说不要就用 dismiss 记下来。用户说"把这类经验固化成技能"时也调用。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'show', 'distill', 'approve', 'reject', 'dismiss', 'patch'],
          description: '要做的操作。',
        },
        name: { type: 'string', description: '技能名（kebab-case）。show / approve / reject / patch 用。' },
        match: {
          type: 'string',
          description:
            'distill 时指定候选记忆的标题或 id，省略则取分最高的；dismiss 时填建议的 key / 标题 / 种子 id，省略则取第一条。',
        },
        body: { type: 'string', description: 'patch 时给出的**完整** SKILL.md 内容（整份替换）。' },
      },
      required: ['action'],
    },
    output: textOutput('技能操作结果（JSON 文本）'),
    async execute(args = {}, exec) {
      const { store: st, state } = await ready;
      const action = String(args.action || '').trim();
      const dir = skillDirOf(cfg);
      const pendingDir = st.root.pendingSkills;

      if (action === 'list') {
        const live = await listSkills(dir);
        const pending = await listSkills(pendingDir);
        // 候选**现算**而不是读启动时的快照：会话中新建的记忆必须立刻能成为候选，
        // 否则会出现"我刚把经验写进去，为什么没有候选"这种说不通的行为。
        // 打分是零 LLM 的，现算的代价可以忽略。
        const all = await st.list();
        const candidates = findCandidates(all, {
          minScore: cfg.skill.minScore,
          minSessions: cfg.skill.minSessions,
          limit: 5,
        }).map((c) => ({ id: c.rec.id, title: c.rec.title, score: c.score, reasons: c.reasons }));
        // 建议 = 候选 + 簇语义（作用/成员），且已滤掉用户忽略过的组。
        // 候选与建议分开给：前者是"够格的条目"，后者是"可以现在决定的一组"。
        const suggestions = computeSuggestions(all, state, cfg);
        return JSON.stringify(
          {
            skillDir: dir,
            skills: live,
            pendingSkills: pending,
            suggestions: suggestions.map((s) => ({
              key: s.key,
              title: s.seedTitle,
              useWhen: s.useWhen,
              tags: s.tags,
              members: s.members.map((m) => m.title),
              reasons: s.reasons,
            })),
            candidates,
            hint:
              'suggestions = 可以现在决定的一组（建议先看它的 useWhen，那说明这技能是干什么用的）；' +
              'distill 提炼 → approve 装进技能库（装完当轮即生效，不用重启）；' +
              '不想要就 dismiss，以后不再提这一组。',
          },
          null,
          2,
        );
      }

      if (action === 'show') {
        const name = String(args.name || '').trim();
        const content = (await readSkill(dir, name)) ?? (await readSkill(pendingDir, name));
        if (content === undefined) return JSON.stringify({ ok: false, error: `找不到技能 "${name}"` });
        return JSON.stringify({ ok: true, name, content });
      }

      if (action === 'distill') {
        const opt = (exec && exec.agent && exec.agent.options) || {};
        // 实现只有一份（`distillCluster`）—— 界面上的「提炼成技能」走的是同一个函数，
        // 两条路径各写一遍的话，迟早一条改了另一条没改（缺陷 25）。
        const res = await distillCluster({
          store: st,
          cfg,
          state,
          ctx,
          logger,
          match: String(args.match || '').trim(),
          opt,
          deadline: Date.now() + EXTRACT_BUDGET_MS,
          signal: exec && exec.signal,
        });
        if (!res.ok) {
          return JSON.stringify({
            ok: false,
            disabled: res.disabled === true,
            error: res.error,
            skipped: res.skipped === true,
            cluster: res.cluster,
            name: res.name,
          });
        }
        return JSON.stringify(
          {
            ok: true,
            name: res.name,
            description: res.description,
            cluster: res.cluster,
            note: '已进待确认队列；用 memfuse_skill action=approve 装进技能库',
          },
          null,
          2,
        );
      }

      if (action === 'approve') {
        const name = String(args.name || '').trim();
        return JSON.stringify(await approveSkill({ store: st, cfg, state, ctx, name }));
      }

      if (action === 'reject') {
        return JSON.stringify(await rejectSkill({ store: st, name: String(args.name || '').trim() }));
      }

      if (action === 'patch') {
        const name = String(args.name || '').trim();
        const body = String(args.body || '');
        const check = validateSkill({ name, content: body, maxBytes: cfg.skill.maxBytes });
        if (!check.ok) return JSON.stringify({ ok: false, error: check.error });
        if ((await readSkill(dir, name)) === undefined) {
          return JSON.stringify({ ok: false, error: `技能库里没有 "${name}"（新建请用 distill）` });
        }
        if (!hasShownSkill(exec, 'memfuse_skill', name)) {
          return JSON.stringify({
            ok: false,
            error: `改技能前必须先 memfuse_skill action=show name=${name} —— 防"凭记忆瞎改一个自己没读过的技能"`,
          });
        }
        await writeSkill(dir, name, body);
        const v = await verifySkill(dir, name);
        if (v.ok) await st.appendUsage({ type: 'skill-patch', name });
        return JSON.stringify({ ok: v.ok, name, problem: v.problem });
      }

      // 用户说"不用" —— 记住这一组，以后不再提示。
      // 簇长大（成员变化）会得到新的 key，所以"以后又觉得有价值"时仍会再提一次。
      if (action === 'dismiss') {
        const all = await st.list();
        const cands = computeSuggestions(all, state, cfg);
        const key = String(args.match || '').trim();
        const hit = key ? cands.find((s) => s.key === key || s.seedId === key || s.seedTitle === key) : cands[0];
        if (!hit) {
          return JSON.stringify({
            ok: false,
            error: key ? `没找到对应的技能建议 "${key}"` : '当前没有待决定的技能建议',
          });
        }
        const total = await dismissSuggestion(st, state, hit.key);
        cachedSuggestions = computeSuggestions(all, state, cfg);
        cachedDistillRequests = Array.isArray(state.distillRequests) ? state.distillRequests : [];
        await st.appendUsage({ type: 'skill-dismiss', key: hit.key, seed: hit.seedId });
        return JSON.stringify({
          ok: true,
          dismissed: hit.seedTitle,
          note: `已忽略这一组（共记 ${total} 组）。它再长大时会重新提示一次。`,
        });
      }

      return JSON.stringify({ ok: false, error: `未知 action "${action}"` });
    },
  };

  // ── 注册工具（失败不阻断插件加载，但结果会记进 status.md 与返回值）────────
  const disposers = [];
  const results = [
    registerTool(ctx?.tools, recallTool, logger, disposers),
    registerTool(ctx?.tools, writeTool, logger, disposers),
    registerTool(ctx?.tools, statusTool, logger, disposers),
    registerTool(ctx?.tools, feedbackTool, logger, disposers),
    registerTool(ctx?.tools, extractTool, logger, disposers),
    registerTool(ctx?.tools, skillTool, logger, disposers),
  ];

  // ── 每轮注入 ─────────────────────────────────────────────────────────
  // 宿主事实（已核实）：
  //   - systemPrompt.context 的 text provider 是**同步求值**的
  //     （dsh-system-prompt 里 `section.text(context)` 直接调用，没有 await）；
  //   - AssembleContext 只有 { scope?, signal? } —— 拿不到当前用户输入，
  //     也不能在 provider 里 await store.list()。
  // 所以：pre-step 时同步缓存本轮输入 + 刷新记忆快照，provider 只读缓存。
  let latestQuery = '';
  let cachedAll = [];
  let cachedHealth = { ok: true };
  let cachedSuggestions = []; // H 技能建议（零 LLM，随记忆库快照一起刷新）
  let cachedDistillRequests = []; // 界面上点过「提炼」的簇 key（同缓存刷新）
  let pendingInjected = []; // 本轮注入过的 id —— provider 是同步的，写盘挪到下一轮
  let lastInjection = null; // E7 归因：上轮注入了什么、当时的 query 是什么
  let currentSessionId = null; // 供反馈与跨会话计数使用
  // 捕获故障要"立刻可见"：这个标记让 pre-step 的 flushInjected 把 runtimeFaults 落盘。
  // 捕获**成功**的计数不在这里 —— 它从 sessions/*.md 派生（见 writeStatus），
  // 内存计数在短命进程上会撒谎（headless 一轮跑完就退出，刷不到盘）。
  const captureFlush = { dirty: false };

  /** 刷新注入缓存。读库失败时把故障写进 cachedHealth —— 这是 Block D 的真实数据源。 */
  async function refreshInjectionCache() {
    try {
      const { state } = await ready;
      cachedAll = await store.list();
      cachedHealth = store.lastListError
        ? { ok: false, sinceDays: 0, reason: `记忆库读取失败：${store.lastListError}` }
        : healthOf(state);
      cachedSuggestions = computeSuggestions(cachedAll, state, cfg);
      cachedDistillRequests = Array.isArray(state.distillRequests) ? state.distillRequests : [];
    } catch (e) {
      cachedHealth = { ok: false, sinceDays: 0, reason: `记忆库读取失败：${e.message}` };
      cachedSuggestions = [];
    }
  }

  /**
   * 把上一轮注入过的记忆计入 `injected` 统计，并把归因记录写进 state.json。
   *
   * 这是 E7「entries 归因」的落点：`buildInjection()` 一直返回 `entries`，
   * 但从来没有人消费它 —— 于是"上轮注入了什么 → 结果如何"这条链路是断的。
   * provider 是同步的不能写盘，所以在这里补上。
   */
  async function flushInjected() {
    const ids = pendingInjected;
    // 捕获**故障**与注入无关：这一轮没注入任何记忆，也照样要把它写下去，
    // 否则故障只活在内存里 —— 又一次静默（"从不生效"就是这么来的）。
    if (!ids.length && !captureFlush.dirty) return 0;
    pendingInjected = [];
    captureFlush.dirty = false;
    let n = 0;
    try {
      if (ids.length) {
        const all = await store.list();
        const byId = new Map(all.map((r) => [r.id, r]));
        for (const id of ids) {
          const rec = byId.get(id);
          if (rec && (await touchMemory(store, rec, { injected: 1 }, cfg, logger))) n++;
        }
      }
      const { state } = await ready;
      if (ids.length) state.lastInjection = lastInjection;
      await writeState(store, state);
    } catch (e) {
      logger.warn?.(`[dsh-memfuse] 注入计数失败：${e.message}`);
    }
    return n;
  }

  // 捕获去重表：session.id → 已捕获的 assistant/message seq。
  // 声明在 pre-step 之前，因为那里是**第二捕获触发点**（缺陷 30），两个触发点共用它。
  const lastCapturedSeq = new Map();

  /**
   * 会话登记表：session.id → { session, turnEndSeq, reason, capturable, sweepSeq }。
   *
   * ⚠️ 这里以前是**单个** `lastSession`（缺陷 30c 的修法），真机上被证伪（缺陷 33）：
   * `agent/pre-step` 的 payload 里没有 session，只能靠 `session/event` 顺手存一个 ——
   * 但那个变量是**全局**的，任何会话的事件都会覆盖它。子代理一开跑（真机现场：129 条
   * 事件的委派会话），pre-step 的兜底捕获就跑去抓子代理的事件流，于是每步报一次
   * 「本轮没找到真人输入」的假告警，而真正该抓的主会话（11190 条事件）一次也没补上。
   *
   * 现在按会话分别记账，谁也抢不走谁的；上限 32 个，超了丢最旧的。
   */
  const captureSessions = new Map();
  const MAX_TRACKED_SESSIONS = 32;

  /** 登记（或刷新）一个会话；拿不到 id 就返回 null（不瞎猜）。 */
  const trackSession = (session) => {
    if (!session || session.id === undefined || session.id === null) return null;
    const id = String(session.id);
    let rec = captureSessions.get(id);
    if (!rec) {
      if (captureSessions.size >= MAX_TRACKED_SESSIONS) {
        captureSessions.delete(captureSessions.keys().next().value);
      }
      rec = {
        session,
        turnEndSeq: -1,
        reason: null,
        // 还没见过 `turn/end` 时按"可以捕"处理（fail-open）：事件投递不到时这条路
        // 就是唯一的兜底，不能因为没记上收尾原因就不干活。
        capturable: true,
        sweepSeq: -1,
      };
      captureSessions.set(id, rec);
    } else {
      rec.session = session;
    }
    return rec;
  };

  ctx?.on?.('agent/pre-step', (payload, next) => {
    try {
      const sid = payload && payload.agent && payload.agent.session && payload.agent.session.id;
      if (sid) currentSessionId = sid;
      const msgs = payload && payload.messages;
      if (Array.isArray(msgs)) {
        for (let i = msgs.length - 1; i >= 0; i--) {
          const text = textOfMessage(msgs[i]);
          if (text) {
            latestQuery = text;
            break;
          }
        }
      }
    } catch {
      /* 探测失败不影响对话 */
    }
    // fire-and-forget：不阻塞 step；下一轮注入用到刷新后的快照
    flushInjected();
    refreshInjectionCache();

    // ── 第二捕获触发点（缺陷 30 / 33）──
    // `session/event` 的投递在 0.2.1-rc.1 下**不可靠**：真机上它静默停了整整一小时
    // （sessions/ 一个字节没长，而 runtimeFaults 是空的）。而 `agent/pre-step`
    // **每轮必到**（本轮的记忆注入就是靠它），所以在这里补一次捕获机会。
    //
    // ⚠️ 三条真机教训（缺陷 30b/30c/33）：
    //   ① `agent/pre-step` 的 payload 里**没有** `agent` —— 宿主派发的是
    //      `{ messages, ...position, signal }`，按 `payload.agent.session` 取是死路；
    //   ② 判"这一轮结束了没"**不能**依赖 payload 字段，只能用事件流
    //      （assistant 之后出现过 `turn/end`，且那一轮是正常收尾）；
    //   ③ **不能**用"最后发事件的那个会话"当目标 —— 子代理一跑就会把目标抢走。
    //      现在遍历登记表里的每个会话，各自判各自的。
    try {
      // 宿主有 `sessions` 服务时，它是最权威的会话来源（可选；拿不到就用事件流攒的表）。
      try {
        const svc = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined;
        const list = svc && typeof svc.list === 'function' ? svc.list() : null;
        if (Array.isArray(list)) for (const s of list) trackSession(s);
      } catch {
        /* 没有这个服务：正常，继续用 session/event 攒出来的登记表 */
      }

      for (const rec of Array.from(captureSessions.values())) {
        const sess = rec.session;
        if (!sess) continue;
        // 子代理（委派）会话不是人机对话：抓它只会得到一条假故障（缺陷 33）。
        if (isSubagentSession(sess)) continue;
        const seqNow = Number(sess.seq);
        if (Number.isFinite(seqNow)) {
          // 没有新事件就别白扫一遍（pre-step 每个 step 都到，扫事件是 O(n)）。
          if (seqNow === rec.sweepSeq) continue;
          // 上一轮没正常收尾（报错 / 被中断 / 被 fork），而且之后**还没有新事件**：
          // 这一轮本来就不该记，重试也没意义（缺陷 33b）。
          //
          // ⚠️ 注意这里必须放行"收尾之后又来了新事件"的情况：新的一轮可能已经在跑，
          // 或者 `session/event` 根本没把 `turn/end` 投递过来 —— 那正是这条兜底存在的原因。
          // 真正防"把失败轮次记进去"的是 `requireTurnEnd`（它只认正常收尾的 turn/end），
          // 不是这道门；这道门只负责省掉没意义的重复扫描。
          if (rec.turnEndSeq >= 0 && !rec.capturable && seqNow <= rec.turnEndSeq) continue;
          rec.sweepSeq = seqNow;
        }
        Promise.resolve(
          captureTurn(store, cfg, logger, sess, lastCapturedSeq, {
            requireTurnEnd: true,
            // 本轮还没收尾是**正常**的，不许记成故障（缺陷 33）
            quietNoExchange: true,
          }),
        ).catch((e) => {
          noteFault(runtimeFaults, 'captureFail', `pre-step 捕获失败：${e.message}`);
          captureFlush.dirty = true;
        });
      }
    } catch (e) {
      noteFault(runtimeFaults, 'captureFail', `pre-step 捕获异常：${e.message}`);
      captureFlush.dirty = true;
    }

    // ⚠️ 必须把决定权交还下游 —— 这一行是硬契约，不是可选礼貌。
    //
    // `agent/pre-step` 是 **waterfall** 模式（宿主 Event 契约：
    // `(payload, next) => Promise<PreStepDecision>`）。不调 `next()` 会**在此截断瀑布链**：
    // 宿主 dsh-agent-loop 拿到的 decision 是 `undefined`，紧接着读 `decision.kind`
    // 直接抛 TypeError，**整轮对话崩掉**。
    //
    // 官方 14 处监听器全部形如 `async (payload, next) => { …; return next(); }`。
    return typeof next === 'function' ? next() : undefined;
  });

  // ── 零 LLM 兜底捕获（F1）─────────────────────────────────────────────
  // DSH 是常驻 web 应用、没有"会话结束"钩子，所以用 `turn/end` 作为**第一**捕获时机
  // （`lastCapturedSeq` 已在上面 pre-step 之前声明，那里是第二触发点）。
  // 目的：即使 `extract.model` 永远不配置，原始问答也已经落盘、可被检索 ——
  // 这正是 Codex 缺的那种韧性（它的管线死了三周，什么都不剩）。
  /**
   * 记一笔捕获故障。
   *
   * 除了写进 runtimeFaults（→ Block D / status.md），还要把 `captureStats.dirty`
   * 立起来：不然"这一轮没有任何注入"时 `flushInjected()` 会提前 return，
   * 故障就只活在内存里、落不了盘 —— 又一次静默。
   */
  const noteCaptureFault = (message) => {
    noteFault(runtimeFaults, 'captureFail', message);
    captureFlush.dirty = true;
  };
  if (typeof ctx?.on === 'function') {
    ctx.on('session/event', (session, event) => {
      try {
        // 顺手登记会话：pre-step 的 payload 里没有它（缺陷 30c / 33）。
        const rec = trackSession(session);
        if (!event || event.type !== 'turn/end') return;

        // ⚠️ 宿主 session 对象上没有事件访问器 ⇒ 捕获**永远不会发生**。
        // 早先这里写的是 `if (!Array.isArray(session.events)) return;` ——
        // 真机上没有 `session.events`（见 sessionEvents 的注释），于是每一轮都
        // 在这里静默 return，sessions/ 永远是空的，而用户与 status.md 都看不出异常。
        // 这种失败必须留痕，否则"功能存在但从不生效"会再次发生。
        if (!sessionEvents(session).via) {
          noteCaptureFault(
            '宿主 session 对象上没有可读的事件访问器（events / ownEvents / snapshotEvents 都没有）—— 兜底捕获无法工作',
          );
          return;
        }

        // 记下这一轮的收尾方式：只有**正常收尾**的轮次才值得记（缺陷 33b）。
        if (rec) {
          const seqNum = Number(event.seq);
          rec.turnEndSeq = Number.isFinite(seqNum) ? seqNum : -1;
          rec.reason = turnEndKind(event);
          rec.capturable = isCapturableTurnEnd(event);
        }
        if (!isCapturableTurnEnd(event)) {
          // 报错 / 被用户停止 / 被 fork 的轮次：assistant 正文是半截或错误回显，
          // 记进记忆库就是脏数据。这一轮不算捕获失败（失败的是这一轮本身，用户已经看见），
          // 所以**不留痕**，也不重试。
          return;
        }
        // 子代理（委派）会话不是人机对话：抓它只会得到一条假故障（缺陷 33）。
        if (isSubagentSession(session)) return;

        captureTurn(store, cfg, logger, session, lastCapturedSeq).catch((e) => {
          noteCaptureFault(`落盘失败：${e.message}`);
          logger.warn?.(`[dsh-memfuse] 捕获失败：${e.message}`);
        });
      } catch (e) {
        // 捕获失败不能影响对话，但**必须留痕**（否则 Web UI 里等于静默）
        noteCaptureFault(e.message);
      }
    });
  }

  if (typeof ctx?.systemPrompt?.context === 'function') {
    try {
      const dispose = ctx.systemPrompt.context({
        name: 'dsh-memfuse:memory',
        // 真实 order 参考：sandbox:policy=110 / approval:policy=115 / subagent:delegation=120。
        // 注意 getContextOrder 在本机 SystemPrompt 类里**不存在**，只能用字面量。
        order: 118,
        text: () => {
          if (!cfg.inject.enabled) return '';
          try {
            const built = buildInjection(cachedAll, latestQuery, cachedHealth, cfg.inject, cachedSuggestions, cachedDistillRequests);
            // provider 同步、不能写盘：只登记，下一轮 pre-step 时落盘
            pendingInjected = built.entries.map((e) => e.id);
            lastInjection = { at: new Date().toISOString(), query: latestQuery, ids: pendingInjected };
            return built.text;
          } catch (e) {
            // 最危险的分支：返回空串 ⇒ 每轮注入**静默消失**。
            // 用户看到的现象是"没有记忆"，而不是"记忆坏了"。必须记账。
            noteFault(runtimeFaults, 'injectFail', e.message);
            logger.warn?.(`[dsh-memfuse] 注入装配失败：${e.message}`);
            return '';
          }
        },
      });
      if (typeof dispose === 'function') disposers.push(dispose);
    } catch (e) {
      noteFault(runtimeFaults, 'contextFail', e.message);
      logger.warn?.(`[dsh-memfuse] systemPrompt.context 注册失败：${e.message}`);
    }
  } else {
    noteFault(runtimeFaults, 'contextFail', '宿主无 systemPrompt.context');
    logger.warn?.('[dsh-memfuse] 宿主无 systemPrompt.context —— 每轮注入不可用（工具仍可用）');
  }

  // 初始化完成后先刷一次缓存，让第一轮就有内容可注入
  ready.then(() => refreshInjectionCache()).catch(() => {});

  // 卸载时释放全部注册（宿主装了 cordis-plugin-hmr，重复注册会撞 duplicate）
  if (typeof ctx?.effect === 'function') {
    ctx.effect(() => () => {
      for (const d of disposers) {
        try {
          d();
        } catch {
          /* 忽略 */
        }
      }
    }, 'dsh-memfuse:disposers');
  }

  // 暴露给宿主 / 测试
  const api = {
    store,
    ready,
    config: cfg,
    recall: async (q, o) => recall(await store.list(), q, o),
    resident: async () => resident(await store.list()),
    buildInjection: async (q) => {
      const { state } = await ready;
      const all = await store.list();
      return buildInjection(all, q, healthOf(state), cfg.inject, computeSuggestions(all, state, cfg), Array.isArray(state.distillRequests) ? state.distillRequests : []);
    },
    /** 技能建议（零 LLM）—— 供测试与调试直接读。 */
    suggestions: async () => {
      const { state } = await ready;
      const all = await store.list();
      return computeSuggestions(all, state, cfg);
    },
    maintenance: () => runMaintenance(store, cfg, logger),
    status: async () => writeStatus(store, cfg, await readState(store), probe),
    probe,
    registerResults: results,
    estimateTokens,
    // 注入路径的可测接口（provider 是同步的，测试要能直接读缓存产物）
    refreshInjectionCache,
    flushInjected,
    lastInjection: () => lastInjection,
    currentSession: () => currentSessionId,
    captureTurn: (session) => captureTurn(store, cfg, logger, session, lastCapturedSeq),
    runExtraction: (opts) => ready.then(({ state }) => runExtraction(store, cfg, logger, ctx, state, opts || {})),
    listPending: () => listPending(store.root),
    skillDir: () => skillDirOf(cfg),
    listSkills: () => listSkills(skillDirOf(cfg)),
    listPendingSkills: () => listSkills(store.root.pendingSkills),
    findDuplicates: async () => antiseptic.findDuplicateClusters(await store.list()),
    injectionText: () => {
      if (!cfg.inject.enabled) return '';
      return buildInjection(cachedAll, latestQuery, cachedHealth, cfg.inject, cachedSuggestions, cachedDistillRequests).text;
    },
    health: () => cachedHealth,
    disposers,
  };

  try {
    ctx?.set?.('memory', api);
  } catch {
    /* 宿主无 set 接口时忽略 */
  }

  return api;
}

// ⚠️ `Config` **必须**放进这个 default 对象里。
//
// cordis loader 的 `unwrapExports()` 是这样的：
//     exports = exports.default ?? exports;
//     if (!exports.__esModule) return exports;
//     return exports.default ?? exports;
// 也就是说它有 default 就**只认 default**，named export 一概不看。
// 而 `dsh-settings` 的 describe() 第一步就是取 `entry.fiber.runtime.Config`，
// 取到 undefined 立刻 `return []` —— 插件再正常也不会出现在「设置 → 插件」里。
//
// 之前把 Config 只作为 named export 导出，设置页死活出不来，根因就在这一行。
export default { name, inject, apply, Config };
