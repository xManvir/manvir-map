import { Component, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

class ErrorBoundary extends Component {
  state = { error: null }
  static getDerivedStateFromError(error) { return { error } }
  componentDidCatch(error, info) { console.error('Render error:', error, info) }
  render() {
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
    return this.props.children
  }
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
