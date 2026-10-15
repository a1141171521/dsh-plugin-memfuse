/**
 * dsh-memfuse — SKILL.md 格式 I/O。
 *
 * ## 为什么单独一个模块
 *
 * 技能是这套系统里**权限最高**的写入：它是"注入即生效的指令"，
 * 写坏一次，之后**每一次会话**都被影响。所以格式必须严格校验，
 * 而且必须防住四个**静默**失败 —— 它们的共同点是出错时什么都不报，
 * 你只会发现"技能没生效"：
 *
 *   1. **CRLF 行尾** → `name: foo\r` 整行匹配失败 → frontmatter 缺 name → 技能被跳过
 *   2. **裸值里含 `: ` 或 ` #`** → 严格 YAML 解析器直接拒
 *   3. **目录名 ≠ frontmatter name** → DSH 静默跳过
 *   4. **写完没验证** → 你以为装上了，其实没有
 *
 * 对策：写前规范化行尾为 LF、description 强制加引号、两处用同一个变量、
 * 写完立刻回读自校验（见 verifySkill）。
 *
 * 参照 dsh-memory-evolve 的 lib/skills.js（它踩过 CRLF 那个坑并留了注释）。
 *
 * 零依赖（node:fs only）。
 *
 * @module dsh-memfuse/skill
 */
import fsp from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

/** 技能名语法：kebab-case 小写字母数字（同时也排除了路径穿越）。 */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 名称是否合法。 */
export function isSkillName(name) {
  return SKILL_NAME.test(String(name || ''));
}

/**
 * 解析规范 SKILL.md（frontmatter 块 + 正文）。
 * @returns {{name: string, description: string, body: string}|undefined}
 */
export function parseSkillMd(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(String(text || ''));
  if (!m) return undefined;
  const fields = {};
  for (const line of m[1].split('\n')) {
    // 坑 1：split('\n') 后每行尾部残留 \r，而 JS 正则里 . 不匹配 \r、
    // $ 也不匹配 \r 前的位置 → "name: foo\r" 整行匹配失败。先剥掉行尾 \r。
    const clean = line.replace(/\r+$/, '');
    const kv = /^([a-zA-Z0-9_-]+):\s*(.*)$/.exec(clean);
    if (!kv) continue;
    const raw = kv[2].trim();
    const quoted =
      (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"));
    // 坑 2：严格 YAML 里裸标量不能含 ": " 或 " #"。我们也要拒 ——
    // 因为我们接受的技能，DSH 那边也必须能解析。
    if (!quoted && (raw.includes(': ') || raw.includes(' #'))) return undefined;
    fields[kv[1]] = quoted ? raw.slice(1, -1) : raw;
  }
  if (typeof fields.name !== 'string' || !fields.name) return undefined;
  if (typeof fields.description !== 'string' || !fields.description) return undefined;
  return { name: fields.name, description: fields.description, body: m[2] };
}

/**
 * 生成规范 SKILL.md 文本。
 * 行尾统一 LF；description 强制双引号（它常含 `: ` 与 `#`，裸值会被拒）。
 */
export function buildSkillMd({ name, description, body }) {
  const desc = String(description || '')
    .replace(/\r?\n/g, ' ')
    .trim();
  const quoted = `"${desc.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return [
    '---',
    `name: ${name}`,
    `description: ${quoted}`,
    '---',
    '',
    String(body || '').trim(),
    '',
  ]
    .join('\n')
    .replace(/\r\n/g, '\n');
}

/**
 * 校验一份技能内容是否可以落盘。
 * @param {{name: string, content: string, maxBytes?: number}} opts
 * @returns {{ok: true, parsed: object} | {ok: false, error: string}}
 */
export function validateSkill({ name, content, maxBytes = 65536 }) {
  if (!isSkillName(name)) {
    return {
      ok: false,
      error: `技能名必须是 kebab-case（小写字母/数字/连字符），收到 "${name}"`,
    };
  }
  if (typeof content !== 'string' || !content.trim()) return { ok: false, error: '技能内容为空' };
  if (content.length > maxBytes) return { ok: false, error: `超过大小上限 ${maxBytes} 字节` };
  const parsed = parseSkillMd(content);
  if (!parsed) {
    return {
      ok: false,
      error: 'frontmatter 不规范（缺 name/description，或裸值里含 ": " / " #"）',
    };
  }
  if (parsed.name !== name) {
    return {
      ok: false,
      error: `目录名（${name}）与 frontmatter name（${parsed.name}）不一致 —— 这种技能会被 DSH 静默跳过`,
    };
  }
  return { ok: true, parsed };
}

/** 原子写一份技能（创建目录）。行尾规范成 LF。 */
export async function writeSkill(dir, name, content) {
  const target = path.join(dir, name);
  await fsp.mkdir(target, { recursive: true });
  const file = path.join(target, 'SKILL.md');
  const tmp = `${file}.tmp-${process.pid}`;
  await fsp.writeFile(tmp, String(content).replace(/\r\n/g, '\n'), 'utf8');
  await fsp.rename(tmp, file);
  return file;
}

/**
 * 列出一个技能目录下的技能。
 * 只认「目录名 === frontmatter name」的技能 —— 这是 DSH 的加载判据，
 * 不一致的会被它静默跳过，我们在这里就如实标出来而不是假装没看见。
 */
export async function listSkills(dir) {
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    try {
      const text = await fsp.readFile(path.join(dir, e.name, 'SKILL.md'), 'utf8');
      const parsed = parseSkillMd(text);
      out.push({
        name: e.name,
        dirName: e.name,
        description: parsed ? parsed.description : '',
        loadable: Boolean(parsed && parsed.name === e.name),
        problem: !parsed
          ? 'frontmatter 解析失败'
          : parsed.name !== e.name
            ? `frontmatter name 是 "${parsed.name}"，与目录名不一致`
            : null,
        bytes: text.length,
      });
    } catch {
      out.push({ name: e.name, dirName: e.name, description: '', loadable: false, problem: '读不到 SKILL.md' });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** 读一份技能的原文。 */
export async function readSkill(dir, name) {
  if (!isSkillName(name)) return undefined;
  try {
    return await fsp.readFile(path.join(dir, name, 'SKILL.md'), 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * 自校验（坑 4 的对策）：写完回读，确认真的能被解析、且目录名与 name 一致。
 * @returns {{ok: boolean, problem: string|null}}
 */
export async function verifySkill(dir, name) {
  const text = await readSkill(dir, name);
  if (text === undefined) return { ok: false, problem: '写完之后读不到 SKILL.md' };
  const parsed = parseSkillMd(text);
  if (!parsed) return { ok: false, problem: 'frontmatter 无法解析（会被 DSH 静默跳过）' };
  if (parsed.name !== name) return { ok: false, problem: `目录名与 frontmatter name 不一致（${parsed.name}）` };
  return { ok: true, problem: null };
}

/**
 * 采纳一份待确认技能：**移动到**真技能目录（移动 = 安装）。
 * 跨盘（EXDEV）时回退成 copy + delete。
 */
export async function approvePendingSkill(pendingDir, skillDir, name) {
  if (!isSkillName(name)) return { ok: false, error: `技能名非法："${name}"` };
  const from = path.join(pendingDir, name);
  if (!existsSync(path.join(from, 'SKILL.md'))) {
    return { ok: false, error: `待确认技能里没有 "${name}"` };
  }
  const to = path.join(skillDir, name);
  if (existsSync(path.join(to, 'SKILL.md'))) {
    return { ok: false, error: `技能库里已经有 "${name}"（如需更新请用 patch）` };
  }
  await fsp.mkdir(skillDir, { recursive: true });
  try {
    await fsp.rename(from, to);
  } catch (e) {
    if (e && e.code === 'EXDEV') {
      await fsp.cp(from, to, { recursive: true });
      await fsp.rm(from, { recursive: true, force: true });
    } else {
      throw e;
    }
  }
  return { ok: true, path: path.join(to, 'SKILL.md') };
}

/** 丢弃一份待确认技能。 */
export async function rejectPendingSkill(pendingDir, name) {
  if (!isSkillName(name)) return { ok: false, error: `技能名非法："${name}"` };
  const target = path.join(pendingDir, name);
  if (!existsSync(path.join(target, 'SKILL.md'))) {
    return { ok: false, error: `待确认技能里没有 "${name}"` };
  }
  await fsp.rm(target, { recursive: true, force: true });
  return { ok: true };
}

/**
 * 把任意标题转成合法的 kebab-case 技能名。
 * 中文无法音译 → 退化成 `skill-<内容哈希前 8 位>`，保证技能仍能落地，
 * 而不是因为"名字不合法"整条丢弃（那种静默丢弃正是我们要防的）。
 */
export function slugifySkillName(title, fallbackSeed = '') {
  const ascii = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  if (isSkillName(ascii)) return ascii;
  let h = 0;
  const s = String(title || '') + String(fallbackSeed || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return `skill-${h.toString(16).padStart(8, '0').slice(0, 8)}`;
}
