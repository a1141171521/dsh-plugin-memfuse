/**
 * 「GitHub 上有没有新版本」——只读检查，**不动工作区**。
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
 * 给界面用的一句话摘要（**不吞原始错误**）。
 * @param status - `checkUpdate()` 的返回值。
 */
export function describeUpdate(status) {
  if (!status) return '还没检查过';
  if (!status.supported) return status.error ?? '这个安装方式没法自动检查更新';
  if (status.error !== undefined) return status.error;
  if (status.behind === 0) return `已是最新（${status.current ?? '版本未知'}${status.head ? ` · ${status.head}` : ''}）`;
  const latest = status.latest ? ` → ${status.latest}` : '';
  return `GitHub 上有新版本（${status.current ?? '?'}${latest}，落后 ${status.behind} 次提交）—— 更新后重启 DSH 生效`;
}
