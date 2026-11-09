import { describe, expect, it, vi } from 'vitest'
import { getRedirectMap } from '../../src/utils/redirectMap.js'
import { getFolderPath } from '../../src/utils/getFolderPath.js'
import { buildPageSlug } from '../../src/utils/buildPageSlug.js'
import { treeFixture } from '../helpers/treeFixture.js'

describe('server helper request options', () => {
  it('keeps legacy redirect calls privileged but applies READ access by default when given req', async () => {
    const f = treeFixture()
    expect(await getRedirectMap(f.payload as any, 'pages')).toHaveLength(2)
    expect(f.find).toHaveBeenLastCalledWith(expect.objectContaining({ overrideAccess: true }))
    expect(await getRedirectMap(f.payload as any, 'pages', { req: f.req })).toEqual([{ from: '/previous', to: '/old/welcome' }])
    expect(f.find).toHaveBeenLastCalledWith(expect.objectContaining({ req: f.req, overrideAccess: false }))
    expect(await getRedirectMap(f.payload as any, 'pages', { req: f.req, overrideAccess: true })).toHaveLength(2)
    expect(await getRedirectMap(f.payload as any, 'pages', { overrideAccess: false })).toEqual([])
  })

  it('preserves trusted getFolderPath callers and lets requests enforce or explicitly override READ access', async () => {
    const f = treeFixture()
    expect(await getFolderPath('hidden-folder', f.payload as any)).toBe('guides/secret')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await getFolderPath('hidden-folder', f.payload as any, f.options.folderSlug, 'pathSegment', { req: f.req })).toBe('')
      expect(f.findByID).toHaveBeenLastCalledWith(expect.objectContaining({ req: f.req, overrideAccess: false }))
      f.findByID.mockClear()
      expect(await getFolderPath('hidden-folder', f.payload as any, f.options.folderSlug, 'pathSegment', { req: f.req, overrideAccess: true })).toBe('guides/secret')
      for (const [opts] of f.findByID.mock.calls) expect(opts).toMatchObject({ req: f.req, overrideAccess: true })
    } finally { log.mockRestore() }
  })

  it.each([null, undefined])('keeps ancestors when the middle segment is %s', async (segment) => {
    const f = treeFixture()
    f.rows['payload-folders'][1].pathSegment = segment
    expect(await getFolderPath('leaf', f.payload as any)).toBe('guides/advanced')
  })

  it.each([false, true])('keeps ancestors across a three-level chain with an empty middle segment (custom names: %s)', async (customFields) => {
    const f = treeFixture(customFields)
    const opts = { req: f.req }
    expect(await getFolderPath('leaf', f.payload as any, f.options.folderSlug, f.options.segmentFieldName, opts)).toBe('guides/advanced')
    for (const [read] of f.findByID.mock.calls) expect(read).toMatchObject({ req: f.req, overrideAccess: false })
    f.findByID.mockClear()
    const buildSlug = vi.fn(({ folderPath, pageSegment }) => `${folderPath}/${pageSegment}`)
    expect(await buildPageSlug({ payload: f.payload as any, folderId: 'leaf', folderSlug: f.options.folderSlug,
      segmentFieldName: f.options.segmentFieldName, pageSegment: 'welcome', doc: {}, operation: 'create', buildSlug, ...opts })).toBe('guides/advanced/welcome')
    expect(buildSlug).toHaveBeenCalledWith(expect.objectContaining({ folderPath: 'guides/advanced' }))
    for (const [read] of f.findByID.mock.calls) expect(read).toMatchObject({ req: f.req, overrideAccess: true })
  })

  it('passes an empty string to buildSlug for pages at root', async () => {
    const f = treeFixture()
    const buildSlug = vi.fn(({ folderPath, pageSegment }) => { expect(folderPath).toBe(''); return pageSegment })
    expect(await buildPageSlug({ payload: f.payload as any, folderId: null, folderSlug: f.options.folderSlug,
      segmentFieldName: 'pathSegment', pageSegment: 'welcome', doc: {}, operation: 'create', buildSlug })).toBe('welcome')
    expect(f.findByID).not.toHaveBeenCalled()
  })
})
