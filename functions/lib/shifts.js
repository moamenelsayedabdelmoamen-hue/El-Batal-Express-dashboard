"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getCairoTimeContext = getCairoTimeContext;
exports.evaluateScheduleDocAtTime = evaluateScheduleDocAtTime;
exports.isCaptainInActiveShift = isCaptainInActiveShift;
const CAIRO_TIME_ZONE = "Africa/Cairo";
const WEEKDAY_MAP = {
    sat: "saturday",
    sun: "sunday",
    mon: "monday",
    tue: "tuesday",
    wed: "wednesday",
    thu: "thursday",
    fri: "friday",
};
const WEEKDAY_ORDER = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
];
/**
 * Computes current Cairo date key, weekday key, and minutes since midnight.
 * @param {number} nowMs Epoch milliseconds.
 * @return {CairoTimeContext} Cairo time context.
 */
function getCairoTimeContext(nowMs) {
    var _a, _b, _c, _d, _e, _f, _g;
    const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: CAIRO_TIME_ZONE,
        weekday: "short",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    });
    const parts = formatter.formatToParts(new Date(nowMs));
    const lookup = {};
    for (const part of parts) {
        lookup[part.type] = part.value;
    }
    const rawWeekday = ((_a = lookup.weekday) !== null && _a !== void 0 ? _a : "sun").slice(0, 3).toLowerCase();
    const weekdayKey = (_b = WEEKDAY_MAP[rawWeekday]) !== null && _b !== void 0 ? _b : "sunday";
    const idx = WEEKDAY_ORDER.indexOf(weekdayKey);
    const prevIdx = (idx + 6) % 7;
    const prevWeekdayKey = WEEKDAY_ORDER[prevIdx];
    const year = (_c = lookup.year) !== null && _c !== void 0 ? _c : "2026";
    const month = (_d = lookup.month) !== null && _d !== void 0 ? _d : "01";
    const day = (_e = lookup.day) !== null && _e !== void 0 ? _e : "01";
    const hourRaw = Number((_f = lookup.hour) !== null && _f !== void 0 ? _f : "0");
    const hour = hourRaw === 24 ? 0 : hourRaw;
    const minute = Number((_g = lookup.minute) !== null && _g !== void 0 ? _g : "0");
    return {
        dayKey: `${year}-${month}-${day}`,
        weekdayKey,
        prevWeekdayKey,
        minutesSinceMidnight: hour * 60 + minute,
    };
}
function parseMinutes(timeStr) {
    if (typeof timeStr !== "string")
        return null;
    const match = timeStr.trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!match)
        return null;
    const h = Number(match[1]);
    const m = Number(match[2]);
    if (!Number.isInteger(h) || !Number.isInteger(m))
        return null;
    if (h < 0 || h > 23 || m < 0 || m > 59)
        return null;
    return h * 60 + m;
}
function mapDayNumberToKey(dayOfWeek) {
    var _a;
    // Convention used across Android ShiftEntity: 1 = Saturday .. 7 = Friday
    const mapping = {
        1: "saturday",
        2: "sunday",
        3: "monday",
        4: "tuesday",
        5: "wednesday",
        6: "thursday",
        7: "friday",
    };
    return (_a = mapping[dayOfWeek]) !== null && _a !== void 0 ? _a : "saturday";
}
function resolveDayKey(entry) {
    var _a, _b, _c, _d;
    if (typeof entry.dayKey === "string" && entry.dayKey.trim()) {
        return entry.dayKey.trim().toLowerCase();
    }
    const dayNameRaw = (_b = (_a = entry.dayName) !== null && _a !== void 0 ? _a : entry.day) !== null && _b !== void 0 ? _b : entry.weekday;
    if (typeof dayNameRaw === "string" && dayNameRaw.trim()) {
        const clean = dayNameRaw.trim().toLowerCase();
        for (const day of WEEKDAY_ORDER) {
            if (clean === day || clean.startsWith(day.slice(0, 3))) {
                return day;
            }
        }
    }
    const dayNum = Number((_d = (_c = entry.dayOfWeek) !== null && _c !== void 0 ? _c : entry.dayIndex) !== null && _d !== void 0 ? _d : entry.dayNumber);
    if (Number.isInteger(dayNum) && dayNum >= 1 && dayNum <= 7) {
        return mapDayNumberToKey(dayNum);
    }
    return null;
}
function isShiftListActive(shiftsRaw, currentDayKey, prevDayKey, currentMins) {
    var _a, _b, _c, _d;
    const parsed = [];
    for (const item of shiftsRaw) {
        if (!item || typeof item !== "object")
            continue;
        const obj = item;
        const dayKey = resolveDayKey(obj);
        const startTime = String((_b = (_a = obj.startTime) !== null && _a !== void 0 ? _a : obj.start) !== null && _b !== void 0 ? _b : "09:00");
        const endTime = String((_d = (_c = obj.endTime) !== null && _c !== void 0 ? _c : obj.end) !== null && _d !== void 0 ? _d : "17:00");
        const isDayOff = obj.isDayOff === true || obj.enabled === false;
        parsed.push({ dayKey: dayKey !== null && dayKey !== void 0 ? dayKey : undefined, isDayOff, startTime, endTime });
    }
    // Check current day shifts
    for (const win of parsed) {
        if (win.dayKey && win.dayKey !== currentDayKey)
            continue;
        if (win.isDayOff)
            continue;
        const startM = parseMinutes(win.startTime);
        const endM = parseMinutes(win.endTime);
        if (startM === null || endM === null)
            continue;
        if (endM <= startM) {
            if (currentMins >= startM)
                return true;
        }
        else if (currentMins >= startM && currentMins < endM) {
            return true;
        }
    }
    // Check overnight spillover from yesterday's shifts
    for (const win of parsed) {
        if (win.dayKey !== prevDayKey)
            continue;
        if (win.isDayOff)
            continue;
        const startM = parseMinutes(win.startTime);
        const endM = parseMinutes(win.endTime);
        if (startM === null || endM === null)
            continue;
        if (endM <= startM && currentMins < endM) {
            return true;
        }
    }
    return false;
}
/**
 * Evaluates whether a schedule document places the captain inside an active
 * shift at the specified timestamp in Africa/Cairo timezone.
 * @param {Record<string, unknown>} scheduleDoc Schedule data document.
 * @param {number} nowMs Epoch milliseconds.
 * @return {{hasSchedule: boolean, isActive: boolean}} Evaluation outcome.
 */
function evaluateScheduleDocAtTime(scheduleDoc, nowMs) {
    var _a, _b, _c, _d;
    if (!scheduleDoc) {
        return { hasSchedule: false, isActive: false };
    }
    if (scheduleDoc.isPaused === true) {
        return { hasSchedule: true, isActive: false };
    }
    const ctx = getCairoTimeContext(nowMs);
    const weekly = scheduleDoc.weeklySchedule;
    if (weekly && typeof weekly === "object" && !Array.isArray(weekly)) {
        const weekMap = weekly;
        const hasDays = Object.keys(weekMap).length > 0;
        if (hasDays) {
            // Check previous day overnight spillovers first
            const prevEntry = weekMap[ctx.prevWeekdayKey];
            if (prevEntry && prevEntry.isDayOff !== true && Array.isArray(prevEntry.shifts)) {
                for (const s of prevEntry.shifts) {
                    if (!s || typeof s !== "object")
                        continue;
                    const slot = s;
                    const startM = parseMinutes((_a = slot.startTime) !== null && _a !== void 0 ? _a : slot.start);
                    const endM = parseMinutes((_b = slot.endTime) !== null && _b !== void 0 ? _b : slot.end);
                    if (startM !== null && endM !== null && endM <= startM) {
                        if (ctx.minutesSinceMidnight < endM) {
                            return { hasSchedule: true, isActive: true };
                        }
                    }
                }
            }
            // Check current day shifts
            const currEntry = weekMap[ctx.weekdayKey];
            if (currEntry && currEntry.isDayOff !== true && Array.isArray(currEntry.shifts)) {
                for (const s of currEntry.shifts) {
                    if (!s || typeof s !== "object")
                        continue;
                    const slot = s;
                    const startM = parseMinutes((_c = slot.startTime) !== null && _c !== void 0 ? _c : slot.start);
                    const endM = parseMinutes((_d = slot.endTime) !== null && _d !== void 0 ? _d : slot.end);
                    if (startM === null || endM === null)
                        continue;
                    if (endM <= startM) {
                        if (ctx.minutesSinceMidnight >= startM) {
                            return { hasSchedule: true, isActive: true };
                        }
                    }
                    else if (ctx.minutesSinceMidnight >= startM &&
                        ctx.minutesSinceMidnight < endM) {
                        return { hasSchedule: true, isActive: true };
                    }
                }
            }
            return { hasSchedule: true, isActive: false };
        }
    }
    const shiftsArray = Array.isArray(scheduleDoc.shifts)
        ? scheduleDoc.shifts
        : Array.isArray(scheduleDoc.schedule)
            ? scheduleDoc.schedule
            : null;
    if (shiftsArray && shiftsArray.length > 0) {
        return {
            hasSchedule: true,
            isActive: isShiftListActive(shiftsArray, ctx.weekdayKey, ctx.prevWeekdayKey, ctx.minutesSinceMidnight),
        };
    }
    return { hasSchedule: false, isActive: false };
}
/**
 * Checks whether the captain is currently inside an active shift using
 * captain_schedules/{uid}, embedded captain doc schedule, or subcollections.
 * @param {DatabaseLike} db Firestore database interface.
 * @param {string} captainUid Captain Firebase UID.
 * @param {Record<string, unknown>} captainData Captain document fields.
 * @param {number} nowMs Current epoch milliseconds.
 * @return {Promise<boolean>} True if captain has an active shift right now.
 */
async function isCaptainInActiveShift(db, captainUid, captainData, nowMs) {
    // 1. Primary source: captain_schedules/{uid}
    const directSchedule = await db
        .collection("captain_schedules")
        .doc(captainUid)
        .get();
    if (directSchedule.exists) {
        const evalRes = evaluateScheduleDocAtTime(directSchedule.data(), nowMs);
        if (evalRes.hasSchedule) {
            return evalRes.isActive;
        }
        // Check subcollection captain_schedules/{uid}/shifts
        const subSnap = await db
            .collection("captain_schedules")
            .doc(captainUid)
            .collection("shifts")
            .get();
        if (!subSnap.empty) {
            const ctx = getCairoTimeContext(nowMs);
            return isShiftListActive(subSnap.docs.map((d) => { var _a; return (_a = d.data()) !== null && _a !== void 0 ? _a : {}; }), ctx.weekdayKey, ctx.prevWeekdayKey, ctx.minutesSinceMidnight);
        }
    }
    // 2. Query captain_schedules where captainId == uid
    const querySnap = await db
        .collection("captain_schedules")
        .where("captainId", "==", captainUid)
        .limit(5)
        .get();
    if (!querySnap.empty) {
        for (const doc of querySnap.docs) {
            const evalRes = evaluateScheduleDocAtTime(doc.data(), nowMs);
            if (evalRes.hasSchedule) {
                if (evalRes.isActive)
                    return true;
                return false;
            }
        }
    }
    // 3. Fallback: embedded schedule inside captains/{uid}
    const embeddedEval = evaluateScheduleDocAtTime(captainData, nowMs);
    if (embeddedEval.hasSchedule) {
        return embeddedEval.isActive;
    }
    // No active schedule configured -> captain cannot receive/accept orders
    return false;
}
//# sourceMappingURL=shifts.js.map