/**
 * Host half of the pet.
 *
 * The desktop window is a separate Electron process, so the host has three
 * jobs: answer the little questions that page cannot answer itself (state,
 * balance), decide when that window should exist at all, and keep the two in
 * sync. Everything the page can do on its own — sprites, blinking, lines, the
 * menu — stays out of here.
 *
 * The window talks to a small private server of this plugin, not to the DSH
 * web server. That one sits behind the app's auth gate, and a `file://` page
 * has no session to show it. A socket on 127.0.0.1 with a random token in the
 * environment is the smallest thing that has neither problem; the in-page
 * client keeps using the public route, same-origin with its cookie.
 */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'claude-pet'

/** Only the web server is required; the rest are read softly, when present. */
export const inject = ['webServer']

const API_PREFIX = '/dsh-claude-pet-api'
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HELPER_MAIN = path.join(PKG_ROOT, 'runtime', 'helper', 'main.cjs')

/** Restart backoff for the helper process. */
const RESTART_BASE_MS = 750
const RESTART_MAX_MS = 30000
const RESTART_MAX_FAILURES = 12
/** A helper that lived this long is considered healthy again. */
const STABLE_MS = 180000

function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
  return path.join(os.homedir(), '.dsh')
}

function log(...parts) {
  // The host's own console is the only log sink; keep the prefix greppable.
  console.log('[dsh-claude-pet]', ...parts)
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      // The client sends a small snapshot; anything large is not ours.
      if (size > 64 * 1024) {
        req.destroy()
        resolve(undefined)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        resolve(undefined)
      }
    })
    req.on('error', () => resolve(undefined))
  })
}

/**
 * Finds an Electron binary.
 *
 * `dsh-pet` lands one at `$DSH_HOME/electron` and this plugin reuses it rather
 * than shipping a hundred megabytes of runtime. A user can point at another
 * build with `DSH_CLAUDE_PET_ELECTRON`.
 */
function resolveElectron() {
  const candidates = []
  if (typeof process.env.DSH_CLAUDE_PET_ELECTRON === 'string') {
    candidates.push(process.env.DSH_CLAUDE_PET_ELECTRON)
  }
  const home = path.join(dshHome(), 'electron')
  if (process.platform === 'win32') candidates.push(path.join(home, 'electron.exe'))
  else if (process.platform === 'darwin') candidates.push(path.join(home, 'Electron.app', 'Contents', 'MacOS', 'Electron'))
  else candidates.push(path.join(home, 'electron'))
  for (const candidate of candidates) {
    try {
      const stat = fs.statSync(candidate)
      if (stat.isFile() && stat.size > 0) return candidate
    } catch {
      // Try the next one.
    }
  }
  return undefined
}

/**
 * Whether the separate desktop window can run on this machine.
 *
 * Probed on every report rather than once at startup, so that installing
 * Electron later starts working without restarting the app.
 */
function desktopWindowReady() {
  try {
    return resolveElectron() !== undefined
  } catch {
    return false
  }
}

export function apply(ctx) {
  // What the page last told us about itself. The page is the only thing that
  // can see the window's visibility, the user's settings and the language, so
  // this is a mirror rather than a source of truth.
  const snapshot = {
    desktop: false,
    desktopPet: true,
    enabled: true,
    display: 'both',
    name: '',
    size: 100,
    lang: 'zh',
    hidden: false,
  }

  function currentPet() {
    const wants =
      snapshot.desktop === true &&
      snapshot.desktopPet === true &&
      snapshot.enabled === true &&
      (snapshot.display === 'desktop' || snapshot.display === 'both')
    return {
      // Only when the DSH window is out of the way: while it is on screen she
      // is already drawn there, and two of her at once would be one too many.
      show: wants && snapshot.hidden === true,
      name: snapshot.name,
      size: snapshot.size,
      lang: snapshot.lang,
    }
  }

  // ---------------------------------------------------------------------
  // The private server the desktop window polls
  // ---------------------------------------------------------------------

  // A token rather than a port alone: any local process can reach a loopback
  // port, and this one answers questions about the user's account.
  const token = randomBytes(16).toString('hex')
  let hostPort = 0
  /** Bumped on every change the desktop window might care about. */
  let stateVersion = 0

  async function hostHandler(req, res) {
    res.setHeader('cache-control', 'no-store')
    if (req.headers['x-pet-token'] !== token) {
      res.statusCode = 403
      res.end('forbidden')
      return
    }
    const pathname = (typeof req.url === 'string' ? req.url : '/').split('?')[0]
    if (pathname === '/state' && req.method === 'GET') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ version: stateVersion, pet: currentPet() }))
      return
    }
    if (pathname === '/balance' && (req.method === 'POST' || req.method === 'GET')) {
      const result = await queryBalance()
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(result))
      return
    }
    res.statusCode = 404
    res.end('not found')
  }

  const hostServer = http.createServer((req, res) => {
    hostHandler(req, res).catch((error) => {
      log('private server request failed:', error instanceof Error ? error.message : error)
      if (!res.headersSent) res.statusCode = 500
      res.end('error')
    })
  })
  hostServer.on('error', (error) => {
    log('private server error:', error instanceof Error ? error.message : error)
  })
  hostServer.listen(0, '127.0.0.1', () => {
    const address = hostServer.address()
    if (address !== null && typeof address === 'object') hostPort = address.port
    log('private server listening on ' + String(hostPort))
  })

  // ---------------------------------------------------------------------
  // The helper process
  // ---------------------------------------------------------------------

  let child = null
  let failures = 0
  let startedAt = 0
  let restartTimer = null
  let disposed = false
  // Reports arrive every thirty seconds; saying "no Electron" that often would
  // bury everything else in the log.
  let warnedNoElectron = false

  function helperWanted() {
    return currentPet().show === true
  }

  /** The desktop window polls, but a change should not wait for the next tick. */
  function pushState() {
    stateVersion += 1
  }

  function stopHelper() {
    if (restartTimer !== null) {
      clearTimeout(restartTimer)
      restartTimer = null
    }
    if (child === null) return
    const dying = child
    child = null
    try {
      dying.kill()
    } catch {
      // Already gone.
    }
  }

  function scheduleRestart() {
    if (disposed || !helperWanted()) return
    if (failures >= RESTART_MAX_FAILURES) {
      log('desktop helper keeps failing; giving up until the setting is toggled')
      return
    }
    const delay = Math.min(RESTART_MAX_MS, RESTART_BASE_MS * 2 ** failures)
    failures += 1
    if (restartTimer !== null) clearTimeout(restartTimer)
    restartTimer = setTimeout(() => {
      restartTimer = null
      startHelper()
    }, delay)
  }

  function startHelper() {
    if (disposed || child !== null || !helperWanted()) return
    const electron = resolveElectron()
    if (electron === undefined) {
      if (!warnedNoElectron) {
        warnedNoElectron = true
        log('no Electron found; set DSH_CLAUDE_PET_ELECTRON or install the dsh-pet desktop helper')
      }
      return
    }
    warnedNoElectron = false
    const windowFile = path.join(dshHome(), 'dsh-claude-pet', 'desktop-window.json')
    const env = { ...process.env }
    // The host may itself be an Electron app; inheriting this variable makes
    // the helper start as plain Node, fail to find `electron`, and exit 134.
    delete env.ELECTRON_RUN_AS_NODE
    env.DSH_CLAUDE_PET_WINDOW_FILE = windowFile
    env.DSH_CLAUDE_PET_PORT = String(hostPort)
    env.DSH_CLAUDE_PET_TOKEN = token

    let spawned
    try {
      spawned = spawn(electron, [HELPER_MAIN], {
        // Not inside node_modules: Windows refuses to rename a running
        // process's working directory, which breaks later upgrades.
        cwd: dshHome(),
        env,
        // Electron closes its own stdin on start, so a stdin pipe is not a
        // channel to it; the private server above is.
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      log('cannot spawn the desktop helper:', error instanceof Error ? error.message : error)
      scheduleRestart()
      return
    }

    child = spawned
    startedAt = Date.now()
    log('desktop helper started (pid ' + String(spawned.pid) + ')')

    let pending = ''
    spawned.stdout?.on('data', (chunk) => {
      pending += String(chunk)
      let index = pending.indexOf('\n')
      while (index >= 0) {
        const line = pending.slice(0, index).trim()
        pending = pending.slice(index + 1)
        if (line !== '') onHelperLine(line)
        index = pending.indexOf('\n')
      }
    })
    spawned.stderr?.on('data', (chunk) => {
      for (const line of String(chunk).split('\n')) {
        if (line.trim() !== '') log('[helper:err]', line.trim())
      }
    })

    spawned.on('exit', (code, signal) => {
      if (child === spawned) child = null
      if (Date.now() - startedAt >= STABLE_MS) failures = 0
      if (disposed) return
      log('desktop helper exited (code=' + String(code) + ', signal=' + String(signal) + ')')
      scheduleRestart()
    })

    spawned.on('error', (error) => {
      log('desktop helper error:', error instanceof Error ? error.message : error)
    })

    // The window may have started precisely because it is now wanted; tell it
    // what to draw without waiting for the next report.
    pushState()
  }

  function onHelperLine(line) {
    // stdout is a log channel only; anything the window needs it pulls from
    // the private server.
    log('[helper]', line)
  }

  function reconcileHelper() {
    if (helperWanted()) startHelper()
    else stopHelper()
  }

  // ---------------------------------------------------------------------
  // Balance
  // ---------------------------------------------------------------------

  function currentProvider() {
    try {
      const service = ctx.get('agentDefaultModel', false)
      if (!service || typeof service.currentSelection !== 'function') return undefined
      const selection = service.currentSelection()
      if (selection && typeof selection.provider === 'string') return selection.provider
      return undefined
    } catch {
      return undefined
    }
  }

  async function resolveSecret(ref) {
    const credentials = ctx.get('credentials', false)
    if (credentials && typeof credentials.resolve === 'function') {
      try {
        const resolved = await credentials.resolve(ref)
        const value =
          typeof resolved === 'string'
            ? resolved
            : resolved && (resolved.value ?? resolved.secret ?? resolved.key)
        if (typeof value === 'string' && value !== '') return value
      } catch {
        // Fall through to the environment.
      }
    }
    const fromEnv = process.env[ref]
    return typeof fromEnv === 'string' && fromEnv !== '' ? fromEnv : undefined
  }

  function moneyOf(value) {
    const number = Number(value)
    if (!Number.isFinite(number)) return String(value ?? '0')
    return number.toFixed(2)
  }

  async function balanceOfficial(provider) {
    const key = await resolveSecret('DEEPSEEK_API_KEY')
    if (key === undefined) return { kind: 'missing', provider, message: 'DEEPSEEK_API_KEY' }
    let response
    try {
      response = await fetch('https://api.deepseek.com/user/balance', {
        headers: { authorization: 'Bearer ' + key },
        signal: AbortSignal.timeout(20000),
      })
    } catch (error) {
      return { kind: 'failed', provider, message: error instanceof Error ? error.message : String(error) }
    }
    if (!response.ok) return { kind: 'failed', provider, message: 'HTTP ' + String(response.status) }
    let body
    try {
      body = await response.json()
    } catch {
      return { kind: 'failed', provider, message: 'unreadable response' }
    }
    const infos = Array.isArray(body?.balance_infos) ? body.balance_infos : []
    if (infos.length === 0) return { kind: 'failed', provider, message: 'no balance_infos' }
    const wallets = infos.map((info) => ({
      currency: typeof info?.currency === 'string' ? info.currency : 'CNY',
      total: moneyOf(info?.total_balance),
    }))
    return { kind: 'ok', provider, wallets }
  }

  async function balanceAccount(provider) {
    const account = ctx.get('deepseekAccount', false)
    if (!account || typeof account.getBalance !== 'function') {
      return { kind: 'missing', provider, message: 'account service unavailable' }
    }
    let result
    try {
      result = await account.getBalance({
        version: '1.0.0',
        locale: snapshot.lang === 'en' ? 'en' : 'zh-CN',
        timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
      })
    } catch (error) {
      return { kind: 'failed', provider, message: error instanceof Error ? error.message : String(error) }
    }
    if (!result) return { kind: 'failed', provider, message: 'not signed in' }
    if (result.status !== 'ready') {
      return { kind: 'failed', provider, message: String(result.status ?? 'unavailable') }
    }
    const byCurrency = new Map()
    const add = (raw) => {
      if (!raw || typeof raw.currency !== 'string' || raw.currency === '') return
      const amount = Number(raw.balance)
      if (!Number.isFinite(amount)) return
      byCurrency.set(raw.currency, (byCurrency.get(raw.currency) ?? 0) + amount)
    }
    for (const raw of Array.isArray(result.value) ? result.value : []) add(raw)
    for (const raw of Array.isArray(result.bonusWallets) ? result.bonusWallets : []) add(raw)
    if (byCurrency.size === 0) return { kind: 'failed', provider, message: 'no wallets' }
    const wallets = [...byCurrency.entries()].map(([currency, total]) => ({
      currency,
      total: total.toFixed(2),
    }))
    return { kind: 'ok', provider, wallets }
  }

  async function queryBalance() {
    const provider = currentProvider()
    if (provider === undefined) return { kind: 'failed', message: 'no provider selected' }
    if (provider === 'deepseek-account') return balanceAccount(provider)
    // A DeepSeek-hosted endpoint (under any route key the user gave it) can be
    // asked directly; everything else — a proxy, a gateway, a third-party
    // OpenAI-compatible base URL — has no balance API this plugin can trust.
    // Saying so is the honest answer; inventing a number would not be.
    if (provider.toLowerCase().includes('deepseek')) return balanceOfficial(provider)
    return { kind: 'unsupported', provider }
  }

  // ---------------------------------------------------------------------
  // Routes for the in-page client
  // ---------------------------------------------------------------------

  async function handler(req, res) {
    res.setHeader('access-control-allow-origin', '*')
    res.setHeader('access-control-allow-headers', 'content-type')
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
    res.setHeader('cache-control', 'no-store')

    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.end()
      return
    }

    const rawUrl = typeof req.url === 'string' ? req.url : '/'
    const pathname = rawUrl.split('?')[0]
    const rest = pathname.startsWith(API_PREFIX) ? pathname.slice(API_PREFIX.length) : pathname

    if (rest === '/report' && req.method === 'POST') {
      const body = await readJsonBody(req)
      if (body === undefined) {
        res.statusCode = 400
        res.end('bad request')
        return
      }
      if (typeof body.desktop === 'boolean') snapshot.desktop = body.desktop
      if (typeof body.desktopPet === 'boolean') snapshot.desktopPet = body.desktopPet
      if (typeof body.enabled === 'boolean') snapshot.enabled = body.enabled
      if (typeof body.display === 'string') snapshot.display = body.display
      if (typeof body.name === 'string') snapshot.name = body.name
      if (Number.isFinite(body.size)) snapshot.size = Number(body.size)
      if (body.lang === 'zh' || body.lang === 'en') snapshot.lang = body.lang
      if (typeof body.hidden === 'boolean') snapshot.hidden = body.hidden
      pushState()
      reconcileHelper()
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true, electron: desktopWindowReady() }))
      return
    }

    if (rest === '/balance' && (req.method === 'POST' || req.method === 'GET')) {
      const result = await queryBalance()
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(result))
      return
    }

    res.statusCode = 404
    res.end('not found')
  }

  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler,
    })
    return () => {
      disposed = true
      stopHelper()
      try {
        hostServer.close()
      } catch {
        // Already closed.
      }
      try {
        if (typeof dispose === 'function') dispose()
        else if (dispose && typeof dispose.dispose === 'function') dispose.dispose()
      } catch {
        // Unloading anyway.
      }
    }
  }, 'dsh-claude-pet: local api and desktop helper')
}
