// GUI 命令必须有上限。
// 真机事故：R-387d746b 20:41 起跑，十条命令一条都没往下走，卡在 in_progress 十几分钟
// 没有任何产物、也没有任何审计 —— 外层 await 永远等下去，只能靠人重启。
// 现在每条命令超过上限就明确报 GuiError('timeout')，Run 才能收账、卡才能进 blocked 并上报。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommandDriver, DEFAULT_COMMAND_TIMEOUT_MS } from '../src/gui-driver.js';

test('G1 · 卡住不返回的命令会按超时失败，而不是永远 await', async () => {
  const driver = createCommandDriver({
    windowTitle: 'x',
    commandTimeoutMs: 500,
    commands: {
      // 一个「永不返回」的命令：60 秒才退，远超我们给它的 0.5 秒上限。
      activate: 'node -e "setTimeout(function(){}, 60000)"',
    },
  });
  const started = Date.now();
  await assert.rejects(
    () => driver.activateWindow('x'),
    (error) => error.kind === 'timeout' && /500ms 没有返回/.test(error.message),
  );
  assert.ok(Date.now() - started < 5000, '必须在超时后立刻返回，不能等到命令自己结束');
});

test('G2 · 正常命令不受影响，仍然拿到输出', async () => {
  const driver = createCommandDriver({
    windowTitle: 'x',
    commandTimeoutMs: 5000,
    commands: { foregroundTitle: 'node -e "process.stdout.write(\'WorkBuddy\')"' },
  });
  assert.equal(await driver.foregroundTitle(), 'WorkBuddy');
  assert.equal(DEFAULT_COMMAND_TIMEOUT_MS, 60000);
});

test('G3 · focusInput 也能拿到 windowTitle，不会留下未填占位', async () => {
  // 2026-11-18 真机：配置写 focusinput -WindowTitle "{{windowTitle}}"，
  // 但 focusInput() 传了空 vars，命令永远渲染不出来 —— 每单卡在粘贴前一步。
  const driver = createCommandDriver({
    windowTitle: 'WorkBuddy',
    commandTimeoutMs: 5000,
    commands: { focusInput: 'node -e "process.stdout.write(process.argv[1])" "{{windowTitle}}"' },
  });
  assert.equal(await driver.focusInput(), 'WorkBuddy');
});
