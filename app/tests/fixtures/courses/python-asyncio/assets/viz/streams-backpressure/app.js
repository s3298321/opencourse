// The writer adds 5 units a tick; the reader drains `speed`. Above the mark,
// the writer pauses on `await drain()` until the reader catches up.
let level = 0
let paused = false
const speed = document.getElementById('speed')
setInterval(() => {
  if (!paused) level += 5
  level = Math.max(0, level - Number(speed.value))
  if (level >= 70) paused = true
  if (paused && level <= 35) paused = false
  document.getElementById('level').style.width = `${Math.min(level, 100)}%`
  document.getElementById('state').textContent = paused ? 'The writer is paused in drain().' : 'The writer is writing.'
}, 200)
