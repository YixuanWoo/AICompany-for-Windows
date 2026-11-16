import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EXAMPLE_CONFIG_PATH, loadConfig, ConfigError, applyConfigRules } from '../src/config.js';
import { parseYaml } from '../src/yaml-lite.js';
import { validate } from '../src/validate.js';
import { ADAPTER_TYPES } from '../src/enums.js';

const ENV = {
  AICOMPANY_CEO_CMD: 'echo ceo',
  AICOMPANY_WORKER_CMD: 'echo worker',
  AICOMPANY_WORK_DIR: 'work',
};

test('P0-2 · 2 席位最小配置能加载、插值、通过汇报线校验', () => {
  const { config, doctor } = loadConfig(EXAMPLE_CONFIG_PATH, ENV);
  assert.equal(config.agents.length, 2);
  assert.equal(config.agents.find((a) => a.isCEO).id, 'ceo');
  assert.equal(config.interaction.defaultMode, 'delegate');
  assert.equal(config.interaction.defaultTarget, 'ceo');
  assert.equal(config.interaction.autoAssign, false);
  assert.equal(config.interaction.meeting.fullRequiresConfirm, true);
  assert.equal(config.interaction.thread.ttlDays, 30);
  assert.deepEqual(config.clients, ['web']);
  assert.deepEqual(config.notifier, ['noop']);
  assert.equal(doctor.ok, true, JSON.stringify(doctor.checks));
  assert.equal(validate('config', config).ok, true, validate('config', config).errors.join('; '));
});

test('P0-2 · ${ENV} 插值生效，且配置里不残留占位符', () => {
  const { config } = loadConfig(EXAMPLE_CONFIG_PATH, ENV);
  const command = config.agents[0].adapter.config.command;
  assert.equal(command, 'echo ceo');
  assert.ok(!JSON.stringify(config).includes('${'));
});

test('P0-2 · 缺必需环境变量：启动失败，且不创建任何文件', () => {
  const sentinel = path.join(os.tmpdir(), `aicompany-should-not-exist-${process.pid}.json`);
  assert.equal(fs.existsSync(sentinel), false);
  assert.throws(
    () => loadConfig(EXAMPLE_CONFIG_PATH, {}),
    (error) => error instanceof ConfigError && error.code === 'ENV_MISSING',
  );
  assert.equal(fs.existsSync(sentinel), false);
});

test('P0-3 · adapter type 拼错：拒绝启动，并列出全部可用类型（不静默降级）', () => {
  const { config } = loadConfig(EXAMPLE_CONFIG_PATH, ENV);
  const broken = { ...config, agents: [{ ...config.agents[0], adapter: { type: 'proces' } }, config.agents[1]] };
  const result = validate('config', broken);
  assert.equal(result.ok, false);
  const message = result.errors.join('\n');
  assert.ok(message.includes('拒绝启动'));
  for (const type of ADAPTER_TYPES) assert.ok(message.includes(type), `错误信息应列出 ${type}`);
});

test('P0-2 · 汇报线成环被拒；默认目标不得写死', () => {
  const { config } = loadConfig(EXAMPLE_CONFIG_PATH, ENV);
  const cyclic = { ...config, agents: [
    { ...config.agents[0], reportsTo: 'worker-01' },
    { ...config.agents[1], reportsTo: 'ceo' },
  ] };
  assert.ok(applyConfigRules(cyclic).some((e) => e.includes('成环')));
  const hardcoded = { ...config, interaction: { ...config.interaction, defaultTarget: 'some-other-seat' } };
  assert.ok(applyConfigRules(hardcoded).some((e) => e.includes('不得写死')));
});

test('P0-2 · 示例配置零产品名（引擎不与任何具体产品绑定）', () => {
  const { config } = loadConfig(EXAMPLE_CONFIG_PATH, ENV);
  const text = JSON.stringify(config).toLowerCase();
  for (const name of ['dsh', 'doubao', 'workbuddy', 'hermes', 'feishu', 'larksuite']) {
    assert.ok(!text.includes(name), `示例配置不该出现 ${name}`);
  }
});

test('P0-2 · 受限 YAML 解析器覆盖嵌套 / 列表 / 行内数组 / null / 注释', () => {
  const parsed = parseYaml([
    'version: 1',
    'company:',
    '  name: demo  # 行尾注释',
    'agents:',
    '  - id: ceo',
    '    isCEO: true',
    '    capabilities: [plan, review]',
    '    reportsTo: null',
    '    adapter:',
    '      type: process',
    'clients: [web]',
  ].join('\n'));
  assert.equal(parsed.version, 1);
  assert.equal(parsed.company.name, 'demo');
  assert.equal(parsed.agents.length, 1);
  assert.equal(parsed.agents[0].id, 'ceo');
  assert.equal(parsed.agents[0].isCEO, true);
  assert.deepEqual(parsed.agents[0].capabilities, ['plan', 'review']);
  assert.equal(parsed.agents[0].reportsTo, null);
  assert.equal(parsed.agents[0].adapter.type, 'process');
  assert.deepEqual(parsed.clients, ['web']);
});

test('配置：两个岗位可以由同一个 agent 担任，各自用自己的 adapterConfig 参数', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aicompany-seats-'));
  const file = path.join(dir, 'seats.yaml');
  fs.writeFileSync(file, [
    'version: 1',
    `workRoot: ${dir.replaceAll(String.fromCharCode(92), '/')}`,
    'holders:',
    '  - id: multi-agent',
    '    name: 全能 agent',
    '    kind: external-agent',
    '    adapter:',
    '      type: process',
    '      config:',
    '        command: node -e "process.exit(0)"',
    'posts:',
    '  - id: ceo',
    '    title: 总经理',
    '    heldBy: multi-agent',
    '    isCEO: true',
    '    capabilities: [plan, review]',
    '  - id: worker',
    '    title: 执行',
    '    heldBy: multi-agent',
    '    adapterConfig:',
    '      timeoutMs: 1234',
    '    isCEO: false',
    '    capabilities: [execute]',
    '    reportsTo: ceo',
    'clients: [web]',
    'notifier: [noop]',
  ].join('\n'), 'utf8');
  const { config } = loadConfig(file, {}, { overridesPath: null });
  try {
    assert.equal(config.agents.length, 2, '两个岗位各算一个席位');
    assert.deepEqual(config.agents.map((a) => a.postTitle), ['总经理', '执行']);
    // 岗位名称是岗位，担任者是同一个 agent 的名字。
    assert.deepEqual(config.agents.map((a) => a.holderName), ['全能 agent', '全能 agent']);
    assert.deepEqual(config.agents.map((a) => a.holderId), ['multi-agent', 'multi-agent']);
    // 调用的还是同一个 agent：adapter 类型与命令完全一样。
    assert.equal(config.agents[0].adapter.type, 'process');
    assert.equal(config.agents[1].adapter.type, config.agents[0].adapter.type);
    assert.equal(config.agents[1].adapter.config.command, config.agents[0].adapter.config.command);
    // 岗位级覆盖只作用于自己那一席，不污染同 agent 的另一个岗位。
    assert.equal(config.agents[1].adapter.config.timeoutMs, 1234);
    assert.equal(config.agents[0].adapter.config.timeoutMs, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
