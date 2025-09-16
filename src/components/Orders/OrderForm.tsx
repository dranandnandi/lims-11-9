import React, { useState, useEffect } from 'react';
import {
  X,
  Search,
  Upload,
  CreditCard,
  User,
  Building,
  Briefcase,
  Plus,
  Calendar,
  TestTube
} from 'lucide-react';
import { database } from '../../utils/supabase';

type PaymentType = 'self' | 'credit' | 'insurance' | 'corporate';

interface Doctor {
  id: string;
  name: string;
  specialization?: string | null;
  default_discount_percent?: number | null;
}

interface Location {
  id: string;
  name: string;
  type: string; // 'hospital' | 'clinic' | 'diagnostic_center' | 'home_collection' | 'walk_in'
  credit_limit?: number | null;
  default_discount_percent?: number | null;
}

interface Account {
  id: string;
  name: string;
  type: 'hospital' | 'corporate' | 'insurer' | 'clinic' | 'doctor' | 'other';
  default_discount_percent?: number | null;
  credit_limit?: number | null;
  payment_terms?: number | null;
  is_active?: boolean | null;
}

interface Patient {
  id: string;
  name: string;
  age?: number | null;
  gender?: string | null;
  phone?: string | null;
  email?: string | null;
  default_doctor_id?: string | null;
  default_location_id?: string | null;
  default_payment_type?: PaymentType | null;
}

interface TestGroup {
  id: string;
  name: string;
  price: number;
  category?: string | null;
  clinicalPurpose?: string | null;
  sampleType?: string | null;
  turnaroundTime?: string | null;
  requiresFasting?: boolean | null;
  type?: 'test' | 'package';
}

interface OrderFormProps {
  onClose: () => void;
  onSubmit: (orderData: any) => void;
  preSelectedPatientId?: string;
}

const OrderForm: React.FC<OrderFormProps> = ({ onClose, onSubmit, preSelectedPatientId }) => {
  // Masters
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [testGroups, setTestGroups] = useState<TestGroup[]>([]);

  // Loading flags
  const [loadingPatients, setLoadingPatients] = useState<boolean>(false);
  const [loadingDoctors, setLoadingDoctors] = useState<boolean>(false);
  const [loadingLocations, setLoadingLocations] = useState<boolean>(false);
  const [loadingAccounts, setLoadingAccounts] = useState<boolean>(false);
  const [loadingTests, setLoadingTests] = useState<boolean>(false);

  // Selecteds / data
  const [selectedPatient, setSelectedPatient] = useState<Patient | null>(null);
  const [selectedDoctor, setSelectedDoctor] = useState<string>('');
  const [selectedLocation, setSelectedLocation] = useState<string>('');
  const [selectedAccount, setSelectedAccount] = useState<string>(''); // bill-to account
  const [paymentType, setPaymentType] = useState<PaymentType>('self');
  const [priority, setPriority] = useState<'Normal' | 'Urgent' | 'STAT'>('Normal');
  const [expectedDate, setExpectedDate] = useState<string>(() =>
    new Date().toISOString().split('T')[0]
  );
  const [notes, setNotes] = useState<string>('');

  // Test selection
  const [selectedTests, setSelectedTests] = useState<string[]>([]);

  // Searches / dropdown visibility
  const [patientSearch, setPatientSearch] = useState<string>('');
  const [doctorSearch, setDoctorSearch] = useState<string>('');
  const [locationSearch, setLocationSearch] = useState<string>('');
  const [accountSearch, setAccountSearch] = useState<string>('');
  const [showPatientDropdown, setShowPatientDropdown] = useState<boolean>(false);
  const [showDoctorDropdown, setShowDoctorDropdown] = useState<boolean>(false);
  const [showLocationDropdown, setShowLocationDropdown] = useState<boolean>(false);
  const [showAccountDropdown, setShowAccountDropdown] = useState<boolean>(false);

  // Test request form
  const [testRequestFile, setTestRequestFile] = useState<File | null>(null);

  // Credit validation (either Location or Account, whichever is chosen)
  const [creditInfo, setCreditInfo] = useState<{
    kind: 'location' | 'account';
    allowed: boolean;
    currentBalance: number;
    creditLimit: number;
    availableCredit: number;
    name: string;
  } | null>(null);

  // New patient modal
  const [showNewPatientModal, setShowNewPatientModal] = useState<boolean>(false);
  const [creatingPatient, setCreatingPatient] = useState<boolean>(false);
  const [newPatient, setNewPatient] = useState<{
    name: string;
    age: string;
    gender: string;
    phone: string;
    email: string;
  }>({ name: '', age: '', gender: 'Male', phone: '', email: '' });

  // Initial loads
  useEffect(() => {
    const fetchMasters = async () => {
      try {
        setLoadingDoctors(true);
        setLoadingLocations(true);
        setLoadingAccounts(true);
        setLoadingPatients(true);
        setLoadingTests(true);

        const [
          doctorsRes,
          locationsRes,
          accountsRes,
          patientsRes,
          testsRes
        ] = await Promise.all([
          (database as any).doctors?.getAll?.() ?? Promise.resolve({ data: [] }),
          (database as any).locations?.getAll?.() ?? Promise.resolve({ data: [] }),
          (database as any).accounts?.getAll?.() ?? Promise.resolve({ data: [] }),
          (database as any).patients?.getAll?.() ?? Promise.resolve({ data: [] }),
          (database as any).testGroups?.getAll?.() ?? Promise.resolve({ data: [] })
        ]);

        setDoctors(doctorsRes?.data ?? []);
        setLocations(locationsRes?.data ?? []);
        setAccounts(accountsRes?.data ?? []);
        setPatients(patientsRes?.data ?? []);
        setTestGroups(testsRes?.data ?? []);
      } catch (err) {
        console.error('Error loading masters:', err);
      } finally {
        setLoadingDoctors(false);
        setLoadingLocations(false);
        setLoadingAccounts(false);
        setLoadingPatients(false);
        setLoadingTests(false);
      }
    };

    fetchMasters();
  }, []);

  // Pre-select patient (if provided)
  useEffect(() => {
    const loadPatient = async (patientId: string) => {
      try {
        const { data, error } = await (database as any).patients?.getById?.(patientId);
        if (error) throw error;
        if (data) {
          setSelectedPatient(data as Patient);
          if (data.default_doctor_id) setSelectedDoctor(data.default_doctor_id);
          if (data.default_location_id) setSelectedLocation(data.default_location_id);
          if (data.default_payment_type) setPaymentType(data.default_payment_type);
        }
      } catch (err) {
        console.error('Error loading patient:', err);
      }
    };

    if (preSelectedPatientId) loadPatient(preSelectedPatientId);
  }, [preSelectedPatientId]);

  // Re-check credit when bill-to changes under non-self payment types
  useEffect(() => {
    const check = async () => {
      if (paymentType === 'self') {
        setCreditInfo(null);
        return;
      }
      if (selectedAccount && (database as any).accounts?.checkCreditLimit) {
        try {
          const res = await (database as any).accounts.checkCreditLimit(selectedAccount, 0);
          if (res) {
            setCreditInfo({
              kind: 'account',
              allowed: !!res.allowed,
              currentBalance: Number(res.currentBalance ?? 0),
              creditLimit: Number(res.creditLimit ?? 0),
              availableCredit: Number(res.availableCredit ?? 0),
              name:
                res.name ||
                (accounts.find((a) => a.id === selectedAccount)?.name ?? 'Account')
            });
            return;
          }
        } catch (e) {
          console.error('Error checking account credit limit:', e);
        }
      }
      if (selectedLocation && (database as any).locations?.checkCreditLimit) {
        try {
          const res = await (database as any).locations.checkCreditLimit(selectedLocation, 0);
          if (res) {
            setCreditInfo({
              kind: 'location',
              allowed: !!res.allowed,
              currentBalance: Number(res.currentBalance ?? 0),
              creditLimit: Number(res.creditLimit ?? 0),
              availableCredit: Number(res.availableCredit ?? 0),
              name:
                res.name ||
                (locations.find((l) => l.id === selectedLocation)?.name ?? 'Location')
            });
            return;
          }
        } catch (e) {
          console.error('Error checking location credit limit:', e);
        }
      }
      setCreditInfo(null);
    };

    check();
  }, [selectedAccount, selectedLocation, paymentType, accounts, locations]);

  // Filtering helpers
  const filteredPatients = patients.filter((p) => {
    const q = patientSearch.toLowerCase().trim();
    return (
      !q ||
      p.name?.toLowerCase().includes(q) ||
      (p.phone ?? '').includes(q) ||
      p.id?.includes(q)
    );
  });

  const filteredDoctors = doctors.filter((d) => {
    const q = doctorSearch.toLowerCase().trim();
    return !q || (d.name + ' ' + (d.specialization ?? '')).toLowerCase().includes(q);
  });

  const filteredLocations = locations.filter((l) => {
    const q = locationSearch.toLowerCase().trim();
    return !q || (l.name + ' ' + l.type).toLowerCase().includes(q);
  });

  const filteredAccounts = accounts.filter((a) => {
    const q = accountSearch.toLowerCase().trim();
    return !q || (a.name + ' ' + a.type).toLowerCase().includes(q);
  });

  // Handlers
  const onPickPatient = (p: Patient) => {
    setSelectedPatient(p);
    setShowPatientDropdown(false);
    // Prefill defaults
    if (p.default_doctor_id) setSelectedDoctor(p.default_doctor_id);
    if (p.default_location_id) setSelectedLocation(p.default_location_id);
    if (p.default_payment_type) setPaymentType(p.default_payment_type);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      alert('File size must be less than 10MB');
      return;
    }
    setTestRequestFile(file);
  };

  const handleToggleTest = (id: string) => {
    setSelectedTests((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!selectedPatient?.id) {
      alert('Please select a patient.');
      return;
    }

    if (
      (paymentType === 'credit' || paymentType === 'corporate' || paymentType === 'insurance') &&
      !selectedAccount &&
      !selectedLocation
    ) {
      alert('For non-self payments, choose a Bill-to Account or a Location.');
      return;
    }

    if (creditInfo && !creditInfo.allowed) {
      alert(
        `${creditInfo.kind === 'account' ? 'Account' : 'Location'} credit limit exceeded. Available credit: ₹${creditInfo.availableCredit}`
      );
      return;
    }

    // Build selected tests payload (if any)
    const selectedTestDetails = testGroups.filter((t) => selectedTests.includes(t.id));
    const testsPayload =
      selectedTestDetails.length > 0
        ? selectedTestDetails.map((t) => ({
            id: t.id,
            name: t.name,
            type: t.type ?? 'test',
            price: t.price ?? 0
          }))
        : undefined;

    // Compose order payload (account layer included)
    const orderData: any = {
      patient_id: selectedPatient.id,
      patient_name: selectedPatient.name,
      referring_doctor_id: selectedDoctor || null,
      location_id: selectedLocation || null, // collection/origin
      account_id: selectedAccount || null, // B2B bill-to
      payment_type: paymentType,
      priority,
      expected_date: expectedDate,
      doctor: doctors.find((d) => d.id === selectedDoctor)?.name || null,
      notes: notes || null
    };

    if (testsPayload) orderData.tests = testsPayload;
    if (testRequestFile) orderData.testRequestFile = testRequestFile;

    onSubmit(orderData);
  };

  // Totals (for UI display only)
  const selectedTestRows = testGroups.filter((t) => selectedTests.includes(t.id));
  const totalAmount = selectedTestRows.reduce((sum, t) => sum + (t.price ?? 0), 0);

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-5xl max-h-[92vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <h2 className="text-xl font-semibold text-gray-900">Create New Order</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1 rounded">
            <X className="h-6 w-6" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-8">
          {/* Patient Section */}
          <section className="space-y-3">
            <h3 className="text-lg font-medium text-gray-900 flex items-center gap-2">
              <User className="h-5 w-5" />
              Patient Information
            </h3>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Select Patient *
                </label>
                <div className="relative">
                  <div className="flex items-center gap-2">
                    <div className="relative flex-1">
                      <Search className="w-4 h-4 text-gray-400 absolute left-2 top-2.5" />
                      <input
                        type="text"
                        value={patientSearch}
                        onChange={(e) => {
                          setPatientSearch(e.target.value);
                          setShowPatientDropdown(true);
                        }}
                        onFocus={() => setShowPatientDropdown(true)}
                        placeholder="Search by name, phone, or ID…"
                        className="w-full pl-8 pr-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                      {showPatientDropdown && filteredPatients.length > 0 && (
                        <div className="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-56 overflow-y-auto">
                          {filteredPatients.map((p) => (
                            <button
                              key={p.id}
                              type="button"
                              onClick={() => onPickPatient(p)}
                              className="w-full px-3 py-2 text-left hover:bg-gray-50"
                            >
                              <div className="font-medium">{p.name}</div>
                              <div className="text-xs text-gray-500">
                                {(p.age ?? '-') + 'y'}, {p.gender ?? '-'} • {p.phone ?? '-'} •{' '}
                                {p.id.slice(-8)}
                              </div>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>

                    {!selectedPatient && (
                      <button
                        type="button"
                        onClick={() => setShowNewPatientModal(true)}
                        className="px-3 py-2 text-sm bg-blue-50 text-blue-700 rounded-md hover:bg-blue-100"
                      >
                        <span className="inline-flex items-center gap-1">
                          <Plus className="h-4 w-4" /> Add Patient
                        </span>
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {selectedPatient && (
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                  <div className="text-sm">
                    <div className="font-medium text-blue-900">{selectedPatient.name}</div>
                    <div className="text-blue-700">
                      {(selectedPatient.age ?? '-') + 'y'}, {selectedPatient.gender ?? '-'}
                    </div>
                    {selectedPatient.phone && (
                      <div className="text-blue-700">Phone: {selectedPatient.phone}</div>
                    )}
                    {selectedPatient.email && (
                      <div className="text-blue-700">Email: {selectedPatient.email}</div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* Test Selection */}
          <section className="space-y-3">
            <h3 className="text-lg font-medium text-gray-900 flex items-center gap-2">
              <TestTube className="h-5 w-5" />
              Test Selection
            </h3>

            {loadingTests ? (
              <div className="p-4 text-center text-gray-500">Loading tests…</div>
            ) : (
              <div className="border border-gray-200 rounded-lg divide-y max-h-64 overflow-y-auto">
                {testGroups.length === 0 ? (
                  <div className="p-4 text-gray-500 text-sm">No tests found.</div>
                ) : (
                  testGroups.map((t) => (
                    <label
                      key={t.id}
                      className="flex items-center justify-between p-3 hover:bg-gray-50"
                    >
                      <div className="flex items-center gap-3">
                        <input
                          type="checkbox"
                          checked={selectedTests.includes(t.id)}
                          onChange={() => handleToggleTest(t.id)}
                          className="w-4 h-4"
                        />
                        <div>
                          <div className="text-sm font-medium text-gray-900">{t.name}</div>
                          <div className="text-xs text-gray-500">
                            {(t.category ?? 'General') +
                              (t.requiresFasting ? ' • Fasting' : '')}
                          </div>
                        </div>
                      </div>
                      <div className="text-sm font-semibold text-gray-900">₹{t.price ?? 0}</div>
                    </label>
                  ))
                )}
              </div>
            )}

            {selectedTests.length > 0 && (
              <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                <h4 className="font-medium text-green-900 mb-2 flex items-center gap-2">
                  <TestTube className="h-4 w-4" />
                  Selected Tests ({selectedTests.length})
                </h4>
                <div className="space-y-1 text-sm">
                  {testGroups
                    .filter((t) => selectedTests.includes(t.id))
                    .map((t) => (
                      <div key={t.id} className="flex justify-between">
                        <span className="text-green-800">{t.name}</span>
                        <span className="font-medium text-green-900">₹{t.price ?? 0}</span>
                      </div>
                    ))}
                </div>
                <div className="border-t border-green-200 mt-2 pt-2 flex justify-between font-semibold text-green-900">
                  <span>Total Amount:</span>
                  <span>₹{totalAmount}</span>
                </div>
              </div>
            )}
          </section>

          {/* Order Details */}
          <section className="space-y-4">
            <h3 className="text-lg font-medium text-gray-900 flex items-center gap-2">
              <Calendar className="h-5 w-5" />
              Order Details
            </h3>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {/* Priority */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Priority</label>
                <select
                  value={priority}
                  onChange={(e) => setPriority(e.target.value as any)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {['Normal', 'Urgent', 'STAT'].map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </div>

              {/* Expected Date */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Expected Date
                </label>
                <input
                  type="date"
                  value={expectedDate}
                  onChange={(e) => setExpectedDate(e.target.value)}
                  min={new Date().toISOString().split('T')[0]}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              {/* Payment Type */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Payment Type
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {(['self', 'credit', 'insurance', 'corporate'] as const).map((type) => (
                    <button
                      key={type}
                      type="button"
                      onClick={() => setPaymentType(type)}
                      className={`px-3 py-2 rounded-md text-sm font-medium ${
                        paymentType === type
                          ? 'bg-blue-600 text-white'
                          : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                      }`}
                    >
                      {type.charAt(0).toUpperCase() + type.slice(1)}
                    </button>
                  ))}
                </div>
              </div>

              {/* Referring Doctor */}
              <div className="md:col-span-3">
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Referring Doctor
                </label>
                <div className="relative">
                  <input
                    type="text"
                    placeholder="Search doctor…"
                    value={doctorSearch}
                    onChange={(e) => {
                      setDoctorSearch(e.target.value);
                      setShowDoctorDropdown(true);
                    }}
                    onFocus={() => setShowDoctorDropdown(true)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  {showDoctorDropdown && filteredDoctors.length > 0 && (
                    <div className="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                      {filteredDoctors.map((doctor) => (
                        <button
                          key={doctor.id}
                          type="button"
                          onClick={() => {
                            setSelectedDoctor(doctor.id);
                            setDoctorSearch(doctor.name);
                            setShowDoctorDropdown(false);
                          }}
                          className="w-full px-4 py-2 text-left hover:bg-gray-50"
                        >
                          <div className="font-medium">{doctor.name}</div>
                          {doctor.specialization && (
                            <div className="text-xs text-gray-500">{doctor.specialization}</div>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Location (collection/origin) */}
              <div className="md:col-span-3">
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Location {paymentType !== 'self' && '(required if no Account)'}
                </label>
                <div className="relative">
                  <input
                    type="text"
                    placeholder="Search location…"
                    value={locationSearch}
                    onChange={(e) => {
                      setLocationSearch(e.target.value);
                      setShowLocationDropdown(true);
                    }}
                    onFocus={() => setShowLocationDropdown(true)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  {showLocationDropdown && filteredLocations.length > 0 && (
                    <div className="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                      {filteredLocations.map((location) => (
                        <button
                          key={location.id}
                          type="button"
                          onClick={() => {
                            setSelectedLocation(location.id);
                            setLocationSearch(location.name);
                            setShowLocationDropdown(false);
                          }}
                          className="w-full px-4 py-2 text-left hover:bg-gray-50 flex items-center gap-2"
                        >
                          <Building className="w-4 h-4 text-gray-400" />
                          <div>
                            <div className="font-medium">{location.name}</div>
                            <div className="text-xs text-gray-500">
                              {location.type.replace(/_/g, ' ')}
                              {location.credit_limit ? ` • Credit: ₹${location.credit_limit}` : ''}
                            </div>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Bill-to Account (optional, used for B2B) */}
              <div className="md:col-span-3">
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Bill-to Account (optional for credit/corporate/insurance)
                </label>
                <div className="relative">
                  <input
                    type="text"
                    placeholder="Search account (hospital / corporate / insurer)…"
                    value={accountSearch}
                    onChange={(e) => {
                      setAccountSearch(e.target.value);
                      setShowAccountDropdown(true);
                    }}
                    onFocus={() => setShowAccountDropdown(true)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  {showAccountDropdown && filteredAccounts.length > 0 && (
                    <div className="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                      {filteredAccounts.map((account) => (
                        <button
                          key={account.id}
                          type="button"
                          onClick={() => {
                            setSelectedAccount(account.id);
                            setAccountSearch(account.name);
                            setShowAccountDropdown(false);
                          }}
                          className="w-full px-4 py-2 text-left hover:bg-gray-50 flex items-center gap-2"
                        >
                          <Briefcase className="w-4 h-4 text-gray-400" />
                          <div>
                            <div className="font-medium">{account.name}</div>
                            <div className="text-xs text-gray-500">
                              {account.type}
                              {account.credit_limit ? ` • Credit: ₹${account.credit_limit}` : ''}
                            </div>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                  <p className="text-xs text-gray-500 mt-1">
                    If selected, the invoice and credit tracking will be under this Account. Otherwise they remain location-based.
                  </p>
                </div>
              </div>
            </div>

            {/* Credit Info */}
            {creditInfo && paymentType !== 'self' && (
              <div
                className={`p-4 rounded-lg ${
                  creditInfo.allowed
                    ? 'bg-green-50 border border-green-200'
                    : 'bg-red-50 border border-red-200'
                }`}
              >
                <div className="flex items-center gap-2 mb-2">
                  <CreditCard
                    className={`w-5 h-5 ${creditInfo.allowed ? 'text-green-600' : 'text-red-600'}`}
                  />
                  <h4
                    className={`font-medium ${
                      creditInfo.allowed ? 'text-green-900' : 'text-red-900'
                    }`}
                  >
                    {creditInfo.kind === 'account' ? 'Account' : 'Location'} Credit
                  </h4>
                </div>
                <div className="grid grid-cols-3 gap-4 text-sm">
                  <div>
                    <span className="text-gray-600">Name:</span>
                    <div className="font-medium">{creditInfo.name}</div>
                  </div>
                  <div>
                    <span className="text-gray-600">Credit Limit:</span>
                    <div className="font-medium">₹{creditInfo.creditLimit.toLocaleString()}</div>
                  </div>
                  <div>
                    <span className="text-gray-600">Current Balance:</span>
                    <div className="font-medium">
                      ₹{creditInfo.currentBalance.toLocaleString()}
                    </div>
                  </div>
                  <div className="col-span-3">
                    <span className="text-gray-600">Available Credit:</span>{' '}
                    <span
                      className={`font-medium ${
                        creditInfo.allowed ? 'text-green-600' : 'text-red-600'
                      }`}
                    >
                      ₹{creditInfo.availableCredit.toLocaleString()}
                    </span>
                  </div>
                </div>
              </div>
            )}
          </section>

          {/* Test Request Form Upload */}
          <section className="space-y-2">
            <label className="block text-sm font-medium text-gray-700">Test Request Form</label>
            <div className="border-2 border-dashed border-gray-300 rounded-lg p-4 text-center">
              <input
                type="file"
                accept="image/*,.pdf"
                onChange={handleFileChange}
                className="hidden"
                id="test-request-upload"
              />
              <label htmlFor="test-request-upload" className="cursor-pointer inline-flex flex-col items-center">
                <Upload className="w-8 h-8 text-gray-400 mb-2" />
                <span className="text-sm text-gray-600">
                  {testRequestFile ? testRequestFile.name : 'Click to upload test request form'}
                </span>
                <span className="text-xs text-gray-500 mt-1">
                  Supports: JPG, PNG, PDF (Max 10MB)
                </span>
              </label>
            </div>
          </section>

          {/* Notes */}
          <section>
            <label className="block text-sm font-medium text-gray-700 mb-1">Clinical Notes</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="Any special instructions or clinical notes…"
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </section>

          {/* Actions */}
          <div className="flex items-center justify-between border-t pt-6">
            <div className="text-sm text-gray-600">
              {selectedTests.length > 0 ? (
                <span className="font-medium">Total: ₹{totalAmount}</span>
              ) : (
                <span>Select tests now or continue—tests can be added later.</span>
              )}
            </div>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-6 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
              >
                Create Order{selectedTests.length > 0 ? ` – ₹${totalAmount}` : ''}
              </button>
            </div>
          </div>
        </form>
      </div>

      {/* New Patient Modal */}
      {showNewPatientModal && (
        <div className="fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-lg">
            <div className="flex items-center justify-between p-4 border-b border-gray-200">
              <h3 className="text-lg font-semibold text-gray-900">Add New Patient</h3>
              <button onClick={() => setShowNewPatientModal(false)} className="text-gray-400 hover:text-gray-600">
                <X className="h-5 w-5" />
              </button>
            </div>

            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (!newPatient.name || !newPatient.age || !newPatient.gender || !newPatient.phone) return;
                try {
                  setCreatingPatient(true);
                  const payload: any = {
                    name: newPatient.name.trim(),
                    age: parseInt(newPatient.age, 10),
                    gender: newPatient.gender,
                    phone: newPatient.phone.trim(),
                    email: newPatient.email?.trim() || null,
                    // sensible defaults
                    address: '',
                    city: '',
                    state: '',
                    pincode: '',
                    emergency_contact: null,
                    emergency_phone: null,
                    blood_group: null,
                    allergies: null,
                    medical_history: null,
                    total_tests: 0,
                    is_active: true,
                    referring_doctor: null,
                    default_doctor_id: selectedDoctor || null,
                    default_location_id: selectedLocation || null,
                    default_payment_type: paymentType || 'self'
                  };

                  const { data, error } = await (database as any).patients?.create?.(payload);
                  if (error) {
                    console.error(error);
                    alert('Failed to create patient');
                    return;
                  }
                  if (data) {
                    setPatients((prev) => [...prev, data]);
                    setSelectedPatient(data);
                    setShowNewPatientModal(false);
                    setNewPatient({ name: '', age: '', gender: 'Male', phone: '', email: '' });
                  }
                } catch (err) {
                  console.error(err);
                  alert('Error creating patient');
                } finally {
                  setCreatingPatient(false);
                }
              }}
              className="p-6 space-y-4"
            >
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Name *</label>
                  <input
                    type="text"
                    required
                    value={newPatient.name}
                    onChange={(e) => setNewPatient((p) => ({ ...p, name: e.target.value }))}
                    className="w-full rounded-md border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Age *</label>
                  <input
                    type="number"
                    min={0}
                    required
                    value={newPatient.age}
                    onChange={(e) => setNewPatient((p) => ({ ...p, age: e.target.value }))}
                    className="w-full rounded-md border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Gender *</label>
                  <select
                    value={newPatient.gender}
                    onChange={(e) => setNewPatient((p) => ({ ...p, gender: e.target.value }))}
                    className="w-full rounded-md border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
                  >
                    <option>Male</option>
                    <option>Female</option>
                    <option>Other</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Phone *</label>
                  <input
                    type="tel"
                    required
                    value={newPatient.phone}
                    onChange={(e) => setNewPatient((p) => ({ ...p, phone: e.target.value }))}
                    className="w-full rounded-md border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
                  />
                </div>
                <div className="md:col-span-2">
                  <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                  <input
                    type="email"
                    value={newPatient.email}
                    onChange={(e) => setNewPatient((p) => ({ ...p, email: e.target.value }))}
                    className="w-full rounded-md border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
                  />
                </div>
              </div>

              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowNewPatientModal(false)}
                  className="px-4 py-2 text-sm border border-gray-300 rounded-md hover:bg-gray-50"
                  disabled={creatingPatient}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={
                    creatingPatient || !newPatient.name || !newPatient.age || !newPatient.phone
                  }
                  className="px-5 py-2 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
                >
                  {creatingPatient ? 'Saving…' : 'Save Patient'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default OrderForm;
