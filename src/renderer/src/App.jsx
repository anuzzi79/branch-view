import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import TerminalNode from './components/TerminalNode'
import themes from './themes'

let nodeIdCounter = 1
const getNextNodeId = () => `node-${++nodeIdCounter}`

const MIN_ZOOM = 0.05
const MAX_ZOOM = 2
const ZOOM_STEP = 1.15

function resetNodeIdCounter(nodes = []) {
  nodeIdCounter = nodes.reduce((highest, node) => {
    const match = /^node-(\d+)$/.exec(node.id)
    return match ? Math.max(highest, Number(match[1])) : highest
  }, 1)
}

const swatchColors = {
  midnight: '#0f0f1a',
  nord: '#2e3440',
  rosePine: '#191724',
  solarizedDark: '#002b36',
  light: '#f5f5f5'
}

function App() {
  const [themeName, setThemeName] = useState('midnight')
  const [terminalProfiles, setTerminalProfiles] = useState([])
  const [selectedProfileId, setSelectedProfileId] = useState('')
  const theme = themes[themeName]
  const reactFlowRef = useRef(null)
  const viewportRef = useRef({ x: 0, y: 0, zoom: 1 })
  const [currentSession, setCurrentSession] = useState(null)

  useEffect(() => {
    const root = document.documentElement
    for (const [key, value] of Object.entries(theme)) {
      if (key.startsWith('--')) {
        root.style.setProperty(key, value)
      }
    }
  }, [theme])

  useEffect(() => {
    window.electronAPI?.getTerminalProfiles?.().then((profiles = []) => {
      setTerminalProfiles(profiles)
      setSelectedProfileId((current) => current || profiles[0]?.id || '')
    })
  }, [])

  const getProfile = useCallback(
    (profileId = selectedProfileId) =>
      terminalProfiles.find((profile) => profile.id === profileId) || terminalProfiles[0],
    [selectedProfileId, terminalProfiles]
  )

  const handleBranchRef = useRef(null)
  const handleCloseRef = useRef(null)

  const onBranchStable = useCallback((sourceNodeId) => {
    handleBranchRef.current?.(sourceNodeId)
  }, [])

  const onCloseStable = useCallback((nodeId) => {
    handleCloseRef.current?.(nodeId)
  }, [])

  const createNode = useCallback(
    ({
      id,
      position,
      profileId = selectedProfileId,
      profileName,
      title = 'Terminal',
      mode = 'new',
      sourceNodeId = null,
      cwd = ''
    }) => {
      const profile = getProfile(profileId)
      const resolvedProfileId = profileId || profile?.id || ''

      return {
        id,
        type: 'terminalNode',
        position,
        data: {
          title,
          profileId: resolvedProfileId,
          profileName: profileName || profile?.name || 'Terminal',
          mode,
          sourceNodeId,
          cwd,
          onBranch: onBranchStable,
          onClose: onCloseStable
        },
        dragHandle: '.terminal-node-header'
      }
    },
    [getProfile, onBranchStable, onCloseStable, selectedProfileId]
  )

  const [nodes, setNodes, onNodesChange] = useNodesState([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])
  const initialNodeCreatedRef = useRef(false)

  const nodeTypes = useMemo(() => ({ terminalNode: TerminalNode }), [])

  useEffect(() => {
    if (initialNodeCreatedRef.current) return
    if (!terminalProfiles.length) return

    initialNodeCreatedRef.current = true
    setNodes((current) =>
      current.length
        ? current
        : [createNode({ id: 'node-1', position: { x: 0, y: 0 }, title: 'Terminal root' })]
    )
  }, [createNode, setNodes, terminalProfiles])

  const handleClose = useCallback(
    (nodeId) => {
      setNodes((nds) => nds.filter((n) => n.id !== nodeId))
      setEdges((eds) => eds.filter((e) => e.source !== nodeId && e.target !== nodeId))
    },
    [setEdges, setNodes]
  )
  handleCloseRef.current = handleClose

  const handleBranch = useCallback(
    (sourceNodeId) => {
      const newId = getNextNodeId()

      setNodes((currentNodes) => {
        const sourceNode = currentNodes.find((n) => n.id === sourceNodeId)
        const baseX = sourceNode ? sourceNode.position.x : 0
        const baseY = sourceNode ? sourceNode.position.y : 0
        const sourceProfile = sourceNode?.data?.profileId || selectedProfileId
        const sourceProfileName = sourceNode?.data?.profileName || getProfile(sourceProfile)?.name

        return [
          ...currentNodes,
          createNode({
            id: newId,
            position: {
              x: baseX + 800,
              y: baseY + Math.random() * 260 - 130
            },
            profileId: sourceProfile,
            profileName: sourceProfileName,
            title: `Branch from ${sourceNodeId}`,
            mode: 'fork',
            sourceNodeId,
            cwd: sourceNode?.data?.cwd || ''
          })
        ]
      })

      setEdges((currentEdges) => [
        ...currentEdges,
        {
          id: `edge-${sourceNodeId}-${newId}`,
          source: sourceNodeId,
          target: newId,
          animated: true,
          style: { stroke: 'var(--accent)', strokeWidth: 2 }
        }
      ])

      return newId
    },
    [createNode, getProfile, selectedProfileId, setEdges, setNodes]
  )
  handleBranchRef.current = handleBranch

  const handleAddRootNode = useCallback(() => {
    const profile = getProfile(selectedProfileId)
    const newId = getNextNodeId()

    setNodes((nds) => [
      ...nds,
      createNode({
        id: newId,
        position: {
          x: Math.random() * 800 - 400,
          y: Math.random() * 600 - 300
        },
        profileId: profile?.id || selectedProfileId,
        profileName: profile?.name,
        title: 'Terminal root',
        mode: 'new'
      })
    ])
  }, [createNode, getProfile, selectedProfileId, setNodes])

  const createSessionSnapshot = useCallback(
    () => ({
      version: 1,
      name: currentSession?.name || 'Canvas',
      themeName,
      selectedProfileId,
      viewport: viewportRef.current,
      nodes: nodes.map((node) => ({
        id: node.id,
        type: 'terminalNode',
        position: node.position,
        data: {
          title: node.data.title,
          profileId: node.data.profileId,
          profileName: node.data.profileName,
          sourceNodeId: node.data.sourceNodeId || null,
          cwd: node.data.cwd || ''
        },
        dragHandle: '.terminal-node-header'
      })),
      edges: edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        animated: edge.animated ?? true,
        style: edge.style || { stroke: 'var(--accent)', strokeWidth: 2 }
      }))
    }),
    [currentSession, edges, nodes, selectedProfileId, themeName]
  )

  const saveSession = useCallback(
    async (saveAs = false) => {
      if (!window.electronAPI?.saveSession) return

      const result = await window.electronAPI.saveSession(createSessionSnapshot(), {
        saveAs,
        filePath: saveAs ? null : currentSession?.filePath
      })

      if (!result?.canceled) {
        setCurrentSession({
          filePath: result.filePath,
          name: result.session?.name || 'Canvas'
        })
      }
    },
    [createSessionSnapshot, currentSession]
  )

  const restoreSession = useCallback(
    (session, filePath) => {
      const restoredNodes = (session.nodes?.length ? session.nodes : []).map((node) =>
        createNode({
          id: node.id,
          position: node.position || { x: 0, y: 0 },
          title: node.data?.title || 'Terminal',
          profileId: node.data?.profileId || session.selectedProfileId || selectedProfileId,
          profileName: node.data?.profileName,
          sourceNodeId: node.data?.sourceNodeId || null,
          cwd: node.data?.cwd || '',
          mode: 'new'
        })
      )

      const nextNodes = restoredNodes.length
        ? restoredNodes
        : [createNode({ id: 'node-1', position: { x: 0, y: 0 }, title: 'Terminal root' })]

      resetNodeIdCounter(nextNodes)
      setThemeName(session.themeName && themes[session.themeName] ? session.themeName : 'midnight')
      setSelectedProfileId(session.selectedProfileId || selectedProfileId)
      setNodes(nextNodes)
      setEdges(
        (session.edges || []).map((edge) => ({
          ...edge,
          animated: edge.animated ?? true,
          style: edge.style || { stroke: 'var(--accent)', strokeWidth: 2 }
        }))
      )
      setCurrentSession({ filePath, name: session.name || 'Canvas' })

      if (session.viewport) {
        viewportRef.current = session.viewport
        window.setTimeout(() => {
          reactFlowRef.current?.setViewport(session.viewport)
        }, 0)
      }
    },
    [createNode, selectedProfileId, setEdges, setNodes]
  )

  const loadSession = useCallback(async () => {
    if (!window.electronAPI?.loadSession) return

    const result = await window.electronAPI.loadSession()
    if (!result?.canceled && result.session) {
      restoreSession(result.session, result.filePath)
    }
  }, [restoreSession])

  const startNewSession = useCallback(() => {
    const freshNode = createNode({
      id: 'node-1',
      position: { x: 0, y: 0 },
      title: 'Terminal root',
      mode: 'new'
    })

    resetNodeIdCounter([freshNode])
    setNodes([freshNode])
    setEdges([])
    setThemeName('midnight')
    setCurrentSession(null)
    viewportRef.current = { x: 0, y: 0, zoom: 1 }
    reactFlowRef.current?.setViewport(viewportRef.current)
  }, [createNode, setEdges, setNodes])

  useEffect(() => {
    const handleWheel = (event) => {
      if (!event.ctrlKey) return
      const target = event.target
      if (!(target instanceof Element)) return
      const flowEl = target.closest('.react-flow')
      if (!flowEl) return
      const instance = reactFlowRef.current
      if (!instance) return

      event.preventDefault()
      event.stopPropagation()

      const rect = flowEl.getBoundingClientRect()
      const pointerX = event.clientX - rect.left
      const pointerY = event.clientY - rect.top
      const viewport = instance.getViewport()
      const flowX = (pointerX - viewport.x) / viewport.zoom
      const flowY = (pointerY - viewport.y) / viewport.zoom
      const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP
      const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, viewport.zoom * factor))
      if (newZoom === viewport.zoom) return

      const newX = pointerX - flowX * newZoom
      const newY = pointerY - flowY * newZoom
      instance.setViewport({ x: newX, y: newY, zoom: newZoom })
      viewportRef.current = { x: newX, y: newY, zoom: newZoom }
    }

    window.addEventListener('wheel', handleWheel, { capture: true, passive: false })
    return () => window.removeEventListener('wheel', handleWheel, { capture: true })
  }, [])

  useEffect(() => {
    if (!window.electronAPI?.onSessionCommand) return

    window.electronAPI.onSessionCommand((command) => {
      if (command.type === 'new') startNewSession()
      if (command.type === 'save') saveSession(false)
      if (command.type === 'saveAs') saveSession(true)
      if (command.type === 'load') loadSession()
    })

    return () => {
      window.electronAPI?.removeSessionCommandListener?.()
    }
  }, [loadSession, saveSession, startNewSession])

  return (
    <div className="app-container">
      <div className="toolbar">
        <div className="toolbar-handle" aria-hidden="true">≡</div>
        <button className="add-chat-btn" onClick={handleAddRootNode}>
          New Terminal
        </button>
        <select
          className="terminal-profile-select"
          value={selectedProfileId}
          onChange={(event) => setSelectedProfileId(event.target.value)}
          title="Terminal profile"
        >
          {terminalProfiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
            </option>
          ))}
        </select>
        <div className="theme-picker">
          {Object.entries(themes).map(([key, t]) => (
            <button
              key={key}
              className={`theme-swatch ${themeName === key ? 'active' : ''}`}
              style={{ background: swatchColors[key] }}
              onClick={() => setThemeName(key)}
              title={t.label}
            />
          ))}
        </div>
      </div>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onInit={(instance) => {
          reactFlowRef.current = instance
          viewportRef.current = instance.getViewport()
        }}
        onMoveEnd={(_event, viewport) => {
          viewportRef.current = viewport
        }}
        nodeTypes={nodeTypes}
        fitView
        minZoom={MIN_ZOOM}
        maxZoom={MAX_ZOOM}
        defaultEdgeOptions={{
          animated: true,
          style: { stroke: 'var(--accent)', strokeWidth: 2 }
        }}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant="dots" gap={20} size={1} color="var(--dots-color)" />
        <Controls position="bottom-right" />
        <MiniMap
          nodeColor="var(--accent)"
          maskColor="var(--minimap-mask)"
          style={{ backgroundColor: 'var(--minimap-bg)' }}
          position="bottom-left"
        />
      </ReactFlow>
    </div>
  )
}

export default App
