import { Tree } from 'react-arborist'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as React from 'react'
import { PageTreeClient } from '../../src/components/PageTreeClient.js'
import { ContextMenuProvider } from '../../src/components/ContextMenu.js'
import { ConfirmationModal } from '../../src/components/ConfirmationModal.js'
import type { TreeNode } from '../../src/types.js'

const hooks = vi.hoisted(() => ({ values: [] as any[], index: 0 }))
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useState: (initial: any) => {
    const index = hooks.index++
    if (!(index in hooks.values)) hooks.values[index] = initial
    return [hooks.values[index], (next: any) => { hooks.values[index] = typeof next === 'function' ? next(hooks.values[index]) : next }]
  },
  useCallback: (fn: any) => fn,
  useMemo: (fn: any) => fn(),
  useRef: () => ({ current: null }),
}))
vi.mock('react-arborist', () => ({ Tree: () => null }))
vi.mock('sonner', () => ({ Toaster: () => null, toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../../src/components/TreeNode.js', () => ({ TreeNode: () => null }))
vi.mock('../../src/components/ContextMenu.js', () => ({ ContextMenuProvider: () => null }))
vi.mock('../../src/components/ConfirmationModal.js', () => ({ ConfirmationModal: () => null }))
vi.mock('../../src/components/SlugHistoryModal.js', () => ({ SlugHistoryModal: () => null }))
vi.mock('../../src/components/FolderSelectModal.js', () => ({ FolderSelectModal: () => null }))
vi.mock('../../src/components/EditUrlModal.js', () => ({ EditUrlModal: () => null }))

function findElement(root: any, type: any, predicate = (_element: any) => true): any {
  if (root?.type === type && predicate(root)) return root
  for (const child of React.Children.toArray(root?.props?.children)) {
    const found = findElement(child, type, predicate)
    if (found) return found
  }
}

beforeEach(() => { hooks.values = []; hooks.index = 0; vi.stubGlobal('React', React) })
afterEach(() => vi.unstubAllGlobals())

it.each(['page', 'folder'] as const)('sends the selected %s through the real delete confirmation callback', async (type) => {
  const node: TreeNode = { id: `${type}-1`, rawId: '1', type, name: 'Selected', children: [], pageCount: 0, sortOrder: 0,
    ...(type === 'page' ? { collection: 'posts' } : {}) }
  const fetch = vi.fn(async () => Response.json({ success: true }))
  vi.stubGlobal('fetch', fetch)
  const render = () => {
    hooks.index = 0
    return PageTreeClient({ treeData: [node], collections: ['pages', 'posts'], selectedCollection: 'posts', adminRoute: '/admin' })
  }
  const root = render()
  await findElement(root, ContextMenuProvider).props.onAction(node, 'delete')
  const pending = render()
  const modal = findElement(pending, ConfirmationModal, element => element.props.danger === true)
  expect(modal.props.isOpen).toBe(true)
  await modal.props.onConfirm()
  expect(fetch).toHaveBeenCalledTimes(1)
  const [path, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
  const query = new URL(path, 'http://localhost').searchParams
  expect(init.method).toBe('DELETE')
  expect(query.get('id')).toBe('1')
  expect(query.get('type')).toBe(type)
  if (type === 'page') expect(query.get('collection')).toBe('posts')
})


it('sends the page collection through the drag-and-drop move callback', async () => {
  const node: TreeNode = { id: 'posts-1', rawId: '1', type: 'page', collection: 'posts', name: 'Selected', children: [], pageCount: 0, sortOrder: 0, folderId: null }
  const fetch = vi.fn(async () => Response.json({ success: true }))
  vi.stubGlobal('fetch', fetch)
  const root = PageTreeClient({ treeData: [node], collections: ['pages', 'posts'], selectedCollection: 'posts', adminRoute: '/admin' })
  await findElement(root, Tree).props.onMove({ dragIds: [node.id], parentId: null, index: 2 })
  expect(fetch).toHaveBeenCalledTimes(1)
  const [path, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
  expect(path).toBe('/api/page-tree/move')
  expect(JSON.parse(init.body as string)).toMatchObject({ type: 'page', id: '1', collection: 'posts', newIndex: 2 })
})
