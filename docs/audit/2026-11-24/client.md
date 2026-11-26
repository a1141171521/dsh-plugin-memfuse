# 客户端状态机与设置页（lib/client.js）审计报告

## 概览

- **代码版本**：`9b6d190`（`git status --short` 只显示新增的 `.audit/` 与 `docs/audit/`，`lib/`、`test/`、`package.json`、`docs/spec.md`、`docs/NEXT.md`、`AGENTS.md` 均未改动）。
- **读了哪些文件**：
  - `lib/client.js` 全文 3594 行（工厂头 / CSS / FIELDS / 组件 / SuggestionFeed / MemoryPanelFeed / 卡片 / 字典 / apply）。
  - `lib/config.js`、`lib/memory-view.js`、`lib/suggestion-status.js`、`lib/remote.js`，以及 `lib/index.js` 的 `list` / `memories` / `setPriority` / `revive` 实现段。
  - `test/client.test.mjs` 全文（1997 行，确认哪些行为已有回归、哪些是设计）。
  - `docs/NEXT.md` 顶部约 180 行、`docs/spec.md` 的缺陷 23 / 25 / 26 / 27 / 37 / 38 / 40 / 41、记忆面板、设置页分栏章节。
  - DSH 宿主源码：`dsh-client-ui-chat`（`TurnTailNodeView` 与 `conversation.chat.turnTail` 的 `scope: 'session'` 声明）、`dsh-client-ui-plugin-manager`（`plugins.row.config` 的 summary/page 两次 renderSlot）、`dsh-client-ui-renderer`（SlotOutlet 的 props 合并）、`dsh-client-ui-session`（`sessionId` 标准 prop）、`dsh-api-gateway`（远程调用没有请求超时）。
- **实际执行过的命令**：
  - `npm test` → 110 + 50 + 5 + 23 = **188 项全绿**（基线确认）。
  - `node .audit/client/f01-action-error-vanish.mjs` … `f13-follow-fallback-labels.mjs`（每条 finding 一个脚本）。
  - `node .audit/client/check-i18n.mjs`（zh/en 各 123 个 key，key 集完全一致；脚本把 `remoteDescriptors` 里的 17 个类型名（`ClusterKey` 等）也当成 `t('…')` 抓了出来，它们不是翻译 key —— 实际翻译 key 无缺失）。
  - `node .audit/client/check-writable.mjs`（`WRITABLE_PATHS` 9 条路径全部 `volatile=true`，与宿主 `Config` 对齐，未发现漂移）。
- **finding 计数：blocker 0 / high 2 / medium 8 / low 3**。

> 结论先行：**SuggestionFeed 的动作错误与通道错误混用一个字段**（F-CL-01）和**记忆面板首次读取失败后成为死路**（F-CL-02）是两条最需要先修的；其余集中在记忆面板的空态/标题/文案、更新按钮互斥、tab 键盘可达性、连点与超时、无模型横幅、跨会话草稿。

## 发现

### 摘要

| id | 严重度 | 标题 |
|---|---|---|
| F-CL-01 | high | 动作失败报错被下一次成功的 list 刷新抹掉 |
| F-CL-02 | high | 记忆面板首次读取失败重试 3 次后成为死路（没有重试按钮） |
| F-CL-03 | medium | 记忆面板空态只认搜索词，筛选到 0 条时说「记忆库里还没有内容」 |
| F-CL-04 | medium | 常驻顺序区只从当前页 rows 回查标题，翻页/搜索后显示内部 id |
| F-CL-05 | medium | 安装更新进行中「检查更新」仍可点，git fetch 与 git pull 并发 |
| F-CL-06 | medium | 设置页 tab 键盘不可达（tabIndex=-1 且无方向键） |
| F-CL-07 | medium | 提炼进行中再点另一行，第二行被静默摘掉且永不出现 |
| F-CL-08 | medium | 提炼/安装没有超时，draftBusy 闩锁可永久卡住 |
| F-CL-09 | medium | 没有可用模型时横幅仍显示绿色「记忆学习已开启」 |
| F-CL-10 | low | 英文 panelHint 说溢出 P0「not injected」，与中文/spec 相反 |
| F-CL-11 | low | 记忆面板行元信息显示裸 workspace/fact，Markdown 星号原样显示 |
| F-CL-12 | medium | 待确认技能草稿是全局的，会话 B 也弹出会话 A 的草稿卡 |
| F-CL-13 | low | 跟随+fallback 时「上面那个模型不可用时」标签/顺序自相矛盾 |

### F-CL-01 「不用 / 提炼 / 装 / 丢」失败后的报错，被下一次成功的 list 刷新当场抹掉
- **严重度**：high
- **位置**：`lib/client.js:2192`（`load()` 成功时 `error: this.seenError`、`errorVisible: null`）、`lib/client.js:2338-2345`（`dismiss` 的 catch）、`lib/client.js:2413-2419`（`distill` 的 catch）、`lib/client.js:2450-2453`（`draftAction` 的 catch）
- **复现**：`.audit/client/f01-action-error-vanish.mjs`，命令 `node .audit/client/f01-action-error-vanish.mjs`
- **实际**：
  ```
  动作失败后快照：status=ready error="dismiss 失败：磁盘只读" errorVisible=null
  动作失败后卡片上是否显示错误： true
  下一次成功 list 之后：status=ready error=null errorVisible=null
  刷新后卡片上是否还显示错误： false
  ```
- **期望**：动作失败的原因应当一直留在卡片上，直到用户再动一次手（与 `MemoryPanelFeed` 的 `actionError` / `error` 分离同一口径，见 `lib/client.js:2511-2524` 的注释）。
- **影响**：用户点「不用」，宿主写盘失败；卡片先显示错误，渲染路径上的 `props.touch()`（`lib/client.js:2855`）发起一次成功的 `list`，`load()` 把 `error` / `errorVisible` 清空。用户只看到错误闪一下，而且那一行已经被 `unpinRow()` 从卡片上摘掉（`lib/client.js:2937-2939`）—— **看起来像「不用」成功了，下一轮它又会出现**。这是「错误被吞掉 + 状态不一致」的组合，正是本项目硬规则 4 要防的失败。
- **建议修法**：`SuggestionFeed` 增加独立的 `actionError`（与 `MemoryPanelFeed` 同构）；`load()` 成功只清通道错误，不动动作错误；并且在动作成功之前不要 `unpinRow`（或失败时把行放回去并显示原因）。
- **备注**：设计不是这样：`MemoryPanelFeed` 的 `actionError` 分离注释明确说第一版混用导致「报错闪一下就消失」。`SuggestionFeed` 没有跟着改。

### F-CL-02 记忆面板首次读取失败重试 3 次后成为死路：没有「重试」按钮，`ensureLoaded` 在 error 态不动作
- **严重度**：high
- **位置**：`lib/client.js:2622-2633`（`scheduleRetry` 最多 3 次）、`lib/client.js:2659-2667`（`ensureLoaded` 只在 `status === 'loading'` 时加载）、`lib/client.js:1192-1205`（`view === null` 时只渲染标题 + 错误，没有按钮）、`lib/client.js:781-784`（`panelLoad` 暴露了 `panel.reload()` 但从未传给 `MemfuseConfigCardView`）
- **复现**：`.audit/client/f02-panel-retry-deadend.mjs`，命令 `node .audit/client/f02-panel-retry-deadend.mjs`
- **实际**：
  ```
  第一次失败后 calls=1 status=error
  重试烧完后 calls=4 status=error error="client api: memfuse/memories failed: HTTP 500" retryCount=3
  再调 ensureLoaded() 之后 calls=4（应仍等于 4）
  面板上的按钮：[]
  面板里出现「重试」： false
  面板里显示原始错误： true
  ```
- **期望**：失败 3 次后把原始报错摆在页面上，同时提供一个「重试」按钮调用 `MemoryPanelFeed.reload()`（`lib/client.js:2635-2643` 已经准备好了，`panelLoad` 也已经暴露）。代码自己的注释就写着「让用户自己点『重试』」（`lib/client.js:2483-2486`）。
- **影响**：`memories` 是设置页「我的记忆」唯一的数据源。重启后宿主端点挂载晚于客户端（缺陷 26/27 的同类竞态）时，第一次 `memories` 很可能 404/500；7 秒烧完 3 次后，面板永远停在「读不到记忆库」，**重新进入设置页也不会再拉**（`ensureLoaded` 在 error 态直接返回）。用户只能 F5 刷新整个页面；「我的记忆」这个主打功能在本次进程内等于失效。
- **建议修法**：在 `MemoryPanel` 的错误分支加一个「重试」按钮（接 `props.panelLoad` / `refresh`）；`ensureLoaded` 可以在 `error` 且用户显式点击时走 `reload()`；同时把 `panelLoad` 真正接进 `MemfuseConfigCardView` 的 props。
- **备注**：面板重试策略「比卡片短、失败后交给用户」是设计（spec §记忆面板 ⑦），但设计里默认有「用户自己点重试」这一步，代码没有实现。

### F-CL-03 记忆面板的空态只认搜索词：按「状态/优先级/作用域」筛选到 0 条时，显示「记忆库里还没有内容」
- **严重度**：medium
- **位置**：`lib/client.js:1315-1319`
- **复现**：`.audit/client/f03-panel-empty-lie.mjs`，命令 `node .audit/client/f03-panel-empty-lie.mjs`
- **实际**：
  ```
  筛选状态：lifecycle=dormant, totalMatches=0, 库内 stats.total=10
  界面文案： 记忆库里还没有内容
  显示「记忆库里还没有内容」= true
  显示「没有匹配的记忆」= false
  ```
- **期望**：只有「库确实为空」才说「记忆库里还没有内容」；只要有任何筛选（`query` / `priority` / `lifecycle` / `scope`）生效且 `totalMatches === 0`，应该说「没有匹配的记忆，试试清掉筛选条件」。
- **影响**：用户库里明明有 10 条记忆，只是选「休眠」没命中，界面却告诉他记忆库是空的，容易误以为记忆丢了。
- **建议修法**：判断条件改为「任何 filter 非空」或直接用 `view.totalMatches === 0 && (stats.total > 0 || 有筛选)` 区分；文案沿用 `panelNoMatch`。
- **备注**：不是设计；`panelEmpty` 的文案本身是「记忆库里还没有内容 —— 对话几轮之后，插件会自动学到东西」。

### F-CL-04 常驻顺序区只从当前页 `rows` 回查标题：翻页或搜索后直接显示内部 id
- **严重度**：medium
- **位置**：`lib/client.js:1212-1213`（`titleOf` 只在 `rows` 里找）、`lib/client.js:1242-1253`（常驻 `<ol>` 渲染）
- **复现**：`.audit/client/f04-panel-resident-raw-id.mjs`，命令 `node .audit/client/f04-panel-resident-raw-id.mjs`
- **实际**：
  ```
  搜索命中行：pnpm 安装依赖
  常驻区显示内容： 1. m_mvdxbrn7_lxkpb2 2. m_mvtp3pju_i1b6bn
  常驻区把内部 id 直接显示出来 = true
  常驻区是否显示真实标题 = false
  ```
- **期望**：常驻区是「每轮注入顺序」，应始终显示可读标题；当前页不包含某条常驻记忆时也不能回落到 id。
- **影响**：用户只要在搜索框输入任何词（或翻到第 2 页），顶部「常驻 2/8」下面就会变成 `1. m_mvdxbrn7_lxkpb2` 这样的内部 id，完全无法判断哪条记忆在常驻。库里超过 50 条（项目现场 119 条）时翻页必现。
- **建议修法**：让宿主 `memories` 额外返回 `residentTitles`（id → title），或让界面在 `view.resident` 里的 id 不在 `rows` 时显示 `（不在当前页）` 而不是裸 id；不要复用 `titleOf` 的页内查找。
- **备注**：`buildView` 的 `resident` 是**全量** id 列表（`lib/memory-view.js:172-177`），`rows` 只是当前页切片，两者口径本来就不同。

### F-CL-05 安装更新进行中，「检查更新」按钮仍可点：`git fetch` 会与 `git pull` 并发写 `.git`
- **严重度**：medium
- **位置**：`lib/client.js:680-705`（`checkUpdate` 只挡 `status === 'checking'`）、`lib/client.js:717-762`（`installUpdate` 只挡 `install.status === 'running'`）、`lib/client.js:1632-1649`（页脚两个按钮的 `disabled` 互不相关）
- **复现**：`.audit/client/f05-check-during-install.mjs`，命令 `node .audit/client/f05-check-during-install.mjs`
- **实际**：
  ```
  安装进行中：install.status=running
  「检查更新」按钮 disabled = false
  「更新中…」按钮 disabled = true
  before: list,checkUpdate,memories,applyUpdate
  after : list,checkUpdate,memories,applyUpdate,checkUpdate
  安装未完成时又发出了 checkUpdate = true
  ```
- **期望**：安装运行期间「检查更新」应禁用（或 `checkUpdate()` 在 `install.status === 'running'` 时直接返回并说明原因）。宿主侧 `applyUpdate` 会 `await updateInFlight`（`lib/index.js:2940-2948`），但 `checkUpdate` **不会**等 `applyInFlight` —— 反过来就会并发。
- **影响**：`git pull --ff-only` 和 `git fetch` 同时操作同一个 `.git`，常见结果是 `index.lock` 存在 / 更新失败；用户刚点完安装，随手再点一下「检查更新」就可能把安装搞失败。
- **建议修法**：两个按钮共享一个 `busy`：安装 running 时禁用检查；`checkUpdate()` 加 `install.status === 'running'` 守卫（并给一行「正在安装，稍后再查」）。
- **备注**：`lib/index.js:2819-2822` 的注释只处理了「check 在飞 → apply 等它」，没有处理反方向。

### F-CL-06 设置页两个 tab 键盘不可达：非选中 tab `tabIndex=-1`，全树没有方向键处理器
- **严重度**：medium
- **位置**：`lib/client.js:1671-1683`（`tabButton` 只给 `onClick`，`tabIndex: tab === id ? 0 : -1`）
- **复现**：`.audit/client/f06-tabs-keyboard.mjs`，命令 `node .audit/client/f06-tabs-keyboard.mjs`
- **实际**：
  ```
  "我的记忆": aria-selected=true tabIndex=0 onKeyDown=undefined
  "设置": aria-selected=false tabIndex=-1 onKeyDown=undefined
  整棵设置树上的 onKeyDown 数量 = 0
  tablist 上有 onKeyDown = false
  ```
- **期望**：WAI-ARIA tabs 模式：选中项 `tabIndex=0`，其余 `-1`，但要用 `ArrowLeft/ArrowRight/Home/End` 在 tab 间移动焦点并切换；或者直接用官方 `SegmentedTabs`。
- **影响**：只用键盘的用户按 Tab 只能落在「我的记忆」，**永远无法用键盘进入「设置」栏**（那一栏的开关、模型、页脚都够不到）。这与 2026-11-24 专门为「不用一路下拉」做的分栏目标相悖。
- **建议修法**：给 `tablist` 加 keydown（左右/Home/End），切换后把焦点移到新 tab 或对应 `tabpanel`；或复用官方的 tab 组件。
- **备注**：视觉与 `aria-selected` 都正确，测试也只验证了「可点」，所以现有 50 条客户端测试抓不到。

### F-CL-07 提炼进行中再点另一行「提炼成技能」：那一行被静默摘掉且永远不会再出现
- **严重度**：medium
- **位置**：`lib/client.js:2925-2930`（点击先 `unpinRow(group.key)`，再 `void props.distill(...)`）、`lib/client.js:2375-2377`（`distill` 的 busy 守卫直接返回 `{ok:false}`）、`lib/client.js:2789-2792`（`unpinRow`）
- **复现**：`.audit/client/f07-distill-rapid-click.mjs`，命令 `node .audit/client/f07-distill-rapid-click.mjs`
- **实际**：
  ```
  卡片上的「提炼成技能」按钮数 = 2
  第一行点击后 draftBusy={"kind":"distill","key":"k1","title":"第一组：部署流程"}
  markSeen 记录 = [["markSeen",["k1","k2"]]]
  distill 实际打到宿主 = [["distill","k1"]]
  重渲染后卡片是否还有第二组： false
  快照里还有没有待提炼的第二组： []
  ```
- **期望**：`distill` 返回 `{ok:false, error:'已经有一个提炼/安装动作在跑'}` 时，界面要么把第二行放回去并显示原因，要么在 busy 时禁用所有「提炼」按钮，绝不能先 `unpinRow` 再被拒绝。
- **影响**：`suggestMax` 调到 >1 时（用户明确可以配置），提炼一次要几十秒；用户在这期间点第二行，第二组被 `unpinRow` 摘掉、没有发 `distill`，而这张卡可见时已把 `k2` 一起 `markSeen` —— 下一轮 `list` 不会再给这一组，用户永远看不到它。属于「静默丢一组建议」。
- **建议修法**：不要先 `unpinRow`；先 `await props.distill`，按返回值决定是否摘行；busy 时给按钮 `disabled` 并在卡片上说明「正在提炼，请稍等」；失败时把行放回去。
- **备注**：默认 `skill.suggestMax=1`，所以是配置 >1 的路径；但 busy 持续时间是「几十秒」，点第二行很自然。

### F-CL-08 提炼 / 安装是一次性闩锁：没有超时、没有取消，宿主不 settle 就永远卡住
- **严重度**：medium
- **位置**：`lib/client.js:2375-2423`（`distill` 全程只等 `this.call('distill', key)`，没有 `setTimeout` / `Abort`）、`lib/client.js:2436-2456`（`draftAction` 同）、`lib/client.js:2377` 与 `2437`（`draftBusy !== null` 守卫）
- **复现**：`.audit/client/f08-distill-no-timeout.mjs`，命令 `node .audit/client/f08-distill-no-timeout.mjs`
- **实际**：
  ```
  点击后立即：draftBusy={"kind":"distill","key":"k1","title":"部署要走 scripts/deploy.sh"}
  3 秒后：draftBusy={"kind":"distill","key":"k1","title":"部署要走 scripts/deploy.sh"} error=null
  再点另一组：{"ok":false,"error":"已经有一个提炼/安装动作在跑"}
  装草稿也一起被挡住：{"ok":false,"error":"已经有一个提炼/安装动作在跑"}
  卡片仍在显示进行中： true
  ```
- **期望**：界面动作要有客户端兜底（例如 90 秒超时后清掉 `draftBusy` 并显示「这次提炼超时，可重试」）；或者提供取消。至少不能在卡住时连「装/丢」也被同一把闩锁挡住。
- **影响**：`distill` 会调模型（正常也要几十秒）；宿主/网关一旦不返回（本项目缺陷 28/29 就是这类挂死），`draftBusy` 永远非空：卡片一直显示「正在把…写成技能」，所有提炼/装/丢都返回 busy，只能刷新页面。`dsh-api-gateway` 的远程调用没有请求超时（只看到 AbortController 用于流取消，没有 invoke 级 timeout），所以这不是理论情况。
- **建议修法**：给 `distill` / `draftAction` 加客户端超时（并 `try/finally` 清 `draftBusy`），超时后显示原始原因；装/丢的状态机不要和提炼共用一把不可超时的闩锁。
- **备注**：`SuggestionFeed` 的 `load()` 重试有无限预算（设计），但动作不是重试而是**永久 busy**，两者语义不同。

### F-CL-09 一个模型都没有时，设置页横幅仍显示绿色「记忆学习已开启」
- **严重度**：medium
- **位置**：`lib/client.js:931-935`（`learningTone` 只看 `enabled` 与 `follow`/`model`，不检查模型目录）、`lib/client.js:937-1002`（横幅没有 catalog 入参）、`lib/client.js:471-487`（`projection` 已经带 `catalog`，但没传给横幅）
- **复现**：`.audit/client/f09-banner-no-model.mjs`，命令 `node .audit/client/f09-banner-no-model.mjs`
- **实际**：
  ```
  横幅 data-tone = ready
  横幅文案 = 记忆学习已开启 模型来源：跟随对话模型（对话框里选的那个）；新记忆以「先确认」落盘。…
  模型目录 groups = 0 status = ready
  页面里出现「没有可用模型」= false
  页面里出现「记忆学习已开启」= true
  ```
- **期望**：`catalog.groups.length === 0`（或 `catalog.default === null`）且 `enabled === true` 时应进 `partial` 档，标题写「已开启，但还没有可用的模型 —— 学习不会发生」，并给出「跟随对话模型 / 去配模型」的动作。
- **影响**：新装/没配 provider 的部署里，设置页最上方是绿色「已开启」，但抽取每轮都会在宿主侧失败；用户会以为已经在学习。项目文档把「开了但没选到模型 = 可见故障」列为一等公民，这一档恰恰没显示。
- **建议修法**：`learningTone(state)` 增加 catalog 判断（`state.catalog.status === 'ready' && state.catalog.groups.length === 0` → partial）；横幅文案与动作复用现有的 `learnNoModel*`。
- **备注**：`follow=true` 时模型选择器被 `visibleFields` 隐藏（`lib/client.js:1023-1035`），页面上没有任何其它地方提示「没有模型」。

### F-CL-10 英文 locale 的 `panelHint` 与中文相反：说溢出 P0「not injected」，实际仍可能从相关召回进来
- **严重度**：low
- **位置**：`lib/client.js:3346`（`en.panelHint`）对比 `lib/client.js:3192`（`zh.panelHint`）
- **复现**：`.audit/client/f10-en-panelhint-false.mjs`，命令 `node .audit/client/f10-en-panelhint-false.mjs`
- **实际**：
  ```
  zh.panelHint = … 超出的仍标着 P0，但**不再固定排在开头** —— 它们还能从相关召回里被选中（P0 有词法豁免，零匹配也有底分），只是不保证在场。…
  en.panelHint = … extra P0 entries keep the tag but are **not** injected. …
  英文里出现 “not injected” = true
  中文里出现「仍可能被召回」= true
  → 同一事实两份文案相反 = true
  ```
- **期望**：英文改成「no longer guaranteed at the top of every turn; may still be picked by relevant recall」，与中文、`panelOverflow` 和 spec §记忆面板 ④ 的更正一致。
- **影响**：英文用户在面板底部读到「超出上限的 P0 不会被注入」，会以为置顶名额外的记忆彻底失效；中文用户看到的是正确答案 —— 同一产品两种结论。
- **建议修法**：同步英文文案；最好把这段「溢出仍可能召回」做成一个共享的字符串常量，两个 locale 都引用。
- **备注**：这是 spec 明确要求「文案不许出现『注入里看不到』」的英文漏网（中文已改，英文没改）。

### F-CL-11 记忆面板行元信息把内部枚举原样拼进中文，且 `**` 在纯文本里原样显示
- **严重度**：low
- **位置**：`lib/client.js:1337-1345`（`panelRowMeta` 直接传 `row.scope` / `row.kind`）、`lib/client.js:3180`（模板 `'{scope} · {kind} · 更新于 {updated} · 被召回 {recalled} 次'`）、`lib/client.js:3192`（`panelHint` 里的 `**…**`）
- **复现**：`.audit/client/f11-panel-raw-enums.mjs`，命令 `node .audit/client/f11-panel-raw-enums.mjs`
- **实际**：
  ```
  行元信息 = workspace · fact · 更新于 2026-11-01 · 被召回 2 次
  原样出现 workspace = true，原样出现 fact = true
  筛选下拉里却写着「本工作区 / 跟人走（跨工作区）」= true
  文案里 Markdown 星号原样显示（**…**）= true
  ```
- **期望**：行里的 scope / kind 用与筛选下拉一致的本地化标签（本工作区 / 跟人走 / 全局共享；事实 / 经验 / 技能…）；`**` 要么用真正渲染 Markdown 的组件，要么去掉。
- **影响**：中文界面里突然出现 `workspace · fact`，用户不知道这两个词是什么；同一页的筛选下拉却是中文，认知不一致。底部提示和溢出提示里的 `**` 星号也会原样显示，看起来很粗糙。
- **建议修法**：`panelRowMeta` 用 `scopeLabel(scope)` / `kindLabel(kind)` 映射（与 `panelScope*` 字典共用）；文案去掉 Markdown 标记或改用 `<strong>`。
- **备注**：`panelHint` 还把可配置的 `lifecycle.p1Days` 写死为「30 天」；用户改 `lifecycle.p1Days` 后文案不跟随。

### F-CL-12 待确认的技能草稿是全局的：在会话 A 提炼后，会话 B 的最后一回合也弹出同一张草稿卡
- **严重度**：medium
- **位置**：`lib/client.js:2873-2876`（`drafts = state.drafts` 直接渲染，没有 session 过滤/钉住）、`lib/client.js:2862`（只有候选行用 `sessionId:turn` 的 `pinKey`）
- **复现**：`.audit/client/f12-draft-cross-session.mjs`，命令 `node .audit/client/f12-draft-cross-session.mjs`
- **实际**：
  ```
  会话 A 的最后一回合是否显示草稿卡：true
  会话 B 的最后一回合是否显示同一份草稿：true
  A 里看到的文案 =  刚写好的技能，先看看再决定收不收 draft-x 以后遇到「部署时用」的时候会用上 它以后就照着下面这段内容做事： --- name: draft-x ---
  ```
- **期望**：草稿卡要么只出现在产生它的那个会话（把 `sessionId` 也钉进草稿的展示条件），要么明确做成一个「待确认技能」的全局入口，而不是让 `SKILL.md` 正文在每个对话底部重复出现。
- **影响**：用户点一次「提炼成技能」后，切到任何其它对话（最后一回合）都会看到同一张草稿卡，包含技能原文；这正是用户之前抱怨「切换对话频繁出现卡片」的同类体验（缺陷 41 只修了候选行，没修草稿）。在多会话/多窗口下还会让用户以为每个对话都各自提炼了一份。
- **建议修法**：草稿卡按 `sessionId` 过滤（与 `pinKey` 同源），或把「待确认技能」收进设置页/一个固定位置；如果产品决定全局展示，至少在卡片标题里写「这是全局待确认技能，不是本对话的」。
- **备注**：`pendingSkills` 的真源在磁盘（设计如此，刷新后还在），但「显示在哪个会话」是纯呈现决策，代码注释没有说明它必须是全局的。

### F-CL-13 跟随对话模型 + fallback 时，字段顺序/标签自相矛盾：「上面那个模型」指的是降级模型本身
- **严重度**：low
- **位置**：`lib/client.js:261-271`（`onUnavailable` 的 label 固定为「上面那个模型不可用时」）、`lib/client.js:1018-1053`（`visibleFields` 在 follow + fallback 时把 `model` 改名并挪到 `fallback` 组，排在 `onUnavailable` 之前）
- **复现**：`.audit/client/f13-follow-fallback-labels.mjs`，命令 `node .audit/client/f13-follow-fallback-labels.mjs`
- **实际**：
  ```
  字段顺序：
    3. 降级模型（主模型不可用时）
    4. 上面那个模型不可用时
    5. 抽到候选后怎么落盘
  「上面那个模型不可用时」出现在「降级模型（主模型不可用时）」之后 = true
  ```
- **期望**：follow + fallback 时，策略选择应排在降级模型之前，label 改成「对话模型不可用时」（或「主模型不可用时」），不要用「上面那个」这种依赖视觉位置的措辞。
- **影响**：用户按字面理解会以为「上面那个模型」是刚选的降级模型，于是把降级模型理解成主模型；配置语义被绕晕。
- **建议修法**：在 `visibleFields` 里同时改 label（`'对话模型不可用时'`），并把 `onUnavailable` 排到 `model` 之前（或者把策略选择放在组头）。
- **备注**：这是纯文案/顺序问题，不改保存路径；但设置页是用户唯一能改这些值的地方。

## 未能证实（可疑但没复现出来）

1. **`MemfuseConfigCardView` 在 `view === 'summary'` 时提前 return，位于 hooks 之前**（`lib/client.js:1456-1471`）。如果某个宿主的同一组件实例先从 `summary` 渲染、再切到 `page`，React 会报 "Rendered more hooks than during the previous render"。实际 DSH 的 `plugins.row.config` 用**两个独立的 SlotOutlet**（summary 在详情头部 `<p>`、page 在详情区 `<section>`，见 `dsh-client-ui-plugin-manager/lib/client.js` 的 `RowDetail`），不会在同一实例上切换，所以没有真机复现。**建议**：把 summary 判断放到一个包装组件，或把 hooks 移到无条件分支之上。
2. **`MemfuseSuggestionCard` 的 `props.useChat ? props.useChat(...) : true`**（`lib/client.js:2841-2851`）是条件 hook。真宿主始终提供 `useChat`（session-scope 标准 hook），预览始终不提供，实例内稳定；没有复现。
3. **记忆面板搜索框是服务端回显的受控输入**：`value={view.filters?.query}`，而 `onChange` 发请求、`view` 要等 RPC 回来才更新。宿主慢时快速输入可能丢字符（React 会用旧 value 覆盖 DOM）。没有真实 React/DOM 环境复现，故不列为 finding。
4. **`SuggestionFeed.touch()` 在 error 态每次渲染都绕过 1.5s 去抖并立刻 `list`**（`lib/client.js:2053-2068`）。单次渲染立即重拉是缺陷 26 的既定回归；但在一个高频渲染的聊天面板里，如果错误态下每次渲染都触发一次请求，可能形成请求放大。没有真实渲染节奏可复现（且现有测试明确要求「出错时渲染不吃去抖」），先记在这里。
5. **`apply()` 里 `ctx.inject(['typert','remote'], cb)` 如果服务永远不可用**，cordis 不会回调，`remoteMount.reason` 保持 null，设置页只会显示「正在读取记忆库…」，没有超时/错误。现有宿主都提供这两个服务，没有真机复现。
6. **三个入口同时挂载时固定 DOM id（`dsh-memfuse-tab-memory` 等）会重复**（`lib/client.js:1671-1734`）。当前 DSH 的设置页/插件页是互斥面板，未观察到同时挂载。若未来做分屏或同时显示两个入口，`aria-controls` 会指向错误面板。
7. **preview 偏差**：`docs/preview/preview.mjs` 的假宿主只有 9 个端点（没有 `memories` / `setPriority` / `revive`），也没有 `diagnostics`；`npm run preview` 只能验证候选卡片，无法验证设置页/记忆面板。`test/preview.test.mjs` 5 项全绿，候选卡片本身没发现显示偏差。这属于预览覆盖缺口，不是用户可见 bug。

## 建议补的回归测试

- F-CL-01：动作失败 → 渲染一次（触发成功 `list`）→ 错误仍在；「不用」失败时行不能被摘掉。
- F-CL-02：`memories` 首次失败、重试 3 次后，面板有「重试」按钮，点击会再发一次 `memories`；`ensureLoaded` 在 error 态不自动发请求。
- F-CL-03：`lifecycle=dormant` / `priority=P2` / `scope=user` 筛到 0 条时显示 `panelNoMatch`，不显示 `panelEmpty`。
- F-CL-04：`view.resident` 的 id 不在当前页 / 搜索过滤后，常驻区不能出现裸 `m_*` id。
- F-CL-05：`install.status==='running'` 时「检查更新」`disabled===true`，`checkUpdate()` 不发远程调用。
- F-CL-06：`tablist` 上 `ArrowRight` 从「我的记忆」切到「设置」，`ArrowLeft` 切回；焦点跟随。
- F-CL-07：两行候选时，busy 期间点第二行：不发 `distill`、但第二行仍在/显示「正在提炼，请稍等」，且 `markSeen` 不能把未处理的第二组永久吞掉。
- F-CL-08：`distill` 永不 settle 时，超过预算后 `draftBusy` 被清掉并显示超时；装/丢不被永久阻塞。
- F-CL-09：`catalog.groups=[]` + `enabled=true` + `follow=true` → 横幅 `data-tone="partial"`，不出现「记忆学习已开启」。
- F-CL-10：zh/en 的 `panelHint` 对「溢出 P0 仍可能被相关召回」表述一致（禁止英文出现 `not injected`）。
- F-CL-11：面板行元信息不出现 `workspace` / `fact` 裸枚举；文案里不出现 `**`。
- F-CL-12：草稿在会话 A 生成后，会话 B 的卡片不显示同一份草稿（或明确标注「全局待确认」）。
- F-CL-13：follow + fallback 时 label 顺序为「对话模型不可用时」→「降级模型」，不再出现「上面那个模型」。
