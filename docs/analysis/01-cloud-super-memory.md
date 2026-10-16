# 云端超级记忆 剖析

> 目标：`<PRODUCT_DIR>\`（VS Code 1.135.0 分支，产品版本 1.4.0）
> 形态：解包 Electron 应用（`resources/app/` 非 asar）
> 存储：`C:\Users\<user>\.<产品目录>\memory.db`（SQLite 3，WAL）

---

## 1. 定位

`超级记忆` 是中文语言包对内部标识 **`superMemory` / `Viking`** 的翻译。
代码里没有中文字面量，只用 `\u8d85\u7ea7\u8bb0\u5fc6` 转义形式存在于 `workbench.desktop.main.js`。

自研代码集中在 `out/vs/workbench/contrib/<产品模块>/**`。

## 2. 架构（五层）

```
UI 面板 (React chunks)   workbench.action.open云端超级记忆SuperMemory
   ↓
编排层 memoryRecallContextService    每轮注入装配
   ↓
生成层 memoryGenerationService       4 个 LLM 提示词（抽取/去重/经验/场景）
   ↓
检索层 vikingRetriever + memoryInjectionPolicy
   ↓
存储层 vikingStoreService ──IPC──> vikingDatabaseChannel（主进程）──> memory.db
   ↓
云端   <嵌入同步服务> ──> api.<产品域名>
       POST /api/viking/embed    (1024 维)
       POST /api/viking/rerank   (Jina 重排)
```

**关键**：记忆文本存本地 SQLite，**向量与重排在云端**（需登录 + 订阅）。

## 3. 数据模型

### 表结构（`PRAGMA user_version = 4`）

```sql
CREATE TABLE viking_nodes (
  id TEXT PRIMARY KEY,          -- vk_<epoch_ms>_<rand>
  path TEXT,                    -- memories/… | skills/… | resources/…
  category TEXT,                -- memory | skill | resource
  l0 TEXT, l1 TEXT, l2 TEXT,    -- 三级文本（索引/概览/全文）
  priority TEXT,                -- P0 | P1 | P2
  tags TEXT, parent_dir TEXT,
  created_at, last_accessed_at, access_count, expires_at,
  source TEXT,                  -- user | tool | conversation | auto
  synced INTEGER, thread_id TEXT, metadata TEXT, workspace_id TEXT,
  lifecycle_state TEXT,         -- active | dormant
  managed_by TEXT,              -- user | auto
  confirmation_count, last_confirmed_at, dormant_at,
  confidence REAL, utility_score REAL,
  positive_outcome_count, negative_outcome_count,
  injected_count, last_injected_at, source_revision TEXT
);
CREATE TABLE viking_embeddings (node_id PRIMARY KEY, embedding TEXT);
CREATE TABLE viking_store_meta (key, value);
CREATE TABLE viking_memory_events (event_key UNIQUE, kind, …, active, reversed_by);
CREATE TABLE viking_lineage_edges (relation);   -- supersedes | contradicts
```

9 个触发器维护 `store_revision` 单调递增 —— 用于注入快照的缓存失效判断。

### 三层文本（核心设计）

| 层 | 用途 | 上限 |
|---|---|---|
| **L0** | 一句话索引，进 L0 清单树 | 200 字符 |
| **L1** | 简明概览，默认检索返回层 | 1000 字符 |
| **L2** | 完整细节 | 8000 字符 |

### 三个顶层目录

| 目录 | 用途 |
|---|---|
| `memories` | 偏好、约定、决策、约束 |
| `skills` | 工具/流程经验（含 `experience`、`trajectory` 子类型） |
| `resources` | 项目知识、代码变更摘要 |

`metadata.kind` 子类型：**`trajectory`**（执行轨迹）、**`experience`**（已验证经验）、**`scenario`**（场景卡）。

## 4. 写入：四条管线

### 4.1 对话抽取（主路径）

`memoryGenerationService.analyzeAndSave()`：

1. 转录 < 30 字符直接跳过
2. LLM 调用（`loggingName: "MemoryExtraction"`，强制 `reasoningEnabled: false`）
3. 系统提示词硬约束：
   - 三种耐久度：`durable` / `temporary` / `turn_local`
   - **"不要分配 P0 或任何优先级；宿主代码掌管 P1/P2，只有用户能确认 P0"**
   - 置信度校准：0.9+ 明确陈述 / ~0.7 明显隐含 / ~0.5 可信但未确认 / **<0.4 属于猜测，直接省略**
   - **用对话主导语言写，绝不翻译成英文**
4. 5 个 few-shot 例子，含两个刻意陷阱：
   - **E3**「顺手提的长期约定，淹没在无关请求里」→ 必须抽出来
   - **E4**「this time」→ 必须**不**抽出来

**准入决策**（`memoryPolicyService.l2o`）：

| 条件 | 结果 |
|---|---|
| `durability === "turn_local"` | **丢弃** |
| `durable && confidence ≥ 0.75` | **创建为 P1** |
| `confidence ≥ 0.6 \|\| evidence ∈ {repeated, explicit}` | **创建为 P2** |
| 其他 | **丢弃** |

同批按 `category\0归一化标题` 去重，**最多 6 条**。

### 4.2 去重与"反记忆腐烂"

LLM 三选一（提示词 `isn`）：`SKIP` / `CREATE`（可带 `delete_ids`）/ `MERGE`。

提示词原文：
> 「矛盾 → 解决，不要累积……**陈旧冲突的记忆是记忆腐烂的主因**——每次都要解决。」
> 「**绝不在合并时提升为 P0**——自动路径最高 P1。」

代码级保险：
- `delete_ids` 过滤：只能删非 P0、非 `managed_by:user`、非 `source∈{user,tool}`
- 合并目标属用户所有 → **不合并**，改为新建并标 `conflictsWithP0`
- **合并丢失熔断**：合并后 L2 < 原 L2 的 **70%** → 放弃合并改新建
- `metadata.revisionHistory` 保留**最近 3 版**

### 4.3 执行轨迹 → 经验（带验证闸门）

从最后一个用户轮次重建工具调用轨迹 → 存为 `category:"skill"`、`kind:"trajectory"`。
**只有该轮产生 `verified_success` 事件时才蒸馏出 `experience`。**

提示词 `nsn` 的硬规则：
> 「大多数轨迹应该是 SKIP——经验稀有且高价值。」
> 「**失败后找到可行修复，是最强的 CREATE 信号。**」
> 「若轨迹 OUTCOME 是 `failed`，**绝不**蒸馏"可行配方"……**注入错误的未来规则比没有规则更糟**。」

### 4.4 场景卡合并

把原子记忆按主题聚合成概览卡：≥2 个成员、最多 12 张、20 小时或新增 8 条触发。

## 5. 检索：五级混合管线

| 阶段 | 动作 |
|---|---|
| 1 | `intent_analysis` — 关键词 + 类别定向（中/英/日/韩硬编码词表） |
| 2 | `vector_search` — 余弦相似度，阈值 **> 0.15** |
| 3 | `fine_grained_exploration` — 字段加权：`anchor`+3 / `tags`+3 / `l0`+2 / `l1`+1 |
| 4 | `reranker` — 云端 Jina：`0.85*rerank + 0.15*本地` |
| 5 | `result_aggregation` — 合并去重 + 最终打分 |

**最终打分公式**：

```js
score = base*0.70 + priorityW*0.16 + confidence*0.08
      + freshness*0.03 + utility*0.03
      - (trajectory ? 0.12 : 0) - (stale ? 0.20 : 0) - (conflict ? 0.35 : 0)
// 阈值 0.12；context 模式排除 trajectory；experience 需 stable===true
```

## 6. 注入：预算化装配

- **常驻块**：P0，上限 **12 条 / 3200 字符**
- **主动召回块**：阈值 `max(0.3, 最高分×0.6)`，条数随最高分浮动（6/4/2 条）
- **L2 升级**：`score ≥ 0.75` 且 L2 非空 → 注入全文
- **交错排序**：偶数位顺序 + 奇数位倒序，避免同类扎堆
- **L0 清单**：`viking://memories/ (N)` + 每行 `[P0|3d] #tag: <L0>`
  → 进度披露的入口："Use memories_recall for relevant details"

**token 预算**：内置 **9 家厂商真实 BPE 分词器**（DeepSeek/Qwen/Kimi/GLM/MiniMax/混元/LongCat/Mistral/Laguna），
超预算时单次缩放 `A = max(0.1, budget/count*0.95)`。

**A/B 影子模式**：`shadow` 阶段同时跑基线与新检索并记录对比。

## 7. 遗忘：四道闸门

| 机制 | 规则 |
|---|---|
| 过期 | P0 → null；P1 → **+30 天**；P2 → **+7 天** |
| 弱续期 | 被召回时 P1 → +3 天，P2 → +1 天 |
| 强续期 | 正面反馈且无负面 → 重置完整 TTL |
| 生命周期扫描 | 启动时 + **每 24 小时** |
| 预算淘汰 | small(≤500 文件) 20/10/5；medium 35/20/10；large 50/30/15 |
| 物理删除 | dormant 超 `budget*2` 且**零反馈**且（P1 或 P2 dormant > 7 天） |
| 用户豁免 | `source=user` / `source=tool` / `priority=P0` / `managed_by=user` 全部豁免 |

## 8. 反馈闭环

**正面事件**：`verified_success`、`user_confirmed`
**负面事件**：`verified_failure`、`user_correction`、`counter_evidence`、`rollback`

```js
utilityScore = clamp((positive - negative*1.5) / (positive + negative*1.5), -1, 1)
// 负面权重是正面的 1.5 倍
priority: 独立正面轮次≥2 且 negative===0 → P1
          negativeCount>0 且 negativeRatio≥0.34 → P2
lifecycle: 来源 stale 或 negativeRatio≥0.5 → dormant
```

`experience` 额外写 `metadata.stable = (独立正面轮次≥2 && negative===0)`。
**`stable` 正是检索时 `context` 模式要求的字段。**

`reverseTurn()` 支持按轮次整体回滚记忆事件。

## 9. 商业与授权

- `hasSuperMemory` 来自 `POST /api/capability-token` 返回的**RSA 签名令牌**
- 公钥硬编码在 `capabilityManager.js`，有效域校验 `<CDN 域名>` / `<产品域名>`
- 429 → `SuperMemoryQuotaExceededError`，按套餐限额

## 10. 实测数据

`~/.<产品目录>/memory.db`：

| 维度 | 值 |
|---|---|
| 节点总数 | **68** |
| 分类 | resource 36 / memory 20 / skill 12 |
| 优先级 | P2 52 / P1 16（**无 P0**） |
| 生命周期 | dormant 52 / active 16 |
| 来源 | tool 36 / conversation 20 / auto 12 |
| `metadata.kind` | trajectory 9 / **scenario 3** |
| **嵌入** | **68 条，维度 1024** |
| 记忆事件 | recalled 29 / injected 29（**11 个节点被注入过**） |

---

## ✅ 亮点

1. **L0/L1/L2 分层 + 渐进披露** —— 索引先行，按需下钻，token 经济学正确
2. **精确 token 账本** —— 9 家真实分词器，而非 `chars/4` 估算
3. **反记忆腐烂** —— 真正理解记忆系统会怎么坏，并有对应机制（两把手术刀 + 熔断 + 用户资产保护）
4. **验证闸门** —— 经验需 `verified_success` + ≥2 独立正面轮次才 `stable`；"注入错误的规则比没有规则更糟"
5. **负面权重 1.5×** —— 保守，宁缺毋滥
6. **事件溯源 + 按轮次回滚** —— 注入/反馈全是事件，可整体撤销
7. **影子模式 A/B** —— 检索系统内置评测基础设施
8. **`retrieval_anchor` 字段** —— 人工触发器描述作为 query-side 向量的廉价替代
9. **用户资产豁免** —— P0 / 用户来源永不被自动清理
10. **提示词工程质量** —— 含对抗性 few-shot（E3 深埋约定 / E4 turn-local 陷阱）

## ❌ 弊端

1. **云端依赖 + 订阅绑定（最大风险）**
   - 嵌入与重排**只有云端一条路**，无本地回退
   - 断网 / 429 → 向量检索返回 `[]`，只剩 ~30 词 CJK 停用表 + `includes()` 子串匹配
   - `L0+L1` 原文持续发往境外后端 → 编码工具的重大数据出口
2. **每轮最多 7 次额外 LLM 调用，且烧用户自己选的模型**
   - 1 次抽取 + 最多 6 次去重；`modelSelectionOfFeature.Chat` = 用户聊天模型
   - 不可见、不可控、不可关
3. **一类节点永久免疫于所有清理（真 bug）**
   ```js
   managedBy: e.managedBy ?? (e.source==="user" || e.source==="tool" || e.priority==="P0" ? "user" : "auto")
   ```
   `source=tool` → `managed_by=user` → 触发全部清理豁免条件。
   实测：36 个 resource 节点全部 `managed_by=user`，**永远不会被删除**，数据库单向增长
4. **L2 被反复重写 = 传话游戏**
   70% 熔断只拦总量骤降，拦不住逐步漂移；`revisionHistory` 只 3 版
5. **8 个手调魔数且互相打架**
   `freshness` 只占 0.03（几乎等于没有）；阈值 0.12 偏低；
   新旧两条路径的 priority 语义不一致（乘性 ×1.5 vs 加性 0.16）
6. **关键词类别路由过于粗糙** —— `String.includes()` 硬编码，"为什么这个测试挂了"不含"报错/修复"就退化为全类目查询
7. **双记忆系统割裂** —— `memory.db` vs `~/.<产品目录>/memories/*.md`，`migrateFromMemoryBank()` 是 `return 0` 空实现
8. **`stable` 冷启动问题** —— 同一坑要踩两次，第一次学到的教训还不生效
9. **死代码** —— `memoryDeletion.js` 仅 22 字节

## 11. 对 dsh-memfuse 的启示

| 学 | 不学 |
|---|---|
| L0/L1/L2 分层、`retrieval_anchor`、准入分权、完整遗忘链、反馈闭环、omissions 记录 | 云端唯一路径、SQLite 黑箱、每轮多次 LLM、清理豁免传染、手调魔数、粗糙关键词路由 |
