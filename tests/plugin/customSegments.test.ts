import { describe, expect, it } from 'vitest'
import { treeFixture } from '../helpers/treeFixture.js'
import { buildTreeStructure } from '../../src/utils/buildTree.js'

describe('non-default segment fields through registered endpoints and hooks', () => {
  it('creates folders and pages using configured fields and collision checks', async () => {
    const f = treeFixture(true)
    f.rows['payload-folders'].push({ id: 'sibling', name: 'Taken', folder: 'root', folderSegment: 'new-folder' })
    expect((await f.call('create', { type: 'folder', name: 'New Folder', parentId: 'root' })).status).toBe(200)
    expect(f.create.mock.calls[0][0].data).toEqual({ name: 'New Folder', folderSegment: 'new-folder-2', folder: 'root', sortOrder: 0 })
    expect((await f.call('create', { type: 'page', name: 'Welcome', parentId: 'leaf' })).status).toBe(200)
    expect(f.rows.pages.at(-1)).toMatchObject({ urlSegment: 'welcome-2', slug: 'guides/advanced/welcome-2' })
    expect(f.rows.pages.at(-1)).not.toHaveProperty('pageSegment')
  })

  it('migrates only the configured missing folder field and preserves page URLs', async () => {
    const f = treeFixture(true)
    const res = await f.call('migrate')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ count: 1 })
    expect(f.rows['payload-folders'].find(row => row.id === 'middle')).toMatchObject({ folderSegment: 'middle' })
    expect(f.rows['payload-folders'].every(row => !('pathSegment' in row))).toBe(true)
    expect(f.rows.pages[0].slug).toBe('old/welcome')
  })

  it.each(['page', 'folder'] as const)('uses configured %s fields in check-segment and edit-url collision rejection', async (type) => {
    const f = treeFixture(true)
    const collection = type === 'page' ? 'pages' : 'payload-folders'
    const field = type === 'page' ? 'urlSegment' : 'folderSegment'
    const parent = type === 'page' ? 'leaf' : undefined
    f.rows[collection].push({ id: 'taken', [field]: 'taken', folder: parent })
    const res = await f.call('check-segment', undefined, `type=${type}&collection=pages&segment=taken${parent ? `&parentId=${parent}` : ''}`)
    expect(await res.json()).toMatchObject({ available: false })
    expect((await f.call('edit-url', { type, id: type === 'page' ? '1' : 'root', collection: 'pages', segment: 'taken' })).status).toBe(409)
    expect(f.update).not.toHaveBeenCalled()
  })

  it('edits a folder URL, cascades through an empty middle folder, and records URL Edited history', async () => {
    const f = treeFixture(true)
    delete f.rows.pages[1].hidden
    expect((await f.call('edit-url', { type: 'folder', id: 'root', segment: 'Renamed URL' })).status).toBe(200)
    expect(f.rows['payload-folders'][0].folderSegment).toBe('renamed-url')
    expect(f.rows.pages[0]).toMatchObject({ slug: 'renamed-url/advanced/welcome', slugHistory: [
      { slug: 'old/welcome', reason: 'edit-url', changedAt: expect.any(String) }, { slug: 'previous' },
    ] })
    const tree = buildTreeStructure(f.rows['payload-folders'] as any, [], {
      collections: ['pages'], segmentFieldName: 'folderSegment',
    })
    expect(tree.find(node => node.rawId === 'root')?.pathSegment).toBe('renamed-url')
    expect(f.config.custom?.pageTree).toMatchObject({ segmentFieldName: 'folderSegment' })
  })

  it('edits, restores, duplicates and regenerates a page using its configured segment', async () => {
    const f = treeFixture(true)
    expect((await f.call('edit-url', { type: 'page', collection: 'pages', id: '1', segment: 'New URL' })).status).toBe(200)
    expect(f.rows.pages[0]).toMatchObject({ urlSegment: 'new-url', slug: 'guides/advanced/new-url' })
    expect((await f.call('restore-slug', { collection: 'pages', id: '1', slug: 'previous' })).status).toBe(200)
    expect(f.rows.pages[0]).toMatchObject({ urlSegment: 'previous', slug: 'previous' })
    expect((await f.call('duplicate', undefined, 'id=1&collection=pages')).status).toBe(200)
    expect(f.duplicate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ urlSegment: 'previous-2' }) }))
    expect((await f.call('regenerate-slugs', undefined, 'folderId=root')).status).toBe(200)
    expect(f.rows.pages[0]).toMatchObject({ slug: 'guides/advanced/previous' })
    expect(f.rows.pages[0]).not.toHaveProperty('pageSegment')
  })
})
