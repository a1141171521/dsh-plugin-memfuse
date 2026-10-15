/**
 * 演示：技能建议（Block E）长什么样。
 * 纯本地，不需要 DSH、不需要模型。
 *
 * 运行：node test/demo-suggest.mjs
 */
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { MemoryStore } from '../lib/store.js';
import * as policy from '../lib/policy.js';
import { buildInjection } from '../lib/inject.js';
import { buildSuggestions, renderSuggestions, clusterKey } from '../lib/distill.js';

const root = path.join(os.tmpdir(), `memfuse-demo-suggest-${Date.now()}`);
const cfg = { root, git: false, lifecycle: { p1Days: 30, p2Days: 7 } };
const store = new MemoryStore(cfg, { log() {}, warn() {} });
await store.init();
const now = new Date().toISOString();

const mk = (o) => ({
  scope: 'workspace',
  priority: 'P2',
  confidence: 0.9,
  source: 'auto',
  lifecycle: 'active',
  created: now,
  updated: now,
  expires: policy.computeExpiry('P2', cfg.lifecycle),
  stats: { recalled: 0, injected: 0, positive: 0, negative: 0 },
  ...o,
});

// 一组"部署流程"记忆：experience + 步骤性内容 → 立刻够格（3+2=5 分）
await store.write(mk({
  id: 'm_d1', kind: 'experience', title: '部署要走 scripts/deploy.sh',
  summary: '第一步确认分支干净，再跑 deploy.sh。',
  body: '第一步 先确认当前分支干净（无未提交改动）。第二步 运行 scripts/deploy.sh。第三步 验证健康检查通过。',
  anchor: '执行部署时', tags: ['deploy', 'release'],
}));
await store.write(mk({
  id: 'm_d2', kind: 'fact', title: '部署前必须确认分支干净',
  summary: '有未提交改动时不要部署。', body: '有未提交改动时不要部署，否则回滚很麻烦。',
  anchor: '准备部署前', tags: ['deploy'],
}));
await store.write(mk({
  id: 'm_d3', kind: 'fact', title: '部署后要跑健康检查',
  summary: '部署完必须验证 /healthz。', body: '部署完必须验证 /healthz 返回 200。',
  anchor: '部署完成后', tags: ['deploy', 'release'],
}));

// 一条 P0 常驻，用来展示块顺序
await store.write(mk({
  id: 'm_p0', kind: 'fact', priority: 'P0', source: 'user', managedBy: 'user',
  title: '回答一律用简体中文', summary: '所有回复使用简体中文。',
  anchor: '任何对话开始时', tags: ['lang'], expires: null,
  body: '用户要求：回复一律使用简体中文。',
}));

const all = await store.list();

console.log('='.repeat(74));
console.log('1) 零 LLM 识别出的建议（buildSuggestions）');
console.log('='.repeat(74));
const sugg = buildSuggestions(all, { minScore: 4, minSessions: 3, limit: 5 }, {});
for (const s of sugg) {
  console.log(`  · 种子: ${s.seedTitle}   （${s.score} 分）`);
  console.log(`    作用  : ${s.useWhen || '(无 anchor)'}`);
  console.log(`    标签  : ${s.tags.map((t) => '#' + t).join(' ')}`);
  console.log(`    成员  : ${s.members.map((m) => m.title).join(' / ')}`);
  console.log(`    理由  : ${s.reasons.join('；')}`);
  console.log(`    key   : ${s.key.slice(0, 48)}…`);
}

console.log('\n' + '='.repeat(74));
console.log('2) 注入进提示词的完整块（含 Block E）');
console.log('='.repeat(74));
const inj = buildInjection(all, '我要发个版本', { ok: true }, {}, sugg);
console.log(inj.text);
console.log(`\n--- tokens ≈ ${inj.tokens} ｜ 块: ${inj.blocks.map((b) => b.key || 'C').join(' , ')}`);

console.log('\n' + '='.repeat(74));
console.log('3) 用户说"不用"之后（dismiss 的效果）');
console.log('='.repeat(74));
const dismissed = { [sugg[0].key]: new Date().toISOString() };
const after = buildSuggestions(all, { minScore: 4, minSessions: 3, limit: 5 }, dismissed);
const inj2 = buildInjection(all, '我要发个版本', { ok: true }, {}, after);
console.log(`  剩余建议: ${after.length} 组`);
console.log(`  Block E : ${inj2.blocks.find((b) => b.key === 'E') ? '仍在' : '已消失 ✅'}`);

console.log('\n' + '='.repeat(74));
console.log('4) 簇长大 → key 变 → 重新提一次');
console.log('='.repeat(74));
const grown = [...sugg[0].members.map((m) => ({ id: m.id })), { id: 'm_new' }];
console.log(`  原 key   : ${sugg[0].key.slice(0, 48)}…`);
console.log(`  长大 key : ${clusterKey(grown).slice(0, 48)}…`);
console.log(`  → ${clusterKey(grown) !== sugg[0].key ? '不同，会重新提示 ✅' : '相同，被永久压住 ❌'}`);

console.log('\n' + '='.repeat(74));
console.log('5) 关掉提示（skill.suggest=false）');
console.log('='.repeat(74));
const inj3 = buildInjection(all, '我要发个版本', { ok: true }, { skillSuggest: false }, sugg);
console.log(`  Block E : ${inj3.blocks.find((b) => b.key === 'E') ? '仍在 ❌' : '已关闭 ✅'}`);
console.log(`  候选识别本身不受影响（list 仍能看到）`);

await fsp.rm(root, { recursive: true, force: true });
