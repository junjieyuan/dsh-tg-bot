/**
 * Host half of @local/dsh-tg-bot.
 *
 * Connects to the Telegram Bot API over long polling, manages pairing
 * requests and the private-chat whitelist, and serves a small authenticated
 * HTTP API (same origin as the Web GUI) to the client half.
 *
 * Scope of this version: private chats only. A Telegram user starts a pairing
 * request by sending the pairing command to the bot; the owner approves it in
 * the Web UI, which records the user in the whitelist. Messages from
 * whitelisted users are acknowledged and kept in a bounded activity log.
 */
import { z } from 'zod'

export const inject = ['webServer', 'connection', 'credentials', 'storageDomain']

const CREDENTIAL_KEY = 'dsh-tg-bot/bot'
const ROUTE_STATE = '/dsh-tg-bot/v1/state'
const ROUTE_ACTION = '/dsh-tg-bot/v1/action'
const MAX_BODY_BYTES = 64 * 1024
const ACTIVITY_PAGE = 50
const MAX_TEXT_BYTES = 2000

/**
 * User-facing replies. Chinese is primary for this deployment; the pairing
 * command is interpolated from configuration.
 */
const MESSAGES = {
  acknowledged: '已收到你的消息。当前版本仅作记录，不会转发给 Agent。',
  notPaired: (command) => `你还没有配对。请发送 "${command}" 发起配对请求。`,
  requestSubmitted: '配对请求已提交，等待管理员批准。',
  pending: '你的配对请求还在等待批准，请稍后再试。',
  approved: '你的配对请求已批准，现在可以发送消息了。',
  rejected: '很抱歉，你的配对请求已被拒绝。',
  revoked: '你已被移出白名单。如需使用，请重新发送配对命令。',
}

/**
 * Persistent state layout. Domain names and table names are restricted to
 * `[a-z][a-z0-9_]*` by the storage backend, hence `dsh_tg_bot`.
 */
const domainSpec = {
  name: 'dsh_tg_bot',
  version: 1,
  tables: {
    pending: {
      valueSchema: z.object({
        userId: z.string(),
        username: z.string(),
        firstName: z.string(),
        lastName: z.string(),
        requestedAt: z.number(),
        lastText: z.string(),
      }),
    },
    whitelist: {
      valueSchema: z.object({
        userId: z.string(),
        username: z.string(),
        firstName: z.string(),
        lastName: z.string(),
        approvedAt: z.number(),
      }),
    },
    activity: {
      valueSchema: z.object({
        msgId: z.string(),
        userId: z.string(),
        username: z.string(),
        ts: z.number(),
        text: z.string(),
      }),
    },
  },
}

/** Non-secret tuning; validated by hand (no Config export) so the bundle stays dependency-light. */
function normalizeConfig(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  const apiBase = (typeof raw.apiBase === 'string' && raw.apiBase.trim() !== ''
    ? raw.apiBase.trim()
    : 'https://api.telegram.org').replace(/\/+$/, '')
  const pairingCommand = typeof raw.pairingCommand === 'string' && raw.pairingCommand.trim() !== ''
    ? raw.pairingCommand.trim().toLowerCase()
    : 'pair'
  const pollTimeoutSeconds = Number.isInteger(raw.pollTimeoutSeconds) && raw.pollTimeoutSeconds >= 5 && raw.pollTimeoutSeconds <= 50
    ? raw.pollTimeoutSeconds
    : 25
  const activityLimit = Number.isInteger(raw.activityLimit) && raw.activityLimit >= 10 && raw.activityLimit <= 1000
    ? raw.activityLimit
    : 200
  return { apiBase, pairingCommand, pollTimeoutSeconds, activityLimit }
}

class TelegramError extends Error {
  constructor(code, message, retryAfterMs) {
    super(message)
    this.code = code
    this.retryAfterMs = retryAfterMs
  }
}

/** Minimal Bot API client over the global fetch; errors carry code + retryAfter. */
function makeTelegramClient(token, apiBase) {
  return async (method, params) => {
    const url = `${apiBase}/bot${token}/${method}`
    let response
    try {
      response = await fetch(url, params === undefined ? undefined : {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
      })
    } catch (error) {
      const cause = error !== null && error !== undefined && error.cause !== undefined
        ? (error.cause.message || String(error.cause))
        : (error !== null && error !== undefined && error.message !== undefined ? error.message : String(error))
      throw new TelegramError(0, `network error: ${cause}`, null)
    }
    let data
    try {
      data = await response.json()
    } catch {
      data = null
    }
    if (response.status === 200 && data !== null && data.ok === true) return data.result
    const code = data !== null && Number.isFinite(data.error_code) ? data.error_code : response.status
    const description = data !== null && typeof data.description === 'string' && data.description !== ''
      ? data.description
      : `HTTP ${response.status}`
    let retryAfterMs
    const parameters = data !== null ? data.parameters : undefined
    if (parameters !== undefined && parameters !== null && Number.isFinite(parameters.retry_after)) {
      retryAfterMs = parameters.retry_after * 1000
    }
    throw new TelegramError(code, description, retryAfterMs)
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function makeBodyError(message, status) {
  const error = new Error(message)
  error.status = status
  return error
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let overLimit = false
    let settled = false
    const settle = (error, value) => {
      if (settled) return
      settled = true
      if (error === undefined) resolve(value)
      else reject(error)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        overLimit = true
        return
      }
      if (!overLimit) chunks.push(chunk)
    })
    req.on('end', () => {
      if (overLimit) return settle(makeBodyError('body too large', 413), undefined)
      if (size === 0) return settle(undefined, {})
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        settle(undefined, parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined)
      } catch {
        settle(makeBodyError('invalid json', 400), undefined)
      }
    })
    req.on('error', () => settle(makeBodyError('bad request', 400), undefined))
  })
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.setHeader('content-length', Buffer.byteLength(body))
  res.end(body)
}

export async function apply(ctx, config) {
  const cfg = normalizeConfig(config)
  const credentials = ctx.credentials
  const connection = ctx.connection
  const webServer = ctx.webServer

  const log = (message) => {
    try {
      console.log(`[dsh-tg-bot] ${message}`)
    } catch {
      /* logging must never break the loop */
    }
  }

  const domain = await ctx.storageDomain.open(domainSpec)
  ctx.effect(() => () => domain.close(), 'dsh-tg-bot: close storage domain')

  const pending = new Map()
  const whitelist = new Map()
  for (const [key, value] of domain.table('pending').entries()) pending.set(key, value)
  for (const [key, value] of domain.table('whitelist').entries()) whitelist.set(key, value)

  const state = {
    token: null,
    bot: null,
    status: 'idle',
    statusError: null,
  }
  let activeTg = null
  let generation = 0

  async function readToken() {
    try {
      const record = await credentials.readRecord(CREDENTIAL_KEY)
      return record !== undefined && record.kind === 'api-key' && typeof record.key === 'string' && record.key !== ''
        ? record.key
        : null
    } catch {
      return null
    }
  }

  async function addActivity(record) {
    const table = domain.table('activity')
    await table.put(record.msgId, record)
    const entries = [...table.entries()]
    if (entries.length > cfg.activityLimit) {
      entries.sort((a, b) => a[1].ts - b[1].ts)
      await table.deleteMany(entries.slice(0, entries.length - cfg.activityLimit).map(([key]) => key))
    }
  }

  async function safeSend(userId, text) {
    if (activeTg === null) return
    try {
      await activeTg('sendMessage', { chat_id: userId, text })
    } catch (error) {
      log(`sendMessage to ${userId} failed: ${error !== null && error !== undefined && error.message !== undefined ? error.message : String(error)}`)
    }
  }

  async function processUpdate(update) {
    const message = update.message
    if (message === undefined || message === null) return
    const chat = message.chat
    // Private chats only: anything else (groups, channels) is ignored entirely.
    if (chat === undefined || chat === null || chat.type !== 'private') return
    const from = message.from
    if (from === undefined || from === null) return
    const userId = String(from.id)
    const username = typeof from.username === 'string' ? from.username : ''
    const text = typeof message.text === 'string' ? message.text : ''
    const trimmed = text.trim()

    if (whitelist.has(userId)) {
      if (trimmed !== '') {
        await addActivity({
          msgId: `${userId}:${message.message_id}`,
          userId,
          username,
          ts: Date.now(),
          text: text.slice(0, MAX_TEXT_BYTES),
        })
      }
      await safeSend(userId, MESSAGES.acknowledged)
      return
    }

    const command = trimmed.toLowerCase()
    const isPairingRequest = command === cfg.pairingCommand || command === `/${cfg.pairingCommand}`
    if (isPairingRequest) {
      const existing = pending.get(userId)
      if (existing === undefined) {
        const record = {
          userId,
          username,
          firstName: typeof from.first_name === 'string' ? from.first_name : '',
          lastName: typeof from.last_name === 'string' ? from.last_name : '',
          requestedAt: Date.now(),
          lastText: trimmed.slice(0, 500),
        }
        await domain.table('pending').put(userId, record)
        pending.set(userId, record)
      }
      await safeSend(userId, MESSAGES.requestSubmitted)
      return
    }
    if (pending.has(userId)) {
      await safeSend(userId, MESSAGES.pending)
      return
    }
    await safeSend(userId, MESSAGES.notPaired(cfg.pairingCommand))
  }

  async function startConnection() {
    generation += 1
    const gen = generation
    const token = await readToken()
    if (token === null) {
      state.token = null
      state.bot = null
      state.status = 'idle'
      state.statusError = null
      activeTg = null
      return
    }
    state.token = token
    state.status = 'connecting'
    state.statusError = null
    const tg = makeTelegramClient(token, cfg.apiBase)
    let me
    try {
      me = await tg('getMe')
    } catch (error) {
      state.status = 'error'
      state.statusError = error !== null && error !== undefined && error.message !== undefined ? error.message : String(error)
      state.bot = null
      activeTg = null
      return
    }
    if (gen !== generation) return
    activeTg = tg
    state.bot = { id: String(me.id), username: me.username || '', firstName: me.first_name || '' }
    state.status = 'polling'
    let offset
    let backoffMs = 1000
    while (gen === generation) {
      try {
        const params = { timeout: cfg.pollTimeoutSeconds, allowed_updates: ['message'] }
        if (offset !== undefined) params.offset = offset
        const updates = await tg('getUpdates', params)
        if (gen !== generation) break
        state.statusError = null
        backoffMs = 1000
        for (const update of updates) {
          offset = update.update_id + 1
          try {
            await processUpdate(update)
          } catch (error) {
            log(`update ${update.update_id} failed: ${error !== null && error !== undefined && error.message !== undefined ? error.message : String(error)}`)
          }
        }
      } catch (error) {
        if (gen !== generation) break
        if (error instanceof TelegramError && (error.code === 401 || error.code === 409)) {
          state.status = 'error'
          state.statusError = error.message
          break
        }
        state.statusError = error !== null && error !== undefined && error.message !== undefined ? error.message : String(error)
        const retryAfterMs = error !== null && error !== undefined && Number.isFinite(error.retryAfterMs) ? error.retryAfterMs * 1000 : backoffMs
        backoffMs = Math.min(backoffMs * 2, 30000)
        const waitMs = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? Math.min(retryAfterMs, backoffMs) : backoffMs
        await sleep(waitMs)
        if (gen !== generation) break
      }
    }
    if (gen === generation) {
      // The loop ended on its own (fatal error); the generation is still ours.
      activeTg = null
      if (state.status !== 'error') {
        state.status = 'idle'
        state.statusError = null
      }
    }
  }

  function stopConnection() {
    generation += 1
  }

  function actionError(status, message) {
    const error = new Error(message)
    error.status = status
    return error
  }

  async function approve(userId) {
    const record = pending.get(userId)
    if (record === undefined) throw actionError(404, `no pending pairing request for user ${userId}`)
    const entry = {
      userId,
      username: record.username,
      firstName: record.firstName,
      lastName: record.lastName,
      approvedAt: Date.now(),
    }
    await domain.table('pending').delete(userId)
    await domain.table('whitelist').put(userId, entry)
    pending.delete(userId)
    whitelist.set(userId, entry)
    await safeSend(userId, MESSAGES.approved)
    return entry
  }

  async function reject(userId) {
    const record = pending.get(userId)
    if (record === undefined) throw actionError(404, `no pending pairing request for user ${userId}`)
    await domain.table('pending').delete(userId)
    pending.delete(userId)
    await safeSend(userId, MESSAGES.rejected)
    return { userId }
  }

  async function revoke(userId) {
    const entry = whitelist.get(userId)
    if (entry === undefined) throw actionError(404, `user ${userId} is not in the whitelist`)
    await domain.table('whitelist').delete(userId)
    whitelist.delete(userId)
    await safeSend(userId, MESSAGES.revoked)
    return { userId }
  }

  async function saveToken(rawToken) {
    const token = typeof rawToken === 'string' ? rawToken.trim() : ''
    if (token === '') throw actionError(400, 'bot token must not be empty')
    await credentials.modifyRecord(CREDENTIAL_KEY, async () => ({ kind: 'api-key', key: token }))
    await startConnection()
    return state.status
  }

  async function removeToken() {
    await credentials.deleteRecord(CREDENTIAL_KEY)
    stopConnection()
    state.token = null
    state.bot = null
    state.status = 'idle'
    state.statusError = null
    activeTg = null
  }

  function publicState() {
    let activity
    try {
      activity = [...domain.table('activity').entries()]
        .map(([, value]) => value)
        .sort((a, b) => b.ts - a.ts)
        .slice(0, ACTIVITY_PAGE)
    } catch {
      activity = []
    }
    return {
      ok: true,
      configured: state.token !== null,
      bot: state.bot,
      status: state.status,
      statusError: state.statusError,
      pairingCommand: cfg.pairingCommand,
      pending: [...pending.values()].sort((a, b) => b.requestedAt - a.requestedAt),
      whitelist: [...whitelist.values()].sort((a, b) => b.approvedAt - a.approvedAt),
      activity,
    }
  }

  const guard = (req, res) => {
    const rejection = connection.requestRejection(req)
    if (rejection === undefined) return false
    res.statusCode = rejection
    res.end()
    return true
  }

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: ROUTE_STATE,
    handler: async (req, res) => {
      if (guard(req, res)) return
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      sendJson(res, 200, publicState())
    },
  }), 'dsh-tg-bot: GET ' + ROUTE_STATE)

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: ROUTE_ACTION,
    handler: async (req, res) => {
      if (guard(req, res)) return
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      let body
      try {
        body = await readJsonBody(req)
      } catch (error) {
        sendJson(res, error !== null && error !== undefined && error.status !== undefined ? error.status : 400, {
          ok: false,
          error: error !== null && error !== undefined && error.message !== undefined ? error.message : 'bad request',
        })
        return
      }
      const action = body !== undefined && typeof body.action === 'string' ? body.action : ''
      if (action === 'saveToken') {
        try {
          const status = await saveToken(body === undefined ? undefined : body.token)
          sendJson(res, 200, { ok: true, result: { status } })
        } catch (error) {
          sendJson(res, error !== null && error !== undefined && error.status !== undefined ? error.status : 400, {
            ok: false,
            error: error !== null && error !== undefined && error.message !== undefined ? error.message : 'save failed',
          })
        }
        return
      }
      if (action === 'removeToken') {
        try {
          await removeToken()
          sendJson(res, 200, { ok: true, result: { status: state.status } })
        } catch (error) {
          sendJson(res, 400, { ok: false, error: error !== null && error !== undefined && error.message !== undefined ? error.message : 'remove failed' })
        }
        return
      }
      if (action !== 'approve' && action !== 'reject' && action !== 'revoke') {
        sendJson(res, 400, { ok: false, error: `unknown action "${action}"` })
        return
      }
      const id = body !== undefined && typeof body.id === 'string' && body.id !== '' ? body.id : null
      if (id === null) {
        sendJson(res, 400, { ok: false, error: 'missing "id"' })
        return
      }
      try {
        const result = action === 'approve' ? await approve(id) : action === 'reject' ? await reject(id) : await revoke(id)
        sendJson(res, 200, { ok: true, result })
      } catch (error) {
        sendJson(res, error !== null && error !== undefined && error.status !== undefined ? error.status : 400, {
          ok: false,
          error: error !== null && error !== undefined && error.message !== undefined ? error.message : 'action failed',
        })
      }
    },
  }), 'dsh-tg-bot: POST ' + ROUTE_ACTION)

  ctx.effect(() => () => {
    generation += 1
  }, 'dsh-tg-bot: stop polling')

  startConnection().catch((error) => {
    log(`startup failed: ${error !== null && error !== undefined && error.message !== undefined ? error.message : String(error)}`)
  })
}
