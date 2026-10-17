/**
 * 把 dsh-memfuse 装进指定 profile（desktop / web / ...）。
 *
 * 为什么用脚本而不是手工改：
 *   - PowerShell 的 Set-Content -Encoding UTF8 会写 BOM，宿主 JSON.parse 直接崩（真机踩过）
 *   - PS 5.1 按 GBK 读 UTF-8 会把中文变乱码（AGENTS.md 明确警告）
 *   node 读写 JSON 两件事都不会犯。
 *
 * 做四件事：
 *   1. 备份 profile 的 package.json
 *   2. dependencies 加 dsh-memfuse = link:<repo>
 *   3. dsh.profile.bundles 追加 dsh-memfuse
 *   4. node_modules/dsh-memfuse 建 junction 指向仓库
 *
 * 用法：node tools/install-memfuse.mjs desktop [web ...]
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '..');
const profilesRoot = path.join(os.homedir(), '.dsh', 'profiles');
const targets = process.argv.slice(2);

if (!targets.length) {
  console.error('用法：node tools/install-memfuse.mjs <profile> [profile ...]');
  process.exit(2);
}

const fwd = (p) => p.split(path.sep).join('/');

for (const name of targets) {
  const dir = path.join(profilesRoot, name);
  const pj = path.join(dir, 'package.json');

  console.log(`\n=== ${name} ===`);
  if (!fs.existsSync(pj)) {
    console.error(`  [FAIL] 找不到 profile：${pj}`);
    process.exitCode = 1;
    continue;
  }

  // 1) 备份（带时间戳，不覆盖旧备份）
  const bak = `${pj}.bak-memfuse-${Date.now()}`;
  fs.copyFileSync(pj, bak);
  console.log(`  备份 -> ${path.basename(bak)}`);

  // 2) 改 JSON
  const j = JSON.parse(fs.readFileSync(pj, 'utf8'));
  j.dependencies = j.dependencies || {};
  j.dependencies['dsh-memfuse'] = `link:${fwd(REPO)}`;

  j.dsh = j.dsh || {};
  j.dsh.profile = j.dsh.profile || {};
  const bundles = Array.isArray(j.dsh.profile.bundles) ? j.dsh.profile.bundles : [];
  if (!bundles.includes('dsh-memfuse')) bundles.push('dsh-memfuse');
  j.dsh.profile.bundles = bundles;

  // 3) 写回：2 空格缩进 + LF + 无 BOM
  fs.writeFileSync(pj, JSON.stringify(j, null, 2) + '\n', { encoding: 'utf8' });
  const raw = fs.readFileSync(pj);
  const bom = raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
  console.log(`  package.json 已写：dep=link:${fwd(REPO)}  bundle=${bundles.includes('dsh-memfuse')}  BOM=${bom}`);
  if (bom) {
    console.error('  [FAIL] 写入了 BOM —— 宿主会 JSON.parse 失败');
    process.exitCode = 1;
    continue;
  }

  // 4) junction
  const link = path.join(dir, 'node_modules', 'dsh-memfuse');
  if (fs.existsSync(link)) {
    const st = fs.lstatSync(link);
    if (st.isSymbolicLink() || st.isDirectory()) {
      console.log(`  junction 已存在，先删：${link}`);
      fs.rmSync(link, { recursive: true, force: true });
    }
  }
  fs.mkdirSync(path.dirname(link), { recursive: true });
  const r = spawnSync('cmd', ['/c', 'mklink', '/J', link, REPO], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(`  [FAIL] 建 junction 失败：${(r.stderr || r.stdout || '').trim()}`);
    process.exitCode = 1;
    continue;
  }
  console.log(`  junction -> ${REPO}`);
  console.log(`  可读到入口：${fs.existsSync(path.join(link, 'lib', 'index.js'))}`);
}
