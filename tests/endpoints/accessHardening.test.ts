import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { treeFixture } from '../helpers/treeFixture.js'

beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}))
afterEach(() => vi.restoreAllMocks())

const trustedCalls = (f: ReturnType<typeof treeFixture>) =>
  f.find.mock.calls.filter(([opts]) => opts.overrideAccess === true)

describe('hidden parent folders cannot be probed', () => {
  it.each(['hidden-folder', 'missing'])('folder-impact returns the same 404 for a %s folder', async folderId => {
    const f = treeFixture()
    const response = await f.call('folder-impact', undefined, `folderId=${folderId}`)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'Folder not found' })
    expect(trustedCalls(f)).toEqual([])
  })

  it.each([
    ['page', 'hidden-folder'], ['page', 'missing'], ['folder', 'hidden-folder'], ['folder', 'missing'],
  ] as const)('check-segment returns the same 404 for a %s under a %s parent', async (type, parentId) => {
    const f = treeFixture()
    const response = await f.call('check-segment', undefined, `type=${type}&collection=pages&parentId=${parentId}&segment=anything`)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'Folder not found' })
    expect(trustedCalls(f)).toEqual([])
  })

  it.each([
    ['page', 'hidden-folder'], ['page', 'missing'], ['folder', 'hidden-folder'], ['folder', 'missing'],
  ] as const)('create returns the same 404 for a %s under a %s parent', async (type, parentId) => {
    const f = treeFixture()
    const response = await f.call('create', { type, collection: 'pages', name: 'Probe', parentId })
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'Folder not found' })
    expect(trustedCalls(f)).toEqual([])
    expect(f.create).not.toHaveBeenCalled()
  })

  it.each([
    ['page', '1', 'hidden-folder'], ['page', '1', 'missing'], ['folder', 'leaf', 'hidden-folder'], ['folder', 'leaf', 'missing'],
  ] as const)('move returns the same 404 for %s %s moved into a %s parent', async (type, id, newParentId) => {
    const f = treeFixture()
    const response = await f.call('move', { type, id, collection: type === 'page' ? 'pages' : undefined, newParentId, newIndex: 0 })
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'Folder not found' })
    expect(f.update).not.toHaveBeenCalled()
  })

  it.each([
    ['page', 'hidden-page'], ['page', 'missing'], ['folder', 'hidden-folder'], ['folder', 'missing'],
  ] as const)('check-segment returns the same 404 when excluding a %s that is %s', async (type, excludeId) => {
    const f = treeFixture()
    const response = await f.call('check-segment', undefined, `type=${type}&collection=pages&parentId=root&segment=secret&excludeId=${excludeId}`)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'Not found' })
    expect(trustedCalls(f)).toEqual([])
  })

  it('check-segment still excludes a readable record being edited', async () => {
    const f = treeFixture()
    const response = await f.call('check-segment', undefined, 'type=folder&parentId=middle&segment=advanced&excludeId=leaf')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ available: true, slugifiedSegment: 'advanced' })
  })

  it('still checks and creates at root and under a readable parent', async () => {
    const f = treeFixture()
    expect((await f.call('check-segment', undefined, 'type=folder&segment=new')).status).toBe(200)
    expect((await f.call('check-segment', undefined, 'type=folder&parentId=root&segment=new')).status).toBe(200)
    expect((await f.call('create', { type: 'folder', name: 'New', parentId: 'root' })).status).toBe(200)
  })
})

describe('recursive delete preflight', () => {
  it('propagates a database error instead of reporting it as unreadable', async () => {
    const f = treeFixture()
    const findByID = f.findByID.getMockImplementation()!
    f.findByID.mockImplementation(async opts => {
      if (opts.overrideAccess === false && opts.id === 'leaf') throw new Error('connection reset')
      return findByID(opts)
    })
    for (const page of f.rows.pages) delete page.hidden
    for (const folder of f.rows['payload-folders']) delete folder.hidden
    const before = structuredClone(f.rows)
    const response = await f.call('delete', undefined, 'type=folder&id=root&deleteChildren=true')
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'connection reset' })
    expect(f.remove).not.toHaveBeenCalled()
    expect(f.rows).toEqual(before)
  })
})

describe('folder update denials', () => {
  it.each([
    ['move', { type: 'folder', id: 'leaf', newParentId: 'root', newIndex: 0 }],
    ['rename', { type: 'folder', id: 'leaf', name: 'Renamed' }],
  ] as const)('%s returns 403 when the folder is readable but the update is filtered out', async (path, body) => {
    const f = treeFixture()
    f.rows['payload-folders'].find(row => row.id === 'leaf')!.updateDenied = 404
    const response = await f.call(path, body)
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'Update denied' })
  })

  it('rename keeps 404 for an unreadable folder', async () => {
    const f = treeFixture()
    const response = await f.call('rename', { type: 'folder', id: 'hidden-folder', name: 'Renamed' })
    expect(response.status).toBe(404)
  })
})

describe('folder reorder', () => {
  it('writes one folder at a time over the shared request', async () => {
    const f = treeFixture()
    const update = f.update.getMockImplementation()!
    let active = 0
    let maxActive = 0
    f.update.mockImplementation(async opts => {
      active++
      maxActive = Math.max(maxActive, active)
      try {
        await new Promise(resolve => setTimeout(resolve, 0))
        return await update(opts)
      } finally {
        active--
      }
    })
    const response = await f.call('reorder', {
      type: 'folder', items: [{ id: 'root', sortOrder: 2 }, { id: 'middle', sortOrder: 1 }, { id: 'leaf', sortOrder: 0 }],
    })
    expect(response.status).toBe(200)
    expect(f.update).toHaveBeenCalledTimes(3)
    expect(maxActive).toBe(1)
    expect(f.rows['payload-folders'].map(row => row.sortOrder)).toEqual([2, 1, 0, undefined])
  })
})

describe('folder URL cascade and trash', () => {
  it('refreshes trashed pages on trash-enabled collections only', async () => {
    const f = treeFixture()
    f.payload.collections.pages.config.trash = true
    for (const page of f.rows.pages) delete page.hidden
    f.rows.pages.push({ id: 'trashed', title: 'Old', folder: 'leaf', pageSegment: 'old', slug: 'guides/advanced/old', deletedAt: '2026-11-01' })
    f.rows.posts.push({ id: 'trashed-post', title: 'Old post', folder: 'leaf', pageSegment: 'gone', slug: 'guides/advanced/gone', deletedAt: '2026-11-01' })
    const response = await f.call('edit-url', { type: 'folder', id: 'root', segment: 'docs' })
    expect(response.status).toBe(200)
    expect(f.rows.pages.find(row => row.id === 'trashed')!.slug).toBe('docs/advanced/old')
    // posts has no trash support, so the soft-deleted row is not part of the cascade.
    expect(f.rows.posts.find(row => row.id === 'trashed-post')!.slug).toBe('guides/advanced/gone')
    for (const [opts] of [...f.find.mock.calls, ...f.findByID.mock.calls, ...f.update.mock.calls]) {
      if (opts.collection === 'posts') expect(opts.trash).toBeUndefined()
    }
    expect(f.update).toHaveBeenCalledWith(expect.objectContaining({ collection: 'pages', id: 'trashed', trash: true, overrideAccess: false }))
  })

  it('refuses the folder change when a trashed page is unreadable', async () => {
    const f = treeFixture()
    f.payload.collections.pages.config.trash = true
    delete f.rows.pages[1].hidden
    f.rows.pages.push({ id: 'trashed', hidden: true, title: 'Old', folder: 'leaf', pageSegment: 'old', slug: 'guides/advanced/old', deletedAt: '2026-11-01' })
    const response = await f.call('edit-url', { type: 'folder', id: 'root', segment: 'docs' })
    expect(response.status).toBe(403)
    expect(f.persistedUpdates).not.toHaveBeenCalled()
  })
})
