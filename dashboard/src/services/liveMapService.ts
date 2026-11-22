import {
  collection,
  onSnapshot,
  query,
} from 'firebase/firestore';
import { db, isFirebaseConfigured, handleFirestoreError, OperationType } from '../firebase/config';
import { COLLECTIONS } from './collections';
import { Captain, Restaurant, Order, NearestCaptainResult, CaptainStatus } from '../types';
import { extractCoordinates, haversineDistanceKm, formatDistanceArabic, isLocationFresh } from '../utils/geoUtils';
import { extractOrderCode, fetchOrderCodesLookup, normalizeOrderStatus } from './orderService';
import { mapDocToRestaurant } from './restaurantService';

/**
 * Service for managing real-time map data from Firestore.
 * Conforms to performance constraints:
 * - Single collection listener per entity type (no individual listeners per captain)
 * - Reads only (never mutates captain GPS from dashboard)
 * - Error handling using handleFirestoreError
 */

export function mapDocToLiveCaptain(id: string, data: Record<string, any>): Captain {
  const coords = extractCoordinates(data);
  const rawStatus = data.status || (data.isOnline ? 'online' : 'offline');

  // Normalize status
  let status: CaptainStatus = 'offline';
  if (rawStatus === 'busy' || data.isBusy || data.currentOrderId) {
    status = 'busy';
  } else if (rawStatus === 'available' || rawStatus === 'online' || data.isOnline === true) {
    status = 'available';
  } else {
    status = 'offline';
  }

  const isOnline = Boolean(data.isOnline ?? (status === 'available' || status === 'busy'));

  const rawImageCandidates = [
    data.profileImagePath,
    data.profile_image_path,
    data.profileImage,
    data.profile_image,
    data.profileImageUrl,
    data.profile_image_url,
    data.photoURL,
    data.photoUrl,
    data.photo_url,
    data.avatarUri,
    data.avatar_uri,
    data.avatarUrl,
    data.avatar,
    data.image,
    data.imageUrl,
  ];
  const profileImage =
    rawImageCandidates.find(
      (v): v is string =>
        typeof v === 'string' &&
        v.trim().length > 0 &&
        !v.trim().toLowerCase().startsWith('content://') &&
        !v.trim().toLowerCase().startsWith('file://') &&
        !v.trim().toLowerCase().startsWith('android.resource://')
    )?.trim() || '';

  return {
    id,
    name: data.name || data.fullName || data.captainName || 'كابتن بدون اسم',
    phone: data.phone || data.mobile || data.phoneNumber || '—',
    profileImage,
    photoURL: profileImage,
    status,
    isOnline,
    ordersCount: typeof data.ordersCount === 'number' ? data.ordersCount : (data.totalDeliveries || 0),
    rating: typeof data.rating === 'number' ? data.rating : 5.0,
    vehicleType: data.vehicleType || data.vehicle || 'دراجة نارية',
    createdAt: data.createdAt?.toDate ? data.createdAt.toDate().toISOString() : (data.createdAt || new Date().toISOString()),
    location: data.location || data.coordinates || data.coords,
    coords,
    lastLocationUpdate: data.lastLocationUpdate || data.lastUpdate || data.updatedAt || data.locationUpdatedAt,
    currentOrderId: data.currentOrderId || data.activeOrderId || data.orderId,
    raw: data,
  };
}

export function mapDocToLiveRestaurant(
  id: string,
  data: Record<string, any>,
  sourceCollection: 'restaurants' | 'merchants' = 'restaurants'
): Restaurant {
  return {
    ...mapDocToRestaurant(id, data, sourceCollection),
    status: data.status || (data.isActive !== false ? 'active' : 'inactive'),
  };
}

export const LiveMapService = {
  /**
   * Subscribes to the captains collection in real-time.
   */
  subscribeCaptains(
    onUpdate: (captains: Captain[]) => void,
    onError?: (err: any) => void
  ): () => void {
    if (!isFirebaseConfigured) {
      onUpdate([]);
      return () => {};
    }

    try {
      const q = query(collection(db, COLLECTIONS.CAPTAINS));
      const unsubscribe = onSnapshot(
        q,
        (snapshot) => {
          const list: Captain[] = [];
          snapshot.forEach((docSnap) => {
            list.push(mapDocToLiveCaptain(docSnap.id, docSnap.data()));
          });
          onUpdate(list);
        },
        (error) => {
          handleFirestoreError(error, OperationType.GET, COLLECTIONS.CAPTAINS);
          if (onError) onError(error);
        }
      );

      return unsubscribe;
    } catch (err) {
      handleFirestoreError(err, OperationType.GET, COLLECTIONS.CAPTAINS);
      return () => {};
    }
  },

  /**
   * Subscribes to both restaurants and merchants collections in real-time
   * and automatically extracts coordinates from merchant location links.
   */
  subscribeRestaurants(
    onUpdate: (restaurants: Restaurant[]) => void,
    onError?: (err: any) => void
  ): () => void {
    if (!isFirebaseConfigured) {
      onUpdate([]);
      return () => {};
    }

    const restDocs = new Map<string, Record<string, any>>();
    const merchDocs = new Map<string, Record<string, any>>();

    const emitMerged = () => {
      const merged = new Map<string, { data: Record<string, any>; source: 'restaurants' | 'merchants' }>();
      restDocs.forEach((d, id) => merged.set(id, { data: d, source: 'restaurants' }));
      merchDocs.forEach((d, id) => {
        const existing = merged.get(id);
        if (existing) {
          const combined: Record<string, any> = { ...d, ...existing.data };
          Object.entries(d).forEach(([k, v]) => {
            if (
              v !== undefined &&
              v !== null &&
              v !== '' &&
              (combined[k] === undefined || combined[k] === null || combined[k] === '')
            ) {
              combined[k] = v;
            }
          });
          merged.set(id, { data: combined, source: existing.source });
        } else {
          merged.set(id, { data: d, source: 'merchants' });
        }
      });

      const list: Restaurant[] = [];
      merged.forEach((entry, id) => {
        list.push(mapDocToLiveRestaurant(id, entry.data, entry.source));
      });
      onUpdate(list);
    };

    try {
      const unsubRest = onSnapshot(
        query(collection(db, COLLECTIONS.RESTAURANTS)),
        (snapshot) => {
          restDocs.clear();
          snapshot.forEach((docSnap) => {
            restDocs.set(docSnap.id, docSnap.data());
          });
          emitMerged();
        },
        (error) => {
          handleFirestoreError(error, OperationType.GET, COLLECTIONS.RESTAURANTS);
          if (onError) onError(error);
        }
      );

      let unsubMerch = () => {};
      try {
        unsubMerch = onSnapshot(
          query(collection(db, COLLECTIONS.MERCHANTS)),
          (snapshot) => {
            merchDocs.clear();
            snapshot.forEach((docSnap) => {
              merchDocs.set(docSnap.id, docSnap.data());
            });
            emitMerged();
          },
          () => {
            // Silently ignore if 'merchants' collection is empty or rules not yet deployed
          }
        );
      } catch {
        // ignore
      }

      return () => {
        unsubRest();
        unsubMerch();
      };
    } catch (err) {
      handleFirestoreError(err, OperationType.GET, COLLECTIONS.RESTAURANTS);
      return () => {};
    }
  },

  /**
   * Subscribes to active orders/trips in real-time.
   */
  subscribeActiveOrders(
    onUpdate: (orders: Order[]) => void,
    onError?: (err: any) => void
  ): () => void {
    if (!isFirebaseConfigured) {
      onUpdate([]);
      return () => {};
    }

    let isCancelled = false;
    let orderCodesMap = new Map<string, string>();
    fetchOrderCodesLookup().then((map) => {
      if (!isCancelled) {
        orderCodesMap = map;
      }
    });

    try {
      const q = query(collection(db, COLLECTIONS.ORDERS));
      const unsubscribe = onSnapshot(
        q,
        async (snapshot) => {
          if (orderCodesMap.size === 0) {
            orderCodesMap = await fetchOrderCodesLookup();
          }
          const list: Order[] = [];
          snapshot.forEach((docSnap) => {
            const data = docSnap.data();
            const status = String(data.status || '').toLowerCase();
            // Active orders are not delivered and not cancelled
            const isCompleted = status === 'delivered' || status === 'cancelled' || status === 'ملغي' || status === 'تم التوصيل';
            if (!isCompleted) {
              const orderCode = extractOrderCode(docSnap.id, data, orderCodesMap);
              const receiptPath = String(data.receiptImagePath || data.receipt_image_path || '').trim();
              const receiptUrl = String(
                data.receiptImageUrl ||
                  data.receipt_image_url ||
                  data.orderImageUrl ||
                  data.receiptImage ||
                  receiptPath ||
                  ''
              ).trim();

              list.push({
                id: docSnap.id,
                orderNumber: orderCode,
                orderCode,
                restaurantId: data.restaurantId || data.restaurant?.id || '',
                restaurantName: data.restaurantName || data.restaurant?.name || 'تاجر غير محدد',
                customerName: data.customerName || data.customer_name || data.clientName || '',
                customerPhone: data.customerPhone || data.customer_phone || data.clientPhone || data.phone || '',
                deliveryAddress: data.deliveryAddress || data.address || '',
                captainId: data.captainId || data.captain?.id || '',
                captainName: data.captainName || data.captain?.name || '',
                receiptImageUrl: receiptUrl,
                receiptImagePath: receiptPath,
                subtotal: Number(data.subtotal || 0),
                deliveryFee: Number(data.deliveryFee || data.delivery_fee || 0),
                total: Number(data.total || 0),
                status: normalizeOrderStatus(data.status),
                createdAt: data.createdAt?.toDate ? data.createdAt.toDate().toISOString() : (data.createdAt || new Date().toISOString()),
                raw: data,
              });
            }
          });
          onUpdate(list);
        },
        (error) => {
          handleFirestoreError(error, OperationType.GET, COLLECTIONS.ORDERS);
          if (onError) onError(error);
        }
      );

      return () => {
        isCancelled = true;
        unsubscribe();
      };
    } catch (err) {
      handleFirestoreError(err, OperationType.GET, COLLECTIONS.ORDERS);
      return () => {
        isCancelled = true;
      };
    }
  },

  /**
   * Finds and sorts nearest available captains to a specific origin coordinate.
   * Algorithm:
   * 1. Filters only available captains (isOnline === true, status !== 'offline', status !== 'busy')
   * 2. Excludes captains without valid GPS coordinates
   * 3. Excludes captains with stale locations (lastLocationUpdate > thresholdMinutes, if threshold is enforced)
   * 4. Calculates Haversine distance in kilometers
   * 5. Sorts ascending by distance
   */
  findNearestCaptains(
    originLat: number,
    originLng: number,
    captains: Captain[],
    options: {
      thresholdMinutes?: number;
      requireFreshLocation?: boolean;
      maxResults?: number;
    } = {}
  ): NearestCaptainResult[] {
    const {
      thresholdMinutes = 3,
      requireFreshLocation = false,
      maxResults = 10,
    } = options;

    const available = captains.filter((captain) => {
      // Must have valid coordinates
      if (!captain.coords) return false;

      // Must be online / available
      const isOnline = captain.isOnline !== false;
      const isAvailable = captain.status === 'available' || captain.status === 'online';
      if (!isOnline || !isAvailable) return false;

      // Check freshness
      if (requireFreshLocation) {
        const freshCheck = isLocationFresh(captain.lastLocationUpdate, thresholdMinutes);
        if (!freshCheck.isFresh) return false;
      }

      return true;
    });

    const withDistance: NearestCaptainResult[] = available.map((captain) => {
      const dist = haversineDistanceKm(
        originLat,
        originLng,
        captain.coords!.lat,
        captain.coords!.lng
      );
      const freshness = isLocationFresh(captain.lastLocationUpdate, thresholdMinutes);

      return {
        captain,
        distanceKm: dist,
        formattedDistance: formatDistanceArabic(dist),
        isFresh: freshness.isFresh,
        minutesAgo: freshness.minutesAgo,
        formattedTime: freshness.formattedTime,
      };
    });

    // Sort ascending by distance
    withDistance.sort((a, b) => a.distanceKm - b.distanceKm);

    return withDistance.slice(0, maxResults);
  },
};
