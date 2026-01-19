'use client'

import { useState, useEffect, useRef } from 'react'
import type { TreeNode } from '../types.js'

interface EditUrlModalProps {
  isOpen: boolean
  node: TreeNode | null
  folderPath: string
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
  onSave,
  onCancel,
}: EditUrlModalProps) {
  const [segment, setSegment] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Initialize segment when modal opens
  useEffect(() => {
    if (isOpen && node) {
      const currentSegment = node.type === 'folder' ? node.pathSegment : node.slug?.split('/').pop()
      setSegment(currentSegment || '')
      setError(null)
      setSaving(false)
    }
  }, [isOpen, node])

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
          <button
            onClick={handleSave}
            disabled={saving || !slugify(segment)}
            style={{
              padding: '8px 16px',
              border: 'none',
              borderRadius: '4px',
              backgroundColor: 'var(--theme-success-500, #22c55e)',
              color: 'white',
              fontSize: '14px',
              fontWeight: 500,
              cursor: saving || !slugify(segment) ? 'not-allowed' : 'pointer',
              opacity: saving || !slugify(segment) ? 0.6 : 1,
            }}
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </>
  )
}

export default EditUrlModal
