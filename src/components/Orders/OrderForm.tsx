import React, { useState, useEffect } from 'react';
import { X, User, TestTube, Calendar, Plus } from 'lucide-react';
import { database } from '../../utils/supabase';
import SearchableSelect from '../ui/SearchableSelect';
import TestMultiSelect from '../ui/TestMultiSelect';
import { FormField, Input, Select, Textarea } from '../ui/FormComponents';

interface OrderFormProps {
  onClose: () => void;
  onSubmit: (data: any) => void;
  preSelectedPatient?: any;
}

const OrderForm: React.FC<OrderFormProps> = ({ onClose, onSubmit, preSelectedPatient }) => {
  const [formData, setFormData] = useState({
    patientId: preSelectedPatient?.id || '',
    selectedTests: [] as string[],
    priority: 'Normal',
    doctor: '',
    notes: '',
    expectedDate: '',
  });

  const [patients, setPatients] = useState<any[]>([]);
  const [loadingPatients, setLoadingPatients] = useState(true);
  const [testGroups, setTestGroups] = useState<any[]>([]);
  const [loadingTests, setLoadingTests] = useState(true);
  const [selectedPatient, setSelectedPatient] = useState<any>(preSelectedPatient || null);
  const [showNewPatientModal, setShowNewPatientModal] = useState(false);
  const [creatingPatient, setCreatingPatient] = useState(false);
  const [newPatient, setNewPatient] = useState({
    name: '',
    age: '',
    gender: 'Male',
    phone: '',
    email: ''
  });

  useEffect(() => {
    const fetchPatients = async () => {
      setLoadingPatients(true);
      try {
        const { data, error } = await database.patients.getAll();
        if (error) {
          console.error('Error loading patients:', error);
          setPatients([]);
        } else {
          setPatients(data || []);
        }
      } catch (err) {
        console.error('Error:', err);
        setPatients([]);
      } finally {
        setLoadingPatients(false);
      }
    };

    const fetchTestGroups = async () => {
      setLoadingTests(true);
      try {
        const { data, error } = await database.testGroups.getAll();
        if (error) {
          console.error('Error loading test groups:', error);
          setTestGroups([]);
        } else {
          setTestGroups(data || []);
        }
      } catch (err) {
        console.error('Error loading test groups:', err);
        setTestGroups([]);
      } finally {
        setLoadingTests(false);
      }
    };

    fetchPatients();
    fetchTestGroups();
  }, []);

  const priorities = ['Normal', 'Urgent', 'STAT'];

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    // Explicit validation to prevent null patient_id
    if (!formData.patientId || formData.patientId.trim() === '') {
      alert('Please select a patient before creating the order.');
      return;
    }
    
    const selectedTestDetails = testGroups.filter(test => 
      formData.selectedTests.includes(test.id)
    );
    
    const totalAmount = selectedTestDetails.reduce((sum, test) => sum + test.price, 0);
    
    // Convert to snake_case for Supabase
    const orderData: any = {
      patient_name: selectedPatient?.name || '',
      patient_id: formData.patientId,
      status: 'Order Created', // Orders start as "Order Created" before sample collection
      priority: formData.priority,
      order_date: new Date().toISOString().split('T')[0],
      expected_date: formData.expectedDate,
      total_amount: totalAmount,
      doctor: formData.doctor,
    };
    
    // Only include tests if there are actually tests selected
    if (selectedTestDetails.length > 0) {
      orderData.tests = selectedTestDetails.map(test => ({
        name: test.name,
        id: test.id,
        type: test.type || 'test', // 'test' or 'package'
        price: test.price || 0
      }));
    }
    
    onSubmit(orderData);
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: value
    }));

    if (name === 'patientId') {
      const patient = patients.find(p => p.id === value);
      setSelectedPatient(patient);
    }
  };

  const selectedTestDetails = testGroups.filter(test => 
    formData.selectedTests.includes(test.id)
  );
  const totalAmount = selectedTestDetails.reduce((sum, test) => sum + test.price, 0);

  return (
    <div className="fixed inset-0 bg-gray-600 bg-opacity-75 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <h2 className="text-xl font-semibold text-gray-900">Create New Order</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-500 p-1 rounded"
          >
            <X className="h-6 w-6" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-6">
          {/* Patient Selection */}
          <div className="space-y-4">
            <h3 className="text-lg font-medium text-gray-900 flex items-center">
              <User className="h-5 w-5 mr-2" />
              Patient Information
            </h3>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <FormField 
                label="Select Patient" 
                required 
                icon={User}
              >
                <SearchableSelect
                  options={patients.map(patient => ({
                    id: patient.id,
                    label: patient.name,
                    description: `${patient.age}y, ${patient.gender} • ${patient.phone}`,
                    badge: patient.id.slice(-8)
                  }))}
                  value={formData.patientId}
                  onChange={(patientId) => {
                    setFormData(prev => ({ ...prev, patientId }));
                    const patient = patients.find(p => p.id === patientId);
                    setSelectedPatient(patient);
                  }}
                  placeholder="Search and select a patient"
                  searchPlaceholder="Search by name, phone, or ID..."
                  loading={loadingPatients}
                  allowClear
                />
                {!formData.patientId && (
                  <button
                    type="button"
                    onClick={() => setShowNewPatientModal(true)}
                    className="mt-2 inline-flex items-center text-sm text-blue-600 hover:text-blue-800"
                  >
                    <Plus className="h-4 w-4 mr-1" /> Add New Patient
                  </button>
                )}
              </FormField>
              
              {selectedPatient && (
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                  <div className="text-sm">
                    <div className="font-medium text-blue-900">{selectedPatient.name}</div>
                    <div className="text-blue-700">{selectedPatient.age}y, {selectedPatient.gender}</div>
                    <div className="text-blue-700">Phone: {selectedPatient.phone}</div>
                    {selectedPatient.email && (
                      <div className="text-blue-700">Email: {selectedPatient.email}</div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Test Selection */}
          <div className="space-y-4">
            <h3 className="text-lg font-medium text-gray-900 flex items-center">
              <TestTube className="h-5 w-5 mr-2" />
              Test Selection
            </h3>
            
            <FormField 
              label="Select Tests" 
              required 
              icon={TestTube}
              hint="Search and select multiple tests. You can filter by test name, category, or clinical purpose."
            >
              {loadingTests ? (
                <div className="p-4 text-center text-gray-500">
                  Loading tests...
                </div>
              ) : (
                <TestMultiSelect
                  options={testGroups.map(test => ({
                    id: test.id,
                    name: test.name,
                    price: test.price,
                    category: test.category,
                    clinicalPurpose: test.clinicalPurpose,
                    sampleType: test.sampleType,
                    turnaroundTime: test.turnaroundTime,
                    requiresFasting: test.requiresFasting
                  }))}
                  selectedIds={formData.selectedTests}
                  onChange={(selectedTests) => setFormData(prev => ({ ...prev, selectedTests }))}
                  placeholder="Search and select tests..."
                  searchPlaceholder="Search tests by name, category, or purpose..."
                />
              )}
            </FormField>

            {/* Selected Tests Summary */}
            {formData.selectedTests.length > 0 && (
              <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                <h4 className="font-medium text-green-900 mb-3 flex items-center">
                  <TestTube className="h-4 w-4 mr-2" />
                  Selected Tests Summary ({formData.selectedTests.length})
                </h4>
                <div className="space-y-2">
                  {selectedTestDetails.map((test) => (
                    <div key={test.id} className="flex justify-between items-center text-sm">
                      <div className="flex-1">
                        <span className="text-green-800 font-medium">{test.name}</span>
                        <span className="text-green-600 ml-2">({test.category})</span>
                      </div>
                      <span className="font-medium text-green-900">₹{test.price}</span>
                    </div>
                  ))}
                </div>
                <div className="border-t border-green-300 mt-3 pt-3 flex justify-between font-bold text-green-900">
                  <span>Total Amount:</span>
                  <span>₹{totalAmount}</span>
                </div>
              </div>
            )}
          </div>

          {/* Order Details */}
          <div className="space-y-4">
            <h3 className="text-lg font-medium text-gray-900 flex items-center">
              <Calendar className="h-5 w-5 mr-2" />
              Order Details
            </h3>
            
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <FormField 
                label="Priority" 
                required 
              >
                <Select
                  name="priority"
                  value={formData.priority}
                  onChange={handleChange}
                  options={priorities.map(priority => ({ value: priority, label: priority }))}
                />
              </FormField>
              
              <FormField 
                label="Expected Date" 
                required 
                hint="When should the results be ready?"
              >
                <Input
                  type="date"
                  name="expectedDate"
                  required
                  value={formData.expectedDate}
                  onChange={handleChange}
                  min={new Date().toISOString().split('T')[0]}
                />
              </FormField>
              
              <FormField 
                label="Referring Doctor" 
                required 
                hint="Doctor who ordered the tests"
              >
                <Input
                  type="text"
                  name="doctor"
                  required
                  value={formData.doctor}
                  onChange={handleChange}
                  placeholder="Dr. Name"
                />
              </FormField>
            </div>

            <FormField 
              label="Clinical Notes" 
              hint="Any special instructions or clinical notes"
            >
              <Textarea
                name="notes"
                rows={3}
                value={formData.notes}
                onChange={handleChange}
                placeholder="Any special instructions or clinical notes..."
              />
            </FormField>
          </div>

          {/* Form Actions */}
          <div className="flex items-center justify-end space-x-4 pt-6 border-t border-gray-200">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={formData.selectedTests.length === 0 || !formData.patientId}
              className="px-6 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
            >
              Create Order - ₹{totalAmount}
            </button>
          </div>
        </form>
      </div>
      {showNewPatientModal && (
        <div className="fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-lg">
            <div className="flex items-center justify-between p-4 border-b border-gray-200">
              <h3 className="text-lg font-semibold text-gray-900">Add New Patient</h3>
              <button
                onClick={() => setShowNewPatientModal(false)}
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (!newPatient.name || !newPatient.age || !newPatient.gender || !newPatient.phone) return;
                try {
                  setCreatingPatient(true);
                  const { data, error } = await database.patients.create({
                    name: newPatient.name.trim(),
                    age: parseInt(newPatient.age, 10),
                    gender: newPatient.gender,
                    phone: newPatient.phone.trim(),
                    email: newPatient.email?.trim() || null,
                    // Add required fields with default values
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
                    referring_doctor: null
                  });
                  if (error) {
                    alert('Failed to create patient');
                    console.error(error);
                  } else if (data) {
                    // refresh list locally
                    setPatients(prev => [...prev, data]);
                    setFormData(prev => ({ ...prev, patientId: data.id }));
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
                    onChange={e => setNewPatient(p => ({ ...p, name: e.target.value }))}
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
                    onChange={e => setNewPatient(p => ({ ...p, age: e.target.value }))}
                    className="w-full rounded-md border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Gender *</label>
                  <select
                    value={newPatient.gender}
                    onChange={e => setNewPatient(p => ({ ...p, gender: e.target.value }))}
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
                    onChange={e => setNewPatient(p => ({ ...p, phone: e.target.value }))}
                    className="w-full rounded-md border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
                  />
                </div>
                <div className="md:col-span-2">
                  <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                  <input
                    type="email"
                    value={newPatient.email}
                    onChange={e => setNewPatient(p => ({ ...p, email: e.target.value }))}
                    className="w-full rounded-md border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
                  />
                </div>
              </div>
              <div className="flex items-center justify-end space-x-3 pt-2">
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
                  disabled={creatingPatient || !newPatient.name || !newPatient.age || !newPatient.phone}
                  className="px-5 py-2 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
                >
                  {creatingPatient ? 'Saving...' : 'Save Patient'}
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