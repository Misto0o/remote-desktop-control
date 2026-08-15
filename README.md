# control_desktop

A self-hosted remote desktop tool: an Electron app broadcasts your screen and
accepts mouse/keyboard input over WebRTC + Socket.IO, tunneled through ngrok
so you can view and control the machine from any browser — including your
phone — without needing both devices on the same network.

## Credits

Originally created by **Amir Eshaq**, modified by Xander, and further
modified by me (Kristian "Mist" Cook). See [LICENSE](./LICENSE) — this
project remains MIT licensed, with the original copyright preserved.

### What I changed

- Split the app into explicit **host** (Electron, captures the screen) and
  **viewer** (any browser) roles, fixing a race condition where the original
  single-component design could stall out waiting for a peer that never
  showed up.
- Migrated `robotjs` → [`@hurdlegroup/robotjs`](https://www.npmjs.com/package/@hurdlegroup/robotjs)
  (a maintained fork with prebuilt Windows binaries), since the original
  dependency doesn't have prebuilt binaries for modern Node and required a
  full Visual Studio Build Tools install to compile from source.
- Removed an unused `@tensorflow/tfjs-node` dependency that also required a
  native compile step for no functional benefit.
- Added mobile support:
  - Touch controls (tap to click, drag to move/drag)
  - Two-finger scroll and pinch-to-zoom, with a lock toggle so the two
    gestures don't fight each other
  - An on-screen keyboard trigger (mobile browsers only show their keyboard
    for a real focused input, so there's a small input box that summons it)
  - Accurate touch-to-screen coordinate mapping that accounts for
    letterboxing when the video's aspect ratio doesn't match the viewport
- Fixed a signaling bug where the server wasn't relaying `offer`/`viewer-ready`
  events between host and viewer, which caused the video stream to never
  attach even though the underlying WebRTC/socket plumbing was healthy.
- Requested higher-resolution screen capture (was defaulting to a small,
  blurry capture).

## Architecture

- **Electron main process** (`public/main.js`, compiled to `build/main.js`
  by `react-scripts build` — **always edit `public/main.js`, never
  `build/main.js` directly**, since it gets overwritten on every build):
  runs an Express + Socket.IO server on port `3001`, and uses
  [`@hurdlegroup/robotjs`](https://www.npmjs.com/package/@hurdlegroup/robotjs)
  to actually move the mouse / send keystrokes on the host machine.
- **React app** (`src/App.js`): detects whether it's running inside
  Electron (`window.electronAPI` present, injected by `public/preload.js`)
  to decide whether it's the host (captures and broadcasts the screen via
  WebRTC) or a viewer (renders the incoming stream and sends input events
  back over the socket).
- **ngrok**: tunnels the local Express server to a public URL so viewers
  don't need to be on the same network as the host.

## Setup

### 1. Install dependencies

```powershell
yarn install
```

If you're on Windows and hit native build errors, make sure you're using
`@hurdlegroup/robotjs`, not the original `robotjs` — the latter has no
prebuilt binaries for modern Node versions and requires a full C++ build
toolchain to compile.

### 2. Set up ngrok

Sign up for a free [ngrok](https://ngrok.com) account and grab your
authtoken from the "Your Authtoken" section of the dashboard (**not** the
API Keys section — API keys start with `cr_` and won't work here).

```powershell
ngrok config add-authtoken YOUR_AUTHTOKEN
```

Free accounts get one permanent static domain ("dev domain") under
**Domains** in the dashboard. Use it explicitly so the URL never changes:

```powershell
ngrok http --domain=YOUR-DOMAIN.ngrok-free.dev 3001
```

### 3. Point the app at your domain

Update the hardcoded URL in **three** places to match your ngrok domain:

- `public/main.js` → `mainWindow.loadURL('https://YOUR-DOMAIN.ngrok-free.dev/')`
- `src/App.js` → `const SIGNALING_URL = 'https://YOUR-DOMAIN.ngrok-free.dev/remote-ctrl'`

(`build/main.js` gets this automatically from `public/main.js` on the next
build — don't edit it directly.)

### 4. Build and run

```powershell
yarn build
yarn start
```

**Always run `yarn build` before `yarn start`** — running them out of order
means Electron loads a stale bundle.

Once it's running, open your ngrok URL on any other device to view and
control the host's screen.

## Controls (viewer)

- **One finger / mouse** — move cursor, click and drag
- **Two fingers** — scroll (default) or pinch-to-zoom, toggle with the
  🔒/🔍 button
- **⌨️ button** — opens a small input to bring up your phone's keyboard;
  typed characters and Backspace/Enter/Tab/arrows get forwarded to the host

## Known limitations / possible next steps

- No authentication — anyone with the URL can control the host. Fine for
  personal use behind an obscure ngrok URL, but worth adding a shared PIN
  before relying on this for anything sensitive.
- Only tested with a single viewer at a time.
- Free ngrok domains can only be used from one machine at a time (whichever
  is currently running `ngrok http --domain=...`).