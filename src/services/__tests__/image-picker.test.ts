import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { formatImageContent, pickImageForChat } from '../image-picker';

const launch = ImagePicker.launchImageLibraryAsync as unknown as jest.Mock;
const readAsString = FileSystem.readAsStringAsync as unknown as jest.Mock;

function pickerResult(assetOverrides: Record<string, unknown> = {}): ImagePicker.ImagePickerResult {
  return {
    canceled: false,
    assets: [
      {
        uri: 'file:///photos/photo.heic',
        width: 100,
        height: 100,
        base64: 'QUJD',
        mimeType: undefined as unknown as string,
        assetId: null,
        fileName: null,
        exif: null,
        duration: null,
        fileExtension: null,
        fileSize: null,
        pairedVideoAsset: null,
        type: 'image',
        ...assetOverrides,
      },
    ],
  } as unknown as ImagePicker.ImagePickerResult;
}

describe('formatImageContent (§2.9 — KR-17, wire-verified smoke #8 format)', () => {
  it('formats [{role:user, content:[text + image_url(data-URL)]}] — the exact /v1/runs payload', () => {
    expect(formatImageContent('What is this?', 'data:image/jpeg;base64,QUJD')).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is this?' },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } },
        ],
      },
    ]);
  });
});

describe('pickImageForChat (§2.9 — guards + data-URL assembly)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('canceled → null', async () => {
    launch.mockResolvedValueOnce({ canceled: true });
    await expect(pickImageForChat()).resolves.toBeNull();
  });

  it('no asset → null (noUncheckedIndexedAccess guard)', async () => {
    launch.mockResolvedValueOnce({ canceled: false, assets: [] });
    await expect(pickImageForChat()).resolves.toBeNull();
  });

  it('mimeType: picker mimeType wins; missing → .png URI → image/png, else image/jpeg', async () => {
    launch.mockResolvedValueOnce(pickerResult({ mimeType: 'image/webp' }));
    await expect(pickImageForChat()).resolves.toBe('data:image/webp;base64,QUJD');

    const base = pickerResult().assets![0]!;
    launch.mockResolvedValueOnce({ ...pickerResult(), assets: [{ ...base, uri: 'file:///x.PNG', base64: null }] });
    readAsString.mockResolvedValueOnce('UE5H');
    await expect(pickImageForChat()).resolves.toBe('data:image/png;base64,UE5H');

    launch.mockResolvedValueOnce({ ...pickerResult(), assets: [{ ...base, uri: 'file:///x.jpg', base64: null }] });
    readAsString.mockResolvedValueOnce('SkVQRw');
    await expect(pickImageForChat()).resolves.toBe('data:image/jpeg;base64,SkVQRw');
  });

  it('picker base64 absent → readAsStringAsync fallback (expo-file-system legacy)', async () => {
    launch.mockResolvedValueOnce({
      ...pickerResult(),
      assets: [{ ...pickerResult().assets![0]!, base64: undefined as unknown as string }],
    });
    readAsString.mockResolvedValueOnce('RkFMTEJBQ0s=');
    await expect(pickImageForChat()).resolves.toBe('data:image/jpeg;base64,RkFMTEJBQ0s=');
    expect(readAsString).toHaveBeenCalledWith(
      'file:///photos/photo.heic',
      { encoding: FileSystem.EncodingType.Base64 },
    );
  });

  it('picker inlines base64 → file-system never called', async () => {
    launch.mockResolvedValueOnce(pickerResult());
    await expect(pickImageForChat()).resolves.toBe('data:image/jpeg;base64,QUJD');
    expect(readAsString).not.toHaveBeenCalled();
  });
});
