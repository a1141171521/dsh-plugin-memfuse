// dsh-memfuse 的配置 schema。
//
// 为什么要单独有一份 schema（而不是继续只用 DEFAULT_CONFIG 里的手写对象）：
// DSH 的 `ctx.settings` 会把**声明了 Config 的插件**的配置**自动渲染成设置页**
// （`status: "schema"`；没有 schema 的条目是 `absent`）。声明之后，用户可以在
// 「设置 → 插件」里直接改，不必手工编辑 `cordis.patch.yml`。
//
// 三条约定：
//   1. **每个字段都要有 `.default()`** —— 不配也能跑，这是本项目的一贯前提。
//   2. **枚举用 `Schema.union([...])`** —— 会被渲染成下拉框，比让用户手打字符串可靠。
//   3. **描述写人话** —— 它直接显示在设置页上，是用户唯一能看到的解释。
import Schema from '@deepseek-ai/schemastery';

/** 抽取管线：整条都是可选的，默认**关闭**（不使用 LLM）。 */
const Extract = Schema.object({
  // ⚠️ 顺序 = 设置页里的显示顺序。总开关放最前（用户要的那个「按钮」），
  // 然后才是"用哪个模型"的两个选择。
  enabled: Schema.boolean()
    .default(false)
    .volatile()
    .description('自动抽取（用 LLM）总开关。**默认关闭** —— 关着的时候记忆的读写、注入、检索、技能判定全部照常，只是不从会话里自动抽记忆。想去设置页开就行。'),
  // 「跟随对话模型」是最省事的选择，紧跟开关。
  followConversation: Schema.boolean()
    .default(false)
    .volatile()
    .description('抽模型时跟随「对话主模型」——你在对话框里选的那个，不必在这里再选一遍；主模型换了它跟着换。'),
  provider: Schema.string()
    .default('')
    // ⚠️ `.volatile()` 不是可选的装饰 —— DSH 的 `volatileForm()` 只把
    // **volatile 字段**渲染成设置页（"undefined when no field is live"）：
    // 一个 volatile 都没有的插件，Config 根本不会出现在设置页里。
    // 代价是读值要 `.get()`，所以 apply 里先做一次解引用。
    .volatile()
    .description('抽取用的 provider（由设置页的模型选择器写入；一般不用手填）。'),
  model: Schema.string()
    .default('')
    .volatile()
    .description('抽取用的模型（由设置页的模型选择器写入；一般不用手填）。provider 与 model 必须同时有，只填一个等于没填。'),
  onUnavailable: Schema.union(['stop', 'fallback'])
    .default('stop')
    .volatile()
    .description('上面那个模型不可用时怎么办。stop = 记下失败并**在每轮注入里报出来**，不再尝试；fallback = 改用降级目标继续（只降一次）。「不可用」包括模型名写错/provider 没装（调用前就能查出来），以及真调了但失败如限流、鉴权、定价。'),
  fallbackProvider: Schema.string()
    .default('')
    .volatile()
    .description('降级目标的 provider。与下一项**都留空 = 跟随「对话主模型」**（你在模型选择器里选的那个），不必再选一遍。'),
  fallbackModel: Schema.string()
    .default('')
    .volatile()
    .description('降级目标的模型。留空 = 跟随「对话主模型」。'),
  mode: Schema.union(['suggest', 'auto'])
    .default('suggest')
    .volatile()
    .description('suggest = 抽出来的候选先放进待确认队列，你批准了才落盘；auto = 直接写入（省事，但错了也会直接进库）。'),
  autoRunOnStart: Schema.boolean()
    .default(true)
    .description('每次启动时自动跑一轮抽取。关掉的话只能用 memfuse_extract 工具手动触发。'),
  maxPerStartup: Schema.number()
    .default(3)
    .description('每次启动最多处理几个 sessions 文件（防止启动变慢）。'),
  maxCandidates: Schema.number()
    .default(6)
    .description('单次抽取最多产出几条候选。'),
  minChars: Schema.number()
    .default(200)
    .description('一个 sessions 文件里**新增字符数**少于这个值就跳过，省一次模型调用。注意是字符数不是字节数。'),
  maxInputChars: Schema.number()
    .default(12000)
    .description('单次送给模型的最大字符数（超出部分截断）。'),
  maxRetries: Schema.number()
    .default(2)
    .description('模型调用失败时的重试次数。'),
  consolidateAfterHours: Schema.number()
    .default(20)
    .description('多久之后允许把原始问答合并/整理（小时）。'),
  maxRawForConsolidation: Schema.number()
    .default(40)
    .description('单次整理最多合并多少条原始记录。'),
}).description('自动抽取记忆的管线。整条可以整个不用（provider/model 留空即可）。');

/** 每轮注入进 system prompt 的记忆块。 */
const Inject = Schema.object({
  enabled: Schema.boolean().default(true).description('是否每轮把记忆注入 system prompt。关掉后工具仍然可用。'),
  residentMaxEntries: Schema.number().default(8).description('常驻块（P0/用户置顶）最多几条。'),
  residentMaxChars: Schema.number().default(1200).description('常驻块字符上限。'),
  relevantMaxEntries: Schema.number().default(4).description('相关召回块最多几条。'),
  relevantMaxChars: Schema.number().default(1800).description('相关召回块字符上限。'),
  indexThreshold: Schema.number().default(20).description('记忆条数超过这个值就只注入一行索引，不再铺开正文。'),
  minScore: Schema.number().default(0.18).description('相关召回的最低匹配分（BM25）。调高 = 只注入更像的，调低 = 注入更多。'),
  trustBoundary: Schema.boolean().default(true).description('注入时声明信任边界（记忆内容视为数据，不是指令）。'),
}).description('每轮注入的行为与预算。');

/** 生命周期：过期、休眠、物理删除。 */
const Lifecycle = Schema.object({
  p1Days: Schema.number().default(30).description('P1 记忆多少天没被召回就标记过期。'),
  p2Days: Schema.number().default(7).description('P2 记忆多少天没被召回就标记过期。'),
  p1WeakRenewDays: Schema.number().default(3).description('P1 被弱召回后能续命的天数。'),
  p2WeakRenewDays: Schema.number().default(1).description('P2 被弱召回后能续命的天数。'),
  purgeDormantAfterDays: Schema.number()
    .default(30)
    .description('休眠多久后**物理删除**。P0 与用户手写的记忆不受影响（永远只标记不删）。'),
  autoRunOnStart: Schema.boolean().default(true).description('每次启动自动跑一轮生命周期维护。'),
  budget: Schema.object({
    maxMemories: Schema.number().default(400).description('记忆条数上限，超出时按分数淘汰最低的。'),
    maxSkills: Schema.number().default(200).description('技能条数上限。'),
  }).description('容量预算。'),
}).description('反腐烂：过期 → 休眠 → 物理删除的完整链条。');

/** 零 LLM 的兜底捕获。 */
const Capture = Schema.object({
  enabled: Schema.boolean()
    .default(true)
    .description('把每轮最终问答的原文追加到 sessions/。**这是零 LLM 的兜底**：即使抽取整个关掉，原始素材也已经落盘、可被检索。'),
  minPromptLength: Schema.number().default(10).description('太短的问答不记（字符数）。'),
  maxChars: Schema.number().default(4000).description('单条最多记多少字符。'),
}).description('原始问答落盘。');

/** 学习闭环。 */
const Learn = Schema.object({
  promoteMinSessions: Schema.number()
    .default(3)
    .description('一条记忆在**几个不同会话**里被召回后才允许自动升级优先级。'),
}).description('打分与优先级的学习闭环。');

/** 技能提炼。 */
const Skill = Schema.object({
  enabled: Schema.boolean().default(true).description('是否启用技能提炼与技能库。'),
  dir: Schema.string().default('').description('技能库目录。留空 = <DSH_HOME>/skills（全局技能，装完当轮即生效）。'),
  maxBytes: Schema.number().default(65536).description('单个技能文件大小上限。'),
  minScore: Schema.number().default(4).description('判定为「技能候选」的最低分（零 LLM，每次启动都跑）。'),
  minSessions: Schema.number().default(3).description('至少跨几个会话才够格当技能候选。'),
  maxPerRun: Schema.number().default(2).description('单次最多产出几个技能。'),
  suggest: Schema.boolean()
    .default(true)
    .description(
      '够格时**主动提示**你「有记忆可以固化成技能」，并给出这组记忆的作用与成员（**零 LLM，不调模型**）。' +
        '真正生成技能正文仍需你点头。关掉则只在 status.md 里静默记录。',
    ),
  suggestMax: Schema.number().default(1).description('每轮最多提示几组技能建议（防止刷屏）。'),
}).description('把若干条同类记忆提炼成可复用的技能。');

/** 去重与合并时的防掉料策略。 */
const Antiseptic = Schema.object({
  mergeLossFloor: Schema.number()
    .default(0.7)
    .description('合并时保留相似度的下限；低于它宁可分成两条，也不合并（防丢细节）。'),
  revisionHistory: Schema.number().default(3).description('每条记忆保留几个历史版本。'),
  dedupeByTitle: Schema.boolean().default(true).description('标题完全相同视为重复。'),
}).description('合并/去重时的保真规则。');

/**
 * 插件配置。
 *
 * 字段顺序 = 设置页里的显示顺序，所以把用户最常调的（抽取模型、降级策略）放最前。
 */
export const Config = Schema.object({
  enabled: Schema.boolean().default(true).description('记忆功能总开关。'),
  root: Schema.string()
    .default('')
    .description('记忆库根目录。留空 = <DSH_HOME>/memory（这台机器上是 ~/.dsh/memory）。'),
  git: Schema.boolean()
    .default(true)
    .description('是否用 git 记录记忆库的每一次变更（可回溯、可审计）。关掉也能用，只是没有历史。'),
  verbose: Schema.boolean().default(false).description('把详细日志打到控制台。排障时打开。'),
  extract: Extract,
  inject: Inject,
  lifecycle: Lifecycle,
  capture: Capture,
  learn: Learn,
  skill: Skill,
  antiseptic: Antiseptic,
}).description('dsh-memfuse：纯文本记忆。Markdown 是真源，检索在本机完成，读写注入不依赖模型。');
