// Replays the bars: sequential ones start in turn, concurrent ones together.
const play = () => {
  document.body.classList.remove('run')
  void document.body.offsetWidth
  document.body.classList.add('run')
}
document.getElementById('replay').addEventListener('click', play)
play()
