#!/usr/bin/env node
// 仓库 CLI：只有登记过的仓库能被这个入口碰，别的目录一律拒绝。
//
// 为什么要有这个入口：代码提交/推送是「会留下永久痕迹」的动作。散着用 git 命令，
// 迟早会出现「推错仓库」「把半成品推上 main」「force push 覆盖别人的提交」。
// 这里把允许的仓库写成白名单（company.yaml 的 repos），推送必须显式 allowPush，
// 且永远不带 --force —— 想强制推，只能人去命令行手动做。
//
// 用法：
//   node scripts/repo.js list
//   node scripts/repo.js status [仓库id]
//   node scripts/repo.js log <仓库id> [--n 5]
//   node scripts/repo.js commit <仓库id> --message "改了什么" [--all] [--dry-run]
//   node scripts/repo.js push <仓库id> [--dry-run]

import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/config.js';
import { allRepos, describeRepo, gitStatus, isGitWorktree, repoEntry } from '../src/repos.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) { out._.push(item); continue; }
    const key = item.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { out[key] = true; continue; }
    out[key] = next;
    i += 1;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0] ?? 'list';
const line = (text = '') => console.log(text);

const configPath = path.resolve(ROOT, env.AICOMPANY_CONFIG ?? 'config/company.prod.yaml');
// loadConfig 返回 { config, doctor, source }：这里要的是里面的 config。
const { config } = loadConfig(configPath, env);

function git(repo, argv, { dryRun = false } = {}) {
  if (dryRun) {
    line(`  [dry-run] git -C "${repo.path}" ${argv.join(' ')}`);
    return '';
  }
  return execFileSync('git', ['-C', repo.path, ...argv], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, maxBuffer: 8 * 1024 * 1024,
  }).trim();
}

function requireRepo(id) {
  const repo = repoEntry(config, id);
  if (!repo) {
    console.error(`未登记的仓库：${String(id ?? '(没写)')}；已登记：${allRepos(config).map((r) => r.id).join(', ') || '（无）'}`);
    console.error('先把它加进 config/company.prod.yaml 的 repos 段 —— 这是唯一允许操作代码的入口。');
    process.exit(2);
  }
  if (!isGitWorktree(repo.path)) {
    console.error(`不是 git 工作区：${repo.path}`);
    process.exit(2);
  }
  return repo;
}

function printStatus(repo) {
  const st = gitStatus(repo);
  line(`${repo.id}（${repo.displayName}）`);
  line(`  ${describeRepo(repo)}`);
  if (!st.ok) { line(`  ✗ ${st.error}`); return st; }
  const dirty = st.dirty ? `脏：${st.changedCount} 个文件待提交` : '干净';
  const sync = st.upstream
    ? `领先 ${st.ahead}｜落后 ${st.behind}（${st.upstream}）`
    : '没有上游分支（还没推过）';
  line(`  分支 ${st.branch}｜HEAD ${st.head}｜${dirty}｜${sync}`);
  for (const item of st.changed.slice(0, 20)) line(`    · ${item}`);
  if (st.changedCount > 20) line(`    · …还有 ${st.changedCount - 20} 个`);
  return st;
}

if (command === 'list') {
  const repos = allRepos(config);
  if (!repos.length) { line('还没有登记任何仓库（company.yaml 的 repos 段是空的）。'); process.exit(0); }
  line(`已登记 ${repos.length} 个仓库：`);
  for (const repo of repos) printStatus(repo);
  process.exit(0);
}

if (command === 'status') {
  const id = args._[1];
  if (!id) {
    for (const repo of allRepos(config)) printStatus(repo);
    process.exit(0);
  }
  const st = printStatus(requireRepo(id));
  process.exit(st.ok ? 0 : 1);
}

if (command === 'log') {
  const repo = requireRepo(args._[1]);
  const n = Number(args.n ?? 5);
  line(git(repo, ['log', `-${Number.isFinite(n) && n > 0 ? n : 5}`, '--oneline', '--decorate']));
  process.exit(0);
}

if (command === 'commit') {
  const repo = requireRepo(args._[1]);
  const message = typeof args.message === 'string' ? args.message.trim() : '';
  if (!message) {
    console.error('必须写 --message "这次改了什么"：提交信息是以后唯一的线索。');
    process.exit(2);
  }
  const st = gitStatus(repo);
  if (!st.ok) { console.error(st.error); process.exit(1); }
  if (!st.dirty) { line('工作区是干净的，没有可提交的改动。'); process.exit(0); }
  line(`将提交 ${st.changedCount} 个文件（分支 ${st.branch}）：`);
  for (const item of st.changed.slice(0, 30)) line(`  · ${item}`);
  if (st.changedCount > 30) line(`  · …还有 ${st.changedCount - 30} 个`);
  if (args.all !== true) {
    line('默认只提交已跟踪文件的改动（不把未跟踪的新文件塞进去）。要把新文件一起提交，加 --all。');
    git(repo, ['add', '-u'], { dryRun: args['dry-run'] === true });
  } else {
    git(repo, ['add', '-A'], { dryRun: args['dry-run'] === true });
  }
  git(repo, ['commit', '-m', message], { dryRun: args['dry-run'] === true });
  if (args['dry-run'] === true) { line('[dry-run] 没有真的提交。'); process.exit(0); }
  line(`已提交：${git(repo, ['log', '-1', '--oneline'])}`);
  process.exit(0);
}

if (command === 'push') {
  const repo = requireRepo(args._[1]);
  if (!repo.remote) {
    console.error(`${repo.id} 没有配 remote：这个仓库只做本地留档，不推送。`);
    process.exit(2);
  }
  if (!repo.allowPush) {
    console.error(`${repo.id} 没开 allowPush。要允许自动推送，在 company.yaml 里给它写 allowPush: true。`);
    process.exit(2);
  }
  const st = gitStatus(repo);
  if (!st.ok) { console.error(st.error); process.exit(1); }
  if (st.dirty) {
    console.error(`工作区还有 ${st.changedCount} 个文件没提交，先把它们处理掉再推（不能推一个半成品状态）。`);
    process.exit(1);
  }
  if (st.branch !== repo.branch) {
    console.error(`当前分支 ${st.branch} 与登记的 ${repo.branch} 不一致；不替你做分支判断。`);
    process.exit(1);
  }
  if (!st.ahead && st.upstream) { line('没有新提交要推（本地与远端一致）。'); process.exit(0); }
  // 永远不带 --force / -f：要覆盖远端只能人自己动手。
  git(repo, ['push', 'origin', st.branch], { dryRun: args['dry-run'] === true });
  if (args['dry-run'] === true) { line('[dry-run] 没有真的推送。'); process.exit(0); }
  line(`已推送：${st.branch} → ${repo.remote}`);
  process.exit(0);
}

console.error(`未知命令 ${command}；可用：list / status / log / commit / push`);
process.exit(2);
