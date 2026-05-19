import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { spawnSync } from 'child_process'
import { createRequire } from 'module'
import { basename, join } from 'path'
import { existsSync } from 'fs'
import { mkdir, readFile, readdir, stat, writeFile } from 'fs/promises'

const require = createRequire(import.meta.url)
const pty = require('node-pty')

let mainWindow
const terminals = new Map()
const ONE_MINUTE = 60 * 1000

function getSessionsDir() {
  return join(app.getPath('userData'), 'sessions')
}

async function ensureSessionsDir() {
  const sessionsDir = getSessionsDir()
  await mkdir(sessionsDir, { recursive: true })
  return sessionsDir
}

function cleanSessionName(name) {
  const cleaned = String(name || 'Session')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
    .trim()
    .slice(0, 80)

  return cleaned || 'Session'
}

function timestampForFile() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function sessionNameFromPath(filePath) {
  return basename(filePath).replace(/\.branchview\.json$/i, '').replace(/\.json$/i, '')
}

function sendSessionCommand(command) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('session-command', command)
  }
}

function sendTerminalPasteCommand() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('terminal:paste-command')
  }
}

function expandEnv(value) {
  return String(value || '').replace(/%([^%]+)%/g, (_match, name) => process.env[name] || '')
}

function stripJsonComments(raw) {
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/,\s*([}\]])/g, '$1')
}

function splitCommandLine(commandLine) {
  const args = []
  let current = ''
  let quote = null

  for (let i = 0; i < commandLine.length; i += 1) {
    const char = commandLine[i]

    if ((char === '"' || char === "'") && commandLine[i - 1] !== '\\') {
      if (quote === char) {
        quote = null
      } else if (!quote) {
        quote = char
      } else {
        current += char
      }
      continue
    }

    if (/\s/.test(char) && !quote) {
      if (current) {
        args.push(current)
        current = ''
      }
      continue
    }

    current += char
  }

  if (current) args.push(current)
  return args
}

function fallbackProfiles() {
  const profiles = []
  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const cmd = process.env.ComSpec || join(systemRoot, 'System32', 'cmd.exe')

  profiles.push({
    id: 'fallback-powershell',
    name: 'Windows PowerShell',
    commandline: powershell,
    startingDirectory: process.env.USERPROFILE || app.getPath('home')
  })

  profiles.push({
    id: 'fallback-cmd',
    name: 'Prompt dei comandi',
    commandline: cmd,
    startingDirectory: process.env.USERPROFILE || app.getPath('home')
  })

  return profiles
}

async function readWindowsTerminalProfiles() {
  const localAppData = process.env.LOCALAPPDATA || ''
  const candidateFiles = [
    join(
      localAppData,
      'Packages',
      'Microsoft.WindowsTerminal_8wekyb3d8bbwe',
      'LocalState',
      'settings.json'
    ),
    join(
      localAppData,
      'Packages',
      'Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe',
      'LocalState',
      'settings.json'
    ),
    join(localAppData, 'Microsoft', 'Windows Terminal', 'settings.json')
  ]

  for (const settingsPath of candidateFiles) {
    if (!existsSync(settingsPath)) continue

    try {
      const raw = await readFile(settingsPath, 'utf8')
      const settings = JSON.parse(stripJsonComments(raw))
      const defaults = settings?.profiles?.defaults || {}
      const list = settings?.profiles?.list || []
      const profiles = list
        .filter((profile) => profile && !profile.hidden)
        .map((profile, index) => {
          const merged = { ...defaults, ...profile }
          return {
            id: merged.guid || `windows-terminal-${index}`,
            name: merged.name || `Terminal ${index + 1}`,
            commandline: merged.commandline || '',
            startingDirectory: merged.startingDirectory || defaults.startingDirectory || '',
            icon: merged.icon || '',
            source: merged.source || ''
          }
        })

      if (profiles.length) return profiles
    } catch (error) {
      console.warn('Could not read Windows Terminal profiles:', error)
    }
  }

  return fallbackProfiles()
}

const wslHomeCache = new Map()

function getWslHome(distroName) {
  if (!distroName) return null
  if (wslHomeCache.has(distroName)) return wslHomeCache.get(distroName)

  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  const wslExe = join(systemRoot, 'System32', 'wsl.exe')
  try {
    const result = spawnSync(
      wslExe,
      ['-d', distroName, '--', 'sh', '-c', 'printf %s "$HOME"'],
      { timeout: 5000, encoding: 'utf8', windowsHide: true }
    )
    const home = result.stdout?.trim()
    if (home && home.startsWith('/')) {
      wslHomeCache.set(distroName, home)
      return home
    }
  } catch {
    // Ignore lookup failures; caller will fall back.
  }
  wslHomeCache.set(distroName, null)
  return null
}

function isWslProfile(profile) {
  const source = String(profile?.source || '').toLowerCase()
  if (!source) return false
  return (
    source.includes('wsl') ||
    source.includes('canonicalgrouplimited') ||
    source.includes('debian') ||
    source.includes('suse') ||
    source.includes('kali') ||
    source.includes('fedora') ||
    source.includes('archlinux') ||
    source.includes('oracle') ||
    source.includes('whitewaterfoundry')
  )
}

function resolveProfileCommand(profile) {
  const commandline = expandEnv(profile?.commandline || '').trim()
  const parts = commandline ? splitCommandLine(commandline) : []
  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  const defaultShell = process.env.ComSpec || join(systemRoot, 'System32', 'cmd.exe')

  if (parts.length) {
    return { file: parts[0], args: parts.slice(1) }
  }

  if (isWslProfile(profile) && profile?.name) {
    const startingDirectory = expandEnv(profile?.startingDirectory || '').trim()
    const cdTarget = startingDirectory || getWslHome(profile.name) || '~'
    return {
      file: join(systemRoot, 'System32', 'wsl.exe'),
      args: ['-d', profile.name, '--cd', cdTarget]
    }
  }

  return { file: defaultShell, args: [] }
}

function resolveCwd(profile, requestedCwd) {
  const requested = expandEnv(requestedCwd || '').trim()
  const startingDirectory = expandEnv(profile?.startingDirectory || '').trim()
  const cwd = requested || startingDirectory || process.env.USERPROFILE || app.getPath('home')
  return existsSync(cwd) ? cwd : app.getPath('home')
}

function normalizePathForCompare(filePath) {
  return String(filePath || '')
    .replace(/\//g, '\\')
    .replace(/\\+$/g, '')
    .toLowerCase()
}

function getCodexSessionsRoot() {
  return join(app.getPath('home'), '.codex', 'sessions')
}

async function collectJsonlFiles(dir, files = []) {
  let entries = []

  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return files
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      await collectJsonlFiles(fullPath, files)
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.jsonl')) {
      const info = await stat(fullPath)
      files.push({ fullPath, mtimeMs: info.mtimeMs })
    }
  }

  return files
}

async function readSessionMeta(filePath) {
  const raw = await readFile(filePath, 'utf8')
  const firstLine = raw.split(/\r?\n/, 1)[0]
  const parsed = JSON.parse(firstLine)

  if (parsed?.type !== 'session_meta') return null
  return parsed.payload || null
}

function encodeClaudeCwd(cwd) {
  return String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-')
}

function getClaudeProjectDir(cwd) {
  return join(app.getPath('home'), '.claude', 'projects', encodeClaudeCwd(cwd))
}

async function findLatestClaudeSession({ cwd, startedAt }) {
  if (!cwd) return null

  const projectDir = getClaudeProjectDir(cwd)
  let entries = []
  try {
    entries = await readdir(projectDir, { withFileTypes: true })
  } catch {
    return null
  }

  const cutoff = startedAt ? startedAt - ONE_MINUTE : 0
  const candidates = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.jsonl')) continue
    const fullPath = join(projectDir, entry.name)
    try {
      const info = await stat(fullPath)
      if (info.mtimeMs < cutoff) continue
      candidates.push({
        id: entry.name.replace(/\.jsonl$/i, ''),
        filePath: fullPath,
        mtimeMs: info.mtimeMs
      })
    } catch {
      // Ignore unreadable files
    }
  }

  if (!candidates.length) return null
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return candidates[0]
}

async function findLatestCodexSession({ cwd, startedAt }) {
  const files = await collectJsonlFiles(getCodexSessionsRoot())
  const normalizedCwd = normalizePathForCompare(cwd)
  const cutoff = startedAt ? startedAt - ONE_MINUTE : 0
  const candidates = files
    .filter((file) => file.mtimeMs >= cutoff)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, 200)

  const metas = []
  for (const file of candidates) {
    try {
      const meta = await readSessionMeta(file.fullPath)
      if (meta?.id) {
        metas.push({ ...meta, filePath: file.fullPath, mtimeMs: file.mtimeMs })
      }
    } catch {
      // Ignore partially written or legacy session files.
    }
  }

  const cwdMatch = metas.find((meta) => normalizePathForCompare(meta.cwd) === normalizedCwd)
  return cwdMatch || metas[0] || null
}

function sendTerminalData(nodeId, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('terminal:data', { nodeId, data })
  }
}

function sendTerminalExit(nodeId, exitCode) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('terminal:exit', { nodeId, exitCode })
  }
}

async function spawnTerminal({
  nodeId,
  profileId,
  cwd,
  cols = 100,
  rows = 32,
  mode = 'new',
  sourceNodeId
}) {
  const profiles = await readWindowsTerminalProfiles()
  const profile = profiles.find((item) => item.id === profileId) || profiles[0] || fallbackProfiles()[0]

  const existing = terminals.get(nodeId)
  if (existing) {
    existing.process.kill()
    terminals.delete(nodeId)
  }

  const { file, args } = resolveProfileCommand(profile)
  const resolvedCwd = resolveCwd(profile, cwd)
  const startedAt = Date.now()
  const terminal = pty.spawn(file, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: resolvedCwd,
    env: {
      ...process.env,
      TERM_PROGRAM: 'branch_view'
    },
    useConpty: true,
    useConptyDll: true
  })

  terminals.set(nodeId, {
    process: terminal,
    cwd: resolvedCwd,
    profile,
    startedAt
  })
  terminal.onData((data) => {
    const current = terminals.get(nodeId)
    if (current && current.process !== terminal) return
    sendTerminalData(nodeId, data)
  })
  terminal.onExit(({ exitCode }) => {
    const current = terminals.get(nodeId)
    if (current && current.process !== terminal) return
    if (current) terminals.delete(nodeId)
    sendTerminalExit(nodeId, exitCode)
  })

  if (mode === 'fork' && sourceNodeId) {
    setTimeout(async () => {
      const active = terminals.get(nodeId)
      const source = terminals.get(sourceNodeId)
      if (!active || active.process !== terminal || !source) return

      const [codexSession, claudeSession] = await Promise.all([
        findLatestCodexSession({ cwd: source.cwd, startedAt: source.startedAt }),
        findLatestClaudeSession({ cwd: source.cwd, startedAt: source.startedAt })
      ])

      const candidates = []
      if (codexSession?.id) {
        candidates.push({ kind: 'codex', session: codexSession, mtimeMs: codexSession.mtimeMs })
      }
      if (claudeSession?.id) {
        candidates.push({ kind: 'claude', session: claudeSession, mtimeMs: claudeSession.mtimeMs })
      }

      if (!candidates.length) {
        terminal.write(
          'Branch View: nessuna sessione Codex o Claude Code rilevata per questo cwd. Lancia `codex` o `claude` nel terminale padre prima di forkare.\r\n'
        )
        return
      }

      candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
      const pick = candidates[0]
      const command =
        pick.kind === 'codex'
          ? `codex fork ${pick.session.id}`
          : `claude --resume ${pick.session.id} --fork-session`

      terminal.write(`${command}\r`)
    }, 700)
  }

  return {
    nodeId,
    profile,
    pid: terminal.pid
  }
}

function killAllTerminals() {
  for (const terminal of terminals.values()) {
    terminal.process.kill()
  }
  terminals.clear()
}

function createAppMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'New Canvas',
          accelerator: 'CmdOrCtrl+N',
          click: () => sendSessionCommand({ type: 'new' })
        },
        {
          label: 'Save Canvas',
          accelerator: 'CmdOrCtrl+S',
          click: () => sendSessionCommand({ type: 'save' })
        },
        {
          label: 'Save Canvas As...',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => sendSessionCommand({ type: 'saveAs' })
        },
        {
          label: 'Load Canvas...',
          accelerator: 'CmdOrCtrl+O',
          click: () => sendSessionCommand({ type: 'load' })
        },
        { type: 'separator' },
        {
          label: 'Show Canvases Folder',
          click: async () => {
            const sessionsDir = await ensureSessionsDir()
            await shell.openPath(sessionsDir)
          }
        },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        {
          label: 'Paste',
          accelerator: 'CmdOrCtrl+V',
          click: sendTerminalPasteCommand
        },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function registerSessionHandlers() {
  ipcMain.handle('session:save', async (_event, snapshot, options = {}) => {
    const sessionsDir = await ensureSessionsDir()
    const defaultName = `${cleanSessionName(snapshot?.name)}-${timestampForFile()}.branchview.json`
    let filePath = options.filePath
    const shouldPickFile = options.saveAs || !filePath

    if (shouldPickFile) {
      const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Save Canvas',
        defaultPath: join(sessionsDir, defaultName),
        filters: [{ name: 'Branch View Canvas', extensions: ['json'] }]
      })

      if (result.canceled || !result.filePath) {
        return { canceled: true }
      }

      filePath = result.filePath
    }

    const savedAt = new Date().toISOString()
    const session = {
      ...snapshot,
      version: 1,
      name: shouldPickFile ? sessionNameFromPath(filePath) : snapshot?.name || sessionNameFromPath(filePath),
      savedAt
    }

    await writeFile(filePath, JSON.stringify(session, null, 2), 'utf8')
    return { canceled: false, filePath, session }
  })

  ipcMain.handle('session:load', async () => {
    const sessionsDir = await ensureSessionsDir()
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Load Canvas',
      defaultPath: sessionsDir,
      properties: ['openFile'],
      filters: [{ name: 'Branch View Canvas', extensions: ['json'] }]
    })

    if (result.canceled || !result.filePaths?.[0]) {
      return { canceled: true }
    }

    const filePath = result.filePaths[0]
    const raw = await readFile(filePath, 'utf8')
    const session = JSON.parse(raw)

    return { canceled: false, filePath, session }
  })

  ipcMain.handle('terminal:getProfiles', readWindowsTerminalProfiles)
  ipcMain.handle('terminal:create', (_event, options) => spawnTerminal(options))
  ipcMain.on('terminal:input', (_event, { nodeId, data }) => {
    terminals.get(nodeId)?.process.write(data)
  })
  ipcMain.on('terminal:resize', (_event, { nodeId, cols, rows }) => {
    terminals.get(nodeId)?.process.resize(cols, rows)
  })
  ipcMain.on('terminal:kill', (_event, { nodeId }) => {
    terminals.get(nodeId)?.process.kill()
    terminals.delete(nodeId)
  })
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'Branch View',
    backgroundColor: '#0b0d12',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.webContents.on('before-input-event', (event, input) => {
    const isPaste =
      input.type === 'keyDown' &&
      input.key?.toLowerCase() === 'v' &&
      (input.control || input.meta)

    if (isPaste) {
      event.preventDefault()
      sendTerminalPasteCommand()
    }
  })
}

app.whenReady().then(() => {
  registerSessionHandlers()
  createAppMenu()
  createWindow()
})

app.on('before-quit', killAllTerminals)

app.on('window-all-closed', () => {
  killAllTerminals()
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
