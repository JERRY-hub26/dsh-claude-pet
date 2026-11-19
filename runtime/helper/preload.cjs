'use strict'

/**
 * The only door between the pet page and the window it lives in.
 *
 * The page is a plain web page with no Node access; dragging a window,
 * toggling click-through and showing or hiding the whole thing are the three
 * things it cannot do for itself.
 */

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktopPet', {
  /** Tells the window whether the cursor is over something clickable. */
  interactive(next) {
    ipcRenderer.send('pet:interactive', next === true)
  },
  dragStart() {
    ipcRenderer.send('pet:drag-start')
  },
  dragMove() {
    ipcRenderer.send('pet:drag-move')
  },
  dragEnd() {
    ipcRenderer.send('pet:drag-end')
  },
  /** Shows or hides the window entirely, without closing it. */
  setVisible(next) {
    ipcRenderer.send('pet:set-visible', next === true)
  },
  /** One JSON line from the host: `{ type: 'state' | 'balance', ... }`. */
  onMessage(callback) {
    const listener = (_event, message) => callback(message)
    ipcRenderer.on('pet:message', listener)
    return () => ipcRenderer.removeListener('pet:message', listener)
  },
  /** Asks the host a question; the answer arrives through `onMessage`. */
  ask(what) {
    ipcRenderer.send('pet:ask', String(what))
  },
  quit() {
    ipcRenderer.send('pet:quit')
  },
  log(message) {
    ipcRenderer.send('pet:log', String(message))
  },
})
