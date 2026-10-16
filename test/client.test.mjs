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
 *   - 假 ctx 提供 slots / locale / configForms / remote / inject，并记录注册与写入。
 * 断言的是**契约**，不是渲染结果：注册到哪个槽、key 是什么、写回 op 长什么样；
 * 有一件事例外 —— 字典是真字典、`t` 是真的插值实现，因为"文案写成函数"这类错
 * 正好是渲染期才炸（见 makeTranslator）。
 *
 * ⚠️ 这个文件**不经 `node --test` 跑**（`npm test` 里是 `node test/client.test.mjs`）：
 * Node 22.22 的 `node --test` 在跑它时会偶发子进程协议崩坏 —— 父进程报
 * `Unable to deserialize cloned data due to invalid or unsupported version.`，
 * 而**所有用例其实都是过的**（本机实测：单独跑 15/15 全绿，跑整包大约一半概率红）。
 * 直接用 node 跑这个文件同样是 `node:test` 的 runner（TAP 输出、失败退出码非 0），
 * 只是没有"再来一个子进程"这一层。等上游修了可以再换回去。
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

/**
 * 官方 locale 的**行为复刻**（`dsh-client-locale/lib/client.js` 的 `translate`）。
 *
 * 关键在于它不是一个宽容的替身：模板必须是字符串，`{name}` 插值，
 * 而传进来一个**函数**会在 `template.replace` 上当场炸。
 * 真机就是这么炸的 —— 字典里写成 `suggestMeta: ({members}) => …`，
 * 卡片每次渲染都抛 `template.replace is not a function`，
 * 表现是"卡片永远不出现、零报错"。替身一宽容，这条回归就永远抓不到。
 */
function makeTranslator(dicts) {
  return (ns, key, params) => {
    const template = dicts.get(ns)?.zh?.[key] ?? key;
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
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
  suggestions = null,
  /** 覆盖 `list` 的实现（用来模拟宿主报错）。 */
  listImpl = null,
  /** 覆盖 `distill` 的实现（缺陷 25：提炼成技能那条路）。 */
  distillImpl = null,
  /** 宿主是否接受写入（false = 模拟"非 volatile 字段被拒"）。 */
  mutateOk = true,
} = {}) {
  const registrations = [];
  const injected = [];
  const writes = [];
  const mounted = []; // 客户端 Remote 贡献
  const remoteCalls = []; // 打到 ctx.remote.memfuse.* 的调用
  const dicts = new Map(); // 字典（locale.register 写进来，t 从这里读）
  const translate = makeTranslator(dicts);
  let bundle = null;
  // ⚠️ 快照必须**跟着写入走**：宿主接受一次 mutate 之后，镜子里的值就变了。
  // 早先这里是静态的，于是"保存后再清除"那一步算不出任何 op —— 测试抓出来了。
  const suggestionsPayload = suggestions ?? {
    groups: [
      { key: 'k1', seedTitle: '部署要走 scripts/deploy.sh', members: 3, score: 7, seen: false, useWhen: '部署时' },
      { key: 'k2', seedTitle: '已经看过的簇', members: 2, score: 5, seen: true, useWhen: null },
    ],
    // 宿主按 `skill.suggestMax`（默认 1）只给前几组，其余的用 restKeys 交回来
    restCount: 2,
    restKeys: ['k8', 'k9'],
    seen: 1,
    dismissed: 0,
    pendingDistill: [],
    // 待确认的技能草稿（真宿主从 `pending-skills/` 读出来）
    pendingSkills: [],
  };
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
      if (!mutateOk) return false; // 宿主拒写（如"非 volatile 字段"）——整批不落地
      current = applyOps(current, ops);
      currentUser = applyUserOps(currentUser, ops);
      currentRevision += 1;
      return true;
    },
  };

  /** 宿主 Remote 命名空间的方法（形状与真宿主一致：`{ok:true,value}` / `{ok:false,error}`）。 */
  const memfuseApi = {
    list: async () => {
      remoteCalls.push(['list']);
      if (listImpl !== null) return listImpl();
      return { ok: true, value: suggestionsPayload };
    },
    markSeen: async (keys) => {
      remoteCalls.push(['markSeen', keys]);
      return { ok: true, value: { ok: true } };
    },
    dismiss: async (key) => {
      remoteCalls.push(['dismiss', key]);
      return { ok: true, value: { ok: true } };
    },
    requestDistill: async (key) => {
      remoteCalls.push(['requestDistill', key]);
      return { ok: true, value: { ok: true } };
    },
    // ── 缺陷 25：界面上真的把技能提炼出来 + 装 / 丢 ──
    distill: async (key) => {
      remoteCalls.push(['distill', key]);
      if (distillImpl !== null) return distillImpl(key);
      return {
        ok: true,
        value: {
          ok: true,
          name: 'ui-skill',
          description: '界面点「提炼成技能」时用',
          content: '---\nname: ui-skill\ndescription: "界面点「提炼成技能」时用"\n---\n\n## 步骤\n1. 先确认\n',
          installPath: 'C:\\Users\\YOU\\.dsh\\skills\\ui-skill\\SKILL.md',
        },
      };
    },
    approve: async (name) => {
      remoteCalls.push(['approve', name]);
      return { ok: true, value: { ok: true, name, markedSources: 1, visibleInHost: true } };
    },
    reject: async (name) => {
      remoteCalls.push(['reject', name]);
      return { ok: true, value: { ok: true, name } };
    },
  };

  /**
   * `ctx.remote` 的替身 —— **故意复刻 cordis 的 inject 校验**。
   *
   * 真机上访问没注入过的点号服务（`remote.memfuse`）会抛
   * `cannot get property "remote.memfuse" without inject`（本机实测，见
   * `.probe/cordis-inject-probe.mjs`）。替身如果不抛，那"卡片的数据源拿了
   * 没注入的 ctx"这种**静默**失败就永远测不出来 —— 而它真的发生过。
   */
  const makeRemote = (allowed) => {
    const target = {
      $on: (event) => {
        injected.push({ kind: 'remote.$on', event });
        return () => {};
      },
      /**
       * 客户端贡献挂载。真实实现：`mountContribution` → `callerCtx.typert.remotes.register`。
       *
       * ⚠️ 这里**故意用 `this`**（不是闭包里的 allowed）：真机上 `$mount` 读的是
       * `this.ctx` —— 也就是"谁在调它"。所以"从根 ctx 拿下函数、再 .call 到别的 ctx"
       * 这种行为必须在这里也失效，否则缺陷 18 的回归测不出来。
       */
      async $mount(contribution) {
        if (this.allowed?.has('typert') !== true) {
          throw new Error('cannot get property "typert" without inject');
        }
        mounted.push(contribution);
        return () => {};
      },
      session: {
        modelCatalog: async () => {
          injected.push({ kind: 'modelCatalog' });
          return catalog;
        },
      },
      allowed,
    };
    // 命名空间服务（`remote.memfuse`）只有声明过才拿得到；没声明就照真机抛
    return new Proxy(target, {
      get(t, prop, receiver) {
        if (typeof prop === 'string' && !(prop in t)) {
          if (!allowed.has(`remote.${prop}`)) {
            throw new Error(`cannot get property "remote.${prop}" without inject`);
          }
          return memfuseApi;
        }
        return Reflect.get(t, prop, receiver);
      },
    });
  };

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

  /** 根 ctx 允许哪些点号命名空间 —— 就是插件自己声明的 inject。 */
  const rootAllowed = new Set(exports.inject.filter((name) => name.startsWith('remote.')));

  const ctx = {
    locale: {
      bind: (ns) => (key, params) => translate(ns, key, params),
      register: (ns, value) => {
        dicts.set(ns, value);
        injected.push({ kind: 'locale', ns });
        return () => {};
      },
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
    remote: makeRemote(rootAllowed),
    /**
     * 运行时注入（cordis 的 `ctx.inject(deps, cb)`）：返回 thenable + `dispose()`。
     * 子 ctx 声明了 deps 里的点号服务，于是拿得到 `remote.memfuse`。
     */
    inject: (deps, cb) => {
      injected.push({ kind: 'inject', deps: [...deps] });
      // 子 ctx 声明什么就允许访问什么（点号服务与 typert 一视同仁）
      const allowed = new Set([...rootAllowed, ...deps]);
      const child = { ...ctx, remote: makeRemote(allowed) };
      const result = cb(child);
      return {
        then: (onFulfilled, onRejected) => Promise.resolve(result).then(onFulfilled, onRejected),
        dispose: async () => {},
      };
    },
  };

  return {
    bundle,
    exports,
    ctx,
    registrations,
    injected,
    writes,
    scope,
    mounted,
    remoteCalls,
    /** 真字典 + 真插值（不是 `t:key` 那种占位，见 makeTranslator 的注释）。 */
    t: (key, params) => translate('settings.memfuse', key, params),
  };
}

/**
 * 把插件的异步装配跑干净（`$mount` → `ctx.inject` → 拉候选都在微任务里，但
 * 要跨几次事件循环才全部落定）。
 *
 * ⚠️ 两件实测出来的事，都踩过：
 *   1. **必须用 `setImmediate`，不要用 `setTimeout`** —— Node 22.22 的
 *      `node --test` 子进程里，await 一个 setTimeout 会让子进程写出一帧
 *      反序列化不了的消息，父进程只报一句 `Unable to deserialize cloned data
 *      due to invalid or unsupported version.`，而**测试自己全是过的**；
 *   2. **要等够几轮** —— 只等一轮时偶发（跑整包时大约一半概率）同一个错，
 *      因为装配链还没跑完就进了下一个用例。
 */
const settle = async (turns = 5) => {
  for (let i = 0; i < turns; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

/** 在 jsx 假树里找一个按钮（按文案认，递归）。 */
function findButton(node, label) {
  if (node === null || typeof node !== 'object') return null;
  if (node.type === 'button' && node.props?.children === label) return node;
  const kids = node.props?.children;
  for (const kid of Array.isArray(kids) ? kids : kids === undefined ? [] : [kids]) {
    const hit = findButton(kid, label);
    if (hit !== null) return hit;
  }
  return null;
}

/** 选出候选卡片那条注册，并把 slot 系统会传的 props 拼出来。 */
function cardProps(handle) {
  const reg = handle.registrations.find((row) => row.options.name === 'conversation.chat.turnTail');
  assert.ok(reg, '候选卡片必须注册（否则回合尾部什么都没有）');
  const face = reg.options.inject();
  return {
    reg,
    face,
    props: {
      t: handle.t,
      ...face,
      useMemfuseSuggestions: (selector) => selector(face.hooks.memfuseSuggestions.getSnapshot()),
    },
  };
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
    // 真字典（中文那套）+ 真插值 —— 与官方 locale 的行为一致，见 makeTranslator
    t: h.t,
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

test('client half：三处入口都注册好（包页表单 + 行标题可点 + 回合尾候选卡）', async () => {
  const h = await loadClientHalf();
  h.exports.apply(h.ctx);
  // 候选卡要等 `$mount` 落地之后才注册（它依赖 remote.memfuse 命名空间）
  await settle();
  const { registrations } = h;

  assert.equal(registrations.length, 3, `应注册三处（包页 + 行 + 候选卡），实际 ${registrations.length}`);

  const bundle = registrations.find((r) => r.options.name === 'plugins.bundle.config');
  const row = registrations.find((r) => r.options.name === 'plugins.row.config');
  const card = registrations.find((r) => r.options.name === 'conversation.chat.turnTail');
  assert.ok(bundle, '必须注册 plugins.bundle.config —— 包页上直接渲染表单，用户不用点任何东西');
  assert.equal(bundle.options.key, 'dsh-memfuse', 'bundle 槽的 key = **包名**');
  assert.ok(row, '必须注册 plugins.row.config —— 行标题才会变成可点入口');
  assert.equal(row.options.key, 'dsh-memfuse#dsh-memfuse', 'key 必须是 <包名>#<cordis.patch.yml 里的 row id>');
  assert.ok(card, '必须注册 conversation.chat.turnTail —— 候选要出现在界面里，而不是只写在 prompt 里');
  assert.equal(card.options.id, 'dsh-memfuse#suggestions', 'list 槽按 id 占位（别复用官方 id，会顶掉人家的格子）');
  assert.equal(card.options.order, 10);

  for (const reg of [bundle, row]) {
    assert.equal(typeof reg.options.inject, 'function', 'slot entry 要给 inject（hooks + 动作）');
    assert.equal(typeof reg.Component, 'function', '必须给一个组件');
    assert.equal(reg.options.locale, 'settings.memfuse');
  }
  assert.equal(typeof card.options.inject, 'function', '候选卡也要 inject（数据源 + 两个动作）');
  assert.equal(typeof card.Component, 'function');
  console.log('  ✅ 注册 plugins.bundle.config + plugins.row.config + conversation.chat.turnTail');
});

test('client half：客户端描述符与宿主**逐字段一致**（防两侧漂移）', async () => {
  const host = await import('../lib/remote.js');
  const { exports } = await loadClientHalf();

  // codec 的 create 是闭包（每次都是新函数），比数据与形状即可
  const shapeOf = (list) =>
    list.map((d) => ({
      ...d,
      result: { ...d.result, create: typeof d.result.create },
      parameters: d.parameters.map((p) => ({ ...p, codec: { ...p.codec, create: typeof p.codec.create } })),
    }));

  assert.deepEqual(
    shapeOf(exports.remoteDescriptors()),
    shapeOf(host.remoteDescriptors()),
    '两侧描述符必须一致：宿主那份决定"谁来执行"，客户端那份决定"界面能调什么"',
  );
  assert.equal(exports.remoteContribution().face, 'client', '客户端贡献的 face 必须是 client');
  console.log('  ✅ 客户端/宿主描述符一致（4 个方法）');
});

test('client half：卡片数据源必须走**注入过 remote.memfuse 的子 ctx**（真机在这里静默失败过）', async () => {
  const h = await loadClientHalf();

  // ① 根 ctx 上访问没注入过的点号服务必须被拒 —— 替身照抄了 cordis 的真实行为，
  //    否则下面这条回归永远测不出来（真机症状：卡片注册了、却永远不出现、零报错）。
  //    ⚠️ 用 try/catch 而不是 assert.throws：后者会把代理对象塞进 AssertionError，
  //    在 `node --test` 的子进程协议里序列化不了（真机上表现为一句莫名其妙的
  //    "Unable to deserialize cloned data"，比测试失败还难查）。
  let rootAccessError = null;
  try {
    void h.ctx.remote.memfuse;
  } catch (error) {
    rootAccessError = error;
  }
  assert.match(
    String(rootAccessError && rootAccessError.message),
    /cannot get property "remote\.memfuse" without inject/,
    '根 ctx（inject 里只有 remote / remote.session）不该拿到 remote.memfuse',
  );

  h.exports.apply(h.ctx);
  await settle();

  const injectedRow = h.injected.find(
    (row) => row.kind === 'inject' && Array.isArray(row.deps) && row.deps.includes('remote.memfuse'),
  );
  assert.ok(injectedRow, '必须用 ctx.inject([...], cb) 去取带命名空间的子 ctx');
  assert.ok(
    injectedRow.deps.includes('remote.memfuse'),
    `子 ctx 必须声明 remote.memfuse，实际声明了 ${injectedRow.deps.join(', ')}`,
  );

  assert.equal(h.mounted.length, 1, '必须把自己那份贡献挂到 Remote 上（否则 remote.memfuse 不存在）');
  assert.equal(h.mounted[0].package, 'dsh-memfuse');
  assert.equal(h.mounted[0].face, 'client');
  // 七个端点：读候选 / 表态 四个 + 缺陷 25 的 distill·approve·reject 三个
  assert.equal(h.mounted[0].descriptors.length, 7);
  assert.ok(
    h.remoteCalls.some((call) => call[0] === 'list'),
    '挂上之后要真的拉一次候选 —— 不拉的话卡片永远是空的',
  );
  console.log('  ✅ $mount → ctx.inject(["remote.memfuse", …]) → 拉候选（顺序与注入都对）');
});

test('client half：挂载贡献必须先声明 typert（真机上的"通道挂不上"，缺陷 18）', async () => {
  const h = await loadClientHalf();
  h.exports.apply(h.ctx);
  await settle();

  const mountRow = h.injected.find((row) => row.kind === 'inject' && Array.isArray(row.deps) && row.deps.includes('typert'));
  assert.ok(
    mountRow,
    `挂载前必须 ctx.inject(['typert', 'remote']) —— $mount 内部要 callerCtx.typert.remotes.register()，` +
      `实际声明过：${h.injected.filter((r) => r.deps).map((r) => `[${r.deps.join(',')}]`).join(' ')}`,
  );
  assert.equal(h.mounted.length, 1, '声明了 typert 之后，贡献必须真的挂上（否则卡片永远不出现）');
  assert.ok(h.remoteCalls.some((call) => call[0] === 'list'), '挂上后要真的拉一次候选');

  // 替身自己也得守规矩：没声明 typert 的 ctx 直接挂一定抛 —— 这才是真机上的现象
  const bare = await loadClientHalf();
  await assert.rejects(
    () => bare.ctx.remote.$mount({ package: 'dsh-memfuse', face: 'client', descriptors: [] }),
    /cannot get property "typert" without inject/,
    '替身必须复刻这个拒绝，否则缺陷 18 这类回归测不出来',
  );
  console.log('  ✅ 贡献挂载走 ctx.inject(["typert", …])，且确实挂上了');
});

test('client half：配置页写的每个路径都必须是 volatile（缺陷 17：一按保存就失败）', async () => {
  const { Config } = await import('../lib/config.js');
  const { exports } = await loadClientHalf();

  const at = (root, path) => path.reduce((node, key) => node?.dict?.[key], root);
  const notVolatile = exports.WRITABLE_PATHS.filter((path) => at(Config, path)?.meta?.volatile !== true);

  assert.deepEqual(
    notVolatile,
    [],
    `这些路径在 UI 上可写、但 schema 里没标 .volatile() —— 宿主会整批拒写，` +
      `用户只看到「保存失败」（dsh-settings/lib/index.js:629）。缺标的是：${JSON.stringify(notVolatile)}`,
  );
  assert.ok(exports.WRITABLE_PATHS.length >= 8, '可写路径清单不能是空的');
  console.log(`  ✅ ${exports.WRITABLE_PATHS.length} 个可写路径全部是 volatile`);
});

test('client half：保存被拒时要说得出"改了哪些路径"', async () => {
  const h = await mount({ value: {}, mutateOk: false });
  h.face.toggleFollow(['extract', 'enabled'], true);
  await h.face.save();

  const snapshot = h.face.hooks.memfuseConfig.getSnapshot();
  assert.equal(snapshot.failed, true, '宿主拒写要标 failed');
  assert.match(String(snapshot.saveError), /extract\.enabled/, '失败提示里必须带上改动的路径');
  const page = h.Component(h.props);
  assert.match(JSON.stringify(page), /extract\.enabled/, '这行要渲染到界面上（否则用户只有一句"保存失败"）');
  console.log('  ✅ 保存被拒 → 界面上写明改动的路径');
});

test('client half：只长在**最后一个回合**的尾巴上（否则每个回合都来一张）', async () => {
  const h = await loadClientHalf();
  h.exports.apply(h.ctx);
  await settle();
  const { reg, props } = cardProps(h);

  const withTurn = (turn, order) => ({
    ...props,
    turn,
    // 官方 owner 给 slot entry 的标准 prop：`useChat(selector)`
    useChat: (selector) => selector({ timeline: { turnOrder: order } }),
  });

  assert.equal(reg.Component(withTurn(2, [1, 2, 3])), null, '不是最后一个回合 → 什么都不渲染');
  assert.ok(reg.Component(withTurn(3, [1, 2, 3])), '最后一个回合 → 出卡片');

  // 拿不到回合序（别的部署 / 老宿主）时按"是"处理，别把功能藏起来。
  // ⚠️ 换一个 handle 再验：候选是**领一次就没了**的（`feed.claim()` 的语义），
  //    同一个 handle 上第二张卡领不到东西 —— 那测的就不是这道门了。
  const h2 = await loadClientHalf();
  h2.exports.apply(h2.ctx);
  await settle();
  const second = cardProps(h2);
  assert.ok(
    second.reg.Component({
      ...second.props,
      turn: 1,
      useChat: (selector) => selector({ timeline: { turnOrder: [] } }),
    }),
    '拿不到 turnOrder → 仍然渲染',
  );

  // ⚠️ **真机的形状**：`props.turn` 是**对象**（`node.location.turn` = `{turn: <id>, status}`，
  //    见 `dsh-client-ui-chat` 的 `TurnTailNodeView` L6577），而 `turnOrder` 里放的是 **id**。
  //    早先这里直接 `String(props.turn)` 比 → `"[object Object]" !== "9"` → 恒 false
  //    → 卡片**永远不出现**（缺陷 24，真机上整整一天没画出来过，而 markSeen 照写不误）。
  const h3 = await loadClientHalf();
  h3.exports.apply(h3.ctx);
  await settle();
  const third = cardProps(h3);
  const location = (id) => ({ turn: id, status: 'closed' }); // TurnLocation 的形状
  assert.ok(
    third.reg.Component({
      ...third.props,
      turn: location(9),
      useChat: (selector) => selector({ timeline: { turnOrder: [1, 9] } }),
    }),
    '真机形状（turn 是对象、turnOrder 里是 id）必须认出"最后一个回合" —— 缺陷 24 的回归',
  );
  assert.equal(
    third.reg.Component({
      ...third.props,
      turn: location(8),
      useChat: (selector) => selector({ timeline: { turnOrder: [1, 9] } }),
    }),
    null,
    '不是最后一个回合 → 不许渲染（否则就是"每个回合都来一张"）',
  );
  console.log('  ✅ 只在最后一个回合尾部渲染');
});

test('client half：刷新回来是空的，卡片也不许把自己撤掉（缺陷 23：真机"一闪而过"）', async () => {
  const h = await loadClientHalf();
  h.exports.apply(h.ctx);
  await settle();
  const { reg, props } = cardProps(h);

  /**
   * 复刻真机那两帧：
   *   ① 第一帧：宿主交回来 1 组没看过的 → 卡片渲染 → **当场记 seen**；
   *   ② 1.5s 后渲染路径上那次去抖刷新再 `list`：那几组已经 seen 了 → `visible: []`。
   * "卡片把自己撤掉"只发生在第 ② 帧 —— 真机上用户看到的就是"一闪而过 / 干脆没有"，
   * 而 `state.json` 里 markSeen 的时间戳一次比一次新（卡片确实渲染过好几次）。
   * 这里直接把这两帧喂给组件（不真等 1.5s：这个文件里连 `await setTimeout` 都要避开）。
   */
  let pendingRows = [];
  let pendingRest = 0;
  const claim = () => {
    if (pendingRows.length === 0) return null;
    const taken = { rows: pendingRows, restCount: pendingRest };
    pendingRows = [];
    pendingRest = 0;
    return taken;
  };
  const snapshot = () => ({
    status: 'ready',
    visible: pendingRows,
    restCount: pendingRest,
    restKeys: [],
    seen: 0,
    dismissed: 0,
    pending: [],
    error: null,
    errorVisible: null,
  });
  const group = (key, title, score) => ({ key, seedTitle: title, members: 3, score, seen: false, useWhen: '甲' });
  const render = (turn, sessionId = 'pin-s1') =>
    reg.Component({
      ...props,
      turn,
      sessionId,
      claim,
      useChat: (selector) => selector({ timeline: { turnOrder: [1, turn] } }),
      useMemfuseSuggestions: (selector) => selector(snapshot()),
    });

  pendingRows = [group('kA', '簇 A', 7)];
  pendingRest = 2;
  const first = render(9);
  assert.ok(first, '第一帧拿到候选 → 出卡片');
  assert.match(JSON.stringify(first), /簇 A/);

  // ② 那次刷新回来是空的（刚渲染完就记过 seen 了）—— 卡片必须还在
  const refreshed = render(9);
  assert.ok(refreshed, '⚠️ 刷新回来是空的时，卡片不能把自己撤掉（真机就是"一闪而过"）');
  assert.match(JSON.stringify(refreshed), /簇 A/, '内容要还是那一组');
  assert.match(JSON.stringify(refreshed), /另有 2 组/, '「另有 N 组」那行也得留住');

  // 钉住的键里有 turn / sessionId —— 别的回合、别的对话都不许蹭这张卡
  assert.equal(render(10), null, '别的回合不许复用（否则就是"每个回合都来一张"）');
  assert.equal(render(9, 'pin-s2'), null, '别的对话不许串台（否则就是"每个对话底部都有"）');

  // 下一轮宿主又给了新的一组 → 新回合照常出卡片
  pendingRows = [group('kZ', '簇 Z', 5)];
  const next = render(11);
  assert.match(JSON.stringify(next), /簇 Z/, '下一轮有新候选 → 新回合照常出卡片');
  assert.doesNotMatch(JSON.stringify(next), /簇 A/, '别把上一回合的内容带过来');

  // 点「不用」→ 那一行也要从钉住的那份里去掉（否则"点了没反应"）
  const button = findButton(next, props.t('suggestDismiss'));
  assert.ok(button, '卡片上必须有「不用」按钮');
  button.props.onClick();
  await settle();
  assert.equal(render(11), null, '点过「不用」的行必须从卡片上消失');
  console.log('  ✅ 卡片不会被自己的下一次刷新撤掉；不串回合、不串对话、点了就去掉');
});

test('client half：带参数的调用也要能跑（参数必须标 source: json，缺陷 19）', async () => {
  const { exports } = await loadClientHalf();
  const params = exports.remoteDescriptors().flatMap((d) => d.parameters.map((p) => [d.method, p]));

  assert.ok(params.length >= 3, 'dismiss / markSeen / requestDistill 都带参数');
  const missing = params.filter(([, p]) => p.source !== 'json').map(([method, p]) => `${method}(${p.name})`);
  assert.deepEqual(
    missing,
    [],
    '宿主 `resolveParameter()` 只看 `parameter.source === "json"`，否则把它当 lookup 参数去要 provider key，' +
      `抛 "lookup parameter \\"keys\\" has no provider key"（表现：list 正常、一按按钮就报错）。缺 source 的：${JSON.stringify(missing)}`,
  );
  console.log(`  ✅ ${params.length} 个参数都标了 source: 'json'`);
});

test('client half：卡片用**真字典**渲染得出来（函数型文案会在渲染期炸）', async () => {
  const h = await loadClientHalf();
  h.exports.apply(h.ctx);
  await settle();
  const { reg, props } = cardProps(h);

  // 这一行就是真机上的第二个坑：官方 t 的模板必须是字符串
  // （`dsh-client-locale/lib/client.js` 的 `template.replace(/\{(\w+)\}/g, …)`），
  // 写成函数会在渲染期抛 TypeError，表现同样是"卡片永远不出现"。
  const rendered = reg.Component(props);
  assert.ok(rendered, '有候选时必须渲染出卡片');
  const text = JSON.stringify(rendered);
  assert.match(text, /记忆里出现了可固化成技能的簇/);
  assert.match(text, /3 条记忆 · 7 分/, `成员数/分数要插值成文字，实际 ${text}`);
  assert.match(text, /部署时/, 'useWhen 要显示出来（用户据此判断要不要提炼）');
  console.log('  ✅ 真字典渲染：标题 +「3 条记忆 · 7 分」+ 作用 都在');
});

test('client half：候选卡片——渲染即记 seen，两个按钮打到 Remote 上', async () => {
  const h = await loadClientHalf();
  h.exports.apply(h.ctx);
  await settle();
  const { reg, face, props } = cardProps(h);

  // $mount 落地时已经拉过一次，所以第一次渲染就该有卡片
  const rendered = reg.Component(props);
  assert.ok(rendered, '有候选时要渲染出卡片');
  await settle();

  const snapshot = face.hooks.memfuseSuggestions.getSnapshot();
  assert.equal(snapshot.status, 'ready', `拉取应成功：${snapshot.error ?? ''}`);
  assert.deepEqual(
    snapshot.visible.map((g) => g.key),
    ['k1'],
    'seen 的那组不该出现在"还该出现"里（这就是「不能一直提示」）',
  );
  // 渲染即记 seen（用户什么都不用做）：**没显示出来的那几组也一起记**，
  // 否则下一轮又冒一行新的，等于换个方式刷屏（真机反馈"太多了，默认 1 组就可以"）
  const seenCall = h.remoteCalls.find((c) => c[0] === 'markSeen');
  assert.deepEqual(seenCall?.[1], ['k1', 'k8', 'k9'], '显示过的 + 没显示的组都要报给宿主');
  assert.equal(snapshot.restCount, 2, '还有几组没显示 —— 卡片要写出来');
  const cardText = JSON.stringify(reg.Component(props));
  assert.match(cardText, /另有 2 组同类候选/, '没显示的那些要说明去处（别装作不存在）');

  // 「不用」→ dismiss(key)
  await face.dismiss('k1');
  assert.deepEqual(h.remoteCalls.find((c) => c[0] === 'dismiss'), ['dismiss', 'k1']);
  assert.equal(face.hooks.memfuseSuggestions.getSnapshot().visible.length, 0, '点完就不再显示');

  // 「提炼」→ requestDistill(key)，并记进 pending（下一轮 prompt 会催）
  h.remoteCalls.length = 0;
  await face.requestDistill('k9');
  assert.deepEqual(h.remoteCalls.find((c) => c[0] === 'requestDistill'), ['requestDistill', 'k9']);
  assert.deepEqual(face.hooks.memfuseSuggestions.getSnapshot().pending, ['k9']);
  console.log('  ✅ 候选卡：渲染即记 seen；不用 → dismiss；提炼待办 → requestDistill');
});

test('缺陷 25：点「提炼成技能」必须给出**第二阶段**（草稿预览 + 装/丢），不是点完就没了', async () => {
  const h = await loadClientHalf();
  h.exports.apply(h.ctx);
  await settle();
  const { reg, props, face } = cardProps(h);

  const first = reg.Component(props);
  assert.ok(first, '有候选时要渲染出卡片');
  await settle();

  // ① 点卡片上的「提炼成技能」—— 以前这里只记一条待办，卡片那一行消失，用户什么都看不到
  const distillButton = findButton(first, props.t('suggestDistill'));
  assert.ok(distillButton, '卡片上必须有「提炼成技能」按钮');
  distillButton.props.onClick();
  // 提炼要调模型（可能几十秒）→ 必须给出进行中的状态，否则就是"点了没反应"
  await settle();
  const busySnapshot = face.hooks.memfuseSuggestions.getSnapshot();
  assert.equal(busySnapshot.draftBusy, null, '动作跑完了（测试里的假宿主是同步返回）');
  assert.deepEqual(
    h.remoteCalls.filter((c) => c[0] === 'distill').map((c) => c[1]),
    ['k1'],
    '按钮要打到宿主新增的 distill 端点（不是只记待办）',
  );

  // ② 草稿到手 → 卡片上出现**提示词本体 + 作用 + 两个按钮**
  const drafts = busySnapshot.drafts;
  assert.equal(drafts.length, 1, '草稿要进快照（渲染它的就是这一份）');
  assert.equal(drafts[0].name, 'ui-skill');
  const withDraft = reg.Component(props);
  const draftText = JSON.stringify(withDraft);
  assert.match(draftText, /ui-skill/, '技能名要显示');
  assert.match(draftText, /界面点「提炼成技能」时用/, '「这个技能干什么用的」要显示（description）');
  assert.match(draftText, /## 步骤/, 'SKILL.md 正文（提示词本体）要显示出来 —— 用户要看的就是这个');
  assert.match(draftText, /装进技能库/);
  assert.match(draftText, /丢掉/);
  assert.ok(findButton(withDraft, props.t('draftApprove')), '「装进技能库」按钮必须在');
  assert.ok(findButton(withDraft, props.t('draftReject')), '「丢掉」按钮必须在');

  // ③ 点「装进技能库」→ 打到宿主 approve，草稿从卡片上消失，并留一句结果说明
  const approveButton = findButton(withDraft, props.t('draftApprove'));
  await approveButton.props.onClick();
  await settle();
  assert.deepEqual(
    h.remoteCalls.find((c) => c[0] === 'approve'),
    ['approve', 'ui-skill'],
    '必须打到宿主的 approve 端点',
  );
  assert.equal(face.hooks.memfuseSuggestions.getSnapshot().drafts.length, 0, '装完草稿就从卡片上撤掉');
  const afterApprove = reg.Component(props);
  assert.match(JSON.stringify(afterApprove), /已装进技能库：ui-skill/, '装完要有一句结果说明（否则又是"点了没反应"）');
  console.log('  ✅ 提炼 → 草稿预览（提示词 + 作用）→ 装进技能库 / 丢掉，四个端点都打到');
});

test('缺陷 25：提炼失败（没开抽取 / 没模型）要如实说出来，并把这一组记成待办兜底', async () => {
  const h = await loadClientHalf({
    value: {},
    distillImpl: async () => ({
      ok: true,
      value: { ok: false, disabled: true, error: '自动抽取没开启（默认关闭）' },
    }),
  });
  h.exports.apply(h.ctx);
  await settle();
  const { reg, props, face } = cardProps(h);

  const first = reg.Component(props);
  const button = findButton(first, props.t('suggestDistill'));
  await button.props.onClick();
  await settle();

  const snapshot = face.hooks.memfuseSuggestions.getSnapshot();
  assert.equal(snapshot.drafts.length, 0, '失败了就不该有草稿');
  assert.match(String(snapshot.error), /自动抽取没开启/, '宿主给的原始原因要留在快照里（不许静默）');
  // 兜底：宿主这侧没模型时，仍然把这一组记成待办 —— 下一轮 Block E 会催模型去提炼
  assert.deepEqual(
    h.remoteCalls.filter((c) => c[0] === 'requestDistill').map((c) => c[1]),
    ['k1'],
    '提炼失败要退化成"记待办"，让对话里的模型去补 —— 两条路都不丢',
  );
  const text = JSON.stringify(reg.Component(props));
  assert.match(text, /自动抽取没开启/, '失败也要显示在卡片上，不能只在控制台里');
  console.log('  ✅ 提炼失败：原始原因可见 + 自动退化成待办（下一轮模型去补）');
});

test('缺陷 25：草稿的真源在宿主（刷新页面后草稿还在）', async () => {
  // 宿主 `list` 直接带 pendingSkills 回来 —— 卡片不靠"内存里的那一次 distill"才显示草稿
  const h = await loadClientHalf({
    value: {},
    suggestions: {
      groups: [],
      restCount: 0,
      restKeys: [],
      seen: 0,
      dismissed: 0,
      pendingDistill: [],
      pendingSkills: [
        {
          name: 'old-draft',
          description: '上次点提炼留下的草稿',
          content: '---\nname: old-draft\n---\n\n## 步骤\n1. x\n',
          installPath: 'C:\\Users\\YOU\\.dsh\\skills\\old-draft\\SKILL.md',
        },
      ],
    },
  });
  h.exports.apply(h.ctx);
  await settle();
  const { reg, props } = cardProps(h);

  const rendered = reg.Component(props);
  assert.ok(rendered, '没有候选行、但有草稿 → 卡片照样要出来（否则草稿就"丢了"）');
  assert.match(JSON.stringify(rendered), /old-draft/);
  assert.match(JSON.stringify(rendered), /## 步骤/);

  const rejectButton = findButton(rendered, props.t('draftReject'));
  await rejectButton.props.onClick();
  await settle();
  assert.deepEqual(h.remoteCalls.find((c) => c[0] === 'reject'), ['reject', 'old-draft']);
  console.log('  ✅ 草稿从宿主读（刷新后仍在）；「丢掉」打到 reject');
});

test('缺陷 26：第一次 list 失败之后要自己重试 —— 那行 404 不许一直挂在回合尾部', async () => {
  let calls = 0;
  const okPayload = {
    groups: [],
    restCount: 0,
    restKeys: [],
    seen: 0,
    dismissed: 0,
    pendingDistill: [],
    pendingSkills: [],
  };
  const h = await loadClientHalf({
    value: {},
    listImpl: async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error('client api: memfuse/list failed: transport failure for /api/memfuse/list: HTTP 404');
      }
      return { ok: true, value: okPayload };
    },
  });
  h.exports.apply(h.ctx);
  await settle();
  const { face } = cardProps(h);
  const feed = face.hooks.memfuseSuggestions;

  assert.equal(feed.getSnapshot().status, 'error', '挂载那次 list 失败 → 快照进 error');
  assert.match(String(feed.getSnapshot().error), /HTTP 404/);

  // ⚠️ 这里**故意不渲染卡片**：渲染会立刻再拉一次（"出错不吃去抖"那条路），
  // 那样测到的就不是重试定时器了。这条要证明的是"没有任何人碰它，它也会自己好"。
  await new Promise((resolve) => setTimeout(resolve, 1300));
  const after = feed.getSnapshot();
  assert.equal(after.status, 'ready', `重试成功之后错误必须收掉（实际还留着：${after.error ?? ''}）`);
  assert.equal(after.error, null);
  assert.equal(calls, 2, '第一次失败 + 一次重试');
  console.log('  ✅ 失败后自动重试（退避 1s），那行错误自己消失');
});

test('缺陷 26：出错时渲染不吃去抖（错误横幅要能被下一次成功收掉）', async () => {
  let calls = 0;
  const h = await loadClientHalf({
    value: {},
    listImpl: async () => {
      calls += 1;
      if (calls === 1) throw new Error('boom-404');
      return {
        ok: true,
        value: { groups: [], restCount: 0, restKeys: [], seen: 0, dismissed: 0, pendingDistill: [], pendingSkills: [] },
      };
    },
  });
  h.exports.apply(h.ctx);
  await settle();
  const { reg, props, face } = cardProps(h);
  const feed = face.hooks.memfuseSuggestions;
  assert.equal(feed.getSnapshot().status, 'error');

  // 紧跟着渲染（距上次 touch 远小于 1.5s）：正常状态下会被去抖挡掉，出错时不许挡
  reg.Component(props);
  await settle();
  assert.equal(calls, 2, '出错时那次渲染必须真的再拉一次');
  assert.equal(feed.getSnapshot().status, 'ready');
  console.log('  ✅ 出错状态下渲染立刻重拉（不吃 1.5s 去抖）');
});

test('client half：没有候选 → 不渲染；通道坏了 → 渲染一行错误（不许静默）', async () => {
  const empty = { groups: [], seen: 0, dismissed: 0, pendingDistill: [] };
  const a = await loadClientHalf({ value: {}, suggestions: empty });
  a.exports.apply(a.ctx);
  await settle();
  const first = cardProps(a);
  assert.equal(first.reg.Component(first.props), null, '没有候选时什么都不渲染');

  // 远程调用失败（宿主没装上 / 命名空间没注入 / 传输断了）→ 必须**看得见**
  const broken = await loadClientHalf({
    value: {},
    listImpl: async () => {
      throw new Error('boom');
    },
  });
  broken.exports.apply(broken.ctx);
  await settle();
  const second = cardProps(broken);
  const snap = second.face.hooks.memfuseSuggestions.getSnapshot();
  assert.equal(snap.status, 'error');
  assert.match(snap.error, /boom/, '错误要留在快照里（不许静默）');
  const rendered = second.reg.Component(second.props);
  assert.ok(rendered, '通道坏了要渲染出来 —— 只表现为"卡片不出现"是最难查的失败');
  assert.match(JSON.stringify(rendered), /boom/, '错误横幅里要带上原始消息');
  console.log('  ✅ 无候选什么都不渲染；通道坏了渲染一行错误');
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
    ['enabled', 'follow', 'model', 'onUnavailable', 'fallback', 'mode', 'skillSuggest'],
    '字段顺序 = 页面顺序：总开关 → 跟随 → 模型 → 不可用时 → 降级 → 落盘方式 → 技能建议',
  );
  assert.equal(snapshot.fields.model.value, 'zjpaiguo\u0000deepseek-flash', '选择器要显示当前 provider#model');
  assert.equal(snapshot.fields.follow.checked, false, '默认不勾选「跟随对话模型」');
  assert.equal(snapshot.fields.mode.text, '', '没配过就是空（回落默认值）');
  // 技能建议**不属于抽取**：它零 LLM，与"用不用模型"无关，不该跟着总开关联动
  assert.ok(snapshot.fields.skillSuggest, '技能建议开关必须在表单里');
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
  assert.equal(snapshot.available, true, '目录失败不该让整张表单变成可用性上的受害者');
  console.log('  ✅ 目录失败不拖垮表单（有提示、仍可保存其它字段）');
});

test('client half：配置页要显示候选卡片的连通状态（卡片不出现时的唯一线索）', async () => {
  // ① 正常：连上了 + 当前有几组待决定
  const good = await mount({ value: {} });
  await settle();
  const page = good.Component(good.props);
  assert.match(JSON.stringify(page), /已连上（1 组候选待你决定）/, '连上要说出来');

  // ② 数据源报错：把原始消息显示出来
  const bad = await mount({
    value: {},
    listImpl: async () => {
      throw new Error('canvas is closed');
    },
  });
  await settle();
  const page2 = bad.Component(bad.props);
  assert.match(JSON.stringify(page2), /候选卡片读不到数据/, '连不上也要说出来（不许静默）');
  assert.match(JSON.stringify(page2), /canvas is closed/, '要带原始报错，否则用户没法自救');
  console.log('  ✅ 配置页显示候选卡片状态：已连上（N 组）/ 读不到数据：<原始报错>');
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
  assert.match(props.t('clean'), /没有未保存的改动/, '文案走真字典');

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
