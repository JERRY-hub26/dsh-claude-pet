'use strict'

/**
 * The desktop window.
 *
 * A second, transparent, always-on-top window that lives in a process of its
 * own, so it keeps standing on the desktop while the DSH window is minimised
 * to the tray. It shows one pet and a bubble.
 *
 * The host runs a small private server on a loopback port for this window
 * alone; the port and the token arrive in the environment. Polling it is not
 * elegant, but Electron closes its own stdin as it starts, so a pipe back into
 * the app is not available, and the DSH web server proper is behind an auth
 * gate this `file://` page cannot satisfy.
 *
 * The window is a lot larger than the pet: the sprite sits near the bottom,
 * the bubble grows upwards, and the context menu opens wherever the cursor
 * is. Everything except those three regions is click-through, so a
 * four-hundred-pixel square of glass does not eat the user's desktop clicks.
 */

const { app, BrowserWindow, ipcMain, screen } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const WINDOW_W = 400
const WINDOW_H = 460
const PET_BOTTOM = 96

/** How often the window looks for a change, and how long a request may hang. */
const POLL_MS = 400
const REQUEST_TIMEOUT_MS = 4000
/** Polling that fails this many times in a row means the host is gone. */
const MAX_MISSES = 60

const HOST_PORT = String(process.env.DSH_CLAUDE_PET_PORT || '')
const HOST_TOKEN = String(process.env.DSH_CLAUDE_PET_TOKEN || '')
const HOST_BASE = HOST_PORT === '' ? '' : 'http://127.0.0.1:' + HOST_PORT

const POSITION_FILE = String(process.env.DSH_CLAUDE_PET_WINDOW_FILE || '')

// A transparent layered window on Windows picks up black edges and flickers
// under DWM compositing unless the GPU path is taken out of it. The same is
// true of the GPU sandbox, which also trips on some driver versions.
if (process.platform === 'win32') {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu-sandbox')
}

app.setName('dsh-claude-pet')

let win = null
let interactive = false
let drag = null
let quitting = false

// ---------------------------------------------------------------------------
// The private server
// ---------------------------------------------------------------------------

let stateVersion = -1
let misses = 0
let pollTimer = null

/** Messages that arrived before the page could receive them. */
const pending = []

function deliver(message) {
  if (win === null || win.isDestroyed()) return false
  // A page that is still loading cannot receive; queue instead of dropping,
  // because the version would otherwise advance past the message it never got.
  if (win.webContents.isLoading()) {
    pending.push(message)
    return false
  }
  win.webContents.send('pet:message', message)
  return true
}

function flushPending() {
  if (win === null || win.isDestroyed() || win.webContents.isLoading()) return
  const queued = pending.splice(0)
  for (const message of queued) win.webContents.send('pet:message', message)
}

async function request(pathname, method) {
  const response = await fetch(HOST_BASE + pathname, {
    method: method || 'GET',
    headers: { 'x-pet-token': HOST_TOKEN },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error('HTTP ' + String(response.status))
  return response.json()
}

async function pollState() {
  if (HOST_BASE === '') return
  try {
    const data = await request('/state')
    misses = 0
    if (data !== null && typeof data === 'object' && data.version !== stateVersion) {
      console.log('[dsh-claude-pet] state v' + String(data.version) + ': ' + JSON.stringify(data.pet))
      // Only remember the version once the page has it, or a message sent
      // while the page was loading would be lost for good.
      if (deliver({ type: 'state', pet: data.pet })) stateVersion = data.version
      else stateVersion = -1
    }
  } catch {
    misses += 1
    // The host is gone (quit, reloaded, crashed). Nothing will ever answer
    // again, so the window closes rather than lingering on the desktop.
    if (misses >= MAX_MISSES) {
      console.log('[dsh-claude-pet] host unreachable; quitting')
      quitting = true
      app.quit()
      return
    }
  }
  if (pollTimer !== null) clearTimeout(pollTimer)
  pollTimer = setTimeout(() => {
    pollTimer = null
    pollState()
  }, POLL_MS)
}

async function askBalance() {
  if (HOST_BASE === '') {
    deliver({ type: 'balance', result: { kind: 'failed', message: 'no host' } })
    return
  }
  try {
    deliver({ type: 'balance', result: await request('/balance', 'POST') })
  } catch (error) {
    deliver({
      type: 'balance',
      result: { kind: 'failed', message: error instanceof Error ? error.message : String(error) },
    })
  }
}

function readPosition() {
  try {
    const raw = JSON.parse(fs.readFileSync(POSITION_FILE, 'utf8'))
    if (Number.isFinite(raw.x) && Number.isFinite(raw.y)) {
      return { x: Math.round(raw.x), y: Math.round(raw.y) }
    }
  } catch {
    // First run, or the file was removed: fall through to the default spot.
  }
  const { workArea } = screen.getPrimaryDisplay()
  return {
    x: workArea.x + workArea.width - WINDOW_W - 40,
    y: workArea.y + workArea.height - WINDOW_H - 20,
  }
}

function savePosition(bounds) {
  if (POSITION_FILE === '') return
  try {
    fs.mkdirSync(path.dirname(POSITION_FILE), { recursive: true })
    fs.writeFileSync(POSITION_FILE, JSON.stringify({ x: bounds.x, y: bounds.y }))
  } catch (error) {
    console.error('[dsh-claude-pet] cannot save the window position', error)
  }
}

/** Keeps at least part of the window on a real monitor after a drag. */
function clampToDisplays(x, y) {
  const displays = screen.getAllDisplays()
  const fits = displays.some((display) => {
    const area = display.workArea
    return (
      x + WINDOW_W > area.x + 24 &&
      x < area.x + area.width - 24 &&
      y + WINDOW_H > area.y + 24 &&
      y < area.y + area.height - 24
    )
  })
  if (fits) return { x: Math.round(x), y: Math.round(y) }
  const { workArea } = screen.getPrimaryDisplay()
  return {
    x: Math.round(Math.min(Math.max(x, workArea.x), workArea.x + workArea.width - WINDOW_W)),
    y: Math.round(Math.min(Math.max(y, workArea.y), workArea.y + workArea.height - WINDOW_H)),
  }
}

/**
 * Click-through is one flag, and Electron has no getter for it, so the value
 * is mirrored here. `forward` is what keeps pointer movement arriving while
 * the window is transparent to the mouse, which is the only way the page can
 * tell when the cursor has come back over the pet.
 */
function setInteractive(next) {
  if (win === null || win.isDestroyed() || interactive === next) return
  interactive = next
  win.setIgnoreMouseEvents(!next, { forward: true })
}

function keepOnTop() {
  if (win === null || win.isDestroyed()) return
  win.setAlwaysOnTop(true, process.platform === 'darwin' ? 'floating' : 'screen-saver')
}

function createWindow() {
  const position = clampToDisplays(readPosition().x, readPosition().y)

  win = new BrowserWindow({
    width: WINDOW_W,
    height: WINDOW_H,
    x: position.x,
    y: position.y,
    show: false,
    useContentSize: true,
    enableLargerThanScreen: true,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    focusable: true,
    title: 'Claude Pet',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  })

  win.setAlwaysOnTop(true, process.platform === 'darwin' ? 'floating' : 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.webContents.setBackgroundThrottling(false)
  // The menu is ours; a native one would draw stock chrome over a custom pet.
  win.webContents.on('context-menu', (event) => event.preventDefault())

  win.loadFile(path.join(__dirname, 'index.html'))
  win.webContents.on('did-finish-load', () => {
    // A state may already have arrived while the page was loading; polling
    // again here is what makes the first frame show the right thing.
    flushPending()
    pollState()
  })

  win.once('ready-to-show', () => {
    // Not shown here: the page decides. It asks the host whether she belongs
    // on the desktop at all, and only then calls `pet:set-visible` —showing
    // first and hiding a frame later would flash her over the user's window.
    setInteractive(false)
  })

  win.on('closed', () => {
    win = null
  })

  // Two watchdogs, because the compositor demotes an always-on-top window on
  // its own schedule (a game going full screen, a workspace switch, a shell
  // restart), and a pet that has sunk behind the desktop is simply gone.
  const topTimer = setInterval(keepOnTop, 1000)
  const taskbarTimer = setInterval(() => {
    if (win === null || win.isDestroyed()) return
    if (process.platform === 'win32') win.setSkipTaskbar(true)
  }, 3000)
  win.on('closed', () => {
    clearInterval(topTimer)
    clearInterval(taskbarTimer)
  })
}

ipcMain.on('pet:interactive', (_event, next) => {
  setInteractive(next === true)
})

ipcMain.on('pet:drag-start', () => {
  if (win === null || win.isDestroyed()) return
  drag = { cursor: screen.getCursorScreenPoint(), bounds: win.getBounds() }
})

ipcMain.on('pet:drag-move', () => {
  if (win === null || win.isDestroyed() || drag === null) return
  const cursor = screen.getCursorScreenPoint()
  const next = clampToDisplays(
    drag.bounds.x + (cursor.x - drag.cursor.x),
    drag.bounds.y + (cursor.y - drag.cursor.y),
  )
  win.setBounds({ x: next.x, y: next.y, width: WINDOW_W, height: WINDOW_H })
})

ipcMain.on('pet:drag-end', () => {
  if (win === null || win.isDestroyed() || drag === null) return
  drag = null
  savePosition(win.getBounds())
})

ipcMain.on('pet:set-visible', (_event, next) => {
  if (win === null || win.isDestroyed()) return
  if (next === true) {
    keepOnTop()
    win.showInactive()
    console.log('[dsh-claude-pet] shown at ' + JSON.stringify(win.getBounds()))
  } else {
    setInteractive(false)
    win.hide()
    console.log('[dsh-claude-pet] hidden')
  }
})

ipcMain.on('pet:ask', (_event, what) => {
  if (what === 'balance') askBalance()
  else pollState()
})

ipcMain.on('pet:quit', () => {
  quitting = true
  app.quit()
})

ipcMain.on('pet:log', (_event, message) => {
  console.log('[dsh-claude-pet] ' + String(message))
})

const primary = app.requestSingleInstanceLock()
if (!primary) {
  console.log('[dsh-claude-pet] another desktop window is already running; leaving it alone')
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win !== null && !win.isDestroyed()) keepOnTop()
  })

  app.whenReady().then(() => {
    console.log('[dsh-claude-pet] electron ready')
    createWindow()
  })

  app.on('window-all-closed', () => {
    console.log('[dsh-claude-pet] all windows closed')
    if (!quitting) app.quit()
  })
}
