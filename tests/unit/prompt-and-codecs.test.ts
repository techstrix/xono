import { describe, expect, it } from 'vitest'
import { buildInitialPrompt, isSilenceTranscript, normalise } from '../../src/main/core/stt/whisperCpp'
import { CHORD_CTRL_V, EVDEV, chord } from '../../src/main/core/inject/keycodes'
import { DEFAULT_CONFIG } from '../../src/shared/schema'
import {
  buildContextBlock,
  buildSystemPrompt,
  buildUserMessage,
  countFillers
} from '../../src/main/core/llm/prompt'
import type { CleanupRequest } from '../../src/main/core/llm/types'

function req(overrides: Partial<CleanupRequest> = {}): CleanupRequest {
  return {
    raw: 'um so like I was thinking we should uh ship it on friday you know',
    mode: 'cleaned',
    vocabulary: [],
    punctuation: true,
    capitalize: true,
    ...overrides
  }
}

describe('whisper initial prompt', () => {
  it('is empty with no vocabulary, so whisper runs unbiased', () => {
    expect(buildInitialPrompt([])).toBe('')
    expect(buildInitialPrompt(['   ', ''])).toBe('')
  })

  it('lists the terms for the decoder to bias toward', () => {
    const prompt = buildInitialPrompt(['pnpm', 'ydotool', ' electron-vite '])
    expect(prompt).toContain('pnpm')
    expect(prompt).toContain('ydotool')
    expect(prompt).toContain('electron-vite')
  })

  it('caps the prompt so it cannot overflow the model context', () => {
    const many = Array.from({ length: 500 }, (_, i) => `term-${i}`)
    expect(buildInitialPrompt(many).length).toBeLessThanOrEqual(600)
  })
})

describe('transcript normalisation', () => {
  it('drops whisper special tokens', () => {
    expect(normalise(' [BLANK_AUDIO]  hello   there ')).toBe('hello there')
    expect(normalise('[SILENCE]deploy it[MUSIC]')).toBe('deploy it')
  })

  it('drops whisper timestamp markers and collapses whitespace', () => {
    expect(normalise('hello[00:00:00.000 --> 00:00:02.000] world')).toBe('hello world')
  })

  it('keeps bracketed text the user actually dictated', () => {
    // A blanket /\[[^\]]*\]/ would eat these, and they are legitimate to say out loud.
    expect(normalise('add a [TODO] for the [see README] note')).toBe('add a [TODO] for the [see README] note')
    expect(normalise('run [npm run dev] now')).toBe('run [npm run dev] now')
    expect(normalise('use array[0] and obj[key]')).toBe('use array[0] and obj[key]')
  })

  it('leaves clean text untouched', () => {
    expect(normalise('deploy the service')).toBe('deploy the service')
  })

  it('recognises a transcript that is only silence markers', () => {
    expect(isSilenceTranscript('[BLANK_AUDIO]')).toBe(true)
    expect(isSilenceTranscript(' [SILENCE] [MUSIC] ')).toBe(true)
    expect(isSilenceTranscript('hello there')).toBe(false)
    // Bracketed dictation is content, not silence.
    expect(isSilenceTranscript('[TODO]')).toBe(false)
  })
})

describe('keycodes', () => {
  it('uses the documented Linux evdev codes', () => {
    expect(EVDEV.KEY_LEFTCTRL).toBe(29)
    expect(EVDEV.KEY_V).toBe(47)
    expect(EVDEV.KEY_ENTER).toBe(28)
  })

  it('presses and releases ctrl around a V tap', () => {
    expect(CHORD_CTRL_V).toEqual(['29:1', '47:1', '47:0', '29:0'])
  })

  it('releases multi-key chords in reverse order', () => {
    expect(chord(29, 47)).toEqual(['29:1', '47:1', '47:0', '29:0'])
  })
})

describe('cleanup prompt', () => {
  it('states the hard rules in every mode', () => {
    for (const mode of ['verbatim', 'cleaned', 'structured'] as const) {
      const prompt = buildSystemPrompt(req({ mode }), {
        punctuation: true,
        capitalize: true,
        vocabulary: [],
        hasContext: false
      })
      expect(prompt).toContain('Never answer')
      expect(prompt).toContain('Only clean it up')
      expect(prompt).toContain(`Mode: ${mode.toUpperCase()}`)
    }
  })

  it('forbids filler removal in verbatim mode and requires it in cleaned', () => {
    const opts = { punctuation: true, capitalize: true, vocabulary: [], hasContext: false }
    expect(buildSystemPrompt(req({ mode: 'verbatim' }), opts)).toMatch(/Do NOT remove filler words/)
    expect(buildSystemPrompt(req({ mode: 'cleaned' }), opts)).toMatch(/Remove disfluencies/)
  })

  it('honours the punctuation and capitalisation switches', () => {
    const on = buildSystemPrompt(req(), { punctuation: true, capitalize: true, vocabulary: [], hasContext: false })
    const off = buildSystemPrompt(req(), { punctuation: false, capitalize: false, vocabulary: [], hasContext: false })
    expect(on).toContain('Add natural punctuation')
    expect(on).toContain('Capitalise sentence beginnings')
    expect(off).toContain('Do not add any')
    expect(off).toContain('Preserve capitalisation')
  })

  it('injects the vocabulary so the model does not "correct" jargon', () => {
    const prompt = buildSystemPrompt(req({ vocabulary: ['ydotool', 'parec'] }), {
      punctuation: true,
      capitalize: true,
      vocabulary: ['ydotool', 'parec'],
      hasContext: false
    })
    expect(prompt).toContain('ydotool, parec')
    expect(prompt).toContain('spelled exactly')
  })

  it('mentions context resolution only when there is context', () => {
    const withCtx = buildSystemPrompt(req(), {
      punctuation: true,
      capitalize: true,
      vocabulary: [],
      hasContext: true
    })
    expect(withCtx).toContain('previous utterance')
    const without = buildSystemPrompt(req(), {
      punctuation: true,
      capitalize: true,
      vocabulary: [],
      hasContext: false
    })
    expect(without).not.toContain('previous utterance')
  })

  it('wraps the transcript in tags and reports the settings', () => {
    const message = buildUserMessage(req({ mode: 'structured' }))
    expect(message).toContain('<transcript>')
    expect(message).toContain('mode: structured')
    expect(message).toContain('punctuation: on')
    expect(message).toContain(req().raw)
  })

  it('keeps the previous utterance out of the user message unless supplied', () => {
    expect(buildContextBlock('earlier words')).toContain('<previous utterance>')
  })
})

describe('filler counting', () => {
  it('counts the difference between input and output', () => {
    const raw = 'um uh so like I mean you know it works'
    const cleaned = 'So it works'
    expect(countFillers(raw, cleaned)).toBeGreaterThanOrEqual(4)
  })

  it('never returns a negative count when the model adds a word', () => {
    expect(countFillers('clean text', 'hmm clean text')).toBe(0)
  })

  it('is case insensitive', () => {
    expect(countFillers('UM uh', 'nothing')).toBe(2)
  })
})

describe('default config sanity', () => {
  it('defaults to the fastest model that is usable on a 4-core CPU', () => {
    expect(DEFAULT_CONFIG.stt.model).toBe('tiny.en')
  })

  it('ships a working default hotkey and dictation mode', () => {
    expect(DEFAULT_CONFIG.hotkey.accelerator).toBe('Super+`')
    expect(DEFAULT_CONFIG.llm.mode).toBe('cleaned')
    expect(DEFAULT_CONFIG.llm.failOpenToRaw).toBe(true)
    expect(DEFAULT_CONFIG.inject.method).toBe('clipboard-ydotool')
  })
})