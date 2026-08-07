import React, { useState, useEffect } from 'react';
import { X, User, Phone, Mail, MapPin, Calendar, Upload, FileText, Brain, Zap, Plus, Minus, TestTube, CheckCircle, AlertTriangle, RotateCcw, UserCheck, Heart, Droplets, ClipboardList } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { supabase, uploadFile, generateFilePath, database, LabPatientFieldConfig, DEFAULT_PATIENT_FORM_SETTINGS, type LabPatientFormSettings } from '../../utils/supabase';
import { notificationTriggerService, formatName } from '../../utils/notificationTriggerService';
import { useAuth } from '../../contexts/AuthContext';

interface Patient {
  id: string;
  display_id?: string;
  name: string;
  age: number;
  age_unit?: 'years' | 'months' | 'days';
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
    age: patient?.age?.toString() || '',
    age_unit: (patient?.age_unit as 'years' | 'months' | 'days') || 'years',
    dob: (patient as any)?.dob || (patient as any)?.date_of_birth || '',
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

  // Custom patient fields
  const [customFieldConfigs, setCustomFieldConfigs] = useState<LabPatientFieldConfig[]>([]);
  const [customFieldValues, setCustomFieldValues] = useState<Record<string, any>>({});

  // Patient form settings
  const [formSettings, setFormSettings] = useState<LabPatientFormSettings>(DEFAULT_PATIENT_FORM_SETTINGS);

  // Lab-wide name case format (Settings → Notifications → Name Display Format)
  const [nameCaseFormat, setNameCaseFormat] = useState<'proper' | 'upper'>('proper');
  const nameInputStyle = nameCaseFormat === 'upper' ? { textTransform: 'uppercase' as const } : undefined;

  // Active section for navigation
  const [activeSection, setActiveSection] = useState<'personal' | 'contact' | 'medical' | 'tests'>('personal');

  // Calculate total amount for requested tests
  const calculateTotalAmount = React.useMemo(() => {
    if (requestedTests.length === 0 || loadingTestData) return 0;

    return requestedTests.reduce((total, testName) => {
      const testGroup = testGroups.find(tg => tg.name === testName);
      if (testGroup) return total + testGroup.price;
      const packageItem = packages.find(pkg => pkg.name === testName);
      if (packageItem) return total + packageItem.price;
      return total + 500;
    }, 0);
  }, [requestedTests, testGroups, packages, loadingTestData]);

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

      if (ocrResults.doctor_info && ocrResults.doctor_info.name) {
        const ocrDoctorName = ocrResults.doctor_info.name;
        const matchingDoctor = doctors.find((doctor: any) =>
          doctor.name.toLowerCase().includes(ocrDoctorName.toLowerCase()) ||
          ocrDoctorName.toLowerCase().includes(doctor.name.toLowerCase())
        );

        if (matchingDoctor) {
          setSelectedDoctorId(matchingDoctor.id);
          setFormData(prev => ({ ...prev, referring_doctor: matchingDoctor.name }));
        } else {
          setFormData(prev => ({ ...prev, referring_doctor: ocrDoctorName }));
        }
      }

      if (ocrResults.requested_tests && ocrResults.requested_tests.length > 0) {
        setRequestedTests(ocrResults.requested_tests);
      }
    }
  }, [ocrResults, doctors]);

  // Fetch test groups and packages
  React.useEffect(() => {
    const fetchTestData = async () => {
      setLoadingTestData(true);
      try {
        const lab_id = await database.getCurrentUserLabId();
        if (!lab_id) {
          setLoadingTestData(false);
          return;
        }

        const { data: testGroupsData } = await supabase
          .from('test_groups')
          .select('id, name, code, category, price, is_active')
          .eq('is_active', true)
          .or(`lab_id.eq.${lab_id},lab_id.is.null`)
          .order('name');

        if (testGroupsData) setTestGroups(testGroupsData);

        const { data: packagesData } = await supabase
          .from('packages')
          .select('id, name, description, category, price, is_active')
          .eq('is_active', true)
          .order('name');

        if (packagesData) setPackages(packagesData);
      } catch (error) {
        console.error('Error fetching test data:', error);
      } finally {
        setLoadingTestData(false);
      }
    };
    fetchTestData();
  }, []);

  // Load custom patient field configs and form settings
  React.useEffect(() => {
    database.patientFormSettings.get().then(({ data }) => {
      if (data) setFormSettings(s => ({ ...s, ...data }));
    }).catch(() => {});
  }, []);

  // Load lab name case format (drives live uppercase in the name inputs + save formatting)
  React.useEffect(() => {
    database.getCurrentUserLabId().then(async labId => {
      if (!labId) return;
      const s = await notificationTriggerService.getSettings(labId);
      if (s?.name_case_format) setNameCaseFormat(s.name_case_format);
    }).catch(() => {});
  }, []);

  React.useEffect(() => {
    const loadCustomFieldConfigs = async () => {
      const { data } = await database.labPatientFieldConfigs.getAll();
      if (data) {
        setCustomFieldConfigs(data);
        if (patient) {
          // custom_fields may be missing if patient came from a view (v_patients_with_duplicates)
          // that was created before the column was added — fetch directly in that case
          let rawCustomFields = (patient as any).custom_fields;
          if (rawCustomFields === undefined) {
            const { data: fullPatient } = await database.patients.getById(patient.id);
            rawCustomFields = fullPatient?.custom_fields;
          }
          if (rawCustomFields) {
            const parsed = typeof rawCustomFields === 'string'
              ? (() => { try { return JSON.parse(rawCustomFields); } catch { return {}; } })()
              : rawCustomFields;
            setCustomFieldValues(parsed || {});
          }
        }
      }
    };
    loadCustomFieldConfigs();
  }, []);

  // Fetch referring doctors
  React.useEffect(() => {
    const fetchDoctors = async () => {
      setLoadingDoctors(true);
      try {
        const lab_id = await database.getCurrentUserLabId();
        if (lab_id) {
          const result = await supabase
            .from('doctors')
            .select('*')
            .eq('lab_id', lab_id)
            .eq('is_active', true)
            .order('name');
          const referringDoctors = (result.data || []).filter((doctor: any) => doctor.is_referring_doctor);
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

  // Update suggestions
  React.useEffect(() => {
    if (newTestName.trim().length > 0) {
      const allTestNames = [...testGroups.map(tg => tg.name), ...packages.map(pkg => pkg.name)];
      const filtered = allTestNames
        .filter(name => name.toLowerCase().includes(newTestName.toLowerCase()) && !requestedTests.includes(name))
        .slice(0, 5);
      setFilteredSuggestions(filtered);
      setShowSuggestions(filtered.length > 0);
    } else {
      setShowSuggestions(false);
      setFilteredSuggestions([]);
    }
  }, [newTestName, testGroups, packages, requestedTests]);

  const calcAgeFromDob = (dob: string): { age: string; age_unit: 'years' | 'months' | 'days' } => {
    const birth = new Date(dob);
    const today = new Date();
    const diffDays = Math.floor((today.getTime() - birth.getTime()) / 86400000);
    if (diffDays < 30) return { age: String(diffDays), age_unit: 'days' };
    if (diffDays < 365) return { age: String(Math.floor(diffDays / 30.44)), age_unit: 'months' };
    return { age: String(Math.floor(diffDays / 365.25)), age_unit: 'years' };
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit({
      ...formData,
      firstName: formatName(formData.firstName, nameCaseFormat),
      lastName: formatName(formData.lastName, nameCaseFormat),
      requestedTests,
      ocrResults,
      attachmentId,
      selectedDoctorId,
      custom_fields: customFieldValues,
    });
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    setFormData(prev => ({ ...prev, [e.target.name]: e.target.value }));
  };

  const handleFileUpload = async (file: File) => {
    setIsUploading(true);
    setOcrError(null);

    try {
      const currentLabId = await database.getCurrentUserLabId();
      const filePath = generateFilePath(file.name, 'temp-registration', undefined, 'patient-forms');
      const uploadResult = await uploadFile(file, filePath);

      const { data: attachment, error } = await supabase
        .from('attachments')
        .insert([{
          patient_id: 'temp-registration',
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

      if (error) throw new Error(`Failed to save attachment: ${error.message}`);

      setAttachmentId(attachment.id);
      setUploadedFile(file);
    } catch (error) {
      console.error('Error uploading file:', error);
      setOcrError('Failed to upload file. Please try again.');
    } finally {
      setIsUploading(false);
    }
  };

  const handleFileInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) handleFileUpload(file);
  };

  const handleRunOCR = async () => {
    if (!attachmentId) {
      setOcrError('Please upload a file first.');
      return;
    }

    setIsOCRProcessing(true);
    setOcrError(null);

    try {
      const visionResponse = await supabase.functions.invoke('vision-ocr', {
        body: { attachmentId, documentType: 'test-request-form', analysisType: 'text' }
      });

      if (visionResponse.error) throw new Error(`Vision OCR failed: ${visionResponse.error.message}`);

      const visionData = visionResponse.data;

      const geminiResponse = await supabase.functions.invoke('gemini-nlp', {
        body: {
          rawText: visionData.fullText,
          visionResults: visionData,
          originalBase64Image: visionData.originalBase64Image,
          documentType: 'test-request-form'
        }
      });

      if (geminiResponse.error) throw new Error(`Gemini NLP failed: ${geminiResponse.error.message}`);

      setOcrResults(geminiResponse.data);
    } catch (error) {
      console.error('Error running OCR:', error);
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
    setRequestedTests(prev => [...prev, suggestion]);
    setNewTestName('');
    setShowSuggestions(false);
  };

  const handleRemoveTest = (index: number) => {
    setRequestedTests(prev => prev.filter((_, i) => i !== index));
  };

  // Section navigation items
  const sections = [
    { id: 'personal', label: 'Personal', icon: User },
    { id: 'contact', label: 'Contact', icon: Phone },
    { id: 'medical', label: 'Medical', icon: Heart },
    ...(!patient ? [{ id: 'tests', label: 'Tests', icon: TestTube }] : []),
  ];

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="bg-gradient-to-r from-blue-600 to-indigo-600 px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="bg-white/20 p-2 rounded-lg">
                <User className="h-6 w-6 text-white" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-white">
                  {patient ? 'Edit Patient' : 'Register New Patient'}
                </h2>
                <p className="text-blue-100 text-sm">
                  {patient ? 'Update patient information' : 'Fill in the details to register a new patient'}
                </p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="text-white/80 hover:text-white hover:bg-white/20 p-2 rounded-lg transition-all"
            >
              <X className="h-6 w-6" />
            </button>
          </div>

          {/* Section Navigation */}
          <div className="flex gap-2 mt-4">
            {sections.map((section) => (
              <button
                key={section.id}
                onClick={() => setActiveSection(section.id as any)}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                  activeSection === section.id
                    ? 'bg-white text-blue-600 shadow-lg'
                    : 'bg-white/20 text-white hover:bg-white/30'
                }`}
              >
                <section.icon className="h-4 w-4" />
                {section.label}
              </button>
            ))}
          </div>
        </div>

        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto">
          {/* AI OCR Section - Only for new patients */}
          {!patient && activeSection === 'personal' && (
            <div className="p-6 bg-gradient-to-br from-purple-50 to-indigo-50 border-b border-purple-100">
              <div className="flex items-center gap-2 mb-4">
                <div className="bg-purple-100 p-2 rounded-lg">
                  <Brain className="h-5 w-5 text-purple-600" />
                </div>
                <div>
                  <h3 className="font-semibold text-gray-900">AI-Powered Form Filling</h3>
                  <p className="text-sm text-gray-600">Upload a prescription or test request form to auto-fill</p>
                </div>
              </div>

              <div className="flex gap-4 items-start">
                <div className="flex-1">
                  {uploadedFile ? (
                    <div className="flex items-center gap-3 bg-white rounded-xl p-4 border border-purple-200">
                      <div className="bg-purple-100 p-3 rounded-lg">
                        <FileText className="h-6 w-6 text-purple-600" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-gray-900 truncate">{uploadedFile.name}</p>
                        <p className="text-sm text-gray-500">{(uploadedFile.size / 1024 / 1024).toFixed(2)} MB</p>
                      </div>
                      <button
                        type="button"
                        onClick={handleClearOCR}
                        className="text-gray-400 hover:text-red-500 p-2"
                      >
                        <RotateCcw className="h-5 w-5" />
                      </button>
                    </div>
                  ) : (
                    <label className="flex flex-col items-center justify-center w-full h-32 border-2 border-dashed border-purple-300 rounded-xl cursor-pointer bg-white hover:bg-purple-50 hover:border-purple-400 transition-all">
                      <Upload className="h-8 w-8 text-purple-400 mb-2" />
                      <span className="text-sm font-medium text-purple-600">
                        {isUploading ? 'Uploading...' : 'Click to upload'}
                      </span>
                      <span className="text-xs text-gray-500 mt-1">JPG, PNG or PDF (max 10MB)</span>
                      <input
                        type="file"
                        accept="image/*,.pdf"
                        onChange={handleFileInputChange}
                        className="hidden"
                        disabled={isUploading}
                      />
                    </label>
                  )}
                </div>

                {uploadedFile && attachmentId && (
                  <button
                    type="button"
                    onClick={handleRunOCR}
                    disabled={isOCRProcessing}
                    className="flex items-center gap-2 px-6 py-3 bg-gradient-to-r from-purple-600 to-indigo-600 text-white rounded-xl font-medium hover:from-purple-700 hover:to-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-lg shadow-purple-200"
                  >
                    {isOCRProcessing ? (
                      <>
                        <div className="animate-spin rounded-full h-5 w-5 border-2 border-white border-t-transparent" />
                        Processing...
                      </>
                    ) : (
                      <>
                        <Zap className="h-5 w-5" />
                        Extract Data
                      </>
                    )}
                  </button>
                )}
              </div>

              {ocrError && (
                <div className="mt-3 flex items-center gap-2 text-red-600 bg-red-50 px-4 py-2 rounded-lg">
                  <AlertTriangle className="h-4 w-4" />
                  <span className="text-sm">{ocrError}</span>
                </div>
              )}

              {ocrResults && (
                <div className="mt-3 flex items-center gap-2 text-green-600 bg-green-50 px-4 py-2 rounded-lg">
                  <CheckCircle className="h-4 w-4" />
                  <span className="text-sm font-medium">Data extracted successfully! Form has been auto-filled.</span>
                </div>
              )}
            </div>
          )}

          <div className="p-6 space-y-6">
            {/* Personal Information Section */}
            {activeSection === 'personal' && (
              <div className="space-y-6">
                {/* Name row: salutation (optional) + first + last */}
                <div className="space-y-3">
                  {formSettings.show_salutation && (
                    <div className="space-y-2">
                      <label className="text-sm font-medium text-gray-700">Salutation</label>
                      <select
                        name="salutation"
                        value={(formData as any).salutation || ''}
                        onChange={handleChange}
                        className="w-36 px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all bg-gray-50 hover:bg-white"
                      >
                        <option value="">Select…</option>
                        {formSettings.salutation_options.map(s => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </div>
                  )}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                    <div className="space-y-2">
                      <label className="text-sm font-medium text-gray-700">First Name *</label>
                      <input
                        type="text"
                        name="firstName"
                        required
                        value={formData.firstName}
                        onChange={handleChange}
                        style={nameInputStyle}
                        className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all bg-gray-50 hover:bg-white"
                        placeholder="Enter first name"
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium text-gray-700">Last Name *</label>
                      <input
                        type="text"
                        name="lastName"
                        required
                        value={formData.lastName}
                        onChange={handleChange}
                        style={nameInputStyle}
                        className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all bg-gray-50 hover:bg-white"
                        placeholder="Enter last name"
                      />
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                  {/* DOB field */}
                  {(formSettings.age_mode === 'dob' || formSettings.age_mode === 'both') && (
                    <div className="space-y-2">
                      <label className="text-sm font-medium text-gray-700 flex items-center gap-2">
                        <Calendar className="h-4 w-4 text-gray-500" />
                        Date of Birth{formSettings.age_mode === 'dob' ? ' *' : ''}
                      </label>
                      <input
                        type="date"
                        name="dob"
                        required={formSettings.age_mode === 'dob'}
                        max={new Date().toISOString().split('T')[0]}
                        value={formData.dob}
                        onChange={(e) => {
                          const dob = e.target.value;
                          if (dob) {
                            const calc = calcAgeFromDob(dob);
                            setFormData(prev => ({ ...prev, dob, age: calc.age, age_unit: calc.age_unit }));
                          } else {
                            setFormData(prev => ({ ...prev, dob: '' }));
                          }
                        }}
                        className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all bg-gray-50 hover:bg-white"
                      />
                    </div>
                  )}

                  {/* Age field */}
                  {(formSettings.age_mode === 'age' || formSettings.age_mode === 'both') && (
                    <div className="space-y-2">
                      <label className="text-sm font-medium text-gray-700">
                        Age *{formData.dob && formSettings.age_mode === 'both' && <span className="ml-1 text-xs text-blue-500 font-normal">(auto-calculated)</span>}
                      </label>
                      <div className="flex gap-2">
                        <input
                          type="number"
                          name="age"
                          required
                          min={0}
                          value={formData.age}
                          onChange={handleChange}
                          className="flex-1 px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all bg-gray-50 hover:bg-white"
                          placeholder="Age"
                        />
                        <select
                          name="age_unit"
                          value={formData.age_unit}
                          onChange={handleChange}
                          className="w-28 px-3 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all bg-gray-50 hover:bg-white font-medium"
                        >
                          <option value="years">Years</option>
                          <option value="months">Months</option>
                          <option value="days">Days</option>
                        </select>
                      </div>
                      <p className="text-xs text-gray-500">For infants, use days or months for accurate reference ranges</p>
                    </div>
                  )}

                  {/* Gender */}
                  {formSettings.show_gender && (
                    <div className="space-y-2">
                      <label className="text-sm font-medium text-gray-700">Gender *</label>
                      <div className={`grid gap-2`} style={{ gridTemplateColumns: `repeat(${formSettings.gender_options.length}, 1fr)` }}>
                        {formSettings.gender_options.map((g) => (
                          <button
                            key={g}
                            type="button"
                            onClick={() => setFormData(prev => ({ ...prev, gender: g }))}
                            className={`px-4 py-3 rounded-xl border-2 font-medium transition-all ${
                              formData.gender === g
                                ? 'border-blue-500 bg-blue-50 text-blue-700'
                                : 'border-gray-200 bg-gray-50 text-gray-600 hover:border-gray-300 hover:bg-white'
                            }`}
                          >
                            {g}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* Referring Doctor - Only for new patients */}
                {!patient && formSettings.show_referring_doctor && (
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-gray-700 flex items-center gap-2">
                      <UserCheck className="h-4 w-4 text-gray-500" />
                      Referring Doctor
                    </label>
                    <select
                      value={selectedDoctorId}
                      onChange={(e) => {
                        setSelectedDoctorId(e.target.value);
                        const selectedDoctor = doctors.find(doc => doc.id === e.target.value);
                        setFormData(prev => ({ ...prev, referring_doctor: selectedDoctor ? selectedDoctor.name : '' }));
                      }}
                      className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all bg-gray-50 hover:bg-white"
                    >
                      <option value="">Select a referring doctor...</option>
                      {doctors.map((doctor) => (
                        <option key={doctor.id} value={doctor.id}>
                          {doctor.name}{doctor.specialization && ` - ${doctor.specialization}`}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            )}

            {/* Contact Information Section */}
            {activeSection === 'contact' && (
              <div className="space-y-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-gray-700 flex items-center gap-2">
                      <Phone className="h-4 w-4 text-gray-500" />
                      Phone Number{formSettings.phone_required ? ' *' : ''}
                    </label>
                    <input
                      type="tel"
                      name="phone"
                      required={formSettings.phone_required}
                      value={formData.phone}
                      onChange={handleChange}
                      className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all bg-gray-50 hover:bg-white"
                      placeholder="Enter phone number"
                    />
                  </div>
                  {formSettings.show_email && (
                    <div className="space-y-2">
                      <label className="text-sm font-medium text-gray-700 flex items-center gap-2">
                        <Mail className="h-4 w-4 text-gray-500" />
                        Email{formSettings.email_required ? ' *' : ''}
                      </label>
                      <input
                        type="email"
                        name="email"
                        required={formSettings.email_required}
                        value={formData.email}
                        onChange={handleChange}
                        className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all bg-gray-50 hover:bg-white"
                        placeholder="Enter email address"
                      />
                    </div>
                  )}
                </div>

                {formSettings.show_address && (
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-gray-700 flex items-center gap-2">
                      <MapPin className="h-4 w-4 text-gray-500" />
                      Address
                    </label>
                    <textarea
                      name="address"
                      rows={2}
                      value={formData.address}
                      onChange={handleChange}
                      className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all bg-gray-50 hover:bg-white resize-none"
                      placeholder="Enter street address"
                    />
                  </div>
                )}

                {(formSettings.show_city || formSettings.show_state || formSettings.show_pincode) && (
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
                    {formSettings.show_city && (
                      <div className="space-y-2">
                        <label className="text-sm font-medium text-gray-700">City</label>
                        <input
                          type="text"
                          name="city"
                          value={formData.city}
                          onChange={handleChange}
                          className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all bg-gray-50 hover:bg-white"
                          placeholder="City"
                        />
                      </div>
                    )}
                    {formSettings.show_state && (
                      <div className="space-y-2">
                        <label className="text-sm font-medium text-gray-700">State</label>
                        <input
                          type="text"
                          name="state"
                          value={formData.state}
                          onChange={handleChange}
                          className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all bg-gray-50 hover:bg-white"
                          placeholder="State"
                        />
                      </div>
                    )}
                    {formSettings.show_pincode && (
                      <div className="space-y-2">
                        <label className="text-sm font-medium text-gray-700">PIN Code</label>
                        <input
                          type="text"
                          name="pincode"
                          value={formData.pincode}
                          onChange={handleChange}
                          className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all bg-gray-50 hover:bg-white"
                          placeholder="PIN Code"
                        />
                      </div>
                    )}
                  </div>
                )}

                {formSettings.show_emergency_contact && (
                  <div className="border-t border-gray-200 pt-5">
                    <h4 className="text-sm font-semibold text-gray-900 mb-4 flex items-center gap-2">
                      <AlertTriangle className="h-4 w-4 text-orange-500" />
                      Emergency Contact
                    </h4>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                      <div className="space-y-2">
                        <label className="text-sm font-medium text-gray-700">Contact Name</label>
                        <input
                          type="text"
                          name="emergencyContact"
                          value={formData.emergencyContact}
                          onChange={handleChange}
                          className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all bg-gray-50 hover:bg-white"
                          placeholder="Emergency contact name"
                        />
                      </div>
                      <div className="space-y-2">
                        <label className="text-sm font-medium text-gray-700">Contact Phone</label>
                        <input
                          type="tel"
                          name="emergencyPhone"
                          value={formData.emergencyPhone}
                          onChange={handleChange}
                          className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all bg-gray-50 hover:bg-white"
                          placeholder="Emergency phone number"
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Medical Information Section */}
            {activeSection === 'medical' && (
              <div className="space-y-6">
                {(formSettings.show_blood_group || formSettings.show_allergies) && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                    {formSettings.show_blood_group && (
                      <div className="space-y-2">
                        <label className="text-sm font-medium text-gray-700 flex items-center gap-2">
                          <Droplets className="h-4 w-4 text-red-500" />
                          Blood Group
                        </label>
                        <div className="grid grid-cols-4 gap-2">
                          {['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'].map((bg) => (
                            <button
                              key={bg}
                              type="button"
                              onClick={() => setFormData(prev => ({ ...prev, bloodGroup: bg }))}
                              className={`px-3 py-2 rounded-lg border-2 text-sm font-medium transition-all ${
                                formData.bloodGroup === bg
                                  ? 'border-red-500 bg-red-50 text-red-700'
                                  : 'border-gray-200 bg-gray-50 text-gray-600 hover:border-gray-300 hover:bg-white'
                              }`}
                            >
                              {bg}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    {formSettings.show_allergies && (
                      <div className="space-y-2">
                        <label className="text-sm font-medium text-gray-700 flex items-center gap-2">
                          <AlertTriangle className="h-4 w-4 text-yellow-500" />
                          Known Allergies
                        </label>
                        <input
                          type="text"
                          name="allergies"
                          value={formData.allergies}
                          onChange={handleChange}
                          className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all bg-gray-50 hover:bg-white"
                          placeholder="e.g., Penicillin, Shellfish"
                        />
                      </div>
                    )}
                  </div>
                )}

                {formSettings.show_medical_history && (
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-gray-700 flex items-center gap-2">
                      <ClipboardList className="h-4 w-4 text-gray-500" />
                      Medical History
                    </label>
                    <textarea
                      name="medicalHistory"
                      rows={4}
                      value={formData.medicalHistory}
                      onChange={handleChange}
                      className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all bg-gray-50 hover:bg-white resize-none"
                      placeholder="Brief medical history, current medications, chronic conditions, etc."
                    />
                  </div>
                )}

                {/* Custom patient fields */}
                {customFieldConfigs.length > 0 && (
                  <div className="border-t border-gray-200 pt-5">
                    <h4 className="text-sm font-semibold text-gray-900 mb-4">Additional Information</h4>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                      {customFieldConfigs.map((field) => (
                        <div key={field.id} className="space-y-2">
                          <label className="text-sm font-medium text-gray-700">
                            {field.label}{field.required && ' *'}
                          </label>
                          {field.field_type === 'select' && field.options ? (
                            <select
                              value={customFieldValues[field.field_key] || ''}
                              onChange={(e) => setCustomFieldValues(prev => ({ ...prev, [field.field_key]: e.target.value }))}
                              required={field.required}
                              className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all bg-gray-50 hover:bg-white"
                            >
                              <option value="">Select {field.label}...</option>
                              {(field.options as string[]).map((opt) => (
                                <option key={opt} value={opt}>{opt}</option>
                              ))}
                            </select>
                          ) : (
                            <input
                              type={field.field_type === 'number' ? 'number' : 'text'}
                              value={customFieldValues[field.field_key] || ''}
                              onChange={(e) => setCustomFieldValues(prev => ({ ...prev, [field.field_key]: e.target.value }))}
                              required={field.required}
                              className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all bg-gray-50 hover:bg-white"
                              placeholder={`Enter ${field.label.toLowerCase()}`}
                            />
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Tests Section - Only for new patients */}
            {activeSection === 'tests' && !patient && (
              <div className="space-y-6">
                <div className="space-y-3">
                  <label className="text-sm font-medium text-gray-700 flex items-center gap-2">
                    <TestTube className="h-4 w-4 text-blue-500" />
                    Add Tests
                  </label>
                  <div className="relative">
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={newTestName}
                        onChange={(e) => setNewTestName(e.target.value)}
                        onKeyPress={(e) => e.key === 'Enter' && (e.preventDefault(), handleAddTest())}
                        placeholder="Search tests or packages..."
                        className="flex-1 px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all bg-gray-50 hover:bg-white"
                      />
                      <button
                        type="button"
                        onClick={handleAddTest}
                        disabled={!newTestName.trim()}
                        className="px-5 py-3 bg-blue-600 text-white rounded-xl hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-all font-medium flex items-center gap-2"
                      >
                        <Plus className="h-5 w-5" />
                        Add
                      </button>
                    </div>

                    {showSuggestions && (
                      <div className="absolute z-10 w-full mt-2 bg-white border border-gray-200 rounded-xl shadow-xl overflow-hidden">
                        {filteredSuggestions.map((suggestion, index) => {
                          const isTestGroup = testGroups.some(tg => tg.name === suggestion);
                          const item = isTestGroup
                            ? testGroups.find(tg => tg.name === suggestion)
                            : packages.find(pkg => pkg.name === suggestion);

                          return (
                            <div
                              key={index}
                              onClick={() => handleSelectSuggestion(suggestion)}
                              className="px-4 py-3 hover:bg-blue-50 cursor-pointer border-b border-gray-100 last:border-b-0 flex items-center justify-between"
                            >
                              <div>
                                <div className="font-medium text-gray-900">{suggestion}</div>
                                <div className="text-xs text-gray-500">
                                  {isTestGroup ? 'Test Group' : 'Package'} • {item?.category}
                                </div>
                              </div>
                              <span className="font-bold text-green-600">₹{item?.price || 0}</span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>

                {requestedTests.length > 0 && (
                  <div className="bg-gradient-to-br from-blue-50 to-indigo-50 border border-blue-200 rounded-2xl p-5">
                    <h4 className="font-semibold text-gray-900 mb-4 flex items-center gap-2">
                      <TestTube className="h-5 w-5 text-blue-600" />
                      Selected Tests ({requestedTests.length})
                    </h4>
                    <div className="space-y-2">
                      {requestedTests.map((test, index) => {
                        const testGroup = testGroups.find(tg => tg.name === test);
                        const packageItem = packages.find(pkg => pkg.name === test);
                        const price = testGroup?.price || packageItem?.price || 500;

                        return (
                          <div key={index} className="flex items-center justify-between bg-white rounded-xl p-4 border border-blue-200">
                            <div>
                              <span className="font-medium text-gray-900">{test}</span>
                              <span className="text-xs text-gray-500 ml-2">
                                {testGroup ? 'Test' : packageItem ? 'Package' : 'Manual'}
                              </span>
                            </div>
                            <div className="flex items-center gap-4">
                              <span className="font-bold text-green-600">₹{price}</span>
                              <button
                                type="button"
                                onClick={() => handleRemoveTest(index)}
                                className="text-red-500 hover:text-red-700 hover:bg-red-50 p-2 rounded-lg transition-all"
                              >
                                <Minus className="h-4 w-4" />
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    <div className="mt-5 pt-4 border-t border-blue-200 space-y-2">
                      <div className="flex justify-between text-sm">
                        <span className="text-gray-600">Subtotal:</span>
                        <span className="font-medium">₹{subtotal.toFixed(2)}</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-gray-600">Tax (18% GST):</span>
                        <span className="font-medium">₹{taxAmount.toFixed(2)}</span>
                      </div>
                      <div className="flex justify-between text-lg font-bold pt-2 border-t border-blue-200">
                        <span className="text-gray-900">Total:</span>
                        <span className="text-green-600">₹{totalAmount.toFixed(2)}</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="border-t border-gray-200 bg-gray-50 px-6 py-4">
            <div className="flex items-center justify-between">
              {patient?.qr_code_data && patient?.color_code && (
                <div className="flex items-center gap-3">
                  <div
                    className="w-6 h-6 rounded-full border-2 border-white shadow"
                    style={{ backgroundColor: patient.color_code }}
                  />
                  <span className="text-sm text-gray-600">{patient.color_name}</span>
                  <QRCodeSVG value={patient.qr_code_data} size={40} />
                </div>
              )}
              <div className="flex items-center gap-3 ml-auto">
                <button
                  type="button"
                  onClick={() => { onClose(); handleClearOCR(); }}
                  className="px-5 py-2.5 border border-gray-300 rounded-xl text-gray-700 hover:bg-gray-100 transition-all font-medium"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-6 py-2.5 bg-gradient-to-r from-blue-600 to-indigo-600 text-white rounded-xl hover:from-blue-700 hover:to-indigo-700 transition-all font-medium shadow-lg shadow-blue-200"
                >
                  {patient ? 'Update Patient' : (
                    requestedTests.length > 0
                      ? `Register & Create Invoice (₹${totalAmount.toFixed(2)})`
                      : 'Register Patient'
                  )}
                </button>
              </div>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};

export default PatientForm;
