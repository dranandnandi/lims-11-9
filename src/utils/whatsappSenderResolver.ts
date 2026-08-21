/**
 * Resolves which WhatsApp account sends a given message.
 *
 * The WhatsApp backend keys every session by the LIMS `users.id` it was
 * registered under (see supabase/functions/sync-user-to-whatsapp), so a lab can
 * hold several connected numbers at once — one per user who has scanned a QR.
 * Picking between them is this module's whole job.
 *
 * Cascade, most specific first:
 *   1. locations.whatsapp_user_id — the branch's own number
 *   2. labs.whatsapp_user_id      — the lab-wide default from Settings
 *   3. the current user           — browser only, last resort
 *
 * NULL at any level means "inherit", so a lab that never configures a branch
 * number behaves exactly as it did before per-location senders existed.
 *
 * Deno mirror: supabase/functions/_shared/whatsappSender.ts. Change one, change
 * the other — the same convention referenceRangeResolver already follows here.
 */

import { supabase } from './supabase';

export type WhatsAppSenderSource = 'location' | 'lab' | 'current_user' | 'none';

export interface ResolvedWhatsAppSender {
  /** users.id of the account whose session sends. null when nothing is configured. */
  userId: string | null;
  /** Dialling code for formatting the recipient's number. */
  countryCode: string;
  /** Which level of the cascade answered — surfaced in logs and in the UI. */
  source: WhatsAppSenderSource;
  /** The location that answered, when source === 'location'. */
  locationId: string | null;
}

export const DEFAULT_COUNTRY_CODE = '+91';

const NONE: ResolvedWhatsAppSender = {
  userId: null,
  countryCode: DEFAULT_COUNTRY_CODE,
  source: 'none',
  locationId: null,
};

export async function resolveWhatsAppSender(options: {
  labId: string;
  /** Order's location, or the operator's branch. undefined/null skips straight to the lab default. */
  locationId?: string | null;
  /** users.id to fall back to when neither location nor lab is configured. */
  fallbackUserId?: string | null;
}): Promise<ResolvedWhatsAppSender> {
  const { labId, locationId, fallbackUserId } = options;
  if (!labId) return NONE;

  try {
    // The lab row is needed either way — as the sender fallback and as the
    // country-code fallback — so fetch both rows in one round trip.
    const [{ data: lab }, { data: location }] = await Promise.all([
      supabase
        .from('labs')
        .select('whatsapp_user_id, country_code')
        .eq('id', labId)
        .maybeSingle(),
      locationId
        ? supabase
          .from('locations')
          .select('id, name, whatsapp_user_id, whatsapp_country_code')
          .eq('id', locationId)
          .maybeSingle()
        : Promise.resolve({ data: null }),
    ]);

    const labCountryCode = lab?.country_code || DEFAULT_COUNTRY_CODE;
    // A branch's dialling code describes the region it serves, so it applies to
    // recipient formatting even when the branch inherits the lab's sender.
    const countryCode = location?.whatsapp_country_code || labCountryCode;

    if (location?.whatsapp_user_id) {
      return {
        userId: location.whatsapp_user_id,
        countryCode,
        source: 'location',
        locationId: location.id,
      };
    }

    if (lab?.whatsapp_user_id) {
      return {
        userId: lab.whatsapp_user_id,
        countryCode,
        source: 'lab',
        locationId: null,
      };
    }

    if (fallbackUserId) {
      return {
        userId: fallbackUserId,
        countryCode,
        source: 'current_user',
        locationId: null,
      };
    }

    return { ...NONE, countryCode };
  } catch (err) {
    console.error('[whatsappSender] Resolution failed:', err);
    return NONE;
  }
}
