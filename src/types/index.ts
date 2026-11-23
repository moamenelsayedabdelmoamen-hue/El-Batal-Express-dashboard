export type UserRole = 'admin' | 'restaurant' | 'captain' | 'user';

export type AdminRolePermission =
  | 'add_restaurants'
  | 'add_captains'
  | 'read_only'
  | 'manage_orders';

export interface AdminAccount {
  id: string;
  uid?: string;
  name: string;
  displayName?: string;
  email: string;
  roles: AdminRolePermission[];
  status: 'active' | 'pending_verification';
  emailVerified?: boolean;
  isMasterAdmin?: boolean;
  createdAt?: any;
  updatedAt?: any;
  addedBy?: string;
  raw?: Record<string, any>;
}

export interface AdminUser {
  uid: string;
  email: string | null;
  displayName: string | null;
  role: UserRole;
  isAdmin: boolean;
  isMasterAdmin?: boolean;
  emailVerified?: boolean;
  roles?: AdminRolePermission[];
}

export type SubscriptionStatus = 'Active' | 'Pending' | 'Expired' | 'Suspended' | 'Cancelled';

export interface Restaurant {
  id: string;
  name: string;
  category?: string;
  phone?: string;
  rating?: number;
  subscriptionStatus?: SubscriptionStatus;
  subscriptionPlan?: string;
  subscriptionStartDate?: string;
  subscriptionEndDate?: string;
  captainsCount?: number;
  isActive: boolean;
  isOpen?: boolean;
  isVerified?: boolean;
  createdAt?: any;
  address?: string;
  ownerEmail?: string;
  ownerUid?: string;
  logo?: string;
  logoPath?: string;
  image?: string;
  location?: any; // GeoPoint or { lat, lng } or { latitude, longitude }
  locationUrl?: string;
  coords?: { lat: number; lng: number } | null;
  activeOrdersCount?: number;
  status?: string;
  workingHours?: string;
  notes?: string;
  sourceCollection?: 'restaurants' | 'merchants';
  // Preserve any raw fields from existing Firestore documents
  raw?: Record<string, any>;
}

export type CaptainStatus =
  | 'online'
  | 'offline'
  | 'busy'
  | 'available'
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'suspended'
  | 'blocked';

export type CaptainAccountStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'suspended'
  | 'blocked';

export interface Captain {
  id: string;
  name: string;
  phone: string;
  email?: string;
  password?: string;
  profileImage?: string;
  photoURL?: string;
  status: CaptainStatus;
  accountStatus?: CaptainAccountStatus;
  isApproved?: boolean;
  emailVerified?: boolean;
  address?: string;
  licensePlate?: string;
  profileImagePath?: string;
  idFrontImagePath?: string;
  idBackImagePath?: string;
  licenseImagePath?: string;
  rejectionReason?: string;
  suspensionReason?: string;
  blockReason?: string;
  isOnline?: boolean;
  canReceiveOrders?: boolean;
  ordersCount: number;
  rating: number;
  createdAt?: any;
  createdAtMs?: number;
  updatedAt?: any;
  statusUpdatedAt?: any;
  vehicleType?: string;
  location?: any; // GeoPoint or { lat, lng } or { latitude, longitude }
  coords?: { lat: number; lng: number } | null;
  lastLocationUpdate?: any;
  currentOrderId?: string;
  raw?: Record<string, any>;
}

export interface CaptainAuditLogEntry {
  id: string;
  captainId: string;
  captainName?: string;
  captainPhone?: string;
  action:
    | 'registration_received'
    | 'approved'
    | 'rejected'
    | 'suspended'
    | 'reactivated'
    | 'blocked'
    | string;
  previousAccountStatus?: string;
  newAccountStatus: string;
  reason?: string;
  note?: string;
  performedByUid: string;
  performedByEmail?: string;
  performedByName?: string;
  createdAt: string;
  createdAtMs: number;
}

export interface NearestCaptainResult {
  captain: Captain;
  distanceKm: number;
  formattedDistance: string;
  isFresh: boolean;
  minutesAgo: number;
  formattedTime: string;
}

export type OrderStatus =
  | 'New'
  | 'Accepted'
  | 'Preparing'
  | 'Ready'
  | 'Picked Up'
  | 'Delivered'
  | 'Cancelled';

export interface OrderItem {
  id?: string;
  name: string;
  quantity: number;
  price: number;
}

export interface Order {
  id: string;
  orderNumber: string;
  orderCode?: string;
  merchantId?: string;
  restaurantId?: string;
  restaurantName: string;
  customerName: string;
  customerPhone?: string;
  deliveryAddress?: string;
  captainId?: string;
  captainName?: string;
  offeredCaptainId?: string;
  offeredCaptainName?: string;
  offerExpiresAt?: any;
  offerGeneration?: number;
  dispatchStatus?: string;
  receiptImageUrl?: string;
  receiptImagePath?: string;
  subtotal: number;
  deliveryFee: number;
  total: number;
  status: OrderStatus;
  createdAt?: any;
  assignedAt?: any;
  acceptedAt?: any;
  arrivedAtMerchantAt?: any;
  pickedUpAt?: any;
  deliveredAt?: any;
  captainSearchDuration?: string;
  captainSearchSeconds?: number;
  distanceToMerchantKm?: number;
  items?: OrderItem[];
  raw?: Record<string, any>;
}

export interface SubscriptionPlan {
  captainsCount: number;
  price: number;
  label: string;
}

export interface Subscription {
  id: string;
  subscriptionNumber?: string;
  restaurantId: string;
  restaurantName: string;
  merchantLogo?: string;
  merchantPhone?: string;
  merchantEmail?: string;
  planId?: string | number;
  planKey?: string;
  plan: string;
  captainsCount?: number;
  price: number;
  durationDays?: number;
  startDate: string;
  endDate: string;
  status: SubscriptionStatus;
  paymentMethod?: string;
  paymentStatus?: string;
  lastPaymentId?: string;
  lastRequestId?: string;
  subscriptionVersion?: number;
  isHistorical?: boolean;
  archivedReason?: string;
  archivedAt?: string;
  raw?: Record<string, any>;
}

export type PaymentMethod = 'Visa' | 'Mobile Wallet' | 'Cash' | string;
export type PaymentStatus = 'success' | 'pending' | 'failed';

export interface Payment {
  id: string;
  requestId?: string;
  subscriptionId?: string;
  subscriptionNumber?: string;
  type?: string;
  source?: string;
  transactionId?: string;
  transactionNumber?: string;
  transactionReference?: string;
  restaurantId?: string;
  restaurantName: string;
  merchantPhone?: string;
  planId?: string;
  packageId?: string;
  planName?: string;
  packageName?: string;
  maxCaptains?: number;
  amount: number;
  paymentMethod: PaymentMethod;
  senderPhone?: string;
  receiverWalletNumber?: string;
  receiptImagePath?: string;
  receiptImageUrl?: string;
  status: PaymentStatus;
  paymentStatus?: string;
  date?: string;
  billingMonth?: string;
  createdAt?: any;
  createdAtMs?: number;
  notes?: string;
  raw?: Record<string, any>;
}

export interface DashboardStats {
  totalRestaurants: number;
  activeRestaurants: number;
  totalCaptains: number;
  activeCaptains: number;
  totalOrders: number;
  todayOrders: number;
  completedOrders: number;
  cancelledOrders: number;
  totalRevenue: number;
  monthlyRevenue?: number;
  dailyOrderVolume?: number;
  avgOrderValue?: number;
  avgDeliveryTimeMinutes?: number;
  orderSuccessRate?: number;
}

export interface SystemSettings {
  companyName: string;
  companyNameAr: string;
  supportPhone: string;
  supportEmail: string;
  address: string;
  baseDeliveryFee: number;
  perKmRate: number;
  taxRatePercent: number;
  activeCities: string[];
}

// -----------------------------------------------------------------------------
// Captain Shifts & Work Schedule Types (نظام إدارة شفتات وساعات عمل الكباتن)
// -----------------------------------------------------------------------------
export type DayOfWeek =
  | 'saturday'
  | 'sunday'
  | 'monday'
  | 'tuesday'
  | 'wednesday'
  | 'thursday'
  | 'friday';

export interface ShiftTimeSlot {
  id: string;
  name?: string;
  startTime: string; // "HH:mm" e.g. "09:00"
  endTime: string;   // "HH:mm" e.g. "17:00" or "02:00" (overnight)
  durationHours: number; // calculated hours
  isOvernight?: boolean;
}

export interface DaySchedule {
  day: DayOfWeek;
  dayNameAr: string;
  isDayOff: boolean;
  shifts: ShiftTimeSlot[];
  totalHours: number;
}

export type ShiftWorkStatus =
  | 'active'        // أخضر: يعمل ومستعد لاستقبال الطلبات
  | 'starting_soon' // برتقالي: لديه شفت قريب وسيبدأ العمل قريباً
  | 'ready'         // أصفر: أكد الجاهزية وينتظر بداية الشفت
  | 'off_shift'     // أحمر: خارج ساعات العمل ولا يستقبل طلبات
  | 'paused'        // رمادي: جدول العمل متوقف مؤقتاً
  | 'unscheduled';  // رمادي: غير مجدول

export interface NextShiftInfo {
  day: DayOfWeek;
  dayNameAr: string;
  shift: ShiftTimeSlot;
  startsInMinutes: number;
  startTimeFormatted: string;
  isToday: boolean;
}

export interface CaptainShiftStatusInfo {
  status: ShiftWorkStatus;
  statusLabelAr: string;
  statusBadgeVariant: 'success' | 'warning' | 'danger' | 'neutral';
  isEligibleForOrders: boolean;
  currentShift: ShiftTimeSlot | null;
  nextShift: NextShiftInfo | null;
  currentShiftEnd: string | null;
  todayWorkingHours: number;
  weeklyWorkingHours: number;
  isPaused: boolean;
  isDayOffToday: boolean;
  currentTimeInCairo: string;
  message?: string;
}

export interface CaptainSchedule {
  id: string; // captainId / UID
  captainId: string;
  captainName: string;
  captainPhone?: string;
  isPaused: boolean;
  notes?: string;
  weeklySchedule: Record<DayOfWeek, DaySchedule>;
  totalWeeklyHours: number;
  updatedAt?: any;
  createdAt?: any;
  updatedBy?: string;
  raw?: Record<string, any>;
}

// -----------------------------------------------------------------------------
// Firebase Cloud Messaging (FCM) & In-Dashboard Admin Notifications
// -----------------------------------------------------------------------------
export type AdminNotificationType =
  | 'new_order'
  | 'captain_assignment_failed'
  | 'manual_subscription_request'
  | 'new_captain_registration'
  | 'system';

export interface AdminNotification {
  id: string;
  type: AdminNotificationType;
  title: string;
  body: string;
  orderId?: string;
  orderNumber?: string;
  requestId?: string;
  merchantId?: string;
  captainId?: string;
  restaurantName?: string;
  reason?: string;
  isRead: boolean;
  createdAt: string;
  userId?: string;
}

// -----------------------------------------------------------------------------
// Manual Vodafone Cash Subscription Review & Payment Settings Types
// -----------------------------------------------------------------------------
export type ManualSubscriptionRequestStatus =
  | 'pending_review'
  | 'pending'
  | 'under_review'
  | 'resubmission_required'
  | 'resubmission_requested'
  | 'approved'
  | 'rejected';

export interface ManualSubscriptionReviewEntry {
  action:
    | 'submitted'
    | 'resubmitted'
    | 'approved'
    | 'rejected'
    | 'resubmission_required'
    | 'resubmission_requested'
    | string;
  reviewerId: string;
  reviewerEmail?: string;
  reviewerName?: string;
  note?: string;
  reason?: string;
  timestampIso: string;
  timestampMs?: number;
}

export interface ManualSubscriptionPreviousReceipt {
  receiptImagePath?: string;
  receiptImageUrl?: string;
  senderPhone?: string;
  transactionReference?: string;
  flaggedReason?: string;
  flaggedAtIso?: string;
  replacedAtIso?: string;
}

export interface ManualSubscriptionRequest {
  id: string;
  requestNumber: string;
  merchantId: string;
  merchantName: string;
  merchantPhone: string;
  merchantEmail: string;
  planId: string;
  planName: string;
  maxCaptains: number;
  amount: number;
  durationDays: number;
  senderPhone: string;
  receiverWalletNumber: string;
  transactionReference: string;
  receiptImagePath: string;
  receiptImageUrl: string;
  status: ManualSubscriptionRequestStatus;
  paymentStatus: string;
  createdAt: string;
  createdAtMs: number;
  updatedAt?: string;
  approvedBy?: string;
  approvedByName?: string;
  approvedByEmail?: string;
  approvedAt?: string;
  rejectedBy?: string;
  rejectedByName?: string;
  rejectedByEmail?: string;
  rejectedAt?: string;
  rejectionReason?: string;
  resubmissionReason?: string;
  resubmissionNote?: string;
  adminNote?: string;
  merchantNote?: string;
  paymentDocId?: string;
  subscriptionStartDate?: string;
  subscriptionEndDate?: string;
  previousReceipts: ManualSubscriptionPreviousReceipt[];
  reviewHistory: ManualSubscriptionReviewEntry[];
  raw?: Record<string, any>;
}

export interface OfficialSubscriptionPlanConfig {
  planId: string;
  planName: string;
  maxCaptains: number;
  price: number;
  durationDays: number;
  features?: string[];
  isActive: boolean;
  isPopular?: boolean;
}

export interface ManualSubscriptionSettings {
  vodafoneCashNumber: string;
  walletHolderName: string;
  vodafoneCashInstructions?: string;
  isAcceptingSubscriptions: boolean;
  pauseMessage: string;
  durationDays: number;
  plans: OfficialSubscriptionPlanConfig[];
  configVersion?: number;
  updatedAt?: string;
  updatedBy?: string;
  updatedByEmail?: string;
  updatedByName?: string;
  isConfiguredInFirestore?: boolean;
}



