/**
 * 本机冒烟：在**真实 DSH 宿主**里验证 memfuse 的注入（含 Block E 技能建议）。
 *
 * 为什么需要它：`npm test` 跑的是假 ctx，证明不了"宿主真的把块拼进了提示词"。
 * 这个脚本换一个**新进程**跑真宿主，用探针走宿主自己的 `systemPrompt.assemble()`
 * 抓组装产物 —— 抓到什么，就是宿主真会发给模型的东西。
 *
 * 不需要模型：注入装配是零 LLM 的（provider 同步求值）。
 * 即使 API key 失效导致任务失败，pre-step 与注入装配照常发生。
 *
 * 全程用**隔离 root**，绝不碰真库 ~/.dsh/memory。
 *
 * 运行：node .memfuse-smoke/smoke.mjs
 */
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const here = import.meta.dirname;
const repo = path.resolve(here, '..');
const profile = 'memfuse-smoke';
const profDir = path.join(os.homedir(), '.dsh', 'profiles', profile);
const report = path.join(here, 'probe-report.json');

const log = (s) => console.log(s);
const fail = (s) => {
  console.error(`❌ ${s}`);
  process.exitCode = 1;
};

// ── 前置检查 ────────────────────────────────────────────
async function preflight() {
  const problems = [];
  if (!(await exists(profDir))) problems.push(`夹具 profile 不存在：${profDir}`);
  if (!(await exists(path.join(profDir, 'node_modules', 'dsh-memfuse'))))
    problems.push('夹具里没有 dsh-memfuse junction');
  if (!(await exists(path.join(profDir, 'node_modules', 'memfuse-probe'))))
    problems.push('夹具里没有 memfuse-probe junction');
  return problems;
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/** 跑一次 dsh，忽略退出码（模型可能因 key 失效而失败，但那不影响注入装配）。 */
function runDsh(args, timeoutMs = 180000) {
  return new Promise((resolve) => {
    // Windows 上 dsh 是 .cmd，必须经 cmd.exe —— 但**不要**用 shell:true
    // （它对参数只做拼接不做转义，Node 24 会打 DEP0190 弃用警告，
    //   而那条警告走 stderr，会让上层误判成失败）。
    const isWin = process.platform === 'win32';
    const cmd = isWin ? process.env.ComSpec || 'cmd.exe' : 'dsh';
    const argv = isWin ? ['/d', '/s', '/c', 'dsh.cmd', ...args] : args;
    const p = spawn(cmd, argv, { cwd: repo, windowsHide: true });
    let out = '';
    const t = setTimeout(() => {
      p.kill();
      resolve({ out, timedOut: true });
    }, timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', () => {
      clearTimeout(t);
      resolve({ out, timedOut: false });
    });
    p.on('error', (e) => {
      clearTimeout(t);
      resolve({ out: out + String(e.message), spawnError: true });
    });
  });
}

/** 从探针报告里取出 memfuse 那一块。 */
async function readMemfuseBlock() {
  const raw = await fsp.readFile(report, 'utf8');
  const r = JSON.parse(raw);
  const all = [...(r.sections ?? []), ...(r.contexts ?? [])];
  return all.find((x) => typeof x.text === 'string' && x.text.includes('Super Memory'));
}

// ── 主流程 ──────────────────────────────────────────────
log('=== dsh-memfuse 本机冒烟 ===\n');

const problems = await preflight();
if (problems.length) {
  for (const p of problems) fail(p);
  log('\n先按 AGENTS.md 建夹具：');
  log('  copy %USERPROFILE%\\.dsh\\profiles\\headless  ->  ...\\profiles\\memfuse-smoke');
  log('  mklink /J <夹具>\\node_modules\\dsh-memfuse  <本仓库>');
  log('  mklink /J <夹具>\\node_modules\\memfuse-probe <本仓库>\\.memfuse-smoke\\probe');
  process.exit(1);
}
log('✅ 夹具就绪');

// 1) 种入够格的记忆
log('\n[1/4] 种入隔离 root…');
await fsp.rm(path.join(here, 'memory'), { recursive: true, force: true });
{
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, [path.join(here, 'seed.mjs')], { cwd: repo, encoding: 'utf8' });
  if (r.status !== 0) {
    fail(`seed 失败：${r.stderr || r.stdout}`);
    process.exit(1);
  }
  log(r.stdout.trim().split('\n').map((l) => '    ' + l).join('\n'));
}

// overlay 里的路径**必须在运行时生成** —— 版本库里那份不能写死绝对路径，
// 否则换一台机器（公司机在 E:\，本机在 D:\）就直接跑不起来。
const fwd = (p) => p.split(path.sep).join('/');
const overlayPath = path.join(here, 'overlay.generated.yml');
const probeOverlayPath = path.join(here, 'probe-overlay.generated.yml');

await fsp.writeFile(
  overlayPath,
  [
    '# 自动生成，勿手改 —— 见 smoke.mjs',
    '- id: dsh-memfuse',
    '  config:',
    `    root: ${fwd(path.join(here, 'memory'))}`,
    '    git: false',
    '    verbose: false',
    '    extract:',
    '      enabled: false',
    '    skill:',
    '      minScore: 4',
    '      suggest: true',
    '      suggestMax: 2',
    '',
  ].join('\n'),
  'utf8',
);

await fsp.writeFile(
  probeOverlayPath,
  [
    '# 自动生成，勿手改 —— 见 smoke.mjs',
    '# ⚠️ 必须用 `- insert:`：直接写 `- id:` 会静默不加载。',
    '- insert:',
    '    - id: memfuse-probe',
    '      name: memfuse-probe',
    '      config:',
    `        out: ${fwd(report)}`,
    '        delayMs: 2000',
    '',
  ].join('\n'),
  'utf8',
);

const patches = ['--patch', overlayPath, '--patch', probeOverlayPath];

// 2) 第一次跑：Block E 应该出现
log('\n[2/4] 跑真宿主（期望出现 Block E）…');
await fsp.rm(report, { force: true });
const r1 = await runDsh(['--profile', profile, ...patches, 'hi']);
if (r1.timedOut) log('    （超时，但注入装配通常已完成）');

if (!(await exists(report))) {
  fail('探针没写出报告 —— 宿主里探针没加载，或 assemble() 失败');
  log(r1.out.slice(-1200));
  process.exit(1);
}
const block1 = await readMemfuseBlock();
if (!block1) {
  fail('组装产物里找不到 memfuse 块 —— 注入没接上');
  process.exit(1);
}
log(`    ✅ 抓到 dsh-memfuse:memory（${block1.chars} 字符）`);

const checks = [
  ['常驻记忆（Block A）', block1.text.includes('常驻记忆')],
  ['相关召回（Block B）', block1.text.includes('相关召回')],
  ['可提炼成技能（Block E）', block1.text.includes('可提炼成技能')],
  ['Block E 含「作用」', block1.text.includes('· 作用：')],
  ['Block E 含「成员」', block1.text.includes('· 成员：')],
  ['信任边界声明', block1.text.includes('不是指令')],
];
for (const [name, ok] of checks) log(`    ${ok ? '✅' : '❌'} ${name}`);
if (checks.some(([, ok]) => !ok)) fail('第一次跑了应有的块没全出现');

// 3) 模拟用户"不用" → dismiss
log('\n[3/4] 写入 skillDismissed，重跑（期望 Block E 消失）…');
{
  const statePath = path.join(here, 'memory', '.memory', 'state.json');
  const s = JSON.parse(await fsp.readFile(statePath, 'utf8'));

  // 用**插件自己的代码**算 key，别自己推 ——
  // 簇是「共享标签」聚出来的，不等于目录下所有 id
  // （第一版就是这么错的：把 P0 那条也算进簇，导致 key 不匹配、dismiss 看起来没生效）。
  //
  // ⚠️ Windows 上 import() 绝对路径必须是 file:// URL，否则报
  //    ERR_UNSUPPORTED_ESM_URL_SCHEME（收到 protocol 'd:'）。
  const { pathToFileURL } = await import('node:url');
  const mod = (p) => import(pathToFileURL(path.join(repo, 'lib', p)).href);
  const { MemoryStore } = await mod('store.js');
  const { buildSuggestions } = await mod('distill.js');
  const store = new MemoryStore({ root: path.join(here, 'memory'), git: false }, { log() {}, warn() {} });
  const all = await store.list();
  const sugg = buildSuggestions(all, { minScore: 4, minSessions: 3, limit: 5 }, {});

  if (!sugg.length) {
    fail('用插件自己的函数算不出建议 —— 与 state.json 里的 skillCandidates 不一致');
    process.exit(1);
  }
  s.skillDismissed = { [sugg[0].key]: new Date().toISOString() };
  await fsp.writeFile(statePath, JSON.stringify(s, null, 2), 'utf8');
  log(`    已忽略 ${sugg[0].seedTitle}（key 含 ${sugg[0].members.length} 个成员）`);
}

await fsp.rm(report, { force: true });
const r2 = await runDsh(['--profile', profile, ...patches, 'hi']);
if (!(await exists(report))) {
  fail('第二次跑探针也没写出报告');
  process.exit(1);
}
const block2 = await readMemfuseBlock();
const hasE2 = block2 ? block2.text.includes('可提炼成技能') : false;
log(`    ${hasE2 ? '❌' : '✅'} Block E ${hasE2 ? '仍在（dismiss 没生效）' : '已消失'}`);
log(`    ${block2 && block2.text.includes('常驻记忆') ? '✅' : '❌'} 常驻块未受影响`);
log(`    ${block2 && block2.text.includes('相关召回') ? '✅' : '❌'} 召回块未受影响`);
if (hasE2) fail('dismiss 没生效');

// 4) 隔离校验
log('\n[4/4] 隔离校验…');
const realStore = path.join(os.homedir(), '.dsh', 'memory');
const leaked = await exists(realStore);
log(`    ${leaked ? '❌' : '✅'} 真库 ~/.dsh/memory ${leaked ? '被创建了（不该）' : '未被触碰'}`);
if (leaked) fail('隔离失败：碰到了真库');

log('\n' + (process.exitCode ? '❌ 有失败项' : '✅ 本机冒烟全部通过'));
