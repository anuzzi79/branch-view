import { useEffect, useRef, useState } from 'react'
import { Handle, Position } from '@xyflow/react'
import './ChatNode.css'
import { trackEvent } from '../analytics'

function ChatNode({ id, data }) {
  const webviewRef = useRef(null)
  const [title, setTitle] = useState(data.label || 'Chat')
  const [isLoading, setIsLoading] = useState(true)
  const [currentUrl, setCurrentUrl] = useState(data.url)
  const titleRef = useRef(title)
  const currentUrlRef = useRef(currentUrl)
  const dataRef = useRef(data)

  useEffect(() => {
    dataRef.current = data
  }, [data])

  useEffect(() => {
    dataRef.current = data
    const nextTitle = data.title || data.label || 'Chat'
    const nextUrl = data.currentUrl || data.url

    setTitle(nextTitle)
    setCurrentUrl(nextUrl)
    titleRef.current = nextTitle
    currentUrlRef.current = nextUrl
  }, [data.currentUrl, data.label, data.title, data.url])

  useEffect(() => {
    const webview = webviewRef.current
    if (!webview) return

    // Ensure allowpopups is set imperatively (React may not set it correctly)
    webview.setAttribute('allowpopups', '')

    const getWebviewUrl = (fallbackUrl = currentUrlRef.current) => {
      try {
        return webview.getURL?.() || fallbackUrl
      } catch {
        return fallbackUrl
      }
    }

    const publishSnapshot = (next = {}) => {
      const nextTitle = next.title || titleRef.current
      const nextUrl = next.currentUrl || getWebviewUrl()

      if (nextTitle) {
        setTitle(nextTitle)
        titleRef.current = nextTitle
      }

      if (nextUrl) {
        setCurrentUrl(nextUrl)
        currentUrlRef.current = nextUrl
      }

      dataRef.current.onNodeSnapshotChange?.(id, {
        title: titleRef.current,
        currentUrl: currentUrlRef.current
      })
    }

    const onDomReady = () => {
      setIsLoading(false)
      // Register this webview so the app knows which node it belongs to
      if (dataRef.current.registerWebview) {
        try {
          const wcId = webview.getWebContentsId()
          dataRef.current.registerWebview(id, wcId)
        } catch (e) {
          console.warn('Could not get webContentsId:', e)
        }
      }
      publishSnapshot()
    }

    const onPageTitleUpdated = (event) => {
      if (event.title && event.title !== 'about:blank') {
        publishSnapshot({ title: event.title })
      }
    }

    const onDidNavigate = (event = {}) => {
      const nextUrl = event.url || getWebviewUrl()
      if (nextUrl) {
        publishSnapshot({ currentUrl: nextUrl })
        trackEvent('webview_navigated', {
          node_id: id,
          destination_url: nextUrl
        })
      }
    }

    const onDidStopLoading = () => {
      publishSnapshot()
    }

    // Direct interception of new-window requests from the webview.
    // This fires in the renderer (no IPC needed) when the guest page
    // tries to open a new tab/window (e.g. ChatGPT "Branch in new chat").
    const onNewWindow = (event) => {
      const url = event.url
      if (url && dataRef.current.onBranch) {
        trackEvent('branch_requested', {
          node_id: id,
          target_url: url
        })
        dataRef.current.onBranch(url, id)
      }
    }

    webview.addEventListener('dom-ready', onDomReady)
    webview.addEventListener('page-title-updated', onPageTitleUpdated)
    webview.addEventListener('did-navigate', onDidNavigate)
    webview.addEventListener('did-navigate-in-page', onDidNavigate)
    webview.addEventListener('did-stop-loading', onDidStopLoading)
    webview.addEventListener('new-window', onNewWindow)

    return () => {
      webview.removeEventListener('dom-ready', onDomReady)
      webview.removeEventListener('page-title-updated', onPageTitleUpdated)
      webview.removeEventListener('did-navigate', onDidNavigate)
      webview.removeEventListener('did-navigate-in-page', onDidNavigate)
      webview.removeEventListener('did-stop-loading', onDidStopLoading)
      webview.removeEventListener('new-window', onNewWindow)

      if (dataRef.current.unregisterWebview) {
        dataRef.current.unregisterWebview(id)
      }
    }
  }, [id])

  const handleBack = () => {
    if (webviewRef.current?.canGoBack()) webviewRef.current.goBack()
  }

  const handleForward = () => {
    if (webviewRef.current?.canGoForward()) webviewRef.current.goForward()
  }

  const handleReload = () => {
    webviewRef.current?.reload()
  }

  return (
    <div className="chat-node">
      <Handle type="target" position={Position.Left} className="chat-handle" />

      {/* Header - this is the drag handle */}
      <div className="chat-node-header">
        <div className="chat-node-nav">
          <button className="nav-btn" onClick={handleBack} title="Back">
            &#8592;
          </button>
          <button className="nav-btn" onClick={handleForward} title="Forward">
            &#8594;
          </button>
          <button className="nav-btn" onClick={handleReload} title="Reload">
            &#8635;
          </button>
        </div>
        <span className="chat-node-title" title={title}>
          {title}
        </span>
        {isLoading && <span className="chat-node-loading">Loading...</span>}
        <button
          className="close-btn"
          onClick={() => data.onClose?.(id)}
          title="Close node"
        >
          &#215;
        </button>
      </div>

      {/* URL bar */}
      <div className="chat-node-urlbar">
        <span className="chat-node-url">{currentUrl}</span>
      </div>

      {/* Webview body */}
      <div className="chat-node-body">
        <webview
          ref={webviewRef}
          src={data.url}
          partition="persist:chatgpt"
          className="chat-webview"
          allowpopups="true"
        />
        {isLoading && (
          <div className="chat-node-loading-overlay">
            <div className="loading-spinner" />
          </div>
        )}
      </div>

      <Handle type="source" position={Position.Right} className="chat-handle" />
    </div>
  )
}

export default ChatNode
