# dsh-memfuse 交接文档

> **给新会话的自己**：这份文档是自包含的。你没有前一个会话的上下文，
> 读完这一份就能接手。**唯一权威的功能清单是 [`spec.md`](spec.md)**，
> 本文件负责告诉你"怎么读它、别踩什么、现在在哪"。
>
> 最后校准：2026-10-15 收尾 · **72 项测试全绿**（49 + 23）·
> 已装进 **desktop + web 两个 profile** 并真机跑通
> · 真机缺陷累计 **12 个**，全修 + 回归测试（最新一个是 §5 坑 11：`session.events` 不存在）

---

## 0. 30 秒进入状态

**这是什么**：DSH（DeepSeek Harness）的长期记忆插件。纯文本 Markdown 存储、
本地检索，给 agent 一套**会遗忘、会自省、坏了会喊**的记忆。

**现在在哪**（2026-10-15）：

| 项 | 状态 |
|---|---|
| 测试 | **72 项全绿**（plugin 49 + smoke 23） |
| 安装 | desktop + web 两个 profile，`link:` + junction |
| 真机功能测试 | 40/40 |
| 真机补测 | 29/29 |
| 真实会话闭环 | ✅（注入归因写进 `state.json.lastInjection`） |
| 真实模型往返 | ✅ 真抽取 3/3 候选、真提炼出技能 |
| **真机缺陷** | **12 个，全修 + 回归测试** |
| **设置页** | ✅ 已实现（实测 `cordis_inspect_query` → Config `status: "schema"`） |
| **抽取降级** | ✅ `extract.onUnavailable = 'stop' \| 'fallback'` |
| **零 LLM 捕获** | ✅ 缺陷 12 修好后**才真的开始跑**（此前 `sessions/` 一直是空的） |

**三个最隐蔽的缺陷**（都靠真机才暴露，症状相同：**功能全对但界面/行为不出现**）：
- **缺陷 5**：`agent/pre-step` 是 waterfall，监听器不调 `next()` → **每轮对话崩**
- **缺陷 11**：`Config` 没放进 `export default` → **设置页静默消失、零报错**
- **缺陷 12**：`session.events` 在宿主上**不存在**（真名是 `ownEvents()`）→ **兜底捕获整条路径静默死掉**，
  `sessions/` 永远是空的、status.md 一片正常。详见 §5 坑 11 与 spec §3.12

**第一条命令**：

```powershell
cd <本仓库路径>
npm test          # 应该看到 75 + 29 + 5 + 23 = 132 项全绿（全部零 LLM 调用）
```

**⚠️ 改 Host half 必须重启 DSH** —— Node 的 ESM 模块缓存，同进程内 `import()`
不重读文件。实测：等 HMR ❌、`plugin_manager` 禁用再启用 ❌（fiber 重建了、
`apply()` 重跑了，模块还是缓存的旧版）。

**❌ 旧说法作废**：「唯一免重启的路是动态插件（`cordis_define`）」—— 本机**桌面版没有这套工具**：
`cordis` 预设只挂 `@deepseek-ai/dsh-tool-cordis`，而该包在本版**只 register 两个只读 inspect 工具**
（`lib/index.js` 全文 100 行）；`cordis_define` / `cordis_run` / `cordis_stop` / `cordis_undefine`
只在源码版 `deepseek-harness/packages/extensions/tool-cordis/src/index.ts` 里。
**✅ 已验证的免重启路 = 换进程 + `memfuse-smoke` 夹具**（§7 与 spec §3.12）。

**但配 patch.yml 是热生效的**（2026-10-15 实测）：改 `cordis.patch.yml` 里 dsh-memfuse 的
`config` → loader 重建 fiber → `apply()` 重跑 → `ready` 重新落盘 `state.json` / `status.md`。
**所以"status.md 被重写了"不代表"新代码进来了"** —— 判断 live 跑的是哪版代码，
只看 `status.md` 的 `代码版本:` 那一行（它由代码写死，patch 改不动）。
那次就是这么误判的：宿主 18:14:21 启动、`index.js` 18:16:25 才改，18:24 的 status.md
里没有新版本号 → 说明进程还在跑 18:14 的旧模块。

**先读什么**（按顺序）：

| 顺序 | 文件 | 为什么 |
|---|---|---|
| 1 | 本文件 | 上下文、纪律、坑 |
| 2 | [`docs/spec.md`](spec.md) §0–§2 | 定位、功能清单、技术线 |
| 3 | [`docs/spec.md`](spec.md) §3 全节 | 宿主 API 已核实 + **11 个真机缺陷** + 设置页四条件 |
| 4 | [`README.md`](../README.md) | 对外说明（部分内容已过时，以 spec.md 为准） |

---

## 1. 定位：做什么，以及**明确不做什么**

### 四条差异化（其余功能都只是"要有"）

1. **纯文本前提下的完整遗忘链**：过期 → 休眠 → 预算淘汰 → 物理删除 + 用户资产豁免
2. **打分与优先级/置信度/utility**：不是"有就注入"，而是"排序后按预算注入"
3. **失败可见**：管线故障本身变成一条注入内容（Block D）+ `status.md`
4. **可审计的学习闭环**：结构化反馈 + 跨会话计数 + 自动升级 + 决策留痕

### 明确不做

五轨模型 · 跨设备同步 · 无限画板 · 通知/IM · COI 调度 · 待办 · 技能管理器 UI ·
会话书签 · 模型设置 · Web UI Tab · i18n · client bundle · 图谱可视化 UI ·
权重自适应 · SQLite 派生索引

> 后两项是**实测后主动否掉**的，理由见 spec §3.5.5 与 §3.7。**不要再重新提议它们**，
> 除非触发条件成立（条数 > 2000 / 需要跨条目聚合查询）。

### 与参照产品的关系（四个都读过源码）

| 产品 | 它占住的位置 | 它留下的空位 |
|---|---|---|
| 云端超级记忆 | 完整遗忘 + 打分 + L0/L1/L2 | 记忆锁进 `memory.db`、语义检索要订阅、断网兜底是 30 词停用表 |
| Claude Desktop | 明文归用户、零 LLM 成本 | **没有遗忘**（只增不减）、没有检索 |
| Codex | 两阶段后台 agent + git | **失败不可见**（管线静默死三周）、无遗忘 |
| dsh-memory-evolve | 5 轨 + drift guard + 自审 + 合并技能 + 情绪反馈 + 同步 | 无自动衰减淘汰、无打分、14 模块、1.2MB 产物、无 CI |
| dsh-memsearch | 极简自动写入 | 依赖 558MB onnx 模型、无遗忘无打分无排序 |
| **memfuse** | — | **纯文本下的完整遗忘链 + 失败可见** ← 无人占据 |

**参照仓库都在本地**，可以随时回去读：
`..\dsh-memory-evolve`、`..\dsh-memsearch`、`..\dsh-memory`（Markdown 知识库那套）。

> ⚠️ **一个 store 只能有一个 owner**：memfuse 与 `dsh-memory` / `dsh-memory-evolve`
> 不能同时启用（工具名与语义都会冲突）。工具名已用 `memfuse_*` 前缀隔离。

---

## 2. 代码地图

```
lib/
├── index.js     124KB 2783 行  宿主半边入口：6 个工具 + 注入接线 + 宿主探测 + 捕获 + 维护 + status.md（**待拆，见下**）
├── client.js     83KB 1738 行  浏览器半边：设置页表单 + 回合尾候选卡片（**不拆文件，见下**）
├── store.js      18KB  489 行  存储层：frontmatter 往返 + 原子写 + drift guard + 锁
├── policy.js     14KB  357 行  策略层（纯函数）：打分 / 准入 / 生命周期 / 反馈 / 升级
├── distill.js    13KB  335 行  技能提炼：候选打分 + 标签聚类 + 提炼提示词
├── remote.js     13KB  294 行  界面数据通道：手写 Typert 贡献，7 个端点
├── config.js     11KB  178 行  宿主半边 Config schema（设置页的字段定义）
├── skill.js       9KB  242 行  SKILL.md 格式 I/O + 四个静默坑的对策 + approve/reject
├── recall.js      9KB  229 行  本地检索：CJK bigram + BM25 + excerpt
├── extract.js     9KB  216 行  记忆抽取：提示词 + 容错解析 + 准入 + 偏好加成
├── inject.js      8KB  175 行  注入装配：Block A/B/C/D/E + 信任边界 + 预算
├── antiseptic.js  5KB  121 行  反腐烂：重复检测 + stale 计划（标记，不删除）
├── queue.js       3KB  105 行  待确认队列：一条一项一文件
├── guard.js       3KB   68 行  凭据扫描：scanThreat / redactThreats
└── paths.js       1KB   42 行  路径布局（所有存储位置集中在这里）
```

**纯函数层**（`policy` / `recall` / `inject` / `antiseptic` / `distill` 的解析部分）
不依赖 DSH，可以单独跑测试。**IO 层**（`store` / `queue` / `skill` / `guard`）
只依赖 `node:`。

### 2.1 两个「巨石」的处置（2026-10-16，外部反馈）

**`lib/index.js`（2783 行）可以拆** —— Node 直接 `import()` 它，相对导入原生可用。
按现有函数边界拆成 12 个模块，入口只留 `apply()` + 再导出：

| 新文件 | 内容 | 原行范围 |
|---|---|---|
| `lib/state.js` | deepMerge / newId / readState / writeState | 136–176 |
| `lib/health.js` | FAULT_LABEL / noteFault / healthOf / runMaintenance | 178–360 |
| `lib/status.js` | writeStatus / probeHost | 362–532 |
| `lib/tools-kit.js` | textOutput / registerTool / textOfMessage / commitOrWarn | 533–600 |
| `lib/usage.js` | touchMemory / mutate / skillDirOf | 603–690 |
| `lib/suggest.js` | DISMISS_MAX / computeSuggestions / selectUiSuggestions / dismissSuggestion / markSuggestionsSeen / requestDistillKey / clearDistillRequest | 690–800 |
| `lib/skill-actions.js` | readSkillSources / writeSkillSources / pendingSkillDrafts / distillCluster / approveSkill / rejectSkill / hasShownSkill | 801–990 |
| `lib/capture.js` | pad2 / localDate / hhmm / isHumanMessage / extractExchange / sessionEvents / captureTurn | 1009–1170 |
| `lib/llm.js` | llmByCtx / llmFor / emptyOutputReason / makeModelCaller / writeCandidate | 1173–1300 |
| `lib/targets.js` | probeTarget / conversationTarget / extractTarget / fallbackTarget / followFallback / pickTarget / runWithTarget | 1342–1550 |
| `lib/extract-run.js` | runExtraction | 1552–1688 |
| `lib/util.js` | plainify / isOn | 1689–1713 |

依赖顺序（无环）：util → state → health → status → usage → suggest → skill-actions →
capture → llm → targets → extract-run → index(apply)。

**必须保住的契约**：入口继续导出 `name` / `inject` / `Config` / `apply` / `default`，
以及 `healthOf` / `computeSuggestions` / `selectUiSuggestions` / `dismissSuggestion` /
`markSuggestionsSeen` / `requestDistillKey` / `clearDistillRequest` / `pendingSkillDrafts` /
`distillCluster` / `approveSkill` / `rejectSkill` / `hasShownSkill` / `extractExchange` /
`sessionEvents` / `runMaintenance`（`test/plugin.test.mjs` 直接 import 入口与这些叶子模块）。
`apply()`（1714–2783，约 1070 行）**最后拆**：那里面是 28 个真机缺陷换来的事件顺序与
装配顺序，测试兜不住的部分全在那儿。

**`lib/client.js`（1738 行）不拆文件** —— 这是宿主契约要求的形状，不是懒：

1. 宿主 `@deepseek-ai/dsh-client-modules` 把 `exports["./client"]` 解析成**一个**
   `clientPath`，`readFileSync` 一次读成 bundle，再拼进 combo script 送浏览器。
   官方包的 client 文件是**构建产物**（tsdown），宿主找不到时的报错原文是
   `client bundle not found; run pnpm run build before launch`。我们这份是手写的，没有构建步骤。
2. 那个加载器**不支持相对 require**：`require('./x.js')` 会抛
   `missed the module table — not a platform seed word, not a materialized module,
   and no registered package factory`。实测扫官方全部 `lib/client.js`：**零处** `require('./...')`。
3. 唯一的多文件通路是 `require.async('./client.<name>.js')`：
   - 文件名必须匹配 `CLIENT_CHUNK = /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/`，
     文件放在入口同级（`join(dirname(clientPath), fileName)`），宿主按需路由
     `/plugins/<包名>/client.<name>.js?rev=` 服务；
   - 但它是**异步**的，而 bundle 工厂是**同步**的 → 卡片/设置页组件不能同步注册，
     只能"先注册壳、再异步换真身" —— 正是本项目已经踩出 4 个"卡片永不出现"缺陷的地方；
   - 更坑的是 **rev 只由入口文件的 stat 算**（`artifactRevision` 取自
     `statSync(clientPath)` 的 `{mtimeMs, ctimeMs, size}`）：chunk 改了而入口没动 → rev 不变 →
     chunk 以 `IMMUTABLE_CACHE` 送达 → 浏览器继续吃旧文件（重启也未必好，得硬刷新）。
     今天单文件没有这个坑：改 `lib/client.js` 就是改入口，rev 必变。

真要拆客户端**源码**，正路是引入构建步骤（tsdown 把 `src/client/*.ts` 打成**一个**
`lib/client.js`）——代价是多一条工具链，且要在 AGENTS.md 里写清"零第三方**运行时**依赖"
与构建期依赖的边界。收益不抵风险，暂不做；可读性靠文件顶部的分节目录。

### 数据布局

```
~/.dsh/memory/                     ← 真源，git 仓库
├── index.md                       L0 总索引（派生）
├── memories/<id>.md               事实 / 约定 / 决策 / 约束
├── skills/<id>.md                 skill / experience 类记忆
├── sessions/<date>.md             零 LLM 兜底捕获的原始问答
└── .memory/
    ├── state.json                 水位线 / 抽取进度 / 上次维护 / 技能候选
    ├── status.md                  人读健康报告（学习状态 / 队列 / 技能 / 反腐烂）
    ├── usage.jsonl                召回 / 注入 / 反馈 / 审批 事件
    ├── pending/<slug>.json        记忆待确认队列（一条一项一文件）
    ├── pending-skills/<name>/SKILL.md  技能待确认（批准 = 移动到技能库）
    └── skill-sources.json         技能 ← 记忆 的来源映射（derivedInto 用）
```

**技能库**（独立于记忆库）：默认 `<DSH_HOME>/skills`（本机 `~/.dsh/skills`）。
装完**当轮即生效**，不用重启。

---

## 3. 宿主 API 契约（**已核实，带证据**）

这一节是最容易踩坑的地方。**每一条都是实测过的，不是推测。**

### 3.1 工具注册

```js
ctx.tools.register({
  name: 'memfuse_xxx',
  description: '...',
  parameters: { type: 'object', properties: {...} },
  output: { schema: { type: 'string' }, render: (args, value) => [{ type: 'text', text: value }] },
  async execute(args, exec) { return '...'; },   // ← 是 execute，不是 handler
});
```

| 事实 | 证据 |
|---|---|
| 调用键是 **`execute`**（`handler` 全仓 0 命中） | `dsh-tools/lib/index.js:3181` |
| **`output` 是注册时强制项**，缺了**同步抛** `TypeError: tool "X" must declare output { schema, render, presentationMeta? }` | `dsh-tools/lib/types/index.js:464` |
| `output.render` 是**必需函数**（只给 schema 不够） | 同上（错误信息里列出的字段集） |
| 返回值按 `output.schema` 校验，违规抛 `ToolOutputError` | `dsh-tools/lib/index.js:3404-3407` |
| `ctx.tools` **只有** `register` / `restrict` / `guard` / `get` / `schemas` / `execute` | `api-catalog.js:4555` |
| `register()` 返回 disposer | `api-catalog.js:1942` |

### 3.2 每轮注入

```js
export const inject = ['tools', 'systemPrompt'];

ctx.systemPrompt.context({
  name: 'dsh-memfuse:memory',
  order: 118,                      // 字面量！见下
  text: () => '同步返回的字符串',    // ← 必须同步
});
```

| 事实 | 证据 |
|---|---|
| `text` 的 provider **被同步求值**（`section.text(context)` 直接调用，没有 `await`） | `dsh-system-prompt/lib/index.js:271,278` |
| `AssembleContext` **只有 `{ scope?, signal? }`** —— 拿不到当前用户输入 | `dsh-system-prompt/lib/types/index.d.ts:37-45` |
| **`getContextOrder` 在本机 `SystemPrompt` 类里不存在** | `api-catalog.js:4311` 的类声明 |
| 真实 order 参考：`sandbox:policy=110` / `approval:policy=115` / `subagent:delegation=120` | — |

**因此**：本轮用户输入必须由 `agent/pre-step` **同步缓存**到模块变量，
provider 只读缓存；`store.list()` 也是异步的，同样只能读缓存。

### 3.3 事件钩子

```js
ctx.on('agent/pre-step', (payload) => { payload.messages; payload.agent.session.id; });
ctx.on('session/event', (session, event) => { if (event.type === 'turn/end') {...} });
ctx.effect(() => () => { /* 释放 disposer */ }, 'label');
```

| 事实 | 说明 |
|---|---|
| `ctx.effect(fn)` 在**注册时**调用 `fn()` 拿 disposer，释放时调那个 disposer | 照 dsh-memory 的写法：`ctx.effect(() => dispose, 'label')` |
| ⚠️ **`session` 上没有 `events` 属性** | 事件在私有字段 `log` 里；公开访问器只有 `ownEvents()` / `snapshotEvents()` / `eventAt()`。实测 `('events' in session) === false`（spec §3.12 缺陷 12）|
| `session/event` 的 `turn/end` **确实会触发** | 扫描本机 71 份会话日志：58 份含 `turn/end`（最多 62 次/会话）|
| 真实 `user/message` 是**大杂烩** | `source.kind` 有 15 种：`user`=341 但 `runtime-context`=196 / `skill-catalog`=75 / `agent-instructions`=49 / `plugin`=7 …。**只有 `kind === 'user'` 是真人输入** |
| `session.events` 里消息形状有两种 | 用户事件 content 在 `data`，assistant 事件包在 `data.message` —— 两种都要兼容 |
| **插件自己注入的消息带 `source.kind === 'plugin'`** | 捕获时必须跳过，否则注入的记忆块会被当用户输入再存一遍 |

### 3.4 调模型

```js
ctx.llm.stream({ provider, model, system, messages, maxTokens, temperature })
// → AsyncIterable<StreamChunk>，只取 { type: 'text-delta', text }
```

| 事实 | 证据 |
|---|---|
| `provider` 与 `model` **都是必填** | `api-catalog.js:3146` 的 `GenerateOptions` 声明 |
| chunk 有多种类型；**`reasoning-delta` 是思考过程，不该进记忆** | `api-catalog.js:4170` 的 `StreamChunk` 声明 |

### 3.5 怎么自己再查一遍

**权威来源是本机宿主包，不是文档、不是参照插件的推测**：

```
C:\Users\<你的用户名>\.dsh\profiles\node_modules\@deepseek-ai\
├── dsh-tools/lib/types/index.js     工具契约
├── dsh-system-prompt/lib/index.js   注入求值时机
├── dsh-tool-cordis/lib/types/api-catalog.js   全量 API 目录（带签名与契约）
└── dsh-llm/lib/types/index.d.ts     模型调用
```

`api-catalog.js` 是**生成的**全量事件目录，每个服务都带精确签名、派发模式和文字契约。
**改宿主相关代码前先查它。**

---

## 4. 六条设计纪律（违反会出事）

1. **零运行时依赖** —— 只用 `node:` 内置。理由：不因缺依赖整块失效（Codex 的教训）。
2. **真源永远是纯文本 Markdown** —— `index.md` / `status.md` / `usage.jsonl` /
   任何索引**都是派生视图**，删掉系统必须仍能工作（只是慢）。
3. **关键路径零 LLM** —— 读 / 写 / 注入 / 检索都不需要模型。只有抽取与技能提炼需要，
   且**关掉后其余功能照常**（有测试断言这一点）。
4. **不许静默失败** —— 包括两类：
   - 真失败要可见（Block D 注入告警 + `status.md`）
   - **"功能存在但从不生效"也是失败**（见 §5 的坑 1/7/8）—— 这种最难发现
5. **破坏性操作只标记不删除** —— `stale` 是标记、`supersede` 转休眠可 `revive`、
   合并**不做正文合并**（会丢信息）。`P0` / `source:user` 是学习的锚，不被自动改动。
6. **一个 store 只能有一个 owner** —— 见 §1 末尾。
7. **`agent/pre-step` 必须调 `next()`** —— 它是 **waterfall** 模式，监听器
   `return next()` 才能把决定权交还下游。不调会**在此截断瀑布链**：宿主 `dsh-agent-loop`
   拿到 `undefined` 后读 `decision.kind` → **直接抛 TypeError，整轮对话崩**。
   宿主里 14 处官方监听器**全部**带 `next`（真机实证见 spec §3.12 缺陷 5）。
   ⚠️ 这条对**任何**监听器成立，包括你在 debug 时临时挂的探针 —— 踩过两次。

---

## 5. 已踩过的坑（按"最容易被重复踩"排序）

### ⚠️ 坑 1：`handler` vs `execute` + 缺 `output` → **静默零工具**

最恶心的一个：`registerTool()` 把注册异常吞成 `warn`，然后去试根本不存在的
`add`/`define`/`provide`/`create`，最后返回一句误导性的 `no known registration method`。
结果：**插件"加载成功"、一个工具都没注册、`status.md` 里看不出真相**。

**对策**：直接用 `ctx.tools.register`，不吞异常。装配测试用假 ctx **模拟宿主契约**（缺 output 就抛）。

### ⚠️ 坑 2：注入 provider 必须同步

`text()` 返回 Promise 会被拼成 `[object Promise]`。而 `buildInjection` 虽然本身是同步的，
但它需要 `await store.list()` 取数据 —— **真正的堵点在这**（不是"函数是 async"）。
对策：pre-step 缓存 + provider 只读缓存。

### ⚠️ 坑 3：frontmatter 往返必须严格对称

四个实测出来的不对称：引号值不 unescape（反斜杠每轮翻倍）、标题含换行被静默截断、
tag 含逗号裂成两个、内部字段 `_bucket` 落盘。
**对策**：`emitScalar` / `parseScalar` 严格对称 + `write()` 剥掉所有 `_` 前缀字段。
**顺序很重要**：先修往返对称，**再**接 drift guard —— 反了会把合法写入判成脏写而硬拒。

### ⚠️ 坑 4：dormant 是单向棘轮（**会丢数据**）

`recall` 只取 active → 条目休眠后永远不再被召回 → 反馈与续期都挂在"被召回"上 →
信号恒为零 → `planPurge` 的"零反馈"判据对休眠条目**必然成立** → 30 天后无条件删除。

**对策**：① purge 判据补上「**从未被召回**」② 提供 `revive` 动作。

### ⚠️ 坑 5：`isProtected` 不能拿来做升级闸

`memfuse_write` 创建的条目一律 `source:'user'`，所以用 `isProtected` 当闸会让
**升级路径永不触发**（等于死代码）。**测试直接把它顶出来了**：
`sessionCount` 到了 3 却不升级。
对策：只挡 P0 + 已升级过的。`isProtected` 保护的是**破坏性**操作，升级是非破坏性可逆的。

### ⚠️ 坑 6："只在某个时机算一次"的东西要检查会不会永远算不到

技能候选最初只在**启动时**算一次 → 会话中新建的记忆永远进不了候选
（"我刚把经验写进去，为什么没候选？"）。对策：`list` / `distill` 时**现算**（零 LLM，代价可忽略）。

> **这条是元规律**：本项目三次"功能存在但不生效"（坑 1 / 5 / 6）都是这个形状。
> 写新功能时自问：**这个值在什么时机算？那个时机一定会到吗？**

### ⚠️ 坑 7：CRLF 让技能被静默跳过

`name: foo\r` 整行匹配失败 → frontmatter 缺 name → 技能被跳过，**不报错**。
另外还有：裸值含 `: ` / ` #` 被严格 YAML 拒、目录名 ≠ frontmatter name 被跳过。
**对策**：解析前剥行尾 `\r`、写入统一 LF、`description` 强制引号、两处用同一变量、
**写完回读自校验**。再加一层：`listSkills()` 如实标 `loadable: false` + `problem`。

### ⚠️ 坑 8：`conflict` 的 −0.35 惩罚不该由启发式来设

会把正常条目压到阈值以下、**等于静默屏蔽**。语义矛盾该由模型判。
对策：只报告，不自动设。同理 `stale` 的 −0.20 只对**完全重复**（无歧义）自动设。

### 坑 9：串行 `readFile` 是 `list()` 的唯一瓶颈

600 条实测：串行 97.6ms → 并行 21.4ms（**4.5×**，3 行代码）。
**这也是 A7（SQLite 派生索引）被否掉的依据** —— 并行拿到 96% 收益只付 1% 复杂度。
**先量再决定，别先建机制。**

### 坑 10：测试断言硬编码工具名 → 改名时漏改

改工具名时 `smoke.mjs` 里一条 `includes('memory_write')` 的断言挂了。
**这是好事** —— 测试抓出了改名影响面。**但反过来也提醒**：
注入进提示词的文本里教模型调用的工具名，必须跟着改（那次差点漏掉）。

### ⚠️ 坑 11（新，代价最大）：照"感觉"写的宿主属性名 —— `session.events` 不存在

**症状**：`sessions/` 永远是空的。不是报错，是什么都不发生。

真机上 `dsh-session` 的 `Session` 类把事件放在**私有字段** `log` 里，
公开访问器是 `ownEvents()` / `snapshotEvents()` / `eventAt()`。
插件里那句 `if (!Array.isArray(session.events)) return;` 于是**每一轮都静默 return**，
捕获一次都没跑过。同一个字段还被 `hasShownSkill()`（技能 patch 的闸门）用着，
所以 `memfuse_skill action=patch` 也变成了**永远拒绝**。

**为什么三方全都没发现**：

| 谁 | 为什么没发现 |
|---|---|
| 代码 | `Array.isArray(undefined)` 永远 false，分支永远不进 —— 不抛错 |
| 测试 | 假 session 写的是 `{ id, events: [...] }`，**宿主里压根没有那种对象** —— 假 ctx 太"好客" |
| status.md | 捕获失败原本只 `console.warn`，没有 `noteFault` —— 看不见 |

**对策（三条，缺一不可）**：

1. **属性名要对着宿主实现查**，不要对着类型声明猜（`api-catalog` 里 `Session` 从来没出现过
   `events`）。查实现：`<DSH_APP>\resources\app\dsh\node_modules\@deepseek-ai\dsh-session\lib\index.js`
2. **假 ctx 必须模拟真机形状**：这次把测试改成 `{ id, ownEvents: () => events }`（真机就只有这个）。
   形状来源写进注释，标上是哪次探针实测的。
3. **"读不到输入"必须留痕**：`sessionEvents()` 返回 `via: null` → `noteFault('captureFail')` +
   status.md 里一行「已捕获轮次: 0」。**"0"才是一眼可见的信号**，空白不是。

> **这条是元规律的第 4 次现身**（前面是坑 1 / 5 / 6）：功能存在但不生效。
> 自问：**这个条件在真机上会成立吗？我怎么知道的？** —— 答"应该会"就是没查。

### ⚠️ 坑 12（跟着坑 11 一起来的）：修活死功能前先审计它的输入

`session.events` 修好之后立刻暴露第二个问题：真机上 `user/message` 是个**大杂烩**，
`source.kind` 有 15 种（`runtime-context` 196 条 / `skill-catalog` 75 / `agent-instructions` 49 …），
"从后往前扫到的第一条用户消息"**大概率是系统注入的模板**（本机实测：真人在 seq=12，
注入在 seq=13/14/37）。旧代码只挡 `plugin` 一种 → 会把 2935 字的指令模板当"用户说的话"落盘。

**教训**：一个静默死掉的功能，修活之后可能立刻变成**制造噪声的机器**。
修法是对**输入**用白名单（只认 `kind === 'user'`），不是对已知噪声用黑名单。

---

## 6. 测试与验证方法

```powershell
npm test              # 两套都跑：49 + 23 = 72 项
npm run test:plugin   # 装配级（node:test + 假 ctx）
npm run test:smoke    # 纯函数层（自写 runner，逐条 ✅ 打印）
npm run demo          # 看产出物长什么样
```

### 两套的分工

| 套件 | 覆盖 | 特点 |
|---|---|---|
| `test/plugin.test.mjs` | **装配层**：注册契约 / 注入路径 / 工具行为 / 队列 / 技能 / 反腐烂 / 捕获 | 用 `fakeCtx()` **模拟宿主真实契约**；假 `llm.stream` 让抽取不需要真模型。⚠️ 假 session 必须给**真机形状**（`ownEvents()`，没有 `events`）—— 见 §5 坑 11 |
| `test/smoke.mjs` | **纯函数层**：分词 / BM25 / 打分 / 生命周期 / 注入装配 | 逐条 `✅` 打印，人读友好 |

### 关键方法论

1. **测试是规格**：每条 `✅` 断言对应一个行为承诺。改行为要同时改断言 —— 别只改代码。
2. **假 ctx 必须模拟真实契约**（缺 `output` 就抛、`execute` 才算数）—— 否则测试全绿而真机全废。
3. **假模型**：`fakeLlm(text, { fail })` 产出 `text-delta` 块或抛错，
   让抽取/提炼路径**不需要真 LLM 就能测**。
4. **测试要能抓出"功能不生效"**：坑 5 / 6 都是测试抓的，不是读代码发现的。
5. **性能问题先写基准脚本再优化**（`$env:TEMP\memfuse-perf.mjs` 那种做法），别凭感觉。

### 加一条新测试的模板

```js
test('功能：一句话说明它承诺什么', async (t) => {
  const root = path.join(os.tmpdir(), `memfuse-xxx-${Date.now()}`);
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const h = fakeCtx({ llm: fakeLlm(...) });        // 需要模型时才传
  const api = mod.apply(h.ctx, { root, git: false, verbose: false, ... });
  await api.ready;
  // ... 断言 ...
  console.log('  ✅ 一行说明');
});
```

---

## 7. 当前状态与下一步

### 已完成（阶段 0–3）

| 阶段 | 内容 |
|---|---|
| **0 让它真的能跑** | `execute` + `output` + 删掉五形状探测 + 注入挂 `systemPrompt.context` + 改名 + 修 `_bucket` |
| **1 记忆卫生** | drift guard + 锁 + 反馈生产端 + `weakRenew` + entries 归因 + BM25 + excerpt + `list()` 并行化 |
| **2 学习闭环** | `memfuse_feedback` + 跨会话去重计数 + 模式识别自动升级 + 零 LLM 兜底捕获 + 凭据过滤 |
| **3 抽取与进化** | F2 抽取（水位线 + 偏好加成）+ E6 待确认队列 + H 技能提炼 + G 反腐烂（保守子集） |

**四条差异化全部落地且有测试**。全程零网络、零向量、零运行时依赖。

### 真机冒烟结论（2026-10-15，web profile）

四条全部有结论，**详细证据见 [`spec.md`](spec.md) §3.12**：

| # | 问题 | 结论 |
|---|---|---|
| 1 | 能否被宿主加载、6 个工具在不在工具清单里 | ✅ **6/6 注册成功且可执行** |
| 2 | Block A–D 是否真的进 systemPrompt | ✅ **`dsh-memfuse:memory` 挂在 order 118，写 P0 后 text len=154** |
| 3 | `agent/pre-step` / `session/event` payload 形状 | ⚠️ 插件侧消费正确；**宿主真实形状仍未观测**（需一次真实会话） |
| 4 | `ctx.llm.stream` 真实调用 | ⚠️ 可调通；但 `inject` 缺 `llm` → **抽取路径必炸**（缺陷 1） |

**四个真机缺陷（已全部修复，见 spec §3.12 修复记录）**：

1. **`inject` 缺 `llm`**（阻断抽取）—— 原代码直接访问 `ctx.llm`，而 cordis 对未声明服务
   **属性访问就抛错**。修：`ctx.inject(['llm'], cb)` 运行时可选注入 + `WeakMap(ctx → llm)`
   （**不要**改成硬 `inject`，那是硬依赖，缺 llm 的宿主整个插件都起不来）
2. **首次启动不落盘 `state.json`**（轻微）—— `ready` 里只有 `writeStatus`，补 `writeState`
3. **虚词 bigram 造成假命中**（检索噪声）—— `recall.js` 加 `CJK_STOP_BIGRAM` 双字虚词黑名单
4. **模型返回 `[]` 被判成解析失败**（假故障）—— 新增 `isExplicitEmptyArray()`，
   空数组是"本轮没有可记的"，不该写 `lastExtractError`（否则会攒成 Block D 假告警）

### ⚠️ 冒烟的环境前提（会重复踩）

本机（开发机）**两套 DSH 运行时**：桌面版 `<DSH_APP>`（**0.2.0-rc.2**）与源码版
`<HARNESS_SRC>`（**0.1.0-rc.8**）。两者的 `~/.dsh/.credentials.yaml`
布局**不兼容**（桌面版是 version 1 结构化 `version`/`refs`/`records`，源码版只认扁平），
用源码版 CLI 起 web profile 会在 credentials 阶段直接崩。

⇒ **启动 web profile 必须用桌面版宿主**：

```powershell
$dnode = '<DSH_APP>\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
$dbin  = '<DSH_APP>\resources\app\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js'
& $dnode --expose-internals $dbin --profile web --port 19388 --no-open
```

装插件本身用哪版 CLI 都行（它只转发 pnpm）。

### 真机补测（2026-10-15，**29 / 29**）

把「只有单测、真机没跑过」的路径补了一遍（`probe-v5.mjs` + `overlay-v5-{setup,verify}.yml`）：
队列 approve/reject、**跨会话自动升级**、弱续期、捕获路径的凭据替换、**Block C**、
**drift guard**、**自动遗忘链**（过期→dormant、完全重复→stale）、**Block D**。
明细见 spec §3.12。

**两条实测出来的设计行为（写测试前先读，补测时踩过）**：

- **`runMaintenance` 是幂等的** —— 过期→dormant 只处理 `lifecycle=active` 的，
  `planStale` 只处理尚未标记的簇。所以第二次启动必然 `expired=0 / staled=0`。
  断言要写「**已达稳定态**」，不是「每次都得做」。
- **`isProtected()` = `P0 || source:user || managedBy:user`** —— `memfuse_write` 创建的条目
  **三条全中**，**永远不会**被自动转休眠/淘汰（设计如此）。要测遗忘链，
  埋的数据必须先把这三个条件清掉（真实抽取产物是 `source:auto` + `managedBy:auto`）。

### 下一步

**只剩验证，没有已知缺陷**：

1. **重启后确认三处**（host half 改了代码，不重启不生效 —— 见上面那条 ESM 缓存警告）：
   - `~/.dsh/memory/.memory/status.md` 的 `代码版本:` 是不是 `2026-10-17-capture-multisession`
     （2026-10-15 那版写的是 `2026-10-15-session-events-fix`；这一行由代码写死，
     是判断"宿主到底加载了哪个模块"的**唯一可靠信号**）
   - 新增的「## 零 LLM 捕获」节：**已捕获轮次 > 0**、`sessions/2026-10-15.md` 有内容
     （且落盘的 `[User]:` 是真人那句，不是 `<system-reminder>` 模板）
   - 「设置 → 内置插件」里 dsh-memfuse 配置页仍在（`status: schema`）
2. **真实模型往返**：捕获有素材之后，`memfuse_extract` 的输入才第一次非空 ——
   跑一次看候选进待确认队列（真机只被假模型测过的那条路径，现在有原料了）。

其余（预算淘汰 / 物理删除 / 锁文件并发）单测已覆盖，真机没造（需要 30 天跨度或并发进程，
收益低于成本）。

收尾项：`stripThink` 死代码**已删**；`mergeAllowed` 有意保留（将来真做正文合并时的保险丝）。

**装之前先确认**：目标 profile 现在是干净的（本机 `profiles/web/package.json` 的
`dependencies` 是空的）；`cordis.patch.yml` 已砍到只剩 `id`/`name`，
**不要再往 profile patch 里手工 insert 同 id**（会撞 duplicate loader entry id）。

### 之后可选的方向

- 相似度聚类（做重复检测的加强版）—— 但要先量"用什么做簇发现最划算"
- 用户画像聚合层（`profile.md`，从已有记忆归纳，派生视图）
- 真机跑一段时间后，用 `usage.jsonl` 的实际数据决定要不要上权重自适应

---

## 8. 开发工作流

1. **改代码 → 跑测试 → 更新 spec 对应节**。spec.md 是唯一权威清单，别让它漂。
2. **不要自动 commit / push**，除非用户明确要求。
3. **新功能先问三件事**：
   - 它在关键路径上吗？（是的话，能不能挪到侧路）
   - 它失败时用户看得见吗？（看不见就加可见性）
   - 它是真源还是派生视图？（派生视图必须可删可重建）
4. **记忆系统**：本机接了 Markdown 知识库（`<VAULT>`），
   项目记忆在 `10-记忆/项目/dsh-memfuse 插件：仓库位置、结构与当前进度-2.md`。
   干完活要写记忆并重建索引：`node <VAULT>\.memory\kb.js index`。

---

## 9. 文件清单

```
dsh-plugin-memfuse/
├── AGENTS.md              给新会话的入口（指向本文件与 spec）
├── package.json           npm 包元信息 + 测试脚本 + dsh.bundle.patch
├── cordis.patch.yml       只注册不配置（默认值只留代码一处）
├── README.md              对外说明（部分已过时，以 spec.md 为准）
├── docs/
│   ├── HANDOFF.md         ← 本文件
│   ├── spec.md            ← 唯一权威的功能清单 + 技术线 + 实施记录
│   ├── design.md          原始设计动机（三家产品剖析的产物）
│   └── analysis/          三家产品记忆系统剖析（00–05）
├── lib/                   12 个模块，见 §2
└── test/
    ├── plugin.test.mjs    49 项装配级（node:test）
    ├── smoke.mjs          23 项纯函数层
    └── demo.mjs           产出物演示
```

---

## 附：一句话总结这个项目的成败判据

> **它不许静默失败。**
>
> 记忆读不出来 → 注入一条告警；抽取管线挂了 → 注入一条告警；
> 技能格式不对会被 DSH 跳过 → `status.md` 里标出来；
> 写了个功能但从不生效 → 测试要能抓到。
>
> 这条贯穿了每一个设计决策。改代码时如果必须在"方便"和"可见"之间选，**选可见**。
