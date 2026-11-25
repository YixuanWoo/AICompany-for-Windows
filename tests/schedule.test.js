import test from 'node:test';
import assert from 'node:assert/strict';

import { buildScheduleJob, planBatch, isScheduledByBoard } from '../src/schedule-request.js';
import { validate } from '../src/validate.js';
import { nextFireAt } from '../src/rrule.js';

const NOW = '2026-11-17T10:00:00.000Z'; // 北京时间 18:00

test('排一条：只跑一轮、忙就等、错过补一次', () => {
  const job = buildScheduleJob({ text: '把第三批文档处理完', at: '02:30', project: 'demo', now: NOW });
  // 一次性由 maxCycles=1 保证（rrule 不支持 COUNT，这是引擎既有能力，不是这里新造的）。
  assert.equal(job.termination.maxCycles, 1);
  assert.equal(job.overlapPolicy, 'queue', '上一轮没完要等，不能齐发');
  assert.equal(job.misfirePolicy, 'run_once', '机器睡着错过，只补一次');
  assert.equal(job.trigger.timezone, 'Asia/Shanghai');
  assert.equal(job.assignee, 'ceo', '默认交给总经理拆活');
  assert.equal(job.project, 'demo');
  assert.ok(validate('recurring', job).ok, '必须过协议校验，否则控制面拒收');
});

test('到点时间的换算：过了今天就是明天，指定日期就钉在那天', () => {
  // 18:00 已经过了 02:30，下一次是明天凌晨。
  const job = buildScheduleJob({ text: '夜间活', at: '02:30', now: NOW });
  assert.equal(nextFireAt(job.trigger.rrule, NOW, job.trigger.timezone), '2026-11-17T18:30:00.000Z');
  // 指定了日期：nextFireAt 直接钉在那一天。
  const pinned = buildScheduleJob({ text: '明晚的活', at: '2026-11-18 02:30', now: NOW });
  assert.equal(pinned.nextFireAt, '2026-11-18T02:30:00+08:00');
  assert.match(pinned.trigger.rrule, /BYHOUR=2;BYMINUTE=30/);
  assert.ok(validate('recurring', pinned).ok);
});

test('批量排班：同一时刻自动错开，顺序保持', () => {
  const planned = planBatch([
    { at: '02:00', text: 'A' },
    { at: '02:00', text: 'B' },
    { at: '02:00', text: 'C' },
    { at: '03:00', text: 'D' },
  ], { gapMin: 10 });
  assert.deepEqual(planned.map((x) => x.at), ['2:00', '2:10', '2:20', '3:00']);
  assert.deepEqual(planned.map((x) => x.text), ['A', 'B', 'C', 'D'], '错开不能打乱顺序');
  // 跨小时要进位
  const roll = planBatch([{ at: '23:50', text: 'X' }, { at: '23:50', text: 'Y' }], { gapMin: 10 });
  assert.deepEqual(roll.map((x) => x.at), ['23:50', '0:00']);
});

test('空需求直接拒绝，不排一条空卡', () => {
  assert.throws(() => buildScheduleJob({ text: '  ', at: '02:30', now: NOW }), /需求是空的/);
  assert.throws(() => buildScheduleJob({ text: 'x', at: '25:00', now: NOW }), /时间不合法/);
  assert.throws(() => buildScheduleJob({ text: 'x', at: '明早', now: NOW }), /看不懂的时间/);
});
