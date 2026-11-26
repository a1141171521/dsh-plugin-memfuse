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
import { randomUUID } from 'node:crypto';
import { layout, bucketOf, memoryRoot, userMemoryRoot, globalMemoryRoot, dshHome } from './paths.js';
import { VALID_SCOPES } from './policy.js';

/**
 * 查询作用域时的**优先级**：workspace → user → global。
 *
 * 与 `VALID_SCOPES` 是两件事：那个是「允许的取值」，这个是「同一个 id 在多个根
 * 都出现时先认谁」。用户在当前工作区写的那份应该压住同名的用户级/全局级记录。
 */
const SCOPE_ORDER = ['workspace', 'user', 'global'];

// ───────────────────────────── frontmatter ─────────────────────────────

const FM = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * 记忆 id = **不可信输入**，绝不许当路径片段直接用。
 *
 * 两条真实链路（审计 F-ST-05）：
 *   ① `memfuse_feedback` 的 id 只声明 `type: string` → `read('../../victim')`
 *      会把记忆根之外的任意 `.md` 读进来；
 *   ② 记忆文件里写 `id: ../../notes/important` → `memfuse_write delete/replace`
 *      会真的删/改根外文件，还回 `{ok:true}`。
 *
 * 判据：非空、不是 `.`/`..`、不含路径分隔符与 Windows 保留字符、basename 等于自身。
 * 允许中文/Unicode 字母（手写 id 不该被误杀），只挡真正能穿越路径的东西。
 */
const ID_FORBIDDEN = /[\\/:*?"<>|\u0000-\u001f]/;
export function safeId(id) {
  const s = String(id ?? '').trim();
  if (!s || s === '.' || s === '..') {
    throw new Error(`非法记忆 id：${JSON.stringify(String(id ?? ''))}`);
  }
  if (ID_FORBIDDEN.test(s) || path.basename(s) !== s) {
    throw new Error(`非法记忆 id（含路径分隔符或保留字符）：${JSON.stringify(s)}`);
  }
  return s;
}

/** tags 既接受数组，也接受手写文件里的 `tags: pnpm, tooling` 字符串（F-ST-02）。 */
function normalizeTags(raw) {
  if (Array.isArray(raw)) {
    return raw.filter((t) => typeof t === 'string').map((t) => t.trim()).filter(Boolean);
  }
  if (typeof raw === 'string' && raw.trim()) {
    return raw.split(',').map((t) => t.trim()).filter(Boolean);
  }
  return [];
}

/**
 * 把「解析出来的 frontmatter + 正文」规整成一条记录。
 *
 * 三件事都在这里收口（同一条纪律：**坏字段只影响它自己**）：
 *   - id 不合法（穿越 / 空）→ 退回文件名，并标 `_issues`；绝不让它进路径
 *   - tags 不是数组（手写的 `tags: pnpm, tooling`）→ 归一成数组，不再让
 *     `renderIndex` 的 `.map` 把整个写路径连坐（F-ST-02）
 *   - 文件名与 frontmatter id 不一致时，`_path` / `_fileId` 都带出来，
 *     删除 / 写回操作**用读到的那份文件**（F-ST-04）
 */
function recordFrom(data, body, { fallbackId, scope, filePath: p, bucket }) {
  const issues = [];
  let id = data.id == null ? fallbackId : String(data.id).trim();
  if (!id) id = fallbackId;
  try {
    safeId(id);
  } catch {
    issues.push('id');
    id = fallbackId;
  }
  if (!Array.isArray(data.tags) && data.tags != null && data.tags !== '') issues.push('tags');
  const rec = {
    ...data,
    id,
    tags: normalizeTags(data.tags),
    body: body.trim(),
    scope,
    _path: p,
    _bucket: bucket,
    _fileId: fallbackId,
  };
  if (issues.length) rec._issues = issues;
  return rec;
}

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

/**
 * 把一批记忆渲染成 `index.md`（纯函数）。
 *
 * 排序：P0 → P1 → P2，同级按 `updated` 倒序。抽出来是为了「每个根写自己的索引」
 * 之后格式只有一份实现 —— 三个根共用同一套规则。
 */
function renderIndex(rows) {
  const byBucket = { memories: [], skills: [] };
  for (const r of rows) byBucket[bucketOf(r.kind)].push(r);
  const rank = { P0: 0, P1: 1, P2: 2 };
  const lines = ['# Memory Index', '', `> 自动生成，请勿手工编辑。共 ${rows.length} 条。`, ''];
  for (const [bucket, title] of [['memories', 'Memories'], ['skills', 'Skills']]) {
    const list = byBucket[bucket].sort(
      (a, b) => (rank[a.priority] ?? 3) - (rank[b.priority] ?? 3) || String(b.updated).localeCompare(String(a.updated)),
    );
    if (!list.length) continue;
    lines.push(`## ${title} (${list.length})`, '');
    for (const r of list) {
      // tags 可能是手写文件里的字符串 —— 这里再兜一层，派生视图失败不该把写路径连坐（F-ST-02）
      const tagList = Array.isArray(r.tags) ? r.tags : normalizeTags(r.tags);
      const tags = tagList.map((t) => `#${t}`).join(' ');
      // 标题缺失时写占位符，不写 `undefined`（F-ST-03 的可见性要求）
      const label = String(r.title ?? '').trim() || '(无标题)';
      lines.push(`- [${r.priority || 'P2'}] ${label}${tags ? ` ${tags}` : ''}  <!-- ${r.id} -->`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export class MemoryStore {
  constructor(config, logger = console) {
    this.config = config || {};
    this.root = layout(memoryRoot(this.config));
    this.log = logger;
    this.gitEnabled = this.config.git !== false;
    /** 用户级/全局级的父目录。可注入（`config.dshHome`）—— 测试别碰真实 `~/.dsh`。 */
    this.dshHome = this.config.dshHome || dshHome();
    /**
     * 同进程内的按路径写队列。
     *
     * 光把 tmp 名加随机数还不够：Windows 上两个并发 `rename(tmp → 同一个目标)` 会
     * 返回 EPERM（目标正被替换）。而 `flushInjected()` 是 fire-and-forget，同一轮
     * 模型再调 `memfuse_recall` 就是两条并发写同一条记忆 —— 必有一条丢计数（F-ST-06）。
     * 这里按最终路径串行化；跨进程仍靠 withLock（F-ST-08 的范畴）。
     */
    this._writeQueues = new Map();
  }

  async init() {
    // 初始化主仓库
    for (const dir of [
      this.root.root, this.root.memories, this.root.skills, this.root.sessions,
      this.root.adhoc, this.root.meta, this.root.pending, this.root.pendingSkills,
    ]) {
      await fsp.mkdir(dir, { recursive: true });
    }
    
    // 只算布局、**不建目录**：没人用 user/global 这两级时，不该在用户主目录里凭空
    // 多出两个空文件夹（真机踩过：跑一次 `npm test` 就多两个）。写的时候按需建，
    // 见 `ensureRoot()`；读的时候目录不存在按「空」处理（ENOENT 已容忍）。
    this.userRoot = layout(userMemoryRoot(this.dshHome));
    this.globalRoot = layout(globalMemoryRoot(this.dshHome));

    if (this.gitEnabled) {
      const check = await git(this.root.root, ['rev-parse', '--git-dir']);
      if (!check.ok) {
        await git(this.root.root, ['init', '-q']);
        await git(this.root.root, ['config', 'user.name', 'dsh-memfuse']);
        await git(this.root.root, ['config', 'user.email', 'dsh-memfuse@local']);
      }
    }
  }

  /** 某个作用域对应的根；init 之前（或该根没建起来）返回 null，由调用方跳过。 */
  rootOfScope(scope) {
    if (scope === 'user') return this.userRoot ?? null;
    if (scope === 'global') return this.globalRoot ?? null;
    return this.root;
  }

  /**
   * 按优先级列出要查的 `[scope, root]`。
   *
   * 指定 `scope` 时**只查那一个** —— 这是「同名 id 在别的作用域也有一份」时
   * 不误删/误改的前提（否则 delete 会删掉优先级更高的那份）。
   */
  rootsFor(scope) {
    const wanted = scope ? [scope] : SCOPE_ORDER;
    const out = [];
    for (const name of wanted) {
      const root = this.rootOfScope(name);
      if (root) out.push([name, root]);
    }
    return out;
  }

  /**
   * 按需建某个作用域的目录（`init()` 只建 workspace 那套）。
   *
   * 幂等、只建该作用域的 `memories/skills/meta` 三个目录 —— 不递归建整个布局，
   * 因为 sessions / pending / 待确认技能这些只对 workspace 有意义。
   */
  async ensureRoot(scope) {
    if (!scope || scope === 'workspace') return;
    const root = this.rootOfScope(scope);
    if (!root) return;
    for (const dir of [root.memories, root.skills, root.meta]) {
      await fsp.mkdir(dir, { recursive: true });
    }
  }

  filePath(id, kind, scope = 'workspace') {
    const bucket = bucketOf(kind || 'fact');
    const root = this.rootOfScope(scope) ?? this.root;
    return path.join(root[bucket], `${safeId(id)}.md`);
  }

  /** `p` 是否正好落在某个作用域的 `memories/` 或 `skills/` 目录里（防 `_path` 被伪造）。 */
  isInsideBucket(p, scope) {
    const roots = scope ? [this.rootOfScope(scope)].filter(Boolean) : [this.root, this.userRoot, this.globalRoot].filter(Boolean);
    const resolved = path.resolve(String(p || ''));
    for (const root of roots) {
      for (const bucket of ['memories', 'skills']) {
        if (path.dirname(resolved) === path.resolve(root[bucket]) && resolved.endsWith('.md')) return true;
      }
    }
    return false;
  }

  /**
   * 读一个已知路径；不存在返回 `undefined`，读失败记 `lastListError` 后同样返回
   * `undefined`（由调用方区分"没找到"与"读不出来"——read() 只把前者折叠成 null）。
   */
  async readFileAt(p, scopeName, bucket, fileId) {
    try {
      const raw = await fsp.readFile(p, 'utf8');
      const { data, body } = parseFrontmatter(raw);
      // scope 以**目录**为准：文件可能被手工搬过，位置才是事实。
      return recordFrom(data, body, { fallbackId: fileId, scope: scopeName, filePath: p, bucket });
    } catch (e) {
      if (e.code !== 'ENOENT') {
        this.lastListError = `${fileId}: ${e.message}`;
        this.log.warn?.(`[dsh-memfuse] read ${fileId}: ${e.message}`);
      }
      return undefined;
    }
  }

  /**
   * 按 **frontmatter id** 找文件（文件名被用户改过时的兜底，F-ST-04）。
   *
   * 只在「按 id 拼出来的路径不存在」时才调；正常路径零额外开销。
   */
  async findFileById(id, kind, scope) {
    const buckets = kind ? [bucketOf(kind)] : ['memories', 'skills'];
    for (const [scopeName, root] of this.rootsFor(scope)) {
      for (const bucket of buckets) {
        let names = [];
        try {
          names = await fsp.readdir(root[bucket]);
        } catch {
          continue;
        }
        for (const name of names) {
          if (!name.endsWith('.md') || name.startsWith('.')) continue;
          const p = path.join(root[bucket], name);
          try {
            const raw = await fsp.readFile(p, 'utf8');
            const { data } = parseFrontmatter(raw);
            if (String(data.id ?? '').trim() === id) {
              return { p, scope: scopeName, bucket, fileId: name.slice(0, -3) };
            }
          } catch {
            /* 读不出来的文件跳过（它自己的 read 路径会记账） */
          }
        }
      }
    }
    return null;
  }

  /** 读取一条记忆；不存在返回 null。`scope` 省略时按 workspace→user→global 找。 */
  async read(id, kind, scope) {
    const sid = safeId(id);
    const buckets = kind ? [bucketOf(kind)] : ['memories', 'skills'];
    for (const [scopeName, root] of this.rootsFor(scope)) {
      for (const bucket of buckets) {
        const p = path.join(root[bucket], `${sid}.md`);
        const rec = await this.readFileAt(p, scopeName, bucket, sid);
        if (rec !== undefined) return rec;
      }
    }
    // 文件名 ≠ frontmatter id（用户把 m_xxx.md 改成了好读的名字）：按 id 兜底找
    const hit = await this.findFileById(sid, kind, scope);
    if (hit) {
      const rec = await this.readFileAt(hit.p, hit.scope, hit.bucket, hit.fileId);
      if (rec !== undefined) return rec;
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
   * 写入这条记录该落到哪个文件。
   *
   * 优先级：**刚读到的那份文件**（`_path`）→ 按 id 拼出来的路径 → 按 frontmatter id
   * 扫出来的文件。中间那步会先看文件在不在；最后一步只在"改名过"时才发生。
   * 这样 read→modify→write 永远回到同一份文件，不会再写出一份影子副本（F-ST-04）。
   */
  async resolveWritePath(rec, scope) {
    const id = safeId(rec.id);
    const root = this.rootOfScope(scope) ?? this.root;
    const direct = path.join(root[bucketOf(rec.kind || 'fact')], `${id}.md`);
    if (rec._path && this.isInsideBucket(rec._path, scope)) return path.resolve(rec._path);
    if (fs.existsSync(direct)) return direct;
    const hit = await this.findFileById(id, rec.kind, scope);
    return hit ? hit.p : direct;
  }

  /**
   * 原子写入（先写临时文件再 rename）。
   *
   * 覆盖已存在的文件前会先做 drift guard：磁盘内容无法安全解析时
   * **备份成 `<file>.bak.<时间戳>` 并抛 DriftError**，绝不静默覆盖。
   * 传 `{ force: true }` 可跳过（仅用于明确的"我知道在做什么"场景）。
   */
  async write(rec, opts = {}) {
    // 作用域决定**文件落在哪个根**，不是只写进 frontmatter。
    // 真机踩过：三级作用域那一版把 scope 只写进了 frontmatter，文件全落在 workspace 目录，
    // 于是「用户级跨工作区共享」一次都没生效，而 list() 又按目录判作用域 → 全报 workspace。
    const scope = VALID_SCOPES.includes(rec.scope) ? rec.scope : 'workspace';
    await this.ensureRoot(scope);
    const p = await this.resolveWritePath(rec, scope);
    const run = async () => {
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
      // 始终把生效的作用域写死进文件：调用方省略 scope 时也要能看出这条记忆属于哪一级。
      data.scope = scope;
      data.updated = data.updated || new Date().toISOString();
      // tags 归一成数组再落盘：手写文件里的 `tags: pnpm, tooling` 在下一次写回时被修好。
      data.tags = normalizeTags(data.tags);
      const text = emitFrontmatter(data) + '\n' + String(rec.body || '').trim() + '\n';
      // tmp 名必须带随机数：同一进程里两条并发写同一 id 会撞同一个 tmp，
      // 56/60 条 rename ENOENT（审计 F-ST-06）。
      const tmp = `${p}.tmp-${process.pid}-${randomUUID()}`;
      try {
        await fsp.writeFile(tmp, text, 'utf8');
        await fsp.rename(tmp, p);
      } catch (e) {
        await fsp.unlink(tmp).catch(() => {});
        throw e;
      }
      return p;
    };
    // 按最终路径串行：并发写同一条记忆时不再互相踩（Windows 的 rename EPERM）
    const prev = this._writeQueues.get(p) || Promise.resolve();
    const task = prev.then(run, run);
    this._writeQueues.set(p, task);
    try {
      return await task;
    } finally {
      if (this._writeQueues.get(p) === task) this._writeQueues.delete(p);
    }
  }

  /**
   * 删除一条记忆。kind 未知时（手写文件没有 kind 字段）两桶都试——
   * 否则会出现「计划里选中了它、unlink 却指向另一个目录 → ENOENT → 静默失败」。
   *
   * `scope` 省略时按 workspace→user→global 找**第一条**命中就停 —— 与 `read()` 同序，
   * 所以「读到哪一份就删哪一份」，不会连带删掉别的作用域里的同名 id。
   *
   * 传入**记录对象**时优先用它的 `_path`（`list()` 读到哪份就删哪份，F-ST-04）；
   * 只传 id 时，按 id 找不到就按 frontmatter id 兜底扫一遍（文件名被改过）。
   */
  async remove(idOrRec, kind, scope) {
    let id;
    let hinted = null;
    if (idOrRec && typeof idOrRec === 'object') {
      id = idOrRec.id;
      kind = idOrRec.kind;
      scope = idOrRec.scope;
      hinted = idOrRec._path;
    } else {
      id = idOrRec;
    }
    if (hinted && this.isInsideBucket(hinted)) {
      try {
        await fsp.unlink(path.resolve(hinted));
        return true;
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    }
    const sid = safeId(id);
    const buckets = kind ? [bucketOf(kind)] : ['memories', 'skills'];
    for (const [, root] of this.rootsFor(scope)) {
      for (const bucket of buckets) {
        const p = path.join(root[bucket], `${sid}.md`);
        try {
          await fsp.unlink(p);
          return true;
        } catch (e) {
          if (e.code !== 'ENOENT') throw e;
        }
      }
    }
    const hit = await this.findFileById(sid, kind, scope);
    if (hit) {
      try {
        await fsp.unlink(hit.p);
        return true;
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    }
    return false;
  }

  /** 列出全部记忆（支持跨作用域查询，不含 sessions / ad-hoc） */
  async list(opts = {}) {
    // 目录不存在是正常状态（init 会建）；**其它**读取错误必须暴露出来，
    // 否则「记忆库读不出来」会静默表现为「记忆是空的」——那正是本项目
    // 最反对的失败模式。调用方读 this.lastListError 判断。
    this.lastListError = null;
    const out = [];
    const seen = new Set();
    
    // 按优先级顺序查询作用域：workspace > user > global（同 id 只保留第一个）
    const scopes = opts.scopes || ['workspace', 'user', 'global'];
    const scopeRoots = {
      workspace: this.root,
      user: this.userRoot,
      global: this.globalRoot,
    };
    
    for (const scope of scopes) {
      const root = scopeRoots[scope];
      if (!root) continue;
      
      for (const bucket of ['memories', 'skills']) {
        const dir = root[bucket];
        let names = [];
        try {
          names = await fsp.readdir(dir);
        } catch (e) {
          if (e.code !== 'ENOENT') this.lastListError = `${scope}/${bucket}: ${e.message}`;
          continue;
        }
        const wanted = names.filter((n) => n.endsWith('.md') && !n.startsWith('.'));
        // **并行**读文件。实测 600 条：串行 await 逐个读 = 97.6ms，
        // 并行 = 21.4ms（含 parse 25.5ms）。串行读是这里唯一的瓶颈，
        // 而并行化只花 3 行代码 —— 这也是"不加派生索引"的依据（见 docs/spec.md §3.7）。
        const recs = await Promise.all(
          wanted.map(async (name) => {
            const fileId = name.slice(0, -3);
            const p = path.join(dir, name);
            try {
              const raw = await fsp.readFile(p, 'utf8');
              const { data, body } = parseFrontmatter(raw);
              return recordFrom(data, body, { fallbackId: fileId, scope, filePath: p, bucket });
            } catch (e) {
              if (e.code !== 'ENOENT') this.lastListError = `${fileId}: ${e.message}`;
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

  /**
   * 重新生成 index.md（L0 总索引）。
   *
   * **派生视图失败绝不允许把写路径连坐**（F-ST-02：一个手改坏的文件让
   * `memfuse_write add` 回「写入失败」，而记忆其实已经落盘）。所以这里逐根
   * try/catch：失败记进 `lastIndexError` 并 warn，仍然返回索引路径。
   */
  async rebuildIndex() {
    this.lastIndexError = null;
    const all = await this.list();
    // 每个根写**自己的** index.md：把用户级/全局级的条目写进 workspace 的索引，
    // 等于让派生视图声称「这条记忆在这个工作区里」——那是假的，而且删掉那份之后
    // 索引还得等下一次重建才对。没建目录的根不写（不凭空造文件，同 ensureRoot）。
    for (const [scope, root] of this.rootsFor()) {
      if (scope !== 'workspace' && !fs.existsSync(root.root)) continue;
      try {
        const rows = all.filter((r) => r.scope === scope && (r.lifecycle || 'active') === 'active');
        await fsp.writeFile(root.index, renderIndex(rows), 'utf8');
      } catch (e) {
        this.lastIndexError = `${scope}: ${e.message}`;
        this.log.warn?.(`[dsh-memfuse] 重建 ${scope} index.md 失败：${e.message}`);
      }
    }
    // 兼容旧契约（原来返回 workspace 索引路径）
    return this.root.index;
  }
}

export { parseFrontmatter, emitFrontmatter };
export const _internal = { parseScalar, emitScalar, splitTopLevel };
