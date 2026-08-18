const {
    app,
    BrowserWindow,
    desktopCapturer,
    ipcMain,
    Menu,
    powerMonitor,
} = require('electron')
const path = require('path')
const fs = require('fs')
const https = require('https')
const { spawn } = require('child_process')
const robot = require('@hurdlegroup/robotjs')

const cors = require('cors')
const express = require('express');
const expressApp = express();
const { screen } = require('electron')

let availableScreens
let mainWindow
let clientSelectedScreen
let displays

const { createServer } = require('http')
const { Server } = require('socket.io');
const { Simulate } = require('react-dom/test-utils');

// ---------- Persistent config ----------
// Stored as a plain JSON file in Electron's per-user data folder, so it
// survives app restarts and never needs to be committed to the repo or set
// as an environment variable. Edited from the Settings panel on the host
// screen in the app itself.
const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json')

const DEFAULT_CONFIG = {
    ngrokDomain: '',       // e.g. "minutial-uncloying-diedre.ngrok-free.dev"
    meteredSecretKey: '',  // TURN credential API key from metered.ca
    pin: 'changeme123',
}

function loadConfig() {
    try {
        const raw = fs.readFileSync(CONFIG_PATH, 'utf-8')
        return { ...DEFAULT_CONFIG, ...JSON.parse(raw) }
    } catch (e) {
        return { ...DEFAULT_CONFIG }
    }
}

function saveConfig(newConfig) {
    const merged = { ...loadConfig(), ...newConfig }
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2))
    return merged
}

let config = loadConfig()

// ---------- ngrok auto-launch ----------
// Spawns `ngrok http --domain=... 3001` as a child process instead of
// requiring you to run it manually in a separate terminal. Assumes `ngrok`
// is on your PATH (true if you installed it via winget/Microsoft Store and
// have used it from a terminal before).
let ngrokProcess = null
let ngrokLogLines = []
let ngrokStatus = 'stopped' // 'stopped' | 'starting' | 'online' | 'error'

function appendNgrokLog(line) {
    ngrokLogLines.push(line)
    if (ngrokLogLines.length > 100) ngrokLogLines.shift()
    if (mainWindow) mainWindow.webContents.send('ngrok-log', line)
}

function sanitizeDomain(raw) {
    return (raw || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '')
}

function startNgrok() {
    if (ngrokProcess) return { ok: false, error: 'ngrok is already running' }
    const domain = sanitizeDomain(config.ngrokDomain)
    if (!domain) return { ok: false, error: 'No ngrok domain set in Settings' }

    ngrokStatus = 'starting'
    ngrokLogLines = []

    try {
        ngrokProcess = spawn(
            'ngrok',
            ['http', `--url=https://${domain}`, '3001'],
            { shell: true }
        )
    } catch (e) {
        ngrokStatus = 'error'
        return { ok: false, error: e.message }
    }

    ngrokProcess.stdout.on('data', (data) => {
        const text = data.toString()
        appendNgrokLog(text)
        // Best-effort check of the accumulated log. The more reliable signal
        // is a real viewer authenticating (see the 'auth' handler below),
        // this is just to get the dot green a little sooner if possible.
        const fullLog = ngrokLogLines.join('')
        if (/online/i.test(fullLog) || /forwarding/i.test(fullLog)) {
            ngrokStatus = 'online'
        }
    })

    ngrokProcess.stderr.on('data', (data) => {
        appendNgrokLog(data.toString())
    })

    // Fallback: if the process is still alive after a few seconds with no
    // error, assume the tunnel came up fine even if we couldn't detect the
    // "online" text in its output. Confirmed properly the moment a real
    // viewer connects, via the 'auth' handler below.
    setTimeout(() => {
        if (ngrokProcess && ngrokStatus === 'starting') {
            ngrokStatus = 'online'
        }
    }, 4000)

    ngrokProcess.on('exit', (code) => {
        appendNgrokLog(`ngrok exited with code ${code}`)
        ngrokProcess = null
        ngrokStatus = 'stopped'
    })

    ngrokProcess.on('error', (err) => {
        appendNgrokLog(`Failed to start ngrok: ${err.message}. Is it installed and on your PATH?`)
        ngrokProcess = null
        ngrokStatus = 'error'
    })

    return { ok: true }
}

function stopNgrok() {
    if (ngrokProcess) {
        const pid = ngrokProcess.pid
        // On Windows, spawning with shell:true runs ngrok inside a cmd.exe
        // wrapper. A plain .kill() only kills that wrapper and leaves the
        // actual ngrok.exe running orphaned in the background. /T kills the
        // whole process tree instead.
        if (process.platform === 'win32') {
            spawn('taskkill', ['/PID', pid, '/T', '/F'])
        } else {
            ngrokProcess.kill()
        }
        ngrokProcess = null
        ngrokStatus = 'stopped'
    }
    return { ok: true }
}

expressApp.use(express.static(__dirname));

//Middleware
expressApp.use((req, res, next) => {
    res.set('ngrok-skip-browser-warning', 'true');
    next(); // Proceed to the next middleware or route
});

expressApp.get('/', function (req, res, next) {
    console.log('req path...', req.path)
    res.sendFile(path.join(__dirname, 'index.html'));
});

expressApp.set('port', 3000)
expressApp.use(cors({ origin: '*' }))

expressApp.use(function (req, res, next) {
    // Website you wish to allow to connect
    res.setHeader('Access-Control-Allow-Origin', '*');
    // Request methods you wish to allow
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
    // Request headers you wish to allow
    res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With,content-type');
    // Set to true if you need the website to include cookies in the requests sent
    // to the API (e.g. in case you use sessions)
    res.setHeader('Access-Control-Allow-Credentials', true);
    // Pass to next layer of middleware
    next();
})

// TURN credentials, fetched fresh server-side using the (never exposed to
// the browser) Metered API key from config.
const METERED_DOMAIN = 'mistai.metered.live'

expressApp.get('/turn-credentials', function (req, res) {
    if (!config.meteredSecretKey) {
        res.json([]) // no TURN key configured yet - STUN-only fallback
        return
    }
    https.get(
        `https://${METERED_DOMAIN}/api/v1/turn/credentials?apiKey=${config.meteredSecretKey}`,
        (turnRes) => {
            let data = ''
            turnRes.on('data', (chunk) => { data += chunk })
            turnRes.on('end', () => {
                try {
                    const iceServers = JSON.parse(data)
                    res.json(iceServers)
                } catch (error) {
                    debugLog('failed to parse TURN credentials', error)
                    res.status(500).json([])
                }
            })
        }
    ).on('error', (error) => {
        debugLog('failed to fetch TURN credentials', error)
        res.status(500).json([])
    })
})

const httpServer = createServer(expressApp)
httpServer.listen(3001, '0.0.0.0')
httpServer.on('error', e => console.log('error'))
httpServer.on('listening', () => console.log('listening.....'))
const io = new Server(httpServer, {
    origin: '*',
})

const connections = io.of('/remote-ctrl')

connections.on('connection', socket => {
    debugLog('connection established')

    // The Electron host authenticates itself automatically - it's already
    // running locally on the machine being controlled, so there's nothing
    // to gate. Only remote viewers need to prove they know the PIN.
    let authenticated = false

    socket.on('auth', (pin) => {
        if (pin === config.pin) {
            authenticated = true
            socket.emit('auth-result', { ok: true })
            debugLog('client authenticated')
            // A real viewer successfully connecting is the clearest possible
            // proof the tunnel is actually working end-to-end - simpler and
            // more reliable than trying to parse ngrok's terminal output.
            if (ngrokProcess && ngrokStatus !== 'online') {
                ngrokStatus = 'online'
                appendNgrokLog('\n[viewer connected - tunnel confirmed working]\n')
            }
        } else {
            socket.emit('auth-result', { ok: false })
            debugLog('auth failed - wrong pin')
        }
    })

    // Electron's own App.js instance calls this immediately on load so the
    // host doesn't have to type a PIN into itself.
    socket.on('host-auth', () => {
        authenticated = true
        debugLog('host self-authenticated')
    })

    socket.on('viewer-ready', () => {
        if (!authenticated) return
        debugLog('viewer ready, forwarding to host')
        socket.broadcast.emit('viewer-ready')
    })

    socket.on('offer', sdp => {
        if (!authenticated) return
        debugLog('routing offer')
        // send to the electron app
        socket.broadcast.emit('offer', sdp)
    })

    socket.on('answer', sdp => {
        if (!authenticated) return
        debugLog('routing answer')
        // send to the electron app
        socket.broadcast.emit('answer', sdp)
    })

    socket.on('icecandidate', icecandidate => {
        if (!authenticated) return
        socket.broadcast.emit('icecandidate', icecandidate)
    })

    socket.on('selectedScreen', selectedScreen => {
        if (!authenticated) return
        clientSelectedScreen = selectedScreen

        socket.broadcast.emit('selectedScreen', clientSelectedScreen)
    })




    let isDragging = false;

    socket.on('mouse_down', ({ button }) => {
        if (!authenticated) return
        //console.log(button)
        if (button == 0) { isDragging = true; robot.mouseToggle("down", "left"); } else
            if (button == 1) robot.mouseToggle("down", "middle"); else
                if (button == 2) robot.mouseToggle("down", "right");
        //console.log("Mouse down: " + button)
        // You may implement further logic depending on the specific needs
    });

    socket.on('mouse_up', ({ button }) => {
        if (!authenticated) return
        //console.log(button)
        if (button == 0) { isDragging = false; robot.mouseToggle("up", "left"); } else
            if (button == 1) robot.mouseToggle("up", "middle"); else
                if (button == 2) robot.mouseToggle("up", "right");
        //console.log("Mouse up: " + button)
        // Finalize any dragging operations if necessary
    });

    socket.on('mouse_move', ({
        clientX, clientY, clientWidth, clientHeight,
    }) => {
        if (!authenticated) return
        try {
            const { width, height } = robot.getScreenSize();

            const ratioX = width / clientWidth;
            const ratioY = height / clientHeight;

            const hostX = clientX * ratioX;
            const hostY = clientY * ratioY;

            if (isDragging) {
                robot.dragMouse(hostX, hostY);
            } else {
                robot.moveMouse(hostX, hostY);
            }

        } catch (error) {
            handleError(error);
        }
    });


    socket.on('scrolling', ({ scroll }) => {
        if (!authenticated) return
        //console.log(scroll);
        const [deltaY, deltaX] = scroll;

        // Optional: Factor to adjust scroll speed
        robot.scrollMouse(deltaX, -deltaY);
    });


    socket.on('key_down', ({ button }) => {
        if (!authenticated) return
        try {
            button = keySort(button);

            var Special = ["shift", "control", "alt"];
            if (Special.includes(button)) {
                robot.keyToggle(button, "down")
            } else
                robot.keyTap(button);
        } catch (error) {
            console.error('An error occurred while processing the key press:', error);
        }
    });

    socket.on('key_up', ({ button }) => {
        if (!authenticated) return
        try {
            button = keySort(button);
            robot.keyToggle(button, 'up');
        } catch (error) {
            console.error('An error occurred while processing the key press:', error);
        }
    });

    function keySort(button) {
        var Namespace = {
            //Normal keys
            Backspace: "backspace",
            Delete: "delete",
            Enter: "enter",
            Tab: "tab",
            Escape: "escape",
            //Navigation
            ArrowUp: "up",
            ArrowDown: "down",
            ArrowLeft: "left",
            ArrowRight: "right",
            Home: "home",
            End: "end",
            // Function Keys
            F1: 'f1', F2: 'f2', F3: 'f3', F4: 'f4',
            F5: 'f5', F6: 'f6', F7: 'f7', F8: 'f8',
            F9: 'f9', F10: 'f10', F11: 'f11', F12: 'f12',
            //Shortcut Keys
            Shift: "shift",
            Control: "control",
            Alt: "alt"
        }

        if (Namespace[button]) {
            return Namespace[button];
        }
        return button
    }
});

const sendSelectedScreen = (item) => {
    try {
        const display = displays.find(display => `${display.id}` === item.display_id);

        if (!display) {
            throw new Error(`Display not found for id: ${item.display_id}`);
        }

        const displaySize = display.size;

        if (!displaySize) {
            throw new Error(`Display size is undefined for display id: ${item.display_id}`);
        }

        debugLog('Sending source ID with display size:', displaySize);

        mainWindow.webContents.send('SET_SOURCE_ID', {
            id: item.id,
            displaySize,
        });

    } catch (error) {
        handleError(error);
        mainWindow.webContents.send('SET_SOURCE_ID', {
            id: item.id,
            displaySize: { width: 1920, height: 1080 } // Or some default value
        });
    }
}

const createTray = () => {
    const screensMenu = availableScreens.map(item => {
        return {
            label: item.name,
            click: () => {
                sendSelectedScreen(item)
            }
        }
    })

    const menu = Menu.buildFromTemplate([
        {
            label: app.name,
            submenu: [
                { role: 'quit' }
            ]
        },
        {
            label: 'Screens',
            submenu: screensMenu
        }
    ])

    Menu.setApplicationMenu(menu)
}


const createWindow = () => {
    mainWindow = new BrowserWindow({
        show: false,
        width: 800,
        height: 600,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js')
        }
    })

    ipcMain.on('set-size', (event, size) => {
        const { width, height } = size
        try {
            debugLog('electron dim..', width, height)
            !isNaN(height) && mainWindow.setSize(width, height, false)
        } catch (e) {
            handleError(e)
        }
    })

    // The host loads its own local server directly - it doesn't need to go
    // through ngrok to reach itself. Only remote viewers need the tunnel.
    mainWindow.loadURL('http://localhost:3001/')

    mainWindow.once('ready-to-show', () => {
        displays = screen.getAllDisplays()

        mainWindow.show()
        mainWindow.setPosition(0, 0)

        desktopCapturer.getSources({
            types: ['screen']
        }).then(sources => {
            sendSelectedScreen(sources[0])
            availableScreens = sources
            createTray()
        })
    })

    //mainWindow.webContents.openDevTools()
}

// ---------- IPC: settings panel support ----------
ipcMain.handle('get-config', () => config)

ipcMain.handle('save-config', (event, newConfig) => {
    if (newConfig.ngrokDomain !== undefined) {
        newConfig = { ...newConfig, ngrokDomain: sanitizeDomain(newConfig.ngrokDomain) }
    }
    config = saveConfig(newConfig)
    return config
})

ipcMain.handle('start-ngrok', () => startNgrok())
ipcMain.handle('stop-ngrok', () => stopNgrok())
ipcMain.handle('ngrok-status', () => ({ status: ngrokStatus, log: ngrokLogLines.join('') }))

app.on('before-quit', () => {
    stopNgrok()
})

// Debugging utility functions
const debugLog = (...args) => {
    console.log('DEBUG:', ...args);
};

const handleError = (error) => {
    if (error.toString().toLowerCase().startsWith("error:")) {
        console.error(error);
    } else {
        console.error('ERROR:', error);
    }
};

app.on('ready', () => {
    createWindow()
})