#!/usr/bin/env node
// P5-1：试运行 CLI。
//
//   node scripts/soak.js --hours 72 --mode compressed          # 压缩时钟，几分钟出结论（只算模拟）
//   node scripts/soak.js --hours 72 --mode real --interval 60  # 真实常驻，跑满 72 小时才算数
//
// 真实模式会真的等。可以随时 Ctrl+C，收尾仍会写出报告，但门禁只会判 insufficient。

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createSoakRunner, buildSoakConfig, judgeGate, writeSoakReport,
} from '../src/soak.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = { hours: null, mode: 'compressed', stepMin: 60, interval: 60, out: null, db: null, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--hours') args.hours = Number(argv[++i]);
    else if (a === '--mode') args.mode = argv[++i];
    else if (a === '--step-min') args.stepMin = Number(argv[++i]);
    else if (a === '--interval') args.interval = Number(argv[++i]);
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--db') args.db = argv[++i];
    else if (a === '--quiet') args.quiet = true;
  }
  return args;
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.hours || args.hours <= 0) {
    console.error('必须给 --hours，例如 --hours 72');
    process.exit(2);
  }
  if (!['real', 'compressed'].includes(args.mode)) {
    console.error('--mode 只能是 real 或 compressed');
    process.exit(2);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runId = `soak-${args.mode}-${stamp}`;
  const workRoot = path.join(ROOT, 'work', runId);
  const reportDir = args.out ? path.resolve(args.out) : path.join(ROOT, 'work', 'soak');
  const dbPath = args.db ? path.resolve(args.db) : path.join(workRoot, 'soak.sqlite');
  fs.mkdirSync(workRoot, { recursive: true });

  const startedAt = new Date().toISOString();
  const runner = createSoakRunner({
    workRoot, dbPath,
    config: buildSoakConfig({ workRoot }),
    stepMinutes: args.mode === 'real' ? 60 : args.stepMin,
  });

  const log = (...line) => { if (!args.quiet) console.log(...line); };
  log(`[soak] ${runId} | 模式 ${args.mode} | 目标 ${args.hours} 小时 | 库 ${dbPath}`);

  let interrupted = false;
  process.on('SIGINT', () => {
    interrupted = true;
    console.log('\n[soak] 收到中断，收尾写报告…');
  });

  if (args.mode === 'compressed') {
    const result = await runner.drive({
      hours: args.hours,
      onStep: ({ step, steps, at }) => {
        if (step % Math.max(1, Math.round(steps / 12)) === 0 || step === steps) {
          log(`  步 ${step}/${steps} | 虚拟时间 ${at} | 采样 ${runner.samples.length}`);
        }
      },
    });
    runner.sample('final');
    const observation = runner.observation({ mode: 'compressed', hours: args.hours, startedAt });
    const endedAt = new Date().toISOString();
    const gate = judgeGate({
      mode: 'compressed',
      wallClockHours: 0,
      wallClockMinutes: (Date.parse(endedAt) - Date.parse(startedAt)) / 60_000,
      samples: runner.samples, finalObservation: observation,
    });
    const { dir } = writeSoakReport(reportDir, {
      runId, mode: 'compressed', hours: args.hours, stepMinutes: args.stepMin,
      startedAt, endedAt, samples: runner.samples, observation, gate, errors: result.errors,
    });
    runner.close();
    printSummary({ observation, gate, dir, errors: result.errors });
    process.exit(gate.level === 'simulated' ? 0 : 1);
  }

  // 真实墙钟：真等，按 interval 秒做维护与采样。跑到 hours 满或人工中断。
  const deadline = Date.now() + args.hours * 3_600_000;
  let lastLog = 0;
  while (Date.now() < deadline && !interrupted) {
    runner.maintain();
    await runner.engine.pump();
    runner.sample('real-tick');
    if (Date.now() - lastLog > 60_000) {
      lastLog = Date.now();
      const left = ((deadline - Date.now()) / 3_600_000).toFixed(2);
      log(`  ${new Date().toISOString()} | 还剩 ${left} 小时 | 采样 ${runner.samples.length}`);
    }
    await sleep(Math.max(1, args.interval) * 1000);
  }

  runner.sample('final');
  const observation = runner.observation({ mode: 'real', hours: args.hours, startedAt });
  const endedAt = new Date().toISOString();
  const gate = judgeGate({
    mode: 'real',
    wallClockHours: (Date.parse(endedAt) - Date.parse(startedAt)) / 3_600_000,
    samples: runner.samples, finalObservation: observation,
  });
  const { dir } = writeSoakReport(reportDir, {
    runId, mode: 'real', hours: args.hours, stepMinutes: 60,
    startedAt, endedAt, samples: runner.samples, observation, gate, errors: [],
  });
  runner.close();
  printSummary({ observation, gate, dir, errors: [] });
  process.exit(gate.passed ? 0 : 1);
}

function printSummary({ observation, gate, dir, errors }) {
  const pct = (v) => (v === null || v === undefined ? '样本不足' : `${(v * 100).toFixed(1)}%`);
  const m = observation.metrics;
  console.log('');
  console.log('=== 五项指标 ===');
  const fw = m.falseWake;
  const fwText = fw.attempts === 0
    ? `真实流量零被拒唤醒；另有 ${fw.probeRejected} 次探针被终态拦截挡住`
    : `${pct(fw.rate)}  (${fw.miswake}/${fw.attempts}，另有 ${fw.probeRejected} 次探针)`;
  console.log(`  误唤醒率      ${fwText}`);
  console.log(`  空转 Run 率   ${pct(m.idleRun.rate)}  (${m.idleRun.total}/${m.idleRun.successRuns})`);
  console.log(`  报告不合格率  ${pct(m.reportReject.rate)}  (${m.reportReject.rejected}/${m.reportReject.rejected + m.reportReject.accepted})`);
  console.log(`  GUI 失败率    ${pct(m.guiFailure.rate)}  (${m.guiFailure.failed}/${m.guiFailure.runs})`);
  console.log(`  额度消耗      ${pct(m.quotaBurn.rate)}  (${m.quotaBurn.used}/${m.quotaBurn.limit})`);
  console.log('=== §6C / §6D 四项结论 ===');
  for (const [key, value] of Object.entries(observation.findings)) {
    console.log(`  ${key.padEnd(20)} ${value.verdict.padEnd(12)} ${value.conclusion}`);
  }
  console.log('=== 脏状态 ===');
  console.log(`  ${observation.dirty.clean ? '无' : `${observation.dirty.count} 处：${JSON.stringify(observation.dirty.counts)}`}`);
  console.log('=== G-P5 门禁 ===');
  console.log(`  ${gate.passed ? '通过' : '未通过'}（${gate.level}）：${gate.reason}`);
  console.log(`  异常 ${errors.length} 次`);
  console.log(`  报告：${dir}`);
}

main().catch((error) => {
  console.error('[soak] 失败：', error.message);
  console.error(error.stack);
  process.exit(1);
});
