// 仓库台账：代码的「家」在哪儿、往哪个远端推、谁审、许不许自动推。
//
// 为什么单独一层：项目（project）回答「这摊事归谁、产物落哪、经验记哪」，
// 仓库（repo）回答「代码在哪台机器的哪个目录、对应哪个 GitHub 仓库」。
// 两者是多对多且都可缺省：
//   · 翻译项目没有代码仓库 —— 只有 project；
//   · 开源小工具没有项目，只是一个仓库 —— 只有 repo；
//   · 项目里的代码 —— 两者都有，卡上各写一个 id。
// 把仓库挂进项目里会让「一次性脚本」和「要长期维护的代码」混在一起，所以这里单独登记。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const REPO_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
// 远端只认 GitHub 的 owner/name 或完整 https 地址，避免把推送目标配到别处。
export const REMOTE_RE = /^(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+|https:\/\/[^\s]+)$/;

export class RepoError extends Error {
  constructor(message, code = 'REPO_INVALID', extra = {}) {
    super(message);
    this.name = 'RepoError';
    this.code = code;
    Object.assign(this, extra);
  }
}

function toPosix(value) {
  return String(value).replace(/\\/g, '/');
}

/** 登记项归一：配置里写一行，这里补全默认值。 */
export function normalizeRepos(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const [id, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== 'object') {
      throw new RepoError(`repos.${id} 必须是一个对象（至少写 path）`, 'REPO_INVALID');
    }
    const dir = entry.path ? path.resolve(String(entry.path)) : null;
    if (!dir) throw new RepoError(`repos.${id} 缺 path：代码在本机的哪个目录`, 'REPO_INVALID');
    if (!REPO_ID_RE.test(id)) {
      throw new RepoError(`repos.${id} 的 id 只允许小写字母、数字、下划线、短横线（≤32 字符）`, 'REPO_INVALID');
    }
    const remote = entry.remote ? String(entry.remote) : null;
    if (remote && !REMOTE_RE.test(remote)) {
      throw new RepoError(`repos.${id}.remote 要写成 owner/name 或 https 地址，收到：${remote}`, 'REPO_INVALID');
    }
    out[id] = {
      id,
      displayName: entry.displayName ? String(entry.displayName) : id,
      path: dir,
      // 远端为空 = 只在本地留档，不推送（一次性脚本、还没上 GitHub 的项目）。
      remote,
      branch: entry.branch ? String(entry.branch) : 'main',
      // 谁审这个仓库的代码。默认工程执行；配 null 表示沿用「谁派的活谁来审」。
      reviewer: entry.reviewer === undefined ? 'engineering' : (entry.reviewer ?? null),
      // 默认不许自动推：要推必须显式写 allowPush: true，免得一句「提交一下」把半成品推上去。
      allowPush: entry.allowPush === true,
      // 这个仓库属于哪个项目（可选）。只用于给人看和拼提示词，不参与派活校验。
      project: entry.project ?? null,
      note: entry.note ? String(entry.note) : null,
    };
  }
  return out;
}

export function configuredRepoIds(config = {}) {
  return Object.keys(config.repos ?? {});
}

export function repoEntry(config = {}, id) {
  const key = id === null || id === undefined ? '' : String(id).trim();
  if (!key) return null;
  return (config.repos ?? {})[key] ?? null;
}

export function assertRepo({ config = {}, requested = null, required = false } = {}) {
  const ids = configuredRepoIds(config);
  const key = requested === null || requested === undefined ? '' : String(requested).trim();
  if (!key) {
    if (required && ids.length) {
      throw new RepoError(
        `这活被判定为「受管代码」，必须写 repo（代码在哪个仓库）；已登记：${ids.join(', ')}`,
        'REPO_REQUIRED',
      );
    }
    return { ok: true, repo: null };
  }
  const repo = repoEntry(config, key);
  if (!repo) {
    throw new RepoError(`未登记的仓库：${key}；已登记：${ids.join(', ') || '（无）'}。先加进 company.yaml 的 repos 段`, 'REPO_UNKNOWN');
  }
  return { ok: true, repo };
}

/** 路径是否落在某个仓库里（取最长前缀，嵌套仓库时以更具体的那个为准）。 */
export function findRepoForPath(config = {}, absPath) {
  const target = toPosix(path.resolve(String(absPath ?? '')));
  if (!target) return null;
  let hit = null;
  for (const repo of Object.values(config.repos ?? {})) {
    const root = toPosix(path.resolve(repo.path)).replace(/\/$/, '');
    if (target === root || target.startsWith(`${root}/`)) {
      if (!hit || root.length > toPosix(hit.path).length) hit = repo;
    }
  }
  return hit;
}

/** 一个目录是不是 git 工作区（只看 .git，不跑命令）。 */
export function isGitWorktree(dir) {
  try {
    return fs.existsSync(path.join(dir, '.git'));
  } catch {
    return false;
  }
}

function git(repo, args, { maxBuffer = 4 * 1024 * 1024 } = {}) {
  return execFileSync('git', ['-C', repo.path, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer,
    timeout: 30000,
  }).trim();
}

/**
 * 只读体检：分支、脏不脏、领先/落后几条、HEAD。
 * 不做任何写操作 —— 状态查询在任何时候都应该是安全的。
 */
export function gitStatus(repo) {
  if (!repo?.path) return { ok: false, error: '没有仓库' };
  if (!isGitWorktree(repo.path)) {
    return { ok: false, error: `不是 git 工作区：${repo.path}`, path: repo.path };
  }
  try {
    const branch = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const head = git(repo, ['rev-parse', '--short', 'HEAD']).slice(0, 12);
    const porcelain = git(repo, ['status', '--porcelain']);
    const changed = porcelain ? porcelain.split('\n').map((line) => line.trim()).filter(Boolean) : [];
    let ahead = 0;
    let behind = 0;
    let upstream = null;
    try {
      upstream = git(repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
      const counts = git(repo, ['rev-list', '--left-right', '--count', `HEAD...@{u}`]).split(/\s+/);
      ahead = Number(counts[0] ?? 0);
      behind = Number(counts[1] ?? 0);
    } catch {
      // 没有上游（还没推过 / 没有 remote）不是错误，如实标 null。
    }
    const remotes = git(repo, ['remote', '-v']).split('\n').filter(Boolean);
    return {
      ok: true, path: repo.path, branch, head, upstream, ahead, behind,
      dirty: changed.length > 0, changed, changedCount: changed.length,
      remotes: [...new Set(remotes.map((l) => l.split(/\s+/)[0]))],
    };
  } catch (error) {
    return { ok: false, path: repo.path, error: String(error.stderr ?? error.message ?? error).slice(0, 500) };
  }
}

/** 给提示词用的一行说明：仓库在哪、推哪、谁审、能不能自动推。 */
export function describeRepo(repo) {
  if (!repo) return '（这张卡没有代码仓库）';
  const bits = [
    `${repo.id}（${repo.displayName}）`,
    `目录 ${toPosix(repo.path)}`,
    repo.remote ? `远端 ${repo.remote}（分支 ${repo.branch}）` : '只在本地，不推送',
    `审查人 ${repo.reviewer ?? '按派活人'}`,
    repo.allowPush ? '允许自动推送' : '不允许自动推送',
  ];
  return bits.join('｜');
}

export function allRepos(config = {}) {
  return Object.values(config.repos ?? {});
}
