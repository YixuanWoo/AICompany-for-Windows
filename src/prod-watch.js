// G-P5 / C：生产真库看门狗。
//
// 为什么单独一个模块：soak 跑的是自己的隔离库（work/soak-*/soak.sqlite），
// 它干净不代表真库干净。真库是常驻进程在写，这里用**只读**连接每 60 秒跑一次
// detectDirty()，把结果单写一份 jsonl，最后跟 soak 报告合流。
//
// 三条纪律：
//   1. 只读打开（readOnly:true），绝不往生产库写半个字；打不开就如实报错，不假装在看。
//   2. 一次探测炸了不中断循环，但要计入 errors —— 看门狗自己瞎了不能当成「没脏状态」。
//   3. 采样用真实墙钟，跟 detectDirty 里的超时判定口径一致。

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { detectDirty } from './observe.js';
import { loadConfig } from './config.js';
import { resolveProfile } from './profiles.js';

/**
 * 造一个生产库看门狗。
 * @param {object} opts
 * @param {string} opts.dbPath 生产库路径（不给就从 profile 解析）
 * @param {string} opts.configPath 生产配置路径（不给就从 profile 解析）
 * @param {string} opts.workRoot 产物根目录（覆盖配置里的 workRoot）
 * @param {string} opts.profile 档位名，默认 prod
 * @param {Function} opts.now 时钟注入
 */
export function createProdWatcher({
  dbPath = null, configPath = null, workRoot = null,
  profile = 'prod', now = () => new Date(),
} = {}) {
  const prof = resolveProfile(profile);
  const resolvedDb = dbPath ? path.resolve(dbPath) : prof.db;
  const resolvedCfg = configPath ? path.resolve(configPath) : prof.config;
  const config = loadConfig(resolvedCfg, process.env, { overridesPath: null });
  const resolvedWorkRoot = workRoot ? path.resolve(workRoot) : config.workRoot;

  if (!fs.existsSync(resolvedDb)) {
    throw new Error(`生产库不存在：${resolvedDb}（看门狗不会自己建库）`);
  }

  // 只读打开；WAL 模式下只读连接照样能看到常驻进程已提交的数据。
  const db = new DatabaseSync(resolvedDb, { readOnly: true });

  const samples = [];
  const errors = [];

  function sample(tag = 'prod-tick') {
    const at = now();
    let row;
    try {
      const dirty = detectDirty({ db, config, workRoot: resolvedWorkRoot, now: at });
      row = {
        at: at.toISOString(), tag,
        ok: true,
        clean: dirty.clean,
        dirtyCount: dirty.count,
        dirtyCodes: dirty.counts,
        issues: dirty.issues.slice(0, 20),
      };
    } catch (error) {
      row = {
        at: at.toISOString(), tag,
        ok: false,
        error: String(error.message ?? error),
      };
      errors.push({ at: row.at, error: row.error });
    }
    samples.push(row);
    return row;
  }

  function summary() {
    const okSamples = samples.filter((s) => s.ok);
    return {
      dbPath: resolvedDb,
      configPath: resolvedCfg,
      workRoot: resolvedWorkRoot,
      sampleCount: samples.length,
      okCount: okSamples.length,
      dirtySamples: okSamples.filter((s) => !s.clean).length,
      errorCount: errors.length,
      lastClean: okSamples.length ? okSamples[okSamples.length - 1].clean : null,
    };
  }

  function flush(reportDir) {
    fs.mkdirSync(reportDir, { recursive: true });
    const file = path.join(reportDir, 'prod-watch.jsonl');
    fs.writeFileSync(file, `${samples.map((s) => JSON.stringify(s)).join('\n')}\n`, 'utf8');
    return file;
  }

  function close() {
    try { db.close(); } catch { /* 已关 */ }
  }

  return {
    db, config, samples, errors,
    get last() { return samples.length ? samples[samples.length - 1] : null; },
    sample, summary, flush, close,
    get meta() { return { dbPath: resolvedDb, configPath: resolvedCfg, workRoot: resolvedWorkRoot }; },
  };
}
