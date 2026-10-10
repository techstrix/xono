import type { ProviderConfig } from '@shared/schema'
import type { ProviderDefinition } from '@shared/providers'
import { OpenAICompatibleProvider } from './openaiCompat'

/**
 * OpenRouter speaks the OpenAI chat-completions dialect, so the request and response
 * handling is inherited wholesale. The only OpenRouter-specific behaviour is app
 * attribution, which it reads from two optional headers:
 *
 *   HTTP-Referer          your site URL, used for ranking attribution
 *   X-OpenRouter-Title    your app name, shown on their dashboard
 *
 * Both are optional to OpenRouter but free to send, and they are what makes the app
 * identifiable in the OpenRouter usage dashboard.
 */
export class OpenRouterProvider extends OpenAICompatibleProvider {
  constructor(def: ProviderDefinition) {
    super(def)
  }

  protected override extraHeaders(config: ProviderConfig): Record<string, string> {
    const headers: Record<string, string> = {}
    // OpenRouter documents both spellings; the -OpenRouter- form is current.
    if (config.referer.trim()) headers['HTTP-Referer'] = config.referer.trim()
    if (config.title.trim()) headers['X-OpenRouter-Title'] = config.title.trim()
    return headers
  }
}