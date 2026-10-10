import { spawn } from 'node:child_process'

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

export class CommandError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly stderr: string
  ) {
    super(message)
    this.name = 'CommandError'
  }
}

export function runCommand(
  command: string,
  args: string[],
  timeoutMs = 5000
): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    let child
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      reject(new CommandError(`could not run ${command}: ${(err as Error).message}`, null, ''))
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(new CommandError(`${command} timed out after ${timeoutMs}ms`, null, stderr))
    }, timeoutMs)

    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString()
    })
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const e = err as NodeJS.ErrnoException
      reject(
        new CommandError(
          e.code === 'ENOENT' ? `${command} is not installed` : `${command} failed: ${e.message}`,
          null,
          ''
        )
      )
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) resolvePromise({ code: 0, stdout, stderr })
      else reject(new CommandError(`${command} exited with code ${code}`, code, stderr.trim()))
    })
  })
}

/** Like runCommand but resolves to null instead of throwing when the tool is absent. */
export async function commandExists(command: string): Promise<boolean> {
  try {
    await runCommand('sh', ['-c', `command -v ${JSON.stringify(command)}`], 3000)
    return true
  } catch {
    return false
  }
}