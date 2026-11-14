/** Local audio state: instruction acknowledgments and backend events cannot unmute it. */
export class PlaybackGate {
  muted = false
  speaking = false
  private learner = false
  private quietSince: number | null = null
  private ready = false
  private lastOutput = -Infinity

  interrupt(): void {
    this.muted = true
    this.speaking = false
    this.learner = false
    this.quietSince = null
    this.ready = false
  }

  sample(inputLevel: number, outputLevel: number, now: number): void {
    const output = outputLevel > 0.008
    if (output) this.lastOutput = now
    if (this.muted) {
      if (inputLevel > 0.015) this.learner = true
      if (!output) {
        this.quietSince ??= now
        if (this.learner && now - this.quietSince >= 300) this.ready = true
      } else {
        if (this.ready) this.muted = false
        this.quietSince = null
      }
    }
    this.speaking = !this.muted && now - this.lastOutput < 250
  }
}
