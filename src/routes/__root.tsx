import {
  createRootRoute,
  HeadContent,
  Outlet,
  Scripts,
} from '@tanstack/react-router'
import { AppShell } from '../components/app-shell'
import '../styles.css'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { name: 'theme-color', content: '#f5f3ed' },
      { title: 'Mealio' },
    ],
  }),
  component: RootDocument,
})

function RootDocument() {
  return (
    <html lang="it">
      <head>
        <HeadContent />
      </head>
      <body>
        <AppShell><Outlet /></AppShell>
        <Scripts />
      </body>
    </html>
  )
}
