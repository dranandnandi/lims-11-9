import {
  endOfDay,
  endOfMonth,
  endOfWeek,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from 'date-fns';

export type CalendarDateFilter = 'today' | 'yesterday' | 'week' | 'month' | 'all' | 'custom';

export interface CustomDateRange {
  start?: string | null;
  end?: string | null;
}

const APP_WEEK_OPTIONS = { weekStartsOn: 1 as const };

const OPEN_RANGE_START = new Date(2000, 0, 1);
const OPEN_RANGE_END = new Date(2100, 0, 1);

export const toLocalDateString = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

/** Parses a `yyyy-MM-dd` input value as a local date (not UTC, as `new Date(str)` would). */
export const parseLocalDateString = (value: string): Date | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
};

export const getCalendarDateRange = (
  filter: CalendarDateFilter,
  now: Date = new Date(),
  custom?: CustomDateRange,
): { start: Date; end: Date } => {
  switch (filter) {
    case 'today':
      return { start: startOfDay(now), end: endOfDay(now) };
    case 'yesterday': {
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      return { start: startOfDay(yesterday), end: endOfDay(yesterday) };
    }
    case 'week':
      return {
        start: startOfWeek(now, APP_WEEK_OPTIONS),
        end: endOfWeek(now, APP_WEEK_OPTIONS),
      };
    case 'month':
      return { start: startOfMonth(now), end: endOfMonth(now) };
    case 'all':
      return { start: OPEN_RANGE_START, end: OPEN_RANGE_END };
    case 'custom': {
      const customStart = custom?.start ? parseLocalDateString(custom.start) : null;
      const customEnd = custom?.end ? parseLocalDateString(custom.end) : null;
      // An empty side stays open-ended so a half-filled range still returns rows.
      const start = customStart ? startOfDay(customStart) : OPEN_RANGE_START;
      const end = customEnd ? endOfDay(customEnd) : OPEN_RANGE_END;
      // Tolerate a reversed range instead of returning nothing.
      return start <= end ? { start, end } : { start: end, end: start };
    }
  }
};

export const getCalendarDateRangeStrings = (
  filter: Exclude<CalendarDateFilter, 'all'>,
  now: Date = new Date(),
  custom?: CustomDateRange,
): { start: string; end: string } => {
  const range = getCalendarDateRange(filter, now, custom);
  return {
    start: toLocalDateString(range.start),
    end: toLocalDateString(range.end),
  };
};

export const isDateInCalendarRange = (
  value: string | Date | null | undefined,
  filter: CalendarDateFilter,
  now: Date = new Date(),
  custom?: CustomDateRange,
): boolean => {
  if (filter === 'all') return true;
  if (!value) return false;

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return false;

  const { start, end } = getCalendarDateRange(filter, now, custom);
  return date >= start && date <= end;
};
