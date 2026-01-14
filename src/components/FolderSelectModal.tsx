'use client'

import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import type { TreeNode } from '../types.js'

interface FolderSelectModalProps {
  isOpen: boolean
  title: string
  treeData: TreeNode[]
  currentFolderIds: (string | null)[]
  excludeIds: string[]
  onSelect: (folderId: string | null) => void
  onCancel: () => void
}

interface FolderItem {
  id: string | null
  rawId: string | null
  name: string
  depth: number
  disabled: boolean
  hasChildren: boolean
  children: FolderItem[]
}

export function FolderSelectModal({
  isOpen,
  title,
  treeData,
  currentFolderIds,
  excludeIds,
  onSelect,
  onCancel,
}: FolderSelectModalProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const moveButtonRef = useRef<HTMLButtonElement>(null)

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setSelectedId(null)
      setExpandedIds(new Set())
    }
  }, [isOpen])

  // Focus move button when modal opens
  useEffect(() => {
    if (isOpen && moveButtonRef.current) {
      moveButtonRef.current.focus()
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

  // Build folder tree structure
  const folderTree = useMemo((): FolderItem[] => {
    const buildTree = (nodes: TreeNode[], depth: number): FolderItem[] => {
      const result: FolderItem[] = []

      for (const node of nodes) {
        if (node.type === 'folder') {
          const isExcluded = excludeIds.includes(node.id)
          const isCurrent = currentFolderIds.includes(node.id)
          const childFolders = buildTree(node.children, depth + 1)

          result.push({
            id: node.id,
            rawId: node.rawId || node.id.replace(/^folder-/, ''),
            name: node.name,
            depth,
            disabled: isExcluded,
            hasChildren: childFolders.length > 0,
            children: childFolders,
          })
        }
      }

      return result
    }

    return buildTree(treeData, 1)
  }, [treeData, excludeIds, currentFolderIds])

  const toggleExpand = useCallback((id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }, [])

  const handleSelect = useCallback((id: string | null) => {
    setSelectedId(id)
  }, [])

  // Check if current selection is valid (not the same folder for all items)
  const isValidSelection = useMemo(() => {
    if (selectedId === null) {
      // Moving to root - valid if not all items are already at root
      return !currentFolderIds.every(id => id === null)
    }
    // Valid if selected folder is different from current folder for at least one item
    return !currentFolderIds.every(id => id === selectedId)
  }, [selectedId, currentFolderIds])

  // Render folder item recursively
  const renderFolderItem = (folder: FolderItem): React.ReactNode => {
    const isExpanded = expandedIds.has(folder.id!)
    const isSelected = selectedId === folder.id

    return (
      <div key={folder.id ?? 'root'}>
        <button
          disabled={folder.disabled}
          onClick={() => handleSelect(folder.id)}
          style={{
            display: 'flex',
            alignItems: 'center',
            width: '100%',
            padding: '8px 12px',
            paddingLeft: `${12 + folder.depth * 20}px`,
            border: 'none',
            backgroundColor: isSelected ? 'var(--theme-elevation-100)' : 'transparent',
            cursor: folder.disabled ? 'not-allowed' : 'pointer',
            opacity: folder.disabled ? 0.5 : 1,
            textAlign: 'left',
            fontSize: '14px',
            color: 'var(--theme-elevation-800)',
            gap: '8px',
          }}
          onMouseEnter={(e) => {
            if (!folder.disabled && !isSelected) {
              e.currentTarget.style.backgroundColor = 'var(--theme-elevation-50)'
            }
          }}
          onMouseLeave={(e) => {
            if (!isSelected) {
              e.currentTarget.style.backgroundColor = 'transparent'
            }
          }}
        >
          {/* Expand/collapse toggle */}
          {folder.hasChildren ? (
            <span
              onClick={(e) => {
                e.stopPropagation()
                toggleExpand(folder.id!)
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '16px',
                height: '16px',
                cursor: 'pointer',
                flexShrink: 0,
              }}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{
                  transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                  transition: 'transform 0.15s ease',
                }}
              >
                <path d="M9 18l6-6-6-6" />
              </svg>
            </span>
          ) : (
            <span style={{ width: '16px', flexShrink: 0 }} />
          )}

          {/* Folder icon */}
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ flexShrink: 0 }}
          >
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>

          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {folder.name}
          </span>

          {folder.disabled && (
            <span style={{ fontSize: '12px', color: 'var(--theme-elevation-400)' }}>
              (excluded)
            </span>
          )}
        </button>

        {/* Children */}
        {folder.hasChildren && isExpanded && (
          <div>
            {folder.children.map(child => renderFolderItem(child))}
          </div>
        )}
      </div>
    )
  }

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
        aria-labelledby="folder-select-title"
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          backgroundColor: 'var(--theme-bg)',
          borderRadius: '8px',
          boxShadow: '0 8px 32px rgba(0, 0, 0, 0.24)',
          minWidth: '400px',
          maxWidth: '560px',
          maxHeight: '80vh',
          display: 'flex',
          flexDirection: 'column',
          zIndex: 10001,
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '20px 24px 16px',
            borderBottom: '1px solid var(--theme-elevation-100)',
          }}
        >
          <h2
            id="folder-select-title"
            style={{
              margin: 0,
              fontSize: '18px',
              fontWeight: 600,
              color: 'var(--theme-elevation-800)',
            }}
          >
            {title}
          </h2>
          <p
            style={{
              margin: '8px 0 0',
              fontSize: '14px',
              color: 'var(--theme-elevation-500)',
            }}
          >
            Select a destination folder
          </p>
        </div>

        {/* Folder list */}
        <div
          style={{
            flex: 1,
            overflow: 'auto',
            padding: '8px 0',
            minHeight: '200px',
            maxHeight: '400px',
          }}
        >
          {/* Root option */}
          <button
            onClick={() => handleSelect(null)}
            style={{
              display: 'flex',
              alignItems: 'center',
              width: '100%',
              padding: '8px 12px',
              border: 'none',
              backgroundColor: selectedId === null ? 'var(--theme-elevation-100)' : 'transparent',
              cursor: 'pointer',
              textAlign: 'left',
              fontSize: '14px',
              color: 'var(--theme-elevation-800)',
              gap: '8px',
            }}
            onMouseEnter={(e) => {
              if (selectedId !== null) {
                e.currentTarget.style.backgroundColor = 'var(--theme-elevation-50)'
              }
            }}
            onMouseLeave={(e) => {
              if (selectedId !== null) {
                e.currentTarget.style.backgroundColor = 'transparent'
              }
            }}
          >
            <span style={{ width: '16px', flexShrink: 0 }} />
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ flexShrink: 0 }}
            >
              <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              <polyline points="9 22 9 12 15 12 15 22" />
            </svg>
            <span style={{ fontWeight: 500 }}>Root (top level)</span>
          </button>

          {/* Folder tree */}
          {folderTree.map(folder => renderFolderItem(folder))}

          {folderTree.length === 0 && (
            <div
              style={{
                padding: '24px',
                textAlign: 'center',
                color: 'var(--theme-elevation-400)',
                fontSize: '14px',
              }}
            >
              No folders available
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '16px 24px',
            borderTop: '1px solid var(--theme-elevation-100)',
            display: 'flex',
            justifyContent: 'flex-end',
            gap: '12px',
          }}
        >
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
            Cancel
          </button>
          <button
            ref={moveButtonRef}
            onClick={() => onSelect(selectedId)}
            disabled={!isValidSelection}
            style={{
              padding: '8px 16px',
              border: 'none',
              borderRadius: '4px',
              backgroundColor: isValidSelection ? 'var(--theme-success-500, #22c55e)' : 'var(--theme-elevation-200)',
              color: isValidSelection ? 'white' : 'var(--theme-elevation-400)',
              fontSize: '14px',
              fontWeight: 500,
              cursor: isValidSelection ? 'pointer' : 'not-allowed',
            }}
          >
            Move Here
          </button>
        </div>
      </div>
    </>
  )
}

export default FolderSelectModal
