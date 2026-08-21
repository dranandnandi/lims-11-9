// src/utils/whatsappAPI.ts
import { supabase, database } from './supabase';
import {
  resolveWhatsAppSender,
  DEFAULT_COUNTRY_CODE,
  type ResolvedWhatsAppSender,
} from './whatsappSenderResolver';

// Simple in-memory auth cache to avoid frequent /auth/v1/user calls during polling
// IMPORTANT: userId here is the LIMS users.id (integer), NOT the Supabase auth UUID
// The WhatsApp backend expects the LIMS user ID that was synced via sync-user-to-whatsapp
let _authCache: { userId: string | null; authUserId: string | null; token: string | null; fetchedAt: number } = {
  userId: null,      // LIMS users.id (the one synced to WhatsApp backend)
  authUserId: null,  // Supabase auth.users.id (UUID)
  token: null,
  fetchedAt: 0,
};

// Backend selection
// rest: call external REST API (DigitalOcean app)
// supabase-functions: call Supabase Edge Functions via supabase.functions.invoke
// netlify-functions: call Netlify Functions under /.netlify/functions/*
const WHATSAPP_API_MODE: 'rest' | 'supabase-functions' | 'netlify-functions' =
  ((import.meta as any).env?.VITE_WHATSAPP_API_MODE as any) || 'rest';

// Dynamically determine base URL to support multiple subdomains
const getDefaultWhatsAppBaseUrl = () => {
  // In production, use current hostname
  if (typeof window !== 'undefined' && window.location.hostname !== 'localhost') {
    const protocol = window.location.protocol;
    const hostname = window.location.hostname;
    return `${protocol}//${hostname}/whatsapp`;
  }
  // Fallback for development/SSR
  return 'https://app.limsapp.in/whatsapp';
};

const WHATSAPP_API_BASE_URL =
  (import.meta as any).env?.VITE_WHATSAPP_API_BASE_URL ||
  getDefaultWhatsAppBaseUrl();

// Prefix used by the backend for WhatsApp routes
const WHATSAPP_API_PREFIX = '/api/whatsapp';
// Enable WS by default; can be disabled by setting VITE_WHATSAPP_WS_ENABLED=false
const WHATSAPP_WS_ENABLED = String(((import.meta as any).env?.VITE_WHATSAPP_WS_ENABLED ?? 'true')) === 'true';
// Optional explicit WS URL override, e.g. wss://lionfish-app-nmodi.ondigitalocean.app/ws
const WHATSAPP_WS_URL: string | undefined = (import.meta as any).env?.VITE_WHATSAPP_WS_URL;
// Verbose logging for WebSocket diagnostics
const WHATSAPP_WS_DEBUG = String(((import.meta as any).env?.VITE_WHATSAPP_WS_DEBUG ?? 'true')) === 'true';

const apiUrl = (path: string, query?: Record<string, string | number | undefined>) => {
  const url = new URL(WHATSAPP_API_PREFIX + path, WHATSAPP_API_BASE_URL);
  if (query) {
    Object.entries(query).forEach(([k, v]) => {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    });
  }
  return url.toString();
};

const buildHeaders = async (base?: Record<string, string>): Promise<HeadersInit> => {
  const headers: Record<string, string> = { ...(base || {}) };
  // Prefer cached token if fresh
  const now = Date.now();
  if (_authCache.token && now - _authCache.fetchedAt < 60_000) {
    headers['Authorization'] = `Bearer ${_authCache.token}`;
    return headers;
  }
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token || null;
  if (token) headers['Authorization'] = `Bearer ${token}`;
  _authCache.token = token;
  _authCache.authUserId = session?.user?.id || _authCache.authUserId;
  _authCache.fetchedAt = now;
  return headers;
};

export interface WhatsAppConnectionStatus {
  success: boolean;
  isConnected: boolean;
  phoneNumber?: string;
  sessionId?: string;
  message?: string;
  qrCode?: string;
  lastActivity?: string;
  error?: string;
}

export interface MessageResult {
  success: boolean;
  messageId?: string;
  message: string;
  error?: string;
}

export interface MessageHistoryItem {
  id: string;
  to_number: string;
  message_text?: string;
  message_type: 'text' | 'document' | 'image';
  file_name?: string;
  status: 'pending' | 'sent' | 'delivered' | 'read' | 'failed';
  patient_name?: string;
  test_name?: string;
  created_at: string;
  sent_at?: string;
  delivered_at?: string;
}

export interface MessageFilters {
  status?: string;
  messageType?: string;
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
}

export class WhatsAppAPI {
  // Generic function invoker for Supabase Edge Functions
  private static async invokeFunction<T = any>(
    name: string,
    body?: any
  ): Promise<{ data?: T; error?: any; response?: Response }> {
    const { data, error } = await supabase.functions.invoke(name, {
      body: body || {},
    });
    return { data, error };
  }

  // Get current user's session information
  // CRITICAL: Returns the LIMS users.id (not auth UUID) because WhatsApp backend expects
  // the user ID that was synced via sync-user-to-whatsapp Edge Function
  static async getCurrentUserSession(): Promise<{ userId: string | null; user: any }> {
    const now = Date.now();
    // Return cached LIMS user ID quickly if recent
    if (_authCache.userId && now - _authCache.fetchedAt < 60_000) {
      return { userId: _authCache.userId, user: { id: _authCache.userId } };
    }
    
    // Get auth session
    const { data: { session } } = await supabase.auth.getSession();
    const authUser = session?.user || null;
    _authCache.token = session?.access_token || _authCache.token;
    _authCache.authUserId = authUser?.id || null;
    _authCache.fetchedAt = now;
    
    if (!authUser?.id) {
      _authCache.userId = null;
      return { userId: null, user: null };
    }
    
    // Fetch the LIMS user ID from public.users table using auth_user_id
    try {
      const { data: limsUser, error } = await supabase
        .from('users')
        .select('id')
        .eq('auth_user_id', authUser.id)
        .single();
      
      if (error || !limsUser) {
        console.warn('[WhatsAppAPI] Could not find LIMS user for auth_user_id:', authUser.id);
        _authCache.userId = null;
        return { userId: null, user: authUser };
      }
      
      // Cache the LIMS user ID (as string for URL compatibility)
      _authCache.userId = String(limsUser.id);
      console.log('[WhatsAppAPI] Resolved LIMS user ID:', _authCache.userId, 'from auth UUID:', authUser.id);
      
      return {
        userId: _authCache.userId,
        user: { ...authUser, limsId: limsUser.id }
      };
    } catch (err) {
      console.error('[WhatsAppAPI] Error fetching LIMS user:', err);
      _authCache.userId = null;
      return { userId: null, user: authUser };
    }
  }

  /**
   * Resolve which WhatsApp account should send, for a given location.
   *
   * Cascade is location -> lab -> current user (see whatsappSenderResolver).
   * When no location is passed we fall back to the operator's own branch, so a
   * receptionist at Branch B messaging from the dashboard sends from Branch B's
   * number without having to pass anything through.
   */
  static async resolveSender(locationId?: string | null): Promise<ResolvedWhatsAppSender> {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const authUser = session?.user;

      if (!authUser?.id) {
        console.warn('[WhatsAppAPI] No auth user for resolveSender');
        return { userId: null, countryCode: DEFAULT_COUNTRY_CODE, source: 'none', locationId: null };
      }

      const { data: currentUser } = await supabase
        .from('users')
        .select('id, lab_id, default_location_id')
        .eq('auth_user_id', authUser.id)
        .maybeSingle();

      const labId = currentUser?.lab_id;
      if (!labId) {
        console.warn('[WhatsAppAPI] No lab_id for user');
        return { userId: null, countryCode: DEFAULT_COUNTRY_CODE, source: 'none', locationId: null };
      }

      const effectiveLocationId = locationId ?? currentUser?.default_location_id ?? null;

      const sender = await resolveWhatsAppSender({
        labId,
        locationId: effectiveLocationId,
        // users.id, not the auth UUID — the backend registers sessions under
        // the LIMS id (see sync-user-to-whatsapp).
        fallbackUserId: currentUser?.id ?? null,
      });

      console.log(
        `[WhatsAppAPI] sender=${sender.userId} via ${sender.source}` +
        (sender.locationId ? ` (location ${sender.locationId})` : ''),
      );
      return sender;
    } catch (err) {
      console.error('[WhatsAppAPI] Error in resolveSender:', err);
      return { userId: null, countryCode: DEFAULT_COUNTRY_CODE, source: 'none', locationId: null };
    }
  }

  // Force-reset a user's WhatsApp session (DELETE /api/users/:userId/whatsapp/session)
  static async resetUserWhatsAppSession(): Promise<{ success: boolean; message?: string; error?: string; status?: number }> {
    try {
      const { userId } = await this.getCurrentUserSession();
      if (!userId) {
        return { success: false, message: 'User not authenticated' };
      }

      let response: Response;
      if (WHATSAPP_API_MODE === 'netlify-functions') {
        // Direct browser calls to the backend fail CORS; go through the Netlify proxy
        const labId = await database.getCurrentUserLabId();
        response = await fetch('/.netlify/functions/whatsapp-session-reset', {
          method: 'POST',
          headers: await buildHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ userId, labId }),
        });
      } else {
        const url = new URL(`/api/users/${encodeURIComponent(userId)}/whatsapp/session`, WHATSAPP_API_BASE_URL);
        response = await fetch(url.toString(), {
          method: 'DELETE',
          headers: await buildHeaders({ 'Content-Type': 'application/json' }),
        });
      }

      let data: any = null;
      try {
        data = await response.json();
      } catch (e) {
        // Non-JSON response; proceed with status only
      }

      return {
        success: response.ok && (data?.success ?? true),
        message: data?.message || (response.ok ? 'Session reset' : 'Failed to reset session'),
        error: data?.error,
        status: response.status,
      };
    } catch (error) {
      console.error('Reset session error:', error);
      return { success: false, error: String(error), message: 'Failed to reset session' };
    }
  }

  // Get WhatsApp session ID for current user
  static async getWhatsAppSessionId(): Promise<string | null> {
    try {
      const status = await this.getConnectionStatus();
      return status.sessionId || null;
    } catch (error) {
      console.error('Error getting WhatsApp session ID:', error);
      return null;
    }
  }

  // Connection Management
  static async connectWhatsApp(): Promise<WhatsAppConnectionStatus> {
    try {
      const { userId } = await this.getCurrentUserSession();
      const labId = await database.getCurrentUserLabId();
      if (!userId || !labId) {
        return {
          success: false,
          isConnected: false,
          message: 'User or lab not available'
        };
      }

      if (WHATSAPP_API_MODE === 'supabase-functions') {
        const { data, error } = await this.invokeFunction<WhatsAppConnectionStatus>('whatsapp-connect', { labId });
        if (error) throw error;
        return data as WhatsAppConnectionStatus;
      } else if (WHATSAPP_API_MODE === 'netlify-functions') {
        const headers = await buildHeaders({ 'Content-Type': 'application/json' });
        const { userId } = await this.getCurrentUserSession();
        if (!userId) throw new Error('User not authenticated');
        const response = await fetch('/.netlify/functions/whatsapp-connect', {
          method: 'POST',
          headers,
          body: JSON.stringify({ labId, userId })
        });
        const result = await response.json();
        // Handle nested response structure: { success: true, data: { qrCode: "..." } }
        if (result?.data && typeof result.data === 'object') {
          return { ...result.data, success: result.success };
        }
        return result;
      } else {
        const headers = await buildHeaders({ 'Content-Type': 'application/json' });
        const response = await fetch(
          apiUrl('/connect'),
          {
            method: 'POST',
            headers,
            body: JSON.stringify({ labId })
          }
        );
        const result = await response.json();
        return result;
      }
    } catch (error) {
      console.error('WhatsApp connect error:', error);
      return {
        success: false,
        isConnected: false,
        message: 'Connection failed: ' + (error as Error).message
      };
    }
  }

  static async getConnectionStatus(): Promise<WhatsAppConnectionStatus> {
    try {
      const { userId } = await this.getCurrentUserSession();
      const labId = await database.getCurrentUserLabId();
      if (!userId || !labId) {
        return {
          success: false,
          isConnected: false,
          message: 'User or lab not available'
        };
      }

      if (WHATSAPP_API_MODE === 'supabase-functions') {
        const { data, error } = await this.invokeFunction<WhatsAppConnectionStatus>('whatsapp-status', { labId });
        if (error) throw error;
        return data as WhatsAppConnectionStatus;
      } else if (WHATSAPP_API_MODE === 'netlify-functions') {
        const { userId } = await this.getCurrentUserSession();
        if (!userId) throw new Error('User not authenticated');
        const qs = new URLSearchParams({ userId, labId });
        const response = await fetch(`/.netlify/functions/whatsapp-status?${qs.toString()}`, { headers: await buildHeaders() });
        const result = await response.json();
        
        // Handle backend response format: { success: true, data: { sessions: [...] } }
        if (result?.data?.sessions && Array.isArray(result.data.sessions)) {
          console.log('[WhatsAppAPI] Raw sessions:', result.data.sessions);
          const activeSession = result.data.sessions.find((s: any) => s.isConnected || s.connected || s.status === 'authenticated');
          console.log('[WhatsAppAPI] Found active session:', activeSession);
          return {
            success: result.success,
            isConnected: !!activeSession,
            message: activeSession ? `Connected: ${activeSession.phoneNumber}` : 'No active session',
            sessionId: activeSession?.sessionId,
            phoneNumber: activeSession?.phoneNumber,
            lastActivity: activeSession?.lastActivity
          };
        }
        
        return result;
      } else {
        const response = await fetch(apiUrl('/status', { labId }), {
          headers: await buildHeaders(),
        });
        const result = await response.json();
        
        // Handle backend response format: { success: true, data: { sessions: [...] } }
        if (result?.data?.sessions && Array.isArray(result.data.sessions)) {
          console.log('[WhatsAppAPI-REST] Raw sessions:', result.data.sessions);
          const activeSession = result.data.sessions.find((s: any) => s.isConnected || s.connected || s.status === 'authenticated');
          return {
            success: result.success,
            isConnected: !!activeSession,
            message: activeSession ? `Connected: ${activeSession.phoneNumber}` : 'No active session',
            sessionId: activeSession?.sessionId,
            phoneNumber: activeSession?.phoneNumber,
            lastActivity: activeSession?.lastActivity
          };
        }
        
        return result;
      }
    } catch (error) {
      console.error('WhatsApp status error:', error);
      return {
        success: false,
        isConnected: false,
        message: 'Failed to get status: ' + (error as Error).message
      };
    }
  }

  // Fetch latest QR via HTTP (for HTTP-only deployments). Returns any available qrCode or rawQR.
  static async getLatestQr(): Promise<{ qrCode?: string; rawQR?: string } | null> {
    try {
      const { userId } = await this.getCurrentUserSession();
      const labId = await database.getCurrentUserLabId();
      if (!userId || !labId) return null;

      if (WHATSAPP_API_MODE === 'netlify-functions') {
        const qs = new URLSearchParams({ userId, labId });
        const resp = await fetch(`/.netlify/functions/whatsapp-qr?${qs.toString()}`, {
          headers: await buildHeaders(),
        });
        if (!resp.ok) return null;
        const json = await resp.json();
        return { qrCode: (json as any)?.qrCode, rawQR: (json as any)?.rawQR };
      }

      // REST fallback: try dedicated /qr then status?includeQr=1
      const resp1 = await fetch(apiUrl('/qr', { labId }), { headers: await buildHeaders() });
      if (resp1.ok) {
        const j = await resp1.json();
        return { qrCode: (j as any)?.qrCode, rawQR: (j as any)?.rawQR };
      }
      const resp2 = await fetch(apiUrl('/status', { labId, includeQr: 1 as any }), { headers: await buildHeaders() });
      if (resp2.ok) {
        const j = await resp2.json();
        return { qrCode: (j as any)?.qrCode, rawQR: (j as any)?.rawQR };
      }
      return null;
    } catch {
      return null;
    }
  }

  static async disconnectWhatsApp(): Promise<WhatsAppConnectionStatus> {
    try {
      const { userId } = await this.getCurrentUserSession();
      const labId = await database.getCurrentUserLabId();
      if (!userId || !labId) {
        return {
          success: false,
          isConnected: false,
          message: 'User or lab not available'
        };
      }

      if (WHATSAPP_API_MODE === 'supabase-functions') {
        const { data, error } = await this.invokeFunction<WhatsAppConnectionStatus>('whatsapp-disconnect', { labId });
        if (error) throw error;
        return data as WhatsAppConnectionStatus;
      } else if (WHATSAPP_API_MODE === 'netlify-functions') {
        const { userId } = await this.getCurrentUserSession();
        if (!userId) throw new Error('User not authenticated');
        const response = await fetch('/.netlify/functions/whatsapp-disconnect', {
          method: 'POST',
          headers: await buildHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ labId, userId })
        });
        const result = await response.json();
        return result;
      } else {
        const response = await fetch(apiUrl('/disconnect'), {
          method: 'POST',
          headers: await buildHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ labId })
        });
        const result = await response.json();
        return result;
      }
    } catch (error) {
      console.error('WhatsApp disconnect error:', error);
      return {
        success: false,
        isConnected: false,
        message: 'Disconnect failed: ' + (error as Error).message
      };
    }
  }

  // Message Sending
  static async sendTextMessage(
    phoneNumber: string, 
    message: string,
    templateData?: Record<string, string>,
    /** Order's location; omit to use the operator's own branch. */
    locationId?: string | null
  ): Promise<MessageResult> {
    try {
      const labId = await database.getCurrentUserLabId();
      // Sender cascade: this location -> lab default -> current user
      const { userId: whatsappUserId, countryCode } = await this.resolveSender(locationId);
      
      if (!whatsappUserId || !labId) {
        return {
          success: false,
          message: 'WhatsApp not configured. Set a sender on this location (Masters → Locations) or a lab default in Settings → Lab Settings.'
        };
      }

      const formattedPhone = this.formatPhoneNumber(phoneNumber, countryCode);
      if (!this.validatePhoneNumber(phoneNumber, countryCode)) {
        return {
          success: false,
          message: 'Invalid phone number format'
        };
      }
      // For message sends, backend expects plain digits (no leading +)
      const plainPhone = formattedPhone.startsWith('+') ? formattedPhone.substring(1) : formattedPhone;

      if (WHATSAPP_API_MODE === 'supabase-functions') {
        const { data, error } = await this.invokeFunction<MessageResult>('whatsapp-send-message', {
          labId,
          phone: plainPhone,
          message,
          templateData,
        });
        if (error) throw error;
        return data as MessageResult;
      } else if (WHATSAPP_API_MODE === 'netlify-functions') {
        const response = await fetch('/.netlify/functions/whatsapp-send-message', {
          method: 'POST',
          headers: await buildHeaders({ 'Content-Type': 'application/json' }),
          // Netlify function expects `phoneNumber`, not `phone`
          body: JSON.stringify({ labId, userId: whatsappUserId, phoneNumber: plainPhone, message, templateData })
        });
        const result = await response.json();
        return result;
      } else {
        const response = await fetch(apiUrl('/send-message'), {
          method: 'POST',
          headers: await buildHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            labId,
            to: plainPhone,
            message,
            templateData
          }),
        });
        const result = await response.json();
        return result;
      }
    } catch (error) {
      console.error('Send message error:', error);
      return {
        success: false,
        message: 'Failed to send message: ' + (error as Error).message
      };
    }
  }

  static async sendReport(
    phoneNumber: string,
    reportFile: File,
    caption?: string,
    patientName?: string,
    testName?: string,
    /** Order's location; omit to use the operator's own branch. */
    locationId?: string | null
  ): Promise<MessageResult> {
    // Use the new sendDocument method which handles all modes properly
    return await this.sendDocument(phoneNumber, reportFile, {
      caption,
      patientName,
      testName,
      locationId
    });
  }

  static async sendReportFromUrl(
    phoneNumber: string,
    reportUrl: string,
    caption?: string,
    patientName?: string,
    testName?: string,
    /** Order's location; omit to use the operator's own branch. */
    locationId?: string | null
  ): Promise<MessageResult> {
    try {
      const labId = await database.getCurrentUserLabId();
      // Sender cascade: this location -> lab default -> current user
      const { userId: whatsappUserId, countryCode } = await this.resolveSender(locationId);
      
      if (!whatsappUserId || !labId) {
        return { success: false, message: 'WhatsApp not configured. Set a sender on this location (Masters → Locations) or a lab default in Settings → Lab Settings.' };
      }

      // Prefer backend to fetch from URL (avoids CORS and big downloads in browser)
      if (WHATSAPP_API_MODE === 'supabase-functions') {
        const { data, error } = await this.invokeFunction<MessageResult>('whatsapp-send-message', {
          labId,
          phone: phoneNumber,
          message: caption || '',
          url: reportUrl,
          patientName,
          testName,
          type: 'document'
        });
        if (!error && data) return data as MessageResult;
        // Fallback to REST URL endpoint if available
      } else if (WHATSAPP_API_MODE === 'netlify-functions') {
        const formattedPhone = this.formatPhoneNumber(phoneNumber, countryCode);
        if (!this.validatePhoneNumber(phoneNumber, countryCode)) {
          return { success: false, message: 'Invalid phone number format' };
        }
        const e164Phone = `+${formattedPhone}`;
        const fileName = reportUrl.split('/').pop() || `${patientName || 'Patient'}_Report.pdf`;
        const templatePayload: Record<string, string> = {};
        if (patientName) templatePayload.PatientName = patientName;
        if (testName) templatePayload.TestName = testName;
        const captionText = caption || `Your report for ${patientName || 'Patient'} is ready`;

        const response = await fetch('/.netlify/functions/send-report-url', {
          method: 'POST',
          headers: await buildHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            userId: whatsappUserId,  // Use the effective WhatsApp user ID
            fileUrl: reportUrl,
            fileName,
            caption: captionText,
            phoneNumber: e164Phone,
            templateData: Object.keys(templatePayload).length ? templatePayload : undefined,
          })
        });
        const raw = await response.text();
        let data: any = null;
        try {
          data = raw ? JSON.parse(raw) : null;
        } catch (parseError) {
          console.warn('send-report-url non-JSON response:', raw);
        }

        if (response.ok) {
          return data ?? { success: true, message: 'Report sent successfully' };
        }

        const failureMessage = data?.message || data?.error || `Failed to send report (status ${response.status})`;
        return {
          success: false,
          message: failureMessage,
          error: data || raw || 'Unknown error',
        } as MessageResult;
      } else {
        try {
          const fileName = reportUrl.split('/').pop() || `${patientName || 'Patient'}_Report.pdf`;
          const response = await fetch(apiUrl('/send-file-url'), {
            method: 'POST',
            headers: await buildHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ 
              fileUrl: reportUrl,  // Backend expects 'fileUrl', not 'url'
              to: phoneNumber, 
              caption, 
              fileName,
              patientName, 
              testName 
            })
          });
          const raw = await response.text();
          let data: any = null;
          try {
            data = raw ? JSON.parse(raw) : null;
          } catch (parseError) {
            console.warn('REST send-file-url non-JSON response:', raw);
          }

          if (response.ok) {
            return data ?? { success: true, message: 'Report sent successfully' };
          }

          const failureMessage = data?.message || data?.error || `Failed to send report (status ${response.status})`;
          return {
            success: false,
            message: failureMessage,
            error: data || raw || 'Unknown error',
          } as MessageResult;
        } catch (error) {
          console.error('Direct backend call failed:', error);
          return {
            success: false,
            message: 'Failed to send report: ' + (error as Error).message,
          };
        }
      }
      return {
        success: false,
        message: 'Unsupported WhatsApp API mode',
      };
    } catch (error) {
      console.error('Send report from URL error:', error);
      return {
        success: false,
        message: 'Failed to send report: ' + (error as Error).message
      };
    }
  }

  // Message History
  static async getMessageHistory(filters?: MessageFilters): Promise<MessageHistoryItem[]> {
    try {
      const { userId } = await this.getCurrentUserSession();
      const labId = await database.getCurrentUserLabId();
      if (!userId || !labId) {
        return [];
      }

      const queryParams = new URLSearchParams();
      queryParams.append('labId', labId);
      if (filters?.status) queryParams.append('status', filters.status);
      if (filters?.messageType) queryParams.append('messageType', filters.messageType);
      if (filters?.dateFrom) queryParams.append('dateFrom', filters.dateFrom);
      if (filters?.dateTo) queryParams.append('dateTo', filters.dateTo);
      if (filters?.limit) queryParams.append('limit', filters.limit.toString());

      // For now, message history is available via REST endpoint only
      const response = await fetch(apiUrl('/messages') + `?${queryParams.toString()}`, {
        headers: await buildHeaders(),
      });
      if (!response.ok) {
        throw new Error('Failed to fetch message history');
      }
      const result = await response.json();
      return result.data || [];
    } catch (error) {
      console.error('Get message history error:', error);
      return [];
    }
  }

  // WebSocket connection for real-time updates
  static createWebSocketConnection(onMessage: (data: any) => void): { close: () => void } | null {
    // Allow disabling WS from env if backend isn't ready; rely on polling fallback
    if (!WHATSAPP_WS_ENABLED) {
      if (WHATSAPP_WS_DEBUG) console.info('[WA-WS] Disabled by VITE_WHATSAPP_WS_ENABLED=false');
      return null;
    }
    try {
      const base = new URL(WHATSAPP_API_BASE_URL);
      const wsProtocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
      if (WHATSAPP_WS_DEBUG) {
        console.info('[WA-WS] Base:', WHATSAPP_API_BASE_URL, '| Proto:', wsProtocol);
      }

      const attachHandlers = (socket: WebSocket) => {
        socket.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (WHATSAPP_WS_DEBUG) {
              const evt = (data && (data.event || data.type)) ? (data.event || data.type) : 'message';
              console.info('[WA-WS] ← msg:', evt, data);
            }
            onMessage(data);
          } catch (error) {
            console.error('WebSocket message parse error:', error);
          }
        };
        socket.onerror = (error) => {
          console.error('[WA-WS] Error:', error);
        };
        socket.onclose = () => {
          if (WHATSAPP_WS_DEBUG) console.info('[WA-WS] Closed');
        };
      };

      // Build candidate endpoints (user-scoped first), try sequentially
      const buildCandidates = async (): Promise<{ url: string; protocols?: string[] }[]> => {
        const { data: sessionData } = await supabase.auth.getSession();
        const token = sessionData.session?.access_token || '';
        // Get LIMS user ID (not auth UUID) for WhatsApp backend compatibility
        const { userId } = await this.getCurrentUserSession();
        const labId = await database.getCurrentUserLabId();

        const toUrl = (path: string, withToken = true, withUserLab = true) => {
          const u = new URL(path, `${base.protocol}//${base.host}`);
          if (withUserLab) {
            if (userId) u.searchParams.set('userId', userId);
            if (labId) u.searchParams.set('labId', labId);
          }
          if (withToken && token) u.searchParams.set('token', token);
          return `${wsProtocol}//${u.host}${u.pathname}${u.search ? `?${u.searchParams.toString()}` : ''}`;
        };

        const urls: { url: string; protocols?: string[] }[] = [];

        const push = (url: string, withProtocols = false) => {
          if (withProtocols && token) {
            urls.push({ url, protocols: [token] });
            urls.push({ url, protocols: [`Bearer ${token}`] });
            urls.push({ url, protocols: [`jwt.${token}`] });
          }
          urls.push({ url });
        };

        // If explicit WS URL is provided, try it first (no params by default)
        if (WHATSAPP_WS_URL) {
          push(WHATSAPP_WS_URL, true);
        }

        // Try root /ws first, as used by the other app
        push(`${wsProtocol}//${base.host}/ws`, true);

        // New user-scoped
        push(toUrl(`/api/users/${encodeURIComponent(userId)}/whatsapp/status-updates`, true, true), true);
        push(toUrl(`/api/users/${encodeURIComponent(userId)}/whatsapp/status-updates`, false, true), true);

        // Legacy with explicit userId
        push(toUrl(`/api/whatsapp/status-updates`, true, true), true);
        push(toUrl(`/api/whatsapp/status-updates`, false, true), true);

        // Pure legacy without params
        push(`${wsProtocol}//${base.host}${WHATSAPP_API_PREFIX}/status-updates`, true);
        push(`${wsProtocol}//${base.host}/api/whatsapp/ws`, true);
        push(toUrl(`/api/users/${encodeURIComponent(userId)}/whatsapp/ws`, true, true), true);

        // Try access_token param variant
        const withAccessToken = (path: string) => {
          const u = new URL(path, `${base.protocol}//${base.host}`);
          if (userId) u.searchParams.set('userId', userId);
          if (labId) u.searchParams.set('labId', labId);
          if (token) u.searchParams.set('access_token', token);
          return `${wsProtocol}//${u.host}${u.pathname}?${u.searchParams.toString()}`;
        };
        push(withAccessToken(`/api/users/${encodeURIComponent(userId)}/whatsapp/status-updates`), false);
        push(withAccessToken(`/api/whatsapp/status-updates`), false);

        if (WHATSAPP_WS_DEBUG) {
          console.info('[WA-WS] Candidates (ordered):');
          urls.forEach((c, i) => console.info(`  [${i}]`, c.url, c.protocols ? '(with subprotocols)' : ''));
        }
        return urls;
      };

      let active: WebSocket | null = null;
      let closedByCaller = false;

      const tryConnect = (url: string, protocols?: string[]): Promise<WebSocket> => new Promise((resolve, reject) => {
        try {
          if (WHATSAPP_WS_DEBUG) console.info('[WA-WS] → trying', url, protocols?.length ? `with ${protocols.length} protocol(s)` : '');
          const s = protocols?.length ? new WebSocket(url, protocols) : new WebSocket(url);
          let settled = false;
          const timer = setTimeout(() => {
            if (settled) return;
            try { s.close(); } catch {}
            reject(new Error('WS open timeout'));
          }, 1500);
          s.onopen = () => {
            if (settled) return;
            clearTimeout(timer);
            settled = true;
            if (WHATSAPP_WS_DEBUG) console.info('[WA-WS] ✅ connected', url);
            resolve(s);
          };
          s.onerror = () => {
            if (settled) return;
            clearTimeout(timer);
            settled = true;
            if (WHATSAPP_WS_DEBUG) console.info('[WA-WS] ❌ error', url);
            reject(new Error('WS error'));
          };
        } catch (e) {
          reject(e);
        }
      });

      // Kick off sequential attempts
      (async () => {
        const candidates = await buildCandidates();
        for (const c of candidates) {
          if (closedByCaller) return;
          try {
            const s = await tryConnect(c.url, c.protocols);
            // Caller unmounted while we were connecting — discard the socket
            if (closedByCaller) {
              try { s.close(); } catch {}
              return;
            }
            // Close any previous
            if (active && active.readyState === WebSocket.OPEN) {
              try { active.close(); } catch {}
            }
            active = s;
            attachHandlers(active);
            break;
          } catch (e) {
            if (WHATSAPP_WS_DEBUG) console.info('[WA-WS] next candidate due to error:', (e as any)?.message || e);
          }
        }
        if (!active && WHATSAPP_WS_DEBUG) console.info('[WA-WS] All WS candidates failed; relying on HTTP polling only');
      })();

      // Connection attempts run async, so the socket doesn't exist yet at
      // return time (the old `return active` was always null — callers could
      // never close the socket). Hand back a close handle instead.
      return {
        close: () => {
          closedByCaller = true;
          if (active) {
            try { active.close(); } catch {}
            active = null;
          }
        },
      };
    } catch (error) {
      console.error('WebSocket connection error:', error);
      return null;
    }
  }

  // Send document/PDF via WhatsApp
  static async sendDocument(
    to: string, 
    file: File, 
    options: {
      caption?: string;
      patientName?: string;
      testName?: string;
      /** Order's location; omit to use the operator's own branch. */
      locationId?: string | null;
    } = {}
  ): Promise<MessageResult> {
    try {
      // Resolve the branch's sender so the session lookup on the backend
      // matches the number actually connected for this location
      const { userId: whatsappUserId, countryCode } = await this.resolveSender(options.locationId);
      const labId = await database.getCurrentUserLabId();
      if (!whatsappUserId || !labId) {
        return {
          success: false,
          message: 'WhatsApp not configured. Set a sender on this location (Masters → Locations) or a lab default in Settings → Lab Settings.'
        };
      }

      // Format phone number
      const formattedPhone = this.formatPhoneNumber(to, countryCode);
      if (!this.validatePhoneNumber(formattedPhone, countryCode)) {
        return {
          success: false,
          message: 'Invalid phone number format'
        };
      }

      // Session ID is required by all backends
      const whatsappSessionId = await this.getWhatsAppSessionId();
      if (WHATSAPP_API_MODE === 'rest' && !whatsappSessionId) {
        throw new Error('WhatsApp session not available');
      }

      const captionText = options.caption || `Report for ${options.patientName || 'Patient'}`;

      // Create FormData
      const formData = new FormData();
      if (whatsappSessionId) formData.append('sessionId', whatsappSessionId);
      formData.append('userId', whatsappUserId);
      formData.append('labId', labId);
      formData.append('phoneNumber', `+${formattedPhone}`);
      formData.append('file', file);
      formData.append('caption', captionText);
      formData.append('content', captionText); // backend uses 'content'
      if (options.patientName) formData.append('patientName', options.patientName);
      if (options.testName) formData.append('testName', options.testName);

      if (WHATSAPP_API_MODE === 'supabase-functions') {
        // Note: Supabase functions might need special handling for multipart/form-data
        return {
          success: false,
          message: 'Document sending via Supabase functions not implemented yet'
        };
      } else if (WHATSAPP_API_MODE === 'netlify-functions') {
        const response = await fetch('/.netlify/functions/send-report', {
          method: 'POST',
          body: formData,
          headers: {
            'Authorization': await this.getAuthHeader()
          }
        });
        const raw = await response.text();
        let result: any;
        try {
          result = raw ? JSON.parse(raw) : null;
        } catch {
          return {
            success: false,
            message: `Server error (${response.status}): ${raw.slice(0, 120)}`
          };
        }
        return result;
      } else {
        const response = await fetch(
          apiUrl(`/users/${userId}/send-document`),
          {
            method: 'POST',
            body: formData,
            headers: {
              'Authorization': await this.getAuthHeader()
            }
          }
        );
        const raw = await response.text();
        let result: any;
        try {
          result = raw ? JSON.parse(raw) : null;
        } catch {
          return {
            success: false,
            message: `Server error (${response.status}): ${raw.slice(0, 120)}`
          };
        }
        return result;
      }
    } catch (error) {
      console.error('WhatsApp send document error:', error);
      return {
        success: false,
        message: 'Failed to send document: ' + (error as Error).message
      };
    }
  }

  // Get auth header for requests
  private static async getAuthHeader(): Promise<string> {
    const now = Date.now();
    if (_authCache.token && now - _authCache.fetchedAt < 60_000) {
      return `Bearer ${_authCache.token}`;
    }
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;
    _authCache.token = token || null;
    _authCache.fetchedAt = now;
    return token ? `Bearer ${token}` : '';
  }

  // Utility functions
  static formatPhoneNumber(phone: string, countryCode: string = '+91'): string {
    // Remove all non-digits
    const digits = phone.replace(/\D/g, '');
    const cc = countryCode.replace(/\D/g, '') || '91';

    // Add the country code if not already present
    if (digits.length === 10) {
      return cc + digits;
    } else if (digits.length === 10 + cc.length && digits.startsWith(cc)) {
      return digits;
    } else if (digits.startsWith('0' + cc)) {
      return digits.substring(1);
    } else if (digits.length === 11 && digits.startsWith('0')) {
      // Local trunk prefix
      return cc + digits.substring(1);
    }
    
    return digits;
  }

  static validatePhoneNumber(phone: string, countryCode: string = '+91'): boolean {
    const cc = countryCode.replace(/\D/g, '') || '91';
    const formatted = this.formatPhoneNumber(phone, countryCode);
    return new RegExp(`^${cc}\\d{10}$`).test(formatted);
  }
}

export default WhatsAppAPI;