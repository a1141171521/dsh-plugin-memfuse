// 用**插件自己的能力**诊断真库：有多少条够格当技能候选。
//
// 教训（本项目自己记的）：验证某段逻辑时，用那段逻辑本身算，
// 不要在诊断脚本里重新实现一遍 —— 上一版只算了 kind+步骤，
// 漏掉会话数/召回次数/P0 三项，差点得出"永远不会有候选"的错误结论。
//
// 用法：node tools/inspect-store.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const repo = path.resolve(import.meta.dirname, '..');
const mod = (p) => import(pathToFileURL(path.join(repo, 'lib', p)).href);
const { MemoryStore } = await mod('store.js');
const { findCandidates, clusterAround, buildSuggestions } = await mod('distill.js');

const root = path.join(os.homedir(), '.dsh', 'memory');
if (!fs.existsSync(root)) {
  console.error('真库不存在：' + root);
  process.exit(1);
}

const store = new MemoryStore({ root, git: false }, { log() {}, warn() {} });
const all = await store.list();

console.log(`真库共 ${all.length} 条（root=${root}）\n`);

// 分布
const dist = {};
for (const r of all) {
  const k = `${r.kind || '?'}/${r.priority || '?'}`;
  dist[k] = (dist[k] || 0) + 1;
}
console.log('分布：');
for (const [k, v] of Object.entries(dist).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(24)} ${v}`);
}

// 用真实门槛跑（默认 minScore=4 / minSessions=3）
const cands = findCandidates(all, { minScore: 4, minSessions: 3, limit: 20 });
console.log(`\n够格候选（真实 findCandidates，门槛 4 分）：${cands.length} 条`);
for (const c of cands) {
  const cluster = clusterAround(c.rec, all, 6);
  console.log(`  ${c.score} 分 · ${c.rec.kind}/${c.rec.priority} · ${c.rec.title}`);
  console.log(`        理由: ${c.reasons.join('；')}`);
  console.log(`        簇大小: ${cluster.length}`);
}

// 接近门槛的（差 1 分）—— 最有价值的改进线索
const near = all
  .filter((r) => (r.lifecycle || 'active') === 'active')
  .map((rec) => {
    let score = 0;
    const why = [];
    if (rec.kind === 'skill' || rec.kind === 'experience') { score += 3; why.push('kind'); }
    const s = rec.sessionCount || 0;
    if (s >= 3) { score += 2; why.push(`会话${s}`); } else if (s >= 2) { score += 1; why.push(`会话${s}`); }
    if ((rec.stats?.recalled || 0) >= 3) { score += 1; why.push(`召回${rec.stats.recalled}`); }
    if (rec.priority === 'P0') { score += 1; why.push('P0'); }
    return { rec, score, why };
  })
  .filter((x) => x.score === 3)
  .sort((a, b) => b.score - a.score);

console.log(`\n差 1 分的（${near.length} 条）—— 再做任意一件事就能触发卡片：`);
for (const n of near.slice(0, 10)) {
  console.log(`  3 分 · ${n.rec.kind}/${n.rec.priority} · ${n.rec.title.slice(0, 50)}  [${n.why.join(',')}]`);
}

// 直接给结论
const sugg = buildSuggestions(all, { minScore: 4, minSessions: 3, limit: 5 }, {});
console.log(`\n⇒ 当前注入的 Block E 建议数：${sugg.length}`);
if (!sugg.length) {
  console.log('   卡片没东西可显示，所以 skillSeen 一直是 0 —— 这是**数据问题，不是故障**。');
  console.log('   最快触发：给任一 skill 条目正文补上步骤（"第一步…第二步…"）→ 3+2=5 分；');
  console.log('   或者让它被召回 3 次（+1）。');
}
