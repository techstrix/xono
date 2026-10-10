# Xono

Speak, and the cleaned text lands in whatever box you were typing in.

Press the hotkey, talk, press it again. Xono records from your microphone, transcribes
it locally with whisper.cpp, cleans the transcript with an LLM (fillers and false
starts gone, paragraphs intact), and pastes the result into the input field that
already had your focus — no window switching, no mouse.

---

## How it works

```
hotkey ──▶ record (PipeWire) ──▶ VAD trim ──▶ whisper.cpp ──▶ LLM cleanup ──▶ Ctrl+V
           16 kHz mono          drop silence   local, offline   your provider   ydotool
```

Everything is designed around one rule: **your words are never lost.** If the LLM is
down, slow, or unconfigured, the raw transcript is pasted anyway and the widget says
so. If injection degrades, the text goes to your clipboard and you press Ctrl+V.

---

## Setup

Requires Node 22+, CMake, a C++ compiler, and (Linux) `pipewire-utils`.

```bash
npm install

# Build whisper.cpp and download the default GGML model.
npm run setup:engine

# Install the desktop entry. Required for the global hotkey to work on Wayland —
# the portal identifies the app by its desktop identity, and refuses the binding
# silently without one. `npm run dev` bypasses this, so the hotkey stays dead.
npm run setup:desktop-entry

# Check everything this machine needs, with the fix for whatever is missing.
npm run doctor

# Launch the way the desktop does, so the hotkey binds.
npm run launch
```

`npm run dev` carries the same `--ozone-platform=x11` flag as the installed app, so the
widget behaves identically in development. Without it, dev mode falls back to native
Wayland and the pill silently loses both its position and its always-on-top behaviour.

Two things need `sudo` and are reported by `npm run doctor`:

```bash
sudo pacman -S ydotool        # sends the Ctrl+V key chord on Wayland
sudo modprobe uinput          # virtual keyboard device
```

**ydotool needs a daemon.** `ydotool` itself is only a thin client; every subcommand
exits `2` with `failed to connect socket ... check if ydotoold is running` when
`ydotoold` — the process that actually holds `/dev/uinput` — is not up. Xono starts
that daemon itself on the first dictation and kills it on quit, so nothing is needed
here.

For a daemon that survives app restarts and reboots, use the systemd user unit
instead; Xono detects the existing socket and leaves it alone:

```bash
systemctl --user enable --now ydotoold
```

---

## Measured behaviour on the reference machine

KDE Plasma 6 / Wayland, 4-core Skylake-U (AVX2, no GPU), 16 GB RAM.

| Step | Result |
|---|---|
| Global hotkey | Registers successfully (`globalShortcut` works on KDE) |
| Audio capture | 16 kHz mono via `parec`, ~47 analysis frames/s |
| VAD | Energy-based, no native dependency; end-of-speech after 1.2 s silence |
| Transcription | `tiny.en` **~10 s**, `base.en` **~19 s** per utterance |
| Injection | Clipboard payload + `ydotool` Ctrl+V chord |
| `ydotoold` | Started on demand in ~70 ms; verified emitting `29:1 47:1 47:0 29:0` |
| Stale socket | Detected and recovered by restarting the daemon, then retrying once |

**On the transcription numbers.** whisper.cpp always runs the encoder across a full
30-second mel window, so cost barely depends on how long you spoke — a 3 s clip and a
24 s clip cost about the same. `tiny.en` is therefore the default; `base.en` is ~19 s
here, which is long enough to break the flow this tool exists for. Move up to
`base.en` only once the vocabulary list has taught it your jargon.

Keeping `whisper-server` warm saves about 3.5 s of model load per utterance
(19 s → 15 s on `base.en`). It is not wired up yet; spawning per utterance is simpler
and works everywhere.

---

## The widget

A small pill sits at the bottom centre of the screen for as long as the app is running.
Its resting state is ~60×44 and shows the shortcut, because a global hotkey is otherwise
invisible; it expands when you start talking and collapses back when it is done.

Verified with `--demo --trace`, which drives every state on a timer and samples the real
rendered geometry:

```
idle  → listening → transcribing → cleaning → injecting → done → idle
width 42..402 px      gap from screen bottom: 47 px      centre delta: 0
```

The margin is constant in every state because the window is fixed-size and the pill is
bottom-anchored inside it, growing upward. The window hangs one shadow-height lower than
the configured gap, which is exactly the padding the renderer reserves, so the pill's
edge lands on the gap and its drop shadow has somewhere to render.

Three flags:

| Flag | Purpose |
|---|---|
| `--demo` | Plays the whole state sequence, so the animation can be reviewed without a microphone, a model or a provider |
| `--diagnose` | Prints the live window and pill geometry, then exits |
| `--trace` | Samples the pill across the sequence as CSV |

## Configuration

`~/.config/xono/config.json`, written atomically with mode `0600`. Edit it by hand or
through the settings window (tray icon → Settings).

| Setting | Default | Notes |
|---|---|---|
| Cleanup provider | Mistral | Groq, OpenRouter, NVIDIA NIM, Ollama (local), Anthropic |
| Dictation mode | `cleaned` | or `verbatim` / `structured` |
| STT model | `tiny.en` | see the table above before choosing |
| Injection method | `clipboard-ydotool` | or `clipboard-xdotool` / `clipboard-only` |
| Hotkey | ``Super+` `` | |
| Fail open to raw | on | paste the un-cleaned text rather than nothing |
| Silence before auto-stop | 2.5 s | longer is safer; the LLM removes fillers, this only avoids cutting you off |
| Speech threshold | 0.006 | low on purpose: a false "silence" truncates the utterance |
| Separator between dictations | a space | two dictations in a row would otherwise paste end to end |
| Restore clipboard | on | always, including back to empty — see below |

### Choosing a model

Providers that publish a catalogue get a searchable picker instead of a text field.
OpenRouter alone lists **467 models**, so the picker filters as you type and shows the
two facts that actually decide the choice here:

- **price per million tokens**, in and out
- **context length**

Entries are sorted text-capable first, then cheapest. Models that cannot emit text are
hidden entirely — they can never be a useful choice here, so deprioritising them would
just be noise.

Two details worth knowing:

- OpenRouter's `/models` is public and needs no key, so the list loads before you have
  one. It is ~780 kB, so it is cached for six hours and refreshed on demand; a failed
  refresh falls back to the cached list rather than emptying the picker.
- Routing pseudo-models (`openrouter/auto` and friends) report a price of `-1` because
  the real cost depends on which upstream model gets routed to. That is shown as *no
  price listed*, not as free.

The free-text field stays alongside the picker on purpose: a model id can always be
typed by hand, which matters when the catalogue is stale or the provider is unreachable.

OpenRouter also gets `HTTP-Referer` and `X-OpenRouter-Title` headers for app
attribution; both are editable in its settings section.

#### NVIDIA specifics

`https://integrate.api.nvidia.com/v1` is OpenAI-compatible and its `/models` endpoint
is public, so the catalogue loads without a key. It is also by far the *sparsest*
response of any provider we support — 80 models carrying nothing but an id:

```json
{ "id": "nvidia/nemotron-3.5-lightning-30b-a3b", "object": "model", "owned_by": "nvidia" }
```

No display name, no description, no context length, no price, and **no modality
information**. So the picker does two things it does not need to do elsewhere:

- **Derives readable names** from the id: `nvidia/nemotron-3.5-lightning-30b-a3b`
  becomes *NVIDIA · Nemotron 3.5 Lightning 30B A3B*.
- **Classifies chat-capability by naming convention**, because there is nothing else to
  go on. Of the 80 live models, 20 are filtered out — embeddings, retrieval, content
  safety guards, a reward model, a calibration model, translation-only and document
  parsing endpoints. None of those can rewrite a sentence.

That heuristic is deliberately conservative: it excludes only what definitively cannot
do chat, rather than trying to rank quality. A model wrongly left in costs one extra row
in a searchable list; a model wrongly hidden is one you cannot find. It is a heuristic
and will need revisiting as NVIDIA's catalogue changes — `npm run test:nvidia` runs it
over the live list and prints what it filtered, which is the fastest way to spot that.

Nothing invents a price for NVIDIA. The picker shows *no price listed* rather than
guessing, since NVIDIA's trial tier is free but production pricing is not published
through this endpoint.

**On reasoning models.** Several NVIDIA and OpenRouter models emit their thinking in a
separate `reasoning_content` field. That is fine — we only read `content` — but a model
that thinks and then returns no answer would otherwise surface as a bare "empty
response", so it now reports explicitly that the model returned only reasoning, and
suggests a non-reasoning alternative. For this job, prefer a small or "lightning" model:
thinking is pure overhead when the task is removing filler words.

### End-of-speech and fillers

The VAD deliberately errs toward *not* cutting you off. Removing fillers like "uhm" is
the cleanup model's job, so the only thing this layer has to get right is knowing when
you have genuinely stopped talking.

Two settings do that work, and both are tuned against the failure mode:

- **Silence before auto-stop** is 2.5 s rather than something short, because a pause
  mid-thought and a trailing filler both look identical to a short window.
- **Speech threshold** is low (0.006), and the adaptive noise floor is *capped* at 2.5x
  it. Without the cap, background noise raises the bar until a quiet "uhm" falls beneath
  it — which is exactly how "uhm uhm" was causing mid-thought cutoffs.

The asymmetry is deliberate: a false "silence" loses the end of your sentence and cannot
be recovered, while a false "speech" only records a little room tone, which the cleanup
model ignores.

### Why a dictation can never paste the wrong text

Three independent guards, because this failure is unrecoverable from the user's side —
they speak, and something else appears.

**The model cannot echo the previous utterance.** Every dictation sends the previous one
as context so that "now do the same for the second one" resolves. When the current
transcript is thin — a stray "uh", a clipped recording — a model has little to work with
and will sometimes hand the context straight back. The output is compared against both the
context and the raw transcript; if it matches the context but *not* the audio, it is
discarded in favour of the raw text. Genuinely repeating the same words twice is
allowed through.

**Your clipboard is always restored, including to empty.** Injection writes the text to
the clipboard, pastes, then puts your clipboard back 1.5 s later. That restore used to be
skipped when the previous value was empty, which left this dictation on the clipboard — so
the *next* dictation captured it as "previous" and restored it in turn. After two
dictations from an empty clipboard, your clipboard held an earlier dictation
permanently, and anything pasting from it later got a stale sentence. The restore now
always happens, and is skipped only if you copied something in the meantime.

**History records what you said, not what the model returned.** An entry is written as
soon as there is a transcript, then amended once cleanup and injection resolve. A failed
paste therefore still leaves the raw words behind rather than losing them.

### Consecutive dictations

Pasting lands at the caret, so dictating twice without moving the caret would paste the
second directly after the first. Xono records what it last pasted and inserts a separator
when the caret is presumably still there — a **space** by default, because a newline
submits the line in a terminal. It skips the separator when the text is already separated,
and after 90 seconds, since by then you have almost certainly moved on.

## Vocabulary

Terms you say often — tool names, repo names, acronyms — fed to whisper as a decoding
hint *and* to the cleanup model so it never "corrects" them. This is the single
highest-leverage setting when dictating about your own codebase.

### Privacy

Audio is captured locally and written only to a temporary WAV that is deleted as soon
as the utterance is transcribed. The only thing that leaves the machine is the
transcript text, sent to the cleanup provider you chose. Selecting Ollama keeps the
whole pipeline local. API keys live in the config file at `0600`; moving them to the
OS keyring is not implemented.

Fetching a provider's model catalogue is the one request that happens outside
dictation, and it sends nothing but the API key.

---

## The widget is placed from inside the window, not by moving it

On Wayland the compositor owns window placement. `xdg-shell` has no "move me" request,
so a client cannot choose its own position at all — on KDE the window simply gets
centred, which is how the pill ended up in the middle of the screen. Passing `x`/`y` to
`BrowserWindow` does not help, because a position requested before the window is mapped
is dropped outright.

So the window is sized to span the whole work area, which is the one placement the
compositor always agrees to, and the renderer anchors the pill to the bottom of it. The
result is bottom-centre on Wayland and unchanged on X11, where the requested position
would have been honoured anyway.

The same restriction is why the app runs under `--ozone-platform=x11`. Chromium
implements neither positioning nor always-on-top on native Wayland, so a window there is
placed by the compositor and other windows cover it — the pill vanished the moment any
app was maximised. XWayland has always had both. The desktop entry sets the flag, and a
packaged build gets it through `build.linux.executableArgs`.

The cost is the global shortcut: on XWayland Electron grabs the key with `XGrabKey`
rather than using the GlobalShortcuts portal. If the hotkey does not respond, bind it in
the desktop instead — the compositor runs the command itself, so it works regardless of
anything in this app:

> System Settings → Shortcuts → Custom Shortcuts → `Control+Space` → `xono --toggle`

Electron reports the `workArea` as the whole screen on Wayland, because a Wayland client
is not told where the panels are — which would leave the pill mispositioned. The window
instead asks XWayland's root window for `_NET_WORKAREA`, which does carry the
compositor's own idea of the available area, and falls back to Electron's answer if that
is unavailable.

## The global hotkey, and why it can look fine and still be dead

This is the single most confusing thing about running a tray app on Wayland, so it is
worth being precise about.

**Xono must be launched through its desktop entry** — `npm run launch`, or from the
application menu. Launched straight from a terminal it has no desktop identity, and the
`xdg-desktop-portal` GlobalShortcuts portal refuses the binding with *"An app id is
required"*. Electron does not surface that, so:

> the shortcut appears registered in settings, the diagnostics report success, and it
> never fires.

**`register()` returning true does not mean the shortcut works.** On Wayland the bind is
submitted to the portal and resolved asynchronously; the boolean only says the request
was accepted for delivery. The only party that knows the truth is the desktop.

So both `npm run doctor` and `npm run check:hotkey` ask KDE directly rather than
trusting Electron:

```
$ npm run check:hotkey
  accelerator: Control+Space
  KDE has the shortcut bound
  RESULT: LIVE — the shortcut reached xono and triggered a toggle
```

`check:hotkey` also invokes the bound shortcut through `KGlobalAccel` and confirms the
app's callback actually ran. Synthesising the key press is not a valid test — a uinput
device reaches applications, but KWin's global-shortcut path does not consume injected
events, so "I sent the key and nothing happened" tells you nothing.

**Fallback.** If the portal refuses the binding for any reason, bind a KDE system
shortcut instead:

> System Settings → Shortcuts → Custom Shortcuts → Command: `xono --toggle`

`npm run check:toggle` verifies that path end to end.

---

## Development

```bash
npm run typecheck        # tsc over main and renderer projects
npm test                 # unit + integration, hermetic
npm run test:live        # records from your real microphone (opt-in)
npm run test:engine      # runs the real whisper.cpp binary (opt-in)
npm run test:inject      # sends a real Ctrl+V and reads the key events back (opt-in)
npm run test:openrouter  # fetches the live OpenRouter catalogue (no key needed)
npm run test:nvidia      # fetches the live NVIDIA catalogue and prints what was filtered
npm run build            # typecheck + electron-vite build
npm run package          # AppImage
```

The live suites are skipped by default so `npm test` never touches hardware or the
network. `npm run test:inject` is the strongest of the three: it starts `ydotoold`,
sends the actual chord, and reads the resulting `input_event` structs back off
`/dev/input/eventN` to confirm the key events reached the kernel input layer — which
is where a receiving application picks them up. It needs `sudo modprobe uinput`.

### Layout

```
src/
  shared/          config schema, IPC contract, types — imported by both sides
  main/
    core/          plain Node, no Electron imports: capture, VAD, STT, LLM, inject
      pipeline.ts  the state machine that ties them together
    windows/       widget + settings BrowserWindows
    ipc/           typed request/response handlers
  preload/         the only bridge across the context boundary
  renderer/
    widget/        the floating pill
    settings/      the tabbed settings window
```

`src/main/core/` deliberately avoids importing Electron, so it can be extracted into a
standalone daemon later without a rewrite. That would cut idle memory from ~200 MB to
~40 MB, at the cost of a second runtime and a second build pipeline.

---

## Known limitations

- Linux only. `Injector` is an interface, so macOS (AppleScript/Accessibility) and
  Windows (UIA) can slot in, but nothing is implemented.
- Batch only: text lands after the utterance is fully processed, not streamed live.
- Cloud STT is not implemented; `SttProvider` is an interface and local whisper.cpp is
  the only implementation.
- API keys are stored in plaintext at `0600` rather than in the OS keyring.
- Text always appends at the caret; there is no append/replace/selection handling yet.
- The tray icon must exist at `resources/tray.png` or it renders empty.
- Text is inserted at the caret with no awareness of existing content in the field.