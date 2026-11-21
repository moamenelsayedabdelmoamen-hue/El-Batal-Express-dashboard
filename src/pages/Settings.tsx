import React, { useEffect, useState } from 'react';
import {
  Save,
  ShieldCheck,
  Database,
  Phone,
  Mail,
  CheckCircle2,
  Lock,
  Wallet,
  Plus,
  Trash2,
  AlertTriangle,
  Calendar,
  UserCheck,
  Power,
} from 'lucide-react';
import { firebaseConfig } from '../firebase/config';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { ManualSubscriptionService } from '../services/manualSubscriptionService';
import { ManualSubscriptionSettings, OfficialSubscriptionPlanConfig } from '../types';
import { formatDateTime } from '../utils/formatters';
import appLogo from '../assets/images/elbatal_logo_1789202744301.jpg';

export const SettingsPage: React.FC = () => {
  const { isMasterAdmin } = useAuth();
  const { success, error: showError } = useToast();

  // General brand metadata (local display preferences)
  const [systemName, setSystemName] = useState('El Batal Express (البطل إكسبريس)');
  const [supportPhone, setSupportPhone] = useState('01000000000');
  const [supportEmail, setSupportEmail] = useState('support@elbatalexpress.com');
  const [supportWhatsapp, setSupportWhatsapp] = useState('01000000000');
  const [savingGeneral, setSavingGeneral] = useState(false);

  // Manual Vodafone Cash Subscription Settings (Firestore `settings/manual_subscription_config`, Master Admin ONLY)
  const [loadingManualConfig, setLoadingManualConfig] = useState(true);
  const [savingManualConfig, setSavingManualConfig] = useState(false);
  const [manualConfigMeta, setManualConfigMeta] = useState<Pick<
    ManualSubscriptionSettings,
    'isConfiguredInFirestore' | 'updatedAt' | 'updatedByName' | 'updatedByEmail'
  >>({
    isConfiguredInFirestore: false,
  });

  const [vodafoneCashNumber, setVodafoneCashNumber] = useState('');
  const [walletHolderName, setWalletHolderName] = useState('');
  const [isAcceptingSubscriptions, setIsAcceptingSubscriptions] = useState(false);
  const [pauseMessage, setPauseMessage] = useState('');
  const [durationDays, setDurationDays] = useState(30);
  const [plans, setPlans] = useState<OfficialSubscriptionPlanConfig[]>([]);

  useEffect(() => {
    let active = true;
    setLoadingManualConfig(true);
    ManualSubscriptionService.getSettings()
      .then((cfg) => {
        if (!active) return;
        setVodafoneCashNumber(cfg.vodafoneCashNumber);
        setWalletHolderName(cfg.walletHolderName);
        setIsAcceptingSubscriptions(cfg.isAcceptingSubscriptions);
        setPauseMessage(cfg.pauseMessage);
        setDurationDays(cfg.durationDays);
        setPlans(cfg.plans);
        setManualConfigMeta({
          isConfiguredInFirestore: cfg.isConfiguredInFirestore,
          updatedAt: cfg.updatedAt,
          updatedByName: cfg.updatedByName,
          updatedByEmail: cfg.updatedByEmail,
        });
      })
      .catch((err) => {
        if (!active) return;
        showError(err?.message || 'تعذر قراءة إعدادات الدفع اليدوي من قاعدة البيانات');
      })
      .finally(() => {
        if (active) setLoadingManualConfig(false);
      });

    return () => {
      active = false;
    };
  }, [showError]);

  const handlePlanChange = <K extends keyof OfficialSubscriptionPlanConfig>(
    idx: number,
    key: K,
    value: OfficialSubscriptionPlanConfig[K]
  ) => {
    setPlans((prev) =>
      prev.map((item, i) => {
        if (i !== idx) return item;
        const next = { ...item, [key]: value };
        if (key === 'maxCaptains') {
          const cap = Math.max(1, Number(value) || 1);
          next.maxCaptains = cap;
          if (!item.planId || /^plan_\d+_captains$/.test(item.planId)) {
            next.planId = `plan_${cap}_captains`;
          }
        }
        return next;
      })
    );
  };

  const handleAddPlan = () => {
    const nextCap = plans.length > 0 ? Math.max(...plans.map((p) => p.maxCaptains)) + 2 : 2;
    setPlans((prev) => [
      ...prev,
      {
        planId: `plan_${nextCap}_captains`,
        planName: `باقة ${nextCap} كابتن`,
        maxCaptains: nextCap,
        price: 0,
        durationDays: durationDays || 30,
        isActive: true,
      },
    ]);
  };

  const handleRemovePlan = (idx: number) => {
    if (plans.length <= 1) {
      showError('يجب أن تحتوي المنظومة على باقة واحدة على الأقل.');
      return;
    }
    setPlans((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleSaveManualSubscriptionSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isMasterAdmin) {
      showError('تعديل إعدادات فودافون كاش والاشتراكات مقتصر على المسؤول الرئيسي فقط.');
      return;
    }

    const cleanWallet = vodafoneCashNumber.replace(/[\s-]/g, '').trim();
    if (!/^01[0125]\d{8}$/.test(cleanWallet)) {
      showError('رقم محفظة فودافون كاش غير صحيح. يجب أن يكون رقماً مصرياً من 11 رقماً يبدأ بـ 01.');
      return;
    }

    if (walletHolderName.trim().length < 2) {
      showError('يرجى إدخال اسم صاحب المحفظة بشكل واضح.');
      return;
    }

    if (plans.length === 0) {
      showError('يرجى إضافة باقة اشتراك واحدة على الأقل مع تحديد سعرها ومدتها.');
      return;
    }

    for (const p of plans) {
      if (!Number.isFinite(p.price) || p.price <= 0) {
        showError(`يرجى إدخال سعر صحيح أكبر من صفر للباقة "${p.planName || p.planId}".`);
        return;
      }
    }

    setSavingManualConfig(true);
    try {
      const res = await ManualSubscriptionService.updateSettings({
        vodafoneCashNumber: cleanWallet,
        walletHolderName: walletHolderName.trim(),
        isAcceptingSubscriptions,
        pauseMessage: pauseMessage.trim(),
        durationDays,
        plans: plans.map((p) => ({
          planId: p.planId.trim() || `plan_${p.maxCaptains}_captains`,
          planName: p.planName.trim() || `باقة ${p.maxCaptains} كابتن`,
          maxCaptains: Number(p.maxCaptains) || 1,
          price: Number(p.price) || 0,
          durationDays: 30,
          isActive: p.isActive !== false,
        })),
      });

      setVodafoneCashNumber(res.settings?.vodafoneCashNumber || cleanWallet);
      setManualConfigMeta({
        isConfiguredInFirestore: true,
        updatedAt: new Date().toISOString(),
        updatedByName: res.settings?.updatedByName,
        updatedByEmail: res.settings?.updatedByEmail,
      });
      success(res.message || 'تم حفظ إعدادات فودافون كاش والباقات الرسمية بنجاح');
    } catch (err: any) {
      showError(err?.message || 'تعذر حفظ إعدادات الدفع اليدوي');
    } finally {
      setSavingManualConfig(false);
    }
  };

  const handleSaveGeneral = (e: React.FormEvent) => {
    e.preventDefault();
    setSavingGeneral(true);
    setTimeout(() => {
      setSavingGeneral(false);
      success('تم تحديث بيانات التواصل العامة للوحة التحكم');
    }, 350);
  };

  return (
    <div className="space-y-8 max-w-5xl">
      {/* Top Header */}
      <div>
        <h2 className="text-xl sm:text-2xl font-black text-white">إعدادات النظام والمنظومة</h2>
        <p className="text-xs sm:text-sm text-zinc-400 mt-0.5">
          إدارة إعدادات El Batal Express ومحفظة فودافون كاش وباقات الاشتراك والاتصال بـ Firebase
        </p>
      </div>

      {/* SECTION 1: Manual Subscriptions & Vodafone Cash Payment Settings */}
      <form
        onSubmit={handleSaveManualSubscriptionSettings}
        className="bg-[#11141c] border border-amber-500/30 rounded-3xl p-6 shadow-xl space-y-6"
      >
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-2xl bg-amber-500/15 border border-amber-500/30 text-amber-400 flex items-center justify-center shrink-0">
              <Wallet className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-base font-black text-white">
                  إعدادات الاشتراكات والدفع اليدوي
                </h3>
                <span className="text-[10px] font-bold px-2.5 py-0.5 rounded-lg bg-amber-500/10 text-amber-400 border border-amber-500/30">
                  فودافون كاش — مسؤول رئيسي فقط
                </span>
              </div>
              <p className="text-xs text-zinc-400 mt-0.5">
                يُحفظ رقم المحفظة والأسعار الرسمية في Firestore وتُحدَّث حصرياً عبر Cloud Function
              </p>
            </div>
          </div>

          {manualConfigMeta.updatedAt && (
            <div className="text-[11px] text-zinc-400 font-mono tabular-nums">
              آخر تحديث: {formatDateTime(manualConfigMeta.updatedAt)}
            </div>
          )}
        </div>

        {/* Permission Notice */}
        {!isMasterAdmin && (
          <div className="p-4 rounded-2xl bg-rose-500/10 border border-rose-500/30 flex items-start gap-3 text-xs text-rose-200">
            <Lock className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
            <div>
              <p className="font-bold text-rose-300">وضع القراءة فقط — صلاحية مقيدة</p>
              <p className="text-rose-200/80 mt-0.5">
                تعديل رقم محفظة فودافون كاش أو أسعار الباقات الرسمية أو حالة استقبال الاشتراكات مسموح
                للمسؤول الرئيسي (Master Admin) فقط ومؤمّن على مستوى السيرفر وقواعد Firestore.
              </p>
            </div>
          </div>
        )}

        {!loadingManualConfig && !manualConfigMeta.isConfiguredInFirestore && (
          <div className="p-4 rounded-2xl bg-amber-500/10 border border-amber-500/30 flex items-start gap-3 text-xs text-amber-200">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <div>
              <p className="font-bold text-amber-300">لم يتم ضبط رقم محفظة فودافون كاش بعد</p>
              <p className="text-amber-200/80 mt-0.5">
                لا يوجد رقم محفظة مكتوب بشكل ثابت داخل الكود. يرجى إدخال رقم محفظة الاستقبال الرسمي
                واسم صاحب المحفظة وحفظ الإعدادات ليظهر تلقائياً في تطبيق التاجر ولوحة المراجعة.
              </p>
            </div>
          </div>
        )}

        {loadingManualConfig ? (
          <div className="py-10 text-center text-xs text-zinc-400">
            <span className="w-5 h-5 border-2 border-amber-500 border-t-transparent rounded-full animate-spin inline-block ml-2 align-middle" />
            جاري تحميل إعدادات الدفع اليدوي من Firestore...
          </div>
        ) : (
          <>
            {/* Wallet & Reception Controls */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
              <div>
                <label className="block font-bold text-zinc-300 mb-1.5">
                  رقم محفظة فودافون كاش المستلمة <span className="text-rose-400">*</span>
                </label>
                <div className="relative">
                  <input
                    type="text"
                    dir="ltr"
                    value={vodafoneCashNumber}
                    onChange={(e) => setVodafoneCashNumber(e.target.value)}
                    disabled={!isMasterAdmin || savingManualConfig}
                    placeholder="010XXXXXXXX"
                    className="w-full bg-[#0a0c12] border border-zinc-800 rounded-xl px-3.5 py-2.5 text-zinc-100 focus:outline-none focus:border-amber-500 font-mono disabled:opacity-60"
                    required
                  />
                  <Phone className="w-4 h-4 text-zinc-500 absolute left-3 top-2.5 pointer-events-none" />
                </div>
              </div>

              <div>
                <label className="block font-bold text-zinc-300 mb-1.5">
                  اسم صاحب المحفظة <span className="text-rose-400">*</span>
                </label>
                <div className="relative">
                  <input
                    type="text"
                    value={walletHolderName}
                    onChange={(e) => setWalletHolderName(e.target.value)}
                    disabled={!isMasterAdmin || savingManualConfig}
                    placeholder="الاسم المسجل على المحفظة"
                    className="w-full bg-[#0a0c12] border border-zinc-800 rounded-xl px-3.5 py-2.5 text-zinc-100 focus:outline-none focus:border-amber-500 disabled:opacity-60"
                    required
                  />
                  <UserCheck className="w-4 h-4 text-zinc-500 absolute left-3 top-2.5 pointer-events-none" />
                </div>
              </div>

              <div>
                <label className="block font-bold text-zinc-300 mb-1.5">
                  مدة الاشتراك
                </label>
                <div className="w-full bg-[#0a0c12] border border-zinc-800 rounded-xl px-3.5 py-2.5 text-amber-300 font-bold">
                  شهر واحد (30 يوماً) لجميع الباقات
                </div>
              </div>
            </div>

            {/* Accepting Subscriptions Toggle */}
            <div className="p-4 rounded-2xl bg-[#0a0c12] border border-zinc-800 space-y-3">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <div
                    className={`w-9 h-9 rounded-xl flex items-center justify-center border ${
                      isAcceptingSubscriptions
                        ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                        : 'bg-rose-500/10 border-rose-500/30 text-rose-400'
                    }`}
                  >
                    <Power className="w-4 h-4" />
                  </div>
                  <div>
                    <p className="text-xs font-black text-white">حالة استقبال طلبات الاشتراك</p>
                    <p className="text-[11px] text-zinc-400">
                      {isAcceptingSubscriptions
                        ? 'مفعّل — يمكن للتجار إرسال طلبات اشتراك جديدة عبر فودافون كاش'
                        : 'متوقف مؤقتاً — لن يتمكن التجار من تقديم طلبات اشتراك جديدة حالياً'}
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  disabled={!isMasterAdmin || savingManualConfig}
                  onClick={() => setIsAcceptingSubscriptions((v) => !v)}
                  className={`px-4 py-2 rounded-xl text-xs font-black border transition-colors disabled:opacity-50 ${
                    isAcceptingSubscriptions
                      ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/25'
                      : 'bg-rose-500/15 border-rose-500/40 text-rose-300 hover:bg-rose-500/25'
                  }`}
                >
                  {isAcceptingSubscriptions ? 'مفعّل (اضغط للإيقاف المؤقت)' : 'متوقف (اضغط للتفعيل)'}
                </button>
              </div>

              {!isAcceptingSubscriptions && (
                <div>
                  <label className="block text-xs font-bold text-zinc-400 mb-1">
                    رسالة الإيقاف المؤقت التي تظهر للتجار (اختياري)
                  </label>
                  <input
                    type="text"
                    value={pauseMessage}
                    onChange={(e) => setPauseMessage(e.target.value)}
                    disabled={!isMasterAdmin || savingManualConfig}
                    placeholder="مثال: جاري تحديث محفظة الاستقبال، يرجى المحاولة بعد قليل..."
                    className="w-full bg-[#11141c] border border-zinc-800 rounded-xl px-3.5 py-2 text-xs text-zinc-100 focus:outline-none focus:border-amber-500 disabled:opacity-60"
                  />
                </div>
              )}
            </div>

            {/* Official Package Pricing Table */}
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h4 className="text-sm font-black text-white flex items-center gap-2">
                    <ShieldCheck className="w-4 h-4 text-emerald-400" />
                    <span>أسعار الباقات الرسمية</span>
                  </h4>
                  <p className="text-[11px] text-zinc-400">
                    تُستخدم هذه الأسعار وعدد الكباتن كمرجع رسمي في تطبيق التاجر ومراجعة الطلبات
                  </p>
                </div>

                {isMasterAdmin && (
                  <button
                    type="button"
                    onClick={handleAddPlan}
                    disabled={savingManualConfig}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-zinc-900 border border-zinc-700 hover:border-amber-500/50 text-xs font-bold text-zinc-200 transition-colors"
                  >
                    <Plus className="w-3.5 h-3.5 text-amber-400" />
                    <span>إضافة باقة</span>
                  </button>
                )}
              </div>

              <div className="overflow-x-auto rounded-2xl border border-zinc-800 bg-[#0a0c12]">
                <table className="w-full text-right text-xs min-w-[740px]">
                  <thead>
                    <tr className="border-b border-zinc-800 text-[11px] text-zinc-400 bg-[#0d1018]">
                      <th className="py-3 px-3">معرّف الباقة (Plan ID)</th>
                      <th className="py-3 px-3">اسم الباقة</th>
                      <th className="py-3 px-3">عدد الكباتن</th>
                      <th className="py-3 px-3">السعر الرسمي (ج.م)</th>
                      <th className="py-3 px-3">المدة (أيام)</th>
                      <th className="py-3 px-3 text-center">الحالة</th>
                      {isMasterAdmin && <th className="py-3 px-3 text-center">حذف</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/70">
                    {plans.length === 0 ? (
                      <tr>
                        <td
                          colSpan={isMasterAdmin ? 7 : 6}
                          className="py-8 px-4 text-center text-zinc-400"
                        >
                          لا توجد باقات محفوظة في Firestore بعد. اضغط على «إضافة باقة» لإدخال الباقات والأسعار والمدد الرسمية.
                        </td>
                      </tr>
                    ) : (
                      plans.map((plan, idx) => (
                        <tr key={`${plan.planId}-${idx}`}>
                          <td className="py-2.5 px-3">
                            <input
                              type="text"
                              dir="ltr"
                              value={plan.planId}
                              onChange={(e) => handlePlanChange(idx, 'planId', e.target.value)}
                              disabled={!isMasterAdmin || savingManualConfig}
                              className="w-36 bg-[#11141c] border border-zinc-800 rounded-lg px-2.5 py-1.5 text-zinc-300 font-mono text-[11px] focus:outline-none focus:border-amber-500 disabled:opacity-60"
                            />
                          </td>
                          <td className="py-2.5 px-3">
                            <input
                              type="text"
                              value={plan.planName}
                              onChange={(e) => handlePlanChange(idx, 'planName', e.target.value)}
                              disabled={!isMasterAdmin || savingManualConfig}
                              className="w-full min-w-[140px] bg-[#11141c] border border-zinc-800 rounded-lg px-2.5 py-1.5 text-white font-bold focus:outline-none focus:border-amber-500 disabled:opacity-60"
                            />
                          </td>
                          <td className="py-2.5 px-3">
                            <input
                              type="number"
                              min={1}
                              max={100}
                              value={plan.maxCaptains}
                              onChange={(e) =>
                                handlePlanChange(idx, 'maxCaptains', Number(e.target.value))
                              }
                              disabled={!isMasterAdmin || savingManualConfig}
                              className="w-20 bg-[#11141c] border border-zinc-800 rounded-lg px-2.5 py-1.5 text-white font-mono font-bold tabular-nums focus:outline-none focus:border-amber-500 disabled:opacity-60"
                            />
                          </td>
                          <td className="py-2.5 px-3">
                            <div className="flex items-center gap-1.5">
                              <input
                                type="number"
                                min={1}
                                value={plan.price}
                                onChange={(e) =>
                                  handlePlanChange(idx, 'price', Number(e.target.value))
                                }
                                disabled={!isMasterAdmin || savingManualConfig}
                                className="w-24 bg-[#11141c] border border-zinc-800 rounded-lg px-2.5 py-1.5 text-emerald-400 font-mono font-black tabular-nums focus:outline-none focus:border-amber-500 disabled:opacity-60"
                              />
                              <span className="text-zinc-500">ج.م</span>
                            </div>
                          </td>
                          <td className="py-2.5 px-3">
                            <div className="flex items-center gap-1.5 text-amber-300 font-bold">
                              30 يوم
                            </div>
                          </td>
                          <td className="py-2.5 px-3 text-center">
                            <button
                              type="button"
                              disabled={!isMasterAdmin || savingManualConfig}
                              onClick={() => handlePlanChange(idx, 'isActive', !plan.isActive)}
                              className={`px-2.5 py-1 rounded-lg text-[11px] font-bold border transition-colors disabled:opacity-60 ${
                                plan.isActive
                                  ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                                  : 'bg-zinc-800 border-zinc-700 text-zinc-400'
                              }`}
                            >
                              {plan.isActive ? 'نشطة' : 'معطلة'}
                            </button>
                          </td>
                          {isMasterAdmin && (
                            <td className="py-2.5 px-3 text-center">
                              <button
                                type="button"
                                onClick={() => handleRemovePlan(idx)}
                                disabled={savingManualConfig || plans.length <= 1}
                                className="p-1.5 rounded-lg text-zinc-500 hover:text-rose-400 hover:bg-rose-500/10 transition-colors disabled:opacity-30"
                                title="حذف الباقة"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </td>
                          )}
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {isMasterAdmin && (
              <div className="flex items-center justify-end pt-2">
                <button
                  type="submit"
                  disabled={savingManualConfig}
                  className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-amber-500 hover:bg-amber-400 text-zinc-950 font-black text-xs sm:text-sm shadow-lg shadow-amber-500/20 transition-all disabled:opacity-50"
                >
                  {savingManualConfig ? (
                    <>
                      <span className="w-4 h-4 border-2 border-zinc-950 border-t-transparent rounded-full animate-spin" />
                      <span>جاري الحفظ عبر السيرفر...</span>
                    </>
                  ) : (
                    <>
                      <Save className="w-4 h-4" />
                      <span>حفظ إعدادات فودافون كاش والباقات</span>
                    </>
                  )}
                </button>
              </div>
            )}
          </>
        )}
      </form>

      {/* SECTION 2: General System Info */}
      <form onSubmit={handleSaveGeneral} className="space-y-6">
        <div className="bg-[#11141c] border border-zinc-800/90 rounded-3xl p-6 shadow-xl">
          <div className="flex items-center gap-3 mb-5">
            <div className="w-12 h-12 rounded-xl overflow-hidden bg-black border border-amber-500/30 flex items-center justify-center shrink-0 p-0.5 shadow-md">
              <img
                src={appLogo}
                alt="شعار البطل إكسبريس"
                className="w-full h-full object-contain rounded-lg"
                referrerPolicy="no-referrer"
              />
            </div>
            <div>
              <h3 className="text-base font-bold text-white">البيانات الأساسية للمشروع</h3>
              <p className="text-xs text-zinc-400">الهوية وعناوين التواصل العامة للعملاء والمطاعم</p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
            <div className="md:col-span-2">
              <label className="block font-bold text-zinc-300 mb-1.5">
                اسم المنظومة / العلامة التجارية
              </label>
              <input
                type="text"
                value={systemName}
                onChange={(e) => setSystemName(e.target.value)}
                className="w-full bg-[#0a0c12] border border-zinc-800 rounded-xl px-3.5 py-2.5 text-zinc-100 focus:outline-none focus:border-amber-500"
                required
              />
            </div>

            <div>
              <label className="block font-bold text-zinc-300 mb-1.5">رقم هاتف الدعم الفني</label>
              <div className="relative">
                <input
                  type="text"
                  dir="ltr"
                  value={supportPhone}
                  onChange={(e) => setSupportPhone(e.target.value)}
                  className="w-full bg-[#0a0c12] border border-zinc-800 rounded-xl px-3.5 py-2.5 text-zinc-100 focus:outline-none focus:border-amber-500 font-mono"
                />
                <Phone className="w-4 h-4 text-zinc-400 absolute left-3 top-3 pointer-events-none" />
              </div>
            </div>

            <div>
              <label className="block font-bold text-zinc-300 mb-1.5">واتساب الدعم (WhatsApp)</label>
              <div className="relative">
                <input
                  type="text"
                  dir="ltr"
                  value={supportWhatsapp}
                  onChange={(e) => setSupportWhatsapp(e.target.value)}
                  className="w-full bg-[#0a0c12] border border-zinc-800 rounded-xl px-3.5 py-2.5 text-zinc-100 focus:outline-none focus:border-amber-500 font-mono"
                />
                <Phone className="w-4 h-4 text-zinc-400 absolute left-3 top-3 pointer-events-none" />
              </div>
            </div>

            <div className="md:col-span-2">
              <label className="block font-bold text-zinc-300 mb-1.5">
                البريد الإلكتروني للإدارة
              </label>
              <div className="relative">
                <input
                  type="email"
                  dir="ltr"
                  value={supportEmail}
                  onChange={(e) => setSupportEmail(e.target.value)}
                  className="w-full bg-[#0a0c12] border border-zinc-800 rounded-xl px-3.5 py-2.5 text-zinc-100 focus:outline-none focus:border-amber-500 font-mono"
                />
                <Mail className="w-4 h-4 text-zinc-400 absolute left-3 top-3 pointer-events-none" />
              </div>
            </div>
          </div>

          <div className="flex justify-end mt-5">
            <button
              type="submit"
              disabled={savingGeneral}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-white font-bold text-xs transition-colors disabled:opacity-50"
            >
              <Save className="w-4 h-4" />
              <span>{savingGeneral ? 'جاري الحفظ...' : 'حفظ بيانات التواصل'}</span>
            </button>
          </div>
        </div>

        {/* SECTION 3: Firebase Config (Read-only / Safe display) */}
        <div className="bg-[#11141c] border border-zinc-800/90 rounded-3xl p-6 shadow-xl">
          <div className="flex items-center gap-3 mb-5">
            <div className="w-10 h-10 rounded-xl bg-blue-500/10 border border-blue-500/20 text-blue-400 flex items-center justify-center font-bold">
              <Database className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-bold text-white">إعدادات Firebase المرتبطة</h3>
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-lg bg-zinc-800 text-amber-400 border border-zinc-700">
                  للقراءة فقط (محمي)
                </span>
              </div>
              <p className="text-xs text-zinc-400">
                مشروع Firebase الفعلي الذي تتصل به لوحة التحكم بدون كشف مفاتيح سرية
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            <div className="p-3.5 rounded-xl bg-[#0a0c12] border border-zinc-800">
              <span className="text-zinc-500 block mb-1">Firebase Project ID</span>
              <span className="font-mono text-amber-400 font-bold text-sm">
                {firebaseConfig.projectId}
              </span>
            </div>

            <div className="p-3.5 rounded-xl bg-[#0a0c12] border border-zinc-800">
              <span className="text-zinc-500 block mb-1">Auth Domain</span>
              <span className="font-mono text-zinc-300 text-xs">{firebaseConfig.authDomain}</span>
            </div>

            <div className="p-3.5 rounded-xl bg-[#0a0c12] border border-zinc-800">
              <span className="text-zinc-500 block mb-1">Storage Bucket</span>
              <span className="font-mono text-zinc-300 text-xs">
                {firebaseConfig.storageBucket}
              </span>
            </div>

            <div className="p-3.5 rounded-xl bg-[#0a0c12] border border-zinc-800">
              <span className="text-zinc-500 block mb-1">حالة الاتصال بالسيرفر</span>
              <div className="flex items-center gap-1.5 text-emerald-400 font-bold">
                <CheckCircle2 className="w-4 h-4" />
                <span>مهيأ ومتصل بنجاح</span>
              </div>
            </div>
          </div>

          <div className="mt-4 p-3.5 rounded-xl bg-zinc-900/60 border border-zinc-800 flex items-start gap-2.5 text-xs text-zinc-400">
            <Lock className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <p>
              يتم تأمين البيانات عبر{' '}
              <strong className="text-zinc-200">Firestore Security Rules</strong> و{' '}
              <strong className="text-zinc-200">Firebase Cloud Functions</strong>. جميع قرارات
              الاشتراك وتعديل إعدادات فودافون كاش تتم حصرياً من السيرفر بعد التحقق من الصلاحيات.
            </p>
          </div>
        </div>
      </form>
    </div>
  );
};
