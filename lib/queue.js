/**
 * dsh-memfuse — 待确认队列（E6）。
 *
 * ## 为什么需要它
 *
 * 「AI 只提议，你确认」是这套系统里唯一能挡住"自主学习把记忆搞坏"的机制。
 * 由自动抽取产生、会真实改变 AI 行为的写入，都先落到这里，由用户决定
 * 采纳（approve）还是丢弃（reject）。
 *
 * ## 存储形态：一条一项一个文件
 *
 * `<root>/.memory/pending/<slug>.json`
 *
 * 刻意**不用**单个 JSONL 追加：Windows 上 `appendFile` 不是原子的，
 * 多会话/多进程并发写会互相插入（对抗性审查点名过这一点）。
 * 一文件一项 = 天然原子，而且被拒绝时删一个文件就行。
 *
 * 零依赖（node:fs only）。
 *
 * @module dsh-memfuse/queue
 */
import fsp from 'node:fs/promises';
import path from 'node:path';

/** 队列目录。 */
export function pendingDir(root) {
  return path.join(root.meta, 'pending');
}

/**
 * 由标题生成稳定的 slug（文件名安全）。
 * 中文标题保留（Windows 允许），只剥掉非法字符与路径分隔符。
 */
export function slugOf(title, id) {
  const base = String(title || 'untitled')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 40)
    .replace(/^[.\s-]+|[.\s-]+$/g, '');
  const suffix = String(id || '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(-6);
  return `${base || 'untitled'}${suffix ? `-${suffix}` : ''}`;
}

/** 列全部待确认项（按 createdAt 升序）。坏文件跳过并计数。 */
export async function listPending(root) {
  const dir = pendingDir(root);
  let names = [];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue;
    try {
      const raw = await fsp.readFile(path.join(dir, name), 'utf8');
      const item = JSON.parse(raw);
      out.push({ ...item, _file: name });
    } catch {
      /* 坏文件跳过：队列读不出来不该阻断整个记忆系统 */
    }
  }
  return out.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
}

/** 入队一项。返回落盘路径。 */
export async function putPending(root, item) {
  const dir = pendingDir(root);
  await fsp.mkdir(dir, { recursive: true });
  const slug = slugOf(item.title, item.id);
  const file = path.join(dir, `${slug}.json`);
  const tmp = `${file}.tmp-${process.pid}`;
  await fsp.writeFile(tmp, JSON.stringify(item, null, 2), 'utf8');
  await fsp.rename(tmp, file);
  return file;
}

/**
 * 按标题或 id 精确匹配一项（也接受 slug）。
 * @returns {object|null} 命中项（带 `_file`），未命中返回 null。
 */
export async function findPending(root, match) {
  const needle = String(match || '').trim();
  if (!needle) return null;
  const all = await listPending(root);
  return (
    all.find((i) => i.id === needle) ||
    all.find((i) => i.title === needle) ||
    all.find((i) => i._file === `${needle}.json`) ||
    null
  );
}

/** 从队列里移除一项（approve / reject 都用它）。 */
export async function dropPending(root, file) {
  try {
    await fsp.unlink(path.join(pendingDir(root), file));
    return true;
  } catch {
    return false;
  }
}
