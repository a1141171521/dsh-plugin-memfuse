/**
 * client half 的离线装配测试。
 *
 * 为什么值得单独测：`lib/client.js` 是**浏览器半边**，跑不到 node:test 的常规路径里，
 * 而它恰恰是最容易"看起来正常其实没接上"的地方 —— 槽位 key 写错、hooks 名字对不上、
 * 写回路径不合法（嵌套 vs 顶层、布尔 vs 字符串），全都不会报错，只会"设置页里什么都没有"
 * 或"保存无效"（本项目第 4 条纪律：功能存在但从不生效也是失败）。
 *
 * 这里用最小的桩把浏览器环境骗出来：
 *   - `window.__ModuleLoader__.load` 抓住 bundle（就是真实加载器做的事）；
 *   - `require` 提供 react/jsx-runtime、primitives、client-store 的假实现；
 *   - 假 ctx 提供 slots / locale / configForms / remote，并记录注册与写入。
 * 断言的是**契约**，不是渲染结果：注册到哪个槽、key 是什么、写回 op 长什么样。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const CLIENT = path.resolve(import.meta.dirname, '..', 'lib', 'client.js');

/** 极简 snapshot store（与 @deepseek-ai/dsh-client-store 的用法一致）。 */
function makeStore(initial) {
  let value = initial;
  const listeners = new Set();
  return {
    getSnapshot: () => value,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next) {
      value = next;
      for (const listener of listeners) listener();
    },
  };
}

/** 宿主返回的模型目录形状（`buildModelCatalog()` 的产物）。 */
const CATALOG = {
  ok: true,
  value: {
    default: { provider: 'zjpaiguo', model: 'deepseek-flash' },
    routableProviders: ['zjpaiguo', 'deepseek-account'],
    groups: [
      {
        id: 'zjpaiguo',
        name: '自用国产',
        models: [
          { id: 'deepseek-flash', name: 'deepseek-flash' },
          { id: 'glm-5.3-flash', name: 'glm-5.3-flash' },
        ],
      },
      { id: 'deepseek-account', name: '官方账号', models: [{ id: 'deepseek-flash', name: 'deepseek-flash' }] },
    ],
    failures: [],
  },
};

/** 把 ops 落到一份 JSON 上（模拟宿主接受写入后的新快照）。 */
function applyOps(root, ops) {
  const next = structuredClone(root ?? {});
  for (const op of ops) {
    let node = next;
    for (const key of op.path.slice(0, -1)) {
      if (node[key] === null || typeof node[key] !== 'object') node[key] = {};
      node = node[key];
    }
    const last = op.path[op.path.length - 1];
    if (op.op === 'set') node[last] = op.value;
    else delete node[last];
  }
  return next;
}

/** 把 ops 落到「用户层」上（`overriddenAt()` 读的就是它）。 */
function applyUserOps(root, ops) {
  const next = structuredClone(root ?? {});
  for (const op of ops) {
    let node = next;
    for (const key of op.path.slice(0, -1)) {
      if (node[key] === null || typeof node[key] !== 'object') node[key] = {};
      node = node[key];
    }
    const last = op.path[op.path.length - 1];
    if (op.op === 'set') node[last] = op.value;
    else delete node[last];
  }
  return next;
}

/** 把 client.js 在桩环境里加载出来，返回它的 exports 与 ctx 上的记录。 */
async function loadClientHalf({
  status = 'ready',
  writable = true,
  value,
  user,
  revision = 7,
  catalog = CATALOG,
} = {}) {
  const registrations = [];
  const injected = [];
  const writes = [];
  let bundle = null;
  // ⚠️ 快照必须**跟着写入走**：宿主接受一次 mutate 之后，镜子里的值就变了。
  // 早先这里是静态的，于是"保存后再清除"那一步算不出任何 op —— 测试抓出来了。
  let current = structuredClone(value ?? {});
  let currentUser = structuredClone(user ?? {});
  let currentRevision = revision;

  const jsx = (type, props, key) => ({ type, props, key });
  const jsxs = (type, props, key) => ({ type, props, key });
  const primitives = {
    SettingsForm: 'SettingsForm',
    SettingsValueField: 'SettingsValueField',
    SegmentedControl: 'SegmentedControl',
    Checkbox: 'Checkbox',
  };

  const scope = {
    // ⚠️ 故意**不给** scope.ctx：远程调用必须用插件自己的 ctx。
    // 早先图省事用了 `scope.ctx`（那是 ui-settings 的 fiber，inject 里没有 remote.session），
    // 真机上模型列表就一直读不出来。留着 undefined，回归时会立刻炸。
    ctx: undefined,
    getSnapshot: () => ({
      status,
      writable,
      revision: currentRevision,
      value: current,
      base: current,
      user: currentUser,
    }),
    subscribe: () => () => {},
    mutate: async (ops, expected) => {
      writes.push({ ops, expected });
      current = applyOps(current, ops);
      currentUser = applyUserOps(currentUser, ops);
      currentRevision += 1;
      return true;
    },
  };

  const ctx = {
    locale: {
      bind: () => (key) => `t:${key}`,
      register: (ns, dicts) => injected.push({ kind: 'locale', ns, dicts }),
    },
    effect: (fn) => {
      const disposer = fn();
      return typeof disposer === 'function' ? disposer : () => {};
    },
    slots: {
      inject: (name, cb) => {
        injected.push({ kind: 'inject', name });
        return cb();
      },
      register: (options, Component) => {
        registrations.push({ options, Component });
        return () => {};
      },
    },
    configForms: {
      get: (ns) => {
        injected.push({ kind: 'configForms.get', ns });
        return scope;
      },
      whileServed: (namespaces, register) => {
        injected.push({ kind: 'whileServed', namespaces });
        return register(new Set(namespaces));
      },
    },
    remote: {
      $on: (event) => {
        injected.push({ kind: 'remote.$on', event });
        return () => {};
      },
      session: {
        modelCatalog: async () => {
          injected.push({ kind: 'modelCatalog' });
          return catalog;
        },
      },
    },
  };
  // 注意：这里**不**把 ctx 挂到 scope 上（见 scope 定义处的注释）。

  globalThis.window = {
    __ModuleLoader__: {
      load(spec) {
        bundle = spec;
      },
    },
  };
  const require = (name) => {
    if (name === 'react/jsx-runtime') return { jsx, jsxs };
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
    if (name === '@deepseek-ai/dsh-client-store') return { createSnapshotStore: makeStore };
    throw new Error(`unexpected require("${name}")`);
  };

  await import(`${pathToFileURL(CLIENT).href}?t=${Math.random()}`);
  assert.ok(bundle, 'client.js 必须调用 window.__ModuleLoader__.load');
  const exports = bundle.factory(require);
  return { bundle, exports, ctx, registrations, injected, writes, scope };
}

/** 挂上配置卡，并把「插件」页会传的 props 拼出来。 */
async function mount(opts) {
  const h = await loadClientHalf(opts);
  const { exports, ctx, registrations } = h;
  exports.apply(ctx);
  // 两处入口注册的是**同一个卡片**，随便取哪个都行；这里固定取行级那个。
  const { options, Component } =
    registrations.find((row) => row.options.name === 'plugins.row.config') ?? registrations[0];
  const face = options.inject();
  const props = {
    t: (key) => `t:${key}`,
    view: 'page',
    ...face,
    useMemfuseConfig: (selector) => selector(face.hooks.memfuseConfig.getSnapshot()),
  };
  return { ...h, face, Component, props };
}

test('client half：bundle id 与包名一致，并声明必需服务', async () => {
  const { bundle, exports } = await loadClientHalf();
  assert.equal(bundle.id, 'dsh-memfuse', 'bundle id 必须等于包名（加载器按包名认领）');
  assert.deepEqual(exports.inject, ['slots', 'locale', 'configForms', 'remote', 'remote.session']);
  console.log('  ✅ bundle id = 包名；inject 含 configForms 与 remote.session');
});

test('client half：两处入口都注册好（包页直接显示 + 行标题可点）', async () => {
  const { exports, ctx, registrations } = await loadClientHalf();
  exports.apply(ctx);

  assert.equal(registrations.length, 2, `应注册两处入口（包页 + 行），实际 ${registrations.length}`);

  const bundle = registrations.find((r) => r.options.name === 'plugins.bundle.config');
  const row = registrations.find((r) => r.options.name === 'plugins.row.config');
  assert.ok(bundle, '必须注册 plugins.bundle.config —— 包页上直接渲染表单，用户不用点任何东西');
  assert.equal(bundle.options.key, 'dsh-memfuse', 'bundle 槽的 key = **包名**');
  assert.ok(row, '必须注册 plugins.row.config —— 行标题才会变成可点入口');
  assert.equal(row.options.key, 'dsh-memfuse#dsh-memfuse', 'key 必须是 <包名>#<cordis.patch.yml 里的 row id>');

  for (const reg of [bundle, row]) {
    assert.equal(typeof reg.options.inject, 'function', 'slot entry 要给 inject（hooks + 动作）');
    assert.equal(typeof reg.Component, 'function', '必须给一个组件');
    assert.equal(reg.options.locale, 'settings.memfuse');
  }
  console.log('  ✅ 注册 plugins.bundle.config(dsh-memfuse) + plugins.row.config(dsh-memfuse#dsh-memfuse)');
});

test('client half：模型列表来自宿主目录，按 provider 分组', async () => {
  const { face, injected } = await mount({ value: {} });

  assert.ok(
    injected.some((row) => row.kind === 'modelCatalog'),
    '必须去读 remote.session.modelCatalog（与对话框里那个选择器同源）',
  );
  const snapshot = face.hooks.memfuseConfig.getSnapshot();
  assert.equal(snapshot.catalog.status, 'ready');
  assert.deepEqual(
    snapshot.catalog.groups.map((group) => [group.id, group.models.length]),
    [
      ['zjpaiguo', 2],
      ['deepseek-account', 1],
    ],
    '目录要按 provider 分组、模型数正确',
  );
  console.log('  ✅ 模型目录从宿主读入并按 provider 分组');
});

test('client half：summary 给一行说明，page 渲染得出来', async () => {
  const { Component, props, face } = await mount({
    value: { extract: { provider: 'zjpaiguo', model: 'deepseek-flash' } },
    user: { extract: { provider: 'zjpaiguo' } },
  });

  const summary = Component({ ...props, view: 'summary' });
  assert.equal(typeof summary, 'string', `summary 视图应返回一行文本，实际 ${typeof summary}`);

  const page = Component(props);
  assert.ok(page, 'page 视图必须渲染出东西');

  // 投影里每个字段都在（下拉、勾选、分段控件各自读自己的那份）
  const snapshot = face.hooks.memfuseConfig.getSnapshot();
  assert.deepEqual(
    Object.keys(snapshot.fields),
    ['enabled', 'follow', 'model', 'onUnavailable', 'fallback', 'mode'],
    '字段顺序 = 页面顺序：总开关 → 跟随 → 模型 → 不可用时 → 降级 → 落盘方式',
  );
  assert.equal(snapshot.fields.model.value, 'zjpaiguo\u0000deepseek-flash', '选择器要显示当前 provider#model');
  assert.equal(snapshot.fields.follow.checked, false, '默认不勾选「跟随对话模型」');
  assert.equal(snapshot.fields.mode.text, '', '没配过就是空（回落默认值）');
  console.log('  ✅ summary/page 都渲染；字段投影齐全（默认不勾跟随、默认不选模型）');
});

test('client half：选模型 = 一次写 provider + model 两个 op（嵌套路径）', async () => {
  const { face, writes } = await mount({ value: { extract: { mode: 'suggest' } } });

  face.pickModel('model', 'zjpaiguo', 'glm-5.3-flash');
  await face.save();

  assert.equal(writes.length, 1, '一次保存只发一次 mutate');
  assert.deepEqual(
    writes[0].ops,
    [
      { op: 'set', path: ['extract', 'provider'], value: 'zjpaiguo' },
      { op: 'set', path: ['extract', 'model'], value: 'glm-5.3-flash' },
    ],
    'provider 与 model 必须一起写，且是嵌套路径',
  );

  // 清空 = 两个都 unset（回落默认）
  writes.length = 0;
  face.clearModel('model');
  await face.save();
  assert.deepEqual(
    writes[0].ops.map((op) => [op.op, op.path.join('.')]).sort(),
    [
      ['unset', 'extract.model'],
      ['unset', 'extract.provider'],
    ],
  );

  console.log('  ✅ 选模型写两个嵌套 op；清除写两个 unset');
});

test('client half：开关与勾选写的都是**布尔真值**，不是字符串', async () => {
  const { face, writes } = await mount({ value: {} });

  // 总开关（用户要的那个「按钮」）
  face.toggleFollow(['extract', 'enabled'], true);
  await face.save();
  assert.deepEqual(
    writes[0].ops,
    [{ op: 'set', path: ['extract', 'enabled'], value: true }],
    '开关必须给 true —— 给字符串 "true" 会被 schema 拒掉',
  );

  // 跟随对话模型
  writes.length = 0;
  face.toggleFollow(['extract', 'followConversation'], true);
  await face.save();
  assert.deepEqual(writes[0].ops, [{ op: 'set', path: ['extract', 'followConversation'], value: true }]);

  writes.length = 0;
  face.toggleFollow(['extract', 'followConversation'], false);
  await face.save();
  assert.equal(writes[0].ops[0].value, false, '取消勾选要给 false');
  console.log('  ✅ 开关 / 跟随都写布尔真值（true / false）');
});

test('client half：模型目录读不到时表单仍然可用，且给出提示', async () => {
  const { face } = await mount({ value: {}, catalog: { ok: false, error: { message: 'boom' } } });
  const snapshot = face.hooks.memfuseConfig.getSnapshot();
  assert.equal(snapshot.catalog.status, 'error', '读不到目录要标 error');
  assert.match(snapshot.catalog.error, /boom/);
  assert.equal(snapshot.available, true, '目录失败不该让整张表单变成不可用');
  console.log('  ✅ 目录失败不拖垮表单（有提示、仍可保存其它字段）');
});

test('client half：没有改动就不写盘（dirty 由 ops 决定）', async () => {
  const { face, writes } = await mount({
    value: { extract: { provider: 'zjpaiguo', model: 'deepseek-flash' } },
  });

  await face.save();
  assert.equal(writes.length, 0, '没有任何草稿时不应写盘');

  face.pickModel('model', 'zjpaiguo', 'deepseek-flash'); // 与现值相同
  await face.save();
  assert.equal(writes.length, 0, '草稿与现值相同时也不该写盘');
  console.log('  ✅ 无改动不写盘');
});

test('client half：保存按钮的灰/亮要能被解释（dirty → saved → clean）', async () => {
  const { face, writes, props } = await mount({ value: {} });
  const snapshot = () => face.hooks.memfuseConfig.getSnapshot();

  // ① 干净：官方表单据此把「保存」置灰 —— 状态行必须说明"没有未保存的改动"
  assert.equal(snapshot().dirty, false);
  assert.equal(snapshot().saved, false);
  assert.equal(props.t('clean'), 't:clean', '文案走字典（这里替身直接回 key）');

  // ② 改一下 → dirty（保存按钮变亮）
  face.toggleFollow(['extract', 'enabled'], true);
  assert.equal(snapshot().dirty, true, '有草稿就该 dirty');
  assert.equal(snapshot().saved, false, '还没保存，不能显示"已保存"');

  // ③ 保存成功 → 回到干净，而且标记 saved（显示「已保存 ✓」而不是「没有改动」）
  await face.save();
  assert.equal(writes.length, 1);
  assert.equal(snapshot().dirty, false);
  assert.equal(snapshot().saved, true, '保存成功后要有明确反馈');

  // ④ 再改一次 → saved 归位，避免"改了却还写着已保存"
  face.toggleFollow(['extract', 'enabled'], false);
  assert.equal(snapshot().saved, false, '一旦有新改动，"已保存"必须撤掉');
  assert.equal(snapshot().dirty, true);
  console.log('  ✅ dirty / saved 状态齐了（灰按钮有解释、保存后有反馈）');
});
