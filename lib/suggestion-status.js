import { buildSuggestions, findCandidates } from './distill.js';

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
  const enabled = cfg.skill?.enabled !== false;
  const suggest = cfg.skill?.suggest !== false;
  const status = !enabled ? 'disabled' : !suggest ? 'suggest_off'
    : raw.length === 0 ? 'no_candidates' : available.length === 0 ? 'all_dismissed'
      : freshGroups === 0 ? 'no_fresh' : 'ready';
  return {
    suggestions: enabled && suggest ? available : [],
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
      freshGroups,
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
