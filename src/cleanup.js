// P4-9：清理类扫描的红线实现。只列路径 / 大小 / 日期出报告，绝不移动、改名、删除。
// 白名单之外、或命中敏感目录（Desktop / Downloads / Documents / Home / 系统盘）→ 直接报错退出，
// 且一个文件都不写。依据：任务书 §6A.9。

import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson, nowIso } from './ids.js';

export const SENSITIVE_PATTERNS = Object.freeze([
  /(^|[\\/])Desktop([\\/]|$)/i,
  /(^|[\\/])桌面([\\/]|$)/,
  /(^|[\\/])Downloads([\\/]|$)/i,
  /(^|[\\/])下载([\\/]|$)/,
  /(^|[\\/])Documents([\\/]|$)/i,
  /(^|[\\/])文档([\\/]|$)/,
  /(^|[\\/])AppData([\\/]|$)/i,
  /(^|[\\/])Library([\\/]|$)/i,
  /^[A-Za-z]:[\\/]Windows([\\/]|$)/i,
  /^\/(System|usr|etc|bin|sbin)([\\/]|$)/,
  /(^|[\\/])\.ssh([\\/]|$)/,
  /(^|[\\/])\.config([\\/]|$)/,
]);

export class CleanupRefused extends Error {
  constructor(reason) {
    super(`清理扫描被拒绝：${reason}（未写入任何文件）`);
    this.name = 'CleanupRefused';
    this.code = 'CLEANUP_REFUSED';
  }
}

// 任何一个目标不合格就整体拒绝——不做「部分处理」。
export function assertScanTargets(targets, whitelist) {
  if (!Array.isArray(targets) || targets.length === 0) throw new CleanupRefused('没有给出扫描目标');
  if (!Array.isArray(whitelist) || whitelist.length === 0) {
    throw new CleanupRefused('没有配置白名单（scanWhitelist 为空），不猜、不顺手处理');
  }
  const normalized = whitelist.map((w) => path.resolve(String(w)));
  for (const target of targets) {
    const raw = String(target);
    const hit = SENSITIVE_PATTERNS.find((re) => re.test(raw));
    if (hit) throw new CleanupRefused(`目标命中敏感目录：${raw}；个人文件目录永远不扫`);
    const resolved = path.resolve(raw);
    const allowed = normalized.some((root) => resolved === root || resolved.startsWith(root + path.sep));
    if (!allowed) throw new CleanupRefused(`目标不在白名单内：${raw}`);
  }
  return targets.map((t) => path.resolve(String(t)));
}

function walk(dir, limit) {
  const out = [];
  const stack = [dir];
  while (stack.length && out.length < limit) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        const st = fs.statSync(full);
        out.push({ path: full, bytes: st.size, modifiedAt: st.mtime.toISOString() });
        if (out.length >= limit) break;
      }
    }
  }
  return out;
}

// 只出清单。deletedCount 恒为 0，schema 也强制它为 0。
export function cleanupScan({
  jobId, cycleNo = null, targets, whitelist, workRoot, maxFiles = 500, now = nowIso(),
}) {
  const resolved = assertScanTargets(targets, whitelist);
  const items = [];
  for (const dir of resolved) {
    if (!fs.existsSync(dir)) {
      items.push({ path: dir, missing: true });
      continue;
    }
    items.push(...walk(dir, maxFiles - items.length));
    if (items.length >= maxFiles) break;
  }
  const report = {
    schema: 'aicompany.cleanup-report/v1',
    jobId, cycleNo,
    scannedAt: now,
    targets: resolved,
    items,
    metrics: {
      fileCount: items.filter((x) => !x.missing).length,
      totalBytes: items.reduce((sum, x) => sum + (x.bytes ?? 0), 0),
      deletedCount: 0,
    },
    note: '只扫描出报告，绝不删除；真要删请另起一次性任务并逐项人工确认。',
  };
  const outDir = path.join(workRoot, 'reports');
  const file = path.join(outDir, `cleanup-${jobId}-${cycleNo ?? 'manual'}.json`);
  atomicWriteJson(file, report);
  return { ...report, reportPath: file };
}
