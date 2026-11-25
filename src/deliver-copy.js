// P7-5 产物落盘：把公司任务目录里的产物复制一份到项目自己的文件夹。
//
// 为什么单独成模块：这一步要写到公司以外的用户资产目录，写坏了代价高，所以把「怎么落」
// 定死成几条硬规矩，引擎只负责调用它、把返回值记进落盘清单：
//   1. 目标一定在 targetDir 之内 —— 保留产物的相对目录结构（2026-11-23 起），
//      但含 '..' / 绝对路径的名字一律拒绝，绝不拼出 targetDir 以外的路径；
//   2. 同名绝不覆盖 —— 撞名先把任务号接在扩展名之前，再撞就接 -2、-3……；
//   3. 单个文件失败不中断整批 —— 原因进 failed，其余照常复制；
//   4. 校验和按源文件内容算 —— 复制前后字节一致，所以也等于目标文件的校验和；
//   5. 同步、零依赖、不打印 —— 调用方同步收账，过程日志由调用方写。
//
// 路径安全由调用方保证（targetDir 一定在项目文件夹内），这里不重复判断；
// 但也绝不自作主张拼出 targetDir 以外的路径：只认 path.join(targetDir, 文件名)。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * 把一批产物复制进目标目录，同名不覆盖，单个失败不拖累整批。
 *
 * @param {object} input
 * @param {Array<{name: string, path: string}>} input.files 产物清单（name 可能带 'output/' 前缀或子目录）
 * @param {string} input.targetDir 目标目录绝对路径（调用方保证在项目文件夹内）
 * @param {string} input.taskId 任务号，形如 'T-1a2b3c4d'，撞名时当后缀用
 * @returns {{copied: Array<{source: string, target: string, bytes: number, sha256: string, renamed: boolean}>,
 *           failed: Array<{source: string, reason: string}>}}
 * @throws {TypeError} 只在 files 不是数组时抛；一切 IO 问题都进返回值里的 failed。
 */
export function copyArtifacts({ files, targetDir, taskId }) {
  if (!Array.isArray(files)) throw new TypeError('copyArtifacts：files 必须是数组');

  const MAX_RENAME_ATTEMPTS = 999;

  const dir = String(targetDir ?? '');
  // 任务号当后缀用；调用方漏传时给个兜底标记，免得拼出 'name-.md' 这种半截名字。
  const tag = String(taskId ?? '').trim() || 'T-untagged';
  const copied = [];
  const failed = [];

  // name 的最后一段：调用方在 Windows 上可能给 'output/ch08.md'，也可能给带反斜杠的分隔符，
  // 两种都认。不用 path.basename 是因为它只认本机分隔符，换平台跑就切不动了。
  const baseNameOf = (name) => {
    const segments = String(name ?? '').split(/[\\/]/).filter((part) => part !== '');
    return segments.length ? segments[segments.length - 1] : '';
  };

  // 2026-11-23：保留产物的**相对目录结构**。旧版只取最后一段文件名，
  // output/分章/ch08.md 会被拍平成 ch08.md，子目录全丢。
  // 现在 output/ 前缀剥掉、其余层级原样保留；含 '..' / 绝对路径的一律拒绝（不许写出 targetDir）。
  const relNameOf = (name) => {
    const raw = String(name ?? '').replace(/\\/g, '/').trim();
    if (!raw) return '';
    if (path.isAbsolute(raw) || /^[a-zA-Z]:\//.test(raw) || raw.startsWith('/')) return null;
    const noPrefix = raw.startsWith('output/') ? raw.slice('output/'.length) : raw;
    const segments = noPrefix.split('/').filter((part) => part !== '');
    if (!segments.length) return '';
    if (segments.some((part) => part === '.' || part === '..')) return null;
    return segments.join('/');
  };

  // 用 path.extname 而不是自己数最后一个点，这样 '.gitignore' 这类点名文件不会被拆成空主干。
  const splitExt = (fileName) => {
    const ext = path.extname(fileName);
    return { stem: ext ? fileName.slice(0, -ext.length) : fileName, ext };
  };

  // 候选目标名按顺序给：先原名；再 -任务号；最后 -任务号-2、-任务号-3……
  // 后缀只加在最后一段文件名上，目录层级不动。
  const candidateTargets = function* candidateTargetsOf(relPath) {
    yield { target: path.join(dir, relPath), renamed: false };
    const parent = path.dirname(relPath);
    const { stem, ext } = splitExt(path.basename(relPath));
    for (let n = 1; n <= MAX_RENAME_ATTEMPTS; n += 1) {
      const suffix = n === 1 ? `-${tag}` : `-${tag}-${n}`;
      const name = `${stem}${suffix}${ext}`;
      yield { target: path.join(dir, parent === '.' ? name : path.join(parent, name)), renamed: true };
    }
  };

  // 失败原因要能直接看懂：带上错误码（ENOENT / EBUSY / EACCES），再带原始说明。
  const describe = (error) => {
    const code = error && error.code ? `${error.code}: ` : '';
    const message = error && error.message ? error.message : String(error);
    return `${code}${message}`;
  };

  // 目标目录都拿不到时，整批一律记失败，不留「部分成功」的假象。
  if (!dir) {
    for (const item of files) failed.push({ source: item && item.path, reason: 'targetDir 为空，无法落盘' });
    return { copied, failed };
  }

  // 目录先建出来（含多层子目录）；建不出来同样整批记失败，不抛给调用方。
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    const reason = `目标目录创建失败：${describe(error)}`;
    for (const item of files) failed.push({ source: item && item.path, reason });
    return { copied, failed };
  }

  for (const item of files) {
    // 入参项不是对象就先挡住：path.join / 读文件都可能当场抛，一抛就破了「整批不中断」。
    if (!item || typeof item !== 'object') {
      failed.push({ source: undefined, reason: '产物项不是对象' });
      continue;
    }
    const source = item.path;
    try {
      // 保留相对目录；name 为空时退回源文件名（单层，同旧版）。
      const hasName = item.name != null && String(item.name).trim() !== '';
      const relPath = hasName ? relNameOf(item.name) : path.basename(String(source ?? ''));
      if (relPath === null) {
        failed.push({ source, reason: `产物路径含 .. 或是绝对路径，拒绝落盘：${String(item.name)}` });
        continue;
      }
      if (!relPath) {
        failed.push({ source, reason: `产物名不合法，拒绝落盘：${String(item.name ?? '(空)')}` });
        continue;
      }

      // 一次读全源文件：既算校验和，又当写入内容 —— 两边字节必然一致，不必复制后再读一遍做对比。
      const buffer = fs.readFileSync(String(source ?? ''));
      const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

      let written = false;
      for (const candidate of candidateTargets(relPath)) {
        try {
          // 子目录按需建出来（保留目录结构的配套动作）。
          fs.mkdirSync(path.dirname(candidate.target), { recursive: true });
          // wx：目标已存在就报 EEXIST，绝不会覆盖别人的文件。
          // 比「先 existsSync 再写」更稳 —— 两者之间有时间差，别人可能正好放进来一个同名文件。
          fs.writeFileSync(candidate.target, buffer, { flag: 'wx' });
        } catch (error) {
          if (error && error.code === 'EEXIST') continue; // 这个名字被占了，换下一个候选
          throw error;
        }
        copied.push({
          source,
          target: candidate.target,
          bytes: buffer.length,
          sha256,
          renamed: candidate.renamed,
        });
        written = true;
        break;
      }
      if (!written) {
        failed.push({ source, reason: `同名文件过多，已试 ${MAX_RENAME_ATTEMPTS} 个候选名仍未写入：${relPath}` });
      }
    } catch (error) {
      failed.push({ source, reason: describe(error) });
    }
  }

  return { copied, failed };
}

// ───────────────────── 自测例子（4 条；跑在 agent 自己的 workspace 里，别落进 output/） ─────────────────────
//
// 例 1 · 正常复制（目标目录已存在，这个名字没撞上）
//   files:     [{ name: 'output/part08-初版.md', path: 'D:\\开源\\AICompany\\work-prod\\tasks\\T-1a2b3c4d\\output/ch08-draft.md' }]
//   targetDir: 'D:/projects/demo-delivery/04-draft'
//   taskId:    'T-1a2b3c4d'
//   返回: copied = [{ source: 原样 path,
//                     target: 'D:/projects/demo-delivery/04-draft/ch08-draft.md',
//                     bytes: 2048, sha256: 64 位小写十六进制, renamed: false }]，failed = []
//
// 例 2 · 重名改名（04-out 里已经有 part08-初版.md）
//   撞一次: 目标 = 04-out\\part08-初版-T-1a2b3c4d.md，renamed = true
//   连撞两次（04-out 里连 part08-初版-T-1a2b3c4d.md 也有了）:
//           目标 = 04-out\\part08-初版-T-1a2b3c4d-2.md，renamed = true
//   同一批里两份同名产物也按这个规矩依次让开：先到的那份保持原名，后到的改名。
//
// 例 3 · 源文件不存在（同一批里另一个文件照常复制，整批不中断）
//   files: [{ name: '交付文本.md', path: 'D:\\...\\tasks\\T-1a2b3c4d\\output\\交付文本.md' },
//           { name: 'output/不存在.md', path: 'D:\\...\\tasks\\T-1a2b3c4d\\output\\不存在.md' }]
//   返回: copied = [{ target: '...\\交付文本.md', renamed: false, ... }]，
//         failed = [{ source: 原样 path, reason: 'ENOENT: no such file or directory, open ...' }]
//
// 例 4 · 目标目录不存在
//   targetDir: 'D:/projects/demo-delivery/04-draft\\2026-11'（目录本身和上级都不存在）
//   返回: 先经 fs.mkdirSync(dir, { recursive: true }) 递归建出目录，再按例 1 落盘；
//         renamed = false，failed = []
