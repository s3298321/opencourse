import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { ThemeProvider, bootTheme } from './theme/ThemeProvider'
import '@xterm/xterm/css/xterm.css'
import './styles.css'

// The applied theme goes on before the first render, so a reload never shows
// the default look for a frame. With nobody signed in yet this is a no-op.
void bootTheme().finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </StrictMode>
  )
})
