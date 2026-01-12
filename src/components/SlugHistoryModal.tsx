'use client'

import type { SlugHistoryEntry } from '../types.js'

interface SlugHistoryModalProps {
  isOpen: boolean
  pageName: string
  currentSlug: string
  history: SlugHistoryEntry[]
  onRestore: (slug: string) => void
  onClose: () => void
}

function formatDate(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatReason(reason?: string): string {
  switch (reason) {
    case 'move':
      return 'Moved'
    case 'rename':
      return 'Renamed'
    case 'regenerate':
      return 'Regenerated'
    case 'restore':
      return 'Restored'
    case 'manual':
      return 'Manual'
    default:
      return 'Changed'
  }
}

export function SlugHistoryModal({
  isOpen,
  pageName,
  currentSlug,
  history,
  onRestore,
  onClose,
}: SlugHistoryModalProps) {
  if (!isOpen) return null

  return (
    <>
      {/* Backdrop */}
      <div
        style={{
          position: 'fixed',
          inset: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.5)',
          zIndex: 9998,
        }}
        onClick={onClose}
      />

      {/* Modal */}
      <div
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          zIndex: 9999,
          width: '100%',
          maxWidth: '500px',
          maxHeight: '80vh',
          backgroundColor: 'var(--theme-bg)',
          borderRadius: '8px',
          boxShadow: '0 8px 32px rgba(0, 0, 0, 0.2)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '16px 20px',
            borderBottom: '1px solid var(--theme-elevation-100)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 600, color: 'var(--theme-elevation-800)' }}>
            URL History for "{pageName}"
          </h2>
          <button
            onClick={onClose}
            style={{
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              padding: '4px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--theme-elevation-500)',
            }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Current URL */}
        <div
          style={{
            padding: '12px 20px',
            backgroundColor: 'var(--theme-elevation-50)',
            borderBottom: '1px solid var(--theme-elevation-100)',
          }}
        >
          <div style={{ fontSize: '12px', color: 'var(--theme-elevation-500)', marginBottom: '4px' }}>
            Current URL
          </div>
          <div
            style={{
              fontFamily: 'monospace',
              fontSize: '14px',
              color: 'var(--theme-elevation-800)',
              wordBreak: 'break-all',
            }}
          >
            /{currentSlug}
          </div>
        </div>

        {/* History list */}
        <div
          style={{
            flex: 1,
            overflow: 'auto',
            padding: '12px 20px',
          }}
        >
          <div style={{ fontSize: '12px', color: 'var(--theme-elevation-500)', marginBottom: '12px' }}>
            Previous URLs ({history.length})
          </div>

          {history.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '20px', color: 'var(--theme-elevation-400)' }}>
              No URL history available
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {history.map((entry, index) => (
                <div
                  key={`${entry.slug}-${index}`}
                  style={{
                    padding: '12px',
                    backgroundColor: 'var(--theme-elevation-0)',
                    border: '1px solid var(--theme-elevation-100)',
                    borderRadius: '6px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '12px',
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontFamily: 'monospace',
                        fontSize: '13px',
                        color: 'var(--theme-elevation-800)',
                        wordBreak: 'break-all',
                        marginBottom: '4px',
                      }}
                    >
                      /{entry.slug}
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--theme-elevation-400)' }}>
                      {formatDate(entry.changedAt)} &bull; {formatReason(entry.reason)}
                    </div>
                  </div>
                  <button
                    onClick={() => onRestore(entry.slug)}
                    style={{
                      padding: '6px 12px',
                      fontSize: '12px',
                      border: '1px solid var(--theme-elevation-150)',
                      borderRadius: '4px',
                      backgroundColor: 'transparent',
                      color: 'var(--theme-elevation-700)',
                      cursor: 'pointer',
                      flexShrink: 0,
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.backgroundColor = 'var(--theme-elevation-50)'
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.backgroundColor = 'transparent'
                    }}
                  >
                    Restore
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '12px 20px',
            borderTop: '1px solid var(--theme-elevation-100)',
            display: 'flex',
            justifyContent: 'flex-end',
          }}
        >
          <button
            onClick={onClose}
            style={{
              padding: '8px 16px',
              fontSize: '14px',
              border: '1px solid var(--theme-elevation-150)',
              borderRadius: '4px',
              backgroundColor: 'transparent',
              color: 'var(--theme-elevation-700)',
              cursor: 'pointer',
            }}
          >
            Close
          </button>
        </div>
      </div>
    </>
  )
}

export default SlugHistoryModal
