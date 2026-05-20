// =============================================================================
// main.jsx — Vite/React entry point. Three jobs:
//   1. Define an ErrorBoundary so a render-time crash inside the map shows a
//      friendly fallback instead of a blank white screen.
//   2. Wrap <App /> in <StrictMode> (extra dev-only checks; no prod impact).
//   3. Mount the tree into the #root div from index.html.
// =============================================================================

import { Component, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// -----------------------------------------------------------------------------
// ErrorBoundary — React requires a class component for componentDidCatch.
// If anything in the subtree throws during render or lifecycle, getDerived-
// StateFromError captures it into state, and render() returns the fallback UI.
// We also log to the console so the developer still sees the original stack.
// -----------------------------------------------------------------------------
class ErrorBoundary extends Component {
  state = { error: null }

  // Static lifecycle method: runs on any thrown error inside a descendant.
  // Returning a state object schedules a re-render with that state set.
  static getDerivedStateFromError(error) { return { error } }

  // Side-effect hook for logging (sending to Sentry would go here too).
  componentDidCatch(error, info) { console.error('Render error:', error, info) }

  render() {
    // Fallback UI: centered card with a reload button.
    if (this.state.error) {
      return (
        <div style={{
          position: 'fixed', inset: 0, display: 'flex',
          alignItems: 'center', justifyContent: 'center',
          padding: '2rem', background: '#1a1a1c', color: '#f3f4f6',
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        }}>
          <div style={{ maxWidth: 420, textAlign: 'center' }}>
            <h1 style={{ fontSize: '1.1rem', marginBottom: '0.5rem' }}>Something went wrong</h1>
            <p style={{ opacity: 0.7, fontSize: '0.85rem', marginBottom: '1rem' }}>
              The map failed to load. Try reloading the page.
            </p>
            <button
              // Hard reload: simpler than trying to remount React on a
              // potentially corrupt module graph.
              onClick={() => window.location.reload()}
              style={{
                background: '#374151', color: '#f3f4f6', border: 'none',
                borderRadius: '8px', padding: '0.5rem 1rem', cursor: 'pointer',
                fontSize: '0.85rem',
              }}
            >
              Reload
            </button>
          </div>
        </div>
      )
    }
    // No error: render the wrapped children as-is.
    return this.props.children
  }
}

// Bootstrap React onto the #root div from index.html.
// StrictMode is a dev-only safeguard: it double-invokes effects and rendering
// to surface side effects that aren't idempotent. Stripped in production.
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
