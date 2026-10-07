/**
 * Every refusal is `{ error: { code, message } }` with an HTTP status. The code
 * is for the app to branch on, the message is for a person, and neither ever
 * says more than the caller is entitled to know - a failed login does not say
 * which half was wrong.
 */
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message)
  }
}

export const badRequest = (code: string, message: string, extra?: Record<string, unknown>): ApiError => new ApiError(400, code, message, extra)
export const unauthorized = (message = 'Sign in again.'): ApiError => new ApiError(401, 'unauthorized', message)
export const forbidden = (code: string, message: string): ApiError => new ApiError(403, code, message)
export const notFound = (message = 'Not found.'): ApiError => new ApiError(404, 'not_found', message)
export const conflict = (code: string, message: string, extra?: Record<string, unknown>): ApiError => new ApiError(409, code, message, extra)
export const tooMany = (message = 'Too many attempts. Wait a few minutes and try again.'): ApiError => new ApiError(429, 'rate_limited', message)
