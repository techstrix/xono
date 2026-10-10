import { afterEach, describe, expect, it, vi } from 'vitest'
import { YdotoolDaemon, socketPaths } from '../../src/main/core/inject/ydotoold'
import { existingSocket } from '../../src/main/core/inject/ydotoold'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Regression coverage for the daemon-lifecycle bug that made every dictation fail with
 * "ydotool exited with code 2": `ydotool` is only a client, and every subcommand exits
 * 2 with "failed to connect socket" when `ydotoold` is not running.
 *
 * These run against a real socket path in a temp directory and stub out process
 * spawning, so they need neither the daemon nor any hardware.
 */

/**
 * Point socket discovery at a throwaway directory for the duration of `fn`.
 *
 * Awaits an async `fn` before cleaning up: without that the temp directory is removed
 * while the test body is still running.
 */
async function withSocketDir<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'xono-socket-'))
  const previous = process.env.YDOTOOL_SOCKET
  process.env.YDOTOOL_SOCKET = join(dir, '.ydotool_socket')
  try {
    return await fn(dir)
  } finally {
    if (previous === undefined) delete process.env.YDOTOOL_SOCKET
    else process.env.YDOTOOL_SOCKET = previous
    rmSync(dir, { recursive: true, force: true })
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('YdotoolDaemon socket discovery', () => {
  it('honours YDOTOOL_SOCKET above everything else', async () => {
    await withSocketDir((dir) => {
      expect(socketPaths()).toEqual([join(dir, '.ydotool_socket')])
    })
  })

  it('probes both the XDG and the legacy /tmp location without the override', () => {
    const previous = process.env.YDOTOOL_SOCKET
    delete process.env.YDOTOOL_SOCKET
    try {
      const paths = socketPaths()
      expect(paths).toHaveLength(2)
      expect(paths[0]).toContain('.ydotool_socket')
      expect(paths[1]).toBe('/tmp/.ydotool_socket')
    } finally {
      if (previous !== undefined) process.env.YDOTOOL_SOCKET = previous
    }
  })
})

describe('YdotoolDaemon', () => {
  it('reports not-running, with an actionable reason, when there is no socket', async () => {
    await withSocketDir(() => {
      const status = new YdotoolDaemon().peek()
      expect(status.ok).toBe(false)
      expect(status.detail).toMatch(/not running/i)
    })
  })

  it('reports running without spawning anything when a socket already exists', async () => {
    await withSocketDir(async (dir) => {
      const { writeFileSync } = await import('node:fs')
      writeFileSync(join(dir, '.ydotool_socket'), '')

      const daemon = new YdotoolDaemon()
      const status = await daemon.ensure(200)

      expect(status.ok).toBe(true)
      // A daemon we did not start must be left running on shutdown.
      expect(status.owned).toBe(false)
      expect(daemon.peek().detail).toMatch(/already running/)
    })
  })

  it('clears a stale socket on restart, so a dead daemon can be replaced', async () => {
    await withSocketDir(async (dir) => {
      const { existsSync, writeFileSync } = await import('node:fs')
      const socket = join(dir, '.ydotool_socket')

      // A socket left behind by a crashed daemon: present on disk, nothing behind it.
      writeFileSync(socket, '')
      const daemon = new YdotoolDaemon()
      expect(daemon.peek().ok).toBe(true) // the misleading state that caused the bug

      // restart() spawns for real, so point it at a spawn that fails fast and check the
      // stale socket was removed rather than left in place.
      const before = existsSync(socket)
      expect(before).toBe(true)

      await daemon.restart(150)

      // Either a fresh daemon took over, or startup failed — but the stale socket must
      // no longer be the thing we report as a live daemon.
      const after = daemon.peek()
      if (!after.ok) expect(existsSync(socket)).toBe(false)
    })
  })

  it('does not report an owned daemon after stop()', async () => {
    await withSocketDir(async () => {
      const daemon = new YdotoolDaemon()
      daemon.stop()
      expect(daemon.peek().ok).toBe(false)
    })
  })
})

describe('existingSocket', () => {
  it('returns null when nothing is listening', async () => {
    await withSocketDir(() => {
      expect(existingSocket()).toBeNull()
    })
  })
})