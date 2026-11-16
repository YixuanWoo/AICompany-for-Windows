// P6-6：常驻「实例档位」（profile）。
//
// 为什么需要：一台机器上会有两种实例 —— 一个跑真活的（带 GUI 席位），一个用来演示 / 试功能的
// （假员工，不抢键鼠）。它们必须各自有端口、数据库、日志目录、产物根目录和计划任务名，
// 否则会互相踩：抢同一个 pid 文件、写同一个数据库、把演示卡派进真席位。
//
// 口径全在这一个 JSON 里，Node 与 PowerShell 都读它（PS 侧通过 `runner.js --print-profile` 拿
// 解析后的绝对路径，避免两边各写一套拼路径逻辑，迟早对不上）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PROFILES_PATH = path.join(ROOT, 'config', 'profiles.json');

export function loadProfiles(profilesPath = PROFILES_PATH) {
  let text;
  try {
    text = fs.readFileSync(profilesPath, 'utf8');
  } catch (error) {
    throw new Error(`读不到实例档位文件：${profilesPath}（${error.message}）`);
  }
  let data;
  try { data = JSON.parse(text); } catch (error) {
    throw new Error(`实例档位不是合法 JSON：${profilesPath}（${error.message}）`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`实例档位必须是对象：${profilesPath}`);
  }
  return data;
}

// 把相对路径全部钉成绝对路径：计划任务的环境变量和当前目录与终端不一致，
// 用相对路径启动等于赌运气。
export function resolveProfile(name, { profilesPath = PROFILES_PATH, root = ROOT } = {}) {
  const profiles = loadProfiles(profilesPath);
  const raw = profiles[name];
  if (!raw) {
    throw new Error(`没有名为「${name}」的实例档位；可用：${Object.keys(profiles).join(' / ')}`);
  }
  const workDir = path.resolve(root, raw.workDir ?? path.join('work', name));
  return {
    name,
    port: Number(raw.port ?? 3100),
    config: path.resolve(root, raw.config),
    db: path.resolve(root, raw.db ?? path.join(workDir, 'aicompany.db')),
    workDir,
    runDir: path.join(workDir, 'run'),
    logDir: path.join(workDir, 'logs'),
    taskName: raw.taskName ?? `AICompany-${name}`,
    maintenanceSec: Number(raw.maintenanceSec ?? 60),
    // 真 GUI 席位一次能跑几分钟：生产档默认「提交即返回，后台推进」，
    // 演示档保持同步（测试与演示需要「提交完就已经跑完」）。
    requestAsync: raw.requestAsync === true,
    // GUI 占位与暂停开关是**跨实例**的：同一台机器上只有一个键鼠。
    guiSeatFile: path.resolve(root, raw.guiSeatFile ?? path.join('work', 'gui-seat.json')),
    guiPauseFile: path.resolve(root, raw.guiPauseFile ?? path.join('work', 'gui-pause.json')),
    description: raw.description ?? '',
  };}

export function listProfileNames(profilesPath = PROFILES_PATH) {
  return Object.keys(loadProfiles(profilesPath));
}
