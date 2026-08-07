import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Loader2,
  RefreshCw,
  Copy,
  Check,
  MessageCircle,
  AlertCircle,
  CheckCircle2,
  Clock,
} from 'lucide-react';
import { supabase, database } from '../../utils/supabase';
import { generateLinkQRCodeDataURL } from '../../utils/upiQrService';
import { WhatsAppAPI } from '../../utils/whatsappAPI';
import { openWhatsAppManually } from '../../utils/whatsappUtils';
import { replacePlaceholders, DEFAULT_TEMPLATES } from '../../utils/whatsappTemplates';

/**
 * Live online-payment panel.
 *
 * CCAvenue's integration is an encrypted browser form-POST and produces no
 * shareable URL, so the lab issues its own short-lived /pay/:token link. That
 * link is what this QR encodes and what WhatsApp carries — the patient scans
 * with their phone camera and pays by Card / UPI / Net Banking on their own
 * device. Settlement happens server-side via the gateway webhook, so this panel
 * only has to watch for it.
 */

interface OnlinePaymentQRProps {
  labId?: string;
  invoiceId?: string;
  orderId?: string;
  patientId?: string;
  amount: number;
  payerName?: string;
  payerPhone?: string;
  /** Shown in the WhatsApp message so the patient knows what they're paying for. */
  invoiceNumber?: string;
  orderNumber?: string;
  /** Fired once the gateway confirms; the payments row is already written. */
  onPaid?: (paymentId?: string) => void;
  onCancel?: () => void;
}

interface LinkState {
  token: string;
  url: string;
  amount: number;
  expires_at: string;
  payer_phone?: string | null;
}

const POLL_INTERVAL_MS = 4000;
const POLL_TIMEOUT_MS = 15 * 60 * 1000;

const PAY_LINK_FUNCTION = 'pay-link';

const OnlinePaymentQR: React.FC<OnlinePaymentQRProps> = ({
  labId,
  invoiceId,
  orderId,
  patientId,
  amount,
  payerName,
  payerPhone,
  invoiceNumber,
  orderNumber,
  onPaid,
  onCancel,
}) => {
  const [creating, setCreating] = useState(true);
  const [link, setLink] = useState<LinkState | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<'waiting' | 'paid' | 'failed' | 'expired' | 'timeout'>('waiting');
  const [copied, setCopied] = useState(false);
  const [sendingWhatsApp, setSendingWhatsApp] = useState(false);
  const [whatsAppNote, setWhatsAppNote] = useState<string | null>(null);

  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollStartedAt = useRef<number>(0);
  const notifiedPaid = useRef(false);

  // Callers pass inline arrows, so keep the latest in a ref rather than making
  // it an effect dependency — otherwise the poll interval resets every render.
  const onPaidRef = useRef(onPaid);
  useEffect(() => {
    onPaidRef.current = onPaid;
  }, [onPaid]);

  const stopPolling = useCallback(() => {
    if (pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  const createLink = useCallback(async () => {
    setCreating(true);
    setError(null);
    setStatus('waiting');
    notifiedPaid.current = false;

    try {
      const resolvedLabId = labId || (await database.getCurrentUserLabId());
      if (!resolvedLabId) throw new Error('Could not determine the current lab');
      if (!invoiceId && !orderId) throw new Error('An invoice is required before collecting an online payment');

      const { data, error: fnError } = await supabase.functions.invoke('create-payment-link', {
        body: {
          lab_id: resolvedLabId,
          invoice_id: invoiceId,
          order_id: orderId,
          patient_id: patientId,
          amount,
          payer_name: payerName,
          payer_phone: payerPhone,
        },
      });

      if (fnError) throw fnError;
      if (!data?.token) throw new Error(data?.error || 'Failed to create payment link');

      const next: LinkState = {
        token: data.token,
        url: data.url,
        amount: Number(data.amount),
        expires_at: data.expires_at,
        payer_phone: data.payer_phone ?? payerPhone ?? null,
      };

      setLink(next);
      setQrDataUrl(await generateLinkQRCodeDataURL(next.url, { size: 240 }));
      pollStartedAt.current = Date.now();
    } catch (err: any) {
      console.error('[OnlinePaymentQR] Failed to create link', err);
      setError(err?.message || 'Failed to create payment link');
    } finally {
      setCreating(false);
    }
  }, [labId, invoiceId, orderId, patientId, amount, payerName, payerPhone]);

  useEffect(() => {
    createLink();
    return stopPolling;
  }, [createLink, stopPolling]);

  // Poll for the gateway's verdict. The webhook does the settling; we just watch.
  useEffect(() => {
    if (!link || status !== 'waiting') return;

    const check = async () => {
      if (Date.now() - pollStartedAt.current > POLL_TIMEOUT_MS) {
        setStatus('timeout');
        stopPolling();
        return;
      }

      try {
        const { data, error: fnError } = await supabase.functions.invoke(
          `${PAY_LINK_FUNCTION}/status`,
          { body: { token: link.token } }
        );

        if (fnError || !data) return;

        if (data.status === 'paid') {
          setStatus('paid');
          stopPolling();
          if (!notifiedPaid.current) {
            notifiedPaid.current = true;
            onPaidRef.current?.(data.payment_id);
          }
        } else if (data.status === 'expired') {
          setStatus('expired');
          stopPolling();
        } else if (data.status === 'failed') {
          setStatus('failed');
          stopPolling();
        }
      } catch (err) {
        // Transient network blips shouldn't kill the poll loop.
        console.warn('[OnlinePaymentQR] Status check failed', err);
      }
    };

    pollTimer.current = setInterval(check, POLL_INTERVAL_MS);
    check();

    return stopPolling;
  }, [link, status, stopPolling]);

  const handleCopy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Could not copy the link. Please copy it manually.');
    }
  };

  const handleSendWhatsApp = async () => {
    if (!link) return;

    const phone = link.payer_phone || payerPhone;
    if (!phone) {
      setWhatsAppNote('No phone number on file for this patient.');
      return;
    }

    setSendingWhatsApp(true);
    setWhatsAppNote(null);

    try {
      const resolvedLabId = labId || (await database.getCurrentUserLabId());

      // Prefer the lab's own template; fall back to the packaged default.
      let template = DEFAULT_TEMPLATES.payment_link.message;
      try {
        const { data: custom } = await database.whatsappTemplates.getDefault('payment_link', resolvedLabId || undefined);
        if (custom?.message_content) template = custom.message_content;
      } catch {
        // Keep the default.
      }

      let labName = 'our lab';
      if (resolvedLabId) {
        const { data: lab } = await supabase.from('labs').select('name').eq('id', resolvedLabId).maybeSingle();
        if (lab?.name) labName = lab.name;
      }

      const message = replacePlaceholders(template, {
        PatientName: payerName || link.payer_phone || 'there',
        Amount: link.amount.toFixed(2),
        PaymentLink: link.url,
        InvoiceNumber: invoiceNumber || '',
        OrderNumber: orderNumber || '',
        LabName: labName,
        ExpiryTime: new Date(link.expires_at).toLocaleString('en-IN', {
          dateStyle: 'medium',
          timeStyle: 'short',
        }),
      });

      const result = await WhatsAppAPI.sendTextMessage(phone, message);

      if (result?.success) {
        setWhatsAppNote('Payment link sent on WhatsApp.');
      } else {
        // Backend session is down — fall back to the pre-filled manual link.
        const manual = await openWhatsAppManually(phone, message);
        setWhatsAppNote(
          manual.success
            ? 'Opened WhatsApp with the message pre-filled — tap Send there.'
            : result?.message || 'Could not send on WhatsApp.'
        );
        if (!manual.success) {
          setSendingWhatsApp(false);
          return;
        }
      }

      await supabase
        .from('payment_links')
        .update({ whatsapp_sent_at: new Date().toISOString(), whatsapp_sent_to: phone })
        .eq('token', link.token);
    } catch (err: any) {
      console.error('[OnlinePaymentQR] WhatsApp send failed', err);
      setWhatsAppNote(err?.message || 'Could not send on WhatsApp.');
    } finally {
      setSendingWhatsApp(false);
    }
  };

  // ---------------------------------------------------------------- render --

  if (creating) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-gray-500">
        <Loader2 className="w-8 h-8 animate-spin mb-3" />
        <p className="text-sm">Creating secure payment link…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-5">
        <div className="flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-red-600 mt-0.5 shrink-0" />
          <div className="flex-1">
            <p className="font-medium text-red-800">Could not start the online payment</p>
            <p className="text-sm text-red-700 mt-1">{error}</p>
            <div className="flex gap-2 mt-3">
              <button
                type="button"
                onClick={createLink}
                className="px-3 py-1.5 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700"
              >
                Try again
              </button>
              {onCancel && (
                <button
                  type="button"
                  onClick={onCancel}
                  className="px-3 py-1.5 text-sm bg-white border border-red-300 text-red-700 rounded-lg hover:bg-red-50"
                >
                  Use another method
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (status === 'paid') {
    return (
      <div className="bg-green-50 border border-green-200 rounded-lg p-8 text-center">
        <CheckCircle2 className="w-14 h-14 text-green-600 mx-auto mb-3" />
        <p className="text-xl font-semibold text-green-800">Payment received</p>
        <p className="text-green-700 mt-1">₹{link?.amount.toFixed(2)} has been credited to this invoice.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="bg-gray-50 border border-gray-200 rounded-lg p-5 flex flex-col items-center">
        <div className="text-sm text-gray-600">Scan to pay</div>
        <div className="text-3xl font-bold text-gray-900 mt-1 mb-4">₹{link?.amount.toFixed(2)}</div>

        {qrDataUrl && (
          <img
            src={qrDataUrl}
            alt="Scan to pay"
            className="w-56 h-56 bg-white p-2 rounded-lg border border-gray-200"
          />
        )}

        <p className="text-xs text-gray-500 mt-3 text-center max-w-xs">
          Ask the patient to scan with their phone camera. They can pay by UPI, Card or Net Banking.
        </p>

        {status === 'waiting' && (
          <div className="flex items-center gap-2 mt-4 text-sm text-blue-700">
            <Loader2 className="w-4 h-4 animate-spin" />
            Waiting for payment…
          </div>
        )}

        {status === 'failed' && (
          <div className="flex items-center gap-2 mt-4 text-sm text-red-700">
            <AlertCircle className="w-4 h-4" />
            The last attempt failed. The patient can scan again.
          </div>
        )}

        {status === 'expired' && (
          <div className="flex items-center gap-2 mt-4 text-sm text-amber-700">
            <Clock className="w-4 h-4" />
            This link has expired.
          </div>
        )}

        {status === 'timeout' && (
          <div className="flex items-center gap-2 mt-4 text-sm text-amber-700">
            <Clock className="w-4 h-4" />
            Stopped checking after 15 minutes. The link still works — refresh to resume.
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-2 px-3 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50"
        >
          {copied ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
          {copied ? 'Copied' : 'Copy link'}
        </button>

        <button
          type="button"
          onClick={handleSendWhatsApp}
          disabled={sendingWhatsApp}
          className="flex items-center gap-2 px-3 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
        >
          {sendingWhatsApp ? <Loader2 className="w-4 h-4 animate-spin" /> : <MessageCircle className="w-4 h-4" />}
          Send on WhatsApp
        </button>

        <button
          type="button"
          onClick={createLink}
          className="flex items-center gap-2 px-3 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50"
        >
          <RefreshCw className="w-4 h-4" />
          New link
        </button>

        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="flex items-center gap-2 px-3 py-2 text-sm text-gray-600 hover:text-gray-900 ml-auto"
          >
            Use another method
          </button>
        )}
      </div>

      {whatsAppNote && <p className="text-sm text-gray-600">{whatsAppNote}</p>}

      {link && (
        <p className="text-xs text-gray-400 break-all">
          {link.url} · valid until{' '}
          {new Date(link.expires_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}
        </p>
      )}
    </div>
  );
};

export default OnlinePaymentQR;
