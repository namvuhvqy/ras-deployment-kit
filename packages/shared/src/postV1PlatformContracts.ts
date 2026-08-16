/** Static Post V1 contract, independent from connection-specific availability. */
export const POST_V1_PLATFORM_CONTRACT_VERSION = '1' as const;

export const POST_V1_PUBLIC_PLATFORMS = [
  'twitter', 'instagram', 'tiktok', 'youtube', 'facebook', 'linkedin', 'bluesky', 'threads',
  'reddit', 'pinterest', 'telegram', 'snapchat', 'google_business', 'discord', 'slack',
] as const;

export type PostV1Platform = typeof POST_V1_PUBLIC_PLATFORMS[number];
export type PostV1Mode = 'publish_now' | 'schedule' | 'draft';

export type PostV1PlatformSetting =
  | { key: 'title'; type: 'string'; maxLength: 100 }
  | { key: 'visibility'; type: 'enum'; values: readonly ['public', 'unlisted', 'private'] }
  | { key: 'madeForKids'; type: 'boolean' }
  | { key: 'privacyLevel'; type: 'enum'; values: readonly ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'SELF_ONLY'] };

export interface PostV1PlatformContract {
  platform: PostV1Platform;
  text: {
    defaultLimit: number;
    limit: number;
  };
  supportedModes: readonly PostV1Mode[];
  /** P1 deliberately defines no media support while Post V1 is text-only. */
  media: readonly [];
  /** P2 is a static, public allowlist; empty means settings are unsupported. */
  platformSpecificData: readonly PostV1PlatformSetting[];
}

const modes = ['publish_now', 'schedule', 'draft'] as const;
const noMedia = [] as const;
const noSettings = [] as const;
const youtubeSettings = [
  { key: 'title', type: 'string', maxLength: 100 },
  { key: 'visibility', type: 'enum', values: ['public', 'unlisted', 'private'] },
  { key: 'madeForKids', type: 'boolean' },
] as const;
const tiktokSettings = [{ key: 'privacyLevel', type: 'enum', values: ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'SELF_ONLY'] }] as const;

function textContract(platform: PostV1Platform, limit: number, platformSpecificData: readonly PostV1PlatformSetting[] = noSettings): PostV1PlatformContract {
  return { platform, text: { defaultLimit: limit, limit }, supportedModes: modes, media: noMedia, platformSpecificData };
}

export const POST_V1_PLATFORM_CONTRACTS: readonly PostV1PlatformContract[] = [
  textContract('twitter', 280),
  textContract('instagram', 2_200),
  textContract('tiktok', 2_200, tiktokSettings),
  textContract('youtube', 5_000, youtubeSettings),
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

export function getPostV1PlatformSettings(platform: PostV1Platform): readonly PostV1PlatformSetting[] {
  return getPostV1PlatformContract(platform).platformSpecificData;
}

/** Returns a normalized typed object or undefined; absent settings are rejected fail-closed. */
export function validatePostV1PlatformSpecificData(platform: PostV1Platform, value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const settings = getPostV1PlatformSettings(platform);
  if (settings.length === 0 || Object.keys(input).length === 0) return undefined;
  for (const [key, candidate] of Object.entries(input)) {
    const setting = settings.find((candidateSetting) => candidateSetting.key === key);
    if (!setting) return undefined;
    if (setting.type === 'string' && (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > setting.maxLength)) return undefined;
    if (setting.type === 'boolean' && typeof candidate !== 'boolean') return undefined;
    if (setting.type === 'enum' && (typeof candidate !== 'string' || !setting.values.includes(candidate as never))) return undefined;
  }
  return Object.fromEntries(Object.entries(input).sort(([left], [right]) => left.localeCompare(right)));
}
