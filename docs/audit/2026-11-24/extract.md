# 抽取 / 提炼 / 建议流水线审计报告

审计日期：2026-11-24（Asia/Shanghai）
仓库：`<REPO_DIR>`（只读审计，未改 `lib/` / `test/` / `package.json` / `docs/spec.md` / `docs/NEXT.md` / `AGENTS.md`）
审计人：audit-extract

## 概览

- 读了：`lib/extract.js`、`lib/distill.js`、`lib/skill.js`、`lib/suggestion-status.js`、`lib/policy.js`、`lib/queue.js`、`lib/inject.js`，以及 `lib/index.js` 中抽取（1850–2635）、技能/建议（1183–1530、2820–3036、3470–3745）、启动（3040–3124、3769–4055）、状态（390–743）相关段落；对照了 `docs/spec.md` 缺陷 29/35/38/40/41 与 `docs/NEXT.md` 顶部、`docs/audit/2026-11-24/BRIEF.md`。
- 基线：`node --version` → `v22.22.0`；`npm test` → **110 + 50 + 5 + 23 = 188 项全绿**（plugin 110 / client 50 / preview 5 / smoke 23）。
- 复现脚本：`.audit/extract/f01-skip-silent.mjs` … `f19-empty-array-prose.mjs`，全部在 `os.tmpdir()` 的临时 `DSH_HOME` 下跑，不碰真实 `~/.dsh`。统一用 `node .audit/extract/<script>` 执行；所有脚本的断言都是"期望的正确行为"，因此**当前失败（exit 1）即代表复现成功**。
- finding 计数：**blocker 0 / high 5 / medium 8 / low 6（共 19）**。
- 实际执行过的命令清单：

```text
node --version
npm test
node .audit/extract/f01-skip-silent.mjs
node .audit/extract/f02-admission-silent.mjs
node .audit/extract/f03-parse-brackets.mjs
node .audit/extract/f04-match-fallback.mjs
node .audit/extract/f05-pending-overwrite.mjs
node .audit/extract/f06-fresh-boundary.mjs
node .audit/extract/f07-state-write-race.mjs
node .audit/extract/f08-skill-write-race.mjs
node .audit/extract/f09-maxretries-noop.mjs
node .audit/extract/f10-skill-bytes.mjs
node .audit/extract/f11-state-corruption.mjs
node .audit/extract/f12-extract-concurrency.mjs
node .audit/extract/f13-force-cooldown.mjs
node .audit/extract/f14-approve-broken.mjs
node .audit/extract/f15-skill-parse-roundtrip.mjs
node .audit/extract/f16-drain-cancel.mjs
node .audit/extract/f17-truncation-hint.mjs
node .audit/extract/f18-salvage-empty-object.mjs
node .audit/extract/f19-empty-array-prose.mjs
```

> 说明：脚本里的 `fNN` 编号与报告里的 `F-EX-NN` 一一对应（f01 → F-EX-01，…，f19 → F-EX-19）。`f01` 同时固定了 F-EX-01 的三个子问题（跳过配置、跳过记录、假成功）。

## 发现

### F-EX-01 跳过的抽取段从不落 `state.skippedSegments`，而且这一轮还报"成功"（同时 `skipAfterFailures: 0` 也失效）
- 严重度：**high**
- 位置：`lib/index.js:2388`（`skippedSegments` 只是局部数组）、`:2517-2554`（跳过分支）、`:2631`（只作为返回值）、`:720`（`writeStatus` 读 `state.skippedSegments`）；`lib/index.js:2393` + `lib/config.js:80-82`（`skipAfterFailures: 0` 的语义）。
- 复现：`.audit/extract/f01-skip-silent.mjs`，命令 `node .audit/extract/f01-skip-silent.mjs`
- 实际（关键行）：
  ```json
  {"i":3,"ok":true,"files":1,"candidates":0,"errors":[],"skippedSegments":[{"file":"2026-11-01.md","start":0,"end":100,"failCount":3}]}
  {"watermark":{"2026-11-01.md":100},"hasSkippedSegments":false,"statusHasSkippedSection":false}
  {"usageSkipRecords":[{"type":"extract-skip","file":"2026-11-01.md","start":100,"end":100,"failCount":3}]}
  ```
  配置里写的是 `skipAfterFailures: 0`（按 `config.js` 描述 = "设为 0 则不跳过"），但第 3 次内容失败后仍然发生了跳过。
- 期望：
  1. `0` 必须表示永不跳过（或删掉这条文案/配置项，不能默默按 3 处理）；
  2. 每次跳过要写进持久状态（`state.skippedSegments` 追加并裁剪），`status.md` 的「跳过的段」章节真正出现；
  3. 跳过整段内容时这一轮不能被 `ok:true` + `lastExtractSuccess` 伪装成成功，至少要在 errors/status 里明确列出被跳过的段；
  4. `extract-skip` 的 `start` 必须是跳过段原来的起点，而不是被 `pos = end` 覆盖后的 `end`（现在日志也打成 `[100-100]`）。
- 影响：用户在 `status.md` 看到「最近成功 / 健康 ✅」，实际上这一段的会话内容永远不会被抽取；`skippedSegments` 只在一次工具返回值里出现，重启后无迹可查。跳过后水位线已被推过该段，正常路径不会重抽（只能手工改 `state.json`）。
- 建议修法：`runExtraction` 里维护 `state.skippedSegments = [...(state.skippedSegments||[]), ...skippedSegments].slice(-50)`（在 `writeState` 前）；`ok` 改成 `errors.length === 0 && skippedSegments.length === 0`（或单独 `skipped` 状态）；`appendUsage` 前先保存 `const segStart = pos`；`skipAfter = Number(ex.skipAfterFailures) === 0 ? Infinity : Math.max(1, ...)`。
- 备注：`status.md` 的读取代码（`:720-739`）本身已经写好了，说明这是漏写而不是设计。

### F-EX-02 准入把整批候选静默丢掉时，抽取仍算成功并推进水位线
- 严重度：**high**
- 位置：`lib/extract.js:177-215`（`normalize`/`classify` 丢弃后没有计数），`lib/policy.js:184-198`（缺 `durability` / `evidence` / `body` 即返回 `null`），`lib/index.js:2563-2592`（`res.candidates` 为空也继续推进）。
- 复现：`.audit/extract/f02-admission-silent.mjs`，命令 `node .audit/extract/f02-admission-silent.mjs`
- 实际（关键行）：
  ```text
  extractCandidates → {"candidates":0,"error":null}
  {"res":{"ok":true,"files":1,"candidates":0,"errors":[]},"lastExtractSuccess":"2026-11-24T05:10:38.071Z","lastExtractError":null,"watermark":{"2026-11-02.md":177},"statusHealthy":true}
  ```
  模型返回的是两条语义完整的候选（`title/summary/body/anchor` 都有），只是漏了 `durability/evidence`；`normalize` 把它们全部判空，`extractCandidates` 返回 `error:null`，`runExtraction` 把它当正常空结果。
- 期望：输入解析出非空数组但 **0 条通过准入**时，必须留下"丢弃了多少条 / 为什么"的可见证据（error/fault/status 计数至少有一个），并且不能把这一段标成成功、不能推进水位线到模型已看过但没被采纳的内容末尾。
- 影响：真实模型经常漏可选字段；整批内容被静默丢弃，用户只看到"抽取成功"、状态"健康 ✅"，下一轮也不会再抽这一段。这是典型的"功能存在但从不生效"。
- 建议修法：`extractCandidates` 统计 `droppedInvalid` / `droppedByReason`，与 `droppedThreat` 一起返回；`runExtraction` 在 `parsed.length > 0 && candidates.length === 0 && dropped > 0` 时记 `lastExtractError`（或单独的 `lastExtractDropped`），并让 `status.md` 显示。`policy.normalize` 的必填字段是否应该这么严，也值得产品决策（至少 `durability/evidence` 可用默认值 + 标记，而不是整条丢）。
- 备注：`droppedThreat` 已有计数，但 `runExtraction` 同样完全没消费（凭据被丢弃也不可见）；同属"准入无审计"。

### F-EX-03 启动抽取与手动 `memfuse_extract` 没有互斥，同一段会话会被抽两遍、候选重复入队
- 严重度：**high**
- 位置：`lib/index.js:3091-3124`（`startupExtraction` fire-and-forget）、`:2306`（`runExtraction` 没有单飞/锁）、`:2381`（两个调用共享同一个 `state.extracted` 引用）。
- 复现：`.audit/extract/f12-extract-concurrency.mjs`，命令 `node .audit/extract/f12-extract-concurrency.mjs`
- 实际（关键行）：
  ```json
  {"modelCalls":2,"manualRes":{"ok":true,"files":1,"candidates":1},"pendingCount":2,"pendingTitles":["部署入口","部署入口"],"watermark":{"2026-11-04.md":277}}
  ```
- 期望：同一段会话同一水位线只调用一次模型；启动抽取正在跑时，手动调用应等待/复用它，或至少按水位线互斥。
- 影响：`suggest` 模式下待确认队列出现重复候选（用户可能两条都批准 → 重复记忆）；`auto` 模式直接写入两条重复记忆；同时多烧一次模型调用。启动抽取每次启动都会自动跑，用户在这段时间里说"把这几天的对话整理成记忆"就会撞上。
- 建议修法：模块级 `runExtraction` 单飞（`if (extractInFlight) return extractInFlight`，或按文件/段加互斥）；`state.extracted` 的读改写放进 `store.locked` 或内存锁；至少给启动抽取一个 `startupExtraction` 可等待句柄并在工具入口 await 它。
- 备注：现有测试只验证了串行两次 `runExtraction`，没有覆盖并发。

### F-EX-04 `writeState` 用固定临时文件名 `<state>.tmp`，并发状态写会 ENOENT / 丢动作
- 严重度：**high**
- 位置：`lib/index.js:193-197`（`writeState`）、`lib/index.js:1238-1274`（`markSuggestionsSeen` / `dismissSuggestion`）、`:3800-3824`（每轮 `flushInjected` 写 state）、`:2623`（抽取结束写 state）。
- 复现：`.audit/extract/f07-state-write-race.mjs`，命令 `node .audit/extract/f07-state-write-race.mjs`
- 实际（关键行）：
  ```json
  {"iterations":200,"stateBytes":24052,"rejectedBatches":8,"rejectionCodes":{"ENOENT":8},"seenKeys":200,"dismissedKeys":101}
  ```
  每个并发批是 `markSuggestionsSeen` + `dismissSuggestion`；8/200 次的其中一个动作以 `ENOENT: rename state.json.tmp -> state.json` 失败（不同运行 2–11 次/200）。
- 期望：状态写必须是并发安全的：唯一 tmp 名（`state.json.tmp-<pid>-<counter/random>`）或串行队列/锁；任何一方都不该因为另一方写状态而失败。
- 影响：界面动作（卡片记 seen / 点不用 / 提炼落定）会直接报错；更隐蔽的是抽取结束的 `writeState` 失败会让水位线没落盘 → 下次启动重抽；`flushInjected` 的失败只进 `logger.warn`，用户看不到。真实并发对很多：`markSeen` + `dismiss`、`distill` + `markSeen`、启动抽取 + 每轮 pre-step 的 `flushInjected`。
- 建议修法：`writeState` 的 tmp 名加 `process.pid + 单调计数器`，并用一个小型 `stateWriteQueue` 串行化；或让所有 state 写走 `store.locked`（注意锁不可重入，抽取内部已在锁内时不要重复加）。
- 备注：`store.write` 的 tmp 名是 `${p}.tmp-${process.pid}`，同一条记忆被两个会话同时 `touchMemory` 时也有同类风险；建议一起修。

### F-EX-05 `distillCluster` 的 `match` 命中不了时静默回退到"分数最高的候选"——用户要 A，写出来的是 B
- 严重度：**high**
- 位置：`lib/index.js:1356-1390`（`const pick = bySeed ? ... : (match && cands.find(...)) || cands[0]`）。
- 复现：`.audit/extract/f04-match-fallback.mjs`，命令 `node .audit/extract/f04-match-fallback.mjs`
- 实际（关键行）：
  ```json
  {"match":"完全不存在的标题","res":{"ok":true,"name":"made-skill","cluster":["新候选"]}}
  ```
  另一个同名的 `seedId` 不存在时也走 `|| cands[0]`，同样静默提炼别的簇。
- 期望：`match` / `seedId` 明确给了却找不到时，返回 `ok:false` + 说明（列出可用标题），绝不替换成另一个簇。
- 影响：模型/用户按 Block E 或记忆面板的标题传 `match`，标题只要差一个空格/标点，就会把完全不相干的记忆提炼成技能；如果用户接着点「装进技能库」，会把错误的技能装进全局技能库（技能是注入即生效的指令）。返回的 `ok:true` 让调用方无法察觉。
- 建议修法：`match` 非空且 `bySeed` 为 null 时直接返回错误；`seedId` 非空且找不到时同理；不要 `|| cands[0]`。`match` 可加 trim/大小写/规范化匹配，但匹配不到仍需报错。
- 备注：`memfuse_skill action=dismiss` 的 `match` 也有类似 `: cands[0]` 回退（`lib/index.js:3720-3730`）：用户传错 key 时会忽略"第一条"而不是报错；同源问题，建议一起修。

### F-EX-06 pending-skills 同名草稿会被静默覆盖（不同簇可能生成同一个 slug）
- 严重度：**medium**
- 位置：`lib/index.js:1416`（`writeSkill(pendingDir, res.name, res.content)`）、`lib/skill.js:117-125`（写 tmp + rename 到已存在目录，直接覆盖）、`lib/index.js:1426-1428`（`sources[res.name]` 覆盖）。
- 复现：`.audit/extract/f05-pending-overwrite.mjs`，命令 `node .audit/extract/f05-pending-overwrite.mjs`
- 实际（关键行）：
  ```json
  {"first":{"ok":true,"name":"deploy-flow","cluster":["Deploy Flow"]},"second":{"ok":true,"name":"deploy-flow","cluster":["deploy flow"]},"dirsAfterFirst":["deploy-flow"],"dirsAfterSecond":["deploy-flow"],"finalContentHasFirstDraft":false,"sources":{"deploy-flow":["m_case_b"]}}
  ```
  两个互不相关的簇（`Deploy Flow` / `deploy flow`，标题只差大小写）都走 `slugifySkillName` → 同名 `deploy-flow`；第二次把第一次的 SKILL.md 覆盖，`skill-sources.json` 也只留下第二簇的来源。
- 期望：pending 草稿按"簇身份"或至少按"名字 + 内容 hash"防覆盖；同名不同来源时要么报错要求改名，要么自动加后缀（`deploy-flow-2`），并在草稿里保留来源。
- 影响：用户还没审的第一份草稿直接消失；`derived-into` 反向标记错位；如果用户随后安装，装的是第二份（可能不是他想审的那份）。
- 建议修法：`distillCluster` 写 pending 前检查 `listSkills(pendingDir)` / `readSkill`，同名且内容不同时拒绝或改名；`writeSkill` 增加 `overwrite:false` 选项（默认拒绝已存在的 `SKILL.md`）。
- 备注：模型漏 `name` 时靠标题 slug 兜底（`distill.js:331`）放大了这个碰撞概率；中文标题因带 id hash 反而较少撞。

### F-EX-07 `writeSkill` 的 tmp 文件名只带 pid，同名并发写入会 ENOENT
- 严重度：**low**
- 位置：`lib/skill.js:121-123`（`const tmp = ${file}.tmp-${process.pid}`）。
- 复现：`.audit/extract/f08-skill-write-race.mjs`，命令 `node .audit/extract/f08-skill-write-race.mjs`
- 实际（关键行）：
  ```json
  {"natural":{"iterations":120,"errors":{"ENOENT":7},"corruptedFiles":0},"patched":{"renameDelayedOnce":true,"firstError":"ENOENT"}}
  ```
  自然并发 7/120 次；把第一次 rename 延迟 50ms 后稳定复现 ENOENT。
- 期望：同名并发写不共用 tmp；失败也不该由文件名竞态造成。
- 影响：多标签页/双击「提炼」/工具与界面同时 distill 时，一次点击报 ENOENT；虽然 UI 有 `draftBusy` 单飞，但工具路径与界面路径没有共享这个锁。
- 建议修法：tmp 名加随机后缀或全局计数器；`writeSkill` 加进程内按 `name` 的队列。
- 备注：与 F-EX-06 同一模块，建议一起修（同一个"pending-skills 幂等/并发"问题域）。

### F-EX-08 已看过（seen）的组即使随后有 new content 也不会再弹；`freshSuggestions` 的"时间变新"分支实际不可达
- 严重度：**medium**
- 位置：`lib/suggestion-status.js:72-76`（先 `!seen[s.key] && !pending` 过滤，再调 `freshSuggestions`）、`:37-42`（`freshSuggestions` 自己的文档说"簇里最新一条的时间变新"也算新）。
- 复现：`.audit/extract/f06-fresh-boundary.mjs`，命令 `node .audit/extract/f06-fresh-boundary.mjs`
- 实际（关键行）：
  ```json
  {"scenario2":{"bUpdated":"2026-11-24T12:00:00.000Z","freshSuggestions":["B 组记忆"],"analyzeFresh":[],"status":"no_fresh","freshGroups":0,"seenGroups":2,"statusText":"当前技能建议已提醒或正在提炼，没有新的卡片"}}
  ```
  纯函数 `freshSuggestions` 认为 B 组该弹（12:00 的更新晚于全局水位 11:00），但 `analyzeSkillSuggestions` 先用 `seen[B.key]` 把 B 排除，`list` 端点和诊断都拿不到它。
- 期望：调用方应把 **全部未忽略组** 交给 `freshSuggestions`，由它按水位判断（或直接对 `seen[key]` 做"组时间 > 该组自己的 seen 时间"比较）；既然文档承诺"簇里最新一条的时间变新 → 重新提"，就不能在调用前把 seen 组全部滤掉。
- 影响：用户对某组点了「看过」之后，如果其中一条记忆被修正/更新（`memfuse_write replace`、面板改优先级等都会 bump `updated`），该组永久不再弹出；`status.md` 还会说"已提醒或正在提炼，没有新的卡片"——这与事实相反。
- 建议修法：`analyzeSkillSuggestions` 的 `fresh` 输入改为 `available`（只排除 `pending`，不排除 `seen`），`freshSuggestions` 内部按"组时间 > `skillSeen[key] ?? 全局水位`"判断；`diagnostics.freshGroups` 与 `list` 统一用这个结果。
- 备注：`f06` 的 `scenario1_globalWaterlineByDesign` 是 spec 的全局水位设计（B 的 10:30 更新早于 A 的 11:00 确认，不弹是对的），不要把它当 bug；真正的问题是 seen 过滤让 `freshSuggestions` 的时间分支失效。

### F-EX-09 `parseCandidates` 用首尾方括号切 JSON，模型在 JSON 前后写带 `[]` 的说明就整段解析失败
- 严重度：**medium**
- 位置：`lib/extract.js:72-84`（`indexOf('[')` / `lastIndexOf(']')`）。
- 复现：`.audit/extract/f03-parse-brackets.mjs`，命令 `node .audit/extract/f03-parse-brackets.mjs`
- 实际（关键行）：
  ```json
  {"JSON 前面有带方括号的说明":{"count":0},"JSON 后面有带方括号的说明":{"count":0},"围栏 + 前后说明":{"count":0},"正常围栏":{"count":1}}
  ```
  例如 `以下是结果（格式参考 [规范 v2]）：\n[{"kind":...}]` 或 `[...]\n共 1 条（详见 [附录]）`。
- 期望：允许 JSON 前后有解释性文字；先尝试围栏/直接 parse，再按"第一个 `[` 起的合法 JSON 数组"扫描，而不是盲取最后一个 `]`。
- 影响：模型返回了完全合法的候选数组，抽取报「无法解析为候选数组」；该段不推进，下一轮重试同样失败，最终按内容错误跳过（叠加 F-EX-01）。用户会误以为模型乱答/被截断。
- 建议修法：实现一个括号配对/逐字符扫描器（跳过字符串与转义），或先 `JSON.parse` 整段，再尝试围栏内容，再尝试从每个 `[` 起找可闭合的数组；不要把最后一个 `]` 当终点。
- 备注：`f17` 的误诊也来自同一条"结尾必须是 ]/}"启发式；`f19` 是空数组版本。

### F-EX-10 `extract.maxRetries` 是死配置：设置 5 次与 0 次行为完全一样
- 严重度：**medium**
- 位置：`lib/config.js:83-85`（配置描述"模型调用失败时的重试次数"）、`lib/index.js:128`（默认值）；全库 grep 只有定义/默认值，无读取点。
- 复现：`.audit/extract/f09-maxretries-noop.mjs`，命令 `node .audit/extract/f09-maxretries-noop.mjs`
- 实际（关键行）：
  ```json
  {"configuredMaxRetries":5,"modelCallAttempts":1,"res":{"ok":false,"errors":["2026-11-03.md[0-144]: 模型调用失败：HTTP 500 临时故障（第 1/3 次失败；再失败 2 次将跳过这一段）"]}}
  ```
- 期望：`maxRetries: 5` 时第一次临时失败应重试（至少对 `transient` / `rate_limit` 类）；或者删掉这个配置项，别让用户以为它能用。
- 影响：用户调大重试次数完全无效；一次 500/网络抖动直接失败，随后按 `skipAfterFailures` 累计并可能跳过内容。属于"设置页/配置里存在但从不生效"。
- 建议修法：在 `makeModelCaller` 里按 `cfg.extract.maxRetries` 对 `transient`/`rate_limit`/`budget` 之外的可重试错误做退避重试（注意与 `MODEL_CALL_TIMEOUT_MS` / `EXTRACT_BUDGET_MS` 的预算嵌套）；不打算实现就删掉字段和描述。
- 备注：`consolidateAfterHours` / `maxRawForConsolidation` 同样只有定义/默认值，疑似另一组死配置；本次未展开（不在抽取/技能的直接影响链上）。

### F-EX-11 冷却期里手动 `memfuse_extract` 被挡回：`force` 只有测试会传，真实入口从不传
- 严重度：**medium**
- 位置：`lib/index.js:2337`（`if (wasCooling && !opts.force)`）、`:2342`（日志写"如需立即重试，用 memfuse_extract 工具手动调用"）、`:3507-3553`（`memfuse_extract.execute` 的 `runOpts` 只有 deadline/signal，没有 `force`）。
- 复现：`.audit/extract/f13-force-cooldown.mjs`，命令 `node .audit/extract/f13-force-cooldown.mjs`
- 实际（关键行）：
  ```json
  {"firstRun":{"ok":false,"errors":["...429 rate limit exceeded"]},"cooldownAfterFirst":{"kind":"rate_limit","until":"2026-11-24T05:20:41.454Z"},"manualToolCall":{"ok":false,"cooling":true,"reason":"抽取暂停到 2026/11/24 13:20:41（限流）"},"forcedApiRun":{"ok":true,"cooldownBypassed":true}}
  ```
- 期望：工具入口应把 `force: true` 传下去（或冷却期工具调用明确提示"需要重启/等 X 分钟"，不要写"手动调用可立即重试"）；`cooldownBypassed` 字段既然存在，就应该有真实入口使用它。
- 影响：429/限流后，用户按日志提示手动抽取，仍然被冷却挡回 10 分钟–2 小时；对"把这几天的对话整理成记忆"这种明确请求，用户会以为插件坏了。只有直接调内部 API 的测试能绕过。
- 建议修法：`extractTool.execute` 的 `runOpts` 加 `force: true`（手动工具语义就是显式重试），并把冷却是否被绕过的结果回传给用户；或者删掉日志里的"手动调用"承诺。
- 备注：`memfuse_extract dryRun` 也走 `runWithTarget`，不走冷却检查，不受影响。

### F-EX-12 `state.json` 损坏时静默重置全部学习状态（水位线 / seen / dismissed / 待办）
- 严重度：**medium**
- 位置：`lib/index.js:185-191`（`readState` `catch` 直接返回全新默认对象）、`:3046-3051`（初始化立即 `writeState` 覆盖原文件）。
- 复现：`.audit/extract/f11-state-corruption.mjs`，命令 `node .audit/extract/f11-state-corruption.mjs`
- 实际（关键行）：
  ```json
  {"before":{"extracted":{"2026-11-01.md":999},"skillSeen":{"someKey":"..."},"skillDismissed":{"anotherKey":"..."},"distillRequests":["anotherKey"]},"after":{"extracted":null,"skillSeen":null,"skillDismissed":null,"distillRequests":null},"statusMentionsCorruption":false}
  ```
- 期望：解析失败时先备份原文件（`.bak.<时间戳>`），记 `runtimeFaults` / `status.md`，再决定是否降级；至少不能没有任何提示就把旧状态覆盖掉。
- 影响：一次磁盘截断/手改坏，所有水位线归零 → 重启后启动抽取会重抽全部历史会话；`auto` 模式下会重复写入记忆库，`suggest` 模式下待确认队列会被历史候选灌满；用户已忽略的技能建议也全部复活。属于"静默丢数据"。
- 建议修法：`readState` 捕获 JSON 解析错误时备份并抛/记 fault；`initTask` 在 state 损坏时使用只读模式，等用户确认再重建，或至少把备份路径写进 status。
- 备注：`readSkillSources` 的 `catch { return {} }` 是同类静默降级（损坏时 derived-into 来源映射丢失），可在同一次修复里一起加日志/备份。

### F-EX-13 模型返回合法但空洞的 JSON（`{"error":"..."}` / `{}`）时，伪造"技能"并报成功，且不标 salvaged
- 严重度：**medium**
- 位置：`lib/distill.js:310-350`（`parseSkillObject` 只要是非数组对象就接受；`obj.name`/`description`/`body` 都有兜底，`body` 兜底成 `## 背景 + 成员标题列表`）、`lib/distill.js:342-350`（`distillSkill` 返回 `ok:true`）。
- 复现：`.audit/extract/f18-salvage-empty-object.mjs`，命令 `node .audit/extract/f18-salvage-empty-object.mjs`
- 实际（关键行）：
  ```json
  {"result":{"ok":true,"name":"skill-ba61eb24","description":"从 2 条记忆提炼：部署流程","salvaged":false,"body":"## 背景\n\n- 部署流程\n- 部署检查"}}
  ```
- 期望：合法 JSON 但没有 `name` 且没有 `body`（或只有 `error` 之类键）时，应该失败并显示模型原始回复（或至少走 `salvaged:true` 的原文兜底），不要凭空造一份没有步骤的"技能"。
- 影响：用户点「提炼」看到一份名为 `skill-xxxx`、正文只有记忆标题的草稿，`salvaged:false` 让它看起来像正常提炼；装进技能库后对 AI 行为没有任何帮助，甚至可能被理解成"以这些标题为背景"的空指令。
- 建议修法：`distillSkill` 先检查 `obj.name`/`obj.body` 是否真实存在且长度足够（比如 body ≥ 40 且包含步骤标记）；缺失时走 `salvaged` 原文兜底或返回错误；`parseSkillObject` 对 `{error:...}` / 无 `name/body` 的对象返回 null。
- 备注：这与 F-EX-06 同名覆盖是两条不同路径：F-EX-06 是两份正常草稿撞名，这里是**一份伪草稿**。

### F-EX-14 "空数组 + 一句解释"被当成解析失败（`[]\n（本轮没有值得记住的内容）`）
- 严重度：**medium**
- 位置：`lib/extract.js:94-104`（`isExplicitEmptyArray` 要求 `s.startsWith('[') && s.endsWith(']')`）、`:164-174`（解析为空且不是显式空 → 报错）。
- 复现：`.audit/extract/f19-empty-array-prose.mjs`，命令 `node .audit/extract/f19-empty-array-prose.mjs`
- 实际（关键行）：
  ```json
  {"bare":{"parsedCount":0,"explicitEmpty":true,"error":null},"explanatory":{"parsedCount":0,"explicitEmpty":false,"error":"模型输出无法解析为候选数组（前 200 字：[]\n（本轮没有值得长期记住的内容）） —— 输出像是**被截断**了..."},"explanatoryBefore":{"error":"模型输出无法解析为候选数组（前 200 字：没有值得记住的内容。\n[]）"}}
  ```
- 期望：`parseCandidates` 已经能解析出空数组时，`isExplicitEmptyArray` 应基于解析结果（或剥掉前后解释）判断，而不是要求整段恰好以 `]` 结尾；空数组是正常结果，不该报错。
- 影响：模型只要在 `[]` 后加一句"本轮没有值得记住的内容"（很常见），每轮都记一次假错误；按 `skipAfterFailures` 累计后还会跳过该段，`status.md` 显示假故障。
- 建议修法：`isExplicitEmptyArray` 复用 `parseCandidates` 的结果并检查 raw 中是否确有 JSON 数组（或用 `parseCandidatesWithMeta` 返回 `{parsed, sawEmptyArray}`）；`extractCandidates` 中把"解析出的空数组"优先判为正常。
- 备注：`f17` 的"完整一句话被判截断"是同一组错误诊断问题。

### F-EX-15 `skill.maxBytes` 按"字符数"校验，中文技能可以超真实字节上限 3 倍；`listSkills.bytes` 也报字符数
- 严重度：**low**
- 位置：`lib/skill.js:99`（`content.length > maxBytes`）、`:155`（`bytes: text.length`）。
- 复现：`.audit/extract/f10-skill-bytes.mjs`，命令 `node .audit/extract/f10-skill-bytes.mjs`
- 实际（关键行）：
  ```json
  {"maxBytes":65536,"contentChars":30050,"contentBytes":90060,"validateOk":true,"listReportedBytes":30050,"listReportedIsChars":true}
  ```
- 期望：名为 `maxBytes` 就按 `Buffer.byteLength(content,'utf8')` 校验并上报；或者改名为 `maxChars` 并把描述改成字符数。
- 影响：中文技能可写成约 90KB 仍通过 64KB 限制；如果 DSH 侧有真实文件大小限制，用户会在安装/加载时遇到静默跳过；`status.md` 的体积显示也低估 3 倍。
- 建议修法：`validateSkill` 与 `listSkills` 统一用 UTF-8 字节数；文档/配置描述同步。
- 备注：纯低危，但属于"校验说的和做的不一致"。

### F-EX-16 `parseSkillMd` 不还原 `buildSkillMd` 的引号/反斜杠转义；空正文技能也能通过校验
- 严重度：**low**
- 位置：`lib/skill.js:52-58`（quoted 只判断首尾引号并直接 slice，不 unescape）、`:72`（build 时转义 `\\` / `"`）、`:98`（只检查 `content.trim()`，不检查 `parsed.body`）。
- 复现：`.audit/extract/f15-skill-parse-roundtrip.mjs`，命令 `node .audit/extract/f15-skill-parse-roundtrip.mjs`
- 实际（关键行）：
  ```json
  {"descriptionRoundTrip":{"original":"他说的 \"hi\" 在 C:\\new 目录","parsed":"他说的 \\\"hi\\\" 在 C:\\\\new 目录","equal":false},"emptyBody":{"validateOk":true,"parsedBody":"\n\n"}}
  ```
- 期望：build → parse 要能往返（或在 UI 显示前 decode）；`validateSkill` 应拒绝没有正文的 SKILL.md。
- 影响：模型生成的 description 只要含引号/反斜杠，草稿卡片和 `pendingSkillDrafts` 就会显示带 `\"`、`\\` 的字符串；frontmatter-only 的空技能可被安装（对 AI 无任何指令）。
- 建议修法：`parseSkillMd` 对双引号值做 YAML 反转义（至少 `\\`→`\`、`\"`→`"`）；`validateSkill` 加 `parsed.body.trim()` 非空。
- 备注：`buildSkillMd` 每次都转义、`parseSkillMd` 不还原，长期 patch 可能让反斜杠逐轮翻倍（本次未走 patch 路径复现）。

### F-EX-17 `approveSkill` 不先校验草稿、失败后不回滚：坏 SKILL.md 会被"装"进技能库并从 pending 消失
- 严重度：**low**
- 位置：`lib/index.js:1453-1462`（`approveSkill` 先 `approvePendingSkill` 移动，再 `verifySkill`；失败只写 `lastSkillError` 并返回）、`lib/skill.js:191-213`（`approvePendingSkill` 直接 rename 整个目录，没有内容校验）。
- 复现：`.audit/extract/f14-approve-broken.mjs`，命令 `node .audit/extract/f14-approve-broken.mjs`
- 实际（关键行）：
  ```json
  {"drafts":[{"name":"broken-skill","loadable":false,"problem":"frontmatter 解析失败"}],"approveResult":{"ok":false,"error":"安装后自校验失败：frontmatter 无法解析（会被 DSH 静默跳过）"},"liveSkills":["broken-skill"],"pendingAfter":[],"brokenSkillInstalled":true}
  ```
- 期望：approve 前先 `validateSkill` 草稿内容；校验/移动失败要回滚（把目录移回 pending 或至少保留副本），不能把坏技能留在 `skills/` 里。
- 影响：`pendingSkillDrafts` 已经标了 `loadable:false`，但界面仍渲染「装进技能库」按钮（client 没有用 `loadable` 禁用）；点了之后接口返回错误，技能库里却留下一个会被 DSH 静默跳过的条目，pending 副本也没了。status.md 会标 ⚠️，但用户已经无法重试。
- 建议修法：`approveSkill` 先 `readSkill` + `validateSkill`，不通过直接拒绝；`approvePendingSkill` 增加"校验后的原子 move"，或 verify 失败时把 `to` 移回 `from`。客户端按 `loadable` 禁用安装按钮。
- 备注：正常 distill 产出的草稿已在 `distillSkill` 校验过，所以只有手工编辑/旧版本/磁盘损坏会走到；但"失败不回滚"本身是危险的。

### F-EX-18 `drainStream` 取消时只 reject、不关上游流（token 继续消耗）
- 严重度：**low**
- 位置：`lib/index.js:1002-1008`（`finally` 里只有 `if (gaveUp) await it.return?.()`；取消路径设置 `onAbort` 但没把 `gaveUp` 置 true）。
- 复现：`.audit/extract/f16-drain-cancel.mjs`，命令 `node .audit/extract/f16-drain-cancel.mjs`
- 实际（关键行）：
  ```json
  {"error":"工具调用已取消（用户停止 / 回合结束）","upstreamReturnCalled":false}
  ```
- 期望：任何提前退出（取消、消费方 break、超时）都应调用 `it.return()` 关闭上游流；注释里也明确写了"放弃时 return() 关掉流"。
- 影响：用户点停止后工具立即返回，但上游模型请求还在跑，继续消耗 token/连接；对"停止对话"体验和账单都不好。
- 建议修法：`finally` 中无条件尝试 `await it.return?.()`（用 try/catch 包住），不要只在 `gaveUp` 时调用。
- 备注：`withBudget` / `drainStream` 的定时器本身都在 `finally` 清理，没有悬挂；这一条只针对上游流。

### F-EX-19 `truncationHint` 把所有不以 `]`/`}` 结尾的输出都诊断为"被截断"，完整拒绝句也会被误导成 maxTokens 问题
- 严重度：**low**
- 位置：`lib/extract.js:131-136`。
- 复现：`.audit/extract/f17-truncation-hint.mjs`，命令 `node .audit/extract/f17-truncation-hint.mjs`
- 实际（关键行）：
  ```text
  raw: 抱歉，这个会话里没有值得长期记住的内容。
  error: 模型输出无法解析为候选数组（前 200 字：...） —— 输出像是**被截断**了（结尾不是 ] 或 }）：多半是 maxTokens 不够；重试一次，或给抽取换一个不"先想很久"的模型
  ```
- 期望：只有在有真实截断证据时才提示截断（宿主 `finish.reason.kind === 'max-tokens'` 已经能拿到，`makeModelCaller` 里也有 `finishKind`；或者省略号/未闭合括号/JSON 扫描失败）。完整句子应提示"模型没有按 JSON 格式回答/可能拒绝"。
- 影响：用户被引导去换模型/调 maxTokens，实际是模型拒绝/格式错误；违反了 spec 里"说错原因比不说更糟"的原则。
- 建议修法：把 `truncationHint` 改成基于 `raw` 的 JSON 结构扫描（未闭合的 `[`/`{`、字符串未闭合）或把 `finishKind` 透传到 `extractCandidates`；纯文本结尾不构成截断证据。

## 已验证 / 设计如此（不是 bug）

- **预算常量与嵌套**：`PROBE_BUDGET_MS=2000`、`MODEL_CALL_TIMEOUT_MS=90000`、`EXTRACT_BUDGET_MS=100000`、`TOOL_TIMEOUT_MS=120000`；`STARTUP_EXTRACT_BUDGET_MS=240000` 是后台启动抽取，不在工具超时链上。`makeModelCaller` 的 `remaining()` 取 `min(MODEL_CALL, deadline-left)`，`drainStream` 的 idle 窗口与 `absDeadline` 分工正确；`withBudget`/`drainStream` 的定时器都在 `finally` 清理（`withBudget` 明确不 `unref` 是有测试原因的）。
- **`clusterKey`**：按 id 排序拼接，顺序无关；成员变化会换 key（现有 `H7` 回归通过）。本次没有复现出功能性缺陷。唯一理论边界：id 里若含逗号会与另一个 id 组合撞 key，但生成器 id 不含逗号，手写 id 才会触发；未列为 finding。
- **salvage 正常路径**：模型返回非 JSON 的整段文本（≥40 字）时，确实会 `buildSkillMd` 成草稿并标 `salvaged:true`；`validateSkill` 通过后落 pending，UI 会显示"这是模型原文"（f18 修的是"合法但空洞对象"的相邻路径，不是正常 salvage）。
- **`skipAfterFailures` 的跳过本身**：作为内容错误的熔断策略是设计如此；问题在记录、成功口径和 0 值语义（F-EX-01），不是"存在跳过"。
- **`suggestMax` 卡片行数**：默认 1 行 + `restKeys` 一并记 seen 是缺陷 22 的设计，不重报。
- **`freshSuggestions` 的全局水位**：`state.skillSeen` 最晚时间戳作为全局水位、老组不再主动弹，是缺陷 41 的明确设计；F-EX-08 只报"seen 组时间变新"这条被调用方过滤掉的死分支。
- **`minChars` 尾部**：文件新增不足 200 字不抽，是 `config.js` 明确写的省调用策略；不报。
- **`dryRun` 只取最后一个文件的前 `maxInputChars`**：spec 缺陷 29 已明确说明 `extract.js` 内部 `slice(0,12000)`，属于预览设计，不报（但建议在工具返回里注明"只预览第一段"）。

## 未能证实（可疑但没复现出来）

- **`writeSkillSources` 的 tmp 名 `${file}.tmp-${pid}`**：两个不同簇并发 distill 时，`readSkillSources` → `writeSkillSources` 的 read-modify-write 会丢一方的 `derived-into` 映射。理论上成立，但本次没有构造稳定的并发复现（f08 只覆盖 `writeSkill` 的 tmp 冲突）；建议与 F-EX-07 一起修。
- **进程在 `runExtraction` 中途崩溃**：水位线只在函数末尾 `writeState`，段 1 已入队但进程崩溃 → 下次重抽段 1 → 重复候选。没有真实的"崩溃注入"脚本，未列为 finding；修 F-EX-04 的状态写队列时可以顺带考虑每段成功后增量持久化。
- **`writeSkill` 的同名覆盖在 UI 双击路径的触发概率**：client 的 `draftBusy` 会阻止同一张卡片的重复动作；但工具路径与界面路径、两个标签页之间没有互斥，F-EX-07 的 patched 复现证明调度交错即可触发，未在真实 UI 上量化概率。
- **`buildSuggestions` 的 `limit: 5` 与 "另有 N 组"**：`computeSuggestions` 固定 5，`renderSuggestions` 的 "另有 N 组" 用的是截断后的长度；当合格组 >5 时 N 会少算。spec 缺陷 38 写明"工具/注入预览仍最多 5 组"，所以只作为文案/可达性备注，不列为 finding。
- **`state.distillRequestsAt` / `state.lastSkillError`**：前者 `requestDistillKey` 写入后无人读取，且 `distillRequests` 裁剪时 `distillRequestsAt` 不裁剪（长期膨胀）；后者只在 `distillCluster`/`approveSkill` 写，`status.md` 和工具都没有展示。属于死状态/体积问题，未单独列 finding。
- **`parseSkillObject` 的括号启发式**：模型返回 "说明 [x] + JSON 对象 + 说明 [y]" 时，数组分支会先失败但对象分支通常能救回；没有找到稳定导致失败的常见形状，未列为 finding。
- **`queue.listPending` 静默跳过坏 JSON**：注释说"跳过并计数"，实际没有计数/日志；坏候选文件会静默消失。与本次抽取/技能主链关系较远，未列 finding。

## 建议补的回归测试

1. **跳过路径**：`skipAfterFailures:0` 永不跳过；跳过时 `state.skippedSegments` 落盘且 `status.md` 出现「跳过的段」；该轮 `ok:false` 或至少 `lastExtractSuccess` 不刷新；`extract-skip` usage 的 `start` 保持原起点。
2. **准入丢弃**：模型返回 2 条字段不全的候选 → `extractCandidates` 返回 `droppedInvalid=2`（或 error），`runExtraction` 不推进水位线、不写成功时间戳、`status.md` 有可见计数。
3. **抽取单飞**：`startupExtraction` 与 `api.runExtraction()` 并发时同一文件只调一次模型、只入队一条候选；`auto` 模式不写重复记忆。
4. **状态写并发**：`markSuggestionsSeen` + `dismissSuggestion` 并发 200 次无 ENOENT；模拟 `flushInjected` + 抽取 `writeState` 并发；断言 `skillSeen`/`skillDismissed` 都不丢 key。
5. **match/seed 不存在**：`distillCluster({match:'不存在'})` / `seedId` 不存在时 `ok:false`，且不写 pending 草稿；`dismiss` 同样不 fallback 到第一条。
6. **pending 幂等**：两个不同簇生成同名 `slug` 时第二次 `distillCluster` 返回冲突/自动改名，第一份草稿内容仍在；并发 `writeSkill` 不 ENOENT；`writeSkillSources` 不丢映射。
7. **fresh 边界**：已 seen 组的成员 `updated` 晚于该组 seen 时间（且晚于全局水位）→ `list` 的 `fresh` 包含它、`status` 为 `ready`；未 seen 但早于全局水位的老组不弹（保持 spec 的全局水位语义）。
8. **JSON 解析**：前后带 `[说明]` 的合法候选数组能解析；`[] + 解释` 判为显式空数组；普通拒绝句不出现"被截断/maxTokens"提示；只有真实未闭合 JSON 才提示截断。
9. **配置生效**：`maxRetries:5` 对 500/429 真重试（并受总预算约束）；冷却期 `memfuse_extract` 能按提示绕过（或删掉提示/配置）；`skipAfterFailures:0` 永不跳过。
10. **SKILL.md**：`buildSkillMd` → `parseSkillMd` 描述往返（含引号/反斜杠）；空正文被拒；`maxBytes` 按 UTF-8 字节；坏草稿 approve 不留坏技能在 `skills/` 且 pending 保留；`drainStream` 取消/消费方 break 都调用上游 `return()`。
11. **salvage**：模型返回 `{"error":"..."}` / `{}` 时不产出伪技能（或至少 `salvaged:true` 且正文为模型原文）。

## 复现日志

完整运行输出见 `.audit/extract/run-all.log`（每个脚本的 exit code 均为 1，表示"期望行为未满足"；关键 JSON 已在上面对应 finding 引用）。

```text
f01-skip-silent.mjs            exit=1
f02-admission-silent.mjs       exit=1
f03-parse-brackets.mjs         exit=1
f04-match-fallback.mjs         exit=1
f05-pending-overwrite.mjs      exit=1
f06-fresh-boundary.mjs         exit=1
f07-state-write-race.mjs       exit=1
f08-skill-write-race.mjs       exit=1
f09-maxretries-noop.mjs        exit=1
f10-skill-bytes.mjs            exit=1
f11-state-corruption.mjs       exit=1
f12-extract-concurrency.mjs    exit=1
f13-force-cooldown.mjs         exit=1
f14-approve-broken.mjs         exit=1
f15-skill-parse-roundtrip.mjs  exit=1
f16-drain-cancel.mjs           exit=1
f17-truncation-hint.mjs        exit=1
f18-salvage-empty-object.mjs   exit=1
f19-empty-array-prose.mjs      exit=1
```
