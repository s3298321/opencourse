import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import NotebookWindow from './writing-notebooks/NotebookWindow'
import './writing-notebooks/writing-notebooks.css'
import { ThemeProvider, bootTheme } from './theme/ThemeProvider'
import '@xterm/xterm/css/xterm.css'
import './styles.css'

// The applied theme goes on before the first render, so a reload never shows
// the default look for a frame. With nobody signed in yet this is a no-op.
void bootTheme().finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ThemeProvider>
        {new URLSearchParams(location.search).get('writingNotebook') ? <NotebookWindow id={new URLSearchParams(location.search).get('writingNotebook')!} /> : <App />}
      </ThemeProvider>
    </StrictMode>
  )
})
