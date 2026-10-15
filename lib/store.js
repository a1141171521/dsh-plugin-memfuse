// 记忆存储层：一条记忆 = 一个 Markdown 文件（YAML frontmatter + 正文）。
//
// 设计依据（README P2）：纯文本、人类可读、可 git、可迁出。
// 刻意不引入 YAML 依赖：只支持我们实际使用的扁平标量 / 数组子集，
// 这样插件在任意 DSH 运行时里都能加载，不会因为缺依赖而整块失效。
//
// 往返（round-trip）纪律：emitScalar / parseScalar 必须严格对称。
// 2026-10-15 修复三处不对称（对抗性审查实测发现）：
//   1. emit 把 " 转义成 \"，parse 却只剥外层引号 → 每轮 read→write 反斜杠翻倍
//   2. 字符串里的换行会被行式 frontmatter 解析静默截断 → 写时折成空格
//   3. 数组元素含逗号时会被 emit 成裸值 → parse 按逗号切开，一个 tag 裂成两个
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { layout, bucketOf, memoryRoot } from './paths.js';

// ───────────────────────────── frontmatter ─────────────────────────────

const FM = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function parseScalar(raw) {
  const v = raw.trim();
  if (v === '' || v === 'null' || v === '~') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+$/.test(v)) return Number(v);
  if (/^-?\d*\.\d+$/.test(v)) return Number(v);
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return splitTopLevel(inner).map((s) => parseScalar(s));
  }
  if (v.startsWith('{') && v.endsWith('}')) {
    const inner = v.slice(1, -1).trim();
    const out = {};
    if (!inner) return out;
    for (const pair of splitTopLevel(inner)) {
      const i = pair.indexOf(':');
      if (i === -1) continue;
      out[pair.slice(0, i).trim()] = parseScalar(pair.slice(i + 1));
    }
    return out;
  }
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
    // 与 emitScalar 对称：还原 \" 与 \\。缺了这一步，正文里出现的每个反斜杠
    // （Windows 路径、正则、转义序列）都会在每次 read→write 后翻倍。
    return v.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) {
    return v.slice(1, -1);
  }
  return v;
}

/** 按顶层逗号切分（忽略引号内的逗号），供数组 / 内联对象解析使用。 */
function splitTopLevel(inner) {
  const out = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      if (ch === '\\' && i + 1 < inner.length) {
        cur += ch + inner[++i];
        continue;
      }
      if (ch === quote) quote = null;
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === ',') {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter((s) => s !== '');
}

function parseFrontmatter(text) {
  const m = text.match(FM);
  if (!m) return { data: {}, body: text };
  const data = {};
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const i = line.indexOf(':');
    if (i === -1) continue;
    const key = line.slice(0, i).trim();
    if (!key) continue;
    data[key] = parseScalar(line.slice(i + 1));
  }
  return { data, body: text.slice(m[0].length) };
}

function needsQuote(s) {
  return (
    /^[\s>|*&!%@`[\]{},#-]|[:#]\s|^\s|\s$/.test(s) ||
    // 含逗号必须引号包裹：否则数组元素会被 parse 按逗号切开（一个 tag 裂成两个）
    s.includes(',') ||
    s === '' ||
    /^(true|false|null|~|-?\d)/.test(s)
  );
}

function emitScalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return '[' + v.map((x) => emitScalar(x)).join(', ') + ']';
  if (typeof v === 'object') {
    return '{ ' + Object.entries(v).map(([k, x]) => `${k}: ${emitScalar(x)}`).join(', ') + ' }';
  }
  // 换行在行式 frontmatter 里无法往返（解析只取首行）→ 折成空格，
  // 避免「标题含换行被静默截断」这类看不见的数据丢失。
  const s = String(v).replace(/\r?\n/g, ' ');
  return needsQuote(s) ? '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"' : s;
}

function emitFrontmatter(data) {
  const order = [
    'id', 'scope', 'kind', 'priority', 'confidence', 'title', 'summary', 'anchor',
    'tags', 'source', 'created', 'updated', 'expires', 'lifecycle', 'dormantAt',
    'stats', 'sessions', 'sessionCount', 'promotedAt', 'promotedFrom', 'derivedInto',
    'revision', 'stale', 'supersededBy', 'conflict', 'stable',
  ];
  const keys = [...order.filter((k) => k in data), ...Object.keys(data).filter((k) => !order.includes(k))];
  const lines = keys.map((k) => `${k}: ${emitScalar(data[k])}`);
  return `---\n${lines.join('\n')}\n---\n`;
}

// ───────────────────────────── drift guard ─────────────────────────────

/** 整文件重写被拒时抛这个（磁盘内容无法安全解析）。 */
export class DriftError extends Error {
  constructor(message, file, backup) {
    super(message);
    this.name = 'DriftError';
    this.file = file;
    this.backup = backup;
  }
}

/**
 * 磁盘内容是否「规范」——即能否被我们安全地整文件重写。
 *
 * 判据（宁可漏判也不要误判，误判会把合法写入变成硬拒写）：
 *   - 空文件 → 视为新建，允许
 *   - 没有 frontmatter 块 → 不是我们的格式，拒绝重写
 *   - frontmatter 里缺 id → 无法安全重写（会丢身份）
 *   - frontmatter 里出现既非空、非注释、又没有冒号的行 → 有外部内容，拒绝
 *
 * 依据：evolve 的 `isCanonical = serializeEntries(parseEntries(t)) === t`，
 * 但我们的格式是 frontmatter + 正文（不是 § 分隔的行式），所以判据要改写。
 */
export function isCanonical(text) {
  const t = String(text || '');
  if (t.trim() === '') return true;
  const m = t.match(FM);
  if (!m) return false;
  const { data } = parseFrontmatter(t);
  if (!data || !data.id) return false;
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (line.indexOf(':') === -1) return false;
  }
  return true;
}

// ───────────────────────────── 跨进程锁 ─────────────────────────────

/** 超过这个时长仍存在的锁视为被遗弃（进程被杀）。 */
const STALE_LOCK_MS = 10_000;
/** 等锁的最长时间，超时就明确报错而不是静默继续。 */
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 25;

/**
 * 用锁文件串行化一段写操作。
 *
 * 为什么需要：`write + rebuildIndex + commit` 三步不是原子的，而 desktop 与
 * web 两个 profile 默认共用 `~/.dsh/memory`。没有锁就是 last-writer-wins，
 * `index.md` 会被对方整个覆盖。
 */
export async function withLock(lockPath, fn, opts = {}) {
  const staleMs = opts.staleMs ?? STALE_LOCK_MS;
  const timeoutMs = opts.timeoutMs ?? LOCK_TIMEOUT_MS;
  const retryMs = opts.retryMs ?? LOCK_RETRY_MS;
  const started = Date.now();
  let acquired = false;

  while (Date.now() - started < timeoutMs) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, `${process.pid}@${new Date().toISOString()}`);
      fs.closeSync(fd);
      acquired = true;
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > staleMs) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        /* 锁刚被别人释放，下一轮重试 */
      }
      await new Promise((r) => setTimeout(r, retryMs));
    }
  }
  if (!acquired) {
    throw new Error(`获取锁超时（${lockPath} 超过 ${timeoutMs}ms）`);
  }
  try {
    return await fn();
  } finally {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      /* 已被清理 */
    }
  }
}

// ───────────────────────────── git（可选，失败不阻断）─────────────────────────────

function git(root, args) {
  return new Promise((resolve) => {
    const p = spawn('git', args, { cwd: root, windowsHide: true });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', () => resolve({ ok: false, out: '', err: 'git not available' }));
    p.on('close', (code) => resolve({ ok: code === 0, out: out.trim(), err: err.trim(), code }));
  });
}

export class MemoryStore {
  constructor(config, logger = console) {
    this.config = config || {};
    this.root = layout(memoryRoot(this.config));
    this.log = logger;
    this.gitEnabled = this.config.git !== false;
  }

  async init() {
    for (const dir of [
      this.root.root, this.root.memories, this.root.skills, this.root.sessions,
      this.root.adhoc, this.root.meta, this.root.pending, this.root.pendingSkills,
    ]) {
      await fsp.mkdir(dir, { recursive: true });
    }
    if (this.gitEnabled) {
      const check = await git(this.root.root, ['rev-parse', '--git-dir']);
      if (!check.ok) {
        await git(this.root.root, ['init', '-q']);
        await git(this.root.root, ['config', 'user.name', 'dsh-memfuse']);
        await git(this.root.root, ['config', 'user.email', 'dsh-memfuse@local']);
      }
    }
  }

  filePath(id, kind) {
    const bucket = bucketOf(kind || 'fact');
    return path.join(this.root[bucket], `${id}.md`);
  }

  /** 读取一条记忆；不存在返回 null */
  async read(id, kind) {
    const buckets = kind ? [bucketOf(kind)] : ['memories', 'skills'];
    for (const bucket of buckets) {
      const p = path.join(this.root[bucket], `${id}.md`);
      try {
        const raw = await fsp.readFile(p, 'utf8');
        const { data, body } = parseFrontmatter(raw);
        return { ...data, id: data.id || id, body: body.trim(), _path: p, _bucket: bucket };
      } catch (e) {
        if (e.code !== 'ENOENT') {
          this.lastListError = `${id}: ${e.message}`;
          this.log.warn?.(`[dsh-memfuse] read ${id}: ${e.message}`);
        }
      }
    }
    return null;
  }

  /** 锁文件路径（整个记忆库一把锁）。 */
  get lockPath() {
    return path.join(this.root.meta, '.lock');
  }

  /** 在锁内执行一段写操作（串行化 write + rebuildIndex + commit）。 */
  async locked(fn) {
    return withLock(this.lockPath, fn);
  }

  /**
   * 原子写入（先写临时文件再 rename）。
   *
   * 覆盖已存在的文件前会先做 drift guard：磁盘内容无法安全解析时
   * **备份成 `<file>.bak.<时间戳>` 并抛 DriftError**，绝不静默覆盖。
   * 传 `{ force: true }` 可跳过（仅用于明确的"我知道在做什么"场景）。
   */
  async write(rec, opts = {}) {
    const p = this.filePath(rec.id, rec.kind);
    if (!opts.force && fs.existsSync(p)) {
      let existing = null;
      try {
        existing = await fsp.readFile(p, 'utf8');
      } catch {
        existing = null;
      }
      if (existing !== null && !isCanonical(existing)) {
        const backup = `${p}.bak.${Date.now()}`;
        await fsp.writeFile(backup, existing, 'utf8');
        throw new DriftError(
          `磁盘内容无法通过往返校验，已备份到 ${path.basename(backup)} 并拒绝重写`,
          p,
          backup,
        );
      }
    }
    // 剥掉全部内部字段（_path / _bucket …）：它们只在内存里用，
    // 落进 frontmatter 会污染文件，也让 round-trip 校验失去意义。
    const data = {};
    for (const [k, v] of Object.entries(rec)) {
      if (k === 'body' || k.startsWith('_')) continue;
      data[k] = v;
    }
    data.updated = data.updated || new Date().toISOString();
    const text = emitFrontmatter(data) + '\n' + String(rec.body || '').trim() + '\n';
    const tmp = `${p}.tmp-${process.pid}`;
    await fsp.writeFile(tmp, text, 'utf8');
    await fsp.rename(tmp, p);
    return p;
  }

  /**
   * 删除一条记忆。kind 未知时（手写文件没有 kind 字段）两桶都试——
   * 否则会出现「计划里选中了它、unlink 却指向另一个目录 → ENOENT → 静默失败」。
   */
  async remove(id, kind) {
    const buckets = kind ? [bucketOf(kind)] : ['memories', 'skills'];
    for (const bucket of buckets) {
      const p = path.join(this.root[bucket], `${id}.md`);
      try {
        await fsp.unlink(p);
        return true;
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    }
    return false;
  }

  /** 列出全部记忆（不含 sessions / ad-hoc） */
  async list() {
    // 目录不存在是正常状态（init 会建）；**其它**读取错误必须暴露出来，
    // 否则「记忆库读不出来」会静默表现为「记忆是空的」——那正是本项目
    // 最反对的失败模式。调用方读 this.lastListError 判断。
    this.lastListError = null;
    const out = [];
    const seen = new Set();
    for (const bucket of ['memories', 'skills']) {
      const dir = this.root[bucket];
      let names = [];
      try {
        names = await fsp.readdir(dir);
      } catch (e) {
        if (e.code !== 'ENOENT') this.lastListError = `${bucket}: ${e.message}`;
        continue;
      }
      const wanted = names.filter((n) => n.endsWith('.md') && !n.startsWith('.'));
      // **并行**读文件。实测 600 条：串行 await 逐个读 = 97.6ms，
      // 并行 = 21.4ms（含 parse 25.5ms）。串行读是这里唯一的瓶颈，
      // 而并行化只花 3 行代码 —— 这也是"不加派生索引"的依据（见 docs/spec.md §3.7）。
      const recs = await Promise.all(
        wanted.map(async (name) => {
          const id = name.slice(0, -3);
          const p = path.join(dir, name);
          try {
            const raw = await fsp.readFile(p, 'utf8');
            const { data, body } = parseFrontmatter(raw);
            return { ...data, id: data.id || id, body: body.trim(), _path: p, _bucket: bucket };
          } catch (e) {
            if (e.code !== 'ENOENT') this.lastListError = `${id}: ${e.message}`;
            return null;
          }
        }),
      );
      for (const rec of recs) {
        // 同 id 落在两个桶时只认第一次（memories 优先），避免重复计数
        if (!rec || seen.has(rec.id)) continue;
        seen.add(rec.id);
        out.push(rec);
      }
    }
    return out;
  }

  /** 用户手写笔记（最高信任的输入之一，但仍只是数据） */
  async listAdhoc() {
    let names = [];
    try {
      names = await fsp.readdir(this.root.adhoc);
    } catch {
      return [];
    }
    const out = [];
    for (const name of names) {
      if (!/\.(md|txt)$/i.test(name)) continue;
      try {
        const text = await fsp.readFile(path.join(this.root.adhoc, name), 'utf8');
        out.push({ name, text });
      } catch {
        /* ignore */
      }
    }
    return out;
  }

  /**
   * 提交。返回值**必须被调用方检查**：`.git/index.lock` 冲突等情况下
   * commit 会失败，早期版本把返回值丢掉了，于是"提交失败"零留痕。
   */
  async commit(message) {
    if (!this.gitEnabled) return { ok: false, reason: 'disabled' };
    await git(this.root.root, ['add', '-A']);
    const r = await git(this.root.root, ['commit', '-q', '-m', message]);
    if (!r.ok && /nothing to commit/i.test(r.out + r.err)) return { ok: true, reason: 'no-change' };
    return r;
  }

  /**
   * 追加一条使用 / 反馈 / 升级事件到 `.memory/usage.jsonl`（append-only）。
   *
   * 刻意**不加锁**：调用点常常已经在 `locked()` 里（锁不可重入，再加一次会死锁）。
   * 单行 JSON 很小，`fs.appendFile` 的 'a' 标志在 Windows 上映射到
   * FILE_APPEND_DATA，小写入是原子的，不会互相插入。
   */
  async appendUsage(event) {
    try {
      const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n';
      await fsp.appendFile(this.root.usage, line, 'utf8');
      return true;
    } catch (e) {
      this.log.warn?.(`[dsh-memfuse] 写 usage 日志失败：${e.message}`);
      return false;
    }
  }

  /** 重新生成 index.md（L0 总索引） */
  async rebuildIndex() {
    const all = (await this.list()).filter((r) => (r.lifecycle || 'active') === 'active');
    const byBucket = { memories: [], skills: [] };
    for (const r of all) {
      const b = bucketOf(r.kind);
      byBucket[b].push(r);
    }
    const rank = { P0: 0, P1: 1, P2: 2 };
    const lines = ['# Memory Index', '', `> 自动生成，请勿手工编辑。共 ${all.length} 条。`, ''];
    for (const [bucket, title] of [['memories', 'Memories'], ['skills', 'Skills']]) {
      const rows = byBucket[bucket].sort(
        (a, b) => (rank[a.priority] ?? 3) - (rank[b.priority] ?? 3) || String(b.updated).localeCompare(String(a.updated)),
      );
      if (!rows.length) continue;
      lines.push(`## ${title} (${rows.length})`, '');
      for (const r of rows) {
        const tags = (r.tags || []).map((t) => `#${t}`).join(' ');
        lines.push(`- [${r.priority || 'P2'}] ${r.title}${tags ? ` ${tags}` : ''}  <!-- ${r.id} -->`);
      }
      lines.push('');
    }
    await fsp.writeFile(this.root.index, lines.join('\n'), 'utf8');
    return this.root.index;
  }
}

export { parseFrontmatter, emitFrontmatter };
export const _internal = { parseScalar, emitScalar, splitTopLevel };
