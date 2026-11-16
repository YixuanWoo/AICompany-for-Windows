/**
 * Offline fixture tests for dsh-ceo-webhook. No real DSH runtime needed:
 * fake ctx supplies webServer/agents/presets and a session/event emitter.
 * Run: node --test integrations/dsh/ceo-webhook/lib/index.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, name, inject, __testing } from './index.js'

/** A tiny EventEmitter-like ctx with the services the plugin injects. */
function makeCtx({ withPresets = true } = {}) {
  const listeners = new Map()
  const effects = []
  let registeredRoute
  const created = []
  const followed = []

  const agent = {
    session: { id: '' },
    followup(msg) { followed.push(msg) },
    cancel() {},
  }

  const agents = {
    get(sessionId) { return this._live.get(sessionId) },
    _live: new Map(),
    async create(opts) {
      created.push(opts)
      const a = { ...agent, session: { id: opts.sessionId } }
      this._live.set(opts.sessionId, a)
      return { agent: a, dispose: async () => {} }
    },
    async resume() { throw new Error('no such session') },
  }

  const presets = withPresets
    ? {
        async resolve() { return { id: 'default' } },
        async mount() {},
        async standingKeyFor() { return 'default' },
      }
    : undefined

  const ctx = {
    getters: { webServer: {}, agents, connection: undefined },
    get(key) { return this.getters[key] },
    logger: { info() {}, warn() {}, error() {} },
    on(evt, fn) { listeners.set(evt, fn) },
    off(evt) { listeners.delete(evt) },
    effect(fn) { effects.push(fn); fn() }, // real cordis executes the effect immediately
    emit(evt, ...args) { listeners.get(evt)?.(...args) },
    webServer: {
      register(route) { registeredRoute = route; return () => { registeredRoute = undefined } },
    },
    // expose for assertions
    _created: created,
    _followed: followed,
    _agents: agents,
    _route: () => registeredRoute,
    _effects: effects,
    _presets: presets,
  }
  // wire getters for the injected/soft services
  ctx.getters.webServer = ctx.webServer
  ctx.getters.agentPresets = presets
  return ctx
}

/** Invoke a registered prefix handler with a POST JSON request. */
async function call(ctx, method, payload, { token } = {}) {
  const route = ctx._route()
  assert.ok(route, 'route must be registered')
  const url = `http://dsh.internal${__testing.PREFIX}/${method}`
  const body = payload === undefined ? '' : JSON.stringify(payload)
  const req = {
    method: 'POST',
    url,
    headers: { host: '127.0.0.1:8080', ...(token === undefined ? {} : { 'x-aiceo-token': token }) },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(body) },
  }
  let status, text
  const res = {
    writeHead(s) { status = s },
    end(t) { text = t },
  }
  await route.handler(req, res)
  return { status, body: JSON.parse(text) }
}

test('exports stable plugin identity', () => {
  assert.equal(name, 'ceo-webhook')
  assert.ok(inject.includes('webServer'))
  assert.ok(inject.includes('agents'))
})

test('registers /aiceo/api prefix route on apply', () => {
  const ctx = makeCtx()
  apply(ctx)
  const route = ctx._route()
  assert.ok(route)
  assert.equal(route.kind, 'prefix')
  assert.equal(route.path, '/aiceo/api')
})

test('task creates a namespaced agent with preset mount and follows up the prompt', async () => {
  const ctx = makeCtx()
  apply(ctx)
  const r = await call(ctx, 'task', { taskId: 't-abc', prompt: '列出当前目录' })
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.value.taskId, 't-abc')
  assert.equal(r.body.value.sessionId, 'aiceo-ceo-t-abc')
  assert.equal(ctx._created.length, 1)
  assert.equal(ctx._created[0].sessionId, 'aiceo-ceo-t-abc')
  assert.equal(ctx._followed.length, 1)
  assert.equal(ctx._followed[0].content[0].text, '列出当前目录')
})

test('assistant/message and turn/end events drive result status', async () => {
  const ctx = makeCtx()
  apply(ctx)
  await call(ctx, 'task', { taskId: 't-xyz', prompt: 'hi' })

  // running before any output
  let r = await call(ctx, 'result', { taskId: 't-xyz' })
  assert.equal(r.body.value.status, 'running')

  // feed assistant text
  ctx.emit('session/event', { id: 'aiceo-ceo-t-xyz' }, {
    type: 'assistant/message',
    data: { turn: 1, message: { content: [{ type: 'text', text: 'done part1' }, { type: 'text', text: ' part2' }] } },
  })
  ctx.emit('session/event', { id: 'aiceo-ceo-t-xyz' }, {
    type: 'turn/end',
    data: { turn: 1, reason: { kind: 'stop' } },
  })

  r = await call(ctx, 'result', { taskId: 't-xyz' })
  assert.equal(r.body.value.status, 'done')
  assert.equal(r.body.value.text, 'done part1 part2')
  assert.equal(r.body.value.turn, 1)
})

test('error turn is reported as error status', async () => {
  const ctx = makeCtx()
  apply(ctx)
  await call(ctx, 'task', { taskId: 't-err', prompt: 'x' })
  ctx.emit('session/event', { id: 'aiceo-ceo-t-err' }, {
    type: 'turn/end',
    data: { turn: 1, reason: { kind: 'error', error: { code: 'E', message: 'boom' } } },
  })
  const r = await call(ctx, 'result', { taskId: 't-err' })
  assert.equal(r.body.value.status, 'error')
  assert.equal(r.body.value.error, 'boom')
})

test('validates taskId and prompt', async () => {
  const ctx = makeCtx()
  apply(ctx)
  let r = await call(ctx, 'task', { taskId: '../bad', prompt: 'x' })
  assert.equal(r.status, 400)
  r = await call(ctx, 'task', { prompt: '' })
  assert.equal(r.status, 400)
  r = await call(ctx, 'result', { taskId: 'nope' })
  assert.equal(r.status, 404)
})

test('同一 taskId：跑着时拒绝重复投递，跑完可再来一轮（返工/验收靠这条）', async () => {
  const ctx = makeCtx()
  apply(ctx)
  const a = await call(ctx, 'task', { taskId: 't-idem', prompt: '第一轮' })
  const b = await call(ctx, 'task', { taskId: 't-idem', prompt: '重复投递' })
  assert.equal(a.body.value.reused, false)
  assert.equal(b.body.value.reused, true)
  assert.equal(ctx._followed.length, 1, '正在跑时不许并发灌第二条')

  ctx.emit('session/event', { id: 'aiceo-ceo-t-idem' }, {
    type: 'assistant/message',
    data: { turn: 1, message: { content: [{ type: 'text', text: '第一轮结果' }] } },
  })
  ctx.emit('session/event', { id: 'aiceo-ceo-t-idem' }, {
    type: 'turn/end',
    data: { turn: 1, reason: { kind: 'stop' } },
  })
  let r = await call(ctx, 'result', { taskId: 't-idem' })
  assert.equal(r.body.value.status, 'done')
  assert.equal(r.body.value.text, '第一轮结果')

  // 同一 taskId 再投 = 让它再跑一轮；旧文本必须清掉，否则调用方会把上一轮结果当本轮。
  const c = await call(ctx, 'task', { taskId: 't-idem', prompt: '第二轮' })
  assert.equal(c.body.value.reused, true)
  assert.equal(ctx._followed.length, 2)
  assert.equal(ctx._followed[1].content[0].text, '第二轮')
  r = await call(ctx, 'result', { taskId: 't-idem' })
  assert.equal(r.body.value.status, 'running')
  assert.equal(r.body.value.text, '')
})

test('health reports service availability', async () => {
  const ctx = makeCtx()
  apply(ctx)
  const r = await call(ctx, 'health', {})
  assert.equal(r.body.value.ok, true)
  assert.equal(r.body.value.agents, true)
  assert.equal(r.body.value.presets, true)
})

test('works without agentPresets service (toolless but still runs)', async () => {
  const ctx = makeCtx({ withPresets: false })
  apply(ctx)
  const r = await call(ctx, 'task', { taskId: 't-nop', prompt: 'x' })
  assert.equal(r.status, 200)
  assert.equal(ctx._created[0].setup, undefined)
})
