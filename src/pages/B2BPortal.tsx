import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { LogOut, Download, Filter, Search, Calendar, RefreshCw, PlusCircle, X, Clock, User, Users, Phone, Trash2, Printer, FileText, Wallet, CreditCard, Receipt, Loader2, CheckCircle, AlertCircle, BarChart3, Building2, ChevronLeft, ChevronRight, Megaphone, MessageSquare, Package, LayoutDashboard, ClipboardList, FileSpreadsheet, Image as ImageIcon } from 'lucide-react';
import { supabase } from '../utils/supabase';
import { getCurrentB2BAccount } from '../utils/b2bAuth';
import B2BBookingModal from '../components/B2B/B2BBookingModal';
import B2BResultAnalysisModal from '../components/B2B/B2BResultAnalysisModal';
import AccountInfoCard from '../components/B2B/AccountInfoCard';
import PartnerChatPanel from '../components/B2B/PartnerChatPanel';
import MaterialRequestPanel from '../components/B2B/MaterialRequestPanel';
import { fetchAccountUnreadCount } from '../utils/partnerCommsService';
import {
    AccountCreditSummary,
    computeAvailableCredit,
    fetchAccountCreditSummary,
    fetchReceiptCreditTotal,
    isCreditCheckBypassed,
} from '../utils/accountCredit';
import { downloadB2BTrfPdf, type TrfOptions, type TrfOrder, type TrfTest } from '../utils/b2bTrfPdf';
import { format } from 'date-fns';
import * as XLSX from 'xlsx';
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

/** Shape returned by the get_b2b_trf_bookings RPC */
interface BookingTrfRow {
    booking_id: string;
    booking_ref: string;
    patient_name: string;
    patient_meta: string | null;
    scheduled_at: string | null;
    created_at: string;
    collection_type: string | null;
    status: string | null;
    tests: TrfTest[];
}

/** One row per distinct patient, as returned by the get_b2b_patients RPC */
interface B2BPatientRow {
    patient_id: string;
    patient_code: string;
    name: string;
    age: number | null;
    age_unit: string | null;
    gender: string | null;
    phone: string | null;
    email: string | null;
    first_visit: string | null;
    last_visit: string | null;
    total_orders: number;
    total_amount: number;
}

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

type PortalSection = 'home' | 'orders' | 'patients' | 'billing' | 'chat' | 'materials';

const PORTAL_SECTIONS: { key: PortalSection; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { key: 'home', label: 'Home', icon: LayoutDashboard },
    { key: 'orders', label: 'Samples & Reports', icon: ClipboardList },
    { key: 'patients', label: 'Patient List', icon: Users },
    { key: 'billing', label: 'Billing & Payments', icon: Wallet },
    { key: 'chat', label: 'Chat with Lab', icon: MessageSquare },
    { key: 'materials', label: 'Material Requests', icon: Package },
];

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
    // The shared ledger position, so the portal can never disagree with Account
    // Master, the order form or the check-b2b-credit gate about this account.
    const [creditSummary, setCreditSummary] = useState<AccountCreditSummary | null>(null);
    const [invoices, setInvoices] = useState<ConsolidatedInvoice[]>([]);
    const [topUpAmount, setTopUpAmount] = useState('');
    const [topUpAmountEdited, setTopUpAmountEdited] = useState(false);
    const [paymentLoading, setPaymentLoading] = useState(false);
    const [paymentError, setPaymentError] = useState<string | null>(null);
    const [sortMode, setSortMode] = useState<OrderSortMode>(() =>
        (localStorage.getItem('b2b-order-sort') as OrderSortMode) || 'sample_desc'
    );
    const [selectedOrderIds, setSelectedOrderIds] = useState<Set<string>>(new Set());
    const [showResultAnalysis, setShowResultAnalysis] = useState(false);
    const [trfLoading, setTrfLoading] = useState(false);
    const [trfError, setTrfError] = useState<string | null>(null);
    const [selectedBookingIds, setSelectedBookingIds] = useState<Set<string>>(new Set());
    const [bookingTrfLoading, setBookingTrfLoading] = useState(false);
    const [bookingTrfError, setBookingTrfError] = useState<string | null>(null);
    const [labInfo, setLabInfo] = useState<{ name: string; logo: string | null; portalSettings: PortalSettings } | null>(null);
    const [activeUpdateIndex, setActiveUpdateIndex] = useState(0);
    const [activeAnnouncementIndex, setActiveAnnouncementIndex] = useState(0);
    // Sidebar navigation keeps each area on its own screen instead of one long page
    const [patients, setPatients] = useState<B2BPatientRow[]>([]);
    const [patientsLoading, setPatientsLoading] = useState(false);
    const [patientsError, setPatientsError] = useState<string | null>(null);
    const [patientsLoaded, setPatientsLoaded] = useState(false);
    const [patientSearch, setPatientSearch] = useState('');
    const [patientRange, setPatientRange] = useState({ from: '', to: '' });
    const [activeSection, setActiveSection] = useState<PortalSection>(() => {
        const stored = localStorage.getItem('b2b-portal-section') as PortalSection | null;
        return stored && PORTAL_SECTIONS.some((section) => section.key === stored) ? stored : 'home';
    });
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
            setCreditSummary(await fetchAccountCreditSummary(accountData.id));

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

    // Patient demographics live behind RLS, so the directory comes from an
    // account-scoped RPC rather than a direct patients query
    const loadPatients = async () => {
        try {
            setPatientsLoading(true);
            setPatientsError(null);

            const { data, error } = await supabase.rpc('get_b2b_patients', {
                p_from: patientRange.from || null,
                p_to: patientRange.to || null,
            });

            if (error) throw error;

            setPatients((data || []).map((row: any) => ({
                ...row,
                total_orders: Number(row.total_orders) || 0,
                total_amount: Number(row.total_amount) || 0,
            })));
        } catch (error: any) {
            console.error('Error loading patient list:', error);
            setPatients([]);
            setPatientsError(error?.message || 'Failed to load the patient list');
        } finally {
            // Marked loaded even on failure, otherwise the auto-load effect retries forever
            setPatientsLoaded(true);
            setPatientsLoading(false);
        }
    };

    // Load on first visit to the section; date filters reload on demand
    useEffect(() => {
        if (activeSection === 'patients' && !patientsLoaded && !patientsLoading) {
            loadPatients();
        }
    }, [activeSection, patientsLoaded, patientsLoading]);

    const patientQuery = patientSearch.trim().toLowerCase();
    const filteredPatients = patientQuery
        ? patients.filter((patient) =>
            (patient.name || '').toLowerCase().includes(patientQuery) ||
            (patient.patient_code || '').toLowerCase().includes(patientQuery) ||
            (patient.phone || '').toLowerCase().includes(patientQuery)
        )
        : patients;

    // Visit dates arrive as plain yyyy-MM-dd; parsing them as Date would shift the day
    const formatVisitDate = (value: string | null) => {
        if (!value) return '';
        const [year, month, day] = value.slice(0, 10).split('-');
        return year && month && day ? `${day}/${month}/${year}` : value;
    };

    const formatPatientAge = (patient: B2BPatientRow) => {
        if (patient.age === null || patient.age === undefined) return '';
        const unit = patient.age_unit === 'months' ? 'M' : patient.age_unit === 'days' ? 'D' : 'Y';
        return `${patient.age}${unit}`;
    };

    const handleExportPatients = () => {
        const rows = filteredPatients.map((patient) => ({
            'Patient ID': patient.patient_code,
            'Patient Name': patient.name,
            'Age': formatPatientAge(patient),
            'Gender': patient.gender || '',
            'Phone': patient.phone || '',
            'Email': patient.email || '',
            'First Visit': formatVisitDate(patient.first_visit),
            'Last Visit': formatVisitDate(patient.last_visit),
            'Total Orders': patient.total_orders,
            'Total Amount': patient.total_amount,
        }));

        const worksheet = XLSX.utils.json_to_sheet(rows);
        worksheet['!cols'] = [
            { wch: 16 }, { wch: 28 }, { wch: 8 }, { wch: 10 }, { wch: 16 },
            { wch: 26 }, { wch: 13 }, { wch: 13 }, { wch: 13 }, { wch: 14 },
        ];
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, 'Patients');

        const accountSlug = String(account?.name || 'partner')
            .replace(/[^a-z0-9]+/gi, '_')
            .replace(/^_+|_+$/g, '')
            .slice(0, 40) || 'partner';
        XLSX.writeFile(workbook, `patients_${accountSlug}_${new Date().toISOString().slice(0, 10)}.xlsx`);
    };

    const openSection = (section: PortalSection) => {
        setActiveSection(section);
        localStorage.setItem('b2b-portal-section', section);
        if (section === 'chat') setChatUnreadCount(0);
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

    const toggleBookingSelection = (bookingId: string) => {
        setSelectedBookingIds((current) => {
            const next = new Set(current);
            if (next.has(bookingId)) next.delete(bookingId);
            else next.add(bookingId);
            return next;
        });
    };

    const allBookingsSelected =
        pendingBookings.length > 0 && pendingBookings.every((booking) => selectedBookingIds.has(booking.id));

    const toggleAllBookings = () => {
        setSelectedBookingIds(allBookingsSelected ? new Set() : new Set(pendingBookings.map((booking) => booking.id)));
    };

    const handleLogout = async () => {
        await supabase.auth.signOut();
        navigate('/b2b');
    };

    const handleDownloadReport = (reportUrl: string) => {
        window.open(reportUrl, '_blank');
    };

    // Logos live in Supabase storage, so inline them before jsPDF renders the sheet
    const loadLogoDataUrl = async (url: string | null): Promise<string | null> => {
        if (!url) return null;
        try {
            const response = await fetch(url);
            if (!response.ok) return null;
            const blob = await response.blob();
            return await new Promise<string | null>((resolve) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(typeof reader.result === 'string' ? reader.result : null);
                reader.onerror = () => resolve(null);
                reader.readAsDataURL(blob);
            });
        } catch {
            return null;
        }
    };

    const buildTrfOptions = async (refPrefix: 'TRF' | 'TRF-B', note?: string): Promise<TrfOptions> => {
        const generatedAt = new Date();
        const partnerRef = String(account?.code || account?.name || 'PARTNER')
            .toUpperCase()
            .replace(/[^A-Z0-9]+/g, '-')
            .replace(/^-|-$/g, '')
            .slice(0, 16) || 'PARTNER';

        const addressLine = [
            account?.address_line1,
            account?.address_line2,
            account?.city,
            account?.state,
            account?.pincode,
        ]
            .map((part: unknown) => String(part || '').trim())
            .filter(Boolean)
            .join(', ');

        return {
            labName: labInfo?.name || 'Laboratory',
            labLogoDataUrl: await loadLogoDataUrl(labInfo?.logo || null),
            partner: {
                name: account?.name || 'Partner',
                code: account?.code || null,
                contact_person: account?.contact_person || null,
                phone: account?.billing_phone || null,
                address: addressLine || null,
            },
            generatedAt,
            reference: `${refPrefix}-${partnerRef}-${format(generatedAt, 'yyyyMMdd-HHmm')}`,
            note: note || null,
        };
    };

    const handleGenerateTrf = async () => {
        if (selectedOrderIds.size === 0) return;

        setTrfLoading(true);
        setTrfError(null);

        try {
            const { data, error } = await supabase.rpc('get_b2b_trf_orders', {
                p_order_ids: Array.from(selectedOrderIds),
            });

            if (error) throw error;

            const trfOrders = (data || []) as TrfOrder[];
            if (trfOrders.length === 0) {
                setTrfError('No order details available for the selected orders.');
                return;
            }

            downloadB2BTrfPdf(trfOrders, await buildTrfOptions('TRF'));
        } catch (err: any) {
            console.error('Error generating TRF:', err);
            setTrfError(err?.message || 'Failed to generate the TRF PDF');
        } finally {
            setTrfLoading(false);
        }
    };

    const handleGenerateBookingTrf = async () => {
        if (selectedBookingIds.size === 0) return;

        setBookingTrfLoading(true);
        setBookingTrfError(null);

        try {
            const { data, error } = await supabase.rpc('get_b2b_trf_bookings', {
                p_booking_ids: Array.from(selectedBookingIds),
            });

            if (error) throw error;

            const rows = (data || []) as BookingTrfRow[];
            if (rows.length === 0) {
                setBookingTrfError('No booking details available for the selected bookings.');
                return;
            }

            // Bookings have no samples yet - the lab labels tubes on receipt
            const trfOrders: TrfOrder[] = rows.map((row) => ({
                order_id: row.booking_id,
                order_display: row.booking_ref,
                patient_name: row.patient_name,
                order_date: row.scheduled_at || row.created_at,
                date_label: row.scheduled_at ? 'Scheduled' : 'Booked',
                patient_meta: [row.patient_meta, row.collection_type?.replace(/_/g, ' ')]
                    .filter(Boolean)
                    .join('   |   ') || null,
                priority: null,
                doctor: null,
                notes: null,
                status: row.status,
                sample_id: null,
                tests: row.tests || [],
                samples: [],
            }));

            downloadB2BTrfPdf(
                trfOrders,
                await buildTrfOptions(
                    'TRF-B',
                    'Pre-order booking sheet: the lab has not accessioned these bookings yet, so barcodes are written on collection.',
                ),
            );
        } catch (err: any) {
            console.error('Error generating booking TRF:', err);
            setBookingTrfError(err?.message || 'Failed to generate the TRF PDF');
        } finally {
            setBookingTrfLoading(false);
        }
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
    // accounts.credit_used is the cached ledger position, so it stands in until
    // the full summary lands. Both may be negative - that is an advance balance,
    // not an error, and clamping it here is exactly what used to swallow top-ups.
    const ledgerCreditUsed = creditSummary?.ledgerCreditUsed ?? Number(account?.credit_used || 0);
    const { effectiveCreditUsed, availableCredit, advanceBalance } = computeAvailableCredit({
        creditLimit,
        ledgerCreditUsed,
        pendingBookingAmount,
    });
    const orderDebitAmount = creditSummary?.orderDebitAmount ?? openOrderAmount;
    // Display the same figures the total was computed from. The standalone
    // b2b_payment_attempts / receipt queries below are the pre-ledger source and
    // only stand in until the summary lands - if a payment is ever marked
    // credit_applied without its ledger row landing, the two disagree and the
    // card visibly stops adding up.
    const shownGatewayCredit = creditSummary?.gatewayPaymentCredit ?? paymentCreditTotal;
    const shownManualCredit = creditSummary?.manualPaymentCredit ?? manualCreditTotal;
    // Accounts flagged for credit bypass in Account Master are never blocked here
    const bypassCreditCheck = isCreditCheckBypassed(account);
    const isCreditBlocked = !bypassCreditCheck && availableCredit < 0;
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
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 lg:flex lg:items-start lg:gap-6">
                {/* Section navigation - vertical sidebar on desktop, scrollable tabs on mobile */}
                <aside className="lg:w-60 lg:shrink-0">
                    <nav className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-3 lg:mx-0 lg:sticky lg:top-6 lg:flex-col lg:gap-1 lg:overflow-visible lg:rounded-lg lg:border lg:border-gray-200 lg:bg-white lg:p-2 lg:shadow-sm">
                        {PORTAL_SECTIONS.map((section) => {
                            const Icon = section.icon;
                            const isActive = activeSection === section.key;
                            const badge = section.key === 'chat' && chatUnreadCount > 0
                                ? String(chatUnreadCount)
                                : section.key === 'orders' && orders.length > 0
                                    ? String(orders.length)
                                    : null;

                            return (
                                <button
                                    key={section.key}
                                    type="button"
                                    onClick={() => openSection(section.key)}
                                    className={`flex shrink-0 items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors lg:w-full lg:border-transparent ${
                                        isActive
                                            ? 'border-blue-200 bg-blue-50 text-blue-700'
                                            : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                                    }`}
                                >
                                    <Icon className="h-4 w-4 shrink-0" />
                                    <span className="whitespace-nowrap lg:flex-1 lg:text-left">{section.label}</span>
                                    {badge && (
                                        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                                            section.key === 'chat' ? 'bg-red-500 text-white' : 'bg-gray-100 text-gray-600'
                                        }`}>
                                            {badge}
                                        </span>
                                    )}
                                </button>
                            );
                        })}
                    </nav>

                    <div className="mt-4 hidden rounded-lg border border-gray-200 bg-white p-4 shadow-sm lg:block">
                        <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Available Credit</p>
                        <p className={`mt-1 text-xl font-bold ${availableCredit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                            {formatCurrency(availableCredit)}
                        </p>
                        <button
                            onClick={() => setShowBookingModal(true)}
                            disabled={isCreditBlocked}
                            className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-300 disabled:text-gray-500"
                        >
                            <PlusCircle className="h-4 w-4" />
                            New Booking
                        </button>
                    </div>
                </aside>

                <main className="min-w-0 flex-1 space-y-6">
                    {isCreditBlocked && (
                        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                            Account credit is overdue. New bookings and report downloads are disabled until payment is received.
                        </div>
                    )}

                    {activeSection === 'home' && (
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

                    </div>
                    )}

                    {activeSection === 'orders' && (
                    <div className="space-y-6 min-w-0">
                        {/* Pending Bookings Section */}
                {pendingBookings.length > 0 && (
                    <div className="bg-yellow-50 rounded-lg shadow-md border border-yellow-200">
                        <div className="p-4 border-b border-yellow-200">
                            <div className="flex flex-wrap items-start justify-between gap-3">
                                <div>
                                    <h2 className="text-lg font-bold text-yellow-800 flex items-center gap-2">
                                        <Clock className="h-5 w-5" />
                                        Booked Samples ({pendingBookings.length})
                                    </h2>
                                    <p className="text-sm text-yellow-700 mt-1">
                                        These bookings are waiting to be processed by the lab.
                                        {selectedBookingIds.size > 0 && (
                                            <span className="ml-1 font-medium text-yellow-900">
                                                {selectedBookingIds.size} selected
                                            </span>
                                        )}
                                    </p>
                                </div>
                                <div className="flex items-center gap-2">
                                    <button
                                        type="button"
                                        onClick={toggleAllBookings}
                                        className="rounded-lg border border-yellow-300 bg-white px-3 py-2 text-sm font-medium text-yellow-800 hover:bg-yellow-100"
                                    >
                                        {allBookingsSelected ? 'Clear all' : 'Select all'}
                                    </button>
                                    <button
                                        onClick={handleGenerateBookingTrf}
                                        disabled={selectedBookingIds.size === 0 || bookingTrfLoading}
                                        title="Print a requisition / handover sheet for the selected bookings"
                                        className="inline-flex items-center gap-2 rounded-lg bg-amber-600 px-3 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:bg-gray-300"
                                    >
                                        {bookingTrfLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ClipboardList className="h-4 w-4" />}
                                        {bookingTrfLoading ? 'Preparing TRF...' : 'Generate TRF'}
                                    </button>
                                </div>
                            </div>
                            {bookingTrfError && (
                                <div className="mt-3 flex items-start gap-2 rounded-lg border border-red-100 bg-red-50 p-2 text-sm text-red-600">
                                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                                    <span>{bookingTrfError}</span>
                                </div>
                            )}
                        </div>
                        <div className="p-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                            {pendingBookings.map((booking) => (
                                <div
                                    key={booking.id}
                                    className={`rounded-lg border p-4 ${
                                        selectedBookingIds.has(booking.id)
                                            ? 'border-amber-400 bg-amber-50 ring-1 ring-amber-300'
                                            : 'border-yellow-200 bg-white'
                                    }`}
                                >
                                    <div className="flex justify-between items-start mb-2">
                                        <div className="flex items-start gap-2">
                                            <input
                                                type="checkbox"
                                                checked={selectedBookingIds.has(booking.id)}
                                                onChange={() => toggleBookingSelection(booking.id)}
                                                className="mt-1 rounded border-gray-300 text-amber-600 focus:ring-amber-500"
                                                aria-label={`Select booking for ${booking.patient_info?.name || 'patient'}`}
                                            />
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
                            <div className="flex flex-wrap items-center gap-2">
                                <button
                                    onClick={handleGenerateTrf}
                                    disabled={selectedOrderIds.size === 0 || trfLoading}
                                    title="Print a requisition / handover sheet for the selected orders"
                                    className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-300"
                                >
                                    {trfLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ClipboardList className="h-4 w-4" />}
                                    {trfLoading ? 'Preparing TRF...' : 'Generate TRF'}
                                </button>
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
                        {trfError && (
                            <div className="mt-3 flex items-start gap-2 rounded-lg border border-red-100 bg-red-50 p-2 text-sm text-red-600">
                                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                                <span>{trfError}</span>
                            </div>
                        )}
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
                    )}

                    {activeSection === 'patients' && (
                    <div className="space-y-6 min-w-0">
                        <div className="bg-white rounded-lg shadow-md border border-gray-200">
                            <div className="p-6 border-b border-gray-200">
                                <div className="flex flex-wrap items-start justify-between gap-3">
                                    <div>
                                        <h2 className="text-xl font-bold text-gray-900">Patient List</h2>
                                        <p className="mt-1 text-sm text-gray-500">
                                            Every patient booked under your account, with visit history.
                                        </p>
                                    </div>
                                    <div className="flex flex-wrap items-center gap-2">
                                        <button
                                            onClick={loadPatients}
                                            disabled={patientsLoading}
                                            className="flex items-center px-3 py-2 text-sm bg-blue-50 text-blue-600 rounded-lg hover:bg-blue-100 transition-colors disabled:cursor-not-allowed disabled:opacity-60"
                                        >
                                            {patientsLoading
                                                ? <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                                : <RefreshCw className="h-4 w-4 mr-2" />}
                                            {patientsLoading ? 'Loading...' : 'Refresh'}
                                        </button>
                                        <button
                                            onClick={handleExportPatients}
                                            disabled={filteredPatients.length === 0}
                                            title="Download the listed patients as an Excel file"
                                            className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-gray-300"
                                        >
                                            <FileSpreadsheet className="h-4 w-4" />
                                            Export to Excel
                                        </button>
                                    </div>
                                </div>

                                <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-4">
                                    <div className="relative md:col-span-2">
                                        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                                        <input
                                            type="text"
                                            placeholder="Search by name, patient ID or phone..."
                                            value={patientSearch}
                                            onChange={(e) => setPatientSearch(e.target.value)}
                                            className="w-full rounded-lg border border-gray-300 py-2 pl-10 pr-3 focus:border-blue-500 focus:ring-2 focus:ring-blue-500"
                                        />
                                    </div>
                                    <div className="relative">
                                        <Calendar className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                                        <input
                                            type="date"
                                            value={patientRange.from}
                                            onChange={(e) => {
                                                setPatientRange({ ...patientRange, from: e.target.value });
                                                setPatientsLoaded(false);
                                            }}
                                            className="w-full rounded-lg border border-gray-300 py-2 pl-10 pr-3 focus:border-blue-500 focus:ring-2 focus:ring-blue-500"
                                            aria-label="Visits from date"
                                        />
                                    </div>
                                    <div className="relative">
                                        <Calendar className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                                        <input
                                            type="date"
                                            value={patientRange.to}
                                            onChange={(e) => {
                                                setPatientRange({ ...patientRange, to: e.target.value });
                                                setPatientsLoaded(false);
                                            }}
                                            className="w-full rounded-lg border border-gray-300 py-2 pl-10 pr-3 focus:border-blue-500 focus:ring-2 focus:ring-blue-500"
                                            aria-label="Visits to date"
                                        />
                                    </div>
                                </div>

                                <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                                    <p className="text-sm text-gray-600">
                                        Showing {filteredPatients.length} of {patients.length} patients
                                    </p>
                                    {(patientRange.from || patientRange.to) && (
                                        <button
                                            type="button"
                                            onClick={() => {
                                                setPatientRange({ from: '', to: '' });
                                                setPatientsLoaded(false);
                                            }}
                                            className="text-sm font-medium text-blue-600 hover:text-blue-700"
                                        >
                                            Clear dates
                                        </button>
                                    )}
                                </div>

                                {patientsError && (
                                    <div className="mt-3 flex items-start gap-2 rounded-lg border border-red-100 bg-red-50 p-2 text-sm text-red-600">
                                        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                                        <span>{patientsError}</span>
                                    </div>
                                )}
                            </div>

                            <div className="overflow-x-auto">
                                <table className="w-full">
                                    <thead className="border-b border-gray-200 bg-gray-50">
                                        <tr>
                                            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Patient ID</th>
                                            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Patient Name</th>
                                            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Age / Gender</th>
                                            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Phone</th>
                                            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">First Visit</th>
                                            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Last Visit</th>
                                            <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Orders</th>
                                            <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Amount</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-gray-200">
                                        {patientsLoading ? (
                                            <tr>
                                                <td colSpan={8} className="px-4 py-8 text-center text-sm text-gray-500">
                                                    Loading patients...
                                                </td>
                                            </tr>
                                        ) : filteredPatients.length === 0 ? (
                                            <tr>
                                                <td colSpan={8} className="px-4 py-8 text-center text-sm text-gray-500">
                                                    {patients.length === 0
                                                        ? 'No patients booked under this account yet.'
                                                        : 'No patients match your search.'}
                                                </td>
                                            </tr>
                                        ) : (
                                            filteredPatients.map((patient) => (
                                                <tr key={patient.patient_id} className="hover:bg-gray-50">
                                                    <td className="whitespace-nowrap px-4 py-3 text-sm font-mono text-gray-600">
                                                        {patient.patient_code}
                                                    </td>
                                                    <td className="px-4 py-3 text-sm font-medium text-gray-900">
                                                        {patient.name}
                                                    </td>
                                                    <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-600">
                                                        {[formatPatientAge(patient), patient.gender].filter(Boolean).join(' / ') || '-'}
                                                    </td>
                                                    <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-600">
                                                        {patient.phone || '-'}
                                                    </td>
                                                    <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-600">
                                                        {formatVisitDate(patient.first_visit) || '-'}
                                                    </td>
                                                    <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-600">
                                                        {formatVisitDate(patient.last_visit) || '-'}
                                                    </td>
                                                    <td className="whitespace-nowrap px-4 py-3 text-right text-sm text-gray-900">
                                                        {patient.total_orders}
                                                    </td>
                                                    <td className="whitespace-nowrap px-4 py-3 text-right text-sm font-medium text-gray-900">
                                                        {formatCurrency(patient.total_amount)}
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

                    {activeSection === 'home' && (
                    <div className="space-y-6 min-w-0">
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

                        <button
                            type="button"
                            onClick={() => openSection('billing')}
                            className="flex w-full items-center justify-between gap-4 rounded-lg border border-gray-200 bg-white p-6 text-left shadow-md transition-colors hover:bg-gray-50"
                        >
                            <div>
                                <h2 className="text-lg font-bold text-gray-900">Current Balance</h2>
                                <p className="text-sm text-gray-500">Open billing to pay or view invoices</p>
                            </div>
                            <span className={`text-2xl font-bold ${availableCredit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                {formatCurrency(availableCredit)}
                            </span>
                        </button>

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
                    )}

                    {/* Billing & Payments */}
                    {activeSection === 'billing' && account && (
                    <div className="space-y-6">
                        <div className="bg-white rounded-lg shadow-md border border-gray-200 p-6">
                            <div className="flex items-center justify-between gap-4">
                                <div>
                                    <h2 className="text-lg font-bold text-gray-900">Make a Payment</h2>
                                    <p className="text-sm text-gray-500">Top up your account credit</p>
                                </div>
                                <span className={`text-2xl font-bold ${availableCredit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                    {formatCurrency(availableCredit)}
                                </span>
                            </div>
                            <div className="mt-5 space-y-3 sm:flex sm:items-start sm:gap-3 sm:space-y-0">
                                <div className="relative sm:flex-1">
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
                                        className="w-full pl-11 pr-3 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                                    />
                                </div>
                                <button
                                    onClick={handlePayNow}
                                    disabled={paymentLoading}
                                    className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors disabled:opacity-60 sm:w-auto"
                                >
                                    {paymentLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <CreditCard className="h-4 w-4" />}
                                    {paymentLoading ? 'Opening Gateway...' : 'Pay Now'}
                                </button>
                            </div>
                            {paymentError && (
                                <div className="mt-3 flex items-start gap-2 text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg p-2">
                                    <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                                    <span>{paymentError}</span>
                                </div>
                            )}
                        </div>

                        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
                            <div className="bg-white rounded-lg shadow-md border border-gray-200 p-6">
                                <div className="flex items-center justify-between mb-5">
                                    <div>
                                        <h2 className="text-lg font-bold text-gray-900">Current Balance Details</h2>
                                        <p className="text-sm text-gray-500">Credit limit, work placed, and payments made</p>
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
                                    {/* Signed so the column reads as one running sum:
                                        limit - money out + money in = available. Money the partner
                                        pays therefore shows as +, never -. The old card subtracted
                                        payments (they reduce credit *used*) while the bottom line
                                        was a *balance*, so a top-up appeared as a deduction and
                                        then again as a gain - the same rupee three times.

                                        Open orders and outstanding bills are not listed separately:
                                        both are already inside "Orders Placed", and repeating them
                                        read as extra charges. */}
                                    <div className="flex items-center justify-between">
                                        <span className="text-sm text-gray-500">Orders Placed</span>
                                        <span className="font-semibold text-orange-600">
                                            {orderDebitAmount > 0 ? '-' : ''}{formatCurrency(orderDebitAmount)}
                                        </span>
                                    </div>
                                    {pendingBookingAmount > 0 && (
                                        <div className="flex items-center justify-between">
                                            <span className="text-sm text-gray-500">Pending Bookings</span>
                                            <span className="font-semibold text-amber-600">-{formatCurrency(pendingBookingAmount)}</span>
                                        </div>
                                    )}
                                    <div className="flex items-center justify-between">
                                        <span className="text-sm text-gray-500">Online Payments</span>
                                        <span className="font-semibold text-green-600">
                                            {shownGatewayCredit > 0 ? '+' : ''}{formatCurrency(shownGatewayCredit)}
                                        </span>
                                    </div>
                                    {shownManualCredit > 0 && (
                                        <div className="flex items-center justify-between">
                                            <span className="text-sm text-gray-500">Paid at Lab</span>
                                            <span className="font-semibold text-green-600">+{formatCurrency(shownManualCredit)}</span>
                                        </div>
                                    )}
                                    <div className="pt-3 border-t border-gray-200 flex items-center justify-between">
                                        <span className="text-sm font-medium text-gray-700">Available Credit</span>
                                        <span className={`text-xl font-bold ${availableCredit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                            {formatCurrency(availableCredit)}
                                        </span>
                                    </div>
                                    {/* A footnote under the total, not a term above it. At a zero
                                        credit limit the advance IS the available credit, so showing
                                        it as its own row just repeated the same number. It only
                                        carries information once there is a limit to separate it
                                        from - "how much of this headroom is my own money". */}
                                    {advanceBalance > 0 && creditLimit > 0 && (
                                        <div className="text-xs text-gray-500">
                                            Includes {formatCurrency(advanceBalance)} you have paid in advance
                                        </div>
                                    )}
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

                    {/* Chat with the lab */}
                    {activeSection === 'chat' && account && (
                        <div className="bg-white rounded-lg shadow-md border border-gray-200 overflow-hidden">
                            <div className="flex items-center gap-3 px-6 py-4">
                                <div className="h-10 w-10 rounded-lg bg-blue-50 flex items-center justify-center">
                                    <MessageSquare className="h-5 w-5 text-blue-600" />
                                </div>
                                <div>
                                    <h2 className="text-lg font-bold text-gray-900">Chat with the Lab</h2>
                                    <p className="text-sm text-gray-500">
                                        Ask questions and share clinical history or documents
                                    </p>
                                </div>
                            </div>
                            <div className="border-t border-gray-100 bg-gray-50 p-4">
                                <PartnerChatPanel
                                    accountId={account.id}
                                    labId={account.lab_id}
                                    counterpartyName={labInfo?.name || 'the lab'}
                                />
                            </div>
                        </div>
                    )}

                    {/* Material requests */}
                    {activeSection === 'materials' && account && (
                        <div className="bg-white rounded-lg shadow-md border border-gray-200 overflow-hidden">
                            <div className="flex items-center gap-3 px-6 py-4">
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
                            <div className="border-t border-gray-100 bg-gray-50 p-4">
                                <MaterialRequestPanel
                                    accountId={account.id}
                                    labId={account.lab_id}
                                    mode="account"
                                />
                            </div>
                        </div>
                    )}
                </main>
            </div>

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
