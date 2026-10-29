import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const DAY = 24 * 3600 * 1000
const HOUR = 3600 * 1000
const NOW = 100 * DAY
const RUN = {
  command: 'compact-all',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 100 },
} as const

const entry = (
  id: string,
  turns: number,
  tokens: number,
  lastTurnAt: number | undefined = NOW - HOUR,
  lastSeen = NOW,
) => ({ id, cwd: `/work/${id}`, turns, tokens, lastSeen, lastTurnAt })

const SELF = { 's:self': entry('self', 4, 160_000) }

// The engine beneath the mod, for a session whose id the test may switch: one
// test process plays several sessions that share one store.
function engine(on: On, who: { id: string }, env: Record<string, string> = {}) {
  on('session.id', () => ({ value: who.id }))
  on('session.root', () => ({ value: `/work/${who.id}` }))
  on('session.turns', () => ({ value: 4 }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: 160_000, window: 200_000 }, rateLimits: [] },
  }))
  on('command.register', () => ({ value: { command: 'compact-all' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.toast', () => ({ value: undefined }))
  mock.env(on, env)
  const compacted: string[] = []
  on('session.compact', () => {
    compacted.push(who.id)
    return {
      messages: [{ role: 'user', text: 'summary', toolUses: [] }],
      tokensBefore: 160_000,
      tokensAfter: 8_000,
    }
  })
  return compacted
}

test('/compact-all picks the worked-in sessions and skips the rest', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, {
    's:other': entry('other', 5, 150_000),
    's:medium': entry('medium', 5, 60_000),
    's:idle': entry('idle', 0, 190_000),
    's:gone': entry('gone', 3, 180_000, NOW - 30 * DAY, NOW - 30 * DAY),
    's:yesterday': entry('yesterday', 7, 120_000, NOW - 30 * HOUR),
    ...SELF,
  })
  const compacted = engine(on, { id: 'self' })

  const out = await $.command.run(RUN)

  expect(out.text).toMatch(/other: запрос поставлен/)
  expect(out.text).toMatch(/idle: пропущена — вы в ней не работали/)
  expect(out.text).toMatch(/medium: пропущена — контекст мал/)
  expect(out.text).toMatch(/yesterday: пропущена — не было работы за 24 ч/)
  expect(out.text).toMatch(/self: эта сессия/)
  expect(out.text).not.toMatch(/gone/)

  await clock.advance(1_000)
  expect(compacted).toEqual(['self'])

  const status = await $.command.run({ ...RUN, args: 'status' })
  expect(status.text).toMatch(/сжато 160000→8000 токенов/)
  expect(status.text).toMatch(/other .*запрос ждёт/)
})

test('another session takes the request on its next poll, once', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, { 's:other': entry('other', 5, 150_000), ...SELF })
  const who = { id: 'other' }
  const compacted = engine(on, who)

  // `other` is running and polling; `self` types the command.
  await $.session.start({ cwd: '/work/other', surface: 'desktop', isInteractive: true })
  who.id = 'self'
  await $.command.run(RUN)
  await clock.advance(1_000)
  expect(compacted).toEqual(['self'])

  who.id = 'other'
  await clock.advance(15_000)
  await clock.advance(1_000)
  expect(compacted).toEqual(['self', 'other'])

  await clock.advance(60_000)
  expect(compacted).toEqual(['self', 'other'])
})

test('a stale request is not acted on', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, {
    's:other': entry('other', 5, 150_000),
    request: { at: NOW - HOUR, from: 'self', targets: ['other'] },
  })
  const compacted = engine(on, { id: 'other' })

  await $.session.start({ cwd: '/work/other', surface: 'desktop', isInteractive: true })
  await clock.advance(20_000)

  expect(compacted).toEqual([])
})

test('the activeHours option narrows the window', { options: { activeHours: 6 } }, async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on, {
    's:recent': entry('recent', 3, 150_000, NOW - 2 * HOUR),
    's:morning': entry('morning', 3, 150_000, NOW - 8 * HOUR),
    ...SELF,
  })
  engine(on, { id: 'self' })

  const out = await $.command.run(RUN)

  expect(out.text).toMatch(/recent: запрос поставлен/)
  expect(out.text).toMatch(/morning: пропущена — не было работы за 6 ч/)
})

test('the minTokens option sets the size floor', { options: { minTokens: 50_000 } }, async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on, { 's:medium': entry('medium', 5, 60_000), ...SELF })
  engine(on, { id: 'self' })

  const out = await $.command.run(RUN)

  expect(out.text).toMatch(/medium: запрос поставлен/)
})

test('work from before the restart counts, read off the transcript', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on, {
    's:other': { id: 'other', cwd: '/work/other', turns: 9, tokens: 200_000, lastSeen: NOW },
  })
  const who = { id: 'other' }
  engine(on, who, { HOME: '/home/me' })
  const asked: string[] = []
  on('fs.stat', (_, e) => {
    asked.push(e.path)
    return { value: { kind: 'file', size: 1, mtimeMs: NOW - 5 * HOUR, isLink: false } }
  })

  await $.session.start({ cwd: '/work/other', surface: 'desktop', isInteractive: true })
  expect(asked).toContain('/home/me/.claude/projects/-work-other/other.jsonl')

  who.id = 'self'
  const out = await $.command.run(RUN)
  expect(out.text).toMatch(/other: запрос поставлен/)
})
