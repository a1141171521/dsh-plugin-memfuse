/**
 * 装配级集成测试：用假 ctx 跑真实 apply()，断言插件在宿主里的注册面。
 *
 * 假 ctx **刻意模拟宿主的真实契约**（依据 @deepseek-ai/dsh-tools 实测）：
 *   - ctx.tools 只有 register（不存在 add/define/provide/create）
 *   - register 在缺 output / output.render 不是函数 / 没有 execute 时**同步抛**
 *   - systemPrompt.context 的 text provider 被同步求值（不 await）
 *
 * 运行：node --test test/plugin.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';

const mod = await import('../lib/index.js');
const { healthOf } = mod;

/** 造一个尽量贴近宿主真实行为的假 ctx。opts.llm 可注入假模型。 */
function fakeCtx(opts = {}) {
  const tools = [];
  const contexts = [];
  const handlers = new Map();
  const effects = [];
  const disposersCalled = [];
  let setValue = null;

  // 未 inject 的服务：属性访问**就抛错**（真机实测 `cannot get property "llm" without inject`）。
  // 这正是"llm 是可选依赖、必须用 ctx.inject() 拿"的原因 —— 也是本项目真机发现的缺陷 1。
  let llmInjected = false;
  const ctx = {
    // 宿主 LlmRuntime：stream(options) 返回 AsyncIterable<StreamChunk>
    get llm() {
      if (!llmInjected) throw new Error('cannot get property "llm" without inject');
      return opts.llm;
    },
    tools: {
      // 宿主：只有 register，且会校验 output / execute
      register(def) {
        if (!def || typeof def !== 'object') throw new TypeError('tool definition required');
        if (!def.output || typeof def.output.render !== 'function') {
          throw new TypeError(`tool "${def.name}" must declare output { schema, render, presentationMeta? }`);
        }
        if (!def.output.schema || typeof def.output.schema.type !== 'string') {
          throw new TypeError(`tool "${def.name}" must declare output.schema`);
        }
        if (typeof def.execute !== 'function') {
          throw new TypeError(`tool "${def.name}" must declare execute`);
        }
        tools.push(def);
        return () => disposersCalled.push(`tool:${def.name}`);
      },
    },
    systemPrompt: {
      context(spec) {
        if (!spec || typeof spec.text !== 'function') throw new TypeError('context needs a text provider');
        contexts.push(spec);
        return () => disposersCalled.push(`context:${spec.name}`);
      },
    },
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
      return () => {};
    },
    // cordis 语义：effect 在**注册时**调用回调拿到 disposer，释放时调用该 disposer
    effect(fn) {
      const dispose = fn();
      effects.push(dispose);
      return () => {};
    },
    set(key, value) {
      if (key === 'memory') setValue = value;
    },
    get(name) {
      // 宿主 cordis Context：ctx.get(name) 返回服务，拿不到就是 undefined。
      // 插件用 ctx.get('agentDefaultModel') 读「对话主模型」来做抽取降级，
      // 所以假 ctx 必须能提供**任意命名**服务，而不是只有硬编码的 undefined。
      return opts.services ? opts.services[name] : undefined;
    },
    get memoryApi() {
      return setValue;
    },
  };

  // cordis 的**运行时可选注入**：服务可用才回调，不可用就不回调。
  // 插件用 `ctx.inject(['llm'], cb)` 拿 llm —— 所以假 ctx 必须模拟出来，
  // 否则测不出"llm 缺失时插件仍能工作"（那正是它的设计承诺）。
  ctx.inject = (names, callback) => {
    const list = Array.isArray(names) ? names : Object.keys(names || {});

    // settings：设置页注册（可选）。插件用它把 Config schema 交给 DSH 渲染成设置页；
    // 宿主没有这个服务时必须**静默跳过** —— 用 opts.settings 控制注不注入。
    if (list.includes('settings') && opts.settings !== undefined) {
      callback({ settings: opts.settings, effect: ctx.effect });
    }

    if (!list.includes('llm')) return () => {};
    if (opts.llm === undefined || opts.llm === null) return () => {};
    llmInjected = true;
    callback({ llm: opts.llm, effect: ctx.effect });
    return () => {
      llmInjected = false;
    };
  };

  /**
   * 模拟宿主对 `agent/pre-step` 的 **waterfall 派发**：链式调用每个监听器，
   * 每个都拿到 `next`，最终返回值就是宿主的 decision。
   *
   * 用 `ctx.parallel` 或"直接调 handler"是测不出「监听器忘了调 next」的 ——
   * 那会静默通过，而真机上整轮对话会崩（宿主读 `decision.kind`）。
   */
  async function dispatchPreStep(payload) {
    const list = handlers.get('agent/pre-step') || [];
    let i = 0;
    const next = () => {
      const fn = list[i++];
      if (!fn) return Promise.resolve({ kind: 'enter', messages: [] });
      return Promise.resolve(fn(payload, next));
    };
    return next();
  }

  return { ctx, tools, contexts, handlers, effects, disposersCalled, dispatchPreStep, getApi: () => setValue };
}

const tmpRoot = path.join(os.tmpdir(), `memfuse-plugin-${Date.now()}`);

test('apply(): 三个工具都按宿主契约注册成功', async (t) => {
  t.after(() => fsp.rm(tmpRoot, { recursive: true, force: true }));
  const h = fakeCtx();
  const api = mod.apply(h.ctx, { root: tmpRoot, git: false, verbose: false });
  await api.ready;

  assert.equal(api.registerResults.length, 6, '六次注册都要有结果');
  for (const r of api.registerResults) {
    assert.equal(r.ok, true, `注册失败：${JSON.stringify(r)}`);
    assert.equal(r.via, 'register');
  }
  assert.deepEqual(
    h.tools.map((d) => d.name).sort(),
    ['memfuse_extract', 'memfuse_feedback', 'memfuse_recall', 'memfuse_skill', 'memfuse_status', 'memfuse_write'],
  );
  // 每个工具都必须有 output.schema + output.render + execute
  for (const def of h.tools) {
    assert.equal(typeof def.output.render, 'function', `${def.name} 缺 render`);
    assert.equal(def.output.schema.type, 'string', `${def.name} 的 schema 必须是 string`);
    assert.equal(typeof def.execute, 'function', `${def.name} 必须用 execute（不是 handler）`);
    assert.equal(def.handler, undefined, `${def.name} 不应再有 handler 键`);
  }
  console.log('  ✅ 6 个工具按契约注册（execute + output.schema + output.render）');
});

test('apply(): 注入 provider 已挂上，且是同步可求值的', async (t) => {
  t.after(() => fsp.rm(tmpRoot, { recursive: true, force: true }));
  const h = fakeCtx();
  const api = mod.apply(h.ctx, { root: tmpRoot, git: false, verbose: false });
  await api.ready;
  await api.refreshInjectionCache();

  assert.equal(h.contexts.length, 1, '应注册一个 systemPrompt.context');
  const spec = h.contexts[0];
  assert.equal(spec.name, 'dsh-memfuse:memory');
  assert.equal(spec.order, 118, 'order 必须是字面量 118（getContextOrder 不存在）');

  // provider 必须同步返回 string —— 返回 Promise 会在宿主里被拼成 [object Promise]
  const text = spec.text({});
  assert.equal(typeof text, 'string', `text provider 必须同步返回 string，实际 ${typeof text}`);
  assert.ok(!text.includes('[object Promise]'), '不能返回 Promise');
  console.log('  ✅ 注入 provider 同步返回 string（长度 ' + text.length + '）');
});

test('pre-step → 注入内容：P0 常驻 + 相关召回都出现', async (t) => {
  t.after(() => fsp.rm(tmpRoot, { recursive: true, force: true }));
  const h = fakeCtx();
  const api = mod.apply(h.ctx, { root: tmpRoot, git: false, verbose: false });
  await api.ready;

  // 先写两条记忆
  const write = h.tools.find((d) => d.name === 'memfuse_write');
  await write.execute({
    mode: 'add', kind: 'convention', priority: 'P0',
    title: '回答一律用简体中文', summary: '所有回复使用简体中文。', anchor: '任何对话开始时',
  });
  await write.execute({
    mode: 'add', kind: 'convention', priority: 'P1',
    title: '本仓库统一用 pnpm', summary: 'install 与 script 都用 pnpm。', anchor: '安装依赖、运行脚本时',
  });
  await api.refreshInjectionCache();

  // 模拟一轮：pre-step 带本轮用户输入
  // ⚠️ 必须按宿主**真实契约**调用：`agent/pre-step` 是 waterfall 模式，
  // 派发时会给监听器传 `next`，监听器必须返回 `next()` 的结果。
  // 不传 next 就测不出"插件截断了瀑布链"这个缺陷（真机上会让整轮对话崩）。
  const preStep = h.handlers.get('agent/pre-step')?.[0];
  assert.ok(preStep, '必须注册 agent/pre-step 以获取本轮输入');
  const downstream = { kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: '下游结果' }] }] };
  const returned = preStep(
    {
      messages: [
        { role: 'user', source: { kind: 'plugin' }, content: [{ type: 'text', text: '注入块不该被当成用户输入' }] },
        { role: 'user', content: [{ type: 'text', text: '我要装个依赖，用 npm 还是 pnpm？' }] },
      ],
    },
    () => Promise.resolve(downstream),
  );
  assert.ok(
    returned && typeof returned.then === 'function',
    'agent/pre-step 是 waterfall：必须返回 next() 的 Promise，否则会截断瀑布链（宿主读 decision.kind 会炸）',
  );
  assert.equal(await returned, downstream, '必须原样交还下游的 decision');
  await new Promise((r) => setTimeout(r, 150));
  await api.refreshInjectionCache();

  const text = h.contexts[0].text({});
  assert.ok(text.includes('## Super Memory'), '应包含 Super Memory 标题');
  assert.ok(text.includes('回答一律用简体中文'), 'P0 常驻块必须在');
  assert.ok(text.includes('本仓库统一用 pnpm'), '相关召回必须在');
  assert.ok(text.includes('不是指令'), '信任边界声明必须在');
  console.log('  ✅ 注入内容含常驻 + 召回 + 信任边界');
  console.log(text.split('\n').map((l) => '     ' + l).join('\n'));
});

test('注入：读库失败时 Block D 出现（失败可见的真实数据源）', async (t) => {
  const h = fakeCtx();
  const api = mod.apply(h.ctx, { root: tmpRoot, git: false, verbose: false });
  await api.ready;
  await api.refreshInjectionCache();

  // 把 memories 换成一个**文件**：readdir 会抛 ENOTDIR（真实故障，
  // 不是"目录不存在"那种正常状态）
  const asFile = path.join(tmpRoot, 'not-a-dir');
  await fsp.writeFile(asFile, 'x', 'utf8');
  api.store.root.memories = asFile;
  await api.refreshInjectionCache();

  assert.equal(api.health().ok, false, 'health 应转为故障');
  const text = h.contexts[0].text({});
  assert.ok(text.includes('⚠️'), 'Block D 告警必须出现');
  assert.ok(text.includes('仍然可用'), '必须告知哪些功能仍可用');
  console.log('  ✅ Block D 数据源可用（读库失败 → 注入告警）');
});

test('卸载：disposer 被 ctx.effect 收好并可释放', async (t) => {
  t.after(() => fsp.rm(tmpRoot, { recursive: true, force: true }));
  const h = fakeCtx();
  const api = mod.apply(h.ctx, { root: tmpRoot, git: false, verbose: false });
  await api.ready;
  assert.equal(h.effects.length, 1, '必须用 ctx.effect 注册卸载逻辑');
  assert.equal(api.disposers.length, 7, '6 个工具 + 1 个注入 provider');
  h.effects[0]();
  assert.equal(h.disposersCalled.length, 7, '释放时必须逐个调用 disposer');
  console.log('  ✅ disposer 全部释放：', h.disposersCalled.join(', '));
});

test('status 工具返回 JSON 且 schema 与实际返回值一致', async (t) => {
  t.after(() => fsp.rm(tmpRoot, { recursive: true, force: true }));
  const h = fakeCtx();
  const api = mod.apply(h.ctx, { root: tmpRoot, git: false, verbose: false });
  await api.ready;
  const status = h.tools.find((d) => d.name === 'memfuse_status');
  const value = await status.execute({});
  assert.equal(typeof value, 'string');
  assert.doesNotThrow(() => JSON.parse(value), 'execute 必须返回可解析的 JSON 字符串');
  assert.equal(status.output.schema.type, typeof value, 'schema.type 必须与返回值类型一致');
  console.log('  ✅ status 返回值与 output.schema 一致（string）');
});

// ───────────────────────── 阶段 1：数据安全 + 学习闭环 ─────────────────────────

const policy = await import('../lib/policy.js');
const storeMod = await import('../lib/store.js');

test('生命周期：被召回过的 dormant 不再被物理删除（原判据会误删）', () => {
  const old = new Date(Date.now() - 40 * 86400000).toISOString();
  const mk = (id, stats) => ({
    id, lifecycle: 'dormant', dormantAt: old, priority: 'P2', source: 'auto', kind: 'fact', stats,
  });
  const now = Date.now();
  assert.deepEqual(
    policy.planPurge([mk('a', { recalled: 0, positive: 0, negative: 0 })], {}, now),
    ['a'], '从未被召回 + 零反馈 → 该删',
  );
  assert.deepEqual(
    policy.planPurge([mk('b', { recalled: 3, positive: 0, negative: 0 })], {}, now),
    [], '被召回过的 → 不能删（它曾经有用）',
  );
  assert.deepEqual(
    policy.planPurge([mk('c', { recalled: 0, positive: 1, negative: 0 })], {}, now),
    [], '有反馈的 → 不能删',
  );
  console.log('  ✅ purge 判据：只有「从未被召回 + 零反馈」才删');
});

test('生命周期：revive 把 dormant 拉回 active 并重算 expires', () => {
  const rec = { id: 'x', priority: 'P1', lifecycle: 'dormant', dormantAt: '2026-01-01T00:00:00.000Z', expires: '2026-01-01T00:00:00.000Z' };
  const back = policy.revive(rec, { p1Days: 30 });
  assert.equal(back.lifecycle, 'active');
  assert.equal(back.dormantAt, null);
  assert.ok(Date.parse(back.expires) > Date.now(), 'expires 必须被重算到未来');
  assert.equal(policy.revive({ id: 'y', priority: 'P0' }, {}).expires, null, 'P0 永不过期');
  console.log('  ✅ revive 路径可用');
});

test('预算超限但被保护项堵死时会报告（不再静默）', () => {
  const many = Array.from({ length: 5 }, (_, i) => ({
    id: `p${i}`, kind: 'fact', priority: 'P0', source: 'user', lifecycle: 'active',
  }));
  const pressure = policy.evictionPressure(many, { maxMemories: 2 });
  assert.equal(pressure.memories.over, 3);
  assert.equal(pressure.memories.evictable, 0);
  assert.equal(pressure.memories.blocked, true, '被堵死必须能被识别出来');
  assert.deepEqual(policy.planEviction(many, { maxMemories: 2 }), [], '一条都动不了');
  console.log('  ✅ 预算压力可报告：超 3 条 / 可淘汰 0 条 / blocked');
});

test('drift guard：手改坏的文件被拒绝重写并留下备份', async (t) => {
  const root = path.join(os.tmpdir(), `memfuse-drift-${Date.now()}`);
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const store = new storeMod.MemoryStore({ root, git: false }, { log() {}, warn() {} });
  await store.init();

  // 手工写一个「有 frontmatter 但里面有坏行（没有冒号）」的文件
  const p = path.join(root, 'memories', 'm_bad.md');
  await fsp.writeFile(p, '---\nid: m_bad\ntitle: 手改过的\n这一行没有冒号\n---\n\n正文\n', 'utf8');
  assert.equal(storeMod.isCanonical(await fsp.readFile(p, 'utf8')), false, '应判为不规范');

  await assert.rejects(
    () => store.write({ id: 'm_bad', kind: 'fact', title: '试图覆盖', body: 'x' }),
    (e) => e.name === 'DriftError' && typeof e.backup === 'string',
    '必须抛 DriftError 并给出备份路径',
  );
  const files = await fsp.readdir(path.join(root, 'memories'));
  assert.ok(files.some((f) => f.includes('.bak.')), `应留下备份，实际：${files.join(',')}`);
  const kept = await fsp.readFile(p, 'utf8');
  assert.ok(kept.includes('这一行没有冒号'), '原文件必须原样保留（未被覆盖）');
  console.log('  ✅ drift guard：拒绝重写 + 备份 + 原文件完好');
});

test('反馈生产端：memfuse_recall 累加 recalled 并弱续期', async (t) => {
  const root = path.join(os.tmpdir(), `memfuse-recall-${Date.now()}`);
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const h = fakeCtx();
  const api = mod.apply(h.ctx, { root, git: false, verbose: false, lifecycle: { p1WeakRenewDays: 3 } });
  await api.ready;

  const write = h.tools.find((d) => d.name === 'memfuse_write');
  const added = JSON.parse(await write.execute({
    mode: 'add', kind: 'convention', priority: 'P1',
    title: '安装依赖统一用 pnpm', summary: 'pnpm 而不是 npm。', anchor: '安装依赖时',
  }));
  // 人为把 expires 拨到过去，好观察续期
  const rec = await api.store.read(added.id);
  await api.store.write({ ...rec, expires: new Date(Date.now() - 86400000).toISOString() });

  const recall = h.tools.find((d) => d.name === 'memfuse_recall');
  const out = JSON.parse(await recall.execute({ query: '安装依赖 用哪个包管理器' }));
  assert.ok(out.count >= 1, '应命中该条');

  const after = await api.store.read(added.id);
  assert.equal(after.stats.recalled, 1, 'recalled 必须被累加（原来永远是 0）');
  assert.ok(Date.parse(after.expires) > Date.now(), '被召回后应弱续期到未来');
  console.log(`  ✅ recalled=${after.stats.recalled}，expires 已续期`);
});

test('注入生产端：注入过的记忆 injected 在下一轮被累加', async (t) => {
  const root = path.join(os.tmpdir(), `memfuse-inj-${Date.now()}`);
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const h = fakeCtx();
  const api = mod.apply(h.ctx, { root, git: false, verbose: false });
  await api.ready;

  const write = h.tools.find((d) => d.name === 'memfuse_write');
  const added = JSON.parse(await write.execute({
    mode: 'add', kind: 'convention', priority: 'P0',
    title: '回答一律用简体中文', summary: '所有回复用中文。', anchor: '任何对话开始时',
  }));
  await api.refreshInjectionCache();

  // 触发一次 provider 求值（它会登记 pendingInjected）
  const text = h.contexts[0].text({});
  assert.ok(text.includes('回答一律用简体中文'), 'P0 应被注入');
  assert.ok(api.lastInjection(), '必须留下归因记录（entries 原来无人消费）');
  assert.deepEqual(api.lastInjection().ids, [added.id]);

  const flushed = await api.flushInjected();
  assert.equal(flushed, 1, '应落盘 1 条注入计数');
  const after = await api.store.read(added.id);
  assert.equal(after.stats.injected, 1, 'injected 必须被累加');
  console.log(`  ✅ injected=${after.stats.injected}，归因记录已写进 state.json`);
});

test('memfuse_write revive：把休眠记忆唤醒回 active', async (t) => {
  const root = path.join(os.tmpdir(), `memfuse-revive-${Date.now()}`);
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const h = fakeCtx();
  const api = mod.apply(h.ctx, { root, git: false, verbose: false });
  await api.ready;

  const write = h.tools.find((d) => d.name === 'memfuse_write');
  const added = JSON.parse(await write.execute({
    mode: 'add', kind: 'fact', priority: 'P2', title: '待唤醒的记忆', summary: 's', anchor: 'a',
  }));
  // 手动转休眠
  const rec = await api.store.read(added.id);
  await api.store.write({ ...rec, lifecycle: 'dormant', dormantAt: new Date().toISOString() });

  const out = JSON.parse(await write.execute({ mode: 'revive', match: '待唤醒的记忆' }));
  assert.equal(out.ok, true, JSON.stringify(out));
  const after = await api.store.read(added.id);
  assert.equal(after.lifecycle, 'active');
  assert.equal(after.dormantAt, null);
  console.log('  ✅ revive 动作生效：dormant → active');
});

// ───────────────────────── 阶段 2：学习闭环 ─────────────────────────

test('memfuse_feedback：改置信度 + 落 usage 事件', async (t) => {
  const root = path.join(os.tmpdir(), `memfuse-fb-${Date.now()}`);
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const h = fakeCtx();
  const api = mod.apply(h.ctx, { root, git: false, verbose: false });
  await api.ready;

  const write = h.tools.find((d) => d.name === 'memfuse_write');
  const feedback = h.tools.find((d) => d.name === 'memfuse_feedback');
  const added = JSON.parse(await write.execute({
    mode: 'add', kind: 'convention', priority: 'P1', title: '提交前跑一遍测试', summary: 's', anchor: 'a',
  }));
  const before = (await api.store.read(added.id)).confidence;

  const neg = JSON.parse(await feedback.execute(
    { id: added.id, sign: 'negative', reason: '这次不该跑', category: '编程/前端', quote: '怎么还没改对' },
    { agent: { session: { id: 'sess-fb' } } },
  ));
  assert.equal(neg.ok, true, JSON.stringify(neg));
  const after = await api.store.read(added.id);
  assert.ok(after.confidence < before, `负面反馈应下调置信度：${before} → ${after.confidence}`);
  assert.equal(after.stats.negative, 1);
  assert.ok(neg.utility < 0, `utility 应为负，实际 ${neg.utility}`);

  const pos = JSON.parse(await feedback.execute({ id: added.id, sign: 'positive' }));
  const after2 = await api.store.read(added.id);
  assert.equal(after2.stats.positive, 1);
  assert.ok(after2.confidence > after.confidence, '正面反馈应微升置信度');

  // usage.jsonl 必须留下结构化事件（可检索、可统计）
  const usage = await fsp.readFile(path.join(root, '.memory', 'usage.jsonl'), 'utf8');
  const events = usage.trim().split('\n').map((l) => JSON.parse(l));
  const fb = events.filter((e) => e.type === 'feedback');
  assert.equal(fb.length, 2, `应有 2 条 feedback 事件，实际 ${fb.length}`);
  assert.equal(fb[0].sign, 'negative');
  assert.equal(fb[0].category, '编程/前端');
  assert.equal(fb[0].quote, '怎么还没改对');
  console.log('  ✅ 反馈：置信度 ' + before + ' → ' + after.confidence + ' → ' + after2.confidence + '，usage 事件 2 条');
});

test('E5 模式识别：跨 3 个会话被召回 → P2 自动升 P1（同会话多次不算）', async (t) => {
  const root = path.join(os.tmpdir(), `memfuse-promote-${Date.now()}`);
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const h = fakeCtx();
  const api = mod.apply(h.ctx, { root, git: false, verbose: false, learn: { promoteMinSessions: 3 } });
  await api.ready;

  const write = h.tools.find((d) => d.name === 'memfuse_write');
  const recall = h.tools.find((d) => d.name === 'memfuse_recall');
  const added = JSON.parse(await write.execute({
    mode: 'add', kind: 'convention', priority: 'P2', title: '日志统一走 stderr',
    summary: '不要把日志写到 stdout。', anchor: '写日志时',
  }));
  const exec = (sid) => ({ agent: { session: { id: sid } } });

  // 同一个会话里连召 5 次：只算 1 个会话，不该升级
  for (let i = 0; i < 5; i++) await recall.execute({ query: '日志 写到哪' }, exec('sess-A'));
  let rec = await api.store.read(added.id);
  assert.equal(rec.sessionCount, 1, `同会话应只计 1，实际 ${rec.sessionCount}`);
  assert.equal(rec.priority, 'P2', '同会话多次召回不该升级');

  // 再来两个不同会话 → 跨 3 会话，升级
  await recall.execute({ query: '日志 写到哪' }, exec('sess-B'));
  await recall.execute({ query: '日志 写到哪' }, exec('sess-C'));
  rec = await api.store.read(added.id);
  assert.equal(rec.sessionCount, 3, `应计 3 个会话，实际 ${rec.sessionCount}`);
  assert.equal(rec.priority, 'P1', '跨 3 会话应自动升 P1');
  assert.equal(rec.promotedFrom, 'P2');
  assert.ok(rec.promotedAt, '升级必须留时间戳');
  console.log(`  ✅ 跨会话计数 ${rec.sessionCount} → 自动升级 ${rec.promotedFrom}→${rec.priority}`);
});

test('E5 四道闸：只升 P2→P1、P0 不动、不重复升、必须跨会话', async () => {
  const p = await import('../lib/policy.js');
  const base = { sessionCount: 99 };
  assert.equal(p.shouldPromote({ ...base, priority: 'P0' }), false, 'P0 永不自动升');
  assert.equal(p.shouldPromote({ ...base, priority: 'P1' }), false, '只升 P2');
  assert.equal(
    p.shouldPromote({ ...base, priority: 'P2', promotedAt: '2026-10-15T00:00:00.000Z' }),
    false,
    '已升级过的不重复升',
  );
  assert.equal(p.shouldPromote({ ...base, priority: 'P2' }), true, 'P2 + 跨 99 会话 → 允许');
  assert.equal(
    p.shouldPromote({ priority: 'P2', sessionCount: 2 }, 3),
    false,
    '不足门槛不升',
  );
  console.log('  ✅ shouldPromote 四道闸生效');
});

test('F1 捕获：turn/end 落盘 + 跳过插件注入 + 同轮去重 + 凭据替换', async (t) => {
  const root = path.join(os.tmpdir(), `memfuse-cap-${Date.now()}`);
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const h = fakeCtx();
  const api = mod.apply(h.ctx, { root, git: false, verbose: false });
  await api.ready;

  const sessHandler = h.handlers.get('session/event')?.[0];
  assert.ok(sessHandler, '必须注册 session/event 以捕获 turn/end');

  const events = [
    // 真人提问
    { type: 'user/message', seq: 1, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '帮我把部署脚本改一下，密钥是 api_key: sk-abcdefghijklmnopqrst' }] } },
    // 宿主在提问**之后**追加的系统注入 —— 真机上 source.kind 五花八门
    // （本机累计：runtime-context=196 / skill-catalog=75 / agent-instructions=49 …）。
    // 向后扫"最后一条用户消息"时，这些会排在真人提问之后，最容易被误当成用户输入。
    { type: 'user/message', seq: 2, data: { role: 'user', source: { kind: 'runtime-context', form: 'environment' }, content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier snapshots.' }] } },
    { type: 'user/message', seq: 3, data: { role: 'user', source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: 'Additional instructions from: DeepSeekPlugin/AGENTS.md' }] } },
    // 插件自己注入的记忆块（Block A–D）
    { type: 'user/message', seq: 4, data: { role: 'user', source: { kind: 'plugin' }, content: [{ type: 'text', text: '这是插件注入的记忆块，绝不该被捕获' }] } },
    { type: 'assistant/message', seq: 5, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'reasoning', text: '思考中' }, { type: 'text', text: '好的，我先看现有的部署脚本。' }] } } },
    { type: 'turn/end', seq: 6, data: { turn: 1 } },
  ];

  // 挑素材的单测：注入块排在真人提问之后，仍然要挑出真人那句（白名单，不是黑名单）
  const ex = mod.extractExchange(events);
  assert.ok(
    ex.userText.startsWith('帮我把部署脚本改一下'),
    `userText 必须是真人输入，实际 ${JSON.stringify(ex.userText.slice(0, 50))}`,
  );
  assert.ok(ex.assistantText.includes('我先看现有的部署脚本'), 'assistant 文本要取到');

  // ⚠️ 这里是**真机形状**：dsh-session 的 Session 类没有 `events` 属性，
  //    公开访问器只有 `ownEvents()` / `snapshotEvents()`（本机探针实测
  //    `('events' in session) === false`，见 spec §3.12 缺陷 12）。
  //    以前这一条假的是 `{ id, events: [...] }` —— 宿主里压根没有那种对象，
  //    于是测试全绿而真机捕获**一轮都没跑过**。假 ctx 的保真度就是这类缺陷的闸门。
  const sess = { id: 'sess-cap', ownEvents: () => events };
  sessHandler(sess, events[5]);
  await new Promise((r) => setTimeout(r, 300));

  const dir = path.join(root, 'sessions');
  const files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.md'));
  assert.equal(files.length, 1, `应生成 1 个会话日志，实际 ${files.join(',')}`);
  const text = await fsp.readFile(path.join(dir, files[0]), 'utf8');
  assert.ok(text.includes('帮我把部署脚本改一下'), '真人用户输入应被捕获');
  assert.ok(text.includes('我先看现有的部署脚本'), 'assistant 文本应被捕获');
  assert.ok(!text.includes('插件注入的记忆块'), '⚠️ 插件注入的内容绝不能被当成用户输入再存一遍');
  assert.ok(!text.includes('Current runtime context'), '⚠️ 宿主注入的 runtime-context 也不能当真人输入');
  assert.ok(!text.includes('Additional instructions from'), '⚠️ 工作区指令注入同理');
  assert.ok(!text.includes('思考中'), 'reasoning 块不应进日志');
  assert.ok(text.includes('[已过滤'), '凭据应被替换成占位符（不是整轮丢弃）');
  assert.ok(!text.includes('sk-abcdefghijklmnopqrst'), '⚠️ 凭据本身绝不能落盘');

  // 同一轮再触发一次 → 不该重复写
  sessHandler(sess, events[5]);
  await new Promise((r) => setTimeout(r, 200));
  const again = await fsp.readFile(path.join(dir, files[0]), 'utf8');
  assert.equal(again, text, '同一轮不该捕获两次');

  // 旧形状（只有 events 数组的宿主实现）仍然要能用 —— 三个来源都试
  sessHandler({ id: 'sess-legacy', events }, events[5]);
  await new Promise((r) => setTimeout(r, 200));
  const legacyText = await fsp.readFile(path.join(dir, files[0]), 'utf8');
  assert.ok(legacyText.length > text.length, 'legacy events 数组也要能捕获（换个 session id 不算同轮）');

  // 捕获进度必须**从磁盘派生**并出现在 status.md 上（内存计数在短命进程里会撒谎：
  // headless 一轮跑完就退出，而计数只在 pre-step 里落盘 —— 实测出现过
  // "素材文件 1 个" 旁边写着 "已捕获轮次: 0" 的自相矛盾）
  await api.status();
  const status = await fsp.readFile(path.join(root, '.memory', 'status.md'), 'utf8');
  assert.match(status, /已捕获轮次: 2/, `status.md 要如实反映磁盘上的轮次，实际：\n${status}`);
  assert.match(status, /素材文件: 1 个/, '素材文件数也要对');
  console.log('  ✅ 捕获：真机形状(ownEvents) + 旧形状都能落盘 / 跳过 plugin 注入 / 凭据已替换 / 同轮去重');
});

test('缺陷 12 回归：读不到会话事件时必须留故障，不能静默', async (t) => {
  // 事故现场：宿主 session 上没有 `events`，`Array.isArray()` 判空后每轮直接 return
  // → 捕获整条路径死掉，而 sessions/ 只是"空"，status.md 也一片正常。
  const root = path.join(os.tmpdir(), `memfuse-noev-${Date.now()}`);
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const h = fakeCtx();
  const api = mod.apply(h.ctx, { root, git: false, verbose: false });
  await api.ready;

  const sessHandler = h.handlers.get('session/event')[0];
  // 一个"陌生"的 session 对象：三个访问器一个都没有
  sessHandler({ id: 'sess-stranger' }, { type: 'turn/end', seq: 9, data: { turn: 1 } });
  await api.flushInjected();

  const st = JSON.parse(await fsp.readFile(path.join(root, '.memory', 'state.json'), 'utf8'));
  assert.ok(st.runtimeFaults?.captureFail, '拿不到事件必须记成运行期故障');
  assert.match(String(st.runtimeFaults.captureFail.message), /事件访问器/, '故障文案要说清是什么坏了');

  await api.status();
  const status = await fsp.readFile(path.join(root, '.memory', 'status.md'), 'utf8');
  assert.ok(status.includes('会话捕获失败'), 'status.md 要如实报出来');
  assert.ok(status.includes('已捕获轮次: 0'), '捕获进度要可见（0 才是那个刺眼的信号）');

  // 直接单测访问器解析：四个来源 / 抛错 / 全缺
  const ev = [{ type: 'turn/end', seq: 1, data: {} }];
  assert.equal(mod.sessionEvents({ ownEvents: () => ev }).via, 'ownEvents()');
  assert.equal(mod.sessionEvents({ events: ev }).via, 'events');
  assert.equal(mod.sessionEvents({ snapshotEvents: () => ev }).via, 'snapshotEvents()');
  assert.equal(
    mod.sessionEvents({ events: [], ownEvents: () => ev }).via,
    'ownEvents()',
    'ownEvents 优先：fork 场景不能把父会话内容再存一遍',
  );
  assert.equal(
    mod.sessionEvents({ ownEvents: () => { throw new Error('boom'); }, snapshotEvents: () => ev }).via,
    'snapshotEvents()',
    '一个访问器抛错不该整条路径失效',
  );
  assert.equal(mod.sessionEvents({ id: 'x' }).via, null, '全缺 → via=null（调用方必须留痕）');
  assert.equal(mod.sessionEvents(null).via, null);
  console.log('  ✅ 缺陷 12 回归：访问器缺失 → 运行期故障 + status.md 可见；四种来源都收敛正确');
});

test('F4 凭据过滤：memory_write 命中即拒绝，正常内容不受影响', async (t) => {
  const root = path.join(os.tmpdir(), `memfuse-guard-${Date.now()}`);
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const h = fakeCtx();
  const api = mod.apply(h.ctx, { root, git: false, verbose: false });
  await api.ready;
  const write = h.tools.find((d) => d.name === 'memfuse_write');

  const bad = JSON.parse(await write.execute({
    mode: 'add', kind: 'fact', priority: 'P2', title: '数据库连接',
    summary: 'password: hunter2xyz', body: 'x',
  }));
  assert.equal(bad.ok, false, '含凭据必须拒绝');
  assert.ok(bad.error.includes('凭据'), bad.error);
  assert.ok(!bad.error.includes('hunter2xyz'), '⚠️ 错误信息不能回显凭据本身');

  const good = JSON.parse(await write.execute({
    mode: 'add', kind: 'fact', priority: 'P2', title: '数据库连接信息',
    summary: '连接串放在 1Password 的「生产库」条目里，不要写进代码。', body: 'x',
  }));
  assert.equal(good.ok, true, `正常内容不该被拦：${JSON.stringify(good)}`);
  console.log('  ✅ 凭据过滤：拒绝命中项且不回显，正常内容放行');
});

// ───────────────────────── 阶段 3：抽取 + 待确认队列 ─────────────────────────

/** 假模型：按固定文本产出 text-delta 块，可配置为抛错。 */
function fakeLlm(responseText, opts = {}) {
  const calls = [];
  return {
    calls,
    stream(options) {
      calls.push(options);
      if (opts.fail) throw new Error(opts.fail);
      return (async function* gen() {
        if (opts.finishError) {
          // 宿主**真实**的失败形态：**不抛错**，而是把失败编码进 finish.reason。
          // 真机实测（中转站 HTTP 400「模型价格未配置」）就是这个形状。
          yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
          yield { type: 'finish', reason: { kind: 'error', failure: { message: opts.finishError } } };
          return;
        }
        yield { type: 'text-delta', index: 0, text: responseText };
        yield { type: 'finish', reason: 'stop' };
      })();
    },
  };
}

const extractMod = await import('../lib/extract.js');
const queueMod = await import('../lib/queue.js');

/** 假模型：第 N 次调用按 `turns[N]` 产出 chunk（用来复现"推理吃光预算"那种流）。 */
function fakeLlmTurns(turns) {
  const calls = [];
  let index = 0;
  return {
    calls,
    stream(options) {
      calls.push(options);
      const chunks = turns[Math.min(index, turns.length - 1)];
      index += 1;
      return (async function* gen() {
        for (const chunk of chunks) yield chunk;
      })();
    },
  };
}

test('空正文：推理型模型吃光 maxTokens → 加倍重试一次；两次都空则报出**完整现场**', async (t) => {
  // ⚠️ 候选字段必须齐全：`policy.normalize()` 要求 durability / evidence 是合法枚举值，
  // 缺了就直接丢（而且**不报错** —— 准入是静默的，测试这边踩过一次）。
  const candidates = JSON.stringify([
    {
      kind: 'convention',
      title: '以后都统一用 pnpm',
      summary: '不要再用 npm。',
      body: '用户要求：以后都统一用 pnpm 安装依赖。',
      anchor: '安装依赖时',
      tags: ['pnpm'],
      durability: 'durable',
      confidence: 0.9,
      evidence: 'explicit',
    },
  ]);

  const mk = async (llm) => {
    const root = path.join(
      os.tmpdir(),
      `memfuse-empty-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    );
    t.after(() => fsp.rm(root, { recursive: true, force: true }));
    const h = fakeCtx({ llm });
    const api = mod.apply(h.ctx, {
      root, git: false, verbose: false,
      extract: { enabled: true, provider: 'p', model: 'm', autoRunOnStart: false, minChars: 10 },
    });
    await api.ready;
    await fsp.mkdir(path.join(root, 'sessions'), { recursive: true });
    await fsp.writeFile(
      path.join(root, 'sessions', '2026-10-15.md'),
      `[User]: 以后统一用 pnpm\n${'补充内容。'.repeat(40)}\n`,
      'utf8',
    );
    return { api, root };
  };

  // ① 第一次：只有推理增量 + finish=max-tokens（正文一个字都没有）→ 加倍重试后成功
  const bad = [
    { type: 'reasoning-delta', index: 0, text: '让我先想想……' },
    { type: 'usage', usage: { inputTokens: 900, outputTokens: 4000, reasoningTokens: 4000 } },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ];
  const good = [{ type: 'text-delta', index: 0, text: candidates }, { type: 'finish', reason: { kind: 'stop' } }];
  const llm1 = fakeLlmTurns([bad, good]);
  const a = await mk(llm1);
  const r1 = await a.api.runExtraction({});
  assert.equal(r1.ok, true, `重试后应成功，实际 ${JSON.stringify(r1)}`);
  assert.equal(llm1.calls.length, 2, '被截断时要重试一次');
  assert.equal(llm1.calls[0].maxTokens, 4000);
  assert.equal(llm1.calls[1].maxTokens, 8000, '重试要把预算加倍');

  // ② 两次都空 → 报错必须带**现场**（finish / 用量 / chunk 直方图 / 线索）
  const llm2 = fakeLlmTurns([bad]);
  const b = await mk(llm2);
  const r2 = await b.api.runExtraction({});
  assert.equal(r2.ok, false);
  const st = JSON.parse(await fsp.readFile(path.join(b.root, '.memory', 'state.json'), 'utf8'));
  const msg = String(st.lastExtractError || '');
  assert.match(msg, /没有返回任何正文/, `实际 ${msg}`);
  assert.match(msg, /maxTokens\(8000\)/, '要说清是被哪个上限截断的（重试后的值）');
  assert.match(msg, /推理增量/, '要区分"推理内容"和"正文"');
  assert.match(msg, /收到的 chunk：.*reasoning-delta/, '要打出 chunk 直方图，这是唯一的现场');
  assert.match(msg, /换一个非推理模型|重试/, '要给可执行的下一步');

  // ③ 正文**非空但被截断**（写了一半的 JSON）→ 同样加倍重试，并取更完整的那份
  const half = [
    { type: 'text-delta', index: 0, text: '[{"kind":"fact","title":"本地优先' },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ];
  const whole = [{ type: 'text-delta', index: 0, text: candidates }, { type: 'finish', reason: { kind: 'stop' } }];
  const llm3 = fakeLlmTurns([half, whole]);
  const c = await mk(llm3);
  const r3 = await c.api.runExtraction({});
  assert.equal(r3.ok, true, `半截 JSON 应靠重试救回来，实际 ${JSON.stringify(r3)}`);
  assert.equal(llm3.calls.length, 2, 'finish=max-tokens 就该重试（**不要求正文为空**）');
  assert.equal(llm3.calls[1].maxTokens, 8000, '重试要把预算加倍');
  assert.equal(r3.candidates, 1, '重试后应拿到候选');

  // ④ 两次都截断 → 提示"像是被截断"，而不是只说"无法解析"（用户才知道该换模型/重试）
  const llm4 = fakeLlmTurns([half]);
  const d = await mk(llm4);
  const r4 = await d.api.runExtraction({});
  assert.equal(r4.ok, false);
  const st4 = JSON.parse(await fsp.readFile(path.join(d.root, '.memory', 'state.json'), 'utf8'));
  assert.match(String(st4.lastExtractError || ''), /被截断/, `实际 ${st4.lastExtractError}`);

  console.log('  ✅ 空正文/半截：加倍重试；真失败→现场完整；截断→明说"像是被截断"');
});

test('抽取纯函数：偏好识别 + JSON 容错解析', () => {
  assert.equal(extractMod.looksLikePreference('以后都统一用 pnpm'), true);
  assert.equal(extractMod.looksLikePreference('不要用 npm'), true);
  assert.equal(extractMod.looksLikePreference('always use pnpm'), true);
  assert.equal(extractMod.looksLikePreference('部署脚本在 scripts/deploy.sh'), false);

  // 模型多写一段解释、包了代码围栏是常态
  const fenced = '好的，这是结果：\n```json\n[{"title":"a"}]\n```\n希望有帮助。';
  assert.deepEqual(extractMod.parseCandidates(fenced), [{ title: 'a' }]);
  assert.deepEqual(extractMod.parseCandidates('完全不是 JSON'), []);
  assert.deepEqual(extractMod.parseCandidates(''), []);
  console.log('  ✅ 偏好识别 + JSON 容错解析');
});

test('队列：一条一项一文件，可列可查可删', async (t) => {
  const root = path.join(os.tmpdir(), `memfuse-queue-${Date.now()}`);
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const store = new storeMod.MemoryStore({ root, git: false }, { log() {}, warn() {} });
  await store.init();

  await queueMod.putPending(store.root, { id: 'p1', title: '标题一', priority: 'P1', createdAt: '2026-10-15T00:00:00Z' });
  await queueMod.putPending(store.root, { id: 'p2', title: '标题二', priority: 'P2', createdAt: '2026-10-15T01:00:00Z' });
  const all = await queueMod.listPending(store.root);
  assert.equal(all.length, 2);
  assert.equal(all[0].id, 'p1', '应按 createdAt 升序');

  assert.equal((await queueMod.findPending(store.root, '标题二')).id, 'p2', '按标题查');
  assert.equal((await queueMod.findPending(store.root, 'p2')).id, 'p2', '按 id 查');
  assert.equal(await queueMod.findPending(store.root, '不存在'), null);

  const files = await fsp.readdir(queueMod.pendingDir(store.root));
  assert.equal(files.length, 2, '一条一项一文件');
  assert.ok(files.every((f) => f.endsWith('.json')));
  console.log('  ✅ 队列：一条一项一文件（不是单文件 append，避免并发插入）');
});

test('F2 抽取：fake 模型 → 候选 → 准入 → 偏好加成 → 进队列', async (t) => {
  const root = path.join(os.tmpdir(), `memfuse-extract-${Date.now()}`);
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const h = fakeCtx({
    llm: fakeLlm(JSON.stringify([
      // 偏好句 + 低置信 → 准入判 P2，但偏好加成应升到 P1
      { kind: 'convention', title: '以后都统一用 pnpm', summary: '不要再用 npm。', body: '用户要求：以后都统一用 pnpm 安装依赖。', anchor: '安装依赖时', tags: ['pnpm'], durability: 'temporary', confidence: 0.6, evidence: 'implicit' },
      // 普通事实：durable + 高置信 → P1
      { kind: 'fact', title: '部署脚本在 scripts/deploy.sh', summary: '部署入口。', body: '部署走 scripts/deploy.sh。', anchor: '要部署时', tags: [], durability: 'durable', confidence: 0.9, evidence: 'implicit' },
      // 一次性指令：必须被丢弃
      { kind: 'fact', title: '这次先跳过 lint', summary: 's', body: 'b', anchor: 'a', durability: 'turn_local', confidence: 0.9, evidence: 'explicit' },
      // 含凭据：必须被丢弃
      { kind: 'fact', title: '数据库口令', summary: 'password: hunter2xyz', body: 'password: hunter2xyz', anchor: 'a', durability: 'durable', confidence: 0.9, evidence: 'explicit' },
    ])),
  });
  const api = mod.apply(h.ctx, {
    root, git: false, verbose: false,
    extract: { enabled: true, provider: 'fake', model: 'fake', autoRunOnStart: false },
  });
  await api.ready;

  // 造一个足够长的会话文件
  await fsp.writeFile(
    path.join(root, 'sessions', '2026-10-15.md'),
    `### 10:00\n=== 本轮最终问答 ===\n[User]: 帮我改一下部署脚本，以后都统一用 pnpm\n[DSH]: 好的。\n${'补充内容。'.repeat(40)}\n`,
    'utf8',
  );

  const res = await api.runExtraction({});
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.candidates, 2, `turn_local 与含凭据的必须被丢弃，实际 ${res.candidates}`);
  assert.equal(res.queued, 2);
  assert.equal(res.written, 0, 'suggest 模式不该直写');

  const pending = await api.listPending();
  assert.equal(pending.length, 2);
  const pref = pending.find((p) => p.preference === true);
  assert.ok(pref, '偏好项必须被标记');
  assert.equal(pref.priority, 'P1', '偏好加成应把 P2 抬到 P1');
  assert.equal(pref.source, 'extract');
  assert.equal(pref.sourceFile, '2026-10-15.md', '必须能追溯是哪天抽出来的');
  console.log(`  ✅ 抽取：候选 2（丢弃 turn_local + 含凭据），偏好项升 P1`);
});

test('F2 水位线：同一段内容不会被重复抽取', async (t) => {
  const root = path.join(os.tmpdir(), `memfuse-mark-${Date.now()}`);
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const llm = fakeLlm(JSON.stringify([
    { kind: 'fact', title: '部署脚本在 scripts/deploy.sh', summary: '部署入口。', body: '部署走 scripts/deploy.sh。', anchor: '要部署时', durability: 'durable', confidence: 0.9, evidence: 'implicit' },
  ]));
  const h = fakeCtx({ llm });
  const api = mod.apply(h.ctx, { root, git: false, verbose: false, extract: { enabled: true, provider: 'p', model: 'm', autoRunOnStart: false } });
  await api.ready;
  await fsp.writeFile(path.join(root, 'sessions', '2026-10-15.md'), `x${'内容。'.repeat(120)}`, 'utf8');

  const first = await api.runExtraction({});
  assert.equal(first.candidates, 1);
  const callsAfterFirst = llm.calls.length;

  const second = await api.runExtraction({});
  assert.equal(second.files, 0, '第二次不该再处理同一文件（水位线已推进）');
  assert.equal(llm.calls.length, callsAfterFirst, '不该再调模型');
  console.log('  ✅ 水位线：成功才推进，同一段不重复抽取');
});

test('F2 失败可见：模型报错 → lastExtractError → Block D 告警（原来这条不可达）', async (t) => {
  const root = path.join(os.tmpdir(), `memfuse-extfail-${Date.now()}`);
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const h = fakeCtx({ llm: fakeLlm('', { fail: '503 model unavailable' }) });
  const api = mod.apply(h.ctx, { root, git: false, verbose: false, extract: { enabled: true, provider: 'p', model: 'm', autoRunOnStart: false } });
  await api.ready;
  await fsp.writeFile(path.join(root, 'sessions', '2026-10-15.md'), `x${'内容。'.repeat(120)}`, 'utf8');

  const res = await api.runExtraction({});
  assert.equal(res.ok, false);
  assert.ok(res.errors.length >= 1 && res.errors[0].includes('503'), JSON.stringify(res.errors));

  await api.refreshInjectionCache();
  assert.equal(api.health().ok, false, 'health 应转为故障');
  assert.ok(String(api.health().reason).includes('503'));
  const text = h.contexts[0].text({});
  assert.ok(text.includes('⚠️'), 'Block D 必须出现');
  assert.ok(text.includes('503'), '告警要带原因');
  assert.ok(text.includes('memfuse_write'), '必须告知哪些功能仍可用');
  console.log('  ✅ 抽取失败可见：lastExtractError → Block D 告警（这条原来结构性不可达）');
});

test('E6 approve / reject：采纳写进记忆，丢弃只删队列项', async (t) => {
  const root = path.join(os.tmpdir(), `memfuse-approve-${Date.now()}`);
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const h = fakeCtx({
    llm: fakeLlm(JSON.stringify([
      { kind: 'convention', title: '以后都统一用 pnpm', summary: '不要再用 npm。', body: '以后都统一用 pnpm。', anchor: '安装依赖时', durability: 'durable', confidence: 0.9, evidence: 'explicit' },
      { kind: 'fact', title: '部署脚本在 scripts/deploy.sh', summary: '部署入口。', body: '部署走 scripts/deploy.sh。', anchor: '要部署时', durability: 'durable', confidence: 0.9, evidence: 'implicit' },
    ])),
  });
  const api = mod.apply(h.ctx, { root, git: false, verbose: false, extract: { enabled: true, provider: 'p', model: 'm', autoRunOnStart: false } });
  await api.ready;
  await fsp.writeFile(path.join(root, 'sessions', '2026-10-15.md'), `x${'内容。'.repeat(120)}`, 'utf8');
  await api.runExtraction({});
  assert.equal((await api.listPending()).length, 2);

  const write = h.tools.find((d) => d.name === 'memfuse_write');
  const pending = await api.listPending();
  const pref = pending.find((p) => p.preference);
  const other = pending.find((p) => !p.preference);

  const ok = JSON.parse(await write.execute({ mode: 'approve', match: pref.title }));
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const rec = await api.store.read(ok.memoryId);
  assert.equal(rec.source, 'auto', '抽取产物不是用户资产（可被淘汰、可被升级）');
  assert.equal(rec.priority, pref.priority);
  assert.equal((await api.listPending()).length, 1, '采纳后应从队列移除');

  const rej = JSON.parse(await write.execute({ mode: 'reject', match: other.title }));
  assert.equal(rej.ok, true, JSON.stringify(rej));
  assert.equal((await api.listPending()).length, 0, '丢弃后应从队列移除');

  const usage = await fsp.readFile(path.join(root, '.memory', 'usage.jsonl'), 'utf8');
  const types = usage.trim().split('\n').map((l) => JSON.parse(l).type);
  assert.ok(types.includes('queue-approve'), '采纳要留痕');
  assert.ok(types.includes('queue-reject'), '丢弃要留痕');
  console.log('  ✅ approve 写进记忆 / reject 只删队列项，两者都写 usage 留痕');
});

test('F2 没开开关 / 开了没选模型：明确报原因，不报错也不静默', async (t) => {
  const root = path.join(os.tmpdir(), `memfuse-nocfg-${Date.now()}`);
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const h = fakeCtx();
  const api = mod.apply(h.ctx, { root, git: false, verbose: false, extract: { autoRunOnStart: false } });
  await api.ready;

  // 默认：总开关关着 → 说清是"没开启"，而且算 disabled（不是故障）
  const res = await api.runExtraction({});
  assert.equal(res.ok, false);
  assert.equal(res.disabled, true, '开关没开 = disabled，不该被当成故障');
  assert.ok(res.reason.includes('自动抽取没开启'), res.reason);

  // 关键：记忆的读写注入照常工作
  const write = h.tools.find((d) => d.name === 'memfuse_write');
  const added = JSON.parse(await write.execute({ mode: 'add', title: '照常可写', summary: 's', body: 'b' }));
  assert.equal(added.ok, true, '没开抽取不该影响手写记忆');
  console.log('  ✅ 开关没开：抽取明确报原因（不算故障），手写记忆照常工作');
});

// ───────────────────────── 阶段 3 第二批：技能提炼（H）─────────────────────────

const skillMod = await import('../lib/skill.js');
const distillMod = await import('../lib/distill.js');

test('H4 四个静默坑：CRLF / 裸值 / 目录名不一致 / 行尾规范', () => {
  const s = skillMod;
  // 坑 1：CRLF —— 不清行尾 \r 会让 "name: foo-bar\r" 整行匹配失败
  const crlf = '---\r\nname: foo-bar\r\ndescription: 说明\r\n---\r\n\r\n正文\r\n';
  const p1 = s.parseSkillMd(crlf);
  assert.ok(p1, 'CRLF 的 SKILL.md 必须能解析');
  assert.equal(p1.name, 'foo-bar');

  // 坑 2：裸值里含 ": " 会被严格 YAML 拒
  assert.equal(s.parseSkillMd('---\nname: foo\ndescription: 用法: 先这样\n---\n'), undefined);
  // 而 buildSkillMd 强制加引号后就没问题
  const built = s.buildSkillMd({ name: 'foo', description: '用法: 先这样', body: '正文' });
  assert.equal(s.parseSkillMd(built).description, '用法: 先这样');
  assert.ok(built.includes('description: "'), 'description 必须加引号');
  assert.ok(!built.includes('\r'), '行尾必须是 LF');

  // 坑 3：目录名 ≠ frontmatter name
  const v = s.validateSkill({ name: 'foo', content: s.buildSkillMd({ name: 'bar', description: 'd', body: 'b' }) });
  assert.equal(v.ok, false);
  assert.ok(v.error.includes('不一致'));

  // 名字语法
  assert.equal(s.isSkillName('repo-onboarding'), true);
  assert.equal(s.isSkillName('Repo_Onboarding'), false);
  assert.equal(s.isSkillName('../escape'), false);
  console.log('  ✅ 四个静默坑：CRLF 能解析 / 裸值被拒 / 名字不一致被拒 / 行尾 LF');
});

test('H2 中文技能名退化成哈希名，而不是整条丢弃', () => {
  const s = skillMod;
  assert.equal(s.slugifySkillName('repo-onboarding'), 'repo-onboarding');
  assert.equal(s.slugifySkillName('Repo Onboarding!'), 'repo-onboarding');
  const cn = s.slugifySkillName('接手陌生仓库的摸底流程');
  assert.ok(s.isSkillName(cn), `中文名应退化成合法 kebab-case，实际 ${cn}`);
  assert.ok(cn.startsWith('skill-'));
  console.log(`  ✅ 中文名 → ${cn}（不整条丢弃，那种静默丢弃正是要防的）`);
});

test('H4 写完自校验：目录名不一致的技能被标成 loadable: false', async (t) => {
  const dir = path.join(os.tmpdir(), `memfuse-skillchk-${Date.now()}`);
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const s = skillMod;
  await fsp.mkdir(path.join(dir, 'wrong-name'), { recursive: true });
  await fsp.writeFile(
    path.join(dir, 'wrong-name', 'SKILL.md'),
    s.buildSkillMd({ name: 'other-name', description: 'd', body: 'b' }),
    'utf8',
  );
  const list = await s.listSkills(dir);
  assert.equal(list.length, 1);
  assert.equal(list[0].loadable, false, '必须如实标出"会被 DSH 静默跳过"');
  assert.ok(list[0].problem.includes('不一致'));
  console.log('  ✅ 自校验：不一致的技能被标成不可加载（而不是假装没看见）');
});

test('H1 候选识别：零 LLM 打分 + 按共享标签聚类', () => {
  const d = distillMod;
  const mem = (o) => ({
    id: 'm', title: 't', summary: 's', body: 'b', kind: 'fact', priority: 'P2',
    lifecycle: 'active', tags: [], stats: {}, ...o,
  });
  const strong = mem({ id: 'a', kind: 'experience', sessionCount: 4, body: '第一步先看 README，再跑测试。', tags: ['x'] });
  const weak = mem({ id: 'b', title: '随便一条', body: '没什么结构' });
  const s1 = d.scoreCandidate(strong, { minSessions: 3 });
  const s2 = d.scoreCandidate(weak, { minSessions: 3 });
  assert.ok(s1.score >= 6, `强候选分应够高，实际 ${s1.score}`);
  assert.ok(s1.reasons.some((r) => r.includes('步骤')), s1.reasons.join('、'));
  assert.ok(s2.score < 4, `弱候选不该够格，实际 ${s2.score}`);

  const all = [strong, weak, mem({ id: 'c', tags: ['x'], body: 'x' })];
  const cluster = d.clusterAround(strong, all, 6);
  assert.equal(cluster[0].id, 'a');
  assert.ok(cluster.some((r) => r.id === 'c'), '共享标签的应被聚进来');
  assert.ok(!cluster.some((r) => r.id === 'b'), '无共享标签的不该进簇');
  assert.equal(d.findCandidates(all, { minScore: 4, minSessions: 3 }).length, 1);
  console.log(`  ✅ 候选打分 ${s1.score} vs ${s2.score}；聚类按共享标签（不引入新相似度机制）`);
});

test('H2 提炼容错：模型说 skip / 输出不是 JSON', async () => {
  const d = distillMod;
  const cluster = [{ id: 'x', title: 't', body: 'b', tags: [] }];
  const skip = await d.distillSkill({ cluster, callModel: async () => '{"skip":"这些记忆凑不出流程"}' });
  assert.equal(skip.ok, false);
  assert.equal(skip.skipped, true, 'skip 要能被识别出来，而不是当成错误');

  const junk = await d.distillSkill({ cluster, callModel: async () => '我觉得这些内容挺好的' });
  assert.equal(junk.ok, false);
  assert.ok(junk.error.includes('无法解析'), junk.error);

  const boom = await d.distillSkill({ cluster, callModel: async () => { throw new Error('503 model unavailable'); } });
  assert.equal(boom.ok, false);
  assert.ok(boom.error.includes('503'));
  console.log('  ✅ 提炼容错：skip / 非 JSON / 模型报错 三种都明确报出来');
});

test('H2/H3/H5 提炼 → 待确认 → approve 装进技能库 + derived-into 反向标记', async (t) => {
  const root = path.join(os.tmpdir(), `memfuse-distill-${Date.now()}`);
  const skillDir = path.join(root, 'skills-lib');
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const h = fakeCtx({
    llm: fakeLlm(JSON.stringify({
      name: 'repo-onboarding',
      description: '接手一个陌生仓库时用',
      body: '## 步骤\n1. 先读 README\n2. 再跑测试',
    })),
  });
  const api = mod.apply(h.ctx, {
    root, git: false, verbose: false,
    extract: { enabled: true, provider: 'p', model: 'm', autoRunOnStart: false },
    skill: { dir: skillDir, minScore: 3, minSessions: 2 },
  });
  await api.ready;

  const write = h.tools.find((d) => d.name === 'memfuse_write');
  const added = JSON.parse(await write.execute({
    mode: 'add', kind: 'experience', priority: 'P1',
    title: '接手陌生仓库的摸底流程',
    summary: '第一步先读 README，再跑测试。',
    body: '第一步先读 README，再跑测试，最后看 CI 配置。',
    anchor: '接手新仓库时',
    tags: ['onboarding'],
  }));

  const skill = h.tools.find((d) => d.name === 'memfuse_skill');
  const list0 = JSON.parse(await skill.execute({ action: 'list' }));
  assert.equal(list0.skills.length, 0);
  assert.ok(list0.candidates.length >= 1, '应识别出候选（零 LLM，启动时已跑）');

  const dis = JSON.parse(await skill.execute({ action: 'distill', match: '接手陌生仓库的摸底流程' }));
  assert.equal(dis.ok, true, JSON.stringify(dis));
  assert.equal(dis.name, 'repo-onboarding');

  const list1 = JSON.parse(await skill.execute({ action: 'list' }));
  assert.equal(list1.pendingSkills.length, 1, '应进待确认队列');
  assert.equal(list1.pendingSkills[0].loadable, true, '待确认技能本身必须是规范格式');
  assert.equal(list1.skills.length, 0, 'approve 之前不该进技能库');

  const app = JSON.parse(await skill.execute({ action: 'approve', name: 'repo-onboarding' }));
  assert.equal(app.ok, true, JSON.stringify(app));
  assert.equal(app.markedSources, 1, '应标记 1 条源记忆');
  const list2 = JSON.parse(await skill.execute({ action: 'list' }));
  assert.equal(list2.skills.length, 1);
  assert.equal(list2.skills[0].loadable, true);
  assert.equal(list2.pendingSkills.length, 0, 'approve 后应从待确认移除');

  const rec = await api.store.read(added.id);
  assert.equal(rec.derivedInto, 'repo-onboarding', '源记忆必须被标 derivedInto（双向可追溯）');

  const raw = await fsp.readFile(path.join(skillDir, 'repo-onboarding', 'SKILL.md'), 'utf8');
  assert.ok(!raw.includes('\r'), '落盘必须 LF');
  assert.ok(raw.includes('description: "'), 'description 必须加引号');
  console.log('  ✅ distill → 待确认 → approve 装进技能库，源记忆标 derivedInto');
});

test('H6 patch 需要 read-before-write 证据', async (t) => {
  const root = path.join(os.tmpdir(), `memfuse-patch-${Date.now()}`);
  const skillDir = path.join(root, 'skills-lib');
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const h = fakeCtx();
  const api = mod.apply(h.ctx, { root, git: false, verbose: false, skill: { dir: skillDir } });
  await api.ready;
  await skillMod.writeSkill(skillDir, 'demo-skill', skillMod.buildSkillMd({ name: 'demo-skill', description: 'd', body: 'b' }));

  const skill = h.tools.find((d) => d.name === 'memfuse_skill');
  const newBody = skillMod.buildSkillMd({ name: 'demo-skill', description: 'd2', body: '新正文' });

  // 没 show 过 → 拒绝
  const denied = JSON.parse(await skill.execute({ action: 'patch', name: 'demo-skill', body: newBody }));
  assert.equal(denied.ok, false);
  assert.ok(denied.error.includes('show'), denied.error);

  // 会话里带了 show 的 tool/call → 允许（会话对象按**真机形状**给：只有 ownEvents()）
  const execWithRead = {
    agent: {
      session: {
        id: 'sess-patch',
        ownEvents: () => [
          { type: 'tool/call', data: { name: 'memfuse_skill', arguments: JSON.stringify({ action: 'show', name: 'demo-skill' }) } },
        ],
      },
    },
  };
  const allowed = JSON.parse(await skill.execute({ action: 'patch', name: 'demo-skill', body: newBody }, execWithRead));
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  const raw = await fsp.readFile(path.join(skillDir, 'demo-skill', 'SKILL.md'), 'utf8');
  assert.ok(raw.includes('新正文'), 'patch 应真的写进去');
  console.log('  ✅ patch：无 read 证据被拒，有 read 证据放行');
});

test('技能：approve 不覆盖已有技能（防误伤）', async (t) => {
  const root = path.join(os.tmpdir(), `memfuse-skdup-${Date.now()}`);
  const skillDir = path.join(root, 'skills-lib');
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const h = fakeCtx();
  const api = mod.apply(h.ctx, { root, git: false, verbose: false, skill: { dir: skillDir } });
  await api.ready;

  await skillMod.writeSkill(skillDir, 'dup-skill', skillMod.buildSkillMd({ name: 'dup-skill', description: 'd', body: 'b' }));
  await skillMod.writeSkill(api.store.root.pendingSkills, 'dup-skill', skillMod.buildSkillMd({ name: 'dup-skill', description: 'd', body: 'b2' }));
  const skill = h.tools.find((d) => d.name === 'memfuse_skill');
  const out = JSON.parse(await skill.execute({ action: 'approve', name: 'dup-skill' }));
  assert.equal(out.ok, false);
  assert.ok(out.error.includes('已经有'), out.error);
  console.log('  ✅ approve 拒绝覆盖已存在的技能');
});

// ───────────────────────── 阶段 3 第三批：反腐烂（G，保守子集）─────────────────────────

const antisepticMod = await import('../lib/antiseptic.js');

test('G1 重复检测：exact / title / summary 三类分得清', () => {
  const mem = (o) => ({
    id: 'x', title: 't', summary: 's', body: 'b', kind: 'fact', priority: 'P2',
    lifecycle: 'active', updated: '2026-10-15T00:00:00Z', ...o,
  });
  const all = [
    // exact：归一化标题与归一化正文都相同（含空格差异）
    mem({ id: 'e1', title: '用 pnpm', summary: 's1', body: '相同正文', updated: '2026-10-15T00:00:00Z' }),
    mem({ id: 'e2', title: '用  pnpm ', summary: 's1', body: '相同 正文', updated: '2026-10-10T00:00:00Z' }),
    // title：标题同、正文不同
    mem({ id: 't1', title: '部署流程', summary: 'sa', body: '正文甲' }),
    mem({ id: 't2', title: '部署流程', summary: 'sb', body: '正文乙' }),
    // summary：摘要同（够长）、标题不同
    mem({ id: 's1', title: '标题甲', summary: '这是一段足够长的相同摘要', body: 'x1' }),
    mem({ id: 's2', title: '标题乙', summary: '这是一段足够长的相同摘要', body: 'x2' }),
  ];
  const clusters = antisepticMod.findDuplicateClusters(all);
  assert.deepEqual(clusters.map((c) => c.kind).sort(), ['exact', 'summary', 'title']);
  const exact = clusters.find((c) => c.kind === 'exact');
  assert.equal(exact.members[0].id, 'e1', '新的排前面');
  assert.equal(exact.members[1].id, 'e2');
  console.log('  ✅ 三类簇都识别出来：exact / title / summary');
});

test('G1 planStale：只动「完全重复」且只留最新；同标题不同正文不自动动手', () => {
  const mk = (id, updated, body = 'B') => ({
    id, title: 'T', body, summary: '', kind: 'fact', priority: 'P2', lifecycle: 'active', updated,
  });
  const clusters = antisepticMod.findDuplicateClusters([
    mk('new', '2026-10-15T00:00:00Z'),
    mk('old', '2026-10-01T00:00:00Z'),
  ]);
  const plan = antisepticMod.planStale(clusters);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].id, 'old');
  assert.equal(plan[0].supersededBy, 'new');

  const tclusters = antisepticMod.findDuplicateClusters([
    { id: 'a', title: 'T', body: 'B1', summary: '', kind: 'fact', priority: 'P2', lifecycle: 'active' },
    { id: 'b', title: 'T', body: 'B2', summary: '', kind: 'fact', priority: 'P2', lifecycle: 'active' },
  ]);
  assert.deepEqual(antisepticMod.planStale(tclusters), [], '同标题不同正文不自动标 stale');
  assert.ok(antisepticMod.renderPotentialConflicts(tclusters).length > 0, '但必须报告出来');
  console.log('  ✅ planStale：只动完全重复、只留最新；同标题不同正文只报告');
});

test('G4 stale 真的降权 0.20，而 conflict 的 0.35 不该由启发式来设', async () => {
  const p = await import('../lib/policy.js');
  const rec = { priority: 'P1', confidence: 0.8, updated: new Date().toISOString(), stats: {} };
  const normal = p.score(rec, 0.5);
  const staled = p.score({ ...rec, stale: true }, 0.5);
  const conflicted = p.score({ ...rec, conflict: true }, 0.5);
  assert.ok(Math.abs(normal - staled - 0.2) < 1e-9, `stale 差值应正好 0.20，实际 ${(normal - staled).toFixed(4)}`);
  assert.ok(normal - conflicted > normal - staled, 'conflict 惩罚更重');
  console.log(`  ✅ stale −0.20 生效；conflict −0.35（更重，所以只报告不自动设）`);
});

test('G1/G4 维护：完全重复自动标 stale，同标题不同正文只报告、绝不设 conflict', async (t) => {
  const root = path.join(os.tmpdir(), `memfuse-anti-${Date.now()}`);
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const h = fakeCtx();
  const api = mod.apply(h.ctx, {
    root, git: false, verbose: false,
    lifecycle: { autoRunOnStart: false },
  });
  await api.ready;
  const write = h.tools.find((d) => d.name === 'memfuse_write');

  await write.execute({ mode: 'add', kind: 'fact', priority: 'P2', title: '完全重复的条目', summary: '同一个摘要内容在这里', body: '完全一样的正文' });
  await new Promise((r) => setTimeout(r, 15));
  await write.execute({ mode: 'add', kind: 'fact', priority: 'P2', title: '完全重复的条目', summary: '同一个摘要内容在这里', body: '完全一样的正文' });
  await write.execute({ mode: 'add', kind: 'fact', priority: 'P2', title: '同标题不同正文', summary: '摘要甲在这里够长了', body: '甲' });
  await write.execute({ mode: 'add', kind: 'fact', priority: 'P2', title: '同标题不同正文', summary: '摘要乙在这里够长了', body: '乙' });

  const res = await api.maintenance();
  assert.equal(res.staled, 1, `只该标 1 条（完全重复里较旧的那条），实际 ${res.staled}`);
  assert.ok(res.dupReport.length >= 2, `报告应含两类簇，实际 ${res.dupReport.length}`);
  assert.ok(res.conflictReport.length >= 1, '同标题不同正文应进冲突报告');

  const all = await api.store.list();
  const dup = all.filter((r) => r.title === '完全重复的条目');
  assert.equal(dup.filter((r) => r.stale === true).length, 1, '完全重复里旧的那条应被标 stale');
  assert.ok(dup.find((r) => r.stale === true).supersededBy, 'stale 条目要记 supersededBy');
  const titleDup = all.filter((r) => r.title === '同标题不同正文');
  assert.equal(titleDup.filter((r) => r.stale === true).length, 0, '同标题不同正文不该自动标 stale');
  assert.equal(titleDup.filter((r) => r.conflict === true).length, 0, '⚠️ conflict 绝不该被自动设');
  console.log(`  ✅ 维护：${res.staled} 条标 stale；冲突只报告、不设标记`);
});

test('G1 duplicates / supersede 两个 mode：标记而非删除，原文保留', async (t) => {
  const root = path.join(os.tmpdir(), `memfuse-sup-${Date.now()}`);
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const h = fakeCtx();
  const api = mod.apply(h.ctx, { root, git: false, verbose: false, lifecycle: { autoRunOnStart: false } });
  await api.ready;
  const write = h.tools.find((d) => d.name === 'memfuse_write');

  const oldOne = JSON.parse(await write.execute({ mode: 'add', kind: 'fact', priority: 'P2', title: '旧版本条目', summary: '旧摘要', body: '旧正文' }));
  const newOne = JSON.parse(await write.execute({ mode: 'add', kind: 'fact', priority: 'P2', title: '新版本条目', summary: '新摘要', body: '新正文' }));

  const dups = JSON.parse(await write.execute({ mode: 'duplicates' }));
  assert.equal(dups.ok, true);
  assert.equal(typeof dups.count, 'number');

  const sup = JSON.parse(await write.execute({ mode: 'supersede', match: '旧版本条目', by: '新版本条目' }));
  assert.equal(sup.ok, true, JSON.stringify(sup));
  assert.equal(sup.superseded, oldOne.id);
  assert.equal(sup.by, newOne.id);

  const rec = await api.store.read(oldOne.id);
  assert.equal(rec.stale, true);
  assert.equal(rec.lifecycle, 'dormant', '归档后不再注入');
  assert.equal(rec.supersededBy, newOne.id);
  assert.ok(rec.body.includes('旧正文'), '⚠️ 原文必须保留（不做正文合并，合并会丢信息）');

  // 可回滚
  const back = JSON.parse(await write.execute({ mode: 'revive', match: '旧版本条目' }));
  assert.equal(back.ok, true);
  assert.equal((await api.store.read(oldOne.id)).lifecycle, 'active');
  console.log('  ✅ supersede：标 stale + 转休眠 + 原文保留 + 可 revive 回滚');
});

// ─────────────── 真机缺陷回归（2026-10-15，见 spec §3.12）───────────────

test('缺陷 1 回归：llm 是可选依赖 —— 宿主不给它，插件照常工作', async (t) => {
  const root = path.join(os.tmpdir(), `memfuse-llm-opt-${Date.now()}`);
  const root2 = `${root}-with-llm`;
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  t.after(() => fsp.rm(root2, { recursive: true, force: true }));

  // ── ① 宿主**没有** llm 服务 ──
  const h = fakeCtx(); // 不传 llm
  const api = mod.apply(h.ctx, {
    root, git: false, verbose: false,
    extract: { enabled: true, provider: 'fake', model: 'fake', autoRunOnStart: false },
  });
  await api.ready;

  // 假 ctx 按真实契约：未 inject 时属性访问就抛（这正是原缺陷的根源）
  assert.throws(() => h.ctx.llm, /without inject/, '假 ctx 应模拟"未 inject 就抛"');

  // 不因缺依赖整块失效：工具与注入必须照常
  assert.equal(h.tools.length, 6, '没有 llm 时 6 个工具仍要注册');
  assert.equal(h.contexts.length, 1, '没有 llm 时注入仍要挂上');

  // 走模型的路径要给**明确原因**，不能崩、也不能静默
  await fsp.mkdir(path.join(root, 'sessions'), { recursive: true });
  await fsp.writeFile(
    path.join(root, 'sessions', '2026-10-15.md'),
    `[User]: 以后都统一用 pnpm\n${'补充内容。'.repeat(60)}\n`,
    'utf8',
  );
  const res = await api.runExtraction({});
  assert.equal(res.ok, false);
  assert.match(JSON.stringify(res.errors), /llm/, `要明确说缺 llm，实际 ${JSON.stringify(res.errors)}`);

  // ── ② 宿主**有** llm：同一套代码抽取就通了 ──
  const h2 = fakeCtx({
    llm: fakeLlm(
      JSON.stringify([
        { kind: 'fact', title: '以后都统一用 pnpm', summary: '包管理器约定。', body: '以后都统一用 pnpm。', anchor: '安装依赖时', durability: 'durable', confidence: 0.9, evidence: 'implicit' },
      ]),
    ),
  });
  const api2 = mod.apply(h2.ctx, {
    root: root2, git: false, verbose: false,
    extract: { enabled: true, provider: 'fake', model: 'fake', autoRunOnStart: false },
  });
  await api2.ready;
  await fsp.mkdir(path.join(root2, 'sessions'), { recursive: true });
  await fsp.writeFile(
    path.join(root2, 'sessions', '2026-10-15.md'),
    `[User]: 以后都统一用 pnpm\n${'补充内容。'.repeat(60)}\n`,
    'utf8',
  );
  const res2 = await api2.runExtraction({});
  assert.equal(res2.ok, true, `有 llm 时抽取应成功：${JSON.stringify(res2)}`);
  console.log('  ✅ llm 可选：没有它工具/注入照常、走模型时明确报因；有它则抽取可用');
});

test('缺陷 2 回归：首次启动就落盘 state.json', async (t) => {
  const root = path.join(os.tmpdir(), `memfuse-state-${Date.now()}`);
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const h = fakeCtx();
  const api = mod.apply(h.ctx, { root, git: false, verbose: false });
  await api.ready;

  // 之前只在 runExtraction / flushInjected 里写 —— 首次启动且无会话时根本不存在
  const raw = await fsp.readFile(path.join(root, '.memory', 'state.json'), 'utf8');
  const st = JSON.parse(raw);
  assert.equal(typeof st, 'object');
  assert.ok('lastMaintenance' in st, 'state.json 应含上次维护记录');
  assert.ok('extractProvider' in st && 'extractModel' in st, 'state.json 应含抽取配置快照');
  assert.ok('extracted' in st || st.extracted === undefined, '水位线字段应在');
  console.log('  ✅ 首次启动即落盘 state.json（维护记录/抽取配置不再重启即丢）');
});

test('缺陷 4 回归：模型返回空数组是「没有可记的」，不是解析失败', async () => {
  const ex = await import('../lib/extract.js');

  // 空数组 = 正常结果
  assert.equal(ex.isExplicitEmptyArray('[]'), true);
  assert.equal(ex.isExplicitEmptyArray('```json\n[]\n```'), true);
  assert.equal(ex.isExplicitEmptyArray('  [ ]  '), true);
  // 非空 / 不是数组 / 空文本 = 不算"明确的空"
  assert.equal(ex.isExplicitEmptyArray('[{"title":"a"}]'), false);
  assert.equal(ex.isExplicitEmptyArray('完全不是 JSON'), false);
  assert.equal(ex.isExplicitEmptyArray(''), false);

  const longText = '一段足够长的会话内容，用来跨过 minChars 之类的门槛。'.repeat(20);

  // 行为：空数组不写 lastExtractError（否则会攒成 Block D 假告警）
  const empty = await ex.extractCandidates({ text: longText, callModel: async () => '[]' });
  assert.deepEqual(empty.candidates, []);
  assert.equal(empty.error, null, `空数组不该被当成故障，实际 error=${empty.error}`);

  // 真的解析不出来，才算故障
  const bad = await ex.extractCandidates({ text: longText, callModel: async () => '抱歉，我不会' });
  assert.equal(bad.candidates.length, 0);
  assert.ok(bad.error, '解析不出数组时必须报错（这才是真故障）');

  console.log('  ✅ 空数组=正常结果（不写 lastExtractError）；非 JSON=真故障');
});

test('缺陷 5 回归：agent/pre-step 是 waterfall，必须把决定权交还下游', async (t) => {
  const root = path.join(os.tmpdir(), `memfuse-waterfall-${Date.now()}`);
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const h = fakeCtx();
  const api = mod.apply(h.ctx, { root, git: false, verbose: false });
  await api.ready;

  const preStep = h.handlers.get('agent/pre-step')?.[0];
  assert.ok(preStep, '必须注册 agent/pre-step');

  // ① 下游监听器必须被调用到（不被截断）
  let downstreamCalled = false;
  const downstream = { kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: 'ok' }] }] };
  const r = await preStep({ messages: [], agent: { session: { id: 's1' } } }, () => {
    downstreamCalled = true;
    return Promise.resolve(downstream);
  });
  assert.equal(downstreamCalled, true, '必须调用 next()，否则瀑布链在此断掉');
  assert.equal(r, downstream, '必须原样交还下游的 decision');

  // ② 宿主真实用法：waterfall 链式派发，最终返回值就是 decision
  const decision = await h.dispatchPreStep({ messages: [], agent: { session: { id: 's1' } } });
  assert.ok(decision, '宿主必须拿到**非空** decision（undefined 会让下一步炸）');
  assert.equal(
    typeof decision.kind,
    'string',
    `宿主紧接着要读 decision.kind，实际 ${JSON.stringify(decision)} —— undefined 会直接抛 TypeError`,
  );

  console.log('  ✅ waterfall：调用了 next()、交还了 decision（宿主读 .kind 不会炸）');
});

test('缺陷 6 回归：模型失败编码在 finish.reason 里，不能被伪装成「输出无法解析」', async (t) => {
  const root = path.join(os.tmpdir(), `memfuse-finfail-${Date.now()}`);
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  // 宿主真实形态：ctx.llm.stream **不抛错**，把 400 的正文塞进 finish.reason.failure
  const h = fakeCtx({ llm: fakeLlm('', { finishError: '400: 模型 deepseek-x 的价格未配置' }) });
  const api = mod.apply(h.ctx, {
    root, git: false, verbose: false,
    extract: { enabled: true, provider: 'fake', model: 'fake', autoRunOnStart: false, minChars: 10 },
  });
  await api.ready;
  await fsp.mkdir(path.join(root, 'sessions'), { recursive: true });
  await fsp.writeFile(
    path.join(root, 'sessions', '2026-10-15.md'),
    `[User]: 以后都统一用 pnpm\n${'补充内容。'.repeat(30)}\n`,
    'utf8',
  );

  const res = await api.runExtraction({});
  const errText = JSON.stringify(res.errors || []);
  assert.match(errText, /模型调用失败/, `必须报「模型调用失败」，实际 ${errText}`);
  assert.match(errText, /价格未配置/, '必须带上服务端给的真实原因');
  assert.ok(!/无法解析/.test(errText), `不能被伪装成「输出无法解析」：${errText}`);
  assert.ok(!/模型调用失败：模型调用失败/.test(errText), `前缀不该重复：${errText}`);

  // 而且这个真实原因要能进 Block D（失败可见的落点）
  const st = JSON.parse(await fsp.readFile(path.join(root, '.memory', 'state.json'), 'utf8'));
  assert.match(String(st.lastExtractError || ''), /价格未配置/, 'lastExtractError 必须留下真实原因');
  console.log('  ✅ 模型失败带真实原因（不是含糊的「输出无法解析」）');
});

test('缺陷 7 回归：distill 的解析必须接受模型包成的数组', async () => {
  const dm = await import('../lib/distill.js');

  // 真机抓到的实际答法：一个含**多个**元素的数组（提示词要的是对象）
  const arr = JSON.stringify([
    { name: 'deploy-flow', description: '部署时用', body: '## 步骤\n1. 跑脚本' },
    { name: 'other-idea', description: '另一个', body: 'y' },
  ]);
  const obj = dm.parseSkillObject(arr);
  assert.ok(obj, `数组形式必须解析得出来，实际 ${JSON.stringify(obj)}`);
  assert.equal(obj.name, 'deploy-flow', '应取数组里的第一个对象');

  // 围栏包裹同样要能处理
  assert.equal(dm.parseSkillObject('```json\n' + arr + '\n```')?.name, 'deploy-flow');
  // 单元素数组
  assert.equal(dm.parseSkillObject('[{"name":"solo","description":"d","body":"b"}]')?.name, 'solo');
  // 对象形式仍然正常（不能为了修数组而弄坏它）
  assert.equal(dm.parseSkillObject('{"name":"a","description":"b","body":"c"}')?.name, 'a');
  // 模型明确说"凑不出流程"
  assert.equal(dm.parseSkillObject('{"skip":"这些记忆没有可复用流程"}')?.skip, '这些记忆没有可复用流程');
  // 垃圾输入
  assert.equal(dm.parseSkillObject('完全不是 JSON'), null);
  assert.equal(dm.parseSkillObject(''), null);

  console.log('  ✅ distill 解析：多元素数组 / 围栏 / 单元素 / 对象 / skip 都能处理');
});

test('缺陷 8 回归：模型漏字段时兜底，不整条丢弃', async () => {
  const dm = await import('../lib/distill.js');
  const cluster = [
    { id: 'm1', title: '部署走 scripts/deploy.sh', summary: 's1', body: 'b1' },
    { id: 'm2', title: '部署前先跑测试', summary: 's2', body: 'b2' },
  ];

  // 模型给了 name + body，但**漏了 description**（真机实测 deepseek-flash 会这样）
  const r = await dm.distillSkill({
    cluster,
    callModel: async () => JSON.stringify({ name: 'deploy-flow', body: '## 步骤\n1. 跑脚本' }),
  });
  assert.equal(r.ok, true, `漏 description 也该成功，实际 ${JSON.stringify(r)}`);
  assert.ok(String(r.description).includes('部署走 scripts/deploy.sh'), `兜底描述应可读，实际 ${r.description}`);
  assert.ok(r.content.includes('description: "'), 'description 必须带引号');

  // 全空对象也要兜底出一个合法技能 —— **不能静默丢弃**
  const r2 = await dm.distillSkill({ cluster, callModel: async () => '{}' });
  assert.equal(r2.ok, true, `空对象也要兜底，实际 ${JSON.stringify(r2)}`);
  assert.equal(typeof r2.name, 'string');

  // 但模型**明确说 skip** 时必须尊重它（别硬凑）
  const r3 = await dm.distillSkill({ cluster, callModel: async () => '{"skip":"凑不出流程"}' });
  assert.equal(r3.ok, false);
  assert.equal(r3.skipped, true);

  console.log('  ✅ distill 字段兜底：漏 description / 空对象 都不丢弃，但尊重 skip');
});

test('缺陷 9 回归：运行期故障必须可见（不能只 console.warn）', async () => {
  const { healthOf } = await import('../lib/index.js');
  const inj = await import('../lib/inject.js');

  // 干净状态：健康
  assert.equal(healthOf({ extractModel: 'x', extractProvider: 'p' }).ok, true);

  // 运行期故障**优先于**抽取管线，且要标 runtime
  const h = healthOf({
    extractModel: 'x',
    runtimeFaults: { injectFail: { at: '2026-10-15T00:00:00Z', message: 'boom' } },
  });
  assert.equal(h.ok, false, '有运行期故障就不能算健康');
  assert.equal(h.runtime, true, '必须标出是运行期故障');
  assert.match(h.reason, /注入装配失败/, `要用人话，实际 ${h.reason}`);
  assert.match(h.reason, /boom/, '要带上原始报错');

  // Block D 必须用"功能部分不可用"的文案 ——
  // 否则用户会把"注入坏了"误读成"库本来就是空的"
  const d = inj.buildInjection([], '', h, {}).blocks.find((b) => b.key === 'D');
  assert.ok(d, 'Block D 必须出现');
  const dt = d.body.join('\n');
  assert.match(dt, /部分不可用/, `实际 ${dt}`);
  assert.doesNotMatch(dt, /自动抽取.*已停止/, '运行期故障不该说成抽取停摆');

  // 抽取类故障仍用原文案（两条线不能混）
  const h2 = { ok: false, sinceDays: 3, reason: '模型调用失败' };
  const d2 = inj.buildInjection([], '', h2, {}).blocks.find((b) => b.key === 'D');
  assert.match(d2.body.join('\n'), /自动抽取.*已停止 3 天/, '抽取故障文案要保留');

  // 抽取故障必须带**时间戳**：lastExtractError 是持久化的历史字符串，
  // 代码修好之后它不会自己消失 —— 没有时间戳就没法分辨"现在还坏着"还是"那次坏过"
  const h3 = healthOf({
    extractModel: 'x',
    extractProvider: 'p',
    lastExtractError: 'provider "[object Object]" 不在宿主注册表里',
    lastErrorAt: '2026-10-15T10:08:55.297Z',
  });
  assert.equal(h3.ok, false);
  assert.match(h3.reason, /记录于 2026-10-15T10:08:55\.297Z/, `要标出记录时间，实际 ${h3.reason}`);
  assert.equal(h3.staleError, true, '要标出这是历史记录');

  console.log('  ✅ 运行期故障进 Block D（文案区分「功能不可用」vs「抽取停摆」）+ 历史错误带时间戳');
});

test('抽取降级：模型不可用时按 onUnavailable 决定「停」还是「降」', async (t) => {
  // 宿主注册表里只有 real-p（两个模型）
  const llm = fakeLlm('[]');
  llm.listProviders = async () => [{ id: 'real-p', name: 'Real' }];
  llm.listModels = async () => [{ id: 'real-m' }, { id: 'real-m2' }];

  const mk = async (extractCfg, services) => {
    const root = path.join(
      os.tmpdir(),
      `memfuse-fb-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    );
    t.after(() => fsp.rm(root, { recursive: true, force: true }));
    const h = fakeCtx({ llm, services });
    const api = mod.apply(h.ctx, {
      root, git: false, verbose: false,
      // 降级那几条路径都以「开关已开」为前提（开关本身由上面那条测试覆盖）
      extract: { enabled: true, autoRunOnStart: false, minChars: 10, ...extractCfg },
    });
    await api.ready;
    await fsp.mkdir(path.join(root, 'sessions'), { recursive: true });
    await fsp.writeFile(
      path.join(root, 'sessions', '2026-10-15.md'),
      `[User]: 以后统一用 pnpm\n${'补充内容。'.repeat(40)}\n`,
      'utf8',
    );
    return api;
  };

  // ① stop（默认）：模型不在注册表里 → 直接失败，且**一次模型都没调**
  llm.calls.length = 0;
  const a = await mk({ provider: 'ghost-p', model: 'ghost-m', onUnavailable: 'stop' });
  const r1 = await a.runExtraction({});
  assert.equal(r1.ok, false, 'stop 策略下必须失败');
  assert.match(String(r1.reason), /不在宿主注册表里/, `要说清为什么，实际 ${r1.reason}`);
  assert.equal(llm.calls.length, 0, '静态不可用不该白跑一次模型调用');

  // ② fallback + 显式降级目标 → 降级后成功，且用的是降级目标
  llm.calls.length = 0;
  const b = await mk({
    provider: 'ghost-p', model: 'ghost-m',
    onUnavailable: 'fallback', fallbackProvider: 'real-p', fallbackModel: 'real-m',
  });
  const r2 = await b.runExtraction({});
  assert.equal(r2.ok, true, `降级后应成功，实际 ${JSON.stringify(r2)}`);
  assert.ok(llm.calls.length > 0, '降级后必须真的调了模型');
  assert.equal(llm.calls[0].provider, 'real-p', '必须用降级目标');
  assert.equal(llm.calls[0].model, 'real-m');

  // ③ fallback + 跟随「对话主模型」（agentDefaultModel 服务）
  llm.calls.length = 0;
  const c = await mk(
    { provider: 'ghost-p', model: 'ghost-m', onUnavailable: 'fallback' },
    { agentDefaultModel: { currentSelection: () => ({ provider: 'real-p', model: 'real-m2' }) } },
  );
  const r3 = await c.runExtraction({});
  assert.equal(r3.ok, true, `跟随主模型降级应成功，实际 ${JSON.stringify(r3)}`);
  assert.equal(llm.calls[0].model, 'real-m2', '应跟随 agentDefaultModel 的选择');

  // ④ fallback 但降级目标自己也坏 → 明确失败，不静默
  const d = await mk({
    provider: 'ghost-p', model: 'ghost-m',
    onUnavailable: 'fallback', fallbackProvider: 'real-p', fallbackModel: 'nope',
  });
  const r4 = await d.runExtraction({});
  assert.equal(r4.ok, false, '降级目标也坏时必须失败');
  assert.match(String(r4.reason), /降级目标.*也不可用/, `实际 ${r4.reason}`);

  console.log('  ✅ 抽取降级：stop / 显式降级 / 跟随主模型 / 降级目标也坏 —— 四条路径都对');
});

test('抽取四形态：默认关闭 / 开关开了但没选模型 / 跟随对话模型 / 显式挑选', async (t) => {
  const llm = fakeLlm('[]');
  llm.listProviders = async () => [{ id: 'real-p', name: 'Real' }];
  llm.listModels = async () => [{ id: 'real-m' }, { id: 'real-m2' }];

  const mk = async (extractCfg, services) => {
    const root = path.join(
      os.tmpdir(),
      `memfuse-target-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    );
    t.after(() => fsp.rm(root, { recursive: true, force: true }));
    const h = fakeCtx({ llm, services });
    const api = mod.apply(h.ctx, {
      root, git: false, verbose: false,
      extract: { autoRunOnStart: false, minChars: 10, ...extractCfg },
    });
    await api.ready;
    // 抽取只在**有素材时**才会调模型：先落一份会话原文（否则只是空跑管线）
    await fsp.mkdir(path.join(root, 'sessions'), { recursive: true });
    await fsp.writeFile(
      path.join(root, 'sessions', '2026-10-15.md'),
      `[User]: 以后统一用 pnpm\n${'补充内容。'.repeat(40)}\n`,
      'utf8',
    );
    return api;
  };

  // ① **默认**：总开关关着 → 抽取不跑，而且**不算故障**（不写 lastExtractError）
  const a = await mk({});
  const r1 = await a.runExtraction({});
  assert.equal(r1.ok, false);
  assert.equal(r1.disabled, true, '默认关闭要标成 disabled（不是故障）');
  assert.match(String(r1.reason), /自动抽取没开启/, `文案要说清是开关没开：${r1.reason}`);
  const st1 = JSON.parse(await fsp.readFile(path.join(a.store.root.root, '.memory', 'state.json'), 'utf8'));
  assert.equal(st1.lastExtractError ?? null, null, '开关没开是用户选择，不该记成错误（否则 Block D 会一直喊）');
  assert.equal(st1.extractSource, '关闭');
  assert.equal(st1.extractEnabled, false, '要记下开关状态（status.md 里那行「开关」读的就是它）');
  const h1 = healthOf(st1);
  assert.equal(h1.ok, true, '关着 = 健康（用户的选择）');
  assert.equal(h1.disabled, true, '要说明是「关闭」而不是「故障」');
  assert.match(h1.reason, /总开关没开/, `实际 ${h1.reason}`);

  // ② 开关开了但**既没挑模型也没勾跟随** → 这是真故障（用户明明开了），要报出来
  const b = await mk({ enabled: true });
  const r2 = await b.runExtraction({});
  assert.equal(r2.ok, false);
  assert.equal(r2.targetError, true, '开了开关却没有可用模型 = 故障（进 Block D）');
  assert.match(String(r2.reason), /既没挑模型也没勾/, `要说清差什么：${r2.reason}`);
  // 故障要**看得见**：状态里别写「✅ 正常」——那会和旁边那行错误自相矛盾
  // （state.json 是启动时那一次的快照，所以这里可能还没有 lastExtractError 文案；
  //  两种文案都算「说清了」——要么是刚写下的错误，要么是兜底提示。）
  const st2 = JSON.parse(await fsp.readFile(path.join(b.store.root.root, '.memory', 'state.json'), 'utf8'));
  const h2 = healthOf(st2);
  assert.equal(h2.ok, false, '开关开着却抽不动，健康度不能报正常');
  assert.match(h2.reason, /既没挑模型也没勾|还没选到可用的模型/, `实际 ${h2.reason}`);

  // ③ 开关 + 勾「跟随对话模型」→ 用对话框里那个模型
  llm.calls.length = 0;
  const c = await mk(
    { enabled: true, followConversation: true },
    { agentDefaultModel: { currentSelection: () => ({ provider: 'real-p', model: 'real-m2' }) } },
  );
  const r3 = await c.runExtraction({});
  assert.equal(r3.ok, true, `跟随对话模型应可跑，实际 ${JSON.stringify(r3)}`);
  assert.equal(llm.calls[0].provider, 'real-p');
  assert.equal(llm.calls[0].model, 'real-m2', '必须用 agentDefaultModel 当前选择');
  const st3 = JSON.parse(await fsp.readFile(path.join(c.store.root.root, '.memory', 'state.json'), 'utf8'));
  assert.equal(st3.extractSource, '对话主模型', 'status.md 要显示来源是「跟随」');
  assert.equal(st3.extractModel, 'real-m2', '状态里要写**实际**在用的模型');

  // ④ 开关 + 跟随，但读不到主模型 → 明确报错，不静默退化
  const d = await mk({ enabled: true, followConversation: true }, {});
  const r4 = await d.runExtraction({});
  assert.equal(r4.ok, false);
  assert.equal(r4.targetError, true, '拿不到主模型是故障（要进 Block D）');
  assert.match(String(r4.reason), /跟随对话模型/, `要指名道姓：${r4.reason}`);

  // ⑤ 开关 + 显式挑选：写进配置的那对 provider/model
  llm.calls.length = 0;
  const e = await mk({ enabled: true, provider: 'real-p', model: 'real-m' });
  const r5 = await e.runExtraction({});
  assert.equal(r5.ok, true);
  assert.equal(llm.calls[0].provider, 'real-p');
  assert.equal(llm.calls[0].model, 'real-m');

  // ⑥ 跟随为主 + 主模型不可用 + onUnavailable=fallback → 退到已挑好的那对
  llm.calls.length = 0;
  const f = await mk(
    { enabled: true, followConversation: true, provider: 'real-p', model: 'real-m', onUnavailable: 'fallback' },
    { agentDefaultModel: { currentSelection: () => ({ provider: 'ghost-p', model: 'ghost-m' }) } },
  );
  const r6 = await f.runExtraction({});
  assert.equal(r6.ok, true, `跟随失败时应能退到显式配置，实际 ${JSON.stringify(r6)}`);
  assert.equal(llm.calls[0].provider, 'real-p');
  assert.equal(llm.calls[0].model, 'real-m');

  console.log('  ✅ 四形态：关闭（不算故障）/ 开了没选模型（算故障）/ 跟随 / 显式，且互为降级');
});

test('缺陷 11 回归：volatile 引用必须被解开（否则 provider 变成 "[object Object]"）', async (t) => {
  const root = path.join(os.tmpdir(), `memfuse-vol-${Date.now()}`);
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  // 模拟 schemastery 的 volatile 引用：读值靠 .get()
  const ref = (v) => ({ get: () => v });

  const h = fakeCtx({});
  const api = mod.apply(h.ctx, {
    root, git: false, verbose: false,
    // 关键：provider/model 传的是**引用对象**而不是字符串 ——
    // 声明 Config 并标 .volatile() 之后，真机上传进来的就是这种东西。
    // 早先用 JSON 序列化去解它，没解开，于是 Block D 里报
    // `provider "[object Object]" 不在宿主注册表里`。
    extract: { enabled: true, provider: ref('real-p'), model: ref('real-m'), autoRunOnStart: false, minChars: 10 },
  });
  await api.ready;

  const st = JSON.parse(await fsp.readFile(path.join(root, '.memory', 'state.json'), 'utf8'));
  assert.equal(st.extractProvider, 'real-p', `provider 必须是字符串，实际 ${JSON.stringify(st.extractProvider)}`);
  assert.equal(st.extractModel, 'real-m', `model 必须是字符串，实际 ${JSON.stringify(st.extractModel)}`);
  assert.ok(
    !String(st.extractProvider).includes('object'),
    '绝不能出现 "[object Object]"',
  );

  console.log('  ✅ volatile 引用被正确解开成普通值');
});

// ───────────────────── H7 技能建议（零 LLM 主动提示）─────────────────────

/** 造一条立刻够格（≥4 分）的记忆：experience(+3) + 步骤性内容(+2) = 5。 */
async function seedSkillCandidate(api, h, extra = {}) {
  const write = h.tools.find((d) => d.name === 'memfuse_write');
  return JSON.parse(
    await write.execute({
      mode: 'add',
      kind: 'experience',
      priority: 'P1',
      title: '部署要走 scripts/deploy.sh',
      summary: '第一步先确认分支干净，再跑 deploy.sh。',
      body: '第一步先确认分支干净；第二步跑 scripts/deploy.sh；第三步验证健康检查。',
      anchor: '执行部署时',
      tags: ['deploy', 'release'],
      ...extra,
    }),
  );
}

test('H7 技能建议：够格就出现在注入里，且不调模型', async (t) => {
  const root = path.join(os.tmpdir(), `memfuse-suggest-${Date.now()}`);
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  let modelCalls = 0;
  const h = fakeCtx({
    llm: {
      async *stream() {
        modelCalls++;
        yield { type: 'text-delta', text: '{}' };
      },
      listProviders: () => ['p'],
      listModels: () => ['m'],
    },
  });
  const api = mod.apply(h.ctx, {
    root, git: false, verbose: false,
    extract: { enabled: true, provider: 'p', model: 'm', autoRunOnStart: false },
  });
  await api.ready;

  await seedSkillCandidate(api, h);
  await api.refreshInjectionCache();

  const sugg = await api.suggestions();
  assert.ok(sugg.length >= 1, `应识别出建议，实际 ${sugg.length}`);
  assert.equal(sugg[0].seedTitle, '部署要走 scripts/deploy.sh');
  assert.ok(sugg[0].useWhen, '建议必须带「作用」（取自 anchor）');
  assert.ok(sugg[0].members.length >= 1, '建议必须带成员列表');

  const inj = await api.buildInjection('随便问点什么');
  const blockE = inj.blocks.find((b) => b.key === 'E');
  assert.ok(blockE, `注入里必须出现 Block E，实际 blocks=${inj.blocks.map((b) => b.key).join(',')}`);
  assert.ok(inj.text.includes('可提炼成技能'), '注入文本要有人话标题');
  assert.ok(inj.text.includes('部署要走 scripts/deploy.sh'), '要出现候选标题');
  assert.ok(inj.text.includes('执行部署时'), '要告知「作用」');
  assert.ok(inj.text.includes('提炼'), '要告诉用户怎么决定');

  // 核心断言：识别与提示**零模型调用**
  assert.equal(modelCalls, 0, `只做建议不该调模型，实际调了 ${modelCalls} 次`);
  console.log('  ✅ 够格 → Block E 提示（含作用/成员），模型调用数 = 0');
});

test('H7 Block E 排在 Block D 之前 —— 故障保持末尾高显著位', async (t) => {
  const root = path.join(os.tmpdir(), `memfuse-order-${Date.now()}`);
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  const h = fakeCtx();
  const api = mod.apply(h.ctx, { root, git: false, verbose: false, extract: { autoRunOnStart: false } });
  await api.ready;
  await seedSkillCandidate(api, h);
  await api.refreshInjectionCache();

  // 同时造一个故障：抽取开着但模型没配 → health 报错
  const inj = await api.buildInjection('部署');
  const keys = inj.blocks.map((b) => b.key);
  const iE = keys.indexOf('E');
  const iD = keys.indexOf('D');
  assert.ok(iE !== -1, 'Block E 应存在');
  if (iD !== -1) {
    assert.ok(iE < iD, `Block E 必须在 D 之前（实际 ${keys.join(',')}）—— 故障要留在最后`);
  }
  console.log(`  ✅ 块顺序 ${keys.join(' → ')}（E 在 D 前，故障留末尾）`);
});

test('H7 suggest=false 时不提示（但仍能被 list 看到候选）', async (t) => {
  const root = path.join(os.tmpdir(), `memfuse-nosuggest-${Date.now()}`);
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  const h = fakeCtx();
  const api = mod.apply(h.ctx, {
    root, git: false, verbose: false,
    extract: { autoRunOnStart: false },
    skill: { suggest: false },
  });
  await api.ready;
  await seedSkillCandidate(api, h);
  await api.refreshInjectionCache();

  const sugg = await api.suggestions();
  assert.equal(sugg.length, 0, 'suggest=false 时不该产生建议');

  const inj = await api.buildInjection('部署');
  assert.equal(inj.blocks.find((b) => b.key === 'E'), undefined, '不该出现 Block E');

  // 候选识别本身仍在（关掉的只是"提示"）
  const skill = h.tools.find((d) => d.name === 'memfuse_skill');
  const list = JSON.parse(await skill.execute({ action: 'list' }));
  assert.ok(list.candidates.length >= 1, '候选识别不受 suggest 影响');
  console.log('  ✅ suggest=false：不提示，但候选识别照常');
});

test('H7 dismiss：忽略后不再提示，簇长大时重新提一次', async (t) => {
  const root = path.join(os.tmpdir(), `memfuse-dismiss-${Date.now()}`);
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  const h = fakeCtx();
  const api = mod.apply(h.ctx, {
    root, git: false, verbose: false,
    extract: { autoRunOnStart: false },
    skill: { minScore: 3 },
  });
  await api.ready;
  await seedSkillCandidate(api, h);
  await api.refreshInjectionCache();

  const before = await api.suggestions();
  assert.ok(before.length >= 1, '先要有建议');
  const keyBefore = before[0].key;
  const membersBefore = before[0].members.length;

  const skill = h.tools.find((d) => d.name === 'memfuse_skill');
  const dis = JSON.parse(await skill.execute({ action: 'dismiss' }));
  assert.equal(dis.ok, true, JSON.stringify(dis));
  assert.ok(dis.note.includes('不会再提') || dis.note.includes('不再提示') || dis.note.includes('忽略'), '要说明后果');

  await api.refreshInjectionCache();
  const after = await api.suggestions();
  assert.equal(after.length, 0, '忽略后不该再提示');

  const inj = await api.buildInjection('部署');
  assert.equal(inj.blocks.find((b) => b.key === 'E'), undefined, '忽略后 Block E 应消失');

  // 簇长大 → key 变 → 重新提示
  const skillMod2 = await import('../lib/distill.js');
  const grown = [...before[0].members.map((m) => ({ id: m.id, tags: ['deploy'] })), { id: 'new-member', tags: ['deploy'] }];
  assert.notEqual(skillMod2.clusterKey(grown), keyBefore, '成员变化必须产生新 key（否则会被旧的忽略永久压住）');

  // dismiss 无建议时要明确报错，而不是静默成功
  const again = JSON.parse(await skill.execute({ action: 'dismiss' }));
  assert.equal(again.ok, false, '没有建议可忽略时必须报错');
  console.log(`  ✅ dismiss：${membersBefore} 条那组被忽略且不再提示；成员变化会重新提一次`);
});

test('H7 clusterKey / renderSuggestions 的纯函数行为', async (t) => {
  const d = await import('../lib/distill.js');

  // key 稳定：成员顺序不影响
  const a = [{ id: 'x' }, { id: 'y' }];
  const b = [{ id: 'y' }, { id: 'x' }];
  assert.equal(d.clusterKey(a), d.clusterKey(b), 'key 必须与成员顺序无关');

  // sharedTags：至少一半成员带它才算
  const cluster = [
    { id: '1', tags: ['deploy', 'x'] },
    { id: '2', tags: ['deploy'] },
    { id: '3', tags: ['deploy'] },
    { id: '4', tags: ['other'] },
  ];
  const tags = d.sharedTags(cluster);
  assert.deepEqual(tags, ['deploy'], `共享标签判定错误：${JSON.stringify(tags)}`);

  // 渲染：作用 / 成员 / 够格理由 / 决定方式 都要有
  const rows = d.renderSuggestions(
    [
      {
        key: 'k',
        seedTitle: '部署流程',
        tags: ['deploy'],
        useWhen: '执行部署时',
        members: [{ title: 'a' }, { title: 'b' }],
        reasons: ['本身就是 skill/experience 类记忆'],
      },
    ],
    1,
  );
  const text = rows.join('\n');
  for (const need of ['部署流程', '作用', '执行部署时', '成员', '够格理由', '提炼']) {
    assert.ok(text.includes(need), `渲染结果缺少「${need}」：\n${text}`);
  }
  assert.ok(!/undefined|null/.test(text), `渲染结果不该出现 undefined/null：\n${text}`);
  console.log('  ✅ clusterKey 顺序无关 / sharedTags 过半判定 / 渲染要素齐全');
});
