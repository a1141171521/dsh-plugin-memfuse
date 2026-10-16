# 下一轮开发清单（2026-10-16 收尾 → 换机器继续）

> 本文件是给**下一次接手**看的：今天做到哪、停在哪、明天第一步查什么。
> 背景与取舍的完整记录在 `docs/spec.md` §H7/§H8，不在这里重复。

---

## 0.1 2026-10-16：重启后真机验收 —— 卡片没出现，查出两个静默失败（已修）

用户重启 desktop 后问"现在是以什么形式弹出来的卡片？"。查下去发现：卡片**注册上了**
（槽位树里有 `dsh-memfuse#suggestions`，`active: true`），但宿主 `state.json` 里
**`skillSeen` 一直空的** —— 说明它**从来没成功拉到过数据**。两个原因叠加，
**任何一个单独都能让卡片永不出现，且都是零报错**：

| # | 缺陷 | 症状 | 判据/证据 |
|---|---|---|---|
| 15 | `ctx.remote.memfuse` 没注入 → 被 cordis 拒 | `list()` 每次都抛，被自己 catch 成 `snapshot.error`，卡片 `return null` | 真 cordis 实测：`cannot get property "remote.memfuse" without inject`；官方 voice-input 也是 `$mount` 完再 `ctx.inject(['remote.speech',…])` |
| 16 | 字典文案写成**函数** | 渲染期 `template.replace is not a function` | 官方 locale 是 `template.replace(/\{(\w+)\}/g,…)`，模板必须是字符串 |
| 17 | `skill.suggest` 漏标 `.volatile()` | 一按保存就「保存失败」，**同批里合法的字段也一起丢** | 宿主 `dsh-settings/lib/index.js:629`：`Config field "skill.suggest" is not volatile`；一次 mutate 有一个非法 op 就整批拒 |
| 18 | `$mount` 要的是**调用方的 `typert`** | 配置页写「界面数据通道没挂上：cannot get property "typert" without inject」，卡片永不出现 | `mountContribution` 里是 `callerCtx.typert.remotes.register(贡献)`；官方 `dsh-api-gateway` 客户端半边自己的 inject 里就有 `typert` |
| 19 | 描述符参数漏了 `source: 'json'` | **没参数的 `list` 正常、一按卡片上的按钮就报错**：`lookup parameter "keys" has no provider key` | 宿主 `resolveParameter()`：`if (parameter.source === "json") return value;` 否则当 lookup 参数要 provider key（`dsh-api-gateway/lib/index.js:1099`） |
| 20 | 卡片长在**每个回合**尾巴上 | 一席长对话里冒出几十张卡片（用户："每个对话底部都出现这个卡片了，很不好"） | turnTail 是**按回合**渲染的；判据用 `props.useChat(s => s.timeline.turnOrder.at(-1) === props.turn)`（官方 owner 同款），⚠️ hooks 不能有条件调用 |
| 21 | 界面动作后 `status.md` 不刷新 | 审计面写着「界面已看过 0 组」而 state.json 已有 5 组 | `markSuggestionsSeen` 等只写 state.json；现在三个界面动作之后顺手 `writeStatus()` |
| 22 | 卡片一次摆 5 行 | 用户："太多了，默认 1 组就可以" | 行数跟 `skill.suggestMax`（默认 1）走：`selectUiSuggestions()`；其余组把 key 交回、卡片一并记 seen（**别改成排队刷屏**），并写一行「另有 N 组」 |

**修法**（`lib/client.js` / `lib/config.js`）：

```js
// ① 两段式注入：先声明 typert 拿"挂载用"的 ctx，再声明命名空间拿"数据源用"的 ctx
mountFiber = ctx.inject(['typert', 'remote'], (mounter) => {
  await mounter.remote.$mount(remoteContribution());   // $mount 读 this.ctx，必须从 mounter 取
  cardFiber = mounter.inject(['remote.memfuse','slots','locale'], (child) => {
    const feed = new SuggestionFeed(child);            // 数据源必须用子 ctx
    …
  });
});
// ② skill.suggest 补 .volatile()；保存被拒时把"改过哪些路径"显示出来
```

文案改回字符串模板：`suggestMeta: '· {members} 条记忆 · {score} 分'`。

**防回归**：客户端测试的替身会照真机抛 `typert` / 命名空间的注入错误；
`WRITABLE_PATHS`（配置页会写的全部路径）× 宿主 schema 的 `.meta.volatile` 逐项比对 ——
两类错都会当场红。

**顺带补的可见性**（硬规则 4）：通道坏掉时回合尾渲染一行 `界面通道出错：<原始消息>`；
配置页加两行 `候选卡片：已连上（N 组）` / `读不到数据：<原始报错>`，
保存失败时写明改动的路径。

### 0.2 离线预览页（不重启也能看卡片）

```
npm run preview     # 起本地静态服务并打开 docs/preview/turn-tail-card.html
```

⚠️ 别直接双击 HTML：模块脚本在 `file://` 下会被浏览器 CORS 拒（页面壳子在、卡片不出来）。
预览页加载**真实的 `lib/client.js`**（同 bundle / 同 CSS / 同字典），宿主是假数据；
侧栏有宿主状态、远程调用日志、下一轮 Block E 示意，四个场景按钮（不点/簇长大/新候选/重置）。
`test/preview.test.mjs` 用迷你 DOM 压一遍（渲染、插值、注入链、两个按钮、seen 语义）。

### 0.3 ⚠️ 测试脚本的坑（Node 22.22 实测，别再踩）

`node --test` 在跑 `test/client.test.mjs` 时会**偶发**子进程协议崩坏：
父进程报 `Unable to deserialize cloned data due to invalid or unsupported version.`，
**而所有用例其实都是过的**（单独跑 15/15 全绿，跑整包大约一半概率红）。
实测两个触发条件（避开就稳）：

1. 测试里**别 `await` 一个 `setTimeout`** —— 会稳定触发；用 `setImmediate` 排空；
2. 干脆**别让这两个文件进 `node --test` 的子进程**：`npm test` 现在是
   `node --test test/plugin.test.mjs && node test/client.test.mjs && node test/preview.test.mjs && node test/smoke.mjs`。
   后两个文件直接跑同样是 `node:test` 的 runner（TAP + 失败退出码非 0），只是没有"再来一个子进程"这一层。

### 0.4 想再看一次候选卡片？清 `skillSeen` 有讲究（2026-10-16 真机实测）

卡片是"**渲染即记 seen**"，所以看过一次就不再出现（簇长大 → key 变 → 再提一次）。
想复现一次，**只清 `~/.dsh/memory/.memory/state.json` 里的 `skillSeen` 是没用的**：

1. 宿主的 `state` 只在 `apply()` 时 `readState()` 读**一次**（`lib/index.js:1605`），
   之后 `memfuse/list` 用的是**内存里那份**；
2. **每个 step 的注入都会把内存那份写回 state.json**（`flushInjected`）——
   清完两分钟就被覆盖回来（实测：清成 0 组 → 又变回 7 组）。

改 `~/.dsh/profiles/<profile>/cordis.patch.yml` 也**不会**热生效（不是被 watch 的：
实测加一行注释后等 4 秒，`status.md` 的生成时间纹丝不动）。可行的是停/启插件：

```
plugin_manager set_plugin target=include:dsh-memfuse enabled=false   # 停
# 趁停着清 state.json 的 skillSeen（此时没有 pre-step 注入，没人写回）
plugin_manager set_plugin target=include:dsh-memfuse enabled=true    # 启 → apply() 重跑 → 重新 readState()
```

**判据**：`status.md` 的「生成时间」变成此刻 **且**「界面已看过（skillSeen）: 0 组」
—— 后者是拿**内存里**的 state 渲染的，所以它 = 0 就说明内存也空了（只清磁盘这行不会变）。
停/启**不会**弄坏客户端半边（`turnTail` 里 `dsh-memfuse#suggestions` 始终 `active`，
`state.remoteChannel` 仍是 `{endpoints:4}`），但会重跑一次启动抽取（多一次 LLM 往返）。
清干净后**不用刷新页面**：卡片每次渲染都会 `touch()` → 去抖 1.5s → 重新 `list`，
所以这一回合结束它就会自己出现。

### 0.5 卡片"一闪而过"（缺陷 23）—— 真机上用户**永远看不到卡片**

用户第三次说"并没有弹出来卡片"。当时以为 `state.json` 里 `skillSeen` 的时间戳一次比一次新
（`04:39:53`、`04:40:55`）就是"卡片渲染过"的证据 —— **这个推断是错的**，见 §0.6：
`touch()` 在门之前调用，所以时间戳只能证明"拉过数据"。这一节修的是**另一个真实存在的隐患**
（下面两条设计确实相撞，只是不是本次"看不到"的原因）。

两条设计相撞：① 卡片**渲染即记 seen**；② 渲染路径上还有一次去抖刷新
（`touch()` → 1.5s 后 `list`）—— 那次回来时那几组已经记过 seen，`visible` 被清成 `[]`，
卡片当场 `return null`。（②本身是必要的：客户端没有轮询通道，"新候选自己冒出来"靠它当心跳。）

修法（`lib/client.js`）：**按回合"领一次、钉住"**。

| 机制 | 干什么 |
|---|---|
| `feed.claim()` | 把宿主刚交回来、还没给过任何回合的那几组**领走**（领走即从共享快照清空） |
| `pinnedCard`（键 `<sessionId>:<turn>`） | 卡片只读自己领到的那一份 → 空刷新撤不掉它；也不串回合 / 不串对话 |
| `unpinRow(key)` | 点「提炼 / 不用」→ 那一行也从钉住的那份里去掉（否则"点了没反应"） |
| `loadSeq` | **过期响应丢掉**：先发出的 `list` 回来时序号变了就整份丢弃（真机启动时两个 `list` 同时在飞） |
| `seenKeys` | 要记 seen 的 key 在 `publish()` **之前**固定 —— 渲染里的 claim 会清空 `visible`，晚读就读到空的 |

回归：`test/client.test.mjs` 的「刷新回来是空的，卡片也不许把自己撤掉」（把两帧直接喂给组件，
不真等 1.5s）；预览页也补了"回合"概念（`preview.nextTurn()`，四个场景按钮 = 进下一轮），
否则演示出来的语义正好是反的。

### 0.6 卡片"再也不出现"的真凶（缺陷 24）—— 那道门比错了东西

把"一闪而过"的可能全部排掉之后（`skillSeen` 一直在写、渲染器 Code Cache 里确认有
`pinnedCard`/`unpinRow` = 新 bundle 确实在跑），屏幕上**永远什么都没有**。

真因：`dsh-client-ui-chat` 的 `TurnTailNodeView`（L6577）传下来的 `turn` 是
**TurnLocation 对象** `{turn: <id>, status}`，而 `snapshot.timeline.turnOrder` 里是 **id**。
缺陷 20 那道门写成了 `String(order.at(-1)) === String(props.turn)` → `"5" !== "[object Object]"`
→ **恒 false** → 卡片一次都没渲染过。

**为什么能瞒这么久**：`touch()` 在门**之前**调用，所以每轮照发 `list` + `markSeen` ——
`skillSeen` 的时间戳看起来完全像"弹过了"。
👉 **判据要认准**：`skillSeen` 只能证明 `touch()` 跑过，**不能**证明卡片画出来过。
（排查时请用这个判据，别再被它骗。）

修法：`turnIdOf(turn)`（对象取 `.turn`/`.id`，标量原样），两边都过它再比；
认不出 id 就按"是"处理（宁可多一张，别把功能藏起来）。`pinnedCard` 的键也改成
`<sessionId>:<回合 id>`。回归：`test/client.test.mjs` 补了真机形状的两个断言。

### 0.7 点「提炼成技能」之后**没有下一步**（缺陷 25）—— 设计错了，不是 bug

用户点完按钮的原话：

> 为什么我点击提炼技能后，弹框消失了，并没有给我弹出创建技能的下一步操作呀？
> 点提炼技能后，不应该弹出一个框，让我看一下具体的提炼的技能的提示词以及作用吗？

**当时的实现**：那个按钮只记一条待办（`requestDistill` → `state.distillRequests`），
真正的提炼等**下一轮注入**的 Block E 催模型调 `memfuse_skill action=distill`；
而卡片那一行又被 `unpinRow()` 当场去掉 → 用户看到的就是"点完什么都没发生"。
（客户端快照里其实有 `pending` 字段，但**从来没渲染过** —— 又是"功能存在但从不生效"。）

**现在**：两段式，全在卡片里 ——

1. 点「提炼成技能」→ 宿主 `memfuse/distill` **当场调模型写出 SKILL.md**（卡片先显示"正在提炼…"）；
2. 卡片出现草稿面板：**技能名 + 作用（description）+ SKILL.md 全文（等宽可滚）**
   + `[装进技能库] [丢掉]`；装/丢之后留一句结果说明。

四个要点（改这块之前先读）：

- **提炼失败要退化成待办**：宿主没模型时客户端顺手 `requestDistill(key)`，下一轮 Block E
  让对话里的模型去补；失败原因**原样显示**在卡片上。
- **实现只有一份**：`distillCluster` / `approveSkill` / `rejectSkill` / `pendingSkillDrafts`
  是 `memfuse_skill` 工具与界面**共用**的函数（两条路各写一遍 = 迟早漂移）。
- **草稿的真源是磁盘**（`pending-skills/`），`list` 每次都带回来 → 刷新页面草稿还在，
  所以它**不**像候选行那样需要"钉住"。
- **端点从 4 个变 7 个**（+`distill`/`approve`/`reject`）；status.md 那行会写「7 个端点」。

回归：plugin 新增 1 条（真 store + 假模型走完整条界面路径）、client 新增 3 条、
preview 新增 1 条（预览页里把整条第二阶段走一遍）。

### 0.8 重启后底部一直挂着 404（缺陷 26）—— 失败之后没人重试

用户重启后只看到一行 `界面通道出错：… /api/memfuse/list: HTTP 404`，而且**不消失**。

**先看宿主，别先改客户端**：`state.json` 里 `remoteChannel = {endpoints: 7}`、
`runtimeFaults = {}` → 7 个端点**全部**通过"装完回读 `typert.local.get()`"自校验。
所以那次 404 是请求赶在宿主网关能应答之前，**不是没装上**。

**为什么一直挂着**：刷新只挂在渲染上（`touch()`，去抖 1.5s），而失败会 `publish()`
→ 立刻渲染 → 那次渲染里的 `touch()` 距上一次只有几毫秒 → **被去抖挡掉** →
再也没有任何东西会重拉。上一轮我说它"会自愈"只对了一半：自愈的触发条件是
**用户再发一条消息**，不是时间。

修：① 失败后退避重试（1s/2s/4s，最多 3 次，成功即清零）；
② 出错状态下 `touch()` 不吃去抖。`markSeenForVisible` 的失败同样接上重试。

回归：client 两条（① 只等定时器、不渲染卡片 → 自己回到 `ready`；② 紧跟渲染 → 真的又拉了一次）。

---

## 0. 今天已完成并提交 ✅

| 项 | 状态 |
|---|---|
| **H8 界面数据通道 + 回合尾候选卡片** | ✅ 真机 4/4 端点可路由；卡片已能渲染，**缺陷 15~26 全修**（"一次摆 5 行"→ 行数跟 `skill.suggestMax`；"一闪而过"→ 按回合领一次并钉住；"再也不出现"→ 那道门比错了东西，见缺陷 24；"点完没有下一步"→ 卡片内两段式提炼，见缺陷 25；"404 一直挂着"→ 失败后退避重试，见缺陷 26），待真机验收 |
| **离线预览页** | ✅ `docs/preview/turn-tail-card.html`（`npm run preview`），有测试兜着 |
| **H7 技能建议（Block E）** | 够格时主动在注入里提示，**零 LLM** |
| `dismiss` action | 用户"不用"后该组不再提示；**簇长大 key 变 → 重新提一次** |
| `skill.suggest` / `skillSuggestMax` | 配置 + 设置页开关已加（`suggest` 已补 `.volatile()`，见缺陷 17） |
| 测试 | **113 项全绿**（plugin 59 / client 26 / 预览 5 / smoke 23） |
| **真机冒烟** | 用探针走宿主 `systemPrompt.assemble()` 抓到真实组装块，且 Block E 的 dismiss 语义已验证 |
| 夹具工具 | `.memfuse-smoke/`，**路径运行时生成**，跨机器可跑 |
| spec.md | §H7 / §H8 已写（含四个静默缺陷、预览页、防回归写法） |

命令：

```powershell
npm test          # 113 项（假 ctx，不需要宿主、不需要模型）
npm run smoke     # 真宿主冒烟（需要 dsh 在 PATH，不需要模型）
npm run preview   # 打开候选卡片的离线预览页
```

---

## 1. ✅ 已完成：UI 里直接显示候选卡片（2026-10-15 当轮做完）

**需求原文**：
> UI 里直接显示候选卡片；如果用户忽略了候选卡片，**不能一直提示**。

**结论（真机已验证）**：

- 数据通道 = 手写 Typert 贡献，`lib/remote.js`（**不需要代码生成器、不需要 zod**）。
  **七个端点**：`memfuse/list|dismiss|markSeen|requestDistill|distill|approve|reject`
  （后三个是缺陷 25 补的：界面点「提炼成技能」当场写 SKILL.md → 草稿预览 → 装/丢）；
  真机探针：**4/4 可路由**（当时只有四个），服务 `memfuseRemote` 已 provide。
- 卡片挂在 `conversation.chat.turnTail`（list 槽）：`id='dsh-memfuse#suggestions'`，
  候选段按钮 `[提炼成技能] [不用（别再提）]`，草稿段按钮 `[装进技能库] [丢掉]`。
- "不能一直提示" = **渲染即记 `skillSeen`**（宿主 state.json，prompt 与卡片共用一份状态）；
  `dismiss` 才是"别再提"；簇长大 → key 变 → 会再提一次。
- 「提炼」→ **宿主当场调模型写 SKILL.md**（用户点按钮 = 显式触发），界面给草稿预览；
  宿主这侧提炼不了时退化成 `distillRequests` 待办 → 下一轮 Block E 催模型执行
  `memfuse_skill action=distill`（界面不偷偷调模型，符合"关键路径零 LLM"）。

**两个坑（都写进 spec §H8 与 lib/remote.js 注释了）**：

1. 宿主贡献读 **`invocations`**、客户端读 **`descriptors`** —— 字段名写错时宿主**静默收下**，
   表现只是"卡片不出现"；所以 `installRemoteHost()` 注册完必须**回读 `typert.local.get()` 自校验**。
2. codec 只要 `{mode:'strict', typeSymbol, create:()=>({parse})}` —— 别去引 zod。

### 1.1 剩下的小尾巴（非阻塞）

- `[提炼成技能]` 目前只写待办（下一轮由模型执行）。若想"点完立刻发生"，
  可以用 turnTail 的 `inputActions.insertText()/setDraft()` 把请求塞进输入框让用户回车
  （方法名已核实，但没接 —— 怕覆盖用户正在写的草稿，要接的话用 `insertText`）。
- 卡片只在**有候选且没看过**时出现；想常驻可以另挂 `sidebar.right.pane.tab`。

### 1.2 历史记录：调研过程（保留，避免重复查）

<details>
<summary>当时的调研结论（已完成，留作参考）</summary>


当前交付链是**间接**的：

```
Block E 拼进 system prompt → 模型看到 → 靠工具描述要求它"主动转述给用户"
```

**风险：模型不转述，用户就永远看不到。** 这是今天要改成 UI 的动因。

### 1.2 今天调研到的可用 slot（中断在这里）

| slot | 谁在用 | 适不适合放候选卡 |
|---|---|---|
| **`conversation.chat.turnTail`** | deliverables / goal / plan-mode / deque | ⭐ **最贴合** —— 就是"回合尾卡片"的位置 |
| `plugins.bundle.config` | memfuse 现有配置表单（key = 包名） | 兜底选项，肯定能渲染 |
| `plugins.row.config` | memfuse 行标题可点（key = `dsh-memfuse#dsh-memfuse`） | 只适合入口，不适合卡片 |
| `sidebar.right.pane.tab` / `.title` | deliverables / plan / auto-review | 适合"常驻面板"，但不够主动 |
| `settings.plugins.tab` | llm-api-extensions | 设置页内标签，发现性一般 |

客户端注册方式（现有代码 `lib/client.js:763-771`）：

```js
ctx.slots.inject('plugins.bundle.config', () =>
  ctx.slots.register({ name: 'plugins.bundle.config', key: CONFIG_NS, ...face() }, View),
);
```

### 1.3 ❗明天第一步要查清的未知点

**客户端怎么读/写宿主侧的 memfuse 数据？** 这是这个任务唯一真正的拦路虎。

现状：
- `suggestions` / `dismiss` 目前**只有工具入口**（`memfuse_skill`，模型可调），**没有给 UI 用的 remote 方法**
- 客户端现在唯一读到的宿主数据是 `ctx.remote.session.modelCatalog()` —— **那是宿主自带服务，不是插件注册的**
- 所以要先搞清楚：**插件能不能往 `remote` 上挂自己的方法？怎么挂？**

排查路径（**先查本机宿主包，不是文档、不是猜** —— AGENTS.md 纪律）：

```powershell
# 宿主包在 <HARNESS_SRC>\... （机器 A），机器 B 是 <DSH_APP>\...
# 1) 找 remote 服务的定义与注册方式
rg -l "remote" packages/*/lib | rg "dsh-remote|api-remotes"
# 2) 看官方插件里有没有插件自挂 remote 方法的先例
rg "remote\.\w+\.(register|provide|define)\(" -g '!node_modules'
# 3) 实时契约（重启 desktop 后可用）
# cordis_inspect_query(platform=client, provider=Remote, listTools)
```

**如果结论是"插件挂不了 remote 方法"**，退路按优先级：
1. 卡片渲染在 `plugins.bundle.config`（复用现有通路），数据走宿主已有的通道
2. 卡片做成**只读入口**：显示"有 N 组候选" + 一个按钮把 `memfuse_skill action=list` 的调用塞进对话框
3. 维持现状（prompt 侧），等 remote 机制明确再做

### 1.4 "不能一直提示"的设计决策（待拍板）

`turnTail` 每轮都会渲染 → **天然会一直提示**。光有 `skillDismissed` 不够，需要更轻的一层：

| 方案 | 行为 | 评价 |
|---|---|---|
| **A：`skillSeen`** | 卡片**展示即记录**簇 key；key 不变就不再出现；成员变化（key 变）重新出现 | 用户不用做任何操作就不被打扰。推荐 |
| **B：三按钮** | `[提炼]` `[不用]` `[下次再说]`；后者写 `skillSeen`，前者写 `skillDismissed` | 交互更明确，但多一个状态 |

**硬性要求**：Block E（prompt）与 UI 卡片**必须共用同一份状态**。
两边各存一套 → 用户在 UI 点了"不用"，下轮 prompt 里 Block E 还在 → 又变成"一直提示"。
⇒ 建议 `skillSeen` 也落在宿主侧 `state.json`，客户端只发指令、不自存。

### 1.5 可以直接复用的现成能力（**别重写**）

| 能力 | 位置 | 说明 |
|---|---|---|
| 算建议 | `computeSuggestions()` / `api.suggestions()` | 零 LLM，**已滤掉 dismissed** |
| 忽略 | `dismissSuggestion()` / `memfuse_skill action=dismiss` | 已实现，含 200 条裁剪 |
| 簇身份 | `distill.clusterKey()` | 成员排序拼接；已有测试锁定"成员变→key 变" |
| 渲染文案 | `renderSuggestions()` | 若要 UI 复用文案，注意它现在输出的是 markdown 行 |

</details>

---

## 2. 环境差异（换机器必读）

| | 机器 A | 机器 B |
|---|---|---|
| 宿主 | `<HARNESS_SRC>\` | `<DSH_APP>\` |
| AGENTS.md 里的冒烟命令 | 路径要换成 `<HARNESS_SRC>\...` | 原样可用 |
| 夹具 profile | `~/.dsh/profiles/memfuse-smoke` **已建** | **需重建**（见下） |
| API key | ❌ **失效**（`****eUU1 is invalid`）→ 跑不了真模型往返 | 未知 |

> 好消息：`.memfuse-smoke/smoke.mjs` 里**没有任何写死的绝对路径**，overlay 运行时生成，换机器直接跑。

**备用机（第二台开发机）首次准备夹具**（三条命令）：

```powershell
$prof = "$env:USERPROFILE\.dsh\profiles\memfuse-smoke"
Copy-Item "$env:USERPROFILE\.dsh\profiles\headless" $prof -Recurse
# 然后编辑 $prof\package.json：加 dsh-memfuse 进 dependencies(link:...) 与 dsh.profile.bundles
# ⚠️ 不要用 PowerShell Set-Content 写 package.json（会加 BOM，JSON.parse 直接崩）
New-Item -ItemType Junction -Path "$prof\node_modules\dsh-memfuse" -Target <仓库路径>
New-Item -ItemType Junction -Path "$prof\node_modules\memfuse-probe" -Target <仓库路径>\.memfuse-smoke\probe
```

**git 推送**：本机 `github.com:443` 直连被墙，仓库级代理已配 `<LOCAL_PROXY_PORT>`（需 Clash 开着）。
备用机若不通：`git config --unset http.proxy` 后改走 SSH（本机实测 `ssh.github.com:443` 与 `github.com:22` 都通）。

---

## 3. 今天踩到的三个坑（都写进注释了，别重复踩）

| 坑 | 现象 | 根因 / 修法 |
|---|---|---|
| **冒烟提示词与 seed 不匹配** | 检查项「相关召回（Block B）」永远 ❌，看起来像注入坏了 | Block B **只在召回命中时渲染**（`inject.js: if (rel.length)`）；smoke 原来发 `'hi'`，而 seed 是三条**部署**记忆 → 命中恒为 0。修法：`smoke.mjs` 用 `PROMPT = '帮我部署到测试环境'`（已修） |
| **拿 mtime 证明隔离** | 「真库被改写了」—— 但那是**活着的 desktop 宿主**在写自己的库 | 备用机上 desktop 一直开着，它随时写 `~/.dsh/memory/.memory/{state.json,status.md}`（本会话就在写）。**隔离要判内容**：真库里有没有出现只有夹具才有的东西（seed 的 `m_deploy_*` / `state.root` 指向 `.memfuse-smoke`）。已改成内容判据 |
| **PowerShell `Set-Content -Encoding UTF8` 写 BOM** | `JSON.parse` 报 `Unexpected token ''`，profile 起不来 | 用编辑器/工具写，或 `[IO.File]::WriteAllText` + `UTF8Encoding($false)`。（改 `.mjs` 也会带 BOM：Node 能忍，但别留着） |
| **Windows ESM 绝对路径** | `ERR_UNSUPPORTED_ESM_URL_SCHEME: protocol 'd:'` | `import(pathToFileURL(p).href)` |
| **测试脚本自己推簇 key** | 误报"dismiss 没生效" | 按目录列 id 推 key 是**错的**（把 P0 那条也算进簇）→ 必须调插件自己的 `buildSuggestions()` |

第三条值得记成一条通用纪律：**验证某段逻辑时，用那段逻辑本身算，不要在测试里重新实现一遍。**
第四条（新增）：**判"有没有副作用"要看内容，不要看时间戳** —— 旁边有个活着的进程在写同一个文件时，
mtime 什么也证明不了。

---

## 4. 已知遗留（非阻塞）

| 项 | 状态 |
|---|---|
| 真实模型往返（`extract` / `distill` 真调模型） | 本机 key 失效，**未验**。spec §H7「仍未做」已记 |
| `preview` 档（后台预生成技能正文） | 未做。会引入后台模型调用，与硬规则 3 冲突 → 要做得**显式 opt-in 且默认关** |
| `renderSuggestions()` 输出 markdown 行 | UI 卡片可能想要结构化数据，届时别硬套这个函数 |
| spec L979 与 L854 矛盾 | 上轮已指出，**未处理**（"真实模型往返至今只被假模型测过" 已过时） |

---

## 5. 改完之后怎么验

```powershell
npm test           # 必须先绿；改了 client half 记得同步改字段顺序断言
npm run smoke      # 真宿主；探针会抓组装块
# 改了 lib/client.js ⇒ 必须重启 desktop（宿主启动时扫描 dsh.client）
# 判据：
#   cordis_inspect_query(platform=client, provider=Slots, listSubTree,
#                        {root:'conversation.chat.turnTail'})
#   的 occupants 里应出现 memfuse 的 key
```
