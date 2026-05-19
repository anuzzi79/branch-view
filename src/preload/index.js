import { clipboard, contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  onSessionCommand: (callback) => {
    ipcRenderer.on('session-command', (_event, command) => callback(command))
  },
  removeSessionCommandListener: () => {
    ipcRenderer.removeAllListeners('session-command')
  },
  saveSession: (snapshot, options) => ipcRenderer.invoke('session:save', snapshot, options),
  loadSession: () => ipcRenderer.invoke('session:load'),

  getTerminalProfiles: () => ipcRenderer.invoke('terminal:getProfiles'),
  createTerminal: (options) => ipcRenderer.invoke('terminal:create', options),
  writeTerminal: (nodeId, data) => ipcRenderer.send('terminal:input', { nodeId, data }),
  resizeTerminal: (nodeId, cols, rows) =>
    ipcRenderer.send('terminal:resize', { nodeId, cols, rows }),
  killTerminal: (nodeId) => ipcRenderer.send('terminal:kill', { nodeId }),
  onTerminalData: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('terminal:data', listener)
    return () => ipcRenderer.removeListener('terminal:data', listener)
  },
  onTerminalExit: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('terminal:exit', listener)
    return () => ipcRenderer.removeListener('terminal:exit', listener)
  },
  onTerminalPasteCommand: (callback) => {
    const listener = () => callback()
    ipcRenderer.on('terminal:paste-command', listener)
    return () => ipcRenderer.removeListener('terminal:paste-command', listener)
  },
  readClipboardText: () => clipboard.readText()
})
