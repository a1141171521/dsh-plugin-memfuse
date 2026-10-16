/**
 * 预览页（`docs/preview/turn-tail-card.html`）的**离屏自检**。
 *
 * 为什么要有：预览页是给人看的 —— 打开是白屏、或者按钮点不动，比没有还丢人。
 * 浏览器不方便在 CI 里跑，所以这里用一份迷你 DOM 把同一套运行时
 * （`docs/preview/preview.mjs` + 真的 `lib/client.js`）跑起来，断言：
 *   1. 卡片渲染出标题、种子标题、`N 条记忆 · M 分`、作用；
 *   2. 「渲染即记 seen」真的发生了（这就是「不一直提示」）；
 *   3. 走的确实是 `$mount` → `ctx.inject(['remote.memfuse', …])` 这条注入链；
 *   4. 点「提炼成技能」之后**真的能看到草稿**（技能名 + 作用 + SKILL.md 原文 + 装/丢），
 *      并且装/丢分别打到宿主的 `approve` / `reject`（缺陷 25）。
 *
 * ⚠️ 与 client.test.mjs 同样**不经 `node --test` 跑**（见那个文件顶部的说明）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const REPO = path.resolve(import.meta.dirname, '..');
const CLIENT = path.join(REPO, 'lib', 'client.js');
const PREVIEW = path.join(REPO, 'docs', 'preview', 'preview.mjs');

/**
 * 把一个节点的文字全收出来。
 * ⚠️ 元素节点既可能是"子节点里带文本"（jsx 那条路），也可能是直接写的
 * `textContent`（预览里那句占位文案）—— 两种都要收，否则断言会看到空串。
 */
const collectText = (node) => {
  if (node.nodeType === 3) return node.textContent;
  const children = node.childNodes ?? [];
  if (children.length > 0) return children.map(collectText).join('');
  return node.textContent ?? '';
};

const walk = (node, out = []) => {
  out.push(node);
  for (const child of node.childNodes ?? []) walk(child, out);
  return out;
};

function makeNode(tag) {
  return {
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    className: '',
    childNodes: [],
    attributes: Object.create(null),
    listeners: Object.create(null),
    dataset: Object.create(null),
    textContent: '',
    setAttribute(key, value) {
      this.attributes[key] = value;
    },
    addEventListener(type, fn) {
      (this.listeners[type] ??= []).push(fn);
    },
    appendChild(child) {
      this.childNodes.push(child);
      return child;
    },
    replaceChildren(...children) {
      this.childNodes = [];
      for (const child of children) if (child !== null && child !== undefined) this.appendChild(child);
    },
    click() {
      for (const fn of this.listeners.click ?? []) fn({ target: this });
    },
  };
}

/** 建一个假浏览器环境 + 跑起来的预览。 */
async function bootPreview() {
  const document = {
    createElement: makeNode,
    createTextNode: (text) => ({ nodeType: 3, textContent: String(text), childNodes: [] }),
    querySelector: () => null,
    head: makeNode('head'),
  };
  let bundle = null;
  const window = {
    __ModuleLoader__: {
      load(spec) {
        bundle = spec;
      },
    },
    // 预览里"等 1.6 秒再去抖刷新"在测试里同步执行；返回真值避免 `?? render()` 双跑
    setTimeout(fn) {
      fn();
      return 1;
    },
  };

  // client.js 是浏览器 IIFE：把 window/document 注入进去执行
  new Function('window', 'document', fs.readFileSync(CLIENT, 'utf8'))(window, document);
  assert.ok(bundle, 'client.js 必须把 bundle 交给 window.__ModuleLoader__.load');

  const logs = [];
  const target = makeNode('div');
  const preview = (await import(pathToFileURL(PREVIEW).href)).startPreview({
    window,
    document,
    bundle,
    target,
    onLog: (line) => logs.push(line),
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  return { preview, logs, target, document };
}

test('预览页：真卡片在迷你 DOM 里渲染得出来，文字与插值都对', async () => {
  const { target } = await bootPreview();
  const text = collectText(target);
  assert.match(text, /记忆里出现了可固化成技能的簇/, '卡片标题');
  assert.match(text, /DSH 插件设置页四条件/, '第一组候选的种子标题');
  assert.match(text, /2 条记忆 · 7 分/, '成员数/分数要插值成文字（说明真字典没被写坏）');
  assert.match(text, /写 DSH 插件的配置页时召回/, 'useWhen 要出来');
  console.log('  ✅ 渲染：标题 + 种子 +「2 条记忆 · 7 分」+ 作用');
});

test('预览页：装配链是 $mount → ctx.inject(["remote.memfuse", …])', async () => {
  const { logs, target } = await bootPreview();
  assert.ok(
    logs.some((line) => line.startsWith('$mount(')),
    '必须先挂客户端贡献（remote.memfuse 那时才存在）',
  );
  assert.ok(
    logs.some((line) => line.includes("ctx.inject([remote.memfuse")),
    '必须用 ctx.inject 拿子 ctx（真机上的坑：根 ctx 拿不到 remote.memfuse）',
  );
  assert.ok(
    logs.some((line) => line.startsWith('markSeen(')),
    '渲染即记 seen：卡片渲染过之后要把 key 报给宿主（这就是「不一直提示」）',
  );
  assert.equal(walk(target).filter((node) => node.tagName === 'BUTTON').length, 2, '只显示 1 组 → 两个按钮');
  // 没显示出来的那几组要**说出来**（别装作不存在）
  assert.match(collectText(target), /另有 2 组同类候选/, '一行说明还剩几组、去哪儿看');
  console.log('  ✅ 装配顺序与注入链正确，且渲染即记 seen（只显示 1 组 + 说明还剩几组）');
});

test('预览页：点「提炼成技能」→ 草稿预览（提示词 + 作用）→ 装进技能库', async () => {
  const { logs, target } = await bootPreview();
  const buttons = walk(target).filter((node) => node.tagName === 'BUTTON');

  buttons.find((node) => collectText(node) === '提炼成技能').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(
    logs.some((line) => line.startsWith('distill(')),
    '点「提炼成技能」要打到宿主的 distill —— 缺陷 25 之前这里只记一条待办，界面什么都不显示',
  );

  // 第二阶段：技能名 + 作用 + **SKILL.md 原文** + 两个按钮，全都要看得见
  const draftText = collectText(target);
  assert.match(draftText, /技能草稿/, '要说清这是"装进去之后会注入的提示词"');
  assert.match(draftText, /## 什么时候用/, 'SKILL.md 正文要真的渲染出来');
  assert.match(draftText, /装进技能库会写到：/, '要告诉用户会落到哪儿');
  const approve = walk(target).find((node) => node.tagName === 'BUTTON' && collectText(node) === '装进技能库');
  assert.ok(approve, '草稿上必须有「装进技能库」按钮');
  assert.ok(
    walk(target).some((node) => node.tagName === 'BUTTON' && collectText(node) === '丢掉'),
    '草稿上必须有「丢掉」按钮',
  );

  approve.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(logs.some((line) => line.startsWith('approve(')), '点「装进技能库」要打到宿主的 approve');
  assert.match(collectText(target), /已装进技能库/, '装完要有一句结果说明（否则又是"点了没反应"）');
  console.log('  ✅ 提炼 → 草稿预览 → 装进技能库：整条第二阶段在预览页里走得通');
});

test('预览页：「不用（别再提）」打到宿主的 dismiss', async () => {
  const { logs, target } = await bootPreview();
  const buttons = walk(target).filter((node) => node.tagName === 'BUTTON');

  buttons.find((node) => collectText(node) === '不用（别再提）').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(logs.some((line) => line.startsWith('dismiss(')), '点「不用（别再提）」要打到宿主的 dismiss');
  console.log('  ✅ 「不用」按钮的远程调用对');
});

test('预览页：不点也会消失（seen），簇长大才会重新出现', async () => {
  const { preview, logs, target } = await bootPreview();
  assert.match(collectText(target), /DSH 插件设置页四条件/, '第一轮：卡片在');

  // ① 什么都不点，直接进下一轮 —— 渲染时已经记过 seen，所以下一轮不该再来。
  //    注意要等过卡片自己的 1.5s 去抖（那是设计行为）：窗口太近的话它不会重新拉数据。
  //    这个文件不经 `node --test` 跑，用 setTimeout 是安全的（见 client.test.mjs 顶部说明）。
  //    ⚠️ 必须用 `nextTurn()` 而不是 `render()`：卡片内容是按回合钉住的（缺陷 23），
  //    同一个回合里它本来就该一直在 —— 只有"下一轮"才该不再出现。
  await new Promise((resolve) => setTimeout(resolve, 1600));
  preview.nextTurn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.doesNotMatch(collectText(target), /DSH 插件设置页四条件/, '「看过」之后不再出现（这就是不打扰）');
  assert.match(collectText(target), /这里什么都没有/, '没有候选时这块是空的，不占位置');

  // ② 这一簇长大了（成员变了 → 簇身份 key 变）→ 视为新的一组 → 重新出现
  preview.scenario('长大了', (s) => s.grow('m_ui_9f2a', 2));
  await new Promise((resolve) => setTimeout(resolve, 1600));
  preview.render();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(collectText(target), /4 条记忆/, '簇长大之后要重新提一次');
  assert.ok(
    logs.some((line) => line.includes('场景：')),
    '场景动作要留日志',
  );
  console.log('  ✅ 不点也不再打扰；簇长大 → key 变 → 重新提一次');
});
