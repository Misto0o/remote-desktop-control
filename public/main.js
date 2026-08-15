const {
    app,
    BrowserWindow,
    desktopCapturer,
    ipcMain,
    Menu,
    powerMonitor,
} = require('electron')
const path = require('path')
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

    socket.on('viewer-ready', () => {
        debugLog('viewer ready, forwarding to host')
        socket.broadcast.emit('viewer-ready')
    })

    socket.on('offer', sdp => {
        debugLog('routing offer')
        // send to the electron app
        socket.broadcast.emit('offer', sdp)
    })

    socket.on('answer', sdp => {
        debugLog('routing answer')
        // send to the electron app
        socket.broadcast.emit('answer', sdp)
    })

    socket.on('icecandidate', icecandidate => {
        socket.broadcast.emit('icecandidate', icecandidate)
    })

    socket.on('selectedScreen', selectedScreen => {
        clientSelectedScreen = selectedScreen

        socket.broadcast.emit('selectedScreen', clientSelectedScreen)
    })




    let isDragging = false;

    socket.on('mouse_down', ({ button }) => {
        //console.log(button)
        if (button == 0) { isDragging = true; robot.mouseToggle("down", "left"); } else
            if (button == 1) robot.mouseToggle("down", "middle"); else
                if (button == 2) robot.mouseToggle("down", "right");
        //console.log("Mouse down: " + button)
        // You may implement further logic depending on the specific needs
    });

    socket.on('mouse_up', ({ button }) => {
        //console.log(button)
        if (button == 0) { isDragging = false; robot.mouseToggle("up", "left"); } else
            if (button == 1) robot.mouseToggle("up", "middle"); else
                if (button == 2) robot.mouseToggle("up", "right");
        //console.log("Mouse up: " + button)
        // Finalize any dragging operations if necessary
    });

    /*    
    socket.on('mouse_move', ({
        clientX, clientY, clientWidth, clientHeight,
    }) => {
        const { displaySize: { width, height }, } = clientSelectedScreen
        const ratioX = width / clientWidth
        const ratioY = height / clientHeight

        const hostX = clientX * ratioX
        const hostY = clientY * ratioY

        //robot.moveMouse(hostX, hostY) 

        if (isDragging) {
            // Optional: If dragging, move the window or element
            // Implement the logic here to drag the specific window or element
           // robot.mouseToggle("down", "left");
            robot.dragMouse(hostX, hostY)
        } else robot.moveMouse(hostX, hostY);
    })
    */

    socket.on('mouse_move', ({
        clientX, clientY, clientWidth, clientHeight,
    }) => {
        try {
            if (!clientSelectedScreen || !clientSelectedScreen.displaySize) {
                throw new Error('clientSelectedScreen or its displaySize is undefined');
            }

            const { displaySize: { width, height } } = clientSelectedScreen;

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
        //console.log(scroll);
        const [deltaY, deltaX] = scroll;

        // Optional: Factor to adjust scroll speed
        robot.scrollMouse(deltaX, -deltaY);
    });


    socket.on('key_down', ({ button }) => {
        try {
            button = keySort(button);

            var Special = ["shift", "control", "alt"];
            if (Special.includes(button)) {
                robot.keyToggle(button, "down")
            } else
                robot.keyTap(button);
            /*
            if (Special.includes(button)) {
                robot.keyToggle(button, "down")
            }
            */
        } catch (error) {
            console.error('An error occurred while processing the key press:', error);
            // Optional: Log the error to a file or use a more sophisticated error-tracking system
        }
    });

    socket.on('key_up', ({ button }) => {
        try {
            // setup button
            button = keySort(button);
            robot.keyToggle(button, 'up');
        } catch (error) {
            console.error('An error occurred while processing the key press:', error);
            // Optional: Log the error to a file or use a more sophisticated error-tracking system
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
            //console.log(button, " namespace found")
            return Namespace[button];
        }
        //console.log(button, " namespace not found")
        return button
    }
});
/*
const sendSelectedScreen = (item) => {
    const displaySize = displays.filter(display => `${display.id}` === item.display_id)[0].size
    console.log(displaySize);
    mainWindow.webContents.send('SET_SOURCE_ID', {
        id: item.id,
        displaySize,
    })
}
*/

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
            // mainWindow.setSize(width, height || 500, true)
            !isNaN(height) && mainWindow.setSize(width, height, false)
        } catch (e) {
            handleError(e)
        }
    })

    mainWindow.loadURL('https://minutial-uncloying-diedre.ngrok-free.dev/')
    mainWindow.once('ready-to-show', () => {
        displays = screen.getAllDisplays()

        mainWindow.show()
        mainWindow.setPosition(0, 0)

        desktopCapturer.getSources({
            types: ['screen']
            // types: ['window', 'screen']
        }).then(sources => {
            sendSelectedScreen(sources[0])
            availableScreens = sources
            createTray()
            /*for (const source of sources) {
                console.log(sources)
                if (source.name === 'Screen 1') {
                    mainWindow.webContents.send('SET_SOURCE_ID', source.id)
                    return
                }
            }*/
        })
    })

    //mainWindow.webContents.openDevTools()
}

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