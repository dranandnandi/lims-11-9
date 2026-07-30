import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  RefreshCw, MapPin, Phone, Clock, Navigation, CheckCircle,
  Truck, FlaskConical, AlertCircle, User, ArrowRight
} from 'lucide-react';
import { format } from 'date-fns';
import { supabase } from '../utils/supabase';
import { useAuth } from '../contexts/AuthContext';
import { Booking } from '../types/booking';

// How often the phlebo's live position is written to the booking while en route
const LOCATION_PUSH_INTERVAL_MS = 20000;

// In the dedicated phlebo app build there is no staff dashboard to hand off to
const IS_PHLEBO_APP = ((import.meta.env.VITE_APP_TARGET as string | undefined) || 'lims') === 'phlebo';

const JOURNEY_STEPS = [
  { key: 'started', label: 'Start Journey', doneLabel: 'Journey Started', icon: Truck },
  { key: 'reached', label: 'Mark Reached', doneLabel: 'Reached Location', icon: MapPin },
  { key: 'collected', label: 'Mark Collected', doneLabel: 'Sample Collected', icon: FlaskConical },
] as const;

type JourneyKey = typeof JOURNEY_STEPS[number]['key'];

const JOURNEY_ORDER: Record<string, number> = { assigned: 0, started: 1, reached: 2, collected: 3 };

const PhleboCollections: React.FC = () => {
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const [myUserId, setMyUserId] = useState<string | null>(null);
  const [myName, setMyName] = useState<string>('');
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [loading, setLoading] = useState(true);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [trackingBookingId, setTrackingBookingId] = useState<string | null>(null);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [lastPushedAt, setLastPushedAt] = useState<Date | null>(null);

  const watchIdRef = useRef<number | null>(null);
  const lastPushRef = useRef<number>(0);
  const trackingBookingRef = useRef<string | null>(null);

  const loadBookings = useCallback(async (uid?: string | null) => {
    const phleboId = uid ?? myUserId;
    if (!phleboId) return;
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('bookings')
        .select('*')
        .eq('assigned_phlebo_id', phleboId)
        .neq('status', 'cancelled')
        .order('scheduled_at', { ascending: true, nullsFirst: false });
      if (error) throw error;
      setBookings((data as Booking[]) || []);
    } catch (err) {
      console.error('Error loading phlebo bookings:', err);
    } finally {
      setLoading(false);
    }
  }, [myUserId]);

  // Resolve the current user's public.users row (id may differ from auth uid)
  useEffect(() => {
    const resolve = async () => {
      if (!user?.email) return;
      const { data } = await supabase
        .from('users')
        .select('id, name')
        .eq('email', user.email)
        .maybeSingle();
      if (data?.id) {
        setMyUserId(data.id);
        setMyName(data.name || '');
        loadBookings(data.id);
      } else {
        setLoading(false);
      }
    };
    resolve();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.email]);

  const pushLocation = useCallback(async (bookingId: string, lat: number, lng: number) => {
    try {
      await supabase
        .from('bookings')
        .update({
          phlebo_last_lat: lat,
          phlebo_last_lng: lng,
          phlebo_location_updated_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', bookingId);
      setLastPushedAt(new Date());
    } catch (err) {
      console.error('Location push failed:', err);
    }
  }, []);

  const stopLocationTracking = useCallback(() => {
    if (watchIdRef.current !== null && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    trackingBookingRef.current = null;
    setTrackingBookingId(null);
  }, []);

  const startLocationTracking = useCallback((bookingId: string) => {
    if (!navigator.geolocation) {
      setLocationError('Location is not supported on this device/browser.');
      return;
    }
    stopLocationTracking();
    setLocationError(null);
    trackingBookingRef.current = bookingId;
    setTrackingBookingId(bookingId);
    lastPushRef.current = 0;

    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const now = Date.now();
        const target = trackingBookingRef.current;
        if (!target) return;
        // Throttle DB writes; the watch callback can fire every second
        if (now - lastPushRef.current >= LOCATION_PUSH_INTERVAL_MS) {
          lastPushRef.current = now;
          pushLocation(target, pos.coords.latitude, pos.coords.longitude);
        }
      },
      (err) => {
        console.warn('Geolocation error:', err);
        setLocationError(
          err.code === err.PERMISSION_DENIED
            ? 'Location permission denied. Enable location access to share your live position.'
            : 'Could not get your location. Live tracking may be unavailable.'
        );
      },
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 }
    );
  }, [pushLocation, stopLocationTracking]);

  // Clean up geolocation watch on unmount
  useEffect(() => stopLocationTracking, [stopLocationTracking]);

  // Resume tracking if a booking was already started/reached (e.g. after page reload)
  useEffect(() => {
    if (trackingBookingRef.current) return;
    const active = bookings.find(
      (b) => b.collection_status === 'started' || b.collection_status === 'reached'
    );
    if (active) startLocationTracking(active.id);
  }, [bookings, startLocationTracking]);

  const handleJourneyUpdate = async (booking: Booking, step: JourneyKey) => {
    setUpdatingId(booking.id);
    try {
      const timestampCol =
        step === 'started' ? 'collection_started_at'
        : step === 'reached' ? 'collection_reached_at'
        : 'collection_collected_at';

      const { error } = await supabase
        .from('bookings')
        .update({
          collection_status: step,
          [timestampCol]: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', booking.id);
      if (error) throw error;

      if (step === 'started') {
        startLocationTracking(booking.id);
        // Push one immediate position so admin sees location right away
        if (navigator.geolocation) {
          navigator.geolocation.getCurrentPosition(
            (pos) => pushLocation(booking.id, pos.coords.latitude, pos.coords.longitude),
            () => undefined,
            { enableHighAccuracy: true, timeout: 15000 }
          );
        }
      } else if (step === 'collected') {
        stopLocationTracking();
      }

      setBookings((prev) =>
        prev.map((b) => (b.id === booking.id ? { ...b, collection_status: step } : b))
      );
    } catch (err) {
      console.error('Journey update failed:', err);
      alert('Failed to update status. Please try again.');
    } finally {
      setUpdatingId(null);
    }
  };

  const openNavigation = (booking: Booking) => {
    const addr = booking.home_collection_address;
    const query = addr?.lat && addr?.lng
      ? `${addr.lat},${addr.lng}`
      : encodeURIComponent([addr?.address, addr?.city, addr?.pincode].filter(Boolean).join(', '));
    window.open(`https://www.google.com/maps/dir/?api=1&destination=${query}`, '_blank');
  };

  const activeBookings = bookings.filter(
    (b) => b.collection_status !== 'collected' && b.status !== 'converted'
  );
  const doneBookings = bookings.filter(
    (b) => b.collection_status === 'collected' || b.status === 'converted'
  );

  const renderBookingCard = (booking: Booking, done: boolean) => {
    const journeyRank = JOURNEY_ORDER[booking.collection_status || 'assigned'] ?? 0;
    const nextStep = JOURNEY_STEPS.find((s) => JOURNEY_ORDER[s.key] === journeyRank + 1);
    const isTracking = trackingBookingId === booking.id;
    const addr = booking.home_collection_address;

    return (
      <div key={booking.id} className={`bg-white rounded-xl border shadow-sm p-4 ${isTracking ? 'border-blue-300 ring-1 ring-blue-200' : 'border-gray-200'}`}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-gray-900 flex items-center gap-1.5">
                <User className="h-4 w-4 text-gray-400" />
                {booking.patient_info?.name || 'Patient'}
              </span>
              {booking.collection_status && (
                <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${
                  booking.collection_status === 'collected' ? 'bg-green-100 text-green-800'
                  : booking.collection_status === 'reached' ? 'bg-purple-100 text-purple-800'
                  : booking.collection_status === 'started' ? 'bg-blue-100 text-blue-800'
                  : 'bg-indigo-100 text-indigo-800'
                }`}>
                  {JOURNEY_STEPS.find((s) => s.key === booking.collection_status)?.doneLabel || 'Assigned'}
                </span>
              )}
              {isTracking && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200">
                  <span className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-pulse" />
                  Sharing live location
                </span>
              )}
            </div>
            {booking.scheduled_at && (
              <p className="text-sm text-gray-600 mt-1 flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5 text-gray-400" />
                {format(new Date(booking.scheduled_at), "dd MMM yyyy 'at' hh:mm a")}
              </p>
            )}
            {addr?.address && (
              <p className="text-sm text-gray-600 mt-1 flex items-start gap-1.5">
                <MapPin className="h-3.5 w-3.5 text-gray-400 mt-0.5 flex-shrink-0" />
                {[addr.address, addr.city, addr.pincode].filter(Boolean).join(', ')}
              </p>
            )}
            {(booking.test_details?.length || 0) > 0 && (
              <p className="text-xs text-gray-500 mt-1.5">
                Tests: {booking.test_details!.map((t) => t.name).join(', ')}
              </p>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="mt-3 flex items-center gap-2 flex-wrap">
          {booking.patient_info?.phone && (
            <a
              href={`tel:${booking.patient_info.phone}`}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors"
            >
              <Phone className="h-4 w-4" />
              Call
            </a>
          )}
          <button
            onClick={() => openNavigation(booking)}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors"
          >
            <Navigation className="h-4 w-4" />
            Navigate
          </button>
          {!done && nextStep && (
            <button
              onClick={() => handleJourneyUpdate(booking, nextStep.key)}
              disabled={updatingId === booking.id}
              className={`inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white rounded-lg transition-colors disabled:opacity-60 ${
                nextStep.key === 'collected' ? 'bg-green-600 hover:bg-green-700' : 'bg-blue-600 hover:bg-blue-700'
              }`}
            >
              <nextStep.icon className="h-4 w-4" />
              {updatingId === booking.id ? 'Updating...' : nextStep.label}
            </button>
          )}
          {booking.status !== 'converted' && !IS_PHLEBO_APP && (
            <button
              onClick={() => navigate('/', { state: { processBooking: booking } })}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-indigo-50 text-indigo-700 border border-indigo-200 rounded-lg hover:bg-indigo-100 transition-colors"
            >
              Process Order
              <ArrowRight className="h-4 w-4" />
            </button>
          )}
          {done && (
            <span className="inline-flex items-center gap-1.5 text-sm text-green-700 font-medium">
              <CheckCircle className="h-4 w-4" />
              Done
            </span>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 space-y-5">
      {IS_PHLEBO_APP && (
        <div className="flex items-center justify-between bg-blue-600 text-white rounded-xl px-4 py-3 shadow-sm">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-9 h-9 rounded-full bg-white/20 flex items-center justify-center flex-shrink-0">
              <User className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <p className="font-semibold leading-tight truncate">{myName || 'Phlebotomist'}</p>
              <p className="text-xs text-blue-100 truncate">{user?.email}</p>
            </div>
          </div>
          <button
            onClick={() => signOut()}
            className="flex-shrink-0 px-3 py-1.5 text-sm font-medium bg-white/15 hover:bg-white/25 rounded-lg transition-colors"
          >
            Logout
          </button>
        </div>
      )}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">My Collections</h1>
          <p className="text-sm text-gray-500 mt-0.5">Home collection visits assigned to you</p>
        </div>
        <button
          onClick={() => loadBookings()}
          className="flex items-center px-3 py-2 text-sm bg-blue-50 text-blue-700 rounded-lg hover:bg-blue-100 transition-colors"
        >
          <RefreshCw className={`h-4 w-4 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {locationError && (
        <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800">
          <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
          {locationError}
        </div>
      )}

      {trackingBookingId && lastPushedAt && (
        <p className="text-xs text-gray-500">
          Live location last shared at {format(lastPushedAt, 'hh:mm:ss a')} (updates every {LOCATION_PUSH_INTERVAL_MS / 1000}s while en route).
        </p>
      )}

      {loading ? (
        <div className="text-center py-16">
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-600 mx-auto" />
          <p className="mt-3 text-gray-500 text-sm">Loading your assignments...</p>
        </div>
      ) : (
        <>
          <div className="space-y-3">
            {activeBookings.length === 0 ? (
              <div className="text-center py-12 text-gray-400 bg-white rounded-xl border border-gray-200">
                <Truck className="h-10 w-10 mx-auto mb-3 opacity-40" />
                <p className="font-medium">No pending collections</p>
                <p className="text-sm mt-1">Assignments from the lab will appear here.</p>
              </div>
            ) : (
              activeBookings.map((b) => renderBookingCard(b, false))
            )}
          </div>

          {doneBookings.length > 0 && (
            <div>
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2 mt-6">Completed</p>
              <div className="space-y-3 opacity-75">
                {doneBookings.map((b) => renderBookingCard(b, true))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default PhleboCollections;
