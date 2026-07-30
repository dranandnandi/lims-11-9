import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  LogOut, Search, RefreshCw, FileText, Printer,
  User, Phone, Droplets, Calendar, ChevronDown, ChevronUp,
  Clock, CheckCircle, Loader, AlertCircle, KeyRound, Eye, EyeOff,
  Home, MapPin, Truck, Navigation
} from 'lucide-react';
import { supabase } from '../supabase';
import { getCurrentPatientMeta, patientSignOut, forgetLabRecordedPin } from '../patientAuth';

interface PatientInfo {
  id: string;
  name: string;
  age: number | null;
  gender: string | null;
  phone: string | null;
  blood_group: string | null;
  date_of_birth: string | null;
  display_id: string | null;
}

interface Report {
  id: string;
  pdf_url: string | null;
  print_pdf_url: string | null;
  status: string;
  generated_date: string | null;
}

interface Order {
  id: string;
  sample_id: string | null;
  order_date: string;
  status: string;
  total_amount: number;
  reports: Report | null;
  order_tests?: { test_group?: { name: string } }[];
  samples?: SampleSummary[] | null;
}

interface SampleSummary {
  id: string;
  barcode: string | null;
  sample_type: string | null;
  status: string;
  collected_at?: string | null;
  received_at?: string | null;
  rejected_at?: string | null;
  rejection_reason?: string | null;
}

interface HomeCollectionBooking {
  id: string;
  status: string;
  scheduled_at: string | null;
  home_collection_address: { address?: string; city?: string; pincode?: string } | null;
  test_details: Array<{ name: string; type?: string }> | null;
  assigned_phlebo_name: string | null;
  collection_status: string | null;
  phlebo_last_lat: number | null;
  phlebo_last_lng: number | null;
  phlebo_location_updated_at: string | null;
  created_at: string;
}

// How often the patient portal re-fetches the phlebo's position while en route
const TRACK_REFRESH_MS = 20000;

const isEnRoute = (b: HomeCollectionBooking) =>
  b.collection_status === 'started' || b.collection_status === 'reached';

const timeAgo = (iso: string | null): string => {
  if (!iso) return '';
  const secs = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
};

const BOOKING_STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  pending:   { label: 'Requested',  color: 'bg-amber-100 text-amber-800' },
  quoted:    { label: 'Quoted',     color: 'bg-blue-100 text-blue-800' },
  confirmed: { label: 'Confirmed',  color: 'bg-green-100 text-green-800' },
  converted: { label: 'Completed',  color: 'bg-gray-100 text-gray-700' },
  cancelled: { label: 'Cancelled',  color: 'bg-red-100 text-red-700' },
};

const JOURNEY_STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  assigned:  { label: 'Phlebotomist Assigned', color: 'bg-indigo-100 text-indigo-800' },
  started:   { label: 'Phlebotomist On The Way', color: 'bg-blue-100 text-blue-800' },
  reached:   { label: 'Phlebotomist Arrived', color: 'bg-purple-100 text-purple-800' },
  collected: { label: 'Sample Collected', color: 'bg-green-100 text-green-800' },
};

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
  'Pending Collection': { label: 'Pending Collection', color: 'bg-yellow-100 text-yellow-800', icon: <Clock className="h-3 w-3" /> },
  'In Progress':        { label: 'In Progress',        color: 'bg-blue-100 text-blue-800',   icon: <Loader className="h-3 w-3 animate-spin" /> },
  'Pending Approval':   { label: 'Pending Approval',   color: 'bg-orange-100 text-orange-800', icon: <Clock className="h-3 w-3" /> },
  'Report Ready':       { label: 'Report Ready',       color: 'bg-green-100 text-green-800', icon: <CheckCircle className="h-3 w-3" /> },
  'Completed':          { label: 'Completed',          color: 'bg-green-100 text-green-800', icon: <CheckCircle className="h-3 w-3" /> },
  'Delivered':          { label: 'Delivered',          color: 'bg-gray-100 text-gray-700',   icon: <CheckCircle className="h-3 w-3" /> },
  'Rejected':           { label: 'Rejected',           color: 'bg-red-100 text-red-700',     icon: <AlertCircle className="h-3 w-3" /> },
};

const PatientPortal: React.FC = () => {
  const navigate = useNavigate();
  const [patient, setPatient] = useState<PatientInfo | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [filteredOrders, setFilteredOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('All');
  const [showChangePIN, setShowChangePIN] = useState(false);
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [showNewPin, setShowNewPin] = useState(false);
  const [pinLoading, setPinLoading] = useState(false);
  const [pinMessage, setPinMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [labName, setLabName] = useState('');

  // Home collection booking
  const [bookings, setBookings] = useState<HomeCollectionBooking[]>([]);
  const [showBookingForm, setShowBookingForm] = useState(false);
  const [bookingDate, setBookingDate] = useState('');
  const [bookingTime, setBookingTime] = useState('');
  const [bookingAddress, setBookingAddress] = useState('');
  const [bookingCity, setBookingCity] = useState('');
  const [bookingPincode, setBookingPincode] = useState('');
  const [bookingNotes, setBookingNotes] = useState('');
  const [bookingLoading, setBookingLoading] = useState(false);
  const [bookingMessage, setBookingMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [trackingOpenId, setTrackingOpenId] = useState<string | null>(null);

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // While a phlebo is en route, refresh their live position + journey status periodically
  useEffect(() => {
    const enRouteIds = bookings.filter(isEnRoute).map((b) => b.id);
    if (enRouteIds.length === 0) return;

    const timer = setInterval(async () => {
      const { data } = await supabase
        .from('bookings')
        .select('id, collection_status, phlebo_last_lat, phlebo_last_lng, phlebo_location_updated_at')
        .in('id', enRouteIds);
      if (data && data.length > 0) {
        setBookings((prev) =>
          prev.map((b) => {
            const fresh = data.find((d) => d.id === b.id);
            return fresh ? { ...b, ...fresh } : b;
          })
        );
      }
    }, TRACK_REFRESH_MS);

    return () => clearInterval(timer);
  }, [bookings]);

  useEffect(() => {
    let filtered = [...orders];
    if (searchTerm) {
      const s = searchTerm.toLowerCase();
      filtered = filtered.filter(
        (o) =>
          o.sample_id?.toLowerCase().includes(s) ||
          (o.samples || []).some((sample) =>
            sample.id?.toLowerCase().includes(s) ||
            sample.barcode?.toLowerCase().includes(s) ||
            sample.sample_type?.toLowerCase().includes(s)
          ) ||
          o.id.toLowerCase().includes(s)
      );
    }
    if (statusFilter !== 'All') {
      filtered = filtered.filter((o) => o.status === statusFilter);
    }
    setFilteredOrders(filtered);
  }, [orders, searchTerm, statusFilter]);

  const loadData = async () => {
    try {
      setLoading(true);
      const meta = await getCurrentPatientMeta();
      if (!meta) { navigate('/login'); return; }

      // Fetch patient record (RLS ensures own record only)
      const { data: patientData } = await supabase
        .from('patients')
        .select('id, name, age, gender, phone, blood_group, date_of_birth, display_id')
        .eq('id', meta.patient_id)
        .single();

      if (patientData) setPatient(patientData);

      // Fetch lab name
      const { data: labData } = await supabase
        .from('labs')
        .select('name')
        .eq('id', meta.lab_id)
        .single();

      if (labData) setLabName(labData.name);

      // Fetch orders (RLS ensures own orders only)
      const { data: ordersData } = await supabase
        .from('orders')
        .select(`
          id, sample_id, order_date, status, total_amount,
          samples(id, barcode, sample_type, status, collected_at, received_at, rejected_at, rejection_reason),
          reports(id, pdf_url, print_pdf_url, status, generated_date)
        `)
        .eq('patient_id', meta.patient_id)
        .order('order_date', { ascending: false });

      setOrders((ordersData as unknown as Order[]) || []);

      // Fetch home collection requests (RLS ensures own bookings only)
      const { data: bookingsData } = await supabase
        .from('bookings')
        .select('id, status, scheduled_at, home_collection_address, test_details, assigned_phlebo_name, collection_status, phlebo_last_lat, phlebo_last_lng, phlebo_location_updated_at, created_at')
        .eq('patient_id', meta.patient_id)
        .order('created_at', { ascending: false });

      setBookings((bookingsData as HomeCollectionBooking[]) || []);
    } catch (err) {
      console.error('PatientPortal load error:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleBookHomeCollection = async (e: React.FormEvent) => {
    e.preventDefault();
    setBookingMessage(null);

    if (!bookingDate || !bookingTime) {
      setBookingMessage({ type: 'error', text: 'Please choose a preferred date and time.' });
      return;
    }
    if (!bookingAddress.trim()) {
      setBookingMessage({ type: 'error', text: 'Please enter your collection address.' });
      return;
    }

    setBookingLoading(true);
    try {
      const meta = await getCurrentPatientMeta();
      if (!meta) { navigate('/login'); return; }

      const scheduledAt = new Date(`${bookingDate}T${bookingTime}`).toISOString();

      const { error } = await supabase.from('bookings').insert({
        lab_id: meta.lab_id,
        patient_id: meta.patient_id,
        booking_source: 'patient_app',
        status: 'pending',
        collection_type: 'home_collection',
        patient_info: {
          name: patient?.name || meta.name,
          phone: patient?.phone || meta.phone,
          age: patient?.age ?? undefined,
          gender: patient?.gender ?? undefined,
        },
        test_details: bookingNotes.trim() ? [{ name: bookingNotes.trim(), type: 'note' }] : [],
        scheduled_at: scheduledAt,
        home_collection_address: {
          address: bookingAddress.trim(),
          city: bookingCity.trim() || undefined,
          pincode: bookingPincode.trim() || undefined,
        },
      });

      if (error) throw error;

      setBookingMessage({ type: 'success', text: 'Home collection request sent! The lab will confirm your slot shortly.' });
      setBookingDate('');
      setBookingTime('');
      setBookingNotes('');
      await loadData();
      setTimeout(() => { setShowBookingForm(false); setBookingMessage(null); }, 2500);
    } catch (err) {
      console.error('Home collection booking error:', err);
      setBookingMessage({ type: 'error', text: 'Failed to send request. Please try again or call the lab.' });
    } finally {
      setBookingLoading(false);
    }
  };

  const handleLogout = async () => {
    await patientSignOut();
    navigate('/login');
  };

  const handleChangePIN = async (e: React.FormEvent) => {
    e.preventDefault();
    setPinMessage(null);

    if (newPin.length !== 6) { setPinMessage({ type: 'error', text: 'PIN must be exactly 6 digits.' }); return; }
    if (newPin !== confirmPin) { setPinMessage({ type: 'error', text: 'PINs do not match.' }); return; }

    setPinLoading(true);
    try {
      const { error } = await supabase.auth.updateUser({ password: newPin });
      if (error) throw error;
      // Drop the PIN the lab recorded — it is no longer the working one
      await forgetLabRecordedPin();
      setPinMessage({ type: 'success', text: 'PIN changed successfully.' });
      setNewPin('');
      setConfirmPin('');
      setTimeout(() => setShowChangePIN(false), 2000);
    } catch {
      setPinMessage({ type: 'error', text: 'Failed to change PIN. Please try again.' });
    } finally {
      setPinLoading(false);
    }
  };

  const formatDate = (dateString: string) =>
    new Date(dateString).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

  const openReport = (url: string) => window.open(url, '_blank');

  const getSampleStatusColor = (status: string) => {
    const normalized = String(status || '').toLowerCase();
    if (normalized === 'rejected') return 'bg-red-100 text-red-700';
    if (normalized === 'received') return 'bg-blue-100 text-blue-700';
    if (normalized === 'collected') return 'bg-green-100 text-green-700';
    if (normalized === 'processing' || normalized === 'processed') return 'bg-purple-100 text-purple-700';
    return 'bg-amber-100 text-amber-700';
  };

  const getSampleStatusLabel = (status: string) => {
    const normalized = String(status || '').toLowerCase();
    if (normalized === 'created') return 'Pending';
    return normalized ? normalized.charAt(0).toUpperCase() + normalized.slice(1) : 'Pending';
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-teal-600 mx-auto" />
          <p className="mt-4 text-gray-600">Loading your reports...</p>
        </div>
      </div>
    );
  }

  const readyCount = orders.filter((o) => ['Report Ready', 'Completed', 'Delivered'].includes(o.status)).length;

  return (
    <div className="min-h-screen bg-gray-50">

      {/* Header */}
      <header className="bg-white shadow-sm border-b border-gray-200">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-gray-900">{labName || 'Patient Portal'}</h1>
            <p className="text-sm text-gray-500 mt-0.5">Your health records</p>
          </div>
          <button
            onClick={handleLogout}
            className="flex items-center px-3 py-2 text-sm bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors"
          >
            <LogOut className="h-4 w-4 mr-1.5" />
            Logout
          </button>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 sm:px-6 py-6 space-y-6">

        {/* Patient Identity Card */}
        {patient && (
          <div className="bg-gradient-to-r from-teal-600 to-cyan-600 rounded-2xl p-6 text-white">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-4">
                <div className="w-14 h-14 bg-white/20 rounded-full flex items-center justify-center">
                  <User className="h-7 w-7 text-white" />
                </div>
                <div>
                  <h2 className="text-xl font-bold">{patient.name}</h2>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1 text-teal-100 text-sm">
                    {patient.gender && <span>{patient.gender}</span>}
                    {patient.age && <span>{patient.age} yrs</span>}
                    {patient.blood_group && (
                      <span className="flex items-center gap-1">
                        <Droplets className="h-3.5 w-3.5" />
                        {patient.blood_group}
                      </span>
                    )}
                  </div>
                </div>
              </div>
              {patient.display_id && (
                <div className="text-right text-sm text-teal-100">
                  <p className="text-xs">Patient ID</p>
                  <p className="font-mono font-medium">{patient.display_id}</p>
                </div>
              )}
            </div>

            <div className="mt-4 flex flex-wrap gap-4 text-sm text-teal-100">
              {patient.phone && (
                <span className="flex items-center gap-1.5">
                  <Phone className="h-3.5 w-3.5" />
                  {patient.phone}
                </span>
              )}
              {patient.date_of_birth && (
                <span className="flex items-center gap-1.5">
                  <Calendar className="h-3.5 w-3.5" />
                  {formatDate(patient.date_of_birth)}
                </span>
              )}
            </div>

            {/* Summary stats */}
            <div className="mt-4 grid grid-cols-3 gap-3">
              {[
                { label: 'Total Orders', value: orders.length },
                { label: 'Reports Ready', value: readyCount },
                { label: 'In Progress', value: orders.length - readyCount },
              ].map(({ label, value }) => (
                <div key={label} className="bg-white/15 rounded-xl p-3 text-center">
                  <p className="text-2xl font-bold">{value}</p>
                  <p className="text-xs text-teal-100 mt-0.5">{label}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Orders & Reports */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200">
          {/* Toolbar */}
          <div className="p-4 border-b border-gray-100 flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
              <input
                type="text"
                placeholder="Search by Sample ID..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
              />
            </div>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
            >
              <option value="All">All Status</option>
              <option value="Pending Collection">Pending Collection</option>
              <option value="In Progress">In Progress</option>
              <option value="Report Ready">Report Ready</option>
              <option value="Completed">Completed</option>
              <option value="Delivered">Delivered</option>
            </select>
            <button
              onClick={loadData}
              className="flex items-center px-3 py-2 text-sm bg-teal-50 text-teal-700 rounded-lg hover:bg-teal-100 transition-colors"
            >
              <RefreshCw className="h-4 w-4 mr-1.5" />
              Refresh
            </button>
          </div>

          <div className="p-4">
            <p className="text-xs text-gray-500 mb-3">
              Showing {filteredOrders.length} of {orders.length} orders
            </p>

            {filteredOrders.length === 0 ? (
              <div className="text-center py-12 text-gray-400">
                <FileText className="h-10 w-10 mx-auto mb-3 opacity-40" />
                <p className="font-medium">No orders found</p>
                <p className="text-sm mt-1">
                  {orders.length === 0
                    ? 'Your orders will appear here once processed by the lab.'
                    : 'Try adjusting your search or filter.'}
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {filteredOrders.map((order) => {
                  const statusCfg = STATUS_CONFIG[order.status] || { label: order.status, color: 'bg-gray-100 text-gray-700', icon: null };
                  const hasReport = !!order.reports?.pdf_url;
                  const orderSamples = order.samples || [];

                  return (
                    <div
                      key={order.id}
                      className="border border-gray-200 rounded-xl p-4 hover:border-teal-200 hover:bg-teal-50/30 transition-colors"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            {(orderSamples.length > 0 ? orderSamples : [{ id: order.sample_id || order.id, barcode: order.sample_id, sample_type: null, status: '' }]).map((sample) => (
                              <span key={sample.id} className="font-mono text-sm font-semibold text-gray-900">
                                {sample.barcode || sample.id}
                              </span>
                            ))}
                            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${statusCfg.color}`}>
                              {statusCfg.icon}
                              {statusCfg.label}
                            </span>
                          </div>
                          <p className="text-xs text-gray-500 mt-1">{formatDate(order.order_date)}</p>
                          {orderSamples.length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-2">
                              {orderSamples.map((sample) => (
                                <div key={`${sample.id}-sample-status`} className="text-xs">
                                  <span className={`inline-flex px-2 py-0.5 rounded-full font-medium ${getSampleStatusColor(sample.status)}`}>
                                    {sample.sample_type ? `${sample.sample_type}: ` : ''}{getSampleStatusLabel(sample.status)}
                                  </span>
                                  {sample.rejection_reason && (
                                    <div className="mt-1 max-w-sm rounded-md bg-red-50 px-2 py-1 text-red-700">
                                      {sample.rejection_reason}
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>

                        {/* Report Actions */}
                        <div className="flex items-center gap-2 flex-shrink-0">
                          {hasReport ? (
                            <>
                              <button
                                onClick={() => openReport(order.reports!.pdf_url!)}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg text-white bg-teal-600 hover:bg-teal-700 transition-colors"
                                title="View/Download report"
                              >
                                <FileText className="h-3.5 w-3.5" />
                                E-Copy
                              </button>
                              {order.reports?.print_pdf_url && (
                                <button
                                  onClick={() => openReport(order.reports!.print_pdf_url!)}
                                  className="inline-flex items-center justify-center p-1.5 rounded-lg text-white bg-teal-700 hover:bg-teal-800 transition-colors"
                                  title="Print version"
                                >
                                  <Printer className="h-3.5 w-3.5" />
                                </button>
                              )}
                            </>
                          ) : (
                            <span className="text-xs text-gray-400 italic">Report pending</span>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Home Collection Section */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200">
          <div className="p-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 bg-teal-50 rounded-lg flex items-center justify-center">
                <Home className="h-4 w-4 text-teal-600" />
              </div>
              <div>
                <p className="text-sm font-medium text-gray-900">Home Collection</p>
                <p className="text-xs text-gray-500">Book a sample collection at your doorstep</p>
              </div>
            </div>
            <button
              onClick={() => { setShowBookingForm(!showBookingForm); setBookingMessage(null); }}
              className="px-3 py-2 text-sm font-medium bg-teal-600 text-white rounded-lg hover:bg-teal-700 transition-colors"
            >
              {showBookingForm ? 'Close' : 'Book Now'}
            </button>
          </div>

          {showBookingForm && (
            <div className="px-4 pb-4 border-t border-gray-100">
              <form onSubmit={handleBookHomeCollection} className="mt-4 space-y-4">
                {bookingMessage && (
                  <div className={`flex items-center gap-2 p-3 rounded-lg text-sm ${bookingMessage.type === 'success' ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'}`}>
                    {bookingMessage.type === 'success'
                      ? <CheckCircle className="h-4 w-4 flex-shrink-0" />
                      : <AlertCircle className="h-4 w-4 flex-shrink-0" />}
                    {bookingMessage.text}
                  </div>
                )}

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1.5">Preferred Date</label>
                    <input
                      type="date"
                      value={bookingDate}
                      min={new Date().toISOString().split('T')[0]}
                      onChange={(e) => setBookingDate(e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1.5">Preferred Time</label>
                    <input
                      type="time"
                      value={bookingTime}
                      onChange={(e) => setBookingTime(e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
                      required
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1.5">Collection Address</label>
                  <textarea
                    value={bookingAddress}
                    onChange={(e) => setBookingAddress(e.target.value)}
                    rows={2}
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
                    placeholder="House / flat, street, landmark..."
                    required
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1.5">City</label>
                    <input
                      type="text"
                      value={bookingCity}
                      onChange={(e) => setBookingCity(e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
                      placeholder="City"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1.5">Pincode</label>
                    <input
                      type="text"
                      inputMode="numeric"
                      maxLength={6}
                      value={bookingPincode}
                      onChange={(e) => setBookingPincode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
                      placeholder="Pincode"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1.5">Tests Needed / Notes (optional)</label>
                  <textarea
                    value={bookingNotes}
                    onChange={(e) => setBookingNotes(e.target.value)}
                    rows={2}
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
                    placeholder="e.g. CBC, Thyroid profile — or doctor's prescription details"
                  />
                </div>

                <button
                  type="submit"
                  disabled={bookingLoading}
                  className="w-full py-2 text-sm font-medium bg-teal-600 text-white rounded-lg hover:bg-teal-700 disabled:bg-teal-300 disabled:cursor-not-allowed transition-colors"
                >
                  {bookingLoading ? 'Sending Request...' : 'Request Home Collection'}
                </button>
              </form>
            </div>
          )}

          {/* Existing requests */}
          {bookings.length > 0 && (
            <div className="px-4 pb-4 border-t border-gray-100">
              <p className="text-xs text-gray-500 mt-3 mb-2 font-medium">Your Requests</p>
              <div className="space-y-2">
                {bookings.map((b) => {
                  const statusCfg = BOOKING_STATUS_CONFIG[b.status] || { label: b.status, color: 'bg-gray-100 text-gray-700' };
                  const journeyCfg = b.collection_status ? JOURNEY_STATUS_CONFIG[b.collection_status] : null;
                  return (
                    <div key={b.id} className="border border-gray-200 rounded-lg p-3">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${statusCfg.color}`}>
                            {statusCfg.label}
                          </span>
                          {journeyCfg && (
                            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${journeyCfg.color}`}>
                              <Truck className="h-3 w-3" />
                              {journeyCfg.label}
                            </span>
                          )}
                        </div>
                        {b.scheduled_at && (
                          <span className="text-xs text-gray-500 flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            {new Date(b.scheduled_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                          </span>
                        )}
                      </div>
                      {b.assigned_phlebo_name && (
                        <p className="text-xs text-gray-600 mt-1.5">
                          Phlebotomist: <span className="font-medium">{b.assigned_phlebo_name}</span>
                        </p>
                      )}
                      {isEnRoute(b) && (
                        b.phlebo_last_lat != null && b.phlebo_last_lng != null ? (
                          <div className="mt-2">
                            <div className="flex items-center gap-3 flex-wrap">
                              <button
                                onClick={() => setTrackingOpenId(trackingOpenId === b.id ? null : b.id)}
                                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                              >
                                <Navigation className="h-3.5 w-3.5" />
                                {trackingOpenId === b.id ? 'Hide Live Location' : 'Track Phlebotomist Live'}
                              </button>
                              <a
                                href={`https://www.google.com/maps?q=${b.phlebo_last_lat},${b.phlebo_last_lng}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-xs text-blue-600 hover:text-blue-700 underline"
                              >
                                Open in Google Maps
                              </a>
                            </div>
                            {trackingOpenId === b.id && (
                              <div className="mt-2 rounded-lg overflow-hidden border border-gray-200">
                                <iframe
                                  title="Phlebotomist live location"
                                  src={`https://maps.google.com/maps?q=${b.phlebo_last_lat},${b.phlebo_last_lng}&z=15&output=embed`}
                                  className="w-full h-48 border-0"
                                  loading="lazy"
                                />
                                <p className="text-[11px] text-gray-500 px-2 py-1.5 bg-gray-50 flex items-center gap-1">
                                  <span className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse flex-shrink-0" />
                                  Location updated {timeAgo(b.phlebo_location_updated_at)} · refreshes automatically
                                </p>
                              </div>
                            )}
                          </div>
                        ) : (
                          <p className="text-xs text-blue-600 mt-2 flex items-center gap-1.5">
                            <Loader className="h-3 w-3 animate-spin" />
                            Phlebotomist is on the way — waiting for live location…
                          </p>
                        )
                      )}
                      {b.home_collection_address?.address && (
                        <p className="text-xs text-gray-500 mt-1 flex items-start gap-1">
                          <MapPin className="h-3 w-3 mt-0.5 flex-shrink-0" />
                          {b.home_collection_address.address}
                          {b.home_collection_address.city ? `, ${b.home_collection_address.city}` : ''}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Change PIN Section */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200">
          <button
            onClick={() => { setShowChangePIN(!showChangePIN); setPinMessage(null); }}
            className="w-full flex items-center justify-between p-4 text-left hover:bg-gray-50 transition-colors rounded-xl"
          >
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 bg-gray-100 rounded-lg flex items-center justify-center">
                <KeyRound className="h-4 w-4 text-gray-600" />
              </div>
              <div>
                <p className="text-sm font-medium text-gray-900">Change PIN</p>
                <p className="text-xs text-gray-500">Update your 6-digit login PIN</p>
              </div>
            </div>
            {showChangePIN ? <ChevronUp className="h-4 w-4 text-gray-400" /> : <ChevronDown className="h-4 w-4 text-gray-400" />}
          </button>

          {showChangePIN && (
            <div className="px-4 pb-4 border-t border-gray-100">
              <form onSubmit={handleChangePIN} className="mt-4 space-y-4">
                {pinMessage && (
                  <div className={`flex items-center gap-2 p-3 rounded-lg text-sm ${pinMessage.type === 'success' ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'}`}>
                    {pinMessage.type === 'success'
                      ? <CheckCircle className="h-4 w-4 flex-shrink-0" />
                      : <AlertCircle className="h-4 w-4 flex-shrink-0" />}
                    {pinMessage.text}
                  </div>
                )}

                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1.5">New PIN</label>
                  <div className="relative">
                    <input
                      type={showNewPin ? 'text' : 'password'}
                      inputMode="numeric"
                      maxLength={6}
                      value={newPin}
                      onChange={(e) => setNewPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-teal-500 focus:border-teal-500 font-mono tracking-widest pr-10"
                      placeholder="6-digit PIN"
                      required
                    />
                    <button type="button" onClick={() => setShowNewPin(!showNewPin)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                      {showNewPin ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1.5">Confirm New PIN</label>
                  <input
                    type="password"
                    inputMode="numeric"
                    maxLength={6}
                    value={confirmPin}
                    onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-teal-500 focus:border-teal-500 font-mono tracking-widest"
                    placeholder="Repeat PIN"
                    required
                  />
                </div>

                <button
                  type="submit"
                  disabled={pinLoading || newPin.length !== 6 || confirmPin.length !== 6}
                  className="w-full py-2 text-sm font-medium bg-teal-600 text-white rounded-lg hover:bg-teal-700 disabled:bg-teal-300 disabled:cursor-not-allowed transition-colors"
                >
                  {pinLoading ? 'Updating...' : 'Update PIN'}
                </button>
              </form>
            </div>
          )}
        </div>
      </main>
    </div>
  );
};

export default PatientPortal;
