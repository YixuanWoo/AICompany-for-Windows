// 轻量 JSON Schema（draft-07 常用子集）校验器，零依赖。
// 支持：type / enum / const / required / properties / additionalProperties /
//       items / minLength / minItems / minimum / maximum / pattern / oneOf / anyOf / allOf / not
// 语义级规则（条件必填、清理红线等）不放在 schema 里，交给 src/validate.js 的业务规则层。

import { isPlainObject } from './enums.js';

function typeMatches(value, expected) {
  switch (expected) {
    case 'null': return value === null;
    case 'object': return isPlainObject(value);
    case 'array': return Array.isArray(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'string': return typeof value === 'string';
    case 'boolean': return typeof value === 'boolean';
    default: return true;
  }
}

function check(schema, data, path, errors) {
  if (schema === true) return;
  if (schema === false) {
    errors.push({ path, message: '此处不允许出现任何值' });
    return;
  }
  if (!isPlainObject(schema)) return;

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(data, t))) {
      errors.push({ path, message: `类型应为 ${types.join(' | ')}，实际为 ${data === null ? 'null' : typeof data}` });
      return;
    }
  }

  if (schema.const !== undefined && data !== schema.const) {
    errors.push({ path, message: `必须等于 ${JSON.stringify(schema.const)}` });
  }
  if (schema.enum !== undefined && !schema.enum.includes(data)) {
    errors.push({ path, message: `必须是 [${schema.enum.join(', ')}] 之一，收到 ${JSON.stringify(data)}` });
  }

  if (typeof data === 'string') {
    if (schema.minLength !== undefined && data.length < schema.minLength) {
      errors.push({ path, message: `长度不得小于 ${schema.minLength}` });
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(data)) {
      errors.push({ path, message: `不符合格式 ${schema.pattern}` });
    }
  }
  if (typeof data === 'number') {
    if (schema.minimum !== undefined && data < schema.minimum) errors.push({ path, message: `不得小于 ${schema.minimum}` });
    if (schema.maximum !== undefined && data > schema.maximum) errors.push({ path, message: `不得大于 ${schema.maximum}` });
  }
  if (Array.isArray(data)) {
    if (schema.minItems !== undefined && data.length < schema.minItems) {
      errors.push({ path, message: `至少 ${schema.minItems} 项` });
    }
    if (schema.items) data.forEach((item, i) => check(schema.items, item, `${path}[${i}]`, errors));
  }

  if (isPlainObject(data)) {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!Object.prototype.hasOwnProperty.call(data, key)) {
          errors.push({ path: `${path}.${key}`, message: '缺少必填字段' });
        }
      }
    }
    if (isPlainObject(schema.properties)) {
      for (const [key, sub] of Object.entries(schema.properties)) {
        if (Object.prototype.hasOwnProperty.call(data, key)) {
          check(sub, data[key], `${path}.${key}`, errors);
        }
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(data)) {
          if (!Object.prototype.hasOwnProperty.call(schema.properties, key)) {
            errors.push({ path: `${path}.${key}`, message: '不允许的多余字段' });
          }
        }
      }
    }
  }

  if (Array.isArray(schema.allOf)) schema.allOf.forEach((s) => check(s, data, path, errors));
  if (Array.isArray(schema.anyOf)) {
    const passing = schema.anyOf.some((s) => {
      const local = [];
      check(s, data, path, local);
      return local.length === 0;
    });
    if (!passing) errors.push({ path, message: '不满足 anyOf 中任一分支' });
  }
  if (Array.isArray(schema.oneOf)) {
    const passing = schema.oneOf.filter((s) => {
      const local = [];
      check(s, data, path, local);
      return local.length === 0;
    }).length;
    if (passing !== 1) errors.push({ path, message: `oneOf 应恰好命中 1 个分支，实际命中 ${passing} 个` });
  }
  if (schema.not !== undefined) {
    const local = [];
    check(schema.not, data, path, local);
    if (local.length === 0) errors.push({ path, message: '命中了 not 禁止的分支' });
  }
}

export function validateAgainstSchema(schema, data) {
  const errors = [];
  check(schema, data, '$', errors);
  return { ok: errors.length === 0, errors };
}

export function formatErrors(errors) {
  return errors.map((e) => `${e.path}: ${e.message}`).join('\n');
}
