import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Captain, CaptainSchedule } from '../../types';
import { ShiftService } from '../../services/shiftService';
import { computeCaptainShiftStatus } from '../../utils/shiftUtils';
import { LiveMapViewer } from './LiveMapViewer';

type ShiftRoster = {
  connectedInShiftCaptains: Captain[];
  offShiftCaptains: Captain[];
};

type Props = React.ComponentProps<typeof LiveMapViewer> & {
  onShiftRosterChange?: (roster: ShiftRoster) => void;
};

export const ShiftAwareLiveMapViewer: React.FC<Props> = (props) => {
  const { onShiftRosterChange, ...mapProps } = props;
  const [schedules, setSchedules] = useState<Map<string, CaptainSchedule>>(new Map());
  const [schedulesLoaded, setSchedulesLoaded] = useState(false);
  const [clockTick, setClockTick] = useState(0);
  const onShiftRosterChangeRef = useRef(onShiftRosterChange);

  useEffect(() => {
    onShiftRosterChangeRef.current = onShiftRosterChange;
  }, [onShiftRosterChange]);

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

  const shiftRoster = useMemo<ShiftRoster>(() => {
    if (!schedulesLoaded) {
      return { connectedInShiftCaptains: [], offShiftCaptains: [] };
    }

    const connectedInShiftCaptains: Captain[] = [];
    const offShiftCaptains: Captain[] = [];

    mapProps.captains.forEach((captain) => {
      const schedule = schedules.get(captain.id);
      const shiftStatus = computeCaptainShiftStatus(schedule);

      if (shiftStatus.status === 'off_shift') {
        offShiftCaptains.push(captain);
        return;
      }

      const isConnected =
        captain.isOnline === true ||
        captain.status === 'available' ||
        captain.status === 'online' ||
        captain.status === 'busy';

      if (shiftStatus.status === 'active' && isConnected) {
        connectedInShiftCaptains.push(captain);
      }
    });

    return { connectedInShiftCaptains, offShiftCaptains };
  }, [mapProps.captains, schedules, schedulesLoaded, clockTick]);

  useEffect(() => {
    onShiftRosterChangeRef.current?.(shiftRoster);
  }, [shiftRoster]);

  const offShiftIds = useMemo(
    () => new Set(shiftRoster.offShiftCaptains.map((captain) => captain.id)),
    [shiftRoster.offShiftCaptains]
  );

  const visibleCaptains = useMemo(
    () => schedulesLoaded
      ? mapProps.captains.filter((captain) => !offShiftIds.has(captain.id))
      : mapProps.captains,
    [mapProps.captains, offShiftIds, schedulesLoaded]
  );

  return <LiveMapViewer {...mapProps} captains={visibleCaptains} />;
};
