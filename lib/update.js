/**
 * 版本管理：**查**有没有新版本（只读）+ **装**新版本（`git pull --ff-only`）。
 *
 * 为什么用 git 而不是 GitHub REST API：
 *   ① 本机到 api.github.com 的连接时通时断（实测会被 reset），而 `git` 走的是用户已经
 *      配好的代理/凭据，能通的时候更多；
 *   ② 不需要判断"发布版/标签"，`origin/<branch>` 与 `HEAD` 的差距就是真答案；
 *   ③ 零第三方依赖 —— 只用 `node:child_process`。
 *
 * ⚠️ `fetch` 会更新 `.git` 里的**远端跟踪引用**（`refs/remotes/origin/*`），
 * 但**不碰工作区**。检查是用户按按钮触发的，这个副作用每次都写在界面上。
 *
 * ⚠️ **没有热更新**：`applyUpdate` 拉完代码之后，本进程里跑的还是旧模块
 * （Node 的 ESM 缓存按进程走，本项目实测：改默认值后不重启，运行中的 schema 一直是旧值）。
 * 所以"装"只负责把**磁盘**换成新版，界面必须照实写"重启 DSH 后生效" ——
 * 假装热更新比不更新更坏（硬规则 4：功能存在但从不生效也算失败）。
 *
 * ⚠️ 每个 git 调用都有超时（`execFile` 的 `timeout`）。网络卡住时按钮不能变成"永转圈"。
 */
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 公开仓库地址（「去点个赞」按钮用它；同时兜底 `remote get-url` 失败的情况）。 */
export const REPO_URL = 'https://github.com/a1141171521/dsh-plugin-memfuse';

/** 插件仓库根目录：本文件在 `<repo>/lib/update.js`。 */
export const REPO_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** 单次 git 调用的默认超时。`fetch` 走网络，给宽一点。 */
const GIT_TIMEOUT_MS = 8000;

/**
 * `git pull` 的超时：比只读命令宽得多。
 *
 * 它要做 fetch + 更新工作区（可能几百个文件），慢网络上十几秒很正常；
 * 但**仍然有界** —— 卡住时要能报"超时"，不能把按钮永久钉在"正在更新…"。
 */
const PULL_TIMEOUT_MS = 60000;

/**
 * 跑一条 git 命令。
 *
 * `exec` 可注入 —— 测试里不跑真 git（那会真的去连 GitHub）。
 * @param dir - 仓库目录（`git -C <dir>`）。
 * @param args - 子命令与参数。
 * @param timeoutMs - 超时（毫秒）。
 * @param exec - 兼容 `child_process.execFile` 签名的实现。
 */
function runGit(dir, args, timeoutMs, exec = execFile) {
  return new Promise((resolve, reject) => {
    exec(
      'git',
      ['-C', dir, ...args],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 20, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) {
          // 超时/被杀时 error.killed 为真，stderr 往往为空 —— 两种都要说人话
          const stderrText = String(stderr ?? '').trim();
          const message = error.killed
            ? `git ${args[0]} 超时（${timeoutMs}ms）`
            : stderrText || String(error.message ?? error).trim();
          reject(new Error(message.slice(0, 400)));
          return;
        }
        resolve(String(stdout ?? '').trim());
      },
    );
  });
}

/**
 * 读本地 `package.json` 的版本号。
 * @returns 版本字符串；读不到返回 `null`（**不是** "0.0.0" —— 别把未知写成已知）。
 */
export async function readVersion(dir = REPO_DIR) {
  try {
    const raw = await fsp.readFile(path.join(dir, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed?.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

/**
 * 检查更新（只读）。
 *
 * @param options.dir       仓库目录（默认本插件仓库）。
 * @param options.timeoutMs 单条 git 命令的超时。
 * @param options.exec      测试注入用。
 * @returns `{supported, current, latest, behind, branch, remote, url, head, checkedAt, error?}`
 *   - `supported: false` = 不是 git 检出（比如用 npm 装的压缩包）→ 界面给"用 dsh plugin add 重装"。
 *   - `supported: true` + `error` = 能查，但这次没查成（网络/git 缺失）→ 界面原样显示。
 */
export async function checkUpdate(options = {}) {
  const dir = options.dir ?? REPO_DIR;
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  const exec = options.exec;
  const git = (args, ms = timeoutMs) => runGit(dir, args, ms, exec);
  const current = await readVersion(dir);
  const base = {
    supported: false,
    current,
    latest: null,
    behind: 0,
    branch: null,
    remote: null,
    url: REPO_URL,
    head: null,
    checkedAt: new Date().toISOString(),
  };

  try {
    const inside = await git(['rev-parse', '--is-inside-work-tree']);
    if (inside !== 'true') {
      return { ...base, error: '插件目录不是 git 检出，没法自动检查更新（用 dsh plugin add 重装可以拿到新版）' };
    }
  } catch (error) {
    return { ...base, error: `插件目录不是 git 检出（${error.message}），用 dsh plugin add 重装可以拿到新版` };
  }

  let branch = '';
  let remote = '';
  let head = '';
  try {
    branch = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
    head = (await git(['rev-parse', '--short', 'HEAD'])).slice(0, 12);
    remote = await git(['remote', 'get-url', 'origin']);
  } catch (error) {
    return { ...base, error: `读不到仓库信息：${error.message}` };
  }

  try {
    // 只更新 refs/remotes/origin/*，不碰工作区
    await git(['fetch', '--quiet', 'origin', branch]);
  } catch (error) {
    return {
      ...base,
      supported: true,
      branch,
      remote,
      head,
      error: `连不上 GitHub（${error.message}）—— 网络恢复后再试一次`,
    };
  }

  let behind = 0;
  try {
    const count = await git(['rev-list', '--count', `HEAD..origin/${branch}`]);
    behind = Number.parseInt(count, 10) || 0;
  } catch {
    behind = 0;
  }

  let latest = null;
  try {
    const raw = await git(['show', `origin/${branch}:package.json`]);
    const parsed = JSON.parse(raw);
    if (typeof parsed?.version === 'string') latest = parsed.version;
  } catch {
    // 远端没有 package.json / 读不到：latest 留 null，判据退回 behind
  }

  return {
    ...base,
    supported: true,
    latest,
    behind,
    branch,
    remote,
    head,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * 安装更新：`git pull --ff-only`。
 *
 * 三条安全边界（缺一条就会毁用户的东西，所以都写在这里而不是界面里）：
 *   ① **不是 git 检出**（用 npm 压缩包 / `dsh plugin add` 装的副本）→ 直接返回
 *      `supported: false`，界面提示用 `dsh plugin add` 重装；
 *   ② **本地有未提交的改动**（只看已跟踪文件：`--untracked-files=no`）→ 拒绝。
 *      未跟踪文件是用户自己的东西，git 自己在真会覆盖时也会拒绝，不必我们多管；
 *   ③ **只快进**（`--ff-only`）。本地有分叉的提交就失败并如实报 ——
 *      静默 rebase / 强推别人的历史比"更新失败"坏得多。
 *
 * ⚠️ 成功后**必须重启 DSH**：宿主半边已经在 ESM 缓存里了，磁盘换了代码不会换。
 * 返回里的 `restartRequired` 就是给界面写那句话用的。
 *
 * @param options.dir           仓库目录（默认本插件仓库）。
 * @param options.timeoutMs     只读 git 命令的超时。
 * @param options.pullTimeoutMs `git pull` 的超时（网络 + 更新工作区，给宽）。
 * @param options.exec          测试注入用。
 * @returns `{ok, supported, changed, from, to, head, branch, remote, url,
 *   restartRequired, updatedAt, error?, dirty?, dirtyCount?}`
 */
export async function applyUpdate(options = {}) {
  const dir = options.dir ?? REPO_DIR;
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  const pullTimeoutMs = options.pullTimeoutMs ?? PULL_TIMEOUT_MS;
  const exec = options.exec;
  const git = (args, ms = timeoutMs) => runGit(dir, args, ms, exec);
  const from = await readVersion(dir);
  const base = {
    ok: false,
    supported: false,
    changed: false,
    from,
    to: from,
    head: null,
    branch: null,
    remote: null,
    url: REPO_URL,
    restartRequired: false,
    updatedAt: new Date().toISOString(),
  };

  try {
    const inside = await git(['rev-parse', '--is-inside-work-tree']);
    if (inside !== 'true') {
      return { ...base, error: '插件目录不是 git 检出，没法自动更新（用 dsh plugin add 重装可以拿到新版）' };
    }
  } catch (error) {
    return { ...base, error: `插件目录不是 git 检出（${error.message}），用 dsh plugin add 重装可以拿到新版` };
  }

  let branch = '';
  let remote = '';
  let headBefore = '';
  try {
    branch = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
    headBefore = (await git(['rev-parse', '--short', 'HEAD'])).slice(0, 12);
    remote = await git(['remote', 'get-url', 'origin']);
  } catch (error) {
    return { ...base, supported: true, error: `读不到仓库信息：${error.message}` };
  }
  const info = { supported: true, branch, remote, head: headBefore };

  // ② 本地改动 → 拒绝（别覆盖用户正在写的东西）
  let dirty = [];
  try {
    const porcelain = await git(['status', '--porcelain', '--untracked-files=no']);
    dirty = porcelain === '' ? [] : porcelain.split('\n').map((line) => line.trim()).filter(Boolean);
  } catch (error) {
    return { ...base, ...info, error: `读不到工作区状态：${error.message}` };
  }
  if (dirty.length > 0) {
    const shown = dirty.slice(0, 3).join('、');
    const more = dirty.length > 3 ? ` 等 ${dirty.length} 处` : '';
    return {
      ...base,
      ...info,
      dirty,
      dirtyCount: dirty.length,
      error: `本地有未提交的改动（${shown}${more}）—— 先提交或还原再更新，不会覆盖你的东西`,
    };
  }

  // ③ 只快进
  try {
    await git(['pull', '--ff-only', 'origin', branch], pullTimeoutMs);
  } catch (error) {
    return { ...base, ...info, error: `更新失败：${error.message}` };
  }

  let headAfter = headBefore;
  try {
    headAfter = (await git(['rev-parse', '--short', 'HEAD'])).slice(0, 12);
  } catch {
    // 读不到就按"没变"处理：changed 会保守地报 false，界面据此说"没有可更新的内容"
  }
  const to = (await readVersion(dir)) ?? from;
  const changed = headAfter !== headBefore;
  return {
    ...base,
    ...info,
    ok: true,
    changed,
    from,
    to,
    head: headAfter,
    // 磁盘换了代码，进程里还是旧的 —— 这一句是界面"重启后生效"的依据
    restartRequired: changed,
  };
}

/**
 * 给界面用的一句话摘要（**不吞原始错误**）。
 * @param status - `checkUpdate()` 的返回值。
 */
export function describeUpdate(status) {
  if (!status) return '还没检查过';
  if (!status.supported) return status.error ?? '这个安装方式没法自动检查更新';
  if (status.error !== undefined) return status.error;
  if (status.behind === 0) return `已是最新（${status.current ?? '版本未知'}${status.head ? ` · ${status.head}` : ''}）`;
  const from = status.current ?? '?';
  // 版本号没变也算"有更新"（文档/测试类提交很常见）—— 这时别写"新版本"，说"新提交"
  const bumped = Boolean(status.latest) && status.latest !== status.current;
  const to = bumped ? ` → ${status.latest}` : '';
  return `GitHub 上有${bumped ? '新版本' : '新提交'}（${from}${to}，落后 ${status.behind} 次提交）—— 装完重启 DSH 生效`;
}
