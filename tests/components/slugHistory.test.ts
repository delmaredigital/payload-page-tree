import { afterEach, expect, it, vi } from 'vitest'
import * as React from 'react'
import { SlugHistoryModal } from '../../src/components/SlugHistoryModal.js'

afterEach(() => vi.unstubAllGlobals())

function textOf(node: any): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  return React.Children.toArray(node?.props?.children).map(textOf).join(' ')
}

it.each([['move', 'Moved'], ['edit-url', 'URL Edited']] as const)('labels cascade history reason %s as %s', (reason, label) => {
  vi.stubGlobal('React', React)
  const modal = SlugHistoryModal({ isOpen: true, pageName: 'Welcome', currentSlug: 'new',
    history: [{ slug: 'old', changedAt: '2026-11-09T12:00:00Z', reason }], onClose: vi.fn(), onRestore: vi.fn() })
  expect(textOf(modal)).toContain(label)
})
