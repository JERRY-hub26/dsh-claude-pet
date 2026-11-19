# Claude pet

A floating study companion for the DSH Web GUI: the same orange-haired character
that already runs in the DSH Android app's native bubble. The in-app pet is a
pure Client-side plugin; the desktop window that survives minimising is a small
Electron process of our own, because DSH exposes no window API (see *Desktop
window*).

## What she does

- **Sits wherever you put her.** Docked to any of the four corners with
  adjustable margins, or dragged anywhere on the frame; a dragged position is
  remembered across reloads.
- **Blinks on an uneven rhythm.** Three blinks per 9.2 s cycle at intervals of
  1.0 s, 4.4 s and 6.1 s, each closing for about 0.15 s. The blink is a CSS
  keyframe over a two-frame sprite sheet — no JavaScript timer, so it also works
  inside the dynamic package sandbox where `setTimeout` does not exist.
- **Breathes and shifts her weight** with three slow, independently-perioded
  transforms (4.4 s bob, 7.3 s sway, 19.7 s weight shift). All three are small
  enough to read as posture rather than animation, and all stop under
  `prefers-reduced-motion` — the blink stays, because a pet that never blinks
  looks like a broken image.
- **Swaps artwork with the session's state**: idle (holding a book), thinking
  (raising a magnifier), working (writing with a quill — the whole figure rocks
  around the point where the nib meets the page, since the artwork has no
  separate arm layer).
- **Occasionally says a line** in character, every 24–52 s, for about five
  seconds. Lines follow her current pose; the voice is a well-mannered honours
  student who is very good at what she does and quietly resents the rules she is
  held to.
- **Reacts when poked**, with a small squash-and-hop and a line of dialogue.
- **Can be closed** with the × that appears on hover, or reopened from settings.
- **Has a right-click menu** with exactly two entries: 碎碎念 (say something now)
  and 查看余额 (ask the provider for the current balance).
- **Answers to a name you choose** — empty means the default, Claude.
- **Stays on the desktop when the app is minimised.** A separate transparent,
  always-on-top Electron window carries the same pet, bubble and menu, so she is
  still there once the DSH window has gone to the tray. See *Desktop window*.

## Speech bubbles

Paper-white (`#fcfbf8`), 1.14 em corners, a soft two-layer shadow and a small
tail that sits under her head; the text is 500-weight at
`clamp(11px, w × 0.105, 15px)`, so it grows with the pet.
The balloon is `width: max-content` capped at `2 × w`: absolute positioning
alone would shrink it into her own 120 px box and wrap every line there. With
the cap in place a whole line of dialogue lands on one row at about 1.9 × her
width. An optional second line
carries the quiet detail (a provider name, a hint); `data-tone="alert"` turns the
first line `#c0392b` for refusals such as an unsupported balance provider.

## Balance

`查看余额` asks the host, which is the only place allowed to touch credentials:

- provider comes from `agentDefaultModel.currentSelection().provider`;
- `deepseek-account` → `deepseekAccount.getBalance({version, locale, timezoneOffsetSeconds})`,
  wallets and bonus wallets summed per currency;
- anything whose id contains `deepseek` → `GET https://api.deepseek.com/user/balance`
  with `DEEPSEEK_API_KEY` from the credential store (or the environment);
- every other provider is answered locally with
  `{kind: 'unsupported', provider}` — the bubble then reads 当前服务商暂不支持余额查询,
  with 当前服务商：<id> underneath. This is the common case: a third-party route
  such as `gah` has no balance endpoint to ask.

## Settings

Two places, both additive:

- **Settings → Claude pet** (`settings.section`, with its own sidebar icon) is
  the full page: current state, show/hide for the desktop app and for the
  browser separately, size, corner, margins, and quick actions.
- **Settings → General → Claude pet** (`settings.general.item`) is the compact
  row: two switches and a reset button.

Everything is one switch, slider, segmented choice, picture of the four corners
or a single-line name field — nothing here needs the user to know what a "margin"
is. Changes apply immediately; sliders persist on release rather than on every
frame, and the name persists on blur.

Distinguishing "desktop app" from "browser" uses `'dshDesktop' in globalThis`,
the same test the shipped settings pages use.

## State bridge

The engine exposes no "thinking" flag. `SessionStatus.running` is a single
boolean, so this plugin derives three poses:

1. **Which session?** The one with `retainedBy.mainView > 0` — the same test
   `ui-session` and `ui-workspace` use internally. Background sessions are
   deliberately ignored: following any running session would drag her into a
   pose about work that is not on screen.
2. **Which pose?** From the Chat projection's `legacy` slice:
   `runningCalls[].phase === 'start'` means a tool is really executing
   (working); a `preparing` call or a non-null `partial` means the model is
   still writing (thinking); otherwise the open turn is thinking, and no turn is
   idle. `phase` is the only signal that separates "the model is still emitting
   this call's arguments" from "the tool is running".

The bridge is attached through `ctx.inject(['sessions', 'uiConversation'], …)`,
so if the session layer is absent she still appears and sits idle.

## Desktop window

DSH has no window API at all — the preload bridge exposes `dshDesktop` with
device info, file actions and updates, and nothing about windows. The desktop pet
is therefore a second Electron process, started by this plugin's host half from
`$DSH_HOME/electron` (the copy dsh-pet installs; `DSH_CLAUDE_PET_ELECTRON`
overrides it).

- **Why a private server.** The window's page is loaded from `file://`, so it has
  no cookie for the app's authenticated web server. The host opens
  `127.0.0.1:0` with a random per-session token, passes port and token through the
  environment, and answers two questions: `GET /state` (a version counter plus
  who to show) and `POST /balance`.
- **Why polling, not stdin.** An Electron main process has no usable stdin — the
  pipe is at EOF before `ready` fires. The window polls `/state` every 400 ms and
  only re-renders when the version changes; 60 consecutive failures mean the host
  is gone, and the window quits instead of outliving it.
- **Why the page decides visibility.** The client half reports
  `document.visibilityState === 'hidden'` (minimised or in the tray), the pet
  setting and the desktop flag. The window is only spawned — and only shown —
  while all three agree, so there is never a desktop copy standing next to the
  in-app one.
- **Window recipe.** `transparent`, `frame: false`, `alwaysOnTop` at
  `screen-saver` level, `skipTaskbar`, `hasShadow: false`, `show: false`, shown
  with `showInactive()`; a 1 s watchdog re-asserts topmost and a 3 s one
  re-asserts `skipTaskbar`, because the compositor demotes both on its own
  schedule. Click-through is `setIgnoreMouseEvents(!over, {forward: true})`,
  driven by the page's `elementFromPoint`.
- **Assets in a `file://` page.** The CSP is `default-src 'none'` plus
  `img-src 'self' data: file:`; without the explicit `file:` the sprites are
  blocked and the window looks empty.
- **Missing Electron is a degraded mode, not an error.** `POST /report` answers
  `{ok, electron, electronState}`, where `electron` is a fresh probe of the same
  lookup the spawn uses and `electronState` says whether a download is under way.
  The settings switch is disabled and explains itself when it is `false`.
  Probing per report (not once at startup) means installing Electron later starts
  working without an app restart.
- **The missing runtime downloads itself, once.** `startHelper()` calls
  `ensureElectron()`, which fetches the official Electron 43.3.0 zip into
  `$DSH_HOME/electron` and unpacks it there — the same directory dsh-pet uses, so
  a machine that already runs dsh-pet never downloads twice. Mirrors first
  (`npmmirror`, then GitHub), any of them overridable with
  `DSH_CLAUDE_PET_ELECTRON_MIRROR`; `DSH_CLAUDE_PET_NO_DOWNLOAD=1` turns it off.
  Extraction shells out to `tar` (libarchive on Windows/macOS reads zip) and falls
  back to `unzip` on Linux, which keeps the package dependency-free. The download
  only starts when the window is actually wanted, i.e. when the app is minimised
  with the setting on — never at startup.

  - **The desktop window mirrors her pose.** The page reports `mode` (`idle` / `thinking` /
    `working`) with every `/report`, the host keeps it in the snapshot, and the window swaps
    `#figure[data-mode]` — so the magnifier and the quill show up on the desktop too, not just
    in the app.
## Layout facts this plugin relies on

- `shell.overlay` is a list slot whose layer is `pointer-events: none`; every
  occupant opts back into pointer events itself.
- The layer is `position: absolute; inset: 0` at `z-index: 20`, so the pet uses
  `position: fixed` coordinates within it and keeps a `z-index` above the layer.
- `settings.section` renders into the settings content column and
  `settings.section.icon` inline beside its nav label; an icon registration
  only shows when its `id` matches the section's.
- Reading an un-injected service off `ctx` throws — the context is a strict
  getter — so optional services must come from `ctx.inject`, never from
  `ctx.something`.

## Assets

`assets/idle-sheet.png` is a 720×402 one-row two-column sprite sheet (left frame
eyes open, right frame eyes closed), and `assets/think.png` / `assets/work.png`
are single 360×402 frames. They are served from the engine's plugin asset route
at `/plugins/dsh-claude-pet/assets/<file>`, which requires each path to appear in
this package's `exports` map.

Every size in the stylesheet is expressed against `--dsh-cp-w` / `--dsh-cp-h`,
so the size slider is a pure style change: nothing has to be re-measured, and
the blinking frame offset (`calc(var(--dsh-cp-w) * -1)`) stays correct at any
scale.
