import React, { useState } from 'react';
import { Plus, Search, Filter, Edit, Eye, Phone, Mail, QrCode, Trash2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { generateQRCodeData } from '../utils/colorAssignment';
import PatientForm from '../components/Patients/PatientForm';
import PatientDetails from '../components/Patients/PatientDetails';
import PatientTestHistory from '../components/Patients/PatientTestHistory';
import { database, supabase, auth } from '../utils/supabase';

interface Patient {
  id: string;
  display_id?: string;
  name: string;
  age: number;
  gender: string;
  phone: string;
  email?: string;
  address: string;
  city: string;
  state: string;
  pincode: string;
  emergency_contact?: string;
  emergency_phone?: string;
  blood_group?: string;
  allergies?: string;
  qr_code_data?: string;
  medical_history?: string;
  registration_date: string;
  last_visit: string;
  total_tests: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  test_count?: number;
}

const Patients: React.FC = () => {
  const navigate = useNavigate();
  const [patients, setPatients] = useState<Patient[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [showEditForm, setShowEditForm] = useState(false);
  const [selectedPatient, setSelectedPatient] = useState<Patient | null>(null);
  const [showTestHistory, setShowTestHistory] = useState(false);
  const [isGeneratingCodes, setIsGeneratingCodes] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  
  // Load patients from Supabase on component mount
  React.useEffect(() => {
    loadPatients();
    checkAdminStatus();
  }, []);

  const checkAdminStatus = async () => {
    try {
      const { user } = await auth.getCurrentUser();
      if (user?.user_metadata?.role === 'Admin') {
        setIsAdmin(true);
      }
    } catch (err) {
      console.error('Error checking admin status:', err);
    }
  };

  const loadPatients = async () => {
    try {
      setLoading(true);
      // Get active patients with their test counts
      const { data, error } = await database.patients.getAllWithTestCounts();
      
      if (error) {
        setError(error.message);
        console.error('Error loading patients:', error);
      } else {
        setPatients(data || []);
      }
    } catch (err) {
      setError('Failed to load patients');
      console.error('Error:', err);
    } finally {
      setLoading(false);
    }
  };

  const filteredPatients = patients.filter(patient =>
    patient.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    patient.id.toLowerCase().includes(searchTerm.toLowerCase()) ||
    patient.phone.includes(searchTerm)
  );

  const handleAddPatient = async (formData: any) => {
    try {
      const { ocrResults, attachmentId, requestedTests, selectedDoctorId, ...patientDetails } = formData;
      
      const patientData = {
        name: `${patientDetails.firstName} ${patientDetails.lastName}`.trim(),
        age: parseInt(patientDetails.age),
        gender: patientDetails.gender,
        phone: patientDetails.phone,
        email: patientDetails.email || null,
        address: patientDetails.address,
        city: patientDetails.city,
        state: patientDetails.state,
        pincode: patientDetails.pincode,
        emergency_contact: patientDetails.emergencyContact || null,
        emergency_phone: patientDetails.emergencyPhone || null,
        blood_group: patientDetails.bloodGroup || null,
        allergies: patientDetails.allergies || null,
        medical_history: patientDetails.medicalHistory || null,
        total_tests: 0,
        is_active: true,
        requestedTests: requestedTests || [],
        referring_doctor: patientDetails.referring_doctor || null, // Use the doctor name for now
        referring_doctor_id: selectedDoctorId || null, // Add the doctor ID
      };

      const { data, error } = await database.patients.create(patientData);
      
      
      if (error) {
        setError(error.message);
        console.error('Error adding patient:', error);
      } else {
        // Update attachment record with actual patient ID if one was uploaded
        if (attachmentId && data) {
          try {
            await supabase
              .from('attachments')
              .update({
                patient_id: data.id,
                related_id: data.id
              })
              .eq('id', attachmentId);
          } catch (attachmentError) {
            console.error('Error updating attachment with patient ID:', attachmentError);
          }
        }
        
        setPatients(prev => [data, ...prev]);
        setShowForm(false);
        
        // Show success message if order was created
        if (data.order_created) {
          if (data.invoice_created) {
            alert(`Patient registered successfully!\n\nOrder created: ${data.matched_tests} of ${data.total_tests} tests matched\nInvoice generated: ₹${data.total_amount.toFixed(2)} (unpaid)\nInvoice ID: ${data.invoice_id}`);
          } else {
            alert(`Patient registered successfully!\n\nOrder created: ${data.matched_tests} of ${data.total_tests} tests matched\n${data.invoice_error ? `Invoice creation failed: ${data.invoice_error}` : 'Invoice creation skipped'}`);
          }
        } else if (data.order_error) {
          alert(`Patient registered successfully!\n\nNote: Order creation failed - ${data.order_error}`);
        }
      }
    } catch (err) {
      setError('Failed to add patient');
      console.error('Error:', err);
    }
  };

  const handleUpdatePatient = async (formData: any) => {
    if (!selectedPatient) return;

    try {
      const patientData = {
        name: `${formData.firstName} ${formData.lastName}`.trim(),
        age: parseInt(formData.age),
        gender: formData.gender,
        phone: formData.phone,
        email: formData.email || null,
        address: formData.address,
        city: formData.city,
        state: formData.state,
        pincode: formData.pincode,
        emergency_contact: formData.emergencyContact || null,
        emergency_phone: formData.emergencyPhone || null,
        blood_group: formData.bloodGroup || null,
        allergies: formData.allergies || null,
        medical_history: formData.medicalHistory || null,
      };

      const { data, error } = await supabase
        .from('patients')
        .update(patientData)
        .eq('id', selectedPatient.id)
        .select()
        .single();
      
      if (error) {
        setError(error.message);
        console.error('Error updating patient:', error);
      } else {
        setPatients(prev => prev.map(p => p.id === selectedPatient.id ? data : p));
        setShowEditForm(false);
        setSelectedPatient(null);
      }
    } catch (err) {
      setError('Failed to update patient');
      console.error('Error:', err);
    }
  };

  const handleGenerateQrAndColor = async (patientId: string) => {
    try {
      setIsGeneratingCodes(true);

      // Get the patient's current details
      const { data: patient, error: patientError } = await database.patients.getById(patientId);
      
      if (patientError || !patient) {
        console.error('Error fetching patient:', patientError);
        setError('Failed to fetch patient details');
        return;
      }
      
      // Generate QR code data
      const qrCodeData = generateQRCodeData({
        id: patient.id,
        name: patient.name,
        age: patient.age,
        gender: patient.gender
      });
      
      // Update the patient with QR code information
      const { data: updatedPatient, error: updateError } = await supabase
        .from('patients')
        .update({
          qr_code_data: qrCodeData
        })
        .eq('id', patientId)
        .select()
        .single();
      
      if (updateError) {
        console.error('Error updating patient with QR data:', updateError);
        setError('Failed to update patient with QR code');
        return;
      }
      
      if (!updatedPatient) {
        console.warn('Warning: Patient update returned no data, but no explicit error was reported.');
        setError('Failed to update patient with QR code - no data returned');
        return;
      }
      
      // Update the patient in the local state
      setPatients(prev => prev.map(p => p.id === patientId ? updatedPatient : p));
      
      // If the selected patient is the one being updated, update it too
      if (selectedPatient && selectedPatient.id === patientId) {
        setSelectedPatient(updatedPatient);
      }

      console.log('Successfully generated QR code for patient:', updatedPatient);
    } catch (err) {
      console.error('Error generating QR code:', err);
      setError('An unexpected error occurred while generating QR code');
    } finally {
      setIsGeneratingCodes(false);
    }
  };

  const handleDeletePatient = async (patientId: string) => {
    try {
      // First check if patient has any orders
      const { data: orders, error: ordersError } = await supabase
        .from('orders')
        .select('id')
        .eq('patient_id', patientId);
      
      if (ordersError) {
        throw new Error(ordersError.message);
      }
      
      if (orders && orders.length > 0) {
        setError(`Cannot mask patient with ID ${patientId} because they have ${orders.length} active orders. Please complete or cancel these orders first.`);
        return;
      }
      
      // Soft delete by setting is_active to false
      const { error } = await database.patients.delete(patientId);
      
      
      if (error) {
        setError('Error masking patient: ' + error.message);
        console.error('Error masking patient:', error);
      } else {
        setPatients(prev => prev.filter(p => p.id !== patientId));
        console.log(`Patient ${patientId} has been masked (soft deleted)`);
      }
    } catch (err) {
      setError('Failed to mask patient');
      console.error('Error during patient masking:', err);
    }
  };

  const handleEditPatient = (patient: any) => {
    setSelectedPatient(patient);
    setShowEditForm(true);
  };

  const handleCreateOrder = (patient: Patient) => {
    // Navigate to orders page with patient pre-selected
    navigate('/orders', { state: { selectedPatient: patient } });
  };

  const handleViewAllTests = (patient: any) => {
    setSelectedPatient(patient);
    setShowTestHistory(true);
  };
  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-4 border-blue-600 border-t-transparent"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <div className="text-red-700">{error}</div>
          <button 
            onClick={() => setError(null)}
            className="text-red-600 hover:text-red-800 text-sm mt-2"
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold text-gray-900">Patient Management</h1>
        <button
          onClick={() => setShowForm(true)}
          className="flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
        >
          <Plus className="h-5 w-5 mr-2" />
          Register Patient
        </button>
      </div>

      {/* Search and Filter Bar */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
        <div className="flex flex-col sm:flex-row gap-4">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input
              type="text"
              placeholder="Search by name, patient ID, or phone..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-10 pr-4 py-2 w-full border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
          <button className="flex items-center px-4 py-2 border border-gray-300 rounded-md hover:bg-gray-50 transition-colors">
            <Filter className="h-4 w-4 mr-2" />
            Filter
          </button>
        </div>
      </div>

      {/* Patients Table */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900">
            Registered Patients ({filteredPatients.length})
          </h3>
        </div>
        
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Patient Details
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Contact
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Registration
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Tests
                </th>
                {isAdmin && (
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Admin
                  </th>
                )}
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {filteredPatients.map((patient) => (
                <tr key={patient.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div>
                      <div className="text-sm font-medium text-gray-900">{patient.name}</div>
                      <div className="text-sm text-gray-500">
                        {patient.display_id ? `Sample ID: ${patient.display_id} • ` : ''}ID: {patient.id} • {patient.age}y • {patient.gender}
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="space-y-1">
                      <div className="flex items-center text-sm text-gray-600">
                        <Phone className="h-3 w-3 mr-1" />
                        {patient.phone}
                      </div>
                      <div className="flex items-center text-sm text-gray-600">
                        <Mail className="h-3 w-3 mr-1" />
                        {patient.email || 'No email'}
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-sm">
                      <div className="text-gray-900">{new Date(patient.registration_date).toLocaleDateString()}</div>
                      <div className="text-gray-500">Last: {new Date(patient.last_visit).toLocaleDateString()}</div>
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                      {patient.test_count || 0} tests
                    </span>
                  </td>
                  {isAdmin && (
                    <td className="px-6 py-4 whitespace-nowrap">
                      {confirmDelete === patient.id ? (
                        <div className="flex items-center space-x-2">
                          <button
                            onClick={() => handleDeletePatient(patient.id)}
                            className="text-red-600 hover:text-red-900 p-1 rounded bg-red-50"
                            title="Confirm Delete"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                          <button
                            onClick={() => setConfirmDelete(null)}
                            className="text-gray-600 hover:text-gray-900 p-1 rounded bg-gray-50"
                            title="Cancel"
                          >
                            ×
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setConfirmDelete(patient.id)}
                          className="text-red-600 hover:text-red-900 p-1 rounded"
                          title="Delete Patient"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </td>
                  )}
                  <td className="px-6 py-4 whitespace-nowrap text-sm font-medium space-x-2">
                    <button
                      onClick={() => setSelectedPatient(patient)}
                      className="text-blue-600 hover:text-blue-900 p-1 rounded" 
                      title="View Patient Details"
                    >
                      <Eye className="h-4 w-4" />
                    </button>
                    <button 
                      onClick={() => handleEditPatient(patient)}
                      className="text-gray-600 hover:text-gray-900 p-1 rounded"
                      title="Edit Patient"
                    >
                      <Edit className="h-4 w-4" />
                    </button>
                    {patient.qr_code_data && (
                      <button
                        onClick={() => setSelectedPatient(patient)}
                        className="text-red-600 hover:text-red-900 p-1 rounded" 
                        title="Mask Patient"
                      >
                        <QrCode className="h-4 w-4" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Patient Registration Form Modal */}
      {showForm && (
        <PatientForm
          onClose={() => setShowForm(false)}
          onSubmit={handleAddPatient}
        />
      )}

      {/* Patient Details Modal */}
      {selectedPatient && !showEditForm && !showTestHistory && (
        <PatientDetails
          patient={selectedPatient}
          isGeneratingCodes={isGeneratingCodes}
          onGenerateQrAndColor={handleGenerateQrAndColor}
          onClose={() => setSelectedPatient(null)}
          onEditPatient={handleEditPatient}
          onCreateOrder={handleCreateOrder}
          onViewAllTests={handleViewAllTests}
        />
      )}

      {/* Patient Edit Form Modal */}
      {showEditForm && selectedPatient && (
        <PatientForm
          onClose={() => setShowEditForm(false)}
          onSubmit={handleUpdatePatient}
          patient={selectedPatient}
        />
      )}

      {/* Patient Test History Modal */}
      {showTestHistory && selectedPatient && (
        <PatientTestHistory
          patient={selectedPatient}
          onClose={() => {            
            setShowTestHistory(false);
            setSelectedPatient(null);
          }}
        />
      )}
    </div>
  );
};

export default Patients;