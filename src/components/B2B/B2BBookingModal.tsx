import React, { useState, useEffect, useMemo } from 'react';
import { X, Search, User, Loader, Package, FlaskConical, Info, AlertTriangle } from 'lucide-react';
import { supabase } from '../../utils/supabase';
import CreditCheckModal from './CreditCheckModal';

interface B2BBookingModalProps {
    accountId: string;
    labId: string;
    onClose: () => void;
    onSuccess: () => void;
}

interface CatalogItem {
    id: string;
    name: string;
    price: number; // Effective price for this account (contracted rate when one exists)
    listPrice: number; // Standard/MRP rate, kept so a discounted rate can be shown against it
    isContracted: boolean;
    type: 'test' | 'package';
    category?: string;
    code?: string;
    includedTests?: string[]; // for packages
}

const B2BBookingModal: React.FC<B2BBookingModalProps> = ({ accountId, labId, onClose, onSuccess }) => {
    const [loading, setLoading] = useState(false);
    const [searchTerm, setSearchTerm] = useState('');
    const [catalogItems, setCatalogItems] = useState<CatalogItem[]>([]);
    const [searching, setSearching] = useState(false);
    const [hasContractedRates, setHasContractedRates] = useState(false);
    const [selectedItems, setSelectedItems] = useState<CatalogItem[]>([]);

    // Credit check state
    const [showCreditModal, setShowCreditModal] = useState(false);
    const [creditCheckPassed, setCreditCheckPassed] = useState(false);
    const [pendingOrderData, setPendingOrderData] = useState<Record<string, unknown> | null>(null);

    const [patient, setPatient] = useState({
        name: '',
        age: '',
        gender: 'Male',
        phone: '',
        email: ''
    });

    useEffect(() => {
        const loadCatalog = async () => {
            setSearching(true);
            try {
                const [testsResult, packagesResult, pricesResult] = await Promise.all([
                    supabase
                        .from('test_groups')
                        .select('id, name, price, category, code')
                        .eq('is_active', true)
                        .or(`lab_id.eq.${labId},lab_id.is.null`)
                        .order('name'),
                    supabase
                        .from('packages')
                        .select(`
                            id, name, price, category,
                            package_test_groups(
                                display_order,
                                test_groups(id, name, is_active)
                            )
                        `)
                        .eq('is_active', true)
                        .eq('lab_id', labId)
                        .order('name'),
                    // Contracted rates set for this account in Account Master (direct override or
                    // inherited price master). Returns only the items that differ from MRP.
                    supabase.rpc('get_b2b_effective_prices')
                ]);

                if (testsResult.error) throw testsResult.error;
                if (packagesResult.error) throw packagesResult.error;

                const testRates: Record<string, number> = {};
                const packageRates: Record<string, number> = {};
                if (pricesResult.error) {
                    // Never block booking on the rate lookup - fall back to standard rates
                    console.error('Error loading account rates, showing standard rates:', pricesResult.error);
                } else {
                    (pricesResult.data || []).forEach((row: any) => {
                        if (row?.price === null || row?.price === undefined) return;
                        const target = row.item_type === 'package' ? packageRates : testRates;
                        target[row.item_id] = Number(row.price);
                    });
                }

                const tests: CatalogItem[] = (testsResult.data || []).map((t: any) => ({
                    id: t.id,
                    name: t.name,
                    price: testRates[t.id] ?? (t.price || 0),
                    listPrice: t.price || 0,
                    isContracted: testRates[t.id] !== undefined,
                    type: 'test',
                    category: t.category,
                    code: t.code,
                }));

                const packages: CatalogItem[] = (packagesResult.data || []).map((p: any) => ({
                    id: p.id,
                    name: p.name,
                    price: packageRates[p.id] ?? (p.price || 0),
                    listPrice: p.price || 0,
                    isContracted: packageRates[p.id] !== undefined,
                    type: 'package',
                    category: p.category,
                    includedTests: (p.package_test_groups || [])
                        // Skip test groups deactivated after they were linked
                        .filter((ptg: any) => ptg.test_groups?.is_active !== false)
                        // Show them in the package's own order, not insert order
                        .slice()
                        .sort((a: any, b: any) => (a.display_order ?? 0) - (b.display_order ?? 0))
                        .map((ptg: any) => ptg.test_groups?.name)
                        .filter(Boolean),
                }));

                setCatalogItems([...packages, ...tests]);
                setHasContractedRates(
                    Object.keys(testRates).length > 0 || Object.keys(packageRates).length > 0
                );
            } catch (error) {
                console.error('Error loading B2B test catalog:', error);
                setCatalogItems([]);
                setHasContractedRates(false);
            } finally {
                setSearching(false);
            }
        };

        loadCatalog();
    }, [labId]);

    const searchResults = useMemo(() => {
        const search = searchTerm.trim().toLowerCase();
        if (search.length < 2) return [];

        return catalogItems.filter(item =>
            item.name.toLowerCase().includes(search) ||
            item.category?.toLowerCase().includes(search) ||
            item.code?.toLowerCase().includes(search) ||
            (item.type === 'package' && 'package'.includes(search))
        );
    }, [catalogItems, searchTerm]);

    const handleAdd = (item: CatalogItem) => {
        if (!selectedItems.find(s => s.id === item.id)) {
            setSelectedItems(prev => [...prev, item]);
        }
        setSearchTerm('');
    };

    const handleRemove = (id: string) => {
        setSelectedItems(prev => prev.filter(s => s.id !== id));
    };

    const totalAmount = selectedItems.reduce((sum, item) => sum + (item.price || 0), 0);

    // Check credit availability before booking
    const checkCreditAndSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (selectedItems.length === 0) return;

        // If credit check already passed, proceed directly
        if (creditCheckPassed) {
            await createBooking();
            return;
        }

        setLoading(true);
        try {
            // Check credit availability
            const { data: creditData, error: creditError } = await supabase.functions.invoke('check-b2b-credit', {
                body: { account_id: accountId, lab_id: labId, order_amount: totalAmount },
            });

            if (creditError) throw creditError;

            if (creditData?.can_proceed) {
                // Sufficient credit, proceed with booking
                await createBooking();
            } else {
                // Insufficient credit, show payment modal
                const orderData = {
                    patient_info: {
                        name: patient.name,
                        age: patient.age,
                        gender: patient.gender,
                        phone: patient.phone,
                        email: patient.email || undefined,
                    },
                    test_details: selectedItems.map(item => ({
                        id: item.id,
                        name: item.name,
                        price: item.price,
                        type: item.type,
                    })),
                    order_amount: totalAmount,
                };
                setPendingOrderData(orderData);
                setShowCreditModal(true);
            }
        } catch (err: any) {
            console.error('Error checking credit:', err);
            alert('Failed to check credit: ' + err.message);
        } finally {
            setLoading(false);
        }
    };

    const createBooking = async () => {
        setLoading(true);
        try {
            const { data: accountData } = await supabase
                .from('accounts')
                .select('lab_id')
                .eq('id', accountId)
                .single();

            if (!accountData) throw new Error('Account not found');

            const { error } = await supabase.from('bookings').insert([{
                lab_id: accountData.lab_id,
                status: 'pending',
	                booking_source: 'b2b_portal',
	                account_id: accountId,
	                b2b_client_id: accountId,
	                quotation_amount: totalAmount,
	                patient_info: {
                    name: patient.name,
                    age: patient.age,
                    gender: patient.gender,
                    phone: patient.phone,
                    email: patient.email || undefined,
                },
                test_details: selectedItems.map(item => ({
                    id: item.id,
                    name: item.name,
                    price: item.price,
                    type: item.type,
                })),
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            }]);

            if (error) throw error;

            onSuccess();
            onClose();
        } catch (err: any) {
            console.error('Error creating booking:', err);
            alert('Failed to create booking: ' + err.message);
        } finally {
            setLoading(false);
        }
    };

    const handlePaymentSuccess = (paymentId: string) => {
        console.log('Payment successful:', paymentId);
        setCreditCheckPassed(true);
        setShowCreditModal(false);
        // The verified payment callback applies credit and releases the pending booking.
        onSuccess();
        onClose();
    };

    const handleProceedWithCredit = () => {
        setShowCreditModal(false);
        createBooking();
    };

    const handleSubmit = checkCreditAndSubmit;

    return (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
            <div className="bg-white rounded-xl shadow-xl max-w-2xl w-full max-h-[90vh] flex flex-col">
                {/* Header */}
                <div className="flex justify-between items-center p-6 border-b border-gray-100">
                    <h2 className="text-xl font-bold text-gray-900">Book New Test</h2>
                    <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-full text-gray-500">
                        <X className="w-5 h-5" />
                    </button>
                </div>

                <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-6 space-y-6">
                    {/* Patient Info */}
                    <div className="space-y-4">
                        <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
                            <User className="w-4 h-4" /> Patient Details
                        </h3>
                        <div className="grid grid-cols-2 gap-4">
                            <div className="col-span-2 md:col-span-1">
                                <label className="block text-xs font-medium text-gray-500 mb-1">Name *</label>
                                <input
                                    type="text"
                                    required
                                    value={patient.name}
                                    onChange={e => setPatient({ ...patient, name: e.target.value })}
                                    className="w-full border rounded-lg p-2.5 focus:ring-2 focus:ring-blue-100 outline-none border-gray-300"
                                    placeholder="Patient Name"
                                />
                            </div>
                            <div>
                                <label className="block text-xs font-medium text-gray-500 mb-1">Phone *</label>
                                <input
                                    type="tel"
                                    required
                                    value={patient.phone}
                                    onChange={e => setPatient({ ...patient, phone: e.target.value })}
                                    className="w-full border rounded-lg p-2.5 focus:ring-2 focus:ring-blue-100 outline-none border-gray-300"
                                    placeholder="Mobile Number"
                                />
                            </div>
                            <div className="flex gap-4">
                                <div className="flex-1">
                                    <label className="block text-xs font-medium text-gray-500 mb-1">Age *</label>
                                    <input
                                        type="number"
                                        required
                                        value={patient.age}
                                        onChange={e => setPatient({ ...patient, age: e.target.value })}
                                        className="w-full border rounded-lg p-2.5 focus:ring-2 focus:ring-blue-100 outline-none border-gray-300"
                                        placeholder="Age"
                                    />
                                </div>
                                <div className="flex-1">
                                    <label className="block text-xs font-medium text-gray-500 mb-1">Gender</label>
                                    <select
                                        value={patient.gender}
                                        onChange={e => setPatient({ ...patient, gender: e.target.value })}
                                        className="w-full border rounded-lg p-2.5 focus:ring-2 focus:ring-blue-100 outline-none border-gray-300"
                                    >
                                        <option value="Male">Male</option>
                                        <option value="Female">Female</option>
                                        <option value="Other">Other</option>
                                    </select>
                                </div>
                            </div>
                            <div className="col-span-2 md:col-span-1">
                                <label className="block text-xs font-medium text-gray-500 mb-1">Email (optional)</label>
                                <input
                                    type="email"
                                    value={patient.email}
                                    onChange={e => setPatient({ ...patient, email: e.target.value })}
                                    className="w-full border rounded-lg p-2.5 focus:ring-2 focus:ring-blue-100 outline-none border-gray-300"
                                    placeholder="Email address"
                                />
                            </div>
                        </div>
                    </div>

                    {/* Test / Package Selection */}
                    <div className="space-y-3 pt-4 border-t border-gray-100">
                        <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
                            <Search className="w-4 h-4" /> Add Tests or Packages
                        </h3>

                        <div className="flex items-start gap-1.5 text-xs text-blue-600 bg-blue-50 rounded-lg px-3 py-2">
                            <Info className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                            <span>
                                {hasContractedRates
                                    ? 'Prices shown are your agreed account rates. Standard rates are struck through where a special rate applies.'
                                    : 'Prices shown are standard rates. Final pricing may vary per your account agreement.'}
                            </span>
                        </div>

                        <div className="relative">
                            <div className="relative">
                                <Search className="absolute left-3 top-3 w-4 h-4 text-gray-400" />
                                <input
                                    type="text"
                                    value={searchTerm}
                                    onChange={e => setSearchTerm(e.target.value)}
                                    className="w-full border rounded-lg p-2.5 pl-9 pr-9 focus:ring-2 focus:ring-blue-100 outline-none border-gray-300"
                                    placeholder="Search tests or packages (e.g. CBC, LFT, Full Body)"
                                />
                                {searching && (
                                    <Loader className="absolute right-3 top-3 w-4 h-4 text-gray-400 animate-spin" />
                                )}
                            </div>

                            {searchResults.length > 0 && (
                                <div className="absolute top-full left-0 right-0 bg-white border border-gray-200 mt-1 rounded-lg shadow-lg max-h-64 overflow-y-auto z-10">
                                    {searchResults.map(item => (
                                        <button
                                            key={item.id}
                                            type="button"
                                            onClick={() => handleAdd(item)}
                                            className="w-full text-left px-4 py-3 hover:bg-gray-50 border-b border-gray-50 last:border-0"
                                        >
                                            <div className="flex items-start justify-between gap-2">
                                                <div className="flex-1 min-w-0">
                                                    <div className="flex items-center gap-2">
                                                        {item.type === 'package' ? (
                                                            <span className="inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 flex-shrink-0">
                                                                <Package className="w-2.5 h-2.5" /> PKG
                                                            </span>
                                                        ) : (
                                                            <span className="inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 flex-shrink-0">
                                                                <FlaskConical className="w-2.5 h-2.5" /> TEST
                                                            </span>
                                                        )}
                                                        <span className="font-medium text-gray-800 text-sm truncate">{item.name}</span>
                                                    </div>
                                                    {item.type === 'package' && item.includedTests && item.includedTests.length > 0 && (
                                                        <p className="text-xs text-gray-400 mt-0.5 pl-7 truncate">
                                                            Includes: {item.includedTests.slice(0, 3).join(', ')}
                                                            {item.includedTests.length > 3 && ` +${item.includedTests.length - 3} more`}
                                                        </p>
                                                    )}
                                                </div>
                                                <span className="text-sm font-semibold text-gray-700 flex-shrink-0 flex items-baseline gap-1.5">
                                                    {item.isContracted && item.listPrice > item.price && (
                                                        <span className="text-xs font-normal text-gray-400 line-through">
                                                            ₹{item.listPrice.toLocaleString('en-IN')}
                                                        </span>
                                                    )}
                                                    ₹{item.price.toLocaleString('en-IN')}
                                                </span>
                                            </div>
                                        </button>
                                    ))}
                                </div>
                            )}

                            {searchTerm.length >= 2 && !searching && searchResults.length === 0 && (
                                <div className="absolute top-full left-0 right-0 bg-white border border-gray-200 mt-1 rounded-lg shadow-lg z-10 px-4 py-3 text-sm text-gray-500">
                                    No tests or packages found for "{searchTerm}"
                                </div>
                            )}
                        </div>

                        {/* Selected Items */}
                        {selectedItems.length > 0 && (
                            <div className="space-y-2 mt-2">
                                {selectedItems.map(item => (
                                    <div
                                        key={item.id}
                                        className="flex items-center justify-between bg-gray-50 p-3 rounded-lg border border-gray-100"
                                    >
                                        <div className="flex items-center gap-2 min-w-0">
                                            {item.type === 'package' ? (
                                                <span className="inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 flex-shrink-0">
                                                    <Package className="w-2.5 h-2.5" /> PKG
                                                </span>
                                            ) : (
                                                <span className="inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 flex-shrink-0">
                                                    <FlaskConical className="w-2.5 h-2.5" /> TEST
                                                </span>
                                            )}
                                            <div className="min-w-0">
                                                <p className="text-sm font-medium text-gray-800 truncate">{item.name}</p>
                                                {item.type === 'package' && item.includedTests && (
                                                    <p className="text-xs text-gray-400 truncate">
                                                        {item.includedTests.length} tests included
                                                    </p>
                                                )}
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-3 flex-shrink-0">
                                            <span className="text-sm font-semibold text-gray-700 flex items-baseline gap-1.5">
                                                {item.isContracted && item.listPrice > item.price && (
                                                    <span className="text-xs font-normal text-gray-400 line-through">
                                                        ₹{item.listPrice.toLocaleString('en-IN')}
                                                    </span>
                                                )}
                                                ₹{item.price.toLocaleString('en-IN')}
                                            </span>
                                            <button
                                                type="button"
                                                onClick={() => handleRemove(item.id)}
                                                className="text-red-400 hover:text-red-600"
                                            >
                                                <X className="w-4 h-4" />
                                            </button>
                                        </div>
                                    </div>
                                ))}

                                <div className="flex justify-between items-center px-3 py-2 bg-blue-50 rounded-lg border border-blue-100">
                                    <span className="text-sm font-medium text-blue-700">Estimated Total</span>
                                    <span className="text-sm font-bold text-blue-800">
                                        ₹{totalAmount.toLocaleString('en-IN')}
                                    </span>
                                </div>
                            </div>
                        )}
                    </div>
                </form>

                {/* Footer */}
                <div className="p-6 border-t border-gray-100 bg-gray-50 rounded-b-xl flex justify-end gap-3">
                    <button
                        type="button"
                        onClick={onClose}
                        className="px-4 py-2 text-sm font-medium text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleSubmit}
                        disabled={loading || selectedItems.length === 0 || !patient.name || !patient.phone || !patient.age}
                        className="px-6 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
                    >
                        {loading && <Loader className="w-4 h-4 animate-spin" />}
                        Submit Booking
                    </button>
                </div>
            </div>

            {/* Credit Check Modal */}
            <CreditCheckModal
                isOpen={showCreditModal}
                onClose={() => setShowCreditModal(false)}
                accountId={accountId}
                labId={labId}
                orderAmount={totalAmount}
                orderData={pendingOrderData || undefined}
                onPaymentSuccess={handlePaymentSuccess}
                onProceedWithCredit={handleProceedWithCredit}
            />
        </div>
    );
};

export default B2BBookingModal;
