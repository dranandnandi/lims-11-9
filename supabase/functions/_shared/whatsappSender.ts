/**
 * Deno mirror of src/utils/whatsappSenderResolver.ts.
 *
 * Same convention referenceRangeResolver already follows in this repo: a
 * hand-copy, kept in step by hand. If you change one, change the other. The
 * only differences are this header and the injected Supabase client — edge
 * functions build their own service-role client rather than importing the
 * browser singleton.
 *
 * Resolves which WhatsApp account sends a message. The backend keys sessions by
 * LIMS users.id, so a lab may hold several connected numbers at once; the
 * cascade below picks between them:
 *
 *   1. locations.whatsapp_user_id — the branch's own number
 *   2. labs.whatsapp_user_id      — the lab-wide default
 *
 * NULL means "inherit", so labs with no branch senders behave as before.
 */

export type WhatsAppSenderSource = "location" | "lab" | "none";

export interface ResolvedWhatsAppSender {
  userId: string | null;
  countryCode: string;
  source: WhatsAppSenderSource;
  locationId: string | null;
}

export const DEFAULT_COUNTRY_CODE = "+91";

export async function resolveWhatsAppSender(
  supabaseClient: any,
  options: { labId: string; locationId?: string | null },
): Promise<ResolvedWhatsAppSender> {
  const { labId, locationId } = options;

  const none: ResolvedWhatsAppSender = {
    userId: null,
    countryCode: DEFAULT_COUNTRY_CODE,
    source: "none",
    locationId: null,
  };

  if (!labId) return none;

  try {
    // The lab row is needed either way — as the sender fallback and as the
    // country-code fallback — so fetch both rows in one round trip.
    const [{ data: lab }, { data: location }] = await Promise.all([
      supabaseClient
        .from("labs")
        .select("whatsapp_user_id, country_code")
        .eq("id", labId)
        .maybeSingle(),
      locationId
        ? supabaseClient
          .from("locations")
          .select("id, name, whatsapp_user_id, whatsapp_country_code")
          .eq("id", locationId)
          .maybeSingle()
        : Promise.resolve({ data: null }),
    ]);

    const labCountryCode = lab?.country_code || DEFAULT_COUNTRY_CODE;
    // A branch's dialling code describes the region it serves, so it applies to
    // recipient formatting even when the branch inherits the lab's sender.
    const countryCode = location?.whatsapp_country_code || labCountryCode;

    if (location?.whatsapp_user_id) {
      console.log(
        `[whatsappSender] location "${location.name}" -> ${location.whatsapp_user_id}`,
      );
      return {
        userId: location.whatsapp_user_id,
        countryCode,
        source: "location",
        locationId: location.id,
      };
    }

    if (location) {
      console.log(
        `[whatsappSender] location "${location.name}" has no sender - inheriting lab default`,
      );
    }

    if (lab?.whatsapp_user_id) {
      return {
        userId: lab.whatsapp_user_id,
        countryCode,
        source: "lab",
        locationId: null,
      };
    }

    console.warn(`[whatsappSender] no sender configured for lab ${labId}`);
    return { ...none, countryCode };
  } catch (err) {
    console.error("[whatsappSender] resolution failed:", err);
    return none;
  }
}

/**
 * Formats a recipient number for the send API using the resolved dialling code.
 * Lifted verbatim from the logic process-notification-queue carried inline, so
 * every caller now formats identically.
 */
export function formatPhoneForSender(
  phone: string,
  countryCode: string,
): string {
  let cleanPhone = String(phone || "").replace(/\D/g, "");

  // Strip a local trunk prefix before applying the country code.
  if (cleanPhone.startsWith("0")) {
    cleanPhone = cleanPhone.substring(1);
  }

  const countryCodeDigits = countryCode.replace(/\D/g, "");

  if (cleanPhone.length === 10) {
    return countryCode + cleanPhone;
  }
  if (
    cleanPhone.startsWith(countryCodeDigits) &&
    cleanPhone.length === 10 + countryCodeDigits.length
  ) {
    return "+" + cleanPhone;
  }
  if (cleanPhone.length > 10) {
    return "+" + cleanPhone;
  }
  return countryCode + cleanPhone;
}
