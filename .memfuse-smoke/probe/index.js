/**
 * 冒烟探针：把宿主**实际组装**出来的 system prompt 里与 memfuse 有关的块抓出来落盘。
 *
 * 为什么需要它：Block E 是零 LLM 的，但"零 LLM"只证明**不需要模型**，
 * 不证明**宿主真的把它拼进了提示词**。这个探针走的是宿主自己的
 * `systemPrompt.assemble()`，抓到什么就是宿主真会发给模型的东西。
 *
 * 只读：不注册任何 section，不改任何状态。
 */
import fsp from 'node:fs/promises';

export const name = 'memfuse-probe';
export const inject = ['systemPrompt'];

/**
 * 探针要查的端点 —— 与 `lib/remote.js` 的 `REMOTE_ENDPOINTS` **同一份清单**。
 *
 * 为什么不 import 那个常量：探针是**独立进程里的另一个插件**（夹具 profile 里
 * 单独挂的），它不该依赖被测包的内部模块路径；但清单必须一致 ——
 * 少列一个的后果是"探针说全绿、实际少一个端点"，正是本项目最忌讳的那种假绿。
 * 加端点时**两边一起加**（`lib/remote.js` + 这里），`npm test` 会盯住插件那侧。
 */
const ENDPOINTS = [
  'memfuse/list',
  'memfuse/dismiss',
  'memfuse/markSeen',
  'memfuse/requestDistill',
  // 缺陷 25：界面上的「提炼成技能」当场写 SKILL.md → 草稿预览 → 装 / 丢
  'memfuse/distill',
  'memfuse/approve',
  'memfuse/reject',
];

const METHODS = ENDPOINTS.map((endpoint) => endpoint.slice('memfuse/'.length));

/**
 * 顺手把**界面数据通道**（Remote）的落地情况抓下来。
 *
 * 为什么要在真宿主里查这个：宿主注册表是**纯运行时**校验的
 * （`validateWireName` / `validateCodec` / `gateway/binding-invalid`），
 * 离线测试只能照着规则抄一遍断言。真机这一查才是"宿主到底认不认"的判据：
 *   - `ctx.typert.local.get('memfuse/list')` 有值 ⇒ 宿主侧贡献被接受、可路由；
 *   - `ctx.get('memfuseRemote')` 有值 ⇒ Service 已 provide（网关要拿它取方法）。
 */
function probeRemote(ctx) {
  const report = { endpoints: {}, service: null, errors: [] };
  try {
    const typert = typeof ctx.get === 'function' ? ctx.get('typert') : undefined;
    if (!typert) return { ...report, errors: ['宿主没有 typert 服务'] };
    for (const endpoint of ENDPOINTS) {
      try {
        const descriptor = typert.local?.get?.(endpoint);
        report.endpoints[endpoint] = descriptor
          ? { ok: true, service: descriptor.service, method: descriptor.method }
          : { ok: false };
      } catch (e) {
        report.endpoints[endpoint] = { ok: false, error: String(e && e.message) };
      }
    }
    const svc = ctx.get('memfuseRemote');
    report.service = svc
      ? { ok: true, methods: METHODS.filter((m) => typeof svc[m] === 'function') }
      : { ok: false };
  } catch (e) {
    report.errors.push(String(e && e.message));
  }
  return report;
}

export function apply(ctx, config = {}) {
  const out = config.out || 'probe-report.json';
  const delayMs = config.delayMs ?? 3000;

  const timer = setTimeout(async () => {
    try {
      const asm = await ctx.systemPrompt.assemble({});

      // 组装的产物形状随版本可能变；把能看到的都抓下来，别猜。
      const pick = (arr) =>
        Array.isArray(arr)
          ? arr.map((x) => ({
              name: x && x.name,
              chars: typeof (x && x.text) === 'string' ? x.text.length : 0,
              text: typeof (x && x.text) === 'string' ? x.text : null,
            }))
          : [];

      const payload = {
        at: new Date().toISOString(),
        assemblyKeys: asm && typeof asm === 'object' ? Object.keys(asm) : [],
        sections: pick(asm && asm.sections),
        contexts: pick(asm && asm.contexts),
        remote: probeRemote(ctx),
      };

      await fsp.writeFile(out, JSON.stringify(payload, null, 2), 'utf8');

      const hits = [...payload.sections, ...payload.contexts].filter(
        (x) => typeof x.text === 'string' && x.text.includes('Super Memory'),
      );
      console.log(`[memfuse-probe] 组装产物已写入 ${out}`);
      console.log(`[memfuse-probe] 含 "Super Memory" 的块：${hits.length} 个`);
      for (const h of hits) console.log(`  - ${h.name} (${h.chars} 字符)`);
      const r = payload.remote;
      const okCount = Object.values(r.endpoints).filter((e) => e.ok).length;
      const total = Object.keys(r.endpoints).length;
      console.log(
        `[memfuse-probe] Remote 端点：${okCount}/${total} 可路由；服务 memfuseRemote：${r.service?.ok ? '已 provide' : '缺失'}`,
      );
      if (r.errors.length) for (const e of r.errors) console.log(`  ⚠️ ${e}`);
    } catch (e) {
      console.error(`[memfuse-probe] assemble 失败：${e && e.message}`);
      try {
        await fsp.writeFile(out, JSON.stringify({ error: String(e && e.message) }, null, 2), 'utf8');
      } catch {
        /* 落盘失败就算了 */
      }
    }
  }, delayMs);

  // 刻意**不 unref**：headless 跑完任务会立刻退出，
  // unref 会让定时器不阻止退出 → 探针永远写不出文件（静默）。
  // 宁可让夹具多等几秒，也不要一个"看起来跑了其实没跑"的探针。
  void timer;
}
