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
      };

      await fsp.writeFile(out, JSON.stringify(payload, null, 2), 'utf8');

      const hits = [...payload.sections, ...payload.contexts].filter(
        (x) => typeof x.text === 'string' && x.text.includes('Super Memory'),
      );
      console.log(`[memfuse-probe] 组装产物已写入 ${out}`);
      console.log(`[memfuse-probe] 含 "Super Memory" 的块：${hits.length} 个`);
      for (const h of hits) console.log(`  - ${h.name} (${h.chars} 字符)`);
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
