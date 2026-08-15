/** Static Post V1 contract, independent from connection-specific availability. */
export const POST_V1_PLATFORM_CONTRACT_VERSION = '1' as const;

export const POST_V1_PUBLIC_PLATFORMS = [
  'twitter', 'instagram', 'tiktok', 'youtube', 'facebook', 'linkedin', 'bluesky', 'threads',
  'reddit', 'pinterest', 'telegram', 'snapchat', 'google_business', 'discord', 'slack',
] as const;

export type PostV1Platform = typeof POST_V1_PUBLIC_PLATFORMS[number];
export type PostV1Mode = 'publish_now' | 'schedule' | 'draft';

export interface PostV1PlatformContract {
  platform: PostV1Platform;
  text: {
    defaultLimit: number;
    limit: number;
  };
  supportedModes: readonly PostV1Mode[];
  /** P1 deliberately defines no media support while Post V1 is text-only. */
  media: readonly [];
}

const modes = ['publish_now', 'schedule', 'draft'] as const;
const noMedia = [] as const;

function textContract(platform: PostV1Platform, limit: number): PostV1PlatformContract {
  return { platform, text: { defaultLimit: limit, limit }, supportedModes: modes, media: noMedia };
}

export const POST_V1_PLATFORM_CONTRACTS: readonly PostV1PlatformContract[] = [
  textContract('twitter', 280),
  textContract('instagram', 2_200),
  textContract('tiktok', 2_200),
  textContract('youtube', 5_000),
  textContract('facebook', 63_206),
  textContract('linkedin', 3_000),
  textContract('bluesky', 300),
  textContract('threads', 500),
  textContract('reddit', 40_000),
  textContract('pinterest', 500),
  textContract('telegram', 4_096),
  textContract('snapchat', 10_000),
  textContract('google_business', 1_500),
  textContract('discord', 2_000),
  textContract('slack', 40_000),
] as const;

export function getPostV1PlatformContract(platform: PostV1Platform): PostV1PlatformContract {
  const contract = POST_V1_PLATFORM_CONTRACTS.find((candidate) => candidate.platform === platform);
  if (!contract) throw new Error(`Unknown Post V1 platform: ${platform}`);
  return contract;
}
