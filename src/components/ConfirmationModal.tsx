'use client'

import { useEffect, useRef, useState } from 'react'

interface ActionButton {
  label: string
  onClick: () => void
  variant?: 'primary' | 'secondary' | 'danger'
}

interface TypeToConfirmConfig {
  /** The exact text the user must type to enable the primary action button. */
  expectedText: string
  /** Label shown above the input. e.g., 'Type "spring" to confirm:' */
  label: string
  /** Optional placeholder shown in the empty input. */
  placeholder?: string
}

// NOTE: when typeToConfirm is set AND actions is set, ALL action buttons are
// gated (disabled until the user's input matches expectedText). The Cancel
// button rendered above the actions array is never gated. Today this works
// because the only consumer (folder-move type-to-confirm) passes a single
// "Confirm and Update URLs" action. If a future caller adds a non-gated
// secondary action, this gating model will need a per-action `gated?: boolean`
// flag.

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
  /**
   * If provided, renders a "type to confirm" input below the message.
   * The primary action button (or all action buttons if `actions` is set)
   * will be disabled until the user's input matches `expectedText` exactly.
   */
  typeToConfirm?: TypeToConfirmConfig
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
  typeToConfirm,
}: ConfirmationModalProps) {
  const confirmButtonRef = useRef<HTMLButtonElement>(null)
  const firstActionRef = useRef<HTMLButtonElement>(null)
  const typeToConfirmInputRef = useRef<HTMLInputElement>(null)
  const [typedText, setTypedText] = useState('')

  // Reset typed text whenever the modal opens or the expected text changes
  useEffect(() => {
    if (isOpen) {
      setTypedText('')
    }
  }, [isOpen, typeToConfirm?.expectedText])

  // Focus the type-to-confirm input if present, otherwise the primary button
  useEffect(() => {
    if (!isOpen) return
    if (typeToConfirm && typeToConfirmInputRef.current) {
      typeToConfirmInputRef.current.focus()
    } else if (actions && firstActionRef.current) {
      firstActionRef.current.focus()
    } else if (confirmButtonRef.current) {
      confirmButtonRef.current.focus()
    }
  }, [isOpen, actions, typeToConfirm])

  // Handle escape key
  useEffect(() => {
    if (!isOpen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onCancel])

  if (!isOpen) return null

  const confirmGateMet = !typeToConfirm || typedText === typeToConfirm.expectedText

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
              margin: '0 0 16px 0',
              fontSize: '13px',
              color: 'var(--theme-elevation-500)',
              padding: '12px',
              backgroundColor: danger
                ? 'var(--theme-error-50, #fef2f2)'
                : 'var(--theme-elevation-50)',
              borderRadius: '4px',
              lineHeight: 1.4,
              whiteSpace: 'pre-wrap',
            }}
          >
            {details}
          </p>
        )}

        {/* Type-to-confirm input */}
        {typeToConfirm && (
          <div style={{ marginBottom: '20px' }}>
            <label
              htmlFor="type-to-confirm-input"
              style={{
                display: 'block',
                marginBottom: '6px',
                fontSize: '13px',
                fontWeight: 500,
                color: 'var(--theme-elevation-700)',
              }}
            >
              {typeToConfirm.label}
            </label>
            <input
              ref={typeToConfirmInputRef}
              id="type-to-confirm-input"
              type="text"
              value={typedText}
              onChange={(e) => setTypedText(e.target.value)}
              placeholder={typeToConfirm.placeholder}
              style={{
                width: '100%',
                padding: '8px 12px',
                border: '1px solid var(--theme-elevation-150)',
                borderRadius: '4px',
                fontSize: '14px',
                backgroundColor: 'var(--theme-input-bg)',
                color: 'var(--theme-elevation-800)',
                outline: 'none',
                boxSizing: 'border-box',
                fontFamily: 'monospace',
              }}
            />
          </div>
        )}

        {/* Buttons */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: '12px',
            marginTop: details || typeToConfirm ? '0' : '24px',
            flexWrap: 'wrap',
          }}
        >
          {actions ? (
            <>
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
              {actions.map((action, index) => {
                const getButtonStyles = () => {
                  const base = {
                    padding: '8px 16px',
                    borderRadius: '4px',
                    fontSize: '14px',
                    fontWeight: 500,
                    cursor: confirmGateMet ? 'pointer' : 'not-allowed',
                    opacity: confirmGateMet ? 1 : 0.5,
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
                    disabled={!confirmGateMet}
                    style={getButtonStyles()}
                  >
                    {action.label}
                  </button>
                )
              })}
            </>
          ) : (
            <>
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
                disabled={!confirmGateMet}
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
                  cursor: confirmGateMet ? 'pointer' : 'not-allowed',
                  opacity: confirmGateMet ? 1 : 0.6,
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
