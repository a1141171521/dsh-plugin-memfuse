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
 * 真机就是这么炸的 —— 字典里写成 `suggestMembers: ({count}) => …`，
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
  markSeenImpl = null,
  /** 覆盖 `dismiss`（F-CL-01：动作失败不能在下次 list 刷新时被抹掉）。 */
  dismissImpl = null,
  /** 覆盖 `requestDistill`。 */
  requestDistillImpl = null,
  /** 覆盖 `distill` 的实现（缺陷 25：提炼成技能那条路）。 */
  distillImpl = null,
  /** 覆盖 `checkUpdate` 的实现（检查更新那条路）。 */
  updateImpl = null,
  /** 覆盖 `applyUpdate` 的实现（安装更新那条路）。 */
  installImpl = null,
  /** 覆盖 `memories` 的实现（记忆面板读取）。 */
  panelImpl = null,
  /** 覆盖 `setPriority` 的实现（面板置顶 / 降级）。 */
  setPriorityImpl = null,
  /** 覆盖 `revive` 的实现（面板唤醒）。 */
  reviveImpl = null,
  /** 宿主是否接受写入（false = 模拟"非 volatile 字段被拒"）。 */
  mutateOk = true,
} = {}) {
  const registrations = [];
  const disposers = [];
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
      {
        key: 'k1',
        seedTitle: '部署要走 scripts/deploy.sh',
        members: 3,
        memberTitles: ['部署入口在 scripts/deploy.sh', '部署前要先跑测试', '回滚用 git revert'],
        score: 7,
        seen: false,
        useWhen: '部署时',
      },
      { key: 'k2', seedTitle: '已经看过的簇', members: 2, memberTitles: ['甲', '乙'], score: 5, seen: true, useWhen: null },
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
      if (markSeenImpl) return markSeenImpl(keys);
      return { ok: true, value: { ok: true } };
    },
    dismiss: async (key) => {
      remoteCalls.push(['dismiss', key]);
      if (dismissImpl !== null) return dismissImpl(key);
      return { ok: true, value: { ok: true } };
    },
    requestDistill: async (key) => {
      remoteCalls.push(['requestDistill', key]);
      if (requestDistillImpl !== null) return requestDistillImpl(key);
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
    // ── 2026-10-18：检查更新（只读）──
    checkUpdate: async () => {
      remoteCalls.push(['checkUpdate']);
      if (updateImpl !== null) return updateImpl();
      return {
        ok: true,
        value: {
          supported: true,
          current: '0.1.0',
          latest: '0.1.0',
          behind: 0,
          branch: 'main',
          remote: 'https://github.com/a1141171521/dsh-plugin-memfuse.git',
          url: 'https://github.com/a1141171521/dsh-plugin-memfuse',
          head: 'abc1234',
          checkedAt: '2026-10-18T00:00:00.000Z',
        },
      };
    },
    // ── 2026-10-18 追加：安装更新（宿主跑 git pull --ff-only）──
    applyUpdate: async () => {
      remoteCalls.push(['applyUpdate']);
      if (installImpl !== null) return installImpl();
      return {
        ok: true,
        value: {
          ok: true,
          supported: true,
          changed: true,
          from: '0.1.0',
          to: '0.2.0',
          head: 'def5678',
          branch: 'main',
          remote: 'https://github.com/a1141171521/dsh-plugin-memfuse.git',
          url: 'https://github.com/a1141171521/dsh-plugin-memfuse',
          restartRequired: true,
          updatedAt: '2026-10-18T00:00:00.000Z',
        },
      };
    },
    // ── 2026-11-23：记忆面板三个端点 ──
    // 形状与宿主 `lib/memory-view.js` 的 buildView + annotateRows 一致；
    // 用例可以用 `panelImpl` 覆盖它（测失败/溢出等分支）。
    memories: async (...args) => {
      remoteCalls.push(['memories', ...args]);
      if (panelImpl !== null) return panelImpl(...args);
      return {
        ok: true,
        value: {
          stats: { total: 0, active: 0, dormant: 0, byPriority: { P0: 0, P1: 0, P2: 0 }, residentCap: 8, residentCount: 0, residentOverflow: 0 },
          resident: [], overflow: [], rows: [],
          page: 1, pageSize: 50, pageCount: 1, totalMatches: 0,
          filters: { query: '', priority: '', lifecycle: '', scope: '' },
          residentMaxEntries: 8, residentMaxChars: 1200, readError: null,
        },
      };
    },
    setPriority: async (id, priority) => {
      remoteCalls.push(['setPriority', id, priority]);
      if (setPriorityImpl !== null) return setPriorityImpl(id, priority);
      return { ok: true, value: { ok: true, changed: true, id, to: priority, targetVisible: true, pushedOut: [] } };
    },
    revive: async (id) => {
      remoteCalls.push(['revive', id]);
      if (reviveImpl !== null) return reviveImpl(id);
      return { ok: true, value: { ok: true, changed: true, revived: id } };
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
    // 2026-11-24：设置页分栏用 `React.useState` 记住当前 tab。
    // 离线测试没有 React 运行时 —— 桩只保留初始值；要验"切到设置栏"就用
    // `MemfuseConfigCardView` 的 `initialTab: 'settings'` 测试接缝。
    if (name === 'react') return { useState: (initial) => [initial, () => {}] };
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
      if (typeof disposer === 'function') disposers.push(disposer);
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
    dicts,
    dispose: async () => { for (const off of disposers.reverse()) await off(); },
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
  // ⚠️ 先展开函数组件（React 会做，假树不会）。`textOfTree` 早就这么做了，
  // 这里以前没有 —— 于是"嵌在子组件里的按钮"永远找不到，看起来像功能没做。
  const current = renderNode(node);
  if (current === null || typeof current !== 'object') return null;
  if (current.type === 'button' && current.props?.children === label) return current;
  const kids = current.props?.children;
  for (const kid of Array.isArray(kids) ? kids : kids === undefined ? [] : [kids]) {
    const hit = findButton(kid, label);
    if (hit !== null) return hit;
  }
  return null;
}

/**
 * 在假树里找出**所有**同文案按钮（F-CL-07：两行候选时按钮数要能数）。
 */
function findButtons(node, label, out = []) {
  const current = renderNode(node);
  if (current === null || typeof current !== 'object') return out;
  if (current.type === 'button' && current.props?.children === label) out.push(current);
  const kids = current.props?.children;
  for (const kid of Array.isArray(kids) ? kids : kids === undefined ? [] : [kids]) findButtons(kid, label, out);
  return out;
}

/**
 * 把假树里的**函数组件**就地渲染一层（React 会做，假树不会）。
 *
 * 为什么要这一步：`SettingsForm` 的 children 里放的是 `<LearningBanner …/>` 这个
 * **元素**，横幅自己的 className 要等组件被调用后才出现。不展开就只能找到元素、
 * 找不到横幅本体（第一版用例就是这么红的）。
 */
function renderNode(node) {
  if (node === null || typeof node !== 'object') return node;
  return typeof node.type === 'function' ? renderNode(node.type(node.props)) : node;
}

/** 在 jsx 假树里找一个横幅（按 className 认，递归）。 */
function findBanner(node) {
  const current = renderNode(node);
  if (current === null || typeof current !== 'object') return null;
  const className = current.props?.className;
  if (typeof className === 'string' && className.includes('dsh-memfuse-banner')) return current;
  const kids = current.props?.children;
  for (const kid of Array.isArray(kids) ? kids : kids === undefined ? [] : [kids]) {
    const hit = findBanner(kid);
    if (hit !== null) return hit;
  }
  return null;
}

/**
 * 收集假树里所有 `className` 含 `cls` 的元素（递归，函数组件会被展开）。
 *
 * 为什么按 className 找而不是按 tag：tab 条 / 分栏都是普通 `div`，
 * 真正区分它们的是类名与 `role`；按 tag 找会把整页的 div 全捞出来。
 */
function findAllByClass(node, cls, out = []) {
  const current = renderNode(node);
  if (current === null || typeof current !== 'object') return out;
  const className = current.props?.className;
  if (typeof className === 'string' && className.split(/\s+/).includes(cls)) out.push(current);
  const kids = current.props?.children;
  for (const kid of Array.isArray(kids) ? kids : kids === undefined ? [] : [kids]) findAllByClass(kid, cls, out);
  return out;
}

/** 把假树里的文本拼起来（断言"文案里说了什么"用）。`props.label` 也算 —— 勾选框的标签
 *  是作为 prop 传给 `Checkbox` 的，不在 children 里。 */function textOfTree(node) {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node;
  if (typeof node !== 'object') return '';
  const current = renderNode(node);
  if (current === null || current === undefined) return '';
  if (typeof current === 'string') return current;
  const label = typeof current.props?.label === 'string' ? current.props.label : '';
  const kids = current.props?.children;
  const childText = (Array.isArray(kids) ? kids : kids === undefined ? [] : [kids]).map(textOfTree).join(' ');
  return label === '' ? childText : `${label} ${childText}`;
}

/** 收集假树里所有 `<select>` 的 id（用来断言"哪个模型选择器出现了"）。 */
function selectIds(node, out = []) {
  const current = renderNode(node);
  if (current === null || typeof current !== 'object') return out;
  if (current.type === 'select' && typeof current.props?.id === 'string') out.push(current.props.id);
  const kids = current.props?.children;
  for (const kid of Array.isArray(kids) ? kids : kids === undefined ? [] : [kids]) selectIds(kid, out);
  return out;
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

test('client half：四处入口都注册好（设置页一级页 + 包页表单 + 行标题可点 + 回合尾候选卡）', async () => {
  const h = await loadClientHalf();
  h.exports.apply(h.ctx);
  // 候选卡要等 `$mount` 落地之后才注册（它依赖 remote.memfuse 命名空间）
  await settle();
  const { registrations } = h;

  assert.equal(
    registrations.length,
    4,
    `应注册四处（设置页 + 包页 + 行 + 候选卡），实际 ${registrations.length}`,
  );

  const section = registrations.find((r) => r.options.name === 'settings.section');
  const bundle = registrations.find((r) => r.options.name === 'plugins.bundle.config');
  const row = registrations.find((r) => r.options.name === 'plugins.row.config');
  const card = registrations.find((r) => r.options.name === 'conversation.chat.turnTail');

  // ① 一级设置页（2026-10-17 新增：用户要求「加到 settingpage 中」）
  assert.ok(section, '必须注册 settings.section —— 否则设置页左侧导航里没有「记忆」这一页');
  assert.equal(section.options.id, 'dsh-memfuse', 'id 用自己的包名（复用官方 id 会顶掉人家那一页）');
  assert.equal(section.options.order, 25, 'order 25：排在 Agent 预设(20) 之后、其它第三方页(35/40) 之前');
  assert.equal(section.options.label(), '记忆', 'label 用 thunk，切语言时槽位重投影即可');
  assert.equal(section.options.locale, 'settings.memfuse');
  assert.equal(typeof section.options.inject, 'function', '设置页也要 inject（hooks + 动作）');
  assert.equal(typeof section.Component, 'function', '必须给一个组件');

  assert.ok(bundle, '必须注册 plugins.bundle.config —— 包页上直接渲染表单，用户不用点任何东西');
  assert.equal(bundle.options.key, 'dsh-memfuse', 'bundle 槽的 key = **包名**');
  assert.ok(row, '必须注册 plugins.row.config —— 行标题才会变成可点入口');
  assert.equal(row.options.key, 'dsh-memfuse#dsh-memfuse', 'key 必须是 <包名>#<cordis.patch.yml 里的 row id>');
  assert.ok(card, '必须注册 conversation.chat.turnTail —— 候选要出现在界面里，而不是只写在 prompt 里');
  assert.equal(card.options.id, 'dsh-memfuse#suggestions', 'list 槽按 id 占位（别复用官方 id，会顶掉人家的格子）');
  assert.equal(card.options.order, 10);

  for (const reg of [section, bundle, row]) {
    assert.equal(typeof reg.options.inject, 'function', 'slot entry 要给 inject（hooks + 动作）');
    assert.equal(typeof reg.Component, 'function', '必须给一个组件');
    assert.equal(reg.options.locale, 'settings.memfuse');
  }
  // 三处入口渲染的是**同一个组件**（草稿/保存只有一份实现）
  assert.equal(section.Component, bundle.Component, '设置页与包页必须共用同一个组件');
  assert.equal(row.Component, bundle.Component, '行详情与包页必须共用同一个组件');
  assert.equal(typeof card.options.inject, 'function', '候选卡也要 inject（数据源 + 两个动作）');
  assert.equal(typeof card.Component, 'function');
  console.log('  ✅ 注册 settings.section + plugins.bundle.config + plugins.row.config + conversation.chat.turnTail');
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
  // 十二个端点：读候选 / 表态 四个 + 缺陷 25 的 distill·approve·reject 三个 +
  // 检查更新一个 + 安装更新一个 + 记忆面板三个（memories·setPriority·revive）
  assert.equal(h.mounted[0].descriptors.length, 12);
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
  const group = (key, title, score) => ({
    key,
    seedTitle: title,
    members: 3,
    memberTitles: ['甲', '乙', '丙'],
    score,
    seen: false,
    useWhen: '甲',
  });
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
  assert.match(JSON.stringify(refreshed), /另外还有 2 组同类候选/, '「另有 N 组」那行也得留住');

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
  assert.match(text, /这组记忆可以变成一条技能/);
  assert.match(text, /包含的同类记忆（3 条）/, `成员数要插值成文字，实际 ${text}`);
  assert.match(text, /部署前要先跑测试/, '成员标题要显示出来（用户得知道这技能里有什么）');
  assert.match(text, /什么时候用得上：部署时/, 'useWhen 要显示出来（用户据此判断要不要提炼）');
  assert.match(text, /把它变成技能后/, '要回答"对我有什么帮助"');
  // 按钮：文字必须短到不换行（真机反馈「提炼和拒绝的按钮描述都换行了」）
  const distillBtn = findButton(rendered, '提炼成技能');
  assert.ok(distillBtn, '卡片上必须有「提炼成技能」');
  assert.equal(distillBtn.props['data-variant'], 'primary', '主按钮要能看出是主按钮');
  const dismissBtn = findButton(rendered, '不用');
  assert.ok(dismissBtn, '拒绝按钮的文案就是「不用」（原来的「不用（别再提）」太长，窄一点就换行）');
  assert.ok(!JSON.stringify(rendered).includes('（别再提）'), '别再退回长按钮文案');
  console.log('  ✅ 真字典渲染：标题 + 成员 + 适用场景 + 好处 + 两个短按钮 都在');
});

/** 只模拟浏览器提交/可见回执；渲染函数本身不代表 DOM 已提交。 */
function attachCard(tree, { io = true, hidden = false, offscreen = false } = {}) {
  const events = new Map();
  const observers = [];
  const add = (name, fn) => { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(fn); };
  const remove = (name, fn) => events.get(name)?.delete(fn);
  const win = { innerWidth: 1000, innerHeight: 800, addEventListener: add, removeEventListener: remove };
  if (io) win.IntersectionObserver = class {
    constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
    observe(node) { this.node = node; }
    disconnect() { this.disconnected = true; }
  };
  const doc = { defaultView: win, visibilityState: hidden ? 'hidden' : 'visible', addEventListener: add, removeEventListener: remove };
  const node = { ownerDocument: doc, isConnected: true,
    getBoundingClientRect: () => ({ width: 400, height: 120, left: 10, right: 410, top: offscreen ? 1000 : 10, bottom: offscreen ? 1120 : 130 }) };
  tree.props.ref(node);
  return {
    doc, node, observers,
    intersect(value = true) { for (const o of observers) o.callback([{target: node, isIntersecting: value, intersectionRatio: value ? 1 : 0}]); },
    show() { doc.visibilityState = 'visible'; for (const fn of [...(events.get('visibilitychange') ?? [])]) fn(); },
    scrollIntoView() { offscreen = false; for (const fn of [...(events.get('scroll') ?? [])]) fn(); },
    detach() { node.isConnected = false; tree.props.ref(null); },
    listenerCount() { return [...events.values()].reduce((n, set) => n + set.size, 0); },
  };
}
let feedClock = Date.now();
async function refreshFeed(face) {
  const realNow = Date.now;
  feedClock = Math.max(feedClock + 2000, realNow() + 2000);
  Date.now = () => feedClock;
  try { face.touch(); } finally { Date.now = realNow; }
  await settle();
}

test('缺陷 37：提交、离屏、后台页都不算展示；可见后仅确认固定批次一次', async () => {
  const h = await loadClientHalf(); h.exports.apply(h.ctx); await settle();
  const { reg, props } = cardProps(h);
  const tree = reg.Component(props);
  assert.equal(h.remoteCalls.filter(c => c[0] === 'markSeen').length, 0);
  const view = attachCard(tree, {hidden:true});
  view.intersect(false); view.intersect(true); await settle();
  assert.equal(h.remoteCalls.filter(c => c[0] === 'markSeen').length, 0);
  view.show(); await settle();
  assert.deepEqual(h.remoteCalls.filter(c => c[0] === 'markSeen'), [['markSeen',['k1','k8','k9']]]);
  view.intersect(true); tree.props.ref(view.node); await settle();
  assert.equal(h.remoteCalls.filter(c => c[0] === 'markSeen').length, 1);
  assert.equal(view.listenerCount(), 0);
  assert.ok(view.observers.every(o => o.disconnected));
  view.detach(); await h.dispose();
});

test('缺陷 37：ref 解绑后迟到的可见回调无效；无 IO 时离屏仍不记账', async () => {
  const h = await loadClientHalf(); h.exports.apply(h.ctx); await settle();
  const { reg, props } = cardProps(h);
  const tree = reg.Component(props);
  const old = attachCard(tree); old.detach(); old.intersect(true); await settle();
  assert.equal(h.remoteCalls.filter(c => c[0] === 'markSeen').length, 0);
  assert.equal(old.listenerCount(), 0);
  const fallback = attachCard(tree, {io:false, offscreen:true}); await settle();
  assert.equal(h.remoteCalls.filter(c => c[0] === 'markSeen').length, 0);
  fallback.scrollIntoView(); await settle();
  assert.equal(h.remoteCalls.filter(c => c[0] === 'markSeen').length, 1);
  assert.equal(fallback.listenerCount(), 0);
  fallback.detach(); await h.dispose();
});

test('缺陷 37：同回合后到候选留给下一回合，旧卡片只确认自己的批次', async () => {
  const payload = {groups:[{key:'A', seedTitle:'候选A', seen:false}], restKeys:['A-rest']};
  const h = await loadClientHalf({listImpl:async()=>({ok:true,value:structuredClone(payload)})});
  h.exports.apply(h.ctx); await settle();
  const { reg, props, face } = cardProps(h);
  const render = turn => reg.Component({...props, sessionId:'late-groups', turn,
    useChat: select => select({timeline:{turnOrder:[turn]}})});
  const first = render(1); const view = attachCard(first);
  await settle();
  payload.groups = [{key:'B', seedTitle:'候选B', seen:false}]; payload.restKeys = ['B-rest'];
  await refreshFeed(face);
  assert.match(textOfTree(render(1)), /候选A/);
  assert.doesNotMatch(textOfTree(render(1)), /候选B/);
  view.intersect(true); await settle();
  assert.deepEqual(h.remoteCalls.filter(c=>c[0]==='markSeen'), [['markSeen',['A','A-rest']]]);
  const next = render(2); assert.match(textOfTree(next), /候选B/);
  const second = attachCard(next); second.intersect(true); await settle();
  assert.deepEqual(h.remoteCalls.filter(c=>c[0]==='markSeen').map(c=>c[1]), [['A','A-rest'],['B','B-rest']]);
  view.detach(); second.detach(); await h.dispose();
});

test('缺陷 37：展示记账在飞时旧 list 不重复投递；失败留原因且可重试', async () => {
  let resolveAck; let attempts=0;
  const h = await loadClientHalf({markSeenImpl: async () => {
    attempts++;
    if(attempts===1) await new Promise(resolve=>{resolveAck=resolve;});
    if(attempts===1) throw new Error('seen write failed');
    return {ok:true};
  }});
  h.exports.apply(h.ctx); await settle();
  const {reg,props,face}=cardProps(h);
  const tree=reg.Component({...props,turn:1,sessionId:'ack-race'});const view=attachCard(tree);
  view.intersect(true);await settle();
  await refreshFeed(face);
  assert.equal(face.hooks.memfuseSuggestions.getSnapshot().visible.length,0);
  resolveAck();await settle();
  assert.match(face.hooks.memfuseSuggestions.getSnapshot().error,/seen write failed/);
  await refreshFeed(face);await settle();
  assert.equal(attempts,2);
  assert.equal(face.hooks.memfuseSuggestions.getSnapshot().error,null);
  assert.deepEqual(h.remoteCalls.filter(c=>c[0]==='markSeen').map(c=>c[1]), [['k1','k8','k9'],['k1','k8','k9']]);
  view.detach();await h.dispose();
});

test('缺陷 37：卸载清理可见监听并忽略晚到 list', async () => {
  let release;let count=0;
  const h=await loadClientHalf({listImpl:async()=>{
    if(++count>1) await new Promise(resolve=>{release=resolve;});
    return {ok:true,value:{groups:[{key:'A',seedTitle:'卸载候选'}],restKeys:[]}};
  }});
  h.exports.apply(h.ctx);await settle();
  const {reg,props,face}=cardProps(h);const view=attachCard(reg.Component(props));
  await settle(); // 卡片 touch 启动的第二次 list 尚未返回。
  await h.dispose();view.intersect(true);release?.();await settle();
  assert.equal(view.listenerCount(),0);
  assert.ok(view.observers.every(o=>o.disconnected));
  assert.equal(h.remoteCalls.filter(c=>c[0]==='markSeen').length,0);
  const before=h.remoteCalls.length;face.touch();face.wake();await settle();
  assert.equal(h.remoteCalls.length,before);
});

test('缺陷 37：同一回合重新挂载插件后，卡片确认属于新 feed', async () => {
  const h=await loadClientHalf();h.exports.apply(h.ctx);await settle();
  const first=cardProps(h);const turn={turn:7,sessionId:'remount'};
  const old=attachCard(first.reg.Component({...first.props,...turn}));
  await h.dispose();h.registrations.length=0;
  h.exports.apply(h.ctx);await settle();
  const fresh=cardProps(h);
  const view=attachCard(fresh.reg.Component({...fresh.props,...turn}));
  old.intersect(true);await settle();
  assert.equal(h.remoteCalls.filter(c=>c[0]==='markSeen').length,0);
  view.intersect(true);await settle();
  assert.equal(h.remoteCalls.filter(c=>c[0]==='markSeen').length,1);
  view.detach();await h.dispose();
});

test('缺陷 37：只有加载或渲染历史回合时，不得把候选标为已展示', async () => {
  const h = await loadClientHalf();
  h.exports.apply(h.ctx);
  await settle();
  const { reg, props } = cardProps(h);
  assert.equal(h.remoteCalls.filter((c) => c[0] === 'markSeen').length, 0,
    '启动预取不代表用户看过卡片');
  assert.equal(reg.Component({ ...props, turn: 1,
    useChat: (select) => select({ timeline: { turnOrder: [1, 2] } }) }), null);
  await settle();
  assert.equal(h.remoteCalls.filter((c) => c[0] === 'markSeen').length, 0,
    '历史回合返回 null 时也应保留未展示候选');
});

test('client half：候选卡片——渲染即记 seen，两个按钮打到 Remote 上', async () => {
  const h = await loadClientHalf();
  h.exports.apply(h.ctx);
  await settle();
  const { reg, face, props } = cardProps(h);

  // $mount 落地时已经拉过一次，所以第一次渲染就该有卡片
  const rendered = reg.Component(props);
  assert.ok(rendered, '有候选时要渲染出卡片');
  const view = attachCard(rendered);
  view.intersect(true);
  await settle();

  const snapshot = face.hooks.memfuseSuggestions.getSnapshot();
  assert.equal(snapshot.status, 'ready', `拉取应成功：${snapshot.error ?? ''}`);
  assert.deepEqual(
    snapshot.visible.map((g) => g.key),
    [],
    '已领走并可见的候选不再向其他回合投递',
  );
  // 渲染即记 seen（用户什么都不用做）：**没显示出来的那几组也一起记**，
  // 否则下一轮又冒一行新的，等于换个方式刷屏（真机反馈"太多了，默认 1 组就可以"）
  const seenCall = h.remoteCalls.find((c) => c[0] === 'markSeen');
  assert.deepEqual(seenCall?.[1], ['k1', 'k8', 'k9'], '显示过的 + 没显示的组都要报给宿主');
  assert.equal(snapshot.restCount, 0, '领走后的共享队列清空，卡片固定保留同批说明');
  const cardText = JSON.stringify(reg.Component(props));
  assert.match(cardText, /另外还有 2 组同类候选，想看就告诉我/, '没显示的那些要说明去处（别装作不存在）');

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
  assert.match(draftText, /刚写好的技能/, '标题要说人话（别写"草稿/提示词"这类术语）');
  assert.match(draftText, /收下这条技能/, '按钮要口语化');
  assert.match(draftText, /不要了/, '拒绝按钮也要口语化');
  assert.ok(findButton(withDraft, props.t('draftApprove')), '「收下这条技能」按钮必须在');
  assert.ok(findButton(withDraft, props.t('draftReject')), '「不要了」按钮必须在');

  // ③ 点「收下这条技能」→ 打到宿主 approve，草稿从卡片上消失，并留一句结果说明
  const approveButton = findButton(withDraft, props.t('draftApprove'));
  await approveButton.props.onClick();
  await settle();
  assert.deepEqual(
    h.remoteCalls.find((c) => c[0] === 'approve'),
    ['approve', 'ui-skill'],
    '必须打到宿主的 approve 端点',
  );
  assert.equal(face.hooks.memfuseSuggestions.getSnapshot().drafts.length, 0, '收下后草稿就从卡片上撤掉');
  const afterApprove = reg.Component(props);
  assert.match(JSON.stringify(afterApprove), /收下了：ui-skill/, '收完要有一句结果说明（否则又是"点了没反应"）');
  console.log('  ✅ 提炼 → 先看内容（说人话）→ 收下 / 不要了，四个端点都打到');
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
  // F-CL-01：动作失败落在 actionError（通道错误 error 是另一回事，列表刷新不许抹掉它）
  assert.match(String(snapshot.actionError), /自动抽取没开启/, '宿主给的原始原因要留在快照里（不许静默）');
  assert.equal(snapshot.error, null, '动作失败不该冒充"通道坏了"');
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
  console.log('  ✅ 草稿从宿主读（刷新后仍在）；「不要了」打到 reject');
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

  // 页面结构：三组标题 + 七个字段（组标题漏了 = 又退回"一列平铺开关"）
  const pageText = textOfTree(page);
  for (const group of ['记忆学习（LLM 抽取）', '模型不可用时', '学到的记忆与技能']) {
    assert.ok(pageText.includes(group), `分组标题「${group}」必须渲染出来`);
  }
  assert.ok(pageText.includes('开启记忆学习（用 LLM 抽取）'), '总开关的标签要在页面上');
  assert.ok(pageText.includes('抽取用的模型'), '模型选择器要在页面上');

  // 投影里每个字段都在（下拉、勾选、分段控件各自读自己的那份）
  const snapshot = face.hooks.memfuseConfig.getSnapshot();
  assert.deepEqual(
    Object.keys(snapshot.fields),
    ['enabled', 'follow', 'model', 'onUnavailable', 'fallback', 'mode', 'skillSuggest'],
    '字段顺序 = 页面顺序：总开关 → 跟随 → 模型 → 不可用时 → 降级 → 落盘方式 → 技能建议',
  );
  assert.equal(snapshot.fields.model.value, 'zjpaiguo\u0000deepseek-flash', '选择器要显示当前 provider#model');
  assert.equal(snapshot.fields.follow.checked, false, '快照里没写过 = 不勾（宿主合并默认值后才变 true）');
  assert.equal(snapshot.fields.mode.text, '', '没配过就是空（回落默认值）');
  // 技能建议**不属于抽取**：它零 LLM，与"用不用模型"无关，不该跟着总开关联动
  assert.ok(snapshot.fields.skillSuggest, '技能建议开关必须在表单里');
  console.log('  ✅ summary/page 都渲染；字段投影齐全（默认不勾跟随、默认不选模型）');
});

test('client half：设置页顶部横幅三态 —— 关着要说清「不会学习」，且一键就能修好', async () => {
  // ① 关着 → off 横幅 + 一键开启
  const off = await mount({ value: { extract: { enabled: false } } });
  const offBanner = findBanner(off.Component(off.props));
  assert.ok(offBanner, '关着时必须有关闭横幅 —— 否则现象只是"记忆好像没长"，设置页看上去还一切正常');
  assert.equal(offBanner.props['data-tone'], 'off');
  assert.match(textOfTree(offBanner), /不会从对话里学新记忆/, '标题必须点名「不会学习」');
  const enable = findButton(offBanner, '开启记忆学习');
  assert.ok(enable, '横幅里要有一键开启按钮');
  enable.props.onClick();
  await settle();
  assert.deepEqual(
    off.writes[0].ops,
    [{ op: 'set', path: ['extract', 'enabled'], value: true }],
    '一键开启必须真的写 extract.enabled=true（布尔真值，不是字符串）',
  );

  // ② 开着、但没模型也没勾跟随 → partial 横幅 + 一键「跟随对话模型」
  //    这一档在宿主侧是**真故障**（每轮注入都会报），界面必须提前说。
  const partial = await mount({ value: { extract: { enabled: true } } });
  const partialBanner = findBanner(partial.Component(partial.props));
  assert.equal(partialBanner.props['data-tone'], 'partial');
  assert.match(textOfTree(partialBanner), /还没有可用的模型/);
  const follow = findButton(partialBanner, '跟随对话模型');
  assert.ok(follow, '缺模型时一键「跟随对话模型」是最省事的修法');
  follow.props.onClick();
  await settle();
  assert.deepEqual(partial.writes[0].ops, [
    { op: 'set', path: ['extract', 'followConversation'], value: true },
  ]);

  // ③ 开着且跟随 → ready 横幅（说清模型来源与落盘方式，别让人再猜）
  const ready = await mount({ value: { extract: { enabled: true, followConversation: true } } });
  const readyBanner = findBanner(ready.Component(ready.props));
  assert.equal(readyBanner.props['data-tone'], 'ready');
  const readyText = textOfTree(readyBanner);
  assert.match(readyText, /已开启/, '就绪态也要有一行，不能只剩开关');
  assert.match(readyText, /跟随对话模型/, '要写出模型来源（跟随 / 显式）');
  assert.match(readyText, /先确认/, '要写出新记忆怎么落盘（suggest / auto）');
  console.log('  ✅ 横幅三态：关着提示+一键开启；没模型提示+一键跟随；就绪说明来源与落盘方式');
});

test('client half：模型选择器按「跟随 / 策略」显隐（跟随开着时不该摆两个用不上的下拉）', async () => {
  const MODEL = 'plugin-config-dsh-memfuse-model';
  const FALLBACK = 'plugin-config-dsh-memfuse-fallback';

  // ① 跟随 ON + stop（默认组合）：两个选择器都不生效 → 全藏
  const a = await mount({ value: { extract: { enabled: true, followConversation: true } } });
  assert.deepEqual(selectIds(a.Component(a.props)), [], '跟随 + stop：主选择器与独立降级模型都用不上，必须藏起来');

  // ② 跟随 ON + fallback：只出现**一个** —— 主选择器就是降级目标，改名并挪到「模型不可用时」
  const b = await mount({
    value: { extract: { enabled: true, followConversation: true, onUnavailable: 'fallback' } },
  });
  assert.deepEqual(selectIds(b.Component(b.props)), [MODEL], '跟随 + fallback：只该有一个选择器（它是降级目标）');
  assert.match(
    textOfTree(b.Component(b.props)),
    /降级模型（主模型不可用时）/,
    '跟随模式下它要改名 —— 否则用户以为在挑主模型',
  );

  // ③ 跟随 OFF + stop：主选择器在；独立降级模型在 stop 下永远用不到 → 藏
  const c = await mount({ value: { extract: { enabled: true, followConversation: false } } });
  assert.deepEqual(selectIds(c.Component(c.props)), [MODEL], '不跟随 + stop：只显示主模型');

  // ④ 跟随 OFF + fallback：两个都要能配
  const d = await mount({
    value: { extract: { enabled: true, followConversation: false, onUnavailable: 'fallback' } },
  });
  assert.deepEqual(
    selectIds(d.Component(d.props)),
    [MODEL, FALLBACK],
    '不跟随 + fallback：主模型与独立降级模型都要显示',
  );
  console.log('  ✅ 模型选择器按状态显隐：跟随+stop 全藏；跟随+fallback 只留降级；不跟随按策略显示');
});

test('client half：设置页页脚 —— 版本 / 检查更新 / GitHub 点赞', async () => {
  const h = await loadClientHalf({
    value: {},
    suggestions: {
      groups: [],
      restCount: 0,
      restKeys: [],
      seen: 0,
      dismissed: 0,
      pendingDistill: [],
      pendingSkills: [],
      version: '0.1.0',
      repoUrl: 'https://github.com/a1141171521/dsh-plugin-memfuse',
    },
  });
  h.exports.apply(h.ctx);
  await settle();

  const reg = h.registrations.find((row) => row.options.name === 'settings.section');
  assert.ok(reg, '设置页必须注册');
  const face = reg.options.inject();
  const props = {
    t: h.t,
    view: 'page',
    ...face,
    useMemfuseConfig: (selector) => selector(face.hooks.memfuseConfig.getSnapshot()),
  };
  const page = reg.Component(props);
  const text = textOfTree(page);
  assert.match(text, /v0\.1\.0/, '版本号要显示（宿主从 package.json 读回来）');
  assert.match(text, /还没检查过/, '没点之前要说清"没查过"，别装成"已是最新"');
  assert.match(text, /去 GitHub 点个赞/, '点赞按钮要在');
  const raw = JSON.stringify(page);
  assert.ok(
    raw.includes('"href":"https://github.com/a1141171521/dsh-plugin-memfuse"'),
    '点赞按钮必须是指向仓库的链接（不是假装能替用户点星）',
  );
  assert.ok(raw.includes('"target":"_blank"'), '要在新标签页打开');

  // 点「检查更新」→ 打到宿主的 checkUpdate（必须走声明过 remote.memfuse 的子 ctx）
  const button = findButton(page, '检查更新');
  assert.ok(button, '必须有「检查更新」按钮');
  button.props.onClick();
  await settle();
  assert.ok(
    h.remoteCalls.some((call) => call[0] === 'checkUpdate'),
    '点「检查更新」要打到宿主的 checkUpdate 端点',
  );
  const after = textOfTree(reg.Component(props));
  assert.match(after, /已是最新（v0\.1\.0 · abc1234）/, '查到"已是最新"要如实显示版本与提交号');
  assert.equal(findButton(reg.Component(props), '安装更新'), null, '没有新版本时不该摆「安装更新」（点了只会吃一次同样的错）');
  console.log('  ✅ 页脚：版本 + 检查更新（真的打到宿主）+ GitHub 点赞链接');
});

/** 选出设置页那一级注册，并把 slot 系统会传的 props 拼出来（页脚/更新相关用例共用）。 */
function sectionProps(handle) {
  const reg = handle.registrations.find((row) => row.options.name === 'settings.section');
  assert.ok(reg, '设置页必须注册');
  const face = reg.options.inject();
  const props = {
    t: handle.t,
    view: 'page',
    ...face,
    useMemfuseConfig: (selector) => selector(face.hooks.memfuseConfig.getSnapshot()),
  };
  return { reg, face, props };
}

/** 一条"查到新版本"的 checkUpdate 返回值（behind = 3）。 */
const NEWER = {
  supported: true,
  current: '0.1.0',
  latest: '0.2.0',
  behind: 3,
  branch: 'main',
  remote: 'https://github.com/a1141171521/dsh-plugin-memfuse.git',
  url: 'https://github.com/a1141171521/dsh-plugin-memfuse',
  head: 'abc1234',
  checkedAt: '2026-10-18T00:00:00.000Z',
};

/** 空候选 + 页脚所需的版本信息。 */
const EMPTY_FEED = {
  groups: [],
  restCount: 0,
  restKeys: [],
  seen: 0,
  dismissed: 0,
  pendingDistill: [],
  pendingSkills: [],
  version: '0.1.0',
  runningVersion: '0.1.0',
  repoUrl: 'https://github.com/a1141171521/dsh-plugin-memfuse',
};

test('client half：查到新版本 → 出现「安装更新」→ 点它真的打到宿主，并明说"重启后生效"', async () => {
  const h = await loadClientHalf({
    value: {},
    suggestions: EMPTY_FEED,
    updateImpl: async () => ({ ok: true, value: NEWER }),
  });
  h.exports.apply(h.ctx);
  await settle();
  const { reg, props } = sectionProps(h);

  // ① 没查过 → 不摆「安装更新」
  assert.equal(
    findButton(reg.Component(props), '安装更新'),
    null,
    '还没查到新版本就摆一个按钮，点了只会再吃一次同样的错',
  );

  // ② 查一下 → 出现按钮
  findButton(reg.Component(props), '检查更新').props.onClick();
  await settle();
  const afterCheck = reg.Component(props);
  assert.match(textOfTree(afterCheck), /落后 3 次提交/, '查到新版本要说清落后多少');
  const install = findButton(afterCheck, '安装更新');
  assert.ok(install, '查到新版本后必须出现「安装更新」按钮');

  // ③ 点安装 → 打到宿主 applyUpdate
  install.props.onClick();
  await settle();
  assert.ok(
    h.remoteCalls.some((call) => call[0] === 'applyUpdate'),
    '点「安装更新」要打到宿主的 applyUpdate 端点',
  );

  const afterInstall = reg.Component(props);
  const text = textOfTree(afterInstall);
  assert.match(text, /已更新到 v0\.2\.0/, '装完要说清更新到了哪个版本');
  assert.match(text, /重启 DSH 后生效/, '没有热更新：必须明说"重启才生效"');
  assert.ok(!/落后 3 次提交/.test(text), '装完之后不许还挂着"落后 N 次提交"（那是装之前的结论）');
  assert.equal(findButton(afterInstall, '安装更新'), null, '装过了就把按钮收起来，剩下的只是重启');
  // 页脚：磁盘 0.2.0 / 进程 0.1.0 → 必须标「重启后生效」
  assert.match(text, /v0\.2\.0（重启后生效）/, '页脚版本号要跟着磁盘走，并标出"待重启"');
  console.log('  ✅ 查到新版本 → 安装（真打到宿主）→ 明说"重启后生效"、按钮收起、页脚标"待重启"');
});

test('client half：落后但版本号没变 → 说「新提交」，不说「新版本」', async () => {
  const h = await loadClientHalf({
    value: {},
    suggestions: EMPTY_FEED,
    // 版本号没动，但确实落后 3 个提交（文档/测试类提交就是这样）
    updateImpl: async () => ({ ok: true, value: { ...NEWER, latest: '0.1.0' } }),
  });
  h.exports.apply(h.ctx);
  await settle();
  const { reg, props } = sectionProps(h);

  findButton(reg.Component(props), '检查更新').props.onClick();
  await settle();
  const text = textOfTree(reg.Component(props));
  assert.match(text, /GitHub 上有新提交/, '版本号没动就别写"新版本"（否则用户以为版本号会变）');
  assert.ok(!/新版本/.test(text), '同一行里不许同时出现"新版本"');
  assert.ok(findButton(reg.Component(props), '安装更新'), '落后就该能装，跟版本号有没有变无关');
  console.log('  ✅ 落后但版本号没变 → 「新提交」措辞，安装按钮照样出现');
});

test('client half：更新被拒（本地有未提交改动）→ 原始报错照原样显示，按钮留着可以改完再试', async () => {
  const dirty = '本地有未提交的改动（M lib/index.js）—— 先提交或还原再更新，不会覆盖你的东西';
  const h = await loadClientHalf({
    value: {},
    suggestions: EMPTY_FEED,
    updateImpl: async () => ({ ok: true, value: NEWER }),
    installImpl: async () => ({
      ok: true,
      value: { ok: false, supported: true, changed: false, from: '0.1.0', to: '0.1.0', dirtyCount: 1, error: dirty },
    }),
  });
  h.exports.apply(h.ctx);
  await settle();
  const { reg, props } = sectionProps(h);

  findButton(reg.Component(props), '检查更新').props.onClick();
  await settle();
  findButton(reg.Component(props), '安装更新').props.onClick();
  await settle();

  const text = textOfTree(reg.Component(props));
  assert.match(text, /更新没成功：本地有未提交的改动/, '拒绝理由要显示出来');
  assert.match(text, /M lib\/index\.js/, '原始报错不许吞（连是哪个文件都要能看到）');
  assert.ok(
    findButton(reg.Component(props), '安装更新'),
    '失败后按钮要留着 —— 用户提交完改动还能再试一次',
  );
  console.log('  ✅ 更新被拒时原样显示宿主理由，且按钮保留可重试');
});

test('client half：页脚版本 —— 磁盘与进程不一致时标「重启后生效」', async () => {
  // 场景：用户已经在别处 `git pull` 过（或上次点了安装但还没重启）→
  // 磁盘 0.2.0、进程里还是 0.1.0。只报磁盘版本就是"界面写着新版、跑的其实是旧版"。
  const h = await loadClientHalf({ value: {}, suggestions: { ...EMPTY_FEED, version: '0.2.0' } });
  h.exports.apply(h.ctx);
  await settle();
  const { reg, props } = sectionProps(h);
  const text = textOfTree(reg.Component(props));
  assert.match(text, /v0\.2\.0（重启后生效）/, '两个版本不同就必须说清"装了还没重启"');

  // 重启之后两边一致 → 不该再挂着那句话
  const h2 = await loadClientHalf({ value: {}, suggestions: EMPTY_FEED });
  h2.exports.apply(h2.ctx);
  await settle();
  const second = sectionProps(h2);
  assert.match(textOfTree(second.reg.Component(second.props)), /v0\.1\.0(?!（重启后生效）)/, '版本一致时不要乱标"待重启"');
  console.log('  ✅ 页脚：磁盘/进程版本不一致 → 「（重启后生效）」；一致 → 只报版本号');
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
  assert.match(JSON.stringify(page), /候选通道：已连接/, '连上要说出来');

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

/**
 * 缺陷 27：缺陷 26 的修法只给了"3 次 / 7 秒"的预算，真机重启后又挂回同一行 404。
 *
 * 三个必须锁住的点：
 *   ① 重试**没有次数上限**（7 秒烧光就永久放弃 = 那行错误钉死在回合尾部）；
 *   ② 重试中说的是"还没就绪"而不是"通道出错"，但**原始报错不许被吞**（硬规则 4）；
 *   ③ 窗口重新可见（`wake()`）要立刻再试，并把退避重置 —— 用户切回来时宿主早好了。
 */
test('缺陷 27：重试不许"3 次就放弃" —— 开机竞态可能持续十几秒', async () => {
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
      // 前 5 次全失败 —— 旧实现第 4 次就不再来（3 次预算），这里必须撑到第 6 次
      if (calls <= 5) {
        throw new Error('client api: memfuse/list failed: transport failure for /api/memfuse/list: HTTP 404');
      }
      return { ok: true, value: okPayload };
    },
  });
  // 把退避压到毫秒级（生产里是 1s/2s/4s/8s/15s/30s…）
  h.exports.__retryConfig.baseMs = 1;
  h.exports.__retryConfig.maxMs = 4;
  h.exports.apply(h.ctx);
  await settle();
  const { face } = cardProps(h);
  const feed = face.hooks.memfuseSuggestions;
  assert.equal(feed.getSnapshot().status, 'error');

  const deadline = Date.now() + 3000;
  while (feed.getSnapshot().status !== 'ready' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const after = feed.getSnapshot();
  assert.equal(after.status, 'ready', `第 6 次才成功 —— 不许放弃（calls=${String(calls)}，还留着：${after.error ?? ''}）`);
  assert.equal(after.error, null);
  assert.ok(calls >= 6, `必须真的重试到第 6 次（实际 ${String(calls)} 次）`);
  console.log(`  ✅ 前 5 次失败、第 ${String(calls)} 次成功 —— 重试没有次数上限`);
});

test('缺陷 27：重试中说「还没就绪」，但原始报错照样看得见', async () => {
  const h = await loadClientHalf({
    value: {},
    listImpl: async () => {
      throw new Error('client api: memfuse/list failed: transport failure for /api/memfuse/list: HTTP 404');
    },
  });
  h.exports.apply(h.ctx);
  await settle();
  const { reg, props, face } = cardProps(h);
  const snap = face.hooks.memfuseSuggestions.getSnapshot();
  assert.equal(snap.status, 'error');
  assert.equal(snap.retrying, true, '还有下一次重试排着 → retrying 必须是 true');

  const rendered = JSON.stringify(reg.Component(props));
  assert.match(rendered, /还没就绪/, '别摆出"出错了"的架势 —— 说清它正在自动重试');
  assert.match(rendered, /HTTP 404/, '原始原因不许吞掉（硬规则 4）');
  assert.doesNotMatch(rendered, /界面通道出错/, '重试中不该说"通道出错"');
  console.log('  ✅ 重试中给「还没就绪 + 原始原因」，不吓人也不吞错');
});

test('缺陷 27：切回窗口（wake）要立刻再试，不等退避', async () => {
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
  // 故意把下一次重试排到很远的将来：只有 wake() 能把它提前
  h.exports.__retryConfig.baseMs = 60000;
  h.exports.__retryConfig.maxMs = 60000;
  h.exports.apply(h.ctx);
  await settle();
  const { props, face } = cardProps(h);
  assert.equal(face.hooks.memfuseSuggestions.getSnapshot().status, 'error');

  const before = calls;
  props.wake(); // 用户切回窗口 / 页面重新可见
  await settle();
  assert.equal(calls, before + 1, 'wake() 必须立刻再拉一次，不许干等那 60 秒');
  assert.equal(face.hooks.memfuseSuggestions.getSnapshot().status, 'ready');
  console.log('  ✅ 切回窗口立刻重试，成功即收掉错误');
});



test('缺陷 38：设置页解释无卡片原因与待确认记忆，读取和渲染均不改用户数据', async () => {
  const diagnostic={status:'all_dismissed',totalMemories:119,activeMemories:26,dormantMemories:93,eligibleGroups:2,dismissedGroups:2,seenGroups:0,pendingGroups:0,freshGroups:0,pendingMemories:101,extractMode:'suggest'};
  const h=await mount({value:{},suggestions:{groups:[],restKeys:[],pendingDistill:[],pendingSkills:[],diagnostics:diagnostic}});
  await settle();
  const text=textOfTree(h.Component(h.props));
  assert.match(text,/候选通道：已连接/);
  assert.match(text,/当前 2 组建议已被忽略/);
  assert.ok(text.includes('活跃 26 / 休眠 93'));
  assert.match(text,/101 条新记忆待你确认/);
  assert.match(text,/采纳前不会参与技能判定/);
  assert.equal(h.writes.length,0);
  assert.ok(!h.remoteCalls.some(c=>['markSeen','dismiss','approve','distill'].includes(c[0])));
  await h.dispose();
  for(const [status,expected] of [['no_candidates',/暂无达到条件/],['no_fresh',/已提醒或正在提炼/],['ready',/3 组新建议/],['suggest_off',/主动提示已关闭/]]) {
    const another=await mount({suggestions:{groups:[],restKeys:[],diagnostics:{...diagnostic,status,freshGroups:3,pendingMemories:0}}});
    await settle();
    assert.match(textOfTree(another.Component(another.props)),expected);
    await another.dispose();
  }
});
// ─────────────────────────── 记忆面板（2026-11-23）───────────────────────────
//
// 面板的数据源有三件事**只能靠行为断言**（渲染路径测不到）：
//   ① 参数必须是**位置参数**（宿主网关按 descriptor.parameters 顺序逐个解析）；
//   ② 首次加载必须**幂等**（渲染期调用，React 会重复渲染）；
//   ③ 改完优先级必须把"挤掉了谁 / 到底生效没有"写进提示（否则用户以为白点了）。

/** 从 loaded bundle 里取出面板数据源类（只给测试的导出，见 client.js 的注释）。 */
async function panelKit() {
  const { exports } = await loadClientHalf();
  assert.equal(typeof exports.MemoryPanelFeed, 'function', '必须导出记忆面板数据源（供测试用）');
  return exports;
}

test('记忆面板：memories 端点走**位置参数**，参数顺序与宿主描述符一致', async () => {
  const exports = await panelKit();
  const calls = [];
  const ctx = {
    remote: {
      memfuse: {
        memories: async (...args) => {
          calls.push(args);
          return { ok: true, value: { page: 1, rows: [], resident: [], overflow: [], stats: {}, filters: {} } };
        },
      },
    },
  };
  const feed = new exports.MemoryPanelFeed(ctx);
  await feed.load();
  assert.equal(calls.length, 1);
  assert.deepEqual(
    calls[0],
    ['', '', '', '', 1],
    '必须按 (query, priority, lifecycle, scope, page) 传位置参数，实际 ' + JSON.stringify(calls[0]) +
      '。传成一个对象会让宿主把第一个字符串之外的条件全丢掉，而且不报错',
  );

  // 改筛选 → 参数跟着变，且**翻页回第 1 页**（换条件还停在旧页码没有意义）
  feed.setPage(3);
  await feed.load();
  assert.equal(calls.at(-1)[4], 3, '翻页要真的把页码传下去');
  await feed.setFilter('priority', 'P0');
  const last = calls.at(-1);
  assert.equal(last[1], 'P0', '筛选值要落在**第 2 个**位置参数上（priority）');
  assert.equal(last[4], 1, '改筛选必须重置回第 1 页');

  // 页码非法时不该发请求
  const before = calls.length;
  await feed.setPage(0);
  assert.equal(calls.length, before, '非法页码（0）不该发请求');
  feed.dispose();
  console.log('  ✅ 面板参数：位置参数顺序正确、筛选重置页码、非法页码不发请求');
});

test('记忆面板：ensureLoaded 幂等（渲染期调用也不会每帧打一次请求）', async () => {
  const exports = await panelKit();
  let resolveFirst = null;
  let count = 0;
  const ctx = {
    remote: {
      memfuse: {
        memories: async () => {
          count += 1;
          // 第一次挂住，用来验"飞行中不重复发"
          if (count === 1) await new Promise((resolve) => { resolveFirst = resolve; });
          return { ok: true, value: { page: 1, rows: [], resident: [], overflow: [], stats: {}, filters: {} } };
        },
      },
    },
  };
  const feed = new exports.MemoryPanelFeed(ctx);
  // 首屏连敲三次（模拟 StrictMode 双渲染 + 父组件更新）
  const a = feed.ensureLoaded();
  const b = feed.ensureLoaded();
  const c = feed.ensureLoaded();
  await settle();
  assert.equal(count, 1, '飞行中必须只发一次请求，实际发了 ' + count + ' 次');
  resolveFirst();
  await Promise.all([a, b, c]);
  assert.equal(feed.store.getSnapshot().status, 'ready');

  // 已经是 ready：再敲也不发
  await feed.ensureLoaded();
  assert.equal(count, 1, '数据已经在了就不该再拉（否则每帧一次请求）');

  // 出错之后 ensureLoaded **不许**自己重试（那是 scheduleRetry 的事，它带退避）
  const broken = new exports.MemoryPanelFeed({
    remote: { memfuse: { memories: async () => { throw new Error('HTTP 404'); } } },
  });
  await broken.load();
  assert.equal(broken.store.getSnapshot().status, 'error');
  const before = broken.retryCount;
  await broken.ensureLoaded();
  assert.equal(broken.retryCount, before, '出错后 ensureLoaded 不该绕过退避自己再试');
  broken.dispose();
  feed.dispose();
  console.log('  ✅ 幂等加载：飞行中只一次、ready 后不再拉、出错交给退避');
});

test('记忆面板：改优先级的提示必须说出后果（挤出谁 / 到底生效没有）', async () => {
  const exports = await panelKit();
  let response = null;
  const ctx = {
    remote: {
      memfuse: {
        memories: async () => ({ ok: true, value: { page: 1, rows: [], resident: [], overflow: [], stats: {}, filters: {} } }),
        setPriority: async () => response,
      },
    },
  };
  const feed = new exports.MemoryPanelFeed(ctx);

  // ① 正常置顶：说"已置顶"
  response = { ok: true, value: { ok: true, changed: true, from: 'P1', to: 'P0', targetVisible: true, pushedOut: [] } };
  await feed.setPriority('m1', 'P0', '某条记忆');
  assert.match(feed.store.getSnapshot().note ?? '', /已置顶/);

  // ② 挤掉了别人：**必须点名**（静默挤掉一条等于悄悄改了每轮注入）
  response = {
    ok: true,
    value: { ok: true, changed: true, from: 'P1', to: 'P0', targetVisible: true, pushedOut: ['old1', 'old2'] },
  };
  await feed.setPriority('m2', 'P0', '新那条');
  assert.match(
    feed.store.getSnapshot().note ?? '',
    /挤出/,
    '把别人挤出常驻块时必须写出来（否则用户不知道自己的置顶把谁顶掉了）',
  );

  // ③ 目标自己挤不进去：也要说清。
  // ⚠️ 措辞必须是"不再固定排在开头"，**不是**"本轮看不到" —— P0 有词法豁免
  // （recall.js:211），零匹配底分 ≈0.34 > 阈值 0.18，所以溢出条目照样能从相关召回进来。
  response = { ok: true, value: { ok: true, changed: true, from: 'P1', to: 'P0', targetVisible: false, pushedOut: [] } };
  await feed.setPriority('m3', 'P0', '倒霉那条');
  const notVisibleNote = feed.store.getSnapshot().note ?? '';
  assert.match(notVisibleNote, /上限/, '目标没进常驻块时必须说清原因');
  assert.match(notVisibleNote, /开头|相关召回/, '要写清"不固定排在开头、只能靠相关召回"');
  assert.ok(!/本轮注入里看不到/.test(notVisibleNote), '不能写成"本轮看不到" —— 溢出条目仍可能被召回');

  // ④ 休眠条目改优先级不会生效：必须提示"再点唤醒"
  response = { ok: true, value: { ok: true, changed: true, from: 'P2', to: 'P0', dormant: true, pushedOut: [] } };
  await feed.setPriority('m4', 'P0', '睡着那条');
  assert.match(feed.store.getSnapshot().note ?? '', /唤醒/, '休眠条目改优先级不会让它生效，必须提示去唤醒');

  // ⑤ 幂等（本来就这个优先级）：不能假装改过
  response = { ok: true, value: { ok: true, changed: false } };
  await feed.setPriority('m5', 'P1', '本来就这样');
  assert.match(feed.store.getSnapshot().note ?? '', /没有改动|本来就是/, '没改动时不该声称改过');

  // ⑥ 失败：原始报错原样上屏（硬规则 4）。
  // ⚠️ 落在 `actionError` 而**不是** `error`：动作之后还会重拉一次列表，
  // 那次刷新是**成功的** —— 混用一个字段的话报错会被它清掉（第一版就是这样）。
  ctx.remote.memfuse.setPriority = async () => ({ ok: false, error: { message: '磁盘满了' } });
  await feed.setPriority('m6', 'P0', '失败的');
  assert.match(feed.store.getSnapshot().actionError ?? '', /磁盘满了/, '原始报错必须原样显示，不许吞');
  assert.equal(feed.store.getSnapshot().status, 'ready', '动作失败不该把列表整体标成"读不到"');

  feed.dispose();
  console.log('  ✅ 后果如实上报：置顶 / 挤掉谁 / 没进常驻 / 还在休眠 / 没改动 / 失败原文');
});

test('记忆面板：通道没挂上时动作给出明确失败，而不是静默什么都不做', async () => {
  const exports = await panelKit();
  // 数据源拿不到 remote.memfuse（模拟贡献没挂上）
  const feed = new exports.MemoryPanelFeed({ remote: {} });
  await feed.load();
  const snapshot = feed.store.getSnapshot();
  assert.equal(snapshot.status, 'error');
  assert.match(String(snapshot.error), /不在|挂上/, '必须说明"端点不在"，实际：' + snapshot.error);
  feed.dispose();
  console.log('  ✅ 通道缺失：明确报"端点不在"，不静默');
});// ──────────────────── 记忆面板：渲染（设置页整条路径）────────────────────
//
// 前面的用例测的是**数据源**（参数、幂等、后果上报）；这一条测的是**渲染**：
// 面板真的出现在设置页上、真的把记忆列出来、真的能点。
// 为什么必须单独测：面板是唯一一张"用户会盯着看几百条数据"的界面，
// 它一旦渲染崩了（某个字段 null、某个 map 漏 key），整个设置页会白屏 ——
// 而那种失败在数据源测试里完全看不见。

test('记忆面板：设置页真的渲染出记忆列表，并把溢出/休眠的原因说出来', async () => {
  // 面板数据源要真的挂上：先走一遍 apply()，再把它拿到的那份 card 交给设置页。
  const h = await loadClientHalf({ value: {}, suggestions: EMPTY_FEED });
  // ⚠️ 必须先 apply()：注册面（settings.section 等）是 apply 里挂的。
  h.exports.apply(h.ctx);
  await settle();
  // 宿主侧的面板响应（形状与 lib/memory-view.js 的 buildView + annotateRows 一致）
  const PANEL = {
    stats: {
      total: 3, active: 2, dormant: 1, stale: 0,
      byPriority: { P0: 2, P1: 0, P2: 1 }, byScope: { workspace: 3, user: 0, global: 0 },
      byKind: { fact: 3 }, residentCap: 1, residentCount: 1, residentOverflow: 1,
    },
    resident: ['m1'],
    overflow: ['m2'],
    rows: [
      {
        id: 'm1', title: '要我每轮都记得的那条', summary: '常驻摘要', priority: 'P0', lifecycle: 'active',
        scope: 'workspace', kind: 'fact', updated: '2026-11-01T00:00:00Z', dormant: false,
        resident: true, overflow: false, reason: null, stats: { recalled: 5 },
      },
      {
        id: 'm2', title: '被挤出常驻块的那条', summary: '溢出摘要', priority: 'P0', lifecycle: 'active',
        scope: 'workspace', kind: 'fact', updated: '2026-11-02T00:00:00Z', dormant: false,
        resident: true, overflow: true,
        reason: {
          code: 'overflow',
          reason: '已置顶，但超出常驻条数上限 —— 不再固定出现在每轮开头，只能靠在相关召回里被选中',
        },
        stats: { recalled: 0 },
      },
      {
        id: 'm3', title: '休眠着的那条', summary: '休眠摘要', priority: 'P2', lifecycle: 'dormant',
        scope: 'workspace', kind: 'fact', updated: '2026-11-03T00:00:00Z', dormant: true,
        resident: false, overflow: false,
        reason: { code: 'dormant', reason: '休眠中，不参与注入；被高相关提问命中时会自动唤醒' },
        stats: { recalled: 1 },
      },
    ],
    page: 1, pageSize: 50, pageCount: 1, totalMatches: 3,
    filters: { query: '', priority: '', lifecycle: '', scope: '' },
    residentMaxEntries: 1, residentMaxChars: 1200, readError: null,
  };
  // 让替身 `memories` 端点返回这份数据
  h.ctx.remote.allowed?.add('remote.memfuse');

  const { reg } = sectionProps(h);
  const face = reg.options.inject();
  // 直接把面板数据源换成一个"已经有数据"的替身（避免依赖真实装配时序）
  const panelSnap = { status: 'ready', view: PANEL, busy: null, error: null, actionError: null, note: null };
  const props = {
    t: h.t,
    view: 'page',
    ...face,
    useMemfuseConfig: (selector) =>
      selector({ ...face.hooks.memfuseConfig.getSnapshot(), panel: panelSnap }),
  };

  const tree = reg.Component(props);
  const text = textOfTree(tree);

  // ① 三条记忆都列出来了（含休眠那条 —— 用户要能看见它才谈得上唤醒）
  assert.match(text, /要我每轮都记得的那条/, '常驻记忆必须出现在列表里');
  assert.match(text, /被挤出常驻块的那条/, '溢出记忆也要列出来（它仍在库中）');
  assert.match(text, /休眠着的那条/, '休眠记忆也要列出来，否则用户没法唤醒它');

  // ② 常驻顺序给了序号（那就是实际注入顺序）
  assert.match(text, /1\..*要我每轮都记得的那条/s, '常驻区要按注入顺序带序号');

  // ③ 溢出必须显形 —— 这是本次改动最要紧的一条：当前实现会**静默丢掉**它们。
  //    措辞必须准：不是"本轮看不到"（P0 有词法豁免 recall.js:211，零匹配底分 ≈0.34
  //    > 阈值 0.18，所以它照样能从相关召回进来），而是"不固定排在开头、只能靠相关召回"。
  assert.match(text, /超出常驻|上限/, '溢出条目必须说清"超出上限"');
  assert.ok(
    !/每一轮都不会被注入|本轮的注入里看不到/.test(text),
    '不许写成"永远看不到" —— 溢出 P0 仍可能被相关召回，那是假消息',
  );

  // ④ 休眠原因也要说清（不参与注入）
  assert.match(text, /休眠/, '休眠条目要有原因说明');

  // ⑤ 三个动作按钮都在：置顶 / 降为 P1 / 唤醒
  assert.ok(findButton(tree, '置顶（每轮生效）') || findButton(tree, '已置顶'), '要有置顶按钮');
  assert.ok(findButton(tree, '降为 P1'), '要有降级按钮');
  assert.ok(findButton(tree, '唤醒'), '休眠条目要有唤醒按钮');

  // ⑥ 点「置顶」必须真的打到宿主（否则界面上点了什么都不发生 —— 缺陷 25 那类）
  const pin = findButton(tree, '置顶（每轮生效）');
  pin.props.onClick();
  await settle();
  assert.ok(
    h.remoteCalls.some((c) => c[0] === 'setPriority'),
    '点「置顶」必须打到宿主的 setPriority 端点',
  );
  // ⑦ 点「唤醒」也一样
  const wake = findButton(reg.Component(props), '唤醒');
  wake.props.onClick();
  await settle();
  assert.ok(h.remoteCalls.some((c) => c[0] === 'revive'), '点「唤醒」必须打到宿主的 revive 端点');

  console.log('  ✅ 面板渲染：三条记忆都列出、序号是注入顺序、溢出与休眠各有原因、三个按钮都打到宿主');
});
// ──────────────────── 设置页分栏（2026-11-24）────────────────────
//
// 用户原话：「我的记忆和原有的设置，应该作为不同的 tab 可以进行切换，现在全部在
// 一个页面中，要一直下拉才能找到记忆设置相关配置」。
// 这一条钉住三件事：① 真的有两个 tab（role/aria 正确、文案对）；② 默认停在
// 「我的记忆」；③ 另一栏是 **hidden**，不是"排在下面继续铺" —— 否则等于没分开。

test('设置页分两栏：我的记忆 / 设置各是一个 tab，默认记忆栏，另一栏 hidden', async () => {
  const h = await loadClientHalf({ value: {}, suggestions: EMPTY_FEED });
  h.exports.apply(h.ctx);
  await settle();
  const { reg } = sectionProps(h);
  const face = reg.options.inject();

  const PANEL = {
    stats: { total: 1, active: 1, dormant: 0, byPriority: { P0: 1 }, byScope: { workspace: 1 }, byKind: { fact: 1 }, residentCap: 8, residentCount: 1, residentOverflow: 0 },
    resident: ['m1'], overflow: [],
    rows: [{
      id: 'm1', title: '要我每轮都记得的那条', summary: '常驻摘要', priority: 'P0', lifecycle: 'active',
      scope: 'workspace', kind: 'fact', updated: '2026-11-01T00:00:00Z', dormant: false,
      resident: true, overflow: false, reason: null, stats: { recalled: 0 },
    }],
    page: 1, pageSize: 50, pageCount: 1, totalMatches: 1,
    filters: { query: '', priority: '', lifecycle: '', scope: '' },
    residentMaxEntries: 8, residentMaxChars: 1200, readError: null,
  };

  const propsOf = (extra = {}) => ({
    t: h.t,
    view: 'page',
    ...face,
    ...extra,
    useMemfuseConfig: (selector) =>
      selector({
        ...face.hooks.memfuseConfig.getSnapshot(),
        panel: { status: 'ready', view: PANEL, busy: null, error: null, actionError: null, note: null },
      }),
  });

  // ① 默认：tab 条 + 两个 tab，选中「我的记忆」
  const tree = reg.Component(propsOf());
  const tabBars = findAllByClass(tree, 'dsh-memfuse-tabs');
  assert.equal(tabBars.length, 1, '设置页必须有一条 tab 栏');
  assert.equal(tabBars[0].props.role, 'tablist', 'tab 栏要有 role=tablist（键盘/读屏要靠它）');

  const tabButtons = findAllByClass(tree, 'dsh-memfuse-tab');
  assert.equal(tabButtons.length, 2, '必须正好两个 tab：我的记忆 / 设置');
  assert.deepEqual(
    tabButtons.map((b) => textOfTree(b)),
    ['我的记忆', '设置'],
    'tab 文案就是用户说的那两栏',
  );
  assert.equal(tabButtons[0].props['aria-selected'], true, '默认停在「我的记忆」');
  assert.equal(tabButtons[1].props['aria-selected'], false);
  assert.equal(tabButtons[0].props['aria-controls'], 'dsh-memfuse-panel-memory', 'aria-controls 要指向分栏容器');

  // ② 两栏都在树里，但只有当前那栏可见 —— 「hidden」才是"分开"，不是继续往下铺
  const panels = findAllByClass(tree, 'dsh-memfuse-tab-panel');
  assert.equal(panels.length, 2, '两栏都要渲染（切换不丢筛选词）');
  assert.equal(panels[0].props.hidden, false, '默认这一栏可见');
  assert.equal(panels[1].props.hidden, true, '设置栏默认必须 hidden —— 否则用户还是要一路下拉');
  assert.match(textOfTree(panels[0]), /要我每轮都记得的那条/, '记忆栏要有真的记忆列表');

  // ③ 切到设置栏：原来那些开关/页脚都在，记忆列表不再占位
  const settingsTree = reg.Component(propsOf({ initialTab: 'settings' }));
  const panels2 = findAllByClass(settingsTree, 'dsh-memfuse-tab-panel');
  assert.equal(panels2[0].props.hidden, true, '切过去之后记忆栏收起');
  assert.equal(panels2[1].props.hidden, false, '设置栏展开');
  const settingsText = textOfTree(panels2[1]);
  assert.match(settingsText, /开启记忆学习|跟随对话模型/, '设置栏必须保留原来的抽取开关');
  assert.match(settingsText, /检查更新/, '版本页脚跟着设置栏');
  assert.ok(!/要我每轮都记得的那条/.test(settingsText), '设置栏里不该再出现记忆列表（那是另一栏的事）');

  // ④ 切 tab 是真的换状态：点第二个 tab 会调到 setTab（桩 setter 不重渲染，只验能点）
  assert.equal(typeof tabButtons[1].props.onClick, 'function', 'tab 必须可点');
  tabButtons[1].props.onClick();
  assert.ok(true);

  console.log('  ✅ 设置页分栏：两个 tab、默认记忆栏、另一栏 hidden、切换后各归各位');
});

// ═══════════════ 2026-11-24 客户端审计（docs/audit/2026-11-24/client.md）回归 ═══════════════
//
// 每条 finding 一条用例，全部断言**用户可见的行为**（不是实现细节）：
// 失败前这些用例确实会红（见交付说明里的逐条对照），修好之后才是绿的。
// 报告口径：F-CL-01..13；F-CL-01/02 是 high，其余 medium/low。

/** 卡片 props（补上真宿主一定会给的会话 / 回合 / useChat）。 */
function cardPropsFor(handle, { sessionId = 's1', turn = 1, turnOrder = [turn] } = {}) {
  const base = cardProps(handle);
  return {
    ...base,
    props: {
      ...base.props,
      sessionId,
      turn,
      useChat: (selector) => selector({ timeline: { turnOrder } }),
    },
  };
}

test('F-CL-01（high）：动作失败留在 actionError，成功的 list 刷新不许抹掉；行也不许提前摘', async () => {
  let failDismiss = true;
  const h = await loadClientHalf({
    value: {},
    dismissImpl: async () =>
      failDismiss
        ? { ok: false, error: { message: 'dismiss 失败：磁盘只读' } }
        : { ok: true, value: { ok: true } },
    suggestions: {
      groups: [
        { key: 'k1', seedTitle: '部署要走 scripts/deploy.sh', members: 1, memberTitles: ['部署入口'], score: 7, seen: false, useWhen: '部署时' },
      ],
      restCount: 0, restKeys: [], seen: 0, dismissed: 0, pendingDistill: [], pendingSkills: [],
    },
  });
  h.exports.apply(h.ctx);
  await settle();
  const { reg, face, props } = cardProps(h);

  const first = reg.Component(props);
  const button = findButton(first, props.t('suggestDismiss'));
  assert.ok(button, '卡片上要有「不用」按钮');
  await button.props.onClick();
  await settle();

  let snap = face.hooks.memfuseSuggestions.getSnapshot();
  assert.match(String(snap.actionError), /磁盘只读/, '动作失败的原因必须留下');
  assert.equal(snap.error, null, '动作失败不该冒充"通道坏了"');
  assert.match(textOfTree(reg.Component(props)), /部署要走 scripts\/deploy\.sh/, '失败时那一行必须还在（否则看起来像成功了）');

  // 渲染路径上的 touch() 发起一次**成功的** list —— 这正是原来把报错抹掉的那一步
  await refreshFeed(face);
  snap = face.hooks.memfuseSuggestions.getSnapshot();
  assert.equal(snap.status, 'ready', '刷新本身是成功的');
  assert.match(String(snap.actionError), /磁盘只读/, '成功的 list 刷新不许抹掉动作错误');
  const refreshedText = textOfTree(reg.Component(props));
  assert.match(refreshedText, /磁盘只读/, '刷新后卡片上仍然要看得见原始原因');

  // 下一次动作成功 → 才清掉 actionError，并且行才被摘掉
  failDismiss = false;
  const button2 = findButton(reg.Component(props), props.t('suggestDismiss'));
  await button2.props.onClick();
  await settle();
  snap = face.hooks.memfuseSuggestions.getSnapshot();
  assert.equal(snap.actionError, null, '下一次动作开始/成功后动作错误才清');
  assert.ok(!/部署要走 scripts\/deploy\.sh/.test(textOfTree(reg.Component(props))), '成功后才允许摘行');
  await h.dispose();
  console.log('  ✅ F-CL-01：动作错误独立存活；失败不摘行；成功才清');
});

test('F-CL-02（high）：记忆面板重试烧完后有「重新加载」按钮，不是死路', async () => {
  const h = await loadClientHalf({ value: {} });
  h.exports.apply(h.ctx);
  await settle();
  const { MemoryPanelFeed, MemoryPanel } = h.exports;

  let calls = 0;
  const feed = new MemoryPanelFeed({
    remote: { memfuse: { memories: async () => { calls += 1; throw new Error('client api: memfuse/memories failed: HTTP 500'); } } },
  });
  await feed.load();
  assert.equal(feed.store.getSnapshot().status, 'error');
  feed.retryCount = 3; // 3 次预算已经烧完（原来这里就是永久死路）

  const snap = feed.store.getSnapshot();
  const tree = MemoryPanel({
    t: h.t,
    useMemfuseMemoryPanel: (selector) => selector(snap),
    setFilter: () => {}, setPage: () => {}, setPriority: () => {}, revive: () => {},
    refresh: () => feed.reload(),
  });
  const retry = findButton(tree, h.t('panelRetry'));
  assert.ok(retry, '失败态必须有「重新加载」按钮（否则只能 F5 整个页面）');
  assert.match(textOfTree(tree), /HTTP 500/, '原始报错要摆出来');

  await retry.props.onClick();
  await settle();
  assert.equal(calls, 2, '点「重新加载」必须真的再发一次 memories');
  assert.equal(feed.store.getSnapshot().status, 'error', '仍失败就仍显示错误（不假装成功）');
  feed.dispose();
  await h.dispose();
  console.log('  ✅ F-CL-02：失败态可手动重新加载');
});

test('F-CL-03：筛选到 0 条说「没有匹配」，只有库真为空才说「记忆库里还没有内容」', async () => {
  const h = await loadClientHalf({ value: {} });
  h.exports.apply(h.ctx);
  await settle();
  const { MemoryPanel } = h.exports;
  const render = (view) =>
    MemoryPanel({
      t: h.t,
      useMemfuseMemoryPanel: (selector) => selector({ status: 'ready', view, busy: null, error: null, actionError: null, note: null }),
      setFilter: () => {}, setPage: () => {}, setPriority: () => {}, revive: () => {},
    });
  const base = {
    stats: { total: 10, active: 10, dormant: 0, residentCap: 8, residentCount: 0, residentOverflow: 0 },
    resident: [], overflow: [], rows: [], page: 1, pageSize: 50, pageCount: 1,
    residentMaxEntries: 8, residentMaxChars: 1200, readError: null,
  };
  for (const [name, filters] of [
    ['lifecycle', { query: '', priority: '', lifecycle: 'dormant', scope: '' }],
    ['priority', { query: '', priority: 'P2', lifecycle: '', scope: '' }],
    ['scope', { query: '', priority: '', lifecycle: '', scope: 'user' }],
  ]) {
    const text = textOfTree(render({ ...base, totalMatches: 0, filters }));
    assert.match(text, /没有匹配的记忆/, `${name} 筛到 0 条时必须说「没有匹配」`);
    assert.ok(!/记忆库里还没有内容/.test(text), `${name}：库里有 10 条，不许说库是空的`);
  }
  const emptyText = textOfTree(render({ ...base, stats: { ...base.stats, total: 0 }, totalMatches: 0, filters: { query: '', priority: '', lifecycle: '', scope: '' } }));
  assert.match(emptyText, /记忆库里还没有内容/, '库真的为空时才说「还没有内容」');
  await h.dispose();
  console.log('  ✅ F-CL-03：空态与「筛选无匹配」分开');
});

test('F-CL-04：常驻顺序不许显示裸 m_* 内部 id（翻页/搜索后也一样）', async () => {
  const h = await loadClientHalf({ value: {} });
  h.exports.apply(h.ctx);
  await settle();
  const { MemoryPanel } = h.exports;
  const view = {
    stats: { total: 12, active: 12, dormant: 0, residentCap: 8, residentCount: 3, residentOverflow: 0 },
    resident: ['m_aaa', 'm_bbb', 'm_ccc'],
    overflow: [],
    rows: [{ id: 'm_aaa', title: '甲：搜索命中的那条', summary: '', priority: 'P0', lifecycle: 'active', scope: 'workspace', kind: 'fact', updated: '2026-11-01T00:00:00Z', dormant: false, resident: true, overflow: false, reason: null, stats: { recalled: 0 } }],
    // 宿主将来若带 residentTitles 就用它（老宿主没有）
    residentTitles: { m_bbb: '乙：不在本页但有标题' },
    page: 1, pageSize: 50, pageCount: 2, totalMatches: 1,
    filters: { query: '部署', priority: '', lifecycle: '', scope: '' },
    residentMaxEntries: 8, residentMaxChars: 1200, readError: null,
  };
  const tree = MemoryPanel({
    t: h.t,
    useMemfuseMemoryPanel: (selector) => selector({ status: 'ready', view, busy: null, error: null, actionError: null, note: null }),
    setFilter: () => {}, setPage: () => {}, setPriority: () => {}, revive: () => {},
  });
  const text = textOfTree(tree);
  assert.match(text, /甲：搜索命中的那条/, '当前页内的常驻标题照常显示');
  assert.match(text, /乙：不在本页但有标题/, '宿主给了 residentTitles 就用它');
  assert.ok(!/m_aaa|m_bbb|m_ccc/.test(text), '常驻区绝不能出现裸 m_* id，实际：' + text);
  assert.match(text, /不在当前页/, '查不到标题时也要写人话，而不是内部 id');
  await h.dispose();
  console.log('  ✅ F-CL-04：常驻标题不回落裸 id');
});

test('F-CL-05：安装更新进行中「检查更新」禁用，且守卫挡住并发的 git fetch', async () => {
  let releaseInstall = null;
  const h = await loadClientHalf({
    value: {},
    updateImpl: async () => ({ ok: true, value: NEWER }),
    installImpl: () => new Promise((resolve) => { releaseInstall = resolve; }),
  });
  h.exports.apply(h.ctx);
  await settle();
  const { reg, face, props } = sectionProps(h);
  await face.checkUpdate();
  await settle();

  let tree = reg.Component(props);
  const install = findButton(tree, '安装更新');
  assert.ok(install, '查到新版本后要出现「安装更新」');
  install.props.onClick();
  await settle();

  tree = reg.Component(props);
  const check = findButton(tree, '检查更新');
  assert.ok(check, '「检查更新」按钮还在');
  assert.equal(check.props.disabled, true, '安装进行中「检查更新」必须禁用（git fetch 会抢 .git）');
  const before = h.remoteCalls.filter((c) => c[0] === 'checkUpdate').length;
  await face.checkUpdate();
  await settle();
  assert.equal(h.remoteCalls.filter((c) => c[0] === 'checkUpdate').length, before, '安装中 checkUpdate() 守卫必须直接返回');
  releaseInstall?.({ ok: true, value: { ok: true, changed: true, from: '0.1.0', to: '0.2.0' } });
  await settle();
  await h.dispose();
  console.log('  ✅ F-CL-05：安装/检查互斥（按钮 + 动作守卫）');
});

test('F-CL-06：设置页 tab 键盘可达（方向键/Home/End 切换并移动焦点）', async () => {
  const h = await loadClientHalf({ value: {}, suggestions: EMPTY_FEED });
  h.exports.apply(h.ctx);
  await settle();
  const { reg, face, props } = sectionProps(h);
  const tree = reg.Component(props);
  const bar = findAllByClass(tree, 'dsh-memfuse-tabs')[0];
  assert.equal(typeof bar.props.onKeyDown, 'function', 'tablist 必须有 keydown 处理器（WAI-ARIA tabs 模式）');

  const tabs = findAllByClass(tree, 'dsh-memfuse-tab');
  assert.equal(tabs[0].props.tabIndex, 0, '选中项 tabIndex=0');
  assert.equal(tabs[1].props.tabIndex, -1, '非选中项 tabIndex=-1（靠方向键进入）');

  const nextTabId = h.exports.__nextTabId;
  assert.equal(typeof nextTabId, 'function', '必须导出方向键映射（测试接缝）');
  assert.equal(nextTabId('memory', 'ArrowRight'), 'settings', 'ArrowRight 从「我的记忆」到「设置」');
  assert.equal(nextTabId('settings', 'ArrowLeft'), 'memory', 'ArrowLeft 从「设置」回「我的记忆」');
  assert.equal(nextTabId('memory', 'End'), 'settings');
  assert.equal(nextTabId('settings', 'Home'), 'memory');
  assert.equal(nextTabId('memory', 'Escape'), null, '别的键不归 tab 管');

  let focused = null;
  let prevented = false;
  bar.props.onKeyDown({
    key: 'ArrowRight',
    preventDefault() { prevented = true; },
    currentTarget: { ownerDocument: { getElementById: (id) => ({ focus() { focused = id; } }) } },
  });
  assert.equal(prevented, true, '方向键要 preventDefault（否则页面会滚动）');
  assert.equal(focused, 'dsh-memfuse-tab-settings', '切换后焦点要跟到新 tab');
  await h.dispose();
  console.log('  ✅ F-CL-06：tab 键盘可达');
});

test('F-CL-07：提炼进行中再点另一行 —— 不发 distill、第二行也不许被摘掉', async () => {
  let release = null;
  const h = await loadClientHalf({
    value: {},
    distillImpl: () => new Promise((resolve) => { release = resolve; }),
    suggestions: {
      groups: [
        { key: 'k1', seedTitle: '第一组：部署流程', members: 1, memberTitles: ['甲'], score: 7, seen: false, useWhen: '部署时' },
        { key: 'k2', seedTitle: '第二组：回滚流程', members: 1, memberTitles: ['乙'], score: 6, seen: false, useWhen: '回滚时' },
      ],
      restCount: 0, restKeys: [], seen: 0, dismissed: 0, pendingDistill: [], pendingSkills: [],
    },
  });
  h.exports.apply(h.ctx);
  await settle();
  const { reg, face, props } = cardProps(h);

  const tree = reg.Component(props);
  const buttons = findButtons(tree, props.t('suggestDistill'));
  assert.equal(buttons.length, 2, '两行候选就有两个「提炼成技能」按钮');
  buttons[0].props.onClick();
  await settle();
  assert.ok(face.hooks.memfuseSuggestions.getSnapshot().draftBusy, '第一行应进入提炼中');

  const second = findButtons(reg.Component(props), props.t('suggestDistill'));
  assert.equal(second.length, 2, '提炼中第二行必须还在（不许提前摘）');
  assert.equal(second[1].props.disabled, true, '提炼中第二行的按钮必须禁用');
  await second[1].props.onClick();
  await settle();
  assert.deepEqual(
    h.remoteCalls.filter((c) => c[0] === 'distill').map((c) => c[1]),
    ['k1'],
    '第二行不许静默发 distill，也不许被 busy 守卫拒绝后消失',
  );
  assert.match(textOfTree(reg.Component(props)), /第二组：回滚流程/, '第二行必须仍然可见（才能等会儿再点）');

  release?.({ ok: true, value: { ok: true, name: 's1', description: '', content: '', installPath: null } });
  await settle();
  assert.match(textOfTree(reg.Component(props)), /第二组：回滚流程/, '第一组完成后第二组还可以点');
  await h.dispose();
  console.log('  ✅ F-CL-07：busy 期间第二行不丢');
});

test('F-CL-08：提炼永不返回时超时清闩锁；也能「取消等待」恢复', async () => {
  const h = await loadClientHalf({
    value: {},
    distillImpl: () => new Promise(() => {}), // 宿主/网关永远不 settle
    suggestions: {
      groups: [{ key: 'k1', seedTitle: '部署要走 scripts/deploy.sh', members: 1, memberTitles: ['甲'], score: 7, seen: false, useWhen: '部署时' }],
      restCount: 0, restKeys: [], seen: 0, dismissed: 0, pendingDistill: [], pendingSkills: [],
    },
  });
  h.exports.apply(h.ctx);
  await settle();
  const { reg, face, props } = cardProps(h);
  h.exports.__actionBudget.ms = 40;

  const first = findButton(reg.Component(props), props.t('suggestDistill'));
  first.props.onClick();
  await settle();
  assert.ok(face.hooks.memfuseSuggestions.getSnapshot().draftBusy, '点击后应显示进行中');
  await new Promise((resolve) => setTimeout(resolve, 90));
  await settle();
  let snap = face.hooks.memfuseSuggestions.getSnapshot();
  assert.equal(snap.draftBusy, null, '超时后 draftBusy 必须被清掉（不能永久卡住）');
  assert.match(String(snap.actionError), /超时/, '超时要如实说（含原始原因）');

  // 手动取消：宿主不返回时用户不必干等 90 秒
  h.exports.__actionBudget.ms = 5000;
  const again = findButton(reg.Component(props), props.t('suggestDistill'));
  again.props.onClick();
  await settle();
  const cancel = findButton(reg.Component(props), props.t('draftCancelWait'));
  assert.ok(cancel, '进行中必须给「取消等待」按钮');
  cancel.props.onClick();
  await settle();
  snap = face.hooks.memfuseSuggestions.getSnapshot();
  assert.equal(snap.draftBusy, null, '取消后闩锁要清掉');
  assert.match(String(snap.actionError), /取消/, '取消要留一句说明（宿主可能还在跑）');
  // 装/丢不再被同一把闩锁挡住
  const rej = await face.rejectDraft('whatever');
  assert.equal(rej.ok, true, '取消之后装/丢必须能继续用');
  h.exports.__actionBudget.ms = 90_000;
  await h.dispose();
  console.log('  ✅ F-CL-08：超时 + 取消等待都可恢复');
});

test('F-CL-09：一个模型都没有时横幅必须 partial，不许写「记忆学习已开启」', async () => {
  const h = await loadClientHalf({
    value: { extract: { enabled: true, followConversation: true } },
    catalog: { ok: true, value: { default: null, routableProviders: [], groups: [], failures: [] } },
    suggestions: EMPTY_FEED,
  });
  h.exports.apply(h.ctx);
  await settle();
  const { reg, face, props } = sectionProps(h);
  const tree = reg.Component(props);
  const banner = findBanner(tree);
  assert.ok(banner, '设置页必须有学习横幅');
  assert.equal(banner.props['data-tone'], 'partial', '没有模型时必须是 partial（不是绿色 ready）');
  assert.match(textOfTree(banner), /没有可用的模型/, '要说清"没有模型、学不了"');
  assert.match(textOfTree(banner), /设置 → 模型/, '要告诉用户去哪儿配模型');
  assert.ok(!/记忆学习已开启/.test(textOfTree(tree)), '不许再写「记忆学习已开启」');
  assert.equal(findButton(banner, '跟随对话模型'), null, '跟随已经开着时不该再摆一个点了也没用的按钮');
  await h.dispose();
  console.log('  ✅ F-CL-09：无模型 → partial');
});

test('F-CL-10：中英文 panelHint 对「溢出 P0 仍可能被召回」必须一致（英文不许写 not injected）', async () => {
  const h = await loadClientHalf({ value: {}, suggestions: EMPTY_FEED });
  h.exports.apply(h.ctx);
  await settle();
  const dicts = h.dicts.get('settings.memfuse');
  assert.ok(dicts?.zh?.panelHint && dicts?.en?.panelHint, '两份字典都要有 panelHint');
  assert.ok(!/not injected/i.test(dicts.en.panelHint), '英文不许再写 "not injected"（与中文/spec 相反）');
  assert.match(dicts.en.panelHint, /relevant recall|recall can still pick/i, '英文要说明仍可能被相关召回');
  assert.match(dicts.zh.panelHint, /还能从相关召回|仍可能/, '中文保持"仍可能被召回"');
  assert.ok(!dicts.zh.panelHint.includes('**') && !dicts.en.panelHint.includes('**'), '纯文本里不许出现 Markdown 星号');
  assert.ok(!dicts.zh.panelOverflow.includes('**') && !dicts.en.panelOverflow.includes('**'), '溢出提示同样不许出现 **');
  await h.dispose();
  console.log('  ✅ F-CL-10：中英文口径一致');
});

test('F-CL-11：面板行元信息用本地化标签，纯文本里不出现 **', async () => {
  const h = await loadClientHalf({ value: {} });
  h.exports.apply(h.ctx);
  await settle();
  const { MemoryPanel } = h.exports;
  const view = {
    stats: { total: 1, active: 1, dormant: 0, residentCap: 8, residentCount: 0, residentOverflow: 0 },
    resident: [], overflow: [],
    rows: [{ id: 'm1', title: '一条记忆', summary: '', priority: 'P1', lifecycle: 'active', scope: 'workspace', kind: 'fact', updated: '2026-11-01T00:00:00Z', dormant: false, resident: false, overflow: false, reason: null, stats: { recalled: 2 } }],
    page: 1, pageSize: 50, pageCount: 1, totalMatches: 1,
    filters: { query: '', priority: '', lifecycle: '', scope: '' },
    residentMaxEntries: 8, residentMaxChars: 1200, readError: null,
  };
  const tree = MemoryPanel({
    t: h.t,
    useMemfuseMemoryPanel: (selector) => selector({ status: 'ready', view, busy: null, error: null, actionError: null, note: null }),
    setFilter: () => {}, setPage: () => {}, setPriority: () => {}, revive: () => {},
  });
  const text = textOfTree(tree);
  const json = JSON.stringify(tree);
  assert.match(text, /本工作区/, 'scope 要本地化（与筛选下拉一致）');
  assert.match(text, /事实/, 'kind 要本地化');
  assert.ok(!/\bworkspace\b/.test(text), '中文界面不许出现裸 workspace');
  assert.ok(!/\bfact\b/.test(text), '中文界面不许出现裸 fact');
  assert.ok(!json.includes('**'), '纯文本文案里不许出现 Markdown 星号（会原样显示）');
  await h.dispose();
  console.log('  ✅ F-CL-11：元信息本地化、无 **');
});

test('F-CL-12：待确认草稿不串会话 —— A 提炼的草稿不出现在 B 的卡片上', async () => {
  const h = await loadClientHalf({
    value: {},
    suggestions: {
      groups: [{ key: 'k1', seedTitle: '部署要走 scripts/deploy.sh', members: 1, memberTitles: ['甲'], score: 7, seen: false, useWhen: '部署时' }],
      restCount: 0, restKeys: [], seen: 0, dismissed: 0, pendingDistill: [], pendingSkills: [],
    },
  });
  h.exports.apply(h.ctx);
  await settle();
  const { reg, face } = cardProps(h);
  const a = cardPropsFor(h, { sessionId: 'session-A', turn: 1 });
  const distill = findButton(reg.Component(a.props), a.props.t('suggestDistill'));
  await distill.props.onClick();
  await settle();
  assert.equal(face.hooks.memfuseSuggestions.getSnapshot().drafts.length, 1);
  assert.match(textOfTree(reg.Component(a.props)), /ui-skill/, 'A 的卡片要看到自己的草稿');
  assert.equal(face.draftsFor('session-A').length, 1);
  assert.equal(face.draftsFor('session-B').length, 0, 'B 不许拿到 A 的草稿');

  const b = cardPropsFor(h, { sessionId: 'session-B', turn: 2, turnOrder: [1, 2] });
  const treeB = reg.Component(b.props);
  assert.ok(treeB === null || !/ui-skill/.test(textOfTree(treeB)), 'B 的卡片不许出现 A 的草稿正文');

  // 刷新页面后来源未知（磁盘真源）：显示，但必须明确标注「全局待确认」
  const h2 = await loadClientHalf({
    value: {},
    suggestions: {
      groups: [], restCount: 0, restKeys: [], seen: 0, dismissed: 0, pendingDistill: [],
      pendingSkills: [{ name: 'draft-global', description: '上次留下的', content: '---\nname: draft-global\n---\n', installPath: null }],
    },
  });
  h2.exports.apply(h2.ctx);
  await settle();
  const c = cardPropsFor(h2, { sessionId: 'session-C', turn: 1 });
  const treeC = reg.Component(c.props);
  assert.ok(treeC, '来源未知的草稿仍然要能看到（否则刷新后就永远装不了）');
  assert.match(textOfTree(treeC), /draft-global/);
  assert.match(textOfTree(treeC), /全局待确认/, '来源未知时必须标注它是全局的，不能假装属于本对话');
  await h.dispose();
  await h2.dispose();
  console.log('  ✅ F-CL-12：草稿按来源会话隔离 + 全局草稿明确标注');
});

test('F-CL-13：跟随+fallback 时策略排在降级模型之前，标签不再说「上面那个模型」', async () => {
  const h = await loadClientHalf({
    value: { extract: { enabled: true, followConversation: true, onUnavailable: 'fallback' } },
    suggestions: EMPTY_FEED,
  });
  h.exports.apply(h.ctx);
  await settle();
  const { reg, face, props } = sectionProps(h);
  const tree = reg.Component(props);
  const fields = findAllByClass(tree, 'dsh-memfuse-field');
  const labels = fields.map((field) => {
    const label = findAllByClass(field, 'dsh-memfuse-field-label')[0];
    return label ? textOfTree(label) : '';
  });
  const strategy = labels.findIndex((label) => label.includes('对话模型不可用时'));
  const fallback = labels.findIndex((label) => label.includes('降级模型（主模型不可用时）'));
  assert.ok(strategy >= 0, '策略字段必须出现（实际标签：' + labels.join(' | ') + '）');
  assert.ok(fallback >= 0, '降级模型字段必须出现');
  assert.ok(strategy < fallback, '策略要排在降级模型之前（否则「上面那个」指的是降级模型本身）');
  assert.ok(!labels.some((label) => label.includes('上面那个模型')), '不许再用依赖视觉位置的「上面那个模型」');
  await h.dispose();
  console.log('  ✅ F-CL-13：策略 → 降级模型，标签自洽');
});

test('渲染边界：summary 与 page 走同一套 hooks（防止 summary→page 切换报 hooks 数量变化）', async () => {
  const h = await loadClientHalf({ value: {}, suggestions: EMPTY_FEED });
  h.exports.apply(h.ctx);
  await settle();
  const { reg, face } = sectionProps(h);
  let calls = 0;
  const props = {
    t: h.t,
    view: 'summary',
    ...face,
    useMemfuseConfig: (selector) => { calls += 1; return selector(face.hooks.memfuseConfig.getSnapshot()); },
  };
  const text = reg.Component(props);
  assert.equal(typeof text, 'string', 'summary 仍然只返回一行说明');
  assert.equal(calls, 1, 'summary 也必须先走 hook —— 否则同一实例切到 page 时 hooks 数量会变，React 直接崩');
  await h.dispose();
  console.log('  ✅ 渲染边界：summary 也走 hooks');
});
