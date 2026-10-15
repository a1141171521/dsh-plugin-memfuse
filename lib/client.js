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
      '.dsh-memfuse-tag{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
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
        path: ['extract', 'enabled'],
        label: '开启自动抽取（用 LLM）',
        hint: '默认关闭。关着的时候记忆的读写、注入、检索、技能判定全部照常，只是不从会话里自动抽记忆。',
      },
      {
        key: 'follow',
        kind: 'bool',
        path: ['extract', 'followConversation'],
        label: '跟随对话模型',
        hint: '勾上就用「对话框里选的那个模型」，主模型换了它跟着换，不用在这里再选一遍。',
      },
      {
        key: 'model',
        kind: 'picker',
        providerPath: ['extract', 'provider'],
        modelPath: ['extract', 'model'],
        label: '抽取用的模型',
        hint: '点开挑一个（数据源与对话框里的模型选择器相同）。没勾跟随、又没挑模型 = 抽取无从下手。',
      },
      {
        key: 'onUnavailable',
        kind: 'enum',
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
        providerPath: ['extract', 'fallbackProvider'],
        modelPath: ['extract', 'fallbackModel'],
        label: '降级模型',
        hint: '主模型不可用时改用它。留空 = 跟随「对话主模型」。',
        clearable: true,
      },
      {
        key: 'mode',
        kind: 'enum',
        path: ['extract', 'mode'],
        label: '抽到候选后怎么落盘',
        hint: 'suggest = 先进待确认队列等你批准；auto = 直接写入。',
        options: [
          { value: 'suggest', label: 'suggest（先确认）' },
          { value: 'auto', label: 'auto（直接写入）' },
        ],
      },
    ];

    const keyOf = (path) => path.join('.');
    const fieldId = (key) => `plugin-config-dsh-memfuse-${key}`;
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
        /** 最近一次保存成功过 —— 用来在表单上写「已保存 ✓」。 */
        this.saved = false;
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
        return { ...this.shell(), fields, catalog: this.catalog };
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
        };
      }

      /** 一次保存写掉全部草稿。 */
      async save() {
        const ops = this.ops();
        if (!ops.length || this.saving || !this.snapshotOf().writable) return;
        this.saving = true;
        this.failed = false;
        this.publish();
        try {
          const landed = await this.scope.mutate(ops, this.snapshotOf().revision);
          if (landed) {
            this.drafts.clear();
            this.saved = true;
          }
          this.failed = !landed;
        } catch (_error) {
          this.failed = true;
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
     * 「插件」页里那一行的一行说明 / 配置表单。
     * @param props - view、快照、动作与本地化文案。
     */
    function MemfuseConfigCardView(props) {
      const { t, view } = props;
      if (view === 'summary') return t('summary');
      const state = props.useMemfuseConfig((snapshot) => snapshot);
      const disabled = !state.writable;

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
          FIELDS.map((field) => {
            const fieldState = state.fields[field.key];
            if (field.kind === 'bool') {
              return jsx(
                BoolField,
                {
                  field,
                  state: fieldState,
                  disabled,
                  t,
                  onToggle: (checked) => props.toggleFollow(field.path, checked),
                },
                field.key,
              );
            }
            if (field.kind === 'picker') {
              return jsx(
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
              );
            }
            return jsx(
              EnumField,
              {
                field,
                state: fieldState,
                disabled,
                onPick: (value) => props.edit(field.path, value),
              },
              field.key,
            );
          }),
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
          jsx('p', { className: 'dsh-memfuse-note', children: t('note') }),
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
      note: '开关默认关着 = 不使用 LLM：记忆的读写、注入、检索、技能判定全部照常。其余配置项（注入预算、生命周期、捕获开关等）在 profile 的 cordis.patch.yml 里改。',
    };

    /** 英文文案。 */
    const en = {
      nav: 'Memory',
      summary: 'Choose the model used to extract memories (or follow the conversation model), its fallback, and how candidates land',
      unavailable: 'This deployment serves no writable configuration for dsh-memfuse.',
      readOnly: 'This deployment stores settings read-only; edits will not land.',
      saveFailed: 'Could not save. Try again.',
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
      note: 'The switch is off by default = no LLM: read, write, injection, recall and skill checks all keep working. Everything else (injection budgets, lifecycle, capture) lives in the profile cordis.patch.yml.',
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

      /**
       * 两处入口，**同一个卡片**（草稿/保存只有一份，免得两边各存一半）：
       *
       * ① `plugins.row.config`（key = `<包名>#<row id>`）：包页那一行**行标题变成可点按钮**
       *    （带 `›` 箭头，aria-label = 「配置 …」）。⚠️ 这一版**没有**单独的「配置」按钮 ——
       *    那个可点的标题**就是**配置入口（读 `RowsSection` 源码确认：注册上了才把
       *    `<span>{title}</span>` 换成 `<button>{title}<IconChevronRight/></button>`）。
       *    点进去是行详情页（面包屑「< 包名」）。
       *
       * ② `plugins.bundle.config`（key = 包名）：**包页上直接渲染表单**，
       *    位置在描述和「包含的组件」之间。用户不用点任何东西就能看到配置 ——
       *    这就是「入口不明显」的正解。
       *
       * 两个槽都由 `whileServed` 包着：宿主不提供这个 namespace 时不留痕迹。
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
            ];
            return () => {
              for (const dispose of disposers) if (typeof dispose === 'function') dispose();
            };
          }),
        'dsh-memfuse: plugins-page config cards',
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.ROW_KEY = ROW_KEY;
    exports.BUNDLE_KEY = CONFIG_NS;
    exports.CONFIG_NS = CONFIG_NS;
    return module.exports;
  },
});
