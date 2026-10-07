import pkg from '../package.json'

/** The server's own version, reported by /api/v1/server and on the web pages. */
export const SERVER_VERSION: string = pkg.version
