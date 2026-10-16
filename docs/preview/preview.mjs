/**
 * 回合尾候选卡片的**离线预览**运行时。
 *
 * 为什么要有这个东西：候选卡片只在真机上出现（要有够格的记忆簇、要重启 desktop），
 * 想在"没有候选"的机器上看一眼它的样子/流程，过去只能靠读代码。这个文件把
 * **真实的 `lib/client.js`**（同一个 bundle、同一段 CSS、同一个组件）塞进一个假页面里，
 * 用一份假宿主数据把它渲染出来，并且可以点那两个按钮看流程。
 *
 * 三条真实性保证：
 *   1. 渲染用的是 `lib/client.js` 里的 `MemfuseSuggestionCard` 本体，不是复制品；
 *   2. 文案走真实字典 + 真实插值（`{members}` 那种），所以"文案写成函数"这类错会当场炸；
 *   3. `ctx.remote.memfuse` 的访问**照样有注入校验** —— 根 ctx 拿不到它，
 *      必须走官方那套 `await $mount(...)` → `ctx.inject(['remote.memfuse'], …)`。
 *      （这条正是真机上"卡片永远不出现"的元凶，留在这里当活体回归。）
 *
 * 唯一的假：宿主那一侧（`list / markSeen / dismiss / requestDistill / distill / approve /
 * reject` 七个端点）是内存里的假数据（`distill` 还假了一个"模型写 SKILL.md"的固定产物），
 * 日志面板会把每次调用如实列出来。
 */

/** 演示用的候选（内容取自本项目真实场景，但数据是假的）。 */
const INITIAL_GROUPS = [
  {
    key: 'm_ui_9f2a',
    seedTitle: 'DSH 插件设置页四条件',
    members: 2,
    score: 7,
    useWhen: '写 DSH 插件的配置页时召回',
    reasons: ['跨 2 个会话被召回', '含步骤性内容', '用户反复纠正过'],
    seen: false,
  },
  {
    key: 'm_smoke_3c71',
    seedTitle: '冒烟夹具用 junction 挂进 profile，删目录即净',
    members: 3,
    score: 6,
    useWhen: '要在真机上验证 DSH 插件改动时召回',
    reasons: ['跨 3 个会话被召回', '含步骤性内容'],
    seen: false,
  },
  {
    key: 'm_card_5b90',
    seedTitle: '候选卡片的位置与显隐规则',
    members: 4,
    score: 5,
    useWhen: '改回合尾卡片的呈现方式时召回',
    reasons: ['跨 2 个会话被召回', '含步骤性内容'],
    seen: false,
  },
];

/**
 * 卡片一次最多显示几行 —— 与真宿主的 `skill.suggestMax`（默认 1）同口径。
 * 改这里等于改插件配置，演示里就写死成 1。
 */
const SUGGEST_MAX = 1;

/** 迷你 DOM 版 jsx 运行时（只用到 createElement / 文本 / 事件这几个 API）。 */
function makeJsxRuntime(document) {
  const appendChildren = (node, children) => {
    const list = Array.isArray(children) ? children : [children];
    for (const child of list) {
      if (child === null || child === undefined || child === false || child === true) continue;
      if (Array.isArray(child)) {
        appendChildren(node, child);
        continue;
      }
      if (typeof child === 'object' && typeof child.nodeType === 'number') {
        node.appendChild(child);
        continue;
      }
      node.appendChild(document.createTextNode(String(child)));
    }
  };

  const build = (type, props) => {
    // 组件就是普通函数（这个插件里没有 class 组件）
    if (typeof type === 'function') return type(props ?? {});
    const node = document.createElement(type);
    for (const [key, value] of Object.entries(props ?? {})) {
      if (key === 'children' || key === 'key' || value === undefined || value === null) continue;
      if (key === 'className') node.className = value;
      else if (key === 'htmlFor') node.htmlFor = value;
      else if (/^on[A-Z]/.test(key) && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (value === true) node.setAttribute(key, '');
      else if (value !== false) node.setAttribute(key, String(value));
    }
    appendChildren(node, props?.children);
    return node;
  };

  return { jsx: build, jsxs: build };
}

/** 极简快照 store（与 `@deepseek-ai/dsh-client-store` 的用法一致）。 */
function makeStore(initial, onSet) {
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
      onSet?.();
    },
  };
}

/**
 * 起一个预览。
 * @param opts.window   - 浏览器 window（或测试里的替身）
 * @param opts.document - 浏览器 document（或测试里的替身）
 * @param opts.bundle   - `lib/client.js` 塞进 `window.__ModuleLoader__` 的那份 bundle
 * @param opts.target   - 候选卡片要渲染进去的元素
 * @param opts.onLog    - 每行日志的回调（宿主调用、渲染、按钮动作）
 * @param opts.onState  - 宿主状态变化回调（面板用）
 */
export function startPreview({ window, document, bundle, target, onLog, onState }) {
  const log = (text) => onLog?.(text);
  // 兜底：预览页靠 `<script src="../../lib/client.js">` 把 bundle 交上来。
  // 路径不对/脚本没加载时，宁可当场说清楚，也别给一片白屏。
  if (!bundle || typeof bundle.factory !== 'function') {
    log('❌ 没拿到 lib/client.js 的 bundle —— 检查预览页里那句 <script src="../../lib/client.js"> 的路径');
    return { render: () => {}, scenario: () => {} };
  }
  const groups = new Map(INITIAL_GROUPS.map((group) => [group.key, { ...group }]));
  const seen = new Set();
  const dismissed = new Set();
  const pending = new Set();
  /** 待确认的技能草稿：`name -> {name, description, content, installPath}`（真宿主上是磁盘）。 */
  const drafts = new Map();

  const publishState = () =>
    onState?.({
      groups: [...groups.values()],
      seen: [...seen],
      dismissed: [...dismissed],
      pending: [...pending],
      drafts: [...drafts.values()],
    });

  const { jsx, jsxs } = makeJsxRuntime(document);

  /**
   * 假的"模型"：真宿主上这一步是 `distillSkill()` 调 LLM 写 SKILL.md（要几十秒）。
   * 预览页里给一份形状/字段完全一致的固定产物，让"点提炼 → 看到草稿 → 装/丢"整条流程
   * 都能离线走一遍 —— 这也是缺陷 25 要修的那一段。
   */
  const fakeSkillMd = (group) =>
    [
      '---',
      `name: preview-skill-${String(group.key).replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`,
      `description: "${group.useWhen ?? group.seedTitle}"`,
      '---',
      '',
      `# ${group.seedTitle}`,
      '',
      '## 什么时候用',
      group.useWhen ?? '（同 description）',
      '',
      '## 怎么做',
      '1. 先确认目标（这一步别跳过）。',
      '2. 按项目里既有的写法改，不要新造一套。',
      '3. 改完跑测试；真机改动再重启一次验证。',
      '',
      '## 反例',
      '- 只看文档不看宿主包源码 —— 契约以本机包为准。',
      '',
    ].join('\n');

  // ── 假宿主：七个端点，语义与 lib/index.js 里的实现一致 ────────────────
  const host = {
    list: async () => {
      // 与真宿主同口径：只看**没看过、也没在待提炼**的组，且最多给 `skill.suggestMax` 组
      // （默认 1）；其余把 key 交回去，卡片会一并记 seen（别改成排队刷屏）。
      const fresh = [...groups.values()].filter(
        (group) => !dismissed.has(group.key) && !seen.has(group.key) && !pending.has(group.key),
      );
      const shown = fresh.slice(0, SUGGEST_MAX);
      const restKeys = fresh.slice(SUGGEST_MAX).map((group) => group.key);
      log(
        `list → 显示 ${shown.length} 组（另有 ${restKeys.length} 组不显示：宿主按 skill.suggestMax=${SUGGEST_MAX} 限行，` +
          `它们的 key 一并交回，卡片会记「看过」不重复打扰）；待确认草稿 ${drafts.size} 份`,
      );
      return {
        ok: true,
        value: {
          groups: shown.map((group) => ({ ...group, seen: false })),
          restCount: restKeys.length,
          restKeys,
          seen: seen.size,
          dismissed: dismissed.size,
          pendingDistill: [...pending],
          pendingSkills: [...drafts.values()],
        },
      };
    },
    markSeen: async (keys) => {
      for (const key of keys) seen.add(key);
      log(`markSeen(${JSON.stringify(keys)}) → 已记「看过」：下一轮起这几组不再出现（不点也不打扰）`);
      publishState();
      return { ok: true, value: { ok: true } };
    },
    dismiss: async (key) => {
      dismissed.add(key);
      log(`dismiss(${JSON.stringify(key)}) → 已记「不用」：prompt 与卡片都不再提这一组`);
      publishState();
      return { ok: true, value: { ok: true } };
    },
    requestDistill: async (key) => {
      pending.add(key);
      log(`requestDistill(${JSON.stringify(key)}) → 记成待办：下一轮 Block E 会催模型去提炼`);
      publishState();
      return { ok: true, value: { ok: true } };
    },
    /**
     * 缺陷 25 的核心：界面上的「提炼成技能」**当场**把 SKILL.md 写出来（真宿主会调模型）。
     * 预览页里同步返回 —— 真宿主上是几十秒的模型调用，卡片会先显示"提炼中…"。
     */
    distill: async (key) => {
      const group = groups.get(key);
      if (!group) {
        log(`distill(${JSON.stringify(key)}) → ✗ 这一组已经不在列表里了`);
        return { ok: true, value: { ok: false, error: `这一组候选已经不在列表里了（key=${key}）` } };
      }
      const content = fakeSkillMd(group);
      const name = content.match(/^name: (.+)$/m)[1];
      const draft = {
        name,
        description: group.useWhen ?? '',
        content,
        installPath: `C:\\Users\\YOU\\.dsh\\skills\\${name}\\SKILL.md`,
      };
      drafts.set(name, draft);
      log(`distill(${JSON.stringify(key)}) → 模型写出 SKILL.md（${content.length} 字符）→ 进待确认队列：${name}`);
      publishState();
      return { ok: true, value: { ok: true, ...draft } };
    },
    approve: async (name) => {
      if (!drafts.has(name)) return { ok: true, value: { ok: false, error: `待确认技能里没有 "${name}"` } };
      drafts.delete(name);
      log(`approve(${JSON.stringify(name)}) → 已装进技能库（当轮即生效，不用重启）`);
      publishState();
      return { ok: true, value: { ok: true, name, markedSources: 2, visibleInHost: true } };
    },
    reject: async (name) => {
      drafts.delete(name);
      log(`reject(${JSON.stringify(name)}) → 草稿已丢掉`);
      publishState();
      return { ok: true, value: { ok: true, name } };
    },
  };

  // ── 假 ctx：**带注入校验**（和真 cordis 一样）──────────────────────────
  let tailEntry = null;
  const dicts = new Map();
  const translate = (ns, key, params) => {
    const template = dicts.get(ns)?.zh?.[key] ?? key;
    if (!params) return template;
    // 与官方 dsh-client-locale 一致：模板必须是字符串（写成函数会在这里炸）
    return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
  };

  const makeRemote = (allowed) => {
    const remote = {
      $on: () => () => {},
      /**
       * 挂载客户端贡献。⚠️ 真机上 `$mount` 内部要用 **调用方 ctx 的 `typert`**
       * （`callerCtx.typert.remotes.register`），没声明就抛
       * `cannot get property "typert" without inject` —— 预览页照样复刻，
       * 它同时是缺陷 18 的活体回归。
       */
      async $mount(contribution) {
        if (this.allowed?.has('typert') !== true) {
          throw new Error('cannot get property "typert" without inject');
        }
        log(`$mount(${contribution.package}) → 客户端贡献挂上（${contribution.descriptors.length} 个描述符）`);
        return () => {};
      },
      // 命名空间服务：**没注入就拿不到**（这正是真机上的坑）
      get memfuse() {
        if (!allowed.has('remote.memfuse')) {
          throw new Error('cannot get property "remote.memfuse" without inject');
        }
        return host;
      },
      allowed,
    };
    return remote;
  };

  /**
   * 卡片是**按回合**渲染的，所以预览也得有"回合"这个概念：
   *   · 同一个回合里反复渲染 → 卡片内容钉住不动（缺陷 23：那次空刷新撤不掉它）；
   *   · 换一个回合（`nextTurn()` / 任何场景按钮）→ 才可能拿到新的一组。
   * 不这么模拟的话，预览会把"同一回合的刷新"当成"下一轮"，演示出来的语义正好是反的。
   */
  let turnSeq = 1;

  const render = () => {
    if (tailEntry === null) return;
    const face = tailEntry.options.inject();
    const props = {
      t: (key, params) => translate(tailEntry.options.locale, key, params),
      ...face,
      turn: turnSeq,
      sessionId: 'preview',
      useMemfuseSuggestions: (selector) => selector(face.hooks.memfuseSuggestions.getSnapshot()),
    };
    const node = tailEntry.Component(props);
    if (node === null || node === undefined) {
      const empty = document.createElement('p');
      empty.className = 'tail-empty';
      empty.textContent = '（这里什么都没有 —— 没有候选时卡片就是 null，不占位置）';
      target.replaceChildren(empty);
      return;
    }
    target.replaceChildren(node);
  };

  const scheduleRender = () => {
    // 卡片自己带 1.5s 去抖，这里跟着上一次渲染排一次，避免抖动
    window.setTimeout?.(render, 0) ?? render();
  };

  const ROOT_INJECT = ['slots', 'locale', 'configForms', 'remote', 'remote.session'];
  const makeCtx = (allowed) => {
    const ctx = {
      locale: {
        bind: (ns) => (key, params) => translate(ns, key, params),
        register: (ns, value) => {
          dicts.set(ns, value);
          return () => {};
        },
      },
      effect: (fn) => {
        const disposer = fn();
        return typeof disposer === 'function' ? disposer : () => {};
      },
      slots: {
        inject: (_name, cb) => cb(),
        register: (options, Component) => {
          if (options.name === 'conversation.chat.turnTail') {
            tailEntry = { options, Component };
            log(`注册回合尾卡片：${options.name} # ${options.id}（order ${options.order}）`);
            scheduleRender();
          }
          return () => {};
        },
      },
      configForms: {
        // 这一页只演示候选卡片，配置表单给个空壳，别让 apply() 挂掉
        get: () => ({ getSnapshot: () => ({ status: 'ready', writable: true, revision: 0, value: {}, base: {}, user: {} }), subscribe: () => () => {}, mutate: async () => true }),
        whileServed: (_namespaces, register) => register(new Set()),
      },
      remote: makeRemote(allowed),
      /**
       * 运行时注入：子 ctx 声明了依赖才拿得到点号服务。
       * 与真 cordis 的差别只有一处 —— 这里同步回调（真实现是服务就绪后回调），
       * 因为预览里"服务"在 `$mount` 之后本来就已经在了。
       */
      inject: (deps, cb) => {
        // 子 ctx 声明什么就允许什么（`typert` 与点号服务一视同仁）
        const childAllowed = new Set([...allowed, ...deps]);
        log(`ctx.inject([${deps.join(', ')}]) → 子 ctx 拿到：${deps.join(' + ')}`);
        const result = cb(makeCtx(childAllowed));
        return { then: (ok, err) => Promise.resolve(result).then(ok, err), dispose: async () => {} };
      },
    };
    return ctx;
  };

  const require = (name) => {
    if (name === 'react/jsx-runtime') return { jsx, jsxs };
    if (name === '@deepseek-ai/dsh-client-ui-primitives') {
      return { SettingsForm: 'SettingsForm', SettingsValueField: 'SettingsValueField', SegmentedControl: 'SegmentedControl', Checkbox: 'Checkbox' };
    }
    if (name === '@deepseek-ai/dsh-client-store') return { createSnapshotStore: (initial) => makeStore(initial, scheduleRender) };
    throw new Error(`预览里没有桩这个模块：${name}`);
  };

  const client = bundle.factory(require);
  client.apply(makeCtx(new Set(ROOT_INJECT)));
  publishState();

  return {
    /** 卡片重新渲染一次（去抖之后的刷新用）。 */
    render,
    /**
     * 进到下一回合。
     * 卡片的内容是**按回合**钉住的（缺陷 23），所以"不点它也不再出现"这件事
     * 必须换一个回合才演示得出来 —— 同一个回合里它本来就该一直在。
     */
    nextTurn() {
      turnSeq += 1;
      log(`进入下一回合（turn ${turnSeq}）`);
      return render();
    },
    /**
     * 场景按钮用：改宿主状态、进下一回合，然后等过卡片的 1.5s 去抖再刷一次。
     * @param mutate - 收一个可变状态，改它
     */
    scenario(label, mutate) {
      mutate({
        add(group) {
          groups.set(group.key, { ...group, seen: false });
        },
        grow(key, extraMembers) {
          const group = groups.get(key);
          if (group) {
            group.members += extraMembers;
            group.key = `${key}+${extraMembers}`; // 成员变了 → key 变 → 视为新的一组
            groups.set(group.key, group);
            groups.delete(key);
            seen.delete(key);
            dismissed.delete(key);
          }
        },
        reset() {
          groups.clear();
          for (const group of INITIAL_GROUPS) groups.set(group.key, { ...group });
          seen.clear();
          dismissed.clear();
          pending.clear();
          drafts.clear();
        },
      });
      log(`场景：${label}`);
      turnSeq += 1; // 场景 = "下一轮再看"（卡片按回合钉内容，见 render 上面的注释）
      publishState();
      window.setTimeout?.(render, 1600) ?? render();
    },
  };
}
