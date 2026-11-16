import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtures } from '../protocol/examples.js';
import { validate, listSchemas, SCHEMA_FILES } from '../src/validate.js';
import { SCHEMA_KINDS, SCHEMA_IDS } from '../src/enums.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('P0-1 · 恰好冻结 8 份协议 schema，无第 9 份', () => {
  assert.equal(SCHEMA_KINDS.length, 8);
  assert.equal(Object.keys(SCHEMA_FILES).length, 8);
  assert.deepEqual(Object.keys(fixtures).sort(), [...SCHEMA_KINDS].sort());
  assert.equal(listSchemas().length, 8);
});

test('P0-1 · 每份 schema 都是合法 JSON，$id 与登记一致', () => {
  for (const item of listSchemas()) {
    const file = path.join(ROOT, item.file);
    assert.ok(fs.existsSync(file), `缺文件 ${item.file}`);
    const schema = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(schema.$id, item.id);
    assert.equal(schema.$id, SCHEMA_IDS[item.kind]);
    assert.equal(schema.type, 'object');
    assert.ok(Array.isArray(schema.required) && schema.required.length > 0);
  }
});

for (const kind of SCHEMA_KINDS) {
  test(`P0-4 · ${kind}：3 个正例全部通过`, () => {
    assert.equal(fixtures[kind].valid.length, 3);
    fixtures[kind].valid.forEach((data, index) => {
      const result = validate(kind, data);
      assert.equal(result.ok, true, `正例 ${index + 1} 未通过：${result.errors.join('; ')}`);
      assert.equal(result.meta.schemaId, SCHEMA_IDS[kind]);
    });
  });

  test(`P0-4 · ${kind}：3 个反例全部被拒`, () => {
    assert.equal(fixtures[kind].invalid.length, 3);
    fixtures[kind].invalid.forEach(({ data, reason }, index) => {
      const result = validate(kind, data);
      assert.equal(result.ok, false, `反例 ${index + 1}（${reason}）竟然通过`);
      assert.ok(result.errors.length > 0, `反例 ${index + 1} 没有给出错误原因`);
    });
  });
}
