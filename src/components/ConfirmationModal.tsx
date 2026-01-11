'use client'

import { useEffect, useRef } from 'react'

interface ActionButton {
  label: string
  onClick: () => void
  variant?: 'primary' | 'secondary' | 'danger'
}

interface ConfirmationModalProps {
  isOpen: boolean
  title: string
  message: string
  details?: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  onConfirm?: () => void
  onCancel: () => void
  /** Custom action buttons - if provided, replaces confirm/cancel pattern */
  actions?: ActionButton[]
}

export function ConfirmationModal({
  isOpen,
  title,
  message,
  details,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  onConfirm,
  onCancel,
  actions,
}: ConfirmationModalProps) {
  const confirmButtonRef = useRef<HTMLButtonElement>(null)
  const firstActionRef = useRef<HTMLButtonElement>(null)

  // Focus first action button when modal opens
  useEffect(() => {
    if (isOpen) {
      if (actions && firstActionRef.current) {
        firstActionRef.current.focus()
      } else if (confirmButtonRef.current) {
        confirmButtonRef.current.focus()
      }
    }
  }, [isOpen, actions])

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

  if (!isOpen) return null

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
        aria-labelledby="modal-title"
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          backgroundColor: 'var(--theme-bg)',
          borderRadius: '8px',
          boxShadow: '0 8px 32px rgba(0, 0, 0, 0.24)',
          padding: '24px',
          minWidth: '360px',
          maxWidth: '480px',
          zIndex: 10001,
        }}
      >
        {/* Title */}
        <h2
          id="modal-title"
          style={{
            margin: '0 0 12px 0',
            fontSize: '18px',
            fontWeight: 600,
            color: 'var(--theme-elevation-800)',
          }}
        >
          {title}
        </h2>

        {/* Message */}
        <p
          style={{
            margin: '0 0 8px 0',
            fontSize: '14px',
            color: 'var(--theme-elevation-600)',
            lineHeight: 1.5,
          }}
        >
          {message}
        </p>

        {/* Details */}
        {details && (
          <p
            style={{
              margin: '0 0 24px 0',
              fontSize: '13px',
              color: 'var(--theme-elevation-500)',
              padding: '12px',
              backgroundColor: danger
                ? 'var(--theme-error-50, #fef2f2)'
                : 'var(--theme-elevation-50)',
              borderRadius: '4px',
              lineHeight: 1.4,
            }}
          >
            {details}
          </p>
        )}

        {/* Buttons */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: '12px',
            marginTop: details ? '0' : '24px',
            flexWrap: 'wrap',
          }}
        >
          {actions ? (
            <>
              {/* Cancel button for custom actions */}
              <button
                onClick={onCancel}
                style={{
                  padding: '8px 16px',
                  border: '1px solid var(--theme-elevation-150)',
                  borderRadius: '4px',
                  backgroundColor: 'transparent',
                  color: 'var(--theme-elevation-600)',
                  fontSize: '14px',
                  cursor: 'pointer',
                }}
              >
                {cancelLabel}
              </button>
              {/* Custom action buttons */}
              {actions.map((action, index) => {
                const getButtonStyles = () => {
                  const base = {
                    padding: '8px 16px',
                    borderRadius: '4px',
                    fontSize: '14px',
                    fontWeight: 500,
                    cursor: 'pointer',
                  }
                  switch (action.variant) {
                    case 'danger':
                      return {
                        ...base,
                        border: 'none',
                        backgroundColor: 'var(--theme-error-500, #ef4444)',
                        color: 'white',
                      }
                    case 'secondary':
                      return {
                        ...base,
                        border: '1px solid var(--theme-elevation-250)',
                        backgroundColor: 'var(--theme-elevation-100)',
                        color: 'var(--theme-elevation-800)',
                      }
                    case 'primary':
                    default:
                      return {
                        ...base,
                        border: 'none',
                        backgroundColor: 'var(--theme-success-500, #22c55e)',
                        color: 'white',
                      }
                  }
                }
                return (
                  <button
                    key={action.label}
                    ref={index === 0 ? firstActionRef : undefined}
                    onClick={action.onClick}
                    style={getButtonStyles()}
                  >
                    {action.label}
                  </button>
                )
              })}
            </>
          ) : (
            <>
              {/* Standard confirm/cancel pattern */}
              <button
                onClick={onCancel}
                style={{
                  padding: '8px 16px',
                  border: '1px solid var(--theme-elevation-150)',
                  borderRadius: '4px',
                  backgroundColor: 'transparent',
                  color: 'var(--theme-elevation-600)',
                  fontSize: '14px',
                  cursor: 'pointer',
                }}
              >
                {cancelLabel}
              </button>
              <button
                ref={confirmButtonRef}
                onClick={onConfirm}
                style={{
                  padding: '8px 16px',
                  border: 'none',
                  borderRadius: '4px',
                  backgroundColor: danger
                    ? 'var(--theme-error-500, #ef4444)'
                    : 'var(--theme-success-500, #22c55e)',
                  color: 'white',
                  fontSize: '14px',
                  fontWeight: 500,
                  cursor: 'pointer',
                }}
              >
                {confirmLabel}
              </button>
            </>
          )}
        </div>
      </div>
    </>
  )
}

export default ConfirmationModal
