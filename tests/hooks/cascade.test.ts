import { describe, expect, it } from 'vitest'
import { treeFixture } from '../helpers/treeFixture.js'

describe('folder cascade history', () => {
  it.each([
    ['move', { folder: 'destination' }, { id: 'destination', name: 'Destination', pathSegment: 'new-parent' }, 'new-parent/guides/advanced/welcome'],
    ['edit-url', { pathSegment: 'renamed' }, undefined, 'renamed/advanced/welcome'],
  ] as const)('records %s on the descendant page history', async (reason, data, destination, slug) => {
    const f = treeFixture()
    delete f.rows.pages[1].hidden
    if (destination) f.rows['payload-folders'].push(destination)
    await f.payload.update({ collection: 'payload-folders', id: 'root', data, req: f.req,
      overrideAccess: false, context: { updateSlugs: true, slugChangeReason: reason } })
    expect(f.rows.pages[0]).toMatchObject({ slug, slugHistory: [
      { slug: 'old/welcome', reason, changedAt: expect.any(String) }, { slug: 'previous' },
    ] })
    for (const [opts] of [...f.find.mock.calls, ...f.findByID.mock.calls, ...f.update.mock.calls.slice(1)]) {
      expect(opts.req).toBe(f.req)
    }
    for (const [opts] of f.find.mock.calls) expect(opts.overrideAccess).toBe(true)
    for (const [opts] of f.findByID.mock.calls) expect(opts.overrideAccess).toBe(opts.collection === 'payload-folders')
    for (const [opts] of f.update.mock.calls.slice(1)) expect(opts.overrideAccess).toBe(false)
    expect(f.rows.pages.find(page => page.id === 'hidden-page')?.slug).toBe(
      reason === 'move' ? 'new-parent/guides/secret' : 'renamed/secret',
    )
    expect(f.rows.posts[0].slug).toBe(reason === 'move' ? 'new-parent/guides/advanced/post' : 'renamed/advanced/post')
    expect(f.payload.db.commitTransaction).toHaveBeenCalledOnce()
  })

  it.each([
    [{ pathSegment: 'renamed' }, 'edit-url'],
    [{ folder: null }, 'move'],
  ] as const)('infers a fitting reason when user code requests a cascade without one', async (data, reason) => {
    const f = treeFixture()
    delete f.rows.pages[1].hidden
    // Call the folder hook directly to inspect the inferred context.
    f.update.mockResolvedValue({ id: '1' })
    const previousDoc = { ...f.rows['payload-folders'][0], ...('folder' in data ? { folder: 'elsewhere' } : {}) }
    const doc = { ...previousDoc, ...data }
    await f.folderConfig.hooks.afterChange[0]({ doc, previousDoc, req: f.req, context: { updateSlugs: true } })
    expect(f.update).toHaveBeenCalledWith(expect.objectContaining({ context: expect.objectContaining({ slugChangeReason: reason }) }))
  })
})

describe('trusted slug maintenance', () => {
  it('keeps an unreadable ancestor in the stored slug when an editor edits a page', async () => {
    const f = treeFixture()
    f.rows['payload-folders'][0].hidden = true
    f.req.transactionID = 'editor-txn'
    expect((await f.call('edit-url', { type: 'page', collection: 'pages', id: '1', segment: 'edited' })).status).toBe(200)
    expect(f.rows.pages[0].slug).toBe('guides/advanced/edited')
    for (const [opts] of f.findByID.mock.calls.filter(([opts]) => opts.collection === 'payload-folders')) {
      expect(opts.req).toBe(f.req)
      expect(opts.req.transactionID).toBe('editor-txn')
      expect(opts.overrideAccess).toBe(true)
    }
  })

  it('updates readable pages beneath unreadable child folders in the original transaction', async () => {
    const f = treeFixture()
    delete f.rows.pages[1].hidden
    f.rows.pages.find(page => page.id === 'hidden-page')!.folder = 'hidden-folder'
    f.req.transactionID = 'cascade-txn'
    const update = f.update.getMockImplementation()!
    f.update.mockImplementation(async opts => {
      expect(opts.req).toBe(f.req)
      expect(opts.req.transactionID).toBe('cascade-txn')
      return update(opts)
    })
    expect((await f.call('edit-url', { type: 'folder', id: 'root', segment: 'renamed' })).status).toBe(200)
    expect(f.rows.pages.find(page => page.id === 'hidden-page')?.slug).toBe('renamed/secret/secret')
    expect(f.update).toHaveBeenCalledWith(expect.objectContaining({ id: 'hidden-page', overrideAccess: false, req: f.req }))
    for (const [opts] of f.find.mock.calls.filter(([opts]) => opts.where?.folder)) {
      expect(opts.req).toBe(f.req)
      expect(opts.overrideAccess).toBe(true)
    }
  })
})


it('propagates a failed cascade update so the parent operation can roll back', async () => {
  const f = treeFixture()
  delete f.rows.pages[1].hidden
  const failure = new Error('Database write failed')
  f.update.mockRejectedValue(failure)
  const previousDoc = { ...f.rows['payload-folders'][0] }
  const doc = { ...previousDoc, pathSegment: 'renamed' }
  await expect(f.folderConfig.hooks.afterChange[0]({ doc, previousDoc, req: f.req, context: { updateSlugs: true } }))
    .rejects.toBe(failure)
})


describe('cascade editor permissions', () => {
  it.each([['enabled', 403], ['enabled', 404], ['disabled', 403], ['disabled', 404]] as const)(
    'refuses an unreadable page across collections before any persistence (transactions %s, READ %s)', async (transactions, status) => {
    const f = treeFixture()
    delete f.rows.pages[1].hidden
    f.rows.posts[0].hidden = true
    f.rows.posts[0].folder = 'hidden-folder'
    if (status === 403) {
      const findByID = f.findByID.getMockImplementation()!
      f.findByID.mockImplementation(async opts => {
        if (opts.collection === 'posts' && !opts.overrideAccess) throw Object.assign(new Error('Forbidden'), { status })
        return findByID(opts)
      })
    }
    if (transactions === 'disabled') f.payload.db.beginTransaction.mockResolvedValue(null as any)
    const before = structuredClone(f.rows)
    await expect(f.payload.update({
      collection: 'payload-folders', id: 'root', data: { pathSegment: 'renamed' },
      req: f.req, overrideAccess: false, context: { updateSlugs: true },
    })).rejects.toMatchObject({
      status: 403, message: 'Cannot change the URL of a folder containing pages you cannot edit',
    })
    expect(f.rows).toEqual(before)
    expect(f.persistedUpdates).not.toHaveBeenCalled()
    expect(f.update).toHaveBeenCalledTimes(1) // Only the attempted folder operation.
    expect(f.findByID).toHaveBeenCalledWith(expect.objectContaining({
      collection: 'posts', id: '1', req: f.req, overrideAccess: false,
    }))
  })

  it.each(['move', 'edit-url'] as const)('%s returns the preflight 403 without any persistence', async path => {
    const f = treeFixture()
    f.rows['payload-folders'].push({ id: 'destination', name: 'Destination', pathSegment: 'new-parent' })
    const before = structuredClone(f.rows)
    const body = path === 'move'
      ? { type: 'folder', id: 'root', newParentId: 'destination', updateSlugs: true }
      : { type: 'folder', id: 'root', segment: 'renamed' }
    const response = await f.call(path, body)
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'Cannot change the URL of a folder containing pages you cannot edit' })
    expect(f.rows).toEqual(before)
    expect(f.persistedUpdates).not.toHaveBeenCalled()
  })

  it.each([403, 404])('rolls back the folder and earlier pages after a later UPDATE denial (%s)', async status => {
    const f = treeFixture()
    delete f.rows.pages[1].hidden
    f.rows.posts[0].updateDenied = status
    const before = structuredClone(f.rows)
    await expect(f.payload.update({
      collection: 'payload-folders', id: 'root', data: { pathSegment: 'renamed' },
      req: f.req, overrideAccess: false, context: { updateSlugs: true },
    })).rejects.toMatchObject({ status })
    expect(f.persistedUpdates.mock.calls.map(([opts]) => opts.collection)).toEqual(['payload-folders', 'pages', 'pages'])
    expect(f.rows).toEqual(before)
    expect(f.payload.db.rollbackTransaction).toHaveBeenCalledWith('delete-txn')
    expect(f.payload.db.commitTransaction).not.toHaveBeenCalled()
    for (const [opts] of f.update.mock.calls.slice(1)) {
      expect(opts.req).toBe(f.req)
      expect(opts.overrideAccess).toBe(false)
    }
  })

  it('keeps no-user Local API cascades trusted under restrictive READ and UPDATE access', async () => {
    const f = treeFixture()
    f.req.user = null
    for (const page of [...f.rows.pages, ...f.rows.posts]) {
      page.hidden = true
      page.updateDenied = 403
    }
    await f.payload.update({
      collection: 'payload-folders', id: 'root', data: { pathSegment: 'renamed' },
      req: f.req, overrideAccess: true, context: { updateSlugs: true },
    })
    expect(f.rows.pages.map(page => page.slug)).toEqual(['renamed/advanced/welcome', 'renamed/secret'])
    expect(f.rows.posts[0].slug).toBe('renamed/advanced/post')
    for (const [opts] of [...f.find.mock.calls, ...f.findByID.mock.calls, ...f.update.mock.calls]) {
      expect(opts.req).toBe(f.req)
      expect(opts.overrideAccess).toBe(true)
    }
    expect(f.payload.db.commitTransaction).toHaveBeenCalledOnce()
  })
})
