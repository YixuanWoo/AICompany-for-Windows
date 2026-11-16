// 桌面气泡通道：看板关掉时也能收到「待你拍板」。
// 这里只验证「注册了 / 能共存 / 日常进展不打扰」，不真的弹窗（弹窗由真机验一次）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { channelNames, createChannels } from '../src/channels.js';

test('N1 · desktop 通道已注册，能和 web 共存', () => {
  assert.ok(channelNames().includes('desktop'));
  const n = createChannels(['web', 'desktop']);
  assert.deepEqual(n.channels, ['web', 'desktop']);
  assert.equal(n.kind, 'web+desktop');
});

test('N2 · 日常进展不打扰：不在白名单的消息直接忽略', () => {
  const n = createChannels(['desktop']);
  assert.doesNotThrow(() => n.send({ title: '进展', body: '干到一半', scene: 'progress' }));
  assert.equal(n.messages.length, 1, '消息仍要存进 inbox，只是不弹窗');
});

test('N3 · 非 Windows 平台静默跳过，不抛异常', () => {
  const n = createChannels(['desktop']);
  assert.doesNotThrow(() => n.requestApproval({ title: '测试', approvalId: 'AP-x' }));
});
