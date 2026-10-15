/**
 * 往**隔离 root** 种入够格的技能候选记忆，供宿主冒烟使用。
 * 绝不碰真库。
 *
 * 运行：node .memfuse-smoke/seed.mjs
 */
import path from 'node:path';
import { MemoryStore } from '../lib/store.js';
import * as policy from '../lib/policy.js';

const root = path.join(import.meta.dirname, 'memory');
const cfg = { root, git: false, lifecycle: { p1Days: 30, p2Days: 7 } };
const store = new MemoryStore(cfg, { log() {}, warn: () => {} });
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

// 一组「部署流程」：experience(+3) + 步骤性内容(+2) = 5 分，超过门槛 4
await store.write(mk({
  id: 'm_deploy_1', kind: 'experience', title: '部署要走 scripts/deploy.sh',
  summary: '第一步确认分支干净，再跑 deploy.sh。',
  body: '第一步 先确认当前分支干净（无未提交改动）。第二步 运行 scripts/deploy.sh。第三步 验证健康检查通过。',
  anchor: '执行部署时', tags: ['deploy', 'release'],
}));
await store.write(mk({
  id: 'm_deploy_2', kind: 'fact', title: '部署前必须确认分支干净',
  summary: '有未提交改动时不要部署。',
  body: '有未提交改动时不要部署，否则回滚很麻烦。',
  anchor: '准备部署前', tags: ['deploy'],
}));
await store.write(mk({
  id: 'm_deploy_3', kind: 'fact', title: '部署后要跑健康检查',
  summary: '部署完必须验证 /healthz 返回 200。',
  body: '部署完必须验证 /healthz 返回 200 才算成功。',
  anchor: '部署完成后', tags: ['deploy', 'release'],
}));

// 一条 P0 常驻，用来验证块顺序（A 在最前）
await store.write(mk({
  id: 'm_p0_lang', kind: 'fact', priority: 'P0', source: 'user', managedBy: 'user',
  title: '回答一律用简体中文', summary: '所有回复使用简体中文。',
  anchor: '任何对话开始时', tags: ['lang'], expires: null,
  body: '用户要求：回复一律使用简体中文。',
}));

await store.rebuildIndex();
const all = await store.list();
console.log(`已种入 ${all.length} 条到 ${root}`);
for (const r of all) console.log(`  [${r.priority}] ${r.kind.padEnd(10)} ${r.title}`);
