// 看板证据徽标回归（2026-11-18 董事会要求）：
// 任务卡上必须能直接看出「未派单 / 未见回执 / 已启动 / 已收到 / 有进度 / 已交活 / 已中断」，
// 数据只来自 /api/runs 已有字段，不新增接口、不改派活逻辑。
// 2026-11-24 修正：L1 从「已送达」改名为「已启动」—— dispatch.json 只证明进程起来了，
// 不等于 agent 收到任务/开工（真机 T-5457e8a0 显示「已送达」但 10 分钟零产出）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const board = fs.readFileSync(path.resolve('src/web/board.html'), 'utf8');

test('B-EV-1 · 任务卡渲染函数接上了证据徽标', () => {
  assert.match(board, /function evidenceChip\(task\)/);
  assert.match(board, /evidenceChip\(t\)/, 'renderTasks 必须真的调用它，不能只定义');
  assert.match(board, /function evidenceRunFor\(taskId\)/);
});

test('B-EV-2 · 七种证据状态都有明确措辞，且不再用「已送达」冒充开工', () => {
  for (const label of ['未派单', '未见回执', '已启动', '已收到', '有进度', '已交活', '已中断']) {
    assert.ok(board.includes(label), `看板缺状态措辞：${label}`);
  }
  assert.ok(!board.includes('已送达'), 'L1 不能再叫「已送达」：dispatch 只证明进程起来');
  // 超过 5 分钟仍无产出痕迹必须标黄提示「未开工」，而不是继续显示等产出
  assert.match(board, /未开工/);
});

test('B-EV-3 · 徽标颜色只承担四种含义，且不抢状态 pill', () => {
  for (const cls of ['.ev-ok', '.ev-work', '.ev-warn', '.ev-bad']) {
    assert.ok(board.includes(cls), `缺样式：${cls}`);
  }
  // 证据徽标是状态列里的第二行，不能另起一列破坏现有表格契约。
  assert.match(board, /<th>状态<\/th>/, '任务表列结构保持原样');
});
