import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { loggerScope } from '../logger'

const log = loggerScope('ydotoold')

/**
 * Where ydotoold listens. Upstream moved this from /tmp to $XDG_RUNTIME_DIR; both are
 * probed so we work with whichever version is installed. `YDOTOOL_SOCKET` overrides
 * both for the client and the daemon.
 */
export function socketPaths(): string[] {
  const override = process.env.YDOTOOL_SOCKET
  if (override) return [override]

  const paths: string[] = []
  const runtime = process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`
  paths.push(join(runtime, '.ydotool_socket'))
  // The pre-systemd location, still used by some packaged builds.
  paths.push('/tmp/.ydotool_socket')
  return paths
}

export function existingSocket(): string | null {
  return socketPaths().find((p) => existsSync(p)) ?? null
}

export function daemonRunning(): boolean {
  return existingSocket() !== null
}

export interface DaemonStatus {
  ok: boolean
  /** True when *we* own the process and must clean it up on exit. */
  owned: boolean
  socket: string | null
  detail: string
}

/**
 * Manages the `ydotoold` background process.
 *
 * This is the piece that is easy to miss: `ydotool` itself is only a thin client, and
 * every one of its subcommands exits with code 2 and "failed to connect socket" when
 * the daemon is not running. A daemon that holds /dev/uinput has to exist before any
 * key can be sent.
 *
 * We prefer an already-running daemon (a systemd user unit is the clean way to get
 * one, and it survives app restarts) and only spawn our own when none is present. An
 * owned daemon is killed on shutdown; a foreign one is left alone.
 */
export class YdotoolDaemon {
  private child: ChildProcess | null = null
  private starting: Promise<DaemonStatus> | null = null
  private lastStatus: DaemonStatus | null = null

  /** Cheap synchronous check, safe to call from preflight. */
  peek(): DaemonStatus {
    const socket = existingSocket()
    if (socket) {
      return { ok: true, owned: false, socket, detail: `daemon already running at ${socket}` }
    }
    return {
      ok: false,
      owned: false,
      socket: null,
      detail: `ydotoold is not running (no socket at ${socketPaths().join(' or ')})`
    }
  }

  /**
   * Ensure a usable daemon exists. Safe to call before every injection: the cost when
   * one is already running is a single `existsSync`.
   */
  async ensure(timeoutMs = 5000): Promise<DaemonStatus> {
    const quick = this.peek()
    if (quick.ok) {
      this.lastStatus = quick
      return quick
    }

    if (this.starting) return this.starting

    this.starting = this.start(timeoutMs).finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private async start(timeoutMs: number): Promise<DaemonStatus> {
    if (!existsSync('/dev/uinput')) {
      const status: DaemonStatus = {
        ok: false,
        owned: false,
        socket: null,
        detail: '/dev/uinput does not exist. Load the module: sudo modprobe uinput'
      }
      this.lastStatus = status
      return status
    }

    log.info('starting ydotoold')
    let child: ChildProcess
    try {
      child = spawn('ydotoold', [], { stdio: ['ignore', 'pipe', 'pipe'], detached: false })
    } catch (err) {
      const status: DaemonStatus = {
        ok: false,
        owned: false,
        socket: null,
        detail: `could not spawn ydotoold: ${(err as Error).message}`
      }
      this.lastStatus = status
      return status
    }

    let stderr = ''
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    child.stdout?.resume()

    let exited = false
    child.on('exit', (code) => {
      exited = true
      // Only report if it died during startup; a later death is handled on next use.
      if (this.starting) log.warn(`ydotoold exited during startup with code ${code}: ${stderr.trim()}`)
      this.child = null
    })
    child.on('error', (err) => {
      log.warn('ydotoold error', err.message)
    })

    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const socket = existingSocket()
      if (socket) {
        this.child = child
        const status: DaemonStatus = { ok: true, owned: true, socket, detail: `started ydotoold at ${socket}` }
        this.lastStatus = status
        log.info('ydotoold ready:', socket)
        return status
      }
      if (exited) break
      await delay(100)
    }

    try {
      child.kill('SIGTERM')
    } catch {
      /* already gone */
    }

    const status: DaemonStatus = {
      ok: false,
      owned: false,
      socket: null,
      detail:
        stderr.trim() ||
        `ydotoold did not create a socket within ${timeoutMs}ms. It needs read/write access to /dev/uinput — check your membership of the "input" group.`
    }
    this.lastStatus = status
    log.warn('ydotoold failed to start:', status.detail)
    return status
  }

  status(): DaemonStatus {
    return this.peek()
  }

  /**
   * Force a fresh daemon even if a socket appears to exist.
   *
   * A socket file outlives its process, so after a crash or an unclean shutdown
   * `peek()` reports a daemon that is not actually running — and every `ydotool`
   * client then exits 2 with "failed to connect socket". Clearing the stale socket and
   * spawning again is the only way out, which is why the injector retries through here.
   */
  async restart(timeoutMs = 5000): Promise<DaemonStatus> {
    log.warn('restarting ydotoold (stale socket or dead daemon)')

    if (this.child) {
      try {
        this.child.kill('SIGTERM')
      } catch {
        /* already gone */
      }
      this.child = null
    }

    for (const path of socketPaths()) {
      // Only remove a socket we have reason to believe is stale: no daemon of ours is
      // running, and nothing answered on it.
      if (existsSync(path)) {
        try {
          rmSync(path, { force: true })
        } catch {
          /* best effort */
        }
      }
    }

    this.starting = null
    return this.start(timeoutMs)
  }

  /** Kill only a daemon we started. A pre-existing (systemd) daemon is left running. */
  stop(): void {
    if (!this.child) return
    log.info('stopping the ydotoold we started')
    try {
      this.child.kill('SIGTERM')
    } catch {
      /* already gone */
    }
    this.child = null
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}