// CLI 席位提示词单测（2026-11-23 第二轮维护改写）。
//
// 前身是对桥接脚本源码的字符串断言（提示词当时长在脚本里，没法 import）。
// 现在提示词抽成了纯函数 src/cli-prompt.js，直接构造上下文断言行为。
//
// 守两条事故线：
//   ① ctx.project 是对象，取 .contextText —— 曾经 String 化成 "[object Object]"，
//      项目规范与经验从来没进过 CLI 提示词，产物落点全靠 agent 猜；
//   ② 落盘口径：有项目落点时产物写项目目录、禁止进 output/、draft 必须报 deliverables；
//      没项目时退回 output/，deliverables 可省。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildCliPrompt } from '../src/cli-prompt.js';

const paths = {
  taskDir: 'D:\\work\\tasks\\T-1',
  outputDir: 'D:\\work\\tasks\\T-1\\output',
  changeRequestsDir: 'D:\\work\\tasks\\T-1\\change-requests',
};

test('CLI-PROMPT-1 · 项目上下文取 contextText，不出现 [object Object]', () => {
  const prompt = buildCliPrompt(
    { task: { taskId: 'T-1', instructions: '干一件事' }, project: { contextText: '【项目规范】\n产物落 05-成品' } },
    paths,
  );
  assert.match(prompt, /【项目规范】/);
  assert.match(prompt, /产物落 05-成品/);
  assert.doesNotMatch(prompt, /\[object Object\]/);
});

test('CLI-PROMPT-2 · 没项目时整段省略，不塞 null / 空壳', () => {
  const prompt = buildCliPrompt({ task: { taskId: 'T-1' }, project: null }, paths);
  assert.doesNotMatch(prompt, /\[object Object\]|【项目规范】|^null$/m);
  // 无项目落点 → 退回 output/，deliverables 可省
  assert.match(prompt, /产物落点（绝对路径）：D:\\work\\tasks\\T-1\\output/);
  assert.match(prompt, /deliverables 可以省略/);
});

test('CLI-PROMPT-3 · 有项目落点：产物写项目目录、禁止进 output/、必须报 deliverables', () => {
  const prompt = buildCliPrompt(
    {
      task: { taskId: 'T-1' },
      project: { contextText: '【项目规范】x', writeDir: 'D:\\Demo\\\文档处理项目\\05-成品' },
    },
    paths,
  );
  assert.match(prompt, /产物落点（绝对路径）：D:\\Demo\\\文档处理项目\\05-成品/);
  assert.match(prompt, /禁止写进 .*output/);
  assert.match(prompt, /deliverables 必须列出/);
  assert.match(prompt, /workflow\.outputs/);
});

test('CLI-PROMPT-4 · 绝对路径纪律与停手信号仍在', () => {
  const prompt = buildCliPrompt({ task: { taskId: 'T-1' } }, paths);
  assert.match(prompt, /路径一律写绝对路径/);
  assert.match(prompt, /change-requests|CR-<时间戳>/);
  assert.match(prompt, /blocked\.json/);
  assert.match(prompt, /最后只回复 DONE/);
});

test('CLI-PROMPT-5 · 打回意见与 briefing 原样带上', () => {
  const prompt = buildCliPrompt(
    { briefing: '【你是谁】工程岗', task: { taskId: 'T-1', reviewNote: '上轮没写 deliverables' } },
    paths,
  );
  assert.match(prompt, /【你是谁】工程岗/);
  assert.match(prompt, /上一轮打回意见：上轮没写 deliverables/);
});

test('CLI-PROMPT-6 · 桥接确实改用纯函数，不再自带一份提示词', () => {
  const src = fs.readFileSync(path.resolve('scripts/cli/doubao-cli-bridge.mjs'), 'utf8');
  assert.match(src, /import \{ buildCliPrompt \} from '\.\.\/\.\.\/src\/cli-prompt\.js'/);
  assert.doesNotMatch(src, /String\(ctx\.project\)/);
  assert.doesNotMatch(src, /产物只能写到（绝对路径）/, '旧的「产物只能写 output」口径又回来了');
});
