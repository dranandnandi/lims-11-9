// Shared payment-provider primitives.
//
// Extracted verbatim from initiate-payment/index.ts so that B2B credit payments
// and patient pay-links share exactly one CCAvenue/Razorpay implementation.
// Consumed by: initiate-payment, pay-link.

import { crypto } from "https://deno.land/std@0.208.0/crypto/mod.ts";
import { encodeHex } from "https://deno.land/std@0.208.0/encoding/hex.ts";

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/** Whoever is paying — a B2B account or a patient. */
export interface PayerDetails {
  name: string;
  email?: string | null;
  phone?: string | null;
}

/** Extra context threaded into the gateway request. */
export interface GatewayOptions {
  /** payment_links.token — comes back as merchant_param4 so the callback can find the link. */
  linkToken?: string | null;
  /** Shown on the Razorpay checkout sheet. */
  description?: string;
  /** Razorpay checkout heading. */
  title?: string;
}

// CCAvenue encryption helper
export async function encryptCCAvenue(plainText: string, workingKey: string): Promise<string> {
  // CCAvenue uses AES-128-CBC encryption
  // Key is MD5 hash of working key
  const encoder = new TextEncoder();

  // Generate MD5 hash of working key
  const keyData = encoder.encode(workingKey);
  const hashBuffer = await crypto.subtle.digest('MD5', keyData);
  const key = new Uint8Array(hashBuffer);

  // CCAvenue's integration kits use a fixed IV: 00 01 02 ... 0f.
  const iv = new Uint8Array(16);
  for (let i = 0; i < iv.length; i++) iv[i] = i;

  // Import the key
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'AES-CBC' },
    false,
    ['encrypt']
  );

  // Pad the plaintext (PKCS7 padding)
  const blockSize = 16;
  const plainBytes = encoder.encode(plainText);
  const paddingLength = blockSize - (plainBytes.length % blockSize);
  const paddedPlain = new Uint8Array(plainBytes.length + paddingLength);
  paddedPlain.set(plainBytes);
  paddedPlain.fill(paddingLength, plainBytes.length);

  // Encrypt
  const encryptedBuffer = await crypto.subtle.encrypt(
    { name: 'AES-CBC', iv },
    cryptoKey,
    paddedPlain
  );

  // Return as hex string
  return encodeHex(new Uint8Array(encryptedBuffer));
}

// Generate unique order ID
export function generateOrderId(prefix: string = 'PAY'): string {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `${prefix}${timestamp}${random}`;
}

/** URL-safe opaque token for a payment link. */
export function generateLinkToken(byteLength: number = 16): string {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// CCAvenue payment handler
export async function handleCCAvenue(
  gateway: Record<string, unknown>,
  credentials: Record<string, unknown>,
  paymentAttempt: Record<string, unknown>,
  payer: PayerDetails,
  amount: number,
  redirectUrl?: string,
  cancelUrl?: string,
  options: GatewayOptions = {}
): Promise<Record<string, unknown>> {
  const merchantId = credentials.merchant_id as string;
  const accessCode = credentials.access_code as string;
  const workingKey = credentials.working_key as string;

  if (!merchantId || !accessCode || !workingKey) {
    throw new Error('CCAvenue credentials not properly configured');
  }

  const environment = gateway.environment as string;
  const baseUrl = environment === 'production'
    ? 'https://secure.ccavenue.com'
    : 'https://test.ccavenue.com';

  // merchant_param2 carries whichever id the callback needs to settle against:
  // the B2B account for credit payments, the invoice for patient payments.
  const settlementRef = (paymentAttempt.payer_type === 'patient'
    ? (paymentAttempt.invoice_id ?? paymentAttempt.order_id)
    : paymentAttempt.account_id) as string | undefined;

  // Build CCAvenue request parameters
  const orderParams: Record<string, string> = {
    merchant_id: merchantId,
    order_id: paymentAttempt.gateway_order_id as string,
    currency: 'INR',
    amount: amount.toFixed(2),
    redirect_url: redirectUrl || '',
    cancel_url: cancelUrl || '',
    language: 'EN',
    billing_name: payer.name || 'Customer',
    billing_address: 'NA',
    billing_city: 'NA',
    billing_state: 'NA',
    billing_zip: '000000',
    billing_country: 'India',
    billing_email: payer.email || '',
    billing_tel: payer.phone || '',
    merchant_param1: paymentAttempt.id as string, // Our payment attempt ID
    merchant_param2: settlementRef || '',
    merchant_param3: paymentAttempt.payment_purpose as string || 'credit_topup',
    merchant_param4: options.linkToken || '',
  };

  // Convert to query string
  const queryString = Object.entries(orderParams)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');

  // Encrypt the data
  const encryptedData = await encryptCCAvenue(queryString, workingKey);

  return {
    gateway_url: `${baseUrl}/transaction/transaction.do?command=initiateTransaction`,
    form_method: 'POST',
    form_data: {
      encRequest: encryptedData,
      access_code: accessCode
    },
    redirect_required: true
  };
}

// Razorpay payment handler
export async function handleRazorpay(
  _gateway: Record<string, unknown>,
  credentials: Record<string, unknown>,
  paymentAttempt: Record<string, unknown>,
  payer: PayerDetails,
  amount: number,
  options: GatewayOptions = {}
): Promise<Record<string, unknown>> {
  const keyId = credentials.key_id as string;
  const keySecret = credentials.key_secret as string;

  if (!keyId || !keySecret) {
    throw new Error('Razorpay credentials not properly configured');
  }

  // Create Razorpay order
  const razorpayResponse = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Basic ' + btoa(`${keyId}:${keySecret}`)
    },
    body: JSON.stringify({
      amount: Math.round(amount * 100), // Razorpay expects amount in paise
      currency: 'INR',
      receipt: paymentAttempt.gateway_order_id as string,
      notes: {
        payment_id: paymentAttempt.id as string,
        account_id: (paymentAttempt.account_id as string) ?? '',
        invoice_id: (paymentAttempt.invoice_id as string) ?? '',
        link_token: options.linkToken ?? '',
        purpose: paymentAttempt.payment_purpose as string
      }
    })
  });

  if (!razorpayResponse.ok) {
    const error = await razorpayResponse.text();
    console.error('[PAYMENT] Razorpay error:', error);
    throw new Error('Failed to create Razorpay order');
  }

  const razorpayOrder = await razorpayResponse.json();

  return {
    razorpay_order_id: razorpayOrder.id,
    razorpay_key_id: keyId,
    amount: amount,
    currency: 'INR',
    name: options.title || 'Credit Payment',
    description: options.description || `Payment for ${payer.name}`,
    prefill: {
      name: payer.name,
      email: payer.email ?? '',
      contact: payer.phone ?? ''
    },
    notes: {
      payment_id: paymentAttempt.id,
      account_id: paymentAttempt.account_id ?? '',
      invoice_id: paymentAttempt.invoice_id ?? '',
      link_token: options.linkToken ?? ''
    },
    redirect_required: false // Razorpay uses client-side checkout
  };
}
