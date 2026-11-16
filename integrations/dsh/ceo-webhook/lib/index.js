/**
 * dsh-ceo-webhook — DSH plugin (NOT part of AICompany core).
 *
 * An HTTP webhook channel for DeepSeek Harness. It turns an incoming POST into
 * a real, tool-capable DSH agent — the very same `agents` + `agentPresets`
 * services the Feishu plugin (dsh-lark-channel) drives — so the agent can read
 * files and run tools under the profile's sandbox policy (danger-full-access).
 *
 * A plain LLM cannot do that; this plugin is what gives a local orchestrator
 * (e.g. AICompany on 127.0.0.1:3100) an executable "CEO" it can hand tasks to.
 *
 * Route prefix: /aiceo/api   (registered on the host webServer, port 8080)
 *   POST /aiceo/api/task          { taskId?, prompt, cwd?, sessionId? } -> { taskId, sessionId }
 *   GET  /aiceo/api/result?taskId=...   -> { status, text, error?, turn }
 *   GET  /aiceo/api/health         -> { ok, agents:bool, presets:bool, tasks:n }
 *
 * Security:
 *   - Only loopback/private callers (delegated to the host `connection` fence
 *     plus an explicit shared-token check when AICEO_TOKEN is configured).
 *   - A task id may not contain path separators; session ids are namespaced
 *     with a fixed prefix so they can never collide with the GUI's sessions.
 *
 * @module dsh-ceo-webhook
 */

import { randomUUID } from 'node:crypto'
import { isIP } from 'node:net'

/** Cordis plugin name — keep stable. */
export const name = 'ceo-webhook'

/** Services that must exist before routes mount. `connection`/`agentPresets` are soft. */
export const inject = ['webServer', 'agents']

/** Route prefix owned by this plugin. */
const PREFIX = '/aiceo/api'

/** Session ids this plugin creates carry this prefix, so they never collide with GUI or Feishu sessions. */
const SESSION_PREFIX = 'aiceo-ceo-'

/** taskId must be a single safe path segment (it is used only as a map key, but keep it strict). */
const TASK_ID_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]{0,96}$/

/** How long to keep finished task results (ms). Results are memory-only. */
const RESULT_TTL_MS = 30 * 60 * 1000

/** Upper bound on a single prompt, to avoid accidental payload bombs. */
const MAX_PROMPT_CHARS = 100_000

/** Optional shared token, read from the host process environment. */
const SHARED_TOKEN = typeof process !== 'undefined' ? process.env.AICEO_TOKEN || '' : ''

/**
 * Default model route. `agents.create()` does NOT inherit the profile's
 * agentDefaultModel automatically — it must be passed explicitly — so default
 * to the logged-in account provider + flash model (env overrides).
 */
const PROVIDER = typeof process !== 'undefined' ? process.env.AICEO_PROVIDER || 'deepseek-account' : 'deepseek-account'
const MODEL = typeof process !== 'undefined' ? process.env.AICEO_MODEL || 'deepseek-flash' : 'deepseek-flash'

/**
 * Minimal error carrying an HTTP status and a stable code.
 */
class PluginError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

/** Write one JSON response. */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

/** Read a JSON body with a hard size cap. */
async function readJson(req, maxBytes = 2 * 1024 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > maxBytes) throw new PluginError('payload-too-large', 'request body too large', 413)
    chunks.push(chunk)
  }
  if (total === 0) throw new PluginError('empty-body', 'request body is empty', 400)
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new PluginError('bad-json', 'request body is not valid JSON', 400)
  }
}

/** Constant-time-ish token compare (token is short-lived local secret; timing is not the main defense). */
function tokenOk(presented) {
  if (SHARED_TOKEN === '') return true // no token configured -> rely on host connection fence + loopback
  if (typeof presented !== 'string' || presented.length !== SHARED_TOKEN.length) return false
  let diff = 0
  for (let i = 0; i < presented.length; i++) diff |= presented.charCodeAt(i) ^ SHARED_TOKEN.charCodeAt(i)
  return diff === 0
}

/**
 * Check a caller is local/private. Socket peer address, not Host header (which
 * is client-controlled); kept as one layer of the fence.
 */
function loopbackOnly(req) {
  const addr = req.socket?.remoteAddress || ''
  // Normalize IPv4-mapped IPv6 (::ffff:127.0.0.1).
  const v4 = addr.startsWith('::ffff:') ? addr.slice(7) : addr
  if (v4 === '127.0.0.1' || v4 === '::1' || v4 === 'localhost') return true
  // Allow LAN/non-loopback only when a token is configured (explicit opt-in).
  if (SHARED_TOKEN === '' && isIP(v4)) return false
  return SHARED_TOKEN !== ''
}

/**
 * Host/Origin fence equivalent to dsh's `isTrustedApiRequest`, WITHOUT the
 * browser-session authentication that `connection.requestRejection` adds.
 * A webhook caller has no browser session, so we fence cross-site requests here
 * and authenticate purely with the shared token. Returns true when trusted.
 */
function trustedRequest(req) {
  // Cross-site browser requests are always rejected.
  if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return false
  const host = req.headers.host
  if (typeof host !== 'string' || host === '') return false
  // Accept loopback Host (localhost / 127.0.0.0/8 / ::1), or any Host when a
  // token is configured (explicit opt-in for LAN/reverse-proxy deployments).
  const hostname = host.split(':')[0].replace(/^\[|\]$/g, '').toLowerCase()
  const isLoopback = hostname === 'localhost' || hostname === '::1'
    || (/^127\./.test(hostname))
  if (!isLoopback && SHARED_TOKEN === '') return false
  // If an Origin is present it must match the Host (same authority).
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin !== '') {
    try {
      if (new URL(origin).host.toLowerCase() !== host.toLowerCase()) return false
    } catch {
      return false
    }
  }
  return true
}

/**
 * Build the per-agent `agentOptions` route. Prefers explicit env overrides;
 * falls back to whatever the profile's `agentDefaultModel` composed.
 */
function agentOptions() {
  if (PROVIDER === '' && MODEL === '') return undefined
  return {
    ...PROVIDER === '' ? {} : { provider: PROVIDER },
    ...MODEL === '' ? {} : { model: MODEL },
  }
}

/**
 * Cordis apply: register HTTP routes on the host webServer, and wire the
 * session/event listener that collects each task's assistant text.
 */
export function apply(ctx) {
  const agents = ctx.get('agents')
  const presets = ctx.get('agentPresets') // optional; absent -> agent joins no preset (still runs, but toolless)

  /**
   * taskId -> { sessionId, done, text, error, turn, createdAt, handle, started }
   * Results are memory-only and expire; a restart clears them (tasks are re-postable).
   */
  const tasks = new Map()

  /** sessionId -> taskId (reverse index for the event listener). */
  const bySession = new Map()

  /** Which task ids are currently being bound, joined by concurrent result reads. */
  const binding = new Map()

  const notify = (line) => {
    try { ctx.logger?.info?.(`[ceo-webhook] ${line}`) } catch { /* logger may be absent in fixtures */ }
  }

  /** Resolve (create or reuse) the agent handle for a task, deduplicated. */
  const bindHandle = (taskId) => {
    const existing = tasks.get(taskId)
    if (existing === undefined) throw new PluginError('unknown-task', `unknown taskId "${taskId}"`, 404)
    if (existing.handle !== undefined) return Promise.resolve(existing.handle)
    const inFlight = binding.get(taskId)
    if (inFlight !== undefined) return inFlight

    const walk = (async () => {
      const sessionId = existing.sessionId
      // Reuse a still-live agent if one is published under our namespaced id.
      const live = typeof agents.get === 'function' ? agents.get(sessionId) : undefined
      if (live !== undefined) return { agent: live, dispose: () => Promise.resolve() }

      // setup() mounts the preset so the agent has tools; without a roster the
      // agent still runs but reaches the model with no tools (call out in health).
      const setup = presets === undefined
        ? undefined
        : async (agentCtx) => {
          const resolved = await presets.resolve()
          await presets.mount(agentCtx, resolved.id)
        }

      // Prefer resume of a durable session, fall back to create. A rejection
      // from resume is the registry's only "never existed" signal.
      let handle
      if (typeof agents.resume === 'function') {
        try {
          handle = await agents.resume({
            resumeSessionId: sessionId,
            ...agentOptions() === undefined ? {} : { agentOptions: agentOptions() },
            ...setup === undefined ? {} : { setup },
          })
        } catch (error) {
          notify(`resume failed for ${taskId}, creating fresh: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      if (handle === undefined) {
        handle = await agents.create({
          sessionId,
          meta: { cwd: existing.cwd },
          ...agentOptions() === undefined ? {} : { agentOptions: agentOptions() },
          ...setup === undefined ? {} : { setup },
        })
      }
      return handle
    })()

    binding.set(taskId, walk)
    walk.then(
      (handle) => {
        const rec = tasks.get(taskId)
        if (rec !== undefined) rec.handle = handle
        binding.delete(taskId)
      },
      () => { binding.delete(taskId) },
    )
    return walk
  }

  /** Collect assistant text and turn boundaries from every owned session. */
  const onSessionEvent = (session, event) => {
    const sessionId = session?.id
    if (typeof sessionId !== 'string') return
    const taskId = bySession.get(sessionId)
    if (taskId === undefined) return
    const rec = tasks.get(taskId)
    if (rec === undefined) return

    if (event?.type === 'assistant/message') {
      const blocks = event.data?.message?.content
      if (Array.isArray(blocks)) {
        for (const block of blocks) {
          if (block?.type === 'text' && typeof block.text === 'string' && block.text !== '') {
            rec.text += block.text
          }
        }
      }
    } else if (event?.type === 'turn/end') {
      rec.turn = event.data?.turn ?? rec.turn
      rec.done = true
      const reason = event.data?.reason
      if (reason?.kind === 'error') {
        rec.error = reason.error?.message || reason.error?.code || 'turn failed'
      }
      rec.started = false
      notify(`task ${taskId} turn ended: ${rec.error === undefined ? 'ok' : rec.error}`)
    }
  }
  ctx.on('session/event', onSessionEvent)

  /** Best-effort reap of expired results. */
  const reap = () => {
    const now = Date.now()
    for (const [id, rec] of tasks) {
      if (rec.done && now - rec.createdAt > RESULT_TTL_MS) {
        tasks.delete(id)
        bySession.delete(rec.sessionId)
      }
    }
  }
  const reapTimer = typeof setInterval === 'function' ? setInterval(reap, 60_000) : undefined
  reapTimer?.unref?.()

  /** The RPC surface, mirroring dsh-delete-chat's shape. */
  const api = {
    health: async () => ({
      ok: true,
      agents: agents !== undefined,
      presets: presets !== undefined,
      tasks: tasks.size,
      provider: PROVIDER || '(profile default)',
      model: MODEL || '(profile default)',
    }),

    task: async (payload) => {
      if (payload === null || typeof payload !== 'object') throw new PluginError('bad-payload', 'payload must be an object')
      const prompt = payload.prompt
      if (typeof prompt !== 'string' || prompt.trim() === '') throw new PluginError('bad-prompt', 'prompt must be a non-empty string')
      if (prompt.length > MAX_PROMPT_CHARS) throw new PluginError('prompt-too-large', `prompt exceeds ${MAX_PROMPT_CHARS} chars`, 413)

      let taskId = payload.taskId
      if (taskId === undefined || taskId === null || taskId === '') {
        taskId = `t-${randomUUID().slice(0, 8)}`
      }
      if (typeof taskId !== 'string' || !TASK_ID_PATTERN.test(taskId)) {
        throw new PluginError('bad-task-id', 'taskId must match ^[0-9A-Za-z][0-9A-Za-z._-]{0,96}$')
      }
      // 同一 taskId 再投一次 = 让它再跑一轮（返工、验收、重试都靠这条）。
      // 只有「正在跑」才拒绝重复投递，避免同一任务被并发灌两条提示词。
      const prior = tasks.get(taskId)
      if (prior !== undefined && prior.started) {
        return { taskId, sessionId: prior.sessionId, reused: true, running: true }
      }

      let cwd = typeof payload.cwd === 'string' && payload.cwd !== '' ? payload.cwd : undefined
      let sessionId
      if (typeof payload.sessionId === 'string' && payload.sessionId !== '') {
        sessionId = payload.sessionId.startsWith(SESSION_PREFIX)
          ? payload.sessionId
          : `${SESSION_PREFIX}${payload.sessionId}`
      } else {
        sessionId = `${SESSION_PREFIX}${taskId}`
      }

      const rec = {
        taskId,
        sessionId,
        cwd,
        done: false,
        text: '',
        error: undefined,
        turn: 0,
        createdAt: Date.now(),
        handle: prior?.handle,
        started: true,
      }
      tasks.set(taskId, rec)
      bySession.set(sessionId, taskId)

      const handle = await bindHandle(taskId)
      const message = Object.freeze({
        id: randomUUID(),
        role: 'user',
        content: Object.freeze([Object.freeze({ type: 'text', text: prompt })]),
        source: Object.freeze({ kind: 'user' }),
      })
      try {
        handle.agent.followup(message)
      } catch (error) {
        rec.started = false
        rec.done = true
        rec.error = error instanceof Error ? error.message : String(error)
        throw new PluginError('followup-failed', rec.error, 500)
      }
      // reused = 复用了已有会话（第二轮/返工），但这一轮提示词是真的投进去了。
      return { taskId, sessionId, reused: prior !== undefined }
    },

    result: async (payload) => {
      const taskId = payload?.taskId
      if (typeof taskId !== 'string' || !TASK_ID_PATTERN.test(taskId)) {
        throw new PluginError('bad-task-id', 'taskId is required')
      }
      const rec = tasks.get(taskId)
      if (rec === undefined) throw new PluginError('unknown-task', `unknown taskId "${taskId}"`, 404)
      return {
        status: rec.error !== undefined ? 'error' : rec.done ? 'done' : 'running',
        text: rec.text,
        ...rec.error === undefined ? {} : { error: rec.error },
        turn: rec.turn,
        sessionId: rec.sessionId,
      }
    },
  }

  /** Register the HTTP prefix route on the host webServer. */
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: PREFIX,
    handler: async (req, res) => {
      // Own Host/Origin fence (cross-site guard) + socket-local check + token.
      // Deliberately NOT using connection.requestRejection: that also requires a
      // browser-session peer, which a headless webhook caller never has.
      if (!trustedRequest(req) || !loopbackOnly(req)
        || !tokenOk(req.headers['x-aiceo-token'] || req.headers.authorization?.replace(/^Bearer\s+/i, ''))) {
        sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'local + token only' } })
        return
      }

      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
      const method = pathname.startsWith(`${PREFIX}/`) ? pathname.slice(PREFIX.length + 1) : undefined
      try {
        if (req.method !== 'POST') throw new PluginError('method-error', 'POST only', 405)
        if (method === undefined || method === '' || method.includes('/') || !Object.hasOwn(api, method)) {
          throw new PluginError('not-found', `unknown method "${method ?? ''}"`, 404)
        }
        const payload = await readJson(req)
        const value = await api[method](payload)
        sendJson(res, 200, { ok: true, value })
      } catch (error) {
        const status = error instanceof PluginError ? error.status : 500
        sendJson(res, status, {
          ok: false,
          error: {
            code: error instanceof PluginError ? error.code : 'internal',
            message: error instanceof Error ? error.message : String(error),
          },
        })
      }
    },
  }), 'ceo-webhook: /aiceo/api routes')

  /** Teardown: unsubscribe events and clear timers. Agents are left to the host registry. */
  ctx.effect(() => () => {
    try { ctx.off?.('session/event', onSessionEvent) } catch { /* off may be absent */ }
    if (reapTimer !== undefined) clearInterval(reapTimer)
  }, 'ceo-webhook: cleanup')

  notify(`ready (presets=${presets !== undefined}, token=${SHARED_TOKEN === '' ? 'off' : 'on'})`)
}

/** Exposed for offline fixture tests; not part of the plugin API. */
export const __testing = { PREFIX, SESSION_PREFIX, TASK_ID_PATTERN, PluginError }
