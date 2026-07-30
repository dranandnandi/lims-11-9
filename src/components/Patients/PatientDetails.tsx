import React from 'react';
import { useState, useEffect } from 'react';
import { X, User, Phone, Mail, MapPin, Droplet, FileText, QrCode, Palette, Printer, Edit, Plus, Upload, ExternalLink, Calendar, Gift, Smartphone, KeyRound, Copy, Check, Eye, EyeOff } from 'lucide-react';
import { QRCodeCanvas } from 'qrcode.react';
import { database, supabase, formatAge, LabPatientFieldConfig } from '../../utils/supabase';
import { WhatsAppAPI } from '../../utils/whatsappAPI';
import ExternalReportUploadModal from './ExternalReportUploadModal';

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
  medical_history?: string;
  registration_date: string;
  last_visit: string;
  qr_code_data?: string;
  color_code?: string;
  color_name?: string;
  total_tests: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

// One row of the lab-scoped patient_portal_credentials view: the patient's virtual
// login plus the last PIN this lab issued. Supabase Auth only stores the hash, so this
// is the only way the PIN survives past the moment it was generated.
interface PortalCredential {
  portal_email: string | null;
  portal_pin: string | null;
  pin_status: 'available' | 'patient_changed' | 'not_recorded' | 'no_access';
  pin_recorded_at: string | null;
  portal_access_enabled: boolean | null;
  // False for roles below admin/owner/lab_manager, whose RLS hides the PIN column
  can_view_pin: boolean | null;
}

interface PatientDetailsProps {
  patient: Patient;
  onClose: () => void;
  onEditPatient: (patient: Patient) => void;
  onCreateOrder: (patient: Patient) => void;
  onViewAllTests: (patient: Patient) => void;
  onGenerateQrAndColor?: (patientId: string) => void;
  isGeneratingCodes?: boolean;
}

const PatientDetails: React.FC<PatientDetailsProps> = ({
  patient,
  onClose,
  onEditPatient,
  onCreateOrder,
  onViewAllTests,
  onGenerateQrAndColor,
  isGeneratingCodes = false
}) => {
  const [recentTests, setRecentTests] = useState<any[]>([]);
  const [loadingTests, setLoadingTests] = useState(true);
  const [testsError, setTestsError] = useState<string | null>(null);
  const [portalLoading, setPortalLoading] = useState(false);
  const [portalPin, setPortalPin] = useState<string | null>(null);
  const [portalAction, setPortalAction] = useState<'created' | 'pin_reset' | null>(null);
  const [portalCred, setPortalCred] = useState<PortalCredential | null>(null);
  const [revealPin, setRevealPin] = useState(false);
  const [pinCopied, setPinCopied] = useState(false);
  const [pinWAStatus, setPinWAStatus] = useState<'sending' | 'sent' | 'failed' | null>(null);
  const [externalReports, setExternalReports] = useState<any[]>([]);
  const [loadingExternalReports, setLoadingExternalReports] = useState(true);
  const [loyaltyBalance, setLoyaltyBalance] = useState<{ current_balance: number; total_earned: number; total_redeemed: number } | null>(null);
  const [loyaltyEnabled, setLoyaltyEnabled] = useState(false);
  const [customFieldConfigs, setCustomFieldConfigs] = useState<LabPatientFieldConfig[]>([]);
  const [customFieldValues, setCustomFieldValues] = useState<Record<string, any>>({});

  useEffect(() => {
    const loadCustomFields = async () => {
      const { data: configs } = await database.labPatientFieldConfigs.getAll();
      if (configs && configs.length > 0) {
        setCustomFieldConfigs(configs);
        let raw = (patient as any).custom_fields;
        if (raw === undefined) {
          const { data: full } = await database.patients.getById(patient.id);
          raw = full?.custom_fields;
        }
        if (raw) {
          const parsed = typeof raw === 'string'
            ? (() => { try { return JSON.parse(raw); } catch { return {}; } })()
            : raw;
          setCustomFieldValues(parsed || {});
        }
      }
    };
    loadCustomFields();
  }, [patient.id]);

  useEffect(() => {
    const fetchRecentTests = async () => {
      setLoadingTests(true);
      setTestsError(null);

      try {
        const { data, error } = await database.results.getByPatientId(patient.id);

        if (error) {
          setTestsError(error.message);
          console.error('Error loading patient tests:', error);
        } else {
          // Transform the data to match the expected format and take only the 3 most recent
          const formattedTests = (data || [])
            .slice(0, 3)
            .map((result: any) => {
              // Extract logic to determine display value
              let displayResult = 'Pending';

              if (result.result_values && result.result_values.length > 0) {
                // Determine if we should show the value based on status
                // Usually show values if Entered, verified/Approved, or Reported
                if (['Entered', 'Approved', 'Reported', 'Reviewed'].includes(result.status)) {
                  const val = result.result_values[0];
                  displayResult = `${val.value} ${val.unit || ''}`.trim();

                  // If multiple values, maybe indicate that? For now just showing first or "View Report" might be safer for panels
                  if (result.result_values.length > 1) {
                    displayResult = 'View Details';
                  }
                }
              } else if (result.status === 'Reported') {
                displayResult = 'Completed';
              }

              return {
                name: result.test_name,
                date: result.entered_date,
                status: result.status === 'Reported' ? 'Completed' : (result.status === 'Approved' ? 'Reviewed' : result.status),
                result: displayResult
              };
            });

          setRecentTests(formattedTests);
        }
      } catch (err) {
        setTestsError('Failed to load recent tests');
        console.error('Error:', err);
      } finally {
        setLoadingTests(false);
      }
    };

    const fetchExternalReports = async () => {
      setLoadingExternalReports(true);
      try {
        const { data, error } = await supabase
          .from('external_reports')
          .select(`
            *,
            external_result_values (
              id,
              original_analyte_name,
              value,
              unit,
              reference_range,
              ai_confidence,
              is_verified
            )
          `)
          .eq('patient_id', patient.id)
          .order('report_date', { ascending: false });

        if (!error && data) {
          setExternalReports(data);
        }
      } catch (err) {
        console.error('Error loading external reports:', err);
      } finally {
        setLoadingExternalReports(false);
      }
    };

    const fetchLoyaltyBalance = async () => {
      try {
        const settings = await database.loyaltyPoints.getLabSettings();
        if (settings?.loyalty_enabled) {
          setLoyaltyEnabled(true);
          const balance = await database.loyaltyPoints.getBalance(patient.id);
          setLoyaltyBalance(balance);
        }
      } catch (err) {
        console.error('Error loading loyalty balance:', err);
      }
    };

    fetchRecentTests();
    fetchExternalReports();
    fetchLoyaltyBalance();
  }, [patient.id]);

  const refreshExternalReports = async () => {
    setLoadingExternalReports(true);
    try {
      const { data, error } = await supabase
        .from('external_reports')
        .select(`
          *,
          external_result_values (
            id,
            original_analyte_name,
            value,
            unit,
            reference_range,
            ai_confidence,
            is_verified
          )
        `)
        .eq('patient_id', patient.id)
        .order('report_date', { ascending: false });

      if (!error && data) {
        setExternalReports(data);
      }
    } catch (err) {
      console.error('Error loading external reports:', err);
    } finally {
      setLoadingExternalReports(false);
    }
  };

  // Reads the lab-scoped view, so this only ever returns the caller's own lab row
  // even when the same mobile number is registered at other labs.
  const loadPortalCredential = async () => {
    const { data, error } = await supabase
      .from('patient_portal_credentials')
      .select('portal_email, portal_pin, pin_status, pin_recorded_at, portal_access_enabled, can_view_pin')
      .eq('patient_id', patient.id)
      .maybeSingle();

    if (error) {
      console.error('Error loading portal credential:', error);
      return;
    }
    setPortalCred((data as PortalCredential | null) ?? null);
  };

  useEffect(() => {
    setRevealPin(false);
    loadPortalCredential();
  }, [patient.id]);

  const buildPortalCredentialsMessage = (pin: string) => {
    const portalUrl = `${window.location.origin}/patient/login`;
    return `Hello ${patient.name},\n\nYour patient portal access is ready!\n\n` +
      `Login: ${portalUrl}\n` +
      `Mobile number: ${patient.phone}\n` +
      `PIN: *${pin}*\n\n` +
      `Use your registered mobile number and this 6-digit PIN to view your reports online. ` +
      `You can change the PIN after logging in.\n\nThank you!`;
  };

  const sendPinViaWhatsApp = async (pin: string) => {
    setPinWAStatus('sending');
    try {
      const result = await WhatsAppAPI.sendTextMessage(patient.phone, buildPortalCredentialsMessage(pin));
      setPinWAStatus(result.success ? 'sent' : 'failed');
    } catch (err) {
      console.error('Portal PIN WhatsApp send error:', err);
      setPinWAStatus('failed');
    }
  };

  const handleGeneratePortalAccess = async () => {
    if (!patient.phone) {
      alert('This patient has no phone number. Add a phone number first.');
      return;
    }
    setPortalLoading(true);
    setPortalPin(null);
    setPinWAStatus(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const supabaseUrl = (supabase as any).supabaseUrl as string;
      const res = await fetch(`${supabaseUrl}/functions/v1/create-patient-portal-user`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session?.access_token}`,
          'apikey': (supabase as any).supabaseKey as string,
        },
        body: JSON.stringify({ patient_id: patient.id }),
      });
      const json = await res.json();
      if (!res.ok || json.error) throw new Error(json.error || 'Failed');
      setPortalPin(json.pin);
      setPortalAction(json.action);
      loadPortalCredential();
      // Auto-send credentials to the patient via WhatsApp
      sendPinViaWhatsApp(json.pin);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to generate portal access');
    } finally {
      setPortalLoading(false);
    }
  };

  const handleCopyPin = (pin: string) => {
    navigator.clipboard.writeText(pin);
    setPinCopied(true);
    setTimeout(() => setPinCopied(false), 2000);
  };

  const handleEditPatient = () => {
    onEditPatient(patient);
    onClose();
  };

  const handleCreateOrder = () => {
    onCreateOrder(patient);
    onClose();
  };

  const handleViewAllTests = () => {
    onViewAllTests(patient);
    onClose();
  };
  const [showUploadModal, setShowUploadModal] = useState(false);

  return (
    <div className="fixed inset-0 bg-gray-600 bg-opacity-75 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <h2 className="text-xl font-semibold text-gray-900">Patient Details</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-500 p-1 rounded"
          >
            <X className="h-6 w-6" />
          </button>
        </div>

        <div className="p-6 space-y-6">
          {/* Patient Summary */}
          <div className={`bg-gradient-to-r from-blue-50 to-blue-100 rounded-lg p-6 ${patient.color_code ? `border-l-4 border-[${patient.color_code}]` : ''
            }`}>
            <div className="flex items-start justify-between">
              <div className="flex items-center space-x-4">
                <div className="h-16 w-16 bg-blue-500 rounded-full flex items-center justify-center">
                  <User className="h-8 w-8 text-white" />
                </div>
                <div>
                  <h3 className="text-2xl font-bold text-gray-900">{patient.name}</h3>
                  <p className="text-gray-600">Patient ID: {patient.id}</p>
                  {patient.display_id && (
                    <p className="text-gray-600">Sample ID: {patient.display_id}</p>
                  )}
                  <div className="flex items-center space-x-4 mt-2 text-sm text-gray-600">
                    <span>{patient.age} years old</span>
                    <span>•</span>
                    <span>{patient.gender}</span>
                    <span>•</span>
                    <span>{patient.total_tests} total tests</span>
                    {patient.color_name && (
                      <>
                        <span>•</span>
                        <span className="flex items-center">
                          <div
                            className="w-3 h-3 rounded-full mr-1"
                            style={{ backgroundColor: patient.color_code }}
                          ></div>
                          {patient.color_name}
                        </span>
                      </>
                    )}
                  </div>
                </div>
              </div>
              <div className="text-right">
                <div className="text-sm text-gray-600">Registered</div>
                <div className="font-medium">{new Date(patient.registration_date).toLocaleDateString()}</div>
                <div className="text-sm text-gray-600 mt-1">Last visit</div>
                <div className="font-medium">{new Date(patient.last_visit).toLocaleDateString()}</div>
                {loyaltyEnabled && loyaltyBalance && (
                  <div className="mt-3 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                    <div className="flex items-center justify-end text-amber-700 text-sm font-medium">
                      <Gift className="h-4 w-4 mr-1" />
                      {loyaltyBalance.current_balance} pts
                    </div>
                    <div className="text-xs text-amber-600 mt-0.5">
                      Earned: {loyaltyBalance.total_earned} • Used: {loyaltyBalance.total_redeemed}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Patient Identification */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* QR Code */}
            <div className="bg-white border border-gray-200 rounded-lg p-6">
              <h4 className="text-lg font-semibold text-gray-900 mb-4 flex items-center">
                <QrCode className="h-5 w-5 mr-2 text-blue-500" />
                Patient QR Code
              </h4>
              {patient.qr_code_data ? (
                <div className="flex flex-col items-center">
                  <QRCodeCanvas
                    value={patient.qr_code_data}
                    size={150}
                    level="H"
                    includeMargin={true}
                    className="mb-4"
                  />
                  <div className="text-sm text-gray-600 mb-4">
                    Scan to identify patient and access records
                  </div>
                  <button
                    onClick={() => {
                      const canvas = document.querySelector("canvas");
                      if (canvas) {
                        const pngUrl = canvas.toDataURL("image/png");
                        const downloadLink = document.createElement("a");
                        downloadLink.href = pngUrl;
                        downloadLink.download = `${patient.name.replace(/\s+/g, '_')}_QR.png`;
                        document.body.appendChild(downloadLink);
                        downloadLink.click();
                        document.body.removeChild(downloadLink);
                      }
                    }}
                    className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
                  >
                    Download QR Code
                  </button>
                </div>
              ) : (
                <div className="flex flex-col items-center">
                  <div className="bg-gray-100 rounded-lg w-150 h-150 flex items-center justify-center mb-4" style={{ width: "150px", height: "150px" }}>
                    <QrCode className="h-12 w-12 text-gray-400" />
                  </div>
                  <div className="text-sm text-gray-600 text-center">
                    QR codes are generated at order level for sample tracking
                  </div>
                </div>
              )}
            </div>

            {/* Color Assignment */}
            <div className="bg-white border border-gray-200 rounded-lg p-6">
              <h4 className="text-lg font-semibold text-gray-900 mb-4 flex items-center">
                <Palette className="h-5 w-5 mr-2 text-blue-500" />
                Color Assignment
              </h4>
              {patient.color_code ? (
                <div className="flex flex-col items-center">
                  <div
                    className="w-32 h-32 rounded-lg mb-4 flex items-center justify-center text-white text-lg font-bold shadow-md"
                    style={{ backgroundColor: patient.color_code }}
                  >
                    {patient.color_name}
                  </div>
                  <div className="text-sm text-gray-600 mb-2">
                    <span className="font-medium">Color Name:</span> {patient.color_name}
                  </div>
                  <div className="text-sm text-gray-600 mb-4">
                    <span className="font-medium">HEX Code:</span> {patient.color_code}
                  </div>
                  <button
                    onClick={() => {
                      const printWindow = window.open('', '_blank');
                      if (printWindow) {
                        printWindow.document.write(`
                          <html>
                            <head>
                              <title>Color Label - ${patient.name}</title>
                              <style>
                                body { font-family: Arial, sans-serif; margin: 0; padding: 20px; }
                                .color-label { 
                                  width: 100px; 
                                  height: 100px; 
                                  background-color: ${patient.color_code}; 
                                  margin: 0 auto;
                                  display: flex;
                                  align-items: center;
                                  justify-content: center;
                                  color: white;
                                  font-weight: bold;
                                  border-radius: 4px;
                                }
                                .patient-info { text-align: center; margin-top: 10px; }
                              </style>
                            </head>
                            <body>
                              <div class="color-label">${patient.color_name}</div>
                              <div class="patient-info">
                                <p>${patient.name}</p>
                                <p>ID: ${patient.id}</p>
                              </div>
                              <script>
                                setTimeout(() => { window.print(); window.close(); }, 500);
                              </script>
                            </body>
                          </html>
                        `);
                      }
                    }}
                    className="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 transition-colors"
                  >
                    Print Color Label
                  </button>
                </div>
              ) : (
                <div className="flex flex-col items-center">
                  <div className="bg-gray-100 rounded-lg w-32 h-32 flex items-center justify-center mb-4">
                    <Palette className="h-12 w-12 text-gray-400" />
                  </div>
                  <div className="text-sm text-gray-600 mb-4">
                    No color has been assigned to this patient. Colors are assigned automatically during registration.
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Contact Information */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="bg-white border border-gray-200 rounded-lg p-6">
              <h4 className="text-lg font-semibold text-gray-900 mb-4 flex items-center">
                <Phone className="h-5 w-5 mr-2 text-blue-500" />
                Contact Information
              </h4>
              <div className="space-y-3">
                <div className="flex items-center">
                  <Phone className="h-4 w-4 text-gray-400 mr-3" />
                  <span className="text-gray-900">{patient.phone}</span>
                </div>
                <div className="flex items-center">
                  <Mail className="h-4 w-4 text-gray-400 mr-3" />
                  <span className="text-gray-900">{patient.email || 'No email provided'}</span>
                </div>
                <div className="flex items-start">
                  <MapPin className="h-4 w-4 text-gray-400 mr-3 mt-1" />
                  <span className="text-gray-900">{patient.address}, {patient.city}, {patient.state} - {patient.pincode}</span>
                </div>
              </div>
            </div>

            {/* Medical Information */}
            <div className="bg-white border border-gray-200 rounded-lg p-6">
              <h4 className="text-lg font-semibold text-gray-900 mb-4 flex items-center">
                <Droplet className="h-5 w-5 mr-2 text-red-500" />
                Medical Information
              </h4>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-gray-600">Blood Group:</span>
                  <span className="font-medium text-gray-900">{patient.blood_group || 'Not specified'}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-600">Known Allergies:</span>
                  <span className="font-medium text-gray-900">{patient.allergies || 'None'}</span>
                </div>
                <div className="border-t border-gray-200 pt-3">
                  <span className="text-gray-600 text-sm">Medical History:</span>
                  <p className="text-gray-900 text-sm mt-1">
                    {patient.medical_history || 'No significant medical history.'}
                  </p>
                </div>
              </div>
            </div>

            {/* Custom Fields */}
            {customFieldConfigs.length > 0 && (
              <div className="bg-white border border-gray-200 rounded-lg p-6">
                <h4 className="text-lg font-semibold text-gray-900 mb-4 flex items-center">
                  <FileText className="h-5 w-5 mr-2 text-purple-500" />
                  Additional Information
                </h4>
                <div className="space-y-3">
                  {customFieldConfigs.map((field) => (
                    <div key={field.id} className="flex items-center justify-between">
                      <span className="text-gray-600">{field.label}:</span>
                      <span className="font-medium text-gray-900">
                        {customFieldValues[field.field_key] || '—'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Recent Tests */}
          <div className="bg-white border border-gray-200 rounded-lg p-6">
            <h4 className="text-lg font-semibold text-gray-900 mb-4 flex items-center">
              <FileText className="h-5 w-5 mr-2 text-green-500" />
              Recent Tests
            </h4>
            {loadingTests ? (
              <div className="flex items-center justify-center py-8">
                <div className="animate-spin rounded-full h-8 w-8 border-4 border-blue-600 border-t-transparent"></div>
              </div>
            ) : testsError ? (
              <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                <div className="text-red-700 text-sm">{testsError}</div>
              </div>
            ) : recentTests.length === 0 ? (
              <div className="text-center py-8 text-gray-500">
                <FileText className="h-12 w-12 mx-auto mb-2 text-gray-300" />
                <p>No test results found for this patient</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Test Name
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Date
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Status
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Result
                      </th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {recentTests.map((test, index) => (
                      <tr key={index} className="hover:bg-gray-50">
                        <td className="px-4 py-3 text-sm font-medium text-gray-900">
                          {test.name}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-600">
                          {new Date(test.date).toLocaleDateString()}
                        </td>
                        <td className="px-4 py-3 text-sm">
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                            {test.status}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-900">
                          {test.result}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* External Reports */}
          {externalReports.length > 0 && (
            <div className="bg-white border border-gray-200 rounded-lg p-6">
              <h4 className="text-lg font-semibold text-gray-900 mb-4 flex items-center">
                <ExternalLink className="h-5 w-5 mr-2 text-purple-500" />
                External Lab Reports
              </h4>
              {loadingExternalReports ? (
                <div className="flex items-center justify-center py-4">
                  <div className="animate-spin rounded-full h-6 w-6 border-4 border-purple-600 border-t-transparent"></div>
                </div>
              ) : (
                <div className="space-y-4">
                  {externalReports.map((report) => (
                    <div key={report.id} className="bg-purple-50 rounded-lg border border-purple-100 overflow-hidden">
                      {/* Report Header */}
                      <div className="flex items-center justify-between p-3">
                        <div className="flex items-center space-x-3">
                          <div className="p-2 bg-purple-100 rounded-lg">
                            <FileText className="h-5 w-5 text-purple-600" />
                          </div>
                          <div className="flex-1">
                            <div className="font-medium text-gray-900">
                              {report.lab_name || 'External Lab Report'}
                            </div>
                            <div className="text-sm text-gray-500 flex items-center flex-wrap gap-1">
                              <span className="flex items-center">
                                <Calendar className="h-3.5 w-3.5 mr-1" />
                                {report.report_date
                                  ? new Date(report.report_date).toLocaleDateString()
                                  : 'Date not specified'}
                              </span>
                              <span className={`px-2 py-0.5 rounded text-xs ${report.status === 'completed'
                                  ? 'bg-green-100 text-green-700'
                                  : report.status === 'review_required'
                                    ? 'bg-amber-100 text-amber-700'
                                    : 'bg-gray-100 text-gray-600'
                                }`}>
                                {report.status === 'completed' ? 'Processed' :
                                  report.status === 'review_required' ? 'Review Required' :
                                    report.status}
                              </span>
                              {report.external_result_values?.length > 0 && (
                                <span className="px-2 py-0.5 rounded text-xs bg-purple-100 text-purple-700">
                                  {report.external_result_values.length} tests
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                        <a
                          href={report.file_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="px-3 py-1.5 text-purple-600 hover:bg-purple-100 rounded-md transition-colors text-sm shrink-0"
                        >
                          View File
                        </a>
                      </div>

                      {/* Extracted Result Values Table */}
                      {report.external_result_values?.length > 0 && (
                        <div className="border-t border-purple-100 bg-white">
                          <table className="min-w-full divide-y divide-gray-200 text-sm">
                            <thead className="bg-gray-50">
                              <tr>
                                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Test</th>
                                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Value</th>
                                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Unit</th>
                                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Ref. Range</th>
                              </tr>
                            </thead>
                            <tbody className="bg-white divide-y divide-gray-100">
                              {report.external_result_values.map((result: any) => (
                                <tr key={result.id} className="hover:bg-gray-50">
                                  <td className="px-3 py-2 text-gray-900 font-medium">
                                    {result.original_analyte_name}
                                  </td>
                                  <td className="px-3 py-2 text-gray-900">
                                    {result.value || '-'}
                                  </td>
                                  <td className="px-3 py-2 text-gray-600">
                                    {result.unit || '-'}
                                  </td>
                                  <td className="px-3 py-2 text-gray-600">
                                    {result.reference_range || '-'}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Portal access — the PIN just generated, or the one this lab last issued.
              Read back from patient_portal_credentials so it survives a page reload
              instead of being visible only in the response that created it. */}
          {(portalPin || portalCred?.portal_access_enabled) && (() => {
            const currentPin = portalPin || portalCred?.portal_pin || null;
            const isFresh = Boolean(portalPin);

            return (
              <div className="mt-4 p-4 bg-teal-50 border border-teal-200 rounded-lg">
                <div className="flex items-center gap-2 mb-2">
                  <KeyRound className="h-4 w-4 text-teal-700" />
                  <p className="text-sm font-medium text-teal-800">
                    {isFresh
                      ? `${portalAction === 'created' ? 'Portal access created!' : 'PIN reset successfully!'} Share this PIN with the patient:`
                      : 'Patient Portal Access'}
                  </p>
                </div>

                {currentPin ? (
                  <>
                    <div className="flex items-center gap-3 flex-wrap">
                      <span className="font-mono text-2xl font-bold text-teal-700 tracking-widest">
                        {isFresh || revealPin ? currentPin : '••••••'}
                      </span>
                      {!isFresh && (
                        <button
                          onClick={() => setRevealPin((v) => !v)}
                          className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-white border border-teal-300 text-teal-700 rounded-lg hover:bg-teal-50 transition-colors"
                        >
                          {revealPin ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                          {revealPin ? 'Hide' : 'Show PIN'}
                        </button>
                      )}
                      <button
                        onClick={() => handleCopyPin(currentPin)}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-white border border-teal-300 text-teal-700 rounded-lg hover:bg-teal-50 transition-colors"
                      >
                        {pinCopied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                        {pinCopied ? 'Copied!' : 'Copy PIN'}
                      </button>
                      <button
                        onClick={() => sendPinViaWhatsApp(currentPin)}
                        disabled={pinWAStatus === 'sending' || !patient.phone}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-60 transition-colors"
                      >
                        <Smartphone className="h-3.5 w-3.5" />
                        {pinWAStatus === 'sending' ? 'Sending...' : pinWAStatus === 'sent' ? 'Resend WhatsApp' : 'Send via WhatsApp'}
                      </button>
                    </div>
                    {!isFresh && portalCred?.pin_recorded_at && (
                      <p className="text-xs text-teal-600 mt-2">
                        Issued {new Date(portalCred.pin_recorded_at).toLocaleString('en-IN')}
                      </p>
                    )}
                  </>
                ) : portalCred?.can_view_pin === false ? (
                  <p className="text-sm text-teal-700">
                    Portal access is active. Only an admin, owner or lab manager can view the PIN.
                  </p>
                ) : portalCred?.pin_status === 'patient_changed' ? (
                  <p className="text-sm text-teal-700">
                    The patient has set their own PIN, so it can no longer be shown here.
                    Use <span className="font-medium">Reset Portal PIN</span> to issue a new one.
                  </p>
                ) : (
                  <p className="text-sm text-teal-700">
                    This PIN was issued before PINs were recorded, so it cannot be shown.
                    Use <span className="font-medium">Reset Portal PIN</span> to issue one you can see.
                  </p>
                )}

                {pinWAStatus === 'sent' && (
                  <p className="text-xs text-green-700 mt-2 flex items-center gap-1">
                    <Check className="h-3.5 w-3.5" /> Credentials sent to {patient.phone} via WhatsApp.
                  </p>
                )}
                {pinWAStatus === 'failed' && (
                  <p className="text-xs text-red-600 mt-2">
                    WhatsApp auto-send failed — share the PIN manually or retry with the button above.
                  </p>
                )}
                <p className="text-xs text-teal-600 mt-2">
                  Patient logs in at <span className="font-mono">/patient/login</span> with their mobile number + this PIN.
                  {' '}If the number is registered at other labs too, the PIN decides which lab's reports open.
                </p>
              </div>
            );
          })()}

          {/* Action Buttons */}
          <div className="flex items-center justify-end space-x-4 pt-6 border-t border-gray-200 flex-wrap gap-y-2">

            <button
              onClick={handleGeneratePortalAccess}
              disabled={portalLoading || !patient.phone}
              className="px-4 py-2 border border-teal-300 text-teal-700 hover:bg-teal-50 rounded-md transition-colors flex items-center disabled:opacity-50 disabled:cursor-not-allowed"
              title={!patient.phone ? 'No phone number on record' : (portalLoading ? 'Generating...' : 'Generate or reset portal PIN')}
            >
              {portalLoading ? (
                <><div className="animate-spin rounded-full h-4 w-4 border-b-2 border-teal-600 mr-2" />Generating...</>
              ) : (
                <><Smartphone className="h-4 w-4 mr-2" />{(portalCred?.portal_access_enabled ?? (patient as any).portal_access_enabled) ? 'Reset Portal PIN' : 'Generate Portal Access'}</>
              )}
            </button>

            <button
              onClick={() => setShowUploadModal(true)}
              className="px-4 py-2 border border-blue-300 text-blue-700 hover:bg-blue-50 rounded-md transition-colors flex items-center"
            >
              <Upload className="h-4 w-4 mr-2" />
              Upload Past Report
            </button>

            <button
              onClick={handleEditPatient}
              className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50 transition-colors flex items-center"
            >
              <Edit className="h-4 w-4 mr-2" />
              Edit Patient
            </button>
            <button
              onClick={handleCreateOrder}
              className="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 transition-colors flex items-center"
            >
              <Plus className="h-4 w-4 mr-2" />
              Create Order
            </button>
            <button
              onClick={handleViewAllTests}
              className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors flex items-center"
            >
              <FileText className="h-4 w-4 mr-2" />
              View All Tests
            </button>
            {patient.qr_code_data && patient.color_code && (
              <button
                onClick={() => {
                  const printWindow = window.open('', '_blank');
                  if (printWindow && patient.qr_code_data) {
                    printWindow.document.write(`
                      <html>
                        <head>
                          <title>Patient ID Label - ${patient.name}</title>
                          <style>
                            body { font-family: Arial, sans-serif; margin: 0; padding: 20px; }
                            .label-container { 
                              display: flex; 
                              flex-direction: column;
                              align-items: center;
                              max-width: 300px;
                              margin: 0 auto;
                              padding: 15px;
                              border: 1px solid #ccc;
                              border-radius: 8px;
                              border-left: 10px solid ${patient.color_code};
                            }
                            .patient-info { text-align: center; margin-top: 10px; }
                            .sample-id { font-size: 14px; font-weight: bold; color: #333; }
                            .color-indicator {
                              width: 50px;
                              height: 50px;
                              background-color: ${patient.color_code};
                              border-radius: 50%;
                              margin: 10px 0;
                              display: flex;
                              align-items: center;
                              justify-content: center;
                              color: white;
                              font-weight: bold;
                              font-size: 10px;
                            }
                          </style>
                          <script src="https://cdn.jsdelivr.net/npm/qrcode@1.4.4/build/qrcode.min.js"></script>
                        </head>
                        <body>
                          <div class="label-container">
                            <div class="patient-info">
                              <h3>${patient.name}</h3>
                              ${patient.display_id ? `<p class="sample-id">Sample ID: ${patient.display_id}</p>` : ''}
                              <p>ID: ${patient.id}</p>
                              <p>${patient.age}${(patient as any).age_unit === 'months' ? 'm' : (patient as any).age_unit === 'days' ? 'd' : 'y'}, ${patient.gender}</p>
                            </div>
                            <div id="qrcode"></div>
                            <div class="color-indicator">${patient.color_name}</div>
                          </div>
                          <script>
                            QRCode.toCanvas(document.getElementById('qrcode'), '${patient.qr_code_data}', {
                              width: 120,
                              margin: 2,
                              errorCorrectionLevel: 'H'
                            });
                            setTimeout(() => { window.print(); window.close(); }, 500);
                          </script>
                        </body>
                      </html>
                    `);
                  }
                }}
                className="px-4 py-2 bg-purple-600 text-white rounded-md hover:bg-purple-700 transition-colors flex items-center"
              >
                <Printer className="h-4 w-4 mr-2" />
                Print ID Label
              </button>
            )}
          </div>
        </div>
      </div>

      {
        showUploadModal && (
          <ExternalReportUploadModal
            patientId={patient.id}
            onClose={() => setShowUploadModal(false)}
            onSuccess={refreshExternalReports}
          />
        )
      }
    </div >
  );
};

export default PatientDetails;