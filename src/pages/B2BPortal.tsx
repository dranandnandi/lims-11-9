import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { LogOut, Download, Filter, Search, Calendar, RefreshCw, PlusCircle, X, Clock, User, Phone, Trash2, Printer, FileText, Wallet, CreditCard, Receipt, Loader2, CheckCircle, AlertCircle, BarChart3, Building2, ChevronLeft, ChevronRight, ChevronDown, Megaphone, MessageSquare, Package, Image as ImageIcon } from 'lucide-react';
import { supabase } from '../utils/supabase';
import { getCurrentB2BAccount } from '../utils/b2bAuth';
import B2BBookingModal from '../components/B2B/B2BBookingModal';
import B2BResultAnalysisModal from '../components/B2B/B2BResultAnalysisModal';
import AccountInfoCard from '../components/B2B/AccountInfoCard';
import PartnerChatPanel from '../components/B2B/PartnerChatPanel';
import MaterialRequestPanel from '../components/B2B/MaterialRequestPanel';
import { fetchAccountUnreadCount } from '../utils/partnerCommsService';
import { computeAvailableCredit, fetchReceiptCreditTotal } from '../utils/accountCredit';
import { format } from 'date-fns';
import type { InitiatePaymentResponse } from '../types/payment';

const PAYMENT_FUNCTIONS_BASE_URL =
    import.meta.env.VITE_PAYMENT_FUNCTIONS_BASE_URL ||
    (window.location.hostname === 'app.limsapp.in'
        ? 'https://api.limsapp.in'
        : import.meta.env.VITE_SUPABASE_URL);

const PAYMENT_CALLBACK_URL =
    import.meta.env.VITE_CCAVENUE_CALLBACK_URL ||
    `${PAYMENT_FUNCTIONS_BASE_URL}/functions/v1/payment-callback?provider=ccavenue`;

const PAYMENT_CANCEL_URL =
    import.meta.env.VITE_PAYMENT_CANCEL_URL ||
    `${window.location.origin}/b2b/payment/cancelled`;

const getBookingAmount = (booking: any): number => {
    const quoted = Number(booking?.quotation_amount);
    if (Number.isFinite(quoted) && quoted > 0) return quoted;

    const tests = Array.isArray(booking?.test_details) ? booking.test_details : [];
    return tests.reduce((sum: number, item: any) => {
        const price = Number(item?.price);
        return sum + (Number.isFinite(price) ? price : 0);
    }, 0);
};

interface Order {
    id: string;
    order_display?: string | null;
    order_number?: number | null;
    patient_name: string;
    patient_id: string;
    status: string;
    priority: string;
    order_date: string;
    expected_date: string;
    total_amount: number;
    final_amount?: number;
    billing_status?: string | null;
    is_billed?: boolean | null;
    sample_id?: string;
    color_code?: string;
    color_name?: string;
    reports?: {
        id: string;
        pdf_url?: string;
        print_pdf_url?: string;
        status: string;
        generated_date?: string;
    } | null;
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

type OrderSortMode = 'sample_desc' | 'sample_asc' | 'order_id_asc' | 'order_id_desc' | 'date_desc' | 'patient_az';

interface PaymentAttempt {
    id: string;
    amount: number;
    currency?: string;
    provider?: string;
    payment_purpose?: string;
    status: string;
    gateway_order_id?: string;
    gateway_tracking_id?: string;
    gateway_payment_id?: string;
    payment_method?: string;
    completed_at?: string;
    created_at?: string;
}

interface ConsolidatedInvoice {
    id: string;
    invoice_number: string;
    billing_period_start?: string;
    billing_period_end?: string;
    total_amount: number;
    paid_amount?: number;
    due_amount?: number;
    status: string;
    due_date?: string;
    pdf_url?: string;
    paid_at?: string;
    created_at?: string;
}

interface PortalUpdateSlide {
    title: string;
    message: string;
    image_url?: string;
}

interface PortalAnnouncement {
    title: string;
    message: string;
}

interface PortalSettings {
    welcome_note: string;
    updates_enabled: boolean;
    updates_title: string;
    update_slides: PortalUpdateSlide[];
    announcements_enabled: boolean;
    announcements_title: string;
    announcement_slides: PortalAnnouncement[];
    slider_aspect: 'square' | 'landscape' | 'banner';
    hide_lims_branding: boolean;
}

const normalizePortalSettings = (raw: any): PortalSettings => {
    const updateSlides = Array.isArray(raw?.update_slides) ? raw.update_slides : [];
    const announcementSlides = Array.isArray(raw?.announcement_slides) ? raw.announcement_slides : [];
    return {
        welcome_note: String(raw?.welcome_note || '').trim(),
        updates_enabled: raw?.updates_enabled !== false,
        updates_title: String(raw?.updates_title || 'Partner Portal Updates').trim() || 'Partner Portal Updates',
        update_slides: updateSlides
            .map((slide: any) => ({
                title: String(slide?.title || '').trim(),
                message: String(slide?.message || '').trim(),
                image_url: String(slide?.image_url || '').trim(),
            }))
            .filter((slide: PortalUpdateSlide) => slide.title || slide.message || slide.image_url),
        announcements_enabled: raw?.announcements_enabled !== false,
        announcements_title: String(raw?.announcements_title || 'Announcements').trim() || 'Announcements',
        announcement_slides: announcementSlides
            .map((slide: any) => ({
                title: String(slide?.title || '').trim(),
                message: String(slide?.message || '').trim(),
            }))
            .filter((slide: PortalAnnouncement) => slide.title || slide.message),
        slider_aspect: ['square', 'landscape', 'banner'].includes(String(raw?.slider_aspect))
            ? raw.slider_aspect
            : 'square',
        hide_lims_branding: raw?.hide_lims_branding === true,
    };
};

const B2BPortal: React.FC = () => {
    const navigate = useNavigate();
    const [account, setAccount] = useState<any>(null);
    const [orders, setOrders] = useState<Order[]>([]);
    const [filteredOrders, setFilteredOrders] = useState<Order[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchTerm, setSearchTerm] = useState('');
    const [statusFilter, setStatusFilter] = useState('All');
    const [dateRange, setDateRange] = useState({ from: '', to: '' });
    const [showBookingModal, setShowBookingModal] = useState(false);
    const [pendingBookings, setPendingBookings] = useState<any[]>([]);
    const [cancellingBooking, setCancellingBooking] = useState<string | null>(null);
    const [payments, setPayments] = useState<PaymentAttempt[]>([]);
    const [paymentCreditTotal, setPaymentCreditTotal] = useState(0);
    // Cash / cheque / bank payments recorded by the lab from Account Master
    const [manualCreditTotal, setManualCreditTotal] = useState(0);
    const [invoices, setInvoices] = useState<ConsolidatedInvoice[]>([]);
    const [outstandingInvoiceAmount, setOutstandingInvoiceAmount] = useState(0);
    const [topUpAmount, setTopUpAmount] = useState('');
    const [topUpAmountEdited, setTopUpAmountEdited] = useState(false);
    const [paymentLoading, setPaymentLoading] = useState(false);
    const [paymentError, setPaymentError] = useState<string | null>(null);
    const [sortMode, setSortMode] = useState<OrderSortMode>(() =>
        (localStorage.getItem('b2b-order-sort') as OrderSortMode) || 'sample_desc'
    );
    const [selectedOrderIds, setSelectedOrderIds] = useState<Set<string>>(new Set());
    const [showResultAnalysis, setShowResultAnalysis] = useState(false);
    const [labInfo, setLabInfo] = useState<{ name: string; logo: string | null; portalSettings: PortalSettings } | null>(null);
    const [activeUpdateIndex, setActiveUpdateIndex] = useState(0);
    const [activeAnnouncementIndex, setActiveAnnouncementIndex] = useState(0);
    // Support sections stay collapsed so reports and billing keep the top of the page
    const [showChatSection, setShowChatSection] = useState(false);
    const [showMaterialSection, setShowMaterialSection] = useState(false);
    const [chatUnreadCount, setChatUnreadCount] = useState(0);

    // Load account and orders
    useEffect(() => {
        loadData();
    }, []);

    // Apply filters
    useEffect(() => {
        applyFilters();
    }, [orders, searchTerm, statusFilter, dateRange, sortMode]);

    const portalSettings = normalizePortalSettings(labInfo?.portalSettings);
    const imageSlides = portalSettings.update_slides.filter((slide) => slide.image_url);
    // Text-only slides saved before dedicated announcements existed keep showing as announcements
    const announcements = portalSettings.announcement_slides.length > 0
        ? portalSettings.announcement_slides
        : portalSettings.update_slides.filter((slide) => !slide.image_url);
    const activeImageSlide = imageSlides[activeUpdateIndex] || imageSlides[0];
    const activeAnnouncement = announcements[activeAnnouncementIndex] || announcements[0];

    useEffect(() => {
        if (activeUpdateIndex >= imageSlides.length) {
            setActiveUpdateIndex(0);
        }
    }, [activeUpdateIndex, imageSlides.length]);

    useEffect(() => {
        if (activeAnnouncementIndex >= announcements.length) {
            setActiveAnnouncementIndex(0);
        }
    }, [activeAnnouncementIndex, announcements.length]);

    // Auto-rotate the promotional image carousel
    useEffect(() => {
        if (imageSlides.length < 2) return;
        const timer = window.setInterval(() => {
            setActiveUpdateIndex((prev) => (prev + 1) % imageSlides.length);
        }, 6000);
        return () => window.clearInterval(timer);
    }, [imageSlides.length]);

    const loadData = async () => {
        try {
            setLoading(true);

            // Get account info
            const accountData = await getCurrentB2BAccount();
            if (!accountData) {
                alert('Unable to load account information');
                handleLogout();
                return;
            }
            setAccount(accountData);

            // Fetch lab info for header display
            if (accountData.lab_id) {
                const { data: labData } = await supabase
                    .from('labs')
                    .select('name, portal_settings')
                    .eq('id', accountData.lab_id)
                    .single();

                // Fetch lab logo (prefer default, fallback to any logo)
                const { data: logoAssets } = await supabase
                    .from('lab_branding_assets')
                    .select('file_url, is_default')
                    .eq('lab_id', accountData.lab_id)
                    .eq('asset_type', 'logo')
                    .order('is_default', { ascending: false })
                    .limit(1);

                if (labData) {
                    setLabInfo({
                        name: labData.name,
                        logo: logoAssets?.[0]?.file_url || null,
                        portalSettings: normalizePortalSettings((labData as any).portal_settings),
                    });
                }
            }

            // Fetch orders for this account
            // Note: Don't join with patients table - B2B users don't have access
            // patient_name is already in the orders table
            const { data: ordersData, error } = await supabase
                .from('orders')
                .select(`
                    *,
                    samples(id, barcode, sample_type, status, collected_at, received_at, rejected_at, rejection_reason),
                    reports(id, pdf_url, print_pdf_url, status, generated_date)
                `)
                .eq('account_id', accountData.id)
                .order('order_date', { ascending: false });

            if (error) {
                console.error('Error fetching orders:', error);
                alert('Failed to load orders');
                return;
            }

            setOrders(ordersData || []);

            // Fetch pending bookings for this account
            const { data: bookingsData, error: bookingsError } = await supabase
                .from('bookings')
                .select('*')
                .eq('account_id', accountData.id)
                .in('status', ['pending', 'quoted', 'confirmed'])
                .order('created_at', { ascending: false });

            if (!bookingsError && bookingsData) {
                setPendingBookings(bookingsData);
            }

            const { data: paymentsData, error: paymentsError } = await supabase
                .from('b2b_payment_attempts')
                .select('id, amount, currency, provider, payment_purpose, status, gateway_order_id, gateway_tracking_id, gateway_payment_id, payment_method, completed_at, created_at')
                .eq('account_id', accountData.id)
                .eq('status', 'success')
                .order('completed_at', { ascending: false })
                .limit(5);

            if (paymentsError) {
                console.error('Error fetching payment history:', paymentsError);
            } else {
                setPayments(paymentsData || []);
            }

            const { data: paymentCreditData, error: paymentCreditError } = await supabase
                .from('b2b_payment_attempts')
                .select('amount')
                .eq('account_id', accountData.id)
                .eq('status', 'success')
                .eq('credit_applied', true);

            if (paymentCreditError) {
                console.error('Error fetching payment credit total:', paymentCreditError);
            } else {
                const totalCredit = (paymentCreditData || []).reduce((sum, payment) => {
                    const amount = Number(payment.amount);
                    return sum + (Number.isFinite(amount) ? amount : 0);
                }, 0);
                setPaymentCreditTotal(totalCredit);
            }

            setManualCreditTotal(await fetchReceiptCreditTotal(accountData.id));

            const { data: invoicesData, error: invoicesError } = await supabase
                .from('consolidated_invoices')
                .select('id, invoice_number, billing_period_start, billing_period_end, total_amount, status, due_date, pdf_url, paid_at, created_at')
                .eq('account_id', accountData.id)
                .order('billing_period_start', { ascending: false })
                .limit(5);

            if (invoicesError) {
                console.error('Error fetching bills:', invoicesError);
            } else {
                setInvoices(invoicesData || []);
            }

            const { data: allInvoiceData, error: allInvoiceError } = await supabase
                .from('consolidated_invoices')
                .select('total_amount, status')
                .eq('account_id', accountData.id)
                .eq('lab_id', accountData.lab_id);

            if (allInvoiceError) {
                console.error('Error fetching outstanding bill total:', allInvoiceError);
            } else {
                const totalOutstanding = (allInvoiceData || [])
                    .filter((invoice) => {
                        const status = String(invoice.status || '').toLowerCase();
                        return status !== 'paid' && status !== 'cancelled';
                    })
                    .reduce((sum, invoice) => {
                        const amount = Number(invoice.total_amount);
                        return sum + (Number.isFinite(amount) ? amount : 0);
                    }, 0);
                setOutstandingInvoiceAmount(totalOutstanding);
            }

            setChatUnreadCount(await fetchAccountUnreadCount(accountData.id));
        } catch (error) {
            console.error('Error loading data:', error);
            alert('An error occurred while loading data');
        } finally {
            setLoading(false);
        }
    };

    const handleCancelBooking = async (bookingId: string) => {
        if (!window.confirm('Are you sure you want to cancel this booking?')) return;
        
        try {
            setCancellingBooking(bookingId);
            const { error } = await supabase
                .from('bookings')
                .update({ status: 'cancelled', updated_at: new Date().toISOString() })
                .eq('id', bookingId);
            
            if (error) throw error;
            
            // Refresh bookings
            setPendingBookings(prev => prev.filter(b => b.id !== bookingId));
        } catch (error) {
            console.error('Error cancelling booking:', error);
            alert('Failed to cancel booking');
        } finally {
            setCancellingBooking(null);
        }
    };

    const applyFilters = () => {
        let filtered = [...orders];

        // Search filter
        if (searchTerm) {
            const search = searchTerm.toLowerCase();
            filtered = filtered.filter(
                (order) =>
                    order.sample_id?.toLowerCase().includes(search) ||
                    (order.samples || []).some((sample) =>
                        sample.id?.toLowerCase().includes(search) ||
                        sample.barcode?.toLowerCase().includes(search) ||
                        sample.sample_type?.toLowerCase().includes(search)
                    ) ||
                    order.patient_name?.toLowerCase().includes(search) ||
                    order.id.toLowerCase().includes(search)
            );
        }

        // Status filter
        if (statusFilter !== 'All') {
            filtered = filtered.filter((order) => order.status === statusFilter);
        }

        // Date range filter
        if (dateRange.from) {
            filtered = filtered.filter((order) => order.order_date >= dateRange.from);
        }
        if (dateRange.to) {
            filtered = filtered.filter((order) => order.order_date <= dateRange.to);
        }

        const dailySequence = (order: Order) => {
            if (typeof order.order_number === 'number' && Number.isFinite(order.order_number)) return order.order_number;
            const firstSample = order.samples?.[0]?.barcode || order.samples?.[0]?.id || order.sample_id || '';
            const tail = String(firstSample).match(/(?:^|[/-])(\d+)\s*$/)?.[1];
            return tail ? Number(tail) : 0;
        };

        filtered.sort((a, b) => {
            if (sortMode === 'patient_az') return (a.patient_name || '').localeCompare(b.patient_name || '');
            if (sortMode === 'date_desc') return new Date(b.order_date).getTime() - new Date(a.order_date).getTime();
            if (sortMode === 'order_id_asc' || sortMode === 'order_id_desc') {
                const aRef = a.order_display || a.id;
                const bRef = b.order_display || b.id;
                return sortMode === 'order_id_asc'
                    ? aRef.localeCompare(bRef, undefined, { numeric: true })
                    : bRef.localeCompare(aRef, undefined, { numeric: true });
            }
            const difference = dailySequence(a) - dailySequence(b);
            return sortMode === 'sample_asc' ? difference : -difference;
        });

        setFilteredOrders(filtered);
    };

    const updateSortMode = (value: OrderSortMode) => {
        setSortMode(value);
        localStorage.setItem('b2b-order-sort', value);
    };

    const toggleOrderSelection = (orderId: string) => {
        setSelectedOrderIds((current) => {
            const next = new Set(current);
            if (next.has(orderId)) next.delete(orderId);
            else next.add(orderId);
            return next;
        });
    };

    const toggleAllVisibleOrders = () => {
        const visibleIds = filteredOrders.map((order) => order.id);
        const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedOrderIds.has(id));
        setSelectedOrderIds((current) => {
            const next = new Set(current);
            visibleIds.forEach((id) => allVisibleSelected ? next.delete(id) : next.add(id));
            return next;
        });
    };

    const handleLogout = async () => {
        await supabase.auth.signOut();
        navigate('/b2b');
    };

    const handleDownloadReport = (reportUrl: string) => {
        window.open(reportUrl, '_blank');
    };

    const handlePayNow = async () => {
        const amount = Number(topUpAmount);
        if (!account?.id || !account?.lab_id) return;
        if (!Number.isFinite(amount) || amount <= 0) {
            setPaymentError('Enter a valid payment amount');
            return;
        }

        setPaymentLoading(true);
        setPaymentError(null);

        try {
            const { data, error } = await supabase.functions.invoke<InitiatePaymentResponse>('initiate-payment', {
                body: {
                    account_id: account.id,
                    lab_id: account.lab_id,
                    amount,
                    purpose: 'credit_topup',
                    return_url: PAYMENT_CALLBACK_URL,
                    cancel_url: PAYMENT_CANCEL_URL,
                },
            });

            if (error) throw error;

            if (data?.redirect_required && data.gateway_url) {
                const form = document.createElement('form');
                form.method = data.form_method || 'POST';
                form.action = data.gateway_url;

                Object.entries(data.form_data || {}).forEach(([key, value]) => {
                    const input = document.createElement('input');
                    input.type = 'hidden';
                    input.name = key;
                    input.value = value;
                    form.appendChild(input);
                });

                document.body.appendChild(form);
                form.submit();
                return;
            }

            if (data?.razorpay_order_id) {
                openRazorpayCheckout(data);
                return;
            }

            setPaymentError('Payment gateway did not return a checkout option');
            setPaymentLoading(false);
        } catch (err: any) {
            console.error('Payment initiation error:', err);
            setPaymentError(err.message || 'Failed to initiate payment');
            setPaymentLoading(false);
        }
    };

    const openRazorpayCheckout = (paymentData: InitiatePaymentResponse) => {
        const startCheckout = () => {
            const options = {
                key: paymentData.razorpay_key_id,
                amount: (paymentData.amount || 0) * 100,
                currency: paymentData.currency || 'INR',
                name: paymentData.name || 'B2B Credit Top-up',
                description: paymentData.description || 'Account credit top-up',
                order_id: paymentData.razorpay_order_id,
                prefill: paymentData.prefill,
                notes: paymentData.notes,
                handler: async (response: any) => {
                    try {
                        const { data, error } = await supabase.functions.invoke('payment-callback/verify', {
                            body: {
                                razorpay_order_id: response.razorpay_order_id,
                                razorpay_payment_id: response.razorpay_payment_id,
                                razorpay_signature: response.razorpay_signature,
                                payment_id: paymentData.payment_id,
                            },
                        });

                        if (error) throw error;

                        if (data?.success) {
                            setTopUpAmount('');
                            await loadData();
                        } else {
                            setPaymentError('Payment verification failed');
                        }
                    } catch (err: any) {
                        setPaymentError(err.message || 'Payment verification failed');
                    } finally {
                        setPaymentLoading(false);
                    }
                },
                modal: {
                    ondismiss: () => setPaymentLoading(false),
                },
            };

            const rzp = new (window as any).Razorpay(options);
            rzp.open();
        };

        if ((window as any).Razorpay) {
            startCheckout();
            return;
        }

        const script = document.createElement('script');
        script.src = 'https://checkout.razorpay.com/v1/checkout.js';
        script.onload = startCheckout;
        script.onerror = () => {
            setPaymentError('Could not load Razorpay checkout');
            setPaymentLoading(false);
        };
        document.body.appendChild(script);
    };

    const getStatusColor = (status: string) => {
        const colors: Record<string, string> = {
            'Pending Collection': 'bg-yellow-100 text-yellow-800',
            'In Progress': 'bg-blue-100 text-blue-800',
            'Pending Approval': 'bg-orange-100 text-orange-800',
            'Report Ready': 'bg-green-100 text-green-800',
            'Completed': 'bg-green-100 text-green-800',
            'Delivered': 'bg-gray-100 text-gray-800',
        };
        return colors[status] || 'bg-gray-100 text-gray-800';
    };

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

    const isFinalOrderStatus = (status: string) => {
        return ['Report Ready', 'Completed', 'Delivered'].includes(status);
    };

    const shouldShowSampleStatus = (order: Order, sample: SampleSummary) => {
        const normalizedSampleStatus = String(sample.status || '').toLowerCase();
        if (normalizedSampleStatus === 'rejected' || sample.rejection_reason) return true;
        return !isFinalOrderStatus(order.status);
    };

    const formatCurrency = (amount: number) => {
        return new Intl.NumberFormat('en-IN', {
            style: 'currency',
            currency: 'INR',
            maximumFractionDigits: 0,
        }).format(amount);
    };

    const formatDate = (dateString?: string) => {
        if (!dateString) return '-';
        const date = new Date(dateString);
        if (Number.isNaN(date.getTime())) return '-';

        return date.toLocaleDateString('en-IN', {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
        });
    };

    const getOrderAmount = (order: Order): number => {
        const finalAmount = Number(order.final_amount);
        if (Number.isFinite(finalAmount) && finalAmount > 0) return finalAmount;

        const totalAmount = Number(order.total_amount);
        return Number.isFinite(totalAmount) ? totalAmount : 0;
    };

    const isOpenCreditOrder = (order: Order): boolean => {
        const status = String(order.status || '').toLowerCase();
        const billingStatus = String(order.billing_status || '').toLowerCase();

        return status !== 'cancelled' && !order.is_billed && billingStatus !== 'billed';
    };

    const openOrderAmount = orders
        .filter(isOpenCreditOrder)
        .reduce((sum, order) => sum + getOrderAmount(order), 0);
    const pendingBookingAmount = pendingBookings.reduce((sum, booking) => sum + getBookingAmount(booking), 0);
    const creditLimit = Number(account?.credit_limit || 0);
    const storedCreditUsed = Number(account?.credit_used || 0);
    const { effectiveCreditUsed, availableCredit } = computeAvailableCredit({
        creditLimit,
        storedCreditUsed,
        openOrderAmount,
        outstandingInvoiceAmount,
        pendingBookingAmount,
        gatewayPaymentCredit: paymentCreditTotal,
        manualPaymentCredit: manualCreditTotal,
    });
    const isCreditBlocked = availableCredit < 0;
    const suggestedTopUpAmount = Math.max(1, Math.ceil(creditLimit > 0 ? creditLimit * 2 : effectiveCreditUsed));

    useEffect(() => {
        if (!topUpAmountEdited && suggestedTopUpAmount > 0) {
            setTopUpAmount(String(suggestedTopUpAmount));
        }
    }, [suggestedTopUpAmount, topUpAmountEdited]);

    if (loading) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-gray-50">
                <div className="text-center">
                    <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
                    <p className="mt-4 text-gray-600">Loading portal...</p>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-gray-50">
            {/* Header */}
            <header className="bg-white shadow-sm border-b border-gray-200">
                <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3">
                    <div className="flex items-center justify-between">
                        {/* Lab Info Section - Centered */}
                        <div className="flex items-center gap-3">
                            {labInfo?.logo ? (
                                <img
                                    src={labInfo.logo}
                                    alt={labInfo.name || 'Lab Logo'}
                                    className="h-10 w-auto max-w-[120px] object-contain rounded border border-gray-200 bg-white"
                                />
                            ) : (
                                <div className="h-10 w-10 rounded-lg bg-blue-100 flex items-center justify-center">
                                    <Building2 className="h-5 w-5 text-blue-600" />
                                </div>
                            )}
                            <div className="min-w-0">
                                <div className="text-base font-semibold text-gray-900">
                                    {labInfo?.name || 'Laboratory'}
                                </div>
                                <div className="text-xs text-gray-500">Partner Portal</div>
                            </div>
                        </div>

                        {/* Account & Actions */}
                        <div className="flex items-center gap-3">
                            <div className="hidden sm:block text-right mr-2">
                                <div className="text-sm font-medium text-gray-900">{account?.name}</div>
                                <div className="text-xs text-gray-500">Welcome back</div>
                            </div>
                            <button
                                onClick={handleLogout}
                                className="flex items-center px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors"
                            >
                                <LogOut className="h-4 w-4 mr-2" />
                                Logout
                            </button>
                        </div>
                    </div>
                </div>
            </header>

            {/* Main Content */}
            <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
                <div className="mb-8 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start">
                    <div className="space-y-6">
                        <div className="rounded-lg border border-blue-100 bg-blue-50 p-5">
                            <div className="text-xs font-semibold uppercase tracking-wide text-blue-700 mb-2">
                                Welcome
                            </div>
                            <h1 className="text-xl font-bold text-gray-900 mb-2">
                                Hello, {account?.name || 'Partner'}
                            </h1>
                            <p className="text-sm leading-6 text-gray-700 whitespace-pre-line">
                                {portalSettings.welcome_note || 'Track your bookings, samples, and reports from one place.'}
                            </p>
                        </div>

                        {account && <AccountInfoCard account={account} />}

                        {portalSettings.announcements_enabled && activeAnnouncement && (
                            <div className="overflow-hidden rounded-lg border border-amber-200 bg-amber-50 shadow-sm">
                                <div className="flex items-center justify-between gap-3 px-5 py-3">
                                    <div className="flex items-center gap-2 min-w-0">
                                        <div className="h-9 w-9 shrink-0 rounded-lg bg-white flex items-center justify-center border border-amber-200">
                                            <Megaphone className="h-4 w-4 text-amber-600" />
                                        </div>
                                        <div className="min-w-0">
                                            <h2 className="text-sm font-bold text-gray-900 truncate">{portalSettings.announcements_title}</h2>
                                            <p className="text-xs text-amber-700">
                                                {activeAnnouncementIndex + 1} of {announcements.length}
                                            </p>
                                        </div>
                                    </div>
                                    {announcements.length > 1 && (
                                        <div className="flex items-center gap-1">
                                            <button
                                                type="button"
                                                onClick={() => setActiveAnnouncementIndex((activeAnnouncementIndex - 1 + announcements.length) % announcements.length)}
                                                className="p-1.5 rounded border border-amber-200 bg-white text-amber-700 hover:bg-amber-100"
                                                aria-label="Previous announcement"
                                            >
                                                <ChevronLeft className="h-4 w-4" />
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setActiveAnnouncementIndex((activeAnnouncementIndex + 1) % announcements.length)}
                                                className="p-1.5 rounded border border-amber-200 bg-white text-amber-700 hover:bg-amber-100"
                                                aria-label="Next announcement"
                                            >
                                                <ChevronRight className="h-4 w-4" />
                                            </button>
                                        </div>
                                    )}
                                </div>
                                <div className="border-t border-amber-200 bg-white px-5 py-4">
                                    {activeAnnouncement.title && (
                                        <h3 className="text-base font-semibold text-gray-900">{activeAnnouncement.title}</h3>
                                    )}
                                    {activeAnnouncement.message && (
                                        <p className="mt-1 text-sm leading-6 text-gray-600 whitespace-pre-line">{activeAnnouncement.message}</p>
                                    )}
                                </div>
                            </div>
                        )}

                        {isCreditBlocked && (
                            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                                Account credit is overdue. New bookings and report downloads are disabled until payment is received.
                            </div>
                        )}
                    </div>

                    {/* Full-width row: bookings + orders table */}
                    <div className="space-y-6 min-w-0 lg:col-span-2 lg:row-start-2">
                        {/* Pending Bookings Section */}
                {pendingBookings.length > 0 && (
                    <div className="bg-yellow-50 rounded-lg shadow-md border border-yellow-200">
                        <div className="p-4 border-b border-yellow-200">
                            <h2 className="text-lg font-bold text-yellow-800 flex items-center gap-2">
                                <Clock className="h-5 w-5" />
                                Booked Samples ({pendingBookings.length})
                            </h2>
                            <p className="text-sm text-yellow-700 mt-1">
                                These bookings are waiting to be processed by the lab.
                            </p>
                        </div>
                        <div className="p-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                            {pendingBookings.map((booking) => (
                                <div key={booking.id} className="bg-white rounded-lg border border-yellow-200 p-4">
                                    <div className="flex justify-between items-start mb-2">
                                        <div>
                                            <p className="font-medium text-gray-900 flex items-center gap-1">
                                                <User className="h-3 w-3" />
                                                {booking.patient_info?.name || 'N/A'}
                                            </p>
                                            <p className="text-sm text-gray-500 flex items-center gap-1">
                                                <Phone className="h-3 w-3" />
                                                {booking.patient_info?.phone || 'N/A'}
                                            </p>
                                        </div>
                                        <span className="text-xs font-semibold px-2 py-1 rounded-full bg-yellow-100 text-yellow-800 uppercase">
                                            {booking.status}
                                        </span>
                                    </div>
                                    <div className="text-xs text-gray-500 mb-2">
                                        {booking.scheduled_at && (
                                            <p>Scheduled: {format(new Date(booking.scheduled_at), 'dd MMM yyyy, hh:mm a')}</p>
                                        )}
                                        <p>Tests: {booking.test_details?.length || 0}</p>
                                    </div>
                                    <button
                                        onClick={() => handleCancelBooking(booking.id)}
                                        disabled={cancellingBooking === booking.id}
                                        className="w-full mt-2 px-3 py-1.5 text-sm font-medium text-red-600 bg-red-50 hover:bg-red-100 rounded-lg flex items-center justify-center gap-1 disabled:opacity-50"
                                    >
                                        {cancellingBooking === booking.id ? (
                                            'Cancelling...'
                                        ) : (
                                            <>
                                                <Trash2 className="h-3 w-3" />
                                                Cancel Booking
                                            </>
                                        )}
                                    </button>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* Orders Section */}
                <div className="bg-white rounded-lg shadow-md border border-gray-200">
                    {/* Filters */}
                    <div className="p-6 border-b border-gray-200">
                        <div className="flex items-center justify-between mb-4">
                            <h2 className="text-xl font-bold text-gray-900">Booked Samples and Reports</h2>
                            <button
                                onClick={loadData}
                                className="flex items-center px-3 py-2 text-sm bg-blue-50 text-blue-600 rounded-lg hover:bg-blue-100 transition-colors"
                            >
                                <RefreshCw className="h-4 w-4 mr-2" />
                                Refresh
                            </button>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
                            {/* Search */}
                            <div className="relative">
                                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
                                <input
                                    type="text"
                                    placeholder="Search by Sample ID or Patient..."
                                    value={searchTerm}
                                    onChange={(e) => setSearchTerm(e.target.value)}
                                    className="w-full pl-10 pr-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                                />
                            </div>

                            {/* Status Filter */}
                            <div className="relative">
                                <Filter className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
                                <select
                                    value={statusFilter}
                                    onChange={(e) => setStatusFilter(e.target.value)}
                                    className="w-full pl-10 pr-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                                >
                                    <option value="All">All Status</option>
                                    <option value="Pending Collection">Pending Collection</option>
                                    <option value="In Progress">In Progress</option>
                                    <option value="Pending Approval">Pending Approval</option>
                                    <option value="Report Ready">Report Ready</option>
                                    <option value="Completed">Completed</option>
                                    <option value="Delivered">Delivered</option>
                                </select>
                            </div>

                            {/* Date From */}
                            <div className="relative">
                                <Calendar className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
                                <input
                                    type="date"
                                    value={dateRange.from}
                                    onChange={(e) => setDateRange({ ...dateRange, from: e.target.value })}
                                    className="w-full pl-10 pr-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                                    placeholder="From Date"
                                />
                            </div>

                            {/* Date To */}
                            <div className="relative">
                                <Calendar className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
                                <input
                                    type="date"
                                    value={dateRange.to}
                                    onChange={(e) => setDateRange({ ...dateRange, to: e.target.value })}
                                    className="w-full pl-10 pr-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                                    placeholder="To Date"
                                />
                            </div>

                            <div>
                                <label htmlFor="b2b-order-sort" className="mb-1 block text-xs font-medium text-gray-600">
                                    Order sort
                                </label>
                                <select
                                    id="b2b-order-sort"
                                    value={sortMode}
                                    onChange={(e) => updateSortMode(e.target.value as OrderSortMode)}
                                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                                >
                                    <option value="sample_desc">Sample ID newest first</option>
                                    <option value="sample_asc">Sample ID oldest first</option>
                                    <option value="order_id_asc">Order ID A-Z</option>
                                    <option value="order_id_desc">Order ID Z-A</option>
                                    <option value="date_desc">Order date newest first</option>
                                    <option value="patient_az">Patient A-Z</option>
                                </select>
                            </div>
                        </div>

                        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                            <div className="text-sm text-gray-600">
                                Showing {filteredOrders.length} of {orders.length} orders
                                {selectedOrderIds.size > 0 && <span className="ml-2 font-medium text-indigo-600"> - {selectedOrderIds.size} selected</span>}
                            </div>
                            <button
                                onClick={() => setShowResultAnalysis(true)}
                                disabled={selectedOrderIds.size === 0}
                                className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-gray-300"
                            >
                                <BarChart3 className="h-4 w-4" />
                                Analyze selected
                            </button>
                        </div>
                    </div>
                    {/* Orders Table */}
                    <div className="overflow-x-auto">
                        <table className="w-full">
                            <thead className="bg-gray-50 border-b border-gray-200">
                                <tr>
                                    <th className="px-4 py-3 text-left">
                                        <input
                                            type="checkbox"
                                            checked={filteredOrders.length > 0 && filteredOrders.every((order) => selectedOrderIds.has(order.id))}
                                            onChange={toggleAllVisibleOrders}
                                            className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                                            aria-label="Select all visible orders"
                                        />
                                    </th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                        Sample ID
                                    </th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                        Patient
                                    </th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                        Order Date
                                    </th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                        Status
                                    </th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                        Amount
                                    </th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                        Actions
                                    </th>
                                </tr>
                            </thead>
                            <tbody className="bg-white divide-y divide-gray-200">
                                {filteredOrders.length === 0 ? (
                                    <tr>
                                        <td colSpan={7} className="px-6 py-12 text-center text-gray-500">
                                            No orders found
                                        </td>
                                    </tr>
                                ) : (
                                    filteredOrders.map((order) => {
                                        const orderSamples = order.samples || [];
                                        return (
                                        <tr key={order.id} className="hover:bg-gray-50 transition-colors">
                                            <td className="px-4 py-4">
                                                <input
                                                    type="checkbox"
                                                    checked={selectedOrderIds.has(order.id)}
                                                    onChange={() => toggleOrderSelection(order.id)}
                                                    className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                                                    aria-label={`Select ${order.sample_id || order.id}`}
                                                />
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap">
                                                <div className="space-y-1.5">
                                                    {orderSamples.length > 0 ? orderSamples.map((sample) => (
                                                        <div key={sample.id} className="flex items-center">
                                                            {order.color_code && (
                                                                <div
                                                                    className="w-3 h-3 rounded-full mr-2"
                                                                    style={{ backgroundColor: order.color_code }}
                                                                    title={order.color_name}
                                                                />
                                                            )}
                                                            <div>
                                                                <span className="text-sm font-medium text-gray-900 font-mono">
                                                                    {sample.barcode || sample.id}
                                                                </span>
                                                                {sample.sample_type && (
                                                                    <div className="text-xs text-gray-500">{sample.sample_type}</div>
                                                                )}
                                                            </div>
                                                        </div>
                                                    )) : (
                                                        <span className="text-sm font-medium text-gray-900">
                                                            {order.sample_id || 'N/A'}
                                                        </span>
                                                    )}
                                                </div>
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap">
                                                <div className="text-sm text-gray-900">{order.patient_name}</div>
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap">
                                                <div className="text-sm text-gray-900">{formatDate(order.order_date)}</div>
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap">
                                                <div className="space-y-1.5">
                                                    <span className={`inline-flex px-2 py-1 rounded-full text-xs font-medium ${getStatusColor(order.status)}`}>
                                                        {order.status}
                                                    </span>
                                                    {orderSamples.filter((sample) => shouldShowSampleStatus(order, sample)).map((sample) => (
                                                        <div key={`${sample.id}-status`} className="text-xs">
                                                            <span className={`inline-flex px-2 py-0.5 rounded-full font-medium ${getSampleStatusColor(sample.status)}`}>
                                                                {getSampleStatusLabel(sample.status)}
                                                            </span>
                                                            {sample.rejection_reason && (
                                                                <div className="mt-1 max-w-[220px] text-red-600 whitespace-normal">
                                                                    {sample.rejection_reason}
                                                                </div>
                                                            )}
                                                        </div>
                                                    ))}
                                                </div>
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap">
                                                <div className="text-sm font-medium text-gray-900">
                                                    {formatCurrency(order.total_amount)}
                                                </div>
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap text-sm">
                                                <div className="flex items-center space-x-1.5">
                                                    {order.reports?.pdf_url ? (
                                                        <>
                                                            {/* E-Copy (digital PDF) */}
	                                                            <button
	                                                                onClick={() => handleDownloadReport(order.reports!.pdf_url!)}
                                                                    disabled={isCreditBlocked}
	                                                                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg text-white bg-emerald-600 hover:bg-emerald-700 transition-colors disabled:bg-gray-300 disabled:text-gray-500 disabled:cursor-not-allowed"
	                                                                title={isCreditBlocked ? 'Clear pending credit to download reports' : 'Download E-Copy (digital PDF)'}
	                                                            >
	                                                                <FileText className="h-3.5 w-3.5" />
	                                                                E-Copy
	                                                            </button>
                                                            {/* Print version */}
                                                            <button
                                                                onClick={() => {
	                                                                    const url = order.reports!.print_pdf_url || order.reports!.pdf_url!;
	                                                                    handleDownloadReport(url);
	                                                                }}
                                                                    disabled={isCreditBlocked}
	                                                                className="inline-flex items-center justify-center p-1.5 text-xs font-medium rounded-lg text-white bg-emerald-700 hover:bg-emerald-800 transition-colors disabled:bg-gray-300 disabled:text-gray-500 disabled:cursor-not-allowed"
	                                                                title={isCreditBlocked ? 'Clear pending credit to download reports' : order.reports!.print_pdf_url ? "Print Version (letterhead)" : "Print (opens report PDF)"}
	                                                            >
	                                                                <Printer className="h-3.5 w-3.5" />
	                                                            </button>
                                                        </>
                                                    ) : (
                                                        <span className="text-gray-400 text-xs italic">Report pending</span>
                                                    )}
                                                </div>
                                            </td>
                                        </tr>
                                        );
                                    })
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>
                    </div>

                    <div className="space-y-6 min-w-0 lg:col-start-2 lg:row-start-1">
                        <div className="bg-white rounded-lg shadow-md border border-gray-200 p-6">
                            <h2 className="text-lg font-bold text-gray-900">Create Booking</h2>
                            <p className="mt-1 text-sm text-gray-500">Start a new sample booking for your patients.</p>
                            <button
                                onClick={() => setShowBookingModal(true)}
                                disabled={isCreditBlocked}
                                className="mt-5 flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-3 text-sm font-medium text-white shadow-sm transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-300 disabled:text-gray-500"
                            >
                                <PlusCircle className="h-4 w-4" />
                                Create Booking
                            </button>
                        </div>

                        <div className="bg-white rounded-lg shadow-md border border-gray-200 p-6">
                            <div className="flex items-center justify-between gap-4">
                                <div>
                                    <h2 className="text-lg font-bold text-gray-900">Current Balance</h2>
                                    <p className="text-sm text-gray-500">Available credit</p>
                                </div>
                                <span className={`text-2xl font-bold ${availableCredit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                    {formatCurrency(availableCredit)}
                                </span>
                            </div>
                            <div className="mt-5 space-y-3">
                                <div className="relative">
                                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">Rs.</span>
                                    <input
                                        type="number"
                                        min="1"
                                        value={topUpAmount}
                                        onChange={(e) => {
                                            setTopUpAmountEdited(true);
                                            setTopUpAmount(e.target.value);
                                        }}
                                        placeholder="Enter amount"
                                        className="w-full pl-11 pr-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                                    />
                                </div>
                                {paymentError && (
                                    <div className="flex items-start gap-2 text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg p-2">
                                        <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                                        <span>{paymentError}</span>
                                    </div>
                                )}
                                <button
                                    onClick={handlePayNow}
                                    disabled={paymentLoading}
                                    className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors disabled:opacity-60"
                                >
                                    {paymentLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <CreditCard className="h-4 w-4" />}
                                    {paymentLoading ? 'Opening Gateway...' : 'Pay Now'}
                                </button>
                            </div>
                        </div>

                        {portalSettings.updates_enabled && activeImageSlide && (
                            <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
                                <div className="flex items-center justify-between gap-3 border-b border-gray-100 px-4 py-3">
                                    <div className="flex items-center gap-2 min-w-0">
                                        <div className="h-8 w-8 shrink-0 rounded-lg bg-blue-50 flex items-center justify-center">
                                            <ImageIcon className="h-4 w-4 text-blue-600" />
                                        </div>
                                        <div className="min-w-0">
                                            <h2 className="text-sm font-bold text-gray-900 truncate">{portalSettings.updates_title}</h2>
                                            <p className="text-xs text-gray-500">
                                                {activeUpdateIndex + 1} of {imageSlides.length}
                                            </p>
                                        </div>
                                    </div>
                                    {imageSlides.length > 1 && (
                                        <div className="flex items-center gap-1">
                                            <button
                                                type="button"
                                                onClick={() => setActiveUpdateIndex((activeUpdateIndex - 1 + imageSlides.length) % imageSlides.length)}
                                                className="p-1.5 rounded border border-gray-200 text-gray-500 hover:bg-gray-50"
                                                aria-label="Previous update"
                                            >
                                                <ChevronLeft className="h-4 w-4" />
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setActiveUpdateIndex((activeUpdateIndex + 1) % imageSlides.length)}
                                                className="p-1.5 rounded border border-gray-200 text-gray-500 hover:bg-gray-50"
                                                aria-label="Next update"
                                            >
                                                <ChevronRight className="h-4 w-4" />
                                            </button>
                                        </div>
                                    )}
                                </div>
                                <div className="bg-gray-100 p-3">
                                    <div
                                        className={`relative mx-auto w-full overflow-hidden rounded-lg bg-gray-200 ${
                                            portalSettings.slider_aspect === 'banner'
                                                ? 'aspect-[3/1]'
                                                : portalSettings.slider_aspect === 'landscape'
                                                    ? 'aspect-video'
                                                    : 'aspect-square'
                                        }`}
                                    >
                                        <img
                                            src={activeImageSlide.image_url}
                                            alt={activeImageSlide.title || portalSettings.updates_title}
                                            className="absolute inset-0 h-full w-full object-cover"
                                        />
                                        {(activeImageSlide.title || activeImageSlide.message) && (
                                            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-3 pb-6 text-white">
                                                {activeImageSlide.title && <h3 className="text-base font-semibold">{activeImageSlide.title}</h3>}
                                                {activeImageSlide.message && <p className="mt-1 text-xs leading-5 text-white/90 whitespace-pre-line">{activeImageSlide.message}</p>}
                                            </div>
                                        )}
                                        {imageSlides.length > 1 && (
                                            <div className="absolute inset-x-0 bottom-2 flex justify-center gap-1.5">
                                                {imageSlides.map((_, index) => (
                                                    <button
                                                        key={index}
                                                        type="button"
                                                        onClick={() => setActiveUpdateIndex(index)}
                                                        className={`h-1.5 rounded-full transition-all ${index === activeUpdateIndex ? 'w-5 bg-white' : 'w-1.5 bg-white/50'}`}
                                                        aria-label={`Go to slide ${index + 1}`}
                                                    />
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                </div>

                {/* Payment Section */}
                {account && (
                    <div className="space-y-6">
                        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
                            <div className="bg-white rounded-lg shadow-md border border-gray-200 p-6">
                                <div className="flex items-center justify-between mb-5">
                                    <div>
                                        <h2 className="text-lg font-bold text-gray-900">Current Balance Details</h2>
                                        <p className="text-sm text-gray-500">Credit limit, open work, and pending bills</p>
                                    </div>
                                    <div className="h-10 w-10 rounded-lg bg-blue-50 flex items-center justify-center">
                                        <Wallet className="h-5 w-5 text-blue-600" />
                                    </div>
                                </div>
                                <div className="space-y-3">
                                    <div className="flex items-center justify-between">
                                        <span className="text-sm text-gray-500">Credit Limit</span>
                                        <span className="font-semibold text-gray-900">{formatCurrency(creditLimit)}</span>
                                    </div>
                                    <div className="flex items-center justify-between">
                                        <span className="text-sm text-gray-500">Open Orders</span>
                                        <span className="font-semibold text-orange-600">{formatCurrency(openOrderAmount)}</span>
                                    </div>
                                    <div className="flex items-center justify-between">
                                        <span className="text-sm text-gray-500">Outstanding Bills</span>
                                        <span className="font-semibold text-orange-600">{formatCurrency(outstandingInvoiceAmount)}</span>
                                    </div>
                                    <div className="flex items-center justify-between">
                                        <span className="text-sm text-gray-500">Pending Bookings</span>
                                        <span className="font-semibold text-amber-600">{formatCurrency(pendingBookingAmount)}</span>
                                    </div>
                                    <div className="flex items-center justify-between">
                                        <span className="text-sm text-gray-500">Payments Applied</span>
                                        <span className="font-semibold text-green-600">-{formatCurrency(paymentCreditTotal)}</span>
                                    </div>
                                    {manualCreditTotal > 0 && (
                                        <div className="flex items-center justify-between">
                                            <span className="text-sm text-gray-500">Payments Received at Lab</span>
                                            <span className="font-semibold text-green-600">-{formatCurrency(manualCreditTotal)}</span>
                                        </div>
                                    )}
                                    <div className="pt-3 border-t border-gray-200 flex items-center justify-between">
                                        <span className="text-sm font-medium text-gray-700">Available Credit</span>
                                        <span className={`text-xl font-bold ${availableCredit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                            {formatCurrency(availableCredit)}
                                        </span>
                                    </div>
                                </div>
                            </div>

                            <div className="bg-white rounded-lg shadow-md border border-gray-200 p-6">
                                <div className="flex items-center justify-between mb-5">
                                    <div>
                                        <h2 className="text-lg font-bold text-gray-900">Past Payments</h2>
                                        <p className="text-sm text-gray-500">Successful gateway payments</p>
                                    </div>
                                    <div className="h-10 w-10 rounded-lg bg-emerald-50 flex items-center justify-center">
                                        <CheckCircle className="h-5 w-5 text-emerald-600" />
                                    </div>
                                </div>
                                <div className="space-y-3">
                                    {payments.length === 0 ? (
                                        <p className="text-sm text-gray-500 py-4 text-center">No successful payments yet</p>
                                    ) : (
                                        payments.slice(0, 5).map((payment) => (
                                            <div key={payment.id} className="flex items-center justify-between border-b border-gray-100 pb-3 last:border-0 last:pb-0">
                                                <div className="min-w-0">
                                                    <p className="text-sm font-medium text-gray-900">{formatCurrency(payment.amount)}</p>
                                                    <p className="text-xs text-gray-500 capitalize">
                                                        {payment.provider || 'gateway'} {payment.payment_method ? ` - ${payment.payment_method}` : ''}
                                                    </p>
                                                </div>
                                                <div className="text-right">
                                                    <span className="inline-flex px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-700">
                                                        Success
                                                    </span>
                                                    <p className="text-xs text-gray-500 mt-1">
                                                        {formatDate(payment.completed_at || payment.created_at || '')}
                                                    </p>
                                                </div>
                                            </div>
                                        ))
                                    )}
                                </div>
                            </div>
                        </div>

                        <div className="bg-white rounded-lg shadow-md border border-gray-200">
                            <div className="p-6 border-b border-gray-200 flex items-center justify-between">
                                <div>
                                    <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
                                        <Receipt className="h-5 w-5 text-blue-600" />
                                        Invoices
                                    </h2>
                                    <p className="text-sm text-gray-500 mt-1">Recent consolidated monthly bills</p>
                                </div>
                            </div>
                            <div className="overflow-x-auto">
                                <table className="w-full">
                                    <thead className="bg-gray-50 border-b border-gray-200">
                                        <tr>
                                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Invoice No.</th>
                                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Period</th>
                                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Due Date</th>
                                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Amount</th>
                                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Action</th>
                                        </tr>
                                    </thead>
                                    <tbody className="bg-white divide-y divide-gray-200">
                                        {invoices.length === 0 ? (
                                            <tr>
                                                <td colSpan={6} className="px-6 py-10 text-center text-gray-500">
                                                    No invoices generated yet
                                                </td>
                                            </tr>
                                        ) : (
                                            invoices.map((invoice) => (
                                                <tr key={invoice.id} className="hover:bg-gray-50 transition-colors">
                                                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{invoice.invoice_number}</td>
                                                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                                                        {invoice.billing_period_start && invoice.billing_period_end
                                                            ? `${formatDate(invoice.billing_period_start)} - ${formatDate(invoice.billing_period_end)}`
                                                            : '-'}
                                                    </td>
                                                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                                                        {invoice.due_date ? formatDate(invoice.due_date) : '-'}
                                                    </td>
                                                    <td className="px-6 py-4 whitespace-nowrap">
                                                        <span className={`px-2 py-1 rounded-full text-xs font-medium capitalize ${
                                                            invoice.status === 'paid'
                                                                ? 'bg-green-100 text-green-700'
                                                                : invoice.status === 'overdue'
                                                                    ? 'bg-red-100 text-red-700'
                                                                    : 'bg-blue-100 text-blue-700'
                                                        }`}>
                                                            {invoice.status}
                                                        </span>
                                                    </td>
                                                    <td className="px-6 py-4 whitespace-nowrap text-sm font-semibold text-gray-900">
                                                        {formatCurrency(invoice.total_amount)}
                                                    </td>
                                                    <td className="px-6 py-4 whitespace-nowrap text-sm">
                                                        {invoice.pdf_url ? (
                                                            <button
                                                                onClick={() => handleDownloadReport(invoice.pdf_url!)}
                                                                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg text-white bg-blue-600 hover:bg-blue-700 transition-colors"
                                                            >
                                                                <Download className="h-3.5 w-3.5" />
                                                                Download
                                                            </button>
                                                        ) : (
                                                            <span className="text-gray-400 text-xs italic">Not ready</span>
                                                        )}
                                                    </td>
                                                </tr>
                                            ))
                                        )}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                )}

                {/* Support sections - collapsed by default, below reports and billing */}
                {account && (
                    <div className="mt-6 space-y-4">
                        <div className="bg-white rounded-lg shadow-md border border-gray-200 overflow-hidden">
                            <button
                                type="button"
                                onClick={() => {
                                    setShowChatSection((current) => {
                                        if (!current) setChatUnreadCount(0);
                                        return !current;
                                    });
                                }}
                                className="flex w-full items-center justify-between px-6 py-4 text-left hover:bg-gray-50"
                            >
                                <div className="flex items-center gap-3">
                                    <div className="h-10 w-10 rounded-lg bg-blue-50 flex items-center justify-center">
                                        <MessageSquare className="h-5 w-5 text-blue-600" />
                                    </div>
                                    <div>
                                        <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
                                            Chat with the Lab
                                            {chatUnreadCount > 0 && (
                                                <span className="rounded-full bg-red-500 px-2 py-0.5 text-xs font-semibold text-white">
                                                    {chatUnreadCount} new
                                                </span>
                                            )}
                                        </h2>
                                        <p className="text-sm text-gray-500">
                                            Ask questions and share clinical history or documents
                                        </p>
                                    </div>
                                </div>
                                <ChevronDown
                                    className={`h-5 w-5 text-gray-400 transition-transform ${showChatSection ? 'rotate-180' : ''}`}
                                />
                            </button>
                            {showChatSection && (
                                <div className="border-t border-gray-100 bg-gray-50 p-4">
                                    <PartnerChatPanel
                                        accountId={account.id}
                                        labId={account.lab_id}
                                        counterpartyName={labInfo?.name || 'the lab'}
                                    />
                                </div>
                            )}
                        </div>

                        <div className="bg-white rounded-lg shadow-md border border-gray-200 overflow-hidden">
                            <button
                                type="button"
                                onClick={() => setShowMaterialSection((current) => !current)}
                                className="flex w-full items-center justify-between px-6 py-4 text-left hover:bg-gray-50"
                            >
                                <div className="flex items-center gap-3">
                                    <div className="h-10 w-10 rounded-lg bg-emerald-50 flex items-center justify-center">
                                        <Package className="h-5 w-5 text-emerald-600" />
                                    </div>
                                    <div>
                                        <h2 className="text-lg font-bold text-gray-900">Material Requests</h2>
                                        <p className="text-sm text-gray-500">
                                            Request vacutainers, containers, and other supplies from the lab
                                        </p>
                                    </div>
                                </div>
                                <ChevronDown
                                    className={`h-5 w-5 text-gray-400 transition-transform ${showMaterialSection ? 'rotate-180' : ''}`}
                                />
                            </button>
                            {showMaterialSection && (
                                <div className="border-t border-gray-100 bg-gray-50 p-4">
                                    <MaterialRequestPanel
                                        accountId={account.id}
                                        labId={account.lab_id}
                                        mode="account"
                                    />
                                </div>
                            )}
                        </div>
                    </div>
                )}
            </main>

            {showBookingModal && account && (
                <B2BBookingModal
                    accountId={account.id}
                    labId={account.lab_id}
                    onClose={() => setShowBookingModal(false)}
                    onSuccess={() => {
                        loadData();
                        alert('Booking created successfully! It will appear in your orders once processed by the lab.');
                    }}
                />
            )}
            {showResultAnalysis && selectedOrderIds.size > 0 && (
                <B2BResultAnalysisModal
                    orderIds={Array.from(selectedOrderIds)}
                    onClose={() => setShowResultAnalysis(false)}
                />
            )}
            {!portalSettings.hide_lims_branding && (
                <div className="pb-6 text-center text-xs text-gray-400">
                    Partner portal powered by LIMS
                </div>
            )}
        </div>
    );
};

export default B2BPortal;
