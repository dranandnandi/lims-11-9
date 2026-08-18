export interface Booking {
  id: string;
  lab_id: string;
  account_id?: string;
  /** `public_web` = submitted through the lab's no-login /book/:slug page */
  booking_source: 'b2b_portal' | 'front_desk' | 'patient_app' | 'phone_call' | 'public_web';
  status: 'pending' | 'quoted' | 'confirmed' | 'converted' | 'cancelled';
  patient_info: {
    name: string;
    phone: string;
    age?: number;
    gender?: 'Male' | 'Female' | 'Other';
    email?: string;
  };
  test_details: Array<{
    id?: string;
    name: string;
    price?: number;
    type?: 'test' | 'profile' | 'test_group' | 'package' | 'note';
  }>;
  scheduled_at?: string;
  collection_type?: 'home_collection' | 'walk_in' | 'lab_pickup';
  home_collection_address?: {
    address: string;
    city?: string;
    pincode?: string;
    lat?: number;
    lng?: number;
  };
  b2b_client_id?: string;
  quotation_amount?: number;
  converted_order_id?: string;
  assigned_phlebo_id?: string;
  assigned_phlebo_name?: string;
  patient_id?: string;
  collection_status?: 'assigned' | 'started' | 'reached' | 'collected' | null;
  collection_started_at?: string | null;
  collection_reached_at?: string | null;
  collection_collected_at?: string | null;
  phlebo_last_lat?: number | null;
  phlebo_last_lng?: number | null;
  phlebo_location_updated_at?: string | null;
  /** Short code shown to a patient who booked through the public link */
  public_reference?: string | null;
  /** Provenance of a public submission (referrer, user agent, IP hash, patient notes) */
  source_meta?: Record<string, unknown> | null;
  created_by?: string;
  created_at: string;
  updated_at: string;
}
