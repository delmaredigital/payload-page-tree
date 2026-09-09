import { describe, expect, it } from 'vitest'
import type { Config, PayloadRequest } from 'payload'
import { pageTreePlugin } from '../../src/index.js'

/**
 * Every /page-tree/* endpoint the plugin registers must sit behind the access
 * gate. Building the config and calling each handler with an anonymous request
 * proves no endpoint was left unguarded.
 */
function buildEndpoints(access?: ({ req }: { req: PayloadRequest }) => boolean) {
  const config = pageTreePlugin({ collections: ['pages'], access })({
    collections: [{ slug: 'pages', fields: [] }],
  } as unknown as Config)
  return (config.endpoints || []).filter((e) => e.path.startsWith('/page-tree/'))
}

describe('pageTreePlugin endpoints', () => {
  it('registers all fourteen tree endpoints', () => {
    expect(buildEndpoints().map((e) => e.path).sort()).toEqual(
      [
        '/page-tree/check-segment',
        '/page-tree/create',
        '/page-tree/delete',
        '/page-tree/duplicate',
        '/page-tree/edit-url',
        '/page-tree/folder-impact',
        '/page-tree/migrate',
        '/page-tree/move',
        '/page-tree/redirects',
        '/page-tree/regenerate-slugs',
        '/page-tree/rename',
        '/page-tree/reorder',
        '/page-tree/restore-slug',
        '/page-tree/status',
      ].sort(),
    )
  })

  it('rejects anonymous requests on every endpoint before touching Payload', async () => {
    const payload = new Proxy({}, { get: () => () => { throw new Error('Payload must not be reached') } })
    const req = { user: null, payload, json: async () => ({}) } as unknown as PayloadRequest
    for (const endpoint of buildEndpoints()) {
      const res = await endpoint.handler(req)
      expect(res.status, endpoint.path).toBe(401)
    }
  })

  it('applies a custom access gate to every endpoint', async () => {
    const payload = new Proxy({}, { get: () => () => { throw new Error('Payload must not be reached') } })
    const req = { user: { id: 1, role: 'user' }, payload, json: async () => ({}) } as unknown as PayloadRequest
    const endpoints = buildEndpoints(({ req }) => (req.user as { role?: string })?.role === 'admin')
    for (const endpoint of endpoints) {
      const res = await endpoint.handler(req)
      expect(res.status, endpoint.path).toBe(403)
    }
  })
})
