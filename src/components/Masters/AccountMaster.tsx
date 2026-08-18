import React, { useState, useEffect } from 'react';
import { Plus, Search, Edit, Trash2, X, DollarSign, Lock, Unlock as LockOpen, Package, Eye, EyeOff, MessageSquare, Wallet, ShieldCheck, ShieldOff, Inbox } from 'lucide-react';
import { database, supabase } from '../../utils/supabase';
import { getUserRoleCode } from '../../utils/permissions';
import { createB2BAccountUser } from '../../utils/b2bAuth';
import HeaderFooterUpload from '../Settings/HeaderFooterUpload';
import AccountCreditModal from './AccountCreditModal';
import PartnerDeskModal from '../B2B/PartnerDeskModal';
import PartnerInboxModal from '../B2B/PartnerInboxModal';
import { fetchLabUnreadCounts, fetchOpenMaterialRequestCounts, subscribeToLabPartnerActivity } from '../../utils/partnerCommsService';

// Reuse Doctor types or create Account specific types?
// Let's define specific types here for simplicity and later move to types.ts

interface Account {
    id: string;
    lab_id?: string;
    name: string;
    code: string | null;
    type: string | null; // 'hospital', 'corporate', 'insurer'
    contact_person?: string | null;  // Optional as it's added via migration
    billing_phone: string | null;
    billing_email: string | null;
    address_line1: string | null;
    default_discount_percent: number | null;
    credit_limit: number | null;
    payment_terms: number | null;
    is_active: boolean;
    billing_mode?: 'standard' | 'monthly' | null;
    price_master_id?: string | null;
    is_locked?: boolean | null;
    locked_reason?: string | null;
    locked_at?: string | null;
    locked_by?: string | null;
    lock_override_until?: string | null;
    bypass_credit_check?: boolean | null;
    credit_bypass_reason?: string | null;
    credit_bypass_set_at?: string | null;
    credit_bypass_set_by?: string | null;
    credit_bypass_until?: string | null;
}

// An account is "effectively locked" when it's locked and any temporary open
// window has expired (or was never granted).
const isAccountEffectivelyLocked = (account: Pick<Account, 'is_locked' | 'lock_override_until'>): boolean => {
    if (!account.is_locked) return false;
    if (account.lock_override_until && new Date(account.lock_override_until).getTime() > Date.now()) return false;
    return true;
};

// The credit bypass may be time-limited the same way: on, but only until
// credit_bypass_until. Past that the flag is still set yet counts for nothing,
// which is what the badge below calls "expired". Mirrors isCreditCheckBypassed
// in utils/accountCredit, the helper every credit gate actually goes through.
const isCreditBypassActive = (account: Pick<Account, 'bypass_credit_check' | 'credit_bypass_until'>): boolean => {
    if (account.bypass_credit_check !== true) return false;
    if (account.credit_bypass_until && new Date(account.credit_bypass_until).getTime() <= Date.now()) return false;
    return true;
};

// Presets offered wherever a bypass window is granted. null = no expiry.
const CREDIT_BYPASS_WINDOWS: { hours: number | null; label: string }[] = [
    { hours: 24, label: '24 hours' },
    { hours: 48, label: '48 hours' },
    { hours: 24 * 7, label: '7 days' },
    { hours: null, label: 'until turned off' },
];

const hoursFromNow = (hours: number) => new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();

interface PriceMaster {
    id: string;
    name: string;
    is_active: boolean;
}

interface AccountPrice {
    id: string;
    account_id: string;
    test_group_id: string;
    price: number;
    source?: 'direct' | 'price_master';
    test_group?: {
        name: string;
        code: string;
        base_price: number;
    }
}

interface TestGroup {
    id: string;
    name: string;
    code: string;
    price: number; // Base price
}

const initialFormData: Partial<Account> = {
    name: '',
    code: '',
    type: 'hospital',
    contact_person: '',
    billing_phone: '',
    billing_email: '',
    address_line1: '',
    default_discount_percent: 0,
    credit_limit: 0,
    payment_terms: 30,
    is_active: true,
    billing_mode: 'standard',
    price_master_id: null,
    bypass_credit_check: false,
};

const initialPortalData = {
    enablePortal: false,
    portalEmail: '',
    portalPassword: '',
};

const buildAccountSavePayload = (data: Partial<Account>) => ({
    name: (data.name || '').trim(),
    code: data.code || null,
    type: data.type || 'hospital',
    contact_person: data.contact_person || null,
    billing_phone: data.billing_phone || null,
    billing_email: data.billing_email || null,
    address_line1: data.address_line1 || null,
    default_discount_percent: Number(data.default_discount_percent || 0),
    credit_limit: Number(data.credit_limit || 0),
    payment_terms: Number(data.payment_terms || 0),
    is_active: data.is_active ?? true,
    billing_mode: data.billing_mode || 'standard',
    price_master_id: data.price_master_id || null,
    bypass_credit_check: data.bypass_credit_check === true,
    credit_bypass_reason: data.bypass_credit_check === true ? ((data.credit_bypass_reason || '').trim() || null) : null,
    credit_bypass_until: data.bypass_credit_check === true ? (data.credit_bypass_until || null) : null,
});

const AccountMaster: React.FC = () => {
    const [accounts, setAccounts] = useState<Account[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchTerm, setSearchTerm] = useState('');
    const [showForm, setShowForm] = useState(false);
    const [editingAccount, setEditingAccount] = useState<Account | null>(null);
    const [formData, setFormData] = useState<Partial<Account>>(initialFormData);
    const [portalData, setPortalData] = useState(initialPortalData);
    const [submitting, setSubmitting] = useState(false);
    const [portalSubmitting, setPortalSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [labId, setLabId] = useState<string | null>(null);

    // Lock/Open feature — admin only
    const [isAdminUser, setIsAdminUser] = useState(false);
    const [currentUserId, setCurrentUserId] = useState<string | null>(null);
    const [lockModalAccount, setLockModalAccount] = useState<Account | null>(null);
    const [lockReason, setLockReason] = useState('');
    const [lockSubmitting, setLockSubmitting] = useState(false);

    // Credit-bypass window — admin only, same submitting flag as the lock
    const [bypassModalAccount, setBypassModalAccount] = useState<Account | null>(null);
    const [bypassReason, setBypassReason] = useState('');

    // Stored portal credential (admin-only view; readable only by lab admins via RLS)
    const [storedCredential, setStoredCredential] = useState<{ email: string; password_text: string; updated_at: string } | null>(null);
    const [storedCredentialLoading, setStoredCredentialLoading] = useState(false);
    const [storedCredentialVisible, setStoredCredentialVisible] = useState(false);

    // Price Management State
    const [showPriceModal, setShowPriceModal] = useState(false);
    const [selectedAccountForPrices, setSelectedAccountForPrices] = useState<Account | null>(null);
    const [accountPrices, setAccountPrices] = useState<AccountPrice[]>([]);
    const [testGroups, setTestGroups] = useState<TestGroup[]>([]);
    const [loadingPrices, setLoadingPrices] = useState(false);
    const [priceSearchTerm, setPriceSearchTerm] = useState('');
    const [priceMasterPrices, setPriceMasterPrices] = useState<Record<string, number>>({});
    
    // Price Masters (for dropdown in form)
    const [availablePriceMasters, setAvailablePriceMasters] = useState<PriceMaster[]>([]);

    // Credit & payments (record cash received against the account's credit)
    const [creditModalAccount, setCreditModalAccount] = useState<Account | null>(null);

    // Partner desk (two-way chat + material requests)
    const [partnerDesk, setPartnerDesk] = useState<{ account: Account; tab: 'chat' | 'materials' } | null>(null);
    const [showPartnerInbox, setShowPartnerInbox] = useState(false);
    const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});
    const [openRequestCounts, setOpenRequestCounts] = useState<Record<string, number>>({});

    const totalUnreadMessages = Object.values(unreadCounts).reduce((sum, count) => sum + count, 0);
    const totalOpenRequests = Object.values(openRequestCounts).reduce((sum, count) => sum + count, 0);

    // Package Pricing State
    const [priceTab, setPriceTab] = useState<'tests' | 'packages'>('tests');
    const [packages, setPackages] = useState<{ id: string; name: string; code: string; price: number }[]>([]);
    const [accountPackagePrices, setAccountPackagePrices] = useState<{ id: string; package_id: string; price: number; package?: { name: string; code: string; price: number } }[]>([]);

    useEffect(() => {
        const init = async () => {
            // Resolve current user + admin status (lock/open is admin-only)
            try {
                const { data: { user } } = await supabase.auth.getUser();
                if (user) {
                    setCurrentUserId(user.id);
                    const roleCode = await getUserRoleCode(user.id, user.email || undefined);
                    setIsAdminUser(roleCode === 'admin');
                }
            } catch (err) {
                console.warn('Could not resolve current user role:', err);
            }

            const id = await database.getCurrentUserLabId();
            if (id) {
                setLabId(id);
                loadAccounts(id);
                loadPartnerCounts(id);
                // Load price masters for the form dropdown
                supabase
                    .from('price_masters')
                    .select('id, name, is_active')
                    .eq('lab_id', id)
                    .eq('is_active', true)
                    .order('name')
                    .then(({ data }) => setAvailablePriceMasters(data || []));
            } else {
                setError('Lab ID not found. Please try logging in again.');
                setLoading(false);
            }
        };
        init();
    }, []);

    const loadAccounts = async (currentLabId?: string) => {
        const activeLabId = currentLabId || labId;
        if (!activeLabId) return;

        setLoading(true);
        setError(null);
        try {
            const { data, error } = await supabase
                .from('accounts')
                .select('*')
                .eq('lab_id', activeLabId)
                .order('name');
            if (error) throw error;
            setAccounts(data || []);
        } catch (err: any) {
            console.error('Error loading accounts:', err);
            setError('Failed to load accounts.');
        } finally {
            setLoading(false);
        }
    };

    // Unread chat messages / open material requests per account, for the row badges
    const loadPartnerCounts = async (currentLabId?: string) => {
        const activeLabId = currentLabId || labId;
        if (!activeLabId) return;

        const [unread, openRequests] = await Promise.all([
            fetchLabUnreadCounts(activeLabId),
            fetchOpenMaterialRequestCounts(activeLabId),
        ]);
        setUnreadCounts(unread);
        setOpenRequestCounts(openRequests);
    };

    // Keep the inbox badge live while this screen is open (debounced, so a burst
    // of partner activity causes one refresh)
    useEffect(() => {
        if (!labId) return;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const unsubscribe = subscribeToLabPartnerActivity(labId, () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => loadPartnerCounts(labId), 800);
        });
        return () => {
            if (timer) clearTimeout(timer);
            unsubscribe();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [labId]);

    const handleSearch = async () => {
        // Implementation similar to DoctorMaster default text filter or DB search
        loadAccounts(labId || undefined); // Refresh for now
    };

    const handleCreateNew = () => {
        setEditingAccount(null);
        setFormData(initialFormData);
        setPortalData(initialPortalData);
        setStoredCredential(null);
        setStoredCredentialVisible(false);
        setShowForm(true);
        setError(null);
    };

    const loadStoredCredential = async (accountId: string) => {
        setStoredCredentialLoading(true);
        setStoredCredential(null);
        setStoredCredentialVisible(false);
        try {
            // Readable only by lab admins (portal_credentials RLS); others simply get no rows
            const { data } = await supabase
                .from('portal_credentials')
                .select('email, password_text, updated_at')
                .eq('account_id', accountId)
                .eq('credential_type', 'b2b_portal')
                .order('updated_at', { ascending: false })
                .limit(1)
                .maybeSingle();
            setStoredCredential(data || null);
        } catch (err) {
            console.warn('Could not load stored portal credential:', err);
            setStoredCredential(null);
        } finally {
            setStoredCredentialLoading(false);
        }
    };

    const handleEdit = (account: Account) => {
        setEditingAccount(account);
        setFormData(account);
        setPortalData({
            ...initialPortalData,
            portalEmail: account.billing_email || '',
        });
        setShowForm(true);
        setError(null);
        loadStoredCredential(account.id);
    };

    const handleCreatePortalUser = async () => {
        if (!editingAccount) return;

        setPortalSubmitting(true);
        setError(null);

        try {
            if (!portalData.portalEmail) {
                setError('Portal email is required when creating portal access.');
                return;
            }
            if (!portalData.portalPassword || portalData.portalPassword.length < 8) {
                setError('Portal password must be at least 8 characters.');
                return;
            }

            const activeLabId = labId || editingAccount.lab_id;
            if (!activeLabId) {
                setError('Lab ID missing. Cannot enable portal access.');
                return;
            }

            const result = await createB2BAccountUser({
                email: portalData.portalEmail,
                password: portalData.portalPassword,
                accountId: editingAccount.id,
                accountName: formData.name || editingAccount.name,
                labId: activeLabId,
            });

            if (result.success) {
                setPortalData(prev => ({ ...prev, portalPassword: '' }));
                loadStoredCredential(editingAccount.id);
                alert(`Partner Portal Access Enabled\nLogin URL: ${window.location.origin}/b2b\nEmail: ${portalData.portalEmail}`);
            } else {
                alert(`Portal access failed: ${result.error}\n\nPlease contact support to enable portal access.`);
            }
        } catch (err: any) {
            console.error('Error creating portal user:', err);
            setError(err.message || 'Failed to create portal access.');
        } finally {
            setPortalSubmitting(false);
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setSubmitting(true);
        setError(null);

        try {
            if (!editingAccount && portalData.enablePortal) {
                if (!portalData.portalEmail) {
                    setError('Portal email is required when enabling portal access.');
                    setSubmitting(false);
                    return;
                }
                if (!portalData.portalPassword || portalData.portalPassword.length < 8) {
                    setError('Portal password must be at least 8 characters.');
                    setSubmitting(false);
                    return;
                }
            }

            const accountPayload: Record<string, unknown> = buildAccountSavePayload(formData);

            // Stamp who switched the credit-check bypass (or moved its expiry), and when
            const bypassToggled = (editingAccount?.bypass_credit_check === true) !== (formData.bypass_credit_check === true);
            const bypassWindowChanged = (editingAccount?.credit_bypass_until || null) !== (formData.credit_bypass_until || null);
            if (bypassToggled || bypassWindowChanged) {
                accountPayload.credit_bypass_set_at = new Date().toISOString();
                accountPayload.credit_bypass_set_by = currentUserId;
            }

            if (editingAccount) {
                const { data, error } = await supabase.from('accounts').update(accountPayload).eq('id', editingAccount.id).select();
                if (error) throw error;
                setAccounts(prev => prev.map(a => a.id === editingAccount.id ? { ...a, ...data[0] } : a));
            } else {
                if (!labId) {
                    setError('Lab ID missing. Cannot create account.');
                    return;
                }

                const newAccount = { ...accountPayload, lab_id: labId };
                const { data, error } = await supabase.from('accounts').insert([newAccount]).select();
                if (error) throw error;

                const createdAccount = data[0];
                setAccounts(prev => [createdAccount, ...prev]);

                // Create partner portal user if enabled
                if (portalData.enablePortal && createdAccount) {
                    const result = await createB2BAccountUser({
                        email: portalData.portalEmail,
                        password: portalData.portalPassword,
                        accountId: createdAccount.id,
                        accountName: createdAccount.name,
                        labId: labId,
                    });

                    if (result.success) {
                        alert(`Account created successfully!\n\nPartner Portal Access Enabled\nLogin URL: ${window.location.origin}/b2b\nEmail: ${portalData.portalEmail}`);
                    } else {
                        alert(`Account created, but portal access failed: ${result.error}\n\nPlease contact support to enable portal access.`);
                    }
                }
            }
            setShowForm(false);
            setFormData(initialFormData);
            setPortalData(initialPortalData);
            setEditingAccount(null);
        } catch (err: any) {
            console.error('Error saving account:', err);
            setError('Failed to save account.');
        } finally {
            setSubmitting(false);
        }
    };

    const handleDelete = async (account: Account) => {
        if (!confirm(`Are you sure you want to delete ${account.name}?`)) return;
        try {
            // Use database.accounts.delete if available, or direct supabase
            const { error } = await supabase.from('accounts').delete().eq('id', account.id);
            if (error) throw error;
            setAccounts(prev => prev.filter(a => a.id !== account.id));
        } catch (err) {
            console.error('Error deleting:', err);
            setError('Failed to delete account.');
        }
    };

    // --- Account Lock / Open (admin only) ---

    const openLockModal = (account: Account) => {
        setLockModalAccount(account);
        setLockReason(account.locked_reason || '');
        setError(null);
    };

    const openBypassModal = (account: Account) => {
        setBypassModalAccount(account);
        setBypassReason(account.credit_bypass_reason || '');
        setError(null);
    };

    // Applies a partial account update (lock state, credit bypass) and refreshes local state
    const applyAccountUpdate = async (account: Account, payload: Partial<Account>) => {
        setLockSubmitting(true);
        setError(null);
        try {
            const { data, error } = await supabase
                .from('accounts')
                .update(payload)
                .eq('id', account.id)
                .select();
            if (error) throw error;
            setAccounts(prev => prev.map(a => (a.id === account.id ? { ...a, ...data[0] } : a)));
            setLockModalAccount(null);
            setLockReason('');
            setBypassModalAccount(null);
            setBypassReason('');
        } catch (err: any) {
            console.error('Error updating account lock state:', err);
            setError(err?.message || 'Failed to update account lock state.');
        } finally {
            setLockSubmitting(false);
        }
    };

    const handleLockAccount = (account: Account) =>
        applyAccountUpdate(account, {
            is_locked: true,
            locked_reason: lockReason.trim() || null,
            locked_at: new Date().toISOString(),
            locked_by: currentUserId,
            lock_override_until: null,
        });

    // Permanent open: clear the lock entirely
    const handleOpenAccount = (account: Account) =>
        applyAccountUpdate(account, {
            is_locked: false,
            lock_override_until: null,
            locked_reason: null,
        });

    // Temporary open: keep locked, but grant an open window for N hours.
    // After the window expires the account is treated as locked again automatically.
    const handleTemporaryOpen = (account: Account, hours: number) =>
        applyAccountUpdate(account, {
            is_locked: true,
            lock_override_until: new Date(Date.now() + hours * 60 * 60 * 1000).toISOString(),
        });

    // --- Credit-check bypass (admin only) ---
    // While on, no credit gate blocks this account: order creation, B2B
    // bookings and portal report downloads all go through even over the limit.
    // Independent of the lock — a locked account stays blocked either way.
    //
    // `hours` grants a window that expires on its own (null = until turned off),
    // the same shape as the lock's temporary open.
    const handleCreditBypass = (account: Account, enabled: boolean, reason: string, hours: number | null) =>
        applyAccountUpdate(account, {
            bypass_credit_check: enabled,
            credit_bypass_reason: enabled ? (reason.trim() || null) : null,
            credit_bypass_until: enabled && hours !== null ? hoursFromNow(hours) : null,
            credit_bypass_set_at: new Date().toISOString(),
            credit_bypass_set_by: currentUserId,
        });

    // --- Price Management Logic ---

    const handleManagePrices = async (account: Account) => {
        setSelectedAccountForPrices(account);
        setShowPriceModal(true);
        setLoadingPrices(true);
        setPriceTab('tests');
        setPriceMasterPrices({});

        try {
            // Fetch Test Groups
            const { data: tgData } = await database.testGroups.getAll();
            setTestGroups(tgData || []);

            // Fetch Existing Test Prices
            const { data: apData } = await supabase
                .from('account_prices')
                .select('*, test_group:test_groups(name, code, price)')
                .eq('account_id', account.id);

            // Map to include base price for easier display
            const formattedPrices = (apData || []).map((ap: any) => ({
                ...ap,
                source: 'direct' as const,
                test_group: {
                    name: ap.test_group.name,
                    code: ap.test_group.code,
                    base_price: ap.test_group.price
                }
            }));

            setAccountPrices(formattedPrices);

            if (account.price_master_id) {
                const { data: pmItems } = await (database as any).priceMasters.getItems(account.price_master_id);
                const inheritedPrices: Record<string, number> = {};
                (pmItems || []).forEach((item: any) => {
                    inheritedPrices[item.test_group_id] = Number(item.price || 0);
                });
                setPriceMasterPrices(inheritedPrices);
            }

            // Fetch Packages
            const { data: pkgData } = await database.packages.getAll();
            setPackages((pkgData || []).map((p: any) => ({ id: p.id, name: p.name, code: p.code, price: p.price })));

            // Fetch Existing Package Prices
            const { data: appData } = await supabase
                .from('account_package_prices')
                .select('*, package:packages(name, code, price)')
                .eq('account_id', account.id);

            setAccountPackagePrices((appData || []).map((ap: any) => ({
                id: ap.id,
                package_id: ap.package_id,
                price: ap.price,
                package: ap.package ? {
                    name: ap.package.name,
                    code: ap.package.code,
                    price: ap.package.price
                } : undefined
            })));

        } catch (err) {
            console.error("Error loading price data", err);
        } finally {
            setLoadingPrices(false);
        }
    };

    const handleSavePrice = async (testGroupId: string, price: number) => {
        if (!selectedAccountForPrices) return;

        try {
            const { error } = await supabase
                .from('account_prices')
                .upsert({
                    account_id: selectedAccountForPrices.id,
                    test_group_id: testGroupId,
                    price: price,
                    updated_at: new Date().toISOString()
                }, { onConflict: 'account_id, test_group_id' }); // Requires unique constraint

            if (error) throw error;

            // Refresh local state
            // Re-fetch or locally update. Let's re-fetch for safety or update locally.
            // Simplified: Re-fetch entire price list for this account
            const { data: apData } = await supabase
                .from('account_prices')
                .select('*, test_group:test_groups(name, code, price)')
                .eq('account_id', selectedAccountForPrices.id);

            const formattedPrices = (apData || []).map((ap: any) => ({
                ...ap,
                source: 'direct' as const,
                test_group: {
                    name: ap.test_group.name,
                    code: ap.test_group.code,
                    base_price: ap.test_group.price
                }
            }));
            setAccountPrices(formattedPrices);

        } catch (err) {
            console.error('Error saving price:', err);
            alert('Failed to save price');
        }
    };

    const handleRemovePrice = async (priceId: string) => {
        if (!confirm('Revert to base price?')) return;
        try {
            const { error } = await supabase.from('account_prices').delete().eq('id', priceId);
            if (error) throw error;
            setAccountPrices(prev => prev.filter(p => p.id !== priceId));
        } catch (err) {
            console.error(err);
        }
    }

    // Package Price Handlers
    const handleSavePackagePrice = async (packageId: string, price: number) => {
        if (!selectedAccountForPrices) return;

        try {
            const { error } = await supabase
                .from('account_package_prices')
                .upsert({
                    account_id: selectedAccountForPrices.id,
                    package_id: packageId,
                    price: price,
                    updated_at: new Date().toISOString()
                }, { onConflict: 'account_id, package_id' });

            if (error) throw error;

            // Refresh package prices
            const { data: appData } = await supabase
                .from('account_package_prices')
                .select('*, package:packages(name, code, price)')
                .eq('account_id', selectedAccountForPrices.id);

            setAccountPackagePrices((appData || []).map((ap: any) => ({
                id: ap.id,
                package_id: ap.package_id,
                price: ap.price,
                package: ap.package ? {
                    name: ap.package.name,
                    code: ap.package.code,
                    price: ap.package.price
                } : undefined
            })));

        } catch (err) {
            console.error('Error saving package price:', err);
            alert('Failed to save package price');
        }
    };

    const handleRemovePackagePrice = async (priceId: string) => {
        if (!confirm('Revert to base price?')) return;
        try {
            const { error } = await supabase.from('account_package_prices').delete().eq('id', priceId);
            if (error) throw error;
            setAccountPackagePrices(prev => prev.filter(p => p.id !== priceId));
        } catch (err) {
            console.error(err);
        }
    };


    const filteredAccounts = accounts.filter(a =>
        !searchTerm || a.name.toLowerCase().includes(searchTerm.toLowerCase())
    );

    const filteredTestGroups = testGroups.filter(tg =>
        !priceSearchTerm || tg.name.toLowerCase().includes(priceSearchTerm.toLowerCase())
    );

    const filteredPackages = packages.filter(pkg =>
        !priceSearchTerm || pkg.name.toLowerCase().includes(priceSearchTerm.toLowerCase())
    );

    return (
        <div className="p-6 max-w-7xl mx-auto">
            <div className="mb-6 flex justify-between items-center">
                <div>
                    <h1 className="text-2xl font-bold text-gray-900 mb-2">Account Master</h1>
                    <p className="text-gray-600">Manage B2B accounts, corporate clients, and their custom pricing.</p>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={() => setShowPartnerInbox(true)}
                        className="relative px-4 py-2 border border-blue-200 bg-blue-50 text-blue-700 rounded-lg hover:bg-blue-100 transition-colors flex items-center gap-2"
                        title="All partner chats and material requests in one place"
                    >
                        <Inbox className="w-4 h-4" />
                        Partner Inbox
                        {totalUnreadMessages > 0 && (
                            <span className="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-red-500 px-1.5 text-[11px] font-semibold text-white">
                                {totalUnreadMessages}
                            </span>
                        )}
                        {totalOpenRequests > 0 && (
                            <span
                                className="flex h-5 min-w-[20px] items-center justify-center gap-0.5 rounded-full bg-amber-500 px-1.5 text-[11px] font-semibold text-white"
                                title={`${totalOpenRequests} open material request(s)`}
                            >
                                <Package className="w-3 h-3" />
                                {totalOpenRequests}
                            </span>
                        )}
                    </button>
                    <button
                        onClick={handleCreateNew}
                        className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors flex items-center gap-2"
                    >
                        <Plus className="w-4 h-4" />
                        Add Account
                    </button>
                </div>
            </div>

            {/* Search Bar */}
            <div className="mb-6 relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-4 h-4" />
                <input
                    type="text"
                    placeholder="Search accounts..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                />
            </div>

            {/* Accounts List */}
            <div className="bg-white rounded-lg shadow overflow-hidden">
                <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                        <tr>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Account</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Contact</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Type</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                            <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200">
                        {filteredAccounts.map(account => (
                            <tr key={account.id} className="hover:bg-gray-50">
                                <td className="px-6 py-4">
                                    <div className="text-sm font-medium text-gray-900">{account.name}</div>
                                    <div className="flex items-center gap-2 mt-0.5">
                                        <span className="text-sm text-gray-500">{account.code || '-'}</span>
                                        {account.price_master_id && (() => {
                                            const pm = availablePriceMasters.find(p => p.id === account.price_master_id);
                                            return pm ? (
                                                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-indigo-100 text-indigo-700">
                                                    {pm.name}
                                                </span>
                                            ) : null;
                                        })()}
                                    </div>
                                </td>
                                <td className="px-6 py-4">
                                    <div className="text-sm text-gray-900">{account.billing_phone}</div>
                                    <div className="text-sm text-gray-500">{account.billing_email}</div>
                                </td>
                                <td className="px-6 py-4">
                                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800 capitalize">
                                        {account.type || 'Standard'}
                                    </span>
                                </td>
                                <td className="px-6 py-4">
                                    <div className="flex flex-col items-start gap-1">
                                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${account.is_active ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
                                            {account.is_active ? 'Active' : 'Inactive'}
                                        </span>
                                        {account.is_locked && (
                                            isAccountEffectivelyLocked(account) ? (
                                                <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800" title={account.locked_reason || undefined}>
                                                    <Lock className="w-3 h-3" /> Locked
                                                </span>
                                            ) : (
                                                <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800">
                                                    <LockOpen className="w-3 h-3" /> Open till {new Date(account.lock_override_until as string).toLocaleString()}
                                                </span>
                                            )
                                        )}
                                        {account.bypass_credit_check && (
                                            isCreditBypassActive(account) ? (
                                                <span
                                                    className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800"
                                                    title={account.credit_bypass_reason || 'Credit limit check is bypassed for this account'}
                                                >
                                                    <ShieldCheck className="w-3 h-3" />
                                                    {account.credit_bypass_until
                                                        ? `Credit bypass till ${new Date(account.credit_bypass_until).toLocaleString()}`
                                                        : 'Credit bypass'}
                                                </span>
                                            ) : (
                                                <span
                                                    className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-600"
                                                    title={`Bypass window ended ${new Date(account.credit_bypass_until as string).toLocaleString()} — credit limit is enforced again`}
                                                >
                                                    <ShieldOff className="w-3 h-3" /> Bypass expired
                                                </span>
                                            )
                                        )}
                                    </div>
                                </td>
                                <td className="px-6 py-4 text-right space-x-2">
                                    {isAdminUser && (
                                        <button
                                            onClick={() => openBypassModal(account)}
                                            className={`p-1 ${isCreditBypassActive(account) ? 'text-amber-600 hover:text-amber-900' : 'text-gray-500 hover:text-gray-800'}`}
                                            title={isCreditBypassActive(account) ? 'Credit check bypassed — manage window' : 'Bypass credit limit check'}
                                        >
                                            {isCreditBypassActive(account) ? <ShieldCheck className="w-4 h-4" /> : <ShieldOff className="w-4 h-4" />}
                                        </button>
                                    )}
                                    {isAdminUser && (
                                        <button
                                            onClick={() => openLockModal(account)}
                                            className={`p-1 ${isAccountEffectivelyLocked(account) ? 'text-red-600 hover:text-red-900' : account.is_locked ? 'text-amber-600 hover:text-amber-900' : 'text-gray-500 hover:text-gray-800'}`}
                                            title={isAccountEffectivelyLocked(account) ? 'Account locked — manage / open' : account.is_locked ? 'Temporarily open — manage' : 'Lock account'}
                                        >
                                            {isAccountEffectivelyLocked(account) ? <Lock className="w-4 h-4" /> : <LockOpen className="w-4 h-4" />}
                                        </button>
                                    )}
                                    <button
                                        onClick={() => setPartnerDesk({ account, tab: 'chat' })}
                                        className="relative text-blue-600 hover:text-blue-900 p-1"
                                        title="Chat with this partner"
                                    >
                                        <MessageSquare className="w-4 h-4" />
                                        {unreadCounts[account.id] > 0 && (
                                            <span className="absolute -top-1 -right-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white">
                                                {unreadCounts[account.id]}
                                            </span>
                                        )}
                                    </button>
                                    <button
                                        onClick={() => setPartnerDesk({ account, tab: 'materials' })}
                                        className="relative text-emerald-600 hover:text-emerald-900 p-1"
                                        title="Material requests"
                                    >
                                        <Package className="w-4 h-4" />
                                        {openRequestCounts[account.id] > 0 && (
                                            <span className="absolute -top-1 -right-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-semibold text-white">
                                                {openRequestCounts[account.id]}
                                            </span>
                                        )}
                                    </button>
                                    <button
                                        onClick={() => setCreditModalAccount(account)}
                                        className="text-emerald-700 hover:text-emerald-900 p-1"
                                        title="Credit & payments — record cash received"
                                    >
                                        <Wallet className="w-4 h-4" />
                                    </button>
                                    <button onClick={() => handleManagePrices(account)} className="text-purple-600 hover:text-purple-900 p-1" title="Manage Prices">
                                        <DollarSign className="w-4 h-4" />
                                    </button>
                                    <button onClick={() => handleEdit(account)} className="text-blue-600 hover:text-blue-900 p-1" title="Edit">
                                        <Edit className="w-4 h-4" />
                                    </button>
                                    <button onClick={() => handleDelete(account)} className="text-red-600 hover:text-red-900 p-1" title="Delete">
                                        <Trash2 className="w-4 h-4" />
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {/* Add/Edit Modal */}
            {showForm && (
                <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
                    <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] flex flex-col">
                        <div className="flex justify-between p-6 border-b">
                            <h2 className="text-xl font-bold">{editingAccount ? 'Edit Account' : 'New Account'}</h2>
                            <button onClick={() => setShowForm(false)}><X className="w-6 h-6" /></button>
                        </div>
                        <form onSubmit={handleSubmit} className="flex flex-col flex-1 overflow-hidden">
                            <div className="flex-1 overflow-y-auto p-6">
                                <div className="grid grid-cols-2 gap-4">
                                    <div className="col-span-2">
                                        <label className="block text-sm font-medium mb-1">Account Name</label>
                                        <input type="text" required value={formData.name} onChange={e => setFormData({ ...formData, name: e.target.value })} className="w-full border rounded p-2" />
                                    </div>
                                    <div>
                                        <label className="block text-sm font-medium mb-1">Account Code</label>
                                        <input type="text" value={formData.code || ''} onChange={e => setFormData({ ...formData, code: e.target.value })} className="w-full border rounded p-2" />
                                    </div>
                                    <div>
                                        <label className="block text-sm font-medium mb-1">Account Type</label>
                                        <select value={formData.type || 'hospital'} onChange={e => setFormData({ ...formData, type: e.target.value })} className="w-full border rounded p-2">
                                            <option value="hospital">Hospital</option>
                                            <option value="corporate">Corporate</option>
                                            <option value="insurer">Insurance Company</option>
                                            <option value="collection_center">Collection Center</option>
                                            <option value="lab_to_lab">Lab to Lab</option>
                                        </select>
                                    </div>
                                    <div>
                                        <label className="block text-sm font-medium mb-1">Email</label>
                                        <input type="email" value={formData.billing_email || ''} onChange={e => setFormData({ ...formData, billing_email: e.target.value })} className="w-full border rounded p-2" />
                                    </div>
                                    <div>
                                        <label className="block text-sm font-medium mb-1">Phone</label>
                                        <input type="text" value={formData.billing_phone || ''} onChange={e => setFormData({ ...formData, billing_phone: e.target.value })} className="w-full border rounded p-2" />
                                    </div>
                                    <div className="col-span-2">
                                        <label className="block text-sm font-medium mb-1">Address</label>
                                        <textarea value={formData.address_line1 || ''} onChange={e => setFormData({ ...formData, address_line1: e.target.value })} className="w-full border rounded p-2" rows={2}></textarea>
                                    </div>
                                    <div>
                                        <label className="block text-sm font-medium mb-1">Credit Limit (₹)</label>
                                        <input type="number" value={formData.credit_limit || 0} onChange={e => setFormData({ ...formData, credit_limit: Number(e.target.value) })} className="w-full border rounded p-2" />
                                    </div>
                                    <div>
                                        <label className="block text-sm font-medium mb-1">Default Discount (%)</label>
                                        <input type="number" max="100" value={formData.default_discount_percent || 0} onChange={e => setFormData({ ...formData, default_discount_percent: Number(e.target.value) })} className="w-full border rounded p-2" />
                                    </div>
                                    {/* Credit-check bypass — admin only, mirrors the lock control */}
                                    <div className="col-span-2 rounded border border-amber-200 bg-amber-50 p-3">
                                        <label className={`flex items-start gap-2 ${isAdminUser ? 'cursor-pointer' : 'cursor-not-allowed opacity-70'}`}>
                                            <input
                                                type="checkbox"
                                                checked={formData.bypass_credit_check === true}
                                                disabled={!isAdminUser}
                                                onChange={e => setFormData({ ...formData, bypass_credit_check: e.target.checked })}
                                                className="mt-0.5 h-4 w-4"
                                            />
                                            <span className="text-sm">
                                                <span className="font-medium flex items-center gap-1.5">
                                                    <ShieldCheck className="w-4 h-4 text-amber-600" />
                                                    Bypass credit limit check
                                                </span>
                                                <span className="block text-xs text-gray-600 mt-0.5">
                                                    Orders, B2B bookings and portal report downloads stay allowed even when this
                                                    account is over its credit limit. Does not unlock a locked account.
                                                    {!isAdminUser && ' Only an admin can change this.'}
                                                </span>
                                            </span>
                                        </label>
                                        {formData.bypass_credit_check === true && (
                                            <>
                                                <input
                                                    type="text"
                                                    value={formData.credit_bypass_reason || ''}
                                                    disabled={!isAdminUser}
                                                    onChange={e => setFormData({ ...formData, credit_bypass_reason: e.target.value })}
                                                    placeholder="Reason (optional) — e.g. approved by management"
                                                    className="mt-2 w-full border rounded p-2 text-sm disabled:bg-gray-100"
                                                />
                                                {/* Optional expiry, like the lock's temporary-open window */}
                                                <label className="block text-xs font-medium text-gray-700 mt-2 mb-1">Bypass window</label>
                                                <select
                                                    value={formData.credit_bypass_until ? 'keep' : 'none'}
                                                    disabled={!isAdminUser}
                                                    onChange={e => {
                                                        const choice = e.target.value;
                                                        if (choice === 'keep') return;
                                                        setFormData({
                                                            ...formData,
                                                            credit_bypass_until: choice === 'none' ? null : hoursFromNow(Number(choice)),
                                                        });
                                                    }}
                                                    className="w-full border rounded p-2 text-sm disabled:bg-gray-100"
                                                >
                                                    {formData.credit_bypass_until && (
                                                        <option value="keep">
                                                            Keep current — {new Date(formData.credit_bypass_until).getTime() > Date.now() ? 'till' : 'expired'} {new Date(formData.credit_bypass_until).toLocaleString()}
                                                        </option>
                                                    )}
                                                    <option value="none">No expiry — until turned off</option>
                                                    {CREDIT_BYPASS_WINDOWS.filter(w => w.hours !== null).map(w => (
                                                        <option key={w.label} value={String(w.hours)}>{w.label} from now (auto-expires)</option>
                                                    ))}
                                                </select>
                                            </>
                                        )}
                                    </div>
                                    {/* Price Master */}
                                    <div className="col-span-2 border-t pt-4 mt-2">
                                        <label className="block text-sm font-medium mb-1 text-gray-700">Price Plan (Price Master)</label>
                                        <select
                                            value={formData.price_master_id || ''}
                                            onChange={e => setFormData({ ...formData, price_master_id: e.target.value || null })}
                                            className="w-full border rounded p-2 text-sm"
                                        >
                                            <option value="">— No price plan (use base / per-account prices) —</option>
                                            {availablePriceMasters.map(pm => (
                                                <option key={pm.id} value={pm.id}>{pm.name}</option>
                                            ))}
                                        </select>
                                        <p className="text-xs text-gray-500 mt-1">
                                            When a plan is selected, its test prices take priority over individual account prices. Manage plans in Settings → Price Masters.
                                        </p>
                                    </div>

                                    <div className="col-span-2 border-t pt-4 mt-2">
                                        <label className="block text-sm font-medium mb-2 text-gray-700">Billing Mode</label>
                                        <div className="flex gap-6">
                                            <label className="flex items-center cursor-pointer">
                                                <input
                                                    type="radio"
                                                    name="billing_mode"
                                                    value="standard"
                                                    checked={formData.billing_mode === 'standard' || !formData.billing_mode}
                                                    onChange={e => setFormData({ ...formData, billing_mode: e.target.value as 'standard' | 'monthly' })}
                                                    className="mr-2"
                                                />
                                                <div>
                                                    <span className="font-medium text-gray-900">Standard (Per-Order Invoice)</span>
                                                    <p className="text-xs text-gray-500">Invoice generated for each individual order</p>
                                                </div>
                                            </label>
                                            <label className="flex items-center cursor-pointer">
                                                <input
                                                    type="radio"
                                                    name="billing_mode"
                                                    value="monthly"
                                                    checked={formData.billing_mode === 'monthly'}
                                                    onChange={e => setFormData({ ...formData, billing_mode: e.target.value as 'standard' | 'monthly' })}
                                                    className="mr-2"
                                                />
                                                <div>
                                                    <span className="font-medium text-gray-900">Monthly Consolidated Billing</span>
                                                    <p className="text-xs text-gray-500">Orders accumulate for month-end consolidated invoice</p>
                                                </div>
                                            </label>
                                        </div>
                                        <div className="mt-2 text-xs text-purple-600 bg-purple-50 p-2 rounded">
                                            💡 Monthly billing: No individual invoices or payment reminders. All orders in billing period are included in one consolidated invoice.
                                        </div>
                                    </div>

                                    <div className="col-span-2 border-t pt-4 mt-2">
                                        {!editingAccount ? (
                                            <div className="flex items-center mb-4">
                                                <input
                                                    type="checkbox"
                                                    id="enablePortal"
                                                    checked={portalData.enablePortal}
                                                    onChange={(e) => setPortalData({ ...portalData, enablePortal: e.target.checked })}
                                                    className="mr-2 h-4 w-4 text-blue-600 rounded"
                                                />
                                                <label htmlFor="enablePortal" className="flex items-center text-sm font-medium text-gray-700 cursor-pointer">
                                                    <Lock className="w-4 h-4 mr-2 text-blue-600" />
                                                    Enable Partner Portal Access
                                                </label>
                                            </div>
                                        ) : (
                                            <div className="flex items-center mb-4">
                                                <Lock className="w-4 h-4 mr-2 text-blue-600" />
                                                <span className="text-sm font-medium text-gray-700">Partner Portal Access</span>
                                            </div>
                                        )}
                                        <p className="text-xs text-gray-500 mb-4">
                                            Allow this account to access the partner portal to view their orders and download reports.
                                        </p>

                                        {editingAccount && (storedCredentialLoading || storedCredential) && (
                                            <div className="mb-4 bg-purple-50 border border-purple-200 rounded-lg p-4">
                                                <div className="flex items-center justify-between mb-2">
                                                    <span className="text-sm font-medium text-purple-900">Current Portal Login (admin view)</span>
                                                    {storedCredential && (
                                                        <button
                                                            type="button"
                                                            onClick={() => setStoredCredentialVisible(v => !v)}
                                                            className="p-1 text-purple-600 hover:text-purple-800 rounded"
                                                            title={storedCredentialVisible ? 'Hide password' : 'Show password'}
                                                        >
                                                            {storedCredentialVisible ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                                        </button>
                                                    )}
                                                </div>
                                                {storedCredentialLoading ? (
                                                    <p className="text-xs text-purple-700">Loading stored credential…</p>
                                                ) : storedCredential ? (
                                                    <div className="text-sm text-purple-900 space-y-1">
                                                        <div><span className="text-purple-600">Email:</span> {storedCredential.email}</div>
                                                        <div className="flex items-center gap-2">
                                                            <span className="text-purple-600">Password:</span>
                                                            <span className="font-mono">{storedCredentialVisible ? storedCredential.password_text : '••••••••••'}</span>
                                                            {storedCredentialVisible && (
                                                                <button
                                                                    type="button"
                                                                    onClick={() => navigator.clipboard.writeText(storedCredential.password_text)}
                                                                    className="text-xs text-purple-600 hover:text-purple-800 underline"
                                                                >
                                                                    Copy
                                                                </button>
                                                            )}
                                                        </div>
                                                        <p className="text-xs text-purple-600">Last set: {new Date(storedCredential.updated_at).toLocaleString()}</p>
                                                    </div>
                                                ) : null}
                                            </div>
                                        )}

                                        {(editingAccount || portalData.enablePortal) && (
                                            <div className="grid grid-cols-2 gap-4 bg-blue-50 p-4 rounded-lg">
                                                <div className="col-span-2">
                                                    <label className="block text-sm font-medium mb-1 text-gray-700">Portal Login Email *</label>
                                                    <input
                                                        type="email"
                                                        required={!editingAccount && portalData.enablePortal}
                                                        value={portalData.portalEmail}
                                                        onChange={(e) => setPortalData({ ...portalData, portalEmail: e.target.value })}
                                                        className="w-full border rounded p-2"
                                                        placeholder="portal@hospital.com"
                                                    />
                                                    <p className="text-xs text-gray-500 mt-1">This email will be used to login to the partner portal</p>
                                                </div>
                                                <div className="col-span-2">
                                                    <label className="block text-sm font-medium mb-1 text-gray-700">Portal Password *</label>
                                                    <input
                                                        type="password"
                                                        required={!editingAccount && portalData.enablePortal}
                                                        value={portalData.portalPassword}
                                                        onChange={(e) => setPortalData({ ...portalData, portalPassword: e.target.value })}
                                                        className="w-full border rounded p-2"
                                                        placeholder="Minimum 8 characters"
                                                        minLength={8}
                                                    />
                                                    <p className="text-xs text-gray-500 mt-1">Minimum 8 characters. Share this securely with the account.</p>
                                                </div>
                                                <div className="col-span-2 bg-blue-100 p-3 rounded">
                                                    <p className="text-xs text-blue-800">
                                                        <strong>Portal URL:</strong> {window.location.origin}/b2b<br />
                                                        The account will be able to view their orders, track status, and download reports.
                                                    </p>
                                                </div>
                                                {editingAccount && (
                                                    <div className="col-span-2 flex justify-end">
                                                        <button
                                                            type="button"
                                                            onClick={handleCreatePortalUser}
                                                            disabled={portalSubmitting}
                                                            className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                                                        >
                                                            {portalSubmitting ? 'Creating...' : 'Create Portal User'}
                                                        </button>
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                </div>

                                {/* Report Customization - Only for existing accounts */}
                                {editingAccount && (
                                    <div className="col-span-2 border-t pt-4 mt-4">
                                        <HeaderFooterUpload
                                            entityType="account"
                                            entityId={editingAccount.id}
                                            entityName={editingAccount.name}
                                        />
                                    </div>
                                )}
                            </div>
                            <div className="border-t p-6 bg-gray-50">
                                <div className="flex justify-end gap-3">
                                    <button type="button" onClick={() => setShowForm(false)} className="px-4 py-2 border rounded hover:bg-gray-50">Cancel</button>
                                    <button type="submit" disabled={submitting} className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50">Save</button>
                                </div>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* Price Management Modal */}
            {
                showPriceModal && selectedAccountForPrices && (
                    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
                        <div className="bg-white rounded-lg shadow-xl max-w-4xl w-full h-[80vh] flex flex-col">
                            <div className="p-4 border-b flex justify-between items-center bg-gray-50">
                                <div>
                                    <h2 className="text-xl font-bold text-gray-900">Manage Prices: {selectedAccountForPrices.name}</h2>
                                    <p className="text-sm text-gray-500">Set fixed prices for specific tests and packages. These override base prices and percentage discounts.</p>
                                    {selectedAccountForPrices.price_master_id && (
                                        <p className="text-xs text-indigo-600 mt-1">Linked price master values are shown as inherited prices. Direct account prices override them.</p>
                                    )}
                                </div>
                                <button onClick={() => setShowPriceModal(false)}><X className="w-6 h-6 text-gray-500" /></button>
                            </div>

                            {/* Tabs */}
                            <div className="flex border-b bg-gray-50 px-4">
                                <button
                                    onClick={() => setPriceTab('tests')}
                                    className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                                        priceTab === 'tests'
                                            ? 'border-purple-600 text-purple-600'
                                            : 'border-transparent text-gray-500 hover:text-gray-700'
                                    }`}
                                >
                                    <DollarSign className="w-4 h-4 inline mr-2" />
                                    Test Prices ({accountPrices.length} custom{Object.keys(priceMasterPrices).length ? `, ${Object.keys(priceMasterPrices).length} inherited` : ''})
                                </button>
                                <button
                                    onClick={() => setPriceTab('packages')}
                                    className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                                        priceTab === 'packages'
                                            ? 'border-purple-600 text-purple-600'
                                            : 'border-transparent text-gray-500 hover:text-gray-700'
                                    }`}
                                >
                                    <Package className="w-4 h-4 inline mr-2" />
                                    Package Prices ({accountPackagePrices.length} custom)
                                </button>
                            </div>

                            <div className="p-4 border-b">
                                <input
                                    type="text"
                                    placeholder={`Search ${priceTab === 'tests' ? 'tests' : 'packages'}...`}
                                    value={priceSearchTerm}
                                    onChange={e => setPriceSearchTerm(e.target.value)}
                                    className="w-full border p-2 rounded"
                                />
                            </div>

                            <div className="flex-1 overflow-y-auto p-4">
                                {priceTab === 'tests' ? (
                                    <table className="min-w-full divide-y divide-gray-200">
                                        <thead>
                                            <tr>
                                                <th className="text-left py-2 font-medium text-gray-500">Test Name</th>
                                                <th className="text-left py-2 font-medium text-gray-500">Base Price</th>
                                                <th className="text-left py-2 font-medium text-gray-500">Account Price</th>
                                                <th className="text-right py-2 font-medium text-gray-500">Action</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-gray-100">
                                            {filteredTestGroups.map(tg => {
                                                const override = accountPrices.find(ap => ap.test_group_id === tg.id);
                                                const inheritedPrice = priceMasterPrices[tg.id];
                                                const effectivePrice = override ? override.price : inheritedPrice;
                                                return (
                                                    <tr key={tg.id} className={override ? "bg-purple-50" : inheritedPrice !== undefined ? "bg-indigo-50" : ""}>
                                                        <td className="py-2 text-sm">{tg.name} <span className="text-xs text-gray-400">({tg.code})</span></td>
                                                        <td className="py-2 text-sm">₹{tg.price}</td>
                                                        <td className="py-2">
                                                            <input
                                                                type="number"
                                                                defaultValue={effectivePrice ?? ''}
                                                                placeholder={override ? String(override.price) : inheritedPrice !== undefined ? `Inherited ${inheritedPrice}` : "Default"}
                                                                onBlur={(e) => {
                                                                    const val = parseFloat(e.target.value);
                                                                    if (!isNaN(val)) {
                                                                        handleSavePrice(tg.id, val);
                                                                    }
                                                                }}
                                                                className="border rounded px-2 py-1 w-24 text-sm"
                                                            />
                                                        </td>
                                                        <td className="py-2 text-right">
                                                            {override ? (
                                                                <div className="flex items-center justify-end gap-3">
                                                                    <span className="text-xs text-purple-700 font-medium">Direct</span>
                                                                    <button
                                                                        onClick={() => handleRemovePrice(override.id)}
                                                                        className="text-red-500 hover:text-red-700 text-xs underline"
                                                                    >
                                                                        {inheritedPrice !== undefined ? 'Use Price List' : 'Reset'}
                                                                    </button>
                                                                </div>
                                                            ) : inheritedPrice !== undefined ? (
                                                                <span className="text-xs text-indigo-700 font-medium">Price List</span>
                                                            ) : null}
                                                        </td>
                                                    </tr>
                                                )
                                            })}
                                        </tbody>
                                    </table>
                                ) : (
                                    <table className="min-w-full divide-y divide-gray-200">
                                        <thead>
                                            <tr>
                                                <th className="text-left py-2 font-medium text-gray-500">Package Name</th>
                                                <th className="text-left py-2 font-medium text-gray-500">Base Price</th>
                                                <th className="text-left py-2 font-medium text-gray-500">Account Price</th>
                                                <th className="text-right py-2 font-medium text-gray-500">Action</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-gray-100">
                                            {filteredPackages.length === 0 ? (
                                                <tr>
                                                    <td colSpan={4} className="py-8 text-center text-gray-500">
                                                        No packages found. Create packages in Test Configuration first.
                                                    </td>
                                                </tr>
                                            ) : filteredPackages.map(pkg => {
                                                const override = accountPackagePrices.find(ap => ap.package_id === pkg.id);
                                                return (
                                                    <tr key={pkg.id} className={override ? "bg-purple-50" : ""}>
                                                        <td className="py-2 text-sm">{pkg.name} <span className="text-xs text-gray-400">({pkg.code})</span></td>
                                                        <td className="py-2 text-sm">₹{pkg.price}</td>
                                                        <td className="py-2">
                                                            <input
                                                                type="number"
                                                                defaultValue={override ? override.price : ''}
                                                                placeholder={override ? String(override.price) : "Default"}
                                                                onBlur={(e) => {
                                                                    const val = parseFloat(e.target.value);
                                                                    if (!isNaN(val)) {
                                                                        handleSavePackagePrice(pkg.id, val);
                                                                    }
                                                                }}
                                                                className="border rounded px-2 py-1 w-24 text-sm"
                                                            />
                                                        </td>
                                                        <td className="py-2 text-right">
                                                            {override && (
                                                                <button
                                                                    onClick={() => handleRemovePackagePrice(override.id)}
                                                                    className="text-red-500 hover:text-red-700 text-xs underline"
                                                                >
                                                                    Reset
                                                                </button>
                                                            )}
                                                        </td>
                                                    </tr>
                                                )
                                            })}
                                        </tbody>
                                    </table>
                                )}
                            </div>
                        </div>
                    </div>
                )
            }

            {/* Lock / Open Modal (admin only) */}
            {lockModalAccount && (
                <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
                    <div className="bg-white rounded-lg shadow-xl max-w-md w-full">
                        <div className="flex justify-between items-center p-5 border-b">
                            <h2 className="text-lg font-bold flex items-center gap-2">
                                {isAccountEffectivelyLocked(lockModalAccount)
                                    ? <><Lock className="w-5 h-5 text-red-600" /> Locked Account</>
                                    : lockModalAccount.is_locked
                                        ? <><LockOpen className="w-5 h-5 text-amber-600" /> Temporarily Open</>
                                        : <><Lock className="w-5 h-5 text-gray-600" /> Lock Account</>}
                            </h2>
                            <button onClick={() => setLockModalAccount(null)} disabled={lockSubmitting}><X className="w-6 h-6" /></button>
                        </div>
                        <div className="p-5 space-y-4">
                            <div className="text-sm text-gray-700">
                                <span className="font-medium">{lockModalAccount.name}</span>
                                {lockModalAccount.code ? <span className="text-gray-500"> ({lockModalAccount.code})</span> : null}
                            </div>

                            {lockModalAccount.is_locked && (
                                <div className="text-xs bg-gray-50 border rounded p-3 space-y-1 text-gray-600">
                                    {lockModalAccount.locked_reason && <div><span className="font-medium text-gray-700">Reason:</span> {lockModalAccount.locked_reason}</div>}
                                    {lockModalAccount.locked_at && <div><span className="font-medium text-gray-700">Locked at:</span> {new Date(lockModalAccount.locked_at).toLocaleString()}</div>}
                                    {!isAccountEffectivelyLocked(lockModalAccount) && lockModalAccount.lock_override_until && (
                                        <div className="text-amber-700"><span className="font-medium">Temporarily open until:</span> {new Date(lockModalAccount.lock_override_until).toLocaleString()}</div>
                                    )}
                                </div>
                            )}

                            {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded p-2">{error}</div>}

                            {!lockModalAccount.is_locked ? (
                                // Currently open → offer to lock
                                <>
                                    <p className="text-sm text-gray-600">Locking this account blocks new order creation against it for everyone. Only an admin can open it again.</p>
                                    <div>
                                        <label className="block text-sm font-medium mb-1">Reason (optional)</label>
                                        <textarea
                                            value={lockReason}
                                            onChange={e => setLockReason(e.target.value)}
                                            rows={2}
                                            placeholder="e.g. Payment overdue, credit on hold"
                                            className="w-full border rounded p-2 text-sm"
                                        />
                                    </div>
                                    <div className="flex justify-end gap-3 pt-1">
                                        <button onClick={() => setLockModalAccount(null)} disabled={lockSubmitting} className="px-4 py-2 border rounded hover:bg-gray-50 text-sm">Cancel</button>
                                        <button onClick={() => handleLockAccount(lockModalAccount)} disabled={lockSubmitting} className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50 text-sm flex items-center gap-2">
                                            <Lock className="w-4 h-4" /> {lockSubmitting ? 'Saving…' : 'Lock Account'}
                                        </button>
                                    </div>
                                </>
                            ) : (
                                // Currently locked → offer to open (permanent or temporary)
                                <>
                                    <p className="text-sm text-gray-600">Open this account to allow order creation again.</p>
                                    <div className="grid gap-2">
                                        <button onClick={() => handleOpenAccount(lockModalAccount)} disabled={lockSubmitting} className="w-full px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50 text-sm flex items-center justify-center gap-2">
                                            <LockOpen className="w-4 h-4" /> Open Permanently
                                        </button>
                                        <button onClick={() => handleTemporaryOpen(lockModalAccount, 24)} disabled={lockSubmitting} className="w-full px-4 py-2 bg-amber-500 text-white rounded hover:bg-amber-600 disabled:opacity-50 text-sm flex items-center justify-center gap-2">
                                            <LockOpen className="w-4 h-4" /> Open for 24 hours (auto re-locks)
                                        </button>
                                        {!isAccountEffectivelyLocked(lockModalAccount) && (
                                            <button onClick={() => handleLockAccount(lockModalAccount)} disabled={lockSubmitting} className="w-full px-4 py-2 border border-red-300 text-red-700 rounded hover:bg-red-50 disabled:opacity-50 text-sm flex items-center justify-center gap-2">
                                                <Lock className="w-4 h-4" /> Cancel temporary window (lock now)
                                            </button>
                                        )}
                                    </div>
                                    <div className="flex justify-end pt-1">
                                        <button onClick={() => setLockModalAccount(null)} disabled={lockSubmitting} className="px-4 py-2 border rounded hover:bg-gray-50 text-sm">Close</button>
                                    </div>
                                </>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* Credit-bypass window (admin only) — same shape as the lock's temporary open */}
            {bypassModalAccount && (
                <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
                    <div className="bg-white rounded-lg shadow-xl max-w-md w-full">
                        <div className="flex justify-between items-center p-5 border-b">
                            <h2 className="text-lg font-bold flex items-center gap-2">
                                {isCreditBypassActive(bypassModalAccount)
                                    ? <><ShieldCheck className="w-5 h-5 text-amber-600" /> Credit Check Bypassed</>
                                    : <><ShieldOff className="w-5 h-5 text-gray-600" /> Bypass Credit Check</>}
                            </h2>
                            <button onClick={() => setBypassModalAccount(null)} disabled={lockSubmitting}><X className="w-6 h-6" /></button>
                        </div>
                        <div className="p-5 space-y-4">
                            <div className="text-sm text-gray-700">
                                <span className="font-medium">{bypassModalAccount.name}</span>
                                {bypassModalAccount.code ? <span className="text-gray-500"> ({bypassModalAccount.code})</span> : null}
                            </div>

                            {bypassModalAccount.bypass_credit_check && (
                                <div className="text-xs bg-gray-50 border rounded p-3 space-y-1 text-gray-600">
                                    {bypassModalAccount.credit_bypass_reason && <div><span className="font-medium text-gray-700">Reason:</span> {bypassModalAccount.credit_bypass_reason}</div>}
                                    {bypassModalAccount.credit_bypass_set_at && <div><span className="font-medium text-gray-700">Set at:</span> {new Date(bypassModalAccount.credit_bypass_set_at).toLocaleString()}</div>}
                                    {bypassModalAccount.credit_bypass_until ? (
                                        isCreditBypassActive(bypassModalAccount) ? (
                                            <div className="text-amber-700"><span className="font-medium">Bypass runs until:</span> {new Date(bypassModalAccount.credit_bypass_until).toLocaleString()}</div>
                                        ) : (
                                            <div className="text-gray-700"><span className="font-medium">Expired on:</span> {new Date(bypassModalAccount.credit_bypass_until).toLocaleString()} — the credit limit is being enforced again.</div>
                                        )
                                    ) : (
                                        <div className="text-amber-700 font-medium">No expiry — runs until turned off.</div>
                                    )}
                                </div>
                            )}

                            {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded p-2">{error}</div>}

                            <p className="text-sm text-gray-600">
                                While the bypass is on, orders, B2B bookings and portal report downloads go through even when this
                                account is over its credit limit. The credit figures are still calculated and shown. It does not
                                unlock a locked account.
                            </p>

                            <div>
                                <label className="block text-sm font-medium mb-1">Reason (optional)</label>
                                <textarea
                                    value={bypassReason}
                                    onChange={e => setBypassReason(e.target.value)}
                                    rows={2}
                                    placeholder="e.g. Approved by management, payment in transit"
                                    className="w-full border rounded p-2 text-sm"
                                />
                            </div>

                            <div className="grid gap-2">
                                {CREDIT_BYPASS_WINDOWS.map(window => (
                                    <button
                                        key={window.label}
                                        onClick={() => handleCreditBypass(bypassModalAccount, true, bypassReason, window.hours)}
                                        disabled={lockSubmitting}
                                        className={`w-full px-4 py-2 rounded text-white disabled:opacity-50 text-sm flex items-center justify-center gap-2 ${window.hours === null ? 'bg-gray-600 hover:bg-gray-700' : 'bg-amber-500 hover:bg-amber-600'}`}
                                    >
                                        <ShieldCheck className="w-4 h-4" />
                                        {window.hours === null
                                            ? 'Bypass until turned off'
                                            : `Bypass for ${window.label} (auto-expires)`}
                                    </button>
                                ))}
                                {bypassModalAccount.bypass_credit_check && (
                                    <button
                                        onClick={() => handleCreditBypass(bypassModalAccount, false, '', null)}
                                        disabled={lockSubmitting}
                                        className="w-full px-4 py-2 border border-green-300 text-green-700 rounded hover:bg-green-50 disabled:opacity-50 text-sm flex items-center justify-center gap-2"
                                    >
                                        <ShieldOff className="w-4 h-4" /> Turn bypass off (enforce credit limit now)
                                    </button>
                                )}
                            </div>

                            <div className="flex justify-end pt-1">
                                <button onClick={() => setBypassModalAccount(null)} disabled={lockSubmitting} className="px-4 py-2 border rounded hover:bg-gray-50 text-sm">Close</button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Credit position + record cash/cheque received from this account */}
            {creditModalAccount && (
                <AccountCreditModal
                    account={{ id: creditModalAccount.id, name: creditModalAccount.name }}
                    onClose={() => setCreditModalAccount(null)}
                    onCreditChanged={() => loadAccounts()}
                />
            )}

            {/* Partner desk: two-way chat + material requests for one account */}
            {partnerDesk && (labId || partnerDesk.account.lab_id) && (
                <PartnerDeskModal
                    accountId={partnerDesk.account.id}
                    accountName={partnerDesk.account.name}
                    labId={(labId || partnerDesk.account.lab_id) as string}
                    initialTab={partnerDesk.tab}
                    openRequestCount={openRequestCounts[partnerDesk.account.id] || 0}
                    onClose={() => {
                        setPartnerDesk(null);
                        loadPartnerCounts();
                    }}
                />
            )}

            {/* Unified inbox: every partner thread and material request, newest first */}
            {showPartnerInbox && labId && (
                <PartnerInboxModal
                    labId={labId}
                    accounts={accounts.map(account => ({ id: account.id, name: account.name, code: account.code }))}
                    onClose={() => setShowPartnerInbox(false)}
                    onCountsChanged={() => loadPartnerCounts()}
                />
            )}
        </div >
    );
};

export default AccountMaster;
