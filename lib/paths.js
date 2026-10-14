// 路径布局。所有存储位置集中在这里，便于迁移与测试。
import os from 'node:os';
import path from 'node:path';

/** DSH 数据根目录 */
export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/** 记忆仓库根 */
export function memoryRoot(config) {
  return config?.root || path.join(dshHome(), 'memory');
}

/** 由根目录推导出全部子路径 */
export function layout(root) {
  const meta = path.join(root, '.memory');
  return {
    root,
    index: path.join(root, 'index.md'),
    memories: path.join(root, 'memories'),
    skills: path.join(root, 'skills'),
    sessions: path.join(root, 'sessions'),
    adhoc: path.join(root, 'extensions', 'ad_hoc'),
    meta,
    state: path.join(meta, 'state.json'),
    jobs: path.join(meta, 'jobs.json'),
    usage: path.join(meta, 'usage.jsonl'),
    status: path.join(meta, 'status.md'),
  };
}

/** kind → 存放目录键 */
export function bucketOf(kind) {
  return kind === 'skill' || kind === 'experience' ? 'skills' : 'memories';
}
