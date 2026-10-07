/** The server owns speech boundaries, interruptions and automatic replies. */
export const COACH_TURN_DETECTION = {
  type: 'semantic_vad', eagerness: 'low', create_response: true, interrupt_response: true
} as const

export const COACH_MICROPHONE_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: { exact: true }, noiseSuppression: true, autoGainControl: true
}

/** Prefer cancellation of all playback where Chromium exposes that mode. */
export async function configureEchoCancellation(track: MediaStreamTrack): Promise<void> {
  const capabilities = track.getCapabilities?.() as { echoCancellation?: (boolean | string)[] } | undefined
  if (capabilities?.echoCancellation?.includes('all')) {
    try {
      // Older TypeScript DOM definitions only describe the boolean modes.
      await track.applyConstraints({ echoCancellation: { exact: 'all' } } as unknown as MediaTrackConstraints)
    } catch {
      // Mandatory boolean cancellation was already requested at capture. A
      // device refusing the extended mode can keep using that baseline.
    }
  }
  if (track.getSettings?.().echoCancellation === false) {
    throw new Error('Echo cancellation could not be enabled on this microphone.')
  }
}
