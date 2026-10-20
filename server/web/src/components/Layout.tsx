import { useEffect, useRef, useState } from 'react'
import { Link, NavLink, Outlet, ScrollRestoration, useLocation, useNavigate, useNavigation, useSearchParams } from 'react-router'
import { BookOpen, ChevronDown, Download, LogOut, Search, Settings } from 'lucide-react'
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
        { key: 'courses', label: 'My publications', icon: <BookOpen aria-hidden />, onSelect: () => navigate('/me/courses', { viewTransition: true }) },
        { key: 'settings', label: 'Settings', icon: <Settings aria-hidden />, onSelect: () => navigate('/settings', { viewTransition: true }) },
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
  const atCatalog = pathname === '/' || pathname === '/documents' || pathname.startsWith('/learn/')
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
          <NavLink to="/" end viewTransition>Courses</NavLink>
          <NavLink to="/documents" viewTransition>Documents</NavLink>
          {account && <NavLink to="/learning" viewTransition>My learning</NavLink>}
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

/** GitHub's mark; lucide no longer ships brand icons. */
function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
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
          <a href={server.appUrl}><Download aria-hidden="true" />Get the app</a>
          <a href={server.sourceUrl} rel="noopener noreferrer"><GitHubMark />GitHub</a>
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
