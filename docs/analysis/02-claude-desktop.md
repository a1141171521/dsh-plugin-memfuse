# Claude Desktop 记忆 剖析

> 目标：`Claude 2.37337.1.0`（MSIX / Store，`Claude_pzs8sxrjxfjjc`）
> 安装：`<WINDOWSAPPS>\<PackageFamily>\app\`
> 宿主：Electron，`resources/app.asar` 49 MB

---

## 1. 定位

Claude Desktop 的记忆**不是一套，而是三层**，且**全部不需要模型调用来工作**。

## 2. 第一层：项目（Space）记忆 —— 纯 Markdown 文件

代码：`app.asar!/.vite/build/index.chunk-Cbq8dAki.js`，导出名 `buildRemoteSpaceMemoryTools`。

两个工具，**始终加载**（`_meta: {"anthropic/alwaysLoad": true}`）：

### `project_memory_read`
> Read this session's project memory. With no `file`, returns a JSON object `{files: string[], index: string | null}` listing every `*.md` memory file and the current `MEMORY.md` index content. With `file` set to a bare filename (e.g. "topic.md"), returns `{file, content}` for that one file. **Memory is a small set of markdown notes the user expects to persist across sessions in this project — read it before deciding whether earlier context applies.**

### `project_memory_write`
> Write a file in this session's project memory (create or overwrite). Pass a bare `file` name ending in `.md` and the full `content`. To edit, call `project_memory_read` first and send back the whole file with your change applied. **Keep MEMORY.md as a short index of one-line links to topic files; put longer notes in their own topic file. Only write what the user would want remembered across sessions.**

### 存储路径

```js
function M0t(accountId, orgId, spaceId) {
  return path.join(rC(accountId, orgId), "spaces", spaceId, "memory");
}
getAutoMemoryDir(spaceId) { return this.spaces.has(spaceId) ? M0t(...) : null }
```

实际落盘：`%LOCALAPPDATA%\Claude-3p\spaces\<spaceId>\memory\`

### 工程细节（这块做得很讲究）

| 项 | 实现 |
|---|---|
| 文件名校验 | 只允许**裸文件名**：拒绝路径分隔符、`..`、绝对路径、Windows 保留名（`CON/PRN/AUX/NUL/COM0-9/LPT0-9`）、非 `.md` 后缀 |
| 上限 | 单文件 **256 KB**；列表最多 **200** 个；目录超 **5000** 条目 → `MemoryTreeTooLargeError` |
| 写入 | **原子写** `writeFileAtomic()` |
| 文件系统 | `P3.open(dir,"vm",{allowUnc:true})` —— 走 `@ant/claude-native` 的 `O_NOFOLLOW` 安全 FS，拒绝符号链接逃逸 |
| 类型检查 | 写入前 `stat`，非普通文件 → 拒绝 |
| 失败关闭 | `no_session` / `no_account` / `no_project` / `memory_disabled` / `project_gone` |
| 遥测 | `lam_space_memory_tool_call`，只记 `{tool, ok, bytes, listed, has_index, created, error_kind}` —— **不上传内容** |

## 3. 第二层：Cowork 记忆同步 —— 服务端内容寻址条目

代码：`index.chunk-YBFVQBQ_.js`，类 `CoworkMemorySync`。

```
GET  /api/claude_code/memory?scope=user&repo=<orgUuid>/<repo>
PUT  /api/claude_code/memory?scope=user&repo=<orgUuid>/<repo>
Headers: X-Client-Platform: cowork-desktop, x-organization-uuid
Body:    { entries: {key: string}, soft_delete_keys: [...] }
Resp:    { checksum, content: { entries, entryChecksums } }
```

- **ETag / 乐观并发**：`pull` 带 `If-None-Match` → 304；`push` 带 `If-Match` → 412/409 冲突重试（`maxConflictRetries: 2`）
- **软删除**：`soft_delete_keys` —— 可恢复
- **按仓库分 store**：`cowork`（账号级）+ `cowork/space/<spaceId>`
- 节流：`pushDebounceMs: 2000`、`pullStalenessMs: 60000`、`flushDefaultTimeoutSeconds: 2`

## 4. 第三层与周边

- **Session memory**：`SessionMemoryStores` / `SessionMemoryError` / `MEMORY_FLUSH_TIMEOUT_MS`
- **Dispatch 记忆迁移**：`[dispatch-memory-migration]`，导入移动端记忆为 `Chat history with Dispatch.md`、`Scheduled tasks with Dispatch.md`
- **组织级开关**：`cowork_account_settings.json` 的 `enabled_cowork_memory`；HIPAA/组织策略可在迁移中途阻断
- **Claude Code 项目记忆**：`~/.claude/projects/<slug>/memory/`
- **Skills**（与记忆分离）：`resources/bundled-skills/*.skill` + `manifest.json`，6 个官方技能，`tier: "always"`

## 5. 实测

```
%LOCALAPPDATA%\Claude-3p\local-agent-mode-sessions\<acct>\<sess>\memory\   （空）
~\.claude\projects\C--Users-...-claude-sandbox-status-*/*/memory\          （空）
```

**记忆文件数 = 0。** 机制完整存在但从未被写入。

---

## ✅ 亮点

1. **纯文本归用户所有** —— 记忆就是能用记事本打开的 `.md`，可改、可 `git diff`、可迁出
2. **零额外 LLM 成本** —— 记忆操作合并在本来就要发生的那次推理里，边际成本 = 0
3. **离线完全可用** —— 语义能力不外包
4. **安全设计扎实** —— 文件名白名单 + 原子写 + `O_NOFOLLOW` + 拒绝非普通文件 + 保留设备名黑名单
5. **同步协议正确** —— ETag + `If-Match` 乐观并发 + 软删除 + 冲突重试（分布式存储标准做法）
6. **权限模型清晰** —— 工具受 session/account/project/`memoryEnabled` 四重闸门
7. **合规成熟** —— 组织级开关、HIPAA 阻断、失败关闭
8. **遥测只记元数据不记内容** —— 隐私边界清楚
9. **"永远加载"的设计** —— `anthropic/alwaysLoad: true` 避免"工具没加载所以从不使用"的失败模式

## ❌ 弊端

1. **不可扩展** —— `MEMORY.md` 是**手工索引**，记忆一多模型要么读不完索引、要么逐个开文件，**上下文成本 O(n) 线性增长**
2. **完全没有遗忘** —— 文件只增不减，无衰减/淘汰/压缩，`MEMORY.md` 必然越来越长直到撑爆
3. **没有去重与合并** —— 靠模型自觉，可反复记同一条
4. **没有质量分层** —— 无 priority / confidence / utility，好记忆与坏记忆生而平等
5. **依赖模型自觉** —— 小模型/差模型会写垃圾；**最大的实践风险是模型可能压根不调 `project_memory_read`**，记忆写了但从不被读
6. **没有自动注入** —— 与 云端超级记忆 相反，完全被动
7. **双代际/双系统并存** —— legacy 与 improved memory 并存，增加心智负担
8. **单文件 256 KB 但无总量配额** —— 只有 5000 条目上限，无总 token 预算

## 6. 对 dsh-memfuse 的启示

| 学 | 不学 |
|---|---|
| 纯文本归用户、原子写、文件名白名单、失败关闭、遥测只记元数据、`alwaysLoad` | 无遗忘机制、无去重、无质量分层、无自动注入、O(n) 手工索引 |
