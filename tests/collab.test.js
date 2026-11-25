// 三人协作：仓库台账 / 产物分类 / 交付路由 / 代码审查 / 子派活。
// 全部用 mock 席位与临时目录，不联网、不碰真仓库。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../src/core.js';
import { createEngine, createNotifier } from '../src/engine.js';
import { normalizeRepos, assertRepo, findRepoForPath } from '../src/repos.js';
import { seatBriefing, orgTreeLines, delegationBriefing, taskIntakeBriefing, seatPreamble } from '../src/org-chart.js';
import { buildTaskPaths, sha256File } from '../src/gui-report.js';

function tmpRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aicompany-collab-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// 三个岗位：总经理（mock 拆卡）/ 执行（mock 交活）/ 工程（pull，测试里直接调方法）。
function company(root, { report = {}, tasks = null } = {}) {
  return {
    version: 1,
    company: { name: 'collab', timezone: 'Asia/Shanghai' },
    workRoot: root,
    interaction: { defaultMode: 'delegate', defaultTarget: 'ceo', autoAssign: false },
    repos: normalizeRepos({
      demo: { path: root, remote: null, reviewer: 'engineering', allowPush: false },
    }),
    artifacts: {
      defaultReviewer: 'engineering',
      defaultHandoff: 'ceo',
      requireRepoForManagedCode: true,
      codeExtensions: ['.js', '.py', '.md'],
    },
    agents: [
      {
        id: 'ceo', postTitle: '总经理', isCEO: true,
        capabilities: ['plan', 'delegate', 'review'], status: 'active',
        quotaDaily: 99, reportsTo: null,
        adapter: {
          type: 'mock',
          config: {
            result: (ctx) => (ctx.wakeReason === 'review_requested'
              ? { type: 'review', verdict: 'pass', reason: '通过' }
              : {
                type: 'task-create', summary: '派一张',
                tasks: tasks ?? [{ title: '干活', assignee: 'doubao' }],
              }),
          },
        },
      },
      {
        id: 'doubao', postTitle: '执行', isCEO: false,
        capabilities: ['execute'], status: 'active', quotaDaily: 99, reportsTo: 'engineering',
        duties: '写文档、改稿', boundaries: ['不改代码仓库'],
        adapter: {
          type: 'mock',
          config: {
            result: (ctx) => {
              const paths = buildTaskPaths(root, ctx.task.taskId);
              fs.mkdirSync(paths.outputDir, { recursive: true });
              const file = path.join(paths.outputDir, 'note.md');
              fs.writeFileSync(file, `done:${ctx.task.title}`, 'utf8');
              return {
                schema: 'aicompany.completion/v1',
                taskId: ctx.task.taskId, runId: ctx.runId, agent: 'doubao',
                revision: ctx.task.revision, status: 'success',
                summary: `完成：${ctx.task.title}`,
                artifacts: ['output/note.md'],
                checksum: { 'output/note.md': sha256File(file) },
                acceptanceResults: [{ rule: '产物非空', pass: true }],
                usage: { quotaUnits: 1 },
                ...report,
                finishedAt: new Date().toISOString(),
              };
            },
          },
        },
      },
      {
        id: 'engineering', postTitle: '工程执行', isCEO: false,
        capabilities: ['execute', 'review', 'delegate', 'plan'], status: 'active',
        quotaDaily: 99, reportsTo: 'ceo', escalationTo: 'ceo', dispatch: 'pull',
        duties: '写代码、审代码、提交推送',
        adapter: { type: 'mock', config: { result: { type: 'review', verdict: 'pass' } } },
      },
    ],
    clients: ['web'], notifier: ['noop'],
  };
}

function setup(t, opts = {}) {
  const root = tmpRoot(t);
  const db = openDb(':memory:');
  const cfg = company(root, opts);
  const engine = createEngine({ db, config: cfg, notifier: createNotifier('noop') });
  t.after(() => db.close());
  return { root, db, engine, cfg };
}

const pumpAll = async (engine) => { for (let i = 0; i < 8; i += 1) await engine.pump(); };
const childOf = (db) => db.prepare('SELECT * FROM tasks WHERE parentTaskId IS NOT NULL ORDER BY rowid').get();

test('R1 · 仓库台账：不写 path 直接拒，未知仓库拒，路径归属取最长前缀', () => {
  assert.throws(() => normalizeRepos({ x: { remote: 'a/b' } }), /缺 path/);
  assert.throws(() => normalizeRepos({ X: { path: 'D:/x' } }), /只允许小写/);
  assert.throws(() => normalizeRepos({ x: { path: 'D:/x', remote: 'not a remote !!' } }), /remote/);

  const config = {
    repos: normalizeRepos({
      outer: { path: 'D:/code' },
      inner: { path: 'D:/code/inner' },
    }),
  };
  assert.throws(() => assertRepo({ config, requested: 'nope' }), /未登记的仓库/);
  assert.equal(findRepoForPath(config, 'D:/code/a.js').id, 'outer');
  assert.equal(findRepoForPath(config, 'D:/code/inner/a.js').id, 'inner');
  assert.equal(findRepoForPath(config, 'D:/other/a.js'), null);
});

test('R2 · 组织图与席位身份：豆包的上级是工程，工程的上级是总经理', (t) => {
  const { cfg } = setup(t);
  const tree = orgTreeLines(cfg).join('\n');
  assert.match(tree, /总经理（ceo/);
  assert.match(tree, /工程执行（engineering/);
  const doubao = seatBriefing(cfg, 'doubao');
  assert.match(doubao, /上级：工程执行（engineering）/);
  assert.match(doubao, /必须上报/);
  assert.match(doubao, /managed-code/);
  const eng = seatBriefing(cfg, 'engineering');
  assert.match(eng, /下级：执行（doubao）/);
  assert.match(eng, /永不 force push|force push/);
});

test('R2b · 管理岗的提示词必须给出「怎么派」的手段，执行岗不该有', (t) => {
  const { cfg } = setup(t);
  const eng = delegationBriefing(cfg, 'engineering', { workRoot: '/tmp/company' });
  // 只写「你是管理岗、别自己干」不够：没有派活手段，它只能自己干（2026-11-17 真机）。
  assert.match(eng, /你的活主要是「派」，不是「做」/);
  assert.match(eng, /技术负责人（CTO）/);
  assert.match(eng, /--assignee/);
  assert.match(eng, /\/api\/bridge\/spawn/);
  assert.match(eng, /doubao/);
  assert.match(eng, /派给自己等于换个名字继续自己干/);
  // 边界要「默认派 + 小改例外」，不能钉成零自做（董事会 2026-11-17 明确要求允许弹性）。
  assert.match(eng, /单点小改/);
  assert.match(eng, /留痕/);
  assert.match(eng, /≤1 个文件、≤40 行/);
  // 执行岗没有 delegate 能力：不该塞派活说明，免得它也去拆卡。
  assert.equal(delegationBriefing(cfg, 'doubao'), '');
});

test('R2d · 每个席位开工前都有「第 0 步：先判断，再安排」', (t) => {
  const { cfg } = setup(t);
  // 「指令是命令句」不等于「必须照抄」：这一层以前全公司只有 CEO 有，而且判的是「要不要派卡」。
  const eng = taskIntakeBriefing(cfg, 'engineering', { task: { difficulty: 'hard' } });
  assert.match(eng, /第 0 步：先判断，再安排/);
  assert.match(eng, /结果」还是「做法/);
  assert.match(eng, /先判它对不对/);
  assert.match(eng, /这事多大/);
  assert.match(eng, /你做，还是派下去/);
  // 大小尺子必须带数值，且明确「判不准按大处理」。
  assert.match(eng, /≤1 个文件、≤40 行/);
  assert.match(eng, /判不准就按「大」处理/);
  // 小活可以自己做，但留痕（不是请示）。
  assert.match(eng, /你自己做/);
  assert.match(eng, /留痕，不是请示/);
  // 派活要列得出下级；顶回去有正当通道，别拿 failed 当意见。
  assert.match(eng, /派给下级/);
  assert.match(eng, /change-requests\//);
  assert.match(eng, /handoff=escalate/);
  // 执行岗没有下级：给它的是「先出方案报上级」，不是「派下去」。
  const doubao = taskIntakeBriefing(cfg, 'doubao');
  assert.match(doubao, /没有可派的下级/);
  assert.doesNotMatch(doubao, /派给下级/);
});

test('R2e · 统一入口：非 CEO 拿到「身份 + 第0步 + 派活」，CEO 只拿派活路由', (t) => {
  const { cfg } = setup(t);
  const eng = seatPreamble(cfg, 'engineering', { workRoot: '/tmp/company' });
  assert.match(eng, /【你是谁】/);
  assert.match(eng, /第 0 步：先判断，再安排/);
  assert.match(eng, /--assignee/);
  // 顺序必须是「身份 → 判断 → 派活」：先判断让位于身份是无意义的。
  assert.ok(eng.indexOf('【你是谁】') < eng.indexOf('第 0 步'));
  assert.ok(eng.indexOf('第 0 步') < eng.indexOf('--assignee'));
  const doubao = seatPreamble(cfg, 'doubao');
  assert.match(doubao, /第 0 步：先判断，再安排/);
  assert.equal(delegationBriefing(cfg, 'doubao'), '', '执行岗仍不该有派活段');
  // CEO 的前置是「派活路由 + 组织树」，不是「你怎么判断要不要自己干」。
  const ceo = seatPreamble(cfg, 'ceo');
  assert.match(ceo, /【公司长什么样（组织树：谁归谁管）】/);
  assert.doesNotMatch(ceo, /第 0 步：先判断，再安排/);
});

test('R2c · 管理岗不能把子卡派给自己（自派 = 换个名字继续自己干）', async (t) => {
  const { db, engine } = setup(t);
  const parent = await engine.submit({ text: '加个功能', mode: 'direct', addressedTo: 'engineering' });
  assert.throws(() => engine.spawnChild({
    parentTaskId: parent.taskId, assignerId: 'engineering', assignee: 'engineering',
    title: '自己复核一遍', instructions: '逐条复核', acceptance: ['复核完成'],
  }), /不能把子卡派给自己/);
  const hit = db.prepare("SELECT * FROM audit WHERE action = 'spawn_self_rejected'").get();
  assert.ok(hit, '自派被拒必须留痕，否则看不出它想自己干');
});

test('R3 · 判成受管代码却没写 repo：打回两次后进 blocked，审计留痕', async (t) => {
  const { db, engine } = setup(t, { report: { artifactKind: 'managed-code', handoff: 'review' } });
  await engine.submit({ text: '写个脚本' });
  await pumpAll(engine);
  const card = childOf(db);
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(card.taskId).status, 'blocked');
  const hit = db.prepare("SELECT * FROM audit WHERE action = 'code_repo_missing' AND taskId = ?").get(card.taskId);
  const seen = db.prepare('SELECT action FROM audit').all().map((a) => a.action).join(',');
  assert.ok(hit, `必须留下「代码没登记仓库」的审计，否则查无可查；实际审计：${seen}`);
});

test('R4 · 受管代码 + 仓库 + 工程审：审过停在「待归口」，仓库主人回执后才 done', async (t) => {
  const { db, engine } = setup(t, {
    tasks: [{ title: '改引擎', assignee: 'doubao', repo: 'demo' }],
    report: { artifactKind: 'managed-code' },
  });
  await engine.submit({ text: '改引擎' });
  await pumpAll(engine);
  const card = childOf(db);
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(card.taskId).status, 'in_review');
  assert.ok(db.prepare("SELECT 1 FROM audit WHERE action = 'review_queued' AND taskId = ?").get(card.taskId),
    '审查人不是总经理时要排队等它来审，不能直调拉模式席位');

  const pending = engine.pendingReviews('engineering');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].taskId, card.taskId);

  const verdict = engine.reviewTask(card.taskId, { reviewer: 'engineering', verdict: 'pass', reason: '看过，没问题' });
  assert.equal(verdict.pendingAssetAck, true, '代码卡验收通过后还要等仓库主人回执');
  const after = db.prepare('SELECT * FROM tasks WHERE taskId = ?').get(card.taskId);
  assert.equal(after.status, 'in_review');
  assert.equal(after.assetAck, 'pending');
  assert.equal(after.assetOwner, 'engineering');
  assert.ok(after.assetAckTaskId, '要派生归口核对卡');
  assert.ok(db.prepare("SELECT 1 FROM audit WHERE action = 'asset_ack_required' AND taskId = ?").get(card.taskId));
});

test('R5 · 一次性脚本（scratch-code）+ 发布者授权：走直接落盘，不建审查、不叫 CEO', async (t) => {
  const { db, engine } = setup(t, {
    report: { artifactKind: 'scratch-code', handoff: 'land' },
    // 发布者（CEO）在卡上授权：这类一次性脚本干完就归档，不用回来审。
    tasks: [{ title: '渲染一段视频', assignee: 'doubao', allowSelfLand: true }],
  });
  await engine.submit({ text: '渲染一段视频' });
  await pumpAll(engine);
  const card = childOf(db);
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(card.taskId).status, 'done');
  assert.ok(db.prepare("SELECT 1 FROM audit WHERE action = 'handoff_land' AND taskId = ?").get(card.taskId));
  const ceoRuns = db.prepare("SELECT COUNT(*) AS n FROM runs WHERE agentId = 'ceo' AND wakeReason = 'review_requested'").get().n;
  assert.equal(ceoRuns, 0, '落盘结案不该再烧一次 CEO 的额度');
});

test('R5b · 上级派活：执行者自报 land 一律被拦，改交上级审并留痕', async (t) => {
  const { db, engine } = setup(t, {
    report: { artifactKind: 'scratch-code', handoff: 'land' },
  });
  await engine.submit({ text: '渲染一段视频' });
  await pumpAll(engine);
  const card = childOf(db);
  // 谁发布谁审：CEO 派的活，豆包无权替 CEO 免审 —— 自报的 land 被拦，改走 CEO 验收。
  const hit = db.prepare("SELECT * FROM audit WHERE action = 'handoff_downgraded' AND taskId = ?").get(card.taskId);
  assert.ok(hit, '拦下私自落盘必须留痕，董事会要看得见');
  assert.match(hit.newValue, /agent-card-cannot-self-land/);
  assert.ok(!db.prepare("SELECT 1 FROM audit WHERE action = 'handoff_land' AND taskId = ?").get(card.taskId),
    '不能既拦下又当落盘结案');
  const ceoReview = db.prepare("SELECT COUNT(*) AS n FROM runs WHERE agentId = 'ceo' AND wakeReason = 'review_requested'").get().n;
  assert.ok(ceoReview > 0, '降级后必须真的请发布者来审');
});

test('R6 · 主动上报：卡转 blocked、不重试，并给上级建一张「处理升级」的卡', async (t) => {
  const { db, engine } = setup(t, {
    report: { status: 'blocked', handoff: 'escalate', reason: '这条路会让整个项目偏离' },
  });
  await engine.submit({ text: '按旧方案做完' });
  await pumpAll(engine);
  const card = childOf(db);
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(card.taskId).status, 'blocked');
  const rescue = db.prepare("SELECT * FROM tasks WHERE role = 'escalation'").get();
  assert.ok(rescue, '必须有人接手这个上报，不能只写一行日志');
  assert.equal(rescue.assignee, 'engineering');
  assert.equal(rescue.parentTaskId, card.taskId);
  assert.match(db.prepare('SELECT * FROM task_payload WHERE taskId = ?').get(rescue.taskId).instructions, /你要决定的一件事/);
  const retries = db.prepare("SELECT COUNT(*) AS n FROM events WHERE taskId = ? AND type = 'issue_assigned'").get(card.taskId).n;
  assert.equal(retries, 1, '方向错了不许自动重试');
});

test('R7 · 子派活：工程可以派给豆包，豆包不能越级派给总经理', async (t) => {
  const { db, engine } = setup(t);
  const parent = await engine.submit({ text: '加个功能', mode: 'direct', addressedTo: 'engineering' });
  const child = engine.spawnChild({
    parentTaskId: parent.taskId, assignerId: 'engineering',
    title: '实现导出按钮', instructions: '按方案实现，产物写到 output/', assignee: 'doubao',
    acceptance: ['按钮能点，导出文件非空'],
  });
  assert.equal(child.assignee, 'doubao');
  assert.equal(child.parentTaskId, parent.taskId);
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(parent.taskId).status, 'todo',
    '父卡不受影响：拆出来的子卡是另一件活');

  assert.throws(() => engine.spawnChild({
    parentTaskId: parent.taskId, assignerId: 'doubao',
    title: '越级', instructions: 'x', assignee: 'ceo',
  }), /只有这张卡的承接人/);

  assert.throws(() => engine.spawnChild({
    parentTaskId: parent.taskId, assignerId: 'engineering',
    title: '往上派', instructions: 'x', assignee: 'ceo',
  }), /跨子树派活被拒绝/);
});

test('R8 · 打回必须写原因；写成 pass 才收账', async (t) => {
  const { db, engine } = setup(t, {
    tasks: [{ title: '改引擎', assignee: 'doubao', repo: 'demo' }],
    report: { artifactKind: 'managed-code' },
  });
  await engine.submit({ text: '改引擎' });
  await pumpAll(engine);
  const card = childOf(db);
  assert.throws(() => engine.reviewTask(card.taskId, { reviewer: 'engineering', verdict: 'reject' }),
    /必须写 reason/);
  engine.reviewTask(card.taskId, { reviewer: 'engineering', verdict: 'reject', reason: '少了错误处理' });
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(card.taskId).status, 'in_progress');
  const rework = db.prepare("SELECT * FROM events WHERE taskId = ? AND processed = 0 AND type = 'issue_assigned'")
    .get(card.taskId);
  assert.ok(rework, '打回要重投给执行人');
});

// ── 谁发布谁负责：交付路由按发布者推导，董事会可以自己审 ──────────────

test('R9 · 董事会直投：默认直接落盘，不惊动总经理', async (t) => {
  const { db, engine } = setup(t);
  const out = await engine.submit({ mode: 'direct', addressedTo: 'doubao', text: '整理一份词条表' });
  await pumpAll(engine);
  const row = db.prepare('SELECT * FROM tasks WHERE taskId = ?').get(out.taskId);
  assert.equal(row.status, 'done');
  assert.equal(row.assignerId, 'human', '发布者要落库：路由与验收人全靠它');
  const ceoReview = db.prepare("SELECT COUNT(*) AS n FROM runs WHERE agentId = 'ceo' AND wakeReason = 'review_requested'").get().n;
  assert.equal(ceoReview, 0, '直投只对董事会负责，不该花 CEO 的额度');
});

test('R10 · 董事会指定「给我审」：出待拍板单，通过后才落盘', async (t) => {
  const { db, engine } = setup(t);
  const out = await engine.submit({
    mode: 'direct', addressedTo: 'doubao', text: '写份交付文件', reviewBy: 'human',
  });
  await pumpAll(engine);
  const row = db.prepare('SELECT * FROM tasks WHERE taskId = ?').get(out.taskId);
  assert.equal(row.status, 'in_review', '指定了要审就不能自己结案');
  assert.equal(row.reviewBy, 'human');

  const ap = db.prepare("SELECT * FROM approvals WHERE kind = 'task_review' AND status = 'pending'").get();
  assert.ok(ap, '董事会亲审必须变成一张待拍板单，否则人根本不知道有活等他');
  const payload = JSON.parse(ap.requestJson).payload;
  assert.equal(payload.assignee, 'doubao');
  assert.match(payload.summary, /完成：写份交付文件/);
  assert.ok(Array.isArray(payload.artifacts) && payload.artifacts.length, '审批单里要能看到产物清单');

  engine.decideApproval(ap.approvalId, { decision: 'approved', decidedBy: 'board', reason: '可以' });
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(out.taskId).status, 'done');
});

test('R11 · 待拍板打回：退回执行人重做，人的意见原样带过去', async (t) => {
  const { db, engine } = setup(t);
  const out = await engine.submit({
    mode: 'direct', addressedTo: 'doubao', text: '写份交付文件', reviewBy: 'human',
  });
  await pumpAll(engine);
  const ap = db.prepare("SELECT * FROM approvals WHERE kind = 'task_review' AND status = 'pending'").get();
  engine.decideApproval(ap.approvalId, { decision: 'rejected', decidedBy: 'board', reason: '第二段漏写' });

  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(out.taskId).status, 'in_progress');
  const rework = db.prepare("SELECT * FROM events WHERE taskId = ? AND processed = 0 AND type = 'issue_assigned'")
    .get(out.taskId);
  assert.ok(rework, '打回要重新叫醒执行人');
  assert.match(rework.payloadJson, /第二段漏写/);
});

test('R12 · 执行者不能把审查人换成自己；换成上级可以并留痕', async (t) => {
  const { db, engine } = setup(t, {
    tasks: [{ title: '写文档', assignee: 'doubao' }],
    report: { handoff: 'review', reviewBy: 'doubao' },
  });
  await engine.submit({ text: '写文档' });
  await pumpAll(engine);
  const card = childOf(db);
  assert.ok(db.prepare("SELECT 1 FROM audit WHERE action = 'review_by_rejected' AND taskId = ?").get(card.taskId),
    '自己审自己必须被拒并留痕');

  const { db: db2, engine: engine2 } = setup(t, {
    tasks: [{ title: '写文档', assignee: 'doubao' }],
    report: { handoff: 'review', reviewBy: 'engineering' },
  });
  await engine2.submit({ text: '写文档' });
  await pumpAll(engine2);
  const card2 = childOf(db2);
  assert.equal(db2.prepare('SELECT reviewBy FROM tasks WHERE taskId = ?').get(card2.taskId).reviewBy, 'engineering');
  assert.ok(db2.prepare("SELECT 1 FROM audit WHERE action = 'review_by_set' AND taskId = ?").get(card2.taskId));
});

test('R13 · 董事会原话里说「给我审」：自动转成董事会亲审（否定说法不算）', async (t) => {
  const { db, engine } = setup(t);
  const out = await engine.submit({
    mode: 'direct', addressedTo: 'doubao', text: '处理这一段，给我审一下再落盘',
  });
  await pumpAll(engine);
  assert.equal(db.prepare('SELECT reviewBy FROM tasks WHERE taskId = ?').get(out.taskId).reviewBy, 'human');
  assert.ok(db.prepare("SELECT 1 FROM audit WHERE action = 'review_intent_detected'").get());

  const out2 = await engine.submit({
    mode: 'direct', addressedTo: 'doubao', text: '整理一份词条表，不用给我看',
  });
  await pumpAll(engine);
  const row2 = db.prepare('SELECT * FROM tasks WHERE taskId = ?').get(out2.taskId);
  assert.equal(row2.reviewBy, null, '「不用给我看」不能被认成「给我看」');
  assert.equal(row2.status, 'done');
});
