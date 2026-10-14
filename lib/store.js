// 记忆存储层：一条记忆 = 一个 Markdown 文件（YAML frontmatter + 正文）。
//
// 设计依据（README P2）：纯文本、人类可读、可 git、可迁出。
// 刻意不引入 YAML 依赖：只支持我们实际使用的扁平标量 / 数组子集，
// 这样插件在任意 DSH 运行时里都能加载，不会因为缺依赖而整块失效。
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
    return inner.split(',').map((s) => parseScalar(s));
  }
  if (v.startsWith('{') && v.endsWith('}')) {
    const inner = v.slice(1, -1).trim();
    const out = {};
    if (!inner) return out;
    for (const pair of inner.split(',')) {
      const i = pair.indexOf(':');
      if (i === -1) continue;
      out[pair.slice(0, i).trim()] = parseScalar(pair.slice(i + 1));
    }
    return out;
  }
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
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
  return /^[\s>|*&!%@`[\]{},#-]|[:#]\s|^\s|\s$/.test(s) || s === '' || /^(true|false|null|~|-?\d)/.test(s);
}

function emitScalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return '[' + v.map((x) => emitScalar(x)).join(', ') + ']';
  if (typeof v === 'object') {
    return '{ ' + Object.entries(v).map(([k, x]) => `${k}: ${emitScalar(x)}`).join(', ') + ' }';
  }
  const s = String(v);
  return needsQuote(s) ? '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"' : s;
}

function emitFrontmatter(data) {
  const order = [
    'id', 'scope', 'kind', 'priority', 'confidence', 'title', 'summary', 'anchor',
    'tags', 'source', 'created', 'updated', 'expires', 'lifecycle', 'dormantAt',
    'stats', 'revision', 'stale', 'conflict', 'stable',
  ];
  const keys = [...order.filter((k) => k in data), ...Object.keys(data).filter((k) => !order.includes(k))];
  const lines = keys.map((k) => `${k}: ${emitScalar(data[k])}`);
  return `---\n${lines.join('\n')}\n---\n`;
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
    for (const dir of [this.root.root, this.root.memories, this.root.skills, this.root.sessions, this.root.adhoc, this.root.meta]) {
      await fsp.mkdir(dir, { recursive: true });
    }
    if (this.gitEnabled) {
      const check = await git(this.root.root, ['rev-parse', '--git-dir']);
      if (!check.ok) {
        await git(this.root.root, ['init', '-q']);
        await git(this.root.root, ['config', 'user.name', 'dsh-memory']);
        await git(this.root.root, ['config', 'user.email', 'dsh-memory@local']);
      }
    }
  }

  filePath(id, kind) {
    const bucket = bucketOf(kind || 'fact');
    return path.join(this.root[bucket], `${id}.md`);
  }

  /** 读取一条记忆；不存在返回 null */
  async read(id, kind) {
    for (const bucket of ['memories', 'skills']) {
      const p = path.join(this.root[bucket], `${id}.md`);
      try {
        const raw = await fsp.readFile(p, 'utf8');
        const { data, body } = parseFrontmatter(raw);
        return { ...data, id: data.id || id, body: body.trim(), _path: p };
      } catch (e) {
        if (e.code !== 'ENOENT') this.log.warn?.(`[dsh-memory] read ${id}: ${e.message}`);
      }
    }
    return null;
  }

  /** 原子写入（先写临时文件再 rename） */
  async write(rec) {
    const p = this.filePath(rec.id, rec.kind);
    const { body, _path, ...data } = rec;
    data.updated = data.updated || new Date().toISOString();
    const text = emitFrontmatter(data) + '\n' + (body || '').trim() + '\n';
    const tmp = `${p}.tmp-${process.pid}`;
    await fsp.writeFile(tmp, text, 'utf8');
    await fsp.rename(tmp, p);
    return p;
  }

  async remove(id, kind) {
    const p = this.filePath(id, kind);
    try {
      await fsp.unlink(p);
      return true;
    } catch (e) {
      if (e.code === 'ENOENT') return false;
      throw e;
    }
  }

  /** 列出全部记忆（不含 sessions / ad-hoc） */
  async list() {
    const out = [];
    for (const bucket of ['memories', 'skills']) {
      const dir = this.root[bucket];
      let names = [];
      try {
        names = await fsp.readdir(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith('.md') || name.startsWith('.')) continue;
        const id = name.slice(0, -3);
        const rec = await this.read(id);
        if (rec) out.push({ ...rec, _bucket: bucket });
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

  async commit(message) {
    if (!this.gitEnabled) return { ok: false, reason: 'disabled' };
    await git(this.root.root, ['add', '-A']);
    const r = await git(this.root.root, ['commit', '-q', '-m', message]);
    if (!r.ok && /nothing to commit/i.test(r.out + r.err)) return { ok: true, reason: 'no-change' };
    return r;
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
export const _internal = { parseScalar, emitScalar };
