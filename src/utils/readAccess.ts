import type { PayloadRequest } from 'payload'

/** Optional Local API read context for helpers used by trusted server code. */
export interface ReadAccessOptions {
  /** Request whose user and transaction should be used for nested reads. */
  req?: PayloadRequest
  /** Defaults to false with req, true without req (legacy trusted server calls). */
  overrideAccess?: boolean
}

/** Access context for user-visible reads and user-authorized writes. */
export function userRead(req?: PayloadRequest) {
  return { req, overrideAccess: false as const }
}

/** Trusted derived-data maintenance; retain the request's transaction and context. */
export function trustedRead(req?: PayloadRequest) {
  return { req, overrideAccess: true as const }
}

/** Cascade writes follow the editor's rights while retaining the request transaction. */
export function cascadeAccess(req: PayloadRequest) {
  // Seeds and other server/Local API calls without a user retain trusted access.
  return req.user ? userRead(req) : trustedRead(req)
}

export function readAccessOptions(options: ReadAccessOptions = {}) {
  return (options.overrideAccess ?? !options.req) ? trustedRead(options.req) : userRead(options.req)
}
