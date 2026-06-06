'use client'

import Link from 'next/link'
import { NavGroup, useConfig } from '@payloadcms/ui'

export interface PageTreeNavLinkProps {
  /** Navigation group label. @default 'Page Tree' */
  navLabel?: string
  /** Admin-relative path of the Page Tree view. @default '/page-tree' */
  viewPath?: string
}

export function PageTreeNavLink({
  navLabel = 'Page Tree',
  viewPath = '/page-tree',
}: PageTreeNavLinkProps = {}) {
  const { config } = useConfig()
  const adminRoute = config?.routes?.admin || '/admin'

  return (
    <NavGroup label={navLabel}>
      <Link
        href={`${adminRoute}${viewPath}`}
        className="nav__link"
        id="nav-page-tree"
      >
        <span className="nav__link-label">Manage Pages</span>
      </Link>
    </NavGroup>
  )
}

export default PageTreeNavLink
