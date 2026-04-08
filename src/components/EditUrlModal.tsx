'use client'

import { useState, useEffect, useRef } from 'react'
import type { TreeNode } from '../types.js'

type AvailabilityState = 'idle' | 'checking' | 'available' | 'taken'

interface EditUrlModalProps {
  isOpen: boolean
  node: TreeNode | null
  folderPath: string
  /** Folder ID of the parent for collision lookups. Null = root. Must be the raw (unprefixed) ID. */
  parentId: string | null
  /** API call helper from PageTreeClient. */
  apiCall: (endpoint: string, options?: RequestInit) => Promise<unknown>
  onSave: (segment: string) => Promise<void>
  onCancel: () => void
}

// Simple slugify for preview
function slugify(text: string): string {
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\w\-]+/g, '')
    .replace(/\-\-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
}

export function EditUrlModal({
  isOpen,
  node,
  folderPath,
  parentId,
  apiCall,
  onSave,
  onCancel,
}: EditUrlModalProps) {
  const [segment, setSegment] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [availability, setAvailability] = useState<AvailabilityState>('idle')
  const [originalSegment, setOriginalSegment] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  // Initialize segment when modal opens
  useEffect(() => {
    if (isOpen && node) {
      const currentSegment = node.type === 'folder' ? node.pathSegment : node.slug?.split('/').pop()
      const initial = currentSegment || ''
      setSegment(initial)
      setOriginalSegment(initial)
      setError(null)
      setSaving(false)
      setAvailability('idle')
    }
  }, [isOpen, node])

  // Debounced live availability check (300ms)
  //
  // Race-condition guard: we use a closed-over `cancelled` flag rather than
  // comparing segment values inside the callback, because the callback's
  // closure captures `segment` at effect-run time — comparing it to itself
  // is always trivially true and provides no race protection. The cleanup
  // function sets cancelled=true so any in-flight fetch from a stale effect
  // can short-circuit before calling setAvailability.
  useEffect(() => {
    if (!isOpen || !node) return

    const slugifiedSegment = slugify(segment)

    // Empty segment, or unchanged from original — no check needed
    if (!slugifiedSegment || slugifiedSegment === originalSegment) {
      setAvailability('idle')
      return
    }

    setAvailability('checking')

    let cancelled = false
    const timeoutId = setTimeout(async () => {
      try {
        const params = new URLSearchParams({
          type: node.type,
          segment: slugifiedSegment,
          excludeId: node.rawId || node.id.replace(/^(folder|page)-/, ''),
        })
        if (parentId) params.set('parentId', parentId)
        if (node.collection) params.set('collection', node.collection)

        const result = (await apiCall(`/page-tree/check-segment?${params.toString()}`)) as {
          available: boolean
        }

        if (!cancelled) {
          setAvailability(result.available ? 'available' : 'taken')
        }
      } catch (err) {
        if (!cancelled) {
          console.error('Availability check failed:', err)
          setAvailability('idle')
        }
      }
    }, 300)

    return () => {
      cancelled = true
      clearTimeout(timeoutId)
    }
  }, [isOpen, node, segment, originalSegment, parentId, apiCall])

  // Focus input when modal opens
  useEffect(() => {
    if (isOpen) {
      // Slight delay to ensure DOM is ready
      setTimeout(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      }, 50)
    }
  }, [isOpen])

  // Handle escape key
  useEffect(() => {
    if (!isOpen) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCancel()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onCancel])

  if (!isOpen || !node) return null

  const handleSave = async () => {
    const slugifiedSegment = slugify(segment)
    if (!slugifiedSegment) {
      setError('URL segment cannot be empty')
      return
    }

    setSaving(true)
    setError(null)

    try {
      await onSave(slugifiedSegment)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
      setSaving(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !saving) {
      handleSave()
    }
  }

  const handleBlur = () => {
    // Slugify on blur for consistency
    setSegment(slugify(segment))
  }

  // Build the preview URL
  const slugifiedSegment = slugify(segment)
  const previewUrl = folderPath
    ? `/${folderPath}/${slugifiedSegment}`
    : `/${slugifiedSegment}`

  const isFolder = node.type === 'folder'

  return (
    <>
      {/* Backdrop */}
      <div
        style={{
          position: 'fixed',
          inset: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.5)',
          backdropFilter: 'blur(2px)',
          zIndex: 10000,
        }}
        onClick={onCancel}
      />

      {/* Modal */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-url-title"
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          backgroundColor: 'var(--theme-bg)',
          borderRadius: '8px',
          boxShadow: '0 8px 32px rgba(0, 0, 0, 0.24)',
          padding: '24px',
          minWidth: '400px',
          maxWidth: '500px',
          zIndex: 10001,
        }}
      >
        {/* Title */}
        <h2
          id="edit-url-title"
          style={{
            margin: '0 0 16px 0',
            fontSize: '18px',
            fontWeight: 600,
            color: 'var(--theme-elevation-800)',
          }}
        >
          Edit URL {isFolder ? 'Segment' : ''}
        </h2>

        {/* Description */}
        <p
          style={{
            margin: '0 0 16px 0',
            fontSize: '14px',
            color: 'var(--theme-elevation-500)',
          }}
        >
          {isFolder
            ? 'Change the URL segment for this folder. This will update URLs for all pages inside.'
            : 'Change the URL segment for this page.'}
        </p>

        {/* Input */}
        <div style={{ marginBottom: '16px' }}>
          <label
            htmlFor="url-segment"
            style={{
              display: 'block',
              marginBottom: '8px',
              fontSize: '14px',
              fontWeight: 500,
              color: 'var(--theme-elevation-700)',
            }}
          >
            URL Segment
          </label>
          <input
            ref={inputRef}
            id="url-segment"
            type="text"
            value={segment}
            onChange={(e) => setSegment(e.target.value)}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            disabled={saving}
            placeholder="my-page-url"
            style={{
              width: '100%',
              padding: '10px 12px',
              border: error
                ? '1px solid var(--theme-error-500, #ef4444)'
                : '1px solid var(--theme-elevation-150)',
              borderRadius: '4px',
              fontSize: '14px',
              backgroundColor: 'var(--theme-input-bg)',
              color: 'var(--theme-elevation-800)',
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
          {error && (
            <p
              style={{
                margin: '8px 0 0 0',
                fontSize: '13px',
                color: 'var(--theme-error-500, #ef4444)',
              }}
            >
              {error}
            </p>
          )}
          {availability === 'checking' && (
            <p
              style={{
                margin: '6px 0 0 0',
                fontSize: '12px',
                color: 'var(--theme-elevation-500)',
              }}
            >
              Checking availability...
            </p>
          )}
          {availability === 'available' && (
            <p
              style={{
                margin: '6px 0 0 0',
                fontSize: '12px',
                color: 'var(--theme-success-500, #22c55e)',
              }}
            >
              ✓ Available
            </p>
          )}
          {availability === 'taken' && (
            <p
              style={{
                margin: '6px 0 0 0',
                fontSize: '12px',
                color: 'var(--theme-error-500, #ef4444)',
              }}
            >
              ✗ URL is already in use
            </p>
          )}
        </div>

        {/* Preview */}
        <div
          style={{
            padding: '12px',
            backgroundColor: 'var(--theme-elevation-50)',
            borderRadius: '4px',
            marginBottom: '24px',
          }}
        >
          <p
            style={{
              margin: '0 0 4px 0',
              fontSize: '12px',
              fontWeight: 500,
              color: 'var(--theme-elevation-500)',
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
            }}
          >
            {isFolder ? 'Folder Path Preview' : 'URL Preview'}
          </p>
          <code
            style={{
              fontSize: '14px',
              color: 'var(--theme-elevation-700)',
              fontFamily: 'monospace',
              wordBreak: 'break-all',
            }}
          >
            {slugifiedSegment ? previewUrl : '(empty)'}
          </code>
        </div>

        {/* Buttons */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: '12px',
          }}
        >
          <button
            onClick={onCancel}
            disabled={saving}
            style={{
              padding: '8px 16px',
              border: '1px solid var(--theme-elevation-150)',
              borderRadius: '4px',
              backgroundColor: 'transparent',
              color: 'var(--theme-elevation-600)',
              fontSize: '14px',
              cursor: saving ? 'not-allowed' : 'pointer',
              opacity: saving ? 0.6 : 1,
            }}
          >
            Cancel
          </button>
          {(() => {
            const isDisabled =
              saving ||
              !slugify(segment) ||
              availability === 'taken' ||
              availability === 'checking'
            return (
              <button
                onClick={handleSave}
                disabled={isDisabled}
                style={{
                  padding: '8px 16px',
                  border: 'none',
                  borderRadius: '4px',
                  backgroundColor: 'var(--theme-success-500, #22c55e)',
                  color: 'white',
                  fontSize: '14px',
                  fontWeight: 500,
                  cursor: isDisabled ? 'not-allowed' : 'pointer',
                  opacity: isDisabled ? 0.6 : 1,
                }}
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
            )
          })()}
        </div>
      </div>
    </>
  )
}

export default EditUrlModal
