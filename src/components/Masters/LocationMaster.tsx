import React, { useState, useEffect } from 'react';
import { Plus, Search, Edit, Trash2, Save, X, MapPin, Building, Phone, Mail, CreditCard, DollarSign, TrendingUp, Calendar, User } from 'lucide-react';
import { database } from '../../utils/supabase';
import { Location, CreditTransaction } from '../../types';

interface LocationFormData {
  name: string;
  code: string;
  address: string;
  phone: string;
  email: string;
  contact_person: string;
  credit_limit: number;
  collection_percentage: number;
  is_cash_collection_center: boolean;
  notes: string;
}

const initialFormData: LocationFormData = {
  name: '',
  code: '',
  address: '',
  phone: '',
  email: '',
  contact_person: '',
  credit_limit: 0,
  collection_percentage: 0,
  is_cash_collection_center: false,
  notes: ''
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

  // Load locations on component mount
  useEffect(() => {
    loadLocations();
  }, []);

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
      address: location.address || '',
      phone: location.phone || '',
      email: location.email || '',
      contact_person: location.contact_person || '',
      credit_limit: location.credit_limit || 0,
      collection_percentage: location.collection_percentage || 0,
      is_cash_collection_center: location.is_cash_collection_center || false,
      notes: location.notes || ''
    });
    setShowForm(true);
    setError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      if (editingLocation) {
        // Update existing location
        const { data, error } = await database.locations.update(editingLocation.id, formData);
        if (error) throw error;
        
        // Update local state
        setLocations(prev => prev.map(l => l.id === editingLocation.id ? { ...l, ...data } : l));
      } else {
        // Create new location
        const { data, error } = await database.locations.create(formData);
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
      const { data, error } = await database.creditTransactions.create({
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
                            {new Date(transaction.transaction_date).toLocaleDateString()}
                          </td>
                          <td className="px-4 py-4 whitespace-nowrap">
                            <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                              transaction.type === 'credit' 
                                ? 'bg-green-100 text-green-800' 
                                : 'bg-red-100 text-red-800'
                            }`}>
                              {transaction.type === 'credit' ? 'Credit' : 'Debit'}
                            </span>
                          </td>
                          <td className="px-4 py-4 whitespace-nowrap text-sm text-gray-900">
                            ₹{transaction.amount.toLocaleString()}
                          </td>
                          <td className="px-4 py-4 text-sm text-gray-900">
                            {transaction.description}
                          </td>
                          <td className="px-4 py-4 whitespace-nowrap text-sm text-gray-500">
                            {transaction.reference_type && transaction.reference_id && (
                              <span>{transaction.reference_type}: {transaction.reference_id}</span>
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
                          <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                            location.is_active 
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
    </div>
  );
};

export default LocationMaster;