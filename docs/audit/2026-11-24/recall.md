# 检索与注入 审计报告

审计范围：`lib/recall.js` / `lib/inject.js` / `lib/policy.js` / `lib/memory-view.js`，
以及把三者接起来的调用点（`lib/index.js` 的注入 provider、`pre-step` 缓存、`runMaintenance`）。
基线：git `9b6d190`，`pnpm test` 188 项全绿（plugin 110 + client 50 + 预览 5 + smoke 23）。

## 概览

**读过的文件**

| 文件 | 关注点 |
|---|---|
| `lib/recall.js` | tokenize / bm25 / excerpt / recall 两池 / resident |
| `lib/inject.js` | Block A–E 装配、字符预算、estimateTokens |
| `lib/policy.js` | score / computeExpiry / planPurge / isProtected / compareForDormancy |
| `lib/memory-view.js` | computeStats / buildView / explainRow / annotateRows |
| `lib/index.js` | `latestQuery` 缓存、`flushInjected`→`touchMemory`、`runMaintenance`、注入 provider |
| `lib/antiseptic.js` | `planStale`（只为确认 stale 的生产端） |
| `docs/spec.md` | §B3 BM25、§G4 stale 设计、缺陷 39（休眠召回） |
| `docs/NEXT.md` / `AGENTS.md` | 已知设计、已知缺陷，避免把设计报成 bug |

**实际执行过的命令**

```
pnpm test                                         # 基线：188 项全绿
node .audit/recall/f01_bm25_poolnorm.mjs          # F-RC-01
node .audit/recall/f02_tokenize_punct.mjs         # F-RC-02
node .audit/recall/f03_excerpt_substring.mjs      # F-RC-03
node .audit/recall/f04_latestquery.mjs            # F-RC-04
node .audit/recall/f05_dormant_inject_purge.mjs   # F-RC-05
node .audit/recall/f06_minscore_noop.mjs          # F-RC-06
node .audit/recall/f07_biglib_perf.mjs            # F-RC-07
node .audit/recall/f08_dormant_panel_copy.mjs     # F-RC-08
node .audit/recall/f09_empty_query_blockb.mjs     # F-RC-09
node .audit/recall/f10_stale_still_injected.mjs   # F-RC-10
node .audit/recall/f11_budget_allocation.mjs      # F-RC-11
node .audit/recall/f12_stats_resident_count.mjs   # F-RC-12
```

所有脚本都在临时 `DSH_HOME` + 临时库根下跑，未读写真实记忆库；`_harness.mjs` 是共用的假 ctx
（按 `test/plugin.test.mjs` 的宿主契约复刻：`tools.register` / `systemPrompt.context` 同步求值 /
`agent/pre-step` waterfall）。

**finding 计数：blocker 0 / high 6 / medium 4 / low 2**

| id | 严重度 | 一句话 |
|---|---|---|
| F-RC-01 | high | BM25 按池归一化 → 休眠「≥0.5 词法」门槛失效、跨池分数不可比 |
| F-RC-02 | high | 拉丁分词吞掉句末标点 → 英文记忆静默召回不到 |
| F-RC-03 | medium | `excerpt()` 子串匹配 + 单字母 token → 摘录行经常是无关的第一行 |
| F-RC-04 | high | `latestQuery` 是全局单值，且会取到助手自己的话 → 串会话 / 同轮内 Block B 消失 |
| F-RC-05 | high | 休眠条目被注入不计 `recalled` → 30 天后仍被物理删除 |
| F-RC-06 | medium | `inject.minScore` 默认值落在恒真区，0.18–0.31 调了等于没调 |
| F-RC-07 | medium | 大库性能：400 条 × 8k 字 ≈ 0.25–0.32 s/次，无缓存；50k 字正文 ≈ 1.9 s |
| F-RC-08 | high | 面板说休眠「不参与注入」，实际每轮都在 Block B 里 |
| F-RC-09 | medium | 没有输入时 Block B 仍出现，且自称「与当前输入相关」 |
| F-RC-10 | high | stale 条目照旧注入（面板说「不再注入」）；顺手把用户 P0 标成 stale |
| F-RC-11 | low | 预算按剩余额度递减 → 长标题时最后两条只剩标题 |
| F-RC-12 | low | `computeStats` 的常驻计数把 dormant P0 也算进去 |

---

## 发现

### F-RC-01 BM25 归一化是「池内相对分」，休眠门槛与跨池排序都当成绝对分用

- 严重度：**high**
- 位置：`lib/recall.js:140-141`（`max = Math.max(...raw)` 后整除归一）、`lib/recall.js:187-225`（active / dormant 各自 `bm25()`）、`lib/recall.js:222-225`（`lexical < 0.5` 剔除）
- 复现：`.audit/recall/f01_bm25_poolnorm.mjs`，命令 `node .audit/recall/f01_bm25_poolnorm.mjs`
- 实际：

```
== A. 休眠池只有 1 条：一个双字命中 = 满分 ==
query = 帮我写报告 季度 汇报 | query tokens = ["帮我","我写","写报","报告","季度","汇报"]
该条与 query 的公共 token = ["报告"]
bm25([这一条], query) = [ 1 ] ← 满分

== B. 跨池排序：休眠（1 个命中）压过活跃（2 个命中）==
  active-best    pool=active  lexical=1.000 score=0.860
  dormant-weak   pool=dormant lexical=1.000 score=0.860
  active-second  pool=active  lexical=0.965 score=0.840
→ 休眠条目是否排在活跃条目前面：true

== C. 同一份内容、不同池 → 两个不同的 lexical（同一份证据两个分数）==
  池里只有自己       → lexical = 1.000
  池里多一个更强的   → lexical = 0.544
```

- 期望：休眠门槛（spec 缺陷 39：「词法命中要过半，避免一条过期记忆凭底分混进来」）应该表达**绝对证据强度**；活跃池与休眠池的分数应该可比较（同一把尺子）。
- 影响：① 休眠池只有 1 条时，任何一次双字命中都拿满分 → `lexical >= 0.5` 这道门形同虚设，一条只在正文里出现「报告」两个字的过期记忆也够格进 Block B；② 休眠条目的 `s` 与活跃条目不可比，1 个命中的休眠条目会排到 2 个命中的活跃条目前面，占掉 `relevantMaxEntries`（默认 4）的名额；③ 把 `minScore` 当绝对阈值用也没有意义（同一份证据池子一大就掉到 0.544）。
- 建议修法：把 IDF / 平均长度用**全库**（active + dormant 合并）算一次，或至少把 `max` 归一化改成「全库共享的最大 raw 分」；休眠门槛改用 raw 分（如 `raw >= 某常数` 或「命中 token 数 ≥ 2」）。
- 备注：不是设计如此 —— 注释写的意图是「必须真的有词法证据」，实现却做成池内相对量。

### F-RC-02 拉丁分词吞掉句末标点 → 英文记忆静默召回不到

- 严重度：**high**
- 位置：`lib/recall.js:63`（`/[a-z0-9][a-z0-9_.+\-]*/g`）
- 复现：`.audit/recall/f02_tokenize_punct.mjs`，命令 `node .audit/recall/f02_tokenize_punct.mjs`
- 实际：

```
  "This is memory."                      → ["this","is","memory."]
  "use node.js. Then run it"             → ["use","node.js.","then","run","it"]
  "The config lives in state.json."      → ["the","config","lives","in","state.json."]

== B. 目标词在正文里以句号结尾 → 查不到 ==
  正文 tokens = [... "memory.","nothing","else.", ... "registry.example.internal.", "use","it."]
  query "memory"                   → hits=0
  query "registry.example.internal" → hits=0

== C. 对照：同一段正文去掉句号 → 立刻命中 ==
  query "memory"                   → hits=1
  query "registry.example.internal" → hits=1
```

- 期望：分词在词尾去掉 `.` `,` `)` 这类句子标点；`memory.` 与 `memory` 是同一个词。`.` 只应在**词内**保留（`node.js`、`state.json`、`e.g`）。
- 影响：任何以英文句子结尾的记忆（正文/摘要/anchor）都切成带句号的 token；查询侧一般不带标点 → 该词永远匹配不上，且**没有任何日志**。中文用户写英文技术词（`pnpm install.`、`state.json.`）时命中率被系统性拉低。
- 建议修法：正则改成 `[a-z0-9](?:[a-z0-9_+\-]|\.(?=[a-z0-9]))*`（点只有在后面还跟字母数字时才算词内），或分词后再 `replace(/[.,;:!?)\]}]+$/,'')`。
- 备注：现有回归只用了中文 bigram，没有英文句末标点的用例。

### F-RC-03 `excerpt()` 用子串包含 + 单字母 token 挑摘录行 → 摘录经常是无关的第一行

- 严重度：medium
- 位置：`lib/recall.js:151-169`（`low.includes(t)` 与 `hits > bestHits` 的平局规则）
- 复现：`.audit/recall/f03_excerpt_substring.mjs`，命令 `node .audit/recall/f03_excerpt_substring.mjs`
- 实际：

```
== A. 查询 "what is a good build" ==
  tokens = ["what","is","a","good","build"]
  query "what is a good build"   → "A quick note about releases."
  query "build"                  → "Run the build with pnpm."

== B. 逐行命中明细（query = "what is a good build"）==
  "A quick note about releases."             hits=1 ["a"]
  "Second line mentions nothing relevant."   hits=1 ["a"]
  "Run the build with pnpm."                 hits=1 ["build"]
```

- 期望：摘录应选**真正含实义词命中**的那一行；冠词/系动词不该参与打分；平局时应偏向命中更稀有的 token，而不是先出现的那行。
- 影响：注入块里每条记忆的「与当前查询最相关的那一行」经常是错的（`- [P1] 标题 — A quick note about releases.`），把本来有用的摘要挤掉；英文正文的记忆几乎恒定摘录第一行。
- 建议修法：拉丁侧加停用词表（至少 a / an / the / is / are / of / to / in），命中判定改成 token 边界匹配，平局用 IDF 加权而不是「先到先得」。
- 备注：中文侧不受影响（bigram 本身就是边界内匹配）。

### F-RC-04 注入用的「当前输入」是全局单值，且会取到助手自己的话

- 严重度：**high**（长 tool 回合里接近 blocker：Block B 全程缺席）
- 位置：`lib/index.js:3764`（`let latestQuery = ''`）、`lib/index.js:3869-3885`（pre-step 里回填）、`lib/index.js:4027-4042`（`text: () => buildInjection(..., latestQuery, ...)`，忽略 host 传入的 scope）
- 复现：`.audit/recall/f04_latestquery.mjs`，命令 `node .audit/recall/f04_latestquery.mjs`
- 实际：

```
== 症状 A：两个会话轮流发 pre-step ==
会话 A（pnpm 提问）之后，lastInjection.query = "我要装依赖，用 pnpm 还是 npm？"
会话 B（nginx 提问）之后，lastInjection.query = "测试环境的 nginx 部署端口是多少？"
  以 sess-A 的 scope 求值：含 pnpm = false 含 nginx = true
  以 sess-B 的 scope 求值：含 pnpm = false 含 nginx = true
  两次求值是否完全相同 = true

== 症状 B：同一轮的第 2 步（messages 末尾是助手自己的话）==
lastInjection.query = "好的，我先把目录结构列出来。"
  注入块含 pnpm 条 = false （本轮用户问的正是 pnpm）
  注入块：
    （空字符串）

== 症状 B2：库里有 P0 时常驻块还在，但 Block B 已经没了 ==
有 Block A（常驻）= true ｜有 Block B（相关召回）= false
lastInjection.query = "好的，我先把目录结构列出来。"
```

- 期望：注入块按**当前会话**的**当前用户输入**算；同一轮的第 2、3… 步仍然用这一轮的用户提问。
- 影响：① 多会话（主会话 + 子代理是 DSH 的常规用法，缺陷 33 就是因为同一个全局变量被踩过）下，后发 pre-step 的会话决定所有会话的注入内容 —— 另一个会话的记忆块会串味；② 任何带 tool 调用的回合，第 2 步起 `latestQuery` 变成助手自己的话（`textOfMessage` 只认 `type:'text'` 块，助手消息也有），Block B 直接算空 → **Block B 从第 2 步起消失**；如果库里没有 P0、也没有别的块，`## Super Memory` 整块都会消失（实测 `text()` 返回空字符串）。
- 建议修法：`pre-step` 里只接受「最后一条 **user** 消息」作为 query（已有 `source.kind === 'user'` 的判据，见缺陷 12b）；缓存改成按 session 存（`Map<sessionId, query>`），`text(ctx)` 用 `ctx.scope` 选；取不到就退回「最近一轮用户输入」而不是助手文本。
- 备注：`flushInjected` / `lastInjection` 同一个全局变量，串会话时统计归因也会错。

### F-RC-05 休眠条目被注入不算「被召回」→ 30 天后仍被物理删除

- 严重度：**high**（不可逆删除；git 开着时可从历史找回）
- 位置：`lib/index.js:3812-3815`（注入只 `touchMemory(..., { injected: 1 })`）、`lib/policy.js:347-359`（`planPurge` 只认 `stats.recalled`）、`lib/index.js:510-515`（维护时真的删）
- 复现：`.audit/recall/f05_dormant_inject_purge.mjs`，命令 `node .audit/recall/f05_dormant_inject_purge.mjs`
- 实际：

```
== 连续 3 轮都问同一个问题（休眠条目被真实注入）==
第 1 轮：注入块含该条 = true｜lifecycle=dormant｜recalled=0｜injected=0
第 2 轮：注入块含该条 = true｜lifecycle=dormant｜recalled=0｜injected=1
第 3 轮：注入块含该条 = true｜lifecycle=dormant｜recalled=0｜injected=2
...
planPurge（休眠 >30 天、零反馈、recalled===0）返回： ["m_mwu8hu6o_seetzi"]
该条 stats = {"recalled":0,"injected":2,"positive":0,"negative":0}
```

- 期望：`planPurge` 的「从未被召回」应该把「被注入过」也算作使用证据（`injected > 0` 就不删）；或者注入路径也走 `recalled` 计数/自动唤醒（`memfuse_recall` 工具那条路就会 auto-revive，注入这条路不会）。
- 影响：一条自动学到、连续多轮被真实注入的休眠记忆，30 天后在启动维护里被 `store.remove()` 物理删除；而面板上它明明显示「注入 N 次」。默认 `lifecycle.autoRunOnStart = true`，用户重启就会触发。
- 建议修法：`planPurge` 增加 `(r.stats?.injected || 0) === 0` 条件；或在 `touchMemory` 里让 `injected > 0` 也算一次弱证据（至少刷新 `dormantAt`）。
- 备注：`planPurge` 的注释只说「从未被召回」，没提「注入」——两条路径对「用过」的定义不一致。

### F-RC-06 `inject.minScore` 的默认值落在恒真区，调它等于没调

- 严重度：medium
- 位置：`lib/policy.js:14-22 + 137-154`（底分）、`lib/policy.js:38`（`THRESHOLD = 0.18`）、`lib/config.js:102`（配置文案）
- 复现：`.audit/recall/f06_minscore_noop.mjs`，命令 `node .audit/recall/f06_minscore_noop.mjs`
- 实际：

```
== A. 零词法命中时的底分（score(rec, 0)）==
  P0 底分 = 0.350
  P1 底分 = 0.310
  P2 底分 = 0.224
  默认阈值 THRESHOLD = 0.18 ← 低于所有底分

== B. 同一个库、不同 minScore ==
  minScore=0.18  recall=[p1-strong,p2-weak]  BlockB 条数=2
  minScore=0.31  recall=[p1-strong,p2-weak]  BlockB 条数=2
  minScore=0.5   recall=[p1-strong]  BlockB 条数=1
```

- 期望：`minScore` 应该真的能把「弱命中」挡在外面；配置文案「调高 = 只注入更像的」应成立。
- 影响：默认 0.18 比所有优先级的零词法底分都低 → 只要有一个词法命中就必然通过。用户在设置页把 0.18 调到 0.3 看不到任何变化（实测 0.18 与 0.3 结果一字不差），会以为配置没生效/插件坏了。真正的筛选实际上只有 `recall` 里的 `l > 0` 一条。
- 建议修法：把阈值改成作用在 **lexical** 上（例如 `lexical >= 0.15`），或把 `minScore` 的默认值抬到 0.35 以上并在文案里写清「低于 0.22/0.31/0.35 的不同含义」。
- 备注：这是「配置项存在但从不生效」，属于项目自己列的硬规则 4 范畴。

### F-RC-07 大库性能：每轮把全库所有字段重新分词，没有任何缓存

- 严重度：medium（有量化）
- 位置：`lib/recall.js:113-122`（每条记忆 5 个字段各一次 `tokenize`）、`lib/inject.js:86-89`（每次装配都重跑 `recall`）
- 复现：`.audit/recall/f07_biglib_perf.mjs`，命令 `node .audit/recall/f07_biglib_perf.mjs`
- 实际（Node v22.22.0，本机）：

```
== A. 条数（每条 8000 字，正常上限内）==
  recall(400 条)                              306.6 ms
  buildInjection(400 条)                      317.2 ms
  buildInjection(1000 条)                     682.6 ms

== B. 单条正文长度（条数固定 400 = 默认预算上限）==
  400 条 × 8000 字                            309.0 ms
  400 条 × 50000 字                          1912.8 ms

== C. 同一份数据、连续两次调用（有没有缓存）==
  第一次 buildInjection  278.6 ms
  第二次 buildInjection  277.4 ms   → 1.00× 每次都全量重算

== D. 超长 query（100000 字 + 120 条库）==
  query 100000 字                       199.7 ms  （没有爆炸，只比 1000 字慢 2×）
```

- 期望：注入在关键路径上（每轮每个 step 求值一次，且 `text()` 是同步的），400 条库应该做到毫秒级；同一份数据在库没变时不该重算。
- 影响：默认上限 400 条 × 8k 字正文 ≈ 0.25–0.32 s/step，模型每步前都要等；写入口不截断 body（spec 已知问题 9），400 条 × 50k 字 ≈ **1.9 s/step**，表现为明显的输入卡顿/流式打嗝。1000 条（用户可能调大 `maxMemories`）≈ 0.7 s。
- 建议修法：给每条记忆缓存 tokenized 的 `Map`（以 `id + updated` 为键，或维护一份内存倒排索引），`buildInjection` 里对 `cachedAll` 复用；至少在 `refreshInjectionCache` 时预计算一次，别每个 step 重算。
- 备注：超长 query 本身**没有**发现爆炸性退化（见「未能证实」），真正的成本来自库规模。

### F-RC-08 面板说休眠「不参与注入」，实际每轮都在注入

- 严重度：**high**（说错原因比不说更糟）
- 位置：`lib/memory-view.js:317`（`explainRow` 的 dormant 文案）、`lib/recall.js:187-225`（缺陷 39 之后 dormant 也进 Block B）
- 复现：`.audit/recall/f08_dormant_panel_copy.mjs`，命令 `node .audit/recall/f08_dormant_panel_copy.mjs`
- 实际：

```
== 注入块（本轮真实发给模型的文本）==
  ### 相关召回（与当前输入相关）
  - [P1] 生产库连接串走只读账号 — 报表任务必须用只读账号连接生产库，写操作一律走离线副本。
  含该休眠条目 = true

== 面板对同一条的说明 ==
  lifecycle = dormant │ dormant = true
  reason.code = dormant
  reason.reason = 休眠中，不参与注入；被高相关提问命中时会自动唤醒
```

- 期望：文案应与缺陷 39 之后的行为一致：「休眠中，只在被高相关提问命中时进入相关召回」；「自动唤醒」也只发生在 `memfuse_recall` 工具路径，注入路径**不会**唤醒（见 F-RC-05）。
- 影响：用户在面板上看到「不参与注入」，就认为这条已经不在上下文里了 —— 实际模型每轮都能读到它。反向也会误导：用户以为「它自己会醒」，实际一直是 dormant（注入不唤醒），30 天后可能被删（F-RC-05）。
- 建议修法：`explainRow` 的 dormant 文案改成「休眠中：只在被高相关提问命中时临时进入相关召回；要恢复常驻请点唤醒」，或者让 `recall()` 注入路径也调 revive，使文案成真。
- 备注：`test/plugin.test.mjs:3668` 只断言 `reason.code === 'dormant'`，断言消息里写着「不参与注入」——测试把错误文案固化了，所以 188 项全绿也抓不到。

### F-RC-09 没有输入时 Block B 仍然出现，且自称「与当前输入相关」

- 严重度：medium
- 位置：`lib/recall.js:191-197`（空 query 分支不看 `minScore`）、`lib/inject.js:86-101`（标题写死）
- 复现：`.audit/recall/f09_empty_query_blockb.mjs`，命令 `node .audit/recall/f09_empty_query_blockb.mjs`
- 实际：

```
== 一次 pre-step 都没发生（latestQuery = ""）时装配提示词 ==
  ### 相关召回（与当前输入相关）
  - [P1] 周报模板 — 关于周报模板的说明。
  - [P2] nginx 端口 8080 — 关于nginx 端口 8080的说明。
  - [P2] 生产库只读账号 — 关于生产库只读账号的说明。
  - [P2] 发版流程 — 关于发版流程的说明。
```

- 期望：没有 query 时不应该有「相关召回」块（或改标题为「按优先级列举」并说明原因）。
- 影响：① 模型被明确告知这 4 条「与当前输入相关」，而当前根本没有输入 —— 归因错误；② 白烧 `relevantMaxChars`（默认 1800）预算；③ 这 4 条会被 `flushInjected` 记成 `injected`，污染统计。触发路径：首条消息不含 text 块（纯图片/纯附件）、或宿主在任何 pre-step 之前先装配一次。
- 建议修法：`buildInjection` 在 `query` 为空时跳过 Block B（需要「按优先级列举」就换个标题单独成块）。
- 备注：`recall(all, '')` 的「按优先级 + 效用」分支本身是给 `memfuse_recall` 工具用的（工具描述里写了「省略 query 时按优先级列出」），注入层不该复用它。

### F-RC-10 stale 条目照旧被注入；顺手把用户置顶的 P0 标成 stale

- 严重度：**high**
- 位置：`lib/index.js:519-533`（维护第 4 步标 stale，不动 lifecycle、不查 `isProtected`）、`lib/memory-view.js:318`（文案「不再注入」）、`lib/recall.js:187`（只按 lifecycle 过滤）
- 复现：`.audit/recall/f10_stale_still_injected.mjs`，命令 `node .audit/recall/f10_stale_still_injected.mjs`
- 实际：

```
维护前： dup-p0(pri=P0,stale=false,lifecycle=active)  dup-p1(pri=P1,stale=false,lifecycle=active)
maintenance 结果： {"expired":0,"dormant":0,"purged":0,"staled":1}
维护后： dup-p0(pri=P0,stale=true,lifecycle=active)  dup-p1(pri=P1,stale=false,lifecycle=active)

== 同一条 stale 记录还进不进注入？ ==
  注入块含「部署端口是 8080」= true
  entries = [{"id":"dup-p0","source":"resident","block":"A"},{"id":"dup-p1","source":"relevant","block":"B"}]
  面板 dup-p0: stale=true reason=stale / 已被更新的条目取代，原文保留但不再注入
```

- 期望：spec §G4 的设计是「stale 只 −0.20 降权，不排除注入」——那面板文案就**不能**写「不再注入」；另外维护不该改 P0 / 用户资产（硬规则 5）。
- 影响：① 用户置顶的 P0 被自动标成「已被更新的条目取代」（每次启动的维护都可能发生），语义上等于系统改写了用户资产；② 面板说它「不再注入」，实际它在 Block A（常驻块）里；③ 完全重复的两条同时进注入（一条 Block A、一条 Block B），同一个事实被喂两遍，白占预算。
- 建议修法：`explainRow` 的 stale 文案改成「已被更新的条目取代，仍会注入但降权 0.2」；`runMaintenance` 第 4 步加 `if (policy.isProtected(rec)) continue`；`recall`/`resident` 里对 `stale` 条目去重或降级。
- 备注：如果产品决定「stale 就是不注入」，那要改的是 `recall` 的过滤条件，不是文案 —— 两种改法都行，但不能像现在这样各说一套。

### F-RC-11 预算按剩余额度递减 → 长标题时最后两条只剩标题

- 严重度：low
- 位置：`lib/inject.js:72-83`（Block A）与 `lib/inject.js:91-101`（Block B）的 `Math.floor(budget / res.length) - 40`
- 复现：`.audit/recall/f11_budget_allocation.mjs`，命令 `node .audit/recall/f11_budget_allocation.mjs`
- 实际：

```
== A. 8 条 P0，标题 80 字、摘要 200 字 ==
  residentMaxChars = 1200，实际 = 1062
  第 1 条： 200 字　有摘要=true
  ...
  第 7 条：  87 字　有摘要=false
  第 8 条：  87 字　有摘要=false

== B. 同样 8 条，但标题只有 10 字 ==
  实际 = 159，每条都有摘要 = true
```

- 期望：预算应平均分配到每条（`budget / 剩余条数`），并预留真实前缀开销（`- [P0] ` + 最多 80 字标题 ≈ 90 字，不是 40）。
- 影响：用户置顶的第 7、8 条在注入里只剩「- [P0] 标题」，正文/摘要全丢 —— 模型知道有这条记忆却看不到内容。内容明明放得下（159 < 1200）也可能因为标题长而被吃干。
- 建议修法：`const per = Math.floor(remaining / 剩余条数) - 90;`，并按剩余条数递减。
- 备注：预算上限本身**没有**被突破（C 段核对：1200 配置 → 实际 976），这一条只关乎分配公平性。

### F-RC-12 `computeStats` 的常驻计数把 dormant P0 也算进去

- 严重度：low
- 位置：`lib/memory-view.js:126-151`（`by.P0` 不区分 lifecycle，`residentCount = Math.min(by.P0, cap)`）
- 复现：`.audit/recall/f12_stats_resident_count.mjs`，命令 `node .audit/recall/f12_stats_resident_count.mjs`
- 实际：

```
computeStats:
  byPriority = {"P0":3,"P1":1,"P2":0} ｜active= 2 ｜dormant= 2
  residentCount = 3 （= by.P0，把 dormant 也算成常驻）
buildView:
  resident（真正每轮注入的）= ["p0-active"]
→ 顶部数字说 3 条常驻，下面实际只列出 1 条。
```

- 期望：`residentCount` / `residentOverflow` 应只统计 active P0（与 `buildView.resident`、`recall.resident()` 同口径）。
- 影响：面板/接口的数字与真实常驻列表对不上（休眠 P0 可达：`memfuse_write mode=supersede` 会把 P0 打成 dormant，见 F-RC-10）。当前界面顶部用的是 `residentIds.length` 而不是 `stats.residentCount`，所以这一条暂时是**潜在**错误，一旦有人用 stats 就会显示错。
- 建议修法：`computeStats` 里单列 `byPriorityActive`，或 `residentCount` 改为 `rows.filter(isResident).length`。
- 备注：`test/plugin.test.mjs:3661` 的断言消息写着「用户看顶部就知道我置顶了几条、几条真生效」——说明这个数字本来是给顶部用的。

---

## 未能证实（可疑但没复现出来）

1. **超长 query 的算法爆炸**：怀疑 `tokenize` + `excerpt` 的 token×行数会二次爆炸。实测 120 条库 + 10 万字 query（含命中词）`buildInjection` = 199.7 ms（1 千字时 104.3 ms），**没有**出现秒级退化。已排除，不作为 finding。
2. **注入预算超发**：怀疑 `- 40` 的预留不够覆盖 80 字标题。实测 1200 预算 → 实际 976 / 1062，**没有超发**。只有分配不公（F-RC-11）。
3. **`estimateTokens` 对 emoji 高估**：`charCodeAt > 0x2e80` 把代理对的两个 code unit 都当 CJK，emoji 会被算成 2 个字。只影响展示用的 `tokens` 数字，不影响预算（预算按字符），未构成用户可见问题。
4. **`refreshInjectionCache()` fire-and-forget 与写入并发**：`pre-step` 里 `refreshInjectionCache()` 不 await，理论上可能与 `runMaintenance` 的写并发读到半截文件。没有构造出可复现的时序（`store.list()` 是逐文件读，单文件写入是原子的），**未证实**。
5. **`recall` 的同标题去重**（`kind + 归一化标题`）会丢掉同标题不同内容的第二条：这是注释里写明的「同主题去重」，未按 bug 报；但它和 F-RC-10 的重复注入叠在一起会让用户看到「明明有两条，只召回一条」。

## 建议补的回归测试

1. **BM25 归一化**：单条 dormant 池 + 只共享一个 bigram → 断言 `lexical < 0.5`（当前会得到 1.0）；活跃/休眠同池可比（同一份内容在两个池里 lexical 相同）。
2. **分词**：`tokenize('memory.')` 必须包含 `'memory'`；`recall([英文句末记忆], 'memory')` 命中。
3. **excerpt**：英文查询应选中含实义词的行，而不是含冠词的第一行。
4. **注入 query 的来源**：模拟「user 消息 + assistant 文本」的 messages，断言 `lastInjection().query === 用户那句话`；两个 session 交替 pre-step，断言各自的注入块不同。
5. **休眠 + 注入**：dormant 条目被注入 N 轮后，`planPurge` 不得返回它（`injected > 0` 视为用过）。
6. **面板文案与行为一致**：dormant / stale 的 `reason` 文案必须与 `recall()` 的实际行为对齐（现在测试只断言 code）。
7. **minScore**：`minScore` 从 0.18 调到一个更高的值必须改变结果（或删掉这个配置项）。
8. **空 query**：`buildInjection(all, '')` 不得产生「相关召回」块。
9. **维护不动用户资产**：P0 / `source:'user'` 的重复条目不得被自动标 stale。
10. **性能基线**：400 条 × 8k 字的 `buildInjection` 加一个上限断言（例如 < 100 ms），防止将来再加一层全量扫描。
