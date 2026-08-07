import React, { useCallback, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import {
  Loader2,
  ShieldCheck,
  CreditCard,
  CheckCircle2,
  XCircle,
  Clock,
  AlertCircle,
} from 'lucide-react';
import { supabase } from '../utils/supabase';

/**
 * Public payment page — /pay/:token (plus /success and /failed sub-routes).
 *
 * No session required: the link token is the credential. Tapping "Pay Now"
 * asks the pay-link function for a gateway payload and then form-POSTs the
 * browser straight to CCAvenue (or opens the Razorpay sheet). The gateway
 * bounces back through payment-callback, which settles the invoice server-side
 * and redirects here with the outcome.
 */

interface LinkMeta {
  status: string;
  amount: number;
  currency: string;
  payer_name?: string | null;
  invoice_number?: string | null;
  expires_at: string;
  expired: boolean;
  lab_name?: string | null;
  lab_city?: string | null;
  lab_phone?: string | null;
  lab_logo_url?: string | null;
}

type Outcome = 'pay' | 'success' | 'failed';

const PayLink: React.FC = () => {
  const { token } = useParams<{ token: string }>();
  const [searchParams] = useSearchParams();

  // /pay/:token, /pay/:token/success, /pay/:token/failed
  const outcome: Outcome = window.location.pathname.endsWith('/success')
    ? 'success'
    : window.location.pathname.endsWith('/failed')
      ? 'failed'
      : 'pay';

  const [loading, setLoading] = useState(true);
  const [meta, setMeta] = useState<LinkMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const failureReason = searchParams.get('reason');

  const loadMeta = useCallback(async () => {
    if (!token) {
      setError('This payment link is not valid.');
      setLoading(false);
      return;
    }

    try {
      const { data, error: fnError } = await supabase.functions.invoke('pay-link', {
        body: { token },
      });

      if (fnError) throw fnError;
      if (!data || data.error) throw new Error(data?.error || 'Payment link not found');

      setMeta(data as LinkMeta);
    } catch (err: any) {
      console.error('[PayLink] Failed to load link', err);
      setError(err?.message || 'This payment link is not valid or has expired.');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    loadMeta();
  }, [loadMeta]);

  const openRazorpayCheckout = (paymentData: any) => {
    const startCheckout = () => {
      const options = {
        key: paymentData.razorpay_key_id,
        amount: (paymentData.amount || 0) * 100,
        currency: paymentData.currency || 'INR',
        name: paymentData.name || meta?.lab_name || 'Lab Payment',
        description: paymentData.description || 'Lab invoice payment',
        order_id: paymentData.razorpay_order_id,
        prefill: paymentData.prefill,
        notes: paymentData.notes,
        handler: async (response: any) => {
          try {
            const { data, error: verifyError } = await supabase.functions.invoke('payment-callback/verify', {
              body: {
                razorpay_order_id: response.razorpay_order_id,
                razorpay_payment_id: response.razorpay_payment_id,
                razorpay_signature: response.razorpay_signature,
                payment_id: paymentData.payment_id,
              },
            });

            if (verifyError) throw verifyError;

            if (data?.success) {
              window.location.href = `/pay/${token}/success?payment_id=${paymentData.payment_id}`;
            } else {
              setError('Payment verification failed. If money was debited, please contact the lab.');
              setStarting(false);
            }
          } catch (err: any) {
            setError(err?.message || 'Payment verification failed');
            setStarting(false);
          }
        },
        modal: {
          ondismiss: () => setStarting(false),
        },
      };

      const rzp = new (window as any).Razorpay(options);
      rzp.open();
    };

    if ((window as any).Razorpay) {
      startCheckout();
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.onload = startCheckout;
    script.onerror = () => {
      setError('Could not load the payment checkout. Please try again.');
      setStarting(false);
    };
    document.body.appendChild(script);
  };

  const handlePay = async () => {
    if (!token) return;
    setStarting(true);
    setError(null);

    try {
      const { data, error: fnError } = await supabase.functions.invoke('pay-link/start', {
        body: { token },
      });

      if (fnError) throw fnError;
      if (!data || data.error) throw new Error(data?.error || 'Could not start the payment');

      // CCAvenue: encrypted form POST — a real browser navigation.
      if (data.redirect_required && data.gateway_url) {
        const form = document.createElement('form');
        form.method = data.form_method || 'POST';
        form.action = data.gateway_url;

        Object.entries(data.form_data || {}).forEach(([key, value]) => {
          const input = document.createElement('input');
          input.type = 'hidden';
          input.name = key;
          input.value = value as string;
          form.appendChild(input);
        });

        document.body.appendChild(form);
        form.submit();
        return;
      }

      if (data.razorpay_order_id) {
        openRazorpayCheckout(data);
        return;
      }

      throw new Error('The payment gateway did not return a checkout option');
    } catch (err: any) {
      console.error('[PayLink] Failed to start payment', err);
      setError(err?.message || 'Could not start the payment');
      setStarting(false);
    }
  };

  const Shell: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4 py-8">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
        {(meta?.lab_logo_url || meta?.lab_name) && (
          <div className="px-6 pt-6 pb-4 border-b border-gray-100 text-center">
            {meta.lab_logo_url && (
              <img src={meta.lab_logo_url} alt="" className="h-12 mx-auto mb-2 object-contain" />
            )}
            <div className="font-semibold text-gray-900">{meta.lab_name}</div>
            {meta.lab_city && <div className="text-xs text-gray-500">{meta.lab_city}</div>}
          </div>
        )}
        <div className="p-6">{children}</div>
      </div>
    </div>
  );

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  if (error && !meta) {
    return (
      <Shell>
        <div className="text-center py-4">
          <XCircle className="w-14 h-14 text-red-500 mx-auto mb-3" />
          <h1 className="text-lg font-semibold text-gray-900">Payment link unavailable</h1>
          <p className="text-sm text-gray-600 mt-2">{error}</p>
        </div>
      </Shell>
    );
  }

  // ------------------------------------------------------------- outcomes --

  if (outcome === 'success' || meta?.status === 'paid') {
    return (
      <Shell>
        <div className="text-center py-4">
          <CheckCircle2 className="w-16 h-16 text-green-600 mx-auto mb-3" />
          <h1 className="text-xl font-semibold text-gray-900">Payment successful</h1>
          {meta && (
            <p className="text-2xl font-bold text-gray-900 mt-2">
              ₹{Number(meta.amount).toFixed(2)}
            </p>
          )}
          {meta?.invoice_number && (
            <p className="text-sm text-gray-500 mt-1">Invoice {meta.invoice_number}</p>
          )}
          <p className="text-sm text-gray-600 mt-4">
            Thank you. Your receipt is available at the lab reception.
          </p>
          {meta?.lab_phone && (
            <p className="text-xs text-gray-400 mt-4">Questions? Call {meta.lab_phone}</p>
          )}
        </div>
      </Shell>
    );
  }

  if (outcome === 'failed') {
    return (
      <Shell>
        <div className="text-center py-4">
          <XCircle className="w-16 h-16 text-red-500 mx-auto mb-3" />
          <h1 className="text-xl font-semibold text-gray-900">Payment not completed</h1>
          <p className="text-sm text-gray-600 mt-2">
            {failureReason || 'The payment was cancelled or declined. No money has been taken.'}
          </p>
          <button
            type="button"
            onClick={() => {
              window.location.href = `/pay/${token}`;
            }}
            className="mt-5 w-full py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700"
          >
            Try again
          </button>
          {meta?.lab_phone && (
            <p className="text-xs text-gray-400 mt-4">Need help? Call {meta.lab_phone}</p>
          )}
        </div>
      </Shell>
    );
  }

  if (meta?.status === 'expired' || meta?.expired) {
    return (
      <Shell>
        <div className="text-center py-4">
          <Clock className="w-14 h-14 text-amber-500 mx-auto mb-3" />
          <h1 className="text-lg font-semibold text-gray-900">This link has expired</h1>
          <p className="text-sm text-gray-600 mt-2">
            Please ask the lab to send you a fresh payment link.
          </p>
          {meta.lab_phone && (
            <p className="text-sm text-gray-500 mt-3">Call {meta.lab_phone}</p>
          )}
        </div>
      </Shell>
    );
  }

  if (meta?.status === 'cancelled') {
    return (
      <Shell>
        <div className="text-center py-4">
          <XCircle className="w-14 h-14 text-gray-400 mx-auto mb-3" />
          <h1 className="text-lg font-semibold text-gray-900">This link was cancelled</h1>
          <p className="text-sm text-gray-600 mt-2">Please contact the lab for a new one.</p>
        </div>
      </Shell>
    );
  }

  // ------------------------------------------------------------- pay page --

  return (
    <Shell>
      <div className="text-center">
        <p className="text-sm text-gray-500">Amount payable</p>
        <p className="text-4xl font-bold text-gray-900 mt-1">
          ₹{Number(meta?.amount ?? 0).toFixed(2)}
        </p>
      </div>

      <div className="mt-5 space-y-2 text-sm">
        {meta?.payer_name && (
          <div className="flex justify-between">
            <span className="text-gray-500">Patient</span>
            <span className="text-gray-900 font-medium">{meta.payer_name}</span>
          </div>
        )}
        {meta?.invoice_number && (
          <div className="flex justify-between">
            <span className="text-gray-500">Invoice</span>
            <span className="text-gray-900 font-medium">{meta.invoice_number}</span>
          </div>
        )}
        {meta?.expires_at && (
          <div className="flex justify-between">
            <span className="text-gray-500">Valid until</span>
            <span className="text-gray-900">
              {new Date(meta.expires_at).toLocaleString('en-IN', {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}
            </span>
          </div>
        )}
      </div>

      {error && (
        <div className="mt-4 flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg p-3">
          <AlertCircle className="w-4 h-4 text-red-600 mt-0.5 shrink-0" />
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      <button
        type="button"
        onClick={handlePay}
        disabled={starting}
        className="mt-6 w-full py-3.5 bg-blue-600 text-white rounded-lg font-semibold text-base hover:bg-blue-700 disabled:opacity-60 flex items-center justify-center gap-2"
      >
        {starting ? (
          <>
            <Loader2 className="w-5 h-5 animate-spin" />
            Opening secure checkout…
          </>
        ) : (
          <>
            <CreditCard className="w-5 h-5" />
            Pay ₹{Number(meta?.amount ?? 0).toFixed(2)}
          </>
        )}
      </button>

      <div className="mt-4 flex items-center justify-center gap-1.5 text-xs text-gray-400">
        <ShieldCheck className="w-3.5 h-3.5" />
        Card · UPI · Net Banking — processed on a secure gateway
      </div>
    </Shell>
  );
};

export default PayLink;
