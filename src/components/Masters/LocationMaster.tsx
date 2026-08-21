import React, { useState, useEffect } from 'react';
import { Plus, Search, Edit, Trash2, Save, X, MapPin, Building, Phone, Mail, CreditCard, DollarSign, TrendingUp, User, IndianRupee, ArrowLeft, ChevronRight, Printer, MessageSquare } from 'lucide-react';
import { database, supabase } from '../../utils/supabase';
import { Location, CreditTransaction } from '../../types';
import HeaderFooterUpload from '../Settings/HeaderFooterUpload';
import PricingGrid from '../Pricing/PricingGrid';

interface LocationFormData {
  name: string;
  code: string;
  type: 'hospital' | 'clinic' | 'diagnostic_center' | 'home_collection' | 'walk_in';
  address: string;
  phone: string;
  email: string;
  contact_person: string;
  credit_limit: number;
  collection_percentage: number;
  is_cash_collection_center: boolean;
  is_collection_center: boolean;
  is_processing_center: boolean;
  can_receive_samples: boolean;
  notes: string;
  upi_id: string;
  barcode_printer_name: string;
  report_printer_name: string;
  barcode_browser_print_enabled: boolean | null;
  auto_print_barcode_on_order: boolean | null;
  auto_print_report_on_approval: boolean | null;
  /** users.id of this branch's WhatsApp sender; '' = inherit the lab default */
  whatsapp_user_id: string;
  /** '' = inherit labs.country_code */
  whatsapp_country_code: string;
}

const initialFormData: LocationFormData = {
  name: '',
  code: '',
  type: 'diagnostic_center',
  address: '',
  phone: '',
  email: '',
  contact_person: '',
  credit_limit: 0,
  collection_percentage: 0,
  is_cash_collection_center: false,
  is_collection_center: true,
  is_processing_center: false,
  can_receive_samples: true,
  notes: '',
  upi_id: '',
  barcode_printer_name: '',
  report_printer_name: '',
  barcode_browser_print_enabled: null,
  auto_print_barcode_on_order: null,
  auto_print_report_on_approval: null,
  whatsapp_user_id: '',
  whatsapp_country_code: '',
};

interface LocationWithBalance extends Location {
  current_credit_balance?: number;
  credit_transactions?: CreditTransaction[];
}

const LocationMaster: React.FC = () => {
  const [locations, setLocations] = useState<LocationWithBalance[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editingLocation, setEditingLocation] = useState<Location | null>(null);
  const [formData, setFormData] = useState<LocationFormData>(initialFormData);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedLocationCredit, setSelectedLocationCredit] = useState<string | null>(null);
  const [creditTransactions, setCreditTransactions] = useState<CreditTransaction[]>([]);
  const [newCreditAmount, setNewCreditAmount] = useState<number>(0);
  const [newCreditDescription, setNewCreditDescription] = useState('');
  const [addingCredit, setAddingCredit] = useState(false);
  const [selectedLocationForPricing, setSelectedLocationForPricing] = useState<Location | null>(null);
  // Candidates for this branch's WhatsApp sender. The backend keys sessions by
  // users.id, so the dropdown offers the lab's users directly.
  const [labUsers, setLabUsers] = useState<{ id: string; name: string; role: string; synced: boolean }[]>([]);
  const [labDefaultSender, setLabDefaultSender] = useState<{ name: string; countryCode: string } | null>(null);

  // Load locations on component mount
  useEffect(() => {
    loadLocations();
    loadWhatsAppSenderOptions();
  }, []);

  // Populates the per-location WhatsApp sender dropdown and the label that tells
  // the user what "inherit" currently resolves to.
  const loadWhatsAppSenderOptions = async () => {
    try {
      const labId = await database.getCurrentUserLabId();
      if (!labId) return;

      const [{ data: users }, { data: lab }] = await Promise.all([
        supabase
          .from('users')
          .select('id, name, role, whatsapp_user_id')
          .eq('lab_id', labId)
          .eq('status', 'Active')
          .order('name'),
        supabase
          .from('labs')
          .select('whatsapp_user_id, country_code')
          .eq('id', labId)
          .maybeSingle(),
      ]);

      type LabUserRow = { id: string; name: string; role: string | null; whatsapp_user_id: string | null };
      const options = ((users || []) as LabUserRow[]).map((u) => ({
        id: u.id,
        name: u.name,
        role: u.role || '',
        // whatsapp_user_id is stamped when the user is registered with the
        // WhatsApp backend; unsynced users can still be picked, they just have
        // to scan a QR before anything will send.
        synced: !!u.whatsapp_user_id,
      }));
      setLabUsers(options);

      const defaultUser = options.find(o => o.id === lab?.whatsapp_user_id);
      setLabDefaultSender({
        name: defaultUser?.name || (lab?.whatsapp_user_id ? 'Unknown user' : 'not set'),
        countryCode: lab?.country_code || '+91',
      });
    } catch (err) {
      console.error('Error loading WhatsApp sender options:', err);
    }
  };

  const loadLocations = async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error } = await database.locations.getAll();
      if (error) throw error;

      // Load credit balances for each location
      const locationsWithBalances = await Promise.all(
        (data || []).map(async (location) => {
          try {
            const { data: creditSummary } = await database.creditTransactions.getCreditSummaryByLocation(location.id);
            return {
              ...location,
              current_credit_balance: creditSummary?.current_balance || 0
            };
          } catch (err) {
            console.error(`Error loading credit balance for location ${location.id}:`, err);
            return {
              ...location,
              current_credit_balance: 0
            };
          }
        })
      );

      setLocations(locationsWithBalances);
    } catch (err: any) {
      console.error('Error loading locations:', err);
      setError('Failed to load locations. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateNew = () => {
    setEditingLocation(null);
    setFormData(initialFormData);
    setShowForm(true);
    setError(null);
  };

  const handleEdit = (location: Location) => {
    setEditingLocation(location);
    setFormData({
      name: location.name,
      code: location.code || '',
      type: location.type as any || 'diagnostic_center',
      address: location.address || '',
      phone: location.phone || '',
      email: location.email || '',
      contact_person: location.contact_person || '',
      credit_limit: location.credit_limit || 0,
      collection_percentage: location.collection_percentage || 0,
      is_cash_collection_center: location.is_cash_collection_center || false,
      is_collection_center: location.is_collection_center ?? true,
      is_processing_center: location.is_processing_center ?? false,
      can_receive_samples: location.can_receive_samples ?? true,
      notes: location.notes || '',
      upi_id: (location as any).upi_id || '',
      barcode_printer_name: (location as any).barcode_printer_name || '',
      report_printer_name: (location as any).report_printer_name || '',
      barcode_browser_print_enabled: (location as any).barcode_browser_print_enabled ?? null,
      auto_print_barcode_on_order: (location as any).auto_print_barcode_on_order ?? null,
      auto_print_report_on_approval: (location as any).auto_print_report_on_approval ?? null,
      whatsapp_user_id: location.whatsapp_user_id || '',
      whatsapp_country_code: location.whatsapp_country_code || '',
    });
    setShowForm(true);
    setError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      // Blank means "inherit from the lab", which the uuid/varchar columns need
      // as a real NULL rather than an empty string.
      const payload = {
        ...formData,
        whatsapp_user_id: formData.whatsapp_user_id || null,
        whatsapp_country_code: formData.whatsapp_country_code || null,
      };

      if (editingLocation) {
        // Update existing location
        const { data, error } = await database.locations.update(editingLocation.id, payload);
        if (error) throw error;

        // Update local state
        setLocations(prev => prev.map(l => l.id === editingLocation.id ? { ...l, ...data } : l));
      } else {
        // Create new location
        const { data, error } = await database.locations.create(payload);
        if (error) throw error;

        // Add to local state
        setLocations(prev => [{ ...data, current_credit_balance: 0 }, ...prev]);
      }

      // Reset form and close
      setShowForm(false);
      setFormData(initialFormData);
      setEditingLocation(null);
    } catch (err: any) {
      console.error('Error saving location:', err);
      setError('Failed to save location. Please check all required fields.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (location: Location) => {
    if (!confirm(`Are you sure you want to delete "${location.name}"? This action cannot be undone.`)) {
      return;
    }

    try {
      const { error } = await database.locations.delete(location.id);
      if (error) throw error;

      // Remove from local state
      setLocations(prev => prev.filter(l => l.id !== location.id));
    } catch (err: any) {
      console.error('Error deleting location:', err);
      setError('Failed to delete location. Please try again.');
    }
  };

  const handleCancel = () => {
    setShowForm(false);
    setFormData(initialFormData);
    setEditingLocation(null);
    setError(null);
  };

  const handleViewCredit = async (locationId: string) => {
    try {
      const { data, error } = await database.creditTransactions.getByLocation(locationId, 50);
      if (error) throw error;

      setCreditTransactions(data || []);
      setSelectedLocationCredit(locationId);
    } catch (err: any) {
      console.error('Error loading credit transactions:', err);
      setError('Failed to load credit transactions.');
    }
  };

  const handleAddCredit = async (locationId: string, type: 'credit' | 'debit') => {
    if (!newCreditAmount || newCreditAmount <= 0) {
      setError('Please enter a valid amount.');
      return;
    }

    setAddingCredit(true);
    try {
      const { error } = await database.creditTransactions.create({
        location_id: locationId,
        amount: newCreditAmount,
        type,
        description: newCreditDescription || `${type === 'credit' ? 'Credit' : 'Debit'} adjustment`,
        reference_type: 'manual_adjustment'
      });

      if (error) throw error;

      // Refresh credit transactions
      await handleViewCredit(locationId);

      // Update location balance in local state
      const { data: creditSummary } = await database.creditTransactions.getCreditSummaryByLocation(locationId);
      setLocations(prev => prev.map(l =>
        l.id === locationId
          ? { ...l, current_credit_balance: creditSummary?.current_balance || 0 }
          : l
      ));

      // Reset form
      setNewCreditAmount(0);
      setNewCreditDescription('');
    } catch (err: any) {
      console.error('Error adding credit transaction:', err);
      setError('Failed to add credit transaction. Please try again.');
    } finally {
      setAddingCredit(false);
    }
  };

  // Filter locations based on search term
  const filteredLocations = locations.filter(location =>
    !searchTerm ||
    location.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    location.code?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    location.contact_person?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    location.address?.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Pricing View */}
      {selectedLocationForPricing ? (
        <div>
          {/* Header with Back Button */}
          <div className="mb-6">
            <button
              onClick={() => setSelectedLocationForPricing(null)}
              className="flex items-center gap-2 text-gray-600 hover:text-gray-900 mb-4"
            >
              <ArrowLeft className="w-4 h-4" />
              Back to Locations
            </button>
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 bg-purple-100 rounded-full flex items-center justify-center">
                <IndianRupee className="h-5 w-5 text-purple-600" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-gray-900">
                  {selectedLocationForPricing.name} - Pricing
                </h1>
                <p className="text-gray-600">
                  Set patient prices and lab receivable amounts for tests and packages
                </p>
              </div>
            </div>
          </div>

          {/* Location Pricing Info */}
          <div className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded-lg">
            <div className="flex items-start gap-3">
              <MapPin className="w-5 h-5 text-blue-600 mt-0.5" />
              <div>
                <h3 className="font-medium text-blue-900">Location Pricing Configuration</h3>
                <p className="text-sm text-blue-700 mt-1">
                  <strong>Patient Price:</strong> The price shown to patients (B2C price) at this location.
                </p>
                <p className="text-sm text-blue-700">
                  <strong>Lab Receivable:</strong> The amount your lab receives from this location per test.
                </p>
                <p className="text-sm text-blue-700 mt-1">
                  <em>Collection Percentage: {selectedLocationForPricing.collection_percentage || 0}%</em>
                  {selectedLocationForPricing.is_cash_collection_center && 
                    <span className="ml-2 px-2 py-0.5 bg-blue-200 text-blue-800 rounded text-xs">Cash Collection Center</span>
                  }
                </p>
              </div>
            </div>
          </div>

          {/* Pricing Grid */}
          <PricingGrid
            entityType="location"
            entityId={selectedLocationForPricing.id}
            entityName={selectedLocationForPricing.name}
            showReceivable={true}
          />
        </div>
      ) : (
      <>
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Location Master</h1>
        <p className="text-gray-600">Manage collection centers, clinics, and credit accounts</p>
      </div>

      {/* Error Message */}
      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg">
          <p className="text-red-600">{error}</p>
          <button
            onClick={() => setError(null)}
            className="mt-2 text-sm text-red-500 hover:text-red-700"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Search and Actions */}
      <div className="mb-6 flex flex-col sm:flex-row gap-4">
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-4 h-4" />
          <input
            type="text"
            placeholder="Search locations by name, code, contact person, or address..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
        </div>
        <button
          onClick={handleCreateNew}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors flex items-center gap-2"
        >
          <Plus className="w-4 h-4" />
          Add Location
        </button>
      </div>

      {/* Form Modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-3xl w-full max-h-[90vh] overflow-y-auto">
            <form onSubmit={handleSubmit} className="p-6">
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-xl font-bold text-gray-900">
                  {editingLocation ? 'Edit Location' : 'Add New Location'}
                </h2>
                <button
                  type="button"
                  onClick={handleCancel}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <X className="w-6 h-6" />
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                {/* Name */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Location Name *
                  </label>
                  <input
                    type="text"
                    required
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    placeholder="City Clinic"
                  />
                </div>

                {/* Type */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Location Type *
                  </label>
                  <select
                    required
                    value={formData.type}
                    onChange={(e) => setFormData({ ...formData, type: e.target.value as any })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  >
                    <option value="diagnostic_center">Diagnostic Center</option>
                    <option value="hospital">Hospital</option>
                    <option value="clinic">Clinic</option>
                    <option value="home_collection">Home Collection</option>
                    <option value="walk_in">Walk-in</option>
                  </select>
                </div>

                {/* Code */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Location Code
                  </label>
                  <input
                    type="text"
                    value={formData.code}
                    onChange={(e) => setFormData({ ...formData, code: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    placeholder="CC001"
                  />
                </div>

                {/* Address */}
                <div className="md:col-span-2">
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Address
                  </label>
                  <textarea
                    value={formData.address}
                    onChange={(e) => setFormData({ ...formData, address: e.target.value })}
                    rows={2}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    placeholder="Complete address including city and postal code"
                  />
                </div>

                {/* Contact Person */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Contact Person
                  </label>
                  <input
                    type="text"
                    value={formData.contact_person}
                    onChange={(e) => setFormData({ ...formData, contact_person: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    placeholder="John Doe"
                  />
                </div>

                {/* Phone */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Phone Number
                  </label>
                  <input
                    type="tel"
                    value={formData.phone}
                    onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    placeholder="+91 98765 43210"
                  />
                </div>

                {/* Email */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Email Address
                  </label>
                  <input
                    type="email"
                    value={formData.email}
                    onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    placeholder="contact@clinic.com"
                  />
                </div>

                {/* Credit Limit */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Credit Limit (₹)
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={formData.credit_limit}
                    onChange={(e) => setFormData({ ...formData, credit_limit: parseFloat(e.target.value) || 0 })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    placeholder="50000"
                  />
                </div>

                {/* Collection Percentage */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Collection Percentage (%)
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    max="100"
                    value={formData.collection_percentage}
                    onChange={(e) => setFormData({ ...formData, collection_percentage: parseFloat(e.target.value) || 0 })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    placeholder="10"
                  />
                </div>

                {/* UPI ID for this location */}
                <div className="md:col-span-2">
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    UPI ID (for this location)
                  </label>
                  <input
                    type="text"
                    value={formData.upi_id}
                    onChange={(e) => setFormData({ ...formData, upi_id: e.target.value.toLowerCase() })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    placeholder="location@ybl or business@paytm"
                  />
                  <p className="mt-1 text-xs text-gray-500">
                    If set, invoices from this location will show this UPI ID for payments. Leave empty to use lab's default UPI.
                  </p>
                </div>

                {/* Is Cash Collection Center */}
                <div className="md:col-span-2">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={formData.is_cash_collection_center}
                      onChange={(e) => setFormData({ ...formData, is_cash_collection_center: e.target.checked })}
                      className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                    />
                    <span className="text-sm font-medium text-gray-700">
                      Is a cash collection center (collects payments on our behalf)
                    </span>
                  </label>
                </div>

                {/* Location role in the sample workflow */}
                <div className="md:col-span-2 border rounded-lg p-4 bg-gray-50 space-y-3">
                  <div>
                    <h3 className="text-sm font-semibold text-gray-700">Role in sample workflow</h3>
                    <p className="text-xs text-gray-500">
                      Controls where samples can be sent and which centers process them in-house.
                    </p>
                  </div>

                  <label className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={formData.is_collection_center}
                      onChange={(e) => setFormData({ ...formData, is_collection_center: e.target.checked })}
                      className="w-4 h-4 mt-0.5 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                    />
                    <span>
                      <span className="block text-sm font-medium text-gray-700">Collection center</span>
                      <span className="block text-xs text-gray-500">Collects samples from patients and registers orders.</span>
                    </span>
                  </label>

                  <label className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={formData.is_processing_center}
                      onChange={(e) => setFormData({
                        ...formData,
                        is_processing_center: e.target.checked,
                        // A processing center must be able to receive samples
                        can_receive_samples: e.target.checked ? true : formData.can_receive_samples,
                      })}
                      className="w-4 h-4 mt-0.5 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                    />
                    <span>
                      <span className="block text-sm font-medium text-gray-700">Processing center</span>
                      <span className="block text-xs text-gray-500">
                        Runs tests and enters results in-house. Appears as a transit destination and as
                        the "processed at" center on reports.
                      </span>
                    </span>
                  </label>

                  <label className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={formData.can_receive_samples}
                      disabled={formData.is_processing_center}
                      onChange={(e) => setFormData({ ...formData, can_receive_samples: e.target.checked })}
                      className="w-4 h-4 mt-0.5 text-blue-600 border-gray-300 rounded focus:ring-blue-500 disabled:opacity-60"
                    />
                    <span>
                      <span className="block text-sm font-medium text-gray-700">Can receive samples in transit</span>
                      <span className="block text-xs text-gray-500">
                        Can be picked as a destination when dispatching samples from another center.
                      </span>
                    </span>
                  </label>
                </div>

                {/* Notes */}
                <div className="md:col-span-2">
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Notes
                  </label>
                  <textarea
                    value={formData.notes}
                    onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                    rows={3}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    placeholder="Additional notes about this location..."
                  />
                </div>
              </div>

              {/* Printer Settings */}
              <div className="border-t pt-5 mt-2">
                <h3 className="text-sm font-semibold text-gray-700 mb-1 flex items-center gap-2">
                  <Printer className="w-4 h-4 text-blue-600" />
                  Printer Settings (overrides lab defaults)
                </h3>
                <p className="text-xs text-gray-500 mb-3">
                  Leave blank to inherit the lab-wide printer. Set here to give this center its own printer.
                </p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Barcode / Label Printer</label>
                    <input
                      type="text"
                      placeholder="e.g. Zebra ZD421 (leave blank = lab default)"
                      value={formData.barcode_printer_name}
                      onChange={(e) => setFormData({ ...formData, barcode_printer_name: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Report Printer</label>
                    <input
                      type="text"
                      placeholder="e.g. HP LaserJet M404dn (leave blank = lab default)"
                      value={formData.report_printer_name}
                      onChange={(e) => setFormData({ ...formData, report_printer_name: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  {/* Auto-print barcode: tri-state — null = inherit lab, true/false = override */}
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Auto-print barcode on order</label>
                    <select
                      value={formData.auto_print_barcode_on_order === null ? 'inherit' : formData.auto_print_barcode_on_order ? 'yes' : 'no'}
                      onChange={(e) => setFormData({
                        ...formData,
                        auto_print_barcode_on_order: e.target.value === 'inherit' ? null : e.target.value === 'yes'
                      })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
                    >
                      <option value="inherit">Inherit from lab</option>
                      <option value="yes">Enabled for this center</option>
                      <option value="no">Disabled for this center</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Barcode print mode</label>
                    <select
                      value={formData.barcode_browser_print_enabled === null ? 'inherit' : formData.barcode_browser_print_enabled ? 'browser' : 'utility'}
                      onChange={(e) => setFormData({
                        ...formData,
                        barcode_browser_print_enabled: e.target.value === 'inherit' ? null : e.target.value === 'browser'
                      })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
                    >
                      <option value="inherit">Inherit from lab</option>
                      <option value="browser">Use browser print dialog</option>
                      <option value="utility">Use LIMS Utility queue</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Auto-print report on approval</label>
                    <select
                      value={formData.auto_print_report_on_approval === null ? 'inherit' : formData.auto_print_report_on_approval ? 'yes' : 'no'}
                      onChange={(e) => setFormData({
                        ...formData,
                        auto_print_report_on_approval: e.target.value === 'inherit' ? null : e.target.value === 'yes'
                      })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
                    >
                      <option value="inherit">Inherit from lab</option>
                      <option value="yes">Enabled for this center</option>
                      <option value="no">Disabled for this center</option>
                    </select>
                  </div>
                </div>
              </div>

              {/* WhatsApp Sender (per-branch number) */}
              <div className="border-t pt-5 mt-2">
                <h3 className="text-sm font-semibold text-gray-700 mb-1 flex items-center gap-2">
                  <MessageSquare className="w-4 h-4 text-green-600" />
                  WhatsApp Sender (overrides lab default)
                </h3>
                <p className="text-xs text-gray-500 mb-3">
                  Messages for orders from this center are sent from this account's WhatsApp number.
                  Leave on "Inherit" to use the lab-wide sender
                  {labDefaultSender ? ` (currently ${labDefaultSender.name})` : ''}.
                </p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Sender Account</label>
                    <select
                      value={formData.whatsapp_user_id}
                      onChange={(e) => setFormData({ ...formData, whatsapp_user_id: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
                    >
                      <option value="">
                        Inherit from lab{labDefaultSender ? ` (${labDefaultSender.name})` : ''}
                      </option>
                      {labUsers.map(u => (
                        <option key={u.id} value={u.id}>
                          {u.name}{u.role ? ` — ${u.role}` : ''}{u.synced ? '' : ' (not yet synced)'}
                        </option>
                      ))}
                    </select>
                    <p className="text-xs text-gray-500 mt-1">
                      This user must connect their own number under WhatsApp → Connection before messages will send.
                    </p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Country Code</label>
                    <select
                      value={formData.whatsapp_country_code}
                      onChange={(e) => setFormData({ ...formData, whatsapp_country_code: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
                    >
                      <option value="">
                        Inherit from lab{labDefaultSender ? ` (${labDefaultSender.countryCode})` : ''}
                      </option>
                      <option value="+91">India (+91)</option>
                      <option value="+92">Pakistan (+92)</option>
                      <option value="+94">Sri Lanka (+94)</option>
                      <option value="+971">UAE (+971)</option>
                      <option value="+880">Bangladesh (+880)</option>
                      <option value="+977">Nepal (+977)</option>
                    </select>
                    <p className="text-xs text-gray-500 mt-1">
                      Used to format recipient numbers for this center.
                    </p>
                  </div>
                </div>
                {formData.whatsapp_user_id
                  && !labUsers.find(u => u.id === formData.whatsapp_user_id)?.synced && (
                  <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5 mt-3">
                    This user has not been synced to the WhatsApp backend yet. Go to WhatsApp → User Sync,
                    sync them, then connect their number.
                  </p>
                )}
              </div>

              {/* Report Customization - Only for existing locations */}
              {editingLocation && (
                <div className="border-t pt-4 mt-4">
                  <HeaderFooterUpload
                    entityType="location"
                    entityId={editingLocation.id}
                    entityName={editingLocation.name}
                  />
                </div>
              )}

              {/* Form Actions */}
              <div className="flex justify-end gap-3">
                <button
                  type="button"
                  onClick={handleCancel}
                  className="px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors flex items-center gap-2 disabled:opacity-50"
                >
                  <Save className="w-4 h-4" />
                  {submitting ? 'Saving...' : 'Save Location'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Credit Transactions Modal */}
      {selectedLocationCredit && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-4xl w-full max-h-[90vh] overflow-y-auto">
            <div className="p-6">
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-xl font-bold text-gray-900">Credit Management</h2>
                <button
                  onClick={() => {
                    setSelectedLocationCredit(null);
                    setCreditTransactions([]);
                  }}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <X className="w-6 h-6" />
                </button>
              </div>

              {/* Add Credit Section */}
              <div className="mb-6 p-4 bg-gray-50 rounded-lg">
                <h3 className="text-lg font-medium text-gray-900 mb-4">Add Credit Transaction</h3>
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Amount (₹)</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={newCreditAmount}
                      onChange={(e) => setNewCreditAmount(parseFloat(e.target.value) || 0)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      placeholder="1000"
                    />
                  </div>
                  <div className="md:col-span-2">
                    <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                    <input
                      type="text"
                      value={newCreditDescription}
                      onChange={(e) => setNewCreditDescription(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      placeholder="Credit adjustment reason..."
                    />
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleAddCredit(selectedLocationCredit, 'credit')}
                      disabled={addingCredit}
                      className="flex-1 px-3 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors disabled:opacity-50"
                    >
                      Add Credit
                    </button>
                    <button
                      onClick={() => handleAddCredit(selectedLocationCredit, 'debit')}
                      disabled={addingCredit}
                      className="flex-1 px-3 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors disabled:opacity-50"
                    >
                      Add Debit
                    </button>
                  </div>
                </div>
              </div>

              {/* Credit History */}
              <div>
                <h3 className="text-lg font-medium text-gray-900 mb-4">Credit Transaction History</h3>
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Date</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Type</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Amount</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Description</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Reference</th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                      {creditTransactions.map((transaction) => (
                        <tr key={transaction.id}>
                          <td className="px-4 py-4 whitespace-nowrap text-sm text-gray-900">
                            {new Date(transaction.created_at).toLocaleDateString()}
                          </td>
                          <td className="px-4 py-4 whitespace-nowrap">
                            <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${transaction.transaction_type === 'credit'
                              ? 'bg-green-100 text-green-800'
                              : 'bg-red-100 text-red-800'
                              }`}>
                              {transaction.transaction_type === 'credit' ? 'Credit' : 'Debit'}
                            </span>
                          </td>
                          <td className="px-4 py-4 whitespace-nowrap text-sm text-gray-900">
                            ₹{transaction.amount.toLocaleString()}
                          </td>
                          <td className="px-4 py-4 text-sm text-gray-900">
                            {transaction.notes}
                          </td>
                          <td className="px-4 py-4 whitespace-nowrap text-sm text-gray-500">
                            {transaction.payment_method && transaction.reference_number && (
                              <span>{transaction.payment_method}: {transaction.reference_number}</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Loading State */}
      {loading && (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
          <span className="ml-2 text-gray-600">Loading locations...</span>
        </div>
      )}

      {/* Locations List */}
      {!loading && (
        <div className="bg-white rounded-lg shadow overflow-hidden">
          {filteredLocations.length === 0 ? (
            <div className="p-8 text-center">
              <Building className="mx-auto h-12 w-12 text-gray-400 mb-4" />
              <h3 className="text-lg font-medium text-gray-900 mb-2">No locations found</h3>
              <p className="text-gray-500 mb-4">
                {searchTerm ? 'No locations match your search criteria.' : 'Get started by adding your first location.'}
              </p>
              {!searchTerm && (
                <button
                  onClick={handleCreateNew}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                >
                  Add First Location
                </button>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Location Information
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Contact Details
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Financial Details
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Status & Type
                    </th>
                    <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {filteredLocations.map((location) => (
                    <tr key={location.id} className="hover:bg-gray-50">
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex items-center">
                          <div className="flex-shrink-0 h-10 w-10 bg-blue-100 rounded-full flex items-center justify-center">
                            <Building className="h-5 w-5 text-blue-600" />
                          </div>
                          <div className="ml-4">
                            <div className="text-sm font-medium text-gray-900">{location.name}</div>
                            {location.code && (
                              <div className="text-sm text-gray-500">Code: {location.code}</div>
                            )}
                            {location.address && (
                              <div className="text-sm text-gray-500 max-w-xs truncate">
                                <MapPin className="inline h-3 w-3 mr-1" />
                                {location.address}
                              </div>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm text-gray-900">
                          {location.contact_person && (
                            <div className="flex items-center gap-1 mb-1">
                              <User className="h-3 w-3 text-gray-400" />
                              {location.contact_person}
                            </div>
                          )}
                          {location.phone && (
                            <div className="flex items-center gap-1 mb-1">
                              <Phone className="h-3 w-3 text-gray-400" />
                              {location.phone}
                            </div>
                          )}
                          {location.email && (
                            <div className="flex items-center gap-1">
                              <Mail className="h-3 w-3 text-gray-400" />
                              {location.email}
                            </div>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm text-gray-900">
                          <div className="flex items-center gap-1 mb-1">
                            <CreditCard className="h-3 w-3 text-gray-400" />
                            Credit Limit: ₹{location.credit_limit?.toLocaleString() || '0'}
                          </div>
                          <div className="flex items-center gap-1 mb-1">
                            <DollarSign className="h-3 w-3 text-gray-400" />
                            Balance: ₹{location.current_credit_balance?.toLocaleString() || '0'}
                          </div>
                          {location.collection_percentage && location.collection_percentage > 0 && (
                            <div className="flex items-center gap-1">
                              <TrendingUp className="h-3 w-3 text-gray-400" />
                              Collection: {location.collection_percentage}%
                            </div>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex flex-col gap-1">
                          <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${location.is_active
                            ? 'bg-green-100 text-green-800'
                            : 'bg-red-100 text-red-800'
                            }`}>
                            {location.is_active ? 'Active' : 'Inactive'}
                          </span>
                          {location.is_cash_collection_center && (
                            <span className="inline-flex px-2 py-1 text-xs font-semibold rounded-full bg-blue-100 text-blue-800">
                              Cash Collection
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                        <div className="flex items-center gap-2 justify-end">
                          <button
                            onClick={() => setSelectedLocationForPricing(location)}
                            className="text-purple-600 hover:text-purple-900 p-1 rounded"
                            title="Manage Prices"
                          >
                            <IndianRupee className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => handleViewCredit(location.id)}
                            className="text-green-600 hover:text-green-900 p-1 rounded"
                            title="Manage Credit"
                          >
                            <CreditCard className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => handleEdit(location)}
                            className="text-blue-600 hover:text-blue-900 p-1 rounded"
                            title="Edit Location"
                          >
                            <Edit className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => handleDelete(location)}
                            className="text-red-600 hover:text-red-900 p-1 rounded"
                            title="Delete Location"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Results Summary */}
      {!loading && searchTerm && (
        <div className="mt-4 text-sm text-gray-600">
          Found {filteredLocations.length} location{filteredLocations.length !== 1 ? 's' : ''} matching "{searchTerm}"
        </div>
      )}
      </>
      )}
    </div>
  );
};

export default LocationMaster;
