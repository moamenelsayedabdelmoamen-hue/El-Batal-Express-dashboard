import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Clock3, Phone } from 'lucide-react';
import { CaptainSchedule } from '../../types';
import { ShiftService } from '../../services/shiftService';
import { computeCaptainShiftStatus } from '../../utils/shiftUtils';
import { LiveMapViewer } from './LiveMapViewer';

/**
 * Keeps captains outside their scheduled working hours off the live map,
 * while showing them in a separate operational list.
 * Shift status is recalculated every minute using Africa/Cairo time.
 */
type Props = React.ComponentProps<typeof LiveMapViewer>;

export const ShiftAwareLiveMapViewer: React.FC<Props> = (props) => {
  const [schedules, setSchedules] = useState<Map<string, CaptainSchedule>>(new Map());
  const [schedulesLoaded, setSchedulesLoaded] = useState(false);
  const [clockTick, setClockTick] = useState(0);

  useEffect(() => {
    const unsubscribe = ShiftService.subscribeAllSchedules((nextSchedules) => {
      setSchedules(new Map(nextSchedules));
      setSchedulesLoaded(true);
    }, (error) => {
      console.warn('Live map shift schedules subscription notice:', error);
      setSchedulesLoaded(true);
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setClockTick((value) => value + 1), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const offShiftCaptains = useMemo(() => {
    if (!schedulesLoaded) return [];
    return props.captains.filter((captain) => {
      const schedule = schedules.get(captain.id);
      return Boolean(schedule) && computeCaptainShiftStatus(schedule).status === 'off_shift';
    });
  }, [props.captains, schedules, schedulesLoaded, clockTick]);

  const offShiftIds = useMemo(
    () => new Set(offShiftCaptains.map((captain) => captain.id)),
    [offShiftCaptains]
  );

  const visibleCaptains = useMemo(
    () => schedulesLoaded
      ? props.captains.filter((captain) => !offShiftIds.has(captain.id))
      : props.captains,
    [props.captains, offShiftIds, schedulesLoaded]
  );

  return (
    <div className="space-y-3">
      {schedulesLoaded && (
        <section className="rounded-2xl border border-orange-500/30 bg-[#0d1017] p-4 shadow-md" dir="rtl">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm font-extrabold text-orange-300">
              <AlertTriangle className="h-4 w-4" />
              <span>كباتن خارج ساعات العمل</span>
              <span className="rounded-full border border-orange-500/30 bg-orange-500/10 px-2 py-0.5 text-xs text-orange-200">
                {offShiftCaptains.length}
              </span>
            </div>
            <span className="text-[11px] text-zinc-500">مستبعدون من علامات الكباتن على الخريطة</span>
          </div>

          {offShiftCaptains.length === 0 ? (
            <p className="text-xs text-zinc-500">لا يوجد كباتن خارج ساعات العمل حالياً.</p>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {offShiftCaptains.map((captain) => {
                const status = computeCaptainShiftStatus(schedules.get(captain.id));
                return (
                  <div key={captain.id} className="flex min-w-0 items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-900/70 px-3 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-xs font-bold text-zinc-100">{captain.name}</p>
                      <p className="mt-1 flex items-center gap-1 text-[11px] text-zinc-400">
                        <Phone className="h-3 w-3" />
                        <span dir="ltr">{captain.phone}</span>
                      </p>
                      <p className="mt-1 flex items-center gap-1 text-[11px] text-orange-300">
                        <Clock3 className="h-3 w-3" />
                        {status.nextShift
                          ? `الشفت القادم: ${status.nextShift.dayNameAr} ${status.nextShift.startTimeFormatted}`
                          : 'لا يوجد شفت قادم محدد'}
                      </p>
                    </div>
                    <span className="shrink-0 rounded-lg bg-orange-500/10 px-2 py-1 text-[10px] font-bold text-orange-300">
                      خارج الشفت
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      <LiveMapViewer {...props} captains={visibleCaptains} />
    </div>
  );
};
