import React, { useState, useEffect } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { auth, isFirebaseConfigured } from '../../firebase/config';
import { resolveStorageImageDetailed } from '../../utils/storageUtils';

interface FirebaseImageProps {
  src?: string | null;
  fallbackStoragePaths?: string[];
  alt: string;
  className?: string;
  fallbackContent: React.ReactNode;
  onClick?: () => void;
  onErrorCode?: (code: string | null) => void;
}

export const FirebaseImage: React.FC<FirebaseImageProps> = ({
  src,
  fallbackStoragePaths,
  alt,
  className = 'w-10 h-10 rounded-xl',
  fallbackContent,
  onClick,
  onErrorCode,
}) => {
  const [resolvedUrl, setResolvedUrl] = useState<string | null>(null);
  const [hasError, setHasError] = useState(false);
  const [triedFallbackPaths, setTriedFallbackPaths] = useState(false);
  const [authUid, setAuthUid] = useState<string>(() => auth?.currentUser?.uid || '');

  const fallbackKey = fallbackStoragePaths?.join('|') || '';

  useEffect(() => {
    if (!isFirebaseConfigured || !auth) return;
    const unsub = onAuthStateChanged(auth, (fbUser) => {
      setAuthUid(fbUser?.uid || '');
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    let isMounted = true;
    setHasError(false);
    setTriedFallbackPaths(false);

    resolveStorageImageDetailed(src, fallbackStoragePaths).then((res) => {
      if (!isMounted) return;
      setResolvedUrl(res.url);
      if (onErrorCode) {
        onErrorCode(res.url ? null : res.errorCode);
      }
    });

    return () => {
      isMounted = false;
    };
  }, [src, fallbackKey, authUid]);

  const handleImageError = () => {
    if (!triedFallbackPaths && fallbackStoragePaths && fallbackStoragePaths.length > 0) {
      setTriedFallbackPaths(true);
      resolveStorageImageDetailed(null, fallbackStoragePaths).then((res) => {
        if (res.url && res.url !== resolvedUrl) {
          setResolvedUrl(res.url);
          setHasError(false);
          if (onErrorCode) onErrorCode(null);
        } else {
          setHasError(true);
          if (onErrorCode) onErrorCode(res.errorCode);
        }
      });
      return;
    }
    setHasError(true);
  };

  if (!resolvedUrl || hasError) {
    return (
      <div
        onClick={onClick}
        className={`${className} flex items-center justify-center shrink-0 overflow-hidden ${
          onClick ? 'cursor-pointer' : ''
        }`}
      >
        {fallbackContent}
      </div>
    );
  }

  return (
    <img
      src={resolvedUrl}
      alt={alt}
      onClick={onClick}
      onError={handleImageError}
      referrerPolicy="no-referrer"
      className={`${className} object-cover shrink-0 ${
        onClick ? 'cursor-pointer hover:opacity-90 transition-opacity' : ''
      }`}
    />
  );
};
