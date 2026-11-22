import { ref, getDownloadURL, getBlob, uploadBytes, listAll } from 'firebase/storage';
import { storage, isFirebaseConfigured } from '../firebase/config';

// In-memory cache of resolved URLs so we don't repeatedly query Firebase Storage
const resolvedUrlCache = new Map<string, string>();
const loggedStorageErrors = new Set<string>();

export interface StorageImageResolution {
  url: string | null;
  errorCode: string | null;
}

function isDirectWebUrl(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    lower.startsWith('http://') ||
    lower.startsWith('https://') ||
    lower.startsWith('data:image/') ||
    lower.startsWith('blob:')
  );
}

function isLocalDeviceUri(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    lower.startsWith('content://') ||
    lower.startsWith('file://') ||
    lower.startsWith('android.resource://')
  );
}

function normalizeStoragePath(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('gs://')) {
    const withoutScheme = trimmed.slice(5);
    const slashIdx = withoutScheme.indexOf('/');
    return slashIdx >= 0 ? withoutScheme.slice(slashIdx + 1).replace(/^\/+/, '') : '';
  }
  return trimmed.replace(/^\/+/, '');
}

function extractStorageErrorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err && typeof (err as any).code === 'string') {
    return (err as any).code;
  }
  const msg = err instanceof Error ? err.message : String(err || '');
  if (msg.includes('unauthorized') || msg.includes('403') || msg.includes('permission')) {
    return 'storage/unauthorized';
  }
  if (msg.includes('object-not-found') || msg.includes('404')) {
    return 'storage/object-not-found';
  }
  return 'storage/unknown';
}

async function fetchStorageRefUrl(path: string): Promise<{ url: string | null; errorCode: string | null }> {
  if (!isFirebaseConfigured || !storage || !path) {
    return { url: null, errorCode: null };
  }

  if (resolvedUrlCache.has(path)) {
    return { url: resolvedUrlCache.get(path) || null, errorCode: null };
  }

  const storageRef = ref(storage, path);

  try {
    const downloadUrl = await getDownloadURL(storageRef);
    resolvedUrlCache.set(path, downloadUrl);
    return { url: downloadUrl, errorCode: null };
  } catch (urlErr) {
    const code = extractStorageErrorCode(urlErr);

    // If getDownloadURL fails for reasons other than missing object or unauthorized (e.g. token missing), try getBlob
    if (code !== 'storage/object-not-found' && code !== 'storage/unauthorized') {
      try {
        const blob = await getBlob(storageRef);
        const objectUrl = URL.createObjectURL(blob);
        resolvedUrlCache.set(path, objectUrl);
        return { url: objectUrl, errorCode: null };
      } catch (blobErr) {
        const blobCode = extractStorageErrorCode(blobErr);
        return { url: null, errorCode: blobCode };
      }
    }

    if (!loggedStorageErrors.has(`${code}:${path}`) && code === 'storage/unauthorized') {
      loggedStorageErrors.add(`${code}:${path}`);
      console.warn(`Firebase Storage access denied (${code}) for path: ${path}`);
    }

    return { url: null, errorCode: code };
  }
}

/**
 * Resolves an image path or URL from Firestore into a displayable URL along with any Storage error code.
 */
export async function resolveStorageImageDetailed(
  rawUrlOrPath?: string | null,
  fallbackFolders?: string[]
): Promise<StorageImageResolution> {
  let lastErrorCode: string | null = null;

  if (rawUrlOrPath && typeof rawUrlOrPath === 'string') {
    const trimmed = rawUrlOrPath.trim();
    if (trimmed && !isLocalDeviceUri(trimmed)) {
      if (isDirectWebUrl(trimmed)) {
        return { url: trimmed, errorCode: null };
      }

      // First try gs:// verbatim if provided, then stripped relative path
      if (trimmed.startsWith('gs://') && isFirebaseConfigured && storage) {
        try {
          const gsRef = ref(storage, trimmed);
          const url = await getDownloadURL(gsRef);
          resolvedUrlCache.set(trimmed, url);
          return { url, errorCode: null };
        } catch (err) {
          lastErrorCode = extractStorageErrorCode(err);
        }
      }

      const normalizedPath = normalizeStoragePath(trimmed);
      if (normalizedPath) {
        const res = await fetchStorageRefUrl(normalizedPath);
        if (res.url) return { url: res.url, errorCode: null };
        if (res.errorCode) lastErrorCode = res.errorCode;
      }
    }
  }

  // Try Firebase Storage fallback paths/folders
  if (isFirebaseConfigured && storage && fallbackFolders && fallbackFolders.length > 0) {
    for (const rawCandidate of fallbackFolders) {
      if (!rawCandidate) continue;
      const candidate = normalizeStoragePath(rawCandidate);
      if (!candidate) continue;

      if (resolvedUrlCache.has(candidate)) {
        return { url: resolvedUrlCache.get(candidate) || null, errorCode: null };
      }

      // Direct file candidate (contains file extension)
      if (/\.(jpe?g|png|webp|gif)$/i.test(candidate) || candidate.includes('.')) {
        const res = await fetchStorageRefUrl(candidate);
        if (res.url) return { url: res.url, errorCode: null };
        if (res.errorCode === 'storage/unauthorized') {
          lastErrorCode = 'storage/unauthorized';
        } else if (!lastErrorCode && res.errorCode) {
          lastErrorCode = res.errorCode;
        }
      } else {
        // Folder candidate: list files inside folder
        try {
          const folderRef = ref(storage, candidate);
          const listResult = await listAll(folderRef);
          if (listResult.items.length > 0) {
            const url = await getDownloadURL(listResult.items[0]);
            resolvedUrlCache.set(candidate, url);
            return { url, errorCode: null };
          }
        } catch (err) {
          const code = extractStorageErrorCode(err);
          if (code === 'storage/unauthorized' && !lastErrorCode) {
            lastErrorCode = 'storage/unauthorized';
          }
        }
      }
    }
  }

  return { url: null, errorCode: lastErrorCode };
}

/**
 * Resolves an image path or URL from Firestore into a displayable URL.
 */
export async function resolveStorageImageUrl(
  rawUrlOrPath?: string | null,
  fallbackFolders?: string[]
): Promise<string | null> {
  const res = await resolveStorageImageDetailed(rawUrlOrPath, fallbackFolders);
  return res.url;
}

/**
 * Compresses an image file to a compact JPEG Data URL as an offline/rules fallback
 * so it fits comfortably within Firestore's 1MB document limit.
 */
function compressImageToDataUrl(file: File, maxDimension = 640, quality = 0.78): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxDimension / Math.max(img.width, img.height));
        const width = Math.max(1, Math.round(img.width * scale));
        const height = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(String(reader.result));
          return;
        }
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => resolve(String(reader.result));
      img.src = String(reader.result);
    };
    reader.onerror = (error) => reject(error);
    reader.readAsDataURL(file);
  });
}

/**
 * Uploads an image file to Firebase Storage and returns its download URL.
 * Falls back to a compressed JPEG Data URL if Storage rules/network block direct upload.
 */
export async function uploadImageToFirebaseStorage(
  file: File,
  storagePath: string
): Promise<string> {
  const cleanPath = normalizeStoragePath(storagePath);

  if (isFirebaseConfigured && storage && cleanPath) {
    try {
      const fileRef = ref(storage, cleanPath);
      await uploadBytes(fileRef, file, {
        contentType: file.type || 'image/jpeg',
      });
      const downloadUrl = await getDownloadURL(fileRef);
      resolvedUrlCache.set(cleanPath, downloadUrl);
      return downloadUrl;
    } catch (err) {
      console.warn('Firebase Storage upload fallback to compressed Data URL:', err);
    }
  }

  return compressImageToDataUrl(file);
}
