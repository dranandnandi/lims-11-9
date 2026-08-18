import React, { useState, useEffect, KeyboardEvent } from 'react';
import { X, User, Phone, Save, Loader, Sparkles } from 'lucide-react';
import { database, supabase } from '../../utils/supabase';
import { detectGenderFromName } from '../../utils/genderDetection';

interface CreateBookingModalProps {
    onClose: () => void;
    onSuccess: () => void;
}

const SALUTATIONS = ['Mr.', 'Mrs.', 'Ms.', 'Dr.', 'Master', 'Baby', 'Prof.', 'Shri.', 'Smt.', 'Ku.'];

interface CatalogTest {
    id: string;
    name: string;
    type: 'test_group' | 'package';
    price: number;
}

interface SelectedTest {
    id?: string;
    name: string;
    type: 'test_group' | 'package' | 'note';
    price?: number;
}

const CreateBookingModal: React.FC<CreateBookingModalProps> = ({ onClose, onSuccess }) => {
    const [loading, setLoading] = useState(false);

    // Name fields
    const [salutation, setSalutation] = useState('');
    const [firstName, setFirstName] = useState('');
    const [middleName, setMiddleName] = useState('');
    const [lastName, setLastName] = useState('');

    // Gender with auto-detect tracking
    const [gender, setGender] = useState('');
    const [genderAutoDetected, setGenderAutoDetected] = useState(false);
    const [genderManuallySet, setGenderManuallySet] = useState(false);

    useEffect(() => {
        if (!genderManuallySet) {
            const detected = detectGenderFromName(salutation, firstName, middleName, lastName);
            if (detected) {
                setGender(detected);
                setGenderAutoDetected(true);
            } else {
                setGenderAutoDetected(false);
            }
        }
    }, [salutation, firstName, middleName, lastName]);

    const [formData, setFormData] = useState({
        phone: '',
        date: new Date().toISOString().slice(0, 16),
        type: 'walk_in',
        address: '',
    });

    // Tests as chips
    const [tests, setTests] = useState<SelectedTest[]>([]);
    const [testInput, setTestInput] = useState('');
    const [catalogTests, setCatalogTests] = useState<CatalogTest[]>([]);

    useEffect(() => {
        const loadCatalogTests = async () => {
            try {
                const labId = await database.getCurrentUserLabId();
                const [testGroupsRes, packagesRes] = await Promise.all([
                    supabase
                        .from('test_groups')
                        .select('id, name, price')
                        .eq('lab_id', labId)
                        .eq('is_active', true)
                        .order('name'),
                    supabase
                        .from('packages')
                        .select('id, name, price')
                        .eq('lab_id', labId)
                        .eq('is_active', true)
                        .order('name')
                ]);

                const testGroups: CatalogTest[] = (testGroupsRes.data || []).map((item: any) => ({
                    id: item.id,
                    name: item.name,
                    price: Number(item.price || 0),
                    type: 'test_group'
                }));
                const packages: CatalogTest[] = (packagesRes.data || []).map((item: any) => ({
                    id: item.id,
                    name: item.name,
                    price: Number(item.price || 0),
                    type: 'package'
                }));

                setCatalogTests([...testGroups, ...packages].sort((a, b) => a.name.localeCompare(b.name)));
            } catch (err) {
                console.error('Failed to load booking test catalog:', err);
            }
        };

        loadCatalogTests();
    }, []);

    const getFullName = () =>
        [salutation, firstName.trim(), middleName.trim(), lastName.trim()]
            .filter(Boolean)
            .join(' ');

    const getSearchKey = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');

    const getInitials = (value: string) =>
        value
            .replace(/[^a-zA-Z0-9\s]/g, ' ')
            .split(/\s+/)
            .filter(Boolean)
            .map(part => part[0])
            .join('')
            .toLowerCase();

    const matchingTests = testInput.trim()
        ? catalogTests
            .filter(item => {
                const query = getSearchKey(testInput);
                const nameKey = getSearchKey(item.name);
                const initials = getInitials(item.name);
                return nameKey.includes(query) || initials.includes(query);
            })
            .filter(item => !tests.some(selected => selected.id === item.id && selected.type === item.type))
            .slice(0, 8)
        : [];

    const getTestsWithPendingInput = () => {
        const val = testInput.trim();
        if (!val) return tests;

        const exactMatch = matchingTests.find(item => getSearchKey(item.name) === getSearchKey(val));
        const selected = exactMatch || matchingTests[0] || { name: val, type: 'note' as const };
        return [...tests, selected].filter((test, index, arr) =>
            arr.findIndex(item =>
                (item.id && test.id && item.id === test.id && item.type === test.type) ||
                item.name.toLowerCase() === test.name.toLowerCase()
            ) === index
        );
    };

    const estimatedTotal = getTestsWithPendingInput().reduce((sum, test) => sum + Number(test.price || 0), 0);

    const addCatalogTest = (item: CatalogTest) => {
        if (!tests.some(test => test.id === item.id && test.type === item.type)) {
            setTests(prev => [...prev, item]);
        }
        setTestInput('');
    };

    const addTest = () => {
        const val = testInput.trim();
        if (!val) return;

        const exactMatch = matchingTests.find(item => getSearchKey(item.name) === getSearchKey(val));
        const selected = exactMatch || matchingTests[0];
        if (selected) {
            addCatalogTest(selected);
            return;
        }

        if (!tests.some(test => test.name.toLowerCase() === val.toLowerCase())) {
            setTests(prev => [...prev, { name: val, type: 'note' }]);
        }
        setTestInput('');
    };

    const handleTestKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            addTest();
        } else if (e.key === 'Backspace' && !testInput && tests.length > 0) {
            setTests(prev => prev.slice(0, -1));
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!firstName.trim()) {
            alert('First name is required.');
            return;
        }
        setLoading(true);

        // Commit any pending test input on submit
        const finalTests = getTestsWithPendingInput();
        const quotationAmount = finalTests.reduce((sum, test) => sum + Number(test.price || 0), 0);

        try {
            const payload = {
                booking_source: 'phone_call',
                status: 'pending',
                patient_info: {
                    name: getFullName(),
                    phone: formData.phone,
                    ...(gender ? { gender: gender as 'Male' | 'Female' | 'Other' } : {})
                },
                collection_type: formData.type,
                scheduled_at: new Date(formData.date).toISOString(),
                home_collection_address: formData.type === 'home_collection'
                    ? { address: formData.address }
                    : null,
                test_details: finalTests.map(t => ({
                    id: t.id,
                    name: t.name,
                    type: t.type,
                    price: t.price
                })),
                quotation_amount: quotationAmount
            };

            const { error } = await database.bookings.create(payload);
            if (error) throw error;
            onSuccess();
        } catch (err) {
            console.error('Error creating booking:', err);
            alert('Failed to create booking');
        } finally {
            setLoading(false);
        }
    };

    const namePreview = getFullName();

    return (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-xl shadow-xl w-full max-w-md overflow-hidden">
                {/* Header */}
                <div className="flex items-center justify-between p-4 border-b border-gray-100 bg-gray-50">
                    <h3 className="font-semibold text-gray-800 flex items-center gap-2">
                        <Phone className="w-4 h-4 text-blue-600" />
                        Log Phone Booking
                    </h3>
                    <button onClick={onClose} className="p-1 hover:bg-gray-200 rounded-full transition-colors">
                        <X className="w-5 h-5 text-gray-500" />
                    </button>
                </div>

                <form onSubmit={handleSubmit} className="p-4 space-y-4">
                    {/* Patient Name */}
                    <div className="space-y-2">
                        <label className="block text-xs font-medium text-gray-700">
                            Patient Name
                        </label>

                        {/* Row 1: Salutation + First Name */}
                        <div className="flex gap-2">
                            <select
                                value={salutation}
                                onChange={e => setSalutation(e.target.value)}
                                className="w-[88px] shrink-0 px-2 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none bg-white"
                            >
                                <option value="">Salute</option>
                                {SALUTATIONS.map(s => (
                                    <option key={s} value={s}>{s}</option>
                                ))}
                            </select>
                            <div className="relative flex-1">
                                <User className="absolute left-3 top-2.5 w-4 h-4 text-gray-400" />
                                <input
                                    type="text"
                                    required
                                    placeholder="First Name *"
                                    value={firstName}
                                    onChange={e => setFirstName(e.target.value)}
                                    className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all"
                                />
                            </div>
                        </div>

                        {/* Row 2: Middle + Last Name */}
                        <div className="flex gap-2">
                            <input
                                type="text"
                                placeholder="Middle Name"
                                value={middleName}
                                onChange={e => setMiddleName(e.target.value)}
                                className="flex-1 px-3 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all"
                            />
                            <input
                                type="text"
                                placeholder="Last Name"
                                value={lastName}
                                onChange={e => setLastName(e.target.value)}
                                className="flex-1 px-3 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all"
                            />
                        </div>

                        {/* Row 3: Gender (auto-detected) */}
                        <div className="flex items-center gap-2">
                            <span className="text-xs text-gray-500 shrink-0">Gender:</span>
                            {(['Male', 'Female', 'Other'] as const).map(g => (
                                <button
                                    key={g}
                                    type="button"
                                    onClick={() => { setGender(g); setGenderAutoDetected(false); setGenderManuallySet(true); }}
                                    className={`px-3 py-1 text-xs font-medium rounded-full border transition-all ${
                                        gender === g
                                            ? g === 'Male'
                                                ? 'bg-blue-50 border-blue-400 text-blue-700'
                                                : g === 'Female'
                                                    ? 'bg-pink-50 border-pink-400 text-pink-700'
                                                    : 'bg-purple-50 border-purple-400 text-purple-700'
                                            : 'border-gray-200 text-gray-500 hover:border-gray-300'
                                    }`}
                                >
                                    {g}
                                </button>
                            ))}
                            {genderAutoDetected && gender && (
                                <span className="flex items-center gap-0.5 text-[10px] text-amber-600 font-medium">
                                    <Sparkles className="w-3 h-3" /> Auto
                                </span>
                            )}
                        </div>

                        {/* Live preview */}
                        {namePreview && (
                            <p className="text-[11px] text-gray-500 leading-tight">
                                Saved as:{' '}
                                <span className="font-semibold text-gray-700">{namePreview}</span>
                            </p>
                        )}
                    </div>

                    {/* Phone */}
                    <div>
                        <label className="block text-xs font-medium text-gray-700 mb-1">Phone Number</label>
                        <div className="relative">
                            <Phone className="absolute left-3 top-2.5 w-4 h-4 text-gray-400" />
                            <input
                                type="tel"
                                required
                                placeholder="Enter phone number"
                                value={formData.phone}
                                onChange={e => setFormData({ ...formData, phone: e.target.value })}
                                className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all"
                            />
                        </div>
                    </div>

                    {/* Schedule & Type */}
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className="block text-xs font-medium text-gray-700 mb-1">Date & Time</label>
                            <input
                                type="datetime-local"
                                required
                                value={formData.date}
                                onChange={e => setFormData({ ...formData, date: e.target.value })}
                                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all"
                            />
                        </div>
                        <div>
                            <label className="block text-xs font-medium text-gray-700 mb-1">Collection Type</label>
                            <select
                                value={formData.type}
                                onChange={e => setFormData({ ...formData, type: e.target.value })}
                                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all"
                            >
                                <option value="walk_in">Walk-in</option>
                                <option value="home_collection">Home Collection</option>
                            </select>
                        </div>
                    </div>

                    {/* Address – only for home collection */}
                    {formData.type === 'home_collection' && (
                        <div className="animate-in fade-in slide-in-from-top-2 duration-200">
                            <label className="block text-xs font-medium text-gray-700 mb-1">Collection Address</label>
                            <textarea
                                required
                                rows={2}
                                placeholder="Enter full address"
                                value={formData.address}
                                onChange={e => setFormData({ ...formData, address: e.target.value })}
                                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all resize-none"
                            />
                        </div>
                    )}

                    {/* Tests – chip / tag input */}
                    <div>
                        <label className="block text-xs font-medium text-gray-700 mb-1">
                            Requested Tests
                            {tests.length > 0 && (
                                <span className="ml-1.5 text-blue-600 font-semibold">{tests.length}</span>
                            )}
                        </label>

                        {/* Tag input box */}
                        <div
                            className="border border-gray-200 rounded-lg focus-within:ring-2 focus-within:ring-blue-500 focus-within:border-transparent bg-white
                                       min-h-[38px] max-h-28 overflow-y-auto px-2 py-1.5 flex flex-wrap gap-1.5 items-center transition-all cursor-text"
                            onClick={e => {
                                const input = (e.currentTarget as HTMLElement).querySelector('input');
                                input?.focus();
                            }}
                        >
                            {tests.map((test, i) => (
                                <span
                                    key={i}
                                    className="inline-flex items-center gap-1 bg-blue-50 text-blue-700 text-xs font-medium
                                               px-2 py-0.5 rounded-full border border-blue-200 shrink-0"
                                >
	                                    {test.name}
	                                    {test.type !== 'note' && (
	                                        <span className="text-[9px] uppercase text-blue-500">
	                                            {test.type === 'package' ? 'Pkg' : 'Test'}
	                                        </span>
	                                    )}
                                    <button
                                        type="button"
                                        onClick={() => setTests(prev => prev.filter((_, idx) => idx !== i))}
                                        className="text-blue-400 hover:text-blue-700 leading-none"
                                    >
                                        <X className="w-3 h-3" />
                                    </button>
                                </span>
                            ))}
                            <input
                                type="text"
                                value={testInput}
                                onChange={e => setTestInput(e.target.value)}
                                onKeyDown={handleTestKeyDown}
                                onBlur={addTest}
                                placeholder={tests.length === 0 ? 'CBC, Thyroid Profile… (Enter to add)' : 'Add more…'}
                                className="flex-1 min-w-[140px] text-sm outline-none bg-transparent py-0.5 placeholder-gray-400"
                            />
                        </div>
	                        {matchingTests.length > 0 && (
	                            <div className="mt-1 max-h-36 overflow-y-auto rounded-lg border border-blue-100 bg-white shadow-sm">
	                                {matchingTests.map(item => (
	                                    <button
	                                        key={`${item.type}-${item.id}`}
	                                        type="button"
	                                        onMouseDown={e => {
	                                            e.preventDefault();
	                                            addCatalogTest(item);
	                                        }}
	                                        className="w-full px-3 py-2 text-left text-xs hover:bg-blue-50 flex items-center justify-between gap-3"
	                                    >
	                                        <span className="font-medium text-gray-800">{item.name}</span>
	                                        <span className="flex items-center gap-2 text-gray-500">
	                                            <span>{item.type === 'package' ? 'Package' : 'Test'}</span>
	                                            <span>Rs. {item.price.toLocaleString('en-IN')}</span>
	                                        </span>
	                                    </button>
	                                ))}
	                            </div>
	                        )}
                        <p className="mt-0.5 text-[10px] text-gray-400">
                            Type to search catalog - Enter adds first match - comma adds note - Backspace removes last
                        </p>
                        {estimatedTotal > 0 && (
                            <div className="mt-2 flex items-center justify-between rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-sm">
                                <span className="font-medium text-blue-800">Estimated total</span>
                                <span className="font-bold text-blue-900">Rs. {estimatedTotal.toLocaleString('en-IN')}</span>
                            </div>
                        )}
                    </div>

                    {/* Actions */}
                    <div className="pt-1 flex justify-end gap-3">
                        <button
                            type="button"
                            onClick={onClose}
                            className="px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
                        >
                            Cancel
                        </button>
                        <button
                            type="submit"
                            disabled={loading}
                            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg shadow-sm shadow-blue-200 flex items-center gap-2 transition-all disabled:opacity-70 disabled:cursor-not-allowed"
                        >
                            {loading ? <Loader className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                            Save Booking
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
};

export default CreateBookingModal;
