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
import type { IncomingMessage, ServerResponse } from 'node:http'

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
  notPaired: (command: string) => `你还没有配对。请发送 "${command}" 发起配对请求。`,
  requestSubmitted: '配对请求已提交，等待管理员批准。',
  pending: '你的配对请求还在等待批准，请稍后再试。',
  approved: '你的配对请求已批准，现在可以发送消息了。',
  rejected: '很抱歉，你的配对请求已被拒绝。',
  revoked: '你已被移出白名单。如需使用，请重新发送配对命令。',
}

/** Record shapes mirrored from `domainSpec` below. */
interface PendingRecord {
  userId: string
  username: string
  firstName: string
  lastName: string
  requestedAt: number
  lastText: string
}
interface WhitelistRecord {
  userId: string
  username: string
  firstName: string
  lastName: string
  approvedAt: number
}
interface ActivityRecord {
  msgId: string
  userId: string
  username: string
  ts: number
  text: string
}
interface BotIdentity {
  id: string
  username: string
  firstName: string
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

interface StorageTable<V> {
  put(key: string, value: V): Promise<void>
  delete(key: string): Promise<void>
  deleteMany(keys: string[]): Promise<void>
  entries(): Iterable<[string, V]>
}

interface StorageDomain {
  table(name: 'pending'): StorageTable<PendingRecord>
  table(name: 'whitelist'): StorageTable<WhitelistRecord>
  table(name: 'activity'): StorageTable<ActivityRecord>
  close(): Promise<void>
}

interface CredentialRecord {
  kind: string
  key?: string
}

interface CredentialsApi {
  readRecord(key: string): Promise<CredentialRecord | undefined>
  modifyRecord(key: string, updater: () => Promise<CredentialRecord>): Promise<void>
  deleteRecord(key: string): Promise<void>
}

interface ConnectionApi {
  requestRejection(req: IncomingMessage): number | undefined
}

interface RouteRegistration {
  kind: string
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void
}

interface WebServerApi {
  register(route: RouteRegistration): void
}

interface StorageDomainApi {
  open(spec: typeof domainSpec): Promise<StorageDomain>
}

/** Injection context provided by the harness (see `inject` above). */
interface HostCtx {
  credentials: CredentialsApi
  connection: ConnectionApi
  webServer: WebServerApi
  storageDomain: StorageDomainApi
  effect(setup: () => unknown, label: string): void
}

/** Non-secret tuning; validated by hand (no Config export) so the bundle stays dependency-light. */
interface TgBotConfig {
  apiBase: string
  pairingCommand: string
  pollTimeoutSeconds: number
  activityLimit: number
}

interface ConfigInput {
  apiBase?: string
  pairingCommand?: string
  pollTimeoutSeconds?: number
  activityLimit?: number
}

function normalizeConfig(config: unknown): TgBotConfig {
  const raw: ConfigInput = config !== null && typeof config === 'object' ? (config as ConfigInput) : {}
  const apiBase = (typeof raw.apiBase === 'string' && raw.apiBase.trim() !== ''
    ? raw.apiBase.trim()
    : 'https://api.telegram.org').replace(/\/+$/, '')
  const pairingCommand = typeof raw.pairingCommand === 'string' && raw.pairingCommand.trim() !== ''
    ? raw.pairingCommand.trim().toLowerCase()
    : 'pair'
  const pollTimeoutSeconds = typeof raw.pollTimeoutSeconds === 'number' && Number.isInteger(raw.pollTimeoutSeconds) && raw.pollTimeoutSeconds >= 5 && raw.pollTimeoutSeconds <= 50
    ? raw.pollTimeoutSeconds
    : 25
  const activityLimit = typeof raw.activityLimit === 'number' && Number.isInteger(raw.activityLimit) && raw.activityLimit >= 10 && raw.activityLimit <= 1000
    ? raw.activityLimit
    : 200
  return { apiBase, pairingCommand, pollTimeoutSeconds, activityLimit }
}

class TelegramError extends Error {
  readonly code: number
  readonly retryAfterMs: number | undefined
  constructor(code: number, message: string, retryAfterMs: number | undefined) {
    super(message)
    this.code = code
    this.retryAfterMs = retryAfterMs
  }
}

interface TgApiResponse {
  ok: boolean
  result?: unknown
  error_code?: number
  description?: string
  parameters?: { retry_after?: number } | null
}

type TelegramMethod = (method: string, params?: Record<string, unknown>) => Promise<unknown>

/** Minimal Bot API client over the global fetch; errors carry code + retryAfter. */
function makeTelegramClient(token: string, apiBase: string): TelegramMethod {
  return async (method, params) => {
    const url = `${apiBase}/bot${token}/${method}`
    let response: Response
    try {
      response = await fetch(url, params === undefined ? undefined : {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
      })
    } catch (error) {
      const err = error as { cause?: { message?: string } | string | null; message?: string } | null | undefined
      const cause = err !== null && err !== undefined && err.cause !== undefined && err.cause !== null
        ? (typeof err.cause === 'object' && err.cause.message !== undefined ? err.cause.message : String(err.cause))
        : (err !== null && err !== undefined && err.message !== undefined ? err.message : String(error))
      throw new TelegramError(0, `network error: ${cause}`, undefined)
    }
    let data: TgApiResponse | null = null
    try {
      data = (await response.json()) as TgApiResponse
    } catch {
      data = null
    }
    if (response.status === 200 && data !== null && data.ok === true) return data.result
    const code = data !== null && data.error_code !== undefined && Number.isFinite(data.error_code)
      ? data.error_code
      : response.status
    const description = data !== null && typeof data.description === 'string' && data.description !== ''
      ? data.description
      : `HTTP ${response.status}`
    let retryAfterMs: number | undefined
    const parameters = data !== null ? data.parameters : undefined
    if (parameters !== undefined && parameters !== null && parameters.retry_after !== undefined && Number.isFinite(parameters.retry_after)) {
      retryAfterMs = parameters.retry_after * 1000
    }
    throw new TelegramError(code, description, retryAfterMs)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function makeBodyError(message: string, status: number): Error & { status: number } {
  const error = new Error(message) as Error & { status: number }
  error.status = status
  return error
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let overLimit = false
    let settled = false
    const settle = (error: Error | undefined, value: Record<string, unknown> | undefined): void => {
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
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        settle(undefined, parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : undefined)
      } catch {
        settle(makeBodyError('invalid json', 400), undefined)
      }
    })
    req.on('error', () => settle(makeBodyError('bad request', 400), undefined))
  })
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.setHeader('content-length', Buffer.byteLength(body))
  res.end(body)
}

function sendError(res: ServerResponse, error: unknown, fallbackMessage: string): void {
  const err = error as { status?: number; message?: string } | null | undefined
  const status = err !== null && err !== undefined && err.status !== undefined ? err.status : 400
  const message = err !== null && err !== undefined && err.message !== undefined ? err.message : fallbackMessage
  sendJson(res, status, { ok: false, error: message })
}

/** Extract a user-facing message from an unknown thrown value. */
function errorMessage(error: unknown): string {
  const err = error as { message?: string } | null | undefined
  return err !== null && err !== undefined && err.message !== undefined ? err.message : String(error)
}

export async function apply(ctx: HostCtx, config: unknown): Promise<void> {
  const cfg = normalizeConfig(config)
  const credentials = ctx.credentials
  const connection = ctx.connection
  const webServer = ctx.webServer

  const log = (message: string): void => {
    try {
      console.log(`[dsh-tg-bot] ${message}`)
    } catch {
      /* logging must never break the loop */
    }
  }

  const domain = await ctx.storageDomain.open(domainSpec)
  ctx.effect(() => () => domain.close(), 'dsh-tg-bot: close storage domain')

  const pending = new Map<string, PendingRecord>()
  const whitelist = new Map<string, WhitelistRecord>()
  for (const [key, value] of domain.table('pending').entries()) pending.set(key, value)
  for (const [key, value] of domain.table('whitelist').entries()) whitelist.set(key, value)

  type ConnectionStatus = 'idle' | 'connecting' | 'polling' | 'error'
  interface ConnectionState {
    token: string | null
    bot: BotIdentity | null
    status: ConnectionStatus
    statusError: string | null
  }
  const state: ConnectionState = {
    token: null,
    bot: null,
    status: 'idle',
    statusError: null,
  }
  let activeTg: TelegramMethod | null = null
  let generation = 0

  async function readToken(): Promise<string | null> {
    try {
      const record = await credentials.readRecord(CREDENTIAL_KEY)
      return record !== undefined && record.kind === 'api-key' && typeof record.key === 'string' && record.key !== ''
        ? record.key
        : null
    } catch {
      return null
    }
  }

  async function addActivity(record: ActivityRecord): Promise<void> {
    const table = domain.table('activity')
    await table.put(record.msgId, record)
    const entries = [...table.entries()]
    if (entries.length > cfg.activityLimit) {
      entries.sort((a, b) => a[1].ts - b[1].ts)
      await table.deleteMany(entries.slice(0, entries.length - cfg.activityLimit).map(([key]) => key))
    }
  }

  async function safeSend(userId: string, text: string): Promise<void> {
    if (activeTg === null) return
    try {
      await activeTg('sendMessage', { chat_id: userId, text })
    } catch (error) {
      log(`sendMessage to ${userId} failed: ${errorMessage(error)}`)
    }
  }

  interface TelegramMessage {
    message_id: number
    chat?: { type: string } | null
    from?: { id: number | string; username?: string; first_name?: string; last_name?: string } | null
    text?: string
  }
  interface TelegramUpdate {
    update_id: number
    message?: TelegramMessage | null
  }

  async function processUpdate(update: TelegramUpdate): Promise<void> {
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
        const record: PendingRecord = {
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

  interface GetMeResult {
    id: number | string
    username?: string
    first_name?: string
  }

  async function startConnection(): Promise<void> {
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
    let me: GetMeResult
    try {
      me = (await tg('getMe')) as GetMeResult
    } catch (error) {
      state.status = 'error'
      state.statusError = errorMessage(error)
      state.bot = null
      activeTg = null
      return
    }
    if (gen !== generation) return
    activeTg = tg
    state.bot = { id: String(me.id), username: me.username || '', firstName: me.first_name || '' }
    state.status = 'polling'
    let offset: number | undefined
    let backoffMs = 1000
    while (gen === generation) {
      try {
        const params: { timeout: number; allowed_updates: string[]; offset?: number } = { timeout: cfg.pollTimeoutSeconds, allowed_updates: ['message'] }
        if (offset !== undefined) params.offset = offset
        const updates = (await tg('getUpdates', params)) as TelegramUpdate[]
        if (gen !== generation) break
        state.statusError = null
        backoffMs = 1000
        for (const update of updates) {
          offset = update.update_id + 1
          try {
            await processUpdate(update)
          } catch (error) {
            log(`update ${update.update_id} failed: ${errorMessage(error)}`)
          }
        }
      } catch (error) {
        if (gen !== generation) break
        if (error instanceof TelegramError && (error.code === 401 || error.code === 409)) {
          state.status = 'error'
          state.statusError = error.message
          break
        }
        state.statusError = errorMessage(error)
        const err = error as { retryAfterMs?: number } | null | undefined
        const retryAfterMs = err !== null && err !== undefined && err.retryAfterMs !== undefined && Number.isFinite(err.retryAfterMs)
          ? err.retryAfterMs * 1000
          : backoffMs
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

  function stopConnection(): void {
    generation += 1
  }

  function actionError(status: number, message: string): Error & { status: number } {
    const error = new Error(message) as Error & { status: number }
    error.status = status
    return error
  }

  async function approve(userId: string): Promise<WhitelistRecord> {
    const record = pending.get(userId)
    if (record === undefined) throw actionError(404, `no pending pairing request for user ${userId}`)
    const entry: WhitelistRecord = {
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

  async function reject(userId: string): Promise<{ userId: string }> {
    const record = pending.get(userId)
    if (record === undefined) throw actionError(404, `no pending pairing request for user ${userId}`)
    await domain.table('pending').delete(userId)
    pending.delete(userId)
    await safeSend(userId, MESSAGES.rejected)
    return { userId }
  }

  async function revoke(userId: string): Promise<{ userId: string }> {
    const entry = whitelist.get(userId)
    if (entry === undefined) throw actionError(404, `user ${userId} is not in the whitelist`)
    await domain.table('whitelist').delete(userId)
    whitelist.delete(userId)
    await safeSend(userId, MESSAGES.revoked)
    return { userId }
  }

  async function saveToken(rawToken: unknown): Promise<ConnectionStatus> {
    const token = typeof rawToken === 'string' ? rawToken.trim() : ''
    if (token === '') throw actionError(400, 'bot token must not be empty')
    await credentials.modifyRecord(CREDENTIAL_KEY, async () => ({ kind: 'api-key', key: token }))
    await startConnection()
    return state.status
  }

  async function removeToken(): Promise<void> {
    await credentials.deleteRecord(CREDENTIAL_KEY)
    stopConnection()
    state.token = null
    state.bot = null
    state.status = 'idle'
    state.statusError = null
    activeTg = null
  }

  function publicState(): Record<string, unknown> {
    let activity: ActivityRecord[]
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

  const guard = (req: IncomingMessage, res: ServerResponse): boolean => {
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
      let body: Record<string, unknown> | undefined
      try {
        body = await readJsonBody(req)
      } catch (error) {
        sendError(res, error, 'bad request')
        return
      }
      const action = body !== undefined && typeof body.action === 'string' ? body.action : ''
      if (action === 'saveToken') {
        try {
          const status = await saveToken(body === undefined ? undefined : body.token)
          sendJson(res, 200, { ok: true, result: { status } })
        } catch (error) {
          sendError(res, error, 'save failed')
        }
        return
      }
      if (action === 'removeToken') {
        try {
          await removeToken()
          sendJson(res, 200, { ok: true, result: { status: state.status } })
        } catch (error) {
          sendError(res, error, 'remove failed')
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
        sendError(res, error, 'action failed')
      }
    },
  }), 'dsh-tg-bot: POST ' + ROUTE_ACTION)

  ctx.effect(() => () => {
    generation += 1
  }, 'dsh-tg-bot: stop polling')

  startConnection().catch((error) => {
    log(`startup failed: ${errorMessage(error)}`)
  })
}
