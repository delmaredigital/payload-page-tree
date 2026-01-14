'use client'

import Link from 'next/link'
import { NavGroup } from '@payloadcms/ui'

export function PageTreeNavLink() {
  return (
    <NavGroup label="Page Tree">
      <Link
        href="/admin/page-tree"
        className="nav__link"
        id="nav-page-tree"
      >
        <span className="nav__link-label">Manage Pages</span>
      </Link>
    </NavGroup>
  )
}

export default PageTreeNavLink
