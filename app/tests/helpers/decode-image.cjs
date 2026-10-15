// Used only by the opt-in Node authoring harness, which otherwise mocks Electron.
const { app, BrowserWindow } = require('electron')
const { readFileSync } = require('node:fs')
const script = readFileSync(0, 'utf8')
const timer = setTimeout(() => app.exit(1), 5000)
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true } })
  try {
    await window.loadURL('data:text/html,' + encodeURIComponent('<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:">'))
    const size = await window.webContents.executeJavaScript(script)
    process.stdout.write(JSON.stringify(size))
    window.destroy(); clearTimeout(timer); app.quit()
  } catch (error) { console.error(error.message); app.exit(1) }
})
