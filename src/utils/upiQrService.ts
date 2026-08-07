/**
 * UPI QR Code Generation Service
 * 
 * Generates static UPI payment QR codes for invoices.
 * No external API needed - uses standard UPI deep link format.
 * 
 * UPI Link Format:
 * upi://pay?pa=UPI_ID&pn=BUSINESS_NAME&am=AMOUNT&cu=INR&tn=TRANSACTION_NOTE
 * 
 * Supported Apps: PhonePe, Google Pay, Paytm, BHIM, Amazon Pay, etc.
 */

import QRCode from 'qrcode';

export interface UPIPaymentDetails {
  /** UPI VPA (Virtual Payment Address) e.g., business@paytm, lab@ybl */
  upiId: string;
  /** Business/Payee name (displayed in payment app) */
  payeeName: string;
  /** Amount in INR (optional - user can modify if not set) */
  amount?: number;
  /** Transaction/Reference note (e.g., Invoice number) */
  transactionNote?: string;
  /** Transaction reference ID (optional) */
  transactionRefId?: string;
  /** Merchant category code (optional) */
  merchantCode?: string;
}

export interface QRCodeOptions {
  /** Width/Height in pixels (default: 150) */
  size?: number;
  /** Margin around QR code (default: 1) */
  margin?: number;
  /** Error correction level: L, M, Q, H (default: M) */
  errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
  /** Output format */
  format?: 'dataURL' | 'svg' | 'utf8';
  /** Dark color (default: #000000) */
  darkColor?: string;
  /** Light color (default: #ffffff) */
  lightColor?: string;
}

/**
 * Generate UPI payment deep link URL
 * This URL can be used to trigger UPI payment apps
 */
export function generateUPIPaymentLink(details: UPIPaymentDetails): string {
  const params = new URLSearchParams();
  
  // Required: Payee VPA (UPI ID)
  params.set('pa', details.upiId);
  
  // Required: Payee name
  params.set('pn', details.payeeName);
  
  // Optional: Amount (if set, some apps won't allow modification)
  if (details.amount && details.amount > 0) {
    params.set('am', details.amount.toFixed(2));
  }
  
  // Currency (always INR for India)
  params.set('cu', 'INR');
  
  // Optional: Transaction note (shown in payment history)
  if (details.transactionNote) {
    params.set('tn', details.transactionNote);
  }
  
  // Optional: Transaction reference ID
  if (details.transactionRefId) {
    params.set('tr', details.transactionRefId);
  }
  
  // Optional: Merchant category code
  if (details.merchantCode) {
    params.set('mc', details.merchantCode);
  }
  
  return `upi://pay?${params.toString()}`;
}

/**
 * Generate UPI QR code as Data URL (base64 image)
 * Can be directly used in <img src="..."> tags
 */
export async function generateUPIQRCodeDataURL(
  details: UPIPaymentDetails,
  options: QRCodeOptions = {}
): Promise<string> {
  const upiLink = generateUPIPaymentLink(details);
  
  const qrOptions = {
    width: options.size || 150,
    margin: options.margin ?? 1,
    errorCorrectionLevel: options.errorCorrectionLevel || 'M',
    color: {
      dark: options.darkColor || '#000000',
      light: options.lightColor || '#ffffff',
    },
  };
  
  try {
    const dataURL = await QRCode.toDataURL(upiLink, qrOptions);
    return dataURL;
  } catch (error) {
    console.error('Failed to generate UPI QR code:', error);
    throw new Error('Failed to generate UPI QR code');
  }
}

/**
 * Generate a QR code for an arbitrary URL as a Data URL.
 *
 * Used for gateway pay links (/pay/:token). Unlike the UPI QRs above, this one
 * is not a `upi://` intent — CCAvenue's integration is an encrypted form POST
 * and exposes no shareable URL of its own, so we encode our own pay page and
 * let the patient's browser take it from there (card / UPI / netbanking).
 */
export async function generateLinkQRCodeDataURL(
  url: string,
  options: QRCodeOptions = {}
): Promise<string> {
  const qrOptions = {
    width: options.size || 220,
    margin: options.margin ?? 1,
    errorCorrectionLevel: options.errorCorrectionLevel || 'M',
    color: {
      dark: options.darkColor || '#000000',
      light: options.lightColor || '#ffffff',
    },
  };

  try {
    return await QRCode.toDataURL(url, qrOptions);
  } catch (error) {
    console.error('Failed to generate payment link QR code:', error);
    throw new Error('Failed to generate payment link QR code');
  }
}

/**
 * Generate UPI QR code as SVG string
 * Better for high-resolution printing
 */
export async function generateUPIQRCodeSVG(
  details: UPIPaymentDetails,
  options: QRCodeOptions = {}
): Promise<string> {
  const upiLink = generateUPIPaymentLink(details);
  
  const qrOptions = {
    width: options.size || 150,
    margin: options.margin ?? 1,
    errorCorrectionLevel: options.errorCorrectionLevel || 'M',
    color: {
      dark: options.darkColor || '#000000',
      light: options.lightColor || '#ffffff',
    },
  };
  
  try {
    const svg = await QRCode.toString(upiLink, { ...qrOptions, type: 'svg' });
    return svg;
  } catch (error) {
    console.error('Failed to generate UPI QR SVG:', error);
    throw new Error('Failed to generate UPI QR SVG');
  }
}

/**
 * Generate complete UPI payment HTML block with QR code
 * Ready to embed in invoices
 */
export async function generateUPIPaymentBlock(
  details: UPIPaymentDetails,
  options: {
    size?: number;
    showAmount?: boolean;
    showUpiId?: boolean;
    title?: string;
    compact?: boolean;
  } = {}
): Promise<string> {
  const {
    size = 120,
    showAmount = true,
    showUpiId = true,
    title = 'Scan to Pay',
    compact = false,
  } = options;
  
  const qrDataURL = await generateUPIQRCodeDataURL(details, { size });
  
  if (compact) {
    // Compact version for thermal receipts
    return `
      <div style="text-align: center; margin: 8px 0;">
        <div style="font-size: 10px; font-weight: bold; margin-bottom: 4px;">${title}</div>
        <img src="${qrDataURL}" alt="UPI QR Code" style="width: ${size}px; height: ${size}px;" />
        ${showUpiId ? `<div style="font-size: 9px; margin-top: 2px;">${details.upiId}</div>` : ''}
        ${showAmount && details.amount ? `<div style="font-size: 11px; font-weight: bold;">₹${details.amount.toFixed(2)}</div>` : ''}
      </div>
    `;
  }
  
  // Full version for A4 invoices
  return `
    <div class="upi-payment-block" style="text-align: center; padding: 15px; border: 2px solid #e5e7eb; border-radius: 8px; background: #f9fafb;">
      <div style="font-size: 14px; font-weight: 600; color: #374151; margin-bottom: 10px;">${title}</div>
      <img src="${qrDataURL}" alt="UPI QR Code" style="width: ${size}px; height: ${size}px; margin: 0 auto;" />
      ${showUpiId ? `
        <div style="font-size: 12px; color: #6b7280; margin-top: 8px;">
          UPI ID: <strong>${details.upiId}</strong>
        </div>
      ` : ''}
      ${showAmount && details.amount ? `
        <div style="font-size: 16px; font-weight: bold; color: #059669; margin-top: 5px;">
          Pay ₹${details.amount.toFixed(2)}
        </div>
      ` : ''}
      <div style="font-size: 10px; color: #9ca3af; margin-top: 8px;">
        PhonePe • Google Pay • Paytm • BHIM
      </div>
    </div>
  `;
}

/**
 * Validate UPI ID format
 * Format: username@provider (e.g., business@paytm, shop@ybl)
 */
export function isValidUPIId(upiId: string): boolean {
  if (!upiId || typeof upiId !== 'string') return false;
  
  // UPI ID format: localpart@provider
  // Provider examples: paytm, ybl, okicici, oksbi, apl, etc.
  const upiRegex = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9]+$/;
  return upiRegex.test(upiId);
}

/**
 * Extract UPI ID from various formats
 * Handles: upi://..., just the ID, with spaces, etc.
 */
export function normalizeUPIId(input: string): string | null {
  if (!input) return null;
  
  // If it's a UPI URL, extract the pa parameter
  if (input.startsWith('upi://')) {
    try {
      const url = new URL(input);
      return url.searchParams.get('pa');
    } catch {
      return null;
    }
  }
  
  // Clean and validate
  const cleaned = input.trim().toLowerCase();
  return isValidUPIId(cleaned) ? cleaned : null;
}
