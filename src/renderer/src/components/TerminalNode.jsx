import { useEffect, useRef, useState } from 'react'
import { Handle, Position } from '@xyflow/react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import './TerminalNode.css'

const TERMINAL_CONTROL_RESPONSES = new Set(['\x1b[?1;2c'])
let activeTerminalNodeId = null

function isPasteShortcut(event) {
  if (event.type !== 'keydown') return false
  if (event.key?.toLowerCase() !== 'v') return false
  return event.ctrlKey || event.metaKey
}

function readClipboardText() {
  try {
    const sync = window.electronAPI?.readClipboardText?.()
    if (typeof sync === 'string') return Promise.resolve(sync)
  } catch {
    // fall through to async path
  }
  if (navigator.clipboard?.readText) {
    return navigator.clipboard.readText().catch(() => '')
  }
  return Promise.resolve('')
}

function pasteFromClipboard(writeInput) {
  readClipboardText().then((text) => {
    if (text) writeInput(text.replace(/\r?\n/g, '\r'))
  })
}

function keyEventToTerminalInput(event) {
  if (event.type !== 'keydown' || event.metaKey) return null

  if (event.ctrlKey && event.key.toLowerCase() === 'v') return null

  if (event.ctrlKey && event.key.length === 1) {
    const key = event.key.toLowerCase()
    if (key >= 'a' && key <= 'z') {
      return String.fromCharCode(key.charCodeAt(0) - 96)
    }
  }

  if (event.altKey || event.ctrlKey) return null
  if (event.key.length === 1) return event.key

  const specialKeys = {
    Enter: '\r',
    Backspace: '\x7f',
    Tab: '\t',
    Escape: '\x1b',
    ArrowUp: '\x1b[A',
    ArrowDown: '\x1b[B',
    ArrowRight: '\x1b[C',
    ArrowLeft: '\x1b[D',
    Delete: '\x1b[3~',
    Home: '\x1b[H',
    End: '\x1b[F',
    PageUp: '\x1b[5~',
    PageDown: '\x1b[6~'
  }

  return specialKeys[event.key] || null
}

function TerminalNode({ id, data }) {
  const hostRef = useRef(null)
  const bodyRef = useRef(null)
  const terminalRef = useRef(null)
  const fitAddonRef = useRef(null)
  const resizeObserverRef = useRef(null)
  const writeInputRef = useRef(() => {})
  const [status, setStatus] = useState('starting')

  const activateTerminal = () => {
    activeTerminalNodeId = id
    window.requestAnimationFrame(() => {
      bodyRef.current?.focus({ preventScroll: true })
      terminalRef.current?.focus()
    })
  }

  const handleKeyDown = (event) => {
    event.stopPropagation()
    activeTerminalNodeId = id

    if (isPasteShortcut(event.nativeEvent)) {
      event.preventDefault()
      pasteFromClipboard(writeInputRef.current)
      return
    }

    const value = keyEventToTerminalInput(event.nativeEvent)
    if (!value) return

    event.preventDefault()
    writeInputRef.current(value)
  }

  const handlePaste = (event) => {
    event.preventDefault()
    event.stopPropagation()
    activeTerminalNodeId = id

    const text = event.clipboardData?.getData('text')
    if (text) {
      writeInputRef.current(text.replace(/\r?\n/g, '\r'))
    }
  }

  useEffect(() => {
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: 'Cascadia Mono, Consolas, "Courier New", monospace',
      fontSize: 13,
      lineHeight: 1.15,
      theme: {
        background: '#080a0f',
        foreground: '#e7edf7',
        cursor: '#f5c542',
        selectionBackground: '#334155',
        black: '#0b0d12',
        red: '#ef4444',
        green: '#22c55e',
        yellow: '#eab308',
        blue: '#38bdf8',
        magenta: '#c084fc',
        cyan: '#2dd4bf',
        white: '#e5e7eb',
        brightBlack: '#64748b',
        brightRed: '#f87171',
        brightGreen: '#4ade80',
        brightYellow: '#facc15',
        brightBlue: '#7dd3fc',
        brightMagenta: '#d8b4fe',
        brightCyan: '#5eead4',
        brightWhite: '#ffffff'
      }
    })
    const fitAddon = new FitAddon()

    terminal.loadAddon(fitAddon)
    terminal.open(hostRef.current)
    terminal.focus()
    fitAddon.fit()

    terminalRef.current = terminal
    fitAddonRef.current = fitAddon

    const dimensions = fitAddon.proposeDimensions()
    window.electronAPI
      ?.createTerminal({
        nodeId: id,
        profileId: data.profileId,
        mode: data.mode || 'new',
        sourceNodeId: data.sourceNodeId,
        cwd: data.cwd,
        cols: dimensions?.cols || 100,
        rows: dimensions?.rows || 32
      })
      .then(() => setStatus('running'))
      .catch((error) => {
        setStatus('error')
        terminal.writeln(`\r\nBranch View could not start this terminal: ${error.message}`)
      })

    const writeInput = (value) => {
      if (TERMINAL_CONTROL_RESPONSES.has(value)) return
      window.electronAPI?.writeTerminal(id, value)
    }

    writeInputRef.current = writeInput

    const onBodyKeyDown = (event) => {
      activeTerminalNodeId = id

      if (isPasteShortcut(event)) {
        event.preventDefault()
        event.stopPropagation()
        event.stopImmediatePropagation?.()
        const text = window.electronAPI?.readClipboardText?.() || ''
        if (text) writeInput(text.replace(/\r?\n/g, '\r'))
        return
      }

      const value = keyEventToTerminalInput(event)
      if (!value) return

      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation?.()
      writeInput(value)
    }

    const onBodyPaste = (event) => {
      activeTerminalNodeId = id
      const text = event.clipboardData?.getData('text')
      if (!text) return

      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation?.()
      writeInput(text.replace(/\r?\n/g, '\r'))
    }

    const body = bodyRef.current
    body?.addEventListener('keydown', onBodyKeyDown, true)
    body?.addEventListener('paste', onBodyPaste, true)

    const removeDataListener = window.electronAPI?.onTerminalData(({ nodeId, data: chunk }) => {
      if (nodeId === id) terminal.write(chunk)
    })

    const removeExitListener = window.electronAPI?.onTerminalExit(({ nodeId, exitCode }) => {
      if (nodeId === id) {
        setStatus('exited')
        terminal.writeln(`\r\n[process exited with code ${exitCode}]`)
      }
    })

    const removePasteCommandListener = window.electronAPI?.onTerminalPasteCommand(() => {
      if (activeTerminalNodeId !== id) return
      pasteFromClipboard(writeInput)
    })

    resizeObserverRef.current = new ResizeObserver(() => {
      fitAddon.fit()
      const next = fitAddon.proposeDimensions()
      if (next) {
        window.electronAPI?.resizeTerminal(id, next.cols, next.rows)
      }
    })
    resizeObserverRef.current.observe(hostRef.current)

    return () => {
      removeDataListener?.()
      removeExitListener?.()
      removePasteCommandListener?.()
      body?.removeEventListener('keydown', onBodyKeyDown, true)
      body?.removeEventListener('paste', onBodyPaste, true)
      writeInputRef.current = () => {}
      if (activeTerminalNodeId === id) activeTerminalNodeId = null
      resizeObserverRef.current?.disconnect()
      window.electronAPI?.killTerminal(id)
      terminal.dispose()
    }
  }, [data.cwd, data.mode, data.profileId, id])

  return (
    <div className="terminal-node">
      <Handle type="target" position={Position.Left} className="terminal-handle" />

      <div className="terminal-node-header">
        <div className="terminal-lights" aria-hidden="true">
          <span className="terminal-light red" />
          <span className="terminal-light yellow" />
          <span className="terminal-light green" />
        </div>
        <span className="terminal-node-title" title={data.title}>
          {data.title}
        </span>
        <span className={`terminal-node-status ${status}`}>{status}</span>
        <button
          className="terminal-action"
          onClick={() => data.onBranch?.(id)}
          title="Open linked terminal"
        >
          branch
        </button>
        <button
          className="terminal-close"
          onClick={() => data.onClose?.(id)}
          title="Close terminal"
        >
          x
        </button>
      </div>

      <div className="terminal-node-meta">
        <span>{data.profileName || 'Terminal'}</span>
        <span>{data.cwd || 'ready'}</span>
      </div>

      <div
        className="terminal-node-body nodrag nopan nowheel"
        ref={bodyRef}
        data-terminal-node-id={id}
        tabIndex={0}
        onClick={(event) => {
          event.stopPropagation()
          activateTerminal()
        }}
        onMouseDown={(event) => {
          event.stopPropagation()
          activateTerminal()
        }}
        onPointerDown={(event) => {
          event.stopPropagation()
          activateTerminal()
        }}
        onFocus={() => {
          activeTerminalNodeId = id
        }}
        onKeyDown={(event) => {
          handleKeyDown(event)
        }}
        onKeyUp={(event) => {
          event.stopPropagation()
        }}
        onPaste={handlePaste}
      >
        <div ref={hostRef} className="terminal-host nodrag nopan nowheel" />
      </div>

      <Handle type="source" position={Position.Right} className="terminal-handle" />
    </div>
  )
}

export default TerminalNode
