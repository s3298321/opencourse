export const NETWORK_RETRIES = 5
export function networkRetryWarning(attempt: number): string {
  return `Connection interrupted. Reconnecting (retry ${attempt} of ${NETWORK_RETRIES})…`
}
export type ChatRecoveryEvent = { kind: 'retry'; attempt: number | null } | { kind: 'replace'; text: string }
