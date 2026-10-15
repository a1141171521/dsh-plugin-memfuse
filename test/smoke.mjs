// 冒烟测试：不依赖 DSH 运行时，直接验证核心逻辑。
// 运行：node dsh-memory/test/smoke.mjs
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import assert from 'node:assert/strict';

import { MemoryStore } from '../lib/store.js';
import * as policy from '../lib/policy.js';
import { recall, tokenize, bm25, excerpt } from '../lib/recall.js';
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

// ── 2. 中文分词 + BM25 打分 ───────────────────────────────
const toks = tokenize('我现在要装依赖，用哪个包管理器？');
assert.ok(toks.includes('依赖'), `tokens=${JSON.stringify(toks)}`);
assert.ok(toks.includes('包管') || toks.includes('管理'), 'CJK bigram 生效');
ok('CJK bigram 分词', `${toks.length} tokens`);

// BM25 字段权重：同样的内容，出现在 anchor 里应比出现在正文里得分高
const anchorHit = { ...back, id: 'a', anchor: '安装依赖、运行脚本时', summary: '', body: '' };
const bodyHit = { ...back, id: 'b', anchor: '', summary: '', body: '安装依赖、运行脚本时' };
const [sA, sB] = bm25([anchorHit, bodyHit], tokenize('安装依赖 包管理'));
assert.ok(sA > sB, `anchor 命中应高于正文命中：${sA} vs ${sB}`);
ok('BM25：anchor 命中权重最高', `${sA.toFixed(3)} > ${sB.toFixed(3)}`);

// BM25 长度归一（b=0.75）：同样命中一次，短文档应高于长文档
const shortDoc = { ...back, id: 's', anchor: '', summary: '', body: '安装依赖' };
const longDoc = { ...back, id: 'l', anchor: '', summary: '', body: `安装依赖 ${'无关内容 '.repeat(200)}` };
const [sLong, sShort] = bm25([longDoc, shortDoc], tokenize('安装依赖'));
assert.ok(sShort > sLong, `短文档应更高：${sShort} vs ${sLong}`);
ok('BM25：长度归一', `${sShort.toFixed(3)} > ${sLong.toFixed(3)}`);

// 反例：无关查询不该命中
assert.equal(bm25([back], tokenize('今天天气怎么样'))[0], 0);
ok('无关查询零命中');

// excerpt：挑出与查询最相关的那一行（而不是固定用 summary）
const ex = excerpt({ body: '第一行讲部署。\n第二行讲安装依赖要用 pnpm。\n第三行讲天气。' }, '安装依赖 用哪个包管理器');
assert.ok(ex.includes('pnpm'), `excerpt=${ex}`);
assert.equal(excerpt({ body: '第一行讲部署。' }, '完全无关的词'), '', '无命中行应返回空串');
ok('excerpt 挑出相关行', JSON.stringify(ex));

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
assert.ok(injBad.text.includes('memfuse_write'), '警告说明哪些功能仍可用');
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

// ── 9. 真机缺陷 3 的回归：双字虚词不该成为有效 bigram ──────
// 真机实测：查询"今天午饭吃什么"里的"什么"命中了某条记忆 anchor 中的
// "用什么包管理器"，而 BM25 按最大值归一化后**唯一的命中就是满分**，
// 假命中直接压过真正相关的条目（详见 spec §3.12 缺陷 3）。
const qTokens = tokenize('今天午饭吃什么');
assert.ok(!qTokens.includes('什么'), `"什么"是虚词，不该参与打分：${JSON.stringify(qTokens)}`);
assert.ok(!tokenize('这个功能怎么用').includes('怎么'), '"怎么"不该参与打分');
assert.ok(!tokenize('我们应该先做哪个').includes('哪个'), '"哪个"不该参与打分');
assert.ok(
  !tokenize('谢谢你，麻烦看一下').some((x) => ['谢谢', '麻烦', '一下'].includes(x)),
  '客套语不该参与打分',
);
// 但不能误杀实词 —— 黑名单只收纯功能词
for (const w of ['依赖', '包管', '部署', '凭据', '安装']) {
  assert.ok(tokenize(`请帮我${w}一下`).includes(w), `实词「${w}」被误杀`);
}
ok('分词：双字虚词被过滤（缺陷 3 回归），实词不被误杀');

// recall()：无关查询不该返回**非 P0** 条目。
// （P0 零命中豁免是有意设计，见 recall.js 的注释；Block B 会把它与 Block A 去重）
const noise = recall(await store.list(), '今天午饭吃什么', { maxEntries: 10 });
const nonP0 = noise.filter((h) => h.rec.priority !== 'P0');
assert.equal(
  nonP0.length,
  0,
  `无关查询不该返回非 P0 条目，实际：${nonP0.map((h) => h.rec.title).join(' / ')}`,
);
ok('检索：无关查询不返回非 P0 条目（虚词不再造出假命中）');

// ── 汇总 ─────────────────────────────────────────────────
console.log('\n通过的全部检查：');
console.log(out.join('\n'));
console.log(`\n✅ ${out.length} 项全部通过`);

await fsp.rm(root, { recursive: true, force: true });
