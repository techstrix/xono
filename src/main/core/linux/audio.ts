import { CHANNELS, SAMPLE_RATE } from '@shared/types'

/**
 * Audio-capture tool fallback chain.
 *
 * `parec` (PulseAudio-compat, ships with pipewire-utils on Arch) is tried first
 * because every existing install already has it and its flags are what the
 * recorder was tuned against. `pw-record` is PipeWire-native and present wherever
 * PipeWire is, even when the compat package is missing (common on fresh
 * Debian/Fedora). `arecord` (ALSA) is the last resort: it works without any
 * sound server, at the cost of exclusive device access.
 *
 * Pure argument builders — the recorder probes availability with `commandExists`
 * at runtime, so unit tests cover the argv shapes without touching hardware.
 */

export type CaptureTool = 'parec' | 'pw-record' | 'arecord'

export const CAPTURE_PRIORITY: CaptureTool[] = ['parec', 'pw-record', 'arecord']

export function buildCaptureArgs(tool: CaptureTool, deviceId?: string): string[] {
  switch (tool) {
    case 'parec':
      return [
        '--format=s16le',
        `--rate=${SAMPLE_RATE}`,
        `--channels=${CHANNELS}`,
        '--latency-msec=20',
        ...(deviceId ? [`--device=${deviceId}`] : [])
      ]
    case 'pw-record':
      // pw-record writes wav/riff to stdout with `-`; `--target` selects the node
      // when the user picked a non-default device.
      return [
        '--format=s16',
        `--rate=${SAMPLE_RATE}`,
        `--channels=${CHANNELS}`,
        ...(deviceId ? [`--target=${deviceId}`] : []),
        '-'
      ]
    case 'arecord':
      // ALSA raw capture: signed 16-bit little-endian, matching SAMPLE_RATE/CANNELS.
      return [
        '-f',
        'S16_LE',
        '-r',
        String(SAMPLE_RATE),
        '-c',
        String(CHANNELS),
        ...(deviceId ? ['-D', deviceId] : []),
        '-t',
        'raw'
      ]
  }
}

/**
 * Pick the first available tool. `exists` is injected so tests stay hermetic and
 * the recorder can pass an async PATH probe.
 */
export async function pickCaptureTool(exists: (tool: CaptureTool) => Promise<boolean> | boolean): Promise<CaptureTool | null> {
  for (const tool of CAPTURE_PRIORITY) {
    if (await exists(tool)) return tool
  }
  return null
}
