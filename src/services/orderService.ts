import {
  collection,
  doc,
  getDocs,
  query,
  orderBy,
} from 'firebase/firestore';
import { db, isFirebaseConfigured, handleFirestoreError, OperationType } from '../firebase/config';
import { COLLECTIONS } from './collections';
import { Order, OrderStatus } from '../types';
import { callOrdersBackend, OrdersBackendResponse } from './cloudFunctionsService';

interface AssignmentResponse extends OrdersBackendResponse {
  assigned?: boolean;
  offeredCaptainId?: string | null;
  offeredCaptainName?: string | null;
  offerId?: string | null;
  offerExpiresAt?: number | null;
  distanceKm?: number | null;
  reason?: string;
}

interface CreateOrderResponse extends OrdersBackendResponse {
  orderId?: string;
  orderNumber?: string;
  orderCode?: string;
  status?: string;
  offeredCaptainId?: string | null;
  offeredCaptainName?: string | null;
  offerId?: string | null;
  offerExpiresAt?: number | null;
  distanceKm?: number | null;
  assigned?: boolean;
  duplicate?: boolean;
  assignmentReason?: string;
}

interface StageTimestampResponse extends OrdersBackendResponse {
  timestamp?: string;
  field?: string;
}

let localOrdersCache: Order[] = [];

const IGNORED_CODE_DOC_IDS = new Set([
  'counter',
  'counters',
  'meta',
  'metadata',
  'config',
  'settings',
  'sequence',
  'last',
]);

function extractStringFromUnknown(val: any): string {
  if (val === undefined || val === null) return '';
  if (typeof val === 'string' || typeof val === 'number') {
    return String(val).trim();
  }
  if (Array.isArray(val)) {
    for (const item of val) {
      const candidate = extractStringFromUnknown(item);
      if (candidate) return candidate;
    }
    return '';
  }
  if (typeof val === 'object') {
    const keys = [
      'order_code',
      'orderCode',
      'order_codes',
      'code',
      'shortCode',
      'displayCode',
      'orderNumber',
      'order_number',
      'orderNo',
      'order_no',
      'number',
      'seq',
      'serial',
      'value',
      'label',
    ];
    for (const k of keys) {
      if (val[k] !== undefined && val[k] !== null && String(val[k]).trim() !== '') {
        return String(val[k]).trim();
      }
    }
  }
  return '';
}

export function normalizeOrderStatus(rawStatus: any): OrderStatus {
  const s = String(rawStatus || 'New').trim().toLowerCase();
  if (
    s === 'new' ||
    s === 'pending' ||
    s === 'searching' ||
    s === 'offered' ||
    s === 'waiting_driver' ||
    s === 'available' ||
    s === 'جديد' ||
    s === 'طلب جديد'
  ) {
    return 'New';
  }
  if (s === 'accepted' || s === 'assigned' || s === 'مقبول' || s === 'تم القبول') {
    return 'Accepted';
  }
  if (s === 'preparing' || s === 'جاري التجهيز' || s === 'قيد التحضير') {
    return 'Preparing';
  }
  if (
    s === 'ready' ||
    s === 'ready_for_pickup' ||
    s === 'arrived_at_merchant' ||
    s === 'arrived_at_restaurant' ||
    s === 'at_store' ||
    s === 'جاهز' ||
    s === 'جاهز للتوصيل'
  ) {
    return 'Ready';
  }
  if (
    s === 'picked up' ||
    s === 'picked_up' ||
    s === 'en_route' ||
    s === 'on_way' ||
    s === 'on_the_way' ||
    s === 'delivering' ||
    s === 'awaiting_merchant_confirmation' ||
    s === 'order_data_entered' ||
    s === 'merchant_rejected' ||
    s === 'تم الاستلام' ||
    s === 'في الطريق'
  ) {
    return 'Picked Up';
  }
  if (s === 'delivered' || s === 'completed' || s === 'done' || s === 'تم التوصيل' || s === 'مكتمل') {
    return 'Delivered';
  }
  if (
    s === 'cancelled' ||
    s === 'canceled' ||
    s === 'rejected' ||
    s === 'declined' ||
    s === 'expired' ||
    s === 'ملغي' ||
    s === 'مرفوض'
  ) {
    return 'Cancelled';
  }
  return 'New';
}

export function extractOrderCode(
  docId: string,
  data: Record<string, any>,
  orderCodesMap?: Map<string, string>
): string {
  const cleanDocId = String(docId || '').trim().replace(/^#+/, '');
  const rawOrderId = data.orderId !== undefined && data.orderId !== null ? String(data.orderId).trim() : '';
  const rawOrderIdSnake = data.order_id !== undefined && data.order_id !== null ? String(data.order_id).trim() : '';

  // Forbidden raw IDs that must NEVER be displayed as the order number
  const forbiddenIds = new Set(
    [
      String(docId || '').trim(),
      cleanDocId,
      rawOrderId,
      rawOrderId.replace(/^#+/, ''),
      rawOrderIdSnake,
      rawOrderIdSnake.replace(/^#+/, ''),
    ].filter(Boolean)
  );

  // 1. Check `order_codes` collection lookup first
  if (orderCodesMap && orderCodesMap.size > 0) {
    const lookupKeys = [
      String(docId || '').trim(),
      cleanDocId,
      rawOrderId,
      rawOrderId.replace(/^#+/, ''),
      rawOrderIdSnake,
      rawOrderIdSnake.replace(/^#+/, ''),
      data.orderCodeId ? String(data.orderCodeId).trim() : '',
      data.order_code_id ? String(data.order_code_id).trim() : '',
      data.codeId ? String(data.codeId).trim() : '',
    ].filter(Boolean);

    for (const key of lookupKeys) {
      const found = orderCodesMap.get(key);
      if (found) return found;
    }
  }

  // 2. Check `order_codes` field inside the order document
  const fromOrderCodesField = extractStringFromUnknown(data.order_codes);
  if (fromOrderCodesField && !forbiddenIds.has(fromOrderCodesField.replace(/^#+/, ''))) {
    return fromOrderCodesField;
  }

  // 3. Check explicit order code fields on the order document
  const explicitCodeCandidates = [
    data.order_code,
    data.orderCode,
    data.shortCode,
    data.displayCode,
    data.code,
  ];
  for (const cand of explicitCodeCandidates) {
    const val = extractStringFromUnknown(cand);
    if (val && !forbiddenIds.has(val) && !forbiddenIds.has(val.replace(/^#+/, ''))) {
      return val;
    }
  }

  // 4. Check orderNumber fields ONLY if they are not equal to orderId / docId
  const orderNumCandidates = [
    data.orderNumber,
    data.order_number,
    data.orderNo,
    data.order_no,
    data.number,
  ];
  for (const cand of orderNumCandidates) {
    const val = extractStringFromUnknown(cand);
    if (val && !forbiddenIds.has(val) && !forbiddenIds.has(val.replace(/^#+/, ''))) {
      return val;
    }
  }

  // Never fall back to orderId or Firestore docId
  return '';
}

export async function fetchOrderCodesLookup(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!isFirebaseConfigured || !db) return map;

  try {
    const codesSnap = await getDocs(collection(db, COLLECTIONS.ORDER_CODES));
    codesSnap.forEach((docSnap) => {
      const codeDocId = docSnap.id.trim();
      const d = docSnap.data() || {};

      // Extract explicit code value from document fields
      let codeVal = extractStringFromUnknown(
        d.order_code ??
          d.orderCode ??
          d.order_codes ??
          d.code ??
          d.shortCode ??
          d.displayCode ??
          d.orderNumber ??
          d.order_number ??
          d.orderNo ??
          d.order_no ??
          d.number ??
          d.seq ??
          d.serial ??
          d.value ??
          d.label
      );

      // Extract linked order IDs from document fields
      const refId =
        d.orderRef && typeof d.orderRef === 'object' && typeof d.orderRef.id === 'string'
          ? d.orderRef.id
          : typeof d.orderRef === 'string'
          ? d.orderRef
          : '';

      const linkedOrderIds = [
        d.orderId,
        d.order_id,
        d.orderDocId,
        d.order_doc_id,
        d.targetOrderId,
        d.docId,
        refId,
      ]
        .map((v) => (v !== undefined && v !== null ? String(v).trim() : ''))
        .filter(Boolean);

      // Pattern: doc ID itself is the short code (e.g., "1045") and doc holds { orderId: "..." }
      if (!codeVal && linkedOrderIds.length > 0 && !IGNORED_CODE_DOC_IDS.has(codeDocId.toLowerCase())) {
        codeVal = codeDocId;
      }

      if (!codeVal) return;

      for (const linkedId of linkedOrderIds) {
        map.set(linkedId, codeVal);
        map.set(linkedId.replace(/^#+/, ''), codeVal);
      }

      // Pattern: doc ID is the orderId and doc holds { code: "1045" }
      if (!IGNORED_CODE_DOC_IDS.has(codeDocId.toLowerCase()) && codeDocId !== codeVal) {
        map.set(codeDocId, codeVal);
        map.set(codeDocId.replace(/^#+/, ''), codeVal);
      }
    });
  } catch {
    // Safe fallback if order_codes collection does not exist or rules restrict reading it
  }

  return map;
}

export function parseAnyTimestampToIso(rawVal: any): string {
  if (!rawVal) return '';
  try {
    if (typeof rawVal === 'object' && typeof rawVal.toDate === 'function') {
      return rawVal.toDate().toISOString();
    }
    if (typeof rawVal === 'object' && typeof rawVal.seconds === 'number') {
      return new Date(rawVal.seconds * 1000).toISOString();
    }
    if (rawVal instanceof Date) {
      return rawVal.toISOString();
    }
    if (typeof rawVal === 'number') {
      const ms = rawVal < 10000000000 ? rawVal * 1000 : rawVal;
      return new Date(ms).toISOString();
    }
    if (typeof rawVal === 'string') {
      const trimmed = rawVal.trim();
      if (!trimmed) return '';
      const d = new Date(trimmed);
      if (!isNaN(d.getTime())) {
        return d.toISOString();
      }
      return trimmed;
    }
  } catch {
    // ignore
  }
  return '';
}

export function formatDurationArabic(seconds: number): string {
  if (seconds < 0 || isNaN(seconds)) seconds = 0;
  const rounded = Math.round(seconds);
  if (rounded === 0) return 'أقل من ثانية';
  if (rounded < 60) {
    return `${rounded} ثانية`;
  }
  const mins = Math.floor(rounded / 60);
  const remSecs = rounded % 60;
  if (mins < 60) {
    return remSecs > 0 ? `${mins} دقيقة و ${remSecs} ث` : `${mins} دقيقة`;
  }
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hours} ساعة و ${remMins} د` : `${hours} ساعة`;
}

function mapDocToOrder(
  id: string,
  data: Record<string, any>,
  orderCodesMap?: Map<string, string>
): Order {
  const rawDeliveryFee =
    data.deliveryFee !== undefined
      ? data.deliveryFee
      : data.delivery_fee !== undefined
      ? data.delivery_fee
      : data.deliveryPrice !== undefined
      ? data.deliveryPrice
      : data.delivery_price !== undefined
      ? data.delivery_price
      : data.deliveryCost !== undefined
      ? data.deliveryCost
      : data.delivery_cost !== undefined
      ? data.delivery_cost
      : data.shippingFee !== undefined
      ? data.shippingFee
      : data.shipping_fee !== undefined
      ? data.shipping_fee
      : data.fee !== undefined
      ? data.fee
      : data.captainFee !== undefined
      ? data.captainFee
      : data.captain_fee !== undefined
      ? data.captain_fee
      : data.deliveryAmount !== undefined
      ? data.deliveryAmount
      : data.delivery_amount !== undefined
      ? data.delivery_amount
      : typeof data.delivery === 'number'
      ? data.delivery
      : data.pricing?.deliveryFee !== undefined
      ? data.pricing.deliveryFee
      : data.pricing?.delivery_fee !== undefined
      ? data.pricing.delivery_fee
      : 0;

  const realDeliveryFee =
    typeof rawDeliveryFee === 'number'
      ? rawDeliveryFee
      : parseFloat(String(rawDeliveryFee).replace(/[^\d.-]/g, '')) || 0;

  const realOrderCode = extractOrderCode(id, data, orderCodesMap);

  const offeredCaptainId = data.offeredCaptainId || '';
  const offeredCaptainName = data.offeredCaptainName || '';
  const realCaptainId = data.captainId || data.captain_id || data.driverId || data.captain?.id || data.captain?.uid || '';
  const realCaptainName =
    data.captainName ||
    data.captain_name ||
    data.driverName ||
    data.captain?.name ||
    data.captain?.displayName ||
    '';

  const rawCreatedAt =
    data.createdAt ||
    data.created_at ||
    data.orderDate ||
    data.order_date ||
    data.date ||
    data.timestamp ||
    data.time;

  const parsedCreatedAt = parseAnyTimestampToIso(rawCreatedAt) || new Date().toISOString();

  // Stage Timestamps
  const timestampsObj = typeof data.timestamps === 'object' && data.timestamps ? data.timestamps : {};
  const historyObj = typeof data.statusHistory === 'object' && data.statusHistory ? data.statusHistory : {};

  const assignedAt = parseAnyTimestampToIso(
    data.assignedAt ||
      data.assigned_at ||
      data.captainAssignedAt ||
      timestampsObj.assignedAt
  );

  const acceptedAt = parseAnyTimestampToIso(
    data.acceptedAt ||
      data.accepted_at ||
      data.captainAcceptedAt ||
      data.captain_accepted_at ||
      timestampsObj.acceptedAt ||
      historyObj.Accepted ||
      assignedAt
  );

  const arrivedAtMerchantAt = parseAnyTimestampToIso(
    data.arrivedAtMerchantAt ||
      data.arrived_at_merchant_at ||
      data.arrivedAtRestaurantAt ||
      data.arrived_at_restaurant_at ||
      data.arrivedAtStoreAt ||
      data.arrivedAt ||
      data.merchantArrivalTime ||
      data.readyAt ||
      timestampsObj.arrivedAtMerchantAt ||
      timestampsObj.arrivedAtMerchant ||
      historyObj.Ready
  );

  const pickedUpAt = parseAnyTimestampToIso(
    data.pickedUpAt ||
      data.picked_up_at ||
      data.receivedFromMerchantAt ||
      data.received_from_merchant_at ||
      data.pickupTime ||
      data.pickedAt ||
      timestampsObj.pickedUpAt ||
      historyObj['Picked Up']
  );

  const deliveredAt = parseAnyTimestampToIso(
    data.deliveredAt ||
      data.delivered_at ||
      data.completedAt ||
      data.completed_at ||
      data.deliveryTime ||
      timestampsObj.deliveredAt ||
      historyObj.Delivered
  );

  // Calculate Captain Search Duration
  let captainSearchSeconds: number | undefined =
    typeof data.captainSearchSeconds === 'number'
      ? data.captainSearchSeconds
      : typeof data.searchDurationSeconds === 'number'
      ? data.searchDurationSeconds
      : undefined;

  let captainSearchDuration: string | undefined =
    data.captainSearchDuration || data.searchDurationText || undefined;

  if (captainSearchSeconds === undefined && acceptedAt && parsedCreatedAt) {
    const startMs = new Date(parsedCreatedAt).getTime();
    const endMs = new Date(acceptedAt).getTime();
    if (!isNaN(startMs) && !isNaN(endMs) && endMs >= startMs) {
      captainSearchSeconds = Math.round((endMs - startMs) / 1000);
    }
  }

  if (!captainSearchDuration && captainSearchSeconds !== undefined) {
    captainSearchDuration = formatDurationArabic(captainSearchSeconds);
  }

  const distanceToMerchantKm =
    typeof data.distanceToMerchantKm === 'number' ? data.distanceToMerchantKm : undefined;

  const rawCustomerName =
    data.customerName ||
    data.customer_name ||
    data.clientName ||
    data.client_name ||
    data.recipientName ||
    data.recipient_name ||
    data.userName ||
    data.user_name ||
    data.customer?.name ||
    data.client?.name ||
    '';

  const rawCustomerPhone =
    data.customerPhone ||
    data.customer_phone ||
    data.clientPhone ||
    data.client_phone ||
    data.recipientPhone ||
    data.recipient_phone ||
    data.phone ||
    data.phoneNumber ||
    data.phone_number ||
    data.mobile ||
    data.customer?.phone ||
    data.client?.phone ||
    '';

  const rawReceiptPath = String(
    data.receiptImagePath || data.receipt_image_path || ''
  ).trim();

  const rawReceiptUrl = String(
    data.receiptImageUrl ||
      data.receipt_image_url ||
      data.orderImageUrl ||
      data.order_image_url ||
      data.deliveryImageUrl ||
      data.delivery_image_url ||
      data.receiptImage ||
      data.receipt_image ||
      data.receiptUrl ||
      data.receipt_url ||
      data.invoiceImageUrl ||
      data.invoice_image_url ||
      data.invoiceImage ||
      data.invoice_image ||
      data.receipt?.url ||
      data.receipt?.imageUrl ||
      rawReceiptPath ||
      ''
  ).trim();

  return {
    id,
    orderNumber: realOrderCode,
    orderCode: realOrderCode,
    restaurantId: data.merchantId || data.restaurantId || data.restaurant_id || data.restaurant?.id || '',
    restaurantName:
      data.restaurantName ||
      data.restaurant_name ||
      data.merchantName ||
      data.storeName ||
      data.restaurant?.name ||
      'تاجر غير محدد',
    customerName: String(rawCustomerName).trim(),
    customerPhone: String(rawCustomerPhone).trim(),
    deliveryAddress:
      data.deliveryAddress || data.delivery_address || data.address || data.clientAddress || '',
    captainId: realCaptainId,
    captainName: realCaptainName,
    offeredCaptainId: String(offeredCaptainId || ''),
    offeredCaptainName: String(offeredCaptainName || ''),
    offerId: String(data.offerId || ''),
    offerExpiresAt: typeof data.offerExpiresAt === 'number' ? data.offerExpiresAt : undefined,
    receiptImageUrl: rawReceiptUrl,
    receiptImagePath: rawReceiptPath,
    subtotal:
      typeof data.subtotal === 'number'
        ? data.subtotal
        : typeof data.itemsTotal === 'number'
        ? data.itemsTotal
        : data.total || 0,
    deliveryFee: realDeliveryFee,
    total: typeof data.total === 'number' ? data.total : 0,
    status: normalizeOrderStatus(data.status || data.order_status || data.orderStatus || data.state),
    createdAt: parsedCreatedAt,
    assignedAt,
    acceptedAt,
    arrivedAtMerchantAt,
    pickedUpAt,
    deliveredAt,
    captainSearchDuration,
    captainSearchSeconds,
    distanceToMerchantKm,
    items: data.items || [],
    raw: data,
  };
}

export const OrderService = {
  async getAll(): Promise<{ data: Order[]; isLive: boolean }> {
    if (!isFirebaseConfigured) {
      return { data: localOrdersCache, isLive: false };
    }

    try {
      const [snapshot, orderCodesMap] = await Promise.all([
        (async () => {
          try {
            const q = query(collection(db, COLLECTIONS.ORDERS), orderBy('createdAt', 'desc'));
            return await getDocs(q);
          } catch {
            return await getDocs(collection(db, COLLECTIONS.ORDERS));
          }
        })(),
        fetchOrderCodesLookup(),
      ]);

      if (snapshot.empty) {
        localOrdersCache = [];
        return { data: [], isLive: true };
      }

      const list: Order[] = [];
      snapshot.forEach((docSnap) => {
        list.push(mapDocToOrder(docSnap.id, docSnap.data(), orderCodesMap));
      });

      list.sort((a, b) => {
        const timeA = new Date(a.createdAt).getTime() || 0;
        const timeB = new Date(b.createdAt).getTime() || 0;
        return timeB - timeA;
      });

      localOrdersCache = list;
      return { data: list, isLive: true };
    } catch (error) {
      handleFirestoreError(error, OperationType.LIST, COLLECTIONS.ORDERS);
      return { data: localOrdersCache, isLive: false };
    }
  },

  async updateStatus(id: string, newStatus: OrderStatus): Promise<Partial<Order>> {
    await callOrdersBackend('adminUpdateOrderStatus', {
      action: 'updateStatus',
      orderId: id,
      newStatus,
    });

    const stageUpdates: Partial<Order> = { status: newStatus };
    localOrdersCache = localOrdersCache.map((order) =>
      order.id === id ? { ...order, ...stageUpdates } : order
    );
    return stageUpdates;
  },

  async recordStageTimestamp(
    orderId: string,
    field: 'acceptedAt' | 'arrivedAtMerchantAt' | 'pickedUpAt' | 'deliveredAt',
    _customIso?: string
  ): Promise<string> {
    const response = await callOrdersBackend<StageTimestampResponse>('adminUpdateOrderStatus', {
      action: 'recordStageTimestamp',
      orderId,
      field,
    });

    const timestampIso =
      typeof response.timestamp === 'string' ? response.timestamp : new Date().toISOString();

    localOrdersCache = localOrdersCache.map((order) =>
      order.id === orderId ? { ...order, [field]: timestampIso } : order
    );

    return timestampIso;
  },

  async assignCaptain(
    orderId: string,
    captainId: string,
    _captainName: string,
    _extra?: {
      searchDurationSeconds?: number;
      searchDurationText?: string;
      distanceToMerchantKm?: number;
    }
  ): Promise<{
    assignedAt: string;
    acceptedAt?: string;
    captainSearchDuration: string;
    captainSearchSeconds: number;
    distanceToMerchantKm?: number;
    status: OrderStatus;
    offeredCaptainId?: string;
    offeredCaptainName?: string;
    offerId?: string;
    offerExpiresAt?: number;
  }> {
    if (!captainId) throw new Error('يجب تحديد كابتن لإرسال عرض الطلب');

    const response = await callOrdersBackend<AssignmentResponse>('assignNextAvailableCaptain', {
      orderId,
      captainId,
    });

    if (response.assigned !== true || typeof response.offeredCaptainId !== 'string') {
      throw new Error(
        typeof response.message === 'string' ? response.message : 'لم يتمكن السيرفر من إرسال عرض إلى الكابتن المحدد'
      );
    }

    const existing = localOrdersCache.find((order) => order.id === orderId);
    const nowIso = new Date().toISOString();
    const offeredCaptainId = response.offeredCaptainId;
    const offeredCaptainName = String(response.offeredCaptainName || _captainName || 'كابتن معتمد');
    const status = existing?.status || 'New';
    const distanceKm = typeof response.distanceKm === 'number' ? response.distanceKm : undefined;

    localOrdersCache = localOrdersCache.map((order) =>
      order.id === orderId
        ? {
            ...order,
            offeredCaptainId,
            offeredCaptainName,
            offeredCaptainName,
            offerId: String(response.offerId || ''),
            offerExpiresAt: typeof response.offerExpiresAt === 'number' ? response.offerExpiresAt : undefined,
            status,
            distanceToMerchantKm: distanceKm,
          }
        : order
    );

    return {
      assignedAt: nowIso,
      acceptedAt: existing?.acceptedAt,
      captainSearchDuration: existing?.captainSearchDuration || 'جارٍ انتظار قبول الكابتن',
      captainSearchSeconds: existing?.captainSearchSeconds || 0,
      distanceToMerchantKm: distanceKm,
      status,
      offeredCaptainId,
      offeredCaptainName,
      offerId: String(response.offerId || ''),
      offerExpiresAt: typeof response.offerExpiresAt === 'number' ? response.offerExpiresAt : undefined,
    };
  },

  async assignNearestCaptain(orderId: string): Promise<{
    assignedAt: string;
    acceptedAt?: string;
    captainSearchDuration: string;
    captainSearchSeconds: number;
    distanceToMerchantKm?: number;
    status: OrderStatus;
    offeredCaptainId?: string;
    offeredCaptainName?: string;
    offerId?: string;
    offerExpiresAt?: number;
  }> {
    const response = await callOrdersBackend<AssignmentResponse>('assignNextAvailableCaptain', { orderId });
    if (response.assigned !== true || typeof response.offeredCaptainId !== 'string') {
      throw new Error(
        typeof response.message === 'string' ? response.message : 'لا يوجد كابتن مؤهل متاح حالياً'
      );
    }

    const existing = localOrdersCache.find((order) => order.id === orderId);
    const nowIso = new Date().toISOString();
    const offeredCaptainId = response.offeredCaptainId;
    const offeredCaptainName = String(response.offeredCaptainName || 'كابتن معتمد');
    const status = existing?.status || 'New';
    const distanceKm = typeof response.distanceKm === 'number' ? response.distanceKm : undefined;

    localOrdersCache = localOrdersCache.map((order) =>
      order.id === orderId
        ? {
            ...order,
            captainId: offeredCaptainId,
            captainName: offeredCaptainName,
            offeredCaptainId,
            offeredCaptainName,
            offerId: String(response.offerId || ''),
            offerExpiresAt: typeof response.offerExpiresAt === 'number' ? response.offerExpiresAt : undefined,
            status,
            distanceToMerchantKm: distanceKm,
          }
        : order
    );

    return {
      assignedAt: nowIso,
      acceptedAt: existing?.acceptedAt,
      captainSearchDuration: existing?.captainSearchDuration || 'جارٍ انتظار قبول الكابتن',
      captainSearchSeconds: existing?.captainSearchSeconds || 0,
      distanceToMerchantKm: distanceKm,
      status,
      offeredCaptainId,
      offeredCaptainName,
      offerId: String(response.offerId || ''),
      offerExpiresAt: typeof response.offerExpiresAt === 'number' ? response.offerExpiresAt : undefined,
    };
  },

  async create(data: {
    restaurantId: string;
    restaurantName: string;
    captainId: string;
    captainName: string;
    deliveryAddress?: string;
    deliveryFee?: number;
    notes?: string;
    customerName?: string;
    customerPhone?: string;
    subtotal?: number;
    total?: number;
    items?: { name: string; quantity: number; price: number }[];
  }): Promise<Order> {
    if (!isFirebaseConfigured) {
      throw new Error('لا يمكن إنشاء طلب دون اتصال بخادم Firebase');
    }

    const requestId =
      typeof globalThis.crypto?.randomUUID === 'function'
        ? globalThis.crypto.randomUUID()
        : `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    const deliveryFee = Number(data.deliveryFee ?? 25);
    const subtotal = Number(data.subtotal ?? 0);
    const total = Number(data.total ?? subtotal + deliveryFee);

    const response = await callOrdersBackend<CreateOrderResponse>('createOrder', {
      ...data,
      requestId,
      deliveryFee,
      subtotal,
      total,
      items: data.items || [],
    });

    if (response.success !== true || typeof response.orderId !== 'string') {
      throw new Error(
        typeof response.error === 'string' ? response.error : 'لم يؤكد السيرفر إنشاء الطلب'
      );
    }

    const nowIso = new Date().toISOString();
    const orderNumber = String(response.orderNumber || response.orderCode || '');
    const offeredCaptainId = String(response.offeredCaptainId || '');
    const offeredCaptainName = String(response.offeredCaptainName || '');

    const newOrder: Order = {
      id: response.orderId,
      orderNumber,
      orderCode: String(response.orderCode || orderNumber),
      merchantId: data.restaurantId,
      restaurantId: data.restaurantId,
      merchantName: data.restaurantName,
      restaurantName: data.restaurantName,
      captainId: '',
      captainName: '',
      offeredCaptainId,
      offeredCaptainName,
      offerId: String(response.offerId || ''),
      offerExpiresAt: typeof response.offerExpiresAt === 'number' ? response.offerExpiresAt : undefined,
      customerName: data.customerName || '',
      customerPhone: data.customerPhone || '',
      deliveryAddress: data.deliveryAddress || '',
      subtotal,
      deliveryFee,
      total,
      status: normalizeOrderStatus(response.status || 'searching'),
      createdAt: nowIso,
      captainSearchSeconds: 0,
      captainSearchDuration: 'جارٍ البحث عن كابتن',
      items: data.items && data.items.length > 0 ? data.items : [],
      raw: {
        ...data,
        ...response,
        notes: data.notes || '',
        dispatchedBy: 'admin',
      },
    };

    localOrdersCache = [newOrder, ...localOrdersCache];
    return newOrder;
  },


};
