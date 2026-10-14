import { app, BrowserWindow, screen } from 'electron'
import { XonoApp } from './app'
import { pillGapFromBottom } from './core/widgetLayout'
import { playWidgetDemo } from './demo'
import { loggerScope } from './core/logger'

const log = loggerScope('main')

const argv = process.argv.slice(1)

// Linux desktop integration identity.
//
// On Wayland, global shortcuts are bound through the xdg-desktop-portal
// GlobalShortcuts portal, and the portal identifies the app by its desktop entry name.
// Without a valid reverse-DNS id the bind is refused *silently* — `register()` still
// returns true, so the only symptom is a hotkey that never fires. This must be set
// before the ready event.
if (process.platform === 'linux') {
  app.setDesktopName('xono')
}

/**
 * Read the rendered pill's geometry out of the renderer.
 *
 * An always-on-top overlay is invisible from a shell, so this is how `--diagnose` and
 * `--trace` check that the pill is actually up and actually sitting where it should.
 *
 * `getBoundingClientRect` is relative to the window's viewport, so callers must add
 * the window's screen position. Two samples are taken so an in-flight animation does
 * not masquerade as the resting state.
 */
const probe = (waitMs: number): string => `(async () => {
  const sample = () => {
    const el = document.querySelector('.pill');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      x: Math.round(r.left),
      y: Math.round(r.top),
      w: Math.round(r.width),
      h: Math.round(r.height),
      opacity: Number(cs.opacity).toFixed(3),
      state: el.closest('.stage')?.getAttribute('data-state') ?? null
    };
  };
  const first = sample();
  await new Promise((r) => setTimeout(r, ${waitMs}));
  const second = sample();
  return { first, second };
})()`

/**
 * Sample the pill repeatedly and print one CSV row per sample, so an animation can be
 * checked as a sequence rather than a single lucky frame.
 */
const PILL_PROBE = probe(700)

async function traceWindows(samples: number, intervalMs: number): Promise<void> {
  console.log('XONO_TRACE state,pillW,pillH,gapFromBottom,centredDelta,opacity')
  for (let i = 0; i < samples; i++) {
    // The widget window only gets its title once the renderer has loaded, so this can
    // legitimately miss on the first few ticks.
    const win = BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'Xono')
    if (!win) {
      console.log('XONO_TRACE no-widget')
      await new Promise((r) => setTimeout(r, intervalMs))
      continue
    }
    const b = win.getBounds()
    const area = screen.getPrimaryDisplay().workArea
    const bottom = area.y + area.height
    // Sample instantly: the probe's own wait would stretch each sample to over a second
    // and miss whole animation phases.
    const sampled = await win.webContents.executeJavaScript(probe(0)).catch(() => null)
    const pill = sampled?.first ?? null

    if (!pill) {
      console.log('XONO_TRACE no-pill')
    } else {
      const gap = pillGapFromBottom(bottom, b.y, pill.y, pill.h)
      const left = b.x + pill.x - area.x
      const right = area.x + area.width - (b.x + pill.x + pill.w)
      console.log(
        `XONO_TRACE ${pill.state},${pill.w},${pill.h},${gap},${right - left},${pill.opacity}`
      )
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

async function reportWindows(): Promise<void> {
  const area = screen.getPrimaryDisplay().workArea
  const bottom = area.y + area.height

  const windows = await Promise.all(
    BrowserWindow.getAllWindows().map(async (win) => {
      const b = win.getBounds()
      // The window rect is not the pill rect: the pill is a small element inside a large
      // transparent window. Read the real geometry from the renderer, because "is it
      // really a little above the screen edge" is a question about the pill.
      const sampled = await win.webContents.executeJavaScript(PILL_PROBE).catch(() => null)
      const pill = sampled?.first ?? null

      return {
        title: win.getTitle(),
        visible: win.isVisible(),
        alwaysOnTop: win.isAlwaysOnTop(),
        focusable: win.isFocusable(),
        bounds: b,
        // Gaps relative to the work area, which is what "a little margin from the screen
        // border" means once panels are accounted for.
        windowGapFromBottom: bottom - (b.y + b.height),
        windowGapFromLeft: b.x - area.x,
        windowGapFromRight: area.x + area.width - (b.x + b.width),
        pill,
        pillSecond: sampled?.second ?? null,
        // Gaps are measured from the pill's own rect: the window is deliberately larger
        // than the pill, so window geometry alone would overstate the margin.
        pillGapFromBottom: pill ? pillGapFromBottom(bottom, b.y, pill.y, pill.h) : null,
        pillGapFromLeft: pill ? b.x + pill.x - area.x : null,
        pillGapFromRight: pill ? area.x + area.width - (b.x + pill.x + pill.w) : null
      }
    })
  )

  console.log(`XONO_DIAGNOSE ${JSON.stringify({ workArea: area, windows })}`)
}

// A tray-resident app must not be a second copy of itself fighting over the hotkey.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  const xono = new XonoApp()

  // A second launch must not open Settings unconditionally: `xono --toggle` is the
  // documented escape hatch for environments where the portal refuses to bind, and the
  // single-instance lock would otherwise make it quit without ever toggling.
  app.on('second-instance', (_event, commandLine) => {
    const forwarded = commandLine.slice(1)
    if (forwarded.includes('--toggle')) {
      log.info('--toggle received from a second instance')
      void xono.toggle()
      return
    }
    if (forwarded.includes('--settings')) {
      xono.getSettingsWindow().show()
      return
    }
    xono.getSettingsWindow().show()
  })

  // Deliberately no `window-all-closed` handler that quits. Closing the settings window
  // must leave the hotkey, the tray and the pill alive; only the tray's Quit ends it.
  app.on('window-all-closed', () => {
    log.debug('all windows closed; staying resident')
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) xono.getSettingsWindow().show()
  })

  app.on('before-quit', () => {
    void xono.shutdown()
  })

  // --toggle is the escape hatch for environments where Electron cannot grab a global
  // shortcut itself (notably Wayland without the GlobalShortcuts portal): the user binds
  // a KDE system shortcut to this command instead.
  if (argv.includes('--toggle')) {
    // Only reachable when this process *is* the primary instance; otherwise the
    // `second-instance` handler above takes over.
    app.whenReady().then(() => {
      setTimeout(() => void xono.toggle(), 800)
    })
  }

  app.whenReady().then(async () => {
    try {
      await xono.boot()
    } catch (err) {
      log.error('failed to start', err)
      app.quit()
      return
    }

    // --demo drives the widget through every state on a timer, so the animation can be
    // reviewed without a microphone, a model and a configured provider. It waits for the
    // renderer to report in, or its opening states would be dropped.
    if (argv.includes('--demo')) {
      xono.whenWidgetReady(() =>
        playWidgetDemo((channel, payload) => xono.getWidget().send(channel, payload))
      )
    }

    // --hotkey-probe keeps the app running and logs every activation, so a shortcut can
    // be told apart from a shortcut that fires but does nothing useful.
    if (argv.includes('--hotkey-probe')) {
      log.info(`hotkey probe ready; send ${xono.getConfigStore().get().hotkey.accelerator} to test`)
    }

    if (argv.includes('--trace')) {
      // Sample across the demo sequence so the expand/collapse can be verified.
      setTimeout(() => {
        void traceWindows(70, 200).finally(() => app.quit())
      }, 600)
    } else if (argv.includes('--diagnose')) {
      // Give the renderer time to paint before sampling.
      setTimeout(() => {
        void reportWindows()
          .catch((err) => log.error('diagnose failed', err))
          .finally(() => app.quit())
      }, 2500)
    }
  })
}
