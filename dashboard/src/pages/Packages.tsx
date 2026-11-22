import React, { useEffect, useState } from 'react';
import {
  Package,
  Plus,
  Edit3,
  Trash2,
  Save,
  ShieldCheck,
  Smartphone,
  Users,
  Calendar,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Sparkles,
  FileText,
  RefreshCw,
  X,
} from 'lucide-react';
import { ManualSubscriptionService } from '../services/manualSubscriptionService';
import { OfficialSubscriptionPlanConfig } from '../types';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';

interface PackageFormState {
  isNew: boolean;
  originalIndex: number | null;
  planId: string;
  planName: string;
  maxCaptains: number;
  price: number;
  durationDays: number;
  featuresText: string;
  isActive: boolean;
  isPopular: boolean;
}

const EMPTY_FORM: PackageFormState = {
  isNew: true,
  originalIndex: null,
  planId: '',
  planName: '',
  maxCaptains: 2,
  price: 400,
  durationDays: 30,
  featuresText: '',
  isActive: true,
  isPopular: false,
};

export const PackagesPage: React.FC = () => {
  const { user, isMasterAdmin } = useAuth();
  const { success, error: showError, info } = useToast();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Vodafone Cash & Global Subscription Settings (loaded from Firestore, never hardcoded)
  const [vodafoneCashNumber, setVodafoneCashNumber] = useState('');
  const [walletHolderName, setWalletHolderName] = useState('');
  const [vodafoneCashInstructions, setVodafoneCashInstructions] = useState('');
  const [isAcceptingSubscriptions, setIsAcceptingSubscriptions] = useState(true);
  const [pauseMessage, setPauseMessage] = useState('');
  const [defaultDurationDays, setDefaultDurationDays] = useState(30);
  const [plans, setPlans] = useState<OfficialSubscriptionPlanConfig[]>([]);
  const [configVersion, setConfigVersion] = useState<number>(0);
  const [isConfiguredInFirestore, setIsConfiguredInFirestore] = useState(false);
  const [lastUpdatedLabel, setLastUpdatedLabel] = useState<string | null>(null);

  // Add/Edit Package Modal
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [formState, setFormState] = useState<PackageFormState>(EMPTY_FORM);

  // Safe Delete Confirmation Modal
  const [deleteTargetIndex, setDeleteTargetIndex] = useState<number | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const loadConfig = async () => {
    setLoading(true);
    try {
      const cfg = await ManualSubscriptionService.getSettings();
      setVodafoneCashNumber(cfg.vodafoneCashNumber || '');
      setWalletHolderName(cfg.walletHolderName || '');
      setVodafoneCashInstructions(cfg.vodafoneCashInstructions || '');
      setIsAcceptingSubscriptions(cfg.isAcceptingSubscriptions);
      setPauseMessage(cfg.pauseMessage || '');
      setDefaultDurationDays(cfg.durationDays || 30);
      setPlans(cfg.plans || []);
      setConfigVersion(Number.isFinite(Number(cfg.configVersion)) ? Number(cfg.configVersion) : 0);
      setIsConfiguredInFirestore(Boolean(cfg.isConfiguredInFirestore));
      if (cfg.updatedAt) {
        const dt = new Date(cfg.updatedAt);
        setLastUpdatedLabel(
          `${dt.toLocaleDateString('ar-EG')} — ${dt.toLocaleTimeString('ar-EG', {
            hour: '2-digit',
            minute: '2-digit',
          })}${cfg.updatedByName ? ` بواسطة ${cfg.updatedByName}` : ''}`
        );
      } else {
        setLastUpdatedLabel(null);
      }
    } catch (err: any) {
      showError(err?.message || 'تعذر تحميل بيانات الباقات وإعدادات فودافون كاش.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadConfig();
  }, []);

  const persistAllSettings = async (
    nextPlans: OfficialSubscriptionPlanConfig[],
    successMsg: string
  ) => {
    if (!isMasterAdmin) {
      showError('تعديل الباقات وإعدادات فودافون كاش متاح للمسؤول الرئيسي فقط.');
      return false;
    }

    const cleanWallet = vodafoneCashNumber.replace(/[^\d+]/g, '').trim();
    if (isAcceptingSubscriptions && !/^01[0125]\d{8}$/.test(cleanWallet)) {
      showError(
        'يرجى إدخال رقم محفظة فودافون كاش مصري صحيح (11 رقماً يبدأ بـ 010 أو 011 أو 012 أو 015) قبل الحفظ.'
      );
      return false;
    }
    if (nextPlans.length === 0) {
      showError('يجب الإبقاء على باقة واحدة على الأقل في النظام.');
      return false;
    }

    setSaving(true);
    try {
      const res = await ManualSubscriptionService.updateSettings({
        vodafoneCashNumber: cleanWallet,
        walletHolderName: walletHolderName.trim(),
        vodafoneCashInstructions: vodafoneCashInstructions.trim(),
        isAcceptingSubscriptions,
        pauseMessage: pauseMessage.trim(),
        durationDays: Math.max(1, Math.min(365, Math.round(defaultDurationDays || 30))),
        expectedVersion: configVersion,
        plans: nextPlans.map((p) => ({
          planId: p.planId.trim() || `plan_${p.maxCaptains}_captains`,
          planName: p.planName.trim() || `باقة ${p.maxCaptains} كابتن`,
          maxCaptains: Math.max(1, Math.min(100, Math.round(Number(p.maxCaptains) || 1))),
          price: Math.max(1, Number(p.price) || 0),
          durationDays: Math.max(1, Math.min(365, Math.round(Number(p.durationDays) || 30))),
          features: Array.isArray(p.features)
            ? p.features.map((f) => f.trim()).filter(Boolean)
            : [],
          isActive: p.isActive !== false,
          isPopular: p.isPopular === true,
        })),
      });

      setPlans(res.settings.plans || nextPlans);
      const nextVer = res.configVersion ?? res.settings?.configVersion;
      if (typeof nextVer === 'number' && Number.isFinite(nextVer)) {
        setConfigVersion(nextVer);
      }
      setIsConfiguredInFirestore(true);
      setLastUpdatedLabel(`الآن بواسطة ${res.settings.updatedByName || user?.email || 'المسؤول الرئيسي'}`);
      success(res.message || successMsg);
      return true;
    } catch (err: any) {
      const errMsg = String(err?.message || 'تعذر حفظ التغييرات على السيرفر.');
      showError(errMsg);
      if (errMsg.includes('تم تعديل الإعدادات') || errMsg.includes('aborted')) {
        await loadConfig();
      }
      throw err;
    } finally {
      setSaving(false);
    }
  };

  const openAddPackageModal = () => {
    setFormState({
      ...EMPTY_FORM,
      durationDays: defaultDurationDays || 30,
      featuresText: 'تتبع مباشر للكباتن\nدعم فني متواصل\nإشعارات فورية للطلبات',
    });
    setIsModalOpen(true);
  };

  const openEditPackageModal = (plan: OfficialSubscriptionPlanConfig, index: number) => {
    setFormState({
      isNew: false,
      originalIndex: index,
      planId: plan.planId,
      planName: plan.planName,
      maxCaptains: plan.maxCaptains,
      price: plan.price,
      durationDays: plan.durationDays || 30,
      featuresText: (plan.features || []).join('\n'),
      isActive: plan.isActive !== false,
      isPopular: plan.isPopular === true,
    });
    setIsModalOpen(true);
  };

  const handleSavePackageModal = async (e: React.FormEvent) => {
    e.preventDefault();
    const caps = Math.max(1, Math.min(100, Math.round(Number(formState.maxCaptains) || 0)));
    const price = Number(formState.price) || 0;
    const dur = Math.max(1, Math.min(365, Math.round(Number(formState.durationDays) || 30)));
    const name = formState.planName.trim() || `باقة ${caps} كابتن`;
    const features = formState.featuresText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    if (price <= 0) {
      showError('يجب إدخال سعر صالح أكبر من صفر.');
      return;
    }

    const generatedId = formState.planId.trim() || `plan_${caps}_captains`;
    const slugId = generatedId.replace(/[^a-zA-Z0-9_-]/g, '_');

    const duplicateIdx = plans.findIndex(
      (p, idx) => p.planId === slugId && idx !== formState.originalIndex
    );
    const finalPlanId = duplicateIdx >= 0 ? `${slugId}_${Date.now().toString().slice(-4)}` : slugId;

    const updatedPkg: OfficialSubscriptionPlanConfig = {
      planId: finalPlanId,
      planName: name,
      maxCaptains: caps,
      price,
      durationDays: dur,
      features,
      isActive: formState.isActive,
      isPopular: formState.isPopular,
    };

    const nextPlans = [...plans];
    if (formState.isNew || formState.originalIndex === null) {
      nextPlans.push(updatedPkg);
    } else {
      nextPlans[formState.originalIndex] = updatedPkg;
    }

    try {
      const ok = await persistAllSettings(
        nextPlans,
        formState.isNew ? 'تمت إضافة الباقة الجديدة وحفظها بنجاح.' : 'تم تعديل الباقة بنجاح.'
      );
      if (ok) {
        setIsModalOpen(false);
      }
    } catch {
      // toast already displayed
    }
  };

  const handleTogglePlanActive = async (index: number) => {
    if (!isMasterAdmin) {
      showError('تعديل حالة الباقة متاح للمسؤول الرئيسي فقط.');
      return;
    }
    const nextPlans = plans.map((p, idx) =>
      idx === index ? { ...p, isActive: !p.isActive } : p
    );
    try {
      await persistAllSettings(
        nextPlans,
        nextPlans[index].isActive ? 'تم تفعيل الباقة بنجاح.' : 'تم إيقاف الباقة بنجاح.'
      );
    } catch {
      // handled
    }
  };

  const handleConfirmDelete = async () => {
    if (deleteTargetIndex === null) return;
    setDeleteError(null);
    const nextPlans = plans.filter((_, idx) => idx !== deleteTargetIndex);
    try {
      const ok = await persistAllSettings(nextPlans, 'تم حذف الباقة بنجاح.');
      if (ok) {
        setDeleteTargetIndex(null);
      }
    } catch (err: any) {
      setDeleteError(
        err?.message ||
          'تعذر حذف الباقة لأنها مرتبطة بسجلات سابقة. يمكنك تعطيلها بدلاً من حذفها.'
      );
    }
  };

  const handleDisableInsteadOfDelete = async () => {
    if (deleteTargetIndex === null) return;
    const targetIdx = deleteTargetIndex;
    setDeleteTargetIndex(null);
    setDeleteError(null);
    const nextPlans = plans.map((p, idx) => (idx === targetIdx ? { ...p, isActive: false } : p));
    try {
      await persistAllSettings(nextPlans, 'تم إيقاف الباقة مع الحفاظ على جميع السجلات التاريخية.');
    } catch {
      // handled
    }
  };

  const handleSeedFourOfficialTemplates = () => {
    const templatePlans: OfficialSubscriptionPlanConfig[] = [
      {
        planId: 'plan_2_captains',
        planName: 'باقة 2 كابتن',
        maxCaptains: 2,
        price: 400,
        durationDays: 30,
        features: ['حتى 2 كابتن متزامن', 'تتبع مباشر على الخريطة', 'إشعارات فورية للطلبات'],
        isActive: true,
        isPopular: false,
      },
      {
        planId: 'plan_4_captains',
        planName: 'باقة 4 كباتن',
        maxCaptains: 4,
        price: 800,
        durationDays: 30,
        features: ['حتى 4 كباتن متزامنين', 'أولوية توزيع الطلبات', 'تتبع مباشر على الخريطة'],
        isActive: true,
        isPopular: true,
      },
      {
        planId: 'plan_6_captains',
        planName: 'باقة 6 كباتن',
        maxCaptains: 6,
        price: 1200,
        durationDays: 30,
        features: ['حتى 6 كباتن متزامنين', 'أولوية قصوى في التوزيع', 'دعم فني مباشر'],
        isActive: true,
        isPopular: false,
      },
      {
        planId: 'plan_8_captains',
        planName: 'باقة 8 كباتن',
        maxCaptains: 8,
        price: 1600,
        durationDays: 30,
        features: ['حتى 8 كباتن متزامنين', 'تغطية شاملة للمطاعم الكبيرة', 'دعم فني مخصص 24/7'],
        isActive: true,
        isPopular: false,
      },
    ];
    setPlans(templatePlans);
    info('تم تجهيز الباقات الأربع الأساسية — أدخل رقم محفظة فودافون كاش ثم اضغط حفظ.');
  };

  const handleSaveVodafoneSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await persistAllSettings(plans, 'تم حفظ إعدادات فودافون كاش والباقات بنجاح.');
    } catch {
      // handled
    }
  };

  if (loading) {
    return (
      <div className="p-16 text-center bg-[#11141c] border border-zinc-800 rounded-3xl">
        <div className="w-8 h-8 border-2 border-amber-500/20 border-t-amber-500 rounded-full animate-spin mx-auto mb-3" />
        <p className="text-xs font-bold text-zinc-400">جاري تحميل الباقات وإعدادات فودافون كاش...</p>
      </div>
    );
  }

  const activeCount = plans.filter((p) => p.isActive !== false).length;
  const deleteTarget = deleteTargetIndex !== null ? plans[deleteTargetIndex] : null;

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-[#11141c] border border-zinc-800/90 rounded-2xl p-5">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-amber-500/15 border border-amber-500/30 text-amber-400">
            <Package className="w-6 h-6" />
          </div>
          <div>
            <h2 className="text-xl font-black text-white">
              إدارة الباقات وإعدادات فودافون كاش
            </h2>
            <p className="text-xs text-zinc-400 mt-0.5">
              المصدر المركزي الموحّد للباقات الرسمية وتعليمات الدفع التي تظهر مباشرة في تطبيق التاجر
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={loadConfig}
            disabled={saving}
            className="inline-flex items-center gap-2 px-3.5 py-2.5 rounded-xl bg-zinc-900 border border-zinc-800 hover:bg-zinc-800 text-zinc-200 font-bold text-xs transition-colors disabled:opacity-50"
          >
            <RefreshCw className="w-4 h-4" />
            <span>تحديث</span>
          </button>
          {isMasterAdmin && (
            <button
              type="button"
              onClick={openAddPackageModal}
              disabled={saving}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-zinc-950 font-black text-xs transition-colors shadow-md shadow-amber-500/15 disabled:opacity-50"
            >
              <Plus className="w-4 h-4" />
              <span>إضافة باقة جديدة</span>
            </button>
          )}
        </div>
      </div>

      {/* Summary & Price Snapshot Notice */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="p-4 rounded-2xl border border-amber-500/20 bg-amber-500/5">
          <p className="text-xs text-zinc-400 font-semibold">إجمالي الباقات المسجلة</p>
          <p className="text-2xl font-black text-amber-400 mt-1 tabular-nums">{plans.length}</p>
          <p className="text-[11px] text-zinc-400 mt-1">
            {activeCount} مفعّلة • {plans.length - activeCount} موقوفة
          </p>
        </div>

        <div className="p-4 rounded-2xl border border-emerald-500/20 bg-emerald-500/5">
          <p className="text-xs text-zinc-400 font-semibold">حالة استقبال طلبات فودافون كاش</p>
          <div className="mt-1.5">
            <span
              className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold border ${
                isAcceptingSubscriptions
                  ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
                  : 'bg-rose-500/15 text-rose-400 border-rose-500/30'
              }`}
            >
              {isAcceptingSubscriptions ? 'مفتوح لاستقبال الطلبات' : 'متوقف مؤقتاً'}
            </span>
          </div>
          <p className="text-[11px] text-zinc-400 mt-1.5 font-mono" dir="ltr">
            {vodafoneCashNumber || 'لم يتم ضبط رقم المحفظة بعد'}
          </p>
        </div>

        <div className="p-4 rounded-2xl border border-sky-500/20 bg-sky-500/5">
          <p className="text-xs text-sky-300 font-bold flex items-center gap-1.5">
            <ShieldCheck className="w-4 h-4" />
            حماية السجلات والأسعار التاريخية
          </p>
          <p className="text-[11px] text-zinc-300 mt-1.5 leading-relaxed">
            تعديل سعر أي باقة يُطبّق فقط على الاشتراكات الجديدة ولا يغيّر أسعار الاشتراكات السابقة أو الطلبات المسجلة.
          </p>
        </div>
      </div>

      {!isMasterAdmin && (
        <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-center gap-3 text-amber-200 text-xs">
          <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0" />
          <span>
            أنت تتصفح الباقات بوضع القراءة فقط. تعديل الباقات أو أسعارها أو رقم محفظة فودافون كاش متاح لحساب{' '}
            <strong>المسؤول الرئيسي</strong> فقط.
          </span>
        </div>
      )}

      {/* Packages Grid */}
      <div className="space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h3 className="text-base font-extrabold text-zinc-100 flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-amber-400" />
            الباقات الرسمية المتاحة للتجار
          </h3>
          {plans.length === 0 && isMasterAdmin && (
            <button
              type="button"
              onClick={handleSeedFourOfficialTemplates}
              className="px-3.5 py-2 rounded-xl border border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 font-bold text-xs transition-colors"
            >
              تجهيز الباقات الأربع الأساسية (2، 4، 6، 8 كباتن)
            </button>
          )}
        </div>

        {plans.length === 0 ? (
          <div className="p-10 text-center rounded-3xl bg-[#11141c] border border-dashed border-zinc-700">
            <Package className="w-12 h-12 text-zinc-600 mx-auto mb-3" />
            <p className="text-zinc-300 font-bold">لا توجد باقات اشتراك مضبوطة في Firestore بعد</p>
            <p className="text-xs text-zinc-500 mt-1 max-w-md mx-auto">
              أضف الباقات الأربع الأساسية (2، 4، 6، 8 كباتن) أو أضف باقة مخصصة ليتم عرضها فوراً في تطبيق التاجر ولوحة التحكم.
            </p>
            {isMasterAdmin && (
              <div className="flex items-center justify-center gap-3 mt-4">
                <button
                  type="button"
                  onClick={handleSeedFourOfficialTemplates}
                  className="px-4 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-zinc-950 font-black text-xs transition-colors"
                >
                  تجهيز الباقات الأربع الأساسية
                </button>
                <button
                  type="button"
                  onClick={openAddPackageModal}
                  className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-zinc-900 border border-zinc-700 hover:bg-zinc-800 text-zinc-200 font-bold text-xs transition-colors"
                >
                  <Plus className="w-4 h-4" />
                  <span>إضافة باقة يدوياً</span>
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
            {plans.map((pkg, idx) => (
              <div
                key={pkg.planId}
                className={`p-5 rounded-2xl border flex flex-col justify-between transition-all ${
                  pkg.isActive === false
                    ? 'opacity-65 border-zinc-800 bg-zinc-950/60'
                    : pkg.isPopular
                      ? 'border-amber-500/50 bg-gradient-to-b from-amber-500/10 to-[#11141c] shadow-lg'
                      : 'border-zinc-800 bg-[#11141c] hover:border-amber-500/30'
                }`}
              >
                <div>
                  <div className="flex items-start justify-between gap-2 mb-3">
                    <div>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <h4 className="font-extrabold text-zinc-100 text-base">{pkg.planName}</h4>
                        {pkg.isPopular && (
                          <span className="text-[10px] px-2 py-0.5 rounded bg-amber-500 text-zinc-950 font-black">
                            الأكثر طلباً
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-zinc-500 font-mono mt-0.5">{pkg.planId}</p>
                    </div>
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold border ${
                        pkg.isActive !== false
                          ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/25'
                          : 'bg-zinc-800 text-zinc-400 border-zinc-700'
                      }`}
                    >
                      {pkg.isActive !== false ? 'مفعّلة' : 'موقوفة'}
                    </span>
                  </div>

                  <div className="my-4 p-3 rounded-xl bg-zinc-950/80 border border-zinc-800/80 flex items-baseline justify-between">
                    <div>
                      <span className="text-2xl font-black text-amber-400 tabular-nums">
                        {pkg.price.toLocaleString('ar-EG')}
                      </span>
                      <span className="text-xs text-zinc-400 mr-1">ج.م</span>
                    </div>
                    <span className="text-xs text-zinc-400 flex items-center gap-1">
                      <Calendar className="w-3.5 h-3.5 text-zinc-500" />
                      {pkg.durationDays || 30} يوم
                    </span>
                  </div>

                  <div className="flex items-center gap-2 text-xs text-zinc-200 font-bold mb-3 px-1">
                    <Users className="w-4 h-4 text-sky-400 shrink-0" />
                    <span>الحد الأقصى: {pkg.maxCaptains} كابتن متزامن</span>
                  </div>

                  {pkg.features && pkg.features.length > 0 && (
                    <ul className="space-y-1.5 mb-4 border-t border-zinc-800/70 pt-3">
                      {pkg.features.map((feat, fIdx) => (
                        <li key={fIdx} className="text-xs text-zinc-400 flex items-start gap-2">
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
                          <span>{feat}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                {isMasterAdmin && (
                  <div className="pt-3 border-t border-zinc-800/80 flex items-center justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => openEditPackageModal(pkg, idx)}
                      disabled={saving}
                      className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-zinc-900 border border-zinc-700 hover:bg-zinc-800 text-zinc-200 text-xs font-bold transition-colors disabled:opacity-50"
                    >
                      <Edit3 className="w-3.5 h-3.5 text-amber-400" />
                      <span>تعديل</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleTogglePlanActive(idx)}
                      disabled={saving}
                      className={`px-2.5 py-2 rounded-xl text-xs font-bold border transition-colors cursor-pointer ${
                        pkg.isActive !== false
                          ? 'text-amber-300 bg-amber-500/10 border-amber-500/20 hover:bg-amber-500/20'
                          : 'text-emerald-300 bg-emerald-500/10 border-emerald-500/20 hover:bg-emerald-500/20'
                      }`}
                      title={pkg.isActive !== false ? 'إيقاف الباقة' : 'تفعيل الباقة'}
                    >
                      {pkg.isActive !== false ? (
                        <XCircle className="w-4 h-4" />
                      ) : (
                        <CheckCircle2 className="w-4 h-4" />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setDeleteError(null);
                        setDeleteTargetIndex(idx);
                      }}
                      disabled={saving}
                      className="p-2 rounded-xl text-rose-400 bg-rose-500/10 border border-rose-500/20 hover:bg-rose-500/20 transition-colors cursor-pointer"
                      title="حذف الباقة (محمي إذا كانت مرتبطة بسجلات)"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Vodafone Cash Settings Section */}
      <div className="bg-[#11141c] border border-zinc-800/90 rounded-3xl p-6 shadow-xl space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h3 className="text-base font-black text-white">
              إعدادات فودافون كاش وتعليمات التحويل لتطبيق التاجر
            </h3>
            <p className="text-xs text-zinc-400 mt-0.5">
              البيانات المحفوظة هنا تُقرأ مباشرة من Firestore في شاشة الاشتراك بتطبيق التاجر
            </p>
          </div>
          <span
            className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-bold border self-start sm:self-auto ${
              isConfiguredInFirestore
                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                : 'bg-amber-500/10 text-amber-400 border-amber-500/30'
            }`}
          >
            {isConfiguredInFirestore ? 'مضبوط على السيرفر' : 'بانتظار الإعداد'}
          </span>
        </div>

        <form onSubmit={handleSaveVodafoneSettings} className="space-y-5">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-bold text-zinc-300 mb-1.5 flex items-center gap-1.5">
                <Smartphone className="w-4 h-4 text-rose-400" />
                رقم محفظة فودافون كاش *
              </label>
              <input
                type="text"
                dir="ltr"
                value={vodafoneCashNumber}
                onChange={(e) => setVodafoneCashNumber(e.target.value)}
                disabled={!isMasterAdmin || saving}
                placeholder="010XXXXXXXX"
                className="w-full px-3.5 py-2.5 bg-[#0a0c12] border border-zinc-800 rounded-xl text-sm font-mono text-zinc-100 focus:outline-none focus:border-amber-500 disabled:opacity-60"
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-zinc-300 mb-1.5">
                اسم صاحب المحفظة
              </label>
              <input
                type="text"
                value={walletHolderName}
                onChange={(e) => setWalletHolderName(e.target.value)}
                disabled={!isMasterAdmin || saving}
                placeholder="مثال: البطل إكسبريس لخدمات التوصيل"
                className="w-full px-3.5 py-2.5 bg-[#0a0c12] border border-zinc-800 rounded-xl text-sm text-zinc-100 focus:outline-none focus:border-amber-500 disabled:opacity-60"
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-zinc-300 mb-1.5">
                المدة الافتراضية للاشتراك (أيام)
              </label>
              <input
                type="number"
                min={1}
                max={365}
                value={defaultDurationDays}
                onChange={(e) => setDefaultDurationDays(Number(e.target.value) || 30)}
                disabled={!isMasterAdmin || saving}
                className="w-full px-3.5 py-2.5 bg-[#0a0c12] border border-zinc-800 rounded-xl text-sm font-mono text-zinc-100 focus:outline-none focus:border-amber-500 disabled:opacity-60"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-zinc-300 mb-1.5 flex items-center gap-1.5">
              <FileText className="w-4 h-4 text-amber-400" />
              تعليمات التحويل للتاجر (تظهر داخل تطبيق التاجر)
            </label>
            <textarea
              rows={3}
              value={vodafoneCashInstructions}
              onChange={(e) => setVodafoneCashInstructions(e.target.value)}
              disabled={!isMasterAdmin || saving}
              placeholder="مثال: قم بتحويل قيمة الباقة على رقم فودافون كاش الموضح أعلاه، ثم ارفع صورة واضحة لإيصال التحويل وأدخل رقم المحفظة المحوّل منها ورقم العملية المرجعي."
              className="w-full px-3.5 py-2.5 bg-[#0a0c12] border border-zinc-800 rounded-xl text-sm text-zinc-100 focus:outline-none focus:border-amber-500 disabled:opacity-60 resize-y"
            />
          </div>

          <div className="p-4 rounded-xl bg-[#0a0c12] border border-zinc-800/80 space-y-3">
            <label className="flex items-center justify-between gap-3 cursor-pointer">
              <div>
                <p className="text-sm font-bold text-zinc-100">
                  تفعيل استقبال طلبات اشتراك فودافون كاش من تطبيق التاجر
                </p>
                <p className="text-xs text-zinc-400">
                  عند الإيقاف سيظهر للتاجر رسالة التوقف المؤقت ولن يتم قبول طلبات جديدة
                </p>
              </div>
              <input
                type="checkbox"
                checked={isAcceptingSubscriptions}
                onChange={(e) => setIsAcceptingSubscriptions(e.target.checked)}
                disabled={!isMasterAdmin || saving}
                className="w-5 h-5 accent-amber-500 rounded cursor-pointer"
              />
            </label>

            {!isAcceptingSubscriptions && (
              <div>
                <label className="block text-xs font-bold text-zinc-300 mb-1.5">
                  رسالة التوقف المؤقت للتاجر
                </label>
                <input
                  type="text"
                  value={pauseMessage}
                  onChange={(e) => setPauseMessage(e.target.value)}
                  disabled={!isMasterAdmin || saving}
                  placeholder="مثال: استقبال طلبات الاشتراك متوقف مؤقتاً للصيانة، يرجى المحاولة لاحقاً."
                  className="w-full px-3.5 py-2.5 bg-[#11141c] border border-zinc-800 rounded-xl text-sm text-zinc-100 focus:outline-none focus:border-amber-500"
                />
              </div>
            )}
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-2 border-t border-zinc-800/80">
            <div className="text-xs text-zinc-500">
              {lastUpdatedLabel ? `آخر تحديث: ${lastUpdatedLabel}` : 'لم يتم الحفظ بعد'}
            </div>
            {isMasterAdmin && (
              <button
                type="submit"
                disabled={saving}
                className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-zinc-950 font-black text-xs sm:text-sm transition-colors shadow-lg shadow-amber-500/15 disabled:opacity-50"
              >
                <Save className="w-4 h-4" />
                <span>{saving ? 'جاري الحفظ...' : 'حفظ إعدادات فودافون كاش والباقات'}</span>
              </button>
            )}
          </div>
        </form>
      </div>

      {/* Add / Edit Package Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-xs">
          <div className="w-full max-w-lg bg-[#11141c] border border-zinc-800 rounded-3xl p-6 shadow-2xl relative max-h-[92vh] overflow-y-auto">
            <button
              type="button"
              onClick={() => !saving && setIsModalOpen(false)}
              className="absolute top-5 left-5 text-zinc-400 hover:text-white p-1 rounded-lg"
            >
              <X className="w-5 h-5" />
            </button>

            <h3 className="text-lg font-black text-white mb-5">
              {formState.isNew ? 'إضافة باقة اشتراك جديدة' : 'تعديل بيانات الباقة'}
            </h3>

            <form onSubmit={handleSavePackageModal} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-bold text-zinc-300 mb-1.5">اسم الباقة *</label>
                  <input
                    type="text"
                    required
                    value={formState.planName}
                    onChange={(e) => setFormState({ ...formState, planName: e.target.value })}
                    placeholder="مثال: باقة 4 كباتن"
                    className="w-full px-3.5 py-2.5 bg-[#0a0c12] border border-zinc-800 rounded-xl text-sm text-zinc-100 focus:outline-none focus:border-amber-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-zinc-300 mb-1.5">
                    عدد الكباتن المسموح بهم *
                  </label>
                  <input
                    type="number"
                    required
                    min={1}
                    max={100}
                    value={formState.maxCaptains}
                    onChange={(e) =>
                      setFormState({ ...formState, maxCaptains: Number(e.target.value) || 1 })
                    }
                    className="w-full px-3.5 py-2.5 bg-[#0a0c12] border border-zinc-800 rounded-xl text-sm font-mono text-zinc-100 focus:outline-none focus:border-amber-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-zinc-300 mb-1.5">
                    سعر الباقة (ج.م) *
                  </label>
                  <input
                    type="number"
                    required
                    min={1}
                    step="0.01"
                    value={formState.price}
                    onChange={(e) =>
                      setFormState({ ...formState, price: Number(e.target.value) || 0 })
                    }
                    className="w-full px-3.5 py-2.5 bg-[#0a0c12] border border-zinc-800 rounded-xl text-sm font-mono text-amber-400 font-bold focus:outline-none focus:border-amber-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-zinc-300 mb-1.5">
                    مدة الاشتراك (بالأيام) *
                  </label>
                  <input
                    type="number"
                    required
                    min={1}
                    max={365}
                    value={formState.durationDays}
                    onChange={(e) =>
                      setFormState({ ...formState, durationDays: Number(e.target.value) || 30 })
                    }
                    className="w-full px-3.5 py-2.5 bg-[#0a0c12] border border-zinc-800 rounded-xl text-sm font-mono text-zinc-100 focus:outline-none focus:border-amber-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-zinc-300 mb-1.5">
                  مميزات الباقة (سطر لكل ميزة)
                </label>
                <textarea
                  rows={4}
                  value={formState.featuresText}
                  onChange={(e) => setFormState({ ...formState, featuresText: e.target.value })}
                  placeholder={'ميزة 1\nميزة 2\nميزة 3'}
                  className="w-full px-3.5 py-2.5 bg-[#0a0c12] border border-zinc-800 rounded-xl text-sm text-zinc-100 focus:outline-none focus:border-amber-500 resize-y"
                />
              </div>

              <div className="flex flex-wrap items-center gap-6 pt-1">
                <label className="flex items-center gap-2 text-xs font-bold text-zinc-200 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formState.isActive}
                    onChange={(e) => setFormState({ ...formState, isActive: e.target.checked })}
                    className="w-4 h-4 accent-amber-500"
                  />
                  <span>الباقة مفعّلة ومتاحة للاشتراك</span>
                </label>

                <label className="flex items-center gap-2 text-xs font-bold text-zinc-200 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formState.isPopular}
                    onChange={(e) => setFormState({ ...formState, isPopular: e.target.checked })}
                    className="w-4 h-4 accent-amber-500"
                  />
                  <span>تمييز كـ &quot;الأكثر طلباً&quot;</span>
                </label>
              </div>

              <div className="flex justify-end gap-3 pt-4 border-t border-zinc-800">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  disabled={saving}
                  className="px-4 py-2 text-xs font-bold text-zinc-400 hover:text-white"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-zinc-950 font-black text-xs transition-colors disabled:opacity-50"
                >
                  <Save className="w-4 h-4" />
                  <span>{saving ? 'جاري الحفظ...' : formState.isNew ? 'إضافة وحفظ الباقة' : 'حفظ التعديلات'}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Safe Delete Confirmation Modal */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-xs">
          <div className="w-full max-w-md bg-[#11141c] border border-zinc-800 rounded-3xl p-6 shadow-2xl relative">
            <button
              type="button"
              onClick={() => !saving && setDeleteTargetIndex(null)}
              className="absolute top-5 left-5 text-zinc-400 hover:text-white p-1 rounded-lg"
            >
              <X className="w-5 h-5" />
            </button>

            <h3 className="text-lg font-black text-white mb-4">تأكيد حذف الباقة</h3>

            <div className="space-y-4">
              <p className="text-sm text-zinc-200 leading-relaxed">
                هل أنت متأكد من حذف الباقة{' '}
                <strong className="text-amber-400">&quot;{deleteTarget.planName}&quot;</strong>؟
              </p>
              <p className="text-xs text-zinc-400">
                سيتحقق الخادم تلقائياً من عدم ارتباط الباقة بأي اشتراكات أو مدفوعات أو طلبات سابقة قبل السماح بالحذف.
              </p>

              {deleteError && (
                <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-xs text-rose-200 space-y-2">
                  <p className="font-bold flex items-center gap-1.5">
                    <X className="w-4 h-4 shrink-0 text-rose-400" />
                    تعذر الحذف الفعلي للباقة
                  </p>
                  <p>{deleteError}</p>
                </div>
              )}

              <div className="flex flex-wrap justify-end gap-2 pt-3 border-t border-zinc-800">
                <button
                  type="button"
                  onClick={() => setDeleteTargetIndex(null)}
                  disabled={saving}
                  className="px-4 py-2 text-xs font-bold text-zinc-400 hover:text-white"
                >
                  إلغاء
                </button>
                {deleteError ? (
                  <button
                    type="button"
                    onClick={handleDisableInsteadOfDelete}
                    disabled={saving}
                    className="px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-zinc-950 font-black text-xs transition-colors disabled:opacity-50"
                  >
                    إيقاف الباقة بدلاً من الحذف
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleConfirmDelete}
                    disabled={saving}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-black text-xs transition-colors disabled:opacity-50"
                  >
                    <Trash2 className="w-4 h-4" />
                    <span>{saving ? 'جاري التحقق...' : 'حذف نهائي'}</span>
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
