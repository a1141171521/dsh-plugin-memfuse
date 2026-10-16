/**
 * memfuse 的**宿主 Remote 能力** —— 客户端 UI 读候选、用户点「不用 / 提炼 / 装进技能库」的唯一通道。
 *
 * ## 为什么是手写描述符，而不是等代码生成
 *
 * DSH 的 Remote 走 Typert：宿主 `@Remote` 装饰器 → tsdown 生成 `/remote` 产物 →
 * 客户端 `ctx.remote.$mount()` 挂载。那条流水线只在**源码版仓库**里存在，
 * 插件作者（本仓库）拿不到。
 *
 * 但协议本身留了**运行时入口**。`dsh-typert-registry/README.md` 原文：
 *
 * > Generated artifacts register through the loader in Loader compositions;
 * > **any other owner calls `ctx.typert.register(contribution)` directly**
 * > and receives the exact disposer that withdraws it.
 *
 * ## 实测核对过的四条契约（0.2.0-rc.2 本机宿主包，行号可复查）
 *
 * 1. **注册表校验**（`dsh-typert-registry/lib/index.js:485-556`）要求
 *    `{package, face: 'host'|'client', schemas, descriptors}`，每个描述符
 *    `{id, service, namespace, method, invocation, parameters, result}`；
 *    线名必须过 `^[A-Za-z0-9_$.-]+$`（`validateWireName`）。
 * 2. **codec 不要求 zod**：`validateCodec` 只看 `mode==='strict'` + `typeSymbol` 非空 +
 *    `create` 是函数；而运行时只调用 `codec.create().parse(value)`
 *    （`dsh-api-gateway/lib/index.js:1513` 的 `decode()`）—— 所以一个
 *    `{mode:'strict', typeSymbol, create: () => ({ parse })}` 就够，**零第三方依赖**。
 * 3. **路由要求 Service 带 `typertRemote` 绑定**
 *    （`dsh-api-gateway/lib/index.js` 的 `validateBinding`），而那东西就是一个
 *    `Object.freeze({service, serviceKey, namespace})`
 *    （`dsh-typert-protocol/lib/index.js:bindTypertRemote` 的返回值）——
 *    照抄这个形状即可，不必 import 那个包。
 * 4. **调用就是取 Service 上的同名方法**：
 *    `method = receiver[descriptor.implementation ?? descriptor.method]`，参数按
 *    `parameters[].wire` 从 `args` 里取（`prepareInvocation`）。
 *
 * ## 失败可见
 *
 * 这套东西任何一步不成立（宿主没有 `typert` 服务 / 注册被拒 / 客户端没挂上），
 * 都必须**留下痕迹**：不注册就记 `runtimeFaults`，界面那侧退化成"卡片不出现"
 * 但 status.md / Block D 会说清为什么（本项目硬规则 4）。
 */

/** 描述符归属的包名（与 npm 包名一致，便于对上号）。 */
export const REMOTE_PACKAGE = 'dsh-memfuse';
/** 宿主侧 Cordis Service 键（`descriptor.service` 指的就是它）。 */
export const REMOTE_SERVICE_KEY = 'memfuseRemote';
/** 客户端看到的命名空间：`ctx.remote.memfuse.list()`。 */
export const REMOTE_NAMESPACE = 'memfuse';

/**
 * 端点是 `<namespace>/<method>`，列表化便于测试与探针断言。
 *
 * 七个端点分两类：
 *   - **读 + 记账**（`list / dismiss / markSeen / requestDistill`）：卡片读候选、用户表态；
 *   - **真动作**（`distill / approve / reject`）：缺陷 25 补的 —— 用户点「提炼成技能」之后
 *     界面上必须真的看到 SKILL.md 草稿（提示词 + 作用）再决定装不装，
 *     而不是"点完那一行就没了、什么都不发生"。
 *
 * ⚠️ `distill` 是这里**唯一会调模型**的端点（用户点按钮 = 显式触发，符合 H7 的
 * "技能会真实改变 AI 行为，必须显式触发"）。它可能跑几十秒，客户端要给出进行中状态。
 */
export const REMOTE_ENDPOINTS = Object.freeze({
  list: `${REMOTE_NAMESPACE}/list`,
  dismiss: `${REMOTE_NAMESPACE}/dismiss`,
  markSeen: `${REMOTE_NAMESPACE}/markSeen`,
  requestDistill: `${REMOTE_NAMESPACE}/requestDistill`,
  distill: `${REMOTE_NAMESPACE}/distill`,
  approve: `${REMOTE_NAMESPACE}/approve`,
  reject: `${REMOTE_NAMESPACE}/reject`,
});

/**
 * 造一个 strict codec。
 *
 * `check` 在**宿主**解码参数时被调用（`create().parse(value)`），所以要真的校验：
 * 参数是外部输入（浏览器侧），不校验等于把类型错误留到下游。
 */
function strict(typeSymbol, check) {
  return {
    mode: 'strict',
    typeSymbol,
    create: () => ({
      parse: (value) => check(value),
    }),
  };
}

const asKey = (value) => {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('期望非空字符串（簇 key）');
  return value;
};

const asKeyList = (value) => {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw new Error('期望字符串数组（簇 key 列表）');
  return value;
};

/** 技能名（目录名 === frontmatter name，所以只允许 slug 字符）。 */
const asName = (value) => {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('期望非空字符串（技能名）');
  return value;
};

/** 返回值一律是 JSON（回给浏览器），这里不做结构变换。 */
const asJson = (value) => value;

/**
 * 一个"普通参数"。（**必须有 `source: 'json'`** —— 真机踩过，见缺陷 19。）
 *
 * 宿主 `resolveParameter()` 的判据是 `if (parameter.source === 'json') return value;`
 * 然后**当成 lookup 参数**去要 provider key
 * （`dsh-api-gateway/lib/index.js:1099-1102`：`lookup parameter "keys" has no provider key`）。
 * 漏了 `source` 的表现是：**没参数的 `list` 正常，一按按钮就报错**。
 */
const json = (name, codec) => ({ name, wire: name, source: 'json', codec });

/**
 * 七个方法的描述符。
 *
 * 方法名/线名都过 `^[A-Za-z0-9_$.-]+$`；`implementation` 就是 Service 上的方法名
 * （这里与 wire 方法名一致，保持可读）。
 */
export function remoteDescriptors() {
  const t = (name) => `${REMOTE_PACKAGE}/types#${name}`;
  const base = (method) => ({
    id: `${REMOTE_PACKAGE}#${REMOTE_NAMESPACE}/${method}`,
    service: REMOTE_SERVICE_KEY,
    namespace: REMOTE_NAMESPACE,
    method,
    implementation: method,
    invocation: { kind: 'direct' },
  });

  return [
    {
      ...base('list'),
      parameters: [],
      // 候选清单 + **待确认的技能草稿**：
      // `{groups: [{key, seedTitle, members, score, reasons}], restKeys, pendingDistill,
      //   pendingSkills: [{name, description, content, installPath}]}`
      result: strict(t('SuggestionFeed'), asJson),
    },
    {
      ...base('dismiss'),
      parameters: [json('key', strict(t('ClusterKey'), asKey))],
      result: strict(t('SuggestionState'), asJson),
    },
    {
      ...base('markSeen'),
      parameters: [json('keys', strict(t('ClusterKeyList'), asKeyList))],
      result: strict(t('SuggestionState'), asJson),
    },
    {
      ...base('requestDistill'),
      parameters: [json('key', strict(t('ClusterKey'), asKey))],
      result: strict(t('SuggestionState'), asJson),
    },
    // ── 缺陷 25：界面上真正把技能提炼出来（会调模型），以及装/丢 ──
    {
      ...base('distill'),
      parameters: [json('key', strict(t('ClusterKey'), asKey))],
      // `{ok:true, name, description, content, cluster:[标题], installPath}`
      // 或 `{ok:false, error, disabled?}`（禁用/没模型/自校验失败 —— 全部如实带回界面）
      result: strict(t('SkillDraft'), asJson),
    },
    {
      ...base('approve'),
      parameters: [json('name', strict(t('SkillName'), asName))],
      result: strict(t('SkillInstall'), asJson),
    },
    {
      ...base('reject'),
      parameters: [json('name', strict(t('SkillName'), asName))],
      result: strict(t('SkillInstall'), asJson),
    },
  ];
}

/**
 * 一份贡献（contribution）。**两侧字段名不同**（真机踩过，别再猜）：
 *
 *   - 宿主（`dsh-typert-registry/lib/index.js:398` 的 `register()`）读的是
 *     **`contribution.invocations`** —— 它把这些当成"当前环境里谁实现这个端点"，
 *     放进 `localStore`，网关的 `resolveDescriptor()` 就查 `typert.local.get(endpoint)`；
 *   - 客户端（`dsh-api-gateway/lib/client.js` 的 `mountContribution`）读的是
 *     **`contribution.descriptors`**，放进 `typert.remotes` 并据此安装命名空间方法。
 *
 * 描述符本身的字段两边一样（`{id, service, namespace, method, implementation,
 * invocation, parameters, result}`）。同 package 同 face 会被注册表判重，
 * 所以两边 face 必须不同。
 *
 * @param {'host'|'client'} face - 哪一侧的贡献。
 */
export function remoteContribution(face) {
  const shared = { package: REMOTE_PACKAGE, face, schemas: [] };
  return face === 'host'
    ? { ...shared, invocations: remoteDescriptors() }
    : { ...shared, descriptors: remoteDescriptors() };
}

/**
 * 造宿主侧的 Service 对象（就是被 `descriptor.service` 指向的那个）。
 *
 * 三个要点：
 *   - `descriptor.implementation` 必须能在它身上取到同名方法；
 *   - 必须挂 `typertRemote` 绑定，否则网关直接 `gateway/binding-invalid`；
 *   - 绑定里的 `service` 必须是**这个对象本身**（网关按 `===` 比对原始对象）。
 *
 * @param impl - `{list, dismiss, markSeen, requestDistill, distill, approve, reject}` 七个实现。
 */
export function createRemoteService(impl) {
  const service = {
    list: (...args) => impl.list(...args),
    dismiss: (...args) => impl.dismiss(...args),
    markSeen: (...args) => impl.markSeen(...args),
    requestDistill: (...args) => impl.requestDistill(...args),
    // 缺陷 25：界面上的「提炼成技能」要能真的拿到 SKILL.md 草稿，而不是只记一条待办。
    distill: (...args) => impl.distill(...args),
    approve: (...args) => impl.approve(...args),
    reject: (...args) => impl.reject(...args),
  };
  Object.defineProperty(service, 'typertRemote', {
    value: Object.freeze({ service, serviceKey: REMOTE_SERVICE_KEY, namespace: REMOTE_NAMESPACE }),
    enumerable: false,
  });
  return service;
}

/**
 * 把宿主侧能力装上去：**provide 服务** + **注册贡献** + **自校验**。
 *
 * ⚠️ 第三步不能省。第一版没有它，`ctx.typert.register()` 收下了我写错字段名的贡献
 * （宿主读 `invocations`，我给了 `descriptors`）却没报错 → status.md 写着
 * 「✅ 已装上（4 个端点）」，而探针一查 **0/4 可路由**。
 * 这就是本项目最忌讳的"看起来装了其实没装"，所以现在**注册完立刻回读**：
 * `typert.local.get('<ns>/<method>')` 拿不到就判失败，并把已注册的东西撤掉。
 *
 * @param ctx - 宿主上下文（会用 `ctx.inject(['typert'], …)` 做可选依赖）。
 * @param impl - 七个实现。
 * @returns `{ok: true, dispose}` 或 `{ok: false, reason}`
 */
export function installRemoteHost(ctx, impl) {
  if (typeof ctx?.inject !== 'function') return { ok: false, reason: '上下文没有 inject（拿不到 typert 服务）' };
  let dispose = null;
  let failure = null;
  try {
    ctx.inject(['typert'], (child) => {
      try {
        const service = createRemoteService(impl);
        const teardown = [];
        child.effect(() => {
          // provide 的两种写法都试：公开糖 `ctx.provide`，以及 Service 基类内部用的
          // `ctx.reflect.provide`。宿主版本之间只保证有一个。
          if (typeof child.provide === 'function') child.provide(REMOTE_SERVICE_KEY, service);
          else if (typeof child.reflect?.provide === 'function') child.reflect.provide(REMOTE_SERVICE_KEY, service);
          else throw new Error('宿主上下文既没有 provide 也没有 reflect.provide');
        }, `dsh-memfuse: provide ${REMOTE_SERVICE_KEY}`);
        teardown.push(child.typert.register(remoteContribution('host')));

        // 自校验：端点必须真的可路由（网关就是查这张表决定"谁来实现"）
        const missing = [];
        for (const [method, endpoint] of Object.entries(REMOTE_ENDPOINTS)) {
          let found;
          try {
            found = child.typert?.local?.get?.(endpoint);
          } catch (error) {
            missing.push(`${endpoint}（查表抛错：${error && error.message}）`);
            continue;
          }
          if (!found) missing.push(`${endpoint}（要的 method=${method}）`);
        }
        if (missing.length) {
          throw new Error(
            `贡献注册后端点仍不可路由：${missing.join('、')} —— ` +
              '宿主读的是 contribution.invocations（客户端才是 descriptors），字段名/形状要跟宿主对齐',
          );
        }
        dispose = () => {
          for (const d of teardown) if (typeof d === 'function') d();
        };
      } catch (error) {
        failure = String(error && error.message ? error.message : error);
      }
    });
  } catch (error) {
    return { ok: false, reason: String(error && error.message ? error.message : error) };
  }
  if (failure) return { ok: false, reason: failure };
  return {
    ok: true,
    dispose: () => {
      if (typeof dispose === 'function') dispose();
    },
  };
}
