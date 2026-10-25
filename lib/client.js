/**
 * dsh-memfuse 的 **client half**（浏览器半边）。
 *
 * 为什么必须要有这个文件：宿主侧的 `Config` schema 只让 DSH 的 **describe 接口**
 * 认得这个插件（`Config.listConfigs` → `status: "schema"`），但**设置界面不会自动
 * 渲染它**。实测（2026-10-15，桌面版 0.2.0-rc.2）：
 *
 *   - 「设置 → 内置插件」= 只读清单（`dsh-client-ui-settings-plugins` 自己的说明写着
 *     "Inspect the plugins this deployment ships"，只挂了一个 `all` tab）；
 *   - 真正的配置页在 **「插件」页**，靠 `plugins.bundle.config` / `plugins.row.config`
 *     这两个 keyed slot 渲染 —— 而它们的 **occupants 是空的**：
 *     `cordis_inspect_query(client, Slots, listSubTree, {root:'plugins.row.config'})`
 *     → `"occupants": []` / `keyDomain: "none are taken yet"`。
 *
 * 结论：**没有 client half 的插件，在 UI 上根本无处可配**。
 *
 * ⚠️ 2026-10-17 追加：插件页仍是二级目录（设置 → 插件 → 找到这张卡），用户找不到。
 * 现在**主入口**是 `settings.section` —— 设置页左侧导航里独立的一页「记忆」，
 * 与「账号 / 通用 / 模型 / 插件 / Agent 预设」并列；插件页那两处保留（老书签/习惯）。
 * 三处渲染的是**同一个** `MemfuseConfigCardView`，草稿与保存只有一份实现。
 *
 * 约定（照 `dsh-client-ui-settings-web-search` 抄的）：
 *   - 注册进 `plugins.row.config`，key = `<包名>#<bundle patch 里的 row id>`
 *     = `dsh-memfuse#dsh-memfuse`；
 *   - 用 `configForms.whileServed([ns])` 包起来：宿主不提供这个 namespace 时不留痕迹；
 *   - `view: 'summary'` 返回一行说明，`view: 'page'` 返回表单；
 *   - 写回走 `scope.mutate(ops)`，宿主按 `isVolatilePath()` 校验 ——
 *     **只有声明了 `.volatile()` 的字段可写**。
 *
 * 模型从哪来：和对话框里那个模型选择器**同一个数据源** ——
 * `remote.session.modelCatalog()`（宿主 `buildModelCatalog()` 的产物：
 * `{ default, routableProviders, groups: [{id, name, models: [{id, name}]}], failures }`）。
 * 用原生 `<select>` 渲染（官方「设置 → 模型」页也是用原生 select，见
 * `dsh-client-ui-settings-models` 的 `_input` 样式），不引入弹层定位的复杂度。
 *
 * ── 为什么这个文件不拆成多个文件 ──────────────────────────────────────────
 * 宿主 `dsh-client-modules` 把 `exports["./client"]` 解析成**一个** clientPath、
 * 一次 `readFileSync` 读成 bundle 拼进 combo script；加载器**不支持相对 require**
 * （只认平台种子词 / 已物化模块 / 已注册的包工厂）。唯一多文件通路
 * `require.async('./client.<name>.js')` 是**异步**的（工厂是同步的），而且
 * chunk 的 rev 只由**入口文件**的 stat 算 —— 改 chunk 不改入口 → rev 不变 →
 * `IMMUTABLE_CACHE` → 浏览器继续吃旧文件。详见 `docs/HANDOFF.md` §2.1。
 * 所以这里保持单文件；可读性靠下面这份分节目录。
 *
 * ── 分节目录（行号会漂，用锚点搜）─────────────────────────────────────────
 *   1. 工厂头与常量 .............. `window.__ModuleLoader__.load` / `DICT` / `ROW_KEY`
 *   2. 样式 ...................... `const CSS = [`
 *   3. 配置字段表 ................ `const FIELDS = [`
 *   4. 小工具 .................... `keyOf` / `pathsOf` / `pairId` / `at` / `textOf`
 *   5. 模型目录 → 下拉选项 ....... `optionGroups`
 *   6. 三个字段控件 .............. `ModelPicker` / `EnumField` / `BoolField`
 *   7. 设置页卡片 ................ `MemfuseConfigCardView`（三处入口共用 + 学习横幅）
 *   8. 远程通道：描述符 .......... `strictCodec` / `asName` / `jsonParam` / `remoteDescriptors`
 *   9. 远程通道：宿主贡献 ........ `remoteContribution`（8 个端点 + codec 表）
 *  10. 卡片状态 .................. `pinnedCard` / `unpinRow` / `setCardNote` / `turnIdOf`
 *  11. 候选卡片组件 .............. `MemfuseSuggestionCard`（两段式：提炼 → 草稿 → 装/丢）
 *  12. 字典 ...................... `const zh = {` / `const en = {`
 *  13. 装配 ...................... `function apply(ctx)`
 */
window.__ModuleLoader__.load({
  id: 'dsh-memfuse',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const { jsx, jsxs } = require('react/jsx-runtime');
    const P = require('@deepseek-ai/dsh-client-ui-primitives');
    const { createSnapshotStore } = require('@deepseek-ai/dsh-client-store');

    /** 必需的客户端服务。 */
    const inject = ['slots', 'locale', 'configForms', 'remote', 'remote.session'];

    /** 字典命名空间（与下面的**配置命名空间**是两回事）。 */
    const DICT = 'settings.memfuse';
    /** 宿主侧插件条目 id —— 也就是 `configForms.get()` 要的 namespace。 */
    const CONFIG_NS = 'dsh-memfuse';
    /** `<包名>#<row id>`，两个都是 dsh-memfuse。 */
    const ROW_KEY = `${CONFIG_NS}#${CONFIG_NS}`;
    /**
     * 设置页一级入口（`settings.section`）的 id 与位置。
     *
     * id 用**自己的包名**：官方注释写明「复用已有 id = 顶掉人家那一页」。
     * order 25：内置页是 -10/0/10/15/20，本机其它第三方页是 35/40 ——
     * 25 落在「Agent 预设」之后、其它第三方页之前（挨着内置页，好找）。
     */
    const SETTINGS_SECTION_ID = CONFIG_NS;
    const SETTINGS_SECTION_ORDER = 25;

    // 一点点样式：复用 shell 的 design token，暗色亮色都跟着走。
    const CSS = [
      '.dsh-memfuse-field{display:flex;flex-direction:column;gap:6px;padding:10px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}',
      '.dsh-memfuse-field:last-of-type{border-bottom:none}',
      '.dsh-memfuse-field-label{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}',
      '.dsh-memfuse-field-hint{color:var(--dsw-alias-label-secondary);margin:0;font-size:12px;line-height:18px}',
      '.dsh-memfuse-row{display:flex;align-items:center;gap:10px}',
      '.dsh-memfuse-select{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);height:32px;font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);padding:0 8px;max-width:320px;min-width:220px}',
      '.dsh-memfuse-select:disabled{opacity:.5;cursor:default}',
      '.dsh-memfuse-select:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}',
      '.dsh-memfuse-clear{border:none;background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer;font:inherit;font-size:12px;line-height:18px;padding:2px 6px;border-radius:var(--dsw-radius-sm)}',
      '.dsh-memfuse-clear:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dsh-memfuse-note{color:var(--dsw-alias-label-tertiary);margin:12px 0 0;font-size:12px;line-height:18px}',
      // 页脚：版本 + 检查更新 + GitHub 点赞
      '.dsh-memfuse-footer{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:14px;padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.dsh-memfuse-footer-version{margin-right:auto;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      'a.dsh-memfuse-card-button{display:inline-flex;align-items:center;text-decoration:none}',
      '.dsh-memfuse-card-button:disabled{opacity:.5;cursor:default}',
      '.dsh-memfuse-tag{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      // 分组标题：设置页从「一列开关」变成「三段可读的说明」
      '.dsh-memfuse-group{margin:18px 0 2px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);font-weight:600}',
      '.dsh-memfuse-group:first-of-type{margin-top:0}',
      // 记忆学习横幅：三态（未开启 / 开了但没模型 / 已开启）
      '.dsh-memfuse-banner{display:flex;flex-direction:column;gap:6px;border:.5px solid var(--dsw-alias-border-l3);border-left-width:3px;border-radius:var(--dsw-radius-md);padding:10px 12px;margin:0 0 14px;background:var(--dsw-alias-bg-layer-1)}',
      '.dsh-memfuse-banner[data-tone="off"]{border-left-color:var(--dsw-alias-state-warn-primary)}',
      '.dsh-memfuse-banner[data-tone="partial"]{border-left-color:var(--dsw-alias-state-warn-primary)}',
      '.dsh-memfuse-banner[data-tone="ready"]{border-left-color:var(--dsw-alias-state-success-primary)}',
      '.dsh-memfuse-banner-title{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);font-weight:600}',
      '.dsh-memfuse-banner-body{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-memfuse-banner-actions{display:flex;gap:8px;margin-top:2px}',
      '.dsh-memfuse-banner-button{border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border-radius:var(--dsw-radius-sm);font:inherit;font-size:12px;line-height:18px;padding:3px 12px;cursor:pointer}',
      '.dsh-memfuse-banner-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-memfuse-banner-button:disabled{opacity:.5;cursor:default}',
      // 回合尾部的候选卡片
      //
      // ⚠️ 按钮**绝不能换行**（真机反馈「提炼和拒绝的按钮描述都换行了」）：
      // 中文按钮没有"词"的概念，容器一窄就一个词一行。所以
      //   ① 按钮自己 `white-space:nowrap` + `flex:0 0 auto`；
      //   ② 外层允许换行，但换的是**整块按钮**（掉到下一行），不是按钮内部。
      '.dsh-memfuse-card{border:.5px solid var(--dsw-alias-settings-card-stroke);background:var(--dsw-alias-settings-card-fill);border-radius:var(--dsw-radius-lg);padding:12px 14px;display:flex;flex-direction:column;gap:10px;max-width:720px}',
      '.dsh-memfuse-card-title{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.dsh-memfuse-card-row{display:flex;flex-wrap:wrap;align-items:flex-start;gap:8px 12px}',
      '.dsh-memfuse-card-main{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 8px;min-width:0;flex:1 1 240px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}',
      '.dsh-memfuse-card-meta{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.dsh-memfuse-card-actions{margin-left:auto;display:inline-flex;gap:6px;flex:0 0 auto}',
      '.dsh-memfuse-card-button{border:.5px solid var(--dsw-alias-border-l3);background:0 0;color:var(--dsw-alias-label-primary);border-radius:var(--dsw-radius-sm);font:inherit;font-size:12px;line-height:18px;padding:3px 12px;cursor:pointer;white-space:nowrap;flex:0 0 auto}',
      '.dsh-memfuse-card-button:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-memfuse-card-button[data-variant="primary"]{border-color:var(--dsw-alias-brand-primary,var(--dsw-alias-border-l3));color:var(--dsw-alias-brand-primary,var(--dsw-alias-label-primary))}',
      '.dsh-memfuse-card-button[data-variant="ghost"]{border-color:transparent;color:var(--dsw-alias-label-secondary)}',
      '.dsh-memfuse-card-hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      // 一组候选 = 一块（标题 + 成员 + 适用场景 + 好处）。组之间用细线隔开。
      '.dsh-memfuse-suggest{display:flex;flex-direction:column;gap:6px;padding-top:10px;border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.dsh-memfuse-suggest-top{display:flex;flex-wrap:wrap;align-items:flex-start;gap:8px 12px}',
      '.dsh-memfuse-suggest-seed{margin:0;flex:1 1 240px;min-width:0;font-size:14px;line-height:22px;font-weight:600;color:var(--dsw-alias-label-primary);word-break:break-word}',
      '.dsh-memfuse-suggest-line{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);word-break:break-word}',
      '.dsh-memfuse-suggest-why{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);border-radius:var(--dsw-radius-sm);padding:6px 8px}',
      // 草稿预览（缺陷 25）：用户要看的是**提示词本体**，所以要能滚、要等宽
      '.dsh-memfuse-card-draft{display:flex;flex-direction:column;gap:8px;border-top:.5px solid var(--dsw-alias-border-l2);padding-top:10px}',
      // ⚠️ `.dsh-memfuse-card-main` 是给**横排**写的（`flex:1 1 240px`）。草稿面板是竖排，
      // 直接复用会让这一行在纵轴方向占掉 240px —— 截图上表现为「技能名」和正文之间一大块空白。
      '.dsh-memfuse-card-draft .dsh-memfuse-card-main{flex:0 0 auto}',
      '.dsh-memfuse-card-skill{margin:0;max-height:260px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);padding:8px}',
    ].join('');
    const CSS_ID = 'dsh-memfuse/client.css';
    if (
      typeof document !== 'undefined' &&
      document.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_ID)}]`) === null
    ) {
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-memfuse';
      tag.dataset.pluginCss = CSS_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    /**
     * 表单字段。
     *
     * ⚠️ 官方 `SettingsFormModel` 只支持**顶层扁平字段**
     * （`sectionValue(field) = snapshot.value?.[field]`、写回 `path:[field]`），
     * 而我们的配置是嵌套的 `extract.*`。所以这里自己管草稿，
     * 用 `scope.mutate([{op:'set', path:['extract','provider'], value}])` 写回 ——
     * 这条路径照样过宿主的 volatile 校验。
     *
     * 顺序就是页面上的顺序：**最省事的选择放最前**（跟随对话模型 → 挑模型）。
     */
    const FIELDS = [
      {
        key: 'enabled',
        kind: 'bool',
        group: 'learn',
        path: ['extract', 'enabled'],
        label: '开启记忆学习（用 LLM 抽取）',
        hint:
          '默认开启。只有开着，插件才会把对话里的问答提炼成记忆 —— 这才是「学习」。' +
          '关掉不影响记忆的读写、注入、检索与技能判定，只是不再从会话里自动学新东西。',
      },
      {
        key: 'follow',
        kind: 'bool',
        group: 'learn',
        path: ['extract', 'followConversation'],
        label: '跟随对话模型',
        hint: '默认开启：直接用「对话框里选的那个模型」，主模型换了它跟着换，不用在这里再选一遍。',
      },
      {
        key: 'model',
        kind: 'picker',
        group: 'learn',
        providerPath: ['extract', 'provider'],
        modelPath: ['extract', 'model'],
        label: '抽取用的模型',
        hint:
          '勾了「跟随对话模型」时，这一项只在主模型不可用时当降级目标；' +
          '不勾跟随，就必须在这里挑一个 —— 否则抽取无从下手（记忆不会学习）。',
      },
      {
        key: 'onUnavailable',
        kind: 'enum',
        group: 'fallback',
        path: ['extract', 'onUnavailable'],
        label: '上面那个模型不可用时',
        hint: 'stop = 记下失败并在每轮注入里报出来；fallback = 改用降级目标（只降一次）。',
        options: [
          { value: 'stop', label: 'stop（记下失败）' },
          { value: 'fallback', label: 'fallback（改用降级目标）' },
        ],
      },
      {
        key: 'fallback',
        kind: 'picker',
        group: 'fallback',
        providerPath: ['extract', 'fallbackProvider'],
        modelPath: ['extract', 'fallbackModel'],
        label: '降级模型',
        hint: '主模型不可用时改用它。留空 = 跟随「对话主模型」。',
        clearable: true,
      },
      {
        key: 'mode',
        kind: 'enum',
        group: 'output',
        path: ['extract', 'mode'],
        label: '抽到候选后怎么落盘',
        hint: 'suggest = 先进待确认队列等你批准；auto = 直接写入。',
        options: [
          { value: 'suggest', label: 'suggest（先确认）' },
          { value: 'auto', label: 'auto（直接写入）' },
        ],
      },
      // 这一项**不属于抽取**：它零 LLM，与上面那些「用不用模型」无关。
      // 单独放一条并写清"不调模型"，免得用户以为要配了模型才生效。
      {
        key: 'skillSuggest',
        kind: 'bool',
        group: 'output',
        path: ['skill', 'suggest'],
        label: '记忆够格时提示「可提炼成技能」',
        hint:
          '默认开启。**不调用模型** —— 只列出这组记忆的作用与成员，你点头了才会生成技能草稿；' +
          '说"不用"就不再提这一组（它长大后会再提一次）。',
      },
    ];

    /**
     * 分组标题（顺序 = 页面顺序）。
     *
     * 为什么分组：原来七行开关平铺，「开关」和「进阶降级」混在一起，用户看不出
     * 哪几个是"让记忆开始学习"的必要条件。现在第一组就是那三件事。
     */
    const GROUPS = [
      { id: 'learn', key: 'groupLearn' },
      { id: 'fallback', key: 'groupFallback' },
      { id: 'output', key: 'groupOutput' },
    ];

    const keyOf = (path) => path.join('.');
    const fieldId = (key) => `plugin-config-dsh-memfuse-${key}`;
    /** 一批 op 落在哪些路径上（保存失败时给用户看的线索）。 */
    const pathsOf = (ops) => ops.map((op) => op.path.join('.')).join('、');
    /** 模型选择的取值编码：`provider#model`。 */
    const pairId = (provider, model) => `${provider}\u0000${model}`;

    /** 沿路径取一个嵌套值；中间缺环就返回 undefined。 */
    function at(root, path) {
      let node = root;
      for (const key of path) {
        if (node === null || typeof node !== 'object') return undefined;
        node = node[key];
      }
      return node;
    }

    /** 值 → 输入框里的文本（null/undefined 都当空）。 */
    const textOf = (value) => (value === null || value === undefined ? '' : String(value));

    /** 目录里的模型展平成一维选项（provider 分组保留在 optgroup 里）。 */
    function optionGroups(catalog) {
      return (catalog?.groups ?? []).map((group) => ({
        id: group.id,
        label: group.name || group.id,
        models: (group.models ?? []).map((model) => ({
          id: model.id,
          label: model.name || model.id,
        })),
      }));
    }

    /**
     * 「插件」页那一行的配置卡：宿主配置表单的作用域 + 本页的草稿 + 模型目录。
     */
    class MemfuseConfigCard {
      /**
       * @param scope - `configForms.get('dsh-memfuse')`，即宿主配置表单。
       * @param ctx - **本插件自己的**浏览器上下文。
       *
       * ⚠️ 远程调用必须用**自己的** ctx，不能用 `scope.ctx`：
       * `ConfigFormController.ctx` 是**提供方**（`dsh-client-ui-settings`）的 fiber
       * （源码注释原文："The PROVIDING fiber … letting a shared form write through the
       * caller's context would make every caller declare `remote.settings` in its own inject"），
       * 而它的 inject 只有 `['remote', 'remote.settings']` —— 里面**没有** `remote.session`。
       * 拿它去调 `modelCatalog()` 会撞上 cordis 的
       * `cannot get property "session" without inject`，结果就是模型列表永远读不出来。
       * 真机上就是这么翻车的（截图里那个"读不到模型列表"）。
       */
      constructor(scope, ctx) {
        this.scope = scope;
        this.ctx = ctx;
        this.drafts = new Map();
        this.listeners = new Set();
        this.saving = false;
        this.failed = false;
        /** 最近一次保存被拒时能看到的线索（改过哪些路径 + 原始报错）。 */
        this.saveError = null;
        /** 最近一次保存成功过 —— 用来在表单上写「已保存 ✓」。 */
        this.saved = false;
        /** 界面数据通道（Remote）挂载失败的原因；成功则 null。 */
        this.remoteError = null;
        /** 候选卡片数据源的实时状态（由 feed 推送，见 `apply()`）—— 卡片不出现时的唯一线索。 */
        this.feed = null;
        /**
         * 声明过 `remote.memfuse` 的**子 ctx**（由 `apply()` 在挂载后回填）。
         *
         * ⚠️ 不能直接用 `this.ctx.remote.memfuse`：根 ctx 的 inject 里没有这个点号服务，
         * cordis 会抛 `cannot get property "remote.memfuse" without inject`（缺陷 15）。
         */
        this.remoteCtx = null;
        /** 页脚用：版本号 + 仓库地址。由 `list` 带回（宿主读 package.json，客户端别硬编码）。 */
        this.info = { version: null, runningVersion: null, repoUrl: null };
        /**
         * 「检查更新 / 安装更新」的状态机（用户点按钮才跑）：
         * `{status: 'idle'|'checking'|'done'|'error', data, error, install}`。
         * `data` 形状见 `lib/update.js` 的 `checkUpdate()`；
         * `install` 是**安装**那一路的独立状态（`{status:'running'|'done'|'error', result, error}`）——
         * 两件事分开放，是因为"安装"的结论比"检查"新：装完之后检查结果里那句
         * 「落后 N 次提交」必须被「已更新到 vX —— 重启后生效」盖掉。
         */
        this.update = { status: 'idle', data: null, error: null, install: null };
        this.catalog = { status: 'loading', groups: [], error: null };
        this.unsubscribe = scope.subscribe(() => this.publish());
        this.store = this.bind(() => this.projection());
      }

      /** 释放订阅（由 ctx.effect 在卸载时调用）。 */
      dispose() {
        this.unsubscribe();
        this.listeners.clear();
      }
      snapshotOf() {
        return this.scope.getSnapshot();
      }

      /** 当前值（宿主已接受的那一份）。 */
      valueAt(path) {
        return at(this.snapshotOf().value, path);
      }

      /** 用户层是否显式写过这个路径 —— 决定要不要显示「重置 / 清除」。 */
      overriddenAt(path) {
        const user = this.snapshotOf().user;
        if (user === null || typeof user !== 'object') return false;
        const parent = at(user, path.slice(0, -1));
        return parent !== null && typeof parent === 'object'
          ? Object.hasOwn(parent, path[path.length - 1])
          : false;
      }

      /** 一个字段的显示态：文本（考虑草稿）、是否被用户层覆盖、是否还没保存。 */
      fieldState(path) {
        const draft = this.drafts.get(keyOf(path));
        const current = textOf(this.valueAt(path));
        return {
          text: draft === undefined ? current : draft.text,
          overridden: this.overriddenAt(path),
          changed: draft !== undefined && draft.text !== current,
        };
      }

      /** 一对路径的显示态（模型选择器要同时看 provider 与 model）。 */
      pairState(providerPath, modelPath) {
        const provider = this.fieldState(providerPath).text.trim();
        const model = this.fieldState(modelPath).text.trim();
        return { provider, model, value: provider && model ? pairId(provider, model) : '' };
      }

      /** 布尔字段的显示态。 */
      boolState(path) {
        const draft = this.drafts.get(keyOf(path));
        const current = this.valueAt(path) === true;
        return {
          checked: draft === undefined ? current : draft.value === true,
          overridden: this.overriddenAt(path),
        };
      }

      /** 整个表单的投影：外壳状态 + 每个字段。 */
      projection() {
        const fields = {};
        for (const field of FIELDS) {
          if (field.kind === 'bool') fields[field.key] = this.boolState(field.path);
          else if (field.kind === 'picker') fields[field.key] = this.pairState(field.providerPath, field.modelPath);
          else fields[field.key] = this.fieldState(field.path);
        }
        return { ...this.shell(), fields, catalog: this.catalog, info: this.info, update: this.update };
      }

      /**
       * 把草稿变成宿主能接受的 ops。
       *
       * 两种草稿：`{ text }`（字符串控件：模型选择、枚举）与 `{ value }`（真值：
       * **布尔必须给布尔**，给 `'true'` 会被 schema 拒掉）。空文本 = 清掉这一项
       * （回落默认值），而不是写一个空字符串。
       *
       * 模型选择器一次改两个路径（provider + model），所以这里天然支持多草稿；
       * 一次保存把它们合并成**一次** `mutate`（宿主按 revision 做乐观并发）。
       */
      ops() {
        const ops = [];
        for (const [key, draft] of this.drafts) {
          const path = key.split('.');
          const current = this.valueAt(path);
          if (Object.hasOwn(draft, 'value')) {
            if (draft.value === current) continue;
            ops.push({ op: 'set', path, value: draft.value });
            continue;
          }
          const text = draft.text.trim();
          if (text === textOf(current)) continue;
          if (text === '') {
            if (this.overriddenAt(path)) ops.push({ op: 'unset', path });
            continue;
          }
          ops.push({ op: 'set', path, value: text });
        }
        return ops;
      }

      /** 表单外壳状态（`SettingsForm` 直接读这些）。 */
      shell() {
        const snapshot = this.snapshotOf();
        const ops = this.ops();
        return {
          available: snapshot.status === 'ready',
          writable: snapshot.writable,
          dirty: ops.length > 0,
          invalid: false,
          saving: this.saving,
          failed: this.failed,
          // 「保存」在没有改动时是**禁用**的（官方 `SettingsForm` 的既定行为：
          // `blocked = !dirty || invalid || saving`）。灰着不解释会让人以为坏掉了，
          // 所以把状态也交出去，由视图写一行字说明。
          saved: this.saved,
          // 保存被拒时的线索（官方 controller 把宿主原话丢了，这里至少给出路径）
          saveError: this.failed ? this.saveError : null,
          // 界面通道状态：卡片不出现时，用户至少能在这里看到原因（不许静默）
          remote: this.remoteError ? { failed: this.remoteError } : null,
          feed: this.feed,
        };
      }

      /** 一次保存写掉全部草稿。 */
      async save() {
        const ops = this.ops();
        if (!ops.length || this.saving || !this.snapshotOf().writable) return;
        this.saving = true;
        this.failed = false;
        this.saveError = null;
        this.publish();
        try {
          const landed = await this.scope.mutate(ops, this.snapshotOf().revision);
          if (landed) {
            this.drafts.clear();
            this.saved = true;
          }
          this.failed = !landed;
          // ⚠️ 官方 `ConfigFormController.mutate` **把宿主的报错丢掉了**
          // （`if (!response.ok) { await this.recover(); return false; }`，
          // 见 `dsh-client-ui-settings/lib/client.js:1183`），所以这里只能自己
          // 把"改过哪些路径"写出来 —— 宿主拒写的原话是
          // `Config field "<path>" is not volatile`（`dsh-settings/lib/index.js:629`），
          // 一次 mutate 里只要有一个非法 op，**整批都会被拒**。
          // 不写路径的话，用户看到的就只有一句「保存失败，请重试」，无从下手（缺陷 17）。
          if (!landed) this.saveError = pathsOf(ops);
        } catch (error) {
          this.failed = true;
          this.saveError = `${pathsOf(ops)}（${error && error.message ? error.message : error}）`;
        } finally {
          this.saving = false;
          this.publish();
        }
      }

      /** 改一个字段（草稿，不落盘）。 */
      edit(path, text) {
        this.drafts.set(keyOf(path), { text });
        this.failed = false;
        this.saved = false;
        this.publish();
      }

      /** 同时改多个字段（模型选择器要用）。 */
      editMany(pairs) {
        for (const [path, text] of pairs) this.drafts.set(keyOf(path), { text });
        this.failed = false;
        this.saved = false;
        this.publish();
      }

      /** 选中一个模型 → 同时写 provider 与 model。 */
      pickModel(fieldKey, provider, model) {
        const field = FIELDS.find((candidate) => candidate.key === fieldKey);
        if (!field) return;
        this.editMany([
          [field.providerPath, provider],
          [field.modelPath, model],
        ]);
      }

      /** 清空一个模型选择（清掉两个路径）。 */
      clearModel(fieldKey) {
        const field = FIELDS.find((candidate) => candidate.key === fieldKey);
        if (!field) return;
        this.editMany([
          [field.providerPath, ''],
          [field.modelPath, ''],
        ]);
      }

      /** 勾选/取消一个布尔项（总开关 / 跟随对话模型）——**写布尔真值**。 */
      toggleFollow(path, checked) {
        this.drafts.set(keyOf(path), { value: checked === true });
        this.failed = false;
        this.saved = false;
        this.publish();
      }

      reset(path) {
        this.edit(path, '');
      }

      discard() {
        if (this.drafts.size === 0 && !this.failed) return;
        this.drafts.clear();
        this.failed = false;
        this.publish();
      }

      /** 模型目录：读主机的 `remote.session.modelCatalog()`（与对话框同一个源）。 */
      async loadCatalog() {
        try {
          const call = this.ctx?.remote?.session?.modelCatalog;
          if (typeof call !== 'function') {
            this.catalog = {
              status: 'error',
              groups: [],
              error: '拿不到 remote.session.modelCatalog（本页没注入 remote.session）',
            };
          } else {
            this.catalog = this.normalizeCatalog(await call.call(this.ctx.remote.session));
          }
        } catch (error) {
          this.catalog = {
            status: 'error',
            groups: [],
            error: String(error && error.message ? error.message : error),
          };
        }
        this.publish();
      }

      /** 远程调用的两种返回：`{ok:true,value}` / `{ok:false,error}`。 */
      normalizeCatalog(response) {
        if (!response) return { status: 'error', groups: [], error: '宿主没有暴露 session.modelCatalog' };
        if (response.ok === false) {
          return { status: 'error', groups: [], error: response.error?.message ?? '读模型目录失败' };
        }
        const value = response.value ?? response;
        return { status: 'ready', groups: optionGroups(value), error: null };
      }

      publish() {
        for (const listener of this.listeners) listener();
      }

      bind(project) {
        const store = createSnapshotStore(project());
        this.listeners.add(() => store.set(project()));
        return store;
      }

      /**
       * 检查 GitHub 上有没有新版本（用户点按钮才跑）。
       *
       * ⚠️ 必须走**声明过 `remote.memfuse` 的子 ctx**（`this.remoteCtx`）——
       * 用根 ctx 会被 cordis 拒（缺陷 15）。通道还没挂上时如实说"没挂上"，
       * 而不是让按钮点了没反应。
       */
      async checkUpdate() {
        if (this.update.status === 'checking') return;
        // ⚠️ 保留 `install`：装完之后再点一次「检查更新」不该把「已更新到 vX —— 重启后生效」
        // 这句话抹掉（否则用户以为没更新成功，又去点一遍）。
        this.update = { ...this.update, status: 'checking', error: null };
        this.publish();
        try {
          const ns = this.remoteCtx === null ? null : this.remoteCtx.remote?.[REMOTE_NAMESPACE];
          const call = ns?.checkUpdate;
          if (typeof call !== 'function') {
            throw new Error('界面通道还没挂上（宿主没装 checkUpdate 端点），等它连上再试');
          }
          const res = await call.call(ns);
          if (res && res.ok === false) throw new Error(res.error?.message ?? '检查更新失败');
          const data = res?.value ?? res;
          // 宿主把"没查成"也放在 `data.error` 里（网络/git 缺失）—— 原样显示，不吞
          this.update = { ...this.update, status: 'done', data, error: data?.error ?? null };
        } catch (error) {
          this.update = {
            ...this.update,
            status: 'error',
            error: String(error && error.message ? error.message : error),
          };
        }
        this.publish();
      }

      /**
       * 安装新版本（`git pull --ff-only`，用户点按钮才跑）。
       *
       * ⚠️ 装完**不会立刻生效**：宿主半边已经在 ESM 缓存里了，拉下来的新代码要
       * **重启 DSH** 才会加载（本项目实测，见 HANDOFF「ESM 缓存」）。所以这里的文案
       * 一律是"已更新到 vX —— 重启后生效"，绝不写成"已经用上新版"。
       *
       * 三种拒绝理由（不是 git 检出 / 本地有未提交的改动 / 不能快进）由宿主放在
       * `data.error` 里带回，界面**原样显示**（硬规则 4：不许吞原始报错）。
       */
      async installUpdate() {
        if (this.update?.install?.status === 'running') return;
        this.update = { ...this.update, install: { status: 'running', result: null, error: null } };
        this.publish();
        try {
          const ns = this.remoteCtx === null ? null : this.remoteCtx.remote?.[REMOTE_NAMESPACE];
          const call = ns?.applyUpdate;
          if (typeof call !== 'function') {
            throw new Error('界面通道还没挂上（宿主没装 applyUpdate 端点）—— 重启 DSH 后再试');
          }
          const res = await call.call(ns);
          if (res && res.ok === false) throw new Error(res.error?.message ?? '更新失败');
          const data = res?.value ?? res;
          if (data?.error) {
            this.update = { ...this.update, install: { status: 'error', result: data, error: data.error } };
          } else if (data?.ok === false) {
            this.update = {
              ...this.update,
              install: { status: 'error', result: data, error: '宿主没有执行更新，也没说为什么（这是缺陷，请报 issue）' },
            };
          } else {
            // 成功：把"检查"那份结果一起改成"已是最新"，否则页脚还挂着「落后 N 次提交」
            const next = data?.changed
              ? {
                  ...(this.update.data ?? {}),
                  supported: true,
                  current: data.to ?? this.update.data?.current ?? null,
                  latest: data.to ?? this.update.data?.latest ?? null,
                  behind: 0,
                  head: data.head ?? this.update.data?.head ?? null,
                  checkedAt: data.updatedAt ?? new Date().toISOString(),
                }
              : this.update.data;
            this.update = { status: 'done', data: next, error: null, install: { status: 'done', result: data, error: null } };
            // 页脚的版本号跟着磁盘走（宿主每次 list 都重读 package.json）——
            // `runningVersion` 不动：它还是"本进程在跑的那个"，两者不同就是"待重启"。
            if (data?.changed && data.to) this.info = { ...this.info, version: data.to };
          }
        } catch (error) {
          this.update = {
            ...this.update,
            install: { status: 'error', result: null, error: String(error && error.message ? error.message : error) },
          };
        }
        this.publish();
      }

      /** slot entry 的 `inject`：hooks（→ `useXxx` prop）+ 动作。 */
      inject() {
        return {
          hooks: { memfuseConfig: this.store },
          edit: (path, text) => this.edit(path, text),
          editMany: (pairs) => this.editMany(pairs),
          pickModel: (key, provider, model) => this.pickModel(key, provider, model),
          clearModel: (key) => this.clearModel(key),
          toggleFollow: (path, checked) => this.toggleFollow(path, checked),
          reset: (path) => this.reset(path),
          save: () => this.save(),
          discard: () => this.discard(),
          checkUpdate: () => this.checkUpdate(),
          installUpdate: () => this.installUpdate(),
        };
      }
    }

    /** 模型选择器：原生 select（optgroup 按 provider 分组）+ 可选的「清除」。 */
    function ModelPicker({ field, state, catalog, disabled, t, onPick, onClear }) {
      const groups = catalog.status === 'ready' ? catalog.groups : [];
      const disabledField = disabled || groups.length === 0;
      // 读不到目录时把**原始报错**也显示出来 —— 只写"读不到"等于让用户没法自救。
      const status =
        catalog.status === 'ready'
          ? groups.length === 0
            ? t('noModels')
            : null
          : catalog.status === 'loading'
            ? t('loadingModels')
            : `${t('catalogFailed')}${catalog.error === null ? '' : `（${catalog.error}）`}`;

      return jsxs('div', {
        className: 'dsh-memfuse-field',
        children: [
          jsx('label', {
            className: 'dsh-memfuse-field-label',
            htmlFor: fieldId(field.key),
            children: field.label,
          }),
          jsxs('div', {
            className: 'dsh-memfuse-row',
            children: [
              jsx('select', {
                id: fieldId(field.key),
                className: 'dsh-memfuse-select',
                disabled: disabledField,
                value: state.value,
                onChange: (event) => {
                  const [provider, model] = String(event.target.value).split('\u0000');
                  if (provider && model) onPick(provider, model);
                },
                children: [
                  jsx('option', { value: '', children: state.value === '' ? t('notSelected') : t('notSelected') }),
                  ...groups.map((group) =>
                    jsx(
                      'optgroup',
                      {
                        label: group.label,
                        children: group.models.map((model) =>
                          jsx('option', { value: pairId(group.id, model.id), children: model.label }, `${group.id}#${model.id}`),
                        ),
                      },
                      group.id,
                    ),
                  ),
                ],
              }),
              field.clearable === true && state.value !== ''
                ? jsx('button', {
                    type: 'button',
                    className: 'dsh-memfuse-clear',
                    disabled,
                    onClick: () => onClear(),
                    children: t('clear'),
                  })
                : null,
            ],
          }),
          status === null ? null : jsx('p', { className: 'dsh-memfuse-field-hint', children: status }),
          field.hint === undefined ? null : jsx('p', { className: 'dsh-memfuse-field-hint', children: field.hint }),
        ],
      });
    }

    /** 枚举字段：分段控件，省得用户手打字符串。 */
    function EnumField({ field, state, disabled, onPick }) {
      return jsxs('div', {
        className: 'dsh-memfuse-field',
        children: [
          jsx('label', {
            className: 'dsh-memfuse-field-label',
            htmlFor: fieldId(field.key),
            children: field.label,
          }),
          jsx(P.SegmentedControl, {
            id: fieldId(field.key),
            label: field.label,
            value: state.text === '' ? undefined : state.text,
            options: field.options,
            disabled,
            onChange: (value) => onPick(value),
          }),
          field.hint === undefined ? null : jsx('p', { className: 'dsh-memfuse-field-hint', children: field.hint }),
        ],
      });
    }

    /**
     * 布尔字段：勾选框。
     *
     * ⚠️ 标签只给一次。`Checkbox` 自己会渲染 `label`（截图里出现过
     * 「跟随对话模型 跟随对话模型」两遍 —— 就是外面又套了一个 `<label>`）。
     */
    function BoolField({ field, state, disabled, t, onToggle }) {
      return jsxs('div', {
        className: 'dsh-memfuse-field',
        children: [
          jsxs('div', {
            className: 'dsh-memfuse-row',
            children: [
              jsx(P.Checkbox, {
                id: fieldId(field.key),
                checked: state.checked,
                disabled,
                label: field.label,
                onChange: (checked) => onToggle(checked),
              }),
              state.overridden ? jsx('span', { className: 'dsh-memfuse-tag', children: t('overridden') }) : null,
            ],
          }),
          field.hint === undefined ? null : jsx('p', { className: 'dsh-memfuse-field-hint', children: field.hint }),
        ],
      });
    }

    /**
     * 记忆学习横幅 —— 设置页最上面那一块。
     *
     * 为什么需要它：这套插件的「学习」= LLM 抽取。开关默认开、但用户可能关掉，
     * 或者开了却没选到模型（这一档在宿主侧是**真故障**，每轮注入都会报）。
     * 两种情况下界面都要**当场说清楚**，并给一个一键修复的按钮 ——
     * 否则现象只是"记忆好像没长"，而设置页看上去一切正常。
     *
     * 三态：off（关着）/ partial（开着但没模型）/ ready（真的会学）。
     */
    function learningTone(state) {
      if (state.fields.enabled.checked !== true) return 'off';
      if (state.fields.follow.checked !== true && state.fields.model.value === '') return 'partial';
      return 'ready';
    }

    function LearningBanner({ state, t, disabled, onEnable, onFollow }) {
      const tone = learningTone(state);
      const follow = state.fields.follow.checked === true;
      const source = follow ? t('sourceFollow') : t('sourceExplicit');
      const mode = state.fields.mode.text === 'auto' ? t('modeAuto') : t('modeSuggest');

      if (tone === 'off') {
        return jsxs('div', {
          className: 'dsh-memfuse-banner',
          'data-tone': 'off',
          role: 'status',
          children: [
            jsx('p', { className: 'dsh-memfuse-banner-title', children: t('learnOffTitle') }),
            jsx('p', { className: 'dsh-memfuse-banner-body', children: t('learnOffBody') }),
            jsxs('div', {
              className: 'dsh-memfuse-banner-actions',
              children: [
                jsx('button', {
                  type: 'button',
                  className: 'dsh-memfuse-banner-button',
                  disabled,
                  onClick: () => onEnable(),
                  children: t('learnOffAction'),
                }),
              ],
            }),
          ],
        });
      }

      if (tone === 'partial') {
        return jsxs('div', {
          className: 'dsh-memfuse-banner',
          'data-tone': 'partial',
          role: 'status',
          children: [
            jsx('p', { className: 'dsh-memfuse-banner-title', children: t('learnNoModelTitle') }),
            jsx('p', { className: 'dsh-memfuse-banner-body', children: t('learnNoModelBody') }),
            jsxs('div', {
              className: 'dsh-memfuse-banner-actions',
              children: [
                jsx('button', {
                  type: 'button',
                  className: 'dsh-memfuse-banner-button',
                  disabled,
                  onClick: () => onFollow(),
                  children: t('learnNoModelAction'),
                }),
              ],
            }),
          ],
        });
      }

      return jsxs('div', {
        className: 'dsh-memfuse-banner',
        'data-tone': 'ready',
        role: 'status',
        children: [
          jsx('p', { className: 'dsh-memfuse-banner-title', children: t('learnReadyTitle') }),
          jsx('p', {
            className: 'dsh-memfuse-banner-body',
            children: t('learnReadyBody', { source, mode }),
          }),
        ],
      });
    }

    /**
     * 当前状态下**实际要显示**的字段（其余藏起来；草稿与已保存值都不动）。
     *
     * ⚠️ 规则必须跟宿主侧 `extractTarget()` / `followFallback()` 的真实语义对齐，
     * 别按直觉写（用户问：「跟随开启时，下面两个模型是不是就不用显示了？」）：
     *
     *   - **跟随 ON**：主选择器（`provider/model`）只在 `onUnavailable='fallback'` 时
     *     才有意义 —— 那时它是**降级目标**（`followFallback()` 把显式那对当降级目标）。
     *     所以把它挪进「模型不可用时」组并改名；策略是 stop 时它完全用不上 → 藏。
     *   - **跟随 ON**：独立「降级模型」（`fallbackProvider/Model`）**不生效**
     *     （跟随模式下 `followFallback()` 返回显式那对，覆盖它）→ 藏。
     *   - **跟随 OFF**：主选择器是抽取用的模型；独立降级模型只在 fallback 策略下有用。
     */
    function visibleFields(state) {
      const follow = state.fields.follow.checked === true;
      const strategy = state.fields.onUnavailable.text === 'fallback';
      const out = [];
      for (const field of FIELDS) {
        if (field.key === 'model') {
          if (!follow) {
            out.push(field);
          } else if (strategy) {
            // 跟随 + fallback：这一对就是降级目标，改名、挪到「模型不可用时」组
            out.push({
              ...field,
              group: 'fallback',
              label: '降级模型（主模型不可用时）',
              hint: '跟随对话模型时，这个模型只在对话主模型不可用时才会被调用。留空 = 没有降级目标（主模型一坏就记失败）。',
            });
          }
          continue;
        }
        if (field.key === 'fallback') {
          // 跟随模式下它被 followFallback() 覆盖，显示出来只会误导
          if (!follow && strategy) out.push(field);
          continue;
        }
        if (field.key === 'onUnavailable' && follow) {
          out.push({
            ...field,
            hint:
              'stop = 跟随的模型不可用时记失败，不再换别的；' +
              'fallback = 改用「降级模型（主模型不可用时）」里挑的那对（要先挑一个，否则等于没有降级目标）。',
          });
          continue;
        }
        out.push(field);
      }
      return out;
    }

    /**
     * 「检查更新 / 安装更新」那一行的文案（纯函数 —— 测试可以直接喂各种状态）。
     *
     * 优先级：**安装**的结论比**检查**新（装完就不该再说"落后 N 次提交"）。
     * 原则：**宿主的原始报错不许吞**（网络/git 缺失/本地有改动都原样显示），
     * 只有"确实没查成"才用兜底文案。
     */
    function updateTextOf(state, t) {
      const update = state.update ?? { status: 'idle', data: null, error: null, install: null };
      const install = update.install ?? null;
      if (install?.status === 'running') return t('updateInstalling');
      if (install?.status === 'error') return t('updateInstallFailed', { error: install.error ?? '未知错误' });
      if (install?.status === 'done') {
        const result = install.result ?? {};
        const version = result.to ? `v${result.to}` : t('versionUnknown');
        // `changed: false` = git 说"已经是最新的"（pull 没动任何东西）—— 别谎报"已更新"
        if (result.changed === false) return t('updateInstalledNoChange', { version });
        // 拉到新提交但版本号没动（文档/测试类提交很常见）：照实说，别假装升了版本
        if (result.from && result.to && result.from === result.to) {
          return t('updateInstalledSameVersion', { version });
        }
        return t('updateInstalled', { version });
      }
      if (update.status === 'checking') return t('updateChecking');
      if (update.status === 'error') return t('updateFailed', { error: update.error ?? '未知错误' });
      if (update.status !== 'done') return t('updateIdle');
      const data = update.data ?? {};
      // 宿主把"没查成"（连不上 GitHub / 不是 git 检出 / 找不到 git）放在 `data.error`
      if (data.error) return t('updateFailed', { error: data.error });
      if (data.supported === false) return t('updateUnsupported');
      const current = data.current ? `v${data.current}` : t('versionUnknown');
      const head = data.head ? ` · ${data.head}` : '';
      if ((data.behind ?? 0) === 0) return t('updateLatest', { version: current, head });
      // 版本号没变也算"有更新"（文档/测试类提交很常见）—— 这时别写"新版本"，说"新提交"
      if (!data.latest || data.latest === data.current) {
        return t('updateAvailableSameVersion', { from: current, behind: String(data.behind ?? 0) });
      }
      return t('updateAvailable', { from: current, to: ` → v${data.latest}`, behind: String(data.behind ?? 0) });
    }

    /**
     * 要不要显示「安装更新」按钮。
     *
     * 只有**真的查到了新版本**才给这个按钮 —— 查不到/查失败/不支持的时候摆一个按钮
     * 只会让人点了再吃一次同样的错。
     */
    function canInstallUpdate(state) {
      const update = state.update ?? {};
      const install = update.install ?? null;
      // 已经装过（且确实拉到了东西）→ 按钮收起来，剩下的只是"重启"
      if (install?.status === 'done' && install.result?.changed !== false) return false;
      const data = update.data ?? null;
      if (data === null) return false;
      if (data.supported === false || data.error) return false;
      return (data.behind ?? 0) > 0;
    }

    /**
     * 页脚那个版本号的文字。
     *
     * `version` = 磁盘上的版本（装完更新立刻变），`runningVersion` = 本进程启动时的版本。
     * 两者不同 = **装了但还没重启** —— 必须写出来，否则用户会以为"已经用上新版了"
     * （本项目实测：改完代码不重启，跑的还是旧模块）。
     */
    function versionLabelOf(state, t) {
      const version = state.info?.version ?? null;
      const running = state.info?.runningVersion ?? null;
      if (version === null && running === null) return t('versionUnknown');
      const label = `v${version ?? running}`;
      return running !== null && version !== null && running !== version
        ? `${label}${t('updateRestartHint')}`
        : label;
    }

    /**
     * 配置表单 —— **三处入口共用同一个组件**：
     *   ① 设置页一级「记忆」页（`settings.section`，2026-10-17 新增的主入口）
     *   ② 「插件」页的包页（`plugins.bundle.config`）
     *   ③ 包页那一行的详情（`plugins.row.config`）
     *
     * @param props - view、快照、动作与本地化文案。
     */
    function MemfuseConfigCardView(props) {
      const { t, view } = props;
      if (view === 'summary') return t('summary');
      const state = props.useMemfuseConfig((snapshot) => snapshot);
      const disabled = !state.writable;

      // 分组标题只在组变化时插一条（字段顺序 = 页面顺序，见 FIELDS / visibleFields）。
      const rows = [];
      let current = null;
      for (const field of visibleFields(state)) {
        if (field.group !== current) {
          current = field.group;
          const meta = GROUPS.find((entry) => entry.id === current);
          if (meta) rows.push(jsx('h3', { className: 'dsh-memfuse-group', children: t(meta.key) }, `group-${current}`));
        }
        const fieldState = state.fields[field.key];
        if (field.kind === 'bool') {
          rows.push(
            jsx(
              BoolField,
              {
                field,
                state: fieldState,
                disabled,
                t,
                onToggle: (checked) => props.toggleFollow(field.path, checked),
              },
              field.key,
            ),
          );
        } else if (field.kind === 'picker') {
          rows.push(
            jsx(
              ModelPicker,
              {
                field,
                state: fieldState,
                catalog: state.catalog,
                disabled,
                t,
                onPick: (provider, model) => props.pickModel(field.key, provider, model),
                onClear: () => props.clearModel(field.key),
              },
              field.key,
            ),
          );
        } else {
          rows.push(
            jsx(
              EnumField,
              {
                field,
                state: fieldState,
                disabled,
                onPick: (value) => props.edit(field.path, value),
              },
              field.key,
            ),
          );
        }
      }

      return jsxs(P.SettingsForm, {
        labels: {
          unavailable: t('unavailable'),
          readOnly: t('readOnly'),
          saveFailed: t('saveFailed'),
          save: t('save'),
          saving: t('saving'),
        },
        state,
        onSave: props.save,
        onDiscard: props.discard,
        children: [
          // 最上面先说清「现在到底会不会学」—— 一键就能修好。
          jsx(
            LearningBanner,
            {
              state,
              t,
              disabled,
              onEnable: () => {
                props.toggleFollow(['extract', 'enabled'], true);
                void props.save();
              },
              onFollow: () => {
                props.toggleFollow(['extract', 'followConversation'], true);
                void props.save();
              },
            },
            'learning',
          ),
          ...rows,
          // 状态行：**「保存」灰着不是坏了**，是没有改动可存 —— 写出来，别让用户猜。
          jsx('p', {
            className: 'dsh-memfuse-note',
            role: 'status',
            'data-state': state.dirty ? 'dirty' : state.saved ? 'saved' : 'clean',
            children: state.failed
              ? t('saveFailed')
              : state.dirty
                ? t('dirty')
                : state.saved
                  ? t('saved')
                  : t('clean'),
          }),
          // 保存失败要**说得出手里有什么**：官方 controller 把宿主的报错丢了
          // （`mutate` 失败只返回 false），所以这里至少要写清"改过哪些路径"。
          state.saveError
            ? jsx('p', {
                className: 'dsh-memfuse-note',
                role: 'status',
                children: t('saveRejected', { paths: state.saveError }),
              })
            : null,
          jsx('p', { className: 'dsh-memfuse-note', children: t('note') }),
          // 界面通道挂了要说出来：否则现象只是"回合尾部没有卡片"，查起来极难。
          state.remote && state.remote.failed
            ? jsx('p', {
                className: 'dsh-memfuse-note',
                role: 'status',
                children: `${t('remoteFailed')}${state.remote.failed}`,
              })
            : null,
          // 通道挂上了、但数据源连不上（或还没连上）——同样要说出来。
          state.feed
            ? jsx('p', {
                className: 'dsh-memfuse-note',
                role: 'status',
                children:
                  state.feed.status === 'ready'
                    ? t('cardReady', { groups: state.feed.groups })
                    : `${t('cardFailed')}${state.feed.error ?? '（还在连…）'}`,
              })
            : null,
          jsx('p', { className: 'dsh-memfuse-note', children: t('remoteHint') }),
          // ── 页脚：版本 / 检查更新 / 安装更新 / GitHub 点赞（2026-10-18）──
          //
          // 「检查更新」只读（宿主那边是 `git fetch`，只更新远端引用、不动工作区），
          // 用户点按钮才跑 —— 不在关键路径上，也不偷偷联网。
          // 「安装更新」只在**真的查到新版本**时出现，宿主跑 `git pull --ff-only`；
          // 装完**必须重启 DSH** 才生效（没有热更新），所以文案与版本号都照实说。
          // 「去 GitHub 点个赞」只是打开仓库页面：点赞要 GitHub 账号，
          // 插件不碰用户凭据，也不假装能替用户点。
          jsxs('div', {
            className: 'dsh-memfuse-footer',
            children: [
              jsx('span', {
                className: 'dsh-memfuse-footer-version',
                children: versionLabelOf(state, t),
              }),
              jsx('button', {
                type: 'button',
                className: 'dsh-memfuse-card-button',
                disabled: (state.update?.status ?? 'idle') === 'checking',
                onClick: () => props.checkUpdate?.(),
                children:
                  (state.update?.status ?? 'idle') === 'checking' ? t('updateCheckingBtn') : t('updateCheck'),
              }),
              canInstallUpdate(state)
                ? jsx('button', {
                    type: 'button',
                    className: 'dsh-memfuse-card-button',
                    'data-variant': 'primary',
                    disabled: state.update?.install?.status === 'running',
                    onClick: () => props.installUpdate?.(),
                    children:
                      state.update?.install?.status === 'running' ? t('updateInstallingBtn') : t('updateInstall'),
                  })
                : null,
              state.info?.repoUrl
                ? jsx('a', {
                    className: 'dsh-memfuse-card-button',
                    href: state.info.repoUrl,
                    target: '_blank',
                    rel: 'noreferrer',
                    children: t('updateStar'),
                  })
                : null,
            ],
          }),
          jsx('p', { className: 'dsh-memfuse-note', role: 'status', children: updateTextOf(state, t) }),
        ],
      });
    }

    // ────────────────────────── 候选卡片（Block E 的界面版）──────────────────────────
    //
    // 为什么要这张卡：Block E 只把候选写进 system prompt，**模型不转述用户就看不到**
    // （docs/NEXT.md §1.1）。这里让候选直接出现在回合尾部，用户点一下就能推进。
    //
    // 数据从哪来：宿主侧的 Remote（`lib/remote.js`）。浏览器 bundle 是独立模块、
    // 没法 import 宿主那份 ESM，所以描述符在这里**复制**了一份 ——
    // `test/client.test.mjs` 有一条断言逐字段比对两份，防漂移。
    const REMOTE_PACKAGE = 'dsh-memfuse';
    const REMOTE_NAMESPACE = 'memfuse';
    const REMOTE_SERVICE_KEY = 'memfuseRemote';
    /** 这个命名空间服务在 ctx 上的**全名** —— `ctx.inject` 要声明的就是它。 */
    const REMOTE_SERVICE = `remote.${REMOTE_NAMESPACE}`;
    const SUGGEST_SLOT = 'conversation.chat.turnTail';
    const SUGGEST_ID = 'dsh-memfuse#suggestions';
    /**
     * 失败重试的退避参数（毫秒）。
     *
     * ⚠️ **别把这两个数写死在 `scheduleRetry()` 的表达式里**：测试要把它们调到个位数
     * 毫秒才能验"重试继续往下走"，而 30 秒封顶在测试里等于挂死。
     * `exports.__retryConfig` 把它暴露出去就是给测试改的（与 `WRITABLE_PATHS` 同类接缝）。
     */
    const RETRY = { baseMs: 1000, maxMs: 30000 };

    const strictCodec = (typeSymbol, check) => ({
      mode: 'strict',
      typeSymbol,
      create: () => ({
        parse: (value) => check(value),
      }),
    });
    const asKey = (value) => {
      if (typeof value !== 'string' || value.trim() === '') throw new Error('期望非空字符串（簇 key）');
      return value;
    };
    const asKeyList = (value) => {
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw new Error('期望字符串数组');
      return value;
    };
    /** 技能名（与宿主 `lib/remote.js` 的 `asName` 同口径）。 */
    const asName = (value) => {
      if (typeof value !== 'string' || value.trim() === '') throw new Error('期望非空字符串（技能名）');
      return value;
    };
    const asJson = (value) => value;

    /**
     * 普通参数的构造器。**`source: 'json'` 不能省**（缺陷 19）：
     * 宿主 `resolveParameter()` 的判据是 `if (parameter.source === 'json') return value;`，
     * 否则就会**把它当 lookup 参数**去要 provider key，抛
     * `lookup parameter "keys" has no provider key` —— 表现是"没参数的 list 正常、
     * 一按卡片上的按钮就报错"。
     */
    const jsonParam = (name, codec) => ({ name, wire: name, source: 'json', codec });

    /** 与宿主 `lib/remote.js` 的 `remoteDescriptors()` 一一对应（测试锁死）。 */
    function remoteDescriptors() {
      const t = (name) => `${REMOTE_PACKAGE}/types#${name}`;
      const base = (method) => ({
        id: `${REMOTE_PACKAGE}#${REMOTE_NAMESPACE}/${method}`,
        service: REMOTE_SERVICE_KEY,
        namespace: REMOTE_NAMESPACE,
        method,
        implementation: method,
        invocation: { kind: 'direct' },
      });
      return [
        { ...base('list'), parameters: [], result: strictCodec(t('SuggestionFeed'), asJson) },
        {
          ...base('dismiss'),
          parameters: [jsonParam('key', strictCodec(t('ClusterKey'), asKey))],
          result: strictCodec(t('SuggestionState'), asJson),
        },
        {
          ...base('markSeen'),
          parameters: [jsonParam('keys', strictCodec(t('ClusterKeyList'), asKeyList))],
          result: strictCodec(t('SuggestionState'), asJson),
        },
        {
          ...base('requestDistill'),
          parameters: [jsonParam('key', strictCodec(t('ClusterKey'), asKey))],
          result: strictCodec(t('SuggestionState'), asJson),
        },
        // ── 缺陷 25：界面上真的把技能提炼出来（会调模型）+ 装 / 丢 ──
        // 没有这三个端点时，"点「提炼成技能」"就只能记一条待办，用户点完什么都看不到。
        {
          ...base('distill'),
          parameters: [jsonParam('key', strictCodec(t('ClusterKey'), asKey))],
          result: strictCodec(t('SkillDraft'), asJson),
        },
        {
          ...base('approve'),
          parameters: [jsonParam('name', strictCodec(t('SkillName'), asName))],
          result: strictCodec(t('SkillInstall'), asJson),
        },
        {
          ...base('reject'),
          parameters: [jsonParam('name', strictCodec(t('SkillName'), asName))],
          result: strictCodec(t('SkillInstall'), asJson),
        },
        // 2026-10-18：检查更新（无参数）。与宿主 `lib/remote.js` 的条目逐字对应。
        {
          ...base('checkUpdate'),
          parameters: [],
          result: strictCodec(t('UpdateStatus'), asJson),
        },
        // 2026-10-18 追加：安装更新（无参数，宿主跑 `git pull --ff-only`）。同样逐字对应。
        {
          ...base('applyUpdate'),
          parameters: [],
          result: strictCodec(t('UpdateInstall'), asJson),
        },
      ];
    }

    /** 客户端贡献：face 必须是 'client'（同包同 face 会被注册表判重）。 */
    function remoteContribution() {
      return { package: REMOTE_PACKAGE, face: 'client', schemas: [], descriptors: remoteDescriptors() };
    }

    /**
     * 候选数据源：调宿主 Remote，维护一份可订阅快照。
     *
     * 关键设计（`docs/NEXT.md` §1.4 方案 A）：
     *   - **渲染即记 seen**：卡片把这批 key 报给宿主（`markSeen`），下一轮起同一组不再出现
     *     —— 用户什么都不用做也不会被打扰；
     *   - 但**当次不重新拉取**：否则标记完立刻消失，用户根本来不及看；
     *   - 簇成员变化 → key 变 → 视为新一组，会再出现一次（这是期望行为）。
     */
    class SuggestionFeed {
      constructor(ctx) {
        /**
         * ⚠️ 必须传**注入了 `remote.memfuse` 的那个子 ctx**（`ctx.inject` 给的），
         * 不能传插件的根 ctx：裸访问 `ctx.remote.memfuse` 会被 cordis 挡下
         * （`cannot get property "remote.memfuse" without inject`，本机实测），
         * 而那个错误的表现只是"卡片永远不出现"。
         */
        this.ctx = ctx;
        this.listeners = new Set();
        this.snapshot = {
          status: 'loading',
          visible: [],
          restCount: 0,
          restKeys: [],
          seen: 0,
          dismissed: 0,
          pending: [],
          /**
           * 待确认的**技能草稿**（含 SKILL.md 原文）—— 缺陷 25 的第二阶段。
           *
           * 真源在**宿主磁盘**上（`pending-skills/<name>/SKILL.md`），每次 `list` 都会带回来，
           * 所以：刷新页面草稿还在、卡片被"空刷新"撤掉也还在（不像候选行那样要钉住）。
           */
          drafts: [],
          /**
           * 正在跑的界面动作（`{kind: 'distill'|'approve'|'reject', key?, name?, title?}`）。
           * 提炼要调模型、可能几十秒，界面必须给出进行中的状态 —— 否则就是"点了没反应"。
           */
          draftBusy: null,
          error: null,
          /**
           * 出错时**要显示出来**的那条消息（成功时清掉）。
           *
           * 为什么快照里单独有一个字段：通道坏了的时候卡片是"什么都没有"，
           * 这是本项目最难查的一类失败（硬规则 4）。渲染路径里做去重
           * （render 期间改状态）在 StrictMode 双渲染下会自相矛盾，
           * 所以状态由数据源决定：坏着就一直显示，修好自动消失。
           */
          errorVisible: null,
          /**
           * 正在自动重试（缺陷 27）：为 true 时卡片说的是"通道还没就绪，正在重试"，
           * 而不是摆出"出错了"的架势 —— 开机竞态不该看起来像插件坏了。
           */
          retrying: false,
          /** 已经重试到第几次（只给文案用，不是控制变量）。 */
          retryAttempt: 0,
          /** 页脚用：版本号 + 仓库地址（由 `list` 带回，宿主读 package.json）。 */
          version: null,
          /**
           * **本进程启动时**的版本（宿主在 import 那一刻读到的）。
           * 与 `version` 不同 = 装了更新但还没重启 —— 页脚据此写「重启后生效」。
           */
          runningVersion: null,
          repoUrl: null,
        };
        /**
         * 每次 `load()` / `claim()` 都 +1 —— 用来丢掉**过期响应**。
         *
         * 两个 `list` 同时在飞是真会发生的（挂载时那次 + 卡片渲染时推的那次；
         * 真机启动时卡片在插件装好端点后 6ms 就渲染了，正好撞上挂载那次）。
         * 而"卡片已经把这批候选领走、并记成 seen"之后，先发出的那个请求回来时
         * 内容还是旧的 —— 照单全收就会把已经摆过、已经记过 seen 的候选塞回 `visible`，
         * 下一个回合于是再摆一遍（缺陷 20 与 23 的合体）。
         */
        this.loadSeq = 0;
        /**
         * 加载失败后的重试（缺陷 26，真机抓的）。
         *
         * 为什么非有不可：卡片的刷新挂在**渲染**上（`touch()`，去抖 1.5s），而
         * `publish()` 会立刻触发一次渲染 —— 那次渲染距上次不足 1.5s，被去抖挡掉。
         * 于是**第一次 `list` 失败之后，再也没有任何东西会重试**：那行
         * 「界面通道出错：…HTTP 404」会一直挂在回合尾部，直到用户碰巧发下一条消息。
         * 真机上表现为"重启之后底部永远显示 404"（而宿主其实已经装好了 7 个端点）。
         *
         * ⚠️ **"重试 3 次就放弃"是错的**（缺陷 27：同一个 404 又回来了）：
         * 重启之后宿主把远程端点挂上可能要十几秒甚至更久，7 秒的预算一烧光就
         * **永久放弃**，那行 404 照样挂在回合尾部。更糟的是 `retryCount` 是**全局**的 ——
         * 一次开机竞态烧光之后，之后**任何对话的任何失败**都不再重试。
         *
         * 现在：1s / 2s / 4s / 8s / 15s / 30s / 30s …（封顶 `RETRY.maxMs`）、**不设次数上限**；
         * 成功即清零，`wake()`（窗口重新可见/被聚焦）与"新的一次渲染"都会重置预算。
         * 失败状态下每 30 秒一个请求，成本可以忽略。
         */
        this.retryCount = 0;
        this.retryTimer = null;
        this.store = this.bind(() => this.snapshot);
      }

      bind(project) {
        const store = createSnapshotStore(project());
        this.listeners.add(() => store.set(project()));
        return store;
      }

      publish() {
        for (const listener of this.listeners) listener();
      }

      /**
       * 渲染时轻推一次刷新（去抖 1.5s）。
       *
       * 为什么把刷新放在渲染路径上：客户端**没有轮询通道**，而"新候选出现后卡片能自己
       * 冒出来"必须成立（否则用户得刷新页面才看得到）。卡片每个回合结束渲染一次，
       * 正好是天然的心跳点；去抖避免同一帧多次渲染打出一串请求。
       *
       * ⚠️ 出错时**不吃去抖**（缺陷 26）：错误横幅要能自己消失，不能被"刚渲染过"挡住。
       */
      touch() {
        const now = Date.now();
        const broken = this.snapshot.status === 'error';
        if (this.loading) return;
        if (!broken && now - this.lastTouch < 1500) return;
        // 新的一次渲染 = 新的一次机会：把已经爬到 30s 的退避重置回 1s。
        // 不重置的话，一次开机竞态把间隔顶到封顶之后，用户下次再看这个对话
        // 还得干等 30 秒才可能好（缺陷 27）。
        if (broken && this.retryTimer === null) this.retryCount = 0;
        this.lastTouch = now;
        this.loading = true;
        void this.load().finally(() => {
          this.loading = false;
        });
      }

      /**
       * 失败后退避重试：1s / 2s / 4s / 8s / 15s / 30s / 30s …（封顶 `RETRY.maxMs`）。
       *
       * **没有次数上限**（缺陷 27）：这个通道本来就该自愈，而"开机竞态"可能持续
       * 十几秒到一分钟。放弃 = 把那行错误永久钉在回合尾部，比不重试还糟。
       */
      scheduleRetry() {
        if (this.retryTimer !== null) return;
        const delay = Math.min(RETRY.baseMs * 2 ** Math.min(this.retryCount, 16), RETRY.maxMs);
        this.retryCount += 1;
        const timer = setTimeout(() => {
          this.retryTimer = null;
          this.loading = true;
          void this.load().finally(() => {
            this.loading = false;
          });
        }, delay);
        // Node 里（测试）别让这个定时器把进程吊着；浏览器里 setTimeout 返回数字，没 unref
        if (typeof timer?.unref === 'function') timer.unref();
        this.retryTimer = timer;
      }

      /** 成功一次就把重试状态收干净（包括撤掉还没到点的那个定时器）。 */
      clearRetry() {
        this.retryCount = 0;
        if (this.retryTimer !== null) {
          clearTimeout(this.retryTimer);
          this.retryTimer = null;
        }
      }

      /**
       * 窗口重新可见 / 被聚焦时敲一下（缺陷 27）。
       *
       * 开机竞态那种失败，用户往往几秒后才切回窗口 —— 那时宿主早就 ready 了，
       * 不该还等着"下一次渲染"。只在本就出错时动作，正常状态下什么都不做。
       */
      wake() {
        if (this.snapshot.status !== 'error') return;
        this.retryCount = 0;
        if (this.retryTimer !== null) {
          clearTimeout(this.retryTimer);
          this.retryTimer = null;
        }
        this.touch();
      }

      /**
       * 把"宿主刚交回来、还没给过任何回合"的那几组**领走**（领走即清空）。
       *
       * 为什么需要这个动作：卡片是**按回合**渲染的，而这份快照是**共享**的。
       * 不领走的话，下一个回合的卡片会把上一个回合已经摆过的候选再摆一遍
       * （真机反馈"每个对话底部都出现这个卡片了"，缺陷 20 的另一面）。
       * 领走之后卡片把它钉在自己那一份里（见 `pinnedCard`），于是渲染路径上那次
       * 空刷新再也撤不掉它（缺陷 23：真机"卡片一闪而过，用户永远看不到"）。
       *
       * 只清 `visible` / `restCount`：那两项就是"卡片还能拿去显示的东西"。
       */
      claim() {
        if (this.snapshot.visible.length === 0) return null;
        const taken = { rows: this.snapshot.visible, restCount: this.snapshot.restCount };
        this.snapshot = { ...this.snapshot, visible: [], restCount: 0 };
        // 领走 = 这批已经"交付"了：还在飞的 `list` 回来时内容是旧的，别让它再塞回来。
        this.loadSeq += 1;
        return taken;
      }

      /** `ctx.remote.memfuse.<method>(...)`：没挂上就明确说"没有"。 */
      call(method, ...args) {
        const ns = this.ctx?.remote?.[REMOTE_NAMESPACE];
        const fn = ns?.[method];
        if (typeof fn !== 'function') {
          return Promise.reject(new Error(`remote.${REMOTE_NAMESPACE}.${method} 不在（客户端贡献没挂上？）`));
        }
        return fn.apply(ns, args);
      }

      /** 远程调用统一返回 `{ok:true,value}` / `{ok:false,error}`。 */
      static unwrap(response) {
        if (response && response.ok === false) throw new Error(response.error?.message ?? '远程调用失败');
        return response?.value ?? response;
      }

      async load() {
        const mySeq = ++this.loadSeq;
        /** 这一次要报给宿主的"看过"key —— 在 publish 之前就固定下来（见下面 ⚠️）。 */
        let seenKeys = [];
        try {
          const value = SuggestionFeed.unwrap(await this.call('list'));
          // 期间这批候选被卡片领走了 / 有更新的 load 在跑 → 这份结果已经过期，丢掉
          // （照单全收的话，已经显示过、已经记过 seen 的候选会被塞回来）。
          if (mySeq !== this.loadSeq) return this.snapshot;
          const groups = Array.isArray(value?.groups) ? value.groups : [];
          const pending = Array.isArray(value?.pendingDistill) ? value.pendingDistill : [];
          const visible = groups.filter((g) => g.seen !== true && !pending.includes(g.key));
          const restKeys = Array.isArray(value?.restKeys) ? value.restKeys : [];
          // ⚠️ 要记 seen 的 key **必须在这里定下来**：下面的 `publish()` 会立刻触发一次
          // 渲染，而渲染里的 `claim()` 会把 `visible` 清空 —— 等 publish 之后再从快照里读，
          // 读到的就是空的，于是"显示过的那一组"反而永远记不上 seen（下一轮又冒出来）。
          seenKeys = [...visible.map((g) => g.key), ...restKeys];
          // 成功一次就把重试状态收干净（含撤掉还没到点的那个定时器）
          this.clearRetry();
          this.snapshot = {
            status: 'ready',
            visible,
            // 宿主按 `skill.suggestMax`（默认 1）只给前几组；其余组的 key 在这里收下来，
            // 渲染时**一起记 seen** —— 否则下一轮又冒一行新的，等于换个方式刷屏。
            restCount: Number(value?.restCount ?? 0),
            restKeys,
            seen: value?.seen ?? 0,
            dismissed: value?.dismissed ?? 0,
            pending,
            // 待确认的技能草稿（宿主从磁盘读，所以刷新页面后还在）
            drafts: Array.isArray(value?.pendingSkills) ? value.pendingSkills : [],
            // 进行中的动作**不能被一次刷新抹掉**（否则"提炼中…"会闪一下就没了）
            draftBusy: this.snapshot.draftBusy,
            // 页脚用：版本号 + 仓库地址（宿主读 package.json 带回；通道坏了保留上一次的值）
            version: value?.version ?? this.snapshot.version ?? null,
            runningVersion: value?.runningVersion ?? this.snapshot.runningVersion ?? null,
            repoUrl: value?.repoUrl ?? this.snapshot.repoUrl ?? null,
            error: null,
            // 连上了就把错误横幅收掉（修好即消失，不需要刷新）
            errorVisible: null,
            retrying: false,
            retryAttempt: 0,
          };
        } catch (error) {
          // 过期的失败也一样丢掉：不然一个早就没人等的请求会把错误横幅弹出来。
          if (mySeq !== this.loadSeq) return this.snapshot;
          const message = String(error && error.message ? error.message : error);
          // 先把下一次重试排上，再写快照 —— `retrying` 说的才是实话
          // （"确实还有人会再来一次"，缺陷 27）。
          this.scheduleRetry();
          this.snapshot = {
            status: 'error',
            visible: [],
            restCount: 0,
            restKeys: [],
            seen: 0,
            dismissed: 0,
            // 草稿来自磁盘、不是这次请求的结果 —— 通道坏了也照样留着（能装就还能装）
            drafts: this.snapshot.drafts,
            draftBusy: this.snapshot.draftBusy,
            // 版本号/仓库地址不是这次请求的结果 —— 通道坏了也留着（页脚不该跟着消失）
            version: this.snapshot.version ?? null,
            runningVersion: this.snapshot.runningVersion ?? null,
            repoUrl: this.snapshot.repoUrl ?? null,
            pending: [],
            error: message,
            errorVisible: message,
            // 缺陷 27：正在自动重试时，卡片说的是"还没就绪、正在重试"，
            // 而不是摆出"通道出错"的架势（开机竞态不该看起来像插件坏了）。
            retrying: this.retryTimer !== null,
            retryAttempt: this.retryCount,
          };
        }
        this.publish();
        await this.markSeenForVisible(seenKeys);
        return this.snapshot;
      }

      /** 渲染即记 seen（**不重新拉取**，见类注释）。没显示出来的那些组也一起记上。 */
      async markSeenForVisible(keys = []) {
        if (!keys.length) return;
        try {
          SuggestionFeed.unwrap(await this.call('markSeen', keys));
        } catch (error) {
          // 记 seen 失败不致命：下一轮卡片会再出现一次（宁可多提醒，不要静默）
          this.snapshot = { ...this.snapshot, error: String(error && error.message ? error.message : error) };
          // 同缺陷 26：错误既然显示出来了，就得有东西负责把它收掉
          this.scheduleRetry();
          this.publish();
        }
      }

      /** 点「不用」→ 宿主记 dismissed（prompt 与卡片都不再提）。 */
      async dismiss(key) {
        try {
          SuggestionFeed.unwrap(await this.call('dismiss', key));
          this.snapshot = { ...this.snapshot, visible: this.snapshot.visible.filter((g) => g.key !== key) };
        } catch (error) {
          this.snapshot = { ...this.snapshot, error: String(error && error.message ? error.message : error) };
        }
        this.publish();
      }

      /** 点「提炼」→ 宿主记待办，下一轮 Block E 会催模型去 distill。 */
      async requestDistill(key) {
        try {
          SuggestionFeed.unwrap(await this.call('requestDistill', key));
          this.snapshot = {
            ...this.snapshot,
            visible: this.snapshot.visible.filter((g) => g.key !== key),
            pending: [...this.snapshot.pending, key],
          };
        } catch (error) {
          this.snapshot = { ...this.snapshot, error: String(error && error.message ? error.message : error) };
        }
        this.publish();
      }

      /**
       * 点「提炼成技能」→ **宿主现在就调模型把 SKILL.md 写出来**（缺陷 25）。
       *
       * 以前这一步只记待办（`requestDistill`），真正的提炼要等下一轮注入里的 Block E
       * 催模型去调工具 —— 于是用户点完按钮**什么都看不到**：那一行被去掉，没有第二阶段。
       *
       * 现在：成功后草稿立刻出现在卡片上（技能名 + 作用 + SKILL.md 全文 + 装/丢两个按钮）；
       * 失败（没开抽取 / 没模型 / 模型报错 / 自校验不过）也如实显示 —— 并且**顺手记一条待办**，
       * 这样"宿主这侧没模型"的情况下，下一轮对话里我照样会把它提炼出来（两条路都不丢）。
       *
       * @returns `{ok, fallback?, error?}` —— 供卡片决定要不要写一行说明
       */
      async distill(key, title = '') {
        if (this.snapshot.draftBusy !== null) return { ok: false, error: '已经有一个提炼/安装动作在跑' };
        this.snapshot = {
          ...this.snapshot,
          draftBusy: { kind: 'distill', key, title },
          error: null,
          errorVisible: null,
        };
        this.publish();
        try {
          const value = SuggestionFeed.unwrap(await this.call('distill', key));
          if (value && value.ok === false) throw new Error(value.error ?? '提炼失败');
          const draft = {
            name: value.name,
            description: value.description ?? '',
            content: value.content ?? '',
            installPath: value.installPath ?? null,
          };
          this.snapshot = {
            ...this.snapshot,
            draftBusy: null,
            drafts: [...this.snapshot.drafts.filter((d) => d.name !== draft.name), draft],
          };
          this.publish();
          return { ok: true, name: draft.name };
        } catch (error) {
          const message = String(error && error.message ? error.message : error);
          // 兜底：把这一组记成"待提炼"，下一轮 Block E 会催模型调工具去做（旧的路径仍然有用）
          let fallback = false;
          try {
            SuggestionFeed.unwrap(await this.call('requestDistill', key));
            fallback = true;
          } catch {
            /* 连待办都记不上：那错误横幅里已经有原始原因了 */
          }
          this.snapshot = {
            ...this.snapshot,
            draftBusy: null,
            pending: fallback ? [...this.snapshot.pending, key] : this.snapshot.pending,
            error: message,
            errorVisible: message,
          };
          this.publish();
          return { ok: false, fallback, error: message };
        }
      }

      /** 点「装进技能库」→ 宿主把草稿移进技能库（装完当轮即生效，不用重启）。 */
      async approveDraft(name) {
        return this.draftAction('approve', name);
      }

      /** 点「丢掉」→ 删掉这份草稿。 */
      async rejectDraft(name) {
        return this.draftAction('reject', name);
      }

      /** 装 / 丢共用的那一段（只有端点名与成功文案不同）。 */
      async draftAction(kind, name) {
        if (this.snapshot.draftBusy !== null) return { ok: false, error: '已经有一个提炼/安装动作在跑' };
        this.snapshot = { ...this.snapshot, draftBusy: { kind, name }, error: null, errorVisible: null };
        this.publish();
        try {
          const value = SuggestionFeed.unwrap(await this.call(kind, name));
          if (value && value.ok === false) throw new Error(value.error ?? `${kind} 失败`);
          this.snapshot = {
            ...this.snapshot,
            draftBusy: null,
            drafts: this.snapshot.drafts.filter((d) => d.name !== name),
          };
          this.publish();
          return { ok: true, name, value };
        } catch (error) {
          const message = String(error && error.message ? error.message : error);
          this.snapshot = { ...this.snapshot, draftBusy: null, error: message, errorVisible: message };
          this.publish();
          return { ok: false, error: message };
        }
      }

      inject() {
        return {
          hooks: { memfuseSuggestions: this.store },
          dismiss: (key) => this.dismiss(key),
          requestDistill: (key) => this.requestDistill(key),
          distill: (key, title) => this.distill(key, title),
          approveDraft: (name) => this.approveDraft(name),
          rejectDraft: (name) => this.rejectDraft(name),
          /** 让卡片重画一次（装完/丢完要写一行结果说明，那一行挂在钉住的那份上）。 */
          rerender: () => this.publish(),
          touch: () => this.touch(),
          /** 窗口重新可见/被聚焦时敲一下（缺陷 27；`apply()` 里已挂好监听，这里也暴露出来）。 */
          wake: () => this.wake(),
          claim: () => this.claim(),
        };
      }
    }

    /**
     * 卡片"已经显示出来的那一份" —— 只钉住**一份**，键是 `<sessionId>:<回合 id>`。
     *
     * 为什么非有它不可（缺陷 23，真机抓的）：
     * 卡片渲染路径上还挂着一次去抖刷新（`props.touch()` → 1.5s 后 `list`），而卡片
     * **一渲染就把那几组记成 seen**（`markSeenForVisible`）—— 于是那次刷新回来必然是空的，
     * `state.visible` 被清成 `[]`，卡片当场把自己撤掉。
     *
     * 钉住的范围刻意收得很小：
     *   - 键里有回合 id（`turnIdOf`）→ 只属于**这一个回合**，下一个回合是新键，
     *     不会把旧候选拖过去；
     *   - 键里有 `sessionId` → 换一个对话也不会串台（"每个对话都出现"是缺陷 20 的另一面）；
     *   - 只留一份 → 不会无界增长。
     * 用户对某一行动了手（提炼 / 不用）→ 用 `unpinRow` 把它从这份里也去掉，
     * 否则会出现"点了没反应"。
     */
    let pinnedCard = null;

    /** 这一行已经被处理过了 → 钉住的那份里也要去掉。 */
    function unpinRow(key) {
      if (pinnedCard === null) return;
      pinnedCard = { ...pinnedCard, rows: pinnedCard.rows.filter((row) => row.key !== key) };
    }

    /**
     * 卡片上的"结果说明"（"已装进技能库：xxx"）—— **按回合**存，`{key, text}`。
     *
     * 为什么寿命是"这一个回合"：用户点完「装进技能库」之后草稿就从列表里没了，
     * 如果卡片当场整个消失，那就又变成"点了没反应"（缺陷 25 的另一面）。
     * 所以这一句挂在这个回合的键上，下一回合自然不带过去。
     *
     * ⚠️ 与 `pinnedCard` **分开存**：没有候选行（`claim()` 拿到空的）时也要能写说明 ——
     * 刷新页面后卡片上只有草稿、没有候选行，那种情况下也得给得出"已装进技能库"。
     */
    let cardNote = null;

    /** 写一句结果说明（`key` = 当前回合的键）。 */
    function setCardNote(key, text) {
      cardNote = { key, text: text ?? null };
    }

    /**
     * 取"回合 id"。
     *
     * ⚠️ 真机上 `props.turn` 是**对象**（`node.location.turn` = `{turn: <id>, status}`，
     * 见 `dsh-client-ui-chat/lib/client.js` 的 `TurnTailNodeView` L6577），
     * 而 `snapshot.timeline.turnOrder` 里放的是 **id**（官方 owner 的判据是
     * `turnOrder.at(-1) !== data.turn`，而 `data.turn` 就是那个 id）。
     *
     * 所以**不能**直接 `String(props.turn)` 去比：一边 `"5"`、一边 `"[object Object]"`
     * → 恒不相等 → 卡片**永远不出现**（缺陷 24，真机上整整一天没画出来过）；
     * 反过来若两边都是对象，则恒相等 → 每个回合都来一张（缺陷 20）。
     * 认不出形状时返回 undefined，交给调用方"别把功能藏起来"。
     */
    function turnIdOf(turn) {
      if (turn !== null && typeof turn === 'object') return turn.turn ?? turn.id;
      return turn;
    }

    /** 回合尾部的候选卡片：一组一行 + 两个按钮。 */
    function MemfuseSuggestionCard(props) {
      const { t } = props;
      // ① 先回答"这张卡该不该长在这儿"：**只长在这一轮对话的最后一个回合的尾巴上**。
      //
      // 槽位是 per-turn 渲染的（`dsh-client-ui-chat` 的 `TurnTailNodeView` 给每个
      // 回合都渲染一次 turnTail），不加这道门就会在**每一个回合**尾巴上各来一张 ——
      // 真机上一眼就看出问题："每个对话底部都出现这个卡片了"。
      // 判据照抄官方 owner 自己的写法：`snapshot.timeline.turnOrder.at(-1) === turn`。
      //
      // ⚠️ hooks 不能有条件地调用：`useChat` 与下面的 `useMemfuseSuggestions` 必须
      // **每次渲染都按同样顺序调用**，早退要放在两者之后（React 的 Rules of Hooks）。
      const isLastTurn = props.useChat
        ? props.useChat((snapshot) => {
            const order = snapshot?.timeline?.turnOrder;
            if (!Array.isArray(order) || order.length === 0) return true; // 拿不到就按"是"处理，别把功能藏起来
            const last = turnIdOf(order[order.length - 1]);
            const mine = turnIdOf(props.turn);
            // 认不出 id 就按"是"处理 —— 这一条写死过，代价是卡片整整一天不出现（缺陷 24）
            if (last === undefined || mine === undefined) return true;
            return String(last) === String(mine);
          })
        : true;
      // 先推一次刷新（去抖）：没有候选时也要推，否则新候选永远不会自己冒出来。
      props.touch();
      const state = props.useMemfuseSuggestions((snapshot) => snapshot);
      if (!isLastTurn) return null;
      // ② 这一回合要显示什么，**只领一次**：把宿主刚交回来的那份从共享快照里领走
      //    （`claim()` 领走即清空）。领到就钉住，之后那次空刷新撤不掉它 —— 见上面 pinnedCard。
      //    ⚠️ 两件事都必须在 `isLastTurn` 之后：
      //      · 别的回合的卡片也会渲染，让它们领就会把候选领给一个根本不显示的回合；
      //      · "领走"的语义是"已经交给某一个回合了"，所以下一个回合自然拿到空的
      //        —— 上一回合的候选不会在新回合里再摆一遍。
      const pinKey = `${props.sessionId ?? ''}:${turnIdOf(props.turn)}`;
      if (pinnedCard === null || pinnedCard.key !== pinKey) {
        const taken = state.status === 'ready' ? props.claim() : null;
        if (taken !== null) pinnedCard = { key: pinKey, rows: taken.rows, restCount: taken.restCount };
      }
      const pinned = pinnedCard !== null && pinnedCard.key === pinKey ? pinnedCard : null;
      const rows = pinned === null ? [] : pinned.rows;
      const restCount = pinned === null ? 0 : pinned.restCount;
      // ②′ 第二阶段（缺陷 25）：**待确认的技能草稿**。这一份不钉住 —— 真源在宿主磁盘上
      //     （`pending-skills/`），每次 `list` 都会带回来，所以空刷新撤不掉它、
      //     刷新页面也照样在（候选行要钉住是因为它们"领走即清空"，草稿不是）。
      const drafts = Array.isArray(state.drafts) ? state.drafts : [];
      // `?? null`：手搓的快照（测试/预览）里可能根本没这个字段 —— 不能因为少一个键就整块炸
      const busy = state.draftBusy ?? null;
      const note = cardNote !== null && cardNote.key === pinKey ? cardNote.text : null;
      // ③ 通道坏了 / 动作失败了：说出来。只表现为"卡片永远不出现 / 点了没反应"是本项目
      //    最难查的失败（硬规则 4）。已经显示着卡片时**不换**成这行报错 —— 错误照样会在
      //    卡片底部显示（见下面 children 里那一段），所以这里只决定"有没有东西可渲染"。
      const errorText = state.error ?? state.errorVisible ?? null;
      // 缺陷 27：通道还没就绪时**别摆出"出错了"的架势** —— 那只是启动竞态，
      // 客户端正在自动重试。把它说成"正在重试"，连上之后这一行自己消失。
      const retrying = state.retrying === true;
      if (rows.length === 0 && drafts.length === 0 && busy === null && note === null && errorText === null) {
        return null;
      }
      return jsxs('div', {
        className: 'dsh-memfuse-card',
        children: [
          rows.length > 0
            ? jsx('p', { className: 'dsh-memfuse-card-title', children: t('suggestTitle') })
            : null,
          ...rows.map((group) => {
            // 「这技能里有什么」：宿主给前 4 条成员标题，多的用省略号收尾。
            // 以前只写「3 条记忆 · 7 分」—— 用户既不知道内容、也不知道分数什么意思。
            const titles = Array.isArray(group.memberTitles) ? group.memberTitles.filter(Boolean) : [];
            const total = Number(group.members ?? titles.length) || titles.length;
            const more = Math.max(0, total - titles.length);
            const memberText = titles.length
              ? t('suggestMembers', { count: total, titles: `${titles.join('、')}${more > 0 ? '…' : ''}` })
              : t('suggestMembersPlain', { count: total });
            return jsxs(
              'div',
              {
                className: 'dsh-memfuse-suggest',
                children: [
                  jsxs('div', {
                    className: 'dsh-memfuse-suggest-top',
                    children: [
                      jsx('p', {
                        className: 'dsh-memfuse-suggest-seed',
                        children: `「${group.seedTitle}」`,
                      }),
                      jsxs('div', {
                        className: 'dsh-memfuse-card-actions',
                        children: [
                          jsx('button', {
                            type: 'button',
                            className: 'dsh-memfuse-card-button',
                            'data-variant': 'primary',
                            onClick: () => {
                              // 这一行先撤掉、换成"提炼中…"那行 —— 提炼要调模型（可能几十秒），
                              // 没有进行中状态的话用户看到的就是"点完没反应"。
                              unpinRow(group.key);
                              void props.distill(group.key, group.seedTitle);
                            },
                            children: t('suggestDistill'),
                          }),
                          jsx('button', {
                            type: 'button',
                            className: 'dsh-memfuse-card-button',
                            'data-variant': 'ghost',
                            onClick: () => {
                              unpinRow(group.key);
                              void props.dismiss(group.key);
                            },
                            children: t('suggestDismiss'),
                          }),
                        ],
                      }),
                    ],
                  }),
                  jsx('p', { className: 'dsh-memfuse-suggest-line', children: memberText }),
                  group.useWhen
                    ? jsx('p', {
                        className: 'dsh-memfuse-suggest-line',
                        children: t('suggestUseWhen', { text: group.useWhen }),
                      })
                    : null,
                  // 「对我有什么帮助」—— 这句话是这个卡片存在的理由，别省
                  jsx('p', { className: 'dsh-memfuse-suggest-why', children: t('suggestWhy') }),
                ],
              },
              group.key,
            );
          }),
          // 只显示了前几组（`skill.suggestMax`，默认 1）；其余的别装作不存在 ——
          // 它们在 Block E 与 `memfuse_skill action=list` 里都还在，说清去哪儿看。
          restCount > 0
            ? jsx('p', {
                className: 'dsh-memfuse-card-hint',
                children: t('suggestRest', { count: restCount }),
              })
            : null,
          // ── 提炼 / 安装进行中 ────────────────────────────────
          busy !== null
            ? jsx('p', {
                className: 'dsh-memfuse-card-hint',
                role: 'status',
                children:
                  busy.kind === 'distill'
                    ? t('distillRunning', { title: busy.title ?? '' })
                    : t('draftWorking'),
              })
            : null,
          // ── 提炼好了：**先过一眼再决定装不装** ────────────────
          ...drafts.map((draft) =>
            jsxs(
              'div',
              {
                className: 'dsh-memfuse-card-draft',
                children: [
                  jsx('p', { className: 'dsh-memfuse-card-title', children: t('draftTitle') }),
                  jsxs('div', {
                    className: 'dsh-memfuse-card-main',
                    children: [
                      jsx('strong', { children: draft.name }),
                      draft.description
                        ? jsx('span', {
                            className: 'dsh-memfuse-card-meta',
                            children: t('draftUseWhen', { text: draft.description }),
                          })
                        : null,
                    ],
                  }),
                  // SKILL.md 原文（提示词本体）—— 用户要看的就是这个，别截断、别折叠成一句话。
                  // 前面先给一句人话说明：原文里有 `--- name: … ---` 这种格式，不解释会像代码。
                  jsx('p', { className: 'dsh-memfuse-suggest-line', children: t('draftContent') }),
                  jsx('pre', { className: 'dsh-memfuse-card-skill', children: draft.content }),
                  draft.installPath
                    ? jsx('p', {
                        className: 'dsh-memfuse-card-hint',
                        children: t('draftWhere', { path: draft.installPath }),
                      })
                    : null,
                  jsxs('div', {
                    className: 'dsh-memfuse-card-actions',
                    children: [
                      jsx('button', {
                        type: 'button',
                        className: 'dsh-memfuse-card-button',
                        onClick: async () => {
                          const res = await props.approveDraft(draft.name);
                          setCardNote(pinKey, res && res.ok ? t('draftInstalled', { name: draft.name }) : null);
                          props.rerender();
                        },
                        children: t('draftApprove'),
                      }),
                      jsx('button', {
                        type: 'button',
                        className: 'dsh-memfuse-card-button',
                        onClick: async () => {
                          const res = await props.rejectDraft(draft.name);
                          setCardNote(pinKey, res && res.ok ? t('draftDropped', { name: draft.name }) : null);
                          props.rerender();
                        },
                        children: t('draftReject'),
                      }),
                    ],
                  }),
                ],
              },
              `draft:${draft.name}`,
            ),
          ),
          // 装完 / 丢完的那一句结果说明（挂在这一回合上，下一回合自然消失）
          note !== null
            ? jsx('p', { className: 'dsh-memfuse-card-hint', role: 'status', children: note })
            : null,
          rows.length > 0 ? jsx('p', { className: 'dsh-memfuse-card-hint', children: t('suggestHint') }) : null,
          errorText !== null
            ? jsx('p', {
                className: 'dsh-memfuse-card-hint',
                role: 'status',
                children: retrying
                  ? `${t('suggestWarming', { count: Math.max(1, Number(state.retryAttempt ?? 1)) })}${errorText}`
                  : `${t('suggestError')}${errorText}`,
              })
            : null,
        ],
      });
    }

    /** 中文文案。 */
    const zh = {
      nav: '记忆',
      summary: '配置抽取记忆用哪个模型（可以跟随对话模型）、不可用时怎么办、候选怎么落盘',
      unavailable: '当前部署没有为 dsh-memfuse 提供可写的配置。',
      readOnly: '这个部署把设置存为只读，改动不会落地。',
      saveFailed: '保存失败，请重试。',
      saveRejected: '宿主拒绝了这次写入，改动的路径：{paths}。宿主只接受 **volatile** 字段 —— 非 volatile 的只能改 profile 的 cordis.patch.yml（改完重启）。',
      save: '保存',
      saving: '保存中…',
      dirty: '有未保存的改动 —— 点「保存」才会写入。',
      saved: '已保存 ✓ 配置已生效（抽取会在下一次启动/触发时用它）。',
      clean: '当前显示的就是已生效的配置，没有未保存的改动（所以「保存」是灰的）。',
      overridden: '已覆盖',
      clear: '清除',
      notSelected: '（未选择）',
      noModels: '宿主没有可用模型 —— 先去「设置 → 模型」配一个 provider。',
      loadingModels: '正在读取模型列表…',
      catalogFailed: '读不到模型列表',
      // ── 设置页：分组 + 记忆学习横幅（2026-10-17）──
      groupLearn: '记忆学习（LLM 抽取）',
      groupFallback: '模型不可用时',
      groupOutput: '学到的记忆与技能',
      learnOffTitle: '记忆学习已关闭 —— 插件不会从对话里学新记忆',
      learnOffBody:
        '对话原文仍会落盘，记忆的读写、注入、检索、技能判定也照常；但不会再提炼出新记忆。想让它开始学习就把开关打开（默认是开的）。',
      learnOffAction: '开启记忆学习',
      learnNoModelTitle: '已开启，但还没有可用的模型 —— 学习不会发生',
      learnNoModelBody:
        '抽取需要一个模型：勾「跟随对话模型」最省事（直接用对话框里选的那个），也可以在下面挑一个。',
      learnNoModelAction: '跟随对话模型',
      learnReadyTitle: '记忆学习已开启',
      learnReadyBody: '模型来源：{source}；新记忆以「{mode}」落盘。对话原文会先落盘成素材，再自动提炼成记忆。',
      sourceFollow: '跟随对话模型（对话框里选的那个）',
      sourceExplicit: '显式挑选的模型',
      modeSuggest: '先确认',
      modeAuto: '直接写入',
      note: '关掉「记忆学习」也不会影响记忆的读写、注入、检索与技能判定 —— 只是不再从对话里学新东西。其余配置项（注入预算、生命周期、捕获开关等）在 profile 的 cordis.patch.yml 里改。',
      suggestTitle: '这组记忆可以变成一条技能',
      // ⚠️ 这里**必须是字符串模板**，不能写成 `({members}) => ...` 的函数！
      // 官方 locale 的实现是 `template.replace(/\{(\w+)\}/g, ...)`（`dsh-client-locale/lib/client.js:1427`）——
      // 传函数进来会在**渲染期**抛 `template.replace is not a function`，
      // 表现是"卡片永远不出现"，零报错（真机踩过，见 test/client.test.mjs 的假 t）。
      //
      // 2026-10-18 改文案：真机反馈「描述太难懂，不知道技能内容是什么、对自己有什么帮助」。
      // 于是每一条候选现在说清三件事：① 它是什么（种子标题 + 成员标题）② 什么时候用得上
      // （anchor）③ 做成技能对自己有什么好处（suggestWhy）。分数**删掉** —— 对用户没有意义。
      suggestMembers: '包含的同类记忆（{count} 条）：{titles}',
      suggestMembersPlain: '包含 {count} 条同类记忆',
      suggestUseWhen: '什么时候用得上：{text}',
      suggestWhy: '把它变成技能后：以后遇到同类情况，我会直接按这套做法来 —— 你不用再解释一遍，也不会重复踩同一个坑。',
      suggestDistill: '提炼成技能',
      suggestDismiss: '不用',
      suggestRest: '（另外还有 {count} 组同类候选，想看就告诉我）',
      suggestHint: '点「提炼成技能」会先写出来给你看；点「不用」以后就不再提这一组了。',
      suggestError: '界面通道出错：',
      // 缺陷 27：开机竞态（宿主还在挂端点）说的话 —— 不吓人、不用用户动手
      suggestWarming: '记忆通道还没就绪（宿主正在挂载端点），正在自动重试 —— 第 {count} 次，连上后这一行会自己消失。原始原因：',
      // ── 第二阶段：草稿预览 + 装 / 丢（缺陷 25）──
      distillRunning: '正在把「{title}」写成技能… 大概要几十秒，写好会直接出现在这里',
      draftTitle: '刚写好的技能，先看看再决定收不收',
      draftUseWhen: '以后遇到「{text}」的时候会用上',
      draftContent: '它以后就照着下面这段内容做事：',
      draftWhere: '收下后存在：{path}（马上就能用，不用重启）',
      draftApprove: '收下这条技能',
      draftReject: '不要了',
      draftWorking: '正在处理…',
      draftInstalled: '收下了：{name} ✓ 现在就能用，不用重启。',
      draftDropped: '不要了，这份内容已删掉。',
      cardReady: '候选卡片：已连上（{groups} 组候选待你决定）',
      cardFailed: '候选卡片读不到数据：',
      remoteFailed: '界面数据通道没挂上：',
      remoteHint: '装好之后，记忆里出现够格的技能簇时，会在回合尾部出现一张卡片（可以点「提炼成技能」或「不用」）。',
      // ── 页脚：版本 / 检查更新 / 安装更新 / GitHub 点赞（2026-10-18）──
      versionUnknown: '版本未知',
      updateCheck: '检查更新',
      updateCheckingBtn: '检查中…',
      updateInstall: '安装更新',
      updateInstallingBtn: '更新中…',
      updateStar: '去 GitHub 点个赞 ⭐',
      updateRestartHint: '（重启后生效）',
      updateIdle: '还没检查过 —— 点「检查更新」去 GitHub 看看有没有新版。',
      updateChecking: '正在连 GitHub 查最新版本…',
      updateInstalling: '正在从 GitHub 拉取新版本…（要十几秒，别关这个页面）',
      updateLatest: '已是最新（{version}{head}）',
      updateAvailable: 'GitHub 上有新版本（{from}{to}，落后 {behind} 次提交）—— 点「安装更新」拉下来，装完重启 DSH 生效',
      updateAvailableSameVersion: 'GitHub 上有新提交（{from}，落后 {behind} 次提交）—— 点「安装更新」拉下来，装完重启 DSH 生效',
      // ⚠️ 别把这条写成"已用上新版"：拉下来的代码要重启才加载（没有热更新）
      updateInstalled: '已更新到 {version} —— 重启 DSH 后生效（新代码要重启才加载）',
      updateInstalledSameVersion: '已拉到最新代码（版本号还是 {version}）—— 重启 DSH 后生效',
      updateInstalledNoChange: '已经是最新的（{version}），没有可更新的内容',
      updateInstallFailed: '更新没成功：{error}',
      updateFailed: '检查更新没成功：{error}',
      updateUnsupported: '这个安装方式没法自动检查更新（用 dsh plugin add 重装可以拿到新版）',
    };

    /** 英文文案。 */
    const en = {
      nav: 'Memory',
      summary: 'Choose the model used to extract memories (or follow the conversation model), its fallback, and how candidates land',
      unavailable: 'This deployment serves no writable configuration for dsh-memfuse.',
      readOnly: 'This deployment stores settings read-only; edits will not land.',
      saveFailed: 'Could not save. Try again.',
      saveRejected: 'The Host refused this write; changed paths: {paths}. Only **volatile** fields are writable — others live in the profile cordis.patch.yml (restart to apply).',
      save: 'Save',
      saving: 'Saving…',
      dirty: 'You have unsaved edits — press Save to write them.',
      saved: 'Saved ✓ The configuration is live.',
      clean: 'These are the live values; nothing is pending (that is why Save is disabled).',
      overridden: 'Overridden',
      clear: 'Clear',
      notSelected: '(none)',
      noModels: 'The Host advertises no models — configure a provider under Settings → Models first.',
      loadingModels: 'Loading the model list…',
      catalogFailed: 'Could not read the model list',
      groupLearn: 'Memory learning (LLM extraction)',
      groupFallback: 'When the model is unavailable',
      groupOutput: 'Learned memories and skills',
      learnOffTitle: 'Memory learning is off — the plugin will not learn from your conversations',
      learnOffBody:
        'Conversation text is still captured, and read, write, injection, recall and skill checks keep working; but no new memories get distilled. Turn the switch on to start learning (it is on by default).',
      learnOffAction: 'Turn on memory learning',
      learnNoModelTitle: 'Learning is on, but no model is available — nothing will be learned',
      learnNoModelBody:
        'Extraction needs a model: ticking “Follow the conversation model” is the easiest (it uses whatever the composer has selected), or pick one below.',
      learnNoModelAction: 'Follow the conversation model',
      learnReadyTitle: 'Memory learning is on',
      learnReadyBody: 'Model source: {source}; new memories land as “{mode}”. Conversation text is captured first, then distilled into memories.',
      sourceFollow: 'following the conversation model (the one selected in the composer)',
      sourceExplicit: 'an explicitly picked model',
      modeSuggest: 'review first',
      modeAuto: 'write directly',
      note: 'Turning memory learning off does not affect read, write, injection, recall or skill checks — it only stops learning new things from conversations. Everything else (injection budgets, lifecycle, capture) lives in the profile cordis.patch.yml.',
      suggestTitle: 'These memories can become one reusable skill',
      suggestMembers: 'Related memories ({count}): {titles}',
      suggestMembersPlain: '{count} related memories',
      suggestUseWhen: 'Comes up when: {text}',
      suggestWhy: 'Once it is a skill: next time the same situation comes up I follow this recipe directly — no re-explaining, no repeating the same mistake.',
      suggestDistill: 'Turn it into a skill',
      suggestDismiss: 'No thanks',
      suggestRest: '({count} more groups like this — just ask if you want to see them)',
      suggestHint: 'It writes the skill out first so you can read it; “No thanks” never brings this group up again.',
      suggestError: 'UI channel error: ',
      suggestWarming: 'The memory channel is not ready yet (the host is still mounting its endpoints) — retrying automatically, attempt {count}. This line disappears once it connects. Original error: ',
      distillRunning: 'Writing “{title}” into a skill… this takes a few dozen seconds; it will show up right here',
      draftTitle: 'Here is the skill it just wrote — take a look before you decide',
      draftUseWhen: 'It will come in handy when: {text}',
      draftContent: 'From now on it will follow what is written below:',
      draftWhere: 'Kept at: {path} (works right away, no restart)',
      draftApprove: 'Keep this skill',
      draftReject: 'No, discard it',
      draftWorking: 'Working…',
      draftInstalled: 'Kept: {name} ✓ works right away, no restart.',
      draftDropped: 'Discarded.',
      cardReady: 'Suggestion card: connected ({groups} cluster(s) waiting for you)',
      cardFailed: 'Suggestion card cannot read its data: ',
      remoteFailed: 'The UI data channel is not mounted: ',
      remoteHint: 'Once mounted, a card appears at the end of a turn whenever a cluster is ready to become a skill.',
      versionUnknown: 'version unknown',
      updateCheck: 'Check for updates',
      updateCheckingBtn: 'Checking…',
      updateInstall: 'Install update',
      updateInstallingBtn: 'Updating…',
      updateStar: 'Star it on GitHub ⭐',
      updateRestartHint: ' (restart to apply)',
      updateIdle: 'Not checked yet — press “Check for updates” to ask GitHub.',
      updateChecking: 'Asking GitHub for the latest version…',
      updateInstalling: 'Pulling the new version from GitHub… (takes a few seconds, keep this page open)',
      updateLatest: 'Up to date ({version}{head})',
      updateAvailable: 'A newer version is on GitHub ({from}{to}, {behind} commit(s) behind) — press “Install update”, then restart DSH',
      updateAvailableSameVersion: 'New commits on GitHub ({from}, {behind} behind) — press “Install update”, then restart DSH',
      updateInstalled: 'Updated to {version} — restart DSH to load it (new code is only loaded at startup)',
      updateInstalledSameVersion: 'Pulled the latest code (version is still {version}) — restart DSH to load it',
      updateInstalledNoChange: 'Already up to date ({version}) — nothing to install',
      updateInstallFailed: 'Update failed: {error}',
      updateFailed: 'Update check failed: {error}',
      updateUnsupported: 'This installation cannot check for updates (reinstall with dsh plugin add to get new versions)',
    };

    /**
     * 把配置卡挂到「插件」页那一行上。
     * @param ctx - 浏览器插件上下文。
     */
    function apply(ctx) {
      const t = ctx.locale.bind(DICT);
      ctx.effect(() => ctx.locale.register(DICT, { zh, en }), 'dsh-memfuse: dictionaries');

      const scope = ctx.configForms.get(CONFIG_NS);
      // ⚠️ 把自己的 ctx 交给卡片（远程调用要用它）。**不要**用 `scope.ctx` ——
      // 那是提供方（ui-settings）的 fiber，没有注入 remote.session，见构造函数的注释。
      const card = new MemfuseConfigCard(scope, ctx);
      ctx.effect(() => () => card.dispose(), 'dsh-memfuse: form subscription');

      // 目录读取 + 失效重读：provider 变了 / 设置文档变了都重读一次（与官方页面同源）。
      try {
        ctx.effect(() => {
          const offs = [];
          if (typeof ctx.remote?.$on === 'function') {
            offs.push(ctx.remote.$on('llm/adapters-updated', () => void card.loadCatalog()));
            offs.push(ctx.remote.$on('settings/document-updated', () => void card.loadCatalog()));
          }
          void card.loadCatalog();
          return () => {
            for (const off of offs) if (typeof off === 'function') off();
          };
        }, 'dsh-memfuse: model catalog');
      } catch (error) {
        // 目录读不到不该拖垮配置卡：表单本身仍然可用（模型选择器会显示提示）。
        card.catalog = { status: 'error', groups: [], error: String(error && error.message ? error.message : error) };
      }

      // ── 回合尾部的候选卡片 ────────────────────────────────
      //
      // ⚠️ 这段的顺序**每一步都踩过坑**，别随手简化。真机先后出过两次
      // "卡片注册了却永远不出现、零报错"，根因分别在第 ①、② 步：
      //
      //   ① `ctx.remote.$mount(贡献)` 内部会执行
      //      `callerCtx.typert.remotes.register(贡献)` —— 用的正是**调用方 ctx**
      //      （`dsh-api-gateway/lib/client.js` 的 `mountContribution`）。第三方插件的
      //      ctx 不在客户端核心的 isolate 里，**必须自己声明 `typert`**，否则抛
      //      `cannot get property "typert" without inject`（真机截图里的原话）。
      //      官方 `dsh-api-gateway` 客户端半边自己也 inject 了 `["typert","connection"]`。
      //   ② 命名空间服务 `remote.memfuse` 是 `$mount` 之后才 provide 的，而且
      //      **点号服务要声明才能访问** —— 裸访问 `ctx.remote.memfuse` 会被 cordis 拒
      //      （`cannot get property "remote.memfuse" without inject`）。
      //
      // 所以顺序是：`ctx.inject(['typert','remote'])` 拿挂载用的 ctx → `$mount` →
      // 再 `inject(['remote.memfuse','slots','locale'])` 拿数据源用的 ctx。
      const remoteMount = { ok: false, reason: null };
      const mountRemote = ctx.remote?.$mount;
      if (typeof mountRemote !== 'function') {
        remoteMount.reason = '这个部署没有 ctx.remote.$mount（界面上拿不到宿主能力）';
      } else {
        /** 把数据源的实时状态交给配置页（卡片不出现时，用户至少能在这里看到原因）。 */
        const publishFeed = (snapshot) => {
          card.feed = { status: snapshot.status, groups: snapshot.visible.length, error: snapshot.error };
          // 页脚：版本号与仓库地址跟着数据源一起更新（宿主读 package.json 带回）
          if (snapshot.version !== undefined) card.info = { ...card.info, version: snapshot.version };
          if (snapshot.runningVersion !== undefined) card.info = { ...card.info, runningVersion: snapshot.runningVersion };
          if (snapshot.repoUrl !== undefined) card.info = { ...card.info, repoUrl: snapshot.repoUrl };
          card.publish();
        };
        ctx.effect(() => {
          let unmounted = false;
          let mountFiber = null;
          let cardFiber = null;
          const setup = new Promise((resolve, reject) => {
            mountFiber = ctx.inject(['typert', 'remote'], (mounter) => {
              void (async () => {
                // ⚠️ 必须从 **mounter** 上取 `$mount`（而不是从根 ctx 取下来再 .call）：
                // `$mount` 内部用的是 `this.ctx`（= 访问它的那个 ctx），
                // 从根 ctx 取就只能拿到根 ctx 的 typert —— 真机上就是那里没有。
                await mounter.remote.$mount(remoteContribution());
                if (unmounted) return;
                remoteMount.ok = true;
                card.remoteError = null;
                card.publish();
                cardFiber = mounter.inject([REMOTE_SERVICE, 'slots', 'locale'], (child) => {
                  // ⚠️ 这个子 ctx 才声明了 `remote.memfuse`；设置页的「检查更新」按钮必须用它
                  // （根 ctx 上访问会被 cordis 拒，缺陷 15）。卸下时清空，别留个失效的句柄。
                  card.remoteCtx = child;
                  const feed = new SuggestionFeed(child);
                  feed.listeners.add(() => publishFeed(feed.snapshot));
                  child.slots.inject(SUGGEST_SLOT, () =>
                    child.slots.register(
                      { name: SUGGEST_SLOT, id: SUGGEST_ID, order: 10, locale: DICT, inject: () => feed.inject() },
                      MemfuseSuggestionCard,
                    ),
                  );
                  void feed.load();
                  // 缺陷 27：窗口重新可见 / 被聚焦时再敲一次。开机竞态那种失败，用户
                  // 往往几秒后才切回窗口 —— 那时宿主早就 ready 了，不该还等下一次渲染。
                  child.effect(() => {
                    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') {
                      return () => {};
                    }
                    const win = typeof window === 'undefined' ? null : window;
                    const wake = () => {
                      if (document.visibilityState !== 'hidden') feed.wake();
                    };
                    document.addEventListener('visibilitychange', wake);
                    if (win !== null && typeof win.addEventListener === 'function') win.addEventListener('focus', wake);
                    return () => {
                      document.removeEventListener('visibilitychange', wake);
                      if (win !== null && typeof win.removeEventListener === 'function') win.removeEventListener('focus', wake);
                    };
                  }, 'dsh-memfuse: channel wake on focus');
                });
                await cardFiber;
              })().then(resolve, reject);
            });
          });
          void setup.catch((error) => {
            remoteMount.ok = false;
            remoteMount.reason = String(error && error.message ? error.message : error);
            card.remoteError = remoteMount.reason;
            card.publish();
          });
          return () => {
            unmounted = true;
            // 先撤卡片，再撤挂载用的那个子 ctx —— 那份贡献的清理挂在它的 effect 上，
            // 所以**不要**另外再调 `$mount` 返回的 disposer（会重复撤一次）。
            void setup.catch(() => {}).then(async () => {
              card.remoteCtx = null;
              if (cardFiber !== null) await cardFiber.dispose();
              if (mountFiber !== null) await mountFiber.dispose();
            });
          };
        }, 'dsh-memfuse: client remote contribution + turn-tail card');
      }
      if (remoteMount.reason) {
        card.remoteError = remoteMount.reason;
        card.publish();
      }

      /**
       * 三处入口，**同一个卡片**（草稿/保存只有一份，免得三边各存一半）：
       *
       * ① `settings.section`（id = `dsh-memfuse`）：**设置页左侧导航里的独立一页**
       *    「记忆」—— 一级入口，与「账号 / 通用 / 模型 / 插件 / Agent 预设」并列。
       *    `order: 25` 排在 Agent 预设（20）之后、其它第三方页（35/40）之前。
       *    `label` 传 thunk：槽位每次投影都重读，切语言不用重新注册。
       *    （2026-10-17 新增：用户原话「现在的设置页是在插件的设置页中，我想把他加到
       *    settingpage 中」—— 插件页藏在二级目录里，用户找不到。）
       *
       * ② `plugins.row.config`（key = `<包名>#<row id>`）：包页那一行**行标题变成可点按钮**
       *    （带 `›` 箭头，aria-label = 「配置 …」）。⚠️ 这一版**没有**单独的「配置」按钮 ——
       *    那个可点的标题**就是**配置入口（读 `RowsSection` 源码确认：注册上了才把
       *    `<span>{title}</span>` 换成 `<button>{title}<IconChevronRight/></button>`）。
       *    点进去是行详情页（面包屑「< 包名」）。
       *
       * ③ `plugins.bundle.config`（key = 包名）：**包页上直接渲染表单**，
       *    位置在描述和「包含的组件」之间。用户不用点任何东西就能看到配置。
       *
       * 三个槽都由 `whileServed` 包着：宿主不提供这个 namespace 时不留痕迹。
       */
      const face = () => ({
        locale: DICT,
        inject: () => card.inject(),
      });
      ctx.effect(
        () =>
          ctx.configForms.whileServed([CONFIG_NS], () => {
            const disposers = [
              ctx.slots.inject('plugins.bundle.config', () =>
                ctx.slots.register(
                  { name: 'plugins.bundle.config', key: CONFIG_NS, ...face() },
                  MemfuseConfigCardView,
                ),
              ),
              ctx.slots.inject('plugins.row.config', () =>
                ctx.slots.register({ name: 'plugins.row.config', key: ROW_KEY, ...face() }, MemfuseConfigCardView),
              ),
              // 一级设置页。⚠️ 别复用官方 id（会顶掉人家那一页），用自己的包名。
              ctx.slots.inject('settings.section', () =>
                ctx.slots.register(
                  {
                    name: 'settings.section',
                    id: SETTINGS_SECTION_ID,
                    order: SETTINGS_SECTION_ORDER,
                    label: () => t('nav'),
                    ...face(),
                  },
                  MemfuseConfigCardView,
                ),
              ),
            ];
            return () => {
              for (const dispose of disposers) if (typeof dispose === 'function') dispose();
            };
          }),
        'dsh-memfuse: settings page + plugins-page config cards',
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.ROW_KEY = ROW_KEY;
    exports.BUNDLE_KEY = CONFIG_NS;
    exports.CONFIG_NS = CONFIG_NS;
    exports.SETTINGS_SECTION_ID = SETTINGS_SECTION_ID;
    exports.SETTINGS_SECTION_ORDER = SETTINGS_SECTION_ORDER;
    // 给测试用：描述符必须与宿主 lib/remote.js 完全一致（防两侧漂移）
    exports.remoteDescriptors = remoteDescriptors;
    exports.remoteContribution = remoteContribution;
    exports.SUGGEST_SLOT = SUGGEST_SLOT;
    exports.SUGGEST_ID = SUGGEST_ID;
    /**
     * 这个配置页会写哪些路径 —— **给测试用的护栏**。
     *
     * 宿主只接受 volatile 路径的写入（`dsh-settings/lib/index.js:629`：非 volatile 抛
     * `Config field "<path>" is not volatile`，而且一次 mutate 里有一个非法 op 就整批拒）。
     * 于是"UI 上摆了个开关、字段却没标 volatile"会变成一按保存就失败、还看不出为什么
     * （缺陷 17）。测试拿这份清单去比对宿主 schema，谁再漏标 volatile 就当场红。
     */
    /** 给测试的接缝：把重试退避调到毫秒级（生产里没人改它）。 */
    exports.__retryConfig = RETRY;

    exports.WRITABLE_PATHS = FIELDS.flatMap((field) =>
      field.kind === 'picker' ? [field.providerPath, field.modelPath] : [field.path],
    );
    return module.exports;
  },
});
