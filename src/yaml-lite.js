// 受限 YAML 解析器：只支持 company.yaml 用到的语法（2 空格缩进、映射、
// 「- key: value」列表、行内数组 [a, b]、标量、行尾注释、${ENV} 占位）。
// 不追求完整 YAML 规范；P1 引入 js-yaml 后可整体替换本文件。

function stripComment(line) {
  const idx = line.indexOf('#');
  if (idx === -1) return line;
  if (idx === 0 || /\s/.test(line[idx - 1])) return line.slice(0, idx);
  return line;
}

function leadingSpaces(line) {
  return line.length - line.replace(/^ +/, '').length;
}

function parseScalar(text) {
  const value = text.trim();
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    return inner === '' ? [] : inner.split(',').map((item) => parseScalar(item));
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~' || value === '') return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function splitKeyValue(content, lineNo) {
  const match = content.match(/^([^:]+):\s*(.*)$/);
  if (!match) throw new Error(`YAML 第 ${lineNo} 行无法解析：${content}`);
  return { key: match[1].trim(), value: match[2].trim() };
}

function parseMap(lines, start, indent) {
  const out = {};
  let i = start;
  while (i < lines.length && lines[i].indent === indent && !lines[i].content.startsWith('- ')) {
    const { key, value } = splitKeyValue(lines[i].content, lines[i].lineNo);
    if (value === '') {
      i += 1;
      if (i < lines.length && lines[i].indent > indent) {
        const [child, next] = parseBlock(lines, i, lines[i].indent);
        out[key] = child;
        i = next;
      } else {
        out[key] = null;
      }
    } else {
      out[key] = parseScalar(value);
      i += 1;
    }
  }
  return [out, i];
}

function parseList(lines, start, indent) {
  const out = [];
  let i = start;
  while (i < lines.length && lines[i].indent === indent && lines[i].content.startsWith('- ')) {
    const rest = lines[i].content.slice(2).trim();
    const block = [{ indent: indent + 2, content: rest, lineNo: lines[i].lineNo }];
    i += 1;
    while (i < lines.length && lines[i].indent > indent) {
      block.push(lines[i]);
      i += 1;
    }
    const [item] = parseMap(block, 0, indent + 2);
    out.push(item);
  }
  return [out, i];
}

function parseBlock(lines, start, indent) {
  if (lines[start].content.startsWith('- ')) return parseList(lines, start, indent);
  return parseMap(lines, start, indent);
}

export function parseYaml(text) {
  const lines = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const cleaned = stripComment(raw);
    const content = cleaned.trim();
    if (content === '') return;
    lines.push({ indent: leadingSpaces(cleaned), content, lineNo: index + 1 });
  });
  if (lines.length === 0) return {};
  const [value] = parseBlock(lines, 0, lines[0].indent);
  return value;
}
