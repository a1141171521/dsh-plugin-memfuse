<!-- dsh-memfuse 项目约定：本文件每轮自动注入，保持精简。 -->

# dsh-memfuse 项目约定

## 接手前先读

| 顺序 | 文件 | 内容 |
|---|---|---|
| 1 | **`docs/NEXT.md`** | **本轮做到哪、停在哪、下一步先查什么**（跨机器接手看这个） |
| 2 | `docs/HANDOFF.md` | 交接文档：定位、代码地图、**宿主 API 契约（已核实）**、已踩的坑、测试方法 |
| 3 | `docs/spec.md` | **唯一权威**的功能清单 + 技术线 + 各阶段实施记录（含真机发现的缺陷） |
| 4 | `README.md` | 对外说明（**部分已过时**，以 spec.md 为准） |

**先跑 `npm test`**（应看到 **59 + 26 + 5 + 23 = 113 项全绿**）确认环境正常，再动手。
想直接看候选卡片长什么样：`npm run preview`（离线预览页，不用重启、不用先有候选）。

## 这是什么

DSH 的长期记忆插件。纯文本 Markdown 存储、本地检索。
四条差异化：**纯文本下的完整遗忘链** · **打分与优先级** · **失败可见** · **可审计的学习闭环**。

## 当前状态（2026-10-16 收尾）

- **代码托管**：`https://github.com/a1141171521/dsh-plugin-memfuse`（`main` 分支，HTTPS 推送已配好凭据）。
  推送前扫一遍：**不带凭据**；本机用户名 / 绝对路径改占位符（仓库是 public）。
- **已装进 desktop + web 两个 profile**（都是**符号链接/junction 指向本仓库**，改文件即生效，
  只差重启让客户端重新加载 bundle），真机跑通。
- 测试 **113 项全绿**（plugin 59 + client 26 + 预览 5 + smoke 23）；真机功能 40/40、补测 29/29、真实会话闭环、真实模型往返全通。
- **候选卡片的离线预览页**：`npm run preview`（起本地静态服务再打开
  `docs/preview/turn-tail-card.html` —— **别直接双击**：模块脚本在 `file://` 下会被 CORS 拒）。
  它加载**真实的 `lib/client.js`**（同 bundle / 同 CSS / 同字典），宿主那侧是假数据；
  侧栏有宿主状态、远程调用日志、下一轮 Block E 示意 + 四个场景按钮。
  `test/preview.test.mjs` 用迷你 DOM 兜底。**想知道卡片长什么样，先看这个，别先重启。**
- **H8 界面数据通道**（2026-10-15/16）：`lib/remote.js` 手写 Typert 贡献
  （**不需要代码生成器、不需要 zod**），**七个端点**
  `memfuse/list|dismiss|markSeen|requestDistill|distill|approve|reject`
  （后三个是缺陷 25 补的：界面点「提炼成技能」当场写 SKILL.md → 草稿预览 → 装/丢）；
  候选在**回合尾部**出卡片（`conversation.chat.turnTail`，id `dsh-memfuse#suggestions`）。
  「渲染即记 seen」= 不一直提示；「不用」= 永不提；簇长大 → key 变 → 再提一次。
  ⚠️ **四个坑**：① 宿主贡献读 **`invocations`**、客户端读 **`descriptors`**（写错宿主**静默收下**，
  所以装完必须回读 `typert.local.get()` 自校验）；② codec 只要 `{mode:'strict',typeSymbol,create}`，
  而**带参数的端点每个参数都要 `source: 'json'`**（漏了会被当 lookup 参数 →
  `lookup parameter "keys" has no provider key`：**没参数的 list 正常、一按按钮就报错**，缺陷 19）；
  ③ **客户端装配顺序**（真机踩了三次，全是"卡片永不出现"）：
  `ctx.inject(['typert','remote'], mounter => mounter.remote.$mount(贡献))` ——
  `$mount` 内部要 `callerCtx.typert.remotes.register()`，**第三方插件必须自己声明 typert**；
  完事再 `mounter.inject(['remote.memfuse','slots','locale'], child => …)`，**数据源用子 ctx**；
  ④ 卡片**只长在最后一个回合**尾部（`turnTail` 是按回合渲染的，不加门就一席对话几十张，
  见缺陷 20）——判据是**比回合 id**：`props.turn` 在真机上是**对象**
  （`node.location.turn` = `{turn: <id>, status}`，`TurnTailNodeView` L6577），
  而 `turnOrder` 里放的是 **id** → 必须用 `turnIdOf()` 取 id 再比，
  **别直接 `String(props.turn)`**（缺陷 24：那样恒不相等，卡片永远不出现）；
  ⚠️ hooks 不能有条件调用，早退要放在所有 hook 之后；
  ⑤ 卡片**行数 = `skill.suggestMax`（默认 1）**：宿主只给前几组，其余组的 key 用
  `restKeys` 交回、卡片一并记 seen（**别改成排队刷屏**），并写一行「另有 N 组」（缺陷 22）；
  ⑥ 卡片是**两段式**（缺陷 25）：点「提炼成技能」→ 宿主 `memfuse/distill` **当场调模型**
  写 SKILL.md → 卡片出现草稿面板（技能名 + 作用 + **SKILL.md 全文** + `[装进技能库] [丢掉]`）。
  提炼/安装的实现与 `memfuse_skill` 工具**共用同一份函数**（`distillCluster` / `approveSkill` /
  `rejectSkill` / `pendingSkillDrafts`）—— 别在界面那条路再写一遍；
  草稿的**真源是磁盘**（`pending-skills/`，`list` 每次都带回来），所以它**不**需要"钉住"；
  提炼失败要**如实显示 + 退化成 `requestDistill` 待办**（下一轮 Block E 让对话模型去补）。
  真机探针：**7 个端点可路由**（缺陷 25 之后从 4 个涨到 7 个）、服务 `memfuseRemote` 已 provide。
- **H7 技能建议**（2026-10-15 追加）：够格时在注入里出 **Block E**（**零 LLM**，只给簇语义不给技能正文），
  用户点头才 `distill`。`dismiss` 后该组不再出现；**簇长大 → key 变 → 重新提一次**。
  真机已用探针（宿主自己的 `systemPrompt.assemble()`）抓到真实组装块验证。
- **真机累计发现 26 个缺陷，全部修复**。最隐蔽的十七个：
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
  - 缺陷 15：**候选卡片注册了却永远不出现（一）**：`ctx.remote.memfuse` **没注入** →
    cordis 拒（`cannot get property "remote.memfuse" without inject`）→ `list()` 每次抛 →
    被自己的 catch 收成 `snapshot.error` → 卡片 `return null`。修法见上面 H8 的第 ③ 条
  - 缺陷 16：**候选卡片注册了却永远不出现（二）**：字典文案写成**函数** →
    官方 locale 的 `template.replace` 在渲染期抛 TypeError。模板**必须是字符串**
    （`'· {members} 条记忆 · {score} 分'`）—— 别拿"函数式文案"当方便，它只在渲染期炸
  - 缺陷 17：**一按保存就「保存失败」**：`skill.suggest` 漏标 `.volatile()` ——
    宿主只收 volatile 路径（`dsh-settings/lib/index.js:629`），而且**一次 mutate 里有一个
    非法 op 就整批拒**，同批里合法的字段也一起丢。修：补 `.volatile()`；失败时把
    "改过哪些路径"显示出来（官方 `ConfigFormController.mutate` 把宿主原话丢了）。
    护栏：`lib/client.js` 导出 `WRITABLE_PATHS`，测试拿它逐项比对 schema 的 volatile
  - 缺陷 18：**通道还是没挂上**：`ctx.remote.$mount()` 内部要
    `callerCtx.typert.remotes.register()` —— 第三方插件的 ctx 必须**自己声明 `typert`**
    （`cannot get property "typert" without inject`）。修：`ctx.inject(['typert','remote'], mounter => …)`
    里挂载，且 `$mount` **必须从 mounter 上取**（它读 `this.ctx`，`.call()` 过去的写法无效）
  - 缺陷 19：**没参数的端点正常、一按按钮就报错**：描述符参数漏了 `source: 'json'` ——
    宿主 `resolveParameter()` 只看 `parameter.source === 'json'`，否则当 lookup 参数去要
    provider key（`lookup parameter "keys" has no provider key`）。修：参数一律由
    `jsonParam(name, codec)` 生成，两份描述符都改，测试逐参数断言 `source === 'json'`
  - 缺陷 20：**卡片长在每个回合的尾巴上**：turnTail 是**按回合渲染**的，不加门就一席对话
    几十张（用户一眼看出）。修：`props.useChat(s => s.timeline.turnOrder.at(-1) === props.turn)`
    —— 照抄官方 owner 的判据；⚠️ hooks 不能有条件调用，早退放在所有 hook 之后
  - 缺陷 21：**界面动作后 `status.md` 不刷新**：审计面写着「界面已看过 0 组」而
    state.json 里已经有 5 组。`markSuggestionsSeen` 等只写 state.json；现在三个界面动作
    之后顺手 `writeStatus()`（`lib/index.js` 的 `refreshStatusAfterUi`）
  - 缺陷 22：**卡片一次摆 5 行**（用户："太多了，默认 1 组就可以"）：行数改为跟
    `skill.suggestMax`（默认 1）走 —— 纯函数 `selectUiSuggestions()`；**没显示的组把 key
    交回**（`restCount`/`restKeys`），卡片一并记 seen（否则变成"排队刷屏"），
    并写一行「另有 N 组同类候选 —— 用 memfuse_skill action=list 查看」
  - 缺陷 23：**卡片一闪而过**（用户："并没有弹出来卡片"，而 `state.json` 里 `skillSeen`
    的时间戳一次比一次新 = 卡片确实渲染过）。根因是两条设计相撞：卡片**渲染即记 seen**，
    而渲染路径上还有一次去抖刷新（`touch()` → 1.5s 后 `list`）—— 那次回来时那几组已经
    记过 seen，`visible` 被清空，卡片当场把自己撤掉。修：**按回合"领一次、钉住"** ——
    `feed.claim()` 领走宿主刚交回来的那几份（领走即清空），卡片把它钉在
    `<sessionId>:<turn>` 上；键里带 turn/sessionId 所以不串回合、不串对话；
    点「提炼/不用」→ `unpinRow()`；**过期响应丢掉**（`loadSeq`，两个 `list` 同时在飞是常态）；
    要记 seen 的 key 在 `publish()` **之前**固定（否则渲染里的 claim 清空 visible，
    显示过的那组反而永远记不上 seen）
  - 缺陷 24（**最坑的一个，也最贵**）：**卡片从此再也不出现** —— 上面那道"只长在最后一个回合"
    的门写的是 `String(order.at(-1)) === String(props.turn)`，而真机上 `props.turn` 是**对象**
    （`node.location.turn` = `{turn: <id>, status}`，`TurnTailNodeView` L6577）、
    `turnOrder` 里是 **id** → `"[object Object]" !== "5"` 恒 false → 卡片**一天都没画出来过**。
    而 `touch()` 在门之前调用，所以 `state.json` 里 `skillSeen` 时间戳照写不误 ——
    看起来"弹过了"，其实一次都没渲染。修：`turnIdOf(turn)`（对象取 `.turn` / `.id`，标量原样），
    两边都过它再比；认不出 id 就按"是"处理（宁可多一张，别把功能藏起来）。
    ⚠️ **判据要认准**：`skillSeen` 时间戳只能证明 `touch()` 跑过，**不能**证明卡片画出来过
  - 缺陷 25（**设计错了，不是 bug**）：**点「提炼成技能」之后没有下一步** —— 用户原话
    "为什么我点击提炼技能后，弹框消失了，并没有给我弹出创建技能的下一步操作呀？
    点提炼技能后，不应该弹出一个框，让我看一下具体的提炼的技能的提示词以及作用吗？"
    当时那个按钮只记一条待办（`requestDistill`），真正的提炼等下一轮 Block E 催模型调工具；
    卡片那一行又被 `unpinRow()` 当场去掉 → "点完什么都没发生"（客户端快照里的 `pending`
    字段**从来没渲染过** —— 又是"功能存在但从不生效"）。修：**卡片内两段式** ——
    点提炼 → 宿主 `memfuse/distill` 当场调模型写 SKILL.md（先显示"正在提炼…"）→
    卡片出现草稿面板（技能名 + 作用 + **SKILL.md 全文** + `[装进技能库] [丢掉]`）→ 装/丢后
    留一句结果说明；提炼失败**如实显示**并退化成 `requestDistill` 待办。见上面 H8 的第 ⑥ 条
  - 缺陷 26（**重启后底部一直挂着 404**）：用户重启后只看到
    `界面通道出错：client api: memfuse/list failed: transport failure for /api/memfuse/list: HTTP 404`。
    宿主那侧其实是好的（`state.json` → `remoteChannel = {endpoints: 7}`、`runtimeFaults = {}`）——
    那次 404 只是请求赶在宿主网关能应答之前。**真正的问题是"失败之后没人重试"**：
    刷新只挂在渲染上（`touch()` 去抖 1.5s），失败会 `publish()` → 立刻渲染 → 那次 `touch()`
    距上次只有几毫秒 → 被去抖挡掉 → 再没有任何东西会重拉（上一轮说"会自愈"只对了一半：
    自愈条件是**用户再发一条消息**，不是时间）。修：① 失败后退避重试（1s/2s/4s，最多 3 次，
    成功即 `clearRetry()`；Node 里记得 `timer.unref?.()`，否则测试进程被吊住）；
    ② 出错状态下 `touch()` 不吃去抖。见 spec 缺陷 26
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
$dnode = '<DSH_APP>\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
$dbin  = '<DSH_APP>\resources\app\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js'
& $dnode $dbin memfuse-smoke "用一句话说明 DSH 是什么。不要用任何工具。"
# 夹具 profile：~/.dsh/profiles/memfuse-smoke（从 headless 模板建，junction 到本仓库）
# 用完删目录即净。加新条目记得用 `- insert:`，直接写 `- id:` 会静默不加载。
```

⚠️ **新增/修改了 client half（`lib/client.js` + `package.json` 的 `dsh.client`）之后必须再重启一次 desktop**：
宿主在启动时扫描 `dsh.client` 声明并把它接进客户端模块表（增量扫描按**已知包**做，
新声明要新一轮激活扫描），浏览器侧也要重新拉那份 bundle。判据：重启后
`cordis_inspect_query(platform=client, provider=Slots, listSubTree, {root:'plugins.bundle.config'})`
的 `occupants` 里应出现 `key: "dsh-memfuse"`，且
`{root:'plugins.row.config'}` 里应出现 `key: "dsh-memfuse#dsh-memfuse"`；
候选卡片还要看 `{root:'conversation.chat.turnTail'}` 里有没有 `id: "dsh-memfuse#suggestions"`。
**卡片有没有真的渲染过**，看 `~/.dsh/memory/.memory/state.json` 里有没有 `skillSeen` 键
（`status.md` 的「界面已看过（skillSeen）」同理）—— 一直是 0 组 = 从来没成功拉到过数据。

## 占位符（公开仓库里不写本机绝对路径）

文档、注释、测试夹具里**一律用占位符**，别把真实路径写回去（仓库是 public，环境布局没必要公开）：

| 占位符 | 含义 |
|---|---|
| `<DSH_APP>` | 桌面版 DSH 安装目录（`resources\runtime\...\node.exe`、`resources\app\dsh\node_modules\@deepseek-ai\` 都在它下面） |
| `<HARNESS_SRC>` | DSH 源码版仓库根（查 `tool-cordis` 源码时才用） |
| `<VAULT>` | 本机 Markdown 知识库根（`memory_*` 工具那套） |
| `<REPO_DIR>` | 本仓库的本地路径（装 profile 时用） |
| `<WINDOWSAPPS>` / `<PRODUCT_DIR>` | 第三方应用安装目录（剖析文档里） |
| `<LOCAL_PROXY_PORT>` | 本地代理端口 |

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
- ⚠️ **`node --test` 的坑（Node 22.22 实测）**：`client.test.mjs` / `preview.test.mjs`
  **不进 `--test` 的子进程**（`npm test` 里是直接 `node test/xxx.mjs`）：跑整包时会偶发
  `Unable to deserialize cloned data due to invalid or unsupported version.`，
  而**用例其实全过**。测试里也**别 `await` 一个 `setTimeout`**（换 `setImmediate`）——
  这个能稳定触发同一个错。详见 `docs/NEXT.md` §0.3。
- ⚠️ **改 `AGENTS.md` / 任何中文文件时，别用 PowerShell 的 `Get-Content`/`Set-Content` 改**：
  PS 5.1 按 GBK 读 UTF-8 会把整份文件变成乱码（真机踩过，只能 `git checkout` 重来）。
  要么用编辑工具，要么用 Node 脚本读写。
- **改宿主相关代码前，先查本机宿主包**（不是文档、不是猜）：
  - 源码：`<DSH_APP>\resources\app\dsh\node_modules\@deepseek-ai\`
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
| 动态那一套只在**源码版**仓库里 | `<HARNESS_SRC>\packages\extensions\tool-cordis\src\index.ts` → L149 `cordis_define`、L241 `cordis_run`、L330 `cordis_stop`、L352 `cordis_undefine`、L97 `cordis_inspect_self` |

**✅ 真正可用的三条路**（按推荐度）：

1. **换进程跑冒烟**（本项目标准做法，命令见上面「已验证」一节）——
   新进程 = 新模块，零重启代价，而且能跑真实对话。**代码改动就用它验。**
2. **`dsh <新名字> --from-default-profile <acp|headless|sdk|sdk-minimal|web>`**：
   从模板建一次性 profile 当夹具，删目录即净。往里面加新条目记得用 `- insert:`（见 spec §3.12 坑 A）。
3. **动态插件**：等同时具备「源码版 runtime + 带 `cordis_define` 的 tool-cordis」再用；本机桌面版做不到。

## 记忆系统（两条链路都在用）

- **memfuse 自己的库**：`~/.dsh/memory`，工具 `memfuse_*`（desktop + web 都指向它）
- **本地 Markdown 知识库（vault）**：`<VAULT>`，工具 `memory_*`（**desktop 已改用 memfuse，故这边只剩 web / 手动**）

```powershell
node <VAULT>\.memory\kb.js recall "dsh-memfuse"
node <VAULT>\.memory\kb.js index    # 写完后重建索引
```
