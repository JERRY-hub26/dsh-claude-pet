'use strict'

/**
 * The desktop pet's behaviour.
 *
 * The page owns the pet, the balloon and the menu; the main process owns the
 * window and the pipe to the host. Everything else arrives as messages: how
 * the DSH window is doing (which is the whole reason this window exists),
 * what to call her, how large she is, and the answer to a balance query.
 */

;(function main() {
  const pet = document.getElementById('pet')
  const figure = document.getElementById('figure')
  const bubble = document.getElementById('bubble')
  const bubbleText = document.getElementById('bubbleText')
  const bubbleSub = document.getElementById('bubbleSub')
  const menu = document.getElementById('menu')

  const state = {
    lang: 'zh',
    name: '',
    size: 100,
    visible: false,
  }

  let bubbleTimer = 0
  let chatterTimer = 0
  let pokeTimer = 0
  let drag = null
  let menuOpen = false
  let greeted = false

  const lines = () => window.PET_LINES[state.lang] || window.PET_LINES.zh
  const pick = (list) => list[Math.floor(Math.random() * list.length)]

  // ---------------------------------------------------------------------
  // Appearance
  // ---------------------------------------------------------------------

  function applySize() {
    const scale = Math.min(2, Math.max(0.6, (Number(state.size) || 100) / 100))
    const width = Math.round(120 * scale)
    const height = Math.round(134 * scale)
    document.documentElement.style.setProperty('--w', width + 'px')
    document.documentElement.style.setProperty('--h', height + 'px')
  }

  // ---------------------------------------------------------------------
  // The balloon
  // ---------------------------------------------------------------------

  function showBubble(text, sub, tone, holdMs) {
    if (typeof text !== 'string' || text === '') return
    bubbleText.textContent = text
    if (typeof sub === 'string' && sub !== '') {
      bubbleSub.textContent = sub
      bubbleSub.hidden = false
    } else {
      bubbleSub.textContent = ''
      bubbleSub.hidden = true
    }
    bubble.dataset.tone = tone === 'alert' ? 'alert' : 'plain'
    bubble.hidden = false
    if (bubbleTimer !== 0) clearTimeout(bubbleTimer)
    bubbleTimer = setTimeout(() => {
      bubble.hidden = true
      bubbleTimer = 0
    }, holdMs || 5200)
  }

  function sayIdle() {
    const table = lines()
    const pool = Math.random() < 0.22 ? table.mood : table.idle
    showBubble(pick(pool), null, 'plain', 5200)
  }

  function scheduleChatter() {
    if (chatterTimer !== 0) clearTimeout(chatterTimer)
    // Uneven intervals on purpose: a metronome is what makes a companion
    // read as a widget rather than as someone whiling the time away.
    const delay = 24000 + Math.random() * 28000
    chatterTimer = setTimeout(() => {
      chatterTimer = 0
      if (state.visible && !menuOpen) sayIdle()
      scheduleChatter()
    }, delay)
  }

  // ---------------------------------------------------------------------
  // Which parts of the window take the mouse
  // ---------------------------------------------------------------------

  function overControls(x, y) {
    if (menuOpen) return true
    const element = document.elementFromPoint(x, y)
    if (element === null) return false
    return element.closest('#pet, #bubble, #menu') !== null
  }

  window.addEventListener('mousemove', (event) => {
    if (drag !== null) return
    window.desktopPet.interactive(overControls(event.clientX, event.clientY))
  })

  window.addEventListener('mouseleave', () => {
    if (drag === null) window.desktopPet.interactive(false)
  })

  // ---------------------------------------------------------------------
  // Dragging and poking
  // ---------------------------------------------------------------------

  pet.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    event.preventDefault()
    closeMenu()
    pet.setPointerCapture(event.pointerId)
    drag = { x: event.screenX, y: event.screenY, moved: false }
    pet.classList.add('is-dragging')
    window.desktopPet.dragStart()
  })

  pet.addEventListener('pointermove', (event) => {
    if (drag === null) return
    if (!drag.moved) {
      const travelled = Math.abs(event.screenX - drag.x) + Math.abs(event.screenY - drag.y)
      if (travelled < 4) return
      drag.moved = true
    }
    window.desktopPet.dragMove()
  })

  function endDrag(event) {
    if (drag === null) return
    const moved = drag.moved
    drag = null
    pet.classList.remove('is-dragging')
    if (pet.hasPointerCapture(event.pointerId)) pet.releasePointerCapture(event.pointerId)
    if (moved) {
      window.desktopPet.dragEnd()
      return
    }
    // A tap, not a drag: a small hop and a line, the same reaction the
    // in-page pet gives.
    figure.classList.remove('is-poked')
    void figure.offsetWidth
    figure.classList.add('is-poked')
    if (pokeTimer !== 0) clearTimeout(pokeTimer)
    pokeTimer = setTimeout(() => {
      figure.classList.remove('is-poked')
      pokeTimer = 0
    }, 640)
    showBubble(pick(lines().poke), null, 'plain', 3200)
  }

  pet.addEventListener('pointerup', endDrag)
  pet.addEventListener('pointercancel', endDrag)

  // ---------------------------------------------------------------------
  // Menu: two items, and nothing else
  // ---------------------------------------------------------------------

  function openMenu(x, y) {
    closeMenu()
    const table = lines()
    menu.textContent = ''
    for (const item of [
      { label: table.ui.chatter, run: sayIdle },
      { label: table.ui.balance, run: checkBalance },
    ]) {
      const row = document.createElement('div')
      row.className = 'item'
      row.textContent = item.label
      row.addEventListener('pointerdown', (event) => event.stopPropagation())
      row.addEventListener('click', () => {
        closeMenu()
        item.run()
      })
      menu.appendChild(row)
    }
    menu.hidden = false
    const rect = menu.getBoundingClientRect()
    const left = Math.min(Math.max(6, x - 10), window.innerWidth - rect.width - 6)
    const top = Math.min(Math.max(6, y - 10), window.innerHeight - rect.height - 6)
    menu.style.left = left + 'px'
    menu.style.top = top + 'px'
    menuOpen = true
    window.desktopPet.interactive(true)
  }

  function closeMenu() {
    if (!menuOpen && menu.hidden) return
    menuOpen = false
    menu.hidden = true
    menu.textContent = ''
  }

  window.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    const target = event.target
    const onPet = target instanceof Element && target.closest('#pet') !== null
    if (!onPet) {
      closeMenu()
      return
    }
    openMenu(event.clientX, event.clientY)
  })

  window.addEventListener('pointerdown', (event) => {
    if (!menuOpen) return
    const target = event.target
    if (target instanceof Element && target.closest('#menu') !== null) return
    closeMenu()
  })

  window.addEventListener('blur', closeMenu)

  // ---------------------------------------------------------------------
  // Balance
  // ---------------------------------------------------------------------

  function symbolOf(currency) {
    if (currency === 'CNY') return '¥'
    if (currency === 'USD') return '$'
    return typeof currency === 'string' && currency !== '' ? currency + ' ' : ''
  }

  function renderBalance(data) {
    const ui = lines().ui
    const provider = data && data.provider ? String(data.provider) : ui.unknown
    if (!data || typeof data !== 'object') {
      showBubble(ui.failed, ui.offline, 'alert', 8000)
      return
    }
    if (data.kind === 'unsupported') {
      showBubble(ui.unsupported, ui.provider + provider, 'alert', 9000)
      return
    }
    if (data.kind === 'missing') {
      showBubble(ui.missing, data.message ? String(data.message) : '', 'alert', 9000)
      return
    }
    if (data.kind === 'failed') {
      showBubble(ui.failed, data.message ? String(data.message) : '', 'alert', 9000)
      return
    }
    const wallets = Array.isArray(data.wallets) ? data.wallets : []
    if (wallets.length === 0) {
      showBubble(ui.empty, null, 'plain', 8000)
      return
    }
    const text = wallets
      .map((wallet) => symbolOf(wallet.currency) + String(wallet.total))
      .join('   ·   ')
    showBubble(text, ui.provider + provider, 'plain', 11000)
  }

  async function checkBalance() {
    showBubble(lines().ui.checking, null, 'plain', 1800)
    window.desktopPet.ask('balance')
  }

  // ---------------------------------------------------------------------
  // Being told what to do
  // ---------------------------------------------------------------------

  function show() {
    if (state.visible) return
    state.visible = true
    window.desktopPet.setVisible(true)
    if (!greeted) {
      greeted = true
      showBubble(pick(lines().greet), null, 'plain', 4200)
    }
    scheduleChatter()
  }

  function hide() {
    if (!state.visible) return
    state.visible = false
    closeMenu()
    bubble.hidden = true
    if (chatterTimer !== 0) {
      clearTimeout(chatterTimer)
      chatterTimer = 0
    }
    window.desktopPet.setVisible(false)
  }

  function applyRemote(remote) {
    if (!remote || typeof remote !== 'object') return
    state.lang = remote.lang === 'en' ? 'en' : 'zh'
    state.name = typeof remote.name === 'string' ? remote.name : ''
    pet.title = state.name
    if (typeof remote.size === 'number' && remote.size !== state.size) {
      state.size = remote.size
      applySize()
    }
    if (remote.show === true) show()
    else hide()
  }

  function onMessage(message) {
    if (message === null || typeof message !== 'object') return
    if (message.type === 'state') {
      applyRemote(message.pet)
      return
    }
    if (message.type === 'balance') {
      renderBalance(message.result)
    }
  }

  applySize()
  window.desktopPet.onMessage(onMessage)
  // The host answers with the current state, so a window that starts after the
  // DSH window is already minimised does not have to wait for a change event.
  window.desktopPet.ask('state')
})()
