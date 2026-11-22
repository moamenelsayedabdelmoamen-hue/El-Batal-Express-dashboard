import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  MapPin,
  Bike,
  Store,
  Navigation,
  Search,
  Eye,
  EyeOff,
  Activity,
  Compass,
  ExternalLink,
  CheckCircle2,
  Crosshair,
  X,
} from 'lucide-react';
import { LiveMapViewer } from '../components/map/LiveMapViewer';
import { NearestCaptainsModal } from '../components/map/NearestCaptainsModal';
import { EntityDetailsPanel } from '../components/map/EntityDetailsPanel';
import { LiveMapService } from '../services/liveMapService';
import { RestaurantService } from '../services/restaurantService';
import { Restaurant, Captain, Order } from '../types';
import { Coordinates } from '../utils/geoUtils';
import { resolveMapUrlToCoordinates } from '../utils/mapLinkResolver';
import { useToast } from '../contexts/ToastContext';

export const LiveMapPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const { success, error: toastError } = useToast();

  const [rawRestaurants, setRawRestaurants] = useState<Restaurant[]>([]);
  const [resolvedCoordsMap, setResolvedCoordsMap] = useState<Record<string, Coordinates>>({});
  const [captains, setCaptains] = useState<Captain[]>([]);
  const [activeOrders, setActiveOrders] = useState<Order[]>([]);

  const [, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'restaurants' | 'captains' | 'available' | 'busy' | 'trips'>('all');
  const [showOfflineCaptains, setShowOfflineCaptains] = useState(false);

  // Selected Entities
  const [selectedRestaurant, setSelectedRestaurant] = useState<Restaurant | null>(null);
  const [selectedCaptain, setSelectedCaptain] = useState<Captain | null>(null);
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [focusTrigger, setFocusTrigger] = useState(0);

  // Interactive click-to-pin mode for merchants with short map links lacking lat/lng
  const [pickingForRestaurant, setPickingForRestaurant] = useState<Restaurant | null>(null);
  const [savingPin, setSavingPin] = useState(false);

  // Modal for Nearest Captains
  const [nearestModalRestaurant, setNearestModalRestaurant] = useState<Restaurant | null>(null);

  // Track which merchant links have already been queued for async resolution
  const attemptedResolveRef = useRef<Set<string>>(new Set());

  // 1. Subscribe to real-time Firestore collections
  useEffect(() => {
    setIsLoading(true);

    const unsubCaptains = LiveMapService.subscribeCaptains(
      (data) => {
        setCaptains(data);
        setIsLoading(false);
      },
      (err) => {
        console.warn('Captains live subscription notice:', err);
        setIsLoading(false);
      }
    );

    const unsubRestaurants = LiveMapService.subscribeRestaurants(
      (data) => {
        setRawRestaurants(data);
        setIsLoading(false);
      },
      (err) => {
        console.warn('Restaurants live subscription notice:', err);
        setIsLoading(false);
      }
    );

    const unsubOrders = LiveMapService.subscribeActiveOrders(
      (data) => {
        setActiveOrders(data);
      },
      (err) => {
        console.warn('Active orders live subscription notice:', err);
      }
    );

    return () => {
      unsubCaptains();
      unsubRestaurants();
      unsubOrders();
    };
  }, []);

  // Automatically resolve merchant location links that don't yet have inline numeric coordinates
  useEffect(() => {
    let cancelled = false;
    const candidates = rawRestaurants.filter(
      (r) => !r.coords && (r.locationUrl || (r.address && r.address !== '—'))
    );

    candidates.forEach(async (rest) => {
      const attemptKey = `${rest.id}:${rest.locationUrl || ''}:${rest.address || ''}`;
      if (attemptedResolveRef.current.has(attemptKey)) return;
      attemptedResolveRef.current.add(attemptKey);

      const coords = await resolveMapUrlToCoordinates(rest.locationUrl, rest.address);
      if (!cancelled && coords) {
        setResolvedCoordsMap((prev) => ({
          ...prev,
          [rest.id]: coords,
        }));
      }
    });

    return () => {
      cancelled = true;
    };
  }, [rawRestaurants]);

  // Merge synchronously extracted coordinates and async resolved coordinates
  const restaurants = useMemo<Restaurant[]>(() => {
    return rawRestaurants.map((r) => {
      if (r.coords) return r;
      const resolved = resolvedCoordsMap[r.id];
      if (resolved) {
        return { ...r, coords: resolved };
      }
      return r;
    });
  }, [rawRestaurants, resolvedCoordsMap]);

  // Auto-select restaurant when navigated from Merchants page (/live-map?restaurantId=...)
  const restaurantQueryParam = searchParams.get('restaurantId') || searchParams.get('restaurant');
  const handledRestaurantQueryRef = useRef<string | null>(null);

  useEffect(() => {
    if (!restaurantQueryParam) {
      handledRestaurantQueryRef.current = null;
      return;
    }
    if (restaurants.length === 0) return;

    const matched = restaurants.find(
      (r) =>
        r.id === restaurantQueryParam ||
        r.name.trim().toLowerCase() === restaurantQueryParam.trim().toLowerCase()
    );

    if (matched) {
      if (handledRestaurantQueryRef.current !== restaurantQueryParam) {
        handledRestaurantQueryRef.current = restaurantQueryParam;
        setSelectedRestaurant(matched);
        setSelectedCaptain(null);
        setSelectedOrder(null);
        setFilter((prev) => (prev === 'all' || prev === 'restaurants' ? prev : 'all'));
        setFocusTrigger((n) => n + 1);
      } else if (selectedRestaurant?.id === matched.id) {
        setSelectedRestaurant(matched);
      }
    }
  }, [restaurantQueryParam, restaurants, selectedRestaurant?.id]);

  // Keep selectedRestaurant synchronized when its coordinates resolve or update in real time
  useEffect(() => {
    if (!selectedRestaurant) return;
    const latest = restaurants.find((r) => r.id === selectedRestaurant.id);
    if (latest && latest !== selectedRestaurant) {
      setSelectedRestaurant(latest);
    }
  }, [restaurants, selectedRestaurant]);

  // 2. Computed Live Statistics & Merchant Location Lists
  const stats = useMemo(() => {
    const restaurantsWithGps = restaurants.filter((r) => r.coords).length;
    const onlineCaptains = captains.filter((c) => c.isOnline || c.status === 'available' || c.status === 'busy');
    const availableCaptains = captains.filter((c) => c.status === 'available' || c.status === 'online');
    const busyCaptains = captains.filter((c) => c.status === 'busy');
    const activeTripsCount = activeOrders.length;

    return {
      restaurantsWithGps,
      totalRestaurants: restaurants.length,
      onlineCaptains: onlineCaptains.length,
      availableCaptains: availableCaptains.length,
      busyCaptains: busyCaptains.length,
      totalCaptains: captains.length,
      activeTripsCount,
    };
  }, [restaurants, captains, activeOrders]);

  const plottedMerchants = useMemo(
    () => restaurants.filter((r) => Boolean(r.coords)),
    [restaurants]
  );

  const merchantsNeedingPin = useMemo(
    () => restaurants.filter((r) => !r.coords && Boolean(r.locationUrl)),
    [restaurants]
  );

  // 3. Filtered Search Results
  const searchResults = useMemo(() => {
    if (!searchQuery.trim()) return { restaurants: [], captains: [] };
    const query = searchQuery.trim().toLowerCase();

    const matchedRestaurants = restaurants.filter(
      (r) =>
        r.name.toLowerCase().includes(query) ||
        (r.phone && r.phone.includes(query)) ||
        (r.address && r.address.toLowerCase().includes(query))
    );

    const matchedCaptains = captains.filter(
      (c) =>
        c.name.toLowerCase().includes(query) ||
        (c.phone && c.phone.includes(query)) ||
        (c.vehicleType && c.vehicleType.toLowerCase().includes(query))
    );

    return {
      restaurants: matchedRestaurants.slice(0, 5),
      captains: matchedCaptains.slice(0, 5),
    };
  }, [searchQuery, restaurants, captains]);

  // Handlers for entity selection
  const handleSelectRestaurant = (restaurant: Restaurant) => {
    setSelectedRestaurant(restaurant);
    setSelectedCaptain(null);
    setSelectedOrder(null);
    setFocusTrigger((n) => n + 1);
  };

  const handleSelectCaptain = (captain: Captain) => {
    setSelectedCaptain(captain);
    setSelectedRestaurant(null);
    setSelectedOrder(null);
    setFocusTrigger((n) => n + 1);
  };

  const handleSelectOrder = (order: Order) => {
    setSelectedOrder(order);
    setSelectedRestaurant(null);
    setSelectedCaptain(null);
  };

  const handleOpenNearestModal = (restaurant: Restaurant) => {
    setNearestModalRestaurant(restaurant);
  };

  const handleMapClickCoordinates = async (lat: number, lng: number) => {
    if (!pickingForRestaurant || savingPin) return;
    setSavingPin(true);
    const target = pickingForRestaurant;
    try {
      const coords = { lat, lng };
      await RestaurantService.update(target.id, {
        sourceCollection: target.sourceCollection,
        coords,
        locationUrl: target.locationUrl || `https://www.google.com/maps?q=${lat},${lng}`,
      });
      setResolvedCoordsMap((prev) => ({ ...prev, [target.id]: coords }));
      setPickingForRestaurant(null);
      setSelectedRestaurant({ ...target, coords });
      setFocusTrigger((n) => n + 1);
      success(`تم تحديد وحفظ موقع "${target.name}" على الخريطة بنجاح`);
    } catch {
      toastError('تعذر حفظ موقع التاجر على الخريطة');
    } finally {
      setSavingPin(false);
    }
  };

  return (
    <div className="space-y-5 animate-in fade-in duration-300">
      {/* Top Header & Real-time Indicator */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-[#0d1017] p-5 rounded-2xl border border-zinc-800/80 shadow-lg">
        <div className="flex items-center gap-3.5">
          <div className="w-12 h-12 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-400 flex items-center justify-center shadow-lg shadow-amber-500/10 shrink-0">
            <Compass className="w-6 h-6" />
          </div>
          <div>
            <div className="flex items-center gap-2.5 flex-wrap">
              <h2 className="text-xl font-extrabold text-zinc-100 tracking-wide">
                الخريطة الحية والمواقع (Live Map)
              </h2>
              <span className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
                مباشر (Firestore onSnapshot)
              </span>
            </div>
            <p className="text-xs text-zinc-400 mt-1">
              متابعة مواقع التجار والكباتن والرحلات النشطة وتحديد موقع أي تاجر مباشرة من رابط موقعه الجغرافي
            </p>
          </div>
        </div>

        {/* Action Toggles */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowOfflineCaptains(!showOfflineCaptains)}
            className={`px-3 py-2 rounded-xl text-xs font-bold border transition-all flex items-center gap-2 cursor-pointer ${
              showOfflineCaptains
                ? 'bg-zinc-800 text-zinc-100 border-zinc-700'
                : 'bg-zinc-900/60 text-zinc-400 border-zinc-800 hover:text-zinc-200'
            }`}
            title="إظهار الكباتن غير المتصلين (Offline)"
          >
            {showOfflineCaptains ? (
              <Eye className="w-4 h-4 text-amber-400" />
            ) : (
              <EyeOff className="w-4 h-4" />
            )}
            <span>كباتن Offline</span>
          </button>
        </div>
      </div>

      {/* Real-time KPI Stats Counters */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <div className="p-3.5 rounded-xl bg-[#0d1017] border border-zinc-800/80 shadow-md">
          <div className="flex items-center justify-between">
            <span className="text-xs text-zinc-400 font-bold">التجار على الخريطة</span>
            <Store className="w-4 h-4 text-amber-400" />
          </div>
          <div className="mt-2 flex items-baseline gap-1.5">
            <span className="text-xl font-extrabold text-zinc-100 font-mono">
              {stats.restaurantsWithGps}
            </span>
            <span className="text-[11px] text-zinc-500">من {stats.totalRestaurants}</span>
          </div>
        </div>

        <div className="p-3.5 rounded-xl bg-[#0d1017] border border-zinc-800/80 shadow-md">
          <div className="flex items-center justify-between">
            <span className="text-xs text-zinc-400 font-bold">الكباتن المتصلين</span>
            <Activity className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="mt-2 flex items-baseline gap-1.5">
            <span className="text-xl font-extrabold text-emerald-400 font-mono">
              {stats.onlineCaptains}
            </span>
            <span className="text-[11px] text-zinc-500">متصل الآن</span>
          </div>
        </div>

        <div className="p-3.5 rounded-xl bg-[#0d1017] border border-zinc-800/80 shadow-md">
          <div className="flex items-center justify-between">
            <span className="text-xs text-zinc-400 font-bold">كباتن متاحين</span>
            <Bike className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="mt-2 flex items-baseline gap-1.5">
            <span className="text-xl font-extrabold text-emerald-300 font-mono">
              {stats.availableCaptains}
            </span>
            <span className="text-[11px] text-zinc-500">جاهز للطلب</span>
          </div>
        </div>

        <div className="p-3.5 rounded-xl bg-[#0d1017] border border-zinc-800/80 shadow-md">
          <div className="flex items-center justify-between">
            <span className="text-xs text-zinc-400 font-bold">في رحلات نشطة</span>
            <Navigation className="w-4 h-4 text-amber-500" />
          </div>
          <div className="mt-2 flex items-baseline gap-1.5">
            <span className="text-xl font-extrabold text-amber-400 font-mono">
              {stats.busyCaptains}
            </span>
            <span className="text-[11px] text-zinc-500">مشغول حالياً</span>
          </div>
        </div>

        <div className="col-span-2 sm:col-span-1 p-3.5 rounded-xl bg-[#0d1017] border border-zinc-800/80 shadow-md">
          <div className="flex items-center justify-between">
            <span className="text-xs text-zinc-400 font-bold">الرحلات الجارية</span>
            <span className="w-2.5 h-2.5 rounded-full bg-amber-400 animate-ping"></span>
          </div>
          <div className="mt-2 flex items-baseline gap-1.5">
            <span className="text-xl font-extrabold text-amber-300 font-mono">
              {stats.activeTripsCount}
            </span>
            <span className="text-[11px] text-zinc-500">طلب قيد التنفيذ</span>
          </div>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="p-4 rounded-2xl bg-[#0d1017] border border-zinc-800/80 flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3 shadow-md">
        {/* Search input */}
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-zinc-400 absolute right-3.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="بحث سريع باسم التاجر، اسم الكابتن، أو رقم الهاتف..."
            className="w-full pl-4 pr-10 py-2.5 rounded-xl bg-zinc-900/80 border border-zinc-800 text-xs text-zinc-100 placeholder-zinc-500 focus:outline-hidden focus:border-amber-500/50"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-200 text-xs"
            >
              مسح
            </button>
          )}

          {/* Quick Search Dropdown Results */}
          {searchQuery.trim() && (searchResults.restaurants.length > 0 || searchResults.captains.length > 0) && (
            <div className="absolute top-full right-0 left-0 mt-2 z-30 bg-[#0d1017] border border-zinc-700 rounded-xl shadow-2xl p-2 space-y-1 max-h-64 overflow-y-auto">
              {searchResults.restaurants.map((rest) => (
                <button
                  key={rest.id}
                  type="button"
                  onClick={() => {
                    handleSelectRestaurant(rest);
                    setSearchQuery('');
                  }}
                  className="w-full text-right p-2 rounded-lg hover:bg-zinc-800 flex items-center justify-between text-xs text-zinc-200 cursor-pointer"
                >
                  <div className="flex items-center gap-2">
                    <Store className="w-3.5 h-3.5 text-amber-400" />
                    <span className="font-bold">{rest.name}</span>
                    <span className="text-[10px] text-zinc-400">({rest.category || 'تاجر'})</span>
                  </div>
                  <span className="text-[10px] text-amber-400">
                    {rest.coords ? 'عرض على الخريطة ←' : 'تثبيت على الخريطة ←'}
                  </span>
                </button>
              ))}

              {searchResults.captains.map((capt) => (
                <button
                  key={capt.id}
                  type="button"
                  onClick={() => {
                    handleSelectCaptain(capt);
                    setSearchQuery('');
                  }}
                  className="w-full text-right p-2 rounded-lg hover:bg-zinc-800 flex items-center justify-between text-xs text-zinc-200 cursor-pointer"
                >
                  <div className="flex items-center gap-2">
                    <Bike className="w-3.5 h-3.5 text-emerald-400" />
                    <span className="font-bold">{capt.name}</span>
                    <span className="text-[10px] text-zinc-400 font-mono">({capt.phone})</span>
                  </div>
                  <span className="text-[10px] text-emerald-400">عرض على الخريطة ←</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Filter Pills */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 md:pb-0 text-xs">
          <button
            type="button"
            onClick={() => setFilter('all')}
            className={`px-3 py-2 rounded-xl font-bold whitespace-nowrap transition-all cursor-pointer ${
              filter === 'all'
                ? 'bg-amber-500 text-zinc-950 shadow-md shadow-amber-500/20'
                : 'bg-zinc-900 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800'
            }`}
          >
            الكل
          </button>

          <button
            type="button"
            onClick={() => setFilter('restaurants')}
            className={`px-3 py-2 rounded-xl font-bold whitespace-nowrap transition-all cursor-pointer ${
              filter === 'restaurants'
                ? 'bg-amber-500 text-zinc-950 shadow-md shadow-amber-500/20'
                : 'bg-zinc-900 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800'
            }`}
          >
            التجار ({plottedMerchants.length})
          </button>

          <button
            type="button"
            onClick={() => setFilter('available')}
            className={`px-3 py-2 rounded-xl font-bold whitespace-nowrap transition-all cursor-pointer ${
              filter === 'available'
                ? 'bg-emerald-500 text-zinc-950 shadow-md shadow-emerald-500/20'
                : 'bg-zinc-900 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800'
            }`}
          >
            الكباتن المتاحين
          </button>

          <button
            type="button"
            onClick={() => setFilter('busy')}
            className={`px-3 py-2 rounded-xl font-bold whitespace-nowrap transition-all cursor-pointer ${
              filter === 'busy'
                ? 'bg-amber-600 text-white shadow-md shadow-amber-600/20'
                : 'bg-zinc-900 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800'
            }`}
          >
            الكباتن في رحلة
          </button>

          <button
            type="button"
            onClick={() => setFilter('trips')}
            className={`px-3 py-2 rounded-xl font-bold whitespace-nowrap transition-all cursor-pointer ${
              filter === 'trips'
                ? 'bg-amber-500 text-zinc-950 shadow-md shadow-amber-500/20'
                : 'bg-zinc-900 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800'
            }`}
          >
            مسارات الرحلات
          </button>
        </div>
      </div>

      {/* Plotted Merchants & Quick Pin Bar */}
      {(plottedMerchants.length > 0 || merchantsNeedingPin.length > 0) && (
        <div className="p-4 rounded-2xl bg-[#0d1017] border border-zinc-800/80 space-y-3 shadow-md">
          {plottedMerchants.length > 0 && (
            <div>
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="flex items-center gap-2 text-xs font-extrabold text-zinc-200">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  <span>التجار المحددين تلقائياً على الخريطة ({plottedMerchants.length})</span>
                </div>
                <span className="text-[11px] text-zinc-500">اضغط على اسم التاجر للانتقال مباشرة إلى موقعه</span>
              </div>
              <div className="flex flex-wrap gap-2">
                {plottedMerchants.map((merchant) => {
                  const isActive = selectedRestaurant?.id === merchant.id;
                  return (
                    <button
                      key={merchant.id}
                      type="button"
                      onClick={() => handleSelectRestaurant(merchant)}
                      className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-bold border transition-all cursor-pointer ${
                        isActive
                          ? 'bg-amber-500 text-zinc-950 border-amber-400 shadow-md shadow-amber-500/20'
                          : 'bg-zinc-900/90 hover:bg-zinc-800 text-zinc-200 border-zinc-800 hover:border-amber-500/40'
                      }`}
                    >
                      <MapPin className={`w-3.5 h-3.5 ${isActive ? 'text-zinc-950' : 'text-amber-400'}`} />
                      <span>{merchant.name}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {merchantsNeedingPin.length > 0 && (
            <div className="pt-2 border-t border-zinc-800/80">
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="flex items-center gap-2 text-xs font-extrabold text-amber-300">
                  <Crosshair className="w-4 h-4 text-amber-400" />
                  <span>تجار بروابط مختصرة تحتاج تحديد الموقع على الخريطة ({merchantsNeedingPin.length})</span>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {merchantsNeedingPin.map((merchant) => (
                  <div
                    key={merchant.id}
                    className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs bg-amber-500/10 border border-amber-500/30 text-amber-200"
                  >
                    <span className="font-bold">{merchant.name}</span>
                    {merchant.locationUrl && (
                      <a
                        href={merchant.locationUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-sky-400 hover:text-sky-300 underline"
                        title="فتح رابط الموقع الأصلي في خرائط جوجل"
                      >
                        <ExternalLink className="w-3 h-3" />
                        <span>فتح الرابط</span>
                      </a>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setPickingForRestaurant(merchant);
                        setSelectedRestaurant(merchant);
                      }}
                      className="px-2 py-0.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-zinc-950 font-extrabold text-[11px] cursor-pointer"
                    >
                      تحديد بالنقر على الخريطة
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Map Pin Picking Banner */}
      {pickingForRestaurant && (
        <div className="p-4 rounded-2xl bg-amber-500/15 border border-amber-400/50 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2.5 text-amber-200">
            <Crosshair className="w-5 h-5 text-amber-400 animate-pulse shrink-0" />
            <div>
              <p className="font-extrabold text-amber-300">
                وضع تحديد الموقع المباشر للتاجر: «{pickingForRestaurant.name}»
              </p>
              <p className="text-amber-100/80">
                انقر الآن على موقع التاجر في الخريطة بالأسفل ليتم تثبيته وحفظ الإحداثيات في قاعدة البيانات فوراً.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setPickingForRestaurant(null)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-zinc-200 font-bold border border-zinc-700 shrink-0 cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
            <span>إلغاء التحديد</span>
          </button>
        </div>
      )}

      {/* Main Interactive Map Viewer */}
      <LiveMapViewer
        restaurants={restaurants}
        captains={captains}
        activeOrders={activeOrders}
        filter={filter}
        showOfflineCaptains={showOfflineCaptains}
        selectedRestaurantId={selectedRestaurant?.id}
        selectedCaptainId={selectedCaptain?.id}
        selectedOrderId={selectedOrder?.id}
        focusTrigger={focusTrigger}
        pickingForRestaurant={pickingForRestaurant}
        onSelectRestaurant={handleSelectRestaurant}
        onSelectCaptain={handleSelectCaptain}
        onSelectOrder={handleSelectOrder}
        onFindNearestCaptain={handleOpenNearestModal}
        onMapClickCoordinates={handleMapClickCoordinates}
      />

      {/* Floating or Docked Entity Details Panel */}
      <EntityDetailsPanel
        selectedRestaurant={selectedRestaurant}
        selectedCaptain={selectedCaptain}
        selectedOrder={selectedOrder}
        restaurants={restaurants}
        captains={captains}
        activeOrders={activeOrders}
        onClose={() => {
          setSelectedRestaurant(null);
          setSelectedCaptain(null);
          setSelectedOrder(null);
        }}
        onFindNearestCaptain={handleOpenNearestModal}
        onStartPickingRestaurant={(merchant) => setPickingForRestaurant(merchant)}
      />

      {/* Nearest Captains Modal */}
      <NearestCaptainsModal
        isOpen={Boolean(nearestModalRestaurant)}
        restaurant={nearestModalRestaurant}
        captains={captains}
        onClose={() => setNearestModalRestaurant(null)}
      />
    </div>
  );
};
