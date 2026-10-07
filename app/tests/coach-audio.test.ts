import { describe, expect, it, vi } from 'vitest'
import { COACH_MICROPHONE_CONSTRAINTS, COACH_TURN_DETECTION, configureEchoCancellation } from '@core/coach/audio'

function track(modes: (boolean | string)[], enabled = true) {
  return {
    getCapabilities: () => ({ echoCancellation: modes }),
    getSettings: () => ({ echoCancellation: enabled }),
    applyConstraints: vi.fn().mockResolvedValue(undefined)
  }
}

describe('continuous coach audio', () => {
  it('requires acoustic echo cancellation at capture and delegates turns to semantic VAD', () => {
    expect(COACH_MICROPHONE_CONSTRAINTS.echoCancellation).toEqual({ exact: true })
    expect(COACH_TURN_DETECTION).toEqual({
      type: 'semantic_vad', eagerness: 'low', create_response: true, interrupt_response: true
    })
  })

  it('selects cancellation of all playback when the microphone supports it', async () => {
    const mic = track([true, false, 'all', 'remote-only'])
    await configureEchoCancellation(mic as unknown as MediaStreamTrack)
    expect(mic.applyConstraints).toHaveBeenCalledWith({ echoCancellation: { exact: 'all' } })
  })

  it('preserves mandatory boolean cancellation on devices without extended modes', async () => {
    const mic = track([true, false])
    await configureEchoCancellation(mic as unknown as MediaStreamTrack)
    expect(mic.applyConstraints).not.toHaveBeenCalled()
  })

  it('retains baseline cancellation if the device refuses its advertised all mode', async () => {
    const mic = track([true, false, 'all'])
    mic.applyConstraints.mockRejectedValue(new Error('unsupported mode'))
    await expect(configureEchoCancellation(mic as unknown as MediaStreamTrack)).resolves.toBeUndefined()
  })

  it('reports a device that returned a track with cancellation disabled', async () => {
    const mic = track([true, false], false)
    await expect(configureEchoCancellation(mic as unknown as MediaStreamTrack)).rejects.toThrow('Echo cancellation')
  })
})
