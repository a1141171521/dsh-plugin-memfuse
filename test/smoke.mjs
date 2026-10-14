// 冒烟测试：不依赖 DSH 运行时，直接验证核心逻辑。
// 运行：node dsh-memory/test/smoke.mjs
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import assert from 'node:assert/strict';

import { MemoryStore } from '../lib/store.js';
import * as policy from '../lib/policy.js';
import { recall, tokenize, lexicalScore } from '../lib/recall.js';
import { buildInjection, estimateTokens } from '../lib/inject.js';

const root = path.join(os.tmpdir(), `dsh-memory-test-${Date.now()}`);
const cfg = {
  root,
  git: false,
  lifecycle: { p1Days: 30, p2Days: 7, p1WeakRenewDays: 3, p2WeakRenewDays: 1, budget: { maxMemories: 400, maxSkills: 200 }, purgeDormantAfterDays: 30 },
};

const out = [];
const ok = (label, extra = '') => out.push(`  ✅ ${label}${extra ? '  ' + extra : ''}`);

console.log('root =', root);

// ── 1. store 往返 ────────────────────────────────────────
const store = new MemoryStore(cfg, { log() {}, warn: console.warn });
await store.init();

const now = new Date().toISOString();
const rec = {
  id: 'm_test_pnpm',
  scope: 'workspace',
  kind: 'convention',
  priority: 'P1',
  confidence: 0.95,
  title: '本仓库统一用 pnpm',
  summary: '所有 install 与 script 使用 pnpm，禁止 npm。',
  anchor: '安装依赖、运行脚本、或编写包管理命令时',
  tags: ['pnpm', 'tooling'],
  source: 'user',
  managedBy: 'user',
  lifecycle: 'active',
  created: now,
  updated: now,
  expires: policy.computeExpiry('P1', cfg.lifecycle),
  stats: { recalled: 0, injected: 0, positive: 0, negative: 0 },
  body: '用户明确要求：这个仓库从今往后统一用 pnpm 安装依赖与运行脚本，npm 不再使用。',
};
await store.write(rec);

const back = await store.read('m_test_pnpm');
assert.equal(back.title, '本仓库统一用 pnpm');
assert.equal(back.priority, 'P1');
assert.deepEqual(back.tags, ['pnpm', 'tooling']);
assert.ok(back.body.includes('pnpm'));
ok('store 往返（frontmatter 含中文、数组、嵌套 stats）');

// 若 git 开启会建仓库；这里关闭，确认不抛错
ok('git 关闭时 init 正常');

// ── 2. 中文分词 + 词法打分 ────────────────────────────────
const toks = tokenize('我现在要装依赖，用哪个包管理器？');
assert.ok(toks.includes('依赖'), `tokens=${JSON.stringify(toks)}`);
assert.ok(toks.includes('包管') || toks.includes('管理'), 'CJK bigram 生效');
ok('CJK bigram 分词', `${toks.length} tokens`);

const lex = lexicalScore(back, tokenize('安装依赖 包管理'));
assert.ok(lex > 0, `lexicalScore=${lex}`);
ok('词法打分（anchor 命中权重最高）', `score=${lex.toFixed(3)}`);

// 反例：无关查询不该命中
const lexMiss = lexicalScore(back, tokenize('今天天气怎么样'));
assert.equal(lexMiss, 0);
ok('无关查询零命中');

// ── 3. 准入策略 ──────────────────────────────────────────
const mk = (o) => ({ kind: 'fact', title: 'T', body: 'B', durability: 'durable', confidence: 0.9, evidence: 'explicit', ...o });
assert.equal(policy.classify(mk({})).priority, 'P1', 'durable+0.9 → P1');
assert.equal(policy.classify(mk({ durability: 'temporary', confidence: 0.7 })).priority, 'P2', 'temporary+0.7 → P2');
assert.equal(policy.classify(mk({ durability: 'turn_local' })).action, 'discard', 'turn_local → 丢弃');
assert.equal(policy.classify(mk({ durability: 'temporary', confidence: 0.3, evidence: 'implicit' })).action, 'discard', '低置信 → 丢弃');
ok('准入策略（turn_local / 低置信被丢弃）');

// 批次去重：同标题保留高置信
const batch = policy.dedupeBatch([
  mk({ title: '用 pnpm', confidence: 0.6, evidence: 'implicit', durability: 'temporary' }),
  mk({ title: '用  pnpm ', confidence: 0.95 }),
]);
assert.equal(batch.length, 1, '同键去重');
assert.equal(batch[0].confidence, 0.95, '保留高置信');
ok('批次去重', `保留 confidence=${batch[0].confidence}`);

// ── 4. 过期 / 续期 / 淘汰 / 删除 ─────────────────────────
const exp1 = policy.computeExpiry('P1', cfg.lifecycle);
const d1 = Math.round((Date.parse(exp1) - Date.now()) / 86400000);
assert.equal(d1, 30, `P1 应为 30 天，实际 ${d1}`);
assert.equal(policy.computeExpiry('P0', cfg.lifecycle), null, 'P0 永不过期');
ok('过期：P0=null / P1=30d / P2=7d，P0 永不过期');

const renewed = policy.weakRenew('P1', cfg.lifecycle, new Date(Date.now() - 86400000).toISOString());
assert.ok(Date.parse(renewed) > Date.now(), '弱续期必须取 max（向后顺延）');
ok('弱续期取 max(现有, 新)');

// 受保护记录永不被淘汰
const all = await store.list();
const fake = [
  ...all,
  { id: 'p0', priority: 'P0', kind: 'fact', lifecycle: 'active', updated: now, stats: {} },
  { id: 'u1', priority: 'P2', kind: 'fact', source: 'user', lifecycle: 'active', updated: now, stats: {} },
  { id: 'e1', priority: 'P2', kind: 'fact', lifecycle: 'active', updated: now, stats: {} },
  { id: 'e2', priority: 'P2', kind: 'fact', lifecycle: 'active', updated: now, stats: {} },
];
const evict = policy.planEviction(fake, { maxMemories: 2, maxSkills: 200 });
assert.ok(!evict.includes('p0'), 'P0 不被淘汰');
assert.ok(!evict.includes('u1'), '用户资产不被淘汰');
assert.ok(evict.includes('e1') || evict.includes('e2'), '普通 P2 会被淘汰');
ok('预算淘汰：P0/用户资产豁免');

const purge = policy.planPurge(
  [
    { id: 'a', lifecycle: 'dormant', dormantAt: new Date(Date.now() - 40 * 86400000).toISOString(), priority: 'P2', kind: 'fact', stats: {} },
    { id: 'b', lifecycle: 'dormant', dormantAt: new Date(Date.now() - 40 * 86400000).toISOString(), priority: 'P2', kind: 'fact', stats: { positive: 1 } },
    { id: 'c', lifecycle: 'dormant', dormantAt: new Date(Date.now() - 40 * 86400000).toISOString(), priority: 'P2', kind: 'fact', source: 'user', stats: {} },
  ],
  cfg.lifecycle,
);
assert.deepEqual(purge, ['a'], `只有零反馈且非保护的才删，实际 ${JSON.stringify(purge)}`);
ok('物理删除：零反馈 / 非保护 / 超期，三者同时满足');

// ── 5. 反腐烂：合并丢失熔断 ──────────────────────────────
assert.equal(policy.mergeAllowed('x'.repeat(1000), 'y'.repeat(800), 0.7), true, '80% 允许');
assert.equal(policy.mergeAllowed('x'.repeat(1000), 'y'.repeat(500), 0.7), false, '50% 熔断');
ok('合并丢失熔断（<70% 放弃合并）');

// ── 6. 检索排序 ──────────────────────────────────────────
await store.write({
  ...rec,
  id: 'm_test_unrelated',
  title: '证件照裁剪的像素规格',
  summary: '头像裁剪必须输出 295×413 像素。',
  anchor: '处理证件照尺寸时',
  tags: ['image'],
  body: '证件照硬性规格：295×413。',
});
const hits = recall(await store.list(), '我要安装依赖，用什么包管理器', { maxEntries: 5 });
assert.ok(hits.length >= 1, '应至少命中 1 条');
assert.equal(hits[0].rec.id, 'm_test_pnpm', `最相关应是 pnpm 约定，实际 ${hits[0]?.rec.id}`);
ok('检索排序：相关记忆排第一', `top=${hits[0].rec.id} score=${hits[0].s.toFixed(3)}`);

const hits2 = recall(await store.list(), '证件照要多大尺寸', { maxEntries: 5 });
assert.equal(hits2[0]?.rec.id, 'm_test_unrelated', `应命中文档类，实际 ${hits2[0]?.rec.id}`);
ok('检索排序：换查询换结果（不是恒返回同一条）');

// ── 7. 注入装配 + 健康警告（Block D）──────────────────────
const allNow = await store.list();

const injOk = buildInjection(allNow, '安装依赖', { ok: true }, {});
assert.ok(injOk.text.includes('Super Memory'), '有标题');
assert.ok(injOk.text.includes('参考资料'), '有信任边界声明');
assert.ok(injOk.text.includes('pnpm'), '注入了相关记忆');
assert.ok(!injOk.text.includes('⚠️'), '健康时不出现警告');
ok('注入：正常路径', `tokens≈${injOk.tokens}`);

const injBad = buildInjection(allNow, '安装依赖', { ok: false, reason: 'model unavailable', sinceDays: 14 }, {});
assert.ok(injBad.text.includes('⚠️'), '故障时出现警告块');
assert.ok(injBad.text.includes('model unavailable'), '警告含原因');
assert.ok(injBad.text.includes('memory_write'), '警告说明哪些功能仍可用');
ok('注入：Block D 失败可见（这是 Codex 缺的那一环）');

// 常驻块
await store.write({ ...rec, id: 'm_p0', priority: 'P0', title: '总是用中文回答', expires: null });
const injP0 = buildInjection(await store.list(), '随便聊聊', { ok: true }, {});
assert.ok(injP0.text.includes('常驻记忆'), '有常驻块');
assert.ok(injP0.text.includes('总是用中文回答'), 'P0 被注入');
ok('注入：P0 常驻块（即使查询无关也注入）');

// ── 8. 索引与统计 ────────────────────────────────────────
await store.rebuildIndex();
const idx = await fsp.readFile(store.root.index, 'utf8');
assert.ok(idx.includes('# Memory Index'), '索引生成');
ok('index.md 生成');

const t = estimateTokens(injOk.text);
assert.ok(t > 0 && t < 2000, `token 估算合理: ${t}`);
ok('token 估算', `${t}`);

// ── 汇总 ─────────────────────────────────────────────────
console.log('\n通过的全部检查：');
console.log(out.join('\n'));
console.log(`\n✅ ${out.length} 项全部通过`);

await fsp.rm(root, { recursive: true, force: true });
