import { expect, mock, test } from 'claude-code/testing'

const DAY = 24 * 3600 * 1000
const NOW = 100 * DAY
const RUN = {
  command: 'compact-all',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 100 },
} as const

const HOUR = 3600 * 1000

const entry = (
  id: string,
  turns: number,
  tokens: number,
  lastTurnAt: number | undefined = NOW - HOUR,
  lastSeen = NOW,
) => ({ id, cwd: `/work/${id}`, turns, tokens, lastSeen, lastTurnAt })

const SELF = { 's:self': entry('self', 4, 60_000) }

test('/compact-all asks every worked-in session and skips the rest', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, {
    's:other': entry('other', 5, 150_000),
    's:idle': entry('idle', 0, 90_000),
    's:small': entry('small', 2, 5_000),
    's:gone': entry('gone', 3, 80_000, NOW - 30 * DAY, NOW - 30 * DAY),
    's:yesterday': entry('yesterday', 7, 120_000, NOW - 30 * HOUR),
    ...SELF,
  })
  on('session.id', () => ({ value: 'self' }))
  on('session.root', () => ({ value: '/work/self' }))
  on('session.turns', () => ({ value: 4 }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: 60_000, window: 200_000 }, rateLimits: [] },
  }))
  on('command.register', () => ({ value: { command: 'compact-all' } }))
  const sent: string[] = []
  on('session.send', (_, e) => {
    sent.push(e.to)
    return { isDelivered: true }
  })
  let compacted = 0
  on('session.compact', () => {
    compacted += 1
    return {
      messages: [{ role: 'user', text: 'summary', toolUses: [] }],
      tokensBefore: 60_000, tokensAfter: 8_000 }
  })
  on('ui.toast', () => ({ value: undefined }))

  const out = await $.command.run(RUN)

  expect(sent.length).toBe(1)
  expect(out.text).toMatch(/other: запрос отправлен/)
  expect(out.text).toMatch(/idle: пропущена — вы в ней не работали/)
  expect(out.text).toMatch(/small: пропущена — контекст мал/)
  expect(out.text).toMatch(/self: эта сессия/)
  expect(out.text).not.toMatch(/gone/)
  expect(out.text).toMatch(/yesterday: пропущена — не было работы за 24 ч/)

  await clock.advance(1_000)
  expect(compacted).toBe(1)

  const status = await $.command.run({ ...RUN, args: 'status' })
  expect(status.text).toMatch(/сжато 60000→8000 токенов/)
})

test('a peer request is taken before the model reads it', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  on('session.receive', (_, e) => ({ text: e.text }))

  const plain = await $.session.receive({ origin: { kind: 'peer' }, text: 'hello' })
  expect(plain.text).toBe('hello')

  const taken = await $.session.receive({
    origin: { kind: 'peer', plugin: 'compact-all' },
    text: '[compact-all] compact-request',
  })
  expect(taken.consumed).toBeDefined()
})

test('the activeHours option narrows the window', { options: { activeHours: 6 } }, async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on, {
    's:recent': entry('recent', 3, 90_000, NOW - 2 * HOUR),
    's:morning': entry('morning', 3, 90_000, NOW - 8 * HOUR),
    ...SELF,
  })
  on('session.id', () => ({ value: 'self' }))
  on('session.root', () => ({ value: '/work/self' }))
  on('session.turns', () => ({ value: 4 }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: 60_000, window: 200_000 }, rateLimits: [] },
  }))
  on('session.send', () => ({ isDelivered: true }))

  const out = await $.command.run(RUN)

  expect(out.text).toMatch(/recent: запрос отправлен/)
  expect(out.text).toMatch(/morning: пропущена — не было работы за 6 ч/)
})
