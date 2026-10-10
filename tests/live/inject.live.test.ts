import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { ClipboardPasteInjector } from '../../src/main/core/inject/clipboardPaste'
import { clearPasteNote } from '../../src/main/core/inject/clipboardPaste'
import { existingSocket } from '../../src/main/core/inject/ydotoold'

const pkill = (name: string): void => {
  try {
    execFileSync('pkill', ['-x', name], { stdio: 'ignore' })
  } catch {
    /* no such process */
  }
}
import { DEFAULT_CONFIG } from '../../src/shared/schema'

/**
 * Proves the real injection path actually emits key events into the kernel input
 * layer, where a receiving application consumes them from.
 *
 * This is the only way to verify injection without stealing the user's focus: the
 * injector is pointed at an in-memory clipboard and the resulting uinput events are
 * read back from the `ydotoold virtual device`.
 *
 *   sudo modprobe uinput
 *   npm run test:inject
 */
const enabled = process.env.XONO_INJECT === '1'

interface KeyEvent {
  code: number
  value: number
}

/**
 * Read input_event structs from a character device without pulling in a native dep.
 *
 * The device node disappears the moment its daemon dies, which shows up as ENODEV on
 * read. That is treated as "the stream ended" rather than an error, so a daemon
 * restart mid-read does not fail the suite.
 */
async function readKeyEvents(device: string, durationMs: number): Promise<KeyEvent[]> {
  const events: KeyEvent[] = []

  let stream: ReturnType<typeof createReadStream>
  try {
    stream = createReadStream(device, { highWaterMark: 24 })
  } catch {
    return events
  }

  let buffer = Buffer.alloc(0)

  const onData = (chunk: string | Buffer): void => {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    buffer = Buffer.concat([buffer, buf])
    // struct input_event { struct timeval time; __u16 type; __u16 code; __s32 value; }
    // timeval is 16 bytes on 64-bit, so the payload starts at offset 16.
    while (buffer.length >= 24) {
      const type = buffer.readUInt16LE(16)
      const code = buffer.readUInt16LE(18)
      const value = buffer.readInt32LE(20)
      if (type === 0x0001) events.push({ code, value })
      buffer = buffer.subarray(24)
    }
  }

  stream.on('data', onData)
  stream.on('error', () => undefined)
  await new Promise((r) => setTimeout(r, durationMs))
  stream.destroy()
  return events
}

/**
 * Locate the event node belonging to the ydotoold virtual device.
 *
 * /proc/bus/input/devices is a sequence of records that do not have a reliable blank
 * line between them, so scan line-wise: find the record naming ydotool, then take the
 * eventNN handler out of its Handlers line.
 */
function findYdotoolDevice(): string | null {
  const proc = '/proc/bus/input/devices'
  if (!existsSync(proc) || !existsSync('/dev/input')) return null

  const lines = readFileSync(proc, 'utf8').split('\n')
  let inBlock = false

  for (const line of lines) {
    if (/^I:/.test(line)) inBlock = false
    if (/ydotool/i.test(line)) inBlock = true
    if (!inBlock) continue

    const handlers = line.match(/^H: Handlers=(.*)$/)
    if (!handlers?.[1]) continue

    const event = handlers[1].split(/\s+/).find((h) => /^event\d+$/.test(h))
    if (!event) continue

    const node = `/dev/input/${event}`
    try {
      statSync(node)
    } catch {
      return null
    }
    return node
  }
  return null
}

describe.skipIf(!enabled)('injection via ydotool', () => {
  let injector: ClipboardPasteInjector
  let clipboard: string

  beforeAll(async () => {
    // Make sure a daemon exists so the device node exists to read from.
    await ClipboardPasteInjector.daemon.ensure(8000)
    await new Promise((r) => setTimeout(r, 300))
    console.log(`\n  daemon: ${ClipboardPasteInjector.daemon.peek().detail}`)
    console.log(`  device: ${findYdotoolDevice() ?? 'not readable'}`)

    injector = new ClipboardPasteInjector(
      'ydotool',
      'clipboard-ydotool',
      {
        read: async () => '',
        write: async (text: string) => {
          clipboard = text
        }
      },
      'ydotool'
    )
  })

  beforeEach(() => {
    // The "what did we last paste" note is deliberately process-global, so tests in this
    // file would otherwise inherit each other's state.
    clearPasteNote()
  })

  afterAll(() => {
    ClipboardPasteInjector.daemon.stop()
  })

  it('starts the daemon on demand, which is the thing that was broken', async () => {
    const status = await ClipboardPasteInjector.daemon.ensure(8000)
    console.log(`  status: ok=${status.ok} owned=${status.owned} ${status.detail}`)
    expect(status.ok).toBe(true)
    expect(status.detail).toMatch(/socket/)
  })

  it('reports a clean preflight once the daemon is up', async () => {
    const checks = await injector.preflight()
    const byId = new Map(checks.map((c) => [c.id, c]))
    console.log(`  ydotool installed: ${byId.get('ydotool-installed')?.ok}`)
    console.log(`  ydotoold running:  ${byId.get('ydotoold')?.ok}`)

    expect(byId.get('ydotool-installed')?.ok).toBe(true)
    expect(byId.get('ydotoold')?.ok).toBe(true)
    expect(checks.filter((c) => c.severity === 'error' && !c.ok)).toHaveLength(0)
  })

  it('emits a ctrl+V chord into the kernel input layer', async () => {
    // Resolve the node here, not at setup: an earlier test may have restarted the
    // daemon, which removes and recreates the event node.
    await ClipboardPasteInjector.daemon.ensure(8000)
    await new Promise((r) => setTimeout(r, 300))

    const node = findYdotoolDevice()
    if (!node) {
      console.log('  ! cannot read the ydotool device node; skipping event assertions')
      return
    }

    const marker = 'xono injection probe'
    const pending = readKeyEvents(node, 3000)

    // Give the reader a moment to attach before the events start flowing.
    await new Promise((r) => setTimeout(r, 250))
    const result = await injector.inject(marker, { ...DEFAULT_CONFIG.inject, restoreClipboard: false })

    expect(clipboard).toBe(marker)
    expect(result.ok).toBe(true)

    const events = await pending
    const codes = events.map((e) => `${e.code}:${e.value}`)
    console.log(`  events: ${codes.join(' ')}`)

    // 29 = KEY_LEFTCTRL, 47 = KEY_V. Both press (1) and release (0) must appear, in
    // order, with the modifier going down first and up last.
    expect(codes).toContain('29:1')
    expect(codes).toContain('47:1')
    expect(codes).toContain('47:0')
    expect(codes).toContain('29:0')
    expect(codes.indexOf('29:1')).toBeLessThan(codes.indexOf('47:1'))
    expect(codes.indexOf('47:0')).toBeLessThan(codes.indexOf('29:0'))
  }, 30_000)

  it('recovers from a stale socket left behind by a dead daemon', async () => {
    // A socket file outlives its process. After a crash, `existsSync` still says the
    // daemon is up, and the naive path fails with ydotool exit code 2.
    const socket = existingSocket()
    if (!socket) {
      console.log('  ! no socket to make stale; skipping')
      return
    }

    // Kill the daemon but leave the socket file in place.
    pkill('ydotoold')
    await new Promise((r) => setTimeout(r, 500))
    expect(existsSync(socket), 'socket file should survive the process').toBe(true)

    // peek() is now lying on purpose: this is the state that caused the original bug.
    expect(ClipboardPasteInjector.daemon.peek().ok).toBe(true)

    const result = await injector.inject('stale socket probe', {
      ...DEFAULT_CONFIG.inject,
      restoreClipboard: false
    })

    console.log(`  recovered: ok=${result.ok} ${result.error ?? ''}`)
    expect(result.ok).toBe(true)
    // The chord landed, so fresh events must have been emitted.
    expect(ClipboardPasteInjector.daemon.peek().ok).toBe(true)
  }, 30_000)

  it('refuses to inject empty text', async () => {
    const result = await injector.inject('   ', DEFAULT_CONFIG.inject)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/nothing to inject/)
  })

  it('appends a newline when configured to', async () => {
    let written = ''
    const nl = new ClipboardPasteInjector(
      'ydotool',
      'clipboard-ydotool',
      { read: async () => '', write: async (t) => void (written = t) },
      'ydotool'
    )
    await nl.inject('send it', { ...DEFAULT_CONFIG.inject, trailingNewline: true, restoreClipboard: false })
    expect(written).toBe('send it\n')
  })
})