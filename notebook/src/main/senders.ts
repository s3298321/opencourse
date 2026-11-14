import type { WebContents } from 'electron'

/**
 * Calls `gone` when a renderer stops waiting for work it asked for: the window
 * closed, its process died, or it reloaded or navigated the main frame to
 * another document. Returns the function that unbinds it.
 *
 * Not `did-start-loading`: that fires whenever any frame of the page starts
 * loading - a visualization's iframe, even a `history.pushState` - so work
 * bound to it was cancelled by the window simply showing a lesson with a
 * visualization in it, and a generated title vanished without a trace.
 */
export function whenSenderGone(sender: WebContents, gone: () => void): () => void {
  const navigated = (event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>): void => {
    if (event.isMainFrame && !event.isSameDocument) gone()
  }
  sender.once('destroyed', gone)
  sender.once('render-process-gone', gone)
  sender.on('did-start-navigation', navigated)
  return () => {
    sender.removeListener('destroyed', gone)
    sender.removeListener('render-process-gone', gone)
    sender.removeListener('did-start-navigation', navigated)
  }
}
