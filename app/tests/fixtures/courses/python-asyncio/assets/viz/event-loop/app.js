// Six moments in the life of three tasks. Each press of Step shows the next,
// and the last one wraps round to the first.
const steps = [
  { ready: ['fetch("a")', 'fetch("b")', 'fetch("c")'], waiting: [], running: [], caption: 'Three tasks are created. None has run yet.' },
  { ready: ['fetch("b")', 'fetch("c")'], waiting: [], running: ['fetch("a")'], caption: 'The loop runs the first task until it reaches an await.' },
  { ready: ['fetch("c")'], waiting: ['fetch("a")'], running: ['fetch("b")'], caption: 'The first task waits on the network, so the loop moves on.' },
  { ready: [], waiting: ['fetch("a")', 'fetch("b")'], running: ['fetch("c")'], caption: 'Every task is now waiting or running. Nothing blocks.' },
  { ready: ['fetch("a")'], waiting: ['fetch("b")', 'fetch("c")'], running: [], caption: 'A reply arrives: the first task is ready again.' },
  { ready: [], waiting: [], running: [], caption: 'All three finish in about the time of the slowest one.' }
]
let at = 0
const fill = (id, items) => {
  const list = document.getElementById(id)
  list.replaceChildren(...items.map((text) => Object.assign(document.createElement('li'), { textContent: text })))
}
const show = () => {
  const step = steps[at]
  fill('ready', step.ready)
  fill('waiting', step.waiting)
  fill('running', step.running)
  document.getElementById('caption').textContent = step.caption
  document.getElementById('step-label').textContent = `Step ${at + 1} of ${steps.length}`
}
document.getElementById('step').addEventListener('click', () => {
  at = (at + 1) % steps.length
  show()
})
show()
