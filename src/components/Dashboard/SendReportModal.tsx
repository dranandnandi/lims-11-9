import React, { useState } from 'react';
import { supabase } from '../../utils/supabase';
import { resolveWhatsAppSender } from '../../utils/whatsappSenderResolver';
import WhatsAppAPI from '../../utils/whatsappAPI';
import { useAuth } from '../../contexts/AuthContext';
import { Send, Phone, FileText, Check, X } from 'lucide-react';

interface SendReportModalProps {
    orderId: string;
    patientName: string;
    doctorName: string;
    doctorPhone: string;
    clinicalSummary?: string;
    includeClinicalSummary?: boolean; // Flag from orders table to control default checkbox state
    reportUrl?: string; // Optional if we just want to trigger generation+send, but usually we send existing URL
    onClose: () => void;
}

export const SendReportModal: React.FC<SendReportModalProps> = ({
    orderId,
    patientName,
    doctorName,
    doctorPhone,
    clinicalSummary,
    includeClinicalSummary: includeSummaryFlag,
    reportUrl,
    onClose
}) => {
    const { user } = useAuth();
    const [phone, setPhone] = useState(doctorPhone || '');
    // Only show summary checkbox enabled if: 1) flag is true AND 2) summary exists
    const [includeSummary, setIncludeSummary] = useState(includeSummaryFlag && !!clinicalSummary);
    const [summaryText, setSummaryText] = useState(clinicalSummary || '');
    const [isSending, setIsSending] = useState(false);
    const [sentSuccess, setSentSuccess] = useState(false);

    const handleSend = async () => {
        if (!phone) {
            alert('Please enter a phone number');
            return;
        }
        if (!reportUrl) {
            alert('Report URL is missing. Please generate the report first.');
            return;
        }

        setIsSending(true);
        try {
            // Logic from Edge Function / Netlify
            // We'll call the Netlify function directly or via a trusted Edge Function if CORS issues
            // Direct call to Netlify function (as seen in generate-pdf-auto)
            const NETLIFY_SEND_REPORT_URL = 'https://app.limsapp.in/.netlify/functions/send-report-url';

            // Sender cascade lives in one place now: this order's location,
            // then the lab default, then the current user.
            const { data: order, error: orderError } = await supabase
                .from('orders')
                .select('lab_id, location_id')
                .eq('id', orderId)
                .single();

            if (orderError || !order) {
                throw new Error('Could not fetch order details');
            }

            const sender = await resolveWhatsAppSender({
                labId: order.lab_id,
                locationId: order.location_id,
                fallbackUserId: user?.id ?? null,
            });

            if (!sender.userId) {
                throw new Error('No WhatsApp sender configured. Set one on this location (Masters → Locations) or a lab default in Settings → Lab Settings.');
            }

            const formattedPhone = '+' + WhatsAppAPI.formatPhoneNumber(phone, sender.countryCode);

            // Construct Message
            // Debug: Log clinical summary state
            console.log('[SendReportModal] Clinical summary state:', {
                orderId,
                includeSummaryFlag: includeSummaryFlag,
                includeSummaryCheckbox: includeSummary,
                summaryTextExists: !!summaryText,
                summaryTextLength: summaryText?.length || 0
            });

            let message = `Hello Dr. ${doctorName || 'Doctor'},\n\nThe report for patient ${patientName} is ready.`;
            if (includeSummary && summaryText) {
                message += `\n\n📋 Clinical Summary:\n${summaryText}`;
                console.log('[SendReportModal] ✅ Clinical summary ADDED to message');
            } else {
                console.log('[SendReportModal] ⚠️ Clinical summary NOT added - checkbox:', includeSummary, 'text exists:', !!summaryText);
            }
            message += `\n\nPlease find the attached report.\n\nThank you.`;

            // Payload
            const payload = {
                userId: sender.userId,
                fileUrl: reportUrl,
                fileName: `Report_${patientName}_${orderId.slice(-4)}.pdf`,
                caption: message,
                phoneNumber: formattedPhone,
                templateData: { PatientName: patientName }
            };

            const response = await fetch(NETLIFY_SEND_REPORT_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Sending failed: ${errorText || response.statusText}`);
            }

            // Log Success
            await supabase.from('reports').update({
                doctor_informed_at: new Date().toISOString(),
                doctor_informed_via: 'whatsapp_manual'
            }).eq('order_id', orderId);

            setSentSuccess(true);
            setTimeout(() => {
                onClose();
            }, 2000);

        } catch (err: any) {
            console.error('Send Error:', err);
            alert('Failed to send: ' + err.message);
        } finally {
            setIsSending(false);
        }
    };

    return (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
            <div className="bg-white rounded-xl shadow-2xl w-full max-w-md overflow-hidden animate-in zoom-in-95 duration-200">

                <div className="px-6 py-4 border-b border-gray-100 flex justify-between items-center bg-green-50">
                    <h3 className="font-bold text-green-800 flex items-center gap-2">
                        <Phone className="w-5 h-5" /> Send to Doctor
                    </h3>
                    <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="w-5 h-5" /></button>
                </div>

                <div className="p-6 space-y-4">
                    {sentSuccess ? (
                        <div className="text-center py-8">
                            <div className="w-16 h-16 bg-green-100 text-green-600 rounded-full flex items-center justify-center mx-auto mb-3">
                                <Check className="w-8 h-8" />
                            </div>
                            <p className="text-lg font-medium text-gray-900">Sent Successfully!</p>
                        </div>
                    ) : (
                        <>
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">Doctor's WhatsApp Number</label>
                                <input
                                    type="text"
                                    value={phone}
                                    onChange={(e) => setPhone(e.target.value)}
                                    className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-green-500"
                                    placeholder="+91..."
                                />
                            </div>

                            {clinicalSummary && (
                                <div className="bg-gray-50 p-3 rounded-lg border border-gray-200">
                                    <label className="flex items-center space-x-2 mb-2 cursor-pointer">
                                        <input
                                            type="checkbox"
                                            checked={includeSummary}
                                            onChange={(e) => setIncludeSummary(e.target.checked)}
                                            className="text-green-600 rounded focus:ring-green-500"
                                        />
                                        <span className="text-sm font-medium text-gray-700">Include AI Clinical Summary</span>
                                    </label>

                                    {includeSummary && (
                                        <textarea
                                            value={summaryText}
                                            onChange={(e) => setSummaryText(e.target.value)}
                                            className="w-full p-2 text-xs border rounded-md h-24 text-gray-600 focus:outline-none focus:border-green-400"
                                        />
                                    )}
                                </div>
                            )}

                            <div className="text-xs text-gray-500 bg-blue-50 p-2 rounded">
                                Verify the report URL exists before sending.
                            </div>
                        </>
                    )}
                </div>

                {!sentSuccess && (
                    <div className="px-6 py-4 bg-gray-50 border-t flex justify-end gap-3">
                        <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-200 rounded-lg">Cancel</button>
                        <button
                            onClick={handleSend}
                            disabled={isSending}
                            className="flex items-center px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 font-medium"
                        >
                            {isSending ? 'Sending...' : <><Send className="w-4 h-4 mr-2" /> Send via WhatsApp</>}
                        </button>
                    </div>
                )}

            </div>
        </div>
    );
};
