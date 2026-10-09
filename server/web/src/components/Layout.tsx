import { useEffect, useRef, useState } from 'react'
import { Link, NavLink, Outlet, ScrollRestoration, useLocation, useNavigate, useNavigation, useSearchParams } from 'react-router'
import { BookOpen, ChevronDown, Download, LogOut, Search, Settings, ShieldCheck } from 'lucide-react'
import { pointerGlow } from '@design/pointer-glow'
import { api } from '../lib/api'
import { server } from '../lib/boot'
import { session, useAccount } from '../lib/session'
import { hash } from '../lib/format'
import { Brand } from './Brand'
import { Menu } from './Menu'
import { useToast } from './Toasts'

/** `/` or ⌘K focuses the page's search, wherever it is. */
function useSearchShortcut(): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement
      const typing = target.closest('input, textarea, select, [contenteditable="true"]')
      if ((event.key === '/' && !typing) || (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey))) {
        const field = document.querySelector<HTMLInputElement>('[data-search]')
        if (field) { event.preventDefault(); field.focus(); field.select() }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

function HeaderSearch() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [value, setValue] = useState(params.get('q') ?? '')
  return (
    <form className="header-search" role="search" onSubmit={(event) => { event.preventDefault(); navigate(value.trim() ? `/?q=${encodeURIComponent(value.trim())}` : '/', { viewTransition: true }) }}>
      <Search aria-hidden />
      <input data-search type="search" placeholder="Search courses" aria-label="Search courses" value={value} onChange={(event) => setValue(event.target.value)} />
      <kbd className="oc-kbd">/</kbd>
    </form>
  )
}

function UserMenu() {
  const account = useAccount()!
  const navigate = useNavigate()
  const notify = useToast()
  const signOut = async (): Promise<void> => {
    try { await api.logout() } catch { /* the cookie is cleared either way */ }
    session.set(null)
    notify('Signed out.', 'info')
    navigate('/', { viewTransition: true })
  }
  return (
    <Menu
      label="Account"
      header={<div className="menu-account"><strong>{account.username}</strong><span>{account.email}</span></div>}
      items={[
        { key: 'courses', label: 'My courses', icon: <BookOpen aria-hidden />, onSelect: () => navigate('/me/courses', { viewTransition: true }) },
        { key: 'settings', label: 'Settings', icon: <Settings aria-hidden />, onSelect: () => navigate('/settings', { viewTransition: true }) },
        ...(account.role === 'admin' ? [{ key: 'admin', label: 'Administration', icon: <ShieldCheck aria-hidden />, onSelect: () => navigate('/admin', { viewTransition: true }) }] : []),
        'separator',
        { key: 'out', label: 'Sign out', icon: <LogOut aria-hidden />, onSelect: () => { void signOut() } }
      ]}
      trigger={({ open, toggle, ref }) => (
        <button ref={ref} type="button" className="user-chip" aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
          <Avatar name={account.username} />
          <span className="user-chip-name">{account.username}</span>
          <ChevronDown aria-hidden className="user-chip-caret" />
        </button>
      )}
    />
  )
}

export function Avatar({ name, size = 'sm' }: { name: string; size?: 'sm' | 'lg' }) {
  return <span className={`avatar ${size} a${hash(name) % 5}`} aria-hidden="true">{name.charAt(0).toUpperCase()}</span>
}

function Header() {
  const account = useAccount()
  const { pathname } = useLocation()
  const navigation = useNavigation()
  const atCatalog = pathname === '/'
  return (
    <header className="site-header oc-glass">
      <div className={`progress${navigation.state !== 'idle' ? ' active' : ''}`} aria-hidden="true" />
      <div className="oc-wrap site-header-row">
        <div className="site-header-start">
          <Brand />
          <span className="site-divider" aria-hidden="true" />
          <Link to="/" className="site-server" viewTransition>{server.name}</Link>
        </div>
        <nav className="site-nav" aria-label="Main">
          <NavLink to="/" end viewTransition>Catalog</NavLink>
          {account && <NavLink to="/me/courses" viewTransition>My courses</NavLink>}
          {account?.role === 'admin' && <NavLink to="/admin" viewTransition>Admin</NavLink>}
        </nav>
        <div className="site-header-end">
          {!atCatalog && <HeaderSearch key={pathname} />}
          <a className="oc-btn ghost sm get-app" href={server.appUrl}><Download aria-hidden /><span>Get the app</span></a>
          {account ? <UserMenu /> : (
            <>
              <Link className="oc-btn ghost sm" to={`/signin?next=${encodeURIComponent(pathname)}`} viewTransition>Sign in</Link>
              {server.registration === 'open' && <Link className="oc-btn sm" to="/signup" viewTransition>Create account</Link>}
            </>
          )}
        </div>
      </div>
    </header>
  )
}

function Footer() {
  return (
    <footer className="site-footer">
      <div className="oc-wrap site-footer-row">
        <div className="site-footer-brand">
          <Brand />
          <p>{server.description || 'Courses shared by the people who use this server.'}</p>
        </div>
        <div className="site-footer-connect">
          <span className="oc-eyebrow">Connect from the app</span>
          <p>Open the app, go to <strong>Settings ▸ Servers</strong> and connect to <code>{server.publicUrl.replace(/^https?:\/\//, '')}</code>.</p>
        </div>
        <nav className="site-footer-links" aria-label="More">
          <a href={server.appUrl}>Get the app</a>
          <a href={server.sourceUrl} rel="noopener noreferrer">Source on GitHub</a>
          <a href="/sitemap.xml">Sitemap</a>
          {server.privacyUrl && <a href={server.privacyUrl}>Privacy</a>}
          {server.legalUrl && <a href={server.legalUrl}>Legal notice</a>}
        </nav>
      </div>
      <div className="oc-wrap site-footer-legal">
        <span>Powered by OpenCourse{server.version ? ` ${server.version}` : ''} · MIT licensed</span>
        {server.registration === 'closed' && <span>This server is not accepting new accounts.</span>}
      </div>
    </footer>
  )
}

/** Every page's frame: the glass header, the page, the footer. */
export function Layout() {
  useSearchShortcut()
  const main = useRef<HTMLElement>(null)
  const first = useRef(true)
  const { pathname } = useLocation()
  useEffect(() => pointerGlow(), [])
  // After a navigation, focus moves into the new page - unless the page put it
  // somewhere itself (a sign-in form's first field) - so a keyboard or screen
  // reader user starts there rather than on the link they left.
  useEffect(() => {
    if (first.current) { first.current = false; return }
    if (!main.current?.contains(document.activeElement)) main.current?.focus({ preventScroll: true })
  }, [pathname])
  return (
    <div className="site">
      <a className="skip-link" href="#main">Skip to content</a>
      <Header />
      <main id="main" ref={main} tabIndex={-1} className="site-main">
        <Outlet />
      </main>
      <Footer />
      <ScrollRestoration />
    </div>
  )
}
