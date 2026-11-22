import React, { useEffect, useState, useMemo, useCallback } from 'react';
import {
  Receipt,
  Search,
  Plus,
  RefreshCw,
  Eye,
  X,
  Calendar,
  ShieldCheck,
  AlertCircle,
  CheckCircle2,
  CreditCard,
  Wallet,
} from 'lucide-react';
import { Payment, Restaurant, OfficialSubscriptionPlanConfig } from '../types';
import { PaymentService, computePaymentRevenueMetrics } from '../services/paymentService';
import { RestaurantService } from '../services/restaurantService';
import { ManualSubscriptionService } from '../services/manualSubscriptionService';
import { StatusBadge } from '../components/common/StatusBadge';
import { EmptyState } from '../components/common/EmptyState';
import { useToast } from '../contexts/ToastContext';
import { ExportButton } from '../components/common/ExportButton';
import { exportPayments } from '../utils/exportUtils';

function generateIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `mpay_${crypto.randomUUID()}`;
  }
  return `mpay_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function getSourceBadge(payment: Payment): { label: string; className: string } {
  const src = String(payment.source || '').toLowerCase();
  const type = String(payment.type || '').toLowerCase();
  if (src.includes('vodafone') || type === 'manual_subscription') {
    return {
      label: 'فودافون كاش',
      className: 'bg-sky-500/10 text-sky-400 border-sky-500/25',
    };
  }
  if (type === 'subscription_renewal') {
    return {
      label: 'تجديد اشتراك',
      className: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/25',
    };
  }
  if (type === 'manual_subscription_payment') {
    return {
      label: 'اشتراك إداري',
      className: 'bg-amber-500/10 text-amber-400 border-amber-500/25',
    };
  }
  if (type === 'manual_financial_payment') {
    return {
      label: 'دفعة مالية مستقلة',
      className: 'bg-zinc-800 text-zinc-300 border-zinc-700',
    };
  }
  return {
    label: 'معاملة مسجلة',
    className: 'bg-zinc-900 text-zinc-400 border-zinc-800',
  };
}

export const PaymentsPage: React.FC = () => {
  const { success, error: toastError, info } = useToast();

  const [payments, setPayments] = useState<Payment[]>([]);
  const [merchants, setMerchants] = useState<Restaurant[]>([]);
  const [officialPackages, setOfficialPackages] = useState<OfficialSubscriptionPlanConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'success' | 'pending' | 'failed'>('all');
  const [methodFilter, setMethodFilter] = useState<string>('all');
  const [dateFilter, setDateFilter] = useState<string>('');

  // Modals state
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [viewingPayment, setViewingPayment] = useState<Payment | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState<string>(() => generateIdempotencyKey());

  const todayYMD = new Date().toISOString().split('T')[0];

  // Form state for server-authoritative `recordManualPayment`
  const [formData, setFormData] = useState({
    merchantId: '',
    applySubscription: true,
    subscriptionAction: 'activate' as 'activate' | 'renew',
    planId: '',
    maxCaptains: 0,
    amount: 0,
    paymentDate: todayYMD,
    paymentMethod: 'فودافون كاش (Vodafone Cash)',
    transactionReference: '',
    paymentStatus: 'paid' as 'paid' | 'pending' | 'failed',
    notes: '',
  });

  const eligibleMerchants = useMemo(() => {
    const strict = merchants.filter((merchant) => {
      const accountStatus = String(merchant.raw?.status || '').toLowerCase();
      const isApproved =
        accountStatus === 'active' ||
        accountStatus === 'approved' ||
        merchant.raw?.isApproved === true;
      return (
        merchant.raw?.accountType === 'merchant' &&
        isApproved &&
        (!merchant.raw?.uid || merchant.raw.uid === merchant.id)
      );
    });
    return strict.length > 0 ? strict : merchants;
  }, [merchants]);

  const activePackages = useMemo(
    () => officialPackages.filter((p) => p.isActive !== false),
    [officialPackages]
  );

  const loadSupportingData = useCallback(async () => {
    const [restRes, cfg] = await Promise.all([
      RestaurantService.getAll().catch(() => ({ data: [] as Restaurant[], isLive: false })),
      ManualSubscriptionService.getSettings().catch(() => null),
    ]);
    setMerchants(restRes.data);
    if (cfg?.plans) {
      setOfficialPackages(cfg.plans);
    }
  }, []);

  const fetchPayments = async () => {
    setLoading(true);
    try {
      const [payRes] = await Promise.all([PaymentService.getAll(), loadSupportingData()]);
      setPayments(payRes.data);
    } catch (err) {
      console.error('Failed to load payments:', err);
      toastError('فشل تحميل سجل المعاملات المالية');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setLoading(true);
    const unsub = PaymentService.subscribe(
      (livePayments) => {
        setPayments(livePayments);
        setLoading(false);
      },
      () => {
        setLoading(false);
      }
    );

    loadSupportingData();

    return () => unsub();
  }, [loadSupportingData]);

  const handleOpenAddModal = () => {
    const firstPkg = activePackages[0];
    setIdempotencyKey(generateIdempotencyKey());
    setFormData({
      merchantId: '',
      applySubscription: activePackages.length > 0,
      subscriptionAction: 'activate',
      planId: firstPkg?.planId || '',
      maxCaptains: firstPkg?.maxCaptains || 0,
      amount: firstPkg?.price || 0,
      paymentDate: new Date().toISOString().split('T')[0],
      paymentMethod: 'فودافون كاش (Vodafone Cash)',
      transactionReference: '',
      paymentStatus: 'paid',
      notes: '',
    });
    setIsAddModalOpen(true);
  };

  const handleSelectPackage = (pkg: OfficialSubscriptionPlanConfig) => {
    setFormData((prev) => ({
      ...prev,
      planId: pkg.planId,
      maxCaptains: pkg.maxCaptains,
      amount: pkg.price,
    }));
  };

  const filteredPayments = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return payments.filter((p) => {
      const txn = (p.transactionId || p.transactionNumber || '').toLowerCase();
      const matchesSearch =
        !q ||
        txn.includes(q) ||
        p.restaurantName.toLowerCase().includes(q) ||
        (p.merchantPhone || '').toLowerCase().includes(q) ||
        p.restaurantId.toLowerCase().includes(q) ||
        p.paymentMethod.toLowerCase().includes(q) ||
        (p.planName || p.packageName || '').toLowerCase().includes(q) ||
        (p.subscriptionNumber || '').toLowerCase().includes(q) ||
        (p.senderPhone || '').toLowerCase().includes(q);

      const matchesStatus = statusFilter === 'all' ? true : p.status === statusFilter;
      const matchesMethod =
        methodFilter === 'all'
          ? true
          : methodFilter === 'فودافون كاش'
            ? p.paymentMethod.includes('فودافون') || p.paymentMethod.toLowerCase().includes('vodafone')
            : p.paymentMethod.includes(methodFilter);

      const matchesDate = !dateFilter ? true : (p.date || '').startsWith(dateFilter);

      return matchesSearch && matchesStatus && matchesMethod && matchesDate;
    });
  }, [payments, searchQuery, statusFilter, methodFilter, dateFilter]);

  const revenueMetrics = useMemo(() => computePaymentRevenueMetrics(payments), [payments]);
  const totalSuccessful = revenueMetrics.totalRevenue;
  const monthlyRevenue = revenueMetrics.monthlyRevenue;

  const handleCreatePayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.merchantId) {
      toastError('يرجى اختيار التاجر المسجل من القائمة');
      return;
    }

    const numericAmount = Number(formData.amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      toastError('يرجى إدخال مبلغ صحيح أكبر من صفر');
      return;
    }

    if (formData.applySubscription && !formData.planId && !formData.maxCaptains) {
      toastError('يرجى اختيار باقة الاشتراك الرسمية المرتبطة بالدفعة');
      return;
    }

    setActionLoading(true);
    try {
      const res = await PaymentService.recordManualPayment({
        merchantId: formData.merchantId,
        idempotencyKey,
        amount: numericAmount,
        paymentMethod: formData.paymentMethod,
        paymentDate: formData.paymentDate,
        transactionReference: formData.transactionReference.trim() || undefined,
        notes: formData.notes.trim() || undefined,
        paymentStatus: formData.paymentStatus,
        applySubscription: formData.applySubscription,
        subscriptionAction: formData.applySubscription ? formData.subscriptionAction : undefined,
        planId: formData.applySubscription ? formData.planId || undefined : undefined,
        maxCaptains: formData.applySubscription ? formData.maxCaptains || undefined : undefined,
      });

      if (res.alreadyRecorded) {
        info(res.message || 'تم تسجيل هذه الدفعة مسبقاً ومنع التكرار بنجاح');
      } else {
        success(
          res.message ||
            (res.subscriptionActivated
              ? 'تم تسجيل الدفعة وتفعيل اشتراك التاجر ومزامنته مع تطبيق التاجر بنجاح'
              : 'تم تسجيل الدفعة المالية بنجاح')
        );
      }

      setIdempotencyKey(generateIdempotencyKey());
      setIsAddModalOpen(false);
    } catch (err: any) {
      toastError(err?.message || 'فشل تسجيل المعاملة المالية عبر الخادم');
    } finally {
      setActionLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Top Header Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl sm:text-2xl font-black text-white">المدفوعات والمعاملات المالية</h2>
          <p className="text-xs sm:text-sm text-zinc-400 mt-0.5">
            السجل المالي المركزي لجميع مدفوعات فودافون كاش والتفعيلات اليدوية والتجديدات المرتبطة بالتجار
          </p>
        </div>

        <div className="flex items-center gap-3">
          <ExportButton
            onExportExcel={() => exportPayments(filteredPayments, 'xlsx')}
            onExportCsv={() => exportPayments(filteredPayments, 'csv')}
            label="تصدير المدفوعات"
            count={filteredPayments.length}
          />

          <button
            onClick={fetchPayments}
            className="p-2.5 rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-300 hover:text-white hover:bg-zinc-800 transition-colors"
            title="تحديث البيانات"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
          <button
            onClick={handleOpenAddModal}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-zinc-950 font-black text-xs sm:text-sm shadow-md shadow-amber-500/10 transition-colors"
          >
            <Plus className="w-4 h-4" />
            <span>تسجيل دفعة جديدة</span>
          </button>
        </div>
      </div>

      {/* Financial Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 sm:gap-4">
        <div className="p-5 rounded-2xl bg-[#11141c] border border-emerald-500/30 shadow-md">
          <span className="text-xs font-bold text-emerald-400 block mb-1">الإيرادات الشهرية (الشهر الحالي)</span>
          <span className="text-xl sm:text-2xl font-black text-white font-['Outfit',sans-serif]">
            {monthlyRevenue.toLocaleString('ar-EG')}{' '}
            <span className="text-xs font-bold text-emerald-400 font-['Cairo']">ج.م</span>
          </span>
        </div>

        <div className="p-5 rounded-2xl bg-[#11141c] border border-amber-500/20 shadow-md">
          <span className="text-xs font-bold text-amber-400 block mb-1">إجمالي المحصل (ناجحة)</span>
          <span className="text-xl sm:text-2xl font-black text-white font-['Outfit',sans-serif]">
            {totalSuccessful.toLocaleString('ar-EG')}{' '}
            <span className="text-xs font-bold text-amber-400 font-['Cairo']">ج.م</span>
          </span>
        </div>

        <div className="p-5 rounded-2xl bg-[#11141c] border border-zinc-800/80">
          <span className="text-xs font-bold text-emerald-400 block mb-1">المعاملات الناجحة</span>
          <span className="text-xl sm:text-2xl font-black text-emerald-400 font-['Outfit',sans-serif]">
            {payments.filter((p) => p.status === 'success').length}
          </span>
        </div>

        <div className="p-5 rounded-2xl bg-[#11141c] border border-zinc-800/80">
          <span className="text-xs font-bold text-amber-400 block mb-1">قيد الانتظار</span>
          <span className="text-xl sm:text-2xl font-black text-amber-400 font-['Outfit',sans-serif]">
            {payments.filter((p) => p.status === 'pending').length}
          </span>
        </div>

        <div className="p-5 rounded-2xl bg-[#11141c] border border-zinc-800/80 col-span-2 lg:col-span-1">
          <span className="text-xs font-bold text-rose-400 block mb-1">المعاملات الفاشلة</span>
          <span className="text-xl sm:text-2xl font-black text-rose-400 font-['Outfit',sans-serif]">
            {payments.filter((p) => p.status === 'failed').length}
          </span>
        </div>
      </div>

      {/* Filters and Search Bar */}
      <div className="bg-[#11141c] border border-zinc-800/90 rounded-2xl p-4 flex flex-col xl:flex-row gap-3 justify-between items-stretch xl:items-center">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 text-zinc-400 absolute right-3.5 top-3.5 pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="البحث برقم المعاملة، اسم التاجر، الهاتف، الباقة، أو رقم الاشتراك..."
            className="w-full bg-[#0a0c12] border border-zinc-800 text-zinc-100 placeholder-zinc-500 rounded-xl py-2.5 pr-10 pl-4 text-xs sm:text-sm focus:outline-none focus:border-amber-500 transition-colors"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Status filter tabs */}
          <div className="flex items-center rounded-xl bg-[#0a0c12] border border-zinc-800 p-1 text-xs">
            <button
              onClick={() => setStatusFilter('all')}
              className={`px-3 py-1.5 rounded-lg font-bold transition-colors ${
                statusFilter === 'all' ? 'bg-amber-500 text-zinc-950' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              الكل ({payments.length})
            </button>
            <button
              onClick={() => setStatusFilter('success')}
              className={`px-3 py-1.5 rounded-lg font-bold transition-colors ${
                statusFilter === 'success' ? 'bg-amber-500 text-zinc-950' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              ناجحة
            </button>
            <button
              onClick={() => setStatusFilter('pending')}
              className={`px-3 py-1.5 rounded-lg font-bold transition-colors ${
                statusFilter === 'pending' ? 'bg-amber-500 text-zinc-950' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              قيد الانتظار
            </button>
            <button
              onClick={() => setStatusFilter('failed')}
              className={`px-3 py-1.5 rounded-lg font-bold transition-colors ${
                statusFilter === 'failed' ? 'bg-amber-500 text-zinc-950' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              فاشلة
            </button>
          </div>

          <select
            value={methodFilter}
            onChange={(e) => setMethodFilter(e.target.value)}
            className="bg-[#0a0c12] border border-zinc-800 text-zinc-300 rounded-xl px-3 py-2 text-xs focus:outline-none focus:border-amber-500"
          >
            <option value="all">كل طرق الدفع</option>
            <option value="فودافون كاش">فودافون كاش</option>
            <option value="محفظة">محفظة إلكترونية</option>
            <option value="تحويل بنكي">تحويل بنكي / InstaPay</option>
            <option value="نقدي">نقدي (كاش)</option>
          </select>

          <div className="flex items-center gap-1 bg-[#0a0c12] border border-zinc-800 rounded-xl px-2.5 py-1.5">
            <Calendar className="w-3.5 h-3.5 text-zinc-500" />
            <input
              type="date"
              value={dateFilter}
              onChange={(e) => setDateFilter(e.target.value)}
              className="bg-transparent text-zinc-200 text-xs font-mono focus:outline-none"
              title="فلترة حسب تاريخ الدفع"
            />
            {dateFilter && (
              <button
                type="button"
                onClick={() => setDateFilter('')}
                className="text-zinc-500 hover:text-white p-0.5"
                title="مسح فلتر التاريخ"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Payments Table */}
      <div className="bg-[#11141c] border border-zinc-800/90 rounded-3xl shadow-xl overflow-hidden">
        {loading ? (
          <div className="p-12 text-center">
            <div className="w-8 h-8 border-3 border-amber-500/20 border-t-amber-500 rounded-full animate-spin mx-auto mb-3" />
            <p className="text-zinc-400 text-xs font-semibold">جاري جلب المعاملات المالية...</p>
          </div>
        ) : filteredPayments.length === 0 ? (
          <div className="p-8">
            <EmptyState
              title="لم يتم العثور على معاملات مالية"
              description="لا توجد بيانات مطابقة لمعايير البحث أو التاريخ الحالية."
              icon={Receipt}
              actionText="تسجيل دفعة جديدة"
              onAction={handleOpenAddModal}
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-right border-collapse text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-xs font-bold text-zinc-400 bg-zinc-950/40">
                  <th className="py-4 px-4">رقم المعاملة / المرجع</th>
                  <th className="py-4 px-4">التاجر والباقة</th>
                  <th className="py-4 px-4">المبلغ</th>
                  <th className="py-4 px-4">طريقة الدفع والمصدر</th>
                  <th className="py-4 px-4">تاريخ الدفع</th>
                  <th className="py-4 px-4">الحالة</th>
                  <th className="py-4 px-4 text-left">الإجراءات</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {filteredPayments.map((payment) => {
                  const sourceMeta = getSourceBadge(payment);
                  return (
                    <tr key={payment.id} className="hover:bg-zinc-900/40 transition-colors">
                      <td className="py-4 px-4">
                        <div className="font-mono font-bold text-amber-400 text-xs">
                          {payment.transactionId || payment.transactionNumber}
                        </div>
                        {payment.subscriptionNumber && (
                          <div className="text-[10px] font-mono text-zinc-500 mt-0.5">
                            {payment.subscriptionNumber}
                          </div>
                        )}
                      </td>

                      <td className="py-4 px-4 font-bold text-zinc-100">
                        <div>{payment.restaurantName}</div>
                        <div className="flex flex-wrap items-center gap-2 mt-0.5">
                          {(payment.planName || payment.packageName) && (
                            <span className="text-[11px] font-semibold text-amber-400/90">
                              {payment.planName || payment.packageName}
                              {payment.maxCaptains ? ` (${payment.maxCaptains} كابتن)` : ''}
                            </span>
                          )}
                          {payment.merchantPhone && (
                            <span className="text-[11px] font-mono text-zinc-500" dir="ltr">
                              {payment.merchantPhone}
                            </span>
                          )}
                        </div>
                      </td>

                      <td className="py-4 px-4 font-mono font-black text-white text-xs font-['Outfit',sans-serif]">
                        {payment.amount.toLocaleString('ar-EG')} ج.م
                      </td>

                      <td className="py-4 px-4 text-xs text-zinc-300">
                        <div className="flex flex-col gap-1 items-start">
                          <span className="px-2 py-0.5 rounded-md bg-zinc-900 border border-zinc-800 text-zinc-300">
                            {payment.paymentMethod}
                          </span>
                          <span
                            className={`text-[10px] font-bold px-2 py-0.5 rounded-md border ${sourceMeta.className}`}
                          >
                            {sourceMeta.label}
                          </span>
                        </div>
                      </td>

                      <td className="py-4 px-4 text-xs font-mono text-zinc-400">
                        {payment.date}
                      </td>

                      <td className="py-4 px-4">
                        <StatusBadge status={payment.status} type="payment" />
                      </td>

                      <td className="py-4 px-4 text-left">
                        <button
                          onClick={() => setViewingPayment(payment)}
                          className="p-1.5 text-zinc-400 hover:text-white hover:bg-zinc-800/80 rounded-lg transition-colors"
                          title="عرض تفاصيل الإيصال"
                        >
                          <Eye className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* View Payment Receipt Modal */}
      {viewingPayment && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-xs">
          <div className="w-full max-w-md bg-[#11141c] border border-zinc-800 rounded-3xl p-6 shadow-2xl relative max-h-[90vh] overflow-y-auto">
            <button
              onClick={() => setViewingPayment(null)}
              className="absolute top-5 left-5 text-zinc-400 hover:text-white p-1 rounded-lg"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="flex items-center gap-3 mb-6">
              <div className="w-12 h-12 rounded-2xl bg-amber-500/10 border border-amber-500/20 text-amber-400 flex items-center justify-center font-bold text-lg">
                <Receipt className="w-6 h-6" />
              </div>
              <div>
                <h3 className="text-lg font-black text-white">إيصال العملية المالية</h3>
                <p className="text-xs font-mono text-amber-400">
                  {viewingPayment.transactionId || viewingPayment.transactionNumber}
                </p>
              </div>
            </div>

            <div className="p-4 rounded-2xl bg-zinc-950/60 border border-zinc-800 space-y-3 text-xs mb-5">
              <div className="flex items-center justify-between">
                <span className="text-zinc-500">التاجر:</span>
                <span className="font-bold text-zinc-200">{viewingPayment.restaurantName}</span>
              </div>
              {viewingPayment.restaurantId && (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-zinc-500">معرف التاجر:</span>
                  <span className="font-mono text-zinc-400 text-[11px] truncate max-w-[200px]" dir="ltr">
                    {viewingPayment.restaurantId}
                  </span>
                </div>
              )}
              {viewingPayment.merchantPhone && (
                <div className="flex items-center justify-between">
                  <span className="text-zinc-500">هاتف التاجر:</span>
                  <span className="font-mono text-zinc-300" dir="ltr">
                    {viewingPayment.merchantPhone}
                  </span>
                </div>
              )}
              {(viewingPayment.planName || viewingPayment.packageName) && (
                <div className="flex items-center justify-between">
                  <span className="text-zinc-500">الباقة:</span>
                  <span className="font-bold text-amber-400">
                    {viewingPayment.planName || viewingPayment.packageName}
                    {viewingPayment.maxCaptains ? ` (${viewingPayment.maxCaptains} كابتن)` : ''}
                  </span>
                </div>
              )}
              {viewingPayment.subscriptionNumber && (
                <div className="flex items-center justify-between">
                  <span className="text-zinc-500">رقم الاشتراك المرتبط:</span>
                  <span className="font-mono text-emerald-400">{viewingPayment.subscriptionNumber}</span>
                </div>
              )}
              {viewingPayment.requestId && (
                <div className="flex items-center justify-between">
                  <span className="text-zinc-500">معرف طلب فودافون كاش:</span>
                  <span className="font-mono text-sky-400 text-[11px]">{viewingPayment.requestId}</span>
                </div>
              )}
              <div className="flex items-center justify-between">
                <span className="text-zinc-500">المبلغ المسدد:</span>
                <span className="font-black text-white font-['Outfit',sans-serif] text-sm">
                  {viewingPayment.amount.toLocaleString('ar-EG')} ج.م
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-zinc-500">وسيلة الدفع:</span>
                <span className="text-zinc-300">{viewingPayment.paymentMethod}</span>
              </div>
              {viewingPayment.senderPhone && (
                <div className="flex items-center justify-between">
                  <span className="text-zinc-500">المحفظة المحوِّلة:</span>
                  <span className="font-mono text-zinc-300" dir="ltr">
                    {viewingPayment.senderPhone}
                  </span>
                </div>
              )}
              {viewingPayment.receiverWalletNumber && (
                <div className="flex items-center justify-between">
                  <span className="text-zinc-500">المحفظة المستلمة:</span>
                  <span className="font-mono text-amber-400" dir="ltr">
                    {viewingPayment.receiverWalletNumber}
                  </span>
                </div>
              )}
              <div className="flex items-center justify-between">
                <span className="text-zinc-500">التاريخ:</span>
                <span className="font-mono text-zinc-300">{viewingPayment.date}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-zinc-500">الحالة:</span>
                <StatusBadge status={viewingPayment.status} type="payment" />
              </div>
              {viewingPayment.notes && (
                <div className="pt-2 border-t border-zinc-800 text-zinc-400">
                  <span className="text-zinc-500 block mb-1">ملاحظات:</span>
                  <p>{viewingPayment.notes}</p>
                </div>
              )}
            </div>

            <button
              onClick={() => setViewingPayment(null)}
              className="w-full py-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-200 font-bold text-xs transition-colors"
            >
              إغلاق الإيصال
            </button>
          </div>
        </div>
      )}

      {/* Server-Authoritative Manual Payment Modal */}
      {isAddModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-xs">
          <div className="w-full max-w-lg bg-[#11141c] border border-zinc-800 rounded-3xl p-6 shadow-2xl relative max-h-[92vh] overflow-y-auto">
            <button
              onClick={() => !actionLoading && setIsAddModalOpen(false)}
              className="absolute top-5 left-5 text-zinc-400 hover:text-white p-1 rounded-lg"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl bg-amber-500/15 border border-amber-500/30 text-amber-400 flex items-center justify-center">
                <Wallet className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-lg font-black text-white">تسجيل دفعة مالية جديدة</h3>
                <p className="text-[11px] text-zinc-400">
                  يُعالج الطلب عبر الخادم لحماية السجلات المالية ومزامنة الاشتراك تلقائياً مع تطبيق التاجر
                </p>
              </div>
            </div>

            <form onSubmit={handleCreatePayment} className="space-y-4 text-xs">
              {/* Merchant Selector */}
              <div>
                <label className="block font-bold text-zinc-300 mb-1.5">اختر التاجر المسجل *</label>
                {eligibleMerchants.length > 0 ? (
                  <select
                    value={formData.merchantId}
                    onChange={(e) => setFormData({ ...formData, merchantId: e.target.value })}
                    className="w-full bg-[#0a0c12] border border-zinc-800 rounded-xl px-3.5 py-2.5 text-zinc-100 focus:outline-none focus:border-amber-500"
                    required
                  >
                    <option value="">-- اختر حساب التاجر من قاعدة البيانات --</option>
                    {eligibleMerchants.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name} {m.phone && m.phone !== '—' ? `(${m.phone})` : ''}
                      </option>
                    ))}
                  </select>
                ) : (
                  <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/25 text-amber-300">
                    لا يوجد تجار مسجلون حالياً في قاعدة البيانات.
                  </div>
                )}
              </div>

              {/* Payment Purpose Toggle */}
              <div>
                <label className="block font-bold text-zinc-300 mb-1.5">نوع الدفعة *</label>
                <div className="grid grid-cols-2 gap-2.5">
                  <button
                    type="button"
                    onClick={() => {
                      const firstPkg = activePackages[0];
                      setFormData((prev) => ({
                        ...prev,
                        applySubscription: true,
                        planId: prev.planId || firstPkg?.planId || '',
                        maxCaptains: prev.maxCaptains || firstPkg?.maxCaptains || 0,
                        amount: prev.amount > 0 ? prev.amount : firstPkg?.price || 0,
                      }));
                    }}
                    className={`p-3 rounded-xl border text-right transition-all ${
                      formData.applySubscription
                        ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                        : 'bg-[#0a0c12] border-zinc-800 text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    <div className="flex items-center gap-1.5 font-black">
                      <CreditCard className="w-4 h-4" />
                      <span>دفعة اشتراك / تجديد</span>
                    </div>
                    <p className="text-[10px] opacity-80 mt-1">
                      تفعّل أو تجدد اشتراك التاجر فور تأكيد الدفع
                    </p>
                  </button>

                  <button
                    type="button"
                    onClick={() =>
                      setFormData((prev) => ({
                        ...prev,
                        applySubscription: false,
                      }))
                    }
                    className={`p-3 rounded-xl border text-right transition-all ${
                      !formData.applySubscription
                        ? 'bg-amber-500/15 border-amber-500/40 text-amber-300'
                        : 'bg-[#0a0c12] border-zinc-800 text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    <div className="flex items-center gap-1.5 font-black">
                      <Receipt className="w-4 h-4" />
                      <span>دفعة مالية مستقلة</span>
                    </div>
                    <p className="text-[10px] opacity-80 mt-1">
                      تسجيل مالي فقط بدون إنشاء أو تفعيل اشتراك
                    </p>
                  </button>
                </div>
              </div>

              {/* Subscription Package Selector (only when applySubscription = true) */}
              {formData.applySubscription && (
                <div className="p-3.5 rounded-2xl bg-[#0a0c12] border border-zinc-800 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-bold text-zinc-200">نوع عملية الاشتراك</span>
                    <div className="flex items-center gap-1.5 bg-[#11141c] border border-zinc-800 rounded-lg p-0.5">
                      <button
                        type="button"
                        onClick={() => setFormData({ ...formData, subscriptionAction: 'activate' })}
                        className={`px-2.5 py-1 rounded-md font-bold transition-colors ${
                          formData.subscriptionAction === 'activate'
                            ? 'bg-amber-500 text-zinc-950'
                            : 'text-zinc-400 hover:text-white'
                        }`}
                      >
                        تفعيل / ترقية
                      </button>
                      <button
                        type="button"
                        onClick={() => setFormData({ ...formData, subscriptionAction: 'renew' })}
                        className={`px-2.5 py-1 rounded-md font-bold transition-colors ${
                          formData.subscriptionAction === 'renew'
                            ? 'bg-emerald-500 text-zinc-950'
                            : 'text-zinc-400 hover:text-white'
                        }`}
                      >
                        تجديد الاشتراك
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="block font-bold text-zinc-400 mb-1.5">اختر الباقة الرسمية *</label>
                    {activePackages.length > 0 ? (
                      <div className="grid grid-cols-2 gap-2">
                        {activePackages.map((pkg) => {
                          const selected = formData.planId === pkg.planId;
                          return (
                            <button
                              key={pkg.planId}
                              type="button"
                              onClick={() => handleSelectPackage(pkg)}
                              className={`p-2.5 rounded-xl border text-right transition-all ${
                                selected
                                  ? 'bg-amber-500 text-zinc-950 border-amber-400 font-black'
                                  : 'bg-[#11141c] text-zinc-200 border-zinc-800 hover:border-zinc-700'
                              }`}
                            >
                              <div className="flex items-center justify-between gap-1">
                                <span className="font-bold truncate">{pkg.planName}</span>
                                <span className="text-[10px] opacity-80">{pkg.durationDays || 30} يوم</span>
                              </div>
                              <div
                                className={`text-xs font-mono font-black mt-0.5 ${
                                  selected ? 'text-zinc-950' : 'text-emerald-400'
                                }`}
                              >
                                {pkg.price.toLocaleString('en-US')} ج.م • {pkg.maxCaptains} كابتن
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="text-amber-400 text-[11px]">
                        لا توجد باقات نشطة مضبوطة حالياً. يمكنك إضافتها من قسم «الباقات».
                      </p>
                    )}
                  </div>
                </div>
              )}

              {/* Amount & Date */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-bold text-zinc-300 mb-1.5">المبلغ المحصل (ج.م) *</label>
                  <input
                    type="number"
                    min={1}
                    value={formData.amount || ''}
                    onChange={(e) => setFormData({ ...formData, amount: Number(e.target.value) })}
                    className="w-full bg-[#0a0c12] border border-zinc-800 rounded-xl px-3.5 py-2.5 text-zinc-100 focus:outline-none focus:border-amber-500 font-mono"
                    required
                  />
                </div>
                <div>
                  <label className="block font-bold text-zinc-300 mb-1.5">تاريخ الدفع *</label>
                  <input
                    type="date"
                    value={formData.paymentDate}
                    onChange={(e) => setFormData({ ...formData, paymentDate: e.target.value })}
                    className="w-full bg-[#0a0c12] border border-zinc-800 rounded-xl px-3.5 py-2.5 text-zinc-100 focus:outline-none focus:border-amber-500 font-mono"
                    required
                  />
                </div>
              </div>

              {/* Method & Status */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-bold text-zinc-300 mb-1.5">طريقة الدفع</label>
                  <select
                    value={formData.paymentMethod}
                    onChange={(e) => setFormData({ ...formData, paymentMethod: e.target.value })}
                    className="w-full bg-[#0a0c12] border border-zinc-800 rounded-xl px-3 py-2.5 text-zinc-100 focus:outline-none focus:border-amber-500"
                  >
                    <option value="فودافون كاش (Vodafone Cash)">فودافون كاش (Vodafone Cash)</option>
                    <option value="كاش نقدي (Cash)">كاش نقدي (Cash)</option>
                    <option value="تحويل بنكي / InstaPay">تحويل بنكي / InstaPay</option>
                    <option value="محفظة إلكترونية (Smart Wallet)">محفظة إلكترونية</option>
                  </select>
                </div>

                <div>
                  <label className="block font-bold text-zinc-300 mb-1.5">حالة الدفع</label>
                  <select
                    value={formData.paymentStatus}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        paymentStatus: e.target.value as 'paid' | 'pending' | 'failed',
                      })
                    }
                    className="w-full bg-[#0a0c12] border border-zinc-800 rounded-xl px-3 py-2.5 text-zinc-100 focus:outline-none focus:border-amber-500"
                  >
                    <option value="paid">مدفوعة وناجحة (Paid)</option>
                    <option value="pending">قيد الانتظار (Pending)</option>
                    <option value="failed">فاشلة (Failed)</option>
                  </select>
                </div>
              </div>

              {/* Reference & Notes */}
              <div>
                <label className="block font-bold text-zinc-300 mb-1.5">الرقم المرجعي / رقم الحوالة (اختياري)</label>
                <input
                  type="text"
                  dir="ltr"
                  value={formData.transactionReference}
                  onChange={(e) => setFormData({ ...formData, transactionReference: e.target.value })}
                  placeholder="مثال: VF-987654 أو رقم الإيصال"
                  className="w-full bg-[#0a0c12] border border-zinc-800 rounded-xl px-3.5 py-2.5 text-zinc-100 font-mono focus:outline-none focus:border-amber-500"
                />
              </div>

              <div>
                <label className="block font-bold text-zinc-300 mb-1.5">ملاحظات إدارية (اختياري)</label>
                <input
                  type="text"
                  value={formData.notes}
                  onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                  placeholder="مثال: تحصيل نقدي بمقر الإدارة أو تجديد باقة شهرية"
                  className="w-full bg-[#0a0c12] border border-zinc-800 rounded-xl px-3.5 py-2.5 text-zinc-100 focus:outline-none focus:border-amber-500"
                />
              </div>

              {/* Clear feedback banner explaining exact server behavior */}
              {formData.applySubscription && formData.paymentStatus === 'paid' ? (
                <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/25 text-emerald-300 flex items-start gap-2">
                  <ShieldCheck className="w-4 h-4 shrink-0 mt-0.5" />
                  <p className="leading-relaxed">
                    سيتم تسجيل الدفعة وتفعيل/تجديد اشتراك التاجر ومزامنة بياناته فوراً مع تطبيق التاجر،
                    مع أرشفة أي فترة اشتراك سابقة في السجل التاريخي.
                  </p>
                </div>
              ) : (
                <div className="p-3 rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-400 flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-amber-400" />
                  <p className="leading-relaxed">
                    {formData.applySubscription
                      ? 'حالة الدفع ليست «مدفوعة»، لذلك سيتم حفظ المعاملة في المدفوعات فقط دون تفعيل الاشتراك.'
                      : 'دفعة مالية مستقلة — سيتم حفظها في سجل المدفوعات فقط دون تعديل أو تفعيل اشتراك التاجر.'}
                  </p>
                </div>
              )}

              <div className="flex items-center justify-end gap-3 pt-3 border-t border-zinc-800/80">
                <button
                  type="button"
                  onClick={() => setIsAddModalOpen(false)}
                  disabled={actionLoading}
                  className="px-4 py-2 text-zinc-400 hover:text-white"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={actionLoading || eligibleMerchants.length === 0}
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-zinc-950 font-black transition-colors disabled:opacity-50"
                >
                  <CheckCircle2 className="w-4 h-4" />
                  <span>{actionLoading ? 'جاري التنفيذ عبر السيرفر...' : 'تأكيد وتسجيل الدفعة'}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
