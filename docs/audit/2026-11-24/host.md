# 宿主契约与端点审计报告

## 概览

- 审计对象：`dsh-plugin-memfuse`（git `9b6d190`，工作树仅有 `docs/audit/` 未跟踪）。
- 基线：`npm test` → **188 项全绿**（plugin 110 + client 50 + preview 5 + smoke 23，`0 fail`）。
- 实际读过：
  - `lib/index.js`（全文件 4136 行，重点 `readState/writeState`、`withBudget/ready`、`apply()`、六个工具、`flushInjected`、`writeStatus`、`installRemoteHost` 调用点）
  - `lib/remote.js`、`lib/config.js`、`lib/update.js`、`lib/memory-view.js`、`lib/store.js`、`lib/paths.js`
  - `lib/client.js` 的 `FIELDS` / `WRITABLE_PATHS` / `remoteDescriptors()` / `MemoryPanelFeed` 参数顺序
  - `docs/spec.md`（远程通道、记忆面板、缺陷 17/19/21/28/29/34 相关节）、`docs/NEXT.md` 顶部 200 行、`docs/HANDOFF.md`、`docs/audit/2026-11-24/BRIEF.md`
  - 宿主源码（不是猜）：`dsh-api-gateway/lib/index.js`（`assertExactArguments` L1776-1787、`validateArguments` L1796-1820、`resolveParameter` L1226/L1353）、`dsh-tools/lib/index.js:433-447`、`@deepseek-ai/cordis/lib/index.js:919-927`（`ctx.on` → `fiber.effect`）、`:1672`（`ctx.inject` 是子 plugin，依赖不满足时不回调）、`dsh-agent-loop/lib/index.js:324`（`session/event` 是普通 emit）、`:782`（pre-step waterfall）
- 实际执行过的命令：
  - `npm test`（基线，188 全绿）
  - `node .audit/host/f01-startup-fallback-wipe.mjs`
  - `node .audit/host/f02-state-write-race.mjs`
  - `node .audit/host/f03-remote-install-silent.mjs`
  - `node .audit/host/f04-state-corrupt-reset.mjs`
  - `node .audit/host/f05-checkupdate-revlist-silent.mjs`
  - `node .audit/host/f06-tool-register-status.mjs`
  - `node .audit/host/f07-panel-resident-count.mjs`
  - `node .audit/host/f08-status-read-silent.mjs`
  - `node .audit/host/verify-contracts.mjs`
- **finding 计数：blocker 1 / high 3 / medium 3 / low 1**。
- 已核对且**通过**的契约（不是 finding）：
  - `verify-contracts.mjs`：12 个端点与 `REMOTE_ENDPOINTS` 一一对应；每个参数 `source: 'json'` + `codec.mode: 'strict'`；`memories` 的参数顺序严格为 `query, priority, lifecycle, scope, page`；`createRemoteService` 的 12 个实现方法都在。
  - `verify-contracts.mjs`：6 个工具全部声明 `timeoutMs = 120000`，`output.schema.type = 'string'` 且有 `render`；内部预算 `EXTRACT_BUDGET_MS = 100000 < 120000`（缺陷 29 的嵌套关系仍成立）。
  - `lib/client.js` 的 `WRITABLE_PATHS` 与 `lib/config.js` 的 `.volatile()` 对应（`test/client.test.mjs:747` 的 188 项基线里通过；本报告未重复实现 worker）。
  - 监听器：`ctx.on` 在 cordis 里走 `fiber.effect`（L919-927），插件 fiber 释放会自动注销；`session/event` 是普通 emit（`dsh-agent-loop` L324），pre-step 是 waterfall 且 handler 明确 `return next()`（index.js:3955）。**未发现监听器泄漏**（详见「未能证实」）。

## 发现

### F-HOST-01 启动超预算后，一次普通注入把 state.json 整份覆盖成 `{runtimeFaults,lastInjection}`

- 严重度：**blocker**
- 位置：`lib/index.js:3069-3083`（`ready` 的 fallback `state: readyState ?? { runtimeFaults }`）、`lib/index.js:3817-3819`（`flushInjected` 用 `await ready` 得到的 state 直接 `writeState`）、`lib/index.js:3091-3098`（`startupExtraction` 同样拿 `r.state`）
- 复现：`.audit/host/f01-startup-fallback-wipe.mjs`，命令 `node .audit/host/f01-startup-fallback-wipe.mjs`（约 13 秒；把 `MemoryStore.prototype.init` 换成永不 resolve，其它全部真实代码）
- 实际：
  ```
  ready degraded after 12002ms (STARTUP_BUDGET_MS=12000)
  beforeKeys: ["version","extracted","skillSeen","skillDismissed","distillRequests","lastExtractSuccess","remoteChannel"]
  afterKeys:  ["runtimeFaults","lastInjection"]
  lostFields: ["version","extracted","skillSeen","skillDismissed","distillRequests","lastExtractSuccess"]
  ```
- 期望：启动初始化超时只应“降级放行”，**不能换掉 state 对象**；任何 `flushInjected` / 启动抽取都必须使用同一个从磁盘读出的 state（或明确跳过写入）。
- 影响：`store.init()` 恰好在 12 秒前卡住（网络盘、首次 `git init`、杀软扫描、慢机器）时，第一轮对话的 `flushInjected` 就把 `extracted` 水位线、`skillSeen`、`skillDismissed`、`distillRequests`、`lastExtractSuccess` 全部抹掉。用户会看到：
  - 已点过「不用」的技能建议重新出现；已“看过”的卡片再次弹；
  - 抽取水位线归零 → `auto` 模式会把历史会话再次抽成候选/记忆（重复写库）；
  - 启动抽取自己也拿 fallback state（`r.state`）写 `state.extracted`，进一步放大重复。
- 建议修法：`required` 的 fallback 不要造新对象：初始化未完成时用一个共享的 `state` holder（或 `await readState(store)` 后合并）；`flushInjected`/`runExtraction` 在 `initTask` 未完成时不要 `writeState`，并把“降级”留在 `runtimeFaults` 里。
- 备注：`STARTUP_BUDGET_MS` 本身是对的（缺陷 28 的修法）；问题只在超时分支的 state 身份。

### F-HOST-02 `writeState` 固定临时文件名 `.tmp`：并发写撞 rename，且两份 state 快照互相整份覆盖

- 严重度：**high**
- 位置：`lib/index.js:193-197`（`const tmp = `${store.root.state}.tmp`; writeFile; rename`）；对照 `lib/store.js:435` 的记忆文件写入用 `${p}.tmp-${process.pid}`
- 复现：`.audit/host/f02-state-write-race.mjs`，命令 `node .audit/host/f02-state-write-race.mjs`
- 实际：
  ```
  A. 300 concurrent pairs on one state: rejected=10, first=ENOENT ENOENT: no such file or directory, rename '...\.memory\state.json.tmp' -> '...\.memory\state.json'
  B. two state snapshots, 40 rounds: final skillSeen=0, skillDismissed=40
  finalKeys: ["version","skillDismissed"]
  ```
- 期望：并发状态写入必须串行化或至少每次用唯一临时文件；不同 state 快照不能无条件整份覆盖（应 lock + 读-改-写/合并）。
- 影响：
  - 用户快速连点两个界面动作（如卡片 `markSeen` 与「不用」），或卡片 `markSeen` 撞上每轮 `flushInjected` 时，会随机收到 `ENOENT ... state.json.tmp`，界面显示通道错误（卡片重试也可能因此抖动）。
  - `desktop` 和 `web` 两个 profile 共用 `~/.dsh/memory` 时就是两个进程各持一份 state → 后写者把先写者的 `skillSeen` / `skillDismissed` / `extracted` 覆盖掉；一个实例的 40 条 dismiss 记录可以把另一个实例的全部 seen 记录清成 0。
- 建议修法：`tmp` 加 `process.pid + random`；`writeState` 走 `store.locked()` 同款文件锁；跨进程采用 lockfile + 读盘合并（至少保留未知字段），不要用内存快照整份覆盖。
- 备注：B 场景在本脚本里用两个 state 对象模拟“两个实例”；同一进程里 F-HOST-01 的 fallback 真 state 也会形成两个对象，属于同一根因。

### F-HOST-03 `installRemoteHost` 在 typert 回调执行前就返回 `ok:true`；延迟注册失败被吞，status.md 仍写「✅ 12 个端点」

- 严重度：**high**
- 位置：`lib/remote.js:347-399`（`ctx.inject(['typert'], cb)` 后立即 `if (failure) ...; return {ok:true}`；`failure` 是回调里的局部变量）、`lib/index.js:3037-3041`（用 `remoteInstall.ok` 写 `state.remoteChannel = {endpoints: 12}`）、`lib/index.js:704-706`（status.md 的 Remote 行）
- 复现：`.audit/host/f03-remote-install-silent.mjs`，命令 `node .audit/host/f03-remote-install-silent.mjs`
- 实际：
  ```
  A. before typert callback: true dispose= function
  A. late callback threw outside? no (swallowed)
  B. inject calls: settings | llm | typert
  B. status line: - 界面通道（Remote）: ✅ 已装上（12 个端点；界面卡片读它）
  B. state.remoteChannel: {"endpoints":12}
  B. runtimeFaults: {}
  ```
  （B 用的是项目自己的 `fakeCtx` 语义：`ctx.inject` 的依赖未就绪时**不回调、不抛错**，与 cordis L1672 一致。）
- 期望：只有自校验真的跑完（12 个 `typert.local.get()` 都命中）才写 `ok:true` / `endpoints:12`；回调晚到或抛错时必须 `noteFault('remoteFail', ...)` 并写 `remoteChannel.failed`。
- 影响：宿主启动顺序变化、typert 服务晚到、插件 HMR 重载撞上 `typert.register()` 的 duplicate 拒绝时，界面通道实际是 0 个端点可路由，但 status.md/Block D 说「已装上（12 个端点）」、`runtimeFaults` 为空。表现就是用户最熟悉的「卡片永远不出现、哪里都没报错」。
- 建议修法：把 `installRemoteHost` 改成 `Promise<{ok, dispose}>`（或接收 `onResult` 回调），在真实回调里做自校验并 `noteFault`；`state.remoteChannel` 用 `Object.keys(REMOTE_ENDPOINTS).length`，不要硬编码 12。
- 备注：F-HOST-03 与项目此前的缺陷 15/18/28 同类；注释里已经写了“注册完立刻回读”，但回读在异步回调里，返回值没等它。

### F-HOST-04 state.json 写坏/形状不对时：静默整份重置；`null` 会让六个工具全部启动失败

- 严重度：**high**
- 位置：`lib/index.js:185-190`（`readState` 的 `catch { return {version:1,...} }`）、`lib/index.js:2763`（`state.extractEnabled = ...` 假定 state 是对象）、`lib/index.js:3049`（初始化末尾无条件 `writeState` 覆盖原文件）
- 复现：`.audit/host/f04-state-corrupt-reset.mjs`，命令 `node .audit/host/f04-state-corrupt-reset.mjs`
- 实际：
  ```
  A. state.json after ready: {"version":1,"lastExtractSuccess":null,"lastExtractError":null,...（原 extracted/skillSeen 全没了）
  A. runtime-fault section: "- 无"
  A. backups in .memory: []
  B. api.ready error: 记忆系统初始化失败：Cannot set properties of null (setting 'extractEnabled')（详见 status.md「运行期故障」）
  B. memfuse_status error: 同一条
  ```
- 期望：
  - `ENOENT`（首次启动）才走默认对象；
  - JSON parse 失败 / `null` / 数组 / 字符串等形状错误：先备份成 `state.json.corrupt.<时间戳>`，再 `noteFault('stateCorrupt', ...)` 并在 status.md/Block D 报出来；
  - 任何写入都要保留/合并旧字段，不能把历史记录静默清空。
- 影响：
  - 一次崩溃写坏、或用户按 `status.md` 的提示手工编辑 `state.json` 时改坏 JSON → 下一次启动无声重置，技能忽略/已看记录/抽取水位线全部丢；用户只会发现「怎么又弹卡片了 / 怎么又开始重复学」。
  - 若文件内容是合法 JSON 但不是对象（例如 `null`，或某些编辑器保存出的 `"..."`）→ `state.extractEnabled = ...` 抛 TypeError，`ready` reject，六个工具全部返回「记忆系统初始化失败」，必须手动删 `state.json` 才能恢复。
- 建议修法：`readState` 区分 `ENOENT` 与解析/形状错误；解析失败先 `rename` 成 `.corrupt.<ts>` 并记 fault；用 `isPlainObject` 校验；`writeState` 前 merge 已存在字段。
- 备注：docs/spec.md 缺陷 31 已经记录过“人工改 state.json 会被内存回写覆盖”，这里补的是**写坏后的恢复路径**，不是同一件事。

### F-HOST-05 `checkUpdate` 把 `git rev-list` 失败当成 `behind:0`，远端已有 0.2.0 仍显示「已是最新」

- 严重度：**medium**
- 位置：`lib/update.js:149-155`（`try { rev-list } catch { behind = 0 }`）、`lib/update.js:157-164`（`git show` 失败时 `latest = null`）、`lib/update.js:293-302`（`describeUpdate` 只看 `behind`）
- 复现：`.audit/host/f05-checkupdate-revlist-silent.mjs`，命令 `node .audit/host/f05-checkupdate-revlist-silent.mjs`
- 实际：
  ```
  case1 result: {"supported":true,"current":"0.1.0","latest":"0.2.0","behind":0}
  case1 describeUpdate: 已是最新（0.1.0 · abc1234def）
  case2 result: {"current":"0.1.0","latest":null,"behind":0}
  case2 describeUpdate: 已是最新（0.1.0 · abc1234def）
  ```
- 期望：`rev-list` 失败不能等价于“没有落后”；至少要返回 `error` / `behind: null`，并保留原始 git stderr；当 `latest !== current` 时不能写「已是最新」。
- 影响：远端 ref 没建出来（`git fetch origin <branch>` 不写 `refs/remotes/origin/<branch>` 的克隆 / 浅克隆 / 复制 `.git`）时，检查更新永远报“已是最新”，页脚不出现「安装更新」按钮，用户被永久钉在旧版本；这是“静默失效”而不是网络错误。
- 建议修法：`rev-list`/`show` 失败都带 `error` 返回；`describeUpdate` 先比较 `latest` 与 `current`，再退回 `behind`；原始 stderr 截断后展示。
- 备注：U2 用例已经覆盖“不是 git / 断网 / 超时都不许装成已是最新”，但**没覆盖 rev-list 成功前的 ref 缺失**。

### F-HOST-06 工具注册失败只在 `api.registerResults` 里，status.md / runtimeFaults 完全不提

- 严重度：**medium**
- 位置：`lib/index.js:1034-1048`（`registerTool` catch 只 `logger.warn`）、`lib/index.js:3746-3755`（注释承诺“结果会记进 status.md”）、`lib/index.js:559-743`（`writeStatus` 实际从不读 `results`）
- 复现：`.audit/host/f06-tool-register-status.mjs`，命令 `node .audit/host/f06-tool-register-status.mjs`
- 实际：
  ```
  registerResults: [{"ok":true,...},{"ok":true,...},{"ok":true,...},{"ok":true,...},{"ok":false,"reason":"duplicate tool name \"memfuse_extract\""},{"ok":true,...}]
  registered tools: memfuse_recall, memfuse_write, memfuse_status, memfuse_feedback, memfuse_skill
  status.md mentions: []
  status.md remote/tool section: - 无
  ```
- 期望：任一工具注册失败都要写 `runtimeFaults.registerFail`（含工具名与原始错误），并在 status.md 的「运行期故障」或「宿主探测」里列出；否则用户只会发现“某个工具用不了”。
- 影响：宿主升级改了 `tools.register` 的校验、同名插件冲突、或 HMR 重复注册时，插件“加载成功”但少一个工具，模型完全不知道 `memfuse_extract` 为什么不存在，用户也不会收到任何提示。
- 建议修法：`registerTool` 失败时 `noteFault(store.runtimeFaults, 'registerFail', ...)`；`writeStatus` 增加“工具注册”节，逐项列出 `api.registerResults`。
- 备注：`FAULT_LABEL` 里已经有 `registerFail`，但全项目没有一处 `noteFault(..., 'registerFail', ...)`。

### F-HOST-07 记忆面板 `stats.residentCount` 把休眠 P0 算进“常驻 N/cap”，和 `resident` 实际列表不一致

- 严重度：**medium**
- 位置：`lib/memory-view.js:118-151`（`computeStats` 用 `by.P0` 算 `residentCount` / `residentOverflow`；`resident()` 的判据是 `priority === 'P0' && lifecycle === 'active'`，见 `lib/recall.js:251`；注释 `memory-view.js:147-150` 自己写的是“P0 active 条数”）
- 复现：`.audit/host/f07-panel-resident-count.mjs`，命令 `node .audit/host/f07-panel-resident-count.mjs`
- 实际：
  ```json
  {"stats":{"byPriority":{"P0":2,...},"residentCount":2,"residentOverflow":0},
   "resident":["m_active_p0"],"overflow":[]}
  ```
  （一条 active P0 + 一条 dormant P0；面板说 2 条常驻，实际常驻 id 列表只有 1 条。）
- 期望：`residentCount` / `residentOverflow` 只统计 `priority === 'P0' && lifecycle === 'active'`；休眠的 P0 不应算进“本轮会被注入的常驻块”。
- 影响：用户打开「设置 → 记忆」看到「常驻 2/8」，以为两条都固定注入；实际有一条是休眠，永远进不了 Block A（只能被相关召回）。用户据此判断“我置顶了但怎么没用”，与面板 `explainRow` 的 dormant 说明自相矛盾。
- 建议修法：`computeStats` 维护 `activeP0` 计数（`isResident(rec)` 或 `lifecycle==='active' && priority==='P0'`），`residentCount/Overflow` 都用它；`byPriority` 可以继续表示全库总数。
- 备注：`buildView.resident` / `overflow` 本身是对的（用 `isResident` 过滤），所以这是纯展示统计 bug，不影响实际注入。

### F-HOST-08 status.md 的捕获/待确认统计把“读目录失败”渲染成「0 个（从未）」且不记故障

- 严重度：**low**
- 位置：`lib/index.js:568`（`listPending(...).catch(() => [])`）、`lib/index.js:572-579`（`readdir(sessions).catch(() => [])` + 每个文件 `readFile(...).catch(() => '')`）、`lib/index.js:685-686`（技能列表同样 `.catch(() => [])`）
- 复现：`.audit/host/f08-status-read-silent.mjs`，命令 `node .audit/host/f08-status-read-silent.mjs`
- 实际：
  ```
  before breakage: - 已捕获轮次: 1
  after breakage: - 已捕获轮次: 0（从未） | - 素材文件: 0 个
  after breakage runtimeFaults section: "- 无"
  ```
- 期望：`readdir` / `readFile` 失败时至少 `noteFault('captureFail' 或 'statusReadFail', ...)`，并在 status.md 写「统计读取失败：…」，而不是把它当成“没有素材”。
- 影响：磁盘权限、目录被误删/改名、杀软锁文件时，status.md 写「已捕获轮次: 0（从未）」「素材文件: 0」，用户会以为捕获功能从来没工作，实际是读不到；这是硬规则 4 明令禁止的“空数组等于没输入”模式。
- 建议修法：把三个 `.catch(() => [])` / `.catch(() => '')` 改成“记录 error 并写进 status 的统计行”；读文件失败只跳过该文件，但保留文件名与错误。
- 备注：`store.list()` 已经正确暴露 `lastListError`，status 的捕获/技能/队列三处应沿用同一模式。

## 未能证实（可疑但没复现出来）

1. **监听器泄漏**：核对 `@deepseek-ai/cordis` L919-927：`ctx.on()` 的注册走 `this.ctx.fiber.effect(...)`，插件 fiber 释放时会自动 unregister；`agent/pre-step` 是 waterfall 且 index.js:3955 有 `return next()`；`session/event` 在 `dsh-agent-loop` L324 是普通 emit。`captureSessions` 上限 32；`lastCapturedSeq` 每个 session 一条（随历史会话数增长，不是每次重载叠加）。**未发现可复现的监听器泄漏**。
2. **`writeStatus` 非原子写**：`lib/index.js:741` 直接 `fsp.writeFile(status)`；两个 `refreshStatusAfterUi` 或启动抽取的 `finally` 并发时，可能读到半截 status.md。没有稳定复现（`writeFile` 很小、时序难卡），列在这里而不是 finding。
3. **`applyUpdate` 在 pull 成功后 `rev-parse --short HEAD` 失败时把 `changed` 保守成 false**（`update.js:268-275`）：此时磁盘已是新版但界面说“没有变化”，用户不会重启。需要构造 `git pull` 成功且紧接着 `rev-parse` 失败的仓库，未复现；建议直接改成用 pull 的 `stdout`/`HEAD` 原子确认。
4. **`memfuse_skill action=distill` 的 `match` 找不到时会退回 `cands[0]`**（`index.js:1386-1390`）：模型传错标题时会在不报错的情况下提炼**另一组**记忆。需要真实模型/技能候选夹具，host 区域内未跑；建议改成 `match` 有值但未命中时返回 `{ok:false,error}`。
5. **`memfuse_write` 的 `mode` 默认值**：`execute` 里 `args.mode || 'add'`，但工具 schema 的 `required: ['mode']`（`verify-contracts.mjs` 打印 `["mode"]`）。如果宿主只把 `parameters` 交给模型、不做运行时校验，则只是文档不一致；如果宿主严格校验，模型省略 `mode` 会直接 INVALID_ARGS。宿主校验路径没在本机用真实 tool-call 复现，列在这里。
6. **`computeSuggestions` 全量 `catch { return [] }`**（`index.js:1201-1216`）：任何评分/数据形状异常都会静默让技能建议消失，没有 fault。没构造出触发条件，列在这里；与硬规则 4 同类。

## 建议补的回归测试

1. **启动超预算不覆盖 state**：`MemoryStore.prototype.init` 挂起 > `STARTUP_BUDGET_MS`，预置 `extracted/skillSeen/skillDismissed`，触发一次注入 + `flushInjected`，断言 `state.json` 仍是同一份 state（F-HOST-01）。
2. **state 并发写**：同一 store 上并发 `markSuggestionsSeen` + `dismissSuggestion` 300 轮，断言 0 个 ENOENT、`skillSeen`/`skillDismissed` 都完整；两个 state 快照并发时断言不会二选一丢字段（F-HOST-02）。
3. **Remote 延迟注册**：`ctx.inject(['typert'], cb)` 先不回调，断言 `installRemoteHost` 不返回 `ok:true`（或返回 pending）；回调里 `register` 抛错时 `runtimeFaults.remoteFail` 有值、status.md 写「未装上」（F-HOST-03）。
4. **state 损坏恢复**：分别写 truncated JSON / `null` / `[]`，断言备份文件存在、`runtimeFaults.stateCorrupt` 有值、`ready` 不 reject（或给出可读错误），且原有字段不丢（F-HOST-04）。
5. **checkUpdate ref 缺失**：`rev-list`/`git show` 失败但 `latest` 可读时，`describeUpdate` 不许出现「已是最新」；`behind` 不能默认为 0（F-HOST-05）。
6. **工具注册失败可见**：`failTool` 让一个工具注册抛错，断言 status.md / runtimeFaults 里有工具名和原始错误（F-HOST-06）。
7. **面板常驻统计**：一条 active P0 + 一条 dormant P0，断言 `stats.residentCount === 1` 且等于 `view.resident.length`（F-HOST-07）。
8. **status 读目录失败**：把 `sessions` 换成普通文件 / 无权限目录，断言 status.md 写「读取失败」而不是「0 个（从未）」（F-HOST-08）。
