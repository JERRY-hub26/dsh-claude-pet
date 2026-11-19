'use strict'

/**
 * Her voice, for the desktop window.
 *
 * These are the same lines the in-page pet speaks. The desktop window is a
 * separate process and cannot require the client bundle, so the table is
 * repeated here; when the voice changes, change both. Only the poses the
 * desktop window can be in are kept — it has no conversation attached, so it
 * is idle, greeting, being poked, or thinking about the rules.
 */

window.PET_LINES = {
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
    ui: {
      chatter: '碎碎念',
      balance: '查看余额',
      checking: '稍等，我去核对一下。',
      unsupported: '当前服务商暂不支持余额查询',
      provider: '当前服务商：',
      unknown: '未知',
      failed: '余额查询失败',
      missing: '缺少余额查询凭证',
      empty: '账上暂时没有可用额度。',
      offline: '主程序好像没有响应。',
    },
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
      '…She has moved the bookmark on by a page.',
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
    ui: {
      chatter: 'Say something',
      balance: 'Balance',
      checking: 'One moment, let me verify.',
      unsupported: 'This provider does not support balance checks',
      provider: 'Provider: ',
      unknown: 'unknown',
      failed: 'Balance check failed',
      missing: 'No credential for the balance check',
      empty: 'Nothing left on the account.',
      offline: 'The main app is not answering.',
    },
  },
}
