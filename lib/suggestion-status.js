import { buildSuggestions, findCandidates } from './distill.js';

/** 上次确认「看过」的时间（毫秒）。从没看过 → null。 */
export function lastSeenAt(state) {
  const seen = state?.skillSeen || {};
  let max = 0;
  for (const value of Object.values(seen)) {
    const at = Date.parse(String(value ?? ''));
    if (Number.isFinite(at) && at > max) max = at;
  }
  return max > 0 ? max : null;
}

/** 组里最新一条成员的时间（毫秒）—— 用来判断"这一组是不是上次确认之后才有的新东西"。 */
function newestMemberAt(suggestion, byId) {
  let max = 0;
  for (const member of suggestion.members || []) {
    const rec = byId.get(member.id);
    const at = Date.parse(String(rec?.updated || rec?.created || ''));
    if (Number.isFinite(at) && at > max) max = at;
  }
  return max;
}

/**
 * 只保留「上次确认之后确实出现了新内容」的组。
 *
 * 为什么要有这一层（2026-11-24，用户反馈「切换对话就频繁弹提炼卡片」）：
 * 卡片原来是**队列式**的 —— 只要还有没看过的组，每次卡片挂载（切到一个老会话、
 * 它的最后一回合重新渲染）就会领走并展示下一组。于是 90 多组够格记忆被一组一组
 * 弹出来，切几次会话就来一张，而用户根本没产生新记忆。
 *
 * 现在的语义：**建议要跟着新记忆走**。上次确认之后没有新增/变动的组，一律不再弹；
 * 新记忆进来（组员变化 → key 变，或簇里最新一条的时间变新）才会重新提。
 * 没看过任何一组（没有时间水位线）时全部算新 —— 首次安装仍能看到建议。
 */
export function freshSuggestions(suggestions, memories, state) {
  const since = lastSeenAt(state);
  if (since === null) return suggestions || [];
  const byId = new Map((memories || []).map((r) => [r.id, r]));
  return (suggestions || []).filter((s) => newestMemberAt(s, byId) > since);
}

/**
 * 技能卡片的只读诊断。正式记忆、待确认记忆、展示历史各自计数，
 * 供设置页、工具与 status.md 使用；不批准候选、不重置忽略记录。
 */
export function analyzeSkillSuggestions(memories, state, cfg, pendingMemories = 0) {
  const options = {
    minScore: cfg.skill?.minScore ?? 4,
    minSessions: cfg.skill?.minSessions ?? 3,
    limit: Math.max(1, memories.length),
  };
  const raw = buildSuggestions(memories, options);
  const pending = new Set(Array.isArray(state.distillRequests) ? state.distillRequests : []);
  const seen = state.skillSeen || {};
  const dismissed = state.skillDismissed || {};
  let dismissedGroups = 0;
  let seenGroups = 0;
  let pendingGroups = 0;
  let freshGroups = 0;
  const available = [];
  for (const group of raw) {
    if (dismissed[group.key]) { dismissedGroups++; continue; }
    available.push(group);
    if (pending.has(group.key)) pendingGroups++;
    else if (seen[group.key]) seenGroups++;
    else freshGroups++;
  }
  // 「还能弹的」= 没看过 + 上次确认之后有新内容。诊断与卡片用同一份口径，
  // 否则会出现 status.md 说"有 N 组等待提醒"、卡片却一张都不弹的自相矛盾。
  const fresh = freshSuggestions(
    available.filter((s) => !seen[s.key] && !pending.has(s.key)),
    memories,
    state,
  );
  const enabled = cfg.skill?.enabled !== false;
  const suggest = cfg.skill?.suggest !== false;
  const status = !enabled ? 'disabled' : !suggest ? 'suggest_off'
    : raw.length === 0 ? 'no_candidates' : available.length === 0 ? 'all_dismissed'
      : fresh.length === 0 ? 'no_fresh' : 'ready';
  return {
    suggestions: enabled && suggest ? available : [],
    /** 卡片可以用哪几组（已按"新内容"过滤）。`list` 端点只用这一份。 */
    fresh: enabled && suggest ? fresh : [],
    diagnostics: {
      status,
      totalMemories: memories.length,
      activeMemories: memories.filter((r) => (r.lifecycle || 'active') === 'active').length,
      dormantMemories: memories.filter((r) => r.lifecycle === 'dormant').length,
      candidateCount: findCandidates(memories, options).length,
      eligibleGroups: raw.length,
      dismissedGroups,
      seenGroups,
      pendingGroups,
      freshGroups: fresh.length,
      pendingMemories,
      extractMode: cfg.extract?.mode ?? 'suggest',
    },
  };
}

export function describeSkillSuggestionStatus(d) {
  const labels = {
    disabled: '技能功能已关闭',
    suggest_off: '主动技能提示已关闭',
    no_candidates: '正式记忆中暂无达到条件的技能建议',
    all_dismissed: `当前 ${d.dismissedGroups} 组技能建议已被忽略，不再重复提示`,
    no_fresh: '当前技能建议已提醒或正在提炼，没有新的卡片',
    ready: `${d.freshGroups} 组技能建议等待提醒`,
  };
  return labels[d.status] ?? '技能候选状态未知';
}
