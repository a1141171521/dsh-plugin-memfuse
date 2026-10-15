<!-- dsh-memfuse 项目约定：本文件每轮自动注入，保持精简。 -->

# dsh-memfuse 项目约定

## 接手前先读

| 顺序 | 文件 | 内容 |
|---|---|---|
| 1 | `docs/HANDOFF.md` | 交接文档：定位、代码地图、**宿主 API 契约（已核实）**、已踩的坑、测试方法 |
| 2 | `docs/spec.md` | **唯一权威**的功能清单 + 技术线 + 各阶段实施记录（含真机发现的缺陷） |
| 3 | `README.md` | 对外说明（**部分已过时**，以 spec.md 为准） |

**先跑 `npm test`**（应看到 **51 + 9 + 23 = 83 项全绿**）确认环境正常，再动手。

## 这是什么

DSH 的长期记忆插件。纯文本 Markdown 存储、本地检索。
四条差异化：**纯文本下的完整遗忘链** · **打分与优先级** · **失败可见** · **可审计的学习闭环**。

## 当前状态（2026-10-15 收尾）

- **已装进 desktop + web 两个 profile**，真机跑通。
- 测试 **83 项全绿**（plugin 51 + client 9 + smoke 23）；真机功能 40/40、补测 29/29、真实会话闭环、真实模型往返全通。
- **真机累计发现 14 个缺陷，全部修复**。最隐蔽的五个：
  - 缺陷 5：`agent/pre-step` 是 waterfall，不调 `next()` → **每轮对话崩**
  - 缺陷 11：`Config` 没放进 `export default` → **设置页静默消失、零报错**
  - 缺陷 12：**`session.events` 在宿主上不存在**（真名 `ownEvents()`）→ 兜底捕获整条路径
    **静默死掉**（`sessions/` 一直空着）；修活后立刻暴露 12b：`user/message` 里只有
    `source.kind === 'user'` 是真人输入，否则会把系统注入模板当用户输入落盘
  - 缺陷 13：**只有宿主半边 `Config` 时，UI 上什么都不显示** —— 配置页在「插件」页，
    靠 `plugins.row.config` 这个 keyed slot 渲染，而它的 occupants 是**空的**；
    必须再给一个 **client half**（`lib/client.js`）
  - 缺陷 14：**模型列表永远读不出来** —— 远程调用借了 `scope.ctx`（那是**提供方
    ui-settings 的 fiber**，inject 只有 `["remote","remote.settings"]`，**没有** `remote.session`），
    报错又被自己的 try/catch 吞成一句含糊的「读不到模型列表」。
    **远程调用一律用插件自己的 ctx**，并且把原始报错显示在界面上
- **设置页**：✅ 两个半边都齐了。宿主半边 `lib/config.js`（`Config status: schema`）+
  浏览器半边 `lib/client.js`（注册**两处**：`plugins.bundle.config` key = 包名、
  `plugins.row.config` key = `dsh-memfuse#dsh-memfuse`）。
  ⚠️ 「设置 → 内置插件」只是**只读清单**，那个页面**不渲染任何表单**；
- **抽取的四种状态**（按用户要求重做）：**总开关 `extract.enabled` 默认关**
  （关着 = 不使用 LLM，且**不算故障**；关着的时候配了模型也不跑）／开了但没选模型
  = **可见故障**／**跟随对话模型**（勾选项）／**显式挑选**（配置页下拉，数据源
  `remote.session.modelCatalog()`，与对话框同源）。后两者互为降级目标。
- **抽取降级**：`extract.onUnavailable = 'stop' | 'fallback'`。
- **空正文会自证**：推理型模型常把 `maxTokens` 花在思考上（正文零个 `text-delta`、
  `finish=max-tokens`）。现在 `maxTokens=4000`，被截断**加倍重试一次**（8000），
  仍空则报**完整现场**（finish 类型 / 文本与推理增量字数 / 用量含 reasoningTokens /
  **chunk 类型直方图**）—— 原来只有一句「模型输出无法解析为候选数组（前 200 字：）」，
  括号里还是空的，等于没线索。

**已验证（2026-10-15 收尾，用 headless 冒烟 profile 跑的真实结果）**：
1. ✅ 兜底捕获真的落盘了（`~/.dsh/memory/sessions/2026-10-15.md`，落的是真人那句话）
2. ✅ `status.md` 里 `代码版本: 2026-10-15-session-events-fix` + 「零 LLM 捕获」节计数正确
3. ✅ 抽取管线**第一次真跑通**（真 provider + 真输入，`最近成功` 有值、`健康: ✅`）
4. ✅ 宿主半边配置存在（`cordis_inspect_query` → Config `status: schema`）；
   浏览器半边见 `lib/client.js` + `test/client.test.mjs`（离线断言注册/写回契约）

**配置页怎么用**（客户端半边加完之后）：
「**插件**」页 → 找到 `dsh-memfuse` 这张卡 → **点开它的包页，描述下方就直接是配置表单**
（新加的 `plugins.bundle.config` 入口，不用点任何东西）。也可以点那一行的**标题** ——
注册上了它会变成可点按钮（带 `›`，无障碍名「配置 dsh-memfuse」）→ 进详情页再看一遍。
⚠️ 这一版**没有**单独写「配置」的按钮，**可点的标题就是入口**。
里面有：
1. ☐ **开启自动抽取（用 LLM）** —— 总开关，**默认关**。关着 = 不使用 LLM，配了模型也不跑
2. ☐ **跟随对话模型**（勾上就用对话框里选的那个，主模型换了它跟着换）
3. **抽取用的模型**（下拉挑选，与对话框里的选择器同一个数据源）
4. 模型不可用时（stop / fallback）、**降级模型**（可清除）、候选落盘方式（suggest / auto）

**模型下拉现在是空的？** 它读宿主目录（`remote.session.modelCatalog()`），失败会把**原始报错**
显示在提示里。历史坑见缺陷 14：远程调用借了提供方（ui-settings）的 ctx，而它的 inject 里
**没有** `remote.session` —— 必须用插件自己的 ctx。

（「设置 → 内置插件」只有只读清单，**没有表单**。）

**怎么自己再验一遍**（不用重启 desktop，换个进程就行）：

```powershell
$dnode = 'E:\DSH Desktop\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
$dbin  = 'E:\DSH Desktop\resources\app\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js'
& $dnode $dbin memfuse-smoke "用一句话说明 DSH 是什么。不要用任何工具。"
# 夹具 profile：~/.dsh/profiles/memfuse-smoke（从 headless 模板建，junction 到本仓库）
# 用完删目录即净。加新条目记得用 `- insert:`，直接写 `- id:` 会静默不加载。
```

⚠️ **新增/修改了 client half（`lib/client.js` + `package.json` 的 `dsh.client`）之后必须再重启一次 desktop**：
宿主在启动时扫描 `dsh.client` 声明并把它接进客户端模块表（增量扫描按**已知包**做，
新声明要新一轮激活扫描），浏览器侧也要重新拉那份 bundle。判据：重启后
`cordis_inspect_query(platform=client, provider=Slots, listSubTree, {root:'plugins.bundle.config'})`
的 `occupants` 里应出现 `key: "dsh-memfuse"`，且
`{root:'plugins.row.config'}` 里应出现 `key: "dsh-memfuse#dsh-memfuse"`。

## 硬规则（违反会出事，详见 HANDOFF §4）

1. **零第三方运行时依赖** —— 只用 `node:` 内置 + **宿主自带的框架包**
   （`@deepseek-ai/cordis`、`@deepseek-ai/schemastery`，official 插件同样依赖它们）。
2. **真源永远是纯文本 Markdown** —— `index.md` / `status.md` / `usage.jsonl` 都是派生视图，删掉必须仍能工作。
3. **关键路径零 LLM** —— 读/写/注入/检索不需要模型。
   **「不使用 LLM」是一等公民**：总开关 `extract.enabled` **默认关**，关着就不跑抽取
   （其余照常），而且**关闭不算故障**（不写 `lastExtractError`，健康度报"总开关没开"）。
   开关开着却没选到模型 = **故障**（必须报出来，不能写「✅ 正常」）。
4. **不许静默失败** —— 包括"**功能存在但从不生效**"（本项目已踩到 5 次，全是真机抓的）。
   运行期故障统一记进 `state.runtimeFaults` → Block D + status.md。
   **顺手记一条推论**：读不到输入（`via: null` / 空数组 / 属性不存在）也要留痕，否则你只会看到"空"。
5. **破坏性操作只标记不删除** —— `P0` / `source:user` 不被自动改动。
6. **一个 store 只能有一个 owner** —— 不能与 `dsh-memory` 同时启用（会双份注入）。

## 改代码的纪律

- **改代码 → 跑测试 → 同步更新 `docs/spec.md`**。spec 是唯一权威清单，别让它漂。
- **新功能先问三件事**：它在关键路径上吗？失败时用户看得见吗？它是真源还是派生视图？
- **不要自动 git commit / push**，除非用户明确要求。
- **改宿主相关代码前，先查本机宿主包**（不是文档、不是猜）：
  - 源码：`E:\DSH Desktop\resources\app\dsh\node_modules\@deepseek-ai\`
  - 实时契约：`cordis_inspect_query`（Service / Event / Config / Tool / Slot）

## ⚠️ 改 Host half：ESM 缓存与三条免重启的路（2026-10-15 实测更正）

**Node 的 ESM 模块缓存**：同进程内 `import()` 不重读文件。
实测（2026-10-15）：改文件等 HMR ❌；`plugin_manager` 禁用再启用 ❌
（fiber 重建了、`apply()` 重跑了，但模块仍是缓存的旧版）。
**改配置 ≠ 改代码**：`cordis.patch.yml` 的改动**会热生效**（fiber 重建、`apply()` 重跑、
status.md 被重写），但那只换配置、不换模块。判据只有一个：status.md 里由**代码**写死的 `代码版本:` 那一行。

**❌ 更正一条旧说法**：「Cordis 预设里有 `cordis_define` / `cordis_run`，可以热加载新代码」——
**本机桌面版没有这两个工具**。三处实测证据：

| 事实 | 证据 |
|---|---|
| 本会话可调用工具里只有两个**只读**的 | `cordis_inspect_query(host, Tool, listTools)`；且 `dsh-tool-cordis/lib/index.js` 全文 100 行、只 register 那 2 个 |
| `cordis` 预设挂的就是这个包 | `dsh-web-app/presets/cordis.patch.yml:140` → `- id: tool-cordis / name: '@deepseek-ai/dsh-tool-cordis'` |
| 动态那一套只在**源码版**仓库里 | `E:\DeepSeekHarness\deepseek-harness\packages\extensions\tool-cordis\src\index.ts` → L149 `cordis_define`、L241 `cordis_run`、L330 `cordis_stop`、L352 `cordis_undefine`、L97 `cordis_inspect_self` |

**✅ 真正可用的三条路**（按推荐度）：

1. **换进程跑冒烟**（本项目标准做法，命令见上面「已验证」一节）——
   新进程 = 新模块，零重启代价，而且能跑真实对话。**代码改动就用它验。**
2. **`dsh <新名字> --from-default-profile <acp|headless|sdk|sdk-minimal|web>`**：
   从模板建一次性 profile 当夹具，删目录即净。往里面加新条目记得用 `- insert:`（见 spec §3.12 坑 A）。
3. **动态插件**：等同时具备「源码版 runtime + 带 `cordis_define` 的 tool-cordis」再用；本机桌面版做不到。

## 记忆系统（两条链路都在用）

- **memfuse 自己的库**：`~/.dsh/memory`，工具 `memfuse_*`（desktop + web 都指向它）
- **Obsidian vault**：`E:\KnowledgeBase`，工具 `memory_*`（**desktop 已改用 memfuse，故这边只剩 web / 手动**）

```powershell
node E:\KnowledgeBase\.memory\kb.js recall "dsh-memfuse"
node E:\KnowledgeBase\.memory\kb.js index    # 写完后重建索引
```
