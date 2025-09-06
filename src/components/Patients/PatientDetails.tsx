import React from 'react';
import { useState, useEffect } from 'react';
import { X, User, Phone, Mail, MapPin, Calendar, Droplet, AlertTriangle, FileText, QrCode, Palette, Printer, Edit, Plus, RefreshCw } from 'lucide-react';
import { QRCodeCanvas } from 'qrcode.react';
import { database } from '../../utils/supabase';

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
            .map((result: any) => ({
              name: result.test_name,
              date: result.entered_date,
              status: result.status === 'Reported' ? 'Completed' : result.status,
              result: result.status === 'Reported' ? 'Completed' : 'Pending'
            }));
          
          setRecentTests(formattedTests);
        }
      } catch (err) {
        setTestsError('Failed to load recent tests');
        console.error('Error:', err);
      } finally {
        setLoadingTests(false);
      }
    };

    fetchRecentTests();
  }, [patient.id]);

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
          <div className={`bg-gradient-to-r from-blue-50 to-blue-100 rounded-lg p-6 ${
            patient.color_code ? `border-l-4 border-[${patient.color_code}]` : ''
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
                  <div className="text-sm text-gray-600 mb-4">
                    No QR code has been generated for this patient
                  </div>
                  {onGenerateQrAndColor && (
                    <button 
                      onClick={() => onGenerateQrAndColor(patient.id)}
                      disabled={isGeneratingCodes}
                      className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors disabled:bg-blue-400 disabled:cursor-not-allowed"
                    >
                      {isGeneratingCodes ? (
                        <>
                          <RefreshCw className="h-4 w-4 mr-2 inline animate-spin" />
                          Generating...
                        </>
                      ) : (
                        <>Generate QR Code</>
                      )}
                    </button>
                  )}
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

          {/* Action Buttons */}
          <div className="flex items-center justify-end space-x-4 pt-6 border-t border-gray-200">
            {onGenerateQrAndColor && !patient.qr_code_data && (
              <button
                onClick={() => onGenerateQrAndColor(patient.id)}
                disabled={isGeneratingCodes}
                className="px-4 py-2 bg-purple-600 text-white rounded-md hover:bg-purple-700 transition-colors disabled:bg-purple-400 disabled:cursor-not-allowed flex items-center"
              >
                {isGeneratingCodes ? (
                  <>
                    <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                    Generating QR...
                  </>
                ) : (
                  <>
                    <QrCode className="h-4 w-4 mr-2" />
                    Generate QR Code
                  </>
                )}
              </button>
            )}
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
                              <p>${patient.age}y, ${patient.gender}</p>
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
    </div>
  );
};

export default PatientDetails;