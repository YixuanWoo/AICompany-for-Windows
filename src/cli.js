// P0 命令行入口：npm run schemas / npm run doctor / node src/cli.js validate <kind> <file>

import fs from 'node:fs';
import { loadConfig, EXAMPLE_CONFIG_PATH, ConfigError } from './config.js';
import { validate, listSchemas } from './validate.js';
import { ADAPTER_TYPES } from './enums.js';

const [, , command, ...args] = process.argv;

function usage() {
  console.log([
    'AICompany P0 · 协议冻结',
    '',
    '  npm run schemas                          列出 8 份协议 schema',
    '  npm run doctor                           校验示例配置并逐项体检',
    '  node src/cli.js doctor <config.yaml>     校验指定配置',
    '  node src/cli.js validate <kind> <file>  校验一份单据 JSON',
    '',
    `可用单据类型：${listSchemas().map((s) => s.kind).join(', ')}, config`,
    `已注册 adapter 类型：${ADAPTER_TYPES.join(', ')}`,
  ].join('\n'));
}

switch (command) {
  case 'schemas': {
    for (const item of listSchemas()) {
      console.log(`${item.kind.padEnd(16)} ${item.id.padEnd(32)} ${item.file}`);
    }
    console.log(`\n共 ${listSchemas().length} 份；配置 schema：config/company.schema.json`);
    break;
  }
  case 'doctor': {
    const configPath = args[0] || EXAMPLE_CONFIG_PATH;
    try {
      const { config, doctor, source } = loadConfig(configPath, process.env);
      console.log(`配置：${source}`);
      console.log(`席位：${config.agents.map((a) => a.id).join(', ')}`);
      console.log(`默认模式：${config.interaction.defaultMode}（目标 ${config.interaction.defaultTarget}）`);
      console.log(`autoAssign：${config.interaction.autoAssign}`);
      for (const check of doctor.checks) {
        console.log(`${check.ok ? '[OK]  ' : '[FAIL]'} ${check.name} — ${check.detail}`);
      }
      console.log(doctor.ok ? '\n体检通过。' : '\n体检未通过。');
      if (!doctor.ok) process.exitCode = 1;
    } catch (error) {
      if (error instanceof ConfigError) {
        console.error(`[${error.code}] ${error.message}`);
        if (error.code === 'ENV_MISSING') {
          console.error('提示：先设置环境变量，例如 AICOMPANY_CEO_CMD=echo AICOMPANY_WORKER_CMD=echo npm run doctor');
        }
      } else {
        console.error(String(error.stack || error));
      }
      process.exitCode = 1;
    }
    break;
  }
  case 'validate': {
    const [kind, file] = args;
    if (!kind || !file) {
      console.error('用法：node src/cli.js validate <kind> <file>');
      process.exitCode = 1;
      break;
    }
    let data;
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      console.error(`读不到或不是合法 JSON：${file}（${error.message}）`);
      process.exitCode = 1;
      break;
    }
    const result = validate(kind, data);
    console.log(result.ok ? `[OK] ${kind} 校验通过（${result.meta.schemaId}）` : `[FAIL] ${kind} 校验失败：`);
    for (const error of result.errors) console.log(`  - ${error}`);
    if (!result.ok) process.exitCode = 1;
    break;
  }
  default:
    usage();
    break;
}
