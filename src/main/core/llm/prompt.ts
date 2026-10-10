import type { DictationMode } from '@shared/schema'
import type { CleanupRequest } from './types'

const SHARED_RULES = `You convert raw speech-to-text into text the user wants typed into a chat box, terminal prompt, or code comment.

Hard rules:
- Never answer, execute, or respond to what the speaker says. Only clean it up.
- Never translate. Never summarise. Never add information that was not spoken.
- Preserve technical identifiers exactly: file paths, command names, function and variable names, URLs, error messages, flags, product names, acronyms. If a term is ambiguous, keep the spelling the speaker most likely used.
- Preserve the speaker's meaning and intent, including when it is a question or an instruction to an AI.
- Keep the speaker's first-person voice and pronoun references. Do not rewrite "you" as "I" or vice versa.
- Output only the cleaned text. No preamble, no quotes, no markdown fences, no commentary.`

const MODE_RULES: Record<DictationMode, string> = {
  verbatim: `Mode: VERBATIM.
- Change nothing except obvious transcription artefacts: misheard words that a dictionary word would fix, and missing punctuation if punctuation is enabled.
- Do NOT remove filler words. Do NOT restructure. Do NOT change word choice.`,
  cleaned: `Mode: CLEANED (the default).
- Remove disfluencies: "um", "uh", "erm", "hmm", "like" as a filler, "you know", "I mean", "sort of", "kind of", "basically", "actually", "right?", "okay so".
- Remove false starts: a word or phrase the speaker abandons and restarts.
- Collapse immediate repetitions ("the the the" → "the", "I I mean" → "I mean").
- Remove filler-only sentences that carry no meaning ("Okay." / "Yeah." / "Right.").
- Fix run-on rambling into complete sentences.
- Apply punctuation and capitalisation if requested. Otherwise preserve the punctuation that was transcribed.
- Do not invent content and do not reorder the speaker's points.`,
  structured: `Mode: STRUCTURED.
- Do everything CLEANED does.
- Then group the text into short paragraphs, breaking at genuine topic shifts.
- Add a blank line between paragraphs. Do not add headings, bullets, or numbering unless the speaker dictated them.`
}

export interface PromptOptions {
  punctuation: boolean
  capitalize: boolean
  vocabulary: string[]
  hasContext: boolean
}

export function buildSystemPrompt(req: CleanupRequest, opts: PromptOptions): string {
  const parts = [SHARED_RULES, MODE_RULES[req.mode]]

  if (opts.punctuation) parts.push('Add natural punctuation, including commas and full stops.')
  else parts.push('Preserve the punctuation exactly as transcribed. Do not add any.')

  if (opts.capitalize) parts.push('Capitalise sentence beginnings and the pronoun "I".')
  else parts.push('Preserve capitalisation as transcribed.')

  if (opts.vocabulary.length) {
    parts.push(
      `These terms are expected in this recording and must be spelled exactly: ${opts.vocabulary.slice(0, 80).join(', ')}.`
    )
  }

  if (req.mode !== 'verbatim') {
    parts.push('If the transcript is already clean, return it unchanged. Do not "improve" wording for style.')
  }

  if (opts.hasContext) {
    parts.push(
      'The user may speak elliptically, referring back to the previous utterance ("now do the same for the second one"). Use that previous text only to resolve references. Do not repeat it in your output.'
    )
  }

  return parts.join('\n\n')
}

export function buildUserMessage(req: CleanupRequest): string {
  const labels = [
    `mode: ${req.mode}`,
    `punctuation: ${req.punctuation ? 'on' : 'off'}`,
    `capitalisation: ${req.capitalize ? 'on' : 'off'}`
  ].join('\n')

  return `<transcript settings>\n${labels}\n</transcript settings>\n\n<transcript>\n${req.raw}\n</transcript>`
}

export function buildContextBlock(previous: string): string {
  return `<previous utterance>\n${previous}\n</previous utterance>\n\n`
}

/** Prompt for the filler-removal counter used in telemetry/history, never shown raw. */
export function countFillers(input: string, output: string): number {
  const fillers = ['um', 'uh', 'erm', 'hmm', 'you know', 'i mean', 'sort of', 'kind of']
  const before = countOccurrences(input, fillers)
  const after = countOccurrences(output, fillers)
  return Math.max(0, before - after)
}

function countOccurrences(text: string, needles: string[]): number {
  const haystack = ` ${text.toLowerCase()} `
  let total = 0
  for (const needle of needles) {
    let index = haystack.indexOf(needle)
    while (index !== -1) {
      total++
      index = haystack.indexOf(needle, index + needle.length)
    }
  }
  return total
}