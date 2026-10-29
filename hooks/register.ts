import type { EngineInterface, Register } from 'claude-code'

// Every session running this mod keeps one entry in the shared store, under
// its own key, so sessions never overwrite each other's writes.
const PREFIX = 's:'
const MARKER = '[compact-all] compact-request'
// A session below this many context tokens has nothing worth compacting.
const MIN_TOKENS = 20_000
// Entries not refreshed for this long belong to sessions that died silently.
const STALE_MS = 7 * 24 * 3600 * 1000
const HOUR_MS = 3600 * 1000
// Default for the activeHours option: only sessions worked in this recently.
const ACTIVE_HOURS = 24
const RETRY_MS = 15_000
const MAX_TRIES = 40

type Entry = {
  id: string
  cwd: string
  turns: number
  tokens: number
  lastSeen: number
  // When a turn of the main conversation last ended: the person's last work.
  lastTurnAt?: number
  lastCompact?: { at: number; result: string }
}

// This session's own run state; a reload starts it over, which only drops a
// request that had not compacted yet.
let isBusy = false
let pending: { instructions?: string; tries: number } | undefined

async function touch($: EngineInterface, extra: Partial<Entry> = {}): Promise<Entry> {
  const id = await $.session.id()
  const old = (await $.store.get(PREFIX + id)) as Entry | undefined
  const { context } = await $.session.usage()
  const entry: Entry = {
    ...old,
    id,
    cwd: await $.session.root(),
    turns: await $.session.turns(),
    tokens: context.tokens ?? old?.tokens ?? 0,
    lastSeen: await $.clock.now(),
    ...extra,
  }
  await $.store.set(PREFIX + id, entry)
  return entry
}

async function entries($: EngineInterface): Promise<Entry[]> {
  const now = await $.clock.now()
  const out: Entry[] = []
  for (const key of await $.store.keys()) {
    if (!key.startsWith(PREFIX)) continue
    const one = (await $.store.get(key)) as Entry | undefined
    if (!one || now - one.lastSeen > STALE_MS) {
      await $.store.delete(key)
      continue
    }
    out.push(one)
  }
  return out
}

async function tryCompact($: EngineInterface): Promise<void> {
  if (!pending || isBusy) return // turn.complete schedules the next try
  const { instructions } = pending
  try {
    const done = await $.session.compact(instructions ? { instructions } : undefined)
    const result =
      done.skip !== undefined
        ? `пропущено: ${done.skip}`
        : `сжато${done.tokensBefore ? ` ${done.tokensBefore}→${done.tokensAfter ?? '?'} токенов` : ''}`
    pending = undefined
    await touch($, { lastCompact: { at: await $.clock.now(), result } })
    $.ui.toast(`compact-all: ${result}`)
  } catch (err) {
    // Rejects while a turn runs; try again a little later.
    if (!pending) return
    pending.tries += 1
    if (pending.tries >= MAX_TRIES) {
      pending = undefined
      await touch($, {
        lastCompact: { at: await $.clock.now(), result: `ошибка: ${String(err)}` },
      })
      return
    }
    $.clock.after(RETRY_MS, () => void tryCompact($))
  }
}

function request($: EngineInterface, instructions?: string): void {
  pending = { instructions, tries: 0 }
  $.clock.after(1_000, () => void tryCompact($))
}

export const register: Register = (on, options) => {
  const hours = Number(options.activeHours ?? ACTIVE_HOURS)
  const activeMs = (Number.isFinite(hours) && hours > 0 ? hours : ACTIVE_HOURS) * HOUR_MS

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'compact-all',
      description:
        'Сжать все запущенные сессии, где вы работали (/compact-all [инструкции] | status)',
    })
    await touch($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await $.store.delete(PREFIX + (await $.session.id()))
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) isBusy = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) {
      isBusy = false
      await touch($, { lastTurnAt: await $.clock.now() })
      if (pending) $.clock.after(2_000, () => void tryCompact($))
    }
    return done
  })

  on('session.receive', async ($, e, next) => {
    if (e.origin.kind !== 'peer' || !e.text.includes(MARKER)) return next(e)
    const instructions = e.text.split(MARKER)[1]?.trim() || undefined
    request($, instructions)
    return { consumed: 'compact-all: запрос на сжатие принят' }
  }).catch(($, e, next) => (next.called ? { text: e.text } : next(e)))

  on('command.run', { command: 'compact-all' }, async ($, e) => {
    const self = await $.session.id()
    const now = await $.clock.now()
    await touch($)
    const all = await entries($)
    const args = e.args.trim()

    if (args === 'status') {
      const lines = all.map(one => {
        const last = one.lastCompact
          ? `${new Date(one.lastCompact.at).toLocaleString('ru-RU')} — ${one.lastCompact.result}`
          : 'не сжималась'
        const active = one.lastTurnAt
          ? `активна ${new Date(one.lastTurnAt).toLocaleString('ru-RU')}`
          : 'без активности'
        return `${one.id === self ? '*' : ' '} ${one.id.slice(0, 8)}  ${one.cwd}  ${one.turns} ход., ~${one.tokens} ток.  ${active}  ${last}`
      })
      return { text: [`известные сессии (окно активности: ${activeMs / HOUR_MS} ч)`, ...lines].join('\n') }
    }

    const instructions = args || undefined
    const lines: string[] = []
    for (const one of all) {
      const tag = `${one.id.slice(0, 8)} ${one.cwd}`
      if (one.turns === 0) {
        lines.push(`  ${tag}: пропущена — вы в ней не работали`)
        continue
      }
      if (one.lastTurnAt === undefined || now - one.lastTurnAt > activeMs) {
        lines.push(`  ${tag}: пропущена — не было работы за ${activeMs / HOUR_MS} ч`)
        continue
      }
      if (one.tokens < MIN_TOKENS) {
        lines.push(`  ${tag}: пропущена — контекст мал (~${one.tokens} ток.)`)
        continue
      }
      if (one.id === self) {
        request($, instructions)
        lines.push(`  ${tag}: эта сессия — сожмётся следом`)
        continue
      }
      const sent = await $.session.send({
        to: { sessionId: one.id },
        text: instructions ? `${MARKER} ${instructions}` : MARKER,
      })
      lines.push(
        sent.isDelivered
          ? `  ${tag}: запрос отправлен`
          : `  ${tag}: не доставлено — ${sent.reason}`,
      )
    }
    if (lines.length === 0) lines.push('  нет сессий с этим модом')
    return {
      text: [
        'каждая сессия сожмётся, как только закончит текущий ход.',
        ...lines,
        'Итог: /compact-all status',
      ].join('\n'),
    }
  })
}
