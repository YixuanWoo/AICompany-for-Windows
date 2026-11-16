#!/usr/bin/env node
// G-P5 / C：生产真库看门狗 CLI。
//
//   node scripts/prod-watch.js --hours 72 --interval 60 --out work/soak/<runId>
//
// 跟 soak 一起挂：soak 观测自己的隔离库，这里每 60 秒只读扫一次生产真库。
// 两份报告合流看：soak 报「引擎逻辑干净」，这里报「真实现场也干净」。
// Ctrl+C 会收尾写出已采到的样本，不假装跑满。

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createProdWatcher } from '../src/prod-watch.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = {
    hours: 72, interval: 60, out: null,
    db: null, config: null, workRoot: null, profile: 'prod', quiet: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--hours') args.hours = Number(argv[++i]);
    else if (a === '--interval') args.interval = Number(argv[++i]);
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--db') args.db = argv[++i];
    else if (a === '--config') args.config = argv[++i];
    else if (a === '--work-root') args.workRoot = argv[++i];
    else if (a === '--profile') args.profile = argv[++i];
    else if (a === '--quiet') args.quiet = true;
  }
  return args;
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!(args.hours > 0) || !(args.interval > 0)) {
    console.error('--hours 和 --interval 必须是正数');
    process.exit(2);
  }
  const outDir = args.out
    ? path.resolve(args.out)
    : path.join(ROOT, 'work', 'soak', `prod-watch-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(outDir, { recursive: true });

  const watcher = createProdWatcher({
    dbPath: args.db, configPath: args.config, workRoot: args.workRoot, profile: args.profile,
  });
  const log = (...line) => { if (!args.quiet) console.log(...line); };
  log(`[prod-watch] 生产库 ${watcher.meta.dbPath}`);
  log(`[prod-watch] 每 ${args.interval} 秒扫一次，目标 ${args.hours} 小时，报告 ${outDir}`);

  let interrupted = false;
  process.on('SIGINT', () => {
    interrupted = true;
    console.log('\n[prod-watch] 收到中断，收尾写报告…');
  });

  const startedAt = Date.now();
  const deadline = startedAt + args.hours * 3_600_000;
  let lastLog = 0;

  while (Date.now() < deadline && !interrupted) {
    const row = watcher.sample('prod-tick');
    if (!row.ok || !row.clean) {
      // 脏状态或探测失败都立刻打到控制台 —— 看门狗的价值就在「当场喊出来」。
      console.log(`[prod-watch] ${row.at} ${row.ok ? `脏状态 ${row.dirtyCount} 处：${JSON.stringify(row.dirtyCodes)}` : `探测失败：${row.error}`}`);
    }
    if (Date.now() - lastLog > 60_000) {
      lastLog = Date.now();
      const left = ((deadline - Date.now()) / 3_600_000).toFixed(2);
      log(`[prod-watch] ${new Date().toISOString()} | 还剩 ${left} 小时 | 已采样 ${watcher.samples.length}`);
    }
    await sleep(args.interval * 1000);
  }

  watcher.sample('final');
  const file = watcher.flush(outDir);
  const summary = watcher.summary();
  const endedAt = new Date().toISOString();
  const report = {
    startedAt: new Date(startedAt).toISOString(),
    endedAt,
    wallClockHours: (Date.now() - startedAt) / 3_600_000,
    interrupted,
    summary,
    samples: watcher.samples,
    errors: watcher.errors,
  };
  fs.writeFileSync(path.join(outDir, 'prod-watch-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  const md = [
    '# 生产真库看门狗报告',
    '',
    `- 生产库：\`${summary.dbPath}\``,
    `- 窗口：${report.startedAt} → ${endedAt}（墙钟 ${report.wallClockHours.toFixed(2)} 小时${interrupted ? '，人工中断' : ''}）`,
    `- 采样：${summary.sampleCount} 次，脏状态 ${summary.dirtySamples} 次，探测失败 ${summary.errorCount} 次`,
    `- 末次干净：${summary.lastClean === null ? '未采到' : (summary.lastClean ? '是' : '否')}`,
    '',
    '## 判定',
    '',
    !interrupted && report.wallClockHours >= args.hours && summary.errorCount === 0 && summary.dirtySamples === 0
      ? '**通过**：跑满窗口、全程无探测失败、生产真库零脏状态。'
      : '**未通过**（或中途中断）：见下方明细，不能当干净证据。',
    '',
    '## 异常明细',
    '',
    ...watcher.samples.filter((s) => !s.ok || !s.clean).slice(0, 30)
      .map((s) => `- ${s.at}：${s.ok ? `脏状态 ${JSON.stringify(s.dirtyCodes)}` : s.error}`),
  ].join('\n');
  fs.writeFileSync(path.join(outDir, 'prod-watch-report.md'), `${md}\n`, 'utf8');

  console.log('');
  console.log('=== 生产真库看门狗 ===');
  console.log(`  采样 ${summary.sampleCount} 次 | 脏 ${summary.dirtySamples} | 探测失败 ${summary.errorCount}`);
  console.log(`  报告：${outDir}`);
  watcher.close();
  const passed = !interrupted && report.wallClockHours >= args.hours
    && summary.errorCount === 0 && summary.dirtySamples === 0;
  process.exit(passed ? 0 : 1);
}

main().catch((error) => {
  console.error('[prod-watch] 失败：', error.message);
  console.error(error.stack);
  process.exit(1);
});
