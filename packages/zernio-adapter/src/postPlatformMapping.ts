import type { PostV1Platform } from '../../shared/src/postV1PlatformContracts.js';

/** Converts the sole normalized RAS identifier at the provider-wire boundary. */
export function toZernioPostPlatform(platform: PostV1Platform): string {
  return platform === 'google_business' ? 'googlebusiness' : platform;
}
