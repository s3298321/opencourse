import { loadConfig } from './config'
import { buildApp } from './app'

const config = loadConfig()
const { app } = await buildApp({ config })
if (config.dev) app.log.warn('Development server: sign-up codes are printed here and served at /dev/outbox. Never expose this to a network.')
await app.listen({ port: config.port, host: config.host })
app.log.info(`${config.name} at ${config.publicUrl}`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void app.close().then(() => process.exit(0)) })
}
