import { signalCode, startManaged } from './managed-process.mjs'

const args = process.argv.slice(2)
let timeoutMs = 0
if (args[0] === '--timeout-ms') {
  args.shift()
  timeoutMs = Number(args.shift())
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    console.error('--timeout-ms must be a positive integer')
    process.exit(2)
  }
}
if (args[0] === '--') args.shift()
const command = args.shift()
if (!command) {
  console.error('Usage: node scripts/run-managed.mjs [--timeout-ms N] -- command [args...]')
  process.exit(2)
}

const managed = startManaged(command, args, { stdio: 'inherit', timeoutMs })
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => managed.stop(signalCode(signal)))
}
process.exitCode = await managed.finished
