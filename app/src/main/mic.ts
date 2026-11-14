/** The main process grants one capture lease to its originating window. */
let owner: number | null = null

export function wantsMic(sender?: number): boolean {
  return owner !== null && (sender === undefined || owner === sender)
}

export function holdMic(sender: number): () => void {
  if (owner !== null) throw new Error('Stop the current dictation or coaching session first.')
  owner = sender
  let released = false
  return () => {
    if (released) return
    released = true
    owner = null
  }
}
