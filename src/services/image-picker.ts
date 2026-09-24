import * as ImagePicker from 'expo-image-picker';
import { readAsStringAsync, EncodingType } from 'expo-file-system/legacy';
import type { RunCreateRequest } from './gateway-api';

/**
 * Pick image from camera roll and convert to base64 data URL.
 * Used for sending photos in chat (KR-17).
 */
export async function pickImageForChat(): Promise<string | null> {
  const result = await ImagePicker.launchImageLibraryAsync({
    // SDK 57: MediaTypeOptions enum is deprecated — array form is current.
    mediaTypes: ['images'],
    quality: 0.8, // compress for network
    base64: true,
  });

  if (result.canceled || !result.assets[0]) return null;

  const asset = result.assets[0];

  // Read as base64 if the picker didn't inline it
  let base64 = asset.base64;
  if (!base64) {
    base64 = await readAsStringAsync(asset.uri, {
      encoding: EncodingType.Base64,
    });
  }

  // Prefer the picker's mimeType when provided (livePhotos etc.);
  // otherwise derive from URI extension.
  const mimeType = asset.mimeType
    ?? (asset.uri.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg');

  // Return as data URL (KR-17 format)
  return `data:${mimeType};base64,${base64}`;
}

/**
 * Format image for /v1/runs input (KR-17a, wire-verified smoke-test #8).
 * input:[{role:"user", content:[text + image_url]}]
 */
export function formatImageContent(
  text: string,
  dataUrl: string,
): RunCreateRequest['input'] {
  return [{
    role: 'user',
    content: [
      { type: 'text', text },
      { type: 'image_url', image_url: { url: dataUrl } },
    ],
  }];
}
