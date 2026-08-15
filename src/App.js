import './App.css';
import { useRef, useEffect, useState } from 'react'
import io from 'socket.io-client'

// Change this to your current ngrok URL whenever it changes.
const SIGNALING_URL = 'https://minutial-uncloying-diedre.ngrok-free.dev/remote-ctrl'

const socket = io(SIGNALING_URL)

// Electron injects window.electronAPI via preload.js.
// If it's present, this instance is the HOST (the machine being viewed/controlled).
// Otherwise, this is a VIEWER (any browser, including phone).
const isHost = !!window.electronAPI

function App() {
  const videoRef = useRef()
  const rtcPeerConnection = useRef(null)
  const [status, setStatus] = useState('connecting...')

  // Auth: host auto-authenticates itself; viewers must enter the PIN.
  const [authenticated, setAuthenticated] = useState(isHost)
  const authenticatedRef = useRef(isHost)
  const [pinInput, setPinInput] = useState('')
  const [authError, setAuthError] = useState('')

  const isDraggingRef = useRef(false)
  const hiddenInputRef = useRef()
  const prevInputValueRef = useRef('')
  const [showKeyboard, setShowKeyboard] = useState(false)
  // When locked (default), two-finger gestures always scroll.
  // When unlocked, two-finger gestures pinch-to-zoom instead.
  const [zoomLocked, setZoomLocked] = useState(true)

  // Pinch-zoom / pan state for the video view (viewer only)
  const [viewTransform, setViewTransform] = useState({ scale: 1, x: 0, y: 0 })
  const pinchStateRef = useRef(null) // { startDist, startScale, startX, startY, startMidX, startMidY }

  useEffect(() => {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    })
    rtcPeerConnection.current = pc

    pc.onicecandidate = (e) => {
      if (e.candidate) socket.emit('icecandidate', e.candidate)
    }

    pc.oniceconnectionstatechange = () => {
      console.log('ICE state:', pc.iceConnectionState)
      setStatus(pc.iceConnectionState)
    }

    socket.on('icecandidate', (icecandidate) => {
      pc.addIceCandidate(new RTCIceCandidate(icecandidate)).catch(console.error)
    })

    socket.on('auth-result', ({ ok }) => {
      if (ok) {
        setAuthenticated(true)
        authenticatedRef.current = true
        setAuthError('')
      } else {
        setAuthenticated(false)
        authenticatedRef.current = false
        setAuthError('Wrong PIN, try again.')
      }
    })

    if (isHost) {
      socket.emit('host-auth')
    }

    if (isHost) {
      // ---------- HOST: capture the screen and broadcast it ----------
      setStatus('host: waiting for a viewer')

      const startCapture = (sourceId) => {
        navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: sourceId,
              minWidth: 1280,
              maxWidth: 1920,
              minHeight: 720,
              maxHeight: 1080,
              maxFrameRate: 30,
            },
          },
        }).then((stream) => {
          stream.getTracks().forEach((track) => pc.addTrack(track, stream))
          console.log('host: screen capture attached')
        }).catch((e) => {
          console.error('host: getUserMedia failed', e)
          setStatus('host: capture failed - ' + e.message)
        })
      }

      window.electronAPI.getScreenId((event, source) => {
        console.log('host: got source id', source)
        socket.emit('selectedScreen', source)
        startCapture(source.id)
      })

      socket.on('viewer-ready', async () => {
        console.log('host: viewer ready, creating offer')
        try {
          const offer = await pc.createOffer()
          await pc.setLocalDescription(offer)
          socket.emit('offer', offer)
        } catch (e) {
          console.error('host: failed to create offer', e)
        }
      })

      socket.on('answer', async (answerSDP) => {
        console.log('host: received answer')
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(answerSDP))
          setStatus('host: connected')
        } catch (e) {
          console.error('host: failed to set remote description', e)
        }
      })

    } else {
      // ---------- VIEWER: wait for the host's stream and render it ----------
      setStatus('viewer: waiting for host')

      pc.ontrack = (e) => {
        console.log('viewer: track received')
        const video = videoRef.current
        video.srcObject = e.streams[0]
        video.muted = true // muted autoplay is allowed without user interaction
        video.playsInline = true // required for iOS Safari to play inline instead of fullscreen
        video.onloadedmetadata = () => {
          video.play().catch((err) => {
            console.warn('autoplay blocked, will retry on first tap', err)
          })
        }
        setStatus('viewer: connected')
      }

      socket.on('offer', async (offerSDP) => {
        console.log('viewer: received offer')
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(offerSDP))
          const answer = await pc.createAnswer()
          await pc.setLocalDescription(answer)
          socket.emit('answer', answer)
        } catch (e) {
          console.error('viewer: failed to handle offer', e)
        }
      })
    }

    return () => {
      pc.close()
    }
  }, [])

  // Once a viewer is authenticated, tell the host we're ready for an offer.
  useEffect(() => {
    if (!isHost && authenticated) {
      socket.emit('viewer-ready')
    }
  }, [authenticated])

  const submitPin = (e) => {
    e.preventDefault()
    socket.emit('auth', pinInput)
  }

  // ---------- Coordinate mapping ----------
  // Maps a point in on-screen (rendered) video pixels to host screen pixels,
  // accounting for letterboxing (video's aspect ratio vs container aspect ratio).
  const mapToHostCoords = (clientX, clientY) => {
    const video = videoRef.current
    if (!video || !video.videoWidth || !video.videoHeight) return null

    const rect = video.getBoundingClientRect()
    const videoAspect = video.videoWidth / video.videoHeight
    const boxAspect = rect.width / rect.height

    let renderedWidth, renderedHeight, offsetX, offsetY

    if (boxAspect > videoAspect) {
      // Letterboxed on left/right (box is wider than video)
      renderedHeight = rect.height
      renderedWidth = rect.height * videoAspect
      offsetX = (rect.width - renderedWidth) / 2
      offsetY = 0
    } else {
      // Letterboxed on top/bottom (box is taller than video)
      renderedWidth = rect.width
      renderedHeight = rect.width / videoAspect
      offsetX = 0
      offsetY = (rect.height - renderedHeight) / 2
    }

    const xInVideo = clientX - rect.left - offsetX
    const yInVideo = clientY - rect.top - offsetY

    if (xInVideo < 0 || yInVideo < 0 || xInVideo > renderedWidth || yInVideo > renderedHeight) {
      return null
    }

    const hostX = (xInVideo / renderedWidth) * video.videoWidth
    const hostY = (yInVideo / renderedHeight) * video.videoHeight

    return { hostX, hostY, videoWidth: video.videoWidth, videoHeight: video.videoHeight }
  }

  const sendMouseMove = (clientX, clientY) => {
    const coords = mapToHostCoords(clientX, clientY)
    if (!coords) return
    // We've already done the ratio math above against the real video size,
    // so send host coords directly with a matching "client size" so the
    // server's own ratio calculation is a no-op.
    socket.emit('mouse_move', {
      clientX: coords.hostX,
      clientY: coords.hostY,
      clientWidth: coords.videoWidth,
      clientHeight: coords.videoHeight,
    })
  }

  // ---------- Mouse events (desktop viewers) ----------
  const handleMouseDown = (e) => {
    isDraggingRef.current = true
    socket.emit('mouse_down', { button: e.button })
  }
  const handleMouseUp = (e) => {
    isDraggingRef.current = false
    socket.emit('mouse_up', { button: e.button })
  }
  const handleMouseMove = (e) => sendMouseMove(e.clientX, e.clientY)

  // ---------- Touch events (mobile viewers) ----------
  // One finger: mouse move + left-click drag.
  // Two fingers: pinch to zoom, drag to pan (does not touch the mouse).
  const dist = (t1, t2) => Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY)
  const midpoint = (t1, t2) => ({
    x: (t1.clientX + t2.clientX) / 2,
    y: (t1.clientY + t2.clientY) / 2,
  })

  const handleTouchStart = (e) => {
    e.preventDefault()
    if (e.touches.length === 2) {
      // Starting a pinch/pan gesture; release any in-progress click.
      if (isDraggingRef.current) {
        isDraggingRef.current = false
        socket.emit('mouse_up', { button: 0 })
      }
      const [t1, t2] = e.touches
      pinchStateRef.current = {
        startDist: dist(t1, t2),
        startScale: viewTransform.scale,
        lastMid: midpoint(t1, t2),
      }
      return
    }
    const touch = e.touches[0]
    if (!touch) return
    sendMouseMove(touch.clientX, touch.clientY)
    isDraggingRef.current = true
    socket.emit('mouse_down', { button: 0 })
  }

  const handleTouchMove = (e) => {
    e.preventDefault()
    if (e.touches.length === 2 && pinchStateRef.current) {
      const [t1, t2] = e.touches
      const { startDist, startScale, lastMid } = pinchStateRef.current
      const newMid = midpoint(t1, t2)

      if (zoomLocked) {
        // Two fingers always scroll while locked - no pinch fighting.
        const deltaY = lastMid.y - newMid.y // finger moves up -> scroll down (like a trackpad)
        const deltaX = lastMid.x - newMid.x
        if (Math.abs(deltaY) > 0.5 || Math.abs(deltaX) > 0.5) {
          socket.emit('scrolling', { scroll: [deltaY * 2, deltaX * 2] })
        }
        pinchStateRef.current.lastMid = newMid
        return
      }

      // Unlocked - two fingers pinch-to-zoom instead.
      const newDist = dist(t1, t2)
      const scale = Math.min(4, Math.max(1, startScale * (newDist / startDist)))
      setViewTransform({ scale, x: 0, y: 0 })
      pinchStateRef.current.lastMid = newMid
      return
    }
    const touch = e.touches[0]
    if (!touch) return
    sendMouseMove(touch.clientX, touch.clientY)
  }

  const handleTouchEnd = (e) => {
    e.preventDefault()
    if (e.touches.length >= 2) return // still mid-pinch on remaining fingers
    if (pinchStateRef.current) {
      pinchStateRef.current = null
      return
    }
    isDraggingRef.current = false
    socket.emit('mouse_up', { button: 0 })
  }

  const resetZoom = () => setViewTransform({ scale: 1, x: 0, y: 0 })

  const handleScroll = (e) => {
    e.preventDefault()
    socket.emit('scrolling', { scroll: [e.deltaY, e.deltaX] })
  }

  const handleKeyTap = (e) => {
    if (!authenticatedRef.current) return // let normal typing (e.g. the PIN box) work
    e.preventDefault()
    socket.emit('key_down', { button: e.key })
  }

  const handleKeyReset = (e) => {
    if (!authenticatedRef.current) return
    const special = ['Shift', 'Control', 'Alt']
    if (special.includes(e.key)) {
      socket.emit('key_up', { button: e.key })
    }
  }

  useEffect(() => {
    if (isHost) return
    window.addEventListener('keydown', handleKeyTap)
    window.addEventListener('keyup', handleKeyReset)
    window.addEventListener('wheel', handleScroll, { passive: false })
    return () => {
      window.removeEventListener('keydown', handleKeyTap)
      window.removeEventListener('keyup', handleKeyReset)
      window.removeEventListener('wheel', handleScroll)
    }
  }, [])

  // Tap anywhere to unstick blocked autoplay, just in case.
  const handleUserGesture = () => {
    const video = videoRef.current
    if (video && video.paused) {
      video.play().catch(() => { })
    }
  }

  // ---------- Mobile on-screen keyboard ----------
  // Mobile browsers only show a keyboard when a real input is focused.
  // We keep a hidden input focused while "keyboard mode" is on, and translate
  // its input events into the same key_down/key_up socket events desktop
  // keydown/keyup already use.
  const openKeyboard = () => {
    setShowKeyboard(true)
    setTimeout(() => hiddenInputRef.current && hiddenInputRef.current.focus(), 0)
  }

  const closeKeyboard = () => {
    setShowKeyboard(false)
    hiddenInputRef.current && hiddenInputRef.current.blur()
    if (hiddenInputRef.current) hiddenInputRef.current.value = ''
    prevInputValueRef.current = ''
  }

  const handleHiddenInput = (e) => {
    const value = e.target.value
    const prev = prevInputValueRef.current
    if (value.length > prev.length) {
      // A character (or characters, e.g. autocomplete) was added.
      const added = value.slice(prev.length)
      for (const char of added) {
        socket.emit('key_down', { button: char })
        socket.emit('key_up', { button: char })
      }
    } else if (value.length < prev.length) {
      // Characters were removed (backspace, select-and-delete, etc.)
      const removedCount = prev.length - value.length
      for (let i = 0; i < removedCount; i++) {
        socket.emit('key_down', { button: 'Backspace' })
        socket.emit('key_up', { button: 'Backspace' })
      }
    }
    prevInputValueRef.current = value
  }

  const handleHiddenKeyDown = (e) => {
    const passthrough = ['Enter', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']
    if (passthrough.includes(e.key)) {
      e.preventDefault()
      socket.emit('key_down', { button: e.key })
      socket.emit('key_up', { button: e.key })
    }
    // Backspace is handled via the input/value diff above, not here,
    // since some mobile keyboards don't fire a real keydown for it.
  }

  if (!isHost && !authenticated) {
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        backgroundColor: '#111',
        fontFamily: 'monospace',
        color: 'white',
        gap: 12,
      }}>
        <div>Enter PIN to connect</div>
        <form onSubmit={submitPin} style={{ display: 'flex', gap: 8 }}>
          <input
            type="password"
            inputMode="numeric"
            autoFocus
            value={pinInput}
            onChange={(e) => setPinInput(e.target.value)}
            style={{
              fontSize: 16,
              padding: '8px 10px',
              borderRadius: 6,
              border: '1px solid #555',
              background: '#222',
              color: 'white',
              width: 140,
            }}
          />
          <button type="submit" style={{ padding: '8px 14px', borderRadius: 6 }}>
            Connect
          </button>
        </form>
        {authError && <div style={{ color: '#f66' }}>{authError}</div>}
      </div>
    )
  }

  return (
    <div className="App" onClick={handleUserGesture}>
      <div style={{
        color: 'white',
        backgroundColor: '#222',
        fontFamily: 'monospace',
        padding: 6,
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 10,
      }}>
        {isHost ? 'HOST' : 'VIEWER'} — {status}
      </div>
      {isHost ? (
        <div style={{ color: '#888', padding: 16, fontFamily: 'monospace' }}>
          Broadcasting this screen. Open the viewer URL on another device to see it.
        </div>
      ) : (
        <>
          <div
            style={{
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              backgroundColor: 'black',
              margin: 0,
              width: '100vw',
              height: '100vh',
              overflow: 'hidden',
              touchAction: 'none',
            }}
            onMouseMove={handleMouseMove}
            onMouseDown={handleMouseDown}
            onMouseUp={handleMouseUp}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            onTouchCancel={handleTouchEnd}
          >
            <video
              ref={videoRef}
              className="video"
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'contain',
                transform: `translate(${viewTransform.x}px, ${viewTransform.y}px) scale(${viewTransform.scale})`,
                transformOrigin: 'center center',
              }}
              playsInline
              muted
            >
              video not available
            </video>
          </div>

          {/* Floating controls: zoom lock, reset zoom, keyboard toggle, bottom-right */}
          <div style={{
            position: 'fixed',
            bottom: 12,
            right: 12,
            zIndex: 20,
            display: 'flex',
            gap: 8,
          }}>
            <button
              onClick={() => setZoomLocked((locked) => !locked)}
              style={{
                padding: '10px 14px',
                fontFamily: 'monospace',
                borderRadius: 8,
                background: zoomLocked ? '#333' : '#2a6',
                color: 'white',
                border: 'none',
              }}
            >
              {zoomLocked ? '🔒 Scroll' : '🔍 Zoom'}
            </button>
            {!zoomLocked && viewTransform.scale !== 1 && (
              <button
                onClick={resetZoom}
                style={{ padding: '10px 14px', fontFamily: 'monospace', borderRadius: 8 }}
              >
                Reset zoom
              </button>
            )}
            <button
              onClick={showKeyboard ? closeKeyboard : openKeyboard}
              style={{ padding: '10px 14px', fontFamily: 'monospace', borderRadius: 8 }}
            >
              {showKeyboard ? 'Hide ⌨️' : 'Show ⌨️'}
            </button>
          </div>

          {/* Invisible-looking input that summons the mobile keyboard while focused.
              Needs to be a real, reasonably-sized, on-screen element - mobile
              browsers won't open the keyboard for 0-opacity/1px/off-screen inputs. */}
          <input
            ref={hiddenInputRef}
            onInput={handleHiddenInput}
            onKeyDown={handleHiddenKeyDown}
            onBlur={() => setShowKeyboard(false)}
            autoCapitalize="off"
            autoCorrect="off"
            style={{
              position: 'fixed',
              bottom: showKeyboard ? 60 : -100,
              left: 12,
              width: 200,
              height: 36,
              fontSize: 16, // prevents iOS Safari auto-zoom on focus
              opacity: showKeyboard ? 0.9 : 0,
              zIndex: 25,
              border: '1px solid #555',
              borderRadius: 6,
              padding: '4px 8px',
              background: '#111',
              color: 'white',
              pointerEvents: showKeyboard ? 'auto' : 'none',
            }}
            placeholder="Type here..."
          />
        </>
      )}
    </div>
  )
}

export default App