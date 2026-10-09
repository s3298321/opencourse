// Three lines of C, and what each does to two boxes of memory.
const lines = [
  { code: 'int x = 7;', x: '7', p: '?', hot: 'x' },
  { code: 'int *p = &x;', x: '7', p: '0x1000', hot: 'p' },
  { code: '*p = 42;', x: '42', p: '0x1000', hot: 'x' }
]
let at = 0
const show = () => {
  const line = lines[at]
  const cell = (name, value, address) => {
    const el = document.createElement('div')
    el.className = 'cell' + (line.hot === name ? ' hot' : '')
    el.append(Object.assign(document.createElement('b'), { textContent: name + ' = ' + value }), Object.assign(document.createElement('small'), { textContent: 'at ' + address }))
    return el
  }
  document.getElementById('cells').replaceChildren(cell('x', line.x, '0x1000'), cell('p', line.p, '0x1008'))
  document.getElementById('note').textContent = line.code
}
document.getElementById('next').addEventListener('click', () => { at = (at + 1) % lines.length; show() })
show()
