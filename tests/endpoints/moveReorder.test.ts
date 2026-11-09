import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { treeFixture } from '../helpers/treeFixture.js'

beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}))
afterEach(() => vi.restoreAllMocks())

describe.each(['move', 'reorder'] as const)('%s page results', path => {
  const body = (id: string, collection?: string) => ({
    type: 'page',
    ...(collection !== undefined ? { collection } : {}),
    ...(path === 'move' ? { id, newParentId: 'root', newIndex: 7 } : { items: [{ id, sortOrder: 7 }] }),
  })

  it.each([undefined, 'posts'])('writes only the resolved collection (%s)', async collection => {
    const f = treeFixture()
    // Legacy callers should find a page in the second configured collection too.
    if (!collection) f.rows.posts[0].id = 'post-only'
    const beforePages = structuredClone(f.rows.pages)
    const response = await f.call(path, body(collection ? '1' : 'post-only', collection))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true })
    expect(f.update).toHaveBeenCalledTimes(1)
    expect(f.update).toHaveBeenCalledWith(expect.objectContaining({
      collection: 'posts', req: f.req, overrideAccess: false, data: expect.objectContaining({ sortOrder: 7 }),
    }))
    expect(f.rows.posts[0].sortOrder).toBe(7)
    if (path === 'move') expect(f.rows.posts[0].folder).toBe('root')
    expect(f.rows.pages).toEqual(beforePages)
  })

  it.each([undefined, 'posts'])('returns 404 without a write for a missing page (%s)', async collection => {
    const f = treeFixture()
    const response = await f.call(path, body('missing', collection))
    expect(response.status).toBe(404)
    expect(await response.json()).not.toHaveProperty('success')
    expect(f.update).not.toHaveBeenCalled()
  })

  it('does not fall back when the selected collection is missing a same-id page', async () => {
    const f = treeFixture()
    f.rows.posts = []
    expect((await f.call(path, body('1', 'posts'))).status).toBe(404)
    expect(f.update).not.toHaveBeenCalled()
    expect(f.findByID.mock.calls.every(([opts]) => opts.collection === 'posts')).toBe(true)
  })

  it.each([undefined, 'pages'])('returns 403 for an unreadable page, including filtered READ 404 (%s)', async collection => {
    const f = treeFixture()
    f.rows.pages[0].hidden = true
    const before = structuredClone(f.rows)
    expect((await f.call(path, body('1', collection))).status).toBe(403)
    expect(f.update).not.toHaveBeenCalled()
    expect(f.rows).toEqual(before)
    expect(f.find).toHaveBeenCalledWith(expect.objectContaining({ req: f.req, overrideAccess: true, select: { id: true } }))
  })

  it('returns 403 for a collection READ denial', async () => {
    const f = treeFixture()
    f.findByID.mockRejectedValueOnce(Object.assign(new Error('Forbidden'), { status: 403 }))
    expect((await f.call(path, body('1', 'pages'))).status).toBe(403)
    expect(f.update).not.toHaveBeenCalled()
  })

  it.each([403, 404])('returns 403 on UPDATE denial (%s) without trying another collection', async status => {
    const f = treeFixture()
    f.rows.pages[0].updateDenied = status
    const before = structuredClone(f.rows)
    const response = await f.call(path, body('1'))
    expect(response.status).toBe(403)
    expect(await response.json()).not.toHaveProperty('success')
    expect(f.update).toHaveBeenCalledTimes(1)
    expect(f.rows).toEqual(before)
  })

  it.each(['', 'unconfigured', 'payload-folders', null, 42])('rejects invalid collection %s', async collection => {
    const f = treeFixture()
    expect((await f.call(path, { ...body('1'), collection })).status).toBe(400)
    expect(f.findByID).not.toHaveBeenCalled()
    expect(f.update).not.toHaveBeenCalled()
  })

  it('reports unexpected write failures as 500 without fallback', async () => {
    const f = treeFixture()
    f.update.mockRejectedValueOnce(new Error('Database unavailable'))
    expect((await f.call(path, body('1'))).status).toBe(500)
    expect(f.update).toHaveBeenCalledTimes(1)
  })
})

it('preflights every reorder target before any write', async () => {
  const f = treeFixture()
  const response = await f.call('reorder', { type: 'page', items: [{ id: '1', sortOrder: 1 }, { id: 'hidden-page', sortOrder: 2 }] })
  expect(response.status).toBe(403)
  expect(f.update).not.toHaveBeenCalled()
})

it('rejects an empty reorder batch without reporting success', async () => {
  const f = treeFixture()
  expect((await f.call('reorder', { type: 'page', items: [] })).status).toBe(400)
  expect(f.update).not.toHaveBeenCalled()
})

it('resolves every page in a legacy reorder batch across collections', async () => {
  const f = treeFixture()
  f.rows.posts[0].id = 'post-only'
  expect((await f.call('reorder', { type: 'page', items: [{ id: '1', sortOrder: 3 }, { id: 'post-only', sortOrder: 4 }] })).status).toBe(200)
  expect(f.rows.pages[0].sortOrder).toBe(3)
  expect(f.rows.posts[0].sortOrder).toBe(4)
})
