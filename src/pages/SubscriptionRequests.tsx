import React, { useEffect, useMemo, useState } from 'react';
import {
  Search,
  RefreshCw,
  ArrowUpDown,
  Eye,
  CheckCircle2,
  XCircle,
  RotateCcw,
  Receipt,
  ZoomIn,
  ZoomOut,
  Maximize2,
  X,
  Phone,
  Mail,
  Wallet,
  Hash,
  Clock,
  ShieldCheck,
  AlertTriangle,
  Copy,
  Check,
  Users,
  Calendar,
  History,
  ImageOff,
  CreditCard,
} from 'lucide-react';
import { ManualSubscriptionService } from '../services/manualSubscriptionService';
import {
  ManualSubscriptionRequest,
  ManualSubscriptionRequestStatus,
  ManualSubscriptionSettings,
} from '../types';
import { useToast } from '../contexts/ToastContext';
import { FirebaseImage } from '../components/common/FirebaseImage';
import { resolveStorageImageDetailed } from '../utils/storageUtils';
import { formatDateTime, formatCurrency } from '../utils/formatters';

type StatusFilter = 'all' | 'pending_review' | 'resubmission_required' | 'approved' | 'rejected';

const STATUS_META: Record<
  ManualSubscriptionRequestStatus,
  { label: string; badgeClass: string; dotClass: string }
> = {
  pending_review: {
    label: 'قيد المراجعة',
    badgeClass: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
    dotClass: 'bg-amber-400',
  },
  pending: {
    label: 'قيد المراجعة',
    badgeClass: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
    dotClass: 'bg-amber-400',
  },
  under_review: {
    label: 'جاري المراجعة',
    badgeClass: 'bg-sky-500/10 text-sky-400 border-sky-500/30',
    dotClass: 'bg-sky-400',
  },
  resubmission_required: {
    label: 'مطلوب إعادة إرسال',
    badgeClass: 'bg-orange-500/10 text-orange-400 border-orange-500/30',
    dotClass: 'bg-orange-400',
  },
  resubmission_requested: {
    label: 'مطلوب إعادة إرسال',
    badgeClass: 'bg-orange-500/10 text-orange-400 border-orange-500/30',
    dotClass: 'bg-orange-400',
  },
  approved: {
    label: 'تمت الموافقة والتفعيل',
    badgeClass: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
    dotClass: 'bg-emerald-400',
  },
  rejected: {
    label: 'مرفوض',
    badgeClass: 'bg-rose-500/10 text-rose-400 border-rose-500/30',
    dotClass: 'bg-rose-400',
  },
};

function getHistoryActionLabel(action: string): string {
  switch (action) {
    case 'approved':
      return 'موافقة وتفعيل الاشتراك';
    case 'rejected':
      return 'رفض الطلب';
    case 'resubmission_required':
    case 'resubmission_requested':
      return 'طلب إعادة إرسال الإيصال';
    case 'resubmitted':
      return 'إعادة رفع إيصال جديد من التاجر';
    case 'submitted':
      return 'تقديم الطلب من التاجر';
    default:
      return action || 'إجراء مراجعة';
  }
}

export const SubscriptionRequestsPage: React.FC = () => {
  const { success, error: showError, info } = useToast();

  const [requests, setRequests] = useState<ManualSubscriptionRequest[]>([]);
  const [settings, setSettings] = useState<ManualSubscriptionSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Filters & sorting
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [sortOrder, setSortOrder] = useState<'desc' | 'asc'>('desc');

  // Selected request & receipt zoom/lightbox
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const [resolvedReceiptUrl, setResolvedReceiptUrl] = useState<string | null>(null);
  const [receiptErrorCode, setReceiptErrorCode] = useState<string | null>(null);
  const [receiptLoading, setReceiptLoading] = useState(false);
  const [zoomScale, setZoomScale] = useState(1);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  // Action modals
  const [approveModalOpen, setApproveModalOpen] = useState(false);
  const [approveAdminNote, setApproveAdminNote] = useState('');
  const [rejectModalOpen, setRejectModalOpen] = useState(false);
  const [rejectionReason, setRejectionReason] = useState('');
  const [resubmitModalOpen, setResubmitModalOpen] = useState(false);
  const [resubmissionNote, setResubmissionNote] = useState('');
  const [submittingAction, setSubmittingAction] = useState(false);

  // Live subscription to manual_subscription_requests + load payment config
  useEffect(() => {
    setLoading(true);
    const unsub = ManualSubscriptionService.subscribeRequests(
      (items) => {
        setRequests(items);
        setLoading(false);
      },
      (err) => {
        setLoading(false);
        showError(`تعذر تحميل طلبات الاشتراك: ${err.message}`);
      }
    );

    ManualSubscriptionService.getSettings()
      .then((cfg) => setSettings(cfg))
      .catch(() => {
        // Non-blocking
      });

    return () => unsub();
  }, [showError]);

  const selectedRequest = useMemo(
    () => requests.find((r) => r.id === selectedRequestId) || null,
    [requests, selectedRequestId]
  );

  // Resolve full-resolution receipt image whenever selectedRequest changes
  useEffect(() => {
    let active = true;
    setZoomScale(1);
    setLightboxOpen(false);

    if (!selectedRequest) {
      setResolvedReceiptUrl(null);
      setReceiptErrorCode(null);
      setReceiptLoading(false);
      return;
    }

    const primary = selectedRequest.receiptImagePath || selectedRequest.receiptImageUrl;
    const fallbacks: string[] = [];
    if (selectedRequest.receiptImagePath && selectedRequest.receiptImageUrl) {
      fallbacks.push(selectedRequest.receiptImageUrl);
    }

    if (!primary) {
      setResolvedReceiptUrl(null);
      setReceiptErrorCode('missing');
      setReceiptLoading(false);
      return;
    }

    setReceiptLoading(true);
    setReceiptErrorCode(null);

    resolveStorageImageDetailed(primary, fallbacks).then((res) => {
      if (!active) return;
      setResolvedReceiptUrl(res.url);
      setReceiptErrorCode(res.url ? null : res.errorCode || 'not_found');
      setReceiptLoading(false);
    });

    return () => {
      active = false;
    };
  }, [selectedRequest?.id, selectedRequest?.receiptImagePath, selectedRequest?.receiptImageUrl]);

  const handleManualRefresh = async () => {
    setRefreshing(true);
    try {
      const [fresh, cfg] = await Promise.all([
        ManualSubscriptionService.getAllRequests(),
        ManualSubscriptionService.getSettings(),
      ]);
      setRequests(fresh);
      setSettings(cfg);
      info('تم تحديث قائمة طلبات الاشتراك');
    } catch (err: any) {
      showError(err?.message || 'تعذر تحديث البيانات');
    } finally {
      setRefreshing(false);
    }
  };

  const handleCopy = (label: string, value: string) => {
    if (!value) return;
    navigator.clipboard?.writeText(value).then(() => {
      setCopiedField(label);
      setTimeout(() => setCopiedField(null), 1600);
    });
  };

  // KPI metrics
  const stats = useMemo(() => {
    let pending = 0;
    let resubmission = 0;
    let approved = 0;
    let rejected = 0;
    let approvedRevenue = 0;

    for (const r of requests) {
      if (r.status === 'pending_review' || r.status === 'pending' || r.status === 'under_review') {
        pending++;
      } else if (
        r.status === 'resubmission_required' ||
        r.status === 'resubmission_requested'
      ) {
        resubmission++;
      } else if (r.status === 'approved') {
        approved++;
        approvedRevenue += r.amount || 0;
      } else if (r.status === 'rejected') rejected++;
    }
    return {
      total: requests.length,
      pending,
      resubmission,
      approved,
      rejected,
      approvedRevenue,
    };
  }, [requests]);

  // Filtered + sorted rows
  const filteredRequests = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const list = requests.filter((req) => {
      if (statusFilter === 'pending_review') {
        if (
          req.status !== 'pending_review' &&
          req.status !== 'pending' &&
          req.status !== 'under_review'
        ) {
          return false;
        }
      } else if (statusFilter === 'resubmission_required') {
        if (
          req.status !== 'resubmission_required' &&
          req.status !== 'resubmission_requested'
        ) {
          return false;
        }
      } else if (statusFilter !== 'all' && req.status !== statusFilter) {
        return false;
      }

      if (!q) return true;
      return (
        req.requestNumber.toLowerCase().includes(q) ||
        req.merchantName.toLowerCase().includes(q) ||
        req.merchantPhone.toLowerCase().includes(q) ||
        req.senderPhone.toLowerCase().includes(q) ||
        req.transactionReference.toLowerCase().includes(q) ||
        req.merchantEmail.toLowerCase().includes(q) ||
        req.planName.toLowerCase().includes(q)
      );
    });

    return [...list].sort((a, b) =>
      sortOrder === 'desc' ? b.createdAtMs - a.createdAtMs : a.createdAtMs - b.createdAtMs
    );
  }, [requests, searchQuery, statusFilter, sortOrder]);

  const canReviewSelected =
    selectedRequest !== null &&
    selectedRequest.status !== 'approved' &&
    selectedRequest.status !== 'rejected';

  // Server-authoritative handlers
  const handleConfirmApprove = async () => {
    if (!selectedRequest) return;
    setSubmittingAction(true);
    try {
      const res = await ManualSubscriptionService.approveRequest(
        selectedRequest.id,
        approveAdminNote
      );
      success(res.message || 'تمت الموافقة وتفعيل اشتراك التاجر بنجاح');
      setApproveModalOpen(false);
      setApproveAdminNote('');
    } catch (err: any) {
      showError(err?.message || 'فشل اعتماد الاشتراك من الخادم');
    } finally {
      setSubmittingAction(false);
    }
  };

  const handleConfirmReject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedRequest) return;
    setSubmittingAction(true);
    try {
      const res = await ManualSubscriptionService.rejectRequest(
        selectedRequest.id,
        rejectionReason
      );
      success(res.message || 'تم رفض طلب الاشتراك وإخطار التاجر');
      setRejectModalOpen(false);
      setRejectionReason('');
    } catch (err: any) {
      showError(err?.message || 'فشل رفض الطلب');
    } finally {
      setSubmittingAction(false);
    }
  };

  const handleConfirmResubmission = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedRequest) return;
    setSubmittingAction(true);
    try {
      const res = await ManualSubscriptionService.requestResubmission(
        selectedRequest.id,
        resubmissionNote
      );
      success(res.message || 'تم إرسال طلب إعادة رفع الإيصال للتاجر');
      setResubmitModalOpen(false);
      setResubmissionNote('');
    } catch (err: any) {
      showError(err?.message || 'فشل إرسال طلب إعادة الإرسال');
    } finally {
      setSubmittingAction(false);
    }
  };

  const effectiveReceiverWallet = (req: ManualSubscriptionRequest): string =>
    req.receiverWalletNumber || settings?.vodafoneCashNumber || '';

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl sm:text-2xl font-black text-white">
            طلبات اشتراك فودافون كاش
          </h2>
          <p className="text-xs sm:text-sm text-zinc-400 mt-0.5">
            مراجعة إيصالات التحويل اليدوية واعتماد تفعيل باقات التجار عبر السيرفر بشكل آمن
          </p>
        </div>

        <div className="flex items-center gap-2.5 self-start sm:self-auto">
          <button
            type="button"
            onClick={() => setSortOrder((prev) => (prev === 'desc' ? 'asc' : 'desc'))}
            className="inline-flex items-center gap-2 px-3.5 py-2.5 rounded-xl bg-[#11141c] border border-zinc-800 hover:border-zinc-700 text-xs font-bold text-zinc-200 transition-colors"
            title="تبديل ترتيب التاريخ"
          >
            <ArrowUpDown className="w-4 h-4 text-amber-400" />
            <span>{sortOrder === 'desc' ? 'الأحدث أولاً' : 'الأقدم أولاً'}</span>
          </button>

          <button
            type="button"
            onClick={handleManualRefresh}
            disabled={refreshing}
            className="inline-flex items-center gap-2 px-3.5 py-2.5 rounded-xl bg-amber-500/10 border border-amber-500/30 hover:bg-amber-500/20 text-xs font-bold text-amber-400 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
            <span>تحديث</span>
          </button>
        </div>
      </div>

      {/* KPI Summary Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <div className="bg-[#11141c] border border-zinc-800/90 rounded-2xl p-4">
          <p className="text-xs text-zinc-400 font-semibold">إجمالي الطلبات</p>
          <p className="text-2xl font-black text-white mt-1.5 tabular-nums">{stats.total}</p>
        </div>

        <div className="bg-[#11141c] border border-amber-500/25 rounded-2xl p-4">
          <p className="text-xs text-amber-400 font-semibold">بانتظار المراجعة</p>
          <p className="text-2xl font-black text-amber-400 mt-1.5 tabular-nums">{stats.pending}</p>
        </div>

        <div className="bg-[#11141c] border border-zinc-800/90 rounded-2xl p-4">
          <p className="text-xs text-orange-400 font-semibold">مطلوب إعادة إرسال</p>
          <p className="text-2xl font-black text-orange-300 mt-1.5 tabular-nums">
            {stats.resubmission}
          </p>
        </div>

        <div className="bg-[#11141c] border border-zinc-800/90 rounded-2xl p-4">
          <p className="text-xs text-emerald-400 font-semibold">المقبولة والمفعلة</p>
          <div className="flex items-baseline justify-between gap-2 mt-1.5">
            <p className="text-2xl font-black text-emerald-400 tabular-nums">{stats.approved}</p>
            <span className="text-[11px] font-mono text-zinc-400 tabular-nums">
              {formatCurrency(stats.approvedRevenue)}
            </span>
          </div>
        </div>

        <div className="bg-[#11141c] border border-zinc-800/90 rounded-2xl p-4 col-span-2 lg:col-span-1">
          <p className="text-xs text-rose-400 font-semibold">المرفوضة</p>
          <p className="text-2xl font-black text-rose-400 mt-1.5 tabular-nums">{stats.rejected}</p>
        </div>
      </div>

      {/* Search & Status Filter Toolbar */}
      <div className="bg-[#11141c] border border-zinc-800/90 rounded-2xl p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div className="relative flex-1 max-w-xl">
          <Search className="w-4 h-4 text-zinc-500 absolute right-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="ابحث باسم التاجر، رقم الهاتف، رقم التحويل، أو رقم العملية المرجعي..."
            className="w-full bg-[#0a0c12] border border-zinc-800 rounded-xl pr-10 pl-4 py-2.5 text-xs sm:text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-amber-500"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-200"
              aria-label="مسح البحث"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        <div className="flex items-center gap-1.5 flex-wrap">
          {(
            [
              { key: 'all', label: `الكل (${stats.total})` },
              { key: 'pending_review', label: `قيد المراجعة (${stats.pending})` },
              { key: 'resubmission_required', label: `إعادة إرسال (${stats.resubmission})` },
              { key: 'approved', label: `مقبول (${stats.approved})` },
              { key: 'rejected', label: `مرفوض (${stats.rejected})` },
            ] as { key: StatusFilter; label: string }[]
          ).map((tab) => {
            const active = statusFilter === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => setStatusFilter(tab.key)}
                className={`px-3 py-2 rounded-xl text-xs font-bold transition-colors border ${
                  active
                    ? 'bg-amber-500 text-zinc-950 border-amber-400'
                    : 'bg-[#0a0c12] text-zinc-400 border-zinc-800 hover:text-zinc-200 hover:border-zinc-700'
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Main 12-Column Table */}
      <div className="bg-[#11141c] border border-zinc-800/90 rounded-2xl overflow-hidden shadow-xl">
        <div className="overflow-x-auto">
          <table className="w-full text-right border-collapse min-w-[1280px]">
            <thead>
              <tr className="bg-[#0b0d14] border-b border-zinc-800 text-[11px] font-bold text-zinc-400">
                <th className="py-3.5 px-3">رقم الطلب</th>
                <th className="py-3.5 px-3">اسم التاجر</th>
                <th className="py-3.5 px-3">رقم هاتف التاجر</th>
                <th className="py-3.5 px-3">البريد الإلكتروني</th>
                <th className="py-3.5 px-3">اسم الباقة</th>
                <th className="py-3.5 px-3 text-center">عدد الكباتن</th>
                <th className="py-3.5 px-3">المبلغ المطلوب</th>
                <th className="py-3.5 px-3">المحفظة المحولة منها</th>
                <th className="py-3.5 px-3">رقم العملية المرجعي</th>
                <th className="py-3.5 px-3">تاريخ إرسال الطلب</th>
                <th className="py-3.5 px-3">حالة المراجعة</th>
                <th className="py-3.5 px-3 text-center">صورة الإيصال</th>
                <th className="py-3.5 px-3 text-center">التفاصيل</th>
              </tr>
            </thead>

            <tbody className="divide-y divide-zinc-800/70 text-xs">
              {loading ? (
                <tr>
                  <td colSpan={13} className="py-16 text-center text-zinc-400">
                    <div className="inline-flex items-center gap-2.5">
                      <span className="w-5 h-5 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
                      <span>جاري تحميل طلبات الاشتراك...</span>
                    </div>
                  </td>
                </tr>
              ) : filteredRequests.length === 0 ? (
                <tr>
                  <td colSpan={13} className="py-16 text-center">
                    <Receipt className="w-10 h-10 text-zinc-700 mx-auto mb-3" />
                    <p className="text-sm font-bold text-zinc-300">
                      لا توجد طلبات اشتراك مطابقة للبحث أو الفلتر الحالي
                    </p>
                    <p className="text-xs text-zinc-500 mt-1">
                      عندما يرفع أحد التجار إيصال فودافون كاش سيظهر هنا فوراً للمراجعة والاعتماد
                    </p>
                  </td>
                </tr>
              ) : (
                filteredRequests.map((req) => {
                  const statusMeta = STATUS_META[req.status] || STATUS_META.pending_review;
                  const receiptSrc = req.receiptImagePath || req.receiptImageUrl;
                  return (
                    <tr
                      key={req.id}
                      onClick={() => setSelectedRequestId(req.id)}
                      className="hover:bg-zinc-900/60 transition-colors cursor-pointer group"
                    >
                      <td className="py-3 px-3 font-mono font-bold text-amber-400 whitespace-nowrap">
                        {req.requestNumber}
                      </td>
                      <td className="py-3 px-3 font-bold text-white whitespace-nowrap max-w-[160px] truncate">
                        {req.merchantName}
                      </td>
                      <td
                        className="py-3 px-3 font-mono text-zinc-300 whitespace-nowrap tabular-nums"
                        dir="ltr"
                      >
                        {req.merchantPhone || '—'}
                      </td>
                      <td
                        className="py-3 px-3 text-zinc-400 max-w-[175px] truncate"
                        dir="ltr"
                        title={req.merchantEmail}
                      >
                        {req.merchantEmail || '—'}
                      </td>
                      <td className="py-3 px-3 font-semibold text-zinc-200 whitespace-nowrap">
                        {req.planName}
                      </td>
                      <td className="py-3 px-3 text-center font-mono font-bold text-zinc-200 tabular-nums">
                        {req.maxCaptains}
                      </td>
                      <td className="py-3 px-3 font-mono font-black text-emerald-400 whitespace-nowrap tabular-nums">
                        {formatCurrency(req.amount)}
                      </td>
                      <td
                        className="py-3 px-3 font-mono text-zinc-200 whitespace-nowrap tabular-nums"
                        dir="ltr"
                      >
                        {req.senderPhone || '—'}
                      </td>
                      <td
                        className="py-3 px-3 font-mono text-zinc-300 whitespace-nowrap max-w-[140px] truncate"
                        dir="ltr"
                        title={req.transactionReference}
                      >
                        {req.transactionReference || '—'}
                      </td>
                      <td className="py-3 px-3 text-zinc-400 whitespace-nowrap tabular-nums">
                        {formatDateTime(req.createdAt)}
                      </td>
                      <td className="py-3 px-3 whitespace-nowrap">
                        <span
                          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[11px] font-bold ${statusMeta.badgeClass}`}
                        >
                          <span className={`w-1.5 h-1.5 rounded-full ${statusMeta.dotClass}`} />
                          {statusMeta.label}
                        </span>
                      </td>
                      <td
                        className="py-3 px-3 text-center"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedRequestId(req.id);
                        }}
                      >
                        <div className="inline-flex items-center justify-center">
                          <FirebaseImage
                            src={receiptSrc}
                            fallbackStoragePaths={
                              req.receiptImagePath && req.receiptImageUrl
                                ? [req.receiptImageUrl]
                                : undefined
                            }
                            alt={`إيصال ${req.requestNumber}`}
                            className="w-11 h-11 rounded-lg border border-zinc-700 bg-[#0a0c12]"
                            fallbackContent={
                              <div className="w-full h-full flex items-center justify-center bg-zinc-900 text-zinc-600">
                                <ImageOff className="w-4 h-4" />
                              </div>
                            }
                          />
                        </div>
                      </td>
                      <td className="py-3 px-3 text-center whitespace-nowrap">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedRequestId(req.id);
                          }}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800/80 hover:bg-amber-500 hover:text-zinc-950 text-zinc-200 font-bold text-[11px] transition-colors"
                        >
                          <Eye className="w-3.5 h-3.5" />
                          <span>مراجعة</span>
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Full Details Modal */}
      {selectedRequest && (
        <div
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-3 sm:p-5 overflow-y-auto"
          onClick={() => {
            if (!submittingAction) setSelectedRequestId(null);
          }}
        >
          <div
            className="bg-[#11141c] border border-zinc-800 rounded-3xl w-full max-w-5xl max-h-[92vh] overflow-hidden flex flex-col shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="px-6 py-4 bg-[#0b0d14] border-b border-zinc-800 flex items-center justify-between gap-4 shrink-0">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-400 flex items-center justify-center shrink-0">
                  <Receipt className="w-5 h-5" />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2.5 flex-wrap">
                    <h3 className="text-base sm:text-lg font-black text-white truncate">
                      تفاصيل طلب الاشتراك —{' '}
                      <span className="font-mono text-amber-400">
                        {selectedRequest.requestNumber}
                      </span>
                    </h3>
                    <span
                      className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-lg border text-[11px] font-bold ${
                        (STATUS_META[selectedRequest.status] || STATUS_META.pending_review).badgeClass
                      }`}
                    >
                      {(STATUS_META[selectedRequest.status] || STATUS_META.pending_review).label}
                    </span>
                  </div>
                  <p className="text-xs text-zinc-400 mt-0.5 tabular-nums">
                    وقت الإرسال: {formatDateTime(selectedRequest.createdAt)}
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setSelectedRequestId(null)}
                disabled={submittingAction}
                className="p-2 rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-white transition-colors"
                aria-label="إغلاق"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-6 overflow-y-auto grid grid-cols-1 lg:grid-cols-12 gap-6">
              {/* Right Column: Merchant, Plan, Transfer & Audit Info */}
              <div className="lg:col-span-7 space-y-5">
                {/* Merchant Info */}
                <section className="bg-[#0a0c12] border border-zinc-800/90 rounded-2xl p-4 space-y-3">
                  <h4 className="text-xs font-black text-amber-400 flex items-center gap-2">
                    <Users className="w-4 h-4" />
                    <span>بيانات التاجر</span>
                  </h4>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                    <div>
                      <span className="text-zinc-500 block mb-0.5">اسم التاجر / المطعم</span>
                      <span className="font-bold text-white text-sm">
                        {selectedRequest.merchantName}
                      </span>
                    </div>
                    <div>
                      <span className="text-zinc-500 block mb-0.5">معرف التاجر (Merchant ID)</span>
                      <span className="font-mono text-zinc-300 text-[11px] break-all">
                        {selectedRequest.merchantId || '—'}
                      </span>
                    </div>
                    <div>
                      <span className="text-zinc-500 block mb-0.5">رقم هاتف التاجر</span>
                      <span
                        className="font-mono text-zinc-200 inline-flex items-center gap-1.5"
                        dir="ltr"
                      >
                        <Phone className="w-3.5 h-3.5 text-zinc-500" />
                        {selectedRequest.merchantPhone || '—'}
                      </span>
                    </div>
                    <div>
                      <span className="text-zinc-500 block mb-0.5">البريد الإلكتروني</span>
                      <span
                        className="font-mono text-zinc-200 inline-flex items-center gap-1.5 break-all"
                        dir="ltr"
                      >
                        <Mail className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                        {selectedRequest.merchantEmail || '—'}
                      </span>
                    </div>
                  </div>
                </section>

                {/* Plan & Amount Info */}
                <section className="bg-[#0a0c12] border border-zinc-800/90 rounded-2xl p-4 space-y-3">
                  <h4 className="text-xs font-black text-emerald-400 flex items-center gap-2">
                    <CreditCard className="w-4 h-4" />
                    <span>بيانات الباقة والمبلغ المطلوب</span>
                  </h4>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                    <div>
                      <span className="text-zinc-500 block mb-0.5">اسم الباقة</span>
                      <span className="font-bold text-white">{selectedRequest.planName}</span>
                    </div>
                    <div>
                      <span className="text-zinc-500 block mb-0.5">عدد الكباتن</span>
                      <span className="font-mono font-bold text-zinc-100 tabular-nums">
                        {selectedRequest.maxCaptains} كابتن
                      </span>
                    </div>
                    <div>
                      <span className="text-zinc-500 block mb-0.5">مدة الاشتراك</span>
                      <span className="font-mono font-bold text-zinc-100 tabular-nums">
                        {selectedRequest.durationDays} يوم
                      </span>
                    </div>
                    <div>
                      <span className="text-zinc-500 block mb-0.5">المبلغ المطلوب</span>
                      <span className="font-mono font-black text-emerald-400 text-sm tabular-nums">
                        {formatCurrency(selectedRequest.amount)}
                      </span>
                    </div>
                  </div>
                </section>

                {/* Vodafone Cash Transfer Details */}
                <section className="bg-[#0a0c12] border border-zinc-800/90 rounded-2xl p-4 space-y-3">
                  <h4 className="text-xs font-black text-sky-400 flex items-center gap-2">
                    <Wallet className="w-4 h-4" />
                    <span>بيانات تحويل فودافون كاش</span>
                  </h4>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                    <div className="p-3 rounded-xl bg-[#11141c] border border-zinc-800">
                      <span className="text-zinc-500 block mb-1">
                        رقم محفظة فودافون كاش المستلمة
                      </span>
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono font-bold text-amber-400 text-sm" dir="ltr">
                          {effectiveReceiverWallet(selectedRequest) ||
                            'غير مضبوط (اضبطه من الإعدادات)'}
                        </span>
                        {effectiveReceiverWallet(selectedRequest) && (
                          <button
                            type="button"
                            onClick={() =>
                              handleCopy('receiver', effectiveReceiverWallet(selectedRequest))
                            }
                            className="p-1.5 rounded-lg bg-zinc-900 text-zinc-400 hover:text-white"
                            title="نسخ رقم المحفظة المستلمة"
                          >
                            {copiedField === 'receiver' ? (
                              <Check className="w-3.5 h-3.5 text-emerald-400" />
                            ) : (
                              <Copy className="w-3.5 h-3.5" />
                            )}
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="p-3 rounded-xl bg-[#11141c] border border-zinc-800">
                      <span className="text-zinc-500 block mb-1">رقم المحفظة المحولة منها</span>
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono font-bold text-white text-sm" dir="ltr">
                          {selectedRequest.senderPhone || '—'}
                        </span>
                        {selectedRequest.senderPhone && (
                          <button
                            type="button"
                            onClick={() => handleCopy('sender', selectedRequest.senderPhone)}
                            className="p-1.5 rounded-lg bg-zinc-900 text-zinc-400 hover:text-white"
                            title="نسخ رقم المحول"
                          >
                            {copiedField === 'sender' ? (
                              <Check className="w-3.5 h-3.5 text-emerald-400" />
                            ) : (
                              <Copy className="w-3.5 h-3.5" />
                            )}
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="sm:col-span-2 p-3 rounded-xl bg-[#11141c] border border-zinc-800">
                      <span className="text-zinc-500 block mb-1">رقم العملية المرجعي</span>
                      <div className="flex items-center justify-between gap-2">
                        <span
                          className="font-mono font-bold text-zinc-100 text-sm inline-flex items-center gap-1.5"
                          dir="ltr"
                        >
                          <Hash className="w-3.5 h-3.5 text-amber-400" />
                          {selectedRequest.transactionReference || '—'}
                        </span>
                        {selectedRequest.transactionReference && (
                          <button
                            type="button"
                            onClick={() => handleCopy('ref', selectedRequest.transactionReference)}
                            className="p-1.5 rounded-lg bg-zinc-900 text-zinc-400 hover:text-white"
                            title="نسخ الرقم المرجعي"
                          >
                            {copiedField === 'ref' ? (
                              <Check className="w-3.5 h-3.5 text-emerald-400" />
                            ) : (
                              <Copy className="w-3.5 h-3.5" />
                            )}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>

                  {selectedRequest.merchantNote && (
                    <div className="p-3 rounded-xl bg-zinc-900/70 border border-zinc-800 text-xs">
                      <span className="text-zinc-500 font-bold block mb-1">ملاحظة التاجر:</span>
                      <p className="text-zinc-200">{selectedRequest.merchantNote}</p>
                    </div>
                  )}
                </section>

                {/* Approval / Rejection Result Banner */}
                {selectedRequest.status === 'approved' && (
                  <section className="p-4 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 text-xs space-y-2">
                    <div className="flex items-center gap-2 font-black text-emerald-400">
                      <ShieldCheck className="w-4 h-4" />
                      <span>تم اعتماد الطلب وتفعيل الاشتراك عبر السيرفر</span>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-zinc-300">
                      <div>
                        <span className="text-zinc-500">المسؤول المعتمد: </span>
                        <span className="font-bold">
                          {selectedRequest.approvedByName ||
                            selectedRequest.approvedByEmail ||
                            selectedRequest.approvedBy ||
                            'الإدارة'}
                        </span>
                      </div>
                      {selectedRequest.approvedAt && (
                        <div>
                          <span className="text-zinc-500">وقت الاعتماد: </span>
                          <span className="font-mono">
                            {formatDateTime(selectedRequest.approvedAt)}
                          </span>
                        </div>
                      )}
                      {selectedRequest.subscriptionStartDate && (
                        <div>
                          <span className="text-zinc-500">بداية الاشتراك: </span>
                          <span className="font-mono">
                            {formatDateTime(selectedRequest.subscriptionStartDate)}
                          </span>
                        </div>
                      )}
                      {selectedRequest.subscriptionEndDate && (
                        <div>
                          <span className="text-zinc-500">انتهاء الاشتراك: </span>
                          <span className="font-mono">
                            {formatDateTime(selectedRequest.subscriptionEndDate)}
                          </span>
                        </div>
                      )}
                      {selectedRequest.paymentDocId && (
                        <div className="sm:col-span-2">
                          <span className="text-zinc-500">معرف السجل المالي: </span>
                          <span className="font-mono text-emerald-300">
                            {selectedRequest.paymentDocId}
                          </span>
                        </div>
                      )}
                    </div>
                  </section>
                )}

                {selectedRequest.status === 'rejected' && (
                  <section className="p-4 rounded-2xl bg-rose-500/10 border border-rose-500/30 text-xs space-y-1.5">
                    <div className="flex items-center gap-2 font-black text-rose-400">
                      <XCircle className="w-4 h-4" />
                      <span>تم رفض هذا الطلب</span>
                    </div>
                    <p className="text-zinc-200">
                      <span className="text-zinc-400">سبب الرفض: </span>
                      {selectedRequest.rejectionReason || 'لم يتم تحديد سبب'}
                    </p>
                    <p className="text-zinc-400">
                      بواسطة:{' '}
                      {selectedRequest.rejectedByName ||
                        selectedRequest.rejectedByEmail ||
                        selectedRequest.rejectedBy ||
                        'الإدارة'}
                      {selectedRequest.rejectedAt
                        ? ` — ${formatDateTime(selectedRequest.rejectedAt)}`
                        : ''}
                    </p>
                  </section>
                )}

                {(selectedRequest.status === 'resubmission_required' ||
                  selectedRequest.status === 'resubmission_requested') &&
                  (selectedRequest.resubmissionReason || selectedRequest.resubmissionNote) && (
                    <section className="p-4 rounded-2xl bg-orange-500/10 border border-orange-500/30 text-xs space-y-1">
                      <div className="flex items-center gap-2 font-black text-orange-400">
                        <RotateCcw className="w-4 h-4" />
                        <span>بانتظار إعادة رفع الإيصال من التاجر</span>
                      </div>
                      <p className="text-zinc-200">
                        {selectedRequest.resubmissionReason || selectedRequest.resubmissionNote}
                      </p>
                    </section>
                  )}

                {/* Previous Receipt Attempts (if resubmitted) */}
                {selectedRequest.previousReceipts.length > 0 && (
                  <section className="bg-[#0a0c12] border border-zinc-800/90 rounded-2xl p-4 space-y-2.5">
                    <h4 className="text-xs font-black text-orange-400 flex items-center gap-2">
                      <RotateCcw className="w-4 h-4" />
                      <span>الإيصالات السابقة المؤرشفة ({selectedRequest.previousReceipts.length})</span>
                    </h4>
                    <div className="space-y-2 max-h-40 overflow-y-auto pl-1">
                      {selectedRequest.previousReceipts.map((prev, idx) => (
                        <div
                          key={`${prev.receiptImagePath || idx}-${prev.flaggedAtIso || prev.replacedAtIso || idx}`}
                          className="p-2.5 rounded-xl bg-[#11141c] border border-zinc-800 text-[11px] space-y-1"
                        >
                          <div className="flex items-center justify-between gap-2 text-zinc-400">
                            <span className="font-mono" dir="ltr">
                              {prev.senderPhone || '—'}
                              {prev.transactionReference ? ` • ${prev.transactionReference}` : ''}
                            </span>
                            <span className="font-mono text-[10px]">
                              {prev.replacedAtIso
                                ? formatDateTime(prev.replacedAtIso)
                                : prev.flaggedAtIso
                                  ? formatDateTime(prev.flaggedAtIso)
                                  : '—'}
                            </span>
                          </div>
                          {prev.flaggedReason && (
                            <p className="text-orange-300">{prev.flaggedReason}</p>
                          )}
                          {prev.receiptImagePath && (
                            <p className="font-mono text-[10px] text-zinc-500 truncate" dir="ltr">
                              {prev.receiptImagePath}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                {/* Previous Review History */}
                <section className="bg-[#0a0c12] border border-zinc-800/90 rounded-2xl p-4 space-y-3">
                  <h4 className="text-xs font-black text-zinc-300 flex items-center gap-2">
                    <History className="w-4 h-4 text-amber-400" />
                    <span>سجل المراجعات السابق ({selectedRequest.reviewHistory.length})</span>
                  </h4>
                  {selectedRequest.reviewHistory.length === 0 ? (
                    <p className="text-xs text-zinc-500">
                      لا توجد مراجعات سابقة مسجلة على هذا الطلب حتى الآن.
                    </p>
                  ) : (
                    <div className="space-y-2.5 max-h-52 overflow-y-auto pl-1">
                      {selectedRequest.reviewHistory.map((entry, idx) => (
                        <div
                          key={`${entry.timestampIso || idx}-${entry.action}`}
                          className="p-3 rounded-xl bg-[#11141c] border border-zinc-800 text-xs space-y-1"
                        >
                          <div className="flex items-center justify-between gap-2 flex-wrap">
                            <span className="font-bold text-amber-400">
                              {getHistoryActionLabel(entry.action)}
                            </span>
                            <span className="text-[11px] font-mono text-zinc-500 tabular-nums inline-flex items-center gap-1">
                              <Clock className="w-3 h-3" />
                              {entry.timestampIso ? formatDateTime(entry.timestampIso) : '—'}
                            </span>
                          </div>
                          <p className="text-zinc-400 text-[11px]">
                            المراجع: {entry.reviewerName || entry.reviewerEmail || 'مسؤول الإدارة'}
                            {entry.reviewerEmail ? ` (${entry.reviewerEmail})` : ''}
                          </p>
                          {(entry.reason || entry.note) && (
                            <p className="text-zinc-200 bg-zinc-900/80 rounded-lg px-2.5 py-1.5">
                              {entry.reason || entry.note}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              </div>

              {/* Left Column: High-Quality Zoomable Receipt Viewer */}
              <div className="lg:col-span-5 flex flex-col gap-3">
                <div className="bg-[#0a0c12] border border-zinc-800/90 rounded-2xl p-4 flex flex-col flex-1">
                  <div className="flex items-center justify-between gap-2 mb-3">
                    <h4 className="text-xs font-black text-white flex items-center gap-2">
                      <Receipt className="w-4 h-4 text-amber-400" />
                      <span>صورة إيصال التحويل</span>
                    </h4>

                    {resolvedReceiptUrl && (
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => setZoomScale((s) => Math.max(0.75, +(s - 0.25).toFixed(2)))}
                          className="p-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-300 hover:text-white"
                          title="تصغير"
                        >
                          <ZoomOut className="w-3.5 h-3.5" />
                        </button>
                        <span className="text-[11px] font-mono text-zinc-400 px-1.5 tabular-nums">
                          {Math.round(zoomScale * 100)}%
                        </span>
                        <button
                          type="button"
                          onClick={() => setZoomScale((s) => Math.min(3, +(s + 0.25).toFixed(2)))}
                          className="p-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-300 hover:text-white"
                          title="تكبير"
                        >
                          <ZoomIn className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setLightboxOpen(true)}
                          className="p-1.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-400 hover:bg-amber-500/20"
                          title="عرض بملء الشاشة"
                        >
                          <Maximize2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="flex-1 min-h-[340px] max-h-[500px] overflow-auto rounded-xl bg-[#07090e] border border-zinc-800 flex items-center justify-center p-2">
                    {receiptLoading ? (
                      <div className="text-center text-zinc-400 text-xs space-y-2">
                        <span className="w-6 h-6 border-2 border-amber-500 border-t-transparent rounded-full animate-spin block mx-auto" />
                        <span>جاري تحميل صورة الإيصال الآمنة...</span>
                      </div>
                    ) : resolvedReceiptUrl ? (
                      <img
                        src={resolvedReceiptUrl}
                        alt={`إيصال تحويل ${selectedRequest.requestNumber}`}
                        referrerPolicy="no-referrer"
                        onClick={() => setLightboxOpen(true)}
                        style={{
                          transform: `scale(${zoomScale})`,
                          transformOrigin: 'center center',
                        }}
                        className="max-w-full max-h-[460px] object-contain rounded-lg transition-transform duration-150 cursor-zoom-in"
                      />
                    ) : (
                      <div className="text-center p-6 space-y-2">
                        <ImageOff className="w-10 h-10 text-zinc-600 mx-auto" />
                        <p className="text-xs font-bold text-zinc-300">
                          {receiptErrorCode === 'storage/unauthorized'
                            ? 'لا توجد صلاحية لعرض ملف الإيصال من Storage'
                            : 'صورة الإيصال غير متوفرة أو لم يتم رفعها'}
                        </p>
                        {selectedRequest.receiptImagePath && (
                          <p className="text-[10px] font-mono text-zinc-500 break-all" dir="ltr">
                            {selectedRequest.receiptImagePath}
                          </p>
                        )}
                      </div>
                    )}
                  </div>

                  {selectedRequest.receiptImagePath && (
                    <p
                      className="mt-2.5 text-[10px] font-mono text-zinc-500 truncate"
                      dir="ltr"
                      title={selectedRequest.receiptImagePath}
                    >
                      Storage: {selectedRequest.receiptImagePath}
                    </p>
                  )}
                </div>
              </div>
            </div>

            {/* Modal Footer — Server-Only Admin Actions */}
            <div className="px-6 py-4 bg-[#0b0d14] border-t border-zinc-800 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 shrink-0">
              <div className="flex items-center gap-2 text-[11px] text-zinc-400">
                <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
                <span>
                  جميع قرارات الاعتماد والرفض وإعادة الإرسال تُنفذ حصرياً عبر Firebase Cloud Functions.
                </span>
              </div>

              <div className="flex items-center gap-2.5 flex-wrap justify-end">
                {canReviewSelected ? (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        setResubmissionNote('');
                        setResubmitModalOpen(true);
                      }}
                      disabled={submittingAction}
                      className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-orange-500/10 hover:bg-orange-500/20 border border-orange-500/30 text-orange-300 font-bold text-xs transition-colors disabled:opacity-50"
                    >
                      <RotateCcw className="w-4 h-4" />
                      <span>طلب إعادة الإرسال</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        setRejectionReason('');
                        setRejectModalOpen(true);
                      }}
                      disabled={submittingAction}
                      className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/30 text-rose-400 font-bold text-xs transition-colors disabled:opacity-50"
                    >
                      <XCircle className="w-4 h-4" />
                      <span>رفض الطلب</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        setApproveAdminNote('');
                        setApproveModalOpen(true);
                      }}
                      disabled={submittingAction}
                      className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-black text-xs shadow-lg shadow-emerald-500/20 transition-colors disabled:opacity-50"
                    >
                      <CheckCircle2 className="w-4 h-4" />
                      <span>الموافقة وتفعيل الاشتراك</span>
                    </button>
                  </>
                ) : (
                  <span className="text-xs font-bold text-zinc-400 px-3 py-2 rounded-xl bg-zinc-900 border border-zinc-800">
                    {selectedRequest.status === 'approved'
                      ? 'الطلب معتمد ومفعل مسبقاً — لا يمكن تكرار الموافقة'
                      : 'الطلب مرفوض نهائياً — لا يمكن تفعيله'}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Fullscreen Receipt Lightbox */}
      {lightboxOpen && resolvedReceiptUrl && selectedRequest && (
        <div
          className="fixed inset-0 z-[60] bg-black/95 flex flex-col items-center justify-center p-4"
          onClick={() => setLightboxOpen(false)}
        >
          <div
            className="w-full max-w-6xl flex items-center justify-between mb-3 px-2"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-xs text-zinc-300 font-bold">
              إيصال الطلب{' '}
              <span className="font-mono text-amber-400">{selectedRequest.requestNumber}</span> —{' '}
              {selectedRequest.merchantName}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setZoomScale((s) => Math.max(0.75, +(s - 0.25).toFixed(2)))}
                className="p-2 rounded-xl bg-zinc-900 border border-zinc-700 text-zinc-200 hover:text-white"
              >
                <ZoomOut className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => setZoomScale(1)}
                className="px-3 py-2 rounded-xl bg-zinc-900 border border-zinc-700 text-xs font-mono text-zinc-200"
              >
                {Math.round(zoomScale * 100)}%
              </button>
              <button
                type="button"
                onClick={() => setZoomScale((s) => Math.min(3.5, +(s + 0.25).toFixed(2)))}
                className="p-2 rounded-xl bg-zinc-900 border border-zinc-700 text-zinc-200 hover:text-white"
              >
                <ZoomIn className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => setLightboxOpen(false)}
                className="p-2 rounded-xl bg-rose-500/20 border border-rose-500/40 text-rose-300 hover:bg-rose-500/30"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          <div
            className="flex-1 w-full overflow-auto flex items-center justify-center"
            onClick={(e) => e.stopPropagation()}
          >
            <img
              src={resolvedReceiptUrl}
              alt={`إيصال ${selectedRequest.requestNumber}`}
              referrerPolicy="no-referrer"
              style={{ transform: `scale(${zoomScale})`, transformOrigin: 'center center' }}
              className="max-h-[82vh] max-w-[92vw] object-contain rounded-xl transition-transform duration-150"
            />
          </div>
        </div>
      )}

      {/* Confirmation Modal: Approve & Activate Subscription */}
      {approveModalOpen && selectedRequest && (
        <div
          className="fixed inset-0 z-[55] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => !submittingAction && setApproveModalOpen(false)}
        >
          <div
            className="bg-[#11141c] border border-emerald-500/40 rounded-3xl w-full max-w-md p-6 space-y-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <div className="w-11 h-11 rounded-2xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 flex items-center justify-center shrink-0">
                <CheckCircle2 className="w-6 h-6" />
              </div>
              <div>
                <h3 className="text-base font-black text-white">تأكيد الموافقة وتفعيل الاشتراك</h3>
                <p className="text-xs text-zinc-400 mt-1">
                  سيتم تنفيذ التفعيل الذري على السيرفر وإنشاء سجل الدفع المالي وإشعار التاجر فوراً.
                </p>
              </div>
            </div>

            <div className="bg-[#0a0c12] border border-zinc-800 rounded-2xl p-4 space-y-2.5 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-zinc-400">اسم التاجر</span>
                <span className="font-black text-white">{selectedRequest.merchantName}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-zinc-400">الباقة</span>
                <span className="font-bold text-amber-400">
                  {selectedRequest.planName} ({selectedRequest.maxCaptains} كابتن)
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-zinc-400">المبلغ المدفوع</span>
                <span className="font-mono font-black text-emerald-400 text-sm tabular-nums">
                  {formatCurrency(selectedRequest.amount)}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-zinc-400">المدة</span>
                <span className="font-mono text-zinc-200 inline-flex items-center gap-1">
                  <Calendar className="w-3.5 h-3.5 text-zinc-500" />
                  {selectedRequest.durationDays} يوم
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-zinc-400">الرقم المرجعي</span>
                <span className="font-mono text-zinc-200" dir="ltr">
                  {selectedRequest.transactionReference || '—'}
                </span>
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-zinc-300 mb-1.5">
                ملاحظة إدارية داخلية (اختياري)
              </label>
              <textarea
                rows={2}
                value={approveAdminNote}
                onChange={(e) => setApproveAdminNote(e.target.value)}
                placeholder="مثال: تم مطابقة التحويل على محفظة فودافون كاش..."
                className="w-full bg-[#0a0c12] border border-zinc-800 rounded-xl px-3.5 py-2.5 text-xs text-zinc-100 focus:outline-none focus:border-emerald-500 resize-none"
              />
            </div>

            <div className="flex items-center justify-end gap-2.5 pt-1">
              <button
                type="button"
                onClick={() => setApproveModalOpen(false)}
                disabled={submittingAction}
                className="px-4 py-2.5 rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-300 text-xs font-bold hover:text-white"
              >
                إلغاء
              </button>
              <button
                type="button"
                onClick={handleConfirmApprove}
                disabled={submittingAction}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-black text-xs disabled:opacity-50"
              >
                {submittingAction ? (
                  <>
                    <span className="w-4 h-4 border-2 border-zinc-950 border-t-transparent rounded-full animate-spin" />
                    <span>جاري الاعتماد والتفعيل...</span>
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="w-4 h-4" />
                    <span>تأكيد الموافقة وتفعيل الاشتراك</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Reject Request */}
      {rejectModalOpen && selectedRequest && (
        <div
          className="fixed inset-0 z-[55] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => !submittingAction && setRejectModalOpen(false)}
        >
          <form
            onSubmit={handleConfirmReject}
            className="bg-[#11141c] border border-rose-500/40 rounded-3xl w-full max-w-md p-6 space-y-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <div className="w-11 h-11 rounded-2xl bg-rose-500/15 border border-rose-500/30 text-rose-400 flex items-center justify-center shrink-0">
                <AlertTriangle className="w-6 h-6" />
              </div>
              <div>
                <h3 className="text-base font-black text-white">رفض طلب الاشتراك</h3>
                <p className="text-xs text-zinc-400 mt-1">
                  لن يتم تفعيل اشتراك التاجر ({selectedRequest.merchantName}) وسيصله سبب الرفض.
                </p>
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-zinc-300 mb-1.5">
                سبب الرفض <span className="text-rose-400">*</span>
              </label>
              <textarea
                rows={3}
                required
                minLength={3}
                value={rejectionReason}
                onChange={(e) => setRejectionReason(e.target.value)}
                placeholder="اكتب سبباً واضحاً لرفض الطلب (مثال: لم يصل التحويل للمحفظة أو المبلغ غير مطابق)..."
                className="w-full bg-[#0a0c12] border border-zinc-800 rounded-xl px-3.5 py-2.5 text-xs text-zinc-100 focus:outline-none focus:border-rose-500 resize-none"
              />
            </div>

            <div className="flex items-center justify-end gap-2.5 pt-1">
              <button
                type="button"
                onClick={() => setRejectModalOpen(false)}
                disabled={submittingAction}
                className="px-4 py-2.5 rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-300 text-xs font-bold hover:text-white"
              >
                إلغاء
              </button>
              <button
                type="submit"
                disabled={submittingAction || rejectionReason.trim().length < 3}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-black text-xs disabled:opacity-50"
              >
                {submittingAction ? (
                  <>
                    <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    <span>جاري الرفض...</span>
                  </>
                ) : (
                  <>
                    <XCircle className="w-4 h-4" />
                    <span>تأكيد رفض الطلب</span>
                  </>
                )}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Modal: Request Resubmission */}
      {resubmitModalOpen && selectedRequest && (
        <div
          className="fixed inset-0 z-[55] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => !submittingAction && setResubmitModalOpen(false)}
        >
          <form
            onSubmit={handleConfirmResubmission}
            className="bg-[#11141c] border border-orange-500/40 rounded-3xl w-full max-w-md p-6 space-y-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <div className="w-11 h-11 rounded-2xl bg-orange-500/15 border border-orange-500/30 text-orange-400 flex items-center justify-center shrink-0">
                <RotateCcw className="w-6 h-6" />
              </div>
              <div>
                <h3 className="text-base font-black text-white">طلب إعادة إرسال الإيصال</h3>
                <p className="text-xs text-zinc-400 mt-1">
                  سيتم تغيير حالة الطلب إلى «مطلوب إعادة إرسال» وإخطار التاجر بملاحظتك دون تفعيل
                  الاشتراك.
                </p>
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-zinc-300 mb-1.5">
                ملاحظة الإدارة للتاجر <span className="text-orange-400">*</span>
              </label>
              <textarea
                rows={3}
                required
                minLength={3}
                value={resubmissionNote}
                onChange={(e) => setResubmissionNote(e.target.value)}
                placeholder="مثال: صورة الإيصال غير واضحة أو رقم العملية مقصوص، يرجى رفع صورة واضحة كاملة..."
                className="w-full bg-[#0a0c12] border border-zinc-800 rounded-xl px-3.5 py-2.5 text-xs text-zinc-100 focus:outline-none focus:border-orange-500 resize-none"
              />
            </div>

            <div className="flex items-center justify-end gap-2.5 pt-1">
              <button
                type="button"
                onClick={() => setResubmitModalOpen(false)}
                disabled={submittingAction}
                className="px-4 py-2.5 rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-300 text-xs font-bold hover:text-white"
              >
                إلغاء
              </button>
              <button
                type="submit"
                disabled={submittingAction || resubmissionNote.trim().length < 3}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-orange-500 hover:bg-orange-400 text-zinc-950 font-black text-xs disabled:opacity-50"
              >
                {submittingAction ? (
                  <>
                    <span className="w-4 h-4 border-2 border-zinc-950 border-t-transparent rounded-full animate-spin" />
                    <span>جاري الإرسال...</span>
                  </>
                ) : (
                  <>
                    <RotateCcw className="w-4 h-4" />
                    <span>إرسال طلب إعادة الرفع</span>
                  </>
                )}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
