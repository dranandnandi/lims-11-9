Looking at the database tables you've created, I see you've already implemented Phase 1 successfully with some enhancements (RLS policies, triggers, indexes). Let me analyze the differences and prepare a detailed plan for Phase 2 with proper code.

## Analysis of Your Implementation vs. Original Plan

**What you added (excellent additions):**
1. Proper indexes for performance
2. RLS policies for multi-lab security
3. Updated_at triggers
4. NOT NULL constraints for better data integrity

**What's missing from Phase 1:**
- The `cash_register` table needs `lab_id` to be NOT NULL (you have it as nullable)
- Need to add indexes for the payment tables

## Phase 2: API Layer & TypeScript Interfaces (Week 1 Day 3-5)

### 2.1 TypeScript Interfaces

````typescript
// ...existing code...

// Add these new interfaces

export interface Doctor {
  id: string;
  lab_id: string;
  name: string;
  specialization?: string;
  qualification?: string;
  registration_number?: string;
  phone?: string;
  email?: string;
  preferred_contact: 'email' | 'sms' | 'whatsapp' | 'none';
  report_delivery_method: 'email' | 'whatsapp' | 'both' | 'none';
  default_discount_percent?: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Location {
  id: string;
  lab_id: string;
  name: string;
  type: 'hospital' | 'clinic' | 'diagnostic_center' | 'home_collection' | 'walk_in';
  contact_person?: string;
  phone?: string;
  email?: string;
  address?: string;
  city?: string;
  state?: string;
  pincode?: string;
  supports_cash_collection: boolean;
  default_discount_percent?: number;
  credit_limit: number;
  payment_terms: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Payment {
  id: string;
  lab_id?: string;
  invoice_id: string;
  amount: number;
  payment_method?: 'cash' | 'card' | 'upi' | 'bank' | 'credit_adjustment';
  payment_reference?: string;
  payment_date: string;
  location_id?: string;
  collected_by?: string;
  notes?: string;
  created_at: string;
}

export interface CashRegister {
  id: string;
  lab_id?: string;
  register_date: string;
  location_id?: string;
  shift: 'morning' | 'afternoon' | 'night' | 'full_day';
  opening_balance: number;
  system_amount: number;
  actual_amount?: number;
  closing_balance?: number;
  variance?: number;
  notes?: string;
  reconciled: boolean;
  reconciled_by?: string;
  reconciled_at?: string;
  created_by?: string;
  created_at: string;
}

export interface CreditTransaction {
  id: string;
  lab_id?: string;
  location_id?: string;
  patient_id?: string;
  invoice_id?: string;
  amount: number;
  transaction_type: 'credit' | 'payment' | 'adjustment';
  payment_method?: string;
  reference_number?: string;
  notes?: string;
  balance_after?: number;
  created_by?: string;
  created_at: string;
}

// Update existing interfaces
export interface Patient {
  // ...existing fields...
  default_doctor_id?: string;
  default_location_id?: string;
  default_payment_type?: 'self' | 'credit' | 'insurance' | 'corporate';
}

export interface Order {
  // ...existing fields...
  referring_doctor_id?: string;
  location_id?: string;
  payment_type: 'self' | 'credit' | 'insurance' | 'corporate';
  is_billed: boolean;
  billing_status: 'pending' | 'partial' | 'billed';
}
````

### 2.2 Update supabase.ts with New API Methods

````typescript
// ...existing code...

// Add these new API methods to the database object

doctors: {
  getAll: async () => {
    const labId = await database.getCurrentUserLabId();
    return supabase
      .from('doctors')
      .select('*')
      .eq('lab_id', labId)
      .eq('is_active', true)
      .order('name');
  },

  getById: async (id: string) => {
    const labId = await database.getCurrentUserLabId();
    return supabase
      .from('doctors')
      .select('*')
      .eq('id', id)
      .eq('lab_id', labId)
      .single();
  },

  create: async (data: Omit<Doctor, 'id' | 'created_at' | 'updated_at' | 'lab_id'>) => {
    const labId = await database.getCurrentUserLabId();
    return supabase
      .from('doctors')
      .insert({ ...data, lab_id: labId })
      .select()
      .single();
  },

  update: async (id: string, data: Partial<Omit<Doctor, 'id' | 'created_at' | 'updated_at' | 'lab_id'>>) => {
    const labId = await database.getCurrentUserLabId();
    return supabase
      .from('doctors')
      .update(data)
      .eq('id', id)
      .eq('lab_id', labId)
      .select()
      .single();
  },

  search: async (query: string) => {
    const labId = await database.getCurrentUserLabId();
    return supabase
      .from('doctors')
      .select('*')
      .eq('lab_id', labId)
      .eq('is_active', true)
      .or(`name.ilike.%${query}%,registration_number.ilike.%${query}%`)
      .limit(10);
  },

  toggleActive: async (id: string) => {
    const labId = await database.getCurrentUserLabId();
    const { data: doctor } = await supabase
      .from('doctors')
      .select('is_active')
      .eq('id', id)
      .eq('lab_id', labId)
      .single();
    
    if (!doctor) return { error: 'Doctor not found' };
    
    return supabase
      .from('doctors')
      .update({ is_active: !doctor.is_active })
      .eq('id', id)
      .eq('lab_id', labId);
  }
},

locations: {
  getAll: async () => {
    const labId = await database.getCurrentUserLabId();
    return supabase
      .from('locations')
      .select('*')
      .eq('lab_id', labId)
      .eq('is_active', true)
      .order('name');
  },

  getById: async (id: string) => {
    const labId = await database.getCurrentUserLabId();
    return supabase
      .from('locations')
      .select('*')
      .eq('id', id)
      .eq('lab_id', labId)
      .single();
  },

  create: async (data: Omit<Location, 'id' | 'created_at' | 'updated_at' | 'lab_id'>) => {
    const labId = await database.getCurrentUserLabId();
    return supabase
      .from('locations')
      .insert({ ...data, lab_id: labId })
      .select()
      .single();
  },

  update: async (id: string, data: Partial<Omit<Location, 'id' | 'created_at' | 'updated_at' | 'lab_id'>>) => {
    const labId = await database.getCurrentUserLabId();
    return supabase
      .from('locations')
      .update(data)
      .eq('id', id)
      .eq('lab_id', labId)
      .select()
      .single();
  },

  getCreditBalance: async (locationId: string) => {
    const labId = await database.getCurrentUserLabId();
    const { data } = await supabase
      .from('credit_transactions')
      .select('balance_after')
      .eq('location_id', locationId)
      .eq('lab_id', labId)
      .order('created_at', { ascending: false })
      .limit(1);
    
    return data?.[0]?.balance_after || 0;
  },

  checkCreditLimit: async (locationId: string, amount: number) => {
    const labId = await database.getCurrentUserLabId();
    const { data: location } = await supabase
      .from('locations')
      .select('credit_limit')
      .eq('id', locationId)
      .eq('lab_id', labId)
      .single();
    
    const currentBalance = await database.locations.getCreditBalance(locationId);
    const newBalance = currentBalance + amount;
    
    return {
      allowed: newBalance <= (location?.credit_limit || 0),
      currentBalance,
      creditLimit: location?.credit_limit || 0,
      availableCredit: (location?.credit_limit || 0) - currentBalance
    };
  }
},

payments: {
  create: async (data: Omit<Payment, 'id' | 'created_at' | 'lab_id' | 'collected_by'>) => {
    const labId = await database.getCurrentUserLabId();
    const userId = (await database.getCurrentUser()).id;
    
    // Start transaction
    const { data: payment, error: paymentError } = await supabase
      .from('payments')
      .insert({ 
        ...data, 
        lab_id: labId,
        collected_by: userId 
      })
      .select()
      .single();

    if (paymentError) return { error: paymentError };

    // Update invoice payment status
    const { data: payments } = await supabase
      .from('payments')
      .select('amount')
      .eq('invoice_id', data.invoice_id);

    const totalPaid = payments?.reduce((sum, p) => sum + p.amount, 0) || 0;

    const { data: invoice } = await supabase
      .from('invoices')
      .select('total_after_discount, total')
      .eq('id', data.invoice_id)
      .single();

    const invoiceTotal = invoice?.total_after_discount || invoice?.total || 0;
    const newStatus = totalPaid >= invoiceTotal ? 'Paid' : 'Partial';

    await supabase
      .from('invoices')
      .update({ 
        status: newStatus,
        paid_amount: totalPaid,
        payment_date: newStatus === 'Paid' ? data.payment_date : null
      })
      .eq('id', data.invoice_id);

    // Update cash register if cash payment
    if (data.payment_method === 'cash' && data.location_id) {
      const { data: register } = await database.cashRegister.getOrCreate(
        data.payment_date, 
        data.location_id
      );
      
      if (register) {
        await supabase
          .from('cash_register')
          .update({ 
            system_amount: (register.system_amount || 0) + data.amount 
          })
          .eq('id', register.id);
      }
    }

    return { data: payment, error: null };
  },

  getByInvoice: async (invoiceId: string) => {
    return supabase
      .from('payments')
      .select(`
        *,
        collected_by_user:users!collected_by(name),
        location:locations(name)
      `)
      .eq('invoice_id', invoiceId)
      .order('payment_date', { ascending: false });
  },

  getByDateRange: async (startDate: string, endDate: string, locationId?: string) => {
    const labId = await database.getCurrentUserLabId();
    let query = supabase
      .from('payments')
      .select(`
        *,
        invoice:invoices(
          id,
          patient_name,
          total_after_discount,
          total
        ),
        location:locations(name),
        collected_by_user:users!collected_by(name)
      `)
      .eq('lab_id', labId)
      .gte('payment_date', startDate)
      .lte('payment_date', endDate);
    
    if (locationId) {
      query = query.eq('location_id', locationId);
    }
    
    return query.order('payment_date', { ascending: false });
  }
},

cashRegister: {
  getOrCreate: async (date: string, locationId: string, shift: string = 'full_day') => {
    const labId = await database.getCurrentUserLabId();
    const userId = (await database.getCurrentUser()).id;
    
    // Try to get existing
    let { data: existing, error } = await supabase
      .from('cash_register')
      .select('*')
      .eq('lab_id', labId)
      .eq('location_id', locationId)
      .eq('register_date', date)
      .eq('shift', shift)
      .maybeSingle();
    
    if (existing) return { data: existing, error: null };
    
    // Create new with previous day's closing as opening
    const previousDate = new Date(date);
    previousDate.setDate(previousDate.getDate() - 1);
    
    const { data: previousRegister } = await supabase
      .from('cash_register')
      .select('closing_balance')
      .eq('lab_id', labId)
      .eq('location_id', locationId)
      .eq('register_date', previousDate.toISOString().split('T')[0])
      .eq('shift', shift)
      .maybeSingle();
    
    const { data: newRegister, error: createError } = await supabase
      .from('cash_register')
      .insert({
        lab_id: labId,
        location_id: locationId,
        register_date: date,
        shift,
        opening_balance: previousRegister?.closing_balance || 0,
        system_amount: 0,
        created_by: userId
      })
      .select()
      .single();
    
    return { data: newRegister, error: createError };
  },

  reconcile: async (id: string, actualAmount: number, notes?: string) => {
    const userId = (await database.getCurrentUser()).id;
    
    return supabase
      .from('cash_register')
      .update({
        actual_amount: actualAmount,
        closing_balance: actualAmount,
        notes,
        reconciled: true,
        reconciled_by: userId,
        reconciled_at: new Date().toISOString()
      })
      .eq('id', id)
      .select()
      .single();
  },

  getByDateRange: async (startDate: string, endDate: string, locationId?: string) => {
    const labId = await database.getCurrentUserLabId();
    let query = supabase
      .from('cash_register')
      .select(`
        *,
        location:locations(name),
        reconciled_by_user:users!reconciled_by(name),
        created_by_user:users!created_by(name)
      `)
      .eq('lab_id', labId)
      .gte('register_date', startDate)
      .lte('register_date', endDate);
    
    if (locationId) {
      query = query.eq('location_id', locationId);
    }
    
    return query.order('register_date', { ascending: false });
  }
},

creditTransactions: {
  create: async (data: Omit<CreditTransaction, 'id' | 'created_at' | 'lab_id' | 'created_by'>) => {
    const labId = await database.getCurrentUserLabId();
    const userId = (await database.getCurrentUser()).id;
    
    // Get current balance
    const currentBalance = await database.locations.getCreditBalance(data.location_id!);
    
    // Calculate new balance
    let newBalance = currentBalance;
    if (data.transaction_type === 'credit') {
      newBalance += data.amount;
    } else if (data.transaction_type === 'payment') {
      newBalance -= data.amount;
    }
    
    return supabase
      .from('credit_transactions')
      .insert({
        ...data,
        lab_id: labId,
        created_by: userId,
        balance_after: newBalance
      })
      .select()
      .single();
  },

  getByLocation: async (locationId: string, limit: number = 50) => {
    const labId = await database.getCurrentUserLabId();
    return supabase
      .from('credit_transactions')
      .select(`
        *,
        patient:patients(name),
        invoice:invoices(id, patient_name),
        created_by_user:users!created_by(name)
      `)
      .eq('lab_id', labId)
      .eq('location_id', locationId)
      .order('created_at', { ascending: false })
      .limit(limit);
  },

  getOutstandingByLocation: async () => {
    const labId = await database.getCurrentUserLabId();
    
    // Get latest balance for each location
    const { data: locations } = await supabase
      .from('locations')
      .select('id, name, credit_limit')
      .eq('lab_id', labId)
      .eq('is_active', true);
    
    if (!locations) return { data: [], error: null };
    
    const outstandingData = await Promise.all(
      locations.map(async (location) => {
        const balance = await database.locations.getCreditBalance(location.id);
        return {
          ...location,
          outstanding_balance: balance,
          available_credit: location.credit_limit - balance
        };
      })
    );
    
    return { data: outstandingData, error: null };
  }
}

// ...existing code...
````

## Phase 3: Master Management Components (Week 2 Day 1-2)

### 3.1 Doctor Master Component

````typescript
import React, { useState, useEffect } from 'react';
import { Plus, Search, Edit2, Trash2, Check, X, Mail, Phone, MessageSquare } from 'lucide-react';
import { database } from '../../utils/supabase';
import type { Doctor } from '../../types';

const DoctorMaster: React.FC = () => {
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editingDoctor, setEditingDoctor] = useState<Doctor | null>(null);
  
  // Form state
  const [formData, setFormData] = useState({
    name: '',
    specialization: '',
    qualification: '',
    registration_number: '',
    phone: '',
    email: '',
    preferred_contact: 'email' as const,
    report_delivery_method: 'email' as const,
    default_discount_percent: 0
  });

  useEffect(() => {
    loadDoctors();
  }, []);

  const loadDoctors = async () => {
    setLoading(true);
    try {
      const { data, error } = await database.doctors.getAll();
      if (error) throw error;
      setDoctors(data || []);
    } catch (error) {
      console.error('Error loading doctors:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    try {
      if (editingDoctor) {
        const { error } = await database.doctors.update(editingDoctor.id, formData);
        if (error) throw error;
      } else {
        const { error } = await database.doctors.create(formData);
        if (error) throw error;
      }
      
      await loadDoctors();
      resetForm();
    } catch (error) {
      console.error('Error saving doctor:', error);
      alert('Failed to save doctor. Please try again.');
    }
  };

  const handleEdit = (doctor: Doctor) => {
    setEditingDoctor(doctor);
    setFormData({
      name: doctor.name,
      specialization: doctor.specialization || '',
      qualification: doctor.qualification || '',
      registration_number: doctor.registration_number || '',
      phone: doctor.phone || '',
      email: doctor.email || '',
      preferred_contact: doctor.preferred_contact,
      report_delivery_method: doctor.report_delivery_method,
      default_discount_percent: doctor.default_discount_percent || 0
    });
    setShowForm(true);
  };

  const handleToggleActive = async (doctor: Doctor) => {
    try {
      const { error } = await database.doctors.toggleActive(doctor.id);
      if (error) throw error;
      await loadDoctors();
    } catch (error) {
      console.error('Error toggling doctor status:', error);
    }
  };

  const resetForm = () => {
    setFormData({
      name: '',
      specialization: '',
      qualification: '',
      registration_number: '',
      phone: '',
      email: '',
      preferred_contact: 'email',
      report_delivery_method: 'email',
      default_discount_percent: 0
    });
    setEditingDoctor(null);
    setShowForm(false);
  };

  const filteredDoctors = doctors.filter(doctor => 
    doctor.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    doctor.specialization?.toLowerCase().includes(searchQuery.toLowerCase()) ||
    doctor.registration_number?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const getContactIcon = (method: string) => {
    switch(method) {
      case 'email': return <Mail className="w-4 h-4" />;
      case 'sms': return <Phone className="w-4 h-4" />;
      case 'whatsapp': return <MessageSquare className="w-4 h-4" />;
      default: return null;
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold text-gray-900">Doctor Master</h1>
        <button
          onClick={() => setShowForm(true)}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
        >
          <Plus className="w-4 h-4" />
          Add Doctor
        </button>
      </div>

      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
          <input
            type="text"
            placeholder="Search by name, specialization, or registration number..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center items-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Doctor Details
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Contact
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Preferences
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Discount %
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Status
                </th>
                <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {filteredDoctors.map((doctor) => (
                <tr key={doctor.id} className={!doctor.is_active ? 'opacity-60' : ''}>
                  <td className="px-6 py-4">
                    <div>
                      <div className="font-medium text-gray-900">{doctor.name}</div>
                      <div className="text-sm text-gray-500">
                        {doctor.specialization}
                        {doctor.qualification && ` • ${doctor.qualification}`}
                      </div>
                      {doctor.registration_number && (
                        <div className="text-xs text-gray-400">Reg: {doctor.registration_number}</div>
                      )}
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <div className="text-sm">
                      {doctor.phone && <div className="text-gray-900">{doctor.phone}</div>}
                      {doctor.email && <div className="text-gray-500">{doctor.email}</div>}
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-4 text-sm">
                      <div className="flex items-center gap-1">
                        {getContactIcon(doctor.preferred_contact)}
                        <span className="text-gray-600">Contact</span>
                      </div>
                      <div className="flex items-center gap-1">
                        {getContactIcon(doctor.report_delivery_method)}
                        <span className="text-gray-600">Reports</span>
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    {doctor.default_discount_percent ? (
                      <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800">
                        {doctor.default_discount_percent}%
                      </span>
                    ) : (
                      <span className="text-sm text-gray-500">-</span>
                    )}
                  </td>
                  <td className="px-6 py-4">
                    <button
                      onClick={() => handleToggleActive(doctor)}
                      className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${
                        doctor.is_active 
                          ? 'bg-green-100 text-green-800' 
                          : 'bg-gray-100 text-gray-800'
                      }`}
                    >
                      {doctor.is_active ? 'Active' : 'Inactive'}
                    </button>
                  </td>
                  <td className="px-6 py-4 text-center">
                    <button
                      onClick={() => handleEdit(doctor)}
                      className="text-blue-600 hover:text-blue-800 mr-3"
                    >
                      <Edit2 className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Add/Edit Form Modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <h2 className="text-xl font-semibold mb-4">
              {editingDoctor ? 'Edit Doctor' : 'Add New Doctor'}
            </h2>
            
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Name *
                  </label>
                  <input
                    type="text"
                    required
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Specialization
                  </label>
                  <input
                    type="text"
                    value={formData.specialization}
                    onChange={(e) => setFormData({ ...formData, specialization: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Qualification
                  </label>
                  <input
                    type="text"
                    value={formData.qualification}
                    onChange={(e) => setFormData({ ...formData, qualification: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Registration Number
                  </label>
                  <input
                    type="text"
                    value={formData.registration_number}
                    onChange={(e) => setFormData({ ...formData, registration_number: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Phone
                  </label>
                  <input
                    type="tel"
                    value={formData.phone}
                    onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Email
                  </label>
                  <input
                    type="email"
                    value={formData.email}
                    onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Preferred Contact Method
                  </label>
                  <select
                    value={formData.preferred_contact}
                    onChange={(e) => setFormData({ ...formData, preferred_contact: e.target.value as any })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="email">Email</option>
                    <option value="sms">SMS</option>
                    <option value="whatsapp">WhatsApp</option>
                    <option value="none">None</option>
                  </select>
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Report Delivery Method
                  </label>
                  <select
                    value={formData.report_delivery_method}
                    onChange={(e) => setFormData({ ...formData, report_delivery_method: e.target.value as any })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="email">Email</option>
                    <option value="whatsapp">WhatsApp</option>
                    <option value="both">Both</option>
                    <option value="none">None</option>
                  </select>
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Default Discount %
                  </label>
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="0.01"
                    value={formData.default_discount_percent}
                    onChange={(e) => setFormData({ ...formData, default_discount_percent: parseFloat(e.target.value) || 0 })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>
              
              <div className="flex justify-end gap-3 pt-4">
                <button
                  type="button"
                  onClick={resetForm}
                  className="px-4 py-2 text-gray-700 bg-gray-100 rounded-md hover:bg-gray-200"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
                >
                  {editingDoctor ? 'Update' : 'Create'} Doctor
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default DoctorMaster;
````

### 3.2 Location Master Component

````typescript
import React, { useState, useEffect } from 'react';
import { Plus, Search, Edit2, MapPin, CreditCard, Building } from 'lucide-react';
import { database } from '../../utils/supabase';
import type { Location } from '../../types';

const LocationMaster: React.FC = () => {
  const [locations, setLocations] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editingLocation, setEditingLocation] = useState<Location | null>(null);
  
  // Form state
  const [formData, setFormData] = useState({
    name: '',
    type: 'clinic' as const,
    contact_person: '',
    phone: '',
    email: '',
    address: '',
    city: '',
    state: '',
    pincode: '',
    supports_cash_collection: false,
    default_discount_percent: 0,
    credit_limit: 0,
    payment_terms: 0
  });

  useEffect(() => {
    loadLocations();
  }, []);

  const loadLocations = async () => {
    setLoading(true);
    try {
      const { data, error } = await database.locations.getAll();
      if (error) throw error;
      setLocations(data || []);
    } catch (error) {
      console.error('Error loading locations:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    try {
      if (editingLocation) {
        const { error } = await database.locations.update(editingLocation.id, formData);
        if (error) throw error;
      } else {
        const { error } = await database.locations.create(formData);
        if (error) throw error;
      }
      
      await loadLocations();
      resetForm();
    } catch (error) {
      console.error('Error saving location:', error);
      alert('Failed to save location. Please try again.');
    }
  };

  const handleEdit = (location: Location) => {
    setEditingLocation(location);
    setFormData({
      name: location.name,
      type: location.type,
      contact_person: location.contact_person || '',
      phone: location.phone || '',
      email: location.email || '',
      address: location.address || '',
      city: location.city || '',
      state: location.state || '',
      pincode: location.pincode || '',
      supports_cash_collection: location.supports_cash_collection,
      default_discount_percent: location.default_discount_percent || 0,
      credit_limit: location.credit_limit,
      payment_terms: location.payment_terms
    });
    setShowForm(true);
  };

  const resetForm = () => {
    setFormData({
      name: '',
      type: 'clinic',
      contact_person: '',
      phone: '',
      email: '',
      address: '',
      city: '',
      state: '',
      pincode: '',
      supports_cash_collection: false,
      default_discount_percent: 0,
      credit_limit: 0,
      payment_terms: 0
    });
    setEditingLocation(null);
    setShowForm(false);
  };

  const filteredLocations = locations.filter(location => 
    location.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    location.type.toLowerCase().includes(searchQuery.toLowerCase()) ||
    location.city?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const getTypeIcon = (type: string) => {
    switch(type) {
      case 'hospital': return <Building className="w-4 h-4 text-blue-600" />;
      case 'clinic': return <Building className="w-4 h-4 text-green-600" />;
      case 'diagnostic_center': return <Building className="w-4 h-4 text-purple-600" />;
      default: return <MapPin className="w-4 h-4 text-gray-600" />;
    }
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      minimumFractionDigits: 0
    }).format(amount);
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold text-gray-900">Location Master</h1>
        <button
          onClick={() => setShowForm(true)}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
        >
          <Plus className="w-4 h-4" />
          Add Location
        </button>
      </div>

      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
          <input
            type="text"
            placeholder="Search by name, type, or city..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center items-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Location Details
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Contact
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Credit Info
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Settings
                </th>
                <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {filteredLocations.map((location) => (
                <tr key={location.id} className={!location.is_active ? 'opacity-60' : ''}>
                  <td className="px-6 py-4">
                    <div>
                      <div className="flex items-center gap-2">
                        {getTypeIcon(location.type)}
                        <span className="font-medium text-gray-900">{location.name}</span>
                      </div>
                      <div className="text-sm text-gray-500">
                        {location.type.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}
                      </div>
                      {location.city && (
                        <div className="text-xs text-gray-400">
                          {[location.city, location.state].filter(Boolean).join(', ')}
                        </div>
                      )}
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <div className="text-sm">
                      {location.contact_person && (
                        <div className="text-gray-900 font-medium">{location.contact_person}</div>
                      )}
                      {location.phone && <div className="text-gray-600">{location.phone}</div>}
                      {location.email && <div className="text-gray-500 text-xs">{location.email}</div>}
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    {location.credit_limit > 0 ? (
                      <div className="text-sm">
                        <div className="flex items-center gap-1">
                          <CreditCard className="w-4 h-4 text-gray-400" />
                          <span className="font-medium">{formatCurrency(location.credit_limit)}</span>
                        </div>
                        {location.payment_terms > 0 && (
                          <div className="text-xs text-gray-500">{location.payment_terms} days</div>
                        )}
                      </div>
                    ) : (
                      <span className="text-sm text-gray-500">Cash Only</span>
                    )}
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex flex-col gap-1">
                      {location.supports_cash_collection && (
                        <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800">
                          Cash Collection
                        </span>
                      )}
                      {location.default_discount_percent > 0 && (
                        <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                          {location.default_discount_percent}% Discount
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-6 py-4 text-center">
                    <button
                      onClick={() => handleEdit(location)}
                      className="text-blue-600 hover:text-blue-800"
                    >
                      <Edit2 className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Add/Edit Form Modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 w-full max-w-3xl max-h-[90vh] overflow-y-auto">
            <h2 className="text-xl font-semibold mb-4">
              {editingLocation ? 'Edit Location' : 'Add New Location'}
            </h2>
            
            <form onSubmit={handleSubmit} className="space-y-6">
              {/* Basic Information */}
              <div>
                <h3 className="text-sm font-medium text-gray-700 mb-3">Basic Information</h3>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Name *
                    </label>
                    <input
                      type="text"
                      required
                      value={formData.name}
                      onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Type *
                    </label>
                    <select
                      required
                      value={formData.type}
                      onChange={(e) => setFormData({ ...formData, type: e.target.value as any })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="hospital">Hospital</option>
                      <option value="clinic">Clinic</option>
                      <option value="diagnostic_center">Diagnostic Center</option>
                      <option value="home_collection">Home Collection</option>
                      <option value="walk_in">Walk-in</option>
                    </select>
                  </div>
                </div>
              </div>

              {/* Contact Information */}
              <div>
                <h3 className="text-sm font-medium text-gray-700 mb-3">Contact Information</h3>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Contact Person
                    </label>
                    <input
                      type="text"
                      value={formData.contact_person}
                      onChange={(e) => setFormData({ ...formData, contact_person: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Phone
                    </label>
                    <input
                      type="tel"
                      value={formData.phone}
                      onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  
                  <div className="col-span-2">
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Email
                    </label>
                    <input
                      type="email"
                      value={formData.email}
                      onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                </div>
              </div>

              {/* Address */}
              <div>
                <h3 className="text-sm font-medium text-gray-700 mb-3">Address</h3>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Address
                    </label>
                    <textarea
                      value={formData.address}
                      onChange={(e) => setFormData({ ...formData, address: e.target.value })}
                      rows={2}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  
                  <div className="grid grid-cols-3 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        City
                      </label>
                      <input
                        type="text"
                        value={formData.city}
                        onChange={(e) => setFormData({ ...formData, city: e.target.value })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                    
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        State
                      </label>
                      <input
                        type="text"
                        value={formData.state}
                        onChange={(e) => setFormData({ ...formData, state: e.target.value })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                    
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Pincode
                      </label>
                      <input
                        type="text"
                        value={formData.pincode}
                        onChange={(e) => setFormData({ ...formData, pincode: e.target.value })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* Financial Settings */}
              <div>
                <h3 className="text-sm font-medium text-gray-700 mb-3">Financial Settings</h3>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Credit Limit (₹)
                    </label>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={formData.credit_limit}
                      onChange={(e) => setFormData({ ...formData, credit_limit: parseFloat(e.target.value) || 0 })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Payment Terms (days)
                    </label>
                    <input
                      type="number"
                      min="0"
                      value={formData.payment_terms}
                      onChange={(e) => setFormData({ ...formData, payment_terms: parseInt(e.target.value) || 0 })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Default Discount %
                    </label>
                    <input
                      type="number"
                      min="0"
                      max="100"
                      step="0.01"
                      value={formData.default_discount_percent}
                      onChange={(e) => setFormData({ ...formData, default_discount_percent: parseFloat(e.target.value) || 0 })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  
                  <div className="flex items-center">
                    <label className="flex items-center">
                      <input
                        type="checkbox"
                        checked={formData.supports_cash_collection}
                        onChange={(e) => setFormData({ ...formData, supports_cash_collection: e.target.checked })}
                        className="mr-2 h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                      />
                      <span className="text-sm font-medium text-gray-700">Supports Cash Collection</span>
                    </label>
                  </div>
                </div>
              </div>
              
              <div className="flex justify-end gap-3 pt-4 border-t">
                <button
                  type="button"
                  onClick={resetForm}
                  className="px-4 py-2 text-gray-700 bg-gray-100 rounded-md hover:bg-gray-200"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
                >
                  {editingLocation ? 'Update' : 'Create'} Location
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default LocationMaster;
````

## Phase 4: Navigation Updates (Week 2 Day 2)

### 4.1 Update Navigation Component

````typescript
// ...existing code...

// Add these new navigation items
const navigationItems = [
  // ...existing items...
  
  {
    name: 'Masters',
    icon: Settings,
    children: [
      { name: 'Doctors', href: '/masters/doctors', icon: Users },
      { name: 'Locations', href: '/masters/locations', icon: MapPin },
      { name: 'Test Groups', href: '/test-groups', icon: TestTube },
      { name: 'Analytes', href: '/analytes', icon: Beaker },
    ],
  },
  
  {
    name: 'Billing',
    icon: DollarSign,
    children: [
      { name: 'Invoices', href: '/billing', icon: FileText },
      { name: 'Payments', href: '/billing/payments', icon: CreditCard },
      { name: 'Cash Reconciliation', href: '/billing/cash-reconciliation', icon: Calculator },
      { name: 'Credit Management', href: '/billing/credits', icon: Wallet },
    ],
  },
  
  // ...existing items...
];
````

### 4.2 Update App Router

````typescript
// ...existing code...

// Add these imports
import DoctorMaster from './components/Masters/DoctorMaster';
import LocationMaster from './components/Masters/LocationMaster';

// Add these routes
<Route path="/masters/doctors" element={<AuthRoute><DoctorMaster /></AuthRoute>} />
<Route path="/masters/locations" element={<AuthRoute><LocationMaster /></AuthRoute>} />
````

## Next Steps Summary

### Completed in Phase 2:
1. ✅ TypeScript interfaces for all new entities
2. ✅ Complete API layer in supabase.ts
3. ✅ Doctor Master component with full CRUD
4. ✅ Location Master component with full CRUD
5. ✅ Navigation updates

### Ready for Phase 3:
1. Update OrderForm with doctor/location selection
2. Fix Dashboard OrderForm handler
3. Create billing components (CreateInvoiceModal, PaymentCapture)
4. Add cash reconciliation interface
5. Update patient form with defaults

Would you like me to continue with Phase 3 implementation?

Similar code found with 2 license types