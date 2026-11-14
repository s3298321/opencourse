/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/** Browser-side stand-in for OpenAI. Exercises actual WebRTC media and data channels. */
export async function answerDictationOffer(sdp: string): Promise<string> {
  const peer = new RTCPeerConnection()
  peer.ondatachannel = ({ channel }) => {
    const send = (kind: string, text: string) => channel.send(JSON.stringify({
      type: 'conversation.item.input_audio_transcription.' + kind, item_id: 'first',
      ...(kind === 'delta' ? { delta: text } : { transcript: text })
    }))
    channel.onopen = () => send('delta', 'Check my draft')
    channel.onmessage = ({ data }) => {
      if (JSON.parse(data).type === 'input_audio_buffer.commit') send('completed', 'Check my draft.')
    }
    channel.onclose = () => peer.close()
  }
  await peer.setRemoteDescription({ type: 'offer', sdp })
  await peer.setLocalDescription(await peer.createAnswer())
  if (peer.iceGatheringState !== 'complete') await new Promise<void>(resolve => {
    const timeout = setTimeout(resolve, 2500)
    peer.onicegatheringstatechange = () => {
      if (peer.iceGatheringState === 'complete') { clearTimeout(timeout); resolve() }
    }
  })
  return peer.localDescription!.sdp
}
