/// <reference types="vite/client" />
import type { OpenCourseApi } from '../preload'

declare global {
  interface Window {
    opencourse: OpenCourseApi
  }
}

export {}
