import React, { useState, useEffect } from 'react';
import { X, User, Phone, Mail, MapPin, Calendar, Upload, FileText, Brain, Zap, Plus, Minus, TestTube, CheckCircle, AlertTriangle, RotateCcw, UserCheck } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { supabase, uploadFile, generateFilePath, database } from '../../utils/supabase';
import { useAuth } from '../../contexts/AuthContext';

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
  color_code?: string;
  color_name?: string;
  medical_history?: string;
  registration_date: string;
  last_visit: string;
  total_tests: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

interface TestGroup {
  id: string;
  name: string;
  code: string;
  category: string;
  price: number;
  is_active: boolean;
}

interface Package {
  id: string;
  name: string;
  description: string;
  category: string;
  price: number;
  is_active: boolean;
}
interface PatientFormProps {
  onClose: () => void;
  onSubmit: (data: any) => void;
  patient?: Patient;
}

const PatientForm: React.FC<PatientFormProps> = ({ 
  onClose, 
  onSubmit, 
  patient
}) => {
  const { user } = useAuth();
  
  // Parse patient name if editing
  const nameParts = patient?.name.split(' ') || ['', ''];
  const firstName = nameParts[0] || '';
  const lastName = nameParts.slice(1).join(' ') || '';

  const [formData, setFormData] = useState({
    firstName: firstName,
    lastName: lastName,
    age: patient?.age.toString() || '',
    gender: patient?.gender || '',
    phone: patient?.phone || '',
    email: patient?.email || '',
    address: patient?.address || '',
    city: patient?.city || '',
    state: patient?.state || '',
    pincode: patient?.pincode || '',
    emergencyContact: patient?.emergency_contact || '',
    emergencyPhone: patient?.emergency_phone || '',
    bloodGroup: patient?.blood_group || '',
    allergies: patient?.allergies || '',
    medicalHistory: patient?.medical_history || '',
    referring_doctor: '',
  });
  
  const [requestedTests, setRequestedTests] = useState<string[]>([]);
  const [newTestName, setNewTestName] = useState('');
  
  // Test data states
  const [testGroups, setTestGroups] = useState<TestGroup[]>([]);
  const [packages, setPackages] = useState<Package[]>([]);
  const [loadingTestData, setLoadingTestData] = useState(true);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [filteredSuggestions, setFilteredSuggestions] = useState<string[]>([]);
  
  // Doctors state for referring doctor dropdown
  const [doctors, setDoctors] = useState<any[]>([]);
  const [loadingDoctors, setLoadingDoctors] = useState(true);
  const [selectedDoctorId, setSelectedDoctorId] = useState<string>('');
  
  // Internal file upload and OCR states
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [attachmentId, setAttachmentId] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isOCRProcessing, setIsOCRProcessing] = useState(false);
  const [ocrResults, setOcrResults] = useState<any>(null);
  const [ocrError, setOcrError] = useState<string | null>(null);
  
  // Calculate total amount for requested tests
  const calculateTotalAmount = React.useMemo(() => {
    if (requestedTests.length === 0 || loadingTestData) return 0;
    
    return requestedTests.reduce((total, testName) => {
      // First try to find in test groups
      const testGroup = testGroups.find(tg => tg.name === testName);
      if (testGroup) {
        return total + testGroup.price;
      }
      
      // Then try to find in packages
      const packageItem = packages.find(pkg => pkg.name === testName);
      if (packageItem) {
        return total + packageItem.price;
      }
      
      // Default price for manually entered tests not found in database
      return total + 500;
    }, 0);
  }, [requestedTests, testGroups, packages, loadingTestData]);
  
  // Calculate tax (18% GST)
  const TAX_RATE = 0.18;
  const subtotal = calculateTotalAmount;
  const taxAmount = subtotal * TAX_RATE;
  const totalAmount = subtotal + taxAmount;
  
  // Auto-fill form when OCR results are available
  React.useEffect(() => {
    if (ocrResults && ocrResults.patient_details) {
      const details = ocrResults.patient_details;
      setFormData(prev => ({
        ...prev,
        firstName: details.first_name || prev.firstName,
        lastName: details.last_name || prev.lastName,
        age: details.age?.toString() || prev.age,
        gender: details.gender || prev.gender,
        phone: details.phone || prev.phone,
        email: details.email || prev.email,
        address: details.address || prev.address,
        city: details.city || prev.city,
        state: details.state || prev.state,
        pincode: details.pincode || prev.pincode,
        bloodGroup: details.blood_group || prev.bloodGroup,
        allergies: details.allergies || prev.allergies,
        medicalHistory: details.medical_history || prev.medicalHistory,
      }));
      
      // Set referring doctor from OCR
      if (ocrResults.doctor_info && ocrResults.doctor_info.name) {
        const ocrDoctorName = ocrResults.doctor_info.name;
        
        // Try to find matching doctor from the loaded doctors list
        const matchingDoctor = doctors.find((doctor: any) => 
          doctor.name.toLowerCase().includes(ocrDoctorName.toLowerCase()) ||
          ocrDoctorName.toLowerCase().includes(doctor.name.toLowerCase())
        );
        
        if (matchingDoctor) {
          // Select the matching doctor
          setSelectedDoctorId(matchingDoctor.id);
          setFormData(prev => ({
            ...prev,
            referring_doctor: matchingDoctor.name
          }));
        } else {
          // If no match found, still set the name for manual review
          setFormData(prev => ({
            ...prev,
            referring_doctor: ocrDoctorName
          }));
        }
      }
      
      // Set requested tests from OCR
      if (ocrResults.requested_tests && ocrResults.requested_tests.length > 0) {
        setRequestedTests(ocrResults.requested_tests);
      }
    }
  }, [ocrResults]);

  // Fetch test groups and packages on component mount
  React.useEffect(() => {
    const fetchTestData = async () => {
      setLoadingTestData(true);
      try {
        // Fetch test groups
        const { data: testGroupsData, error: testGroupsError } = await supabase
          .from('test_groups')
          .select('id, name, code, category, price, is_active')
          .eq('is_active', true)
          .order('name');
        
        if (testGroupsError) {
          console.error('Error fetching test groups:', testGroupsError);
        } else {
          setTestGroups(testGroupsData || []);
        }
        
        // Fetch packages
        const { data: packagesData, error: packagesError } = await supabase
          .from('packages')
          .select('id, name, description, category, price, is_active')
          .eq('is_active', true)
          .order('name');
        
        if (packagesError) {
          console.error('Error fetching packages:', packagesError);
        } else {
          setPackages(packagesData || []);
        }
      } catch (error) {
        console.error('Error fetching test data:', error);
      } finally {
        setLoadingTestData(false);
      }
    };
    
    fetchTestData();
  }, []);

  // Fetch referring doctors on component mount
  React.useEffect(() => {
    const fetchDoctors = async () => {
      setLoadingDoctors(true);
      try {
        // Use the database.doctors API if available, otherwise fallback to direct supabase call
        let doctorsData: any[] = [];
        let error: any = null;
        
        if ((database as any).doctors) {
          const result = await (database as any).doctors.getAll();
          doctorsData = result.data || [];
          error = result.error;
        } else {
          // Fallback to direct supabase call
          const lab_id = await database.getCurrentUserLabId();
          if (lab_id) {
            const result = await supabase
              .from('doctors')
              .select('*')
              .eq('lab_id', lab_id)
              .eq('is_active', true)
              .order('name');
            doctorsData = result.data || [];
            error = result.error;
          }
        }
        
        if (error) {
          console.error('Error fetching doctors:', error);
        } else {
          // Filter only referring doctors for the dropdown
          const referringDoctors = (doctorsData || []).filter((doctor: any) => doctor.is_referring_doctor);
          setDoctors(referringDoctors);
        }
      } catch (error) {
        console.error('Error fetching doctors:', error);
      } finally {
        setLoadingDoctors(false);
      }
    };

    fetchDoctors();
  }, []);

  // Update suggestions when newTestName changes
  React.useEffect(() => {
    if (newTestName.trim().length > 0) {
      const allTestNames = [
        ...testGroups.map(tg => tg.name),
        ...packages.map(pkg => pkg.name)
      ];
      
      const filtered = allTestNames
        .filter(name => 
          name.toLowerCase().includes(newTestName.toLowerCase()) &&
          !requestedTests.includes(name)
        )
        .slice(0, 5); // Limit to 5 suggestions
      
      setFilteredSuggestions(filtered);
      setShowSuggestions(filtered.length > 0);
    } else {
      setShowSuggestions(false);
      setFilteredSuggestions([]);
    }
  }, [newTestName, testGroups, packages, requestedTests]);
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit({
      ...formData,
      requestedTests,
      ocrResults,
      attachmentId,
      selectedDoctorId, // Include the selected doctor ID
    });
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    setFormData(prev => ({
      ...prev,
      [e.target.name]: e.target.value
    }));
  };
  
  // Internal file upload handler
  const handleFileUpload = async (file: File) => {
    setIsUploading(true);
    setOcrError(null);
    
    try {
      // Get current user's lab_id
      const currentLabId = await database.getCurrentUserLabId();
      
      // Generate file path for patient forms
      const filePath = generateFilePath(file.name, 'temp-registration', undefined, 'patient-forms');
      
      // Upload to Supabase Storage
      const uploadResult = await uploadFile(file, filePath);
      
      // Insert attachment record
      const { data: attachment, error } = await supabase
        .from('attachments')
        .insert([{
          patient_id: 'temp-registration', // Will be updated after patient creation
          lab_id: currentLabId,
          related_table: 'patients',
          related_id: 'temp-registration',
          file_url: uploadResult.publicUrl,
          file_path: uploadResult.path,
          original_filename: file.name,
          stored_filename: filePath.split('/').pop(),
          file_type: file.type,
          file_size: file.size,
          description: 'Test request form for patient registration',
          uploaded_by: user?.id || null,
          upload_timestamp: new Date().toISOString()
        }])
        .select()
        .single();
      
      if (error) {
        throw new Error(`Failed to save attachment metadata: ${error.message}`);
      }
      
      setAttachmentId(attachment.id);
      setUploadedFile(file);
      
      console.log('File uploaded successfully:', {
        attachmentId: attachment.id,
        filePath: uploadResult.path,
        publicUrl: uploadResult.publicUrl
      });
      
    } catch (error) {
      console.error('Error uploading file:', error);
      setOcrError('Failed to upload file. Please try again.');
    } finally {
      setIsUploading(false);
    }
  };
  
  const handleFileInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      handleFileUpload(file);
    }
  };
  
  const handleRunOCR = async () => {
    if (!attachmentId) {
      setOcrError('Please upload a file first.');
      return;
    }
    
    console.log('Starting OCR process with attachment ID:', attachmentId);
    setIsOCRProcessing(true);
    setOcrError(null);
    
    try {
      // Step 1: Call vision-ocr Edge Function
      console.log('Calling vision-ocr Edge Function...');
      const visionResponse = await supabase.functions.invoke('vision-ocr', {
        body: {
          attachmentId,
          documentType: 'test-request-form',
          analysisType: 'text'
        }
      });
      
      if (visionResponse.error) {
        throw new Error(`Vision OCR failed: ${visionResponse.error.message}`);
      }
      
      const visionData = visionResponse.data;
      console.log('Vision OCR completed. Extracted text length:', visionData.fullText?.length || 0);
      
      // Step 2: Call gemini-nlp Edge Function
      console.log('Calling gemini-nlp Edge Function...');
      const geminiResponse = await supabase.functions.invoke('gemini-nlp', {
        body: {
          rawText: visionData.fullText,
          visionResults: visionData,
          originalBase64Image: visionData.originalBase64Image,
          documentType: 'test-request-form'
        }
      });
      
      if (geminiResponse.error) {
        throw new Error(`Gemini NLP failed: ${geminiResponse.error.message}`);
      }
      
      const result = geminiResponse.data;
      console.log('Gemini NLP completed successfully. Result:', result);
      
      // Log the metadata for debugging
      if (result.metadata) {
        console.log('OCR Metadata:', {
          method: result.metadata.ocrMethod,
          confidence: result.metadata.ocrConfidence,
          textLength: result.metadata.extractedTextLength,
          rawTextPreview: result.metadata.rawOcrText
        });
      }
      
      setOcrResults(result);
      
    } catch (error) {
      console.error('Error running OCR - Full details:', error);
      setOcrError('Failed to process document. Please try again.');
    } finally {
      setIsOCRProcessing(false);
    }
  };
  
  const handleClearOCR = () => {
    setUploadedFile(null);
    setAttachmentId(null);
    setOcrResults(null);
    setOcrError(null);
  };
  
  const handleAddTest = () => {
    if (newTestName.trim() && !requestedTests.includes(newTestName.trim())) {
      setRequestedTests(prev => [...prev, newTestName.trim()]);
      setNewTestName('');
      setShowSuggestions(false);
    }
  };
  
  const handleSelectSuggestion = (suggestion: string) => {
    setNewTestName(suggestion);
    setRequestedTests(prev => [...prev, suggestion]);
    setNewTestName('');
    setShowSuggestions(false);
  };
  
  const handleRemoveTest = (index: number) => {
    setRequestedTests(prev => prev.filter((_, i) => i !== index));
  };
  
  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddTest();
    } else if (e.key === 'Escape') {
      setShowSuggestions(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-gray-600 bg-opacity-75 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <h2 className="text-xl font-semibold text-gray-900">
            {patient ? 'Edit Patient' : 'Register New Patient'}
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-500 p-1 rounded"
          >
            <X className="h-6 w-6" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-6">
          {/* OCR Document Upload Section - Only show for new patients */}
          {!patient && (
            <div className="space-y-4">
              <h3 className="text-lg font-medium text-gray-900 flex items-center">
                <Brain className="h-5 w-5 mr-2 text-purple-600" />
                AI-Powered Form Filling
              </h3>
              
              <div className="bg-purple-50 border border-purple-200 rounded-lg p-4">
                <p className="text-sm text-purple-800 mb-4">
                  Upload a test request form or prescription to automatically extract patient details and requested tests using AI.
                </p>
                
                {/* File Upload */}
                <div className="space-y-4">
                  <div className="border-2 border-dashed border-purple-300 rounded-lg p-4 text-center hover:border-purple-400 transition-colors">
                    {uploadedFile ? (
                      <div className="space-y-3">
                        <div className="flex items-center justify-center">
                          <div className="bg-purple-100 p-3 rounded-full">
                            <FileText className="h-8 w-8 text-purple-600" />
                          </div>
                        </div>
                        <div>
                          <div className="text-sm font-medium text-gray-900">{uploadedFile.name}</div>
                          <div className="text-xs text-gray-500">{(uploadedFile.size / 1024 / 1024).toFixed(2)} MB</div>
                        </div>
                        <div className="flex items-center justify-center space-x-2">
                          <button
                            type="button"
                            onClick={() => document.getElementById('file-upload')?.click()}
                            className="text-purple-600 hover:text-purple-700 text-sm font-medium bg-purple-100 px-3 py-1 rounded"
                          >
                            Change File
                          </button>
                          <button
                            type="button"
                            onClick={handleClearOCR}
                            className="text-gray-600 hover:text-gray-700 text-sm font-medium bg-gray-100 px-3 py-1 rounded"
                          >
                            <RotateCcw className="h-3 w-3 mr-1 inline" />
                            Clear
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        <div className="flex justify-center">
                          <div className="bg-purple-100 p-3 rounded-full">
                            <Upload className="h-8 w-8 text-purple-600" />
                          </div>
                        </div>
                        <div>
                          <button
                            type="button"
                            onClick={() => document.getElementById('file-upload')?.click()}
                            disabled={isUploading}
                            className="flex items-center justify-center mx-auto px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:bg-purple-400 disabled:cursor-not-allowed transition-colors"
                          >
                            {isUploading ? (
                              <>
                                <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent mr-2"></div>
                                Uploading...
                              </>
                            ) : (
                              <>
                                <Upload className="h-4 w-4 mr-2" />
                                Upload Test Request Form
                              </>
                            )}
                          </button>
                          <p className="text-xs text-gray-500 mt-2">
                            Supports JPG, PNG, PDF (max 10MB)
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                  
                  <input
                    id="file-upload"
                    type="file"
                    accept="image/*,.pdf"
                    onChange={handleFileInputChange}
                    className="hidden"
                  />
                  
                  {/* OCR Processing */}
                  {uploadedFile && attachmentId && (
                    <div className="space-y-3">
                      <button
                        type="button"
                        onClick={handleRunOCR}
                        disabled={isOCRProcessing}
                        className="w-full flex items-center justify-center px-4 py-3 bg-gradient-to-r from-purple-600 to-blue-600 text-white rounded-lg hover:from-purple-700 hover:to-blue-700 disabled:from-gray-400 disabled:to-gray-400 disabled:cursor-not-allowed transition-all"
                      >
                        {isOCRProcessing ? (
                          <>
                            <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent mr-2"></div>
                            Processing with AI...
                          </>
                        ) : (
                          <>
                            <Zap className="h-4 w-4 mr-2" />
                            <Brain className="h-4 w-4 mr-2" />
                            Extract Data with AI
                          </>
                        )}
                      </button>
                      
                      {isOCRProcessing && (
                        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                          <div className="text-sm text-blue-800 space-y-1">
                            <div>• Google Vision AI: Extracting text from document...</div>
                            <div>• Gemini NLP: Identifying patient details and tests...</div>
                            <div>• Database matching: Linking to available test groups...</div>
                            <div>• Auto-filling form fields...</div>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                  
                  {/* OCR Error */}
                  {ocrError && (
                    <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                      <div className="flex items-center">
                        <AlertTriangle className="h-4 w-4 text-red-500 mr-2" />
                        <span className="text-red-700 text-sm">{ocrError}</span>
                      </div>
                    </div>
                  )}
                  
                  {/* OCR Success */}
                  {ocrResults && (
                    <div className="bg-green-50 border border-green-200 rounded-lg p-3">
                      <div className="flex items-center mb-2">
                        <CheckCircle className="h-4 w-4 text-green-500 mr-2" />
                        <span className="text-green-700 text-sm font-medium">AI extraction completed!</span>
                      </div>
                      <div className="text-xs text-green-600 space-y-1">
                        {ocrResults.patient_details && Object.keys(ocrResults.patient_details).length > 0 && (
                          <div>✓ Patient details extracted and auto-filled</div>
                        )}
                        {ocrResults.requested_tests && ocrResults.requested_tests.length > 0 && (
                          <div>✓ {ocrResults.requested_tests.length} tests identified</div>
                        )}
                        {ocrResults.doctor_info && ocrResults.doctor_info.name && (
                          <div>✓ Referring doctor identified</div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Personal Information */}
          <div className="space-y-4">
            <h3 className="text-lg font-medium text-gray-900 flex items-center">
              <User className="h-5 w-5 mr-2" />
              Personal Information
            </h3>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  First Name *
                </label>
                <input
                  type="text"
                  name="firstName"
                  required
                  value={formData.firstName}
                  onChange={handleChange}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Last Name *
                </label>
                <input
                  type="text"
                  name="lastName"
                  required
                  value={formData.lastName}
                  onChange={handleChange}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Age *
                </label>
                <input
                  type="number"
                  name="age"
                  required
                  value={formData.age}
                  onChange={handleChange}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Gender *
                </label>
                <select
                  name="gender"
                  required
                  value={formData.gender}
                  onChange={handleChange}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                >
                  <option value="">Select Gender</option>
                  <option value="Male">Male</option>
                  <option value="Female">Female</option>
                  <option value="Other">Other</option>
                </select>
              </div>
            </div>
          </div>

          {/* Contact Information */}
          <div className="space-y-4">
            <h3 className="text-lg font-medium text-gray-900 flex items-center">
              <Phone className="h-5 w-5 mr-2" />
              Contact Information
            </h3>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Phone Number *
                </label>
                <input
                  type="tel"
                  name="phone"
                  required
                  value={formData.phone}
                  onChange={handleChange}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Email
                </label>
                <input
                  type="email"
                  name="email"
                  value={formData.email}
                  onChange={handleChange}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
            </div>
          </div>

          {/* Address Information */}
          <div className="space-y-4">
            <h3 className="text-lg font-medium text-gray-900 flex items-center">
              <MapPin className="h-5 w-5 mr-2" />
              Address Information
            </h3>
            
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Address
                </label>
                <textarea
                  name="address"
                  rows={2}
                  value={formData.address}
                  onChange={handleChange}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    City
                  </label>
                  <input
                    type="text"
                    name="city"
                    value={formData.city}
                    onChange={handleChange}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    State
                  </label>
                  <input
                    type="text"
                    name="state"
                    value={formData.state}
                    onChange={handleChange}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    PIN Code
                  </label>
                  <input
                    type="text"
                    name="pincode"
                    value={formData.pincode}
                    onChange={handleChange}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Emergency Contact */}
          <div className="space-y-4">
            <h3 className="text-lg font-medium text-gray-900">Emergency Contact</h3>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Emergency Contact Name
                </label>
                <input
                  type="text"
                  name="emergencyContact"
                  value={formData.emergencyContact}
                  onChange={handleChange}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Emergency Contact Phone
                </label>
                <input
                  type="tel"
                  name="emergencyPhone"
                  value={formData.emergencyPhone}
                  onChange={handleChange}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
            </div>
          </div>

          {/* Medical Information */}
          <div className="space-y-4">
            <h3 className="text-lg font-medium text-gray-900">Medical Information</h3>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Blood Group
                </label>
                <select
                  name="bloodGroup"
                  value={formData.bloodGroup}
                  onChange={handleChange}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                >
                  <option value="">Select Blood Group</option>
                  <option value="A+">A+</option>
                  <option value="A-">A-</option>
                  <option value="B+">B+</option>
                  <option value="B-">B-</option>
                  <option value="AB+">AB+</option>
                  <option value="AB-">AB-</option>
                  <option value="O+">O+</option>
                  <option value="O-">O-</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Known Allergies
                </label>
                <input
                  type="text"
                  name="allergies"
                  value={formData.allergies}
                  onChange={handleChange}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder="e.g., Penicillin, Shellfish"
                />
              </div>
            </div>
            
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Medical History
              </label>
              <textarea
                name="medicalHistory"
                rows={3}
                value={formData.medicalHistory}
                onChange={handleChange}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="Brief medical history, current medications, etc."
              />
            </div>
          </div>

          {/* Referring Doctor - Only show for new patients */}
          {!patient && (
            <div className="space-y-4">
              <h3 className="text-lg font-medium text-gray-900 flex items-center">
                <UserCheck className="h-5 w-5 mr-2" />
                Referring Doctor
              </h3>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Select Doctor *
                </label>
                {loadingDoctors ? (
                  <div className="w-full px-3 py-2 border border-gray-300 rounded-md bg-gray-50 text-gray-500">
                    Loading doctors...
                  </div>
                ) : (
                  <select
                    value={selectedDoctorId}
                    onChange={(e) => {
                      setSelectedDoctorId(e.target.value);
                      const selectedDoctor = doctors.find(doc => doc.id === e.target.value);
                      setFormData(prev => ({
                        ...prev,
                        referring_doctor: selectedDoctor ? selectedDoctor.name : ''
                      }));
                    }}
                    required
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  >
                    <option value="">Select a referring doctor...</option>
                    {doctors.map((doctor) => (
                      <option key={doctor.id} value={doctor.id}>
                        {doctor.name}
                        {doctor.specialization && ` - ${doctor.specialization}`}
                        {doctor.hospital && ` (${doctor.hospital})`}
                      </option>
                    ))}
                  </select>
                )}
                
                {/* Option to add new doctor */}
                <div className="mt-2">
                  <a
                    href="/masters/doctors"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-blue-600 hover:text-blue-800 flex items-center gap-1"
                  >
                    <UserCheck className="h-3 w-3" />
                    Add new doctor to master list
                  </a>
                </div>
              </div>
            </div>
          )}

          {/* Requested Tests - Only show for new patients */}
          {!patient && (
            <div className="space-y-4">
              <h3 className="text-lg font-medium text-gray-900 flex items-center">
                <TestTube className="h-5 w-5 mr-2" />
                Requested Tests
              </h3>
              
              <div className="space-y-4">
                {/* Add Test Input */}
                <div className="relative">
                  <div className="flex space-x-2">
                    <div className="flex-1 relative">
                      <input
                        type="text"
                        value={newTestName}
                        onChange={(e) => setNewTestName(e.target.value)}
                        onKeyPress={handleKeyPress}
                        onFocus={() => {
                          if (filteredSuggestions.length > 0) {
                            setShowSuggestions(true);
                          }
                        }}
                        onBlur={() => {
                          // Delay hiding suggestions to allow clicking
                          setTimeout(() => setShowSuggestions(false), 200);
                        }}
                        placeholder="Enter test name or select from suggestions..."
                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      />
                      
                      {/* Suggestions Dropdown */}
                      {showSuggestions && filteredSuggestions.length > 0 && (
                        <div className="absolute z-10 w-full mt-1 bg-white border border-gray-300 rounded-md shadow-lg max-h-60 overflow-y-auto">
                          {filteredSuggestions.map((suggestion, index) => {
                            const isTestGroup = testGroups.some(tg => tg.name === suggestion);
                            const isPackage = packages.some(pkg => pkg.name === suggestion);
                            const item = isTestGroup 
                              ? testGroups.find(tg => tg.name === suggestion)
                              : packages.find(pkg => pkg.name === suggestion);
                            
                            return (
                              <div
                                key={index}
                                onClick={() => handleSelectSuggestion(suggestion)}
                                className="px-4 py-3 hover:bg-blue-50 cursor-pointer border-b border-gray-100 last:border-b-0"
                              >
                                <div className="flex items-center justify-between">
                                  <div className="flex-1">
                                    <div className="text-sm font-medium text-gray-900">{suggestion}</div>
                                    <div className="text-xs text-gray-500">
                                      {isTestGroup ? `Test Group • ${item?.category}` : `Package • ${item?.category}`}
                                    </div>
                                  </div>
                                  <div className="text-sm font-bold text-green-600">
                                    ₹{item?.price || 0}
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={handleAddTest}
                      disabled={!newTestName.trim()}
                      className="flex items-center px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
                    >
                      <Plus className="h-4 w-4 mr-1" />
                      Add
                    </button>
                  </div>
                  
                  {/* Loading indicator */}
                  {loadingTestData && (
                    <div className="text-xs text-gray-500 mt-1">
                      Loading available tests...
                    </div>
                  )}
                  
                  {/* Available tests summary */}
                  {!loadingTestData && (testGroups.length > 0 || packages.length > 0) && (
                    <div className="text-xs text-gray-500 mt-1">
                      {testGroups.length} test groups and {packages.length} packages available
                    </div>
                  )}
                </div>
                
                {/* Tests List */}
                {requestedTests.length > 0 && (
                  <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                    <h4 className="font-medium text-blue-900 mb-3">
                      Requested Tests ({requestedTests.length})
                    </h4>
                    <div className="space-y-2">
                      {requestedTests.map((test, index) => (
                        <div key={index} className="flex items-center justify-between bg-white rounded-lg p-3 border border-blue-200">
                          <div className="flex-1">
                            <span className="text-sm font-medium text-gray-900">{test}</span>
                            <div className="text-xs text-gray-500">
                              {(() => {
                                const testGroup = testGroups.find(tg => tg.name === test);
                                const packageItem = packages.find(pkg => pkg.name === test);
                                if (testGroup) return `Test Group • ${testGroup.category}`;
                                if (packageItem) return `Package • ${packageItem.category}`;
                                return 'Manual Entry';
                              })()}
                            </div>
                          </div>
                          <div className="flex items-center space-x-3">
                            <span className="text-sm font-bold text-green-600">
                              ₹{(() => {
                                const testGroup = testGroups.find(tg => tg.name === test);
                                const packageItem = packages.find(pkg => pkg.name === test);
                                if (testGroup) return testGroup.price;
                                if (packageItem) return packageItem.price;
                                return 500; // Default price for manual entries
                              })()}
                            </span>
                          <button
                            type="button"
                            onClick={() => handleRemoveTest(index)}
                            className="text-red-600 hover:text-red-800 p-1 rounded"
                            title="Remove test"
                          >
                            <Minus className="h-4 w-4" />
                          </button>
                          </div>
                        </div>
                      ))}
                    </div>
                    
                    {/* Pricing Summary */}
                    <div className="mt-4 pt-3 border-t border-blue-300">
                      <div className="space-y-2 text-sm">
                        <div className="flex justify-between">
                          <span className="text-blue-700">Subtotal:</span>
                          <span className="font-medium text-blue-900">₹{subtotal.toFixed(2)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-blue-700">Tax (18% GST):</span>
                          <span className="font-medium text-blue-900">₹{taxAmount.toFixed(2)}</span>
                        </div>
                        <div className="flex justify-between font-bold text-lg border-t border-blue-300 pt-2">
                          <span className="text-blue-900">Total Amount:</span>
                          <span className="text-green-600">₹{totalAmount.toFixed(2)}</span>
                        </div>
                      </div>
                    </div>
                    
                    <div className="mt-3 p-2 bg-green-100 border border-green-200 rounded text-xs text-green-800">
                      <strong>Note:</strong> An order and unpaid invoice will be automatically created for these tests after patient registration.
                    </div>
                  </div>
                )}
                
                {requestedTests.length === 0 && (
                  <div className="text-sm text-gray-500 italic">
                    No tests added yet. You can add tests manually or use AI extraction from uploaded documents.
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Form Actions */}
          <div className="flex items-center justify-end space-x-4 pt-6 border-t border-gray-200">
            {patient?.qr_code_data && patient?.color_code && (
              <div className="flex-1 flex items-center space-x-2">
                <div className="flex items-center">
                  <div 
                    className="w-4 h-4 rounded-full mr-1" 
                    style={{ backgroundColor: patient.color_code }}
                  ></div>
                  <span className="text-sm text-gray-600">{patient.color_name}</span>
                </div>
                <div className="h-8 w-8">
                  <QRCodeSVG 
                    value={patient.qr_code_data} 
                    size={32}
                  />
                </div>
              </div>
            )}
            <button
              type="button"
              onClick={() => {
                onClose();
                handleClearOCR(); // Clear OCR data when closing form
              }}
              className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-6 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
              title={patient ? "Update patient information" : "Register new patient and assign identification"}
            >
              {patient ? 'Update Patient' : (
                requestedTests.length > 0 
                  ? `Register Patient & Create Invoice (₹${totalAmount.toFixed(2)})` 
                  : 'Register Patient'
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default PatientForm;