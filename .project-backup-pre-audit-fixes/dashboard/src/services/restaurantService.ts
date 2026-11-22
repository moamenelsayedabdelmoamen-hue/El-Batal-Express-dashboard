import {
  collection,
  doc,
  getDocs,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
} from 'firebase/firestore';
import { db, isFirebaseConfigured, handleFirestoreError, OperationType } from '../firebase/config';
import { COLLECTIONS } from './collections';
import { Restaurant, SubscriptionStatus } from '../types';
import { extractCoordinates, extractCoordinatesFromText, extractLocationUrl } from '../utils/geoUtils';

// Local cache for real data fetched from Firestore
let localRestaurantsCache: Restaurant[] = [];

function formatTimestamp(val: any): string {
  if (!val) return new Date().toISOString();
  if (typeof val?.toDate === 'function') {
    return val.toDate().toISOString();
  }
  if (typeof val === 'object' && typeof val.seconds === 'number') {
    return new Date(val.seconds * 1000).toISOString();
  }
  return String(val);
}

function pickFirstValidImage(candidates: unknown[]): string {
  for (const val of candidates) {
    if (typeof val === 'string') {
      const trimmed = val.trim();
      if (
        trimmed.length > 0 &&
        !trimmed.toLowerCase().startsWith('content://') &&
        !trimmed.toLowerCase().startsWith('file://') &&
        !trimmed.toLowerCase().startsWith('android.resource://')
      ) {
        return trimmed;
      }
    }
  }
  return '';
}

function normalizeMerchantSubStatus(rawStatus: any): SubscriptionStatus {
  const s = String(rawStatus || '').trim();
  const lower = s.toLowerCase();
  if (lower === 'active' || s === 'نشط' || s === 'ساري') return 'Active';
  if (lower === 'pending' || s === 'معلق' || s === 'قيد الانتظار') return 'Pending';
  if (lower === 'expired' || s === 'منتهي') return 'Expired';
  if (lower === 'suspended' || s === 'موقوف' || lower === 'inactive') return 'Suspended';
  return 'Active';
}

export function mapDocToRestaurant(
  id: string,
  data: Record<string, any>,
  sourceCollection: 'restaurants' | 'merchants' = 'restaurants'
): Restaurant {
  const logoPath = pickFirstValidImage([
    data.logoPath,
    data.logo_path,
    data.imagePath,
    data.image_path,
    data.merchantLogoPath,
    data.storeLogoPath,
  ]);

  const logo = pickFirstValidImage([
    data.logoUrl,
    data.logoURL,
    data.logo_url,
    data.logo,
    data.storeLogo,
    data.storeImage,
    data.merchantLogo,
    data.merchantImage,
    data.imageUrl,
    data.imageURL,
    data.image_url,
    data.image,
    data.photoURL,
    data.photoUrl,
    data.photo_url,
    data.avatar,
    data.icon,
    logoPath,
  ]);

  const ownerEmail =
    data.ownerEmail ||
    data.email ||
    data.merchantEmail ||
    data.storeEmail ||
    data.userEmail ||
    data.contactEmail ||
    '';

  const coords = extractCoordinates(data);
  const locationUrl = extractLocationUrl(data, coords);

  const subObj = typeof data.subscription === 'object' && data.subscription ? data.subscription : {};
  const rawSubStatus =
    data.subscriptionStatus ||
    data.subscription_status ||
    subObj.status ||
    'Active';

  const isActive =
    typeof data.isActive === 'boolean'
      ? data.isActive
      : typeof data.active === 'boolean'
      ? data.active
      : data.status
      ? ['active', 'نشط', 'approved', 'enabled', 'open'].includes(String(data.status).trim().toLowerCase())
      : typeof data.isApproved === 'boolean'
      ? data.isApproved
      : true;

  return {
    id,
    name:
      data.name ||
      data.nameAr ||
      data.merchantName ||
      data.storeName ||
      data.shopName ||
      data.restaurantName ||
      data.businessName ||
      data.displayName ||
      data.fullName ||
      data.title ||
      'بدون اسم',
    category:
      data.category ||
      data.businessType ||
      data.storeType ||
      data.merchantCategory ||
      data.cuisine ||
      data.type ||
      'عام',
    phone:
      data.phone ||
      data.phoneNumber ||
      data.phone_number ||
      data.mobile ||
      data.mobileNumber ||
      data.whatsapp ||
      data.hotline ||
      data.contact ||
      '—',
    rating:
      typeof data.rating === 'number'
        ? data.rating
        : typeof data.stars === 'number'
        ? data.stars
        : 5.0,
    subscriptionStatus: normalizeMerchantSubStatus(rawSubStatus),
    subscriptionPlan:
      data.subscriptionPlan ||
      data.plan ||
      subObj.plan ||
      undefined,
    subscriptionStartDate:
      data.subscriptionStartDate || data.startDate || subObj.startDate
        ? formatTimestamp(data.subscriptionStartDate || data.startDate || subObj.startDate)
        : undefined,
    subscriptionEndDate:
      data.subscriptionEndDate || data.endDate || data.expiryDate || data.expiresAt || subObj.endDate
        ? formatTimestamp(
            data.subscriptionEndDate || data.endDate || data.expiryDate || data.expiresAt || subObj.endDate
          )
        : undefined,
    captainsCount:
      typeof data.captainsCount === 'number'
        ? data.captainsCount
        : typeof subObj.captainsCount === 'number'
        ? subObj.captainsCount
        : undefined,
    isActive,
    isOpen: typeof data.isOpen === 'boolean' ? data.isOpen : undefined,
    isVerified: typeof data.isVerified === 'boolean' ? data.isVerified : undefined,
    createdAt: formatTimestamp(data.createdAt || data.registeredAt || data.updatedAt),
    address:
      data.address ||
      data.fullAddress ||
      data.storeAddress ||
      data.locationAddress ||
      data.addressAr ||
      data.locationName ||
      data.area ||
      data.city ||
      (typeof data.location === 'string' && !data.location.startsWith('http') ? data.location : '—'),
    ownerEmail: ownerEmail || '—',
    ownerUid: data.ownerUid || data.uid || data.userId || undefined,
    logo,
    logoPath: logoPath || undefined,
    image: logo,
    location: data.location || data.coordinates || data.coords,
    locationUrl,
    coords,
    workingHours: data.workingHours || data.openHours || undefined,
    notes: data.notes || data.description || undefined,
    sourceCollection,
    raw: data,
  };
}

function getCollectionNameForId(id: string): 'restaurants' | 'merchants' {
  const cached = localRestaurantsCache.find((r) => r.id === id);
  return cached?.sourceCollection || 'restaurants';
}

export const RestaurantService = {
  async getAll(): Promise<{ data: Restaurant[]; isLive: boolean }> {
    if (!isFirebaseConfigured) {
      return { data: localRestaurantsCache, isLive: false };
    }

    try {
      // Fetch both 'restaurants' and 'merchants' without orderBy('name') so docs missing 'name' are never skipped
      const [restResult, merchResult] = await Promise.allSettled([
        getDocs(collection(db, COLLECTIONS.RESTAURANTS)),
        getDocs(collection(db, COLLECTIONS.MERCHANTS)),
      ]);

      const mergedMap = new Map<
        string,
        { data: Record<string, any>; source: 'restaurants' | 'merchants' }
      >();

      if (restResult.status === 'fulfilled') {
        restResult.value.forEach((docSnap) => {
          mergedMap.set(docSnap.id, {
            data: docSnap.data(),
            source: 'restaurants',
          });
        });
      } else {
        handleFirestoreError(restResult.reason, OperationType.LIST, COLLECTIONS.RESTAURANTS);
      }

      if (merchResult.status === 'fulfilled') {
        merchResult.value.forEach((docSnap) => {
          const existing = mergedMap.get(docSnap.id);
          if (existing) {
            // Merge non-empty values so neither collection overwrites populated fields
            const mData = docSnap.data();
            const mergedData: Record<string, any> = { ...mData, ...existing.data };
            Object.entries(mData).forEach(([key, value]) => {
              if (
                value !== undefined &&
                value !== null &&
                value !== '' &&
                (mergedData[key] === undefined || mergedData[key] === null || mergedData[key] === '')
              ) {
                mergedData[key] = value;
              }
            });
            mergedMap.set(docSnap.id, {
              data: mergedData,
              source: existing.source,
            });
          } else {
            mergedMap.set(docSnap.id, {
              data: docSnap.data(),
              source: 'merchants',
            });
          }
        });
      }

      const list: Restaurant[] = [];
      mergedMap.forEach((entry, id) => {
        list.push(mapDocToRestaurant(id, entry.data, entry.source));
      });

      list.sort((a, b) => a.name.localeCompare(b.name, 'ar'));

      localRestaurantsCache = list;
      const anyLive =
        restResult.status === 'fulfilled' || merchResult.status === 'fulfilled';
      return { data: list, isLive: anyLive };
    } catch (error) {
      handleFirestoreError(error, OperationType.LIST, COLLECTIONS.RESTAURANTS);
      return { data: localRestaurantsCache, isLive: false };
    }
  },

  async getById(id: string): Promise<Restaurant | null> {
    if (!isFirebaseConfigured) {
      return localRestaurantsCache.find((r) => r.id === id) || null;
    }

    try {
      const restSnap = await getDoc(doc(db, COLLECTIONS.RESTAURANTS, id));
      if (restSnap.exists()) {
        return mapDocToRestaurant(restSnap.id, restSnap.data(), 'restaurants');
      }
      const merchSnap = await getDoc(doc(db, COLLECTIONS.MERCHANTS, id));
      if (merchSnap.exists()) {
        return mapDocToRestaurant(merchSnap.id, merchSnap.data(), 'merchants');
      }
      return localRestaurantsCache.find((r) => r.id === id) || null;
    } catch (error) {
      handleFirestoreError(error, OperationType.GET, `${COLLECTIONS.RESTAURANTS}/${id}`);
      return localRestaurantsCache.find((r) => r.id === id) || null;
    }
  },

  async toggleActive(id: string, currentStatus: boolean): Promise<boolean> {
    const newStatus = !currentStatus;
    const colName = getCollectionNameForId(id);

    localRestaurantsCache = localRestaurantsCache.map((r) =>
      r.id === id ? { ...r, isActive: newStatus } : r
    );

    if (isFirebaseConfigured) {
      try {
        const docRef = doc(db, colName, id);
        await updateDoc(docRef, {
          isActive: newStatus,
          status: newStatus ? 'active' : 'inactive',
          updatedAt: serverTimestamp(),
        });
      } catch (error) {
        handleFirestoreError(error, OperationType.UPDATE, `${colName}/${id}`);
      }
    }
    return newStatus;
  },

  async update(id: string, updates: Partial<Restaurant>): Promise<void> {
    const colName = updates.sourceCollection || getCollectionNameForId(id);
    const parsedFromUrl = updates.locationUrl
      ? extractCoordinatesFromText(updates.locationUrl)
      : null;
    const effectiveCoords = updates.coords || parsedFromUrl || null;

    localRestaurantsCache = localRestaurantsCache.map((r) =>
      r.id === id
        ? {
            ...r,
            ...updates,
            ...(effectiveCoords ? { coords: effectiveCoords } : {}),
          }
        : r
    );

    if (isFirebaseConfigured) {
      try {
        const docRef = doc(db, colName, id);
        const payload: Record<string, any> = {
          updatedAt: serverTimestamp(),
        };
        if (updates.name !== undefined) payload.name = updates.name;
        if (updates.category !== undefined) payload.category = updates.category;
        if (updates.phone !== undefined) payload.phone = updates.phone;
        if (updates.address !== undefined) payload.address = updates.address;
        if (updates.subscriptionStatus !== undefined) payload.subscriptionStatus = updates.subscriptionStatus;
        if (updates.ownerEmail !== undefined) {
          payload.ownerEmail = updates.ownerEmail;
          payload.email = updates.ownerEmail;
        }
        if (updates.logo !== undefined) {
          payload.logo = updates.logo;
          payload.logoUrl = updates.logo;
          payload.image = updates.logo;
        }
        if (updates.locationUrl !== undefined) {
          payload.locationUrl = updates.locationUrl;
          payload.mapUrl = updates.locationUrl;
          payload.googleMapsUrl = updates.locationUrl;
        }
        if (effectiveCoords) {
          payload.lat = effectiveCoords.lat;
          payload.lng = effectiveCoords.lng;
          payload.coords = effectiveCoords;
          payload.location = effectiveCoords;
        }

        await updateDoc(docRef, payload);
      } catch (error) {
        handleFirestoreError(error, OperationType.UPDATE, `${colName}/${id}`);
      }
    }
  },

  async create(data: Omit<Restaurant, 'id'>): Promise<Restaurant> {
    const newId = `rest_${Date.now()}`;
    const parsedFromUrl = data.locationUrl
      ? extractCoordinatesFromText(data.locationUrl)
      : null;
    const coords = data.coords || parsedFromUrl || null;

    const newRestaurant: Restaurant = {
      ...data,
      id: newId,
      coords,
      sourceCollection: 'restaurants',
      createdAt: new Date().toISOString(),
    };

    localRestaurantsCache = [newRestaurant, ...localRestaurantsCache];

    if (isFirebaseConfigured) {
      try {
        const docRef = doc(db, COLLECTIONS.RESTAURANTS, newId);
        await setDoc(docRef, {
          name: data.name,
          category: data.category || 'عام',
          phone: data.phone || '',
          ownerEmail: data.ownerEmail || '',
          email: data.ownerEmail || '',
          logo: data.logo || '',
          logoUrl: data.logo || '',
          image: data.logo || '',
          rating: data.rating || 5.0,
          subscriptionStatus: data.subscriptionStatus || 'Active',
          isActive: data.isActive,
          address: data.address || '',
          locationUrl: data.locationUrl || '',
          mapUrl: data.locationUrl || '',
          googleMapsUrl: data.locationUrl || '',
          ...(coords
            ? {
                lat: coords.lat,
                lng: coords.lng,
                coords,
                location: coords,
              }
            : {}),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } catch (error) {
        handleFirestoreError(error, OperationType.CREATE, `${COLLECTIONS.RESTAURANTS}/${newId}`);
      }
    }

    return newRestaurant;
  },

  async delete(id: string): Promise<void> {
    const colName = getCollectionNameForId(id);
    localRestaurantsCache = localRestaurantsCache.filter((r) => r.id !== id);

    if (isFirebaseConfigured) {
      try {
        const docRef = doc(db, colName, id);
        await deleteDoc(docRef);
      } catch (error) {
        handleFirestoreError(error, OperationType.DELETE, `${colName}/${id}`);
      }
    }
  },
};
