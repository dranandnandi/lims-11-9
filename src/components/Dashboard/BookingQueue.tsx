import React, { useEffect, useState } from 'react';
import { Calendar, Clock, User, Phone, ArrowRight, Home, Building2, Globe, FileText, Plus, X, Eye, Trash2, UserCheck, MessageCircle, CheckCircle, MapPin, Truck } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { database, supabase } from '../../utils/supabase';
import { Booking } from '../../types';
import { format } from 'date-fns';
import CreateBookingModal from './CreateBookingModal';
import { WhatsAppAPI } from '../../utils/whatsappAPI';
import { jsPDF } from 'jspdf';

interface BookingQueueProps {
    onProcessBooking?: (booking: Booking) => void;
    onViewAll?: () => void;
    onCountChange?: (count: number) => void;
}

interface B2BAccountInfo {
    id: string;
    name: string;
    billing_phone?: string | null;
    contact_person?: string | null;
}

interface Phlebo {
    id: string;
    name: string;
    email: string;
    // User Management saves the number as `contact_number`; older rows use `phone`.
    phone?: string;
    contact_number?: string;
}

const phleboPhone = (p?: Phlebo) => p?.contact_number || p?.phone || undefined;

const BookingQueue: React.FC<BookingQueueProps> = ({ onProcessBooking, onViewAll, onCountChange }) => {
    const navigate = useNavigate();
    const [bookings, setBookings] = useState<Booking[]>([]);
    const [loading, setLoading] = useState(true);
    const [showCreateModal, setShowCreateModal] = useState(false);
    const [selectedBooking, setSelectedBooking] = useState<Booking | null>(null);
    const [cancelling, setCancelling] = useState<string | null>(null);

    // Phlebo state
    const [phlebos, setPhlebos] = useState<Phlebo[]>([]);
    const [selectedPhleboId, setSelectedPhleboId] = useState<string>('');
    const [assigningPhlebo, setAssigningPhlebo] = useState(false);
    const [phleboAssigned, setPhleboAssigned] = useState(false);

    // WhatsApp state
    const [sendingWA, setSendingWA] = useState<'patient' | 'phlebo' | 'b2b' | 'estimate' | null>(null);
    const [waSentTo, setWaSentTo] = useState<Set<string>>(new Set());

    // B2B account info cache (account_id -> info)
    const [b2bAccounts, setB2bAccounts] = useState<Record<string, B2BAccountInfo>>({});

    useEffect(() => {
        loadBookings();
        loadPhlebos();
    }, []);

    // Keep parent badge count in sync
    useEffect(() => {
        onCountChange?.(bookings.length);
    }, [bookings.length]);

    // Sync selected phlebo when modal opens
    useEffect(() => {
        if (selectedBooking) {
            setSelectedPhleboId(selectedBooking.assigned_phlebo_id || '');
            setPhleboAssigned(false);
            setWaSentTo(new Set());
        }
    }, [selectedBooking?.id]);

    const isB2BBooking = (booking: Booking) =>
        booking.booking_source === 'b2b_portal' || !!(booking.account_id || booking.b2b_client_id);

    const getB2BAccountId = (booking: Booking) => booking.account_id || booking.b2b_client_id || null;

    // Fetch B2B account contact details for visible B2B bookings
    useEffect(() => {
        const missingIds = [...new Set(
            bookings
                .filter(isB2BBooking)
                .map(getB2BAccountId)
                .filter((id): id is string => !!id)
        )].filter(id => !b2bAccounts[id]);

        if (missingIds.length === 0) return;

        supabase
            .from('accounts')
            .select('id, name, billing_phone, contact_person')
            .in('id', missingIds)
            .then(({ data }) => {
                if (data?.length) {
                    setB2bAccounts(prev => {
                        const next = { ...prev };
                        (data as B2BAccountInfo[]).forEach(acc => { next[acc.id] = acc; });
                        return next;
                    });
                }
            });
    }, [bookings]);

    const loadBookings = async () => {
        try {
            setLoading(true);
            const { data, error } = await database.bookings.list({ status: 'pending' });
            if (data) {
                const activeBookings = (data as Booking[]).filter(
                    b => !['converted', 'cancelled'].includes(b.status)
                );
                setBookings(activeBookings);
            }
        } catch (error) {
            console.error('Error loading bookings:', error);
        } finally {
            setLoading(false);
        }
    };

    const loadPhlebos = async () => {
        try {
            const { data } = await database.users.getPhlebotomists();
            if (data) setPhlebos(data as Phlebo[]);
        } catch (err) {
            console.error('Error loading phlebotomists:', err);
        }
    };

    const handleAssignPhlebo = async () => {
        if (!selectedBooking || !selectedPhleboId) return;
        const phlebo = phlebos.find(p => p.id === selectedPhleboId);
        if (!phlebo) return;

        try {
            setAssigningPhlebo(true);
            const { error } = await database.bookings.update(selectedBooking.id, {
                assigned_phlebo_id: selectedPhleboId,
                assigned_phlebo_name: phlebo.name,
                collection_status: 'assigned',
            });
            if (error) throw error;

            // Update local state
            setSelectedBooking(prev => prev ? {
                ...prev,
                assigned_phlebo_id: selectedPhleboId,
                assigned_phlebo_name: phlebo.name,
                collection_status: 'assigned' as const,
            } : null);
            setBookings(prev => prev.map(b => b.id === selectedBooking.id
                ? { ...b, assigned_phlebo_id: selectedPhleboId, assigned_phlebo_name: phlebo.name, collection_status: 'assigned' as const }
                : b
            ));
            setPhleboAssigned(true);
        } catch (err) {
            console.error('Error assigning phlebo:', err);
            alert('Failed to assign phlebotomist');
        } finally {
            setAssigningPhlebo(false);
        }
    };

    const buildPatientMessage = (booking: Booking, phleboName?: string) => {
        const patientName = booking.patient_info?.name || 'Patient';
        const scheduledStr = booking.scheduled_at
            ? format(new Date(booking.scheduled_at), 'dd MMM yyyy \'at\' hh:mm a')
            : 'your scheduled time';
        const address = booking.home_collection_address?.address || '';
        const tests = booking.test_details?.map(t => t.name).join(', ') || 'requested tests';

        let msg = `Hello ${patientName},\n\nYour home collection is confirmed for ${scheduledStr}.`;
        if (address) msg += `\n\nCollection address: ${address}`;
        if (phleboName) msg += `\n\nOur phlebotomist *${phleboName}* will visit you for sample collection.`;
        msg += `\n\nTests: ${tests}`;
        msg += `\n\nKindly be available at the time of collection. Thank you!`;
        return msg;
    };

    const formatCurrency = (amount?: number | null) => `Rs. ${Number(amount || 0).toLocaleString('en-IN')}`;

    const getJourneyLabel = (status?: string | null) => {
        if (status === 'started') return 'On the way';
        if (status === 'reached') return 'Reached';
        if (status === 'collected') return 'Collected';
        if (status === 'assigned') return 'Assigned';
        return '';
    };

    // Live location is only meaningful while en route and recently updated (< 30 min)
    const isLiveLocationFresh = (booking: Booking) => {
        if (booking.phlebo_last_lat == null || booking.phlebo_last_lng == null) return false;
        if (!['started', 'reached'].includes(booking.collection_status || '')) return false;
        if (!booking.phlebo_location_updated_at) return false;
        return Date.now() - new Date(booking.phlebo_location_updated_at).getTime() < 30 * 60 * 1000;
    };

    const formatLocationAge = (updatedAt?: string | null) => {
        if (!updatedAt) return '';
        const mins = Math.round((Date.now() - new Date(updatedAt).getTime()) / 60000);
        return mins <= 1 ? 'just now' : `${mins} min ago`;
    };

    const getEstimateAmount = (booking: Booking) => {
        const detailTotal = booking.test_details?.reduce((sum, test) => sum + Number(test.price || 0), 0) || 0;
        return Number(booking.quotation_amount || detailTotal || 0);
    };

    const getTestTypeLabel = (type?: string) => {
        if (type === 'package') return 'Package';
        if (type === 'note') return 'Note';
        return 'Test';
    };

    const buildEstimateMessage = (booking: Booking) => {
        const patientName = booking.patient_info?.name || 'Patient';
        const tests = booking.test_details || [];
        const lines = tests.length
            ? tests.map((test, index) => `${index + 1}. ${test.name}${test.price ? ` - ${formatCurrency(test.price)}` : ''}`).join('\n')
            : 'Tests will be confirmed by the lab.';

        return `Hello ${patientName},\n\nYour estimated amount is ${formatCurrency(getEstimateAmount(booking))}.\n\nRequested tests:\n${lines}\n\nThis is an estimate. Final billing may change after confirmation.\n\nThank you!`;
    };

    const createEstimatePdf = (booking: Booking) => {
        const doc = new jsPDF({ unit: 'pt', format: 'a4' });
        const margin = 44;
        let y = 52;
        const patientName = booking.patient_info?.name || 'Patient';
        const estimateAmount = getEstimateAmount(booking);

        doc.setFont('helvetica', 'bold');
        doc.setFontSize(18);
        doc.text('Booking Estimate', margin, y);

        y += 24;
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(10);
        doc.text(`Date: ${format(new Date(), 'dd MMM yyyy, hh:mm a')}`, margin, y);
        y += 18;
        doc.text(`Patient: ${patientName}`, margin, y);
        y += 16;
        doc.text(`Phone: ${booking.patient_info?.phone || 'N/A'}`, margin, y);
        y += 16;
        if (booking.scheduled_at) {
            doc.text(`Scheduled: ${format(new Date(booking.scheduled_at), 'dd MMM yyyy, hh:mm a')}`, margin, y);
            y += 16;
        }
        doc.text(`Collection: ${(booking.collection_type || 'walk_in').replace('_', ' ')}`, margin, y);

        y += 28;
        doc.setFont('helvetica', 'bold');
        doc.text('Item', margin, y);
        doc.text('Type', 330, y);
        doc.text('Amount', 455, y);
        y += 8;
        doc.line(margin, y, 552, y);
        y += 18;

        doc.setFont('helvetica', 'normal');
        (booking.test_details || []).forEach((test) => {
            const wrappedName = doc.splitTextToSize(test.name, 260);
            doc.text(wrappedName, margin, y);
            doc.text(getTestTypeLabel(test.type), 330, y);
            doc.text(test.price ? formatCurrency(test.price) : '-', 455, y);
            y += Math.max(18, wrappedName.length * 14);
        });

        if (!booking.test_details?.length) {
            doc.text('No tests selected', margin, y);
            y += 18;
        }

        y += 12;
        doc.line(margin, y, 552, y);
        y += 24;
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(14);
        doc.text('Estimated Total', 330, y);
        doc.text(formatCurrency(estimateAmount), 455, y);

        y += 36;
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(9);
        doc.text('Note: This is an estimate. Final billing may change after confirmation.', margin, y);

        return doc;
    };

    const getEstimateFileName = (booking: Booking) => {
        const safeName = (booking.patient_info?.name || 'Patient').replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '');
        return `Estimate_${safeName || 'Patient'}.pdf`;
    };

    const handleDownloadEstimatePdf = (booking: Booking) => {
        createEstimatePdf(booking).save(getEstimateFileName(booking));
    };

    const handleSendEstimatePdf = async () => {
        if (!selectedBooking) return;
        const phone = selectedBooking.patient_info?.phone;
        if (!phone) {
            alert('Patient phone number not available');
            return;
        }

        try {
            setSendingWA('estimate');
            const pdfBlob = createEstimatePdf(selectedBooking).output('blob');
            const pdfFile = new File([pdfBlob], getEstimateFileName(selectedBooking), { type: 'application/pdf' });
            const caption = buildEstimateMessage(selectedBooking);
            const result = await WhatsAppAPI.sendDocument(phone, pdfFile, {
                caption,
                patientName: selectedBooking.patient_info?.name || 'Patient',
                testName: 'Booking Estimate'
            });

            if (result.success) {
                setWaSentTo(prev => new Set([...prev, 'estimate']));
                return;
            }

            const textResult = await WhatsAppAPI.sendTextMessage(phone, caption);
            if (textResult.success) {
                setWaSentTo(prev => new Set([...prev, 'estimate']));
                alert('PDF send failed, so the estimate was sent as WhatsApp text.');
            } else {
                alert(`Failed to send estimate: ${result.message || textResult.message || 'Unknown error'}`);
            }
        } catch (err) {
            console.error('Estimate send error:', err);
            alert('Failed to send estimate');
        } finally {
            setSendingWA(null);
        }
    };

    const buildPhleboMessage = (booking: Booking, phleboName?: string) => {
        const patientName = booking.patient_info?.name || 'Patient';
        const patientPhone = booking.patient_info?.phone || '';
        const scheduledStr = booking.scheduled_at
            ? format(new Date(booking.scheduled_at), 'dd MMM yyyy \'at\' hh:mm a')
            : 'scheduled time';
        const address = booking.home_collection_address?.address || '';
        const tests = booking.test_details?.map(t => t.name).join(', ') || 'as requested';

        let msg = `Hi ${phleboName || 'Phlebotomist'},\n\nYou have a *home collection assignment*:\n`;
        msg += `\nPatient: *${patientName}*`;
        if (patientPhone) msg += `\nPhone: ${patientPhone}`;
        msg += `\nScheduled: ${scheduledStr}`;
        if (address) msg += `\nAddress: ${address}`;
        msg += `\nTests: ${tests}`;
        msg += `\n\nOpen ${window.location.origin}/phlebo to start your journey and share live location.`;
        msg += `\nPlease be on time. Thank you!`;
        return msg;
    };

    const buildB2BMessage = (booking: Booking, accountName?: string, phleboName?: string) => {
        const patientName = booking.patient_info?.name || 'Patient';
        const scheduledStr = booking.scheduled_at
            ? format(new Date(booking.scheduled_at), 'dd MMM yyyy \'at\' hh:mm a')
            : 'the scheduled time';
        const tests = booking.test_details?.map(t => t.name).join(', ') || 'requested tests';

        let msg = `Hello ${accountName || 'Partner'},\n\nUpdate on your booking for patient *${patientName}*.`;
        msg += `\n\nScheduled: ${scheduledStr}`;
        if (booking.collection_type === 'home_collection') {
            const address = booking.home_collection_address?.address || '';
            msg += `\nCollection: Home visit${address ? ` at ${address}` : ''}`;
            if (phleboName) msg += `\nPhlebotomist: *${phleboName}*`;
        }
        msg += `\nTests: ${tests}`;
        if (getEstimateAmount(booking) > 0) msg += `\nEstimate: ${formatCurrency(getEstimateAmount(booking))}`;
        msg += `\n\nWe will keep you posted on the progress. Thank you!`;
        return msg;
    };

    const handleSendWhatsApp = async (target: 'patient' | 'phlebo' | 'b2b') => {
        if (!selectedBooking) return;

        const phleboName = selectedBooking.assigned_phlebo_name ||
            phlebos.find(p => p.id === selectedPhleboId)?.name;

        let phone: string | undefined;
        let message: string;

        if (target === 'patient') {
            phone = selectedBooking.patient_info?.phone;
            message = buildPatientMessage(selectedBooking, phleboName);
        } else if (target === 'b2b') {
            const accountId = getB2BAccountId(selectedBooking);
            const account = accountId ? b2bAccounts[accountId] : undefined;
            phone = account?.billing_phone || undefined;
            message = buildB2BMessage(selectedBooking, account?.name, phleboName);
        } else {
            const phlebo = phlebos.find(p => p.id === (selectedBooking.assigned_phlebo_id || selectedPhleboId));
            phone = phleboPhone(phlebo);
            message = buildPhleboMessage(selectedBooking, phleboName);
        }

        if (!phone) {
            const who = target === 'patient' ? 'patient' : target === 'b2b' ? 'B2B account (set billing phone in Account Master)' : 'phlebotomist';
            alert(`No phone number found for ${who}`);
            return;
        }

        try {
            setSendingWA(target);
            const result = await WhatsAppAPI.sendTextMessage(phone, message);
            if (result.success) {
                setWaSentTo(prev => new Set([...prev, target]));
            } else {
                alert(`Failed to send WhatsApp: ${result.message || 'Unknown error'}`);
            }
        } catch (err) {
            console.error('WhatsApp send error:', err);
            alert('Failed to send WhatsApp message');
        } finally {
            setSendingWA(null);
        }
    };

    const handleCancelBooking = async (bookingId: string) => {
        if (!window.confirm('Are you sure you want to cancel this booking?')) return;

        try {
            setCancelling(bookingId);
            const { error } = await database.bookings.update(bookingId, {
                status: 'cancelled',
                updated_at: new Date().toISOString()
            });
            if (error) throw error;
            await loadBookings();
        } catch (error) {
            console.error('Error cancelling booking:', error);
            alert('Failed to cancel booking');
        } finally {
            setCancelling(null);
        }
    };

    const getSourceIcon = (source: string) => {
        switch (source) {
            case 'b2b_portal': return <Building2 className="w-4 h-4 text-blue-500" />;
            case 'front_desk': return <User className="w-4 h-4 text-green-500" />;
            case 'patient_app': return <Phone className="w-4 h-4 text-purple-500" />;
            case 'phone_call': return <Phone className="w-4 h-4 text-orange-500" />;
            case 'public_web': return <Globe className="w-4 h-4 text-teal-500" />;
            default: return <Globe className="w-4 h-4 text-gray-500" />;
        }
    };

    const getStatusColor = (status: string) => {
        switch (status) {
            case 'pending': return 'bg-yellow-100 text-yellow-800';
            case 'quoted': return 'bg-blue-100 text-blue-800';
            case 'confirmed': return 'bg-green-100 text-green-800';
            case 'converted': return 'bg-gray-100 text-gray-600';
            case 'cancelled': return 'bg-red-100 text-red-800';
            default: return 'bg-gray-100 text-gray-800';
        }
    };

    const currentPhlebo = phlebos.find(p => p.id === (selectedBooking?.assigned_phlebo_id || selectedPhleboId));
    const canSendPhleboWA = !!phleboPhone(currentPhlebo);
    const canSendPatientWA = !!(selectedBooking?.patient_info?.phone);
    const selectedB2BAccountId = selectedBooking ? getB2BAccountId(selectedBooking) : null;
    const selectedB2BAccount = selectedB2BAccountId ? b2bAccounts[selectedB2BAccountId] : undefined;
    const selectedIsB2B = !!selectedBooking && isB2BBooking(selectedBooking);
    const canSendB2BWA = !!selectedB2BAccount?.billing_phone;

    if (loading) {
        return (
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 flex items-center justify-center min-h-[200px]">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
            </div>
        );
    }

    return (
        <>
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 flex flex-col h-full">
                <div className="p-4 border-b border-gray-100 flex items-center justify-between">
                    <h3 className="font-semibold text-gray-800 flex items-center gap-2">
                        <Calendar className="w-5 h-5 text-primary-600" />
                        Booking Queue
                    </h3>
                    <div className="flex items-center gap-2">
                        <span className="text-xs font-medium bg-primary-50 text-primary-700 px-2.5 py-1 rounded-full">
                            {bookings.length} Pending
                        </span>
                        <button
                            onClick={() => setShowCreateModal(true)}
                            className="p-1.5 bg-primary-50 text-primary-600 rounded-lg hover:bg-primary-100 transition-colors"
                            title="Log Phone Booking"
                        >
                            <Plus className="w-4 h-4" />
                        </button>
                    </div>
                </div>

                <div className="flex-1 overflow-y-auto p-2 space-y-2 max-h-[400px]">
                    {bookings.length === 0 ? (
                        <div className="text-center py-8 text-gray-500 text-sm flex flex-col items-center gap-2">
                            <span>No pending bookings found.</span>
                            <button
                                onClick={() => setShowCreateModal(true)}
                                className="text-primary-600 font-medium hover:underline"
                            >
                                Log a call?
                            </button>
                        </div>
                    ) : (
                        bookings.map((booking) => (
                            <div
                                key={booking.id}
                                className="p-3 rounded-lg border border-gray-100 hover:border-primary-200 hover:shadow-sm transition-all bg-gray-50/50 group"
                            >
                                <div className="flex items-start justify-between mb-2">
                                    <div className="flex items-center gap-2 flex-wrap">
                                        {getSourceIcon(booking.booking_source)}
                                        <span className="font-medium text-gray-900">
                                            {booking.patient_info?.name || 'Unknown Patient'}
                                        </span>
                                        {isB2BBooking(booking) && (
                                            <span className="text-[10px] uppercase font-bold px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 inline-flex items-center gap-1">
                                                <Building2 className="w-3 h-3" />
                                                B2B
                                            </span>
                                        )}
                                        {booking.collection_type === 'home_collection' && (
                                            <span className="text-[10px] uppercase font-bold px-2 py-0.5 rounded-full bg-orange-100 text-orange-700 inline-flex items-center gap-1">
                                                <Home className="w-3 h-3" />
                                                Home Visit
                                            </span>
                                        )}
                                    </div>
                                    <span className={`text-[10px] uppercase font-bold px-2 py-0.5 rounded-full ${getStatusColor(booking.status)}`}>
                                        {booking.status}
                                    </span>
                                </div>

                                <div className="flex items-center gap-4 text-xs text-gray-500 mb-3">
                                    <div className="flex items-center gap-1">
                                        <Phone className="w-3 h-3" />
                                        {booking.patient_info?.phone || 'N/A'}
                                    </div>
                                    {booking.scheduled_at && (
                                        <div className="flex items-center gap-1">
                                            <Clock className="w-3 h-3" />
                                            {format(new Date(booking.scheduled_at), 'dd MMM, hh:mm a')}
                                        </div>
                                    )}
                                    {booking.collection_type !== 'home_collection' && (
                                        <div className="flex items-center gap-1">
                                            <span className="text-gray-400">Walk-in</span>
                                        </div>
                                    )}
                                </div>

                                <div className="flex items-center justify-between">
                                    <div className="text-xs text-gray-500">
                                        <span className="font-medium text-gray-700">{booking.test_details?.length || 0}</span> tests requested
                                        {getEstimateAmount(booking) > 0 && (
                                            <span className="ml-2 text-blue-600 font-semibold">
                                                Estimate {formatCurrency(getEstimateAmount(booking))}
                                            </span>
                                        )}
                                        {booking.assigned_phlebo_name && (
                                            <span className="ml-2 text-green-600 font-medium flex items-center gap-1 inline-flex">
                                                <UserCheck className="w-3 h-3" />
                                                {booking.assigned_phlebo_name}
                                            </span>
                                        )}
                                        {booking.collection_status && booking.collection_status !== 'assigned' && (
                                            <span className={`ml-2 font-medium items-center gap-1 inline-flex ${
                                                booking.collection_status === 'collected' ? 'text-green-600'
                                                : booking.collection_status === 'reached' ? 'text-purple-600'
                                                : 'text-blue-600'
                                            }`}>
                                                <Truck className="w-3 h-3" />
                                                {getJourneyLabel(booking.collection_status)}
                                            </span>
                                        )}
                                        {isLiveLocationFresh(booking) && (
                                            <a
                                                href={`https://www.google.com/maps?q=${booking.phlebo_last_lat},${booking.phlebo_last_lng}`}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="ml-2 text-red-600 font-medium items-center gap-1 inline-flex hover:underline"
                                                title={`Last updated ${formatLocationAge(booking.phlebo_location_updated_at)}`}
                                            >
                                                <MapPin className="w-3 h-3" />
                                                Live
                                            </a>
                                        )}
                                    </div>

                                    <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                        <button
                                            onClick={() => setSelectedBooking(booking)}
                                            className="text-xs font-medium text-gray-500 hover:text-gray-700 flex items-center gap-1"
                                            title="View Details"
                                        >
                                            <Eye className="w-3 h-3" />
                                        </button>
                                        <button
                                            onClick={() => handleCancelBooking(booking.id)}
                                            disabled={cancelling === booking.id}
                                            className="text-xs font-medium text-red-500 hover:text-red-700 flex items-center gap-1 disabled:opacity-50"
                                            title="Cancel Booking"
                                        >
                                            {cancelling === booking.id ? (
                                                <span className="animate-spin">⏳</span>
                                            ) : (
                                                <Trash2 className="w-3 h-3" />
                                            )}
                                        </button>
                                        <button
                                            onClick={() => onProcessBooking?.(booking)}
                                            className="text-xs font-medium text-primary-600 hover:text-primary-700 flex items-center gap-1"
                                        >
                                            Process <ArrowRight className="w-3 h-3" />
                                        </button>
                                    </div>
                                </div>
                            </div>
                        ))
                    )}
                </div>

                <div className="p-3 border-t border-gray-100 bg-gray-50 rounded-b-xl">
                    <button
                        onClick={() => onViewAll ? onViewAll() : navigate('/orders')}
                        className="w-full text-center text-xs font-medium text-gray-600 hover:text-primary-600 transition-colors"
                    >
                        View All Bookings
                    </button>
                </div>
            </div>

            {showCreateModal && (
                <CreateBookingModal
                    onClose={() => setShowCreateModal(false)}
                    onSuccess={() => {
                        setShowCreateModal(false);
                        loadBookings();
                    }}
                />
            )}

            {/* Booking Details Modal */}
            {selectedBooking && (
                <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                    <div className="bg-white rounded-xl shadow-xl w-full max-w-md overflow-hidden max-h-[90vh] flex flex-col">
                        <div className="flex items-center justify-between p-4 border-b border-gray-100 bg-gray-50 flex-shrink-0">
                            <h3 className="font-semibold text-gray-800 flex items-center gap-2 flex-wrap">
                                <FileText className="w-4 h-4 text-blue-600" />
                                Booking Details
                                {selectedIsB2B && (
                                    <span className="text-[10px] uppercase font-bold px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 inline-flex items-center gap-1">
                                        <Building2 className="w-3 h-3" />
                                        B2B
                                    </span>
                                )}
                                {selectedBooking.collection_type === 'home_collection' && (
                                    <span className="text-[10px] uppercase font-bold px-2 py-0.5 rounded-full bg-orange-100 text-orange-700 inline-flex items-center gap-1">
                                        <Home className="w-3 h-3" />
                                        Home Visit
                                    </span>
                                )}
                            </h3>
                            <button onClick={() => setSelectedBooking(null)} className="p-1 hover:bg-gray-200 rounded-full">
                                <X className="w-5 h-5 text-gray-500" />
                            </button>
                        </div>

                        <div className="p-4 space-y-4 overflow-y-auto">
                            {/* Patient Info */}
                            <div>
                                <h4 className="text-xs font-semibold text-gray-500 uppercase mb-2">Patient</h4>
                                <div className="bg-gray-50 rounded-lg p-3">
                                    <p className="font-medium text-gray-900">{selectedBooking.patient_info?.name || 'N/A'}</p>
                                    <p className="text-sm text-gray-600">{selectedBooking.patient_info?.phone || 'N/A'}</p>
                                    {selectedBooking.patient_info?.email && (
                                        <p className="text-sm text-gray-500">{selectedBooking.patient_info.email}</p>
                                    )}
                                </div>
                            </div>

                            {/* B2B Account Info */}
                            {selectedIsB2B && (
                                <div>
                                    <h4 className="text-xs font-semibold text-gray-500 uppercase mb-2 flex items-center gap-1">
                                        <Building2 className="w-3 h-3" />
                                        B2B Account
                                    </h4>
                                    <div className="bg-blue-50 rounded-lg p-3">
                                        <p className="font-medium text-blue-900">{selectedB2BAccount?.name || 'Loading account...'}</p>
                                        {selectedB2BAccount?.contact_person && (
                                            <p className="text-sm text-blue-700">{selectedB2BAccount.contact_person}</p>
                                        )}
                                        <p className="text-sm text-blue-700">
                                            {selectedB2BAccount?.billing_phone || 'No billing phone set (Account Master)'}
                                        </p>
                                    </div>
                                </div>
                            )}

                            {/* Booking Info */}
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <h4 className="text-xs font-semibold text-gray-500 uppercase mb-1">Source</h4>
                                    <div className="flex items-center gap-1">
                                        {getSourceIcon(selectedBooking.booking_source)}
                                        <span className="text-sm capitalize">
                                            {selectedBooking.booking_source === 'public_web'
                                                ? 'Online booking link'
                                                : selectedBooking.booking_source.replace('_', ' ')}
                                        </span>
                                    </div>
                                    {selectedBooking.public_reference && (
                                        <p className="text-xs font-mono text-gray-500 mt-0.5">
                                            Ref {selectedBooking.public_reference}
                                        </p>
                                    )}
                                </div>
                                <div>
                                    <h4 className="text-xs font-semibold text-gray-500 uppercase mb-1">Status</h4>
                                    <span className={`text-xs uppercase font-bold px-2 py-0.5 rounded-full ${getStatusColor(selectedBooking.status)}`}>
                                        {selectedBooking.status}
                                    </span>
                                </div>
                                <div>
                                    <h4 className="text-xs font-semibold text-gray-500 uppercase mb-1">Collection</h4>
                                    <span className="text-sm capitalize">{selectedBooking.collection_type?.replace('_', ' ') || 'Walk-in'}</span>
                                </div>
                                <div>
                                    <h4 className="text-xs font-semibold text-gray-500 uppercase mb-1">Scheduled</h4>
                                    <span className="text-sm">
                                        {selectedBooking.scheduled_at
                                            ? format(new Date(selectedBooking.scheduled_at), 'dd MMM yyyy, hh:mm a')
                                            : 'Not scheduled'}
                                    </span>
                                </div>
                            </div>

                            {/* Note the patient typed on the public booking page */}
                            {typeof selectedBooking.source_meta?.notes === 'string' && selectedBooking.source_meta.notes && (
                                <div>
                                    <h4 className="text-xs font-semibold text-gray-500 uppercase mb-1">Patient's Note</h4>
                                    <p className="text-sm text-gray-700 bg-amber-50 border border-amber-200 rounded-lg p-3 whitespace-pre-wrap">
                                        {selectedBooking.source_meta.notes}
                                    </p>
                                </div>
                            )}

                            {/* Tests */}
                            {selectedBooking.test_details && selectedBooking.test_details.length > 0 && (
                                <div>
                                    <div className="flex items-center justify-between mb-2">
                                        <h4 className="text-xs font-semibold text-gray-500 uppercase">Requested Tests / Estimate</h4>
                                        {getEstimateAmount(selectedBooking) > 0 && (
                                            <span className="text-sm font-bold text-blue-700">{formatCurrency(getEstimateAmount(selectedBooking))}</span>
                                        )}
                                    </div>
                                    <div className="bg-gray-50 rounded-lg p-3 space-y-2">
                                        {selectedBooking.test_details.map((test, i) => (
                                            <div key={i} className="flex items-center justify-between gap-3 text-sm">
                                                <span className="min-w-0">
                                                    <span className="font-medium text-gray-800">{test.name}</span>
                                                    <span className="ml-2 rounded-full bg-white px-1.5 py-0.5 text-[10px] uppercase text-gray-500">
                                                        {getTestTypeLabel(test.type)}
                                                    </span>
                                                </span>
                                                <span className="shrink-0 text-gray-600">{test.price ? formatCurrency(test.price) : '-'}</span>
                                            </div>
                                        ))}
                                    </div>
                                    <div className="mt-2 flex gap-2">
                                        <button
                                            type="button"
                                            onClick={() => handleDownloadEstimatePdf(selectedBooking)}
                                            className="flex-1 px-3 py-2 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-lg border border-blue-100"
                                        >
                                            Estimate PDF
                                        </button>
                                        <button
                                            type="button"
                                            onClick={handleSendEstimatePdf}
                                            disabled={!canSendPatientWA || sendingWA === 'estimate'}
                                            className={`flex-1 px-3 py-2 text-xs font-medium rounded-lg border disabled:opacity-50 disabled:cursor-not-allowed ${
                                                waSentTo.has('estimate')
                                                    ? 'bg-green-50 border-green-300 text-green-700'
                                                    : 'bg-white border-gray-200 text-gray-700 hover:bg-green-50 hover:border-green-300'
                                            }`}
                                        >
                                            {sendingWA === 'estimate' ? 'Sending...' : waSentTo.has('estimate') ? 'Estimate Sent' : 'Send Estimate'}
                                        </button>
                                    </div>
                                </div>
                            )}

                            {/* Home Collection Address */}
                            {selectedBooking.collection_type === 'home_collection' && selectedBooking.home_collection_address && (
                                <div>
                                    <h4 className="text-xs font-semibold text-gray-500 uppercase mb-2">Collection Address</h4>
                                    <div className="bg-orange-50 rounded-lg p-3 text-sm text-orange-800">
                                        {selectedBooking.home_collection_address.address}
                                        {selectedBooking.home_collection_address.city && `, ${selectedBooking.home_collection_address.city}`}
                                        {selectedBooking.home_collection_address.pincode && ` - ${selectedBooking.home_collection_address.pincode}`}
                                    </div>
                                </div>
                            )}

                            {/* Collection Journey */}
                            {selectedBooking.collection_type === 'home_collection' && selectedBooking.collection_status && (
                                <div>
                                    <h4 className="text-xs font-semibold text-gray-500 uppercase mb-2 flex items-center gap-1">
                                        <Truck className="w-3 h-3" />
                                        Collection Journey
                                    </h4>
                                    <div className="bg-gray-50 rounded-lg p-3 space-y-1.5 text-sm">
                                        {[
                                            { key: 'assigned', label: 'Phlebotomist assigned', at: null },
                                            { key: 'started', label: 'Journey started', at: selectedBooking.collection_started_at },
                                            { key: 'reached', label: 'Reached patient location', at: selectedBooking.collection_reached_at },
                                            { key: 'collected', label: 'Sample collected', at: selectedBooking.collection_collected_at },
                                        ].map((step) => {
                                            const order = ['assigned', 'started', 'reached', 'collected'];
                                            const done = order.indexOf(selectedBooking.collection_status || '') >= order.indexOf(step.key);
                                            return (
                                                <div key={step.key} className={`flex items-center justify-between gap-2 ${done ? 'text-gray-800' : 'text-gray-400'}`}>
                                                    <span className="flex items-center gap-2">
                                                        <CheckCircle className={`w-3.5 h-3.5 ${done ? 'text-green-600' : 'text-gray-300'}`} />
                                                        {step.label}
                                                    </span>
                                                    {step.at && done && (
                                                        <span className="text-xs text-gray-500">{format(new Date(step.at), 'hh:mm a')}</span>
                                                    )}
                                                </div>
                                            );
                                        })}
                                        {isLiveLocationFresh(selectedBooking) && (
                                            <a
                                                href={`https://www.google.com/maps?q=${selectedBooking.phlebo_last_lat},${selectedBooking.phlebo_last_lng}`}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="mt-2 flex items-center gap-1.5 text-sm font-medium text-red-600 hover:underline"
                                            >
                                                <MapPin className="w-4 h-4" />
                                                View live location (updated {formatLocationAge(selectedBooking.phlebo_location_updated_at)})
                                            </a>
                                        )}
                                    </div>
                                </div>
                            )}

                            {/* Phlebotomist Assignment */}
                            <div>
                                <h4 className="text-xs font-semibold text-gray-500 uppercase mb-2 flex items-center gap-1">
                                    <UserCheck className="w-3 h-3" />
                                    Assign Phlebotomist
                                </h4>
                                <div className="flex gap-2">
                                    <select
                                        value={selectedPhleboId}
                                        onChange={e => { setSelectedPhleboId(e.target.value); setPhleboAssigned(false); }}
                                        className="flex-1 text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-primary-300"
                                    >
                                        <option value="">-- Select Phlebotomist --</option>
                                        {phlebos.map(p => (
                                            <option key={p.id} value={p.id}>{p.name}</option>
                                        ))}
                                    </select>
                                    <button
                                        onClick={handleAssignPhlebo}
                                        disabled={!selectedPhleboId || assigningPhlebo}
                                        className="px-3 py-2 text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1 whitespace-nowrap"
                                    >
                                        {assigningPhlebo ? (
                                            <span className="animate-spin">⏳</span>
                                        ) : phleboAssigned ? (
                                            <><CheckCircle className="w-4 h-4" /> Assigned</>
                                        ) : (
                                            'Assign'
                                        )}
                                    </button>
                                </div>
                                {selectedBooking.assigned_phlebo_name && (
                                    <p className="mt-1.5 text-xs text-green-600 flex items-center gap-1">
                                        <CheckCircle className="w-3 h-3" />
                                        Currently assigned: <span className="font-medium">{selectedBooking.assigned_phlebo_name}</span>
                                    </p>
                                )}
                                {phlebos.length === 0 && (
                                    <p className="mt-1.5 text-xs text-gray-400">No phlebotomists found. Mark users as phlebotomists in User Settings.</p>
                                )}
                            </div>

                            {/* WhatsApp Notifications */}
                            <div>
                                <h4 className="text-xs font-semibold text-gray-500 uppercase mb-2 flex items-center gap-1">
                                    <MessageCircle className="w-3 h-3" />
                                    Send WhatsApp Notification
                                </h4>
                                <div className="flex gap-2">
                                    <button
                                        onClick={() => handleSendWhatsApp('patient')}
                                        disabled={!canSendPatientWA || sendingWA === 'patient'}
                                        title={!canSendPatientWA ? 'Patient phone number not available' : 'Notify patient about home collection'}
                                        className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg border transition-colors
                                            ${waSentTo.has('patient')
                                                ? 'bg-green-50 border-green-300 text-green-700'
                                                : 'bg-white border-gray-200 text-gray-700 hover:bg-green-50 hover:border-green-300 hover:text-green-700'}
                                            disabled:opacity-50 disabled:cursor-not-allowed`}
                                    >
                                        {sendingWA === 'patient' ? (
                                            <span className="animate-spin text-xs">⏳</span>
                                        ) : waSentTo.has('patient') ? (
                                            <CheckCircle className="w-4 h-4 text-green-600" />
                                        ) : (
                                            <MessageCircle className="w-4 h-4 text-green-600" />
                                        )}
                                        {waSentTo.has('patient') ? 'Sent to Patient' : 'Notify Patient'}
                                    </button>

                                    <button
                                        onClick={() => handleSendWhatsApp('phlebo')}
                                        disabled={!canSendPhleboWA || sendingWA === 'phlebo' || !(selectedBooking.assigned_phlebo_id || selectedPhleboId)}
                                        title={
                                            !(selectedBooking.assigned_phlebo_id || selectedPhleboId)
                                                ? 'Assign a phlebotomist first'
                                                : !canSendPhleboWA
                                                    ? 'Phlebotomist has no phone number'
                                                    : 'Notify phlebotomist about assignment'
                                        }
                                        className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg border transition-colors
                                            ${waSentTo.has('phlebo')
                                                ? 'bg-blue-50 border-blue-300 text-blue-700'
                                                : 'bg-white border-gray-200 text-gray-700 hover:bg-blue-50 hover:border-blue-300 hover:text-blue-700'}
                                            disabled:opacity-50 disabled:cursor-not-allowed`}
                                    >
                                        {sendingWA === 'phlebo' ? (
                                            <span className="animate-spin text-xs">⏳</span>
                                        ) : waSentTo.has('phlebo') ? (
                                            <CheckCircle className="w-4 h-4 text-blue-600" />
                                        ) : (
                                            <MessageCircle className="w-4 h-4 text-blue-600" />
                                        )}
                                        {waSentTo.has('phlebo') ? 'Sent to Phlebo' : 'Notify Phlebo'}
                                    </button>

                                    {selectedIsB2B && (
                                        <button
                                            onClick={() => handleSendWhatsApp('b2b')}
                                            disabled={!canSendB2BWA || sendingWA === 'b2b'}
                                            title={!canSendB2BWA ? 'Client has no billing phone (set it in Account Master)' : 'Notify client about this booking'}
                                            className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg border transition-colors
                                                ${waSentTo.has('b2b')
                                                    ? 'bg-indigo-50 border-indigo-300 text-indigo-700'
                                                    : 'bg-white border-gray-200 text-gray-700 hover:bg-indigo-50 hover:border-indigo-300 hover:text-indigo-700'}
                                                disabled:opacity-50 disabled:cursor-not-allowed`}
                                        >
                                            {sendingWA === 'b2b' ? (
                                                <span className="animate-spin text-xs">⏳</span>
                                            ) : waSentTo.has('b2b') ? (
                                                <CheckCircle className="w-4 h-4 text-indigo-600" />
                                            ) : (
                                                <Building2 className="w-4 h-4 text-indigo-600" />
                                            )}
                                            {waSentTo.has('b2b') ? 'Sent to Client' : 'Notify Client'}
                                        </button>
                                    )}
                                </div>
                                {!(selectedBooking.assigned_phlebo_id || selectedPhleboId) ? (
                                    <p className="mt-1.5 text-xs text-amber-600">Assign a phlebotomist to enable phlebo notification.</p>
                                ) : !currentPhlebo ? (
                                    <p className="mt-1.5 text-xs text-amber-600">Assigned phlebotomist is inactive or no longer marked as a phlebotomist — reassign to enable phlebo notification.</p>
                                ) : !canSendPhleboWA ? (
                                    <p className="mt-1.5 text-xs text-amber-600">{currentPhlebo.name} has no contact number — set it in User Management to enable phlebo notification.</p>
                                ) : null}
                                {selectedIsB2B && !canSendB2BWA && (
                                    <p className="mt-1.5 text-xs text-amber-600">Client has no billing phone — set it in Masters → Accounts to enable client notification.</p>
                                )}
                            </div>
                        </div>

                        {/* Actions */}
                        <div className="flex gap-2 p-4 border-t border-gray-100 flex-shrink-0">
                            <button
                                onClick={() => {
                                    handleCancelBooking(selectedBooking.id);
                                    setSelectedBooking(null);
                                }}
                                className="flex-1 px-4 py-2 text-sm font-medium text-red-600 bg-red-50 hover:bg-red-100 rounded-lg"
                            >
                                Cancel Booking
                            </button>
                            <button
                                onClick={() => {
                                    onProcessBooking?.(selectedBooking);
                                    setSelectedBooking(null);
                                }}
                                className="flex-1 px-4 py-2 text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 rounded-lg"
                            >
                                Process → Order
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
};

export default BookingQueue;
