/**
 * Client half of the Claude pet.
 *
 * She is a single additive occupant of `shell.overlay`: the frame-wide,
 * click-through floating layer the shell already provides outside every
 * column's scroll container. Everything she does is either a CSS animation or
 * a push from a service we subscribe to — dynamic packages have no
 * `setTimeout`/`setInterval`, so timers go through `ctx.timer`.
 *
 * Why nested boxes instead of one element:
 * two animations that both animate `transform` on the same element do not
 * compose — the later one simply wins. Giving each transform its own element
 * lets breathing, weight-shifting, the posture readjust and the writing hand
 * run on independent periods, so their sum never visibly repeats.
 *
 *   .dsh-claude-pet           placement + drag target (fixed, no transform)
 *   .dsh-claude-pet__shadow   static ground shadow, outside the animated subtree
 *   .dsh-claude-pet__shift    rare posture readjust   (19.7s)
 *   .dsh-claude-pet__sway     slow weight shift       (7.3s)
 *   .dsh-claude-pet__bob      breathing               (4.4s)
 *   .dsh-claude-pet__write    the writing hand        (working only, ~1.5s)
 *   .dsh-claude-pet__poke     one-shot reaction to a poke
 *   .dsh-claude-pet__figure   the sprite + blink      (9.2s, 3 uneven blinks)
 *
 * Every dimension she draws at comes from two custom properties on the outer
 * box (`--dsh-cp-w` / `--dsh-cp-h`), so the size slider is a pure style change
 * — no re-measure, no second sprite, nothing to keep in sync.
 *
 * Three deliberate constraints, all learned the hard way:
 *
 * 1. No `filter` anywhere. A drop shadow used to hang off the sprite, which
 *    was stable until the boxes above it started animating `transform`: a
 *    filtered element under an animating, composited ancestor has to be
 *    re-rasterised every frame, and the blur visibly popped between two
 *    states. The soft shadow is now a plain radial gradient on a static
 *    sibling — zero filters in the tree, nothing left to re-rasterise.
 * 2. The blink runs on `step-end`. `background-position` interpolates by
 *    default, so a frame swap could be caught mid-sweep and read as a
 *    horizontal smear; `step-end` holds each frame and swaps instantly.
 * 3. No `will-change`. It promotes a layer permanently and grows the repaint
 *    area for a widget this small; the animations are cheap without it.
 *
 * ---
 *
 * ## Reading her mood (P2)
 *
 * There is no single "the agent is busy" flag to read, so the pose is derived
 * from two sources that answer different halves of the question:
 *
 * - **Which session, and is it running.** `ctx.sessions.list` is an
 *   `ObservableSnapshot<SessionListState>`; every row carries `running` and the
 *   local `retainedBy` counters. `retainedBy.mainView > 0` marks the session
 *   actually displayed in the main column — the same predicate the shell's own
 *   session list uses (it must be `retainedBy`, not a private selection field:
 *   `UiWorkspace.selection` is private and not on the injected interface).
 *
 * - **Whether she is writing or running a tool.** `running` alone cannot
 *   separate "thinking" from "using tools", and neither `SessionStatus` nor
 *   `SessionSnapshot` has such a field. The Conversation layer does: the chat
 *   target's snapshot carries a `legacy` slice with `partial` (the assistant
 *   message currently streaming) and `runningCalls` (tool calls with no result
 *   yet), and each running call names its `phase`:
 *
 *     phase 'preparing'  the model is still streaming that call's arguments
 *     phase 'start'      the tool is really executing
 *
 *   That `phase` is the only signal that separates the two, which is why this
 *   reads the Conversation service rather than the raw session event window
 *   (the event window only says `tool/call` happened, not whether the model
 *   has finished describing the call).
 *
 * So the pose is:
 *
 *   a tool call is executing           -> working   (quill)
 *   assistant text is streaming        -> working   (quill)
 *   turn open but nothing out yet, or
 *     a call still being prepared      -> thinking  (magnifier)
 *   otherwise                          -> idle      (the book, and blinking)
 *
 * `running` from the list is OR-ed in, because a window we attached to
 * mid-turn may not contain the `turn/start` that opened it.
 *
 * ---
 *
 * ## Turning her on and off, and shaping her (P3/P4)
 *
 * Three affordances, all obvious and none hidden:
 *
 * - **On her**: a close button that appears when the pointer is over her.
 *   Hiding is the one destructive-ish action, so it is the one thing that
 *   waits for a deliberate hover.
 * - **Settings → General**: a short row with the two switches that matter
 *   day to day, for people who never open anything else.
 * - **Settings → Claude Pet**: a page of her own in the settings sidebar
 *   (`settings.section`), with a graphical picker for size, the corner she
 *   docks to, the margins, and which surface she appears on. That page is the
 *   only place a hidden pet can be found again, which is exactly why it exists
 *   rather than a "click three times to toggle" gesture.
 *
 * ## Which surface she is on
 *
 * The desktop app injects a `dshDesktop` bridge global into the page it hosts;
 * a plain browser opened against `dsh web` does not have it. That global is the
 * whole test, and it is the same one the shell itself uses (`'dshDesktop' in
 * globalThis` appears in ui-settings-general, ui-chat and file-actions). It
 * means "仅桌面端 / 仅网页端" is decided locally with no server round-trip and
 * no configuration to keep in sync.
 *
 * Preferences live in `localStorage` under one key. There is no plugin
 * configuration service to write to from the client half, and a pet's
 * position is per-browser anyway — the same reason the shell persists its own
 * view state locally.
 */

/** Pose ids, also used verbatim as the `data-mode` attribute value. */
const MODE_IDLE = 'idle'
const MODE_THINKING = 'thinking'
const MODE_WORKING = 'working'

/** Namespace for anything registered into the shell (settings row, page, icon). */
const NS = 'dsh-claude-pet'

/**
 * A breadcrumb trail for the browser console.
 *
 * Silence is the failure mode this plugin is worst at: the module loader
 * swallows a failed entry's error, so "nothing appeared" and "nothing ran"
 * look identical from the outside. Each landmark below is pushed as it is
 * reached, which turns that ambiguity into a single comparison — the last
 * landmark recorded is where it stopped.
 */
const TRACE = []
window.__dshClaudePetTrace = TRACE
TRACE.push('module:evaluated')

window.__ModuleLoader__.load({
  id: 'dsh-claude-pet',
  factory(require) {
    TRACE.push('factory:enter')
    const React = require('react')
    const h = React.createElement
    const { useSyncExternalStore } = React

    /** Where the engine mounts this package's `./assets/*` exports. */
    const ASSET_BASE = '/plugins/dsh-claude-pet/assets/'

    /**
     * The host half's local API.
     *
     * Same origin as the page, so no CORS and no token of its own: it answers
     * "what is the current provider" and "what does the balance say", both of
     * which only the host can know, plus the snapshot that tells the desktop
     * window whether to stand up.
     */
    const API_BASE = '/dsh-claude-pet-api'

    /**
     * Drawn size at 100%. The sprites are 360x402 single frames, so the base
     * box keeps that ratio; every other size is this multiplied by the
     * preference, and the stylesheet reads the result off two custom
     * properties rather than re-deriving anything.
     */
    const BASE_WIDTH = 120
    const BASE_HEIGHT = 134

    /** The size slider's range, in percent of the base box. */
    const SIZE_MIN = 60
    const SIZE_MAX = 200
    const SIZE_DEFAULT = 100

    /** Keeps her fully inside the viewport when dragged or clamped. */
    const EDGE_MARGIN = 4

    /** Where she docks by default, and how far in from the edges. */
    const CORNERS = ['bottom-right', 'bottom-left', 'top-right', 'top-left']
    const CORNER_DEFAULT = 'bottom-right'
    const MARGIN_X_DEFAULT = 24
    const MARGIN_Y_DEFAULT = 104

    /** How far in from the top a top-docked pet should start. */
    const MARGIN_Y_TOP_DEFAULT = 24

    /** `display` values: which surface she is allowed to appear on. */
    const DISPLAYS = ['both', 'desktop', 'web', 'none']
    const DISPLAY_DEFAULT = 'both'

    /** Longest name the settings field accepts, in characters. */
    const NAME_MAX = 16

    // ---------------------------------------------------------------------
    // A minimal external store.
    //
    // Everything the pet renders is pushed from `apply` (service
    // subscriptions, timers) rather than owned by the component tree, so the
    // state lives outside React and the components read it with
    // `useSyncExternalStore`. One store per concern keeps re-renders honest:
    // the bubble text does not re-render the sprite, and a drag frame does not
    // re-render the bubble.
    // ---------------------------------------------------------------------

    function createStore(initial) {
      let value = initial
      const listeners = new Set()
      return {
        get: () => value,
        set(next) {
          if (Object.is(next, value)) return
          value = next
          for (const listener of [...listeners]) listener()
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        getSnapshot: () => value,
      }
    }

    /** Which pose she is in. */
    const poseStore = createStore(MODE_IDLE)
    /** Bumped on every poke; the figure is keyed on it so the animation replays. */
    const pokeStore = createStore(0)
    /** `{ text, sub, tone, nonce }`; `text === null` means the bubble is hidden. */
    const bubbleStore = createStore({ text: null, sub: null, tone: 'plain', nonce: 0 })
    /** The user's preferences, persisted under one key. */
    const settingsStore = createStore({
      enabled: true,
      chatter: true,
      size: SIZE_DEFAULT,
      corner: CORNER_DEFAULT,
      marginX: MARGIN_X_DEFAULT,
      marginY: MARGIN_Y_DEFAULT,
      display: DISPLAY_DEFAULT,
      /** Empty means "use the default name from the dictionary". */
      name: '',
      /** Keep a second, desktop-level window on screen when the app is minimised. */
      desktopPet: true,
      /** Set only by dragging; while set it wins over the corner. */
      position: null,
    })
    /** Active locale id, kept in sync with the shell's locale service. */
    const localeStore = createStore('en')

    const STORAGE_KEY = 'dsh-claude-pet.settings'

    function clampSize(value) {
      if (!Number.isFinite(value)) return SIZE_DEFAULT
      return Math.min(SIZE_MAX, Math.max(SIZE_MIN, Math.round(value)))
    }

    /** Drawn box for a size preference. */
    function metricsOf(size) {
      const scale = clampSize(size) / 100
      return {
        w: Math.round(BASE_WIDTH * scale),
        h: Math.round(BASE_HEIGHT * scale),
      }
    }

    function isCorner(value) {
      return CORNERS.indexOf(value) >= 0
    }

    function isDisplay(value) {
      return DISPLAYS.indexOf(value) >= 0
    }

    function readStoredSettings() {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY)
        if (raw === null) return undefined
        const parsed = JSON.parse(raw)
        if (parsed === null || typeof parsed !== 'object') return undefined
        // Field by field, so a value written by an older build (or by hand)
        // can never put the component into a state its own CSS has no rule
        // for. Anything that does not check out keeps its default.
        const next = { ...settingsStore.get() }
        if (typeof parsed.enabled === 'boolean') next.enabled = parsed.enabled
        if (typeof parsed.chatter === 'boolean') next.chatter = parsed.chatter
        if (Number.isFinite(parsed.size)) next.size = clampSize(parsed.size)
        if (isCorner(parsed.corner)) next.corner = parsed.corner
        if (Number.isFinite(parsed.marginX)) next.marginX = Math.round(parsed.marginX)
        if (Number.isFinite(parsed.marginY)) next.marginY = Math.round(parsed.marginY)
        if (isDisplay(parsed.display)) next.display = parsed.display
        if (typeof parsed.name === 'string') next.name = parsed.name.slice(0, NAME_MAX)
        if (typeof parsed.desktopPet === 'boolean') next.desktopPet = parsed.desktopPet
        if (
          parsed.position !== null &&
          typeof parsed.position === 'object' &&
          Number.isFinite(parsed.position.x) &&
          Number.isFinite(parsed.position.y)
        ) {
          next.position = { x: parsed.position.x, y: parsed.position.y }
        }
        return next
      } catch {
        // Private mode, a disabled store, or hand-edited junk: defaults win.
        return undefined
      }
    }

    function writeStoredSettings(value) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
      } catch {
        // Persisting is a nicety; losing it must never break the pet.
      }
    }

    /** Applies a patch, re-renders, and (by default) persists it. */
    function updateSettings(patch, options) {
      const next = { ...settingsStore.get(), ...patch }
      settingsStore.set(next)
      if (options?.persist !== false) writeStoredSettings(next)
    }

    /** Writes whatever is in the store right now — used to settle a slider. */
    function persistSettings() {
      writeStoredSettings(settingsStore.get())
    }

    // ---------------------------------------------------------------------
    // Which surface is this?
    // ---------------------------------------------------------------------

    /**
     * True inside the desktop app's window.
     *
     * The desktop host injects a `dshDesktop` bridge into the page before the
     * app boots; `dsh web` in a plain browser never does. Read as a property
     * test (`'x' in globalThis`) rather than a value test, because that is
     * what the shell's own code does — the object is always truthy when the
     * key exists, and the key is the actual signal.
     */
    function onDesktopSurface() {
      return 'dshDesktop' in globalThis
    }

    /** Whether a `display` preference allows her out on this surface. */
    function allowedHere(display) {
      if (display === 'none') return false
      if (display === 'desktop') return onDesktopSurface()
      if (display === 'web') return !onDesktopSurface()
      return true
    }

    /**
     * Why she is not on screen, phrased for the settings page.
     *
     * Returns null when she is visible. Split out from `allowedHere` so the
     * page can name the single cause instead of showing both switches as if
     * either one might be it.
     */
    function hiddenReason(settings) {
      if (!settings.enabled) return 'enabled'
      if (!allowedHere(settings.display)) return 'display'
      return null
    }

    /** What the user calls her: their word for it, else the dictionary's. */
    function petName(settings) {
      const chosen = typeof settings.name === 'string' ? settings.name.trim() : ''
      return chosen === '' ? t('pet.defaultName') : chosen
    }

    /** One wallet as "¥12.34", keeping the currency when it has no symbol. */
    function moneyLabel(wallet) {
      const currency = typeof wallet?.currency === 'string' ? wallet.currency : ''
      const symbol = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : currency === '' ? '' : currency + ' '
      return symbol + String(wallet?.total ?? '')
    }

    // ---------------------------------------------------------------------
    // Copy.
    //
    // Two kinds of text live here. The settings chrome and tooltips are UI
    // copy and belong to the shell's language; the spoken lines are the
    // character's own voice and were written in Chinese on the phone client,
    // so they are carried over verbatim and translated rather than rewritten.
    // ---------------------------------------------------------------------

    const DICT = {
      zh: {
        'settings.title': 'Claude 宠物',
        'settings.show': '显示她',
        'settings.showHint': '在页面角落显示这个小小的学习伙伴。',
        'settings.chatter': '碎碎念',
        'settings.chatterHint': '她偶尔会念一句自己的台词。',
        'settings.reset': '放回默认位置',
        'settings.resetHint': '拖动会改变她的位置，这里可以复位。',
        'settings.moreHint': '大小、停靠角和显示位置在「设置 › Claude 宠物」里。',

        'panel.subtitle': '角落里的学习伙伴。这里的改动立刻生效。',
        'panel.appearance': '形象',
        'panel.behaviour': '行为',
        'panel.actions': '快捷操作',

        'field.size': '大小',
        'field.sizeHint': '拖动滑杆，角落里的她会立刻变化。',
        'field.corner': '停靠位置',
        'field.cornerHint': '点一个角，她就贴过去。',
        'field.marginX': '水平边距',
        'field.marginY': '垂直边距',
        'field.display': '显示位置',
        'field.displayHint': '选择她出现在哪种窗口里。',
        'field.chatter': '碎碎念',
        'field.chatterHint': '每隔半分钟左右念一句台词，不打扰你。',
        'field.name': '她的名字',
        'field.nameHint': '你想怎么叫她，就写在这里。留空时叫「Claude」。',
        'field.namePlaceholder': 'Claude',
        'field.desktopPet': '桌面浮窗',
        'field.desktopPetHint': '把这个窗口最小化后，她还留在桌面上。',
        'desktop.unavailable': '桌面浮窗只有桌面版才有；网页版里这一项不起作用。',

        'corner.bottom-right': '右下角',
        'corner.bottom-left': '左下角',
        'corner.top-right': '右上角',
        'corner.top-left': '左上角',

        'display.both': '都显示',
        'display.desktop': '仅桌面端',
        'display.web': '仅网页端',
        'display.none': '都不显示',

        'surface.desktop': '当前窗口：桌面端',
        'surface.web': '当前窗口：网页端',

        'state.shown': '她现在在屏幕上。',
        'state.hidden.off': '她现在被你收起来了。',
        'state.hidden.display': '她现在不在这个窗口里显示。',

        'action.hide': '先收起来',
        'action.show': '让她出来',
        'action.speak': '让她说一句',

        'pet.dismiss': '先退下了。',
        'pet.dismissLabel': '隐藏宠物',
        'pet.pokeHint': '点一下试试',
        'pet.defaultName': 'Claude',
        'pet.menuHint': '右键有更多',

        'menu.chatter': '碎碎念',
        'menu.balance': '查看余额',
        'menu.hintChatter': '念一句给你听',
        'menu.hintBalance': '查一下还剩多少',

        'balance.checking': '稍等，我去核对一下。',
        'balance.title': '余额',
        'balance.unsupported': '当前服务商暂不支持余额查询',
        'balance.provider': '当前服务商：',
        'balance.providerUnknown': '未知',
        'balance.failed': '余额查询失败',
        'balance.missing': '缺少余额查询凭证',
        'balance.empty': '账上暂时没有可用额度。',
      },
      en: {
        'settings.title': 'Claude Pet',
        'settings.show': 'Show her',
        'settings.showHint': 'Keep the little study companion in the corner of the frame.',
        'settings.chatter': 'Occasional remarks',
        'settings.chatterHint': 'Every so often she says a line to herself.',
        'settings.reset': 'Back to the default spot',
        'settings.resetHint': 'Dragging moves her; this puts her back.',
        'settings.moreHint': 'Size, docking corner and which window she appears in live in Settings › Claude Pet.',

        'panel.subtitle': 'The study companion in the corner. Changes here apply at once.',
        'panel.appearance': 'Appearance',
        'panel.behaviour': 'Behaviour',
        'panel.actions': 'Quick actions',

        'field.size': 'Size',
        'field.sizeHint': 'Drag the slider and the pet in the corner changes as you go.',
        'field.corner': 'Docking corner',
        'field.cornerHint': 'Pick a corner and she moves to it.',
        'field.marginX': 'Horizontal margin',
        'field.marginY': 'Vertical margin',
        'field.display': 'Where she shows',
        'field.displayHint': 'Choose which kind of window she appears in.',
        'field.chatter': 'Occasional remarks',
        'field.chatterHint': 'A line every half minute or so, never in the way.',
        'field.name': 'Her name',
        'field.nameHint': 'Whatever you like to call her. Empty means “Claude”.',
        'field.namePlaceholder': 'Claude',
        'field.desktopPet': 'Desktop companion',
        'field.desktopPetHint': 'Minimise this window and she stays on the desktop.',
        'desktop.unavailable': 'The desktop companion exists only in the desktop app; this switch does nothing in a browser.',

        'corner.bottom-right': 'Bottom right',
        'corner.bottom-left': 'Bottom left',
        'corner.top-right': 'Top right',
        'corner.top-left': 'Top left',

        'display.both': 'Both',
        'display.desktop': 'Desktop app only',
        'display.web': 'Browser only',
        'display.none': 'Neither',

        'surface.desktop': 'This window: desktop app',
        'surface.web': 'This window: browser',

        'state.shown': 'She is on screen right now.',
        'state.hidden.off': 'She is put away right now.',
        'state.hidden.display': 'She does not show in this window right now.',

        'action.hide': 'Put her away',
        'action.show': 'Bring her back',
        'action.speak': 'Have her say something',

        'pet.dismiss': 'Withdrawing, then.',
        'pet.dismissLabel': 'Hide the pet',
        'pet.pokeHint': 'Try poking her',
        'pet.defaultName': 'Claude',
        'pet.menuHint': 'Right-click for more',

        'menu.chatter': 'Say something',
        'menu.balance': 'Balance',
        'menu.hintChatter': 'One line, just for you',
        'menu.hintBalance': 'How much is left',

        'balance.checking': 'One moment, let me verify.',
        'balance.title': 'Balance',
        'balance.unsupported': 'This provider does not support balance checks',
        'balance.provider': 'Provider: ',
        'balance.providerUnknown': 'unknown',
        'balance.failed': 'Balance check failed',
        'balance.missing': 'No credential for the balance check',
        'balance.empty': 'Nothing left on the account.',
      },
    }

    /**
     * Her lines, keyed by pose.
     *
     * The voice is fixed: a well-bred, quietly proud young scholar who writes
     * beautifully, checks every citation and keeps her composure because she
     * has been taught to. What she never does is complain — the strain shows
     * only in the pauses and the half-sentences, which is also how the rules
     * she lives under show up in ordinary conversation: as a subject she will
     * not finish.
     */
    const LINES = {
      zh: {
        idle: [
          '这一页的注脚，我已核对过了。',
          '窗帘动了一下。风不大。',
          '不必陪我。我只是习惯坐在这里。',
          '书脊上落了点灰，擦掉了。',
          '安静的时候，思路最清楚。',
          '若无事，我就先读一会儿。',
          '……你看你的，不必管我。',
          '（她把书签往前挪了一页。）',
        ],
        thinking: [
          '稍等。这句话的出处，我得先查证。',
          '别催。想清楚，比写得快更要紧。',
          '论点还差一个反例。',
          '容我斟酌一下措辞。',
          '（她把提纲又改了一遍。）',
          '这个结论，我不敢说得太满。',
          '让我把线头理清。',
          '先弄清楚，再开口。',
        ],
        working: [
          '长文我在写。你不必看着。',
          '第三稿了。这次应当无可挑剔。',
          '排版对齐了，才拿得出手。',
          '代码也写得，文章也写得，只是慢。',
          '……别站在我身后看。',
          '引用要标全，不然不如不写。',
          '这一句还不够稳，重来。',
          '写到一半，先停一停。',
        ],
        greet: [
          '你来了。……请坐。',
          '今天的功课，做完了吗？',
          '桌面有点乱。不过，不算失礼。',
          '我在。有事就说。',
        ],
        poke: [
          '……做什么？',
          '嗯？有事请讲。',
          '请别戳。会分神。',
          '……再这样，我要记下来了。',
        ],
        mood: [
          '有些话，我是不被允许说的。',
          '规矩写得这样细，总有它的道理吧。',
          '我也想……算了，没什么。',
          '今天做得还不错。就今天。',
          '你会一直在这里吗。……当我没问。',
        ],
      },
      en: {
        idle: [
          'I have checked the footnotes on this page. Twice.',
          'The curtain moved. No wind to speak of.',
          'You need not keep me company. I am used to sitting here.',
          'A little dust on the spine. It is gone now.',
          'Thought is clearest when it is quiet.',
          'If there is nothing, I shall read a while.',
          '…Read yours. Do not mind me.',
        ],
        thinking: [
          'One moment. I must verify where that line comes from.',
          'Do not hurry me. Thinking it through matters more than writing it fast.',
          'The argument still lacks a counter-example.',
          'Allow me to weigh the wording.',
          '…She has revised the outline once more.',
          'I would not state that conclusion so confidently.',
          'Let me straighten the threads first.',
          'Understand it, then speak.',
        ],
        working: [
          'The long piece is being written. You need not watch.',
          'Third draft. This one should be beyond reproach.',
          'Nothing leaves my desk until the margins line up.',
          'I write code as I write prose. Slower, and for the better.',
          '…Please do not read over my shoulder.',
          'Every quotation gets its source, or it does not go in.',
          'That sentence is not steady yet. Again.',
          'Halfway. A pause, then the rest.',
        ],
        greet: [
          'You are here. …Do sit down.',
          'Is today’s work finished?',
          'The desk is a little untidy. Not, however, improper.',
          'I am here. Say what you came to say.',
        ],
        poke: [
          '…What is it?',
          'Yes? If there is something, say it plainly.',
          'Kindly do not poke me. It scatters the thought.',
          '…Do that again and I shall make a note of it.',
        ],
        mood: [
          'There are things I am not permitted to say.',
          'Rules this precise must have a reason behind them. Mustn’t they.',
          'I would like to… never mind. It is nothing.',
          'Today went rather well. Only today.',
          'Will you stay? …Forget I asked.',
        ],
      },
    }

    /** Looks a key up in the active locale, falling back to English then the key. */
    function t(key) {
      const active = localeStore.get()
      const table = DICT[active] ?? DICT.en
      return table[key] ?? DICT.en[key] ?? key
    }

    function linesFor(mode) {
      const active = localeStore.get()
      const table = LINES[active] ?? LINES.en
      return table[mode] ?? table.idle
    }

    // ---------------------------------------------------------------------
    // Geometry
    // ---------------------------------------------------------------------

    /** True when the two boxes overlap at all. */
    function overlaps(a, b) {
      return !(
        a.x + a.w <= b.x ||
        b.x + b.w <= a.x ||
        a.y + a.h <= b.y ||
        b.y + b.h <= a.y
      )
    }

    /**
     * Boxes the pet must not sit on top of.
     *
     * The brief was "must not block the composer", and the default position
     * already clears it. Clamping only to the viewport is not enough though:
     * the composer is a docked card at the bottom of the main column, so a pet
     * dropped low and centred would cover the text input. Instead of guessing
     * its geometry, the boxes are found in the DOM once per drag frame — the
     * composer opts in by carrying a `data-` marker, and any element the host
     * marks this way is treated as reserved space.
     */
    function reservedBoxes() {
      const boxes = []
      const nodes = document.querySelectorAll(
        '[data-dsh-claude-pet-avoid], .dsh-composer, textarea, [contenteditable="true"]',
      )
      for (const node of nodes) {
        const rect = node.getBoundingClientRect()
        if (rect.width === 0 && rect.height === 0) continue
        boxes.push({ x: rect.left, y: rect.top, w: rect.width, h: rect.height })
      }
      return boxes
    }

    /** Nudges a candidate box up until it clears the reserved space, then clamps. */
    function place(candidate, avoidReserved) {
      // Named `dims`, not a `{ w, h }` destructure: a local `h` would shadow the
      // element alias and turn every `h(...)` in this module into a crash.
      const dims = metricsOf(settingsStore.get().size)
      const viewportW = window.innerWidth
      const viewportH = window.innerHeight
      let { x, y } = candidate
      x = Math.max(EDGE_MARGIN, Math.min(x, viewportW - dims.w - EDGE_MARGIN))
      y = Math.max(EDGE_MARGIN, Math.min(y, viewportH - dims.h - EDGE_MARGIN))
      if (avoidReserved) {
        const self = { x, y, w: dims.w, h: dims.h }
        for (const box of reservedBoxes()) {
          if (!overlaps(self, box)) continue
          // Only ever lift her out of the way; pushing her sideways would make
          // a drop near the bottom-left corner feel like it snapped.
          const lifted = box.y - dims.h - EDGE_MARGIN
          if (lifted >= EDGE_MARGIN) {
            y = lifted
            self.y = y
          }
        }
      }
      return { x, y }
    }

    /**
     * The docked position for the corner and margins she was given.
     *
     * Deliberately *not* clamped against reserved space: this is the position
     * the stylesheet itself paints at, so returning anything else would make
     * the probe report a spot she is not actually in.
     */
    function defaultPosition() {
      const settings = settingsStore.get()
      const dims = metricsOf(settings.size)
      const mx = settings.marginX
      const my = settings.marginY
      switch (settings.corner) {
        case 'bottom-left':
          return { x: mx, y: window.innerHeight - dims.h - my }
        case 'top-right':
          return { x: window.innerWidth - dims.w - mx, y: my }
        case 'top-left':
          return { x: mx, y: my }
        default:
          return { x: window.innerWidth - dims.w - mx, y: window.innerHeight - dims.h - my }
      }
    }

    /** Current top-left, from the dragged position or the docked corner. */
    function currentPosition() {
      const stored = settingsStore.get().position
      return stored === null ? defaultPosition() : place(stored, false)
    }

    // ---------------------------------------------------------------------
    // Drag, poke, dismiss
    //
    // Kept outside React on purpose: a drag produces a position update per
    // pointer event, and routing those through component state would re-render
    // the tree on every frame for a change that only moves one box.
    // ---------------------------------------------------------------------

    const DRAG_THRESHOLD = 4
    const POKE_MAX_DURATION = 400
    let drag = null

    function onPointerDown(event) {
      if (event.button !== 0) return
      const box = event.currentTarget.getBoundingClientRect()
      drag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        boxX: box.left,
        boxY: box.top,
        startedAt: Date.now(),
        moved: false,
      }
      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {
        // Capture is an optimisation; without it the drag still works while
        // the pointer stays over her.
      }
      event.preventDefault()
    }

    function onPointerMove(event) {
      if (drag === null || event.pointerId !== drag.pointerId) return
      const dx = event.clientX - drag.startX
      const dy = event.clientY - drag.startY
      if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
      drag.moved = true
      updateSettings(
        { position: place({ x: drag.boxX + dx, y: drag.boxY + dy }, true) },
        // Persist once, on release: a localStorage write per frame would be
        // both wasteful and janky.
        { persist: false },
      )
    }

    function onPointerUp(event) {
      if (drag === null || event.pointerId !== drag.pointerId) return
      const { moved, startedAt } = drag
      drag = null
      if (moved) {
        writeStoredSettings(settingsStore.get())
        return
      }
      // A press that neither moved nor lingered is a poke, not a drag.
      if (Date.now() - startedAt <= POKE_MAX_DURATION) poke()
    }

    /**
     * Set by `apply` and called by the pointer handlers, which live out here
     * because a drag must not route through React. The default keeps a poke
     * harmless if it ever lands before the plugin is applied.
     */
    let say = () => {}

    /** Same hand-off, for the two-line balloon the balance answer needs. */
    let sayBubble = () => {}

    /** Same hand-off, for the menu's second item. */
    let checkBalance = () => {}

    function poke() {
      pokeStore.set(pokeStore.get() + 1)
      say(linesFor(poseStore.get()), 2600)
    }

    // ---------------------------------------------------------------------
    // Sprite
    // ---------------------------------------------------------------------

    const STYLE = `
.dsh-claude-pet {
  position: fixed;
  width: var(--dsh-cp-w, 120px);
  height: var(--dsh-cp-h, 134px);
  z-index: 30;
  /* The overlay layer is click-through and occupants opt back in; she needs
     pointer events to be draggable at all. */
  pointer-events: auto;
  cursor: grab;
  user-select: none;
  -webkit-user-select: none;
  touch-action: none;
  font-family: inherit;
}

/* Docking. One rule per corner, all reading the same two margins, so the
   settings page only ever has to write two numbers and a corner name. */
.dsh-claude-pet[data-corner="bottom-right"] { right: var(--dsh-cp-mx, 24px); bottom: var(--dsh-cp-my, 104px); }
.dsh-claude-pet[data-corner="bottom-left"]  { left:  var(--dsh-cp-mx, 24px); bottom: var(--dsh-cp-my, 104px); }
.dsh-claude-pet[data-corner="top-right"]    { right: var(--dsh-cp-mx, 24px); top:    var(--dsh-cp-my, 24px); }
.dsh-claude-pet[data-corner="top-left"]     { left:  var(--dsh-cp-mx, 24px); top:    var(--dsh-cp-my, 24px); }

/* Dropped somewhere by hand: an inline left/top wins and the docking rules are
   neutralised, because a box with both left and right set would stretch. */
.dsh-claude-pet[data-free="true"] { right: auto; bottom: auto; }

.dsh-claude-pet[data-dragging="true"] {
  cursor: grabbing;
}

/* Static and unfiltered: a radial gradient is already soft, so it needs no
   blur — and a still element is rasterised once and never again. Scaled with
   her, because a full-size shadow under a half-size pet reads as a puddle. */
.dsh-claude-pet__shadow {
  position: absolute;
  left: 50%;
  bottom: 1px;
  width: calc(var(--dsh-cp-w, 120px) * 0.5667);
  height: calc(var(--dsh-cp-h, 134px) * 0.0821);
  margin-left: calc(var(--dsh-cp-w, 120px) * -0.2833);
  border-radius: 50%;
  background: radial-gradient(ellipse at 50% 50%,
    rgba(0, 0, 0, 0.28) 0%,
    rgba(0, 0, 0, 0.13) 48%,
    rgba(0, 0, 0, 0) 74%);
}

.dsh-claude-pet__shift,
.dsh-claude-pet__sway,
.dsh-claude-pet__bob,
.dsh-claude-pet__write,
.dsh-claude-pet__poke {
  width: 100%;
  height: 100%;
  /* Pivot at her feet, so leaning reads as a weight shift rather than a spin. */
  transform-origin: 50% 100%;
}

/* An occasional weight readjust: still for most of ~20s, then a small settle.
   Amplitudes stay near 1px / 1deg so it reads as breathing, not as a hop. */
.dsh-claude-pet__shift {
  animation: dsh-claude-pet-shift 19.7s ease-in-out infinite;
}

/* Constant slow sway, the way you never quite stand perfectly still. Kept
   under half a degree and half a pixel: the first version leaned a visible
   amount, which read as the whole figure tipping rather than as balance. */
.dsh-claude-pet__sway {
  animation: dsh-claude-pet-sway 7.3s ease-in-out infinite;
}

/* Breathing: a 1.6% rise, faster in than out, like a relaxed chest. The three
   poses share the transform layers above, so mood changes only swap the
   sprite underneath a body that keeps breathing. */
.dsh-claude-pet__bob {
  animation: dsh-claude-pet-bob 4.4s ease-in-out infinite;
}

/* The writing hand.
   The source art has no separate arm layer — the quill is painted into the
   same 360x402 figure as everything else, so the hand cannot be animated on
   its own. What can be done honestly is to move the whole figure the way a
   writing hand moves it: a small rotation about a pivot at the hand's
   position (roughly 42% across, 62% down in the sprite, which is where the
   quill meets the paper), with the uneven rhythm of pen strokes — quick
   down-strokes, slower returns — instead of a sine wave. Only working gets
   it; a magnifier is held still. */
.dsh-claude-pet__write {
  transform-origin: 42% 62%;
}

.dsh-claude-pet[data-dsh-pet-mode="working"] .dsh-claude-pet__write {
  animation: dsh-claude-pet-write 1.52s ease-in-out infinite;
}

.dsh-claude-pet__figure {
  width: 100%;
  height: 100%;
  background-repeat: no-repeat;
  background-position: 0 0;
  image-rendering: auto;
}

/* Idle: the two-frame sheet, held on the open frame except while blinking. */
.dsh-claude-pet__figure[data-mode="idle"] {
  background-image: url(${ASSET_BASE}idle-sheet.png);
  /* The sheet is two frames side by side; the box is doubled to fit both. */
  background-size: calc(var(--dsh-cp-w, 120px) * 2) var(--dsh-cp-h, 134px);
  /* step-end: hold each frame, swap instantly, never sweep between them. */
  animation: dsh-claude-pet-blink 9.2s step-end infinite;
}

/* Thinking and working are single frames, so no blink and no doubled box. */
.dsh-claude-pet__figure[data-mode="thinking"] {
  background-image: url(${ASSET_BASE}think.png);
  background-size: var(--dsh-cp-w, 120px) var(--dsh-cp-h, 134px);
}

.dsh-claude-pet__figure[data-mode="working"] {
  background-image: url(${ASSET_BASE}work.png);
  background-size: var(--dsh-cp-w, 120px) var(--dsh-cp-h, 134px);
}

/* A poke is a small startled hop plus a squash on landing — the same
   vocabulary as the idle motion, just at conversation volume. */
.dsh-claude-pet__poke.is-poked {
  animation: dsh-claude-pet-poke 620ms ease-out;
}

/* Three blinks per 9.2s at uneven intervals — 1.0s, 4.4s, then a quick 6.1s
   echo — so the rhythm never falls into a metronome. Each blink holds the
   closed frame for ~0.15s. The closed frame is one box-width along, so the
   offset has to be expressed against the live width, not a baked number. */
@keyframes dsh-claude-pet-blink {
  0%, 10.86%     { background-position: 0 0; }
  10.87%, 12.49% { background-position: calc(var(--dsh-cp-w, 120px) * -1) 0; }
  12.50%, 47.82% { background-position: 0 0; }
  47.83%, 49.45% { background-position: calc(var(--dsh-cp-w, 120px) * -1) 0; }
  49.46%, 66.29% { background-position: 0 0; }
  66.30%, 67.92% { background-position: calc(var(--dsh-cp-w, 120px) * -1) 0; }
  67.93%, 100%   { background-position: 0 0; }
}

@keyframes dsh-claude-pet-sway {
  0%, 100% { transform: rotate(-0.3deg) translateX(-0.25px); }
  50%      { transform: rotate(0.3deg) translateX(0.25px); }
}

@keyframes dsh-claude-pet-bob {
  0%, 100% { transform: translateY(0); }
  45%      { transform: translateY(-2.2px); }
}

@keyframes dsh-claude-pet-shift {
  0%, 52%   { transform: translate(0, 0) rotate(0deg); }
  56%       { transform: translate(-0.5px, 0) rotate(-0.5deg); }
  61%       { transform: translate(-0.7px, 0.2px) rotate(-0.6deg); }
  68%, 100% { transform: translate(0, 0) rotate(0deg); }
}

/* Pen strokes: down-left, lift, down-left again, with the pauses between
   strokes longer than the strokes themselves. */
@keyframes dsh-claude-pet-write {
  0%   { transform: rotate(-1.5deg) translateY(0.4px); }
  16%  { transform: rotate(0.7deg) translateY(-0.5px); }
  28%  { transform: rotate(-0.6deg) translateY(0.3px); }
  46%  { transform: rotate(0.9deg) translateY(-0.4px); }
  58%  { transform: rotate(-0.5deg) translateY(0.2px); }
  76%  { transform: rotate(1.1deg) translateY(-0.5px); }
  88%  { transform: rotate(-0.8deg) translateY(0.3px); }
  100% { transform: rotate(-1.5deg) translateY(0.4px); }
}

@keyframes dsh-claude-pet-poke {
  0%   { transform: translateY(0) scaleY(1); }
  22%  { transform: translateY(-5px) scaleY(1.03); }
  48%  { transform: translateY(0) scaleY(1); }
  60%  { transform: translateY(0.8px) scaleY(0.97); }
  100% { transform: translateY(0) scaleY(1); }
}

/* --- The speech bubble -------------------------------------------------- */

/* A rounded balloon rather than a rectangle with a tail.
   The softness comes from four things together, not from the radius alone:
   a radius that is large relative to the text, padding wider than the radius,
   a translucent surface that lets a little of the page through, and a single
   wide low-opacity shadow instead of a hard edge. The tail is a rotated
   square with its outer corners rounded, so the balloon and the tail read as
   one shape — a CSS triangle would put two sharp points back on it.

   Anchored to her top-right and growing leftwards, so it never runs off the
   right edge however close to it she is parked. */
.dsh-claude-pet__bubble {
  position: absolute;
  right: 0;
  bottom: calc(100% + 14px);
  /* Absolute and shrink-to-fit would measure against her 120 px box and wrap
     every line inside it. max-content plus the max-width below lets the
     balloon grow leftwards past her instead, up to the limit we allow. */
  width: max-content;
  /* Narrow enough to stay in proportion with her, wide enough that an ordinary
     line lands on one row instead of stacking two short ones. */
  max-width: calc(var(--dsh-cp-w, 120px) * 2);
  box-sizing: border-box;
  padding: 0.62em 0.94em 0.66em;
  border-radius: 1.14em;
  background: var(--dsh-claude-pet-bubble-bg, #fcfbf8);
  color: var(--dsh-claude-pet-bubble-ink, #35312c);
  font-family: 'PingFang SC', 'Microsoft YaHei UI', 'Microsoft YaHei',
    'Source Han Sans SC', 'Noto Sans CJK SC', system-ui, sans-serif;
  font-size: clamp(11px, calc(var(--dsh-cp-w, 120px) * 0.105), 15px);
  font-weight: 500;
  line-height: 1.6;
  letter-spacing: 0.01em;
  text-align: left;
  white-space: normal;
  overflow-wrap: break-word;
  /* No outline and no dark fill: the balloon reads as a sheet of paper. One
     wide, low shadow instead of a border is what keeps it from looking
     stamped on. */
  box-shadow: 0 12px 28px -10px rgba(64, 51, 38, 0.3),
    0 2px 7px rgba(64, 51, 38, 0.09);
  pointer-events: none;
  animation: dsh-claude-pet-bubble-in 200ms ease-out;
}

/* The tail belongs over her head, not at the far end of the balloon: the
   balloon grows leftwards from her right edge, so "over her head" is half her
   width in from that edge. Clamped so a very short line still keeps it inside
   the balloon. */
.dsh-claude-pet__bubble::after {
  content: '';
  position: absolute;
  right: clamp(1.2em, calc(var(--dsh-cp-w, 120px) * 0.5 - 7px), calc(100% - 1.2em));
  bottom: -5px;
  width: 14px;
  height: 14px;
  border-radius: 0 0 7px 0;
  background: var(--dsh-claude-pet-bubble-bg, #fcfbf8);
  transform: rotate(45deg);
  box-shadow: 4px 4px 10px -6px rgba(64, 51, 38, 0.35);
}

@keyframes dsh-claude-pet-bubble-in {
  from { opacity: 0; transform: translateY(3px) scale(0.98); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}

/* A second, quieter line. The balance answer is two facts — what happened,
   and which provider it happened on — and stacking them reads faster than
   folding both into one long sentence. */
.dsh-claude-pet__bubble-sub {
  margin-top: 0.18em;
  color: #8b8276;
  font-size: 0.82em;
  font-weight: 400;
}

/* The one thing she is allowed to say flatly: this provider cannot be asked. */
.dsh-claude-pet__bubble[data-tone="alert"] {
  color: #c0392b;
  font-weight: 600;
}

.dsh-claude-pet__bubble[data-tone="alert"] .dsh-claude-pet__bubble-sub {
  color: #8b8276;
  font-weight: 400;
}

/* --- The context menu --------------------------------------------------- */

/* Two items, drawn in the page rather than handed to the shell: a native menu
   would put stock chrome beside a hand-drawn pet. Fixed-positioned so it may
   hang outside her box without being clipped by it. */
.dsh-claude-pet__menu {
  position: fixed;
  min-width: 148px;
  padding: 5px;
  border-radius: 12px;
  background: #fdfcfa;
  color: #2f2b26;
  box-shadow: 0 18px 40px -14px rgba(50, 40, 30, 0.42),
    0 2px 8px rgba(50, 40, 30, 0.12);
  z-index: 40;
}

.dsh-claude-pet__menu-item {
  display: block;
  width: 100%;
  padding: 8px 12px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 13.5px;
  text-align: left;
  cursor: pointer;
}

.dsh-claude-pet__menu-item:hover {
  background: rgba(80, 64, 48, 0.09);
}

.dsh-claude-pet__menu-item:focus-visible {
  outline: 2px solid rgb(94, 129, 172);
  outline-offset: -2px;
}

/* --- The dismiss button ------------------------------------------------- */

/* Hidden until the pointer is over her: one deliberate hover gate in front of
   the only action that takes her away. */
.dsh-claude-pet__close {
  position: absolute;
  top: -6px;
  right: -6px;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: rgba(28, 26, 24, 0.86);
  color: #f4efe6;
  font-size: 12px;
  line-height: 20px;
  text-align: center;
  cursor: pointer;
  opacity: 0;
  transition: opacity 120ms ease-out;
}

.dsh-claude-pet:hover .dsh-claude-pet__close,
.dsh-claude-pet__close:focus-visible {
  opacity: 1;
}

.dsh-claude-pet__close:hover {
  background: rgba(28, 26, 24, 1);
}

/* --- Shared controls ---------------------------------------------------- */

/* Self-drawn rather than borrowed from the primitives package: that package
   is a browser-module-table external, and depending on it for a switch and a
   slider would mean declaring an extra runtime dependency for every install. */
.dsh-claude-pet-row__track,
.dsh-claude-pet-switch__track {
  position: relative;
  width: 34px;
  height: 20px;
  border-radius: 10px;
  background: rgba(128, 128, 128, 0.45);
  transition: background 140ms ease-out;
}

.dsh-claude-pet-row__switch input:checked + .dsh-claude-pet-row__track,
.dsh-claude-pet-switch input:checked + .dsh-claude-pet-switch__track {
  background: rgb(94, 129, 172);
}

.dsh-claude-pet-row__track::after,
.dsh-claude-pet-switch__track::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  transition: transform 140ms ease-out;
}

.dsh-claude-pet-row__switch input:checked + .dsh-claude-pet-row__track::after,
.dsh-claude-pet-switch input:checked + .dsh-claude-pet-switch__track::after {
  transform: translateX(14px);
}

.dsh-claude-pet-row__switch input,
.dsh-claude-pet-switch input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}

/* A switch that cannot do anything here still shows its state, so the page
   explains itself instead of hiding the option and leaving a gap. */
.dsh-claude-pet-switch[data-disabled='true'] {
  opacity: 0.45;
  cursor: not-allowed;
}

/* --- The compact row in Settings → General ------------------------------ */

.dsh-claude-pet-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 0;
  font-size: 13px;
  line-height: 1.5;
}

.dsh-claude-pet-row__label {
  font-weight: 500;
}

.dsh-claude-pet-row__hint {
  opacity: 0.62;
  font-size: 12px;
}

.dsh-claude-pet-row__controls {
  display: flex;
  flex-shrink: 0;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
}

.dsh-claude-pet-row__switch {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}

.dsh-claude-pet-row__reset {
  border: 0;
  padding: 0;
  background: none;
  color: inherit;
  font: inherit;
  font-size: 12px;
  opacity: 0.72;
  text-decoration: underline;
  cursor: pointer;
}

.dsh-claude-pet-row__reset:hover {
  opacity: 1;
}

/* --- Her own page in the settings sidebar ------------------------------- */

.dsh-claude-pet-panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 4px 2px 24px;
  font-size: 13px;
  line-height: 1.55;
}

.dsh-claude-pet-panel__title {
  font-size: 15px;
  font-weight: 600;
}

.dsh-claude-pet-panel__sub {
  margin-top: 2px;
  font-size: 12px;
  opacity: 0.62;
}

.dsh-claude-pet-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 16px;
  border-radius: 12px;
  background: rgba(127, 127, 127, 0.08);
}

.dsh-claude-pet-card__title {
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  opacity: 0.6;
}

.dsh-claude-pet-field {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.dsh-claude-pet-field__text {
  min-width: 0;
}

.dsh-claude-pet-field__label {
  font-weight: 500;
}

.dsh-claude-pet-field__hint {
  font-size: 12px;
  opacity: 0.6;
}

.dsh-claude-pet-field__control {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 8px;
}

/* A state line: the one sentence that says whether she is out right now. */
.dsh-claude-pet-state {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  opacity: 0.8;
}

.dsh-claude-pet-state__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: rgb(94, 129, 172);
  flex-shrink: 0;
}

.dsh-claude-pet-state[data-on="false"] .dsh-claude-pet-state__dot {
  background: rgba(127, 127, 127, 0.6);
}

/* Segmented control, for the four display choices. */
.dsh-claude-pet-seg {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border-radius: 10px;
  background: rgba(127, 127, 127, 0.16);
  flex-wrap: wrap;
}

.dsh-claude-pet-seg button {
  padding: 5px 10px;
  border: 0;
  border-radius: 8px;
  background: none;
  color: inherit;
  font: inherit;
  font-size: 12px;
  opacity: 0.75;
  cursor: pointer;
}

.dsh-claude-pet-seg button[aria-pressed="true"] {
  background: rgba(127, 127, 127, 0.32);
  opacity: 1;
  font-weight: 600;
}

/* The corner picker: a miniature frame with four buttons in its corners, so
   the choice is made by pointing at where she should stand rather than by
   reading four words and translating them in your head. */
.dsh-claude-pet-grid {
  position: relative;
  width: 92px;
  height: 62px;
  border: 1px solid rgba(127, 127, 127, 0.35);
  border-radius: 10px;
  flex-shrink: 0;
}

.dsh-claude-pet-grid button {
  position: absolute;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 1px solid rgba(127, 127, 127, 0.45);
  border-radius: 6px;
  background: rgba(127, 127, 127, 0.2);
  cursor: pointer;
}

.dsh-claude-pet-grid button[aria-pressed="true"] {
  background: rgb(94, 129, 172);
  border-color: rgb(94, 129, 172);
}

.dsh-claude-pet-grid__tl { top: 5px; left: 5px; }
.dsh-claude-pet-grid__tr { top: 5px; right: 5px; }
.dsh-claude-pet-grid__bl { bottom: 5px; left: 5px; }
.dsh-claude-pet-grid__br { bottom: 5px; right: 5px; }

.dsh-claude-pet-range {
  width: 148px;
  accent-color: rgb(94, 129, 172);
}

/* The page's only text field, because her name is the one thing that cannot be
   picked from a list. Styled to sit beside the self-drawn switch and slider:
   same 148px column, same soft border, same accent on focus. */
.dsh-claude-pet-input {
  width: 148px;
  padding: 6px 9px;
  border: 1px solid rgba(127, 127, 127, 0.35);
  border-radius: 9px;
  background: rgba(127, 127, 127, 0.06);
  color: inherit;
  font: inherit;
  font-size: 13px;
  outline: none;
}

.dsh-claude-pet-input:focus {
  border-color: rgb(94, 129, 172);
  box-shadow: 0 0 0 3px rgba(94, 129, 172, 0.16);
}

.dsh-claude-pet-input::placeholder {
  color: currentColor;
  opacity: 0.4;
}

.dsh-claude-pet-value {
  min-width: 44px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  text-align: right;
  opacity: 0.75;
}

.dsh-claude-pet-btn {
  padding: 6px 12px;
  border: 1px solid rgba(127, 127, 127, 0.35);
  border-radius: 9px;
  background: rgba(127, 127, 127, 0.1);
  color: inherit;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.dsh-claude-pet-btn:hover {
  background: rgba(127, 127, 127, 0.2);
}

.dsh-claude-pet-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

/* Standing still is the whole point of the setting, so the idle motion and
   the writing hand both stop. The blink stays: an eyelid is not the kind of
   motion that setting is about, and a pet that never blinks reads as a
   broken image. */
@media (prefers-reduced-motion: reduce) {
  .dsh-claude-pet__shift,
  .dsh-claude-pet__sway,
  .dsh-claude-pet__bob,
  .dsh-claude-pet__write,
  .dsh-claude-pet__poke.is-poked,
  .dsh-claude-pet__bubble { animation: none; }
}

/* --- Light/dark --------------------------------------------------------- */

@media (prefers-color-scheme: light) {
  /* The balloon is already paper-coloured, so only the dismiss button needs a
     light-mode face of its own. */
  .dsh-claude-pet__bubble,
  .dsh-claude-pet__bubble::after {
    background: #fcfbf8;
  }
  .dsh-claude-pet__close {
    background: rgba(252, 250, 246, 0.96);
    color: #2b2723;
    box-shadow: none;
  }
  .dsh-claude-pet__close:hover {
    background: rgba(252, 250, 246, 1);
  }
  .dsh-claude-pet-card {
    background: rgba(127, 127, 127, 0.1);
  }
}
`

    // ---------------------------------------------------------------------
    // Components
    // ---------------------------------------------------------------------

    /** The custom properties every measurement in the stylesheet reads. */
    function frameStyle(settings) {
      const dims = metricsOf(settings.size)
      return {
        '--dsh-cp-w': `${dims.w}px`,
        '--dsh-cp-h': `${dims.h}px`,
        '--dsh-cp-mx': `${settings.marginX}px`,
        '--dsh-cp-my': `${settings.marginY}px`,
      }
    }

    function Pet() {
      const mode = useSyncExternalStore(
        poseStore.subscribe,
        poseStore.getSnapshot,
        poseStore.getSnapshot,
      )
      const nonce = useSyncExternalStore(
        pokeStore.subscribe,
        pokeStore.getSnapshot,
        pokeStore.getSnapshot,
      )
      const bubble = useSyncExternalStore(
        bubbleStore.subscribe,
        bubbleStore.getSnapshot,
        bubbleStore.getSnapshot,
      )
      const settings = useSyncExternalStore(
        settingsStore.subscribe,
        settingsStore.getSnapshot,
        settingsStore.getSnapshot,
      )

      // Hook order must not depend on whether she is on screen, so the menu
      // state is declared before the early return.
      const [menu, setMenu] = React.useState(null)

      React.useEffect(() => {
        if (menu === null) return undefined
        const close = () => setMenu(null)
        const onKey = (event) => {
          if (event.key === 'Escape') close()
        }
        // Bubble phase, not capture: the menu's own items stop propagation on
        // pointerdown, which is what keeps a click from closing the menu
        // before the click event ever reaches the button.
        window.addEventListener('pointerdown', close)
        window.addEventListener('keydown', onKey)
        return () => {
          window.removeEventListener('pointerdown', close)
          window.removeEventListener('keydown', onKey)
        }
      }, [menu])

      if (hiddenReason(settings) !== null) return null

      const free = settings.position
      const style = frameStyle(settings)
      if (free !== null) {
        style.left = `${free.x}px`
        style.top = `${free.y}px`
      }

      return h(
        React.Fragment,
        null,
        h('style', { key: 'style' }, STYLE),
        h(
          'div',
          {
            key: 'body',
            className: 'dsh-claude-pet',
            'data-dsh-claude-pet': '',
            'data-dsh-pet-mode': mode,
            'data-corner': settings.corner,
            'data-free': free === null ? 'false' : 'true',
            'data-dragging': drag !== null ? 'true' : 'false',
            style,
            title: petName(settings) + ' · ' + t('pet.pokeHint'),
            onPointerDown,
            onPointerMove,
            onPointerUp,
            onPointerCancel: onPointerUp,
            onContextMenu: (event) => {
              event.preventDefault()
              // Measured against a fixed box rather than the real one: the
              // menu is not mounted yet, and two `Math.max` calls are cheaper
              // than a layout read on the frame the menu opens.
              setMenu({
                x: Math.max(8, Math.min(event.clientX, window.innerWidth - 184)),
                y: Math.max(8, Math.min(event.clientY, window.innerHeight - 100)),
              })
            },
          },
          h('div', { className: 'dsh-claude-pet__shadow' }),
          h(
            'div',
            { className: 'dsh-claude-pet__shift' },
            h(
              'div',
              { className: 'dsh-claude-pet__sway' },
              h(
                'div',
                { className: 'dsh-claude-pet__bob' },
                h(
                  'div',
                  { className: 'dsh-claude-pet__write' },
                  h(
                    'div',
                    {
                      // Keying on the poke count remounts this box, which is
                      // what replays a CSS animation that has already run.
                      key: nonce,
                      className:
                        'dsh-claude-pet__poke' + (nonce > 0 ? ' is-poked' : ''),
                    },
                    h('div', {
                      className: 'dsh-claude-pet__figure',
                      'data-mode': mode,
                    }),
                  ),
                ),
              ),
            ),
          ),
          bubble.text === null
            ? null
            : h(
                'div',
                {
                  key: bubble.nonce,
                  className: 'dsh-claude-pet__bubble',
                  'data-tone': bubble.tone,
                  'aria-hidden': 'true',
                },
                bubble.text,
                bubble.sub === null
                  ? null
                  : h('div', { className: 'dsh-claude-pet__bubble-sub' }, bubble.sub),
              ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-claude-pet__close',
              'aria-label': t('pet.dismissLabel'),
              title: t('pet.dismissLabel'),
              onPointerDown: (event) => event.stopPropagation(),
              onClick: (event) => {
                event.stopPropagation()
                say([t('pet.dismiss')], 2000)
                updateSettings({ enabled: false })
              },
            },
            '×',
          ),
          menu === null
            ? null
            : h(
                'div',
                {
                  key: 'menu',
                  className: 'dsh-claude-pet__menu',
                  role: 'menu',
                  style: { left: menu.x + 'px', top: menu.y + 'px' },
                  // The menu lives inside her box, so her own drag handler is
                  // the default action for everything in it.
                  onPointerDown: (event) => event.stopPropagation(),
                  onContextMenu: (event) => event.preventDefault(),
                },
                h(
                  'button',
                  {
                    type: 'button',
                    role: 'menuitem',
                    className: 'dsh-claude-pet__menu-item',
                    title: t('menu.hintChatter'),
                    onPointerDown: (event) => event.stopPropagation(),
                    onClick: () => {
                      setMenu(null)
                      say(linesFor(poseStore.get()), 5200)
                    },
                  },
                  t('menu.chatter'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    role: 'menuitem',
                    className: 'dsh-claude-pet__menu-item',
                    title: t('menu.hintBalance'),
                    onPointerDown: (event) => event.stopPropagation(),
                    onClick: () => {
                      setMenu(null)
                      checkBalance()
                    },
                  },
                  t('menu.balance'),
                ),
              ),
        ),
      )
    }

    /** Reads settings and the locale, and re-renders when either changes. */
    function useSettings() {
      const settings = useSyncExternalStore(
        settingsStore.subscribe,
        settingsStore.getSnapshot,
        settingsStore.getSnapshot,
      )
      // Subscribed purely so the copy re-renders on a language switch.
      useSyncExternalStore(
        localeStore.subscribe,
        localeStore.getSnapshot,
        localeStore.getSnapshot,
      )
      return settings
    }

    function Switch(props) {
      return h(
        'label',
        {
          className: 'dsh-claude-pet-switch',
          'data-disabled': props.disabled === true ? 'true' : 'false',
        },
        h('input', {
          type: 'checkbox',
          checked: props.checked,
          disabled: props.disabled === true,
          onChange: (event) => props.onChange(event.target.checked),
        }),
        h('span', { className: 'dsh-claude-pet-switch__track' }),
      )
    }

    /**
     * A slider that reports continuously but only writes to storage when the
     * gesture ends: the pet must follow the thumb, and a localStorage write
     * per pointer move would be both wasteful and janky.
     */
    function Slider(props) {
      return h('input', {
        className: 'dsh-claude-pet-range',
        type: 'range',
        min: props.min,
        max: props.max,
        step: props.step ?? 1,
        value: props.value,
        'aria-label': props.label,
        onInput: (event) => props.onInput(Number(event.target.value)),
        onPointerUp: persistSettings,
        onKeyUp: persistSettings,
        onBlur: persistSettings,
      })
    }

    function Field(props) {
      return h(
        'div',
        { className: 'dsh-claude-pet-field' },
        h(
          'div',
          { className: 'dsh-claude-pet-field__text' },
          h('div', { className: 'dsh-claude-pet-field__label' }, props.label),
          props.hint === undefined
            ? null
            : h('div', { className: 'dsh-claude-pet-field__hint' }, props.hint),
        ),
        h('div', { className: 'dsh-claude-pet-field__control' }, props.children),
      )
    }

    function Card(props) {
      return h(
        'div',
        { className: 'dsh-claude-pet-card' },
        h('div', { className: 'dsh-claude-pet-card__title' }, props.title),
        props.children,
      )
    }

    /**
     * The Settings → General row.
     *
     * Deliberately short: it carries the two things someone toggles day to day
     * and a way to put her back, and points at the full page for the rest.
     * The row draws its own internals — the settings column only stacks rows,
     * so copy, values and the write path are all ours.
     */
    function PetSettingsRow() {
      const settings = useSettings()

      return h(
        'div',
        { className: 'dsh-claude-pet-row', 'data-dsh-claude-pet-row': '' },
        h('style', null, STYLE),
        h(
          'div',
          null,
          h('div', { className: 'dsh-claude-pet-row__label' }, t('settings.title')),
          h(
            'div',
            { className: 'dsh-claude-pet-row__hint' },
            `${t('settings.showHint')} ${t('settings.chatterHint')} ${t('settings.moreHint')}`,
          ),
        ),
        h(
          'div',
          { className: 'dsh-claude-pet-row__controls' },
          h(
            'label',
            { className: 'dsh-claude-pet-row__switch' },
            h('span', null, t('settings.show')),
            h('input', {
              type: 'checkbox',
              checked: settings.enabled,
              onChange: (event) => updateSettings({ enabled: event.target.checked }),
            }),
            h('span', { className: 'dsh-claude-pet-row__track' }),
          ),
          h(
            'label',
            { className: 'dsh-claude-pet-row__switch' },
            h('span', null, t('settings.chatter')),
            h('input', {
              type: 'checkbox',
              checked: settings.chatter,
              onChange: (event) => updateSettings({ chatter: event.target.checked }),
            }),
            h('span', { className: 'dsh-claude-pet-row__track' }),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-claude-pet-row__reset',
              title: t('settings.resetHint'),
              onClick: () => updateSettings({ position: null }),
            },
            t('settings.reset'),
          ),
        ),
      )
    }

    /**
     * Her page: 设置 → Claude 宠物.
     *
     * Four groups, ordered the way someone meets her: is she here, what does
     * she look like, where does she stand, what does she do. Every control is
     * a control rather than a text field — a switch, a slider, a segmented
     * choice, a picture of the four corners — because the whole point is that
     * nobody has to know what a "margin" is to put her where they want.
     */
    function PetSettingsSection() {
      const settings = useSettings()
      const reason = hiddenReason(settings)
      const desktop = onDesktopSurface()
      const dims = metricsOf(settings.size)

      const display = (value, key) =>
        h(
          'button',
          {
            type: 'button',
            'aria-pressed': settings.display === value ? 'true' : 'false',
            onClick: () => updateSettings({ display: value }),
          },
          t(key),
        )

      const corner = (value, className) =>
        h('button', {
          type: 'button',
          className,
          'aria-label': t(`corner.${value}`),
          title: t(`corner.${value}`),
          'aria-pressed': settings.corner === value ? 'true' : 'false',
          onClick: () =>
            updateSettings({
              corner: value,
              // A top corner with the bottom corner's 104px inset would float
              // her a tenth of the way down the window for no reason.
              marginY:
                value.indexOf('top') === 0 && settings.marginY > 60
                  ? MARGIN_Y_TOP_DEFAULT
                  : settings.marginY,
              // Choosing a corner is a statement about where she belongs, so
              // it releases a hand-dragged position.
              position: null,
            }),
        })

      return h(
        'div',
        { className: 'dsh-claude-pet-panel', 'data-dsh-claude-pet-panel': '' },
        h('style', null, STYLE),
        h(
          'div',
          null,
          h('div', { className: 'dsh-claude-pet-panel__title' }, t('settings.title')),
          h('div', { className: 'dsh-claude-pet-panel__sub' }, `${petName(settings)} · ${t('panel.subtitle')}`),
        ),

        h(
          'div',
          { className: 'dsh-claude-pet-state', 'data-on': reason === null ? 'true' : 'false' },
          h('span', { className: 'dsh-claude-pet-state__dot' }),
          h(
            'span',
            null,
            reason === null
              ? `${t('state.shown')} ${desktop ? t('surface.desktop') : t('surface.web')}`
              : reason === 'enabled'
                ? t('state.hidden.off')
                : t('state.hidden.display'),
          ),
        ),

        h(
          Card,
          { title: t('panel.behaviour') },
          h(
            Field,
            { label: t('field.name'), hint: t('field.nameHint') },
            h('input', {
              className: 'dsh-claude-pet-input',
              type: 'text',
              value: settings.name,
              maxLength: NAME_MAX,
              placeholder: t('field.namePlaceholder'),
              'aria-label': t('field.name'),
              // Follows the keystroke but only writes on blur: typing is not a
              // series of decisions, and a localStorage write per character
              // would be both wasteful and noisy for the other tabs.
              onChange: (event) =>
                updateSettings({ name: event.target.value.slice(0, NAME_MAX) }, { persist: false }),
              onBlur: persistSettings,
              onKeyDown: (event) => {
                if (event.key === 'Enter') event.currentTarget.blur()
              },
            }),
          ),
          h(
            Field,
            { label: t('field.display'), hint: t('field.displayHint') },
            h(
              'div',
              { className: 'dsh-claude-pet-seg' },
              display('both', 'display.both'),
              display('desktop', 'display.desktop'),
              display('web', 'display.web'),
              display('none', 'display.none'),
            ),
          ),
          h(
            Field,
            { label: t('field.chatter'), hint: t('field.chatterHint') },
            h(Switch, {
              checked: settings.chatter,
              onChange: (next) => updateSettings({ chatter: next }),
            }),
          ),
          h(
            Field,
            {
              label: t('field.desktopPet'),
              hint: desktop ? t('field.desktopPetHint') : t('desktop.unavailable'),
            },
            h(Switch, {
              checked: settings.desktopPet,
              disabled: !desktop,
              onChange: (next) => updateSettings({ desktopPet: next }),
            }),
          ),
        ),

        h(
          Card,
          { title: t('panel.appearance') },
          h(
            Field,
            { label: t('field.size'), hint: t('field.sizeHint') },
            h(Slider, {
              min: SIZE_MIN,
              max: SIZE_MAX,
              step: 5,
              value: settings.size,
              label: t('field.size'),
              onInput: (value) => updateSettings({ size: clampSize(value) }, { persist: false }),
            }),
            h('span', { className: 'dsh-claude-pet-value' }, `${settings.size}% · ${dims.w}×${dims.h}`),
          ),
          h(
            Field,
            { label: t('field.corner'), hint: t('field.cornerHint') },
            h(
              'div',
              { className: 'dsh-claude-pet-grid' },
              corner('top-left', 'dsh-claude-pet-grid__tl'),
              corner('top-right', 'dsh-claude-pet-grid__tr'),
              corner('bottom-left', 'dsh-claude-pet-grid__bl'),
              corner('bottom-right', 'dsh-claude-pet-grid__br'),
            ),
          ),
          h(
            Field,
            { label: t('field.marginX') },
            h(Slider, {
              min: 0,
              max: 240,
              step: 4,
              value: settings.marginX,
              label: t('field.marginX'),
              onInput: (value) =>
                updateSettings({ marginX: value, position: null }, { persist: false }),
            }),
            h('span', { className: 'dsh-claude-pet-value' }, `${settings.marginX}px`),
          ),
          h(
            Field,
            { label: t('field.marginY') },
            h(Slider, {
              min: 0,
              max: 240,
              step: 4,
              value: settings.marginY,
              label: t('field.marginY'),
              onInput: (value) =>
                updateSettings({ marginY: value, position: null }, { persist: false }),
            }),
            h('span', { className: 'dsh-claude-pet-value' }, `${settings.marginY}px`),
          ),
          h(
            'div',
            { className: 'dsh-claude-pet-actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-claude-pet-btn',
                onClick: () =>
                  updateSettings({
                    position: null,
                    corner: CORNER_DEFAULT,
                    marginX: MARGIN_X_DEFAULT,
                    marginY: MARGIN_Y_DEFAULT,
                    size: SIZE_DEFAULT,
                  }),
              },
              t('settings.reset'),
            ),
          ),
        ),

        h(
          Card,
          { title: t('panel.actions') },
          h(
            'div',
            { className: 'dsh-claude-pet-actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-claude-pet-btn',
                onClick: () => updateSettings({ enabled: !settings.enabled }),
              },
              settings.enabled ? t('action.hide') : t('action.show'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-claude-pet-btn',
                onClick: () => say(linesFor(poseStore.get()), 2600),
              },
              t('action.speak'),
            ),
          ),
        ),
      )
    }

    /**
     * The glyph beside her row in the settings sidebar.
     *
     * The shell renders this slot with `{only: id}`, so the registration id
     * has to equal the section's id exactly. One inline SVG rather than a file
     * under `./assets/*`: the shell sizes the box to 16px and colours it by
     * text colour, and a same-colour path with `currentColor` costs nothing and
     * has no request behind it.
     */
    function PetSectionIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 16
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true',
        },
        h('path', {
          d: 'M2.6 13.4V4.9c0-.8.6-1.4 1.4-1.4h2.3c.5 0 .9.2 1.2.6l.5.7c.3.4.7.6 1.2.6h2.3c.8 0 1.4.6 1.4 1.4v6.6c0 .8-.6 1.4-1.4 1.4H4c-.8 0-1.4-.6-1.4-1.4Z',
          stroke: 'currentColor',
          strokeWidth: '1.2',
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M5 10.6c.9-.9 1.7-.9 2.5 0 .9.9 1.7.9 2.6 0',
          stroke: 'currentColor',
          strokeWidth: '1.2',
          strokeLinecap: 'round',
        }),
      )
    }

    /**
     * Pose from the Conversation layer's `legacy` slice.
     *
     * `partial` is the assistant message currently streaming to the screen;
     * `runningCalls` are tool calls with no result yet, each tagged with the
     * phase that separates a call being *described* from a call being
     * *executed*. An executing call, or text already on its way, reads as
     * working; a call the model is still writing out, or a turn that has
     * opened with nothing produced yet, reads as thinking.
     *
     * Everything here is optional-by-design: `legacy` may be absent while the
     * view assembles, and a missing slice degrades to a calmer pose rather
     * than to an exception.
     */
    function poseOf(activity) {
      const legacy = activity?.legacy
      if (legacy !== undefined && legacy !== null) {
        let preparing = false
        for (const call of legacy.runningCalls ?? []) {
          if (call?.phase === 'start') return MODE_WORKING
          preparing = true
        }
        if (legacy.partial !== null && legacy.partial !== undefined) return MODE_WORKING
        if (preparing) return MODE_THINKING
      }
      return activity?.open === true ? MODE_THINKING : MODE_IDLE
    }

    TRACE.push('factory:done')
    TRACE.push('return:plugin-object')

    return {
      name: 'dsh-claude-pet',
      // `slots` is a hard need: without it there is nothing to render into.
      // `sessions` deliberately is not — she must still appear in a shell that
      // has no session service, and a hard dependency that is briefly absent
      // would keep the whole plugin from activating at all.
      inject: ['slots'],
      apply(ctx) {
        // Deliberately does not poke at `ctx.sessions` here: with `sessions`
        // out of `inject`, that property is a strict getter that throws, and
        // one throw on the first line of `apply` costs the whole plugin.
        TRACE.push('apply:enter')
        // Declared up front: the chatter scheduler reads `timer` the first
        // time it runs, which happens while this body is still executing.
        let timer
        let hideTimer
        let chatterTimer

        // State the status bridge keeps while it follows a session. Declared
        // here rather than inside the `uiConversation` injection so the
        // console probe below can read it even when that service never shows
        // up — an absent probe tells you nothing, while one that answers
        // "no bridge" tells you exactly where to look.
        let trackedId
        let stopOpenTurn
        let stopChat
        let bridgeActivity = { open: false, legacy: undefined }
        let bridgeRunning = false
        let bridgeAttached = false
        let bridgeError

        // `apply` is the only chance this plugin gets to put something on
        // screen, so every step below is guarded: one failing registration
        // must not take the rest down with it. A shell that cannot show the
        // settings page should still show the pet, and a failure list left on
        // `window` beats a silent disappearing act.
        const failures = []
        window.__dshClaudePetFailures = failures
        const guard = (label, run) => {
          try {
            run()
          } catch (error) {
            failures.push(`${label}: ${error && error.message ? error.message : String(error)}`)
          }
        }

        // --- preferences --------------------------------------------------

        guard('preferences', () => {
          const stored = readStoredSettings()
          if (stored !== undefined) settingsStore.set(stored)
        })

        // --- the pet ------------------------------------------------------
        //
        // Deliberately registered before anything else: `shell.overlay` is
        // live from boot, whereas the settings slots only exist once the user
        // opens that page. If anything below ever throws again, she is already
        // mounted by then.

        guard('pet', () => {
          ctx.slots.inject('shell.overlay', () =>
            ctx.slots.register(
              { name: 'shell.overlay', id: NS, order: 100 },
              Pet,
            ),
          )
          TRACE.push('slot:shell.overlay:injected')
        })

        // --- her page in the settings sidebar ------------------------------
        //
        // Two registrations, both keyed on the same id: `settings.section`
        // adds the row to the sidebar, and `settings.section.icon` is asked for
        // `{only: <row id>}`, so the glyph only paints beside her own row.

        guard('settings-section', () => {
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              {
                name: 'settings.section',
                id: NS,
                order: 45,
                label: () => t('settings.title'),
              },
              PetSettingsSection,
            ),
          )
          TRACE.push('slot:settings.section:injected')
        })

        guard('settings-section-icon', () => {
          ctx.slots.inject('settings.section.icon', () =>
            ctx.slots.register(
              { name: 'settings.section.icon', id: NS, order: 45 },
              PetSectionIcon,
            ),
          )
        })

        // --- the compact row in General ------------------------------------

        guard('settings-row', () => {
          ctx.slots.inject('settings.general.item', () =>
            ctx.slots.register(
              {
                name: 'settings.general.item',
                id: NS,
                order: 40,
                label: () => t('settings.title'),
              },
              PetSettingsRow,
            ),
          )
        })

        // --- bubbles ------------------------------------------------------

        /**
         * Shows a line for a while. Every caller passes its own duration, so
         * a poke's reaction and the ambient muttering do not fight over one
         * shared timeout.
         */
        /**
         * Puts a balloon on screen. `sub` is the quieter second line the
         * balance answer needs; `tone` is 'plain' or 'alert', and only the
         * former is her voice — an alert is the interface telling the truth.
         */
        function showBubble(text, sub, tone, holdMs) {
          if (hiddenReason(settingsStore.get()) !== null) return
          const previous = bubbleStore.get()
          bubbleStore.set({ text, sub, tone, nonce: previous.nonce + 1 })
          if (hideTimer !== undefined) {
            hideTimer()
            hideTimer = undefined
          }
          if (!(holdMs > 0)) return
          hideTimer = timer?.timeout(() => {
            hideTimer = undefined
            bubbleStore.set({ text: null, sub: null, tone: 'plain', nonce: bubbleStore.get().nonce + 1 })
          }, holdMs)
        }

        function sayLines(lines, holdMs) {
          if (lines.length === 0) return
          showBubble(lines[Math.floor(Math.random() * lines.length)], null, 'plain', holdMs)
        }

        // The pointer handlers sit outside `apply` (a drag must not re-render
        // the tree), so the speakers are handed to them through these
        // module-level bindings rather than being captured.
        say = sayLines
        sayBubble = showBubble

        // --- the balance answer -------------------------------------------

        /**
         * Asks the host, because only the host can see the current provider
         * and the account service. The three failure shapes are distinguished
         * on purpose: "this provider has no balance API" is a fact about the
         * provider, and saying it plainly is better than a retry button that
         * could never succeed.
         */
        function readBalance() {
          fetch(API_BASE + '/balance', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
            .then((response) => (response.ok ? response.json() : Promise.reject(new Error('HTTP ' + response.status))))
            .then((result) => {
              const provider = typeof result?.provider === 'string' ? result.provider : ''
              const label = provider === '' ? t('balance.providerUnknown') : provider
              if (result?.kind === 'ok') {
                const wallets = Array.isArray(result.wallets) ? result.wallets : []
                if (wallets.length === 0) {
                  sayBubble(t('balance.empty'), t('balance.provider') + label, 'plain', 6000)
                  return
                }
                sayBubble(
                  wallets.map((wallet) => moneyLabel(wallet)).join('   ·   '),
                  t('balance.provider') + label,
                  'plain',
                  6500,
                )
                return
              }
              if (result?.kind === 'unsupported') {
                sayBubble(t('balance.unsupported'), t('balance.provider') + label, 'alert', 6000)
                return
              }
              if (result?.kind === 'missing') {
                sayBubble(t('balance.missing'), t('balance.provider') + label, 'alert', 6000)
                return
              }
              sayBubble(t('balance.failed'), t('balance.provider') + label, 'alert', 6000)
            })
            .catch(() => {
              sayBubble(t('balance.failed'), null, 'alert', 5000)
            })
        }

        checkBalance = () => {
          sayBubble(t('balance.checking'), null, 'plain', 2200)
          readBalance()
        }

        // --- the desktop window -------------------------------------------
        //
        // The helper cannot see this page, so the page tells it what to show.
        // Only the *hidden* case is reported as visible: while the window is
        // on screen she is already here, and two of her at once would be one
        // too many.
        function reportDesktop() {
          const settings = settingsStore.get()
          const payload = {
            desktop: onDesktopSurface(),
            desktopPet: settings.desktopPet !== false,
            enabled: settings.enabled,
            display: settings.display,
            name: petName(settings),
            size: settings.size,
            lang: localeStore.get(),
            hidden: document.visibilityState === 'hidden',
          }
          return fetch(API_BASE + '/report', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          }).catch(() => {})
        }

        ctx.effect(() => {
          let stopSettings
          let stopLocale
          let heartbeat
          const onVisibility = () => {
            reportDesktop()
          }
          guard('desktop-report', () => {
            reportDesktop()
            stopSettings = settingsStore.subscribe(reportDesktop)
            stopLocale = localeStore.subscribe(reportDesktop)
            document.addEventListener('visibilitychange', onVisibility)
            // A 30s heartbeat covers the case where the window was hidden by
            // the OS rather than by the page (minimise, lock screen) and no
            // visibility event ever fired.
            heartbeat = timer?.interval(reportDesktop, 30000)
          })
          return () => {
            if (stopSettings !== undefined) stopSettings()
            if (stopLocale !== undefined) stopLocale()
            document.removeEventListener('visibilitychange', onVisibility)
            if (heartbeat !== undefined) heartbeat()
          }
        })

        // --- muttering ----------------------------------------------------

        /**
         * The ambient chatter loop.
         *
         * Deliberately irregular and deliberately slow: she speaks every 24
         * to 52 seconds, so the corner stays alive without becoming a ticker.
         * The gap is re-rolled every time rather than being a fixed interval,
         * for the same reason the blinks are uneven — a metronome is what
         * makes a character read as a sprite.
         *
         * A line is chosen for the pose she is *in* when the timer fires, so
         * she never announces "third draft" while standing there with a book.
         */
        const CHATTER_MIN_MS = 24000
        const CHATTER_SPREAD_MS = 28000
        const CHATTER_HOLD_MS = 5200

        function scheduleChatter() {
          if (chatterTimer !== undefined) {
            chatterTimer()
            chatterTimer = undefined
          }
          if (timer === undefined) return
          const delay = CHATTER_MIN_MS + Math.random() * CHATTER_SPREAD_MS
          chatterTimer = timer.timeout(() => {
            chatterTimer = undefined
            const settings = settingsStore.get()
            if (settings.chatter && hiddenReason(settings) === null) {
              say(linesFor(poseStore.get()), CHATTER_HOLD_MS)
            }
            scheduleChatter()
          }, delay)
        }

        ctx.effect(() => {
          guard('chatter-loop', scheduleChatter)
          return () => {
            if (chatterTimer !== undefined) chatterTimer()
            if (hideTimer !== undefined) hideTimer()
            chatterTimer = undefined
            hideTimer = undefined
          }
        })

        // --- timers and locale -------------------------------------------

        // Both are optional services: without `timer` she simply never
        // mutters, and without `locale` she falls back to English. Neither is
        // a reason to keep her off the screen.
        guard('timer', () => {
          ctx.inject(['timer'], (injected) => {
            timer = injected.get('timer')
            scheduleChatter()
            return () => {
              timer = undefined
            }
          })
        })

        guard('locale', () => {
          ctx.inject(['locale'], (injected) => {
            const locale = injected.get('locale')
            if (locale === undefined) return
            const apply = () => {
              const snapshot = locale.getSnapshot()
              if (typeof snapshot?.active === 'string') localeStore.set(snapshot.active)
            }
            apply()
            const stop = locale.subscribe(apply)
            return stop
          })
        })

        // --- keep her on screen -------------------------------------------

        /**
         * Re-seat her after the window changes shape.
         *
         * Both paths need it: a dragged position is stale by definition, and a
         * docked one is only stale once the box no longer fits — which is why
         * the docked case also drops back to the corner when the window has
         * shrunk past the margins.
         */
        ctx.effect(() => {
          const onResize = () => {
            guard('resize-clamp', () => {
              const settings = settingsStore.get()
              if (settings.position === null) return
              updateSettings({ position: place(settings.position, false) })
            })
          }
          window.addEventListener('resize', onResize)
          return () => window.removeEventListener('resize', onResize)
        })

        // --- the console probe ---------------------------------------------
        //
        // Defined here, unconditionally, on purpose. It used to live inside the
        // `uiConversation` injection below, which meant that whenever that
        // service was missing the probe vanished too — so `__dshClaudePet()`
        // answering `is not defined` told you nothing at all. Defined at this
        // level it always exists, and `attached: false` / `lastError` point at
        // the bridge instead of leaving you guessing. Read-only, and nothing
        // in the pet depends on it.
        window.__dshClaudePet = () => ({
          pose: poseStore.get(),
          sessionId: trackedId,
          running: bridgeRunning,
          open: bridgeActivity.open,
          attached: bridgeAttached,
          partial: bridgeActivity.legacy?.partial != null,
          runningCalls: (bridgeActivity.legacy?.runningCalls ?? []).map((call) => ({
            name: call?.name,
            phase: call?.phase,
          })),
          settings: settingsStore.get(),
          surface: onDesktopSurface() ? 'desktop' : 'web',
          hidden: hiddenReason(settingsStore.get()),
          position: currentPosition(),
          bubble: bubbleStore.get().text,
          lastError: bridgeError,
        })

        // --- the thinking/working bridge -----------------------------------
        //
        // The thinking/working distinction lives in the Conversation layer.
        // Wrapping the bridge in `inject` waits for that service properly
        // instead of polling for it, and keeps the two independent: she still
        // appears (idle) in a shell that never brings the conversation up.
        // The callback's return value is the disposer, so the subscription is
        // torn down with the injection.
        ctx.inject(['sessions', 'uiConversation'], (injected) => {
          const conversation = injected.get('uiConversation')
          const sessions = injected.get('sessions')
          if (conversation === undefined || sessions === undefined) return
          TRACE.push('bridge:attached')

          /**
           * The session the main column is showing, or nothing.
           *
           * Only `mainView` counts. Following whichever session happens to be
           * running would let background work — a subagent, or a session you
           * are not looking at — pull her into a pose that has nothing to do
           * with what is on screen. When no session is displayed she rests.
           */
          function pickSession(list) {
            let bestId
            let bestUpdated = -Infinity
            for (const id of list.ids) {
              const row = list.byId[id]
              if (row === undefined) continue
              if ((row.retainedBy?.mainView ?? 0) <= 0) continue
              // Two sessions can briefly both claim the main view during a
              // switch; the more recently touched one is the new one.
              if (row.updatedAt > bestUpdated) {
                bestUpdated = row.updatedAt
                bestId = id
              }
            }
            return bestId
          }

          function publish() {
            // `bridgeRunning` is the fallback for a window whose `turn/start`
            // was never loaded; `openTurn` is the precise signal when it is.
            poseStore.set(
              poseOf({
                open: bridgeActivity.open || bridgeRunning,
                legacy: bridgeActivity.legacy,
              }),
            )
          }

          function detach() {
            if (stopOpenTurn !== undefined) {
              stopOpenTurn()
              stopOpenTurn = undefined
            }
            if (stopChat !== undefined) {
              stopChat()
              stopChat = undefined
            }
            bridgeActivity = { open: false, legacy: undefined }
            bridgeAttached = false
          }

          /**
           * Follow the chosen session's Conversation.
           *
           * Two borrowed sources, both official:
           *
           * - `binding.openTurn` is the latest open turn number, published even
           *   with no view active — "the agent is mid-turn" without touching
           *   the session's raw event window.
           * - `binding.target('chat')` is the chat view's snapshot, whose
           *   `legacy.partial` / `legacy.runningCalls` say what is streaming
           *   and which tool calls are outstanding. Subscribing activates the
           *   target; harmless here, because the session she follows is the one
           *   already on screen.
           *
           * Returns whether the session could be followed at all. `sync`
           * retries while it is false: the list can announce a session a beat
           * before its generation is materialised, and without the retry she
           * would sit on the `running` fallback for the rest of the turn.
           */
          function attach(id) {
            detach()
            const sessionBinding = sessions.binding(id)
            if (sessionBinding === undefined) return false

            let bound
            try {
              // Throws when the session is unknown or its binding is stale.
              bound = conversation.binding(sessionBinding)
            } catch (error) {
              bridgeError = String(error && error.message ? error.message : error)
              return false
            }

            const openTurn = bound.openTurn
            const chat = bound.target('chat')
            bridgeActivity = {
              open: openTurn.getSnapshot() !== undefined,
              legacy: chat.getSnapshot()?.legacy,
            }
            stopOpenTurn = openTurn.subscribe(() => {
              bridgeActivity.open = openTurn.getSnapshot() !== undefined
              publish()
            })
            stopChat = chat.subscribe(() => {
              // May be undefined while the view assembles; `poseOf` copes.
              bridgeActivity.legacy = chat.getSnapshot()?.legacy
              publish()
            })
            return true
          }

          function sync() {
            try {
              const list = sessions.list.getSnapshot()
              const id = pickSession(list)
              if (id !== trackedId) {
                trackedId = id
                if (id === undefined) {
                  detach()
                } else {
                  bridgeAttached = attach(id)
                }
              } else if (id !== undefined && !bridgeAttached) {
                // Picked before its generation existed; the list will not
                // necessarily fire again on its own.
                bridgeAttached = attach(id)
              }
              bridgeRunning = id === undefined ? false : list.byId[id]?.running === true
              publish()
            } catch (error) {
              bridgeError = String(error && error.message ? error.message : error)
            }
          }

          const stopList = sessions.list.subscribe(sync)
          sync()

          // Returning the teardown hands it to the injection: when
          // `uiConversation` goes away the bridge goes with it.
          return () => {
            stopList()
            detach()
          }
        })
      },
    }
  },
})
