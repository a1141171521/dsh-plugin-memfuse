# 下一轮开发清单（2026-10-15 收尾 → 公司机继续）

> 本文件是给**下一次接手**看的：今天做到哪、停在哪、明天第一步查什么。
> 背景与取舍的完整记录在 `docs/spec.md` §H7，不在这里重复。

---

## 0. 今天已完成并提交 ✅

| 项 | 状态 |
|---|---|
| **H7 技能建议（Block E）** | 够格时主动在注入里提示，**零 LLM** |
| `dismiss` action | 用户"不用"后该组不再提示；**簇长大 key 变 → 重新提一次** |
| `skill.suggest` / `skillSuggestMax` | 配置 + 设置页开关已加 |
| 测试 | **88 项全绿**（plugin 56 / client 9 / smoke 23） |
| **真机冒烟** | 用探针走宿主 `systemPrompt.assemble()` 抓到真实组装块（527 字符，含 Block E） |
| 夹具工具 | `.memfuse-smoke/`，**路径运行时生成**，跨机器可跑 |
| spec.md | §H7 已写（含取舍理由、分块依据、降噪设计） |

命令：

```powershell
npm test          # 88 项（假 ctx，不需要宿主、不需要模型）
npm run smoke     # 真宿主冒烟（需要 dsh 在 PATH，不需要模型）
```

---

## 1. ⏳ 中断的任务：UI 里直接显示候选卡片

**需求原文**：
> UI 里直接显示候选卡片；如果用户忽略了候选卡片，**不能一直提示**。

### 1.1 为什么现在还不是"UI"

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
# 宿主包在 D:\DeepseekHarness\... （本机），公司机是 E:\DSH Desktop\...
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

---

## 2. 环境差异（换机器必读）

| | 本机 | 公司机 |
|---|---|---|
| 宿主 | `D:\DeepseekHarness\` | `E:\DSH Desktop\` |
| AGENTS.md 里的冒烟命令 | 路径要换成 `D:\DeepseekHarness\...` | 原样可用 |
| 夹具 profile | `~/.dsh/profiles/memfuse-smoke` **已建** | **需重建**（见下） |
| API key | ❌ **失效**（`****eUU1 is invalid`）→ 跑不了真模型往返 | 未知 |

> 好消息：`.memfuse-smoke/smoke.mjs` 里**没有任何写死的绝对路径**，overlay 运行时生成，换机器直接跑。

**公司机首次准备夹具**（三条命令）：

```powershell
$prof = "$env:USERPROFILE\.dsh\profiles\memfuse-smoke"
Copy-Item "$env:USERPROFILE\.dsh\profiles\headless" $prof -Recurse
# 然后编辑 $prof\package.json：加 dsh-memfuse 进 dependencies(link:...) 与 dsh.profile.bundles
# ⚠️ 不要用 PowerShell Set-Content 写 package.json（会加 BOM，JSON.parse 直接崩）
New-Item -ItemType Junction -Path "$prof\node_modules\dsh-memfuse" -Target <仓库路径>
New-Item -ItemType Junction -Path "$prof\node_modules\memfuse-probe" -Target <仓库路径>\.memfuse-smoke\probe
```

**git 推送**：本机 `github.com:443` 直连被墙，仓库级代理已配 `127.0.0.1:7897`（需 Clash 开着）。
公司机若不通：`git config --unset http.proxy` 后改走 SSH（本机实测 `ssh.github.com:443` 与 `github.com:22` 都通）。

---

## 3. 今天踩到的三个坑（都写进注释了，别重复踩）

| 坑 | 现象 | 根因 / 修法 |
|---|---|---|
| **PowerShell `Set-Content -Encoding UTF8` 写 BOM** | `JSON.parse` 报 `Unexpected token ''`，profile 起不来 | 用编辑器/工具写，或 `[IO.File]::WriteAllText` + `UTF8Encoding($false)` |
| **Windows ESM 绝对路径** | `ERR_UNSUPPORTED_ESM_URL_SCHEME: protocol 'd:'` | `import(pathToFileURL(p).href)` |
| **测试脚本自己推簇 key** | 误报"dismiss 没生效" | 按目录列 id 推 key 是**错的**（把 P0 那条也算进簇）→ 必须调插件自己的 `buildSuggestions()` |

第三条值得记成一条通用纪律：**验证某段逻辑时，用那段逻辑本身算，不要在测试里重新实现一遍。**

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
