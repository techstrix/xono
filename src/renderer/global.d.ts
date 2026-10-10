import type { XonoApi } from '../preload'

declare global {
  interface Window {
    xono: XonoApi
  }
}

export {}