// Simplified Helper: Fetch Letterhead Background Image URL
// Returns ImageKit URL for full-page letterhead background
// Supports priority: B2B Account > Location > Lab

/**
 * Fetch letterhead background image URL for an order
 * Priority: B2B Account > Location > Lab
 * Returns ImageKit URL to be used as full-page background
 */
export async function fetchLetterheadBackgroundForOrder(
  supabase: any,
  orderId: string,
  labId: string
): Promise<string | null> {
  try {
    console.log('[LETTERHEAD] Fetching letterhead for order:', orderId);

    // 1. Get order details to determine priority (account_id, location_id)
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('account_id, location_id')
      .eq('id', orderId)
      .single();

    if (orderError) {
      console.log('[LETTERHEAD] Error fetching order:', orderError.message);
      // Fall back to lab-level
      return fetchLetterheadBackground(supabase, labId);
    }

    console.log('[LETTERHEAD] Order context:', {
      orderId,
      account_id: order?.account_id,
      location_id: order?.location_id,
      lab_id: labId
    });

    // 2. Priority 1: Try B2B account-specific header (using attachments table)
    if (order?.account_id) {
      const accountHeader = await getAttachmentImageUrl(
        supabase,
        'account',
        order.account_id
      );
      
      if (accountHeader) {
        console.log('[LETTERHEAD] Using B2B account header');
        return accountHeader;
      }
    }

    // 3. Priority 2: Try location-specific header (using attachments table)
    if (order?.location_id) {
      const locationHeader = await getAttachmentImageUrl(
        supabase,
        'location',
        order.location_id
      );
      
      if (locationHeader) {
        console.log('[LETTERHEAD] Using location header');
        return locationHeader;
      }
    }

    // 4. Priority 3: Try lab-level header from attachments table (set via HeaderFooterUpload)
    const labAttachmentHeader = await getAttachmentImageUrl(supabase, 'lab', labId);
    if (labAttachmentHeader) {
      console.log('[LETTERHEAD] Using lab attachment header');
      return labAttachmentHeader;
    }

    // 5. Priority 4: Fall back to lab_branding_assets table
    console.log('[LETTERHEAD] Falling back to lab-level branding assets');
    return fetchLetterheadBackground(supabase, labId);

  } catch (error) {
    console.error('[LETTERHEAD] Error fetching letterhead for order:', error);
    // Fall back to lab-level
    return fetchLetterheadBackground(supabase, labId);
  }
}

export type LetterheadMode = 'background' | 'header_footer';

export interface ReportBranding {
  /** Which rendering style won for this order */
  mode: LetterheadMode;
  /** Which entity supplied the branding */
  source: 'account' | 'location' | 'lab';
  /** Full-page A4 background image (only in 'background' mode) */
  letterheadUrl: string | null;
  /** Top strip image (only in 'header_footer' mode) */
  headerUrl: string | null;
  /** Bottom strip image (only in 'header_footer' mode) */
  footerUrl: string | null;
}

/**
 * Read an entity's own letterhead mode override.
 * Returns null when the entity inherits (or when the column is not deployed yet).
 */
async function getEntityLetterheadMode(
  supabase: any,
  table: 'locations' | 'accounts' | 'labs',
  id: string
): Promise<LetterheadMode | null> {
  try {
    const { data, error } = await supabase
      .from(table)
      .select('pdf_letterhead_mode')
      .eq('id', id)
      .maybeSingle();

    if (error || !data) return null;
    const mode = data.pdf_letterhead_mode;
    return mode === 'background' || mode === 'header_footer' ? mode : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the complete report branding for an order in a single pass.
 *
 * Priority for WHICH entity's artwork is used: B2B Account > Location > Lab.
 * The winning entity also decides HOW its artwork is rendered:
 *   - explicit `pdf_letterhead_mode` on that entity wins;
 *   - otherwise auto-detect: a footer image implies separate header/footer strips,
 *     while a header image on its own is treated as a full-page letterhead
 *     (matching how the lab-level default letterhead behaves);
 *   - the lab always follows its own `labs.pdf_letterhead_mode` setting.
 *
 * Any image the winning entity does not supply falls back to the lab's artwork,
 * so a location can override just the header and keep the lab footer.
 */
export async function resolveReportBranding(
  supabase: any,
  orderId: string,
  labId: string
): Promise<ReportBranding> {
  const labMode = (await getEntityLetterheadMode(supabase, 'labs', labId)) || 'background';

  const labFallback = async (): Promise<ReportBranding> => {
    if (labMode === 'header_footer') {
      const headerUrl = (await getAttachmentImageUrl(supabase, 'lab', labId, 'header')) ||
        (await fetchLabAssetUrl(supabase, labId, 'header'));
      const footerUrl = (await getAttachmentImageUrl(supabase, 'lab', labId, 'footer')) ||
        (await fetchLabAssetUrl(supabase, labId, 'footer'));
      return { mode: 'header_footer', source: 'lab', letterheadUrl: null, headerUrl, footerUrl };
    }

    const letterheadUrl = (await getAttachmentImageUrl(supabase, 'lab', labId, 'header')) ||
      (await fetchLetterheadBackground(supabase, labId));
    return { mode: 'background', source: 'lab', letterheadUrl, headerUrl: null, footerUrl: null };
  };

  try {
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('account_id, location_id')
      .eq('id', orderId)
      .single();

    if (orderError) {
      console.log('[BRANDING] Could not read order, falling back to lab branding:', orderError.message);
      return labFallback();
    }

    console.log('[BRANDING] Order context:', {
      orderId,
      account_id: order?.account_id,
      location_id: order?.location_id,
      lab_id: labId,
      labMode,
    });

    const candidates: Array<{
      source: 'account' | 'location';
      entityType: 'account' | 'location';
      table: 'accounts' | 'locations';
      id: string;
    }> = [];

    if (order?.account_id) {
      candidates.push({ source: 'account', entityType: 'account', table: 'accounts', id: order.account_id });
    }
    if (order?.location_id) {
      candidates.push({ source: 'location', entityType: 'location', table: 'locations', id: order.location_id });
    }

    for (const candidate of candidates) {
      const [ownHeader, ownFooter] = await Promise.all([
        getAttachmentImageUrl(supabase, candidate.entityType, candidate.id, 'header'),
        getAttachmentImageUrl(supabase, candidate.entityType, candidate.id, 'footer'),
      ]);

      // Nothing uploaded for this entity - let the next candidate (or the lab) win.
      if (!ownHeader && !ownFooter) continue;

      const explicitMode = await getEntityLetterheadMode(supabase, candidate.table, candidate.id);
      const mode: LetterheadMode = explicitMode || (ownFooter ? 'header_footer' : 'background');

      console.log(`[BRANDING] Using ${candidate.source} branding`, {
        mode,
        explicitMode: explicitMode || 'auto',
        hasHeader: !!ownHeader,
        hasFooter: !!ownFooter,
      });

      if (mode === 'header_footer') {
        const headerUrl = ownHeader ||
          (await getAttachmentImageUrl(supabase, 'lab', labId, 'header')) ||
          (await fetchLabAssetUrl(supabase, labId, 'header'));
        const footerUrl = ownFooter ||
          (await getAttachmentImageUrl(supabase, 'lab', labId, 'footer')) ||
          (await fetchLabAssetUrl(supabase, labId, 'footer'));
        return { mode, source: candidate.source, letterheadUrl: null, headerUrl, footerUrl };
      }

      // Full-page letterhead: the header upload IS the whole page.
      const letterheadUrl = ownHeader ||
        (await getAttachmentImageUrl(supabase, 'lab', labId, 'header')) ||
        (await fetchLetterheadBackground(supabase, labId));
      return { mode, source: candidate.source, letterheadUrl, headerUrl: null, footerUrl: null };
    }

    return labFallback();
  } catch (error) {
    console.error('[BRANDING] Error resolving report branding:', error);
    return labFallback();
  }
}

/**
 * Get header image URL from ATTACHMENTS table (for location/account)
 */
async function getAttachmentImageUrl(
  supabase: any,
  entityType: string,
  entityId: string,
  attachmentType: 'header' | 'footer' = 'header'
): Promise<string | null> {
  try {
    const { data: attachment, error } = await supabase
      .from('attachments')
      .select('file_url, imagekit_url, mime_type')
      .eq('entity_type', entityType)
      .eq('entity_id', entityId)
      .eq('attachment_type', attachmentType)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (error || !attachment) {
      console.log(`[LETTERHEAD] No ${entityType} ${attachmentType} found`);
      return null;
    }

    // Prefer ImageKit URL for better performance
    const headerUrl = attachment.imagekit_url || attachment.file_url;
    console.log(`[LETTERHEAD] Found ${entityType} ${attachmentType}:`, headerUrl);
    return headerUrl;

  } catch (error) {
    console.error(`[LETTERHEAD] Error getting ${entityType} attachment:`, error);
    return null;
  }
}

/**
 * Fetch letterhead background image URL for a lab (fallback)
 * Returns ImageKit URL to be used as full-page background
 */
export async function fetchLetterheadBackground(
  supabase: any,
  labId: string
): Promise<string | null> {
  try {
    console.log('[LETTERHEAD] Fetching letterhead background for lab:', labId);

    const { data: asset, error } = await supabase
      .from('lab_branding_assets')
      .select('imagekit_url, file_url, asset_name')
      .eq('lab_id', labId)
      .eq('asset_type', 'header')  // Using 'header' type for letterhead
      .eq('is_active', true)
      .eq('is_default', true)
      .single();

    if (error) {
      console.log('[LETTERHEAD] No letterhead found:', error.message);
      return null;
    }

    if (!asset) {
      console.log('[LETTERHEAD] No default letterhead asset found');
      return null;
    }

    // Prefer ImageKit URL for better performance and transformations
    const letterheadUrl = asset.imagekit_url || asset.file_url;

    console.log('[LETTERHEAD] Found letterhead:', {
      name: asset.asset_name,
      url: letterheadUrl,
      isImageKit: !!asset.imagekit_url
    });

    return letterheadUrl;

  } catch (error) {
    console.error('[LETTERHEAD] Error fetching letterhead:', error);
    return null;
  }
}

/**
 * Fetch front and last page branding for a lab
 * (Keeping this for compatibility)
 */
export async function fetchFrontBackPages(
  supabase: any,
  labId: string
): Promise<{ frontPage: string | null; lastPage: string | null }> {
  try {
    const { data: assets, error } = await supabase
      .from('lab_branding_assets')
      .select('asset_type, file_url, imagekit_url')
      .eq('lab_id', labId)
      .eq('is_active', true)
      .eq('is_default', true)
      .in('asset_type', ['front_page', 'last_page']);

    if (error) {
      console.error('[FRONT/BACK] Error fetching branding pages:', error);
      return { frontPage: null, lastPage: null };
    }

    const frontPageAsset = assets?.find((a: any) => a.asset_type === 'front_page');
    const lastPageAsset = assets?.find((a: any) => a.asset_type === 'last_page');

    const frontPage = frontPageAsset ? await wrapImageInFullPageHTML(
      frontPageAsset.imagekit_url || frontPageAsset.file_url
    ) : null;
    
    const lastPage = lastPageAsset ? await wrapImageInFullPageHTML(
      lastPageAsset.imagekit_url || lastPageAsset.file_url
    ) : null;

    console.log('[FRONT/BACK] Fetched pages:', {
      hasFront: !!frontPage,
      hasLast: !!lastPage
    });

    return { frontPage, lastPage };

  } catch (error) {
    console.error('[FRONT/BACK] Unexpected error:', error);
    return { frontPage: null, lastPage: null };
  }
}

/**
 * Helper to wrap full page image in HTML content (NOT a full document)
 * This generates just the content div that can be injected into an existing HTML document
 */
function wrapImageInFullPageHTML(url: string): string {
  return `
<style>
  .full-page-branding {
    width: 210mm;
    height: 297mm;
    margin: 0;
    padding: 0;
    position: relative;
    overflow: hidden;
    background-image: url('${url}');
    background-size: 210mm 297mm;
    background-position: top left;
    background-repeat: no-repeat;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
</style>
<div class="full-page-branding"></div>`;
}

/**
 * Fetch separate header and footer image URLs for an order
 * Used in 'header_footer' mode where header/footer are sent as separate images to PDF.co
 * Priority: B2B Account > Location > Lab (same as letterhead)
 */
export async function fetchHeaderFooterImages(
  supabase: any,
  orderId: string,
  labId: string
): Promise<{ headerUrl: string | null; footerUrl: string | null }> {
  try {
    console.log('[HEADER_FOOTER] Fetching separate header/footer images for order:', orderId);

    // Get order details for priority resolution
    const { data: order } = await supabase
      .from('orders')
      .select('account_id, location_id')
      .eq('id', orderId)
      .single();

    // Try B2B account-level first - an account footer overrides the lab footer
    if (order?.account_id) {
      const [accountHeader, accountFooter] = await Promise.all([
        getAttachmentImageUrl(supabase, 'account', order.account_id, 'header'),
        getAttachmentImageUrl(supabase, 'account', order.account_id, 'footer'),
      ]);
      if (accountHeader || accountFooter) {
        const footerUrl = accountFooter || await fetchLabAssetUrl(supabase, labId, 'footer');
        const headerUrl = accountHeader || await fetchLabAssetUrl(supabase, labId, 'header');
        console.log('[HEADER_FOOTER] Using B2B account header/footer', {
          ownHeader: !!accountHeader,
          ownFooter: !!accountFooter,
        });
        return { headerUrl, footerUrl };
      }
    }

    // Try location-level - a location footer overrides the lab footer
    if (order?.location_id) {
      const [locationHeader, locationFooter] = await Promise.all([
        getAttachmentImageUrl(supabase, 'location', order.location_id, 'header'),
        getAttachmentImageUrl(supabase, 'location', order.location_id, 'footer'),
      ]);
      if (locationHeader || locationFooter) {
        const footerUrl = locationFooter || await fetchLabAssetUrl(supabase, labId, 'footer');
        const headerUrl = locationHeader || await fetchLabAssetUrl(supabase, labId, 'header');
        console.log('[HEADER_FOOTER] Using location header/footer', {
          ownHeader: !!locationHeader,
          ownFooter: !!locationFooter,
        });
        return { headerUrl, footerUrl };
      }
    }

    // Fall back to lab-level header + footer
    const headerUrl = await fetchLabAssetUrl(supabase, labId, 'header');
    const footerUrl = await fetchLabAssetUrl(supabase, labId, 'footer');
    console.log('[HEADER_FOOTER] Using lab-level header/footer:', { hasHeader: !!headerUrl, hasFooter: !!footerUrl });
    return { headerUrl, footerUrl };

  } catch (error) {
    console.error('[HEADER_FOOTER] Error fetching header/footer images:', error);
    return { headerUrl: null, footerUrl: null };
  }
}

/**
 * Fetch a specific asset URL from lab_branding_assets by type
 */
async function fetchLabAssetUrl(
  supabase: any,
  labId: string,
  assetType: string
): Promise<string | null> {
  try {
    const { data: asset, error } = await supabase
      .from('lab_branding_assets')
      .select('imagekit_url, file_url')
      .eq('lab_id', labId)
      .eq('asset_type', assetType)
      .eq('is_active', true)
      .eq('is_default', true)
      .single();

    if (error || !asset) return null;
    return asset.imagekit_url || asset.file_url;
  } catch {
    return null;
  }
}

/**
 * Convert an image URL to a base64 data URI with error handling and timeout
 * Returns null if conversion fails (caller should fall back gracefully)
 */
export async function imageUrlToBase64(
  url: string,
  timeoutMs: number = 8000
): Promise<string | null> {
  if (!url) return null;

  try {
    console.log('[BASE64] Converting image to base64:', url.substring(0, 80) + '...');
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(url, { 
      signal: controller.signal,
      headers: { 'Accept': 'image/*' }
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      console.warn('[BASE64] Failed to fetch image:', response.status, response.statusText);
      return null;
    }

    const contentType = response.headers.get('content-type') || 'image/png';
    const arrayBuffer = await response.arrayBuffer();
    
    // Size check: skip if > 5MB (PDF.co header/footer has limits)
    if (arrayBuffer.byteLength > 5 * 1024 * 1024) {
      console.warn('[BASE64] Image too large for base64 conversion:', 
        (arrayBuffer.byteLength / 1024 / 1024).toFixed(1) + 'MB');
      return null;
    }

    // Convert to base64
    const uint8Array = new Uint8Array(arrayBuffer);
    let binary = '';
    for (let i = 0; i < uint8Array.length; i++) {
      binary += String.fromCharCode(uint8Array[i]);
    }
    const base64 = btoa(binary);
    const dataUri = `data:${contentType};base64,${base64}`;

    console.log('[BASE64] Conversion successful:', 
      (arrayBuffer.byteLength / 1024).toFixed(0) + 'KB',
      '→ data URI length:', dataUri.length);
    return dataUri;

  } catch (error: any) {
    if (error.name === 'AbortError') {
      console.warn('[BASE64] Image fetch timed out after', timeoutMs + 'ms');
    } else {
      console.warn('[BASE64] Image conversion failed:', error.message);
    }
    return null;
  }
}

/**
 * Prefer an optimized direct ImageKit URL for PDF.co header/footer images.
 * Native PDF.co header/footer rendering is happier with normal URLs than very large data URIs.
 */
export function optimizeHeaderFooterImageUrl(
  url: string,
  type: 'header' | 'footer',
  heightPx: number
): string {
  if (!url || !url.includes('ik.imagekit.io')) {
    return url;
  }

  try {
    const safeHeight = Math.max(120, Math.min(480, Math.round(heightPx * 3)));
    const width = type === 'header' ? 2480 : 2200;
    const transform = `tr:w-${width},h-${safeHeight},c-at_max,f-png`;

    if (url.includes('/tr:')) {
      return url.replace(/\/tr:[^/]+/, `/${transform}`);
    }

    return url.replace(/(ik\.imagekit\.io\/[^/]+)/, `$1/${transform}`);
  } catch (error) {
    console.warn(`[HEADER_FOOTER] Failed to optimize ${type} image URL:`, error);
    return url;
  }
}

/**
 * Build header HTML for PDF.co native header section
 * Uses base64 data URI or falls back to direct URL
 */
export function buildHeaderHtml(
  imageUrl: string,
  height: number = 90,
  sideMargins: { left: number; right: number } = { left: 20, right: 20 }
): string {
  if (!imageUrl) return '';
  const bleedWidth = sideMargins.left + sideMargins.right;
  return `<div style="width: calc(100% + ${bleedWidth}px); height: ${height}px; margin: 0 0 0 -${sideMargins.left}px; padding: 0; overflow: hidden; background: #ffffff;">
    <img src="${imageUrl}" style="display: block; width: 100%; height: ${height}px; object-fit: cover; object-position: center top; margin: 0; padding: 0; border: 0;" />
  </div>`;
}

/**
 * Build footer HTML for PDF.co native footer section
 * Uses base64 data URI or falls back to direct URL
 */
export function buildFooterHtml(
  imageUrl: string,
  height: number = 80,
  sideMargins: { left: number; right: number } = { left: 20, right: 20 }
): string {
  if (!imageUrl) return '';
  const bleedWidth = sideMargins.left + sideMargins.right;
  return `<div style="width: calc(100% + ${bleedWidth}px); height: ${height}px; margin: 0 0 0 -${sideMargins.left}px; padding: 0; overflow: hidden; background: #ffffff;">
    <img src="${imageUrl}" style="display: block; width: 100%; height: ${height}px; object-fit: cover; object-position: center bottom; margin: 0; padding: 0; border: 0;" />
  </div>`;
}

/**
 * DEPRECATED: No longer fetching separate header/footer
 * Keeping for backward compatibility but returns null
 */
export async function fetchHeaderFooter(
  supabase: any,
  orderId: string,
  type: 'header' | 'footer'
): Promise<string | null> {
  console.log(`[HEADER/FOOTER] Deprecated - using letterhead background instead of ${type}`);
  return null;
}

/**
 * Replace template variables in HTML
 */
export function replaceTemplateVariables(
  html: string,
  variables: Record<string, string>
): string {
  let result = html;
  
  for (const [key, value] of Object.entries(variables)) {
    const placeholder = `{{${key}}}`;
    result = result.replace(new RegExp(placeholder, 'g'), value || '');
  }
  
  return result;
}

/**
 * Get default header HTML (fallback) - NOT USED with letterhead approach
 */
export function getDefaultHeaderHTML(labInfo: any): string {
  return '';
}

/**
 * Get default footer HTML (fallback) - NOT USED with letterhead approach
 */
export function getDefaultFooterHTML(labInfo: any): string {
  return '';
}
