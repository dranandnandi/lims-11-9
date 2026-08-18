/**
 * Storage URL Builder - Custom Domain Proxy for Supabase Storage
 * 
 * Replaces default Supabase storage URLs with branded custom domain URLs.
 * Currently supports 'reports' bucket with custom domain.
 * 
 * Example:
 * Old: https://scqhzbkkradflywariem.supabase.co/storage/v1/object/public/reports/ecopy/file.pdf
 * New: https://reports.limsapp.in/ecopy/file.pdf
 */

import { supabase } from './supabase';

// Custom domain for reports bucket (configured via environment variable)
const CUSTOM_REPORTS_DOMAIN = import.meta.env.VITE_CUSTOM_STORAGE_DOMAIN || '';

/**
 * Get public URL for a file in Supabase Storage
 * 
 * @param bucket - Storage bucket name (e.g., 'reports', 'lab-branding')
 * @param path - File path within the bucket
 * @returns Public URL - custom domain if configured, otherwise default Supabase URL
 */
export function getPublicStorageUrl(bucket: string, path: string): string {
  // For reports bucket, use custom domain if configured
  if (bucket === 'reports' && CUSTOM_REPORTS_DOMAIN) {
    // Clean up path (remove leading slash if present)
    const cleanPath = path.startsWith('/') ? path.slice(1) : path;
    return `${CUSTOM_REPORTS_DOMAIN}/${cleanPath}`;
  }
  
  // Fall back to default Supabase storage URL for other buckets or if custom domain not set
  const { data } = supabase.storage.from(bucket).getPublicUrl(path);
  return data.publicUrl;
}

/**
 * Check if custom domain is configured
 */
export function hasCustomDomain(bucket: string = 'reports'): boolean {
  return bucket === 'reports' && !!CUSTOM_REPORTS_DOMAIN;
}

/**
 * Get the custom domain URL (if configured)
 */
export function getCustomDomain(bucket: string = 'reports'): string | null {
  if (bucket === 'reports' && CUSTOM_REPORTS_DOMAIN) {
    return CUSTOM_REPORTS_DOMAIN;
  }
  return null;
}

/**
 * Extract file path from either custom domain or default Supabase URL
 * Useful for backward compatibility with existing URLs
 */
export function extractStoragePath(url: string, bucket: string = 'reports'): string | null {
  if (!url) return null;

  try {
    // Handle custom domain URLs
    if (CUSTOM_REPORTS_DOMAIN && url.startsWith(CUSTOM_REPORTS_DOMAIN)) {
      return url.replace(CUSTOM_REPORTS_DOMAIN + '/', '');
    }

    // Not an absolute http(s) URL (e.g. '#demo-report-<id>' placeholders, blob:, relative paths)
    if (!/^https?:\/\//i.test(url)) return null;

    // Handle default Supabase storage URLs
    const urlObj = new URL(url);
    const pathMatch = urlObj.pathname.match(/\/storage\/v1\/object\/public\/([^/]+)\/(.+)/);
    if (pathMatch && pathMatch[1] === bucket) {
      return pathMatch[2];
    }
    
    return null;
  } catch (e) {
    console.error('Failed to extract storage path from URL:', url, e);
    return null;
  }
}

/**
 * Convert any storage URL (old or new) to custom domain format
 * 
 * @param url - Existing storage URL (Supabase or custom domain)
 * @param bucket - Storage bucket name (default: 'reports')
 * @returns Converted URL with custom domain, or original URL if conversion fails
 * 
 * @example
 * // Old URL
 * convertToCustomDomain('https://scqhzbkkradflywariem.supabase.co/storage/v1/object/public/reports/ecopy/file.pdf')
 * // Returns: 'https://reports.limsapp.in/ecopy/file.pdf'
 * 
 * // Already custom domain
 * convertToCustomDomain('https://reports.limsapp.in/ecopy/file.pdf')
 * // Returns: 'https://reports.limsapp.in/ecopy/file.pdf'
 */
export function convertToCustomDomain(url: string, bucket: string = 'reports'): string {
  if (!url) return url;
  
  // If custom domain not configured, return original URL
  if (!hasCustomDomain(bucket)) return url;

  // Already using custom domain? Return as-is
  if (url.startsWith(CUSTOM_REPORTS_DOMAIN)) return url;

  // Nothing to convert for non-http(s) values (placeholders, blob:, relative paths)
  if (!/^https?:\/\//i.test(url)) return url;

  // Extract path and rebuild with custom domain
  const path = extractStoragePath(url, bucket);
  if (path) {
    return `${CUSTOM_REPORTS_DOMAIN}/${path}`;
  }
  
  // Fallback: return original URL if extraction failed
  return url;
}
