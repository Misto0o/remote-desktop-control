# control_desktop

Remote control your PC from your phone (or any browser) — no same-WiFi
requirement, no port forwarding, no messing with your router. Just install
it, open the app, and scan a QR code.

Built on top of a project originally made by **Amir Eshaq**, tweaked by my
friend Xander, and then heavily rebuilt by me. See the [Credits](#credits)
section for the full story.

## Just want to use it?

Grab the installer from the [Releases page](../../releases) and run it.
That's it — no terminal, no code.

**Heads up:** it's unsigned (I'm one guy, not a company with a code-signing
certificate), so Windows will probably show a "Windows protected your PC"
warning the first time you run it. Click **"More info" → "Run anyway"**.
It's safe — you can read every line of the source right here if you want.

### First-time setup (takes like 2 minutes)

1. Open the app
2. Click **Settings**
3. Fill in:
   - Your **ngrok domain** (see below if you don't have one yet)
   - A **PIN** — this is what protects your PC from randoms, pick something
     you'll remember
   - A **TURN API key** (optional, but recommended — makes it work on
     cellular data, not just WiFi. See below)
4. Hit **Save**, then **Start tunnel**
5. Scan the QR code with your phone, type in the PIN, and you're in

Everything you type here is saved on your computer automatically — you
won't have to do this again next time you open the app.

### Getting an ngrok domain (free, 2 minutes)

1. Sign up at [ngrok.com](https://ngrok.com)
2. In the dashboard, go to **Domains** and grab your free static domain
   (looks like `something-random.ngrok-free.dev`)
3. Open a terminal once and run:
   ```
   ngrok config add-authtoken YOUR_TOKEN
   ```
   (your token is on the ngrok dashboard homepage)
4. Paste the domain into the app's Settings

You only need ngrok *installed* on your computer — the app launches and
manages the tunnel for you after that, so no terminal needed going forward.

### Getting a TURN key (free, makes cellular work)

Without this, the app still works great over WiFi, but video usually won't
connect over cellular data (phone carriers block the direct connection type
it needs). Takes 5 minutes to fix:

1. Sign up free at [metered.ca](https://www.metered.ca)
2. Go to **TURN Server** in the sidebar (not "Developers" — that's a
   different key that won't work here)
3. Create a credential if you don't have one
4. Click **"Show API Key"** next to it and paste that into the app's Settings

## Want to build it yourself instead?

```bash
git clone <this repo>
cd control_desktop
yarn install
yarn build
yarn start
```

Everything else (ngrok domain, PIN, TURN key) is set through the Settings
panel in the running app, same as above — nothing needs to be hardcoded or
set as an environment variable anymore.

To build your own installer:
```bash
yarn make
```
Your `.exe` shows up in `out/make/squirrel.windows/x64/`.

## How it works, roughly

- The app runs a little local server on your PC (port 3001) that does two
  things: shares your screen over WebRTC, and listens for mouse/keyboard
  commands to actually move your cursor and type.
- ngrok makes that local server reachable from the internet, so your phone
  can talk to it from anywhere — coffee shop, cellular data, wherever.
- Your phone connects to the WebRTC stream directly-ish (through a TURN
  relay if needed) so video stays fast, while control commands and the
  handshake to set that up route through ngrok.
- Everything's gated behind a PIN so randomly guessing your ngrok URL
  doesn't get anyone in.

## Controls on the viewer (phone) side

- **One finger** — move the cursor, tap to click, drag to drag
- **Two fingers** — scroll by default; tap the 🔒/🔍 button to switch to
  pinch-to-zoom instead
- **⌨️ button** — pops up a little box so your phone's keyboard shows up;
  whatever you type gets sent over

## Things to know

- Only really tested with one viewer connected at a time.
- Your computer needs to stay **awake**, not sleeping, for this to work.
  If you want to check on it while you're out, go into Windows power
  settings and turn off sleep while plugged in.
- Mouse movement is 1:1 with screen position (great for normal desktop
  use, not built for FPS-style camera-look controls in games).
- Free ngrok domains only work from one computer at a time — if you're
  running this on two machines, only whichever one has the tunnel started
  will actually be reachable.

## Credits

This started as a project by **Amir Eshaq**, which my friend Xander
modified, and I rebuilt a lot of on top of that (see the license file for
the original copyright — this is still MIT licensed).

Rough list of what changed under the hood, if you're curious or building
on this yourself:

- Rewrote the host/viewer connection logic to fix a race condition where
  the app could get stuck waiting for a peer that never showed up
- Swapped in a maintained fork of `robotjs` so the app doesn't need a full
  C++ compiler installed just to run
- Added real mobile support — touch controls, pinch-zoom, an on-screen
  keyboard trigger, and coordinate mapping that actually lines up taps
  with where they land on screen
- Added PIN authentication
- Added TURN relay support so it works on cellular, not just WiFi
- Replaced editing code / setting environment variables with an actual
  Settings screen in the app, plus a QR code so you don't have to type
  URLs on your phone
- Made ngrok launch automatically from inside the app instead of needing
  a separate terminal window running the whole time
- Packaged the whole thing into a real Windows installer