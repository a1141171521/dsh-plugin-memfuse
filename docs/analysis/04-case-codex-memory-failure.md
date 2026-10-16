# 失败案例研究：Codex 记忆静默死亡三周

> 这是整个分析里**最有价值的一个案例**，因为它完整展示了一个"设计良好但会静默烂掉"的记忆系统。
> `dsh-memfuse` 的 Block D「健康警告」就是直接针对这个案例设计的。

---

## 1. 现象

```sql
-- ~/.codex/memories_1.sqlite
stage1_outputs          : 0 行
consolidation_progress  : max_thread_count = 0

SELECT kind, status, retry_remaining, last_error FROM jobs;
```

| kind | status | retry_remaining | last_error |
|---|---|---|---|
| `memory_stage1` | **error** | 2 | `unexpected status 503 Service Unavailable: No available channel for model gpt-5.6-luna under group 国产 (distributor) …` |
| `memory_consolidate_global` | **error** | 1 | `failed_agent` |

**结论：自动记忆从来没有生成过任何一条记忆。**

## 2. 时间线

| 时间 | 事件 |
|---|---|
| 2026-07-11 | memory 迁移 v1 安装（功能上线） |
| **2026-09-25 20:21** | `memory_stage1` **失败**，此后从未成功 |
| 2026-10-14 21:06 | 用户改了 `config.toml` |
| 2026-10-14 21:16 | `memories_1.sqlite` 仍被写入（管线还在空转） |

**已经死了三周，用户毫无察觉。**

## 3. 根因排查（一次反转）

### 第一层判断（错误）
"如果没有 `gpt-5.6-luna` 这个模型，Codex 就没有记忆。"

### 第二层判断（正确）
检查用户自己的中转站模型目录：

```
~/.codex/model-catalogs/relay-mrg9rxng.json   (270 KB, 6 个模型)
~/.codex/model-catalogs/relay-msbu0nth.json   (142 KB, 3 个模型)
```

里面**明确列着**：

```json
{
  "slug": "gpt-5.6-luna",
  "display_name": "GPT-5.6-Luna",
  "description": "Fast and affordable agentic coding model.",
  "default_reasoning_level": "medium"
}
```

同目录还有：
- `gpt-5.6-sol` — "Latest frontier agentic coding model"
- `gpt-5.6-terra` — "Balanced agentic coding model"

**所以根因不是"模型不存在"，而是第三方中转站"挂羊头卖狗肉"：**

```
"No available channel for model gpt-5.6-luna under group 国产 (distributor)"
```

→ 目录里登记了 `luna`，但中转站背后**没有真实通道能服务它**。
这是第三方 API 中转站的典型症状：catalog 抄一份官方列表，实际只有部分能跑。

## 4. 为什么记忆偏偏用了 luna？

注意 luna 的官方描述：**"Fast and affordable agentic coding model"**（快、便宜）。
而 `sol` 是 "Latest frontier"（最贵最强），用户主力恰好是 sol 系。

**结论**：Codex 的记忆管线**刻意挑廉价档模型跑后台任务**，不动用户主力模型。
二进制里也确实有 `consolidation_model` 这个独立配置键。

**这个设计本身是对的**——你不想让后台记忆抽取烧掉前沿模型的额度。
**但它把便宜档放在了一条会静默死亡的关键路径上。**

### 结构性矛盾

> **省钱的选择（廉价档）恰恰是可用性最没保障的选择** —— 因为中转站最爱虚标的，就是那些便宜模型。

形成死循环：想省钱 → 选便宜档 → 中转站没有 → 静默失败 → 记忆归零。

## 5. 为什么这个失败特别糟糕：三层静默

1. **UI 无提示** —— 没有 toast、没有状态灯、没有设置页告警
2. **开关说谎** —— `generate_memories = true` 和 `use_memories = true` 都亮着，看起来一切正常
3. **错误藏在深井** —— 唯一真相在 `memories_1.sqlite` 的 `jobs.last_error` 字段里，措辞还像是网络问题

而 `use_memories = true` 是个**空开关**——没有东西可供"使用"。

## 6. 修复路径（已验证存在）

从 `codex.exe` 二进制字符串提取的完整 `[memories]` 模式：

```toml
[memories]
dual_write
disable_on_external_context
generate_memories
use_memories
dedicated_tools
max_raw_memories_for_consolidation
max_unused_days
max_rollout_age_days
max_rollouts_per_startup
min_rollout_idle_hours
min_rate_limit_remaining
consolidation_model          ← 记忆专用模型
```

**三步修复：**

1. `consolidation_model = "<curl 验证过、确实能跑的便宜模型>"`
2. 或换 base_url 到真能提供该模型的端点
3. 清掉已死的 job（二进制里有现成语句）：
   ```sql
   DELETE FROM jobs WHERE kind = 'memory_stage1' OR kind = 'memory_consolidate_global';
   ```

**⚠️ 教训：不要相信 catalog。先 curl 验证，再写配置。**

```bash
curl -sS https://<中转>/v1/chat/completions \
  -H "Authorization: Bearer <key>" -H "Content-Type: application/json" \
  -d '{"model":"<候选>","messages":[{"role":"user","content":"ping"}],"max_tokens":5}'
```

**唯一可靠的验证点**：`stage1_outputs` 是否有行。UI 什么都看不出来。

## 7. 附带发现

二进制里有 feature flag **`no_memories_if_mcp_or_web_search`**。
用户配置里恰好有启用的 MCP（`[mcp_servers.node_repl]`）——
**即便修好模型生成记忆，记忆也可能在注入阶段被主动让位。**

这个设计的逻辑是清醒的：模型已有 MCP / 联网这类即时信息源时，
陈旧记忆的边际价值下降、甚至可能干扰。但对用户意味着——**修好模型未必就能看到记忆生效**。

---

## 8. 从本案例提炼的设计要求

| 要求 | dsh-memfuse 的实现 |
|---|---|
| 管线健康必须可见 | `status.md` + `state.json` 记录 `lastExtractSuccess` / `lastExtractError` / `lastErrorAt` |
| 失败必须进入模型的视野 | **Block D** 在注入块里插一行显式警告，含原因与已停止天数 |
| 必须说明哪些功能仍可用 | 警告明确写"手动写入与检索仍然可用" |
| 不能把 LLM 放在关键路径 | 读/写/注入/检索**零模型调用**；关掉抽取后一切照常 |
| 模型必须可配置 | `extract.model`，留空 = 关闭抽取而非崩溃 |
| 不能被"开关说谎"骗到 | `memory_status` 工具返回真实管线健康，而非开关状态 |
| 便宜档不是唯一选项 | `extract.model` 由用户指定，可指向已 curl 验证的模型 |

**一句话**：

> 任何把 LLM 放在关键路径上的记忆系统，都必须有**失败可见性**。
> Claude 的记忆不存在"失效"概念（就是文件，写没写一看便知）；
> 云端超级记忆 至少在 UI 显示 active/dormant/unsynced 统计；
> **Codex 是唯一一个会静默烂掉的。**
