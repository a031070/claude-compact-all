import type { EngineInterface, Register } from 'claude-code'

// Every session running this mod keeps one entry in the shared store, under
// its own key, so sessions never overwrite each other's writes.
const PREFIX = 's:'
// The one pending request, which every session polls for. Messages between
// sessions would need a permission verdict nobody is there to give.
const REQUEST = 'request'
const POLL_MS = 15_000
// A request older than this is not acted on: a session opened next morning
// must not compact on last night's command.
const REQUEST_TTL_MS = 30 * 60 * 1000
// The turn an idle session is given before it compacts: a compaction alone
// waits for a turn that, in an idle session, nobody starts.
const SUMMARY_PROMPT = [
  '[compact-all] Перед сжатием контекста подведи итог этой сессии по тому, что уже есть в переписке.',
  'Не запускай команд и инструментов, не меняй файлы. Кратко, списками:',
  '1. Что сделано.',
  '2. Что в работе.',
  '3. Что осталось.',
  '4. Открытые решения и блокеры.',
  '5. Ветки и PR (с номерами и ссылками, если они есть в переписке).',
  'После ответа сессия будет сжата, и этот итог должен пережить сжатие.',
].join('\n')
const SUMMARY_KEEP =
  'Сохрани целиком итог сессии из последнего ответа (подведение итогов compact-all): что сделано, в работе, осталось, решения и блокеры, ветки и PR.'
// Default for the minTokens option: a smaller session is not worth compacting.
const MIN_TOKENS = 100_000
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
  // The person's last work: when a turn of the main conversation last ended,
  // or, from before this process, when the transcript file was last written.
  lastTurnAt?: number
  lastCompact?: { at: number; result: string }
  // The `at` of the last request this session took.
  takenRequest?: number
}

type Request = {
  at: number
  from: string
  targets: string[]
  instructions?: string
}

// This session's own run state; a reload starts it over, which only drops a
// request that had not compacted yet.
let isBusy = false
let pending:
  | {
      instructions?: string
      tries: number
      // The summary turn this session was given has not ended yet.
      isAwaitingSummary?: boolean
    }
  | undefined

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

// Where the engine keeps the session's transcript when no hook has said: the
// project folder is the root with every other character turned into '-'.
async function transcriptPath($: EngineInterface): Promise<string | undefined> {
  const dir =
    (await $.env.get('CLAUDE_CONFIG_DIR')) ??
    ((await $.env.get('HOME')) ? `${await $.env.get('HOME')}/.claude` : undefined)
  if (!dir) return undefined
  const project = (await $.session.root()).replace(/[^A-Za-z0-9]/g, '-')
  return `${dir}/projects/${project}/${await $.session.id()}.jsonl`
}

// A restart writes nothing to the transcript, so its modification time is
// when the person last worked here, even before the mod loaded.
async function recordActivity($: EngineInterface, path: string | undefined): Promise<void> {
  if (!path) return
  const stat = await $.fs.stat(path).catch(() => undefined)
  if (!stat || stat.kind !== 'file') return
  const old = (await $.store.get(PREFIX + (await $.session.id()))) as Entry | undefined
  if ((old?.lastTurnAt ?? 0) >= stat.mtimeMs) return
  await touch($, { lastTurnAt: stat.mtimeMs })
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
  // turn.complete schedules the next try
  if (!pending || isBusy || pending.isAwaitingSummary) return
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

// A busy session compacts when its turn ends; an idle one is first given a
// turn that sums the session up, and compacts when that turn ends.
function take($: EngineInterface, instructions?: string): void {
  if (isBusy) {
    request($, instructions)
    return
  }
  const keep = instructions ? `${SUMMARY_KEEP}\n${instructions}` : SUMMARY_KEEP
  pending = { instructions: keep, tries: 0, isAwaitingSummary: true }
  // Not awaited: the turn starts once the session is idle, which for the
  // session the command runs in is after this hook returns.
  void $.prompt.submit({ text: SUMMARY_PROMPT }).catch(() => {
    // No turn could start: compact as before, with the person's instructions.
    request($, instructions)
  })
}

// Takes a fresh request naming this session; puts the session back on the
// list where its entry went missing.
async function poll($: EngineInterface): Promise<void> {
  const id = await $.session.id()
  const own = (await $.store.get(PREFIX + id)) as Entry | undefined
  if (!own) {
    await touch($)
    await transcriptPath($)
      .then(path => recordActivity($, path))
      .catch(() => undefined)
  }
  const req = (await $.store.get(REQUEST)) as Request | undefined
  if (!req || !req.targets.includes(id)) return
  if ((own?.takenRequest ?? 0) >= req.at) return
  if ((await $.clock.now()) - req.at > REQUEST_TTL_MS) return
  await touch($, { takenRequest: req.at })
  take($, req.instructions)
}

export const register: Register = (on, options) => {
  const hours = Number(options.activeHours ?? ACTIVE_HOURS)
  const activeMs = (Number.isFinite(hours) && hours > 0 ? hours : ACTIVE_HOURS) * HOUR_MS
  const min = Number(options.minTokens ?? MIN_TOKENS)
  const minTokens = Number.isFinite(min) && min >= 0 ? min : MIN_TOKENS

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'compact-all',
      description:
        'Сжать все запущенные сессии, где вы работали (/compact-all [инструкции] | status)',
    })
    // Polling first: what follows may fail, and the session must still listen.
    $.clock.every(POLL_MS, () => void poll($).catch(() => undefined))
    await touch($)
    await transcriptPath($)
      .then(path => recordActivity($, path))
      .catch(() => undefined)
    return next(e)
  })

  // The classic event carries the engine's own transcript path.
  on('classic.SessionStart', async ($, e, next) => {
    await recordActivity($, e.transcript_path)
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
      if (pending) {
        pending.isAwaitingSummary = false
        $.clock.after(2_000, () => void tryCompact($))
      }
    }
    return done
  })

  on('command.run', { command: 'compact-all' }, async ($, e) => {
    const self = await $.session.id()
    const now = await $.clock.now()
    // Typing the command is work in this session.
    await touch($, { lastTurnAt: now })
    const all = await entries($)
    const args = e.args.trim()

    if (args === 'status') {
      const req = (await $.store.get(REQUEST)) as Request | undefined
      const lines = all.map(one => {
        const asked = req?.targets.includes(one.id)
          ? (one.takenRequest ?? 0) >= req.at
            ? '  запрос принят'
            : '  запрос ждёт'
          : ''
        const last = one.lastCompact
          ? `${new Date(one.lastCompact.at).toLocaleString('ru-RU')} — ${one.lastCompact.result}`
          : 'не сжималась'
        const active = one.lastTurnAt
          ? `активна ${new Date(one.lastTurnAt).toLocaleString('ru-RU')}`
          : 'без активности'
        return `${one.id === self ? '*' : ' '} ${one.id.slice(0, 8)}  ${one.cwd}  ${one.turns} ход., ~${one.tokens} ток.  ${active}  ${last}${asked}`
      })
      return { text: [`известные сессии (окно активности: ${activeMs / HOUR_MS} ч)`, ...lines].join('\n') }
    }

    const instructions = args || undefined
    const lines: string[] = []
    const targets: string[] = []
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
      if (one.tokens < minTokens) {
        lines.push(`  ${tag}: пропущена — контекст мал (~${one.tokens} ток.)`)
        continue
      }
      targets.push(one.id)
      lines.push(
        one.id === self ? `  ${tag}: эта сессия — сожмётся следом` : `  ${tag}: запрос поставлен`,
      )
    }
    if (lines.length === 0) lines.push('  нет сессий с этим модом')
    if (targets.length > 0) {
      const req: Request = { at: now, from: self, targets, instructions }
      await $.store.set(REQUEST, req)
      if (targets.includes(self)) {
        await touch($, { takenRequest: now })
        take($, instructions)
      }
    }
    return {
      text: [
        `каждая сессия заберёт запрос в течение ${POLL_MS / 1000} с и сожмётся, как только закончит текущий ход.`,
        ...lines,
        'Итог: /compact-all status',
      ].join('\n'),
    }
  })
}
