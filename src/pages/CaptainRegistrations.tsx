import React, { useEffect, useMemo, useState } from 'react';
import {
  UserCheck,
  Search,
  RefreshCw,
  ArrowUpDown,
  Eye,
  CheckCircle2,
  XCircle,
  PauseCircle,
  RotateCcw,
  Ban,
  Phone,
  Mail,
  MapPin,
  Bike,
  Calendar,
  Copy,
  Check,
  X,
  ZoomIn,
  ZoomOut,
  RotateCw,
  Maximize2,
  ShieldCheck,
  ShieldAlert,
  FileText,
  History,
  ChevronRight,
  ChevronLeft,
  BadgeCheck,
  Clock,
  ExternalLink,
} from 'lucide-react';
import {
  CaptainApprovalService,
  CaptainRegistrationRecord,
} from '../services/captainApprovalService';
import { CaptainAccountStatus, CaptainAuditLogEntry } from '../types';
import { useToast } from '../contexts/ToastContext';
import { FirebaseImage } from '../components/common/FirebaseImage';
import { resolveStorageImageDetailed } from '../utils/storageUtils';
import { formatDateTime } from '../utils/formatters';

const TABS: Array<{
  key: CaptainAccountStatus;
  label: string;
  badgeClass: string;
  activeTabClass: string;
}> = [
  {
    key: 'pending',
    label: 'طلبات جديدة',
    badgeClass: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
    activeTabClass: 'bg-amber-500 text-zinc-950',
  },
  {
    key: 'approved',
    label: 'الكباتن المعتمدون',
    badgeClass: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
    activeTabClass: 'bg-emerald-500 text-zinc-950',
  },
  {
    key: 'rejected',
    label: 'الطلبات المرفوضة',
    badgeClass: 'bg-rose-500/15 text-rose-400 border-rose-500/30',
    activeTabClass: 'bg-rose-500 text-white',
  },
  {
    key: 'suspended',
    label: 'الكباتن الموقوفون',
    badgeClass: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
    activeTabClass: 'bg-orange-500 text-zinc-950',
  },
  {
    key: 'blocked',
    label: 'الكباتن المحظورون',
    badgeClass: 'bg-red-600/15 text-red-400 border-red-500/30',
    activeTabClass: 'bg-red-600 text-white',
  },
];

const STATUS_META: Record<
  CaptainAccountStatus,
  { label: string; badgeClass: string; dotClass: string }
> = {
  pending: {
    label: 'قيد المراجعة',
    badgeClass: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
    dotClass: 'bg-amber-400',
  },
  approved: {
    label: 'معتمد',
    badgeClass: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
    dotClass: 'bg-emerald-400',
  },
  rejected: {
    label: 'مرفوض',
    badgeClass: 'bg-rose-500/10 text-rose-400 border-rose-500/30',
    dotClass: 'bg-rose-400',
  },
  suspended: {
    label: 'موقوف مؤقتاً',
    badgeClass: 'bg-orange-500/10 text-orange-400 border-orange-500/30',
    dotClass: 'bg-orange-400',
  },
  blocked: {
    label: 'محظور نهائياً',
    badgeClass: 'bg-red-600/10 text-red-400 border-red-500/30',
    dotClass: 'bg-red-400',
  },
};

type ModerationModalAction = 'approve' | 'reject' | 'suspend' | 'reactivate' | 'block';

function getAuditActionLabel(action: string): string {
  switch (action) {
    case 'registration_received':
      return 'استلام طلب التسجيل';
    case 'approved':
      return 'الموافقة على الحساب';
    case 'rejected':
      return 'رفض الحساب';
    case 'suspended':
      return 'إيقاف الحساب مؤقتاً';
    case 'reactivated':
      return 'إعادة تفعيل الحساب';
    case 'blocked':
      return 'حظر الحساب نهائياً';
    default:
      return action || 'إجراء إداري';
  }
}

export const CaptainRegistrationsPage: React.FC = () => {
  const { success, error: showError } = useToast();

  const [captains, setCaptains] = useState<CaptainRegistrationRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  // Filters, sorting, pagination
  const [activeTab, setActiveTab] = useState<CaptainAccountStatus>('pending');
  const [searchQuery, setSearchQuery] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [sortOrder, setSortOrder] = useState<'desc' | 'asc'>('desc');
  const [pageSize, setPageSize] = useState<number>(10);
  const [currentPage, setCurrentPage] = useState<number>(1);

  // Selected captain review modal + audit timeline + document lightbox
  const [selectedCaptainId, setSelectedCaptainId] = useState<string | null>(null);
  const [auditLogs, setAuditLogs] = useState<CaptainAuditLogEntry[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const [lightboxDoc, setLightboxDoc] = useState<{
    label: string;
    primaryPath: string;
    fallbacks: string[];
  } | null>(null);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [lightboxLoading, setLightboxLoading] = useState(false);
  const [lightboxZoom, setLightboxZoom] = useState(1);
  const [lightboxRotation, setLightboxRotation] = useState(0);

  // Moderation confirmation/reason modal
  const [actionModal, setActionModal] = useState<{
    captain: CaptainRegistrationRecord;
    action: ModerationModalAction;
  } | null>(null);
  const [reasonOrNoteInput, setReasonOrNoteInput] = useState('');
  const [submittingAction, setSubmittingAction] = useState(false);

  // Subscribe to captains/{uid}
  useEffect(() => {
    setLoading(true);
    const unsub = CaptainApprovalService.subscribeCaptainsRegistrations(
      (items) => {
        setCaptains(items);
        setLoading(false);
      },
      (err) => {
        setLoading(false);
        showError(`تعذر تحميل طلبات الكباتن: ${err.message}`);
      }
    );
    return () => unsub();
  }, [refreshKey, showError]);

  const selectedCaptain = useMemo(
    () => captains.find((c) => c.id === selectedCaptainId) || null,
    [captains, selectedCaptainId]
  );

  // Subscribe to audit logs when a captain is selected
  useEffect(() => {
    if (!selectedCaptainId) {
      setAuditLogs([]);
      setAuditLoading(false);
      return;
    }
    setAuditLoading(true);
    const unsub = CaptainApprovalService.subscribeCaptainAuditLogs(
      selectedCaptainId,
      (entries) => {
        setAuditLogs(entries);
        setAuditLoading(false);
      },
      () => {
        setAuditLoading(false);
      }
    );
    return () => unsub();
  }, [selectedCaptainId]);

  // Resolve full-res URL for lightbox
  useEffect(() => {
    let active = true;
    setLightboxZoom(1);
    setLightboxRotation(0);

    if (!lightboxDoc) {
      setLightboxUrl(null);
      setLightboxLoading(false);
      return;
    }

    setLightboxLoading(true);
    resolveStorageImageDetailed(lightboxDoc.primaryPath, lightboxDoc.fallbacks).then((res) => {
      if (!active) return;
      setLightboxUrl(res.url);
      setLightboxLoading(false);
    });

    return () => {
      active = false;
    };
  }, [lightboxDoc]);

  const countsByStatus = useMemo(() => {
    const counts: Record<CaptainAccountStatus, number> = {
      pending: 0,
      approved: 0,
      rejected: 0,
      suspended: 0,
      blocked: 0,
    };
    captains.forEach((c) => {
      counts[c.accountStatus] = (counts[c.accountStatus] || 0) + 1;
    });
    return counts;
  }, [captains]);

  const filteredCaptains = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const fromMs = fromDate ? Date.parse(`${fromDate}T00:00:00`) : null;
    const toMs = toDate ? Date.parse(`${toDate}T23:59:59.999`) : null;

    const filtered = captains.filter((c) => {
      if (c.accountStatus !== activeTab) return false;

      if (q) {
        const hay = `${c.name} ${c.phone} ${c.uid} ${c.id} ${c.email}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }

      if (fromMs !== null && Number.isFinite(fromMs)) {
        if (!c.createdAtMs || c.createdAtMs < fromMs) return false;
      }
      if (toMs !== null && Number.isFinite(toMs)) {
        if (!c.createdAtMs || c.createdAtMs > toMs) return false;
      }
      return true;
    });

    filtered.sort((a, b) =>
      sortOrder === 'desc' ? b.createdAtMs - a.createdAtMs : a.createdAtMs - b.createdAtMs
    );
    return filtered;
  }, [captains, activeTab, searchQuery, fromDate, toDate, sortOrder]);

  // Reset pagination when filters/tab change
  useEffect(() => {
    setCurrentPage(1);
  }, [activeTab, searchQuery, fromDate, toDate, pageSize, sortOrder]);

  const totalPages = Math.max(1, Math.ceil(filteredCaptains.length / pageSize));
  const safePage = Math.min(currentPage, totalPages);
  const paginatedCaptains = useMemo(() => {
    const start = (safePage - 1) * pageSize;
    return filteredCaptains.slice(start, start + pageSize);
  }, [filteredCaptains, safePage, pageSize]);

  const handleCopy = async (label: string, value: string) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(label);
      setTimeout(() => setCopiedKey(null), 1500);
    } catch {
      // ignore clipboard errors
    }
  };

  const getDocumentFallbacks = (captain: CaptainRegistrationRecord) => {
    const cid = captain.uid || captain.id;
    return {
      profile: [
        `captains/${cid}/profile/profile.jpg`,
        `captains/${cid}/profile/profile.jpeg`,
        `captains/${cid}/profile.jpg`,
      ],
      idFront: [
        `captains/${cid}/documents/id_front.jpg`,
        `captains/${cid}/documents/id_front.jpeg`,
      ],
      idBack: [
        `captains/${cid}/documents/id_back.jpg`,
        `captains/${cid}/documents/id_back.jpeg`,
      ],
      license: [
        `captains/${cid}/documents/license.jpg`,
        `captains/${cid}/documents/license.jpeg`,
      ],
    };
  };

  const openActionModal = (captain: CaptainRegistrationRecord, action: ModerationModalAction) => {
    setReasonOrNoteInput('');
    setActionModal({ captain, action });
  };

  const requiresMandatoryReason = (action: ModerationModalAction): boolean =>
    action === 'reject' || action === 'suspend' || action === 'block';

  const handleConfirmModerationAction = async () => {
    if (!actionModal) return;
    const { captain, action } = actionModal;
    const text = reasonOrNoteInput.trim();

    if (requiresMandatoryReason(action) && text.length < 3) {
      showError('يرجى كتابة سبب واضح لا يقل عن 3 أحرف قبل تنفيذ هذا الإجراء.');
      return;
    }

    setSubmittingAction(true);
    try {
      let res;
      if (action === 'approve') {
        res = await CaptainApprovalService.approveCaptain(captain.id, text);
      } else if (action === 'reject') {
        res = await CaptainApprovalService.rejectCaptain(captain.id, text);
      } else if (action === 'suspend') {
        res = await CaptainApprovalService.suspendCaptain(captain.id, text);
      } else if (action === 'reactivate') {
        res = await CaptainApprovalService.reactivateCaptain(captain.id, text);
      } else {
        res = await CaptainApprovalService.blockCaptain(captain.id, text);
      }
      success(res.message);
      setActionModal(null);
      setReasonOrNoteInput('');
    } catch (err: any) {
      showError(err?.message || 'تعذر تنفيذ الإجراء الإداري.');
    } finally {
      setSubmittingAction(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-3 flex-wrap">
            <div className="w-10 h-10 rounded-xl bg-amber-500/15 border border-amber-500/30 text-amber-400 flex items-center justify-center shrink-0">
              <UserCheck className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-2xl font-black text-zinc-100 tracking-tight">
                إدارة طلبات تسجيل الكباتن
              </h1>
              <p className="text-sm text-zinc-400 mt-0.5">
                مراجعة طلبات الانضمام، فحص مستندات الهوية والرخصة، واعتماد أو إيقاف حسابات الكباتن
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2.5 flex-wrap">
          {countsByStatus.pending > 0 && (
            <div className="px-3.5 py-2 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs font-bold flex items-center gap-2 whitespace-nowrap">
              <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
              <span className="tabular-nums">{countsByStatus.pending} طلب بانتظار المراجعة</span>
            </div>
          )}

          <button
            type="button"
            onClick={() => setRefreshKey((k) => k + 1)}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-200 text-xs font-bold transition-colors whitespace-nowrap cursor-pointer"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin text-amber-400' : ''}`} />
            <span>تحديث القائمة</span>
          </button>
        </div>
      </div>

      {/* 5 Status Tabs */}
      <div className="flex items-center gap-2 overflow-x-auto pb-1">
        {TABS.map((tab) => {
          const isActive = activeTab === tab.key;
          const count = countsByStatus[tab.key] || 0;
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              className={`inline-flex items-center gap-2.5 px-4 py-2.5 rounded-xl text-xs font-bold border transition-all whitespace-nowrap cursor-pointer shrink-0 ${
                isActive
                  ? `${tab.activeTabClass} border-transparent shadow-md`
                  : 'bg-[#0d1017] text-zinc-400 border-zinc-800/90 hover:text-zinc-100 hover:border-zinc-700'
              }`}
            >
              <span>{tab.label}</span>
              <span
                className={`px-2 py-0.5 rounded-md text-[11px] font-mono font-black tabular-nums ${
                  isActive ? 'bg-black/25 text-current' : `${tab.badgeClass} border`
                }`}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Search, Date Range, Sort & Page Size Bar */}
      <div className="bg-[#0d1017] border border-zinc-800/80 rounded-2xl p-4 flex flex-col xl:flex-row xl:items-center gap-3">
        <div className="relative flex-1 min-w-[240px]">
          <Search className="w-4 h-4 text-zinc-400 absolute right-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="بحث بالاسم أو رقم الهاتف أو UID..."
            className="w-full pr-10 pl-4 py-2.5 rounded-xl bg-zinc-900/90 border border-zinc-800 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-amber-500/60"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex items-center gap-2 bg-zinc-900/90 border border-zinc-800 rounded-xl px-3 py-1.5">
            <Calendar className="w-4 h-4 text-zinc-400 shrink-0" />
            <span className="text-[11px] text-zinc-400 whitespace-nowrap">من:</span>
            <input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              className="bg-transparent text-xs text-zinc-200 focus:outline-none"
            />
            <span className="text-[11px] text-zinc-400 whitespace-nowrap">إلى:</span>
            <input
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              className="bg-transparent text-xs text-zinc-200 focus:outline-none"
            />
            {(fromDate || toDate) && (
              <button
                type="button"
                onClick={() => {
                  setFromDate('');
                  setToDate('');
                }}
                className="text-zinc-400 hover:text-zinc-200 p-0.5 cursor-pointer"
                title="مسح فلتر التاريخ"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          <button
            type="button"
            onClick={() => setSortOrder((s) => (s === 'desc' ? 'asc' : 'desc'))}
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl bg-zinc-900/90 border border-zinc-800 hover:border-zinc-700 text-xs font-bold text-zinc-300 whitespace-nowrap cursor-pointer"
          >
            <ArrowUpDown className="w-3.5 h-3.5 text-amber-400" />
            <span>{sortOrder === 'desc' ? 'الأحدث أولاً' : 'الأقدم أولاً'}</span>
          </button>

          <select
            value={pageSize}
            onChange={(e) => setPageSize(Number(e.target.value))}
            className="px-3 py-2 rounded-xl bg-zinc-900/90 border border-zinc-800 text-xs font-bold text-zinc-200 focus:outline-none cursor-pointer"
          >
            <option value={10}>10 في الصفحة</option>
            <option value={25}>25 في الصفحة</option>
            <option value={50}>50 في الصفحة</option>
          </select>
        </div>
      </div>

      {/* Table Container */}
      <div className="bg-[#0d1017] border border-zinc-800/80 rounded-2xl overflow-hidden">
        {loading ? (
          <div className="py-16 flex flex-col items-center justify-center gap-3 text-zinc-400">
            <RefreshCw className="w-7 h-7 animate-spin text-amber-400" />
            <p className="text-sm font-semibold">جاري تحميل بيانات الكباتن من Firestore...</p>
          </div>
        ) : paginatedCaptains.length === 0 ? (
          <div className="py-16 px-4 text-center">
            <div className="w-12 h-12 rounded-2xl bg-zinc-900 border border-zinc-800 flex items-center justify-center mx-auto mb-3 text-zinc-500">
              <UserCheck className="w-6 h-6" />
            </div>
            <p className="text-sm font-bold text-zinc-200">
              لا توجد حسابات في قسم "{TABS.find((t) => t.key === activeTab)?.label}"
            </p>
            <p className="text-xs text-zinc-500 mt-1">
              {searchQuery || fromDate || toDate
                ? 'جرّب تعديل كلمات البحث أو نطاق التاريخ.'
                : 'ستظهر الطلبات الجديدة هنا تلقائياً فور تسجيل أي كابتن.'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-right border-collapse">
              <thead>
                <tr className="border-b border-zinc-800/80 bg-zinc-900/50 text-[11px] font-bold text-zinc-400">
                  <th className="py-3.5 px-4">الكابتن</th>
                  <th className="py-3.5 px-4">الهاتف والـ UID</th>
                  <th className="py-3.5 px-4">المركبة والعنوان</th>
                  <th className="py-3.5 px-4">المستندات</th>
                  <th className="py-3.5 px-4">تاريخ التسجيل</th>
                  <th className="py-3.5 px-4">الحالة</th>
                  <th className="py-3.5 px-4 text-left">إجراءات</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {paginatedCaptains.map((cap) => {
                  const statusMeta = STATUS_META[cap.accountStatus];
                  const fallbacks = getDocumentFallbacks(cap);
                  const docsReadyCount = [
                    cap.profileImagePath,
                    cap.idFrontImagePath,
                    cap.idBackImagePath,
                    cap.licenseImagePath,
                  ].filter(Boolean).length;

                  return (
                    <tr
                      key={cap.id}
                      className="hover:bg-zinc-900/40 transition-colors"
                    >
                      <td className="py-3.5 px-4">
                        <div className="flex items-center gap-3 min-w-[180px]">
                          <div className="w-10 h-10 rounded-xl overflow-hidden bg-zinc-900 border border-zinc-800 shrink-0">
                            <FirebaseImage
                              src={cap.profileImagePath}
                              fallbackPaths={fallbacks.profile}
                              alt={cap.name}
                              className="w-full h-full object-cover"
                            />
                          </div>
                          <div className="min-w-0">
                            <div className="font-bold text-sm text-zinc-100 truncate">
                              {cap.name}
                            </div>
                            <div className="flex items-center gap-1.5 text-[11px] text-zinc-400 mt-0.5 truncate">
                              <Mail className="w-3 h-3 shrink-0" />
                              <span className="truncate" dir="ltr">
                                {cap.email || '—'}
                              </span>
                              {cap.emailVerified && (
                                <span
                                  title="البريد الإلكتروني مؤكد"
                                  className="inline-flex items-center text-emerald-400 shrink-0"
                                >
                                  <BadgeCheck className="w-3.5 h-3.5" />
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      </td>

                      <td className="py-3.5 px-4">
                        <div className="space-y-1 min-w-[150px]">
                          <div className="text-xs font-bold text-zinc-200 font-mono tabular-nums" dir="ltr">
                            {cap.phone || '—'}
                          </div>
                          <button
                            type="button"
                            onClick={() => handleCopy(`uid_${cap.id}`, cap.uid)}
                            className="inline-flex items-center gap-1 text-[10px] font-mono text-zinc-400 hover:text-amber-400 cursor-pointer"
                            title={`نسخ UID: ${cap.uid}`}
                          >
                            <span dir="ltr">{cap.uid.slice(0, 12)}…</span>
                            {copiedKey === `uid_${cap.id}` ? (
                              <Check className="w-3 h-3 text-emerald-400" />
                            ) : (
                              <Copy className="w-3 h-3" />
                            )}
                          </button>
                        </div>
                      </td>

                      <td className="py-3.5 px-4">
                        <div className="space-y-0.5 max-w-[200px]">
                          <div className="text-xs font-semibold text-zinc-200 truncate">
                            {cap.vehicleType}
                            {cap.licensePlate ? ` • ${cap.licensePlate}` : ''}
                          </div>
                          <div className="text-[11px] text-zinc-400 truncate">
                            {cap.address || 'لم يحدد العنوان'}
                          </div>
                        </div>
                      </td>

                      <td className="py-3.5 px-4">
                        <div className="flex items-center gap-1.5">
                          <span
                            className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-bold border tabular-nums whitespace-nowrap ${
                              docsReadyCount >= 3
                                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/25'
                                : 'bg-zinc-800/80 text-zinc-300 border-zinc-700'
                            }`}
                          >
                            <FileText className="w-3 h-3" />
                            <span>{docsReadyCount} / 4</span>
                          </span>
                        </div>
                      </td>

                      <td className="py-3.5 px-4">
                        <div className="text-xs text-zinc-300 tabular-nums whitespace-nowrap">
                          {cap.createdAt ? formatDateTime(cap.createdAt) : '—'}
                        </div>
                      </td>

                      <td className="py-3.5 px-4">
                        <span
                          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-bold border whitespace-nowrap ${statusMeta.badgeClass}`}
                        >
                          <span className={`w-1.5 h-1.5 rounded-full ${statusMeta.dotClass}`} />
                          <span>{statusMeta.label}</span>
                        </span>
                      </td>

                      <td className="py-3.5 px-4 text-left">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={() => setSelectedCaptainId(cap.id)}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-zinc-950 text-xs font-bold transition-colors whitespace-nowrap cursor-pointer"
                          >
                            <Eye className="w-3.5 h-3.5" />
                            <span>مراجعة</span>
                          </button>

                          {cap.accountStatus === 'pending' && (
                            <button
                              type="button"
                              onClick={() => openActionModal(cap, 'approve')}
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-300 text-xs font-bold transition-colors whitespace-nowrap cursor-pointer"
                              title="موافقة سريعة"
                            >
                              <CheckCircle2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination Footer */}
        {!loading && filteredCaptains.length > 0 && (
          <div className="px-4 py-3.5 border-t border-zinc-800/80 flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-zinc-900/30">
            <div className="text-xs text-zinc-400 tabular-nums">
              عرض{' '}
              <span className="font-bold text-zinc-200">
                {(safePage - 1) * pageSize + 1}
              </span>{' '}
              –{' '}
              <span className="font-bold text-zinc-200">
                {Math.min(safePage * pageSize, filteredCaptains.length)}
              </span>{' '}
              من أصل{' '}
              <span className="font-bold text-zinc-200">{filteredCaptains.length}</span>
            </div>

            <div className="flex items-center gap-1.5">
              <button
                type="button"
                disabled={safePage <= 1}
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-xs font-bold text-zinc-300 disabled:opacity-40 hover:border-zinc-700 cursor-pointer disabled:cursor-not-allowed"
              >
                <ChevronRight className="w-3.5 h-3.5" />
                <span>السابق</span>
              </button>

              <span className="px-3 py-1.5 text-xs font-mono font-bold text-zinc-300 tabular-nums">
                {safePage} / {totalPages}
              </span>

              <button
                type="button"
                disabled={safePage >= totalPages}
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-xs font-bold text-zinc-300 disabled:opacity-40 hover:border-zinc-700 cursor-pointer disabled:cursor-not-allowed"
              >
                <span>التالي</span>
                <ChevronLeft className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Captain Review Detail Modal */}
      {selectedCaptain && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-xs flex items-center justify-center p-3 sm:p-6 overflow-y-auto">
          <div className="bg-[#0d1017] border border-zinc-800 rounded-2xl w-full max-w-5xl max-h-[92vh] flex flex-col overflow-hidden shadow-2xl my-auto">
            {/* Modal Header */}
            <div className="px-6 py-4 border-b border-zinc-800 flex items-center justify-between gap-4 bg-zinc-900/40">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-11 h-11 rounded-xl overflow-hidden bg-zinc-900 border border-zinc-700 shrink-0">
                  <FirebaseImage
                    src={selectedCaptain.profileImagePath}
                    fallbackPaths={getDocumentFallbacks(selectedCaptain).profile}
                    alt={selectedCaptain.name}
                    className="w-full h-full object-cover"
                  />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h2 className="text-lg font-black text-zinc-100 truncate">
                      {selectedCaptain.name}
                    </h2>
                    <span
                      className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md text-[11px] font-bold border ${STATUS_META[selectedCaptain.accountStatus].badgeClass}`}
                    >
                      {STATUS_META[selectedCaptain.accountStatus].label}
                    </span>
                    {selectedCaptain.emailVerified ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/25">
                        <ShieldCheck className="w-3 h-3" />
                        بريد مؤكد
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-bold bg-zinc-800 text-zinc-400 border border-zinc-700">
                        <ShieldAlert className="w-3 h-3" />
                        بريد غير مؤكد
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-xs text-zinc-400 mt-0.5 font-mono">
                    <span dir="ltr">UID: {selectedCaptain.uid}</span>
                    <button
                      type="button"
                      onClick={() => handleCopy('modal_uid', selectedCaptain.uid)}
                      className="text-amber-400 hover:text-amber-300 cursor-pointer"
                      title="نسخ UID"
                    >
                      {copiedKey === 'modal_uid' ? (
                        <Check className="w-3.5 h-3.5" />
                      ) : (
                        <Copy className="w-3.5 h-3.5" />
                      )}
                    </button>
                  </div>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setSelectedCaptainId(null)}
                className="p-2 rounded-xl text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors cursor-pointer"
                aria-label="إغلاق"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="flex-1 overflow-y-auto p-6 space-y-6">
              {/* Active Reason Alert */}
              {(selectedCaptain.rejectionReason ||
                selectedCaptain.suspensionReason ||
                selectedCaptain.blockReason) && (
                <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/30 flex items-start gap-3">
                  <ShieldAlert className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
                  <div className="space-y-1 text-sm">
                    <div className="font-bold text-rose-300">
                      {selectedCaptain.accountStatus === 'blocked'
                        ? 'سبب الحظر الدائم:'
                        : selectedCaptain.accountStatus === 'suspended'
                        ? 'سبب الإيقاف المؤقت:'
                        : 'سبب الرفض المسجل:'}
                    </div>
                    <p className="text-zinc-200 text-xs leading-relaxed">
                      {selectedCaptain.blockReason ||
                        selectedCaptain.suspensionReason ||
                        selectedCaptain.rejectionReason}
                    </p>
                  </div>
                </div>
              )}

              {/* Captain Information Grid */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5">
                <div className="p-3.5 rounded-xl bg-zinc-900/60 border border-zinc-800/80">
                  <div className="flex items-center gap-2 text-[11px] text-zinc-400 mb-1">
                    <Phone className="w-3.5 h-3.5 text-amber-400" />
                    <span>رقم الهاتف</span>
                  </div>
                  <div className="text-sm font-bold text-zinc-100 font-mono" dir="ltr">
                    {selectedCaptain.phone || '—'}
                  </div>
                </div>

                <div className="p-3.5 rounded-xl bg-zinc-900/60 border border-zinc-800/80">
                  <div className="flex items-center gap-2 text-[11px] text-zinc-400 mb-1">
                    <Mail className="w-3.5 h-3.5 text-amber-400" />
                    <span>البريد الإلكتروني</span>
                  </div>
                  <div className="text-sm font-bold text-zinc-100 truncate" dir="ltr">
                    {selectedCaptain.email || '—'}
                  </div>
                </div>

                <div className="p-3.5 rounded-xl bg-zinc-900/60 border border-zinc-800/80">
                  <div className="flex items-center gap-2 text-[11px] text-zinc-400 mb-1">
                    <Bike className="w-3.5 h-3.5 text-amber-400" />
                    <span>المركبة ورقم اللوحة</span>
                  </div>
                  <div className="text-sm font-bold text-zinc-100">
                    {selectedCaptain.vehicleType}
                    {selectedCaptain.licensePlate ? ` — ${selectedCaptain.licensePlate}` : ''}
                  </div>
                </div>

                <div className="p-3.5 rounded-xl bg-zinc-900/60 border border-zinc-800/80 sm:col-span-2">
                  <div className="flex items-center gap-2 text-[11px] text-zinc-400 mb-1">
                    <MapPin className="w-3.5 h-3.5 text-amber-400" />
                    <span>العنوان المسجل</span>
                  </div>
                  <div className="text-sm font-semibold text-zinc-200">
                    {selectedCaptain.address || 'لم يقم الكابتن بإدخال العنوان'}
                  </div>
                </div>

                <div className="p-3.5 rounded-xl bg-zinc-900/60 border border-zinc-800/80">
                  <div className="flex items-center gap-2 text-[11px] text-zinc-400 mb-1">
                    <Clock className="w-3.5 h-3.5 text-amber-400" />
                    <span>تاريخ التسجيل</span>
                  </div>
                  <div className="text-xs font-bold text-zinc-200 tabular-nums">
                    {selectedCaptain.createdAt ? formatDateTime(selectedCaptain.createdAt) : '—'}
                  </div>
                </div>
              </div>

              {/* Documents Gallery */}
              <div>
                <h3 className="text-sm font-black text-zinc-100 mb-3 flex items-center gap-2">
                  <FileText className="w-4 h-4 text-amber-400" />
                  <span>المستندات والصور المرفوعة (اضغط للتكبير والمعاينة)</span>
                </h3>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                  {[
                    {
                      label: 'الصورة الشخصية',
                      path: selectedCaptain.profileImagePath,
                      fallbacks: getDocumentFallbacks(selectedCaptain).profile,
                    },
                    {
                      label: 'البطاقة الشخصية (وجه أمامي)',
                      path: selectedCaptain.idFrontImagePath,
                      fallbacks: getDocumentFallbacks(selectedCaptain).idFront,
                    },
                    {
                      label: 'البطاقة الشخصية (وجه خلفي)',
                      path: selectedCaptain.idBackImagePath,
                      fallbacks: getDocumentFallbacks(selectedCaptain).idBack,
                    },
                    {
                      label: 'رخصة القيادة / المركبة',
                      path: selectedCaptain.licenseImagePath,
                      fallbacks: getDocumentFallbacks(selectedCaptain).license,
                    },
                  ].map((docSlot) => (
                    <button
                      key={docSlot.label}
                      type="button"
                      onClick={() =>
                        setLightboxDoc({
                          label: docSlot.label,
                          primaryPath: docSlot.path,
                          fallbacks: docSlot.fallbacks,
                        })
                      }
                      className="group text-right rounded-xl bg-zinc-900/70 border border-zinc-800 hover:border-amber-500/50 overflow-hidden transition-all cursor-pointer flex flex-col"
                    >
                      <div className="relative aspect-[4/3] w-full bg-zinc-950 overflow-hidden flex items-center justify-center">
                        <FirebaseImage
                          src={docSlot.path}
                          fallbackPaths={docSlot.fallbacks}
                          alt={docSlot.label}
                          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                        />
                        <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                          <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-black/80 text-white text-xs font-bold">
                            <Maximize2 className="w-3.5 h-3.5" />
                            <span>تكبير</span>
                          </span>
                        </div>
                      </div>
                      <div className="px-3 py-2.5 flex items-center justify-between gap-2">
                        <span className="text-xs font-bold text-zinc-200 truncate">
                          {docSlot.label}
                        </span>
                        <span
                          className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                            docSlot.path
                              ? 'bg-emerald-500/10 text-emerald-400'
                              : 'bg-zinc-800 text-zinc-400'
                          }`}
                        >
                          {docSlot.path ? 'مرفوع' : 'فحص مسار'}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Admin Audit Log Timeline */}
              <div>
                <h3 className="text-sm font-black text-zinc-100 mb-3 flex items-center gap-2">
                  <History className="w-4 h-4 text-amber-400" />
                  <span>سجل قرارات الإدارة والتدقيق (Audit Log)</span>
                </h3>

                {auditLoading ? (
                  <div className="p-4 rounded-xl bg-zinc-900/50 border border-zinc-800 text-xs text-zinc-400">
                    جاري تحميل سجل التدقيق...
                  </div>
                ) : auditLogs.length === 0 ? (
                  <div className="p-4 rounded-xl bg-zinc-900/50 border border-zinc-800 text-xs text-zinc-500">
                    لا توجد قرارات إدارية مسجلة لهذا الحساب بعد.
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    {auditLogs.map((entry) => (
                      <div
                        key={entry.id}
                        className="p-3.5 rounded-xl bg-zinc-900/60 border border-zinc-800/80 flex flex-col sm:flex-row sm:items-center justify-between gap-2"
                      >
                        <div className="space-y-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-xs font-black text-amber-400">
                              {getAuditActionLabel(entry.action)}
                            </span>
                            <span className="text-[11px] text-zinc-400">
                              بواسطة: {entry.performedByName || entry.performedByEmail || entry.performedByUid}
                            </span>
                          </div>
                          {(entry.reason || entry.note) && (
                            <p className="text-xs text-zinc-300">
                              {entry.reason ? `السبب: ${entry.reason}` : entry.note}
                            </p>
                          )}
                        </div>
                        <div className="text-[11px] text-zinc-400 tabular-nums shrink-0">
                          {entry.createdAt ? formatDateTime(entry.createdAt) : '—'}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Modal Moderation Action Footer */}
            <div className="px-6 py-4 border-t border-zinc-800 bg-zinc-900/50 flex flex-wrap items-center justify-between gap-3">
              <div className="text-xs text-zinc-400">
                تتم جميع التعديلات عبر Firebase Cloud Functions المعتمدة فقط.
              </div>

              <div className="flex flex-wrap items-center gap-2.5">
                {(selectedCaptain.accountStatus === 'pending' ||
                  selectedCaptain.accountStatus === 'rejected') && (
                  <button
                    type="button"
                    onClick={() => openActionModal(selectedCaptain, 'approve')}
                    className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-zinc-950 text-xs font-black transition-colors whitespace-nowrap cursor-pointer"
                  >
                    <CheckCircle2 className="w-4 h-4" />
                    <span>الموافقة على الحساب</span>
                  </button>
                )}

                {selectedCaptain.accountStatus === 'pending' && (
                  <button
                    type="button"
                    onClick={() => openActionModal(selectedCaptain, 'reject')}
                    className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/40 text-rose-300 text-xs font-bold transition-colors whitespace-nowrap cursor-pointer"
                  >
                    <XCircle className="w-4 h-4" />
                    <span>رفض الحساب</span>
                  </button>
                )}

                {selectedCaptain.accountStatus === 'approved' && (
                  <button
                    type="button"
                    onClick={() => openActionModal(selectedCaptain, 'suspend')}
                    className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-orange-500/15 hover:bg-orange-500/25 border border-orange-500/40 text-orange-300 text-xs font-bold transition-colors whitespace-nowrap cursor-pointer"
                  >
                    <PauseCircle className="w-4 h-4" />
                    <span>إيقاف الحساب</span>
                  </button>
                )}

                {(selectedCaptain.accountStatus === 'suspended' ||
                  selectedCaptain.accountStatus === 'blocked') && (
                  <button
                    type="button"
                    onClick={() => openActionModal(selectedCaptain, 'reactivate')}
                    className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-zinc-950 text-xs font-black transition-colors whitespace-nowrap cursor-pointer"
                  >
                    <RotateCcw className="w-4 h-4" />
                    <span>إعادة تفعيل الحساب</span>
                  </button>
                )}

                {selectedCaptain.accountStatus !== 'blocked' && (
                  <button
                    type="button"
                    onClick={() => openActionModal(selectedCaptain, 'block')}
                    className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-red-600/20 hover:bg-red-600/35 border border-red-500/40 text-red-300 text-xs font-bold transition-colors whitespace-nowrap cursor-pointer"
                  >
                    <Ban className="w-4 h-4" />
                    <span>الحظر</span>
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Interactive Document Lightbox */}
      {lightboxDoc && (
        <div className="fixed inset-0 z-[60] bg-black/95 flex flex-col">
          <div className="px-5 py-3.5 border-b border-zinc-800 flex items-center justify-between gap-4">
            <span className="text-sm font-bold text-zinc-100">{lightboxDoc.label}</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setLightboxZoom((z) => Math.max(0.5, Number((z - 0.25).toFixed(2))))}
                className="p-2 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-200 cursor-pointer"
                title="تصغير"
              >
                <ZoomOut className="w-4 h-4" />
              </button>
              <span className="text-xs font-mono text-zinc-300 tabular-nums px-1">
                {Math.round(lightboxZoom * 100)}%
              </span>
              <button
                type="button"
                onClick={() => setLightboxZoom((z) => Math.min(3, Number((z + 0.25).toFixed(2))))}
                className="p-2 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-200 cursor-pointer"
                title="تكبير"
              >
                <ZoomIn className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => setLightboxRotation((r) => (r + 90) % 360)}
                className="p-2 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-200 cursor-pointer"
                title="تدوير 90 درجة"
              >
                <RotateCw className="w-4 h-4" />
              </button>
              {lightboxUrl && (
                <a
                  href={lightboxUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="p-2 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-amber-400"
                  title="فتح في نافذة مستقلة"
                >
                  <ExternalLink className="w-4 h-4" />
                </a>
              )}
              <button
                type="button"
                onClick={() => setLightboxDoc(null)}
                className="p-2 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 cursor-pointer"
                title="إغلاق المعاينة"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-auto flex items-center justify-center p-6">
            {lightboxLoading ? (
              <RefreshCw className="w-8 h-8 animate-spin text-amber-400" />
            ) : lightboxUrl ? (
              <img
                src={lightboxUrl}
                alt={lightboxDoc.label}
                style={{
                  transform: `scale(${lightboxZoom}) rotate(${lightboxRotation}deg)`,
                  transition: 'transform 150ms ease',
                }}
                className="max-h-[82vh] max-w-full object-contain rounded-lg select-none"
              />
            ) : (
              <div className="text-center text-zinc-400 space-y-2">
                <ShieldAlert className="w-10 h-10 mx-auto text-zinc-500" />
                <p className="text-sm font-bold">تعذر تحميل هذا المستند أو لم يتم رفعه بعد</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Confirmation / Mandatory Reason Modal */}
      {actionModal && (
        <div className="fixed inset-0 z-[70] bg-black/80 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-[#0d1017] border border-zinc-800 rounded-2xl w-full max-w-md p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-black text-zinc-100">
                {actionModal.action === 'approve' && 'تأكيد الموافقة على حساب الكابتن'}
                {actionModal.action === 'reject' && 'تأكيد رفض طلب تسجيل الكابتن'}
                {actionModal.action === 'suspend' && 'تأكيد إيقاف حساب الكابتن مؤقتاً'}
                {actionModal.action === 'reactivate' && 'تأكيد إعادة تفعيل حساب الكابتن'}
                {actionModal.action === 'block' && 'تأكيد الحظر النهائي لحساب الكابتن'}
              </h3>
              <button
                type="button"
                disabled={submittingAction}
                onClick={() => setActionModal(null)}
                className="text-zinc-400 hover:text-zinc-200 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-zinc-300 leading-relaxed">
              الكابتن:{' '}
              <span className="font-bold text-amber-400">{actionModal.captain.name}</span>{' '}
              ({actionModal.captain.phone || actionModal.captain.uid})
            </p>

            <div>
              <label className="block text-xs font-bold text-zinc-300 mb-1.5">
                {requiresMandatoryReason(actionModal.action)
                  ? 'سبب القرار (إلزامي ويظهر للكابتن):'
                  : 'ملاحظة إدارية (اختياري):'}
              </label>
              <textarea
                rows={3}
                value={reasonOrNoteInput}
                onChange={(e) => setReasonOrNoteInput(e.target.value)}
                placeholder={
                  requiresMandatoryReason(actionModal.action)
                    ? 'اكتب السبب بوضوح (مثال: صورة البطاقة غير واضحة / مخالفة شروط العمل)...'
                    : 'أضف ملاحظة اختيارية للسجل...'
                }
                className="w-full rounded-xl bg-zinc-900 border border-zinc-800 p-3 text-xs text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-amber-500/60"
              />
            </div>

            <div className="flex items-center justify-end gap-2.5 pt-2">
              <button
                type="button"
                disabled={submittingAction}
                onClick={() => setActionModal(null)}
                className="px-4 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-xs font-bold text-zinc-300 cursor-pointer"
              >
                إلغاء
              </button>
              <button
                type="button"
                disabled={submittingAction}
                onClick={handleConfirmModerationAction}
                className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-black transition-colors cursor-pointer disabled:opacity-50 ${
                  actionModal.action === 'approve' || actionModal.action === 'reactivate'
                    ? 'bg-emerald-500 hover:bg-emerald-400 text-zinc-950'
                    : actionModal.action === 'suspend'
                    ? 'bg-orange-500 hover:bg-orange-400 text-zinc-950'
                    : 'bg-rose-600 hover:bg-rose-500 text-white'
                }`}
              >
                {submittingAction && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
                <span>تأكيد التنفيذ</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
