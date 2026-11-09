import { describe, expect, it } from 'vitest'
import { treeFixture } from '../helpers/treeFixture.js'

describe('request-scoped collection READ access', () => {
  it.each([
    ['create', { type: 'folder', name: 'New folder', parentId: 'root' }, ''],
    ['create', { type: 'page', name: 'New page', parentId: 'leaf' }, ''],
    ['duplicate', undefined, 'collection=pages&id=1'],
    ['regenerate-slugs', undefined, 'folderId=root'],
    ['regenerate-slugs', undefined, ''],
    ['migrate', undefined, ''],
    ['redirects', undefined, 'collection=pages'],
    ['restore-slug', { collection: 'pages', id: '1', slug: 'previous' }, ''],
    ['edit-url', { type: 'page', collection: 'pages', id: '1', segment: 'changed' }, ''],
    ['edit-url', { type: 'folder', id: 'root', segment: 'changed' }, ''],
    ['check-segment', undefined, 'type=page&collection=pages&segment=secret&parentId=root'],
    ['check-segment', undefined, 'type=folder&segment=secret&parentId=root'],
    ['folder-impact', undefined, 'folderId=root'],
  ] as const)('%s preserves the request and separates user reads from slug maintenance (%s %s)', async (path, body, query) => {
    const f = treeFixture()
    if (path === 'edit-url' && body?.type === 'folder') delete f.rows.pages[1].hidden
    const res = await f.call(path, body, query)
    expect(res.status).toBe(200)
    const reads = [...f.find.mock.calls, ...f.findByID.mock.calls]
    expect(reads.length).toBeGreaterThan(0)
    for (const [opts] of reads) {
      expect(opts.req).toBe(f.req)
      expect(opts.req.user).toBe(f.req.user)
    }
    const expectAccess = (calls: any[], trusted: boolean) => {
      for (const [opts] of calls) expect(opts.overrideAccess).toBe(trusted)
    }
    if (path === 'create' || path === 'check-segment' || path === 'folder-impact') {
      expectAccess(reads, true)
    } else if (path === 'duplicate') {
      expectAccess(f.find.mock.calls.slice(0, 1), false) // display title siblings
      expectAccess(f.find.mock.calls.slice(1), true) // stored segment/slug selection
      expectAccess(f.findByID.mock.calls.slice(0, 1), false) // source document
      expectAccess(f.findByID.mock.calls.slice(1), true) // slug ancestors
    } else if (path === 'edit-url') {
      expectAccess(f.find.mock.calls, true) // write collision checks and cascade
      expectAccess(f.findByID.mock.calls.slice(0, 1), false) // source document
      for (const [opts] of f.findByID.mock.calls.slice(1)) {
        expect(opts.overrideAccess).toBe(opts.collection === 'payload-folders') // ancestors trusted; cascade preflight checked
      }
    } else {
      expectAccess(f.find.mock.calls, false) // selections/returned data
      expectAccess(f.findByID.mock.calls, path === 'regenerate-slugs')
    }
    const cascades = path === 'edit-url' && body?.type === 'folder'
    expect(f.update.mock.calls.some(([o]) => String(o.id).startsWith('hidden'))).toBe(cascades)
    expect(f.remove.mock.calls.some(([o]) => String(o.id).startsWith('hidden'))).toBe(false)
    const result = await res.json()
    if (path === 'redirects') expect(result.redirects).toEqual([{ from: '/previous', to: '/old/welcome' }])
    if (path === 'folder-impact') expect(result).toEqual({ childPageCount: 3 })
    if (path === 'regenerate-slugs') expect(result.count).toBe(2)
    if (path === 'check-segment') expect(result).toEqual({ available: false, slugifiedSegment: 'secret' })
  })

  it('reserves hidden slug ownership when choosing a stored slug', async () => {
    const f = treeFixture()
    f.rows.pages.push({ id: 'secret-root', hidden: true, title: 'Hidden', slug: 'welcome' })
    const response = await f.call('create', { type: 'page', name: 'Welcome' })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ pageSegment: 'welcome-2', collisionResolved: true })
    expect(f.rows.pages.at(-1)?.slug).toBe('welcome-2')
    expect(f.find).toHaveBeenCalledWith(expect.objectContaining({ where: { slug: { equals: 'welcome' } }, req: f.req, overrideAccess: true }))
  })
})


describe('write-path collision checks', () => {
  it('reserves hidden sibling segments when duplicating a page', async () => {
    const f = treeFixture()
    f.rows.pages.push({ id: 'hidden-sibling', hidden: true, folder: 'leaf', pageSegment: 'welcome-2', slug: 'guides/advanced/welcome-2' })
    const response = await f.call('duplicate', undefined, 'collection=pages&id=1')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ pageSegment: 'welcome-3' })
    expect(f.duplicate).toHaveBeenCalledWith(expect.objectContaining({ req: f.req, overrideAccess: false }))
  })

  it.each(['page', 'folder'] as const)('UI availability and save both reject a hidden %s sibling', async type => {
    const f = treeFixture()
    const query = `type=${type}&collection=pages&parentId=root&segment=secret`
    const check = await f.call('check-segment', undefined, query)
    expect(check.status).toBe(200)
    expect(await check.json()).toEqual({ available: false, slugifiedSegment: 'secret' })
    expect(f.find).toHaveBeenLastCalledWith(expect.objectContaining({ req: f.req, overrideAccess: true }))
    const id = type === 'page' ? '1' : 'middle'
    if (type === 'page') f.rows.pages[0].folder = 'root'
    expect((await f.call('edit-url', { type, collection: 'pages', id, segment: 'secret' })).status).toBe(409)
    expect(f.update).not.toHaveBeenCalled()
    const create = await f.call('create', { type, collection: 'pages', name: 'Secret', parentId: 'root' })
    expect(create.status).toBe(200)
    expect(await create.json()).toMatchObject(type === 'page' ? { pageSegment: 'secret-2' } : { pathSegment: 'secret-2' })
  })

  it('counts hidden pages and pages beneath hidden folders across collections, returning only a number', async () => {
    const f = treeFixture()
    f.rows.posts.push({ id: 'nested-hidden', hidden: true, folder: 'hidden-folder', pageSegment: 'nested' })
    const impact = await f.call('folder-impact', undefined, 'folderId=root')
    expect(impact.status).toBe(200)
    expect(await impact.json()).toEqual({ childPageCount: 4 })
    for (const [opts] of f.find.mock.calls) {
      expect(opts).toMatchObject({ req: f.req, overrideAccess: true })
    }
    expect((await f.call('edit-url', { type: 'folder', id: 'root', segment: 'changed' })).status).toBe(403)
    expect(f.persistedUpdates).not.toHaveBeenCalled()
    // The trusted count is the number of pages the editor must be allowed to edit.
    for (const page of [...f.rows.pages, ...f.rows.posts]) delete page.hidden
    expect((await f.call('edit-url', { type: 'folder', id: 'root', segment: 'changed' })).status).toBe(200)
    const rewrittenPages = f.update.mock.calls.filter(([opts]) => opts.collection !== 'payload-folders')
    expect(rewrittenPages).toHaveLength(4)
  })
})


describe('user-operated targets remain access-checked', () => {
  it.each([
    ['move', { type: 'page', id: 'hidden-page', newParentId: 'leaf' }, ''],
    ['move', { type: 'folder', id: 'hidden-folder', newParentId: 'leaf' }, ''],
    ['rename', { type: 'page', collection: 'pages', id: 'hidden-page', name: 'Changed' }, ''],
    ['rename', { type: 'folder', id: 'hidden-folder', name: 'Changed' }, ''],
    ['delete', undefined, 'type=page&collection=pages&id=hidden-page'],
    ['delete', undefined, 'type=folder&id=hidden-folder'],
    ['duplicate', undefined, 'collection=pages&id=hidden-page'],
    ['edit-url', { type: 'page', collection: 'pages', id: 'hidden-page', segment: 'changed' }, ''],
    ['edit-url', { type: 'folder', id: 'hidden-folder', segment: 'changed' }, ''],
    ['restore-slug', { collection: 'pages', id: 'hidden-page', slug: 'hidden-old' }, ''],
  ] as const)('%s cannot mutate an unreadable target (%s %s)', async (path, body, query) => {
    const f = treeFixture()
    const before = structuredClone(f.rows)
    await f.call(path, body, query)
    expect(f.rows).toEqual(before)
    expect(f.update).not.toHaveBeenCalled()
    expect(f.remove).not.toHaveBeenCalled()
    expect(f.duplicate).not.toHaveBeenCalled()
    expect(f.findByID).toHaveBeenCalled()
    for (const [opts] of f.findByID.mock.calls) {
      expect(opts.req).toBe(f.req)
      expect(opts.overrideAccess).toBe(false)
    }
  })
})
