import { supabase } from './supabase';
import { User, Lab } from '../types';

const API_MODE = ((import.meta as any).env?.VITE_WHATSAPP_API_MODE as string) || 'rest';

// WhatsApp Backend API Configuration
const WHATSAPP_API_BASE_URL = (import.meta as any).env?.VITE_WHATSAPP_API_BASE_URL ||
  'https://lionfish-app-nmodi.ondigitalocean.app';
const WHATSAPP_API_PREFIX = '/api/whatsapp';
const apiEndpoint = new URL(WHATSAPP_API_PREFIX, WHATSAPP_API_BASE_URL).toString();

// WhatsApp User Interface (matching the backend schema)
interface WhatsAppUser {
  id?: string;
  auth_id: string;
  username: string;
  password_hash: string;
  name: string;
  role: string;
  clinic_name: string;
  clinic_address: string;
  gmb_link?: string;
  logo?: string;
  primary_color: string;
  secondary_color: string;
  contact_phone: string;
  contact_email: string;
  contact_whatsapp?: string;
  languages: {
    en: {
      name: string;
      address: string;
    };
  };
  default_language: string;
  enabled_features: string[];
  profile_types: string[];
  google_sheet_id?: string;
  google_apps_script_url?: string;
  blueticks_api_key?: string;
  whatsapp_integration_available: boolean;
  max_sessions: number;
  session_preferences?: any;
  bundle_message_count: number;
}

// User Sync Service
class WhatsAppUserSyncService {
  private async callWhatsAppAPI(endpoint: string, method: string = 'GET', data?: any) {
    try {
      const url = `${apiEndpoint}${endpoint}`;
      const response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${await this.getAuthToken()}`
        },
        body: data ? JSON.stringify(data) : undefined
      });

      if (!response.ok) {
        throw new Error(`WhatsApp API error: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      console.error('WhatsApp API call failed:', error);
      throw error;
    }
  }

  private async getAuthToken(): Promise<string> {
    const { data: { session } } = await supabase.auth.getSession();
    return session?.access_token || '';
  }

  private generatePasswordHash(email: string): string {
    // Simple hash generation - in production, use proper bcrypt or similar
    // For now, return a placeholder hash - this should be handled by the backend
    return 'placeholder_hash_' + btoa(email + Date.now().toString()).replace(/[^a-zA-Z0-9]/g, '').substring(0, 32);
  }

  /**
   * Map LIMS user to WhatsApp user format
   */
  private mapLIMSUserToWhatsApp(limsUser: User, lab: Lab): WhatsAppUser {
    return {
      auth_id: limsUser.id, // Use LIMS user ID as auth_id
      username: limsUser.email,
      password_hash: this.generatePasswordHash(limsUser.email),
      name: lab.name || limsUser.name,
      role: this.mapLIMSRoleToWhatsApp(limsUser.role),
      clinic_name: lab.name,
      clinic_address: this.formatAddress(lab),
      gmb_link: '', // Will need to be configured separately
      logo: undefined,
      primary_color: '#3849c7', // Default color
      secondary_color: '#E5E7EB', // Default color
      contact_phone: lab.phone || limsUser.phone || '',
      contact_email: lab.email || limsUser.email,
      contact_whatsapp: '', // Will need to be configured
      languages: {
        en: {
          name: lab.name,
          address: this.formatAddress(lab)
        }
      },
      default_language: 'en',
      enabled_features: [
        'dashboard',
        'appointments', 
        'reviews',
        'sequences',
        'creatives',
        'reports',
        'gmb'
      ],
      profile_types: [],
      google_sheet_id: '', // Will need configuration
      google_apps_script_url: '', // Will need configuration
      blueticks_api_key: '', // Will need configuration
      whatsapp_integration_available: true,
      max_sessions: 2,
      session_preferences: null,
      bundle_message_count: 3
    };
  }

  private mapLIMSRoleToWhatsApp(limsRole: string): string {
    const roleMapping: { [key: string]: string } = {
      'Admin': 'admin',
      'Manager': 'manager',
      'Technician': 'user',
      'Data Entry': 'receptionist',
      'Viewer': 'viewer'
    };

    return roleMapping[limsRole] || 'receptionist';
  }

  private formatAddress(lab: Lab): string {
    const parts = [lab.address, lab.city, lab.state, lab.pincode].filter(Boolean);
    return parts.join(', ');
  }

  /**
   * Sync a single user to WhatsApp backend
   */
  async syncUserToWhatsApp(userId: string): Promise<{ success: boolean; message: string; whatsappUserId?: string }> {
    try {
      // Get user details from LIMS
      const { data: user, error: userError } = await supabase
        .from('users')
        .select('*')
        .eq('id', userId)
        .single();

      if (userError || !user) {
        throw new Error(`Failed to fetch user: ${userError?.message}`);
      }

      // Get lab details
      const { data: lab, error: labError } = await supabase
        .from('labs')
        .select('*')
        .eq('id', user.lab_id)
        .single();

      if (labError || !lab) {
        throw new Error(`Failed to fetch lab: ${labError?.message}`);
      }

      // Map to WhatsApp user format
      const whatsappUser = this.mapLIMSUserToWhatsApp(user, lab);

      // If using Netlify Functions, call a single upsert endpoint via function
      if (API_MODE === 'netlify-functions') {
        const res = await fetch('/.netlify/functions/sync-user-to-whatsapp', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${await this.getAuthToken()}`
          },
          body: JSON.stringify({ labId: user.lab_id, user: whatsappUser })
        });
        if (!res.ok) throw new Error(`Function error: ${res.statusText}`);
        const data = await res.json();
        const id = data?.id || data?.userId || null;
        await this.updateSyncStatus(userId, true, id);
        return { success: true, message: 'User synced via Netlify function', whatsappUserId: id || undefined };
      }

      // Default: direct backend APIs (create or update)
      const existingUser = await this.checkUserExists(user.id);
      let result;
      if (existingUser) {
        result = await this.callWhatsAppAPI(`/users/${existingUser.id}`, 'PUT', whatsappUser);
      } else {
        result = await this.callWhatsAppAPI('/users', 'POST', whatsappUser);
      }
      await this.updateSyncStatus(userId, true, result.id);
      return { success: true, message: existingUser ? 'User updated successfully' : 'User created successfully', whatsappUserId: result.id };

    } catch (error) {
      console.error('User sync failed:', error);
      
      // Store sync failure status
      await this.updateSyncStatus(userId, false, null, (error as Error).message);

      return {
        success: false,
        message: `Sync failed: ${(error as Error).message}`
      };
    }
  }

  /**
   * Check if user exists in WhatsApp backend
   */
  private async checkUserExists(authId: string): Promise<any> {
    try {
      const result = await this.callWhatsAppAPI(`/users/by-auth-id/${authId}`);
      return result.user || null;
    } catch (error) {
      // User doesn't exist
      return null;
    }
  }

  /**
   * Update sync status in LIMS database
   */
  private async updateSyncStatus(userId: string, success: boolean, whatsappUserId?: string | null, errorMessage?: string) {
    try {
      const updateData: any = {
        whatsapp_sync_status: success ? 'synced' : 'failed',
        whatsapp_last_sync: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      if (whatsappUserId) {
        updateData.whatsapp_user_id = whatsappUserId;
      }

      if (errorMessage) {
        updateData.whatsapp_sync_error = errorMessage;
      }

      await supabase
        .from('users')
        .update(updateData)
        .eq('id', userId);

      // If sync was successful and we have a whatsappUserId, also update labs table if it's empty
      if (success && whatsappUserId) {
        try {
          // Get user's lab_id and role
          const { data: user } = await supabase
            .from('users')
            .select('lab_id, role')
            .eq('id', userId)
            .single();

          if (user?.lab_id) {
            // Check if lab's whatsapp_user_id is empty
            const { data: lab } = await supabase
              .from('labs')
              .select('whatsapp_user_id')
              .eq('id', user.lab_id)
              .single();

            // If lab doesn't have a whatsapp_user_id yet, set it (prioritize Admin users)
            if (!lab?.whatsapp_user_id) {
              await supabase
                .from('labs')
                .update({ 
                  whatsapp_user_id: whatsappUserId,
                  updated_at: new Date().toISOString()
                })
                .eq('id', user.lab_id);
              
              console.log(`✅ Auto-set labs.whatsapp_user_id to ${whatsappUserId} for lab ${user.lab_id}`);
            }
          }
        } catch (labUpdateError) {
          console.error('Failed to update lab whatsapp_user_id:', labUpdateError);
          // Don't fail the overall sync if lab update fails
        }
      }

    } catch (error) {
      console.error('Failed to update sync status:', error);
    }
  }

  /**
   * Sync all users in a lab to WhatsApp backend
   */
  async syncAllUsersInLab(labId: string): Promise<{ success: number; failed: number; results: any[] }> {
    const results = [];
    let successCount = 0;
    let failedCount = 0;

    try {
      // Get all active users in the lab
      const { data: users, error } = await supabase
        .from('users')
        .select('*')
        .eq('lab_id', labId)
        .eq('status', 'Active');

      if (error) {
        throw new Error(`Failed to fetch users: ${error.message}`);
      }

      // Sync each user
      for (const user of users || []) {
        const result = await this.syncUserToWhatsApp(user.id);
        results.push({ userId: user.id, email: user.email, ...result });
        
        if (result.success) {
          successCount++;
        } else {
          failedCount++;
        }
      }

    } catch (error) {
      console.error('Bulk sync failed:', error);
    }

    return { success: successCount, failed: failedCount, results };
  }

  /**
   * Auto-sync trigger for new users
   */
  async handleNewUserCreated(userData: User): Promise<void> {
    try {
      // Delay sync by 2 seconds to ensure user is fully created
      setTimeout(async () => {
        const result = await this.syncUserToWhatsApp(userData.id);
        console.log('Auto-sync result for new user:', result);
      }, 2000);
    } catch (error) {
      console.error('Auto-sync failed for new user:', error);
    }
  }

  /**
   * Get sync status for users.
   *
   * Restricted to active users to match syncAllUsersInLab — otherwise the list
   * offers rows that "Sync All" silently skips. Keep the two filters in step.
   */
  async getSyncStatus(labId?: string): Promise<any[]> {
    try {
      let query = supabase
        .from('users')
        .select(`
          id,
          name,
          email,
          whatsapp_sync_status,
          whatsapp_last_sync,
          whatsapp_user_id,
          whatsapp_sync_error
        `)
        .eq('status', 'Active');

      if (labId) {
        query = query.eq('lab_id', labId);
      }

      // .order() returns a transform builder with no .eq, so it has to come
      // after the conditional filter above.
      const { data, error } = await query.order('name');

      if (error) {
        throw new Error(`Failed to fetch sync status: ${error.message}`);
      }

      return data || [];
    } catch (error) {
      console.error('Failed to get sync status:', error);
      return [];
    }
  }

  /**
   * Force re-sync for failed users
   */
  async retryFailedSyncs(labId: string): Promise<{ success: number; failed: number }> {
    try {
      const { data: failedUsers, error } = await supabase
        .from('users')
        .select('id')
        .eq('lab_id', labId)
        .eq('whatsapp_sync_status', 'failed');

      if (error) {
        throw new Error(`Failed to fetch failed users: ${error.message}`);
      }

      let successCount = 0;
      let failedCount = 0;

      for (const user of failedUsers || []) {
        const result = await this.syncUserToWhatsApp(user.id);
        if (result.success) {
          successCount++;
        } else {
          failedCount++;
        }
      }

      return { success: successCount, failed: failedCount };
    } catch (error) {
      console.error('Retry failed syncs error:', error);
      return { success: 0, failed: 0 };
    }
  }
}

// Export singleton instance
export const whatsappUserSync = new WhatsAppUserSyncService();

// Export individual functions for easy use
export const {
  syncUserToWhatsApp,
  syncAllUsersInLab,
  handleNewUserCreated,
  getSyncStatus,
  retryFailedSyncs
} = whatsappUserSync;