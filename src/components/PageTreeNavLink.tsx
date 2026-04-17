'use client'

import Link from 'next/link'
import { NavGroup, useConfig } from '@payloadcms/ui'

export function PageTreeNavLink() {
  const { config } = useConfig()
  const adminRoute = config?.routes?.admin || '/admin'

  return (
    <NavGroup label="Page Tree">
      <Link
        href={`${adminRoute}/page-tree`}
        className="nav__link"
        id="nav-page-tree"
      >
        <span className="nav__link-label">Manage Pages</span>
      </Link>
    </NavGroup>
  )
}

export default PageTreeNavLink
