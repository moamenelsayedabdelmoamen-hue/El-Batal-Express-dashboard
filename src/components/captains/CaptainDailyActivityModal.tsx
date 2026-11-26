import React, { useEffect, useMemo, useState } from 'react';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  Timestamp,
  where,
} from 'firebase/firestore';
import { ArrowDownCircle, ArrowUpCircle, CalendarDays, ChevronLeft, ChevronRight, Clock3, History, Wallet, X } from 'lucide-react';
import { db, isFirebaseConfigured } from '../../firebase/config';
import { Captain } from '../../types';

type ActivityTab = 'wallet' | 'orders';
type ActivityOrder = {
  id: string;
  orderNumber: string;
  customerName: string;
  restaurantName: string;
  status: string;
  amount: number;
  createdAt: any;
};

type WalletTransaction = {
  id: string;
  type: string;
  amount: number;
  currency: string;
  orderNumber?: string;
  createdAt: any;
};

interface Props {
  captain: Captain;
  initialTab: ActivityTab;
  onClose: () => void;
}

function cairoDateKey(date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function cairoWallClockToUtc(dayKey: string, hour: number): Date {
  const [year, month, day] = dayKey.split('-').map(Number);
  const targetWallClock = Date.UTC(year, month - 1, day, hour, 0, 0);
  let guess = targetWallClock - 2 * 60 * 60 * 1000;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  for (let i = 0; i < 3; i += 1) {
    const parts = formatter.formatToParts(new Date(guess));
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const represented = Date.UTC(
      Number(values.year),
      Number(values.month) - 1,
      Number(values.day),
      Number(values.hour),
      Number(values.minute),
      Number(values.second)
    );
    guess += targetWallClock - represented;
  }
  return new Date(guess);
}

function toDate(value: any): Date | null {
  if (!value) return null;
  if (typeof value?.toDate === 'function') return value.toDate();
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDateTime(value: any): string {
  const date = toDate(value);
  return date
    ? date.toLocaleString('ar-EG', { timeZone: 'Africa/Cairo', hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })
    : '—';
}

function formatMoney(value: unknown): string {
  const amount = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return `${amount.toLocaleString('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ج.م`;
}

function displayStatus(status: string): string {
  const labels: Record<string, string> = {
    pending: 'قيد الانتظار',
    accepted: 'تم القبول',
    assigned: 'تم الإسناد',
    preparing: 'قيد التجهيز',
    ready: 'جاهز للاستلام',
    picked_up: 'تم الاستلام',
    out_for_delivery: 'في الطريق',
    delivering: 'جاري التوصيل',
    delivered: 'تم التسليم',
    completed: 'مكتمل',
    cancelled: 'ملغي',
    canceled: 'ملغي',
  };
  return labels[status.toLowerCase().replace(/\s+/g, '_')] || status || '—';
}

export const CaptainDailyActivityModal: React.FC<Props> = ({ captain, initialTab, onClose }) => {
  const [tab, setTab] = useState<ActivityTab>(initialTab);
  const [selectedDate, setSelectedDate] = useState(() => cairoDateKey());
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [dailyWallet, setDailyWallet] = useState<Record<string, any> | null>(null);
  const [transactions, setTransactions] = useState<WalletTransaction[]>([]);
  const [orders, setOrders] = useState<ActivityOrder[]>([]);

  useEffect(() => setTab(initialTab), [initialTab]);

  useEffect(() => {
    let active = true;
    const load = async () => {
      if (!isFirebaseConfigured) {
        setLoadError('اتصال Firebase غير متاح حالياً.');
        return;
      }
      setLoading(true);
      setLoadError('');
      try {
        const dayWalletRef = doc(db, 'captains', captain.id, 'daily_wallets', selectedDate);
        const txQuery = query(
          collection(db, 'captains', captain.id, 'transactions'),
          where('dayKey', '==', selectedDate)
        );
        const [walletSnap, txSnap] = await Promise.all([getDoc(dayWalletRef), getDocs(txQuery)]);
        if (!active) return;
        setDailyWallet(walletSnap.exists() ? walletSnap.data() : null);
        const txRows = txSnap.docs.map((item) => ({ id: item.id, ...item.data() } as WalletTransaction));
        txRows.sort((a, b) => (toDate(b.createdAt)?.getTime() || 0) - (toDate(a.createdAt)?.getTime() || 0));
        setTransactions(txRows);

        if (tab === 'orders') {
          const start = Timestamp.fromDate(cairoWallClockToUtc(selectedDate, 0));
          const end = Timestamp.fromDate(cairoWallClockToUtc(selectedDate, 24));
          const runOrderQuery = async (field: string) => getDocs(query(
            collection(db, 'orders'),
            where(field, '==', captain.id),
            where('createdAt', '>=', start),
            where('createdAt', '<', end),
            orderBy('createdAt', 'asc'),
            limit(200)
          ));
          let orderSnap = await runOrderQuery('captainId');
          if (orderSnap.empty) {
            for (const legacyField of ['driverId', 'captainUid', 'assignedCaptainId']) {
              orderSnap = await runOrderQuery(legacyField);
              if (!orderSnap.empty) break;
            }
          }
          if (!active) return;
          const unique = new Map<string, ActivityOrder>();
          orderSnap.docs.forEach((item) => {
            const data = item.data();
            unique.set(item.id, {
              id: item.id,
              orderNumber: String(data.orderNumber || data.orderCode || item.id),
              customerName: String(data.customerName || data.customer?.name || 'عميل'),
              restaurantName: String(data.restaurantName || data.merchantName || data.storeName || 'تاجر'),
              status: String(data.status || data.orderStatus || '—'),
              amount: Number(data.total ?? data.deliveryFee ?? 0) || 0,
              createdAt: data.createdAt,
            });
          });
          setOrders(Array.from(unique.values()).sort((a, b) =>
            (toDate(b.createdAt)?.getTime() || 0) - (toDate(a.createdAt)?.getTime() || 0)
          ));
        } else {
          setOrders([]);
        }
      } catch (error) {
        console.error('Failed to load captain daily activity:', error);
        if (active) setLoadError('تعذر تحميل السجل. تحقق من صلاحيات Firestore والفهارس المطلوبة.');
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return () => { active = false; };
  }, [captain.id, selectedDate, tab]);

  const walletEarnings = useMemo(
    () => Number(dailyWallet?.totalEarnings ?? 0) || 0,
    [dailyWallet]
  );
  const dailyOrders = Number(dailyWallet?.deliveredOrdersCount ?? dailyWallet?.totalOrdersCount ?? 0) || 0;
  const previousDay = () => {
    const date = new Date(`${selectedDate}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() - 1);
    setSelectedDate(date.toISOString().slice(0, 10));
  };
  const nextDay = () => {
    const date = new Date(`${selectedDate}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + 1);
    const next = date.toISOString().slice(0, 10);
    if (next <= cairoDateKey()) setSelectedDate(next);
  };

  return (
    <div className="fixed inset-0 z-[90] bg-black/75 backdrop-blur-sm flex items-center justify-center p-3 sm:p-6" dir="rtl">
      <div className="w-full max-w-4xl max-h-[92vh] overflow-hidden rounded-3xl bg-[#11141c] border border-zinc-700 shadow-2xl flex flex-col">
        <div className="p-5 border-b border-zinc-800 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-black text-white">سجل الكابتن: {captain.name}</h3>
            <p className="text-xs text-zinc-400 mt-1">الرصيد المالي والطلبات حسب اليوم بتوقيت القاهرة</p>
          </div>
          <button type="button" onClick={onClose} className="p-2 rounded-xl text-zinc-400 hover:text-white hover:bg-zinc-800" aria-label="إغلاق">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 sm:p-5 space-y-4 overflow-y-auto">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex rounded-xl bg-zinc-900 border border-zinc-800 p-1">
              <button type="button" onClick={() => setTab('wallet')} className={`px-4 py-2 rounded-lg text-xs font-bold flex items-center gap-2 ${tab === 'wallet' ? 'bg-amber-500 text-zinc-950' : 'text-zinc-400 hover:text-white'}`}>
                <Wallet className="w-4 h-4" /> سجل المحفظة
              </button>
              <button type="button" onClick={() => setTab('orders')} className={`px-4 py-2 rounded-lg text-xs font-bold flex items-center gap-2 ${tab === 'orders' ? 'bg-amber-500 text-zinc-950' : 'text-zinc-400 hover:text-white'}`}>
                <History className="w-4 h-4" /> سجل الطلبات
              </button>
            </div>
            <div className="flex items-center gap-2">
              <button type="button" onClick={previousDay} className="p-2 rounded-lg border border-zinc-700 text-zinc-300 hover:bg-zinc-800" title="اليوم السابق">
                <ChevronRight className="w-4 h-4" />
              </button>
              <label className="relative flex items-center gap-2 px-3 py-2 rounded-xl bg-zinc-900 border border-zinc-700 text-xs text-zinc-200">
                <CalendarDays className="w-4 h-4 text-amber-400" />
                <input type="date" value={selectedDate} max={cairoDateKey()} onChange={(event) => setSelectedDate(event.target.value)} className="bg-transparent text-zinc-100 outline-none [color-scheme:dark]" />
              </label>
              <button type="button" onClick={nextDay} disabled={selectedDate >= cairoDateKey()} className="p-2 rounded-lg border border-zinc-700 text-zinc-300 hover:bg-zinc-800 disabled:opacity-30" title="اليوم التالي">
                <ChevronLeft className="w-4 h-4" />
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="p-4 rounded-2xl bg-zinc-900/80 border border-zinc-800">
              <span className="text-xs text-zinc-400 block mb-1">الرصيد الحالي الحقيقي</span>
              <strong className="text-xl text-emerald-400">{captain.walletBalance !== undefined ? formatMoney(captain.walletBalance) : 'غير متاح'}</strong>
              <span className="text-[10px] text-zinc-500 block mt-1">من سجل captains/{captain.id}</span>
            </div>
            <div className="p-4 rounded-2xl bg-zinc-900/80 border border-zinc-800">
              <span className="text-xs text-zinc-400 block mb-1">أرباح اليوم المحدد</span>
              <strong className="text-xl text-white">{formatMoney(walletEarnings)}</strong>
              <span className="text-[10px] text-zinc-500 block mt-1">من daily_wallets/{selectedDate}</span>
            </div>
            <div className="p-4 rounded-2xl bg-zinc-900/80 border border-zinc-800">
              <span className="text-xs text-zinc-400 block mb-1">رصيد إغلاق اليوم</span>
              <strong className="text-xl text-amber-300">
                {dailyWallet?.balanceAtClose !== undefined ? formatMoney(Number(dailyWallet.balanceAtClose)) : 'غير مسجل'}
              </strong>
              <span className="text-[10px] text-zinc-500 block mt-1">
                {dailyWallet?.balanceAtClose !== undefined ? 'لقطة الرصيد عند إغلاق اليوم' : 'سيظهر بعد تشغيل سجل الإغلاق اليومي'}
              </span>
            </div>
          </div>

          {loadError && <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs">{loadError}</div>}
          {loading ? (
            <div className="py-12 text-center text-sm text-zinc-400">جاري تحميل السجل...</div>
          ) : tab === 'wallet' ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between text-xs text-zinc-400">
                <span>حركات المحفظة في {selectedDate}</span>
                <span>{transactions.length} حركة • {dailyOrders} طلب تم تسليمه</span>
              </div>
              {transactions.length === 0 ? (
                <div className="py-10 text-center rounded-2xl border border-dashed border-zinc-700 text-zinc-500 text-sm">لا توجد حركات مسجلة للمحفظة في هذا اليوم.</div>
              ) : transactions.map((tx) => {
                const positive = tx.amount >= 0;
                return (
                  <div key={tx.id} className="p-3 rounded-xl bg-zinc-900/70 border border-zinc-800 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      {positive ? <ArrowUpCircle className="w-5 h-5 text-emerald-400 shrink-0" /> : <ArrowDownCircle className="w-5 h-5 text-rose-400 shrink-0" />}
                      <div className="min-w-0">
                        <p className="text-sm font-bold text-zinc-200 truncate">{tx.type || 'حركة محفظة'} {tx.orderNumber ? `• طلب ${tx.orderNumber}` : ''}</p>
                        <p className="text-[11px] text-zinc-500 flex items-center gap-1"><Clock3 className="w-3 h-3" />{formatDateTime(tx.createdAt)}</p>
                      </div>
                    </div>
                    <strong className={`text-sm whitespace-nowrap ${positive ? 'text-emerald-400' : 'text-rose-400'}`}>{positive ? '+' : ''}{formatMoney(tx.amount)}</strong>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="text-xs text-zinc-400">طلبات الكابتن في {selectedDate} ({orders.length})</div>
              {orders.length === 0 ? (
                <div className="py-10 text-center rounded-2xl border border-dashed border-zinc-700 text-zinc-500 text-sm">لا توجد طلبات مسجلة لهذا الكابتن في هذا اليوم.</div>
              ) : orders.map((order) => (
                <div key={order.id} className="p-4 rounded-xl bg-zinc-900/70 border border-zinc-800 grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-2">
                  <div>
                    <p className="text-sm font-black text-white">طلب #{order.orderNumber}</p>
                    <p className="text-xs text-zinc-400 mt-1">{order.restaurantName} • {order.customerName}</p>
                    <p className="text-[11px] text-zinc-500 mt-1">{formatDateTime(order.createdAt)}</p>
                  </div>
                  <div className="sm:text-left">
                    <span className="text-xs font-bold text-amber-300">{displayStatus(order.status)}</span>
                    <p className="text-sm font-bold text-zinc-200 mt-1">{formatMoney(order.amount)}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
