/**
 * The web app of an OpenCourse server. Its pages are shared/pages.ts - the
 * table the server also reads - each mapped to its component and loader here.
 */
import '@fontsource-variable/inter/wght.css'
import '@design/tokens.css'
import '@design/base.css'
import '@design/motion.css'
import './styles/app.css'
import { StrictMode, type ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider, type LoaderFunction, type RouteObject } from 'react-router'
import { PAGES, type PageKey } from '@shared/pages'
import { Layout } from './components/Layout'
import { ToastProvider } from './components/Toasts'
import { CatalogFallback, CatalogPageView, catalogLoader } from './pages/Catalog'
import { CoursePage, courseLoader } from './pages/Course'
import { ForgotPage, SignInPage, SignUpPage } from './pages/Auth'
import { MyCoursePage, MyCoursesPage, myCourseLoader, myCoursesLoader } from './pages/MyCourses'
import { SettingsPage, settingsLoader } from './pages/Settings'
import { AdminAccounts, AdminAudit, AdminCourses, AdminLayout, AdminOverview, adminAccountsLoader, adminAuditLoader, adminCoursesLoader, adminStatsLoader } from './pages/admin/Admin'
import { NotFoundPage, RouteError } from './pages/Errors'
import { loadDevBoot } from './lib/boot'
import { resetSessionFromBoot } from './lib/session'

const VIEWS: Record<PageKey, { Component: ComponentType; loader?: LoaderFunction }> = {
  catalog: { Component: CatalogPageView, loader: catalogLoader },
  course: { Component: CoursePage, loader: courseLoader },
  signin: { Component: SignInPage },
  signup: { Component: SignUpPage },
  forgot: { Component: ForgotPage },
  myCourses: { Component: MyCoursesPage, loader: myCoursesLoader },
  myCourse: { Component: MyCoursePage, loader: myCourseLoader },
  settings: { Component: SettingsPage, loader: settingsLoader },
  admin: { Component: AdminOverview, loader: adminStatsLoader },
  adminAccounts: { Component: AdminAccounts, loader: adminAccountsLoader },
  adminCourses: { Component: AdminCourses, loader: adminCoursesLoader },
  adminAudit: { Component: AdminAudit, loader: adminAuditLoader }
}

const route = (key: PageKey, path: string): RouteObject => ({ path, ...VIEWS[key], errorElement: <RouteError /> })
const isAdmin = (path: string): boolean => path === '/admin' || path.startsWith('/admin/')

const routes: RouteObject[] = [{
  element: <Layout />,
  HydrateFallback: CatalogFallback,
  errorElement: <RouteError />,
  children: [
    ...PAGES.filter((page) => !isAdmin(page.path)).map((page) => route(page.key, page.path)),
    {
      path: '/admin',
      element: <AdminLayout />,
      errorElement: <RouteError />,
      children: PAGES.filter((page) => isAdmin(page.path)).map((page) => (
        page.path === '/admin' ? { index: true, ...VIEWS[page.key], errorElement: <RouteError /> } : route(page.key, page.path)
      ))
    },
    { path: '*', Component: NotFoundPage }
  ]
}]

await loadDevBoot()
resetSessionFromBoot()
const router = createBrowserRouter(routes)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <RouterProvider router={router} />
    </ToastProvider>
  </StrictMode>
)
