# 存储层与作用域 审计报告（lib/store.js / paths / queue / guard / antiseptic）

> 审计对象：`<REPO_DIR>`，git `9b6d190`
> 审计方式：只读；所有实验都在 `os.tmpdir()` 下的一次性 `DSH_HOME` 里跑，未读写真实 `~/.dsh/memory`、`~/.dsh/sessions`、`~/.dsh/state.json`。
> 脚本目录：`.audit/store/`（每个 finding 一个可独立复跑的 `.mjs`，公共夹具 `_harness.mjs`）。

## 概览

### 读了哪些文件

- `lib/store.js`（全文 592 行）、`lib/paths.js`、`lib/queue.js`、`lib/guard.js`、`lib/antiseptic.js`
- `lib/policy.js`（`isProtected` / 生命周期 / 淘汰 / 评分相关段）
- `lib/index.js`（`runMaintenance`、`touchMemory`、`memfuse_write`、`memfuse_feedback`、`writeCandidate`、`approveSkill` 等调用点）
- `test/plugin.test.mjs`、`test/smoke.mjs`（确认已有覆盖，避免把设计报成 bug）
- `docs/spec.md` §3.7 / 缺陷 36 / 生命周期与维护、`docs/NEXT.md`、`docs/HANDOFF.md`（相关段）

### 实际执行过的命令

```
git rev-parse --short HEAD                 → 9b6d190
git status --porcelain                     → 仅 ?? docs/audit/（审计前）
pnpm test                                  → node --test 110/110 + client 50/50 + preview 5/5 + smoke 23/23 = 188 全绿，exit 0
node .audit/store/probe-roundtrip.mjs      → 往返探测（标量 / 数组 / 真文件 / BOM / 坏 tags）
node .audit/store/probe-fuzz-scalar.mjs    → 50000 条随机字符串往返（除已列两类外 0 失败）
node .audit/store/f01-quote-roundtrip.mjs
node .audit/store/f02-tags-string-crash.mjs
node .audit/store/f02b-maintenance-abort.mjs
node .audit/store/f03-bom-encoding.mjs
node .audit/store/f04-rename-breaks-remove.mjs
node .audit/store/f05-path-traversal.mjs
node .audit/store/f05b-traversal-delete.mjs
node .audit/store/f06-concurrent-write.mjs
node .audit/store/f07-lock-stale-steal.mjs
node .audit/store/f08-cross-workspace-lock.mjs
node .audit/store/f09-stale-protected.mjs
node .audit/store/f10-shadowed-scope.mjs
node .audit/store/f11-queue-silent.mjs
node .audit/store/f12-guard-coverage.mjs
node .audit/store/f13-lock-in-git.mjs
node .audit/store/f14-silent-read.mjs
node .audit/store/f15-index-active-only.mjs
```

### finding 计数

| 严重度 | 数量 | 编号 |
|---|---|---|
| blocker | 0 | — |
| high | 4 | F-ST-02 / 04 / 05 / 09 |
| medium | 7 | F-ST-01 / 03 / 06 / 07 / 08 / 10 / 12 |
| low | 4 | F-ST-11 / 13 / 14 / 15 |

一句话结论：**正常路径（add / replace / delete / 过期 / 淘汰 / 三作用域）能跑通；坏在"外部改过的文件"和"并发/多进程"这两类边界上，而且坏的方式大多是静默的**——删除报成功但没删、维护写成功但对象是另一份文件、写失败但内容已落盘。最值得先修的是 F-ST-04（文件名与 id 不一致导致读写视图分裂）和 F-ST-02（一个手改文件让所有写路径报失败）。

---

## 发现

### F-ST-01 frontmatter 往返仍不对称：整段被引号包住的字符串会丢引号，tags 里带引号/撇号会被合并成一项
- 严重度：medium
- 位置：`lib/store.js:54-63`（`parseScalar` 剥引号）、`lib/store.js:112-133`（`needsQuote` 不含首尾 `"` / `'`）、`lib/store.js:66-95`（`splitTopLevel` 在数组里把 `'`/`"` 当引号起点，但 emit 不给这种元素加引号）
- 复现：`.audit/store/f01-quote-roundtrip.mjs`，命令 `node .audit/store/f01-quote-roundtrip.mjs`
- 实际：

```
=== 标量 ===
in="\"被引号包住\"" → emit="\"被引号包住\"" → back="被引号包住"  FAIL
in="'single quoted'" → emit="'single quoted'" → back="single quoted"  FAIL
in="第一行\n第二行" → emit="第一行 第二行" → back="第一行 第二行"  FAIL

=== tags 数组 ===
in=["a\"b","c"] → emit="[a\"b, c]" → back=["a\"b, c"]  FAIL
in=["it's","c"] → emit="[it's, c]" → back=["it's, c"]  FAIL

=== 真文件往返（write → read） ===
title = "用户原话：不要让我一个一个去发现 bug"      （原值首尾各有一个双引号）
tags  = ["user's, preference"]                      （原值 ["user's","preference"]）
维护式写回之后：
title = "用户原话：不要让我一个一个去发现 bug"
tags  = ["user's, preference"]
```

- 期望：`parseScalar(emitScalar(v)) === v`（文件头注释里承诺的"严格对称"，2026-10-15 已修过三处）；tags 的元素边界不能因为元素里有一个撇号就消失。
- 影响：模型/用户给标题加引号（很常见：引用用户原话）时，**任何一次 read→write**（维护转 dormant、setPriority、feedback、replace、supersede）都会把首尾引号永久删掉；tag 里带 `'`/`"`（英文 `user's`、`don't`）时，**两个 tag 会被合并成一个**，而 tags 在打分里权重 3（与 anchor 并列最高）→ 召回命中/排序被改变。注意这是**一次写回就永久改变**，不是显示问题。
- 建议修法：`needsQuote()` 增加"首字符是 `'` 或 `"`"与"尾字符是 `'` 或 `"`"两条；`splitTopLevel()` 只在引号是**元素首字符**时进入 quote 状态（或 emit 数组元素时统一走 `emitScalar` 的 quoting 判定，element 已带引号则整体包一层）。
- 备注：换行折空格是**有意设计**（行式 frontmatter 无法往返），不算此条；fuzz 50000 条里除"整体引号"和"换行"外没有别的失败类别。

### F-ST-02 一个手改坏的文件（`tags: pnpm, tooling` 写成字符串）会让所有写路径报"写入失败"，但记忆其实已经落盘；维护也会中途崩掉
- 严重度：high
- 位置：`lib/store.js:274`（`(r.tags || []).map(...)` 假定 tags 一定是数组）、`lib/store.js:576-588`（`rebuildIndex` 不捕获）；调用侧：`lib/index.js:2036-2049`、`3004-3008`、`3279-3283`、`3299-3303`、`3334-3338`、`3363-3367`（都是 `store.write()` 成功后紧跟 `await store.rebuildIndex()`，包在 `mutate()` 里）
- 复现：`.audit/store/f02-tags-string-crash.mjs`、`.audit/store/f02b-maintenance-abort.mjs`
- 实际：

```
memfuse_write add 返回： {"ok":false,"error":"(r.tags || []).map is not a function"}
磁盘上的文件： m_handedit.md, m_mwu84ilh_y1geym.md
新记忆是否已经落盘： 是 → m_mwu84ilh_y1geym.md
落盘内容： {"title":"新写入的一条","body":"正文"}
```

```
runMaintenance 抛错： TypeError (r.tags || []).map is not a function
m_expired 的 lifecycle = dormant   （已经写盘，但调用方拿不到结果 → state.lastMaintenance 不更新）
```

- 期望：一个字段形状不对的文件只影响它自己（至少 `renderIndex` 要按"tags 不是数组就跳过/降级"处理），不能把整个库的所有写操作连坐；写工具"失败"时磁盘上不应已经多出一条用户看不见的记忆。
- 影响：用户按 YAML 习惯手写 `tags: pnpm, tooling`（这是合法 YAML，但本项目解析成字符串）之后——① 之后每一次 `memfuse_write add/replace/delete/revive/supersede`、以及所有走 `writeCandidate()` 的路径（`memfuse_extract` 的 auto 模式、`memfuse_write mode=approve`）**全部返回失败**，错误原文是 `(r.tags || []).map is not a function`；② 但 add 的记忆**已经写进库、下一轮就会被注入**，用户以为没写成功，再写一遍就重复；③ 启动维护在标完 dormant 后崩，`status.md` 的"上次维护"永远不更新。
- 建议修法：`renderIndex()` 里 `const tags = Array.isArray(r.tags) ? r.tags : []`（或在 `list()` 归一化 tags）；`rebuildIndex()` 把单个根的渲染失败降级成 `lastListError`/状态行，不抛给写路径；写工具在 `write()` 成功、`rebuildIndex()` 失败时应回报"已写入，索引重建失败"而不是笼统"写入失败"。
- 备注：drift guard 只保护"读不懂的文件"，这个文件读得懂但字段类型错，正好落在保护之外。

### F-ST-03 外部编辑器改过的文件（UTF-8 BOM / UTF-16LE / 无 frontmatter / 块状 YAML）会被当成"没有元数据的记忆"列出来，索引写 `undefined`，而写路径又拒修 → 永久卡死
- 严重度：medium
- 位置：`lib/store.js:29`（`FM` 锚定 `^---`，不认 BOM）、`97-110`（解析失败就 `{data:{}, body:text}`）、`171-183`（`isCanonical` 同样不认 BOM）、`362-381` / `465-522`（read/list 把坏文件当正常记录）、`583`（索引行）
- 复现：`.audit/store/f03-bom-encoding.mjs`
- 实际：

```
[m_bom] isCanonical=false
  title = undefined | summary = undefined
  body 前 60 字 = "---\nid: m_bom\nkind: fact\npriority: P1\ntitle: 记事本保存过的记忆\nsumma"
[m_utf16] isCanonical=false
  title = undefined | summary = undefined
  body 前 60 字 = "-\u0000-\u0000-\u0000\n\u0000i\u0000d\u0000:\u0000 ..."
[m_plain] isCanonical=true
  title = "正常的记忆"
[m_block] isCanonical=false        ← 标准 YAML 块状写法
  title = "块状写法" | summary = "|"   （应为"多行摘要"；tags 也解析成 null）
[m_note] isCanonical=false          ← 丢了 frontmatter 的纯笔记
  title = undefined

list() 见到的条目： m_block(title="块状写法"), m_bom(title=undefined), m_note(title=undefined), m_plain(title="正常的记忆"), m_utf16(title=undefined)
index.md 里这两条长这样：
   "- [P2] undefined  <!-- m_bom -->"
   "- [P2] undefined  <!-- m_utf16 -->"
维护写回被拒： DriftError → 这条记忆永远无法被正常维护（过期/淘汰/修正都做不到）
```

把同形状记录直接喂给 `buildInjection`（`lib/inject.js:66`）时，空标题 + 原始 frontmatter 行会进上下文：`"- [P1]  — title: 记事本保存过的记忆"`。

- 期望：`list()` 对"没有 frontmatter / 编码不对"的文件要么跳过并在 `lastListError` / status 里报一条"有 N 个文件不是本插件格式"，要么至少标记出来；不能装作是一条正常记忆，又把它的 `title` 渲染成 `undefined`。写路径也不该让用户陷入"看得见、改不动、删不掉"（删除倒是能按文件名删掉，但界面上没有标题）。
- 影响：Windows 记事本"UTF-8 带 BOM"、PowerShell 5.1 `Out-File`（默认 UTF-16LE）都会触发。用户看到一条**没有标题**的记忆；打开 `index.md` 看到 `undefined`；它还会占着"记忆库共 N 条"的计数。因为 drift guard 拒写，它永远不会过期/转休眠/被维护，只能手工回到资源管理器删文件。
- 建议修法：读入时剥 BOM（`text.replace(/^\uFEFF/, '')`）并按 BOM/零字节探测给出明确错误；`list()` 把无法解析的记录收集成 `{badFiles: [...]}` 暴露到 status/Block D（不是静默当成正常条目）；`isCanonical` 与 `parseFrontmatter` 共用同一套归一化。
- 备注：`docs/spec.md` 说格式"只支持扁平标量/数组子集"，块状 YAML 不在承诺内——但"不支持的格式被当成正常记忆"仍然违反硬规则 4（不许静默失败）。

### F-ST-04 文件名 ≠ frontmatter id 时：删除报成功但没删、replace/维护写出第二份文件、`list()` 与 `read()` 各认一份、过期永远不生效
- 严重度：high
- 位置：`lib/store.js:355-359`（`filePath()` 用 `id+kind` 重建路径）、`448-462`（`remove()` 同样重建）、`400-439`（`write()` 也按 `rec.id` 落盘，而不是用读到的 `_path`）、`504-507`（`list()` 给了 `_path` 却没人用）；调用侧 `lib/index.js:3298-3305`（delete 不检查 `remove()` 的返回值）、`464-476`（markDormant 用 `store.write`）
- 复现：`.audit/store/f04-rename-breaks-remove.mjs`
- 实际：

```
目录： 0-pnpm-约定.md
list() → {"id":"m_abc123_def456","_path":"0-pnpm-约定.md","body":"原始正文"}

① store.remove(rec.id, rec.kind, rec.scope) = false | 文件还在？ 在
② 目录： 0-pnpm-约定.md, m_abc123_def456.md
   list() 读到： "原始正文"        （旧文件名字母序在前，继续遮蔽新文件）
   read(id) 读到： "改过的正文"    （直接拼 id → 读到新文件）
③ 维护 markDormant 之后：list() 的 lifecycle = undefined （应为 dormant；实际还是旧文件的 active）
   磁盘文件： 0-pnpm-约定.md, m_abc123_def456.md
```

- 期望：`list()` 已经把 `_path` 带出来了，删除/写回就该操作**它刚刚读到的那份文件**；`memfuse_write mode=delete` 必须在 `remove()` 返回 false 时报错，而不是回 `{"ok":true,"deleted":...}`。
- 影响：插件把"纯文本、人类可读、可 git、可迁出"当卖点，用户把 `m_3f2a.md` 改成 `pnpm-约定.md` 是再自然不过的操作。改完之后：① **点删除 → 提示成功，但记忆还在，下一轮继续注入**（用户无法删除一条记忆，且以为删了）；② 点修改 → 插件写出一份新的 `m_xxx.md`，列表里看到的还是旧内容（取决于文件名排序），但 `read()` 又是新内容 → 面板/召回/反馈三处可能看到两个版本；③ 过期/预算淘汰把 dormant 写进新文件，`list()` 仍从旧文件读 active → **这条记忆永远不睡，每轮维护都重复处理它**。
- 建议修法：`remove()`/`write()` 接受并优先使用 `rec._path`（只允许位于该 scope 的两个 bucket 内，做 `path.resolve` 前缀校验）；`filePath()` 对 id 做 `path.basename` 或白名单校验；`memfuse_write delete` 检查返回值。
- 备注：与 F-ST-05 同根（id 被当成可信路径片段），建议一起修。

### F-ST-05 id 未做任何校验就拼路径：`memfuse_feedback` 的 id 能读记忆根之外的任意 `.md`；记忆文件里的 `id: ../../x` 能让 `memfuse_write delete/replace` 删改根外文件
- 严重度：high
- 位置：`lib/store.js:355-359`（`path.join(root[bucket], `${id}.md`)`，无 `basename`/前缀校验）、`362-381`、`448-462`；入口：`lib/index.js:3435`（`memfuse_feedback` 的 `id` 只声明 `type: string`）→ `3449 st.read(id)`；`lib/index.js:3294-3305`（按标题找到 target 后，`target.id` 直接进 `remove`）、`3322-3338`（replace 写 `target.id`）
- 复现：`.audit/store/f05-path-traversal.mjs`（store 层）、`.audit/store/f05b-traversal-delete.mjs`（真实工具端到端）
- 实际：

```
① read("../../victim") = {"id":"victim","title":"记忆根之外的文件","_path":"<tmp>/victim.md"}
③ remove("../../victim") = true → 文件还在？ 已删除
```

```
list() 里这条的 id = "../../notes/important"
① delete 返回： {"ok":true,"deleted":"../../notes/important"}
   记忆根之外的受害文件： 已被删除
② replace 返回： {"ok":true,"replaced":"../../notes/important"}
   受害文件正文： "被替换成记忆内容\n"
```

- 期望：id 只允许 `[A-Za-z0-9_-]`（或与 `newId()` 同形），且拼出来的路径必须 `startsWith(path.resolve(root[bucket]) + path.sep)`；越界直接报错。
- 影响：两条链——① 模型可以按 `memfuse_recall` 返回的 id 调 `memfuse_feedback`，只要那个 id 带 `../`，`read()` 就会把根外任意 `.md` 读进来（标题/置信度等信息进工具结果），随后 `touchMemory` 还会在记忆根**内**多写一份 `victim.md`（把库外内容复制进库）；② 记忆库里只要有一个文件把 `id` 写成 `../../notes/important`（手工编辑、从共享/克隆的 memory 仓库进来），用户点"删除这条记忆"或"修改这条记忆"就会**真的删掉/覆盖根外那个文件**，还提示成功。插件把记忆库宣传成可 git、可迁移、可手工编辑的纯文本，这条边界必须守住。
- 建议修法：在 `MemoryStore` 里加一个 `safeId(id)`（拒绝空、`.`、`..`、含 `/` `\`、含 `:` 的 id），`filePath/read/remove/write` 全部过它；对 `_path` 再加一层"必须在 root 内"的 `path.resolve` 校验；`memfuse_feedback` 的 schema 加 `pattern`。
- 备注：需要记忆库里存在带穿越 id 的文件（插件自己不会生成），所以定 high 而不是 blocker；但它和 F-ST-04 是同一个修复点。

### F-ST-06 `write()` 的临时文件名只有 pid：同进程两条并发写同一 id 必然撞同一个 tmp → 56/60 条 ENOENT 或内容互相覆盖
- 严重度：medium
- 位置：`lib/store.js:435`（`const tmp = `${p}.tmp-${process.pid}``）
- 复现：`.audit/store/f06-concurrent-write.mjs`
- 实际：

```
  写失败： ENOENT ENOENT: no such file or directory, rename '...\m_concurrent.md.tmp-29096' -> '...\m_concurrent.md'
60 条并发写：失败 56 条；最终 readable=true title="写手 57" body="内容 57"
目录里残留 tmp 文件： （无）
```

（同一脚本连跑两次结果一致：56/60。）
- 期望：`write()` 声称"先写临时文件再 rename"的原子写，至少同进程内不该互相踩；tmp 名要带 pid + 随机数/计数器。
- 影响：DSH 里 `flushInjected()` 是 fire-and-forget（`lib/index.js:3887`），每轮 pre-step 都会重写上一轮注入过的记忆的 `stats`/`expires`；同一轮模型再调 `memfuse_recall`（`lib/index.js:3150` 也走 `touchMemory`）或用户点"置顶/反馈"，就是两条异步写同一条 → 必有一条 `ENOENT`。`touchMemory` 把它吞成 `logger.warn` + 返回 false（`lib/index.js:1157-1160`）→ **召回计数/注入计数/弱续期静默丢一次**；工具路径则直接给用户"写入失败"。
- 建议修法：`tmp` 用 `${p}.tmp-${process.pid}-${randomUUID()}`（或自增计数）；失败时 `finally` 清 tmp。
- 备注：跨进程因为 pid 不同不会撞，但也不互斥（见 F-ST-08）。

### F-ST-07 锁的"陈旧"判定只看 mtime，而持有者从不刷新：临界区超过 10s 就会被别人抢锁，两段临界区真实重叠
- 严重度：medium
- 位置：`lib/store.js:186-240`（`STALE_LOCK_MS=10_000`、`LOCK_TIMEOUT_MS=5_000`、`withLock()`）
- 复现：`.audit/store/f07-lock-stale-steal.mjs`
- 实际：

```
A enter @4ms
B enter @10211ms  ← 锁在 A 手里，B 却进来了
B exit  @10318ms
A exit  @12007ms
重叠 = true
```

- 期望：要么持有期间定期 touch 锁文件（心跳），要么把 pid 写进锁文件并用"进程是否还活着"判遗弃；"mtime 超过 10s"不能等同于"进程已死"。
- 影响：锁内包含 `git add -A` + `git commit`（`lib/index.js` 的 `mutate` 回调），在记忆库较大 / 杀软扫描 / 慢盘上完全可能 >10s。被抢锁后两个进程同时 `write + rebuildIndex + commit`：`index.md` 互相覆盖、git 索引锁冲突（`commitOrWarn` 只 warn）、后一个 finally 还会把前一个刚建的新锁删掉 → 第三个进程也能进来。`docs/spec.md` 的 A4 写的是"陈旧 10s / 超时 5s"照搬 evolve，但 evolve 的临界区里没有 git 提交，阈值在这里不安全。
- 建议修法：锁文件内写 `pid@时间`；获取失败时先 `process.kill(pid, 0)` 判活，活着就继续等（并给持有者续 mtime）；释放时校验锁内容是不是自己的（token），避免删别人的锁。
- 备注：`spec.md:983` 明确"锁文件并发单测覆盖、真机没造"，这条就是没造出来的那部分。

### F-ST-08 锁只包住工具写路径、且只按 workspace 根建：注入计数/启动维护不拿锁会丢更新，跨工作区写共享 user 根互不排斥
- 严重度：medium
- 位置：`lib/store.js:384-391`（`lockPath` 恒为 `this.root.meta/.lock`）、`lib/index.js:1086-1160`（`touchMemory` 的 read-modify-write 直接 `store.write`，没有 `locked()`）、`lib/index.js:455-536`（`runMaintenance` 没有 `locked()`）
- 复现：`.audit/store/f08-cross-workspace-lock.mjs`
- 实际：

```
A 读到 recalled=0 → 写回 1
B 读到 recalled=0 → 写回 1
① 两次召回之后 recalled = 1 （期望 2）

② A 的锁： <home>\ws-a\memory\.memory\.lock
   B 的锁： <home>\ws-b\memory\.memory\.lock
   两者是同一个文件吗？ 否 ← 但它们写的是同一个 user 根
   A enter
   B enter
   A exit
   B exit
   最终计数 = 1 （期望 2）
   共享 user 文件最后是谁写的： title: B 写的
```

- 期望：凡是"读-改-写"同一条记忆都要进锁；锁的作用域应该覆盖**实际写入的根**（写 user/global 时锁 user/global 根，或统一用 `DSH_HOME` 下的库级锁）。
- 影响：① desktop + web 两个 profile 同时召回同一条记忆时，`recalled/injected/sessions/sessionCount/expires` 每次丢一半——`shouldPromote`（跨 3 个会话升 P1）会被拖慢，弱续期可能失效；② `user` 级"跨工作区共享"正是靠同一个 `~/.dsh/memfuse-user`，两个工作区（不同 `memory.root`）却各有各的锁文件 → 同时写同一条 user 记忆时 last-writer-wins，且各自重建的 user `index.md` 会互相覆盖。
- 建议修法：`locked()` 接受目标 scope/root，锁文件放到被写根下（或所有写统一用 `dshHome` 下的一把库级锁）；`touchMemory` 与 `runMaintenance` 也走 `store.locked()`（注意 `withLock` 不可重入，要把内部的多次 `write` 合并到一次 `locked` 里）。
- 备注：`docs/spec.md` 只承诺 A4 把"write+rebuildIndex+commit"串行化（三个写分支 + add/revive），没承诺统计路径；但统计丢失会直接改变召回/升级行为，不是纯日志。

### F-ST-09 `planStale` 不检查 `isProtected()`：维护会把 P0 / `source:user` 的记忆自动标 `stale`（跨作用域也中招），违反硬规则 5
- 严重度：high
- 位置：`lib/antiseptic.js:84-93`（`planStale` 只按 `kind==='exact'` 过滤）、`lib/policy.js:251-253`（`isProtected` 定义了却没用在这里）、`lib/index.js:519-533`（维护直接 `store.write({...rec, stale:true})`）
- 复现：`.audit/store/f09-stale-protected.mjs`
- 实际：

```
维护结果：staled = 1 | dupClusters = 1
m_user_p0 → priority=P0 source=user stale=true supersededBy=m_auto_p2
m_auto_p2 → priority=P2 source=auto stale=undefined supersededBy=undefined

第二次维护：staled = 1 | 用户级 user 资产 → stale = true supersededBy = m_ws_auto
```

- 期望：`AGENTS.md` 硬规则 5 / `policy.isProtected()` 的语义是"P0 / source:user / managedBy:user 不被自动改动"；`planEviction` / `planPurge` 都遵守了，`planStale` 漏了。至少要跳过受保护记录，或只允许"自动产生的两条之间"互相标。
- 影响：用户手写的 P0/P1 只要和一条**更新的自动抽取产物**完全重复（自动抽取重复写同一条很常见），用户那条就会被自动打上 `stale`（打分 −0.20），并且写 `supersededBy` 指向自动条目。P1 会因此掉到 0.18 阈值以下**静默不再被召回**；P0 虽然仍常驻，但这是对"用户资产不被自动改动"承诺的直接违背。跨作用域同样发生（用户级那条被工作区的自动副本标 stale）。
- 建议修法：`planStale` 里 `if (isProtected(m)) continue`（或者仅当簇内**没有**受保护成员时才自动标）；已在 `stale` 的记录不再重复写。
- 备注：`docs/spec.md:973-975` 专门写了 `isProtected` 三条件，"用户资产永远不会被自动转休眠/淘汰"——这条是同一承诺在 stale 路径上的缺口。

### F-ST-10 同 id 在低作用域也有一份时，`list()` 遮蔽它 → 这份副本永不过期、不进索引、不可维护
- 严重度：medium
- 位置：`lib/store.js:465-522`（`list()` 用 `seen` 去重，只返回高优先级那份）、`576-588`（`rebuildIndex` 只遍历 `list()` 结果）；`lib/index.js:455-536`（维护同样只遍历 `list()`）
- 复现：`.audit/store/f10-shadowed-scope.mjs`
- 实际：

```
维护前 list() = workspace/dup
维护：expired = 1 dormant = 1
workspace 副本 lifecycle = dormant
user 副本   lifecycle = undefined | expires = 2026-11-23T05:00:41.034Z （早已过期）

user 根的 index.md： "（没有这条）"
user 根里的文件： dup.md
```

- 期望：`list()` 对外的"同名只认最高优先级"可以保留（`S2` 测试锁的就是这个），但**维护和索引**应该能看到所有根里的文件；至少让低优先级副本能过期/被清理，或在索引里标出"被 workspace 遮蔽"。
- 影响：`user`/`global` 级的设计目的就是跨工作区共享；一旦用户在工作区也写了一条同 id 的记录（或旧版本遗留），用户级那份就变成**隐形僵尸**：不注入（被遮蔽）、不淘汰（维护看不到）、不在 `index.md`（用户以为没这条）、也不能通过面板操作（面板基于 `list()`）。它只会在 workspace 那份被删掉之后突然"复活"，内容却是很久以前的。
- 建议修法：`list()` 增加 `{ allScopes: true }`（或内部分 `listRaw()`）供 `runMaintenance`/`rebuildIndex` 使用；索引行为可以保留"每根自己的"，但要把被遮蔽的条目也渲染出来（或至少计数）。
- 备注：需要产品决策——遮蔽语义本身是设计（`S2` 用例），本条说的是"遮蔽之后没人维护它"。

### F-ST-11 待确认队列的静默：坏 JSON 被无痕丢弃（注释承诺"计数"但没有）、`dropPending` 失败被忽略、并发 `putPending` 撞 tmp
- 严重度：low
- 位置：`lib/queue.js:47-67`（`listPending` `catch {}`，"坏文件跳过并计数"但没有 count）、`70-79`（tmp 同样只带 pid）、`98-105`（`dropPending` 任何错误都返回 false）；调用侧 `lib/index.js:3221`、`3227`（不检查返回值）
- 复现：`.audit/store/f11-queue-silent.mjs`
- 实际：

```
目录里的文件： broken.json, 好的一项-pok.json
listPending() = 1 项： p_ok ← broken.json 静默消失，没有计数/告警
  并发入队失败： ENOENT ENOENT: no such file or directory
20 次并发 putPending(同一项)：失败 16 次
```

- 期望：`listPending` 返回 `{items, badCount}`（或把坏文件改名 `.bad` 并在 status 留一行）；`dropPending` 失败要冒泡给工具；tmp 名加随机数。
- 影响：① 用户在队列里看不到某条候选，以为它被自己处理过了（或从来没抽到），**没有任何可查的痕迹**；② 队列文件删不掉时（被杀软/句柄占用）`approve/reject` 仍回 `{ok:true}`，下次列表里它还在——重复 approve 会写出两条重复记忆；③ 同一项被并发入队（抽取重试/两个进程）时会丢一条。
- 建议修法：`listPending` 返回计数并在 `status.md` 体现；`dropPending` 失败时让 approve/reject 返回错误；tmp 名带随机后缀。
- 备注：真实状态里 pending 已 101 条（`docs/NEXT.md`），队列的"看得见"很重要，建议和 F-ST-02 一起做"派生视图失败要可见"的收口。

### F-ST-12 凭据过滤可被绕开：`tags` 不在扫描范围、队列 `approve` 路径完全不过 guard；`Authorization: Basic` / `AccountKey=` 等模式漏检
- 严重度：medium
- 位置：`lib/index.js:3202-3211`（`haystack = [title, summary, body, anchor]`，无 tags）、`lib/index.js:2023-2051`（`writeCandidate` 直接 `store.write`，无 `scanThreat`）、`lib/index.js:3213-3235`（approve 走 `writeCandidate`）；`lib/guard.js:24-33`（模式表）
- 复现：`.audit/store/f12-guard-coverage.mjs`
- 实际：

```
scanThreat(secret) = "OpenAI 风格密钥" （同一段文字放进正文会被拒）
① tags 里带凭据 → {"ok":true,"id":"m_mwu8a8wt_tzd242",...}
   落盘 tags = ["api_key=sk-live-abcdefghijklmnop"]
② approve 带凭据的候选 → {"ok":true,"approved":"p_secret","memoryId":"m_mwu8a8x5_3f1cxf",...}
   落盘正文 = "部署笔记：api_key=sk-live-abcdefghijklmnop"
```

模式表漏检（`node -e` 直接调 `scanThreat`）：

```
"Authorization: Basic dXNlcjpwYXNzd29yZA==" -> null
"AccountKey=abcdefghijklmnopqrstuv=="        -> null
"token=abcdefghijklmnop"                     -> null
"password: hunter2hunter2"                   -> 凭据赋值
"-----BEGIN OPENSSH PRIVATE KEY-----"        -> 私钥块
```

- 期望：guard 的承诺是"显式写入拒绝、捕获路径替换"，那么**所有**把内容写进记忆库的入口都要过同一套扫描（至少 add/replace/approve 三条），字段范围要包括 tags；`Authorization: Basic`、`AccountKey=` 这类最常见的凭据形式不该漏。
- 影响：记忆会被注入每轮上下文、进 git、进 status、进 usage——凭据一旦进去就是扩散。现在只要把凭据放进 `tags` 或者走"抽取 → 待确认 → 采纳"，就完全没有拦截；用户会以为这个插件"有凭据过滤"。
- 建议修法：把 `scanThreat` 收口到 `writeCandidate` / `store.write` 之前的唯一入口（或用 `redactThreats` 统一替换），haystack 加 `tags.join('\n')`；模式表补 `Authorization:\s*Basic`、`AccountKey=`、`(?:access_)?token=`。
- 备注：误拒是设计（宁可误拒一条记忆），所以补模式表的风险可接受。

### F-ST-13 记忆库的 git 仓库每次提交都包含 `.memory/.lock`，退出锁后永久留一条 ` D .memory/.lock`
- 严重度：low
- 位置：`lib/store.js:384-391`（锁路径在 `.memory/.lock`）、`549-555`（`commit()` 用 `git add -A`）
- 复现：`.audit/store/f13-lock-in-git.mjs`
- 实际：

```
git log：
c87843d memfuse: add m_g2
M	.memory/.lock
M	index.md
A	memories/m_g2.md

e823d96 memfuse: add m_g1
A	.memory/.lock
A	index.md
A	memories/m_g1.md

git status（每次退出锁后都会留下这条）： " D .memory/.lock\n"
```

- 期望：锁文件是运行时产物，不该进 git；`commit()` 应该有选择地 `git add` 记忆文件，或在记忆根写 `.gitignore`（`.memory/.lock`、`*.tmp-*`、`.memory/*.tmp*`）。
- 影响：用户的记忆库 git 历史被 PID/时间戳污染（每个进程不同），且工作区**永远 dirty**——"nothing to commit"短路永远不生效，每次写都产生一次提交；用户自己 `git commit` 时会把锁文件一起提交。不丢数据，但破坏"记忆库可审计"的体验。
- 建议修法：`init()` 时写 `.gitignore`（`*.tmp-*`、`.memory/.lock`）；`commit()` 用 `git add -A -- . ':(exclude).memory/.lock'` 或显式 `add memories skills index.md`。
- 备注：`store.commit` 的返回值已经被 `commitOrWarn` 检查，这条只影响历史整洁。

### F-ST-14 `read()` 把"读失败"折叠成"不存在"；`listAdhoc()` 的 catch-all 让读不出来的笔记看起来像"没有笔记"
- 严重度：low
- 位置：`lib/store.js:362-381`（非 ENOENT 只记 `lastListError` + warn，然后 `return null`）、`525-543`（`listAdhoc` 全部 `catch { return [] / ignore }`）；调用侧 `lib/index.js:3449-3450`
- 复现：`.audit/store/f14-silent-read.mjs`
- 实际：

```
① store.read(目录名) = null | lastListError = "m_broken: EISDIR: illegal operation on a directory, read"
   memfuse_feedback 返回： {"ok":false,"error":"未找到 id 为 m_broken 的记忆"}
② listAdhoc() = [{"name":"ok.md","text":"正常笔记"}]   （notes.md 是个目录，被静默跳过）
```

- 期望：`read()` 区分"不存在"与"读不出来"（返回 `null` vs 抛错/返回 `{error}`）；`memfuse_feedback` 应显示"读取失败：EISDIR…"而不是"未找到"。
- 影响：磁盘/权限/文件被占用的真实故障会被用户读成"这条记忆不存在"，排障时最容易走错方向（项目硬规则 4 明确点名过这种"读不到输入也要留痕"）。触发条件不常见，故 low。
- 建议修法：`read()` 把非 ENOENT 包成 `ReadError` 抛出（`memfuse_feedback` 捕获后原样显示），或返回 `{missing:true}` / `{error}` 两态；`listAdhoc` 收集失败文件名返回给 status。
- 备注：`read()` 设置 `this.lastListError` 是个好习惯，但工具层没读它。

### F-ST-15 `index.md` 只统计 active 条目：真机上 113/119 条休眠记忆从"总索引"里消失
- 严重度：low
- 位置：`lib/store.js:583`（`rows = all.filter(r => r.scope === scope && (r.lifecycle || 'active') === 'active')`）、`lib/store.js:266`（`共 ${rows.length} 条`）
- 复现：`.audit/store/f15-index-active-only.mjs`
- 实际：

```
[workspace] "> 自动生成，请勿手工编辑。共 1 条。"
          条目： - [P1] 还在用的  <!-- m_live -->
[user] "> 自动生成，请勿手工编辑。共 1 条。"
          条目： - [P2] 用户级的一条  <!-- m_user -->
store.list() 实际条数 = 3 （含 dormant）
```

（现场真实状态是 `total 119 / active 6 / dormant 113`，见 `docs/NEXT.md`——`index.md` 会写"共 6 条"。）

- 期望：作为"L0 总索引"的派生视图，要么把 dormant 也列出来（标 `[dormant]`），要么在头部写清"active 6 / 共 119"，不要让读者以为记忆丢了。
- 影响：用户打开 `index.md`（插件把纯文本索引当卖点）看到只有 6 条，而面板/status 说 119 条 → "我的记忆是不是被删了"。纯体验/信任问题，不影响功能。
- 建议修法：`renderIndex` 分两段（Active / Dormant）或头部计数写成 `共 N 条（active X）`。
- 备注：需要产品决策——如果"总索引"的本意就是"当前在用的"，那至少把计数写准。

---

## 未能证实（可疑但没复现出来）

- **`write()` 的 drift guard 是 TOCTOU**：`fs.existsSync(p)` → `readFile` → `writeFile(tmp)` → `rename`，中间没有锁；如果另一个进程在这段时间改坏文件，会被静默覆盖。逻辑上成立，但需要精确的进程调度，没能稳定复现（不写进 finding）。
- **`index.md` 的 `fsp.writeFile` 不是原子写**：并发重建时读者可能看到 0 字节/半截索引。索引是派生视图且代码不读它，只在人/git 侧可见；试了几次没抓到截断窗口，暂列可疑。
- **断电/蓝屏后 rename 前没 fsync**：NTFS 延迟分配可能导致 rename 后内容为空。无法在本机复现（需要真实掉电），只作为"原子写"承诺的边界提示。
- **`usage.jsonl` 无轮转**：每次召回/注入/反馈都追加一行，长期使用会无界增长。没量化，属于运维问题不是缺陷。
- **`paths.js:29 rootForScope()` 是死代码**：全仓库无调用；但默认参数 `config?.dshHome` 会落到真实 `~/.dsh`，将来谁用它写测试就会污染真实库。建议删除或改成与 `MemoryStore.rootOfScope` 同一实现。
- **`store.list()` 的 `seen` 检查在并行 map 里其实是死代码**（`seen.add` 在 await 之后的循环里），目前靠后面的循环兜底，行为正确；只是读代码容易误判，建议删掉那行。
- **`index.md` 是否应包含 dormant**：已作为 F-ST-15 的可选项列出，需要产品拍板。

## 建议补的回归测试

1. `frontmatter 往返：title = '\"引号\"' / tags = [\"a\\\"b\", \"c\"] / [\"it's\",\"c\"]` → 读回必须逐字相等（F-ST-01）。
2. `tags 写成字符串（tags: pnpm, tooling）` → `rebuildIndex()` 不抛；`memfuse_write add` 必须成功且只写一条（F-ST-02）。
3. `BOM / UTF-16LE / 无 frontmatter` 文件 → `list()` 要么跳过并给出 `badFiles` 计数，要么按坏文件报错；`index.md` 不得出现 `undefined`（F-ST-03）。
4. `把 memories/m_x.md 改名` → `remove('m_x')` 仍然删得掉；`memfuse_write delete` 在 `remove()` 返回 false 时必须报错（F-ST-04）。
5. `id = '../../victim'` → `read/remove/write` 必须拒绝（`../`、绝对路径、`a/b`、空 id）；`memfuse_write delete` 不能删到根外（F-ST-05）。
6. `Promise.all(60 次同一 id 的 write)` → 0 失败，最终内容等于其中一次的完整内容（F-ST-06）。
7. `withLock` 持锁 12s，第二个 `withLock` 在 10.2s 进入 → 必须等待，不得重叠；且 A 的 finally 不能删掉 B 的锁（F-ST-07）。
8. `两个 MemoryStore（不同 root、同 dshHome）同时写 user 记忆` → 要么串行，要么后者能看到前者；`touchMemory` 的 read-modify-write 要串行（F-ST-08）。
9. `P0 / source:user 与一条更新的 auto 完全重复` → 维护后受保护记录 `stale` 必须仍为 undefined（F-ST-09）。
10. `同 id 在 workspace + user 都有一份且 user 那条已过期` → 维护后 user 副本应 dormant/被报告，不能永远 active（F-ST-10）。
11. `queue.listPending` 遇到坏 JSON → 返回 `badCount`；`approve/reject` 在 `dropPending` 失败时返回错误（F-ST-11）。
12. `memfuse_write` 的 tags 与 `mode=approve` 路径都必须被 `scanThreat` 拦截（F-ST-12）。
13. `store.init()` 后 `git status` 不得出现 `.memory/.lock`；两次 commit 之间 `nothing to commit`（F-ST-13）。
14. `read()` 遇到 EISDIR/EACCES → `memfuse_feedback` 必须显示原始错误而不是"未找到"（F-ST-14）。
15. `index.md` 头部计数与 `list()` 总数一致（或明确写 active/total 两个数）（F-ST-15）。

---

## 附：本次未触碰的东西

- 未修改 `lib/`、`test/`、`package.json`、`docs/spec.md`、`docs/NEXT.md`、`AGENTS.md`。
- 未做任何 git 操作；未读写真实 `%USERPROFILE%\.dsh\memory` / `sessions` / `state.json`（`f13` 里只在临时目录 `git init` 了一个一次性仓库）。
- 所有脚本都在 `os.tmpdir()` 下建临时 `DSH_HOME`，跑完 `rm -rf`。

---

## 复审（t10）

> 复审对象：t6 针对本报告的修复（`lib/store.js` / `lib/index.js` / `lib/antiseptic.js`，diff `9b6d190..工作区`）。
> 方式：只读。旧 finding 的原始脚本全部重跑（after 输出存 `.audit/store/t10/after-*.txt`）；另写 6 个对手脚本在 `.audit/store/t10/`。
> 基线：`pnpm test` → plugin 128 / client 64 / preview 5 / smoke 23 = **220 全绿**，exit 0（复审时工作区状态）。

### ① 旧 finding 复跑结果

| 编号 | 严重度 | 状态 | after 关键证据 | 脚本 |
|---|---|---|---|---|
| F-ST-02 | high | ✅ 已修 | `memfuse_write add 返回 {"ok":true,...}`；`runMaintenance 返回 {"expired":1,"dormant":1}`（不再 TypeError） | `f02` / `f02b` |
| F-ST-04 | high | ✅ 已修 | `remove(...) = true / 文件还在？没了`；目录只剩 `0-pnpm-约定.md`；`list()` 与 `read()` 都读到 `改过的正文`；`lifecycle = "dormant"` | `f04` |
| F-ST-05 | high | ✅ 已修 | `read('../../victim')` → `Error: 非法记忆 id（含路径分隔符或保留字符）："../../victim"`；坏 id 文件 `list()` 退回 `m_evil`，`delete` 后根外文件"还在" | `f05` / `f05b` |
| F-ST-06 | medium | ✅ 已修 | `60 条并发写：失败 0 条`；`tmp 残留 0` | `f06` |
| F-ST-09 | high | ✅ 已修 | `staled = 0`；`m_user_p0 stale=undefined`；用户级 user 资产 `stale=undefined` | `f09` |
| F-ST-01 | medium | ❌ 仍复现 | `in="\"被引号包住\"" → back="被引号包住" FAIL`；tags 仍合并 | `f01` |
| F-ST-03 | medium | ❌ 仍复现 | BOM/UTF-16 文件 `title = undefined`；`index.md` 仍是 `(无标题)` 之外的值不变 | `f03` |
| F-ST-07 | medium | ❌ 仍复现 | `B enter @10217ms ← 锁在 A 手里，B 却进来了`，`重叠 = true` | `f07` |
| F-ST-08 | medium | ❌ 仍复现 | 两次召回后 `recalled = 1`（期望 2）；两个 root 的 lockPath 仍不同 | `f08` |
| F-ST-10 | medium | ❌ 仍复现 | 被遮蔽的 user 副本 `lifecycle = undefined`（已过期仍 active）；user index 无此条 | `f10` |
| F-ST-12 | medium | ❌ 仍复现 | tags 与 approve 仍落盘 `sk-live-...` | `f12` |
| F-ST-11 / 13 / 14 / 15 | low | ❌ 仍复现 | 坏 JSON 静默消失；`.memory/.lock` 仍进 git；EISDIR 仍报"未找到"；index 仍"共 1 条"而 list 3 条 | `f11` / `f13` / `f14` / `f15` |

**结论：4 条 high + F-ST-06 全部闭环（5/15）；其余 10 条（6 medium + 4 low）仍复现，与 t6 的"只修 high + 个别 medium"口径一致，但尚未收口。**

### ② 修复本身的边界检查（safeId / _path / normalizeTags / 写队列 / 锁 / 错误）

- **safeId**：`..`、`.`、`a/b`、`a\b`、`C:\x`、`C:x`、`\\server\share`、空串/纯空格、`:`、`*`、换行全部拒绝；中文、emoji、`%2e%2e%2f`、`...`、`a..b`、末尾点放行（都只是普通文件名，无穿越）。核心目标达成。
- **isInsideBucket**：目录归属校验有效，但**只做词法比较**（不解析真实路径、不校验文件归属、大小写敏感），见 R-03 / R-04。
- **_path 兜底**：read→write→remove 回到同一份文件已生效（f04 全绿）；但 `_path` 是快照，过期后会复活旧文件（R-05）。
- **normalizeTags**：`tags: pnpm, tooling` 被正确归一成数组，`renderIndex` 不再崩（f02 绿）；代价是引号内的逗号也被拆（R-08）。
- **写队列**：100 条并发（同 id 50 + 新 id 50）0 失败、156ms；DriftError 之后同路径仍可写；30 条 RMW 并发内容完整、无 tmp 残留——**没有死锁**（`.audit/store/t10/attack-queue-deadlock.mjs`）。
- **锁语义**：本次 diff 没有改 `withLock` / `lockPath`，F-ST-07（10s 抢锁）与 F-ST-08（不覆盖统计路径、跨工作区不互斥）**原样存在**。
- **错误是否被吞**：`rebuildIndex()` 改成逐根 try/catch 后，`lastIndexError` 全仓库只有 store.js 自己写、没人读（R-02）；`_issues` 也只有测试断言存在，面板/status 均不展示。

### ③ 对手用例（专门构造）

`.audit/store/t10/attack-id-matrix.mjs`（25 个 id 形态）、`attack-fs.mjs`（符号链接 / _path 伪造 / 同名 scope / 写入中读 / 保留名）、`attack-path-snapshot.mjs`（改名竞态 / 大小写 / 标签语义 / 删除竞态）、`regression-scope.mjs`。

| 用例 | 结果 |
|---|---|
| `..` / `../victim` / `a/b` / `a\b` / `C:\Windows\win.ini` / `C:evil` / `\\server\share\x` / 空串 / `.` / `..` | ✅ 全部 `safeId` 拒绝，write 也拒绝 |
| 中文 id `记忆_中文id` / emoji `🧠_memory` | ✅ 正常读写 |
| 超长 id（300 字符） | ⚠️ `safeId` 放行、write `ENOENT`（路径超限），见 R-06 |
| `CASE_ID` + `case_id` | ⚠️ Windows 同一个文件，后写覆盖（最终目录只有 `case_id.md`），见 R-06 |
| 保留名 `CON` / `NUL` / `COM1` | ⚠️ Node 能建文件，但 `git add -A` exit 128（`error: open("CON.md")`），见 R-06 |
| 符号链接 `memories/m_link.md -> 根外 .md` | ⚠️ `read` 读到根外内容（id 取 frontmatter=`victim`），write 把链接替换成普通文件；根外目标未被改，见 R-03 |
| `_path` 指向另一条记忆的文件 | ⚠️ 整份覆盖另一条（id/title 被改成传入值），见 R-04 |
| 同名不同 scope（workspace + user） | ✅ `remove(userRec)` 只删 user，workspace 保留；写回不回错根（`regression-scope.mjs`） |
| 写入过程中读（3MB 正文 × 200 次读） | ✅ 0 次空/半截，0 tmp 残留 |
| `list`/`read` 之后改名再写 | ⚠️ 旧路径复活一份，见 R-05 |
| `remove` 与并发写 | ⚠️ 记忆复活，见 R-07 |

### ④ 复审新发现

#### R-01 `resolveWritePath()` 让"新增一条记忆"退化成全库扫描：400 条 ×8KB 时 106ms（旧 1.5ms），未命中读 124ms（旧 0.19ms）
- 严重度：medium
- 位置：`lib/store.js:546-556`（`resolveWritePath` 无条件调 `findFileById`）、`lib/store.js:481-507`（逐文件 `readFile` 串行扫描）；调用点：`lib/index.js:2270`（`writeCandidate` 每个候选）、`lib/index.js:3646`（`memfuse_write add`）
- 复现：`.audit/store/t10/bench-write.mjs <old-snapshot>`、`.audit/store/t10/bench-realistic.mjs`
- 实际：

```
预置 400 条记忆 × 2 套
new: 新增一条平均 85.21 ms | 读一个不存在的 id 平均 74.61 ms
old(9b6d190): 新增一条平均 1.54 ms | 读一个不存在的 id 平均 0.19 ms
倍数：新增 55.2× | 未命中读 383.0×
```

```
400 条 ×8KB：新增一条平均 106 ms
未命中 read 平均 124 ms
119 条 ×8KB（现场规模）：新增平均 34 ms
```

- 期望：新增记录是**已知新 id**，没有"改名后旧文件"需要找，应该 O(1) 直接写；只有"从磁盘读到但 `_path` 不可用"的记录才需要按 frontmatter id 兜底扫描。
- 影响：`memfuse_write add` 每条多 30–100ms；`memfuse_extract` auto / approve 每条候选都多一次全库扫描（6 条 ≈ 0.2–0.6s）；`memfuse_feedback` 收到一个不存在的 id 从 0.2ms 变成 75–124ms。记忆库越大、正文越长越慢，且是**串行 readFile**。
- 建议修法：`resolveWritePath` 只在 `rec._fileId` 存在（说明这份记录来自磁盘，可能是改名文件）时才调 `findFileById`；新建记录（无 `_fileId`/`_path`）直接返回 `direct`。或维护一个 id→path 的进程内缓存，在 `list()`/写入后更新。
- 备注：功能正确性没问题，纯粹是 O(N) 回归；t6 的新测试没有性能护栏。

#### R-02 `rebuildIndex()` 失败被彻底吞掉：`lastIndexError` / `_issues` 没有任何出口，违反硬规则 4「派生视图坏了要在 status.md 留一行」
- 严重度：medium
- 位置：`lib/store.js:795-812`（逐根 try/catch 只写 `lastIndexError` + `logger.warn`）、`lib/store.js:71-98`（`_issues` 只挂在记录上）；`grep lastIndexError lib/` → 只有 store.js 自己；`grep _issues` → 只有 test 一行断言
- 复现：`.audit/store/t10/attack-silent-errors.mjs`
- 实际：

```
rebuildIndex 返回 = ...\memory\index.md | 抛错？否
store.lastIndexError = "workspace: EISDIR: illegal operation on a directory, open '...\\index.md'"
memfuse_write add 返回 = {"ok":true,"id":"m_mwu9put5_6lk6um","priority":"P2",...}
memfuse_status 里是否提到索引失败 = false
坏文件 list 记录：id = m_issue | _issues = ["id","tags"]
面板 toViewRow 不拷贝 _issues（lib/memory-view.js:85-114）
```

- 期望：写路径不因派生视图失败而失败（F-ST-02 的目标）**不等于**失败可以不留痕。至少要：`lastIndexError` 进 `memfuse_status` / `status.md` / Block D；`_issues` 汇总成 `badFiles` 计数（"有 N 个文件不是本插件格式，id/tags 已被归一化"）。
- 影响：`index.md` 被外部弄坏（变成目录、只读、磁盘满）之后，每次写都"成功"但索引永远不更新，用户在 `index.md` 里看到的是旧快照；手改坏的文件被静默改写/归一化，用户不知道自己的文件有问题。这是本项目最反对的"静默失败"。
- 建议修法：`rebuildIndex()` 把 `lastIndexError` 交给 `health()`/`writeStatus()`（一行"索引重建失败：…"）；`list()` 的 `_issues` 汇总到 `memfuse_status` 的 `badFiles`（只给计数和人话，不刷屏）。
- 备注：F-ST-02 的修复方向是对的，这条是"修一半"。

#### R-03 符号链接读穿透：`read`/`list` 会跟随 `memories/*.md` 链接读根外文件；写回会把链接替换成普通文件
- 严重度：low
- 位置：`lib/store.js:461-474`（`readFileAt` 直接 `readFile`，不 `lstat`）、`lib/store.js:446-455`（`isInsideBucket` 只做 `path.resolve` 词法比较，不 `realpath`）；`read/remove` 用了 `isInsideBucket`，`read` 没有
- 复现：`.audit/store/t10/attack-fs.mjs` ①
- 实际：

```
read(m_link) = {"id":"victim","title":"根外目标","_path":"m_link.md"}
写回后：根外目标内容 = "id: victim" | 链接还在？ 已被替换成普通文件
根外目标是否被改 = 否
```

- 期望：记忆库目录里的符号链接不应被当成记忆读入；`list()` 应跳过并计入 `badFiles`。
- 影响：另一个插件/手工放一个 `memories/x.md -> C:\some\secret.md`，记忆库就会把它读成记忆（正文/标题可被召回/注入）；链接文件名与 frontmatter id 不一致时还会在 `list()` 里遮蔽同名真记忆。写回会删掉用户的链接本身（数据是链接，不是目标）。需要先有目录写权限，故 low。
- 建议修法：`readFileAt` 先 `lstat().isSymbolicLink()` → 拒绝并记 `lastListError`；`list()` 跳过符号链接；`isInsideBucket` 用 `fs.realpathSync` 复核。

#### R-04 `_path` 只校验"在不在桶目录"，不校验"是不是这条记忆"：`store.write({...recA, _path: recB 的文件})` 可整份覆盖 B
- 严重度：low
- 位置：`lib/store.js:550`（`if (rec._path && this.isInsideBucket(rec._path, scope)) return path.resolve(rec._path)`）
- 复现：`.audit/store/t10/attack-fs.mjs` ②
- 实际：

```
写完之后 m_b.md 的 frontmatter id/title = id: m_a2 / title: 冒充写入
```

- 期望：写回前应确认 `_path` 指向的文件 frontmatter id 与 `rec.id` 一致（或 `_fileId === basename(_path,'.md')`）；不一致时退回按 id 解析。
- 影响：`store.write` 是公开方法；当前所有内部调用都传自己 `_path`，工具/界面不可触达。属"将来新增调用方时容易踩"的加固缺口；一旦传错 `_path`（比如合并两个记录对象）会静默覆盖另一条记忆。
- 建议修法：`resolveWritePath` 里对 `_path` 再做一次归属校验（读 frontmatter id 或比对 `_fileId`），不匹配就走 direct。

#### R-05 `_path` 是快照：`list`/`read` 之后文件被改名，`write` 会在旧路径复活一份（`remove` 有兜底、`write` 没有）
- 严重度：low
- 位置：`lib/store.js:546-556`（`_path` 存在且"在桶内"就直接返回，不检查文件是否还在）；对照 `lib/store.js:634-670`（`remove` 在 ENOENT 后会走 `findFileById`）
- 复现：`.audit/store/t10/attack-path-snapshot.mjs` ①
- 实际：

```
① 改名后再按旧快照写：目录 = m_snap.md, 改过名.md
   list() = m_snap@m_snap.md:v2
```

- 期望：`_path` 不存在时再走一次 `findFileById`，别直接造旧文件。
- 影响：用户在插件运行期间重命名记忆文件，然后马上改优先级/反馈（用的是改名前的快照）→ 旧文件名被复活，目录里出现两份同 id；`list()` 只显示一份，另一份在被删/遮蔽后可能带着旧内容复活。窗口窄（list 与 write 之间），故 low。
- 建议修法：`if (rec._path && this.isInsideBucket(...) && fs.existsSync(rec._path)) return ...`，否则继续按 id 解析。

#### R-06 id 边界：大小写合并 / Windows 保留名让 git commit 永久失败 / 超长 id ENOENT
- 严重度：low
- 位置：`lib/store.js:34-55`（`ID_FORBIDDEN` / `safeId`）、`lib/store.js:439-443`（`filePath`）、`lib/store.js:549-555`（`isInsideBucket` 大小写敏感）
- 复现：`.audit/store/t10/attack-id-matrix.mjs`、`.audit/store/t10/attack-fs.mjs` ⑤
- 实际：

```
CASE_ID     safeId="CASE_ID" write=OK
case_id     safeId="case_id" write=OK
最终目录： ... case_id.md ...（CASE_ID.md 消失：Windows 大小写不敏感，后写覆盖）
设备名 CON    safeId="CON" write=OK
设备名 NUL    safeId="NUL" write=OK
超长 300     safeId="xxx..." write=FAIL:ENOENT
git add -A 退出码 = 128 | stderr = "error: open(\"CON.md\"): No such file or directory"
isInsideBucket(小写盘符) = false（同一文件、大写盘符 = true）
```

- 期望：`safeId` 拒绝 Windows 保留设备名（`CON|PRN|AUX|NUL|COM1-9|LPT1-9`，含带扩展名）；大小写不同的 id 应明确报错或规范化后查重；超长 id 给明确错误（"id 过长"），不要落到 ENOENT。
- 影响：`memfuse_write add` 的 id 由 `newId()` 生成，不经过用户，所以这些形态**不会由正常使用产生**；只有手工编辑 frontmatter、跨平台（Linux 大小写敏感）同步 memory 仓库、或未来某个调用方直接 `store.write({id})` 才会遇到。一旦出现 `CON.md`，记忆库 git `add -A` 永远 128（`commitOrWarn` 只 warn），大小写两条则静默合并。
- 建议修法：`ID_FORBIDDEN` 之外再加 `RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i`；`safeId` 返回规范化 id 时对 Windows 做 lower-case 查重提示；长度 > 200 直接报"id 过长"。
- 备注：不是本次修复引入的功能回归，是 `safeId` 新增后暴露出来的边界口径问题。

#### R-07 `remove()` 不进写队列：删除与 `touchMemory` 式写并发时记忆会复活
- 严重度：low
- 位置：`lib/store.js:634-670`（`remove` 直接 `unlink`，不进 `_writeQueues`）、`lib/store.js:373/614-620`（写队列只包 `write`）
- 复现：`.audit/store/t10/attack-path-snapshot.mjs` ④
- 实际：

```
④ remove 与并发写之后：文件 = m_race.md
```

- 期望：删除与写同一路径应互斥；删除后到达的写如果是"统计更新"应被丢弃（tombstone），而不是把整条记忆复活。
- 影响：用户点"删除记忆"的同时，上一轮注入的 `flushInjected()`（fire-and-forget）正好在写 `stats` → 删除后文件被重建，记忆继续注入。窗口小但用户可见（"删了又回来"）。
- 建议修法：`remove` 也进 `_writeQueues`；`touchMemory` 写前确认记录仍存在（`read` 返回 null 就跳过），或写入时带 `expectedPath` 校验。

#### R-08 `normalizeTags` 把带引号的单个标签 `tags: "a, b"` 拆成两个
- 严重度：low
- 位置：`lib/store.js:57-66`（`normalizeTags` 只按逗号拆，不区分是否带引号）
- 复现：`.audit/store/t10/attack-path-snapshot.mjs` ③
- 实际：

```
③ 手写 tags: "a, b" → ["a","b"] （YAML 语义是一个标签 "a, b"；被拆成两个）
```

- 期望：`tags: pnpm, tooling`（裸逗号串）拆成两个；`tags: "a, b"`（引号包住的整体）应是一个标签。
- 影响：修复 F-ST-02 的代价；只有"标签本身含逗号且用户特意加引号"才会触发，但这正好是引号存在的意义。tags 权重 3，拆错会改变召回命中。
- 建议修法：`parseScalar` 返回时保留"原本是否带引号"（或在 `parseFrontmatter` 里把原始行一起带出），`normalizeTags` 只对未加引号的串按逗号拆。

### 复审结论

1. **t6 的 5 条修复（4 high + F-ST-06）经原始脚本复跑全部闭环**，未发现"修复反而让原问题更糟"的情况；220 项测试全绿。
2. **修复引入了 2 条 medium 级新问题**：R-01（新增/未命中读全库扫描，55–383× 性能回归）与 R-02（索引重建失败被吞、`_issues` 无出口，违反硬规则 4）。建议在下一批修复里优先处理这两条——它们正好是 t6 修复的副作用，且都便宜（一个加 `if (!rec._fileId) return direct`，一个把 `lastIndexError` 接进 status）。
3. **6 条 low 属加固/边界**（符号链接、_path 归属、快照过期、保留名/大小写、删写竞态、标签引号），不阻断本轮，但建议至少修 R-03/R-04（安全边界）与 R-07（"删了又回来"）。
4. F-ST-07 / F-ST-08（锁语义）本轮 diff 未触及，仍按原报告保持 medium；F-ST-01 / 03 / 10 / 12 等仍未修，均属 t6 明确跳过的非 high。

**复审脚本清单**：`.audit/store/t10/` → `attack-id-matrix.mjs`、`attack-silent-errors.mjs`、`attack-fs.mjs`、`attack-queue-deadlock.mjs`、`attack-path-snapshot.mjs`、`regression-scope.mjs`、`bench-write.mjs`、`bench-realistic.mjs`；after 输出 `.audit/store/t10/after-*.txt`。

