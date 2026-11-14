import { isCoachVoice, VOICE_LANGUAGES } from './models'

const samples = {
  English: 'Hello! What would you like to learn today? Let’s start with an example.',
  French: 'Bonjour ! Qu’aimeriez-vous apprendre aujourd’hui ? Commençons par un exemple.',
  German: 'Hallo! Was möchten Sie heute lernen? Beginnen wir mit einem Beispiel.',
  'Brazilian Portuguese': 'Olá! O que você gostaria de aprender hoje? Vamos começar com um exemplo.',
  Hindi: 'नमस्ते! आज आप क्या सीखना चाहेंगे? चलिए, एक उदाहरण से शुरू करते हैं।',
  Japanese: 'こんにちは。今日は何を学びたいですか？まずは例を一つ見てみましょう。',
  Korean: '안녕하세요! 오늘은 무엇을 배우고 싶으세요? 예시를 하나 살펴볼까요?'
}

export function voicePreviewInstructions(voice: string): string {
  if (!isCoachVoice(voice)) throw new Error('Choose a supported coach voice.')
  const language = VOICE_LANGUAGES[voice]
  return `This is a short voice preview. Speak in ${language}. Begin immediately. Read the following passage aloud exactly once, then stay silent: "${samples[language]}"`
}

export const VOICE_PREVIEW_MS = 12_000
