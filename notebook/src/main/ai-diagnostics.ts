import { AsyncLocalStorage } from 'node:async_hooks'
export interface RequestDiagnostics { mode: string; chatId: string; turnSeq?: number; request?: number; kind?: 'answer' | 'title' }
export const requestDiagnostics = new AsyncLocalStorage<RequestDiagnostics>()
