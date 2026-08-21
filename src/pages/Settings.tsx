import React, { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useQZTray } from '../contexts/QZTrayContext';
import { database, generateFilePath, supabase, type LabPatientFieldConfig, uploadFile } from '../utils/supabase';
import { usePermissions } from '../hooks/usePermissions';
import EditUserModal from '../components/Users/EditUserModal';
import { NotificationSettings } from '../components/Settings/NotificationSettings';
import { NotificationTriggerSettings } from '../components/Settings/NotificationTriggerSettings';
import InvoiceTemplateManager from '../components/Billing/InvoiceTemplateManager';
import BasicTemplateFormatBuilder from '../components/Reports/BasicTemplateFormatBuilder';
import BuiltinTemplatePreview from '../components/Reports/BuiltinTemplatePreview';
import AnalyzerAPIKeys from '../components/Settings/AnalyzerAPIKeys';
import AnalyzerConnectionsManager from '../components/Settings/AnalyzerConnectionsManager';
import AnalyteInterfaceConfig from '../components/Settings/AnalyteInterfaceConfig';
import PatientPortalSettings from '../components/Settings/PatientPortalSettings';
import PatientFormSettings from '../components/Settings/PatientFormSettings';
import LabBillingItemSettings from '../components/Settings/LabBillingItemSettings';
import PriceMasterSettings from '../components/Settings/PriceMasterSettings';
import PaymentGatewaySettings from '../components/Settings/PaymentGatewaySettings';
import PublicBookingSettings from '../components/Settings/PublicBookingSettings';
import SampleTypeColorsConfig from '../components/Settings/SampleTypeColorsConfig';
import AccessionSettings, { type AccessionCollectionConfig } from '../components/Settings/AccessionSettings';
import BarcodeLabelLayoutConfig from '../components/Settings/BarcodeLabelLayoutConfig';
import { normalizeLabelLayout, type LabelLayout } from '../utils/labelLayout';
import { useSampleTypeColors } from '../contexts/SampleTypeColorsContext';
import {
  Users,
  Shield,
  BarChart3,
  Plus,
  Edit,
  Trash2,
  Eye,
  Search,
  Bell,
  Clock,
  Activity,
  Database,
  Server,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Building,
  MapPin,
  Phone,
  Mail,
  FileText,
  Save,
  Loader2,
  UserCheck,
  Globe,
  MessageSquare,
  Gift,
  Star,
  Smartphone,
  Tag,
  Printer,
  CreditCard,
  Droplet,
  ClipboardCheck,
  Image as ImageIcon
} from 'lucide-react';
import { LANGUAGE_DISPLAY_NAMES, type SupportedLanguage } from '../hooks/useAIResultIntelligence';
import { COUNTRY_CODE_OPTIONS } from '../utils/phoneFormatter';

interface User {
  id: string;
  name: string;
  email: string;
  role: 'Admin' | 'Lab Manager' | 'Technician' | 'Receptionist' | 'Doctor';
  role_id?: string;
  department: string;
  department_id?: string;
  contact_number?: string;
  gender?: string;
  is_phlebotomist?: boolean;
  clinic_keywords?: string;
  status: 'Active' | 'Inactive' | 'Suspended';
  lastLogin: string;
  permissions: string[];
  phone: string;
  joinDate: string;
  avatar?: string;
}

interface Permission {
  id: string;
  name: string;
  description: string;
  category: string;
  isDefault: boolean;
}

interface UsageStats {
  totalUsers: number;
  activeUsers: number;
  totalTests: number;
  totalPatients: number;
  storageUsed: number;
  storageLimit: number;
  apiCalls: number;
  apiLimit: number;
}

interface LabSettings {
  id: string;
  name: string;
  code: string;
  address: string;
  city: string;
  state: string;
  pincode: string;
  phone: string;
  email: string;
  email_domain?: string;
  license_number: string;
  registration_number: string;
  gst_number: string;
  upi_id: string;
  whatsapp_user_id?: string | null;
  bank_details: {
    bank_name?: string;
    account_number?: string;
    ifsc_code?: string;
    account_holder?: string;
    branch?: string;
  } | null;
  watermark_enabled: boolean;
  watermark_opacity: number;
  watermark_position: string;
  watermark_size: string;
  watermark_rotation: number;
  preferred_language: SupportedLanguage;
  country_code?: string;
  result_colors?: {
    enabled: boolean;
    high: string;
    low: string;
    normal: string;
  } | null;
  default_template_style?: 'beautiful' | 'classic' | 'basic';
  show_methodology?: boolean;
  show_interpretation?: boolean;
  flag_options?: Array<{ value: string; label: string }>;
  loyalty_enabled?: boolean;
  loyalty_conversion_rate?: number;
  loyalty_min_redeem_points?: number;
  loyalty_point_value?: number;
  block_send_on_due?: boolean;
  report_patient_info_config?: {
    layout: 'table' | 'inline';
    fields: string[];
  } | null;
	  print_options?: {
	    tableBorders?: boolean;
	    flagColumn?: boolean;
	    flagAsterisk?: boolean;
	    flagAsteriskCritical?: boolean;
	    headerBackground?: string;
	    alternateRows?: boolean;
	    baseFontSize?: number;
	    showSampleType?: boolean;
	    showSampleCondition?: boolean;
	    testNameBold?: boolean;
	    testNameAlignment?: 'left' | 'center' | 'right';
	    boldAllValues?: boolean;
	    boldAbnormalValues?: boolean;
	    patientInfoBold?: boolean;
	    patientInfoColumnDivider?: boolean;
	    underlineAbnormalValues?: boolean;
	    calcMarker?: 'asterisk' | 'cal' | 'none';
	    sectionHeaderInline?: boolean;
	    flagSymbol?: 'none' | 'before' | 'after';
	    showFlagLegend?: boolean;
	    flagGapPx?: number;
	    analyteRowSpacing?: number;
	    testGroupSpacing?: number;
	    testGroupTitlePosition?: 'below_headers' | 'above_headers_center' | 'above_headers_left';
	    qrHorizontalOffset?: number;
	    qrPosition?: 'bottom_left' | 'top_left' | 'top_right' | 'header_right';
	    headerQrTop?: number;
	    headerQrRight?: number;
	    signatureMaxHeight?: number;
	    signatureMaxWidth?: number;
	    sectionFieldNamePct?: number;
	    resultTableBackground?: 'white' | 'transparent';
	  } | null;
  _pdf_layout_settings_raw?: Record<string, unknown> | null;
  barcode_printer_name?: string | null;
  report_printer_name?: string | null;
  barcode_browser_print_enabled?: boolean;
  barcode_label_layout?: LabelLayout | null;
  auto_collect_on_registration?: boolean;
  auto_open_collection_modal?: boolean;
  auto_print_barcode_on_order?: boolean;
  auto_print_report_on_approval?: boolean;
  show_approve_all_in_result_entry?: boolean;
  default_collapsed_order_cards?: boolean;
  tat_alert_max_overdue_hours?: number;
  sample_type_colors?: Record<string, string>;
  accession_collection_config?: AccessionCollectionConfig | null;
  portal_settings?: PortalSettings | null;
}

interface PortalUpdateSlide {
  title: string;
  message: string;
  image_url?: string;
}

interface PortalAnnouncement {
  title: string;
  message: string;
}

interface PortalSettings {
  welcome_note: string;
  updates_enabled: boolean;
  updates_title: string;
  update_slides: PortalUpdateSlide[];
  announcements_enabled: boolean;
  announcements_title: string;
  announcement_slides: PortalAnnouncement[];
  slider_aspect: 'square' | 'landscape' | 'banner';
  hide_lims_branding: boolean;
  sidebar_branding_mode: 'anpro' | 'lab' | 'hidden';
}

const normalizePortalSettings = (raw: Partial<PortalSettings> | null | undefined, keepBlankSlides = false): PortalSettings => {
  const announcementSlides = Array.isArray(raw?.announcement_slides) ? raw.announcement_slides : [];
  const normalizedAnnouncements = announcementSlides.map((slide) => ({
    title: keepBlankSlides ? String(slide?.title || '') : String(slide?.title || '').trim(),
    message: keepBlankSlides ? String(slide?.message || '') : String(slide?.message || '').trim(),
  }));
  const updateSlides = Array.isArray(raw?.update_slides) ? raw.update_slides : [];
  const normalizedSlides = updateSlides.map((slide) => ({
    title: keepBlankSlides ? String(slide?.title || '') : String(slide?.title || '').trim(),
    message: keepBlankSlides ? String(slide?.message || '') : String(slide?.message || '').trim(),
    image_url: keepBlankSlides ? String(slide?.image_url || '') : String(slide?.image_url || '').trim(),
  }));
  const slidesWithMinimum = keepBlankSlides
    ? [
        ...normalizedSlides,
        ...Array.from({ length: Math.max(0, 5 - normalizedSlides.length) }, () => ({
          title: '',
          message: '',
          image_url: '',
        })),
      ]
    : normalizedSlides;

  return {
    welcome_note: keepBlankSlides ? String(raw?.welcome_note || '') : String(raw?.welcome_note || '').trim(),
    updates_enabled: raw?.updates_enabled !== false,
    updates_title: keepBlankSlides
      ? String(raw?.updates_title ?? 'Partner Portal Updates')
      : String(raw?.updates_title || 'Partner Portal Updates').trim() || 'Partner Portal Updates',
    update_slides: keepBlankSlides
      ? slidesWithMinimum
      : slidesWithMinimum.filter((slide) => slide.title || slide.message || slide.image_url),
    announcements_enabled: raw?.announcements_enabled !== false,
    announcements_title: keepBlankSlides
      ? String(raw?.announcements_title ?? 'Announcements')
      : String(raw?.announcements_title || 'Announcements').trim() || 'Announcements',
    announcement_slides: keepBlankSlides
      ? normalizedAnnouncements
      : normalizedAnnouncements.filter((slide) => slide.title || slide.message),
    slider_aspect: ['square', 'landscape', 'banner'].includes(String((raw as any)?.slider_aspect))
      ? (raw as any).slider_aspect
      : 'square',
    hide_lims_branding: raw?.hide_lims_branding === true,
    sidebar_branding_mode: ['anpro', 'lab', 'hidden'].includes(String((raw as any)?.sidebar_branding_mode))
      ? (raw as any).sidebar_branding_mode
      : 'anpro',
  };
};

// Define UserForm component outside of Settings
const UserFormComponent: React.FC<{
  onClose: () => void;
  user?: User;
  permissions: Permission[],
  availableRoles: any[],
  labId?: string,
  onSave?: () => void
}> = ({ onClose, user, permissions, availableRoles, labId, onSave }) => {
  // Initialize roleId by finding matching role from availableRoles
  const initialRoleId = user ? availableRoles.find(r => r.role_name === user.role)?.id || '' : '';

  const [formData, setFormData] = useState({
    name: user?.name || '',
    email: user?.email || '',
    roleId: initialRoleId,
    department: user?.department || '',
    phone: user?.phone || '',
    permissions: user?.permissions || [],
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [locations, setLocations] = useState<any[]>([]);
  const [selectedPrimaryLocation, setSelectedPrimaryLocation] = useState<string>('');
  const [selectedLocations, setSelectedLocations] = useState<string[]>([]);

  // Fetch locations and user's location assignments on mount
  useEffect(() => {
    const fetchData = async () => {
      if (!labId) return;

      // Fetch all locations
      const { data: locationsData } = await database.locations.getAll();
      setLocations(locationsData || []);

      // Fetch user's location assignments if editing existing user
      if (user?.id) {
        const { data: userCenters, error } = await supabase
          .from('user_centers')
          .select('location_id, is_primary')
          .eq('user_id', user.id);

        if (!error && userCenters) {
          const primaryCenter = userCenters.find(c => c.is_primary);
          setSelectedPrimaryLocation(primaryCenter?.location_id || '');
          setSelectedLocations(userCenters.map(c => c.location_id));
        }
      }
    };
    fetchData();
  }, [labId, user?.id]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!labId) {
      console.error('labId is missing in UserFormComponent', { labId, user });
      setError('Lab context not found. Please refresh the page and try again.');
      return;
    }

    try {
      setSaving(true);
      setError(null);

      // Find role ID from role selection
      const selectedRole = availableRoles.find(r => r.id === formData.roleId);

      if (!selectedRole) {
        setError('Please select a valid role');
        return;
      }

      let userId: string;

      if (user) {
        // Update existing user
        const { error: updateError } = await supabase
          .from('users')
          .update({
            name: formData.name,
            email: formData.email,
            role_id: selectedRole.id,
            department: formData.department,
            phone: formData.phone,
            updated_at: new Date().toISOString(),
          })
          .eq('id', user.id);

        if (updateError) throw updateError;
        userId = user.id;
      } else {
        // Create new user (note: this should ideally be done through Auth system)
        console.log('Creating user with lab_id:', labId);
        const { data: newUser, error: insertError } = await supabase
          .from('users')
          .insert({
            name: formData.name,
            email: formData.email,
            role_id: selectedRole.id,
            department: formData.department,
            phone: formData.phone,
            lab_id: labId,
            status: 'Active',
            join_date: new Date().toISOString(),
            created_at: new Date().toISOString(),
          })
          .select('id')
          .single();

        if (insertError || !newUser) throw insertError || new Error('Failed to create user');
        userId = newUser.id;
      }

      // Update user_centers (location assignments)
      // First, delete existing assignments if updating
      if (user) {
        await supabase
          .from('user_centers')
          .delete()
          .eq('user_id', userId);
      }

      // Insert new location assignments
      if (selectedLocations.length > 0) {
        const userCenters = selectedLocations.map(locationId => ({
          user_id: userId,
          location_id: locationId,
          is_primary: locationId === selectedPrimaryLocation,
          created_at: new Date().toISOString(),
        }));

        const { error: centersError } = await supabase
          .from('user_centers')
          .insert(userCenters);

        if (centersError) throw centersError;
      }

      onSave?.();
      onClose();
    } catch (err) {
      console.error('Error creating user:', err);
      setError(err instanceof Error ? err.message : 'Failed to save user');
    } finally {
      setSaving(false);
    }
  };

  const handlePermissionToggle = (permissionId: string) => {
    setFormData(prev => ({
      ...prev,
      permissions: prev.permissions.includes(permissionId)
        ? prev.permissions.filter(id => id !== permissionId)
        : [...prev.permissions, permissionId]
    }));
  };

  const handleLocationToggle = (locationId: string) => {
    setSelectedLocations(prev =>
      prev.includes(locationId)
        ? prev.filter(id => id !== locationId)
        : [...prev, locationId]
    );

    // If unchecking the primary location, clear it
    if (selectedPrimaryLocation === locationId && selectedLocations.includes(locationId)) {
      setSelectedPrimaryLocation('');
    }
  };

  return (
    <div className="fixed inset-0 bg-gray-600 bg-opacity-75 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <h2 className="text-xl font-semibold text-gray-900">
            {user ? 'Edit User' : 'Add New User'}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-500">
            <XCircle className="h-6 w-6" />
          </button>
        </div>

        {error && (
          <div className="p-4 bg-red-50 border-b border-red-200">
            <div className="text-sm text-red-700">{error}</div>
          </div>
        )}

        <form onSubmit={handleSubmit} className="p-6 space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Full Name *
              </label>
              <input
                type="text"
                required
                value={formData.name}
                onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Email Address *
              </label>
              <input
                type="email"
                required
                value={formData.email}
                onChange={(e) => setFormData(prev => ({ ...prev, email: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Role *
              </label>
              <select
                required
                value={formData.roleId}
                onChange={(e) => setFormData(prev => ({ ...prev, roleId: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">Select a role</option>
                {availableRoles.map(role => (
                  <option key={role.id} value={role.id}>{role.role_name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Department
              </label>
              <input
                type="text"
                value={formData.department}
                onChange={(e) => setFormData(prev => ({ ...prev, department: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Primary Location
              </label>
              <select
                value={selectedPrimaryLocation}
                onChange={(e) => {
                  const newPrimary = e.target.value;
                  setSelectedPrimaryLocation(newPrimary);
                  // If a location is set as primary, ensure it's also in the selected locations
                  if (newPrimary && !selectedLocations.includes(newPrimary)) {
                    setSelectedLocations(prev => [...prev, newPrimary]);
                  }
                }}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">No primary location</option>
                {locations.map(location => (
                  <option key={location.id} value={location.id}>{location.name}</option>
                ))}
              </select>
              <p className="text-xs text-gray-500 mt-1">Main work location for this user</p>
            </div>
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Phone Number
              </label>
              <input
                type="tel"
                value={formData.phone}
                onChange={(e) => setFormData(prev => ({ ...prev, phone: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          {/* Location Access Section */}
          {locations.length > 0 && (
            <div>
              <h3 className="text-lg font-medium text-gray-900 mb-2">Location Access</h3>
              <p className="text-sm text-gray-600 mb-4">
                Select which locations this user can access. Leave empty to grant access to all locations.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {locations.map(location => (
                  <label
                    key={location.id}
                    className={`flex items-center p-3 border rounded-lg hover:bg-gray-50 cursor-pointer ${selectedPrimaryLocation === location.id
                      ? 'border-blue-500 bg-blue-50'
                      : 'border-gray-200'
                      }`}
                  >
                    <input
                      type="checkbox"
                      checked={selectedLocations.includes(location.id)}
                      onChange={() => handleLocationToggle(location.id)}
                      className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                    />
                    <div className="ml-3 flex-1">
                      <div className="flex items-center justify-between">
                        <div className="text-sm font-medium text-gray-900">{location.name}</div>
                        {selectedPrimaryLocation === location.id && (
                          <span className="ml-2 px-2 py-0.5 text-xs font-medium bg-blue-100 text-blue-700 rounded">
                            Primary
                          </span>
                        )}
                      </div>
                      {location.address && (
                        <div className="text-xs text-gray-500">{location.address}</div>
                      )}
                    </div>
                  </label>
                ))}
              </div>
            </div>
          )}

          <div>
            <h3 className="text-lg font-medium text-gray-900 mb-4">Permissions</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {permissions.map(permission => (
                <label key={permission.id} className="flex items-start p-3 border border-gray-200 rounded-lg hover:bg-gray-50 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formData.permissions.includes(permission.id)}
                    onChange={() => handlePermissionToggle(permission.id)}
                    className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded mt-1"
                  />
                  <div className="ml-3">
                    <div className="text-sm font-medium text-gray-900">{permission.name}</div>
                    <div className="text-xs text-gray-500">{permission.description}</div>
                    <div className="text-xs text-blue-600">{permission.category}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-end space-x-4 pt-6 border-t border-gray-200">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-6 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:bg-gray-400"
            >
              {saving ? 'Saving...' : user ? 'Update User' : 'Create User'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

const Settings: React.FC = () => {
  const { user: authUser } = useAuth();
  const { loading: permissionsLoading, hasPermission } = usePermissions();
  const { status: qzStatus, connect: qzConnect, disconnect: qzDisconnect, refreshSettings: refreshPrintSettings } = useQZTray();
  const { refresh: refreshSampleTypeColors } = useSampleTypeColors();
  const [activeTab, setActiveTab] = useState<'team' | 'permissions' | 'usage' | 'lab' | 'accession' | 'notifications' | 'invoices' | 'analyzer' | 'patient_portal' | 'billing_items' | 'price_masters' | 'patient_form' | 'payment_gateway'>('team');
  const [showUserForm, setShowUserForm] = useState(false);
  const [showEditUserModal, setShowEditUserModal] = useState(false);
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedRole, setSelectedRole] = useState('All');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [labId, setLabId] = useState<string | null>(null);
  const [labInterfaceEnabled, setLabInterfaceEnabled] = useState(false);
  const [savingLab, setSavingLab] = useState(false);
  const [uploadingPortalSlide, setUploadingPortalSlide] = useState<Record<number, boolean>>({});
  const [saveSuccess, setSaveSuccess] = useState(false);

  // Real database state
  const [users, setUsers] = useState<User[]>([]);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [availableRoles, setAvailableRoles] = useState<any[]>([]);
  const [labSettings, setLabSettings] = useState<LabSettings | null>(null);
  const [syncedWhatsAppUsers, setSyncedWhatsAppUsers] = useState<{id: string; name: string; whatsapp_user_id: string}[]>([]);

  // Custom patient fields state
  const [customPatientFields, setCustomPatientFields] = useState<LabPatientFieldConfig[]>([]);
  const [showAddFieldForm, setShowAddFieldForm] = useState(false);
  const [editingField, setEditingField] = useState<LabPatientFieldConfig | null>(null);
  const [fieldForm, setFieldForm] = useState({ field_key: '', label: '', field_type: 'text' as 'text'|'number'|'select', options: '', searchable: false, required: false, use_for_ai_ref_range: false });
  const [savingField, setSavingField] = useState(false);
  const [usageStats, setUsageStats] = useState<UsageStats>({
    totalUsers: 0,
    activeUsers: 0,
    totalTests: 0,
    totalPatients: 0,
    storageUsed: 0,
    storageLimit: 10,
    apiCalls: 0,
    apiLimit: 100000,
  });

  // Flag usage tracking for validation when deleting
  const [flagUsageCounts, setFlagUsageCounts] = useState<Record<string, number>>({});
  const [checkingFlagUsage, setCheckingFlagUsage] = useState(false);

  // Check flag usage when lab settings are loaded
  const checkFlagUsage = async (currentLabId: string) => {
    setCheckingFlagUsage(true);
    try {
      const { data, error } = await supabase
        .from('result_values')
        .select('flag')
        .eq('lab_id', currentLabId)
        .not('flag', 'is', null)
        .not('flag', 'eq', '');

      if (!error && data) {
        const counts: Record<string, number> = {};
        data.forEach((row: { flag: string }) => {
          const flag = row.flag?.trim();
          if (flag) {
            counts[flag] = (counts[flag] || 0) + 1;
          }
        });
        setFlagUsageCounts(counts);
      }
    } catch { /* non-critical */ }
    setCheckingFlagUsage(false);
  };

  // Load data from database
  useEffect(() => {
    const loadData = async () => {
      try {
        setLoading(true);
        setError(null);

        if (!authUser?.id) {
          setError('User not authenticated');
          console.error('Auth user not found');
          return;
        }

        // Get lab_id using the centralized method
        const currentLabId = await database.getCurrentUserLabId();
        console.log('getCurrentUserLabId result:', currentLabId, 'for user:', authUser.email);

        if (!currentLabId) {
          setError('Lab context not found. User may not be assigned to any lab.');
          console.error('No lab_id found for user:', authUser.email);
          return;
        }

        // Store lab_id in state for use in modal
        setLabId(currentLabId);
        console.log('Lab ID set to state:', currentLabId);

        // Load lab settings
        const { data: labData, error: labError } = await database.labs.getById(currentLabId);
        if (!labError && labData) {
          setLabInterfaceEnabled(!!(labData as any).lab_interface_enabled);
          setLabSettings({
            id: labData.id,
            name: labData.name || '',
            code: labData.code || '',
            address: labData.address || '',
            city: labData.city || '',
            state: labData.state || '',
            pincode: labData.pincode || '',
            phone: labData.phone || '',
            email: labData.email || '',
            email_domain: labData.email_domain || '',
            license_number: labData.license_number || '',
            registration_number: labData.registration_number || '',
            gst_number: (labData as any).gst_number || '',
            upi_id: (labData as any).upi_id || '',
            whatsapp_user_id: (labData as any).whatsapp_user_id || null,
            bank_details: (labData as any).bank_details || null,
            watermark_enabled: labData.watermark_enabled || false,
            watermark_opacity: labData.watermark_opacity || 0.15,
            watermark_position: labData.watermark_position || 'center',
            watermark_size: labData.watermark_size || 'medium',
            watermark_rotation: labData.watermark_rotation || 0,
            preferred_language: labData.preferred_language || 'english',
            country_code: (labData as any).country_code || '+91',
            default_template_style: (labData as any).default_template_style || 'beautiful',
            show_methodology: (labData as any).show_methodology ?? true,
            show_interpretation: (labData as any).show_interpretation ?? false,
            flag_options: (labData as any).flag_options || [
              { value: '', label: 'Normal' },
              { value: 'H', label: 'High' },
              { value: 'L', label: 'Low' },
              { value: 'A', label: 'Abnormal' },
              { value: 'C', label: 'Critical' },
            ],
            loyalty_enabled: (labData as any).loyalty_enabled ?? false,
            loyalty_conversion_rate: (labData as any).loyalty_conversion_rate ?? 0.1,
            loyalty_min_redeem_points: (labData as any).loyalty_min_redeem_points ?? 100,
            loyalty_point_value: (labData as any).loyalty_point_value ?? 1.0,
            block_send_on_due: (labData as any).block_send_on_due ?? false,
            report_patient_info_config: (labData as any).report_patient_info_config ?? null,
            print_options: (labData as any).pdf_layout_settings?.printOptions ?? null,
            result_colors: (labData as any).pdf_layout_settings?.resultColors ?? null,
            _pdf_layout_settings_raw: (labData as any).pdf_layout_settings ?? null,
            barcode_printer_name: (labData as any).barcode_printer_name ?? null,
            report_printer_name: (labData as any).report_printer_name ?? null,
            barcode_browser_print_enabled: (labData as any).barcode_browser_print_enabled ?? false,
            barcode_label_layout: normalizeLabelLayout((labData as any).barcode_label_layout),
            auto_collect_on_registration: (labData as any).auto_collect_on_registration ?? false,
            auto_open_collection_modal: (labData as any).auto_open_collection_modal ?? false,
            auto_print_barcode_on_order: (labData as any).auto_print_barcode_on_order ?? false,
            auto_print_report_on_approval: (labData as any).auto_print_report_on_approval ?? false,
            show_approve_all_in_result_entry: (labData as any).show_approve_all_in_result_entry ?? false,
            default_collapsed_order_cards: (labData as any).default_collapsed_order_cards ?? false,
            tat_alert_max_overdue_hours: (labData as any).tat_alert_max_overdue_hours ?? 72,
            sample_type_colors: (labData as any).sample_type_colors ?? {},
            accession_collection_config: (labData as any).accession_collection_config ?? { sample_type_flows: {} },
            portal_settings: normalizePortalSettings((labData as any).portal_settings, true),
          });
        }

        // Load custom patient field configs
        const { data: fieldConfigs } = await database.labPatientFieldConfigs.getAll();
        if (fieldConfigs) setCustomPatientFields(fieldConfigs);

        // Load flag usage counts for validation
        checkFlagUsage(currentLabId);

        // Load ALL users for WhatsApp sender dropdown (use user.id as whatsapp_user_id)
        const { data: allLabUsers, error: allUsersError } = await supabase
          .from('users')
          .select('id, name, role, user_roles(role_name)')
          .eq('lab_id', currentLabId)
          .eq('status', 'Active')
          .order('name');
        
        console.log('[Settings] WhatsApp sender dropdown - Users for lab:', {
          labId: currentLabId,
          usersCount: allLabUsers?.length || 0,
          users: allLabUsers?.map(u => ({ id: u.id, name: u.name })),
          error: allUsersError
        });
        
        if (allLabUsers && allLabUsers.length > 0) {
          const usersForDropdown = allLabUsers.map(u => ({
            id: u.id,
            name: u.name || 'Unknown',
            whatsapp_user_id: u.id  // Use same user ID
          }));
          setSyncedWhatsAppUsers(usersForDropdown);
          
          // If lab doesn't have whatsapp_user_id set, auto-set to first Admin user
          if (!labData?.whatsapp_user_id) {
            const adminUser = allLabUsers.find(u => 
              (u.user_roles as any)?.role_name === 'Admin' || u.role === 'Admin'
            );
            if (adminUser) {
              // Auto-update lab's whatsapp_user_id
              await supabase
                .from('labs')
                .update({ whatsapp_user_id: adminUser.id })
                .eq('id', currentLabId);
              
              setLabSettings(prev => ({ ...prev, whatsapp_user_id: adminUser.id }));
              console.log(`✅ Auto-set lab whatsapp_user_id to Admin user: ${adminUser.name} (${adminUser.id})`);
            }
          }
        }

        // Load users for this lab
        const { data: labUsers, error: usersError } = await supabase
          .from('users')
          .select(`
            id,
            name,
            email,
            phone,
            contact_number,
            gender,
            department,
            department_id,
            departments!department_id(id, name),
            role_id,
            is_phlebotomist,
            clinic_keywords,
            status,
            last_login,
            join_date,
            user_roles(role_name, role_code)
          `)
          .eq('lab_id', currentLabId)
          .order('name');

        if (usersError) throw usersError;

        // Transform users data
        const transformedUsers: User[] = (labUsers || []).map((u: any) => ({
          id: u.id,
          name: u.name,
          email: u.email,
          role: u.user_roles?.role_name || 'Technician',
          role_id: u.role_id,
          department: u.departments?.name || u.department || '',
          department_id: u.department_id,
          contact_number: u.contact_number,
          gender: u.gender,
          is_phlebotomist: u.is_phlebotomist,
          clinic_keywords: u.clinic_keywords,
          status: u.status === 'Active' ? 'Active' : u.status === 'Inactive' ? 'Inactive' : 'Suspended',
          lastLogin: u.last_login || 'Never',
          permissions: [], // Will be loaded separately
          phone: u.phone || '',
          joinDate: u.join_date || new Date().toISOString(),
        }));

        setUsers(transformedUsers);

        // Load user roles
        const { data: rolesData, error: rolesError } = await supabase
          .from('user_roles')
          .select('id, role_name, role_code, is_active')
          .eq('is_active', true)
          .order('role_name');

        if (rolesError) throw rolesError;
        setAvailableRoles(rolesData || []);

        // Load permissions
        const { data: permsData, error: permsError } = await supabase
          .from('permissions')
          .select('id, permission_name, description, category, is_active')
          .eq('is_active', true)
          .order('category, permission_name');

        if (permsError) throw permsError;

        const transformedPermissions: Permission[] = (permsData || []).map((p: any) => ({
          id: p.id,
          name: p.permission_name,
          description: p.description || '',
          category: p.category || 'General',
          isDefault: false,
        }));

        setPermissions(transformedPermissions);

        // Load usage stats
        const { count: totalUsersCount } = await supabase
          .from('users')
          .select('id', { count: 'exact' })
          .eq('lab_id', currentLabId);

        const { count: activeUsersCount } = await supabase
          .from('users')
          .select('id', { count: 'exact' })
          .eq('lab_id', currentLabId)
          .eq('status', 'Active');

        const { count: totalTestsCount } = await supabase
          .from('order_tests')
          .select('id', { count: 'exact' })
          .eq('lab_id', currentLabId);

        const { count: totalPatientsCount } = await supabase
          .from('patients')
          .select('id', { count: 'exact' })
          .eq('lab_id', currentLabId);

        setUsageStats(prev => ({
          ...prev,
          totalUsers: totalUsersCount || 0,
          activeUsers: activeUsersCount || 0,
          totalTests: totalTestsCount || 0,
          totalPatients: totalPatientsCount || 0,
        }));
      } catch (err) {
        console.error('Error loading settings data:', err);
        setError(err instanceof Error ? err.message : 'Failed to load data');
      } finally {
        setLoading(false);
      }
    };

    loadData();
  }, [authUser?.id]);

  const tabs = [
    { id: 'team', name: 'Team Management', icon: Users },
    { id: 'permissions', name: 'Permissions', icon: Shield },
    { id: 'usage', name: 'Usage & Analytics', icon: BarChart3 },
    { id: 'lab', name: 'Lab Settings', icon: Building },
    { id: 'accession', name: 'Accession', icon: ClipboardCheck },
    { id: 'notifications', name: 'Notifications', icon: Bell },
    { id: 'invoices', name: 'Invoice Templates', icon: FileText },
    ...(labInterfaceEnabled ? [{ id: 'analyzer', name: 'Analyzer Interface', icon: Activity }] : []),
    { id: 'patient_portal', name: 'Patient Portal', icon: Smartphone },
    { id: 'public_booking', name: 'Public Booking Link', icon: Globe },
    { id: 'patient_form', name: 'Patient Form', icon: UserCheck },
    { id: 'billing_items', name: 'Billing Items', icon: FileText },
    { id: 'price_masters', name: 'Price Masters', icon: Tag },
    { id: 'payment_gateway', name: 'Payment Gateway', icon: CreditCard },
  ];

  const roles = availableRoles.length > 0
    ? ['All', ...availableRoles.map(r => r.role_name)]
    : ['All', 'Admin', 'Lab Manager', 'Technician', 'Receptionist', 'Doctor'];

  const filteredUsers = users.filter(user => {
    const matchesSearch = user.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      user.email.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesRole = selectedRole === 'All' || user.role === selectedRole;
    return matchesSearch && matchesRole;
  });

  const portalSettings = normalizePortalSettings(labSettings?.portal_settings, true);

  // Delete user (soft delete)
  const handleDeleteUser = async (userId: string) => {
    if (!window.confirm('Are you sure you want to delete this user?')) return;

    try {
      const { error } = await supabase
        .from('users')
        .update({ status: 'Inactive', updated_at: new Date().toISOString() })
        .eq('id', userId);

      if (error) throw error;

      setUsers(users.filter(u => u.id !== userId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete user');
    }
  };

  // ── Custom Patient Fields ────────────────────────────────────────
  const resetFieldForm = () => {
    setFieldForm({ field_key: '', label: '', field_type: 'text', options: '', searchable: false, required: false });
    setEditingField(null);
    setShowAddFieldForm(false);
  };

  const handleSaveField = async () => {
    if (!fieldForm.field_key.trim() || !fieldForm.label.trim()) return;
    setSavingField(true);
    try {
      const payload = {
        field_key: fieldForm.field_key.trim().toLowerCase().replace(/\s+/g, '_'),
        label: fieldForm.label.trim(),
        field_type: fieldForm.field_type,
        options: fieldForm.field_type === 'select' && fieldForm.options
          ? fieldForm.options.split(',').map(o => o.trim()).filter(Boolean)
          : null,
        searchable: fieldForm.searchable,
        required: fieldForm.required,
        use_for_ai_ref_range: fieldForm.use_for_ai_ref_range,
        sort_order: editingField ? editingField.sort_order : customPatientFields.length,
      };
      if (editingField) {
        const { data } = await database.labPatientFieldConfigs.update(editingField.id, payload);
        if (data) setCustomPatientFields(prev => prev.map(f => f.id === data.id ? data : f));
      } else {
        const { data } = await database.labPatientFieldConfigs.create(payload);
        if (data) setCustomPatientFields(prev => [...prev, data]);
      }
      resetFieldForm();
    } finally {
      setSavingField(false);
    }
  };

  const handleDeleteField = async (id: string) => {
    if (!confirm('Delete this custom field? Existing patient data for this field will remain in the database but will no longer be displayed.')) return;
    const { error } = await database.labPatientFieldConfigs.delete(id);
    if (!error) setCustomPatientFields(prev => prev.filter(f => f.id !== id));
  };

  const handleEditField = (field: LabPatientFieldConfig) => {
    setEditingField(field);
    setFieldForm({
      field_key: field.field_key,
      label: field.label,
      field_type: field.field_type,
      options: Array.isArray(field.options) ? field.options.join(', ') : '',
      searchable: field.searchable,
      required: field.required,
      use_for_ai_ref_range: field.use_for_ai_ref_range ?? false,
    });
    setShowAddFieldForm(true);
  };

  const handleMoveField = async (id: string, direction: 'up' | 'down') => {
    const idx = customPatientFields.findIndex(f => f.id === id);
    if ((direction === 'up' && idx === 0) || (direction === 'down' && idx === customPatientFields.length - 1)) return;
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    const reordered = [...customPatientFields];
    [reordered[idx], reordered[swapIdx]] = [reordered[swapIdx], reordered[idx]];
    setCustomPatientFields(reordered);
    // Persist new sort_orders
    await Promise.all(reordered.map((f, i) => database.labPatientFieldConfigs.update(f.id, { sort_order: i })));
  };
  // ────────────────────────────────────────────────────────────────

  const updatePortalSettings = (patch: Partial<PortalSettings>) => {
    setLabSettings(prev => prev ? {
      ...prev,
      portal_settings: normalizePortalSettings({
        ...normalizePortalSettings(prev.portal_settings, true),
        ...patch,
      }, true),
    } : prev);
  };

  const updatePortalSlide = (index: number, patch: Partial<PortalUpdateSlide>) => {
    const current = normalizePortalSettings(labSettings?.portal_settings, true);
    updatePortalSettings({
      update_slides: current.update_slides.map((slide, slideIndex) =>
        slideIndex === index ? { ...slide, ...patch } : slide
      ),
    });
  };

  const addPortalSlide = () => {
    const current = normalizePortalSettings(labSettings?.portal_settings, true);
    updatePortalSettings({
      update_slides: [...current.update_slides, { title: '', message: '', image_url: '' }],
    });
  };

  const removePortalSlide = (index: number) => {
    const current = normalizePortalSettings(labSettings?.portal_settings, true);
    updatePortalSettings({
      update_slides: current.update_slides.filter((_, slideIndex) => slideIndex !== index),
    });
  };

  const updateAnnouncementSlide = (index: number, patch: Partial<PortalAnnouncement>) => {
    const current = normalizePortalSettings(labSettings?.portal_settings, true);
    updatePortalSettings({
      announcement_slides: current.announcement_slides.map((slide, slideIndex) =>
        slideIndex === index ? { ...slide, ...patch } : slide
      ),
    });
  };

  const addAnnouncementSlide = () => {
    const current = normalizePortalSettings(labSettings?.portal_settings, true);
    updatePortalSettings({
      announcement_slides: [...current.announcement_slides, { title: '', message: '' }],
    });
  };

  const removeAnnouncementSlide = (index: number) => {
    const current = normalizePortalSettings(labSettings?.portal_settings, true);
    updatePortalSettings({
      announcement_slides: current.announcement_slides.filter((_, slideIndex) => slideIndex !== index),
    });
  };

  const handlePortalSlideImageUpload = async (index: number, file?: File | null) => {
    if (!file || !labId) return;

    if (!file.type.startsWith('image/')) {
      setError('Please upload an image file for the promotional slider.');
      return;
    }

    try {
      setError(null);
      setUploadingPortalSlide(prev => ({ ...prev, [index]: true }));
      const filePath = generateFilePath(file.name, undefined, labId, 'portal-promotions');
      const result = await uploadFile(file, filePath, { upsert: true });
      updatePortalSlide(index, { image_url: result.publicUrl });
    } catch (err) {
      console.error('Failed to upload portal slide image:', err);
      setError(err instanceof Error ? err.message : 'Failed to upload promotional image.');
    } finally {
      setUploadingPortalSlide(prev => ({ ...prev, [index]: false }));
    }
  };

  // Save lab settings
  const handleSaveLabSettings = async () => {
    if (!labSettings || !labId) return;

    try {
      setSavingLab(true);
      setError(null);

      const { error: updateError } = await database.labs.update(labId, {
        name: labSettings.name,
        code: labSettings.code,
        address: labSettings.address,
        city: labSettings.city,
        state: labSettings.state,
        pincode: labSettings.pincode,
        phone: labSettings.phone,
        email: labSettings.email,
        license_number: labSettings.license_number,
        registration_number: labSettings.registration_number,
        gst_number: labSettings.gst_number || null,
        upi_id: labSettings.upi_id || null,
        whatsapp_user_id: labSettings.whatsapp_user_id || null,
        bank_details: labSettings.bank_details || null,
        watermark_enabled: labSettings.watermark_enabled,
        watermark_opacity: labSettings.watermark_opacity,
        watermark_position: labSettings.watermark_position,
        watermark_size: labSettings.watermark_size,
        watermark_rotation: labSettings.watermark_rotation,
        preferred_language: labSettings.preferred_language,
        country_code: labSettings.country_code || '+91',
        default_template_style: labSettings.default_template_style || 'beautiful',
        show_methodology: labSettings.show_methodology ?? true,
        show_interpretation: labSettings.show_interpretation ?? false,
        flag_options: labSettings.flag_options || null,
        loyalty_enabled: labSettings.loyalty_enabled ?? false,
        loyalty_conversion_rate: labSettings.loyalty_conversion_rate ?? 0.1,
        loyalty_min_redeem_points: labSettings.loyalty_min_redeem_points ?? 100,
        loyalty_point_value: labSettings.loyalty_point_value ?? 1.0,
        block_send_on_due: labSettings.block_send_on_due ?? false,
        report_patient_info_config: labSettings.report_patient_info_config ?? null,
        barcode_printer_name: labSettings.barcode_printer_name || null,
        report_printer_name: labSettings.report_printer_name || null,
        barcode_browser_print_enabled: labSettings.barcode_browser_print_enabled ?? false,
        barcode_label_layout: normalizeLabelLayout(labSettings.barcode_label_layout),
        auto_collect_on_registration: labSettings.auto_collect_on_registration ?? false,
        auto_open_collection_modal: labSettings.auto_open_collection_modal ?? false,
        auto_print_barcode_on_order: labSettings.auto_print_barcode_on_order ?? false,
        auto_print_report_on_approval: labSettings.auto_print_report_on_approval ?? false,
        show_approve_all_in_result_entry: labSettings.show_approve_all_in_result_entry ?? false,
        default_collapsed_order_cards: labSettings.default_collapsed_order_cards ?? false,
        tat_alert_max_overdue_hours: labSettings.tat_alert_max_overdue_hours ?? 72,
        sample_type_colors: labSettings.sample_type_colors || {},
        accession_collection_config: labSettings.accession_collection_config || { sample_type_flows: {} },
        portal_settings: normalizePortalSettings(labSettings.portal_settings),
        pdf_layout_settings: {
          ...(labSettings._pdf_layout_settings_raw || {}),
          printOptions: labSettings.print_options ?? undefined,
          ...(labSettings.result_colors ? { resultColors: labSettings.result_colors } : {}),
        },
      } as any);

      if (updateError) throw updateError;

      // Refresh sample type colors context so UI updates immediately
      await refreshSampleTypeColors();

      // Re-resolve printer settings so the new label layout applies immediately
      // to every print path without a page reload.
      await refreshPrintSettings();

      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err) {
      console.error('Error saving lab settings:', err);
      setError(err instanceof Error ? err.message : 'Failed to save lab settings');
    } finally {
      setSavingLab(false);
    }
  };

  // Reload users helper
  const reloadUsers = async () => {
    if (!labId) return;
    const { data: labUsers } = await supabase
      .from('users')
      .select(`
        id,
        name,
        email,
        phone,
        contact_number,
        gender,
        department,
        department_id,
        departments!department_id(id, name),
        role_id,
        is_phlebotomist,
        clinic_keywords,
        status,
        last_login,
        join_date,
        user_roles(role_name, role_code)
      `)
      .eq('lab_id', labId)
      .order('name');

    setUsers((labUsers || []).map((u: any) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.user_roles?.role_name || 'Technician',
      role_id: u.role_id,
      department: u.departments?.name || u.department || '',
      department_id: u.department_id,
      contact_number: u.contact_number,
      gender: u.gender,
      is_phlebotomist: u.is_phlebotomist,
      clinic_keywords: u.clinic_keywords,
      status: u.status === 'Active' ? 'Active' : u.status === 'Inactive' ? 'Inactive' : 'Suspended',
      lastLogin: u.last_login || 'Never',
      permissions: [],
      phone: u.phone || '',
      joinDate: u.join_date || new Date().toISOString(),
    })));
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'Active': return 'text-green-600 bg-green-100';
      case 'Inactive': return 'text-gray-600 bg-gray-100';
      case 'Suspended': return 'text-red-600 bg-red-100';
      default: return 'text-gray-600 bg-gray-100';
    }
  };

  const getRoleColor = (role: string) => {
    switch (role) {
      case 'Admin': return 'text-purple-600 bg-purple-100';
      case 'Lab Manager': return 'text-blue-600 bg-blue-100';
      case 'Technician': return 'text-green-600 bg-green-100';
      case 'Receptionist': return 'text-orange-600 bg-orange-100';
      case 'Doctor': return 'text-red-600 bg-red-100';
      default: return 'text-gray-600 bg-gray-100';
    }
  };

  const canViewSettings = hasPermission('settings.view') || hasPermission('settings.edit_lab');

  if (permissionsLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
      </div>
    );
  }

  if (!canViewSettings) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center max-w-md">
          <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <Shield className="h-8 w-8 text-red-600" />
          </div>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">Access Denied</h2>
          <p className="text-gray-600">
            You don't have permission to access Settings.
            Ask an administrator to grant `settings.view`.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col bg-gray-50">
      {/* Header and Tabs */}
      <div className="flex-none p-4 sm:p-6 pb-0 space-y-4 sm:space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Settings</h1>
            <p className="text-gray-600 mt-1">Manage your LIMS system configuration and team</p>
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-2 sm:p-1">
          <div className="sm:hidden">
            <label className="block px-1 pb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
              Section
            </label>
            <select
              value={activeTab}
              onChange={(e) => setActiveTab(e.target.value as any)}
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm font-medium text-gray-800 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
            >
              {tabs.map((tab) => (
                <option key={tab.id} value={tab.id}>
                  {tab.name}
                </option>
              ))}
            </select>
          </div>
          <div className="hidden sm:flex sm:flex-wrap sm:gap-1">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={`flex items-center px-4 py-3 rounded-md text-sm font-medium transition-all whitespace-nowrap ${activeTab === tab.id
                  ? 'bg-primary-600 text-white shadow-sm'
                  : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50'
                  }`}
              >
                <tab.icon className="h-4 w-4 mr-2" />
                {tab.name}
              </button>
            ))}
          </div>
          <div className="mt-3 flex gap-2 overflow-x-auto scrollbar-hide sm:hidden">
            {tabs.map((tab) => (
              <button
                key={`${tab.id}-mobile-chip`}
                onClick={() => setActiveTab(tab.id as any)}
                className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                  activeTab === tab.id
                    ? 'bg-primary-100 text-primary-700'
                    : 'bg-gray-100 text-gray-600'
                }`}
              >
                {tab.name}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Content Area - scrolls with the main application page */}
      <div className="flex-1 p-4 sm:p-6 pt-4">

        {/* Team Management Tab */}
        {activeTab === 'team' && (
          <div className="space-y-6">
            {loading && (
              <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-8 text-center">
                <div className="text-gray-500">Loading team data...</div>
              </div>
            )}

            {error && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                <div className="text-sm text-red-700">{error}</div>
              </div>
            )}
            {/* Team Stats */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
              <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
                <div className="flex items-center">
                  <div className="bg-blue-100 p-3 rounded-lg">
                    <Users className="h-6 w-6 text-blue-600" />
                  </div>
                  <div className="ml-4">
                    <div className="text-2xl font-bold text-gray-900">{usageStats.totalUsers}</div>
                    <div className="text-sm text-gray-600">Total Users</div>
                  </div>
                </div>
              </div>
              <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
                <div className="flex items-center">
                  <div className="bg-green-100 p-3 rounded-lg">
                    <UserCheck className="h-6 w-6 text-green-600" />
                  </div>
                  <div className="ml-4">
                    <div className="text-2xl font-bold text-gray-900">{usageStats.activeUsers}</div>
                    <div className="text-sm text-gray-600">Active Users</div>
                  </div>
                </div>
              </div>
              <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
                <div className="flex items-center">
                  <div className="bg-orange-100 p-3 rounded-lg">
                    <Clock className="h-6 w-6 text-orange-600" />
                  </div>
                  <div className="ml-4">
                    <div className="text-2xl font-bold text-gray-900">
                      {users.filter(u => new Date(u.lastLogin) > new Date(Date.now() - 24 * 60 * 60 * 1000)).length}
                    </div>
                    <div className="text-sm text-gray-600">Online Today</div>
                  </div>
                </div>
              </div>
              <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
                <div className="flex items-center">
                  <div className="bg-purple-100 p-3 rounded-lg">
                    <Shield className="h-6 w-6 text-purple-600" />
                  </div>
                  <div className="ml-4">
                    <div className="text-2xl font-bold text-gray-900">
                      {users.filter(u => u.role === 'Admin').length}
                    </div>
                    <div className="text-sm text-gray-600">Administrators</div>
                  </div>
                </div>
              </div>
            </div>

            {/* Search and Filter */}
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
              <div className="flex flex-col sm:flex-row gap-4">
                <div className="flex-1 relative">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
                  <input
                    type="text"
                    placeholder="Search users by name or email..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="pl-10 pr-4 py-2 w-full border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <select
                  value={selectedRole}
                  onChange={(e) => setSelectedRole(e.target.value)}
                  className="px-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {roles.map(role => (
                    <option key={role} value={role}>{role}</option>
                  ))}
                </select>
                <button
                  onClick={() => {
                    if (!labId) {
                      alert('Lab context is still loading. Please wait...');
                      return;
                    }
                    setShowUserForm(true);
                  }}
                  disabled={!labId}
                  className="flex items-center px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
                >
                  <Plus className="h-4 w-4 mr-2" />
                  Add User
                </button>
              </div>
            </div>

            {/* Users Table */}
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
              <div className="px-6 py-4 border-b border-gray-200">
                <h3 className="text-lg font-semibold text-gray-900">Team Members ({filteredUsers.length})</h3>
              </div>

              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">User</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Role</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Department</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Last Login</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {filteredUsers.map((user) => (
                      <tr key={user.id} className="hover:bg-gray-50">
                        <td className="px-6 py-4 whitespace-nowrap">
                          <div className="flex items-center">
                            <div className="h-10 w-10 bg-blue-500 rounded-full flex items-center justify-center">
                              <span className="text-white font-medium">
                                {user.name.split(' ').map(n => n[0]).join('')}
                              </span>
                            </div>
                            <div className="ml-4">
                              <div className="text-sm font-medium text-gray-900">{user.name}</div>
                              <div className="text-sm text-gray-500">{user.email}</div>
                            </div>
                          </div>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getRoleColor(user.role)}`}>
                            {user.role}
                          </span>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                          {user.department}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusColor(user.status)}`}>
                            {user.status}
                          </span>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                          {new Date(user.lastLogin).toLocaleDateString()}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-medium space-x-2">
                          <button
                            onClick={() => { setSelectedUser(user); setShowEditUserModal(true); }}
                            className="text-blue-600 hover:text-blue-900 p-1 rounded"
                            title="View User"
                          >
                            <Eye className="h-4 w-4" />
                          </button>
                          <button
                            onClick={() => { setSelectedUser(user); setShowEditUserModal(true); }}
                            className="text-gray-600 hover:text-gray-900 p-1 rounded"
                            title="Edit User"
                          >
                            <Edit className="h-4 w-4" />
                          </button>
                          <button
                            onClick={() => handleDeleteUser(user.id)}
                            className="text-red-600 hover:text-red-900 p-1 rounded"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* Permissions Tab */}
        {activeTab === 'permissions' && (
          <div className="space-y-6">
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
              <h3 className="text-lg font-semibold text-gray-900 mb-4">Permission Management</h3>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {Object.entries(
                  permissions.reduce((acc, permission) => {
                    if (!acc[permission.category]) acc[permission.category] = [];
                    acc[permission.category].push(permission);
                    return acc;
                  }, {} as Record<string, Permission[]>)
                ).map(([category, categoryPermissions]) => (
                  <div key={category} className="border border-gray-200 rounded-lg p-4">
                    <h4 className="font-medium text-gray-900 mb-3 flex items-center">
                      <Shield className="h-4 w-4 mr-2 text-blue-600" />
                      {category}
                    </h4>
                    <div className="space-y-2">
                      {categoryPermissions.map(permission => (
                        <div key={permission.id} className="flex items-start justify-between">
                          <div className="flex-1">
                            <div className="text-sm font-medium text-gray-900">{permission.name}</div>
                            <div className="text-xs text-gray-500">{permission.description}</div>
                          </div>
                          {permission.isDefault && (
                            <span className="text-xs bg-green-100 text-green-800 px-2 py-1 rounded">Default</span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Usage & Analytics Tab */}
        {activeTab === 'usage' && (
          <div className="space-y-6">
            {/* Usage Overview */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
              <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-2xl font-bold text-gray-900">{usageStats.totalTests.toLocaleString()}</div>
                    <div className="text-sm text-gray-600">Total Tests</div>
                  </div>
                  <div className="bg-blue-100 p-3 rounded-lg">
                    <Activity className="h-6 w-6 text-blue-600" />
                  </div>
                </div>
              </div>

              <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-2xl font-bold text-gray-900">{usageStats.totalPatients.toLocaleString()}</div>
                    <div className="text-sm text-gray-600">Total Patients</div>
                  </div>
                  <div className="bg-green-100 p-3 rounded-lg">
                    <Users className="h-6 w-6 text-green-600" />
                  </div>
                </div>
              </div>

              <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-2xl font-bold text-gray-900">{usageStats.storageUsed}GB</div>
                    <div className="text-sm text-gray-600">Storage Used</div>
                    <div className="w-full bg-gray-200 rounded-full h-2 mt-2">
                      <div
                        className="bg-orange-600 h-2 rounded-full"
                        style={{ width: `${(usageStats.storageUsed / usageStats.storageLimit) * 100}%` }}
                      />
                    </div>
                  </div>
                  <div className="bg-orange-100 p-3 rounded-lg">
                    <Database className="h-6 w-6 text-orange-600" />
                  </div>
                </div>
              </div>

              <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-2xl font-bold text-gray-900">{usageStats.apiCalls.toLocaleString()}</div>
                    <div className="text-sm text-gray-600">API Calls</div>
                    <div className="w-full bg-gray-200 rounded-full h-2 mt-2">
                      <div
                        className="bg-purple-600 h-2 rounded-full"
                        style={{ width: `${(usageStats.apiCalls / usageStats.apiLimit) * 100}%` }}
                      />
                    </div>
                  </div>
                  <div className="bg-purple-100 p-3 rounded-lg">
                    <Server className="h-6 w-6 text-purple-600" />
                  </div>
                </div>
              </div>
            </div>

            {/* System Health */}
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
              <h3 className="text-lg font-semibold text-gray-900 mb-4">System Health</h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div className="flex items-center justify-between p-4 bg-green-50 border border-green-200 rounded-lg">
                  <div className="flex items-center">
                    <CheckCircle className="h-5 w-5 text-green-600 mr-3" />
                    <div>
                      <div className="font-medium text-green-900">Database</div>
                      <div className="text-sm text-green-700">Operational</div>
                    </div>
                  </div>
                  <div className="text-green-600">99.9%</div>
                </div>

                <div className="flex items-center justify-between p-4 bg-green-50 border border-green-200 rounded-lg">
                  <div className="flex items-center">
                    <CheckCircle className="h-5 w-5 text-green-600 mr-3" />
                    <div>
                      <div className="font-medium text-green-900">API Services</div>
                      <div className="text-sm text-green-700">Operational</div>
                    </div>
                  </div>
                  <div className="text-green-600">99.8%</div>
                </div>

                <div className="flex items-center justify-between p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
                  <div className="flex items-center">
                    <AlertTriangle className="h-5 w-5 text-yellow-600 mr-3" />
                    <div>
                      <div className="font-medium text-yellow-900">Backup System</div>
                      <div className="text-sm text-yellow-700">Warning</div>
                    </div>
                  </div>
                  <div className="text-yellow-600">95.2%</div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Lab Settings Tab */}
        {activeTab === 'lab' && (
          <div className="space-y-6">
            {loading ? (
              <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-8 text-center">
                <Loader2 className="h-8 w-8 mx-auto animate-spin text-blue-600" />
                <div className="text-gray-500 mt-2">Loading lab settings...</div>
              </div>
            ) : error ? (
              <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                <div className="text-sm text-red-700">{error}</div>
              </div>
            ) : labSettings ? (
              <>
                {saveSuccess && (
                  <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                    <div className="flex items-center text-sm text-green-700">
                      <CheckCircle className="h-5 w-5 mr-2" />
                      Lab settings saved successfully!
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  {/* Basic Information */}
                  <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
                    <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center">
                      <Building className="h-5 w-5 mr-2 text-blue-600" />
                      Basic Information
                    </h3>
                    <div className="space-y-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Lab Name *</label>
                        <input
                          type="text"
                          value={labSettings.name}
                          onChange={(e) => setLabSettings(prev => prev ? { ...prev, name: e.target.value } : prev)}
                          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Lab Code *</label>
                        <input
                          type="text"
                          value={labSettings.code}
                          onChange={(e) => setLabSettings(prev => prev ? { ...prev, code: e.target.value } : prev)}
                          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">License Number</label>
                        <input
                          type="text"
                          value={labSettings.license_number}
                          onChange={(e) => setLabSettings(prev => prev ? { ...prev, license_number: e.target.value } : prev)}
                          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                          placeholder="Lab license number"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Registration Number</label>
                        <input
                          type="text"
                          value={labSettings.registration_number}
                          onChange={(e) => setLabSettings(prev => prev ? { ...prev, registration_number: e.target.value } : prev)}
                          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                          placeholder="Registration/NABL number"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Patient Summary Settings */}
                  <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
                    <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center">
                      <Globe className="h-5 w-5 mr-2 text-blue-600" />
                      Patient Summary Settings
                    </h3>
                    <div className="space-y-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          Patient Summary Language
                        </label>
                        <select
                          value={labSettings.preferred_language}
                          onChange={(e) => setLabSettings(prev => prev ? { ...prev, preferred_language: e.target.value as SupportedLanguage } : prev)}
                          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                        >
                          {Object.entries(LANGUAGE_DISPLAY_NAMES).map(([key, label]) => (
                            <option key={key} value={key}>{label}</option>
                          ))}
                        </select>
                        <p className="text-xs text-gray-500 mt-2">
                          This is the default language for patient-friendly summaries. Medical terms like "Hemoglobin", "CBC", etc. will remain in English for accuracy, while explanations will be in the selected language.
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* Payment & Billing Settings */}
                  <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
                    <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center">
                      <FileText className="h-5 w-5 mr-2 text-green-600" />
                      Payment & Billing Settings
                    </h3>
                    <p className="text-sm text-gray-500 mb-4">
                      Configure payment details for invoices. UPI QR codes will automatically appear on invoices when balance is due.
                    </p>
                    <div className="space-y-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">GST Number (GSTIN)</label>
                        <input
                          type="text"
                          value={labSettings.gst_number}
                          onChange={(e) => setLabSettings(prev => prev ? { ...prev, gst_number: e.target.value.toUpperCase() } : prev)}
                          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 uppercase"
                          placeholder="22AAAAA0000A1Z5"
                          maxLength={15}
                        />
                        <p className="text-xs text-gray-500 mt-1">15-digit GST Identification Number for B2B invoices</p>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          UPI ID (Virtual Payment Address)
                        </label>
                        <input
                          type="text"
                          value={labSettings.upi_id}
                          onChange={(e) => setLabSettings(prev => prev ? { ...prev, upi_id: e.target.value.toLowerCase() } : prev)}
                          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                          placeholder="yourlab@paytm or 9876543210@ybl"
                        />
                        <p className="text-xs text-gray-500 mt-1">
                          UPI QR code will be shown on invoices for quick payment via PhonePe, Google Pay, Paytm, etc.
                        </p>
                      </div>
                      
                      {/* Bank Details Section */}
                      <div className="border-t pt-4 mt-4">
                        <h4 className="text-sm font-semibold text-gray-800 mb-3">Bank Account Details (for NEFT/RTGS)</h4>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">Bank Name</label>
                            <input
                              type="text"
                              value={labSettings.bank_details?.bank_name || ''}
                              onChange={(e) => setLabSettings(prev => prev ? { 
                                ...prev, 
                                bank_details: { ...prev.bank_details, bank_name: e.target.value } 
                              } : prev)}
                              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                              placeholder="HDFC Bank"
                            />
                          </div>
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">Branch</label>
                            <input
                              type="text"
                              value={labSettings.bank_details?.branch || ''}
                              onChange={(e) => setLabSettings(prev => prev ? { 
                                ...prev, 
                                bank_details: { ...prev.bank_details, branch: e.target.value } 
                              } : prev)}
                              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                              placeholder="Main Branch"
                            />
                          </div>
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">Account Holder Name</label>
                            <input
                              type="text"
                              value={labSettings.bank_details?.account_holder || ''}
                              onChange={(e) => setLabSettings(prev => prev ? { 
                                ...prev, 
                                bank_details: { ...prev.bank_details, account_holder: e.target.value } 
                              } : prev)}
                              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                              placeholder="Your Lab Name Pvt Ltd"
                            />
                          </div>
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">Account Number</label>
                            <input
                              type="text"
                              value={labSettings.bank_details?.account_number || ''}
                              onChange={(e) => setLabSettings(prev => prev ? { 
                                ...prev, 
                                bank_details: { ...prev.bank_details, account_number: e.target.value } 
                              } : prev)}
                              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                              placeholder="1234567890123"
                            />
                          </div>
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">IFSC Code</label>
                            <input
                              type="text"
                              value={labSettings.bank_details?.ifsc_code || ''}
                              onChange={(e) => setLabSettings(prev => prev ? { 
                                ...prev, 
                                bank_details: { ...prev.bank_details, ifsc_code: e.target.value.toUpperCase() } 
                              } : prev)}
                              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 uppercase"
                              placeholder="HDFC0001234"
                              maxLength={11}
                            />
                          </div>
                        </div>
                        <p className="text-xs text-gray-500 mt-3">
                          Bank details will appear on invoices for NEFT/RTGS payments.
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* Contact Information */}
                  <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
                    <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center">
                      <Phone className="h-5 w-5 mr-2 text-blue-600" />
                      Contact Information
                    </h3>
                    <div className="space-y-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          <Mail className="h-4 w-4 inline mr-1" />
                          Email
                        </label>
                        <input
                          type="email"
                          value={labSettings.email}
                          onChange={(e) => setLabSettings(prev => prev ? { ...prev, email: e.target.value } : prev)}
                          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                          placeholder="lab@example.com"
                        />
                        <p className="text-xs text-gray-500 mt-1">Used for email forwarding and system notifications</p>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          <Globe className="h-4 w-4 inline mr-1" />
                          Country Code
                        </label>
                        <select
                          value={labSettings.country_code || '+91'}
                          onChange={(e) => setLabSettings(prev => prev ? { ...prev, country_code: e.target.value } : prev)}
                          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                        >
                          <option value="+91">🇮🇳 India (+91)</option>
                          <option value="+92">🇵🇰 Pakistan (+92)</option>
                          <option value="+94">🇱🇰 Sri Lanka (+94)</option>
                          <option value="+971">🇦🇪 UAE (+971)</option>
                          <option value="+880">🇧🇩 Bangladesh (+880)</option>
                          <option value="+977">🇳🇵 Nepal (+977)</option>
                        </select>
                        <p className="text-xs text-gray-500 mt-1">Used for WhatsApp messages and phone number formatting. A location can override this.</p>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          <MessageSquare className="h-4 w-4 inline mr-1" />
                          Default WhatsApp Sender Account
                        </label>
                        <select
                          value={labSettings.whatsapp_user_id || ''}
                          onChange={(e) => setLabSettings(prev => prev ? { ...prev, whatsapp_user_id: e.target.value || null } : prev)}
                          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                        >
                          <option value="">-- Select User --</option>
                          {syncedWhatsAppUsers.map(u => (
                            <option key={u.id} value={u.whatsapp_user_id}>
                              {u.name} ({u.whatsapp_user_id.substring(0, 8)}...)
                            </option>
                          ))}
                        </select>
                        <p className="text-xs text-gray-500 mt-1">
                          {syncedWhatsAppUsers.length === 0 
                            ? '⚠️ No synced users. Go to WhatsApp → User Sync to sync users first.'
                            : 'Used for any location that has no sender of its own. To give a branch its own number, set it in Masters → Locations.'}
                        </p>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          <Phone className="h-4 w-4 inline mr-1" />
                          Phone
                        </label>
                        <input
                          type="tel"
                          value={labSettings.phone}
                          onChange={(e) => setLabSettings(prev => prev ? { ...prev, phone: e.target.value } : prev)}
                          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                          placeholder="+91 1234567890"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          <Mail className="h-4 w-4 inline mr-1" />
                          Email Domain (for sending)
                        </label>
                        <input
                          type="text"
                          value={labSettings.email_domain || ''}
                          onChange={(e) => setLabSettings(prev => prev ? { ...prev, email_domain: e.target.value } : prev)}
                          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                          placeholder="bestpathologylab.in"
                        />
                        <p className="text-xs text-gray-500 mt-1">
                          ⚠️ Must be verified in Resend. Emails will be sent from reports@{labSettings.email_domain || 'yourdomain.com'}
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* Address */}
                  <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 lg:col-span-2">
                    <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center">
                      <MapPin className="h-5 w-5 mr-2 text-blue-600" />
                      Address
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="md:col-span-2">
                        <label className="block text-sm font-medium text-gray-700 mb-1">Street Address</label>
                        <input
                          type="text"
                          value={labSettings.address}
                          onChange={(e) => setLabSettings(prev => prev ? { ...prev, address: e.target.value } : prev)}
                          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                          placeholder="Building, Street, Area"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">City</label>
                        <input
                          type="text"
                          value={labSettings.city}
                          onChange={(e) => setLabSettings(prev => prev ? { ...prev, city: e.target.value } : prev)}
                          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">State</label>
                        <input
                          type="text"
                          value={labSettings.state}
                          onChange={(e) => setLabSettings(prev => prev ? { ...prev, state: e.target.value } : prev)}
                          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Pincode</label>
                        <input
                          type="text"
                          value={labSettings.pincode}
                          onChange={(e) => setLabSettings(prev => prev ? { ...prev, pincode: e.target.value } : prev)}
                          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Default Report Template Style */}
                  <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 lg:col-span-2">
                    <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center">
                      <FileText className="h-5 w-5 mr-2 text-indigo-600" />
                      Default Report Template Style
                    </h3>
                    <p className="text-sm text-gray-600 mb-4">
                      Choose the default template style used when a test group has no custom HTML template assigned.
                    </p>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <label
                        className={`flex items-start p-4 border-2 rounded-lg cursor-pointer transition-all ${
                          (labSettings.default_template_style || 'beautiful') === 'beautiful'
                            ? 'border-indigo-500 bg-indigo-50'
                            : 'border-gray-200 hover:border-gray-300'
                        }`}
                      >
                        <input
                          type="radio"
                          name="template_style"
                          value="beautiful"
                          checked={(labSettings.default_template_style || 'beautiful') === 'beautiful'}
                          onChange={() => setLabSettings(prev => prev ? { ...prev, default_template_style: 'beautiful' } : prev)}
                          className="mt-1 mr-3 text-indigo-600"
                        />
                        <div>
                          <span className="font-medium text-gray-900">Beautiful (3-Band Color)</span>
                          <p className="text-xs text-gray-500 mt-1">
                            Modern color-coded template with green/gold/red bands, flag badges, and method display.
                          </p>
                        </div>
                      </label>
                      <label
                        className={`flex items-start p-4 border-2 rounded-lg cursor-pointer transition-all ${
                          labSettings.default_template_style === 'classic'
                            ? 'border-indigo-500 bg-indigo-50'
                            : 'border-gray-200 hover:border-gray-300'
                        }`}
                      >
                        <input
                          type="radio"
                          name="template_style"
                          value="classic"
                          checked={labSettings.default_template_style === 'classic'}
                          onChange={() => setLabSettings(prev => prev ? { ...prev, default_template_style: 'classic' } : prev)}
                          className="mt-1 mr-3 text-indigo-600"
                        />
                        <div>
                          <span className="font-medium text-gray-900">Classic (Plain Table)</span>
                          <p className="text-xs text-gray-500 mt-1">
                            Traditional clean table layout with alternating rows and simple flag text colors.
                          </p>
                        </div>
                      </label>
                      <label
                        className={`flex items-start p-4 border-2 rounded-lg cursor-pointer transition-all ${
                          labSettings.default_template_style === 'basic'
                            ? 'border-indigo-500 bg-indigo-50'
                            : 'border-gray-200 hover:border-gray-300'
                        }`}
                      >
                        <input
                          type="radio"
                          name="template_style"
                          value="basic"
                          checked={labSettings.default_template_style === 'basic'}
                          onChange={() => setLabSettings(prev => prev ? { ...prev, default_template_style: 'basic' } : prev)}
                          className="mt-1 mr-3 text-indigo-600"
                        />
                        <div>
                          <span className="font-medium text-gray-900">Basic (Old School)</span>
                          <p className="text-xs text-gray-500 mt-1">
                            No colours, no borders. Small font, bold H/L prefix on abnormal values. Method in italic. Classic lab printout style.
                          </p>
                        </div>
                      </label>
                    </div>

                    {/* Basic (Old School) format builder — shown only when basic is selected */}
                    {labSettings.default_template_style === 'basic' && (
                      <div className="mt-5">
                        <BasicTemplateFormatBuilder
                          printOptions={labSettings.print_options ?? {}}
                          showMethodology={labSettings.show_methodology ?? true}
                          showInterpretation={labSettings.show_interpretation ?? false}
                          onChange={({ printOptions, showMethodology, showInterpretation }) => {
                            setLabSettings(prev => {
                              if (!prev) return prev;
                              return {
                                ...prev,
                                ...(printOptions !== undefined && { print_options: { ...(prev.print_options || {}), ...printOptions } }),
                                ...(showMethodology !== undefined && { show_methodology: showMethodology }),
                                ...(showInterpretation !== undefined && { show_interpretation: showInterpretation }),
                              };
                            });
                          }}
                        />
                      </div>
                    )}

                    {/* Beautiful preview — shown when beautiful is selected (or default) */}
                    {(labSettings.default_template_style || 'beautiful') === 'beautiful' && (
                      <div className="mt-5">
                        <BuiltinTemplatePreview
                          style="beautiful"
                          showMethodology={labSettings.show_methodology ?? true}
                          showInterpretation={labSettings.show_interpretation ?? false}
                          printOptions={labSettings.print_options ?? {}}
                        />
                      </div>
                    )}

                    {/* Classic preview — shown when classic is selected */}
                    {labSettings.default_template_style === 'classic' && (
                      <div className="mt-5">
                        <BuiltinTemplatePreview
                          style="classic"
                          showMethodology={labSettings.show_methodology ?? true}
                          showInterpretation={labSettings.show_interpretation ?? false}
                          printOptions={labSettings.print_options ?? {}}
                        />
                      </div>
                    )}

                    {/* Additional Template Display Options */}
                    <div className="mt-6 pt-4 border-t border-gray-200">
                      <h4 className="text-sm font-semibold text-gray-700 mb-3">Additional Display Options</h4>
                      <p className="text-xs text-gray-500 mb-3">
                        Control which extra columns appear in the default report template for each analyte row.
                      </p>
                      <div className="flex flex-col sm:flex-row gap-4">
                        <label className="flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={labSettings.show_methodology ?? true}
                            onChange={(e) => setLabSettings(prev => prev ? { ...prev, show_methodology: e.target.checked } : prev)}
                            className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded mr-2"
                          />
                          <div>
                            <span className="text-sm font-medium text-gray-700">Show Methodology</span>
                            <p className="text-xs text-gray-400">Display the test method (e.g. Photometry, ELISA) below each analyte name.</p>
                          </div>
                        </label>
                        <label className="flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={labSettings.show_interpretation ?? false}
                            onChange={(e) => setLabSettings(prev => prev ? { ...prev, show_interpretation: e.target.checked } : prev)}
                            className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded mr-2"
                          />
                          <div>
                            <span className="text-sm font-medium text-gray-700">Show Interpretation</span>
                            <p className="text-xs text-gray-400">Display low/normal/high interpretation text for each analyte based on its flag.</p>
                          </div>
                        </label>
                      </div>
                    </div>

                    {/* Print Style Options */}
                    <div className="mt-6 pt-4 border-t border-gray-200">
                      <div className="flex items-center justify-between mb-1">
                        <h4 className="text-sm font-semibold text-gray-700">Print Style Options</h4>
                        {labSettings.print_options && Object.keys(labSettings.print_options).length > 0 && (
                          <button
                            type="button"
                            onClick={() => setLabSettings(prev => prev ? { ...prev, print_options: null } : prev)}
                            className="text-xs text-gray-400 hover:text-red-500 transition-colors"
                          >
                            ↩ Reset all to system defaults
                          </button>
                        )}
                      </div>
                      <p className="text-xs text-gray-500 mb-3">Applied to all reports as CSS overrides. Can be overridden per test group.</p>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
                        {/* Table Borders */}
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={labSettings.print_options?.tableBorders !== false}
                            onChange={(e) => setLabSettings(prev => prev ? { ...prev, print_options: { ...(prev.print_options || {}), tableBorders: e.target.checked } } : prev)}
                            className="h-4 w-4 text-indigo-600 border-gray-300 rounded"
                          />
                          <div>
                            <span className="text-sm font-medium text-gray-700">Table Borders</span>
                            <p className="text-xs text-gray-400">Show borders on result table cells.</p>
                          </div>
                        </label>
                        {/* Flag Column */}
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={labSettings.print_options?.flagColumn !== false}
                            onChange={(e) => setLabSettings(prev => prev ? { ...prev, print_options: { ...(prev.print_options || {}), flagColumn: e.target.checked } } : prev)}
                            className="h-4 w-4 text-indigo-600 border-gray-300 rounded"
                          />
                          <div>
                            <span className="text-sm font-medium text-gray-700">Flag Column</span>
                            <p className="text-xs text-gray-400">Show H/L/N flag column (Classic layout).</p>
                          </div>
                        </label>
                        {/* Flag Asterisk */}
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={!!labSettings.print_options?.flagAsterisk}
                            onChange={(e) => setLabSettings(prev => prev ? { ...prev, print_options: { ...(prev.print_options || {}), flagAsterisk: e.target.checked } } : prev)}
                            className="h-4 w-4 text-indigo-600 border-gray-300 rounded"
                          />
                          <div>
                            <span className="text-sm font-medium text-gray-700">Flag Asterisk (*)</span>
                            <p className="text-xs text-gray-400">Append * to abnormal values (Classic).</p>
                          </div>
                        </label>
                        {/* Critical Double Asterisk */}
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={!!labSettings.print_options?.flagAsteriskCritical}
                            disabled={!labSettings.print_options?.flagAsterisk}
                            onChange={(e) => setLabSettings(prev => prev ? { ...prev, print_options: { ...(prev.print_options || {}), flagAsteriskCritical: e.target.checked } } : prev)}
                            className="h-4 w-4 text-indigo-600 border-gray-300 rounded disabled:opacity-40"
                          />
                          <div>
                            <span className="text-sm font-medium text-gray-700">Critical Double (**)</span>
                            <p className="text-xs text-gray-400">Use ** for critical H/L values.</p>
                          </div>
                        </label>
                        {/* Bold All Values */}
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={labSettings.print_options?.boldAllValues === true}
                            onChange={(e) => setLabSettings(prev => prev ? { ...prev, print_options: { ...(prev.print_options || {}), boldAllValues: e.target.checked } } : prev)}
                            className="h-4 w-4 text-indigo-600 border-gray-300 rounded"
                          />
                          <div>
                            <span className="text-sm font-medium text-gray-700">Bold All Values</span>
                            <p className="text-xs text-gray-400">All result values semi-bold (uncheck for normal weight).</p>
                          </div>
                        </label>
                        {/* Bold Abnormal Values */}
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={labSettings.print_options?.boldAbnormalValues !== false}
                            onChange={(e) => setLabSettings(prev => prev ? { ...prev, print_options: { ...(prev.print_options || {}), boldAbnormalValues: e.target.checked } } : prev)}
                            className="h-4 w-4 text-indigo-600 border-gray-300 rounded"
                          />
                          <div>
                            <span className="text-sm font-medium text-gray-700">Bold Abnormal Values</span>
                            <p className="text-xs text-gray-400">Extra bold for high/low values in result table.</p>
                          </div>
                        </label>
                        {/* Underline Abnormal Values */}
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={labSettings.print_options?.underlineAbnormalValues === true}
                            onChange={(e) => setLabSettings(prev => prev ? { ...prev, print_options: { ...(prev.print_options || {}), underlineAbnormalValues: e.target.checked } } : prev)}
                            className="h-4 w-4 text-indigo-600 border-gray-300 rounded"
                          />
                          <div>
                            <span className="text-sm font-medium text-gray-700">Underline Abnormal Values</span>
                            <p className="text-xs text-gray-400">Underline high/low/critical values in result table.</p>
                          </div>
                        </label>
                        {/* Alternate Row Shading */}
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={labSettings.print_options?.alternateRows !== false}
                            onChange={(e) => setLabSettings(prev => prev ? { ...prev, print_options: { ...(prev.print_options || {}), alternateRows: e.target.checked } } : prev)}
                            className="h-4 w-4 text-indigo-600 border-gray-300 rounded"
                          />
                          <div>
                            <span className="text-sm font-medium text-gray-700">Alternate Row Shading</span>
                            <p className="text-xs text-gray-400">Alternating row background color.</p>
                          </div>
                        </label>
                        {/* Show Sample Type */}
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={!!labSettings.print_options?.showSampleType}
                            onChange={(e) => setLabSettings(prev => prev ? { ...prev, print_options: { ...(prev.print_options || {}), showSampleType: e.target.checked } } : prev)}
                            className="h-4 w-4 text-indigo-600 border-gray-300 rounded"
                          />
                          <div>
                            <span className="text-sm font-medium text-gray-700">Show Sample Type on Report</span>
                            <p className="text-xs text-gray-400">Display the specimen/sample type (e.g. Blood, Urine) next to each test group title on all template styles.</p>
                          </div>
                        </label>
                        {/* Show Sample Condition */}
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={!!labSettings.print_options?.showSampleCondition}
                            onChange={(e) => setLabSettings(prev => prev ? { ...prev, print_options: { ...(prev.print_options || {}), showSampleCondition: e.target.checked } } : prev)}
                            className="h-4 w-4 text-indigo-600 border-gray-300 rounded"
                          />
                          <div>
                            <span className="text-sm font-medium text-gray-700">Show Sample Condition on Report</span>
                            <p className="text-xs text-gray-400">Display selected condition such as Morning, Fasting, or Random under each test group title.</p>
                          </div>
                        </label>
                        {/* Header Background */}
                        <div className="flex items-center gap-2">
                          <input
                            type="color"
                            value={labSettings.print_options?.headerBackground || '#0b4aa2'}
                            onChange={(e) => setLabSettings(prev => prev ? { ...prev, print_options: { ...(prev.print_options || {}), headerBackground: e.target.value } } : prev)}
                            className="h-8 w-8 rounded border border-gray-300 cursor-pointer"
                          />
                          <div>
                            <span className="text-sm font-medium text-gray-700">Header Color</span>
                            <p className="text-xs text-gray-400">Table header background color.</p>
                          </div>
                        </div>
                        {/* Base Font Size */}
                        <div className="flex items-center gap-2">
                          <input
                            type="number"
                            min={8}
                            max={24}
                            value={labSettings.print_options?.baseFontSize ?? 12}
                            onChange={(e) => setLabSettings(prev => prev ? { ...prev, print_options: { ...(prev.print_options || {}), baseFontSize: parseInt(e.target.value) || 12 } } : prev)}
                            className="w-16 px-2 py-1 border border-gray-300 rounded text-sm"
                          />
                          <div>
                            <span className="text-sm font-medium text-gray-700">Font Size (px)</span>
                            <p className="text-xs text-gray-400">Base font size for result table (8–16).</p>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Patient Info Section Configuration */}
                    <div className="mt-6 pt-4 border-t border-gray-200">
                      <h4 className="text-sm font-semibold text-gray-700 mb-2">Patient Information Section</h4>
                      <p className="text-xs text-gray-500 mb-3">
                        Customize which fields appear in the patient info area of the default report template, and choose the layout style.
                        This only applies to default templates — custom CKEditor templates control their own layout.
                      </p>

                      {/* Layout toggle */}
                      <div className="flex items-center gap-4 mb-4">
                        <span className="text-sm text-gray-600 font-medium">Layout:</span>
                        {(['inline', 'table'] as const).map(layout => (
                          <label key={layout} className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border-2 cursor-pointer text-sm transition-all ${
                            (labSettings.report_patient_info_config?.layout || (labSettings.default_template_style === 'classic' ? 'table' : 'inline')) === layout
                              ? 'border-indigo-500 bg-indigo-50 text-indigo-700 font-medium'
                              : 'border-gray-200 text-gray-600 hover:border-gray-300'
                          }`}>
                            <input
                              type="radio"
                              name="patient_info_layout"
                              value={layout}
                              checked={(labSettings.report_patient_info_config?.layout || (labSettings.default_template_style === 'classic' ? 'table' : 'inline')) === layout}
                              onChange={() => {
                                const current = labSettings.report_patient_info_config;
                                setLabSettings(prev => prev ? { ...prev, report_patient_info_config: { layout, fields: current?.fields || ['patientName','patientId','age','gender','collectionDate','sampleId','referringDoctorName','approvedAt'] } } : prev);
                              }}
                              className="sr-only"
                            />
                            {layout === 'inline' ? '📋 Inline (rows)' : '📊 Table (grid)'}
                          </label>
                        ))}
                        {labSettings.report_patient_info_config && (
                          <button
                            type="button"
                            onClick={() => setLabSettings(prev => prev ? { ...prev, report_patient_info_config: null } : prev)}
                            className="text-xs text-gray-400 hover:text-red-500 ml-auto"
                          >
                            Reset to default
                          </button>
                        )}
                      </div>

                      {/* Bold patient values — stored in print_options so print and e-copy share it */}
                      <label className="flex items-center gap-2 cursor-pointer mb-4">
                        <input
                          type="checkbox"
                          checked={labSettings.print_options?.patientInfoBold === true}
                          onChange={(e) => setLabSettings(prev => prev ? { ...prev, print_options: { ...(prev.print_options || {}), patientInfoBold: e.target.checked } } : prev)}
                          className="h-4 w-4 text-indigo-600 border-gray-300 rounded"
                        />
                        <div>
                          <span className="text-sm font-medium text-gray-700">Bold Patient Info Values</span>
                          <p className="text-xs text-gray-400">Bold the values (name, age/sex, ref. doctor). Field labels are always bold. Applies to both print and e-copy.</p>
                        </div>
                      </label>

                      {/* Vertical rule between the two patient info columns */}
                      <label className="flex items-center gap-2 cursor-pointer mb-4">
                        <input
                          type="checkbox"
                          checked={labSettings.print_options?.patientInfoColumnDivider === true}
                          onChange={(e) => setLabSettings(prev => prev ? { ...prev, print_options: { ...(prev.print_options || {}), patientInfoColumnDivider: e.target.checked } } : prev)}
                          className="h-4 w-4 text-indigo-600 border-gray-300 rounded"
                        />
                        <div>
                          <span className="text-sm font-medium text-gray-700">Line Between Patient Info Columns</span>
                          <p className="text-xs text-gray-400">Draws a vertical line separating the left and right patient info columns. Off by default. Applies to both print and e-copy.</p>
                        </div>
                      </label>

                      {/* Field selection */}
                      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                        {[
                          { key: 'patientName', label: 'Patient Name' },
                          { key: 'patientId', label: 'Patient ID' },
                          { key: 'registrationDate', label: 'Registration Date' },
                          { key: 'age', label: 'Age' },
                          { key: 'gender', label: 'Gender' },
                          { key: 'collectionDate', label: 'Collection Date/Time' },
                          { key: 'sampleId', label: 'Sample ID' },
                          { key: 'referringDoctorName', label: 'Ref. Doctor' },
                          { key: 'approvedAt', label: 'Approved On' },
                          { key: 'phone', label: 'Phone' },
                          { key: 'sampleCollectedBy', label: 'Collected By' },
                          { key: 'receivedAt', label: 'Received Date/Time' },
                          { key: 'collectionCenter', label: 'Collection Center' },
                          { key: 'b2bAccountName', label: 'B2B / Account Name' },
                          { key: 'refCenter', label: 'Ref. Center (B2B)' },
                          { key: 'processingCenter', label: 'Proc. Center (Main Lab)' },
                          ...customPatientFields.map(f => ({ key: `custom_${f.field_key}`, label: f.label })),
                        ].map(field => {
                          const currentFields = labSettings.report_patient_info_config?.fields || ['patientName','patientId','age','gender','collectionDate','sampleId','referringDoctorName','approvedAt'];
                          const isChecked = currentFields.includes(field.key);
                          return (
                            <label key={field.key} className="flex items-center gap-2 text-sm cursor-pointer">
                              <input
                                type="checkbox"
                                checked={isChecked}
                                onChange={(e) => {
                                  const newFields = e.target.checked
                                    ? [...currentFields, field.key]
                                    : currentFields.filter(f => f !== field.key);
                                  const currentLayout = labSettings.report_patient_info_config?.layout || (labSettings.default_template_style === 'classic' ? 'table' : 'inline');
                                  setLabSettings(prev => prev ? { ...prev, report_patient_info_config: { layout: currentLayout, fields: newFields } } : prev);
                                }}
                                className="h-3.5 w-3.5 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
                              />
                              <span className="text-gray-700">{field.label}</span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  </div>

                  {/* Custom Patient Fields */}
                  <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 lg:col-span-2">
                    <div className="flex items-center justify-between mb-1">
                      <h3 className="text-lg font-semibold text-gray-900">Custom Patient Fields</h3>
                      {!showAddFieldForm && (
                        <button
                          type="button"
                          onClick={() => { resetFieldForm(); setShowAddFieldForm(true); }}
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 text-white text-sm rounded-md hover:bg-indigo-700"
                        >
                          <Plus className="h-4 w-4" /> Add Field
                        </button>
                      )}
                    </div>
                    <p className="text-sm text-gray-500 mb-4">
                      Define extra fields specific to your lab (e.g. ABHA ID, HIMS ID, Animal Type). Values are stored per patient and can optionally be searched in the order form and shown in PDF reports.
                    </p>

                    {/* Add / Edit form */}
                    {showAddFieldForm && (
                      <div className="mb-5 p-4 border border-indigo-200 bg-indigo-50 rounded-lg space-y-3">
                        <h4 className="text-sm font-semibold text-indigo-800">{editingField ? 'Edit Field' : 'New Custom Field'}</h4>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <div>
                            <label className="block text-xs font-medium text-gray-700 mb-1">Field Key <span className="text-gray-400">(unique, no spaces)</span></label>
                            <input
                              type="text"
                              value={fieldForm.field_key}
                              disabled={!!editingField}
                              onChange={e => setFieldForm(prev => ({ ...prev, field_key: e.target.value }))}
                              placeholder="abha_id"
                              className="w-full px-3 py-1.5 border border-gray-300 rounded text-sm disabled:bg-gray-100"
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-gray-700 mb-1">Display Label</label>
                            <input
                              type="text"
                              value={fieldForm.label}
                              onChange={e => setFieldForm(prev => ({ ...prev, label: e.target.value }))}
                              placeholder="ABHA ID"
                              className="w-full px-3 py-1.5 border border-gray-300 rounded text-sm"
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-gray-700 mb-1">Field Type</label>
                            <select
                              value={fieldForm.field_type}
                              onChange={e => setFieldForm(prev => ({ ...prev, field_type: e.target.value as any }))}
                              className="w-full px-3 py-1.5 border border-gray-300 rounded text-sm"
                            >
                              <option value="text">Text</option>
                              <option value="number">Number</option>
                              <option value="select">Select (dropdown)</option>
                            </select>
                          </div>
                          {fieldForm.field_type === 'select' && (
                            <div>
                              <label className="block text-xs font-medium text-gray-700 mb-1">Options <span className="text-gray-400">(comma separated)</span></label>
                              <input
                                type="text"
                                value={fieldForm.options}
                                onChange={e => setFieldForm(prev => ({ ...prev, options: e.target.value }))}
                                placeholder="Dog, Cat, Bird, Rabbit"
                                className="w-full px-3 py-1.5 border border-gray-300 rounded text-sm"
                              />
                            </div>
                          )}
                        </div>
                        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                          <label className="flex items-center gap-2 text-sm cursor-pointer">
                            <input type="checkbox" checked={fieldForm.searchable} onChange={e => setFieldForm(prev => ({ ...prev, searchable: e.target.checked }))} className="h-3.5 w-3.5 text-indigo-600 rounded" />
                            <span>Searchable in order form</span>
                          </label>
                          <label className="flex items-center gap-2 text-sm cursor-pointer">
                            <input type="checkbox" checked={fieldForm.required} onChange={e => setFieldForm(prev => ({ ...prev, required: e.target.checked }))} className="h-3.5 w-3.5 text-indigo-600 rounded" />
                            <span>Required when creating patient</span>
                          </label>
                          <label className="flex items-center gap-2 text-sm cursor-pointer">
                            <input type="checkbox" checked={fieldForm.use_for_ai_ref_range} onChange={e => setFieldForm(prev => ({ ...prev, use_for_ai_ref_range: e.target.checked }))} className="h-3.5 w-3.5 text-purple-600 rounded" />
                            <span className="text-purple-800">Use for AI Ref Range context</span>
                          </label>
                        </div>
                        <div className="flex items-center gap-2 pt-1">
                          <button type="button" onClick={handleSaveField} disabled={savingField || !fieldForm.field_key || !fieldForm.label} className="px-4 py-1.5 bg-indigo-600 text-white text-sm rounded hover:bg-indigo-700 disabled:opacity-50">
                            {savingField ? 'Saving...' : editingField ? 'Update Field' : 'Add Field'}
                          </button>
                          <button type="button" onClick={resetFieldForm} className="px-4 py-1.5 border border-gray-300 text-gray-700 text-sm rounded hover:bg-gray-50">Cancel</button>
                        </div>
                      </div>
                    )}

                    {/* Field list */}
                    {customPatientFields.length === 0 && !showAddFieldForm ? (
                      <p className="text-sm text-gray-400 text-center py-6 border border-dashed border-gray-200 rounded-lg">
                        No custom fields defined yet. Click "Add Field" to create one.
                      </p>
                    ) : customPatientFields.length > 0 ? (
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="text-left text-xs text-gray-500 border-b border-gray-100">
                              <th className="pb-2 pr-3 font-medium">Label</th>
                              <th className="pb-2 pr-3 font-medium">Key</th>
                              <th className="pb-2 pr-3 font-medium">Type</th>
                              <th className="pb-2 pr-3 font-medium text-center">Searchable</th>
                              <th className="pb-2 pr-3 font-medium text-center">Required</th>
                              <th className="pb-2 pr-3 font-medium text-center text-purple-700">AI Ref Range</th>
                              <th className="pb-2 font-medium">Order</th>
                              <th className="pb-2 font-medium">Actions</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-50">
                            {customPatientFields.map((field, idx) => (
                              <tr key={field.id} className="hover:bg-gray-50">
                                <td className="py-2 pr-3 font-medium text-gray-800">{field.label}</td>
                                <td className="py-2 pr-3 font-mono text-xs text-gray-500">{field.field_key}</td>
                                <td className="py-2 pr-3 text-gray-600 capitalize">{field.field_type}{field.field_type === 'select' && field.options ? ` (${(field.options as string[]).join(', ')})` : ''}</td>
                                <td className="py-2 pr-3 text-center text-green-600">{field.searchable ? '✓' : <span className="text-gray-300">—</span>}</td>
                                <td className="py-2 pr-3 text-center text-orange-500">{field.required ? '✓' : <span className="text-gray-300">—</span>}</td>
                                <td className="py-2 pr-3 text-center text-purple-600">{field.use_for_ai_ref_range ? '✓' : <span className="text-gray-300">—</span>}</td>
                                <td className="py-2 pr-3">
                                  <div className="flex items-center gap-0.5">
                                    <button type="button" onClick={() => handleMoveField(field.id, 'up')} disabled={idx === 0} className="p-0.5 text-gray-400 hover:text-gray-600 disabled:opacity-20 text-xs">▲</button>
                                    <button type="button" onClick={() => handleMoveField(field.id, 'down')} disabled={idx === customPatientFields.length - 1} className="p-0.5 text-gray-400 hover:text-gray-600 disabled:opacity-20 text-xs">▼</button>
                                  </div>
                                </td>
                                <td className="py-2">
                                  <div className="flex items-center gap-1">
                                    <button type="button" onClick={() => handleEditField(field)} className="p-1 text-indigo-500 hover:text-indigo-700"><Edit className="h-3.5 w-3.5" /></button>
                                    <button type="button" onClick={() => handleDeleteField(field.id)} className="p-1 text-red-400 hover:text-red-600"><Trash2 className="h-3.5 w-3.5" /></button>
                                  </div>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>

                        {/* Custom fields for PDF are now managed in the Patient Information Section above */}
                      </div>
                    ) : null}
                  </div>

                  {/* Block Report Send on Outstanding Dues (Admin only) */}
                  {authUser?.user_metadata?.role === 'Admin' && (
                    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 lg:col-span-2">
                      <h3 className="text-lg font-semibold text-gray-900 mb-2 flex items-center">
                        <span className="mr-2">🔒</span>
                        Report Sending — Outstanding Dues Policy
                      </h3>
                      <p className="text-sm text-gray-600 mb-4">
                        When enabled, report auto-send (after PDF generation) and manual WhatsApp send are blocked for any order that has an outstanding invoice balance. Admins can still send manually. Turn this OFF if your lab sends reports regardless of payment status.
                      </p>
                      <label className="flex items-center cursor-pointer gap-3">
                        <input
                          type="checkbox"
                          checked={labSettings.block_send_on_due ?? false}
                          onChange={(e) => setLabSettings(prev => prev ? { ...prev, block_send_on_due: e.target.checked } : prev)}
                          className="h-4 w-4 text-red-600 focus:ring-red-500 border-gray-300 rounded"
                        />
                        <div>
                          <span className="text-sm font-medium text-gray-800">Block report send when payment is due</span>
                          <p className="text-xs text-gray-400 mt-0.5">Auto-send is skipped and non-admin users cannot manually send WhatsApp for orders with a balance.</p>
                        </div>
                      </label>
                    </div>
                  )}

                  {/* Patient Loyalty Points Program */}
                  <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 lg:col-span-2">
                    <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center">
                      <Gift className="h-5 w-5 mr-2 text-amber-600" />
                      Patient Loyalty Points Program
                    </h3>
                    <p className="text-sm text-gray-600 mb-4">
                      Reward repeat patients with loyalty points. Points are earned on every paid order and can be redeemed for discounts.
                    </p>

                    {/* Enable Toggle */}
                    <div className="flex items-center mb-6">
                      <label className="flex items-center cursor-pointer">
                        <input
                          type="checkbox"
                          checked={labSettings.loyalty_enabled ?? false}
                          onChange={(e) => setLabSettings(prev => prev ? { ...prev, loyalty_enabled: e.target.checked } : prev)}
                          className="h-4 w-4 text-amber-600 focus:ring-amber-500 border-gray-300 rounded mr-2"
                        />
                        <span className="text-sm font-medium text-gray-700">Enable Loyalty Points</span>
                      </label>
                    </div>

                    {labSettings.loyalty_enabled && (
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                        {/* Conversion Rate */}
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            <Star className="h-4 w-4 inline mr-1 text-amber-500" />
                            Points per {labSettings.country_code === '+91' ? '\u20B9' : '$'}1 spent
                          </label>
                          <input
                            type="number"
                            min="0.01"
                            max="10"
                            step="0.01"
                            value={labSettings.loyalty_conversion_rate ?? 0.1}
                            onChange={(e) => setLabSettings(prev => prev ? { ...prev, loyalty_conversion_rate: parseFloat(e.target.value) || 0.1 } : prev)}
                            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-amber-500"
                          />
                          <p className="text-xs text-gray-500 mt-1">
                            {(() => {
                              const rate = labSettings.loyalty_conversion_rate ?? 0.1;
                              const symbol = labSettings.country_code === '+91' ? '\u20B9' : '$';
                              return `${symbol}100 order = ${Math.floor(100 * rate)} points`;
                            })()}
                          </p>
                        </div>

                        {/* Point Value */}
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Redemption Value per Point
                          </label>
                          <div className="flex items-center gap-2">
                            <span className="text-sm text-gray-500">{labSettings.country_code === '+91' ? '\u20B9' : '$'}</span>
                            <input
                              type="number"
                              min="0.1"
                              max="100"
                              step="0.1"
                              value={labSettings.loyalty_point_value ?? 1.0}
                              onChange={(e) => setLabSettings(prev => prev ? { ...prev, loyalty_point_value: parseFloat(e.target.value) || 1.0 } : prev)}
                              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-amber-500"
                            />
                          </div>
                          <p className="text-xs text-gray-500 mt-1">
                            1 point = {labSettings.country_code === '+91' ? '\u20B9' : '$'}{labSettings.loyalty_point_value ?? 1.0} discount
                          </p>
                        </div>

                        {/* Minimum Redeem Points */}
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Minimum Points to Redeem
                          </label>
                          <input
                            type="number"
                            min="1"
                            max="10000"
                            step="1"
                            value={labSettings.loyalty_min_redeem_points ?? 100}
                            onChange={(e) => setLabSettings(prev => prev ? { ...prev, loyalty_min_redeem_points: parseInt(e.target.value) || 100 } : prev)}
                            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-amber-500"
                          />
                          <p className="text-xs text-gray-500 mt-1">
                            Patient must have at least this many points before they can redeem
                          </p>
                        </div>
                      </div>
                    )}

                    {labSettings.loyalty_enabled && (
                      <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mt-4">
                        <div className="text-xs text-amber-800 space-y-1">
                          <p><strong>Example flow:</strong></p>
                          <ul className="list-disc list-inside ml-2 space-y-0.5">
                            <li>Patient pays {labSettings.country_code === '+91' ? '\u20B9' : '$'}500 for tests \u2192 earns {Math.floor(500 * (labSettings.loyalty_conversion_rate ?? 0.1))} points</li>
                            <li>After accumulating {labSettings.loyalty_min_redeem_points ?? 100}+ points, patient can redeem at checkout</li>
                            <li>{labSettings.loyalty_min_redeem_points ?? 100} points = {labSettings.country_code === '+91' ? '\u20B9' : '$'}{((labSettings.loyalty_min_redeem_points ?? 100) * (labSettings.loyalty_point_value ?? 1.0)).toFixed(0)} discount</li>
                          </ul>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Report Watermark Settings */}
                  <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 lg:col-span-2">
                    <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center">
                      <FileText className="h-5 w-5 mr-2 text-blue-600" />
                      Report Watermark Settings
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                      <div className="flex items-center">
                        <label className="flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={labSettings.watermark_enabled}
                            onChange={(e) => setLabSettings(prev => prev ? { ...prev, watermark_enabled: e.target.checked } : prev)}
                            className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded mr-2"
                          />
                          <span className="text-sm font-medium text-gray-700">Enable Watermark</span>
                        </label>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Position</label>
                        <select
                          value={labSettings.watermark_position}
                          onChange={(e) => setLabSettings(prev => prev ? { ...prev, watermark_position: e.target.value } : prev)}
                          disabled={!labSettings.watermark_enabled}
                          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
                        >
                          <option value="center">Center</option>
                          <option value="top-left">Top Left</option>
                          <option value="top-right">Top Right</option>
                          <option value="bottom-left">Bottom Left</option>
                          <option value="bottom-right">Bottom Right</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Size</label>
                        <select
                          value={labSettings.watermark_size}
                          onChange={(e) => setLabSettings(prev => prev ? { ...prev, watermark_size: e.target.value } : prev)}
                          disabled={!labSettings.watermark_enabled}
                          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
                        >
                          <option value="small">Small</option>
                          <option value="medium">Medium</option>
                          <option value="large">Large</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Opacity ({Math.round(labSettings.watermark_opacity * 100)}%)</label>
                        <input
                          type="range"
                          min="0.05"
                          max="0.50"
                          step="0.05"
                          value={labSettings.watermark_opacity}
                          onChange={(e) => setLabSettings(prev => prev ? { ...prev, watermark_opacity: parseFloat(e.target.value) } : prev)}
                          disabled={!labSettings.watermark_enabled}
                          className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer disabled:opacity-50"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Flag Options Configuration */}
                  <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 lg:col-span-2">
                    <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center">
                      <FileText className="h-5 w-5 mr-2 text-orange-600" />
                      Result Flag Options
                    </h3>
                    <p className="text-sm text-gray-600 mb-4">
                      Configure the flag options available during result entry, verification, and analyte dropdown mapping.
                    </p>
                    <div className="space-y-2">
                      {(labSettings.flag_options || []).map((opt, idx) => (
                        <div key={idx} className="flex items-center gap-3">
                          <input
                            type="text"
                            value={opt.label}
                            onChange={(e) => {
                              const updated = [...(labSettings.flag_options || [])];
                              updated[idx] = { ...updated[idx], label: e.target.value };
                              setLabSettings(prev => prev ? { ...prev, flag_options: updated } : prev);
                            }}
                            placeholder="Label (e.g. High)"
                            className="flex-1 px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                          />
                          <input
                            type="text"
                            value={opt.value}
                            onChange={(e) => {
                              const updated = [...(labSettings.flag_options || [])];
                              updated[idx] = { ...updated[idx], value: e.target.value };
                              setLabSettings(prev => prev ? { ...prev, flag_options: updated } : prev);
                            }}
                            placeholder="Code (e.g. H)"
                            className="w-28 px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                          />
                          {/* Show usage count if this flag is used */}
                          {opt.value && flagUsageCounts[opt.value] > 0 && (
                            <span className="text-xs text-amber-600 bg-amber-50 px-2 py-1 rounded" title="Results using this flag">
                              {flagUsageCounts[opt.value]} results
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={() => {
                              const usageCount = opt.value ? (flagUsageCounts[opt.value] || 0) : 0;
                              if (usageCount > 0) {
                                const confirmed = window.confirm(
                                  `Warning: This flag "${opt.label}" (${opt.value}) is used in ${usageCount} result${usageCount > 1 ? 's' : ''}.\n\n` +
                                  `Removing it will:\n` +
                                  `• Hide this option from dropdowns for new results\n` +
                                  `• NOT affect existing results (they keep their flag)\n\n` +
                                  `Are you sure you want to remove this flag option?`
                                );
                                if (!confirmed) return;
                              }
                              const updated = (labSettings.flag_options || []).filter((_, i) => i !== idx);
                              setLabSettings(prev => prev ? { ...prev, flag_options: updated } : prev);
                            }}
                            className={`p-2 rounded ${opt.value && flagUsageCounts[opt.value] > 0 ? 'text-amber-500 hover:bg-amber-50' : 'text-red-500 hover:bg-red-50'}`}
                            title={opt.value && flagUsageCounts[opt.value] > 0 ? `Used in ${flagUsageCounts[opt.value]} results - click to remove with warning` : 'Remove'}
                          >
                            <XCircle className="h-4 w-4" />
                          </button>
                        </div>
                      ))}
                      {checkingFlagUsage && (
                        <p className="text-xs text-gray-400 italic">Checking flag usage...</p>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          const updated = [...(labSettings.flag_options || []), { value: '', label: '' }];
                          setLabSettings(prev => prev ? { ...prev, flag_options: updated } : prev);
                        }}
                        className="inline-flex items-center px-3 py-2 text-sm text-blue-600 hover:bg-blue-50 rounded-md border border-blue-200"
                      >
                        + Add Flag Option
                      </button>
                    </div>
                  </div>

                  {/* Report Flag Color Settings */}
                  <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 lg:col-span-2">
                    <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center">
                      <FileText className="h-5 w-5 mr-2 text-purple-600" />
                      Test Result Flag Colors
                    </h3>
                    <p className="text-sm text-gray-600 mb-4">
                      Customize how abnormal test results are highlighted in PDF reports. These colors apply to both values and flag text.
                    </p>
                    <div className="space-y-4">
                      <div className="flex items-center mb-4">
                        <label className="flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={labSettings.result_colors?.enabled ?? true}
                            onChange={(e) => setLabSettings(prev => prev ? { 
                              ...prev, 
                              result_colors: { 
                                enabled: e.target.checked,
                                high: prev.result_colors?.high || '#dc2626',
                                low: prev.result_colors?.low || '#ea580c',
                                normal: prev.result_colors?.normal || '#16a34a'
                              } 
                            } : prev)}
                            className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded mr-2"
                          />
                          <span className="text-sm font-medium text-gray-700">Enable Flag Coloring (E-Copy version)</span>
                        </label>
                      </div>
                      
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-2">
                            High/Critical High Results
                          </label>
                          <div className="flex items-center space-x-3">
                            <input
                              type="color"
                              value={labSettings.result_colors?.high || '#dc2626'}
                              onChange={(e) => setLabSettings(prev => prev ? { 
                                ...prev, 
                                result_colors: { 
                                  enabled: prev.result_colors?.enabled ?? true,
                                  high: e.target.value,
                                  low: prev.result_colors?.low || '#ea580c',
                                  normal: prev.result_colors?.normal || '#16a34a'
                                } 
                              } : prev)}
                              disabled={!(labSettings.result_colors?.enabled ?? true)}
                              className="h-10 w-20 border border-gray-300 rounded cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                            />
                            <div>
                              <div className="text-sm font-medium text-gray-900">
                                {labSettings.result_colors?.high || '#dc2626'}
                              </div>
                              <div className="text-xs text-gray-500">Default: Red (#dc2626)</div>
                            </div>
                          </div>
                          <div className="mt-2 p-2 border border-gray-200 rounded bg-gray-50">
                            <span 
                              className="text-sm font-bold" 
                              style={{ color: labSettings.result_colors?.high || '#dc2626' }}
                            >
                              Preview: high, critical_high
                            </span>
                          </div>
                          <div className="text-xs text-gray-500 mt-1">
                            Also applies to: abnormal, critical_h, H, HH
                          </div>
                        </div>

                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-2">
                            Low/Critical Low Results
                          </label>
                          <div className="flex items-center space-x-3">
                            <input
                              type="color"
                              value={labSettings.result_colors?.low || '#ea580c'}
                              onChange={(e) => setLabSettings(prev => prev ? { 
                                ...prev, 
                                result_colors: { 
                                  enabled: prev.result_colors?.enabled ?? true,
                                  high: prev.result_colors?.high || '#dc2626',
                                  low: e.target.value,
                                  normal: prev.result_colors?.normal || '#16a34a'
                                } 
                              } : prev)}
                              disabled={!(labSettings.result_colors?.enabled ?? true)}
                              className="h-10 w-20 border border-gray-300 rounded cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                            />
                            <div>
                              <div className="text-sm font-medium text-gray-900">
                                {labSettings.result_colors?.low || '#ea580c'}
                              </div>
                              <div className="text-xs text-gray-500">Default: Orange (#ea580c)</div>
                            </div>
                          </div>
                          <div className="mt-2 p-2 border border-gray-200 rounded bg-gray-50">
                            <span 
                              className="text-sm font-bold" 
                              style={{ color: labSettings.result_colors?.low || '#ea580c' }}
                            >
                              Preview: low, critical_low
                            </span>
                          </div>
                          <div className="text-xs text-gray-500 mt-1">
                            Also applies to: critical_l, L, LL
                          </div>
                        </div>

                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-2">
                            Normal Results
                          </label>
                          <div className="flex items-center space-x-3">
                            <input
                              type="color"
                              value={labSettings.result_colors?.normal || '#16a34a'}
                              onChange={(e) => setLabSettings(prev => prev ? { 
                                ...prev, 
                                result_colors: { 
                                  enabled: prev.result_colors?.enabled ?? true,
                                  high: prev.result_colors?.high || '#dc2626',
                                  low: prev.result_colors?.low || '#ea580c',
                                  normal: e.target.value
                                } 
                              } : prev)}
                              disabled={!(labSettings.result_colors?.enabled ?? true)}
                              className="h-10 w-20 border border-gray-300 rounded cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                            />
                            <div>
                              <div className="text-sm font-medium text-gray-900">
                                {labSettings.result_colors?.normal || '#16a34a'}
                              </div>
                              <div className="text-xs text-gray-500">Default: Green (#16a34a)</div>
                            </div>
                          </div>
                          <div className="mt-2 p-2 border border-gray-200 rounded bg-gray-50">
                            <span 
                              className="text-sm font-bold" 
                              style={{ color: labSettings.result_colors?.normal || '#16a34a' }}
                            >
                              Preview: normal
                            </span>
                          </div>
                          <div className="text-xs text-gray-500 mt-1">
                            Also applies to: N
                          </div>
                        </div>
                      </div>

                      <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mt-4">
                        <div className="space-y-1 text-xs text-blue-800">
                          <p><strong>How it works:</strong></p>
                          <ul className="list-disc list-inside space-y-0.5 ml-2">
                            <li><strong>Critical values</strong> automatically use the same color as their direction (critical_high → high color, critical_low → low color)</li>
                            <li><strong>"Abnormal" without direction</strong> uses the high color (treated as generally concerning)</li>
                            <li><strong>E-Copy (screen)</strong>: Uses these colors for visual highlighting</li>
                            <li><strong>Print version</strong>: Uses bold text instead of colors for grayscale printing</li>
                          </ul>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Partner Portal Settings */}
                  <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 lg:col-span-2">
                    <h3 className="text-lg font-semibold text-gray-900 mb-2 flex items-center">
                      <MessageSquare className="h-5 w-5 mr-2 text-blue-600" />
                      Partner Portal Settings
                    </h3>
                    <p className="text-xs text-gray-500 mb-5">
                      Common welcome note, updates slider, and branding option for all partner accounts.
                    </p>

                    <div className="space-y-5">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Welcome Note</label>
                        <textarea
                          value={portalSettings.welcome_note}
                          onChange={(e) => updatePortalSettings({ welcome_note: e.target.value })}
                          className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                          rows={3}
                          placeholder="Welcome to your partner portal. Track orders, download reports, and book new tests here."
                        />
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <label className="flex items-start cursor-pointer gap-3 rounded-lg border border-gray-200 p-3">
                          <input
                            type="checkbox"
                            checked={portalSettings.announcements_enabled}
                            onChange={(e) => updatePortalSettings({ announcements_enabled: e.target.checked })}
                            className="mt-0.5 h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                          />
                          <div>
                            <span className="text-sm font-medium text-gray-800">Show text announcements</span>
                            <p className="text-xs text-gray-400 mt-0.5">Displays text notices (holidays, closures, news) on the partner portal.</p>
                          </div>
                        </label>

                        <label className="flex items-start cursor-pointer gap-3 rounded-lg border border-gray-200 p-3">
                          <input
                            type="checkbox"
                            checked={portalSettings.updates_enabled}
                            onChange={(e) => updatePortalSettings({ updates_enabled: e.target.checked })}
                            className="mt-0.5 h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                          />
                          <div>
                            <span className="text-sm font-medium text-gray-800">Show promotional image slider</span>
                            <p className="text-xs text-gray-400 mt-0.5">Displays the image carousel promoting tests and packages.</p>
                          </div>
                        </label>

                        <label className="flex items-start cursor-pointer gap-3 rounded-lg border border-gray-200 p-3">
                          <input
                            type="checkbox"
                            checked={portalSettings.hide_lims_branding}
                            onChange={(e) => updatePortalSettings({ hide_lims_branding: e.target.checked })}
                            className="mt-0.5 h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                          />
                          <div>
                            <span className="text-sm font-medium text-gray-800">Hide LIMS branding in partner portal</span>
                            <p className="text-xs text-gray-400 mt-0.5">Removes the footer branding for all partner accounts.</p>
                          </div>
                        </label>
                      </div>

                      <div className="space-y-3 rounded-lg border border-amber-200 bg-amber-50/40 p-4">
                        <div className="flex items-center justify-between">
                          <div>
                            <label className="block text-sm font-medium text-gray-700">Text Announcements</label>
                            <p className="mt-0.5 text-xs text-gray-500">Short text notices — e.g. "Lab closed for Diwali on 29 Oct" or today's news.</p>
                          </div>
                          <button
                            type="button"
                            onClick={addAnnouncementSlide}
                            className="px-3 py-1.5 text-xs font-medium bg-amber-50 text-amber-700 rounded border border-amber-300 hover:bg-amber-100"
                          >
                            Add Announcement
                          </button>
                        </div>

                        <div>
                          <label className="block text-xs font-medium text-gray-600 mb-1">Section Name</label>
                          <input
                            type="text"
                            value={portalSettings.announcements_title}
                            onChange={(e) => updatePortalSettings({ announcements_title: e.target.value })}
                            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                            placeholder="Announcements"
                          />
                        </div>

                        {portalSettings.announcement_slides.length === 0 ? (
                          <div className="rounded-lg border border-dashed border-gray-300 bg-white p-4 text-sm text-gray-500">
                            No announcements added yet.
                          </div>
                        ) : (
                          portalSettings.announcement_slides.map((slide, index) => (
                            <div key={index} className="rounded-lg border border-gray-200 bg-white p-3 space-y-2">
                              <div className="flex items-center justify-between">
                                <span className="text-xs font-semibold text-gray-600">Announcement {index + 1}</span>
                                <button
                                  type="button"
                                  onClick={() => removeAnnouncementSlide(index)}
                                  className="text-xs text-red-600 hover:text-red-700"
                                >
                                  Remove
                                </button>
                              </div>
                              <input
                                type="text"
                                value={slide.title}
                                onChange={(e) => updateAnnouncementSlide(index, { title: e.target.value })}
                                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                                placeholder="Announcement title"
                              />
                              <textarea
                                value={slide.message}
                                onChange={(e) => updateAnnouncementSlide(index, { message: e.target.value })}
                                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                                rows={2}
                                placeholder="Announcement message"
                              />
                            </div>
                          ))
                        )}
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Image Slider Section Name</label>
                        <input
                          type="text"
                          value={portalSettings.updates_title}
                          onChange={(e) => updatePortalSettings({ updates_title: e.target.value })}
                          className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                          placeholder="Partner Portal Updates"
                        />
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">Image Slider Size</label>
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                          {[
                            { value: 'square', title: 'Square (1:1)', description: 'Instagram-style square posts. Best for test/package creatives.' },
                            { value: 'landscape', title: 'Landscape (16:9)', description: 'Standard widescreen images and posters.' },
                            { value: 'banner', title: 'Wide Banner (3:1)', description: 'Slim full-width strip, like a website banner.' },
                          ].map((option) => (
                            <label
                              key={option.value}
                              className={`cursor-pointer rounded-lg border p-3 transition-colors ${
                                portalSettings.slider_aspect === option.value
                                  ? 'border-blue-500 bg-blue-50'
                                  : 'border-gray-200 bg-white hover:bg-gray-50'
                              }`}
                            >
                              <input
                                type="radio"
                                name="slider_aspect"
                                value={option.value}
                                checked={portalSettings.slider_aspect === option.value}
                                onChange={(e) => updatePortalSettings({ slider_aspect: e.target.value as PortalSettings['slider_aspect'] })}
                                className="sr-only"
                              />
                              <div className="text-sm font-semibold text-gray-900">{option.title}</div>
                              <div className="mt-1 text-xs leading-5 text-gray-500">{option.description}</div>
                            </label>
                          ))}
                        </div>
                      </div>

                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <div>
                            <label className="block text-sm font-medium text-gray-700">Promotional Image Slider</label>
                            <p className="mt-0.5 text-xs text-gray-500">Upload pictures promoting tests and packages. For best results match the slider size selected above.</p>
                          </div>
                          <button
                            type="button"
                            onClick={addPortalSlide}
                            className="px-3 py-1.5 text-xs font-medium bg-blue-50 text-blue-700 rounded border border-blue-200 hover:bg-blue-100"
                          >
                            Add Slide
                          </button>
                        </div>

                        {portalSettings.update_slides.length === 0 ? (
                          <div className="rounded-lg border border-dashed border-gray-300 p-4 text-sm text-gray-500">
                            No updates added yet.
                          </div>
                        ) : (
                          portalSettings.update_slides.map((slide, index) => (
                            <div key={index} className="rounded-lg border border-gray-200 bg-gray-50 p-3 space-y-2">
                              <div className="flex items-center justify-between">
                                <span className="text-xs font-semibold text-gray-600">Slide {index + 1}</span>
                                <button
                                  type="button"
                                  onClick={() => removePortalSlide(index)}
                                  className="text-xs text-red-600 hover:text-red-700"
                                >
                                  Remove
                                </button>
                              </div>
                              {slide.image_url ? (
                                <img
                                  src={slide.image_url}
                                  alt={slide.title || `Promotional slide ${index + 1}`}
                                  className={`mx-auto rounded-md border border-gray-200 bg-white object-cover ${
                                    portalSettings.slider_aspect === 'banner'
                                      ? 'aspect-[3/1] w-full'
                                      : portalSettings.slider_aspect === 'landscape'
                                        ? 'aspect-video w-64'
                                        : 'aspect-square w-40'
                                  }`}
                                />
                              ) : (
                                <div
                                  className={`mx-auto flex items-center justify-center rounded-md border border-dashed border-gray-300 bg-white p-2 text-center text-xs text-gray-400 ${
                                    portalSettings.slider_aspect === 'banner'
                                      ? 'aspect-[3/1] w-full'
                                      : portalSettings.slider_aspect === 'landscape'
                                        ? 'aspect-video w-64'
                                        : 'aspect-square w-40'
                                  }`}
                                >
                                  No promotional image uploaded
                                </div>
                              )}
                              <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-2">
                                <input
                                  type="url"
                                  value={slide.image_url || ''}
                                  onChange={(e) => updatePortalSlide(index, { image_url: e.target.value })}
                                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                                  placeholder="Image URL"
                                />
                                <label className="inline-flex cursor-pointer items-center justify-center rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-medium text-blue-700 hover:bg-blue-100">
                                  {uploadingPortalSlide[index] ? 'Uploading...' : 'Upload Image'}
                                  <input
                                    type="file"
                                    accept="image/*"
                                    className="sr-only"
                                    disabled={uploadingPortalSlide[index]}
                                    onChange={(e) => handlePortalSlideImageUpload(index, e.target.files?.[0])}
                                  />
                                </label>
                              </div>
                              <input
                                type="text"
                                value={slide.title}
                                onChange={(e) => updatePortalSlide(index, { title: e.target.value })}
                                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                                placeholder="Update title"
                              />
                              <textarea
                                value={slide.message}
                                onChange={(e) => updatePortalSlide(index, { message: e.target.value })}
                                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                                rows={2}
                                placeholder="Short update message"
                              />
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  </div>

                  {/* App Sidebar Branding */}
                  <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 lg:col-span-2">
                    <h3 className="text-lg font-semibold text-gray-900 mb-2 flex items-center">
                      <ImageIcon className="h-5 w-5 mr-2 text-blue-600" />
                      App Sidebar Branding
                    </h3>
                    <p className="text-xs text-gray-500 mb-5">
                      Choose what appears at the top of the main LIMS sidebar.
                    </p>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                      {[
                        { value: 'anpro', title: 'Show AnPro LIMS', description: 'Use the default product logo and name.' },
                        { value: 'lab', title: 'Use Lab Branding', description: 'Use the default lab logo and lab name.' },
                        { value: 'hidden', title: 'Hide Branding', description: 'Show only the sidebar controls.' },
                      ].map((option) => (
                        <label
                          key={option.value}
                          className={`cursor-pointer rounded-lg border p-4 transition-colors ${
                            portalSettings.sidebar_branding_mode === option.value
                              ? 'border-blue-500 bg-blue-50'
                              : 'border-gray-200 bg-white hover:bg-gray-50'
                          }`}
                        >
                          <input
                            type="radio"
                            name="sidebar_branding_mode"
                            value={option.value}
                            checked={portalSettings.sidebar_branding_mode === option.value}
                            onChange={(e) => updatePortalSettings({ sidebar_branding_mode: e.target.value as PortalSettings['sidebar_branding_mode'] })}
                            className="sr-only"
                          />
                          <div className="text-sm font-semibold text-gray-900">{option.title}</div>
                          <div className="mt-1 text-xs leading-5 text-gray-500">{option.description}</div>
                        </label>
                      ))}
                    </div>
                  </div>

                  {/* Workflow Settings */}
                  <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 lg:col-span-2">
                    <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center">
                      <Printer className="h-5 w-5 mr-2 text-blue-600" />
                      Workflow Settings
                    </h3>

                    {/* Printer Settings */}
                    <div className="mb-6">
                      <h4 className="text-sm font-semibold text-gray-700 mb-1">Preferred Printers</h4>
                      <p className="text-xs text-gray-500 mb-3">
                        Enter the exact printer name as it appears in your OS print dialog. Staff will be reminded which printer to select when printing.
                      </p>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">Barcode / Label Printer</label>
                          <input
                            type="text"
                            placeholder="e.g. Zebra ZD421, TSC DA210"
                            value={labSettings.barcode_printer_name || ''}
                            onChange={(e) => setLabSettings(prev => prev ? { ...prev, barcode_printer_name: e.target.value || null } : prev)}
                            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-blue-500 focus:border-blue-500"
                          />
                          <label className="flex items-start cursor-pointer gap-3 mt-3">
                            <input
                              type="checkbox"
                              checked={labSettings.barcode_browser_print_enabled ?? false}
                              onChange={(e) => setLabSettings(prev => prev ? { ...prev, barcode_browser_print_enabled: e.target.checked } : prev)}
                              className="mt-0.5 h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                            />
                            <div>
                              <span className="text-sm font-medium text-gray-800">Use browser print dialog for barcode labels</span>
                              <p className="text-xs text-gray-400 mt-0.5">Opens label printing in the browser instead of sending barcode labels to the LIMS Utility queue.</p>
                            </div>
                          </label>
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">Report Printer</label>
                          <input
                            type="text"
                            placeholder="e.g. HP LaserJet M404dn"
                            value={labSettings.report_printer_name || ''}
                            onChange={(e) => setLabSettings(prev => prev ? { ...prev, report_printer_name: e.target.value || null } : prev)}
                            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-blue-500 focus:border-blue-500"
                          />
                        </div>
                      </div>
                    </div>

                    {/* Barcode Label Layout */}
                    <div className="border-t border-gray-100 pt-5 mb-6">
                      <h4 className="text-sm font-semibold text-gray-700 mb-1">Barcode Label Layout</h4>
                      <p className="text-xs text-gray-500 mb-4">
                        Match these to your physical label stock. The same geometry drives both the browser print dialog and the thermal (ZPL) printers, so labels come out at exact size without staff adjusting scale or orientation.
                      </p>
                      <BarcodeLabelLayoutConfig
                        value={labSettings.barcode_label_layout}
                        onChange={(layout) => setLabSettings(prev => prev ? { ...prev, barcode_label_layout: layout } : prev)}
                      />
                    </div>

                    {/* Auto-collect on registration */}
                    <div className="border-t border-gray-100 pt-5">
                      <h4 className="text-sm font-semibold text-gray-700 mb-1">Sample Collection</h4>
                      <p className="text-xs text-gray-500 mb-3">
                        For labs that collect samples at the front desk (walk-in). When enabled, every new order is automatically marked as <strong>Sample Collected</strong> at the time of registration — bypassing the separate collection step. Barcode can be printed immediately.
                      </p>
                      <div className="space-y-3">
                        <label className="flex items-center cursor-pointer gap-3">
                          <input
                            type="checkbox"
                            checked={labSettings.auto_collect_on_registration ?? false}
                            onChange={(e) => setLabSettings(prev => prev ? { ...prev, auto_collect_on_registration: e.target.checked } : prev)}
                            className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                          />
                          <div>
                            <span className="text-sm font-medium text-gray-800">Auto-collect at registration</span>
                            <p className="text-xs text-gray-400 mt-0.5">Marks sample as collected when the order is created. No separate "Sample Collection" step required.</p>
                          </div>
                        </label>

                        <label className="flex items-center cursor-pointer gap-3">
                          <input
                            type="checkbox"
                            checked={labSettings.auto_open_collection_modal ?? false}
                            onChange={(e) => setLabSettings(prev => prev ? { ...prev, auto_open_collection_modal: e.target.checked } : prev)}
                            className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                          />
                          <div>
                            <span className="text-sm font-medium text-gray-800">Auto-open collection modal after order creation</span>
                            <p className="text-xs text-gray-400 mt-0.5">Immediately opens the Collect Sample dialog after each order is saved — ideal for front-desk walk-in labs that need to print barcodes on the spot.</p>
                          </div>
                        </label>
                      </div>
                    </div>

                    {/* Result Entry */}
                    <div className="border-t border-gray-100 pt-5">
                      <h4 className="text-sm font-semibold text-gray-700 mb-1">Result Entry</h4>
                      <p className="text-xs text-gray-500 mb-3">
                        Controls what the technician sees inside the result entry modal. Saved results are always listed there in a collapsed panel that can be opened, edited and approved analyte by analyte.
                      </p>
                      <label className="flex items-start cursor-pointer gap-3">
                        <input
                          type="checkbox"
                          checked={labSettings.show_approve_all_in_result_entry ?? false}
                          onChange={(e) => setLabSettings(prev => prev ? { ...prev, show_approve_all_in_result_entry: e.target.checked } : prev)}
                          className="mt-0.5 h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                        />
                        <div>
                          <span className="text-sm font-medium text-gray-800">Show "Approve Whole Order" button in result entry</span>
                          <p className="text-xs text-gray-400 mt-0.5">Lets whoever enters results verify every analyte on the order in one click. Leave off when a separate verification desk must sign off.</p>
                        </div>
                      </label>
                    </div>

                    {/* Order List View */}
                    <div className="border-t border-gray-100 pt-5">
                      <h4 className="text-sm font-semibold text-gray-700 mb-1">Order List View</h4>
                      <p className="text-xs text-gray-500 mb-3">
                        Sets how the Test Orders list opens on the dashboard. Staff can still switch between collapsed and expanded with the button on the page — this only decides which one they land on.
                      </p>
                      <label className="flex items-start cursor-pointer gap-3">
                        <input
                          type="checkbox"
                          checked={labSettings.default_collapsed_order_cards ?? false}
                          onChange={(e) => setLabSettings(prev => prev ? { ...prev, default_collapsed_order_cards: e.target.checked } : prev)}
                          className="mt-0.5 h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                        />
                        <div>
                          <span className="text-sm font-medium text-gray-800">Open order cards collapsed by default</span>
                          <p className="text-xs text-gray-400 mt-0.5">Shows one compact row per order so more orders fit on screen. Leave off to open the full cards with test chips visible.</p>
                        </div>
                      </label>
                    </div>

                    {/* TAT Alerts */}
                    <div className="border-t border-gray-100 pt-5">
                      <h4 className="text-sm font-semibold text-gray-700 mb-1">TAT Alerts</h4>
                      <p className="text-xs text-gray-500 mb-3">
                        Controls the floating TAT alert panel. Orders that breached longer ago than this are treated as stale and dropped from the panel, so the list keeps showing breaches the team can still act on.
                      </p>
                      <div className="flex items-center gap-3">
                        <input
                          type="number"
                          min={1}
                          max={720}
                          value={labSettings.tat_alert_max_overdue_hours ?? 72}
                          onChange={(e) => {
                            const parsed = parseInt(e.target.value, 10);
                            setLabSettings(prev => prev ? {
                              ...prev,
                              tat_alert_max_overdue_hours: Number.isFinite(parsed) && parsed > 0 ? parsed : undefined,
                            } : prev);
                          }}
                          className="w-24 px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-blue-500 focus:border-blue-500"
                        />
                        <div>
                          <span className="text-sm font-medium text-gray-800">Hide alerts overdue by more than this many hours</span>
                          <p className="text-xs text-gray-400 mt-0.5">Default 72 (3 days). Lower it to 24 or 48 if stale breaches are crowding out fresh ones.</p>
                        </div>
                      </div>
                    </div>

                    {/* Sample Type Colors */}
                    <div className="border-t border-gray-100 pt-5">
                      <h4 className="text-sm font-semibold text-gray-700 mb-1 flex items-center gap-2">
                        <Droplet className="h-4 w-4 text-blue-500" />
                        Sample Type / Tube Colors
                      </h4>
                      <p className="text-xs text-gray-500 mb-3">
                        Customize tube cap colors displayed for each sample type across the lab.
                        Overrides default industry-standard colors when set.
                      </p>
                      <SampleTypeColorsConfig
                        value={labSettings.sample_type_colors || {}}
                        onChange={(colors) => setLabSettings(prev => prev ? { ...prev, sample_type_colors: colors } : prev)}
                      />
                    </div>

                    {/* LIMS Utility Auto-Print */}
                    <div className="border-t border-gray-100 pt-5">
                      <h4 className="text-sm font-semibold text-gray-700 mb-1">Auto-Print via LIMS Utility</h4>
                      <p className="text-xs text-gray-500 mb-3">
                        Sends print jobs to the local LIMS Bridge Utility queue. The installed utility polls the cloud queue,
                        prints on the configured desktop printer, and reports success or failure back to LIMS.
                        Printer names above must match the utility/Windows printer names exactly.
                      </p>

                      {/* Queue status */}
                      <div className="flex items-center gap-3 mb-4 p-3 rounded-lg bg-gray-50 border border-gray-200">
                        <span className={`inline-block w-2.5 h-2.5 rounded-full flex-shrink-0 ${
                          qzStatus === 'connected' ? 'bg-green-500' :
                          qzStatus === 'connecting' ? 'bg-yellow-400 animate-pulse' :
                          qzStatus === 'error' ? 'bg-red-500' : 'bg-gray-400'
                        }`} />
                        <span className="text-sm text-gray-700 flex-1">
                          Print queue:{' '}
                          <span className={`font-medium ${
                            qzStatus === 'connected' ? 'text-green-600' :
                            qzStatus === 'connecting' ? 'text-yellow-600' :
                            qzStatus === 'error' ? 'text-red-600' : 'text-gray-500'
                          }`}>
                            {qzStatus === 'connected' ? 'Ready' :
                             qzStatus === 'connecting' ? 'Connecting…' :
                             qzStatus === 'error' ? 'Queue unavailable' : 'Paused'}
                          </span>
                        </span>
                        {qzStatus === 'connected' ? (
                          <button
                            type="button"
                            onClick={() => qzDisconnect()}
                            className="text-xs px-3 py-1 rounded border border-gray-300 text-gray-600 hover:bg-gray-100"
                          >
                            Disconnect
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => qzConnect().catch(() => {})}
                            disabled={qzStatus === 'connecting'}
                            className="text-xs px-3 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:bg-gray-300"
                          >
                            {qzStatus === 'connecting' ? 'Connecting…' : 'Resume'}
                          </button>
                        )}
                      </div>

                      <div className="space-y-3">
                        <label className="flex items-start cursor-pointer gap-3">
                          <input
                            type="checkbox"
                            checked={labSettings.auto_print_barcode_on_order ?? false}
                            onChange={(e) => setLabSettings(prev => prev ? { ...prev, auto_print_barcode_on_order: e.target.checked } : prev)}
                            className="mt-0.5 h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                          />
                          <div>
                            <span className="text-sm font-medium text-gray-800">Auto-print barcode label on order creation</span>
                            <p className="text-xs text-gray-400 mt-0.5">Queues a ZPL label for the Barcode / Label Printer immediately after an order is saved.</p>
                          </div>
                        </label>

                        <label className="flex items-start cursor-pointer gap-3">
                          <input
                            type="checkbox"
                            checked={labSettings.auto_print_report_on_approval ?? false}
                            onChange={(e) => setLabSettings(prev => prev ? { ...prev, auto_print_report_on_approval: e.target.checked } : prev)}
                            className="mt-0.5 h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                          />
                          <div>
                            <span className="text-sm font-medium text-gray-800">Auto-print report when results are approved</span>
                            <p className="text-xs text-gray-400 mt-0.5">Queues the final PDF report for the Report Printer when results are approved.</p>
                          </div>
                        </label>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Save Button */}
                <div className="flex justify-end">
                  <button
                    onClick={handleSaveLabSettings}
                    disabled={savingLab}
                    className="flex items-center px-6 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:bg-gray-400"
                  >
                    {savingLab ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Saving...
                      </>
                    ) : (
                      <>
                        <Save className="h-4 w-4 mr-2" />
                        Save Lab Settings
                      </>
                    )}
                  </button>
                </div>
              </>
            ) : (
              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                <div className="flex items-center text-sm text-yellow-700">
                  <AlertTriangle className="h-5 w-5 mr-2" />
                  No lab settings found. Please contact support.
                </div>
              </div>
            )}
          </div>
        )}

        {/* Notifications Tab */}
        {activeTab === 'notifications' && (
          <div className="space-y-8">
            <NotificationTriggerSettings />
            <div className="pt-8 border-t border-gray-200">
              <NotificationSettings />
            </div>
          </div>
        )}

        {/* Accession Tab */}
        {activeTab === 'accession' && labId && (
          <div className="p-6">
            <AccessionSettings
              labId={labId}
              value={labSettings?.accession_collection_config}
              onSaved={(config) => setLabSettings((prev) => prev ? { ...prev, accession_collection_config: config } : prev)}
            />
          </div>
        )}

        {/* Invoice Templates Tab */}
        {activeTab === 'invoices' && (
          <InvoiceTemplateManager />
        )}

        {/* Analyzer Interface Tab */}
        {activeTab === 'analyzer' && labInterfaceEnabled && labId && (
          <div className="p-6 space-y-8">
            <div>
              <h2 className="text-lg font-semibold text-gray-800">Analyzer Interface</h2>
              <p className="text-sm text-gray-500 mt-1">
                Configure physical analyzers and the Bridge API keys that connect them to LIMS.
              </p>
            </div>

            {/* Analyzer Connections */}
            <div className="bg-white rounded-xl border border-gray-200 p-5">
              <AnalyzerConnectionsManager labId={labId} />
            </div>

            {/* Analyte Interface Config */}
            <div className="bg-white rounded-xl border border-gray-200 p-5">
              <AnalyteInterfaceConfig labId={labId} />
            </div>

            {/* Bridge API Keys */}
            <div className="bg-white rounded-xl border border-gray-200 p-5">
              <div className="mb-4">
                <h3 className="text-base font-semibold text-gray-800">Bridge API Keys</h3>
                <p className="text-sm text-gray-500 mt-0.5">
                  Generate keys for the on-premises Bridge process that relays messages between LIMS and analyzers.
                </p>
              </div>
              <AnalyzerAPIKeys />
            </div>
          </div>
        )}

        {/* Patient Portal Tab */}
        {activeTab === 'patient_portal' && labId && (
          <div className="p-6">
            <PatientPortalSettings labId={labId} />
          </div>
        )}

        {/* Public Booking Link Tab */}
        {activeTab === 'public_booking' && labId && (
          <div className="p-6">
            <PublicBookingSettings labId={labId} />
          </div>
        )}

        {/* Patient Form Tab */}
        {activeTab === 'patient_form' && labId && (
          <div className="p-6">
            <PatientFormSettings labId={labId} />
          </div>
        )}

        {/* Billing Items Tab */}
        {activeTab === 'billing_items' && labId && (
          <div className="p-6">
            <LabBillingItemSettings labId={labId} />
          </div>
        )}

        {/* Price Masters Tab */}
        {activeTab === 'price_masters' && (
          <div className="p-6">
            <PriceMasterSettings />
          </div>
        )}

        {/* Payment Gateway Tab */}
        {activeTab === 'payment_gateway' && labId && (
          <div className="p-6">
            <PaymentGatewaySettings labId={labId} />
          </div>
        )}

      </div>

      {/* User Form Modal (for adding new users) */}
      {
        showUserForm && labId && (
          <UserFormComponent
            onClose={() => { setShowUserForm(false); setSelectedUser(null); }}
            user={selectedUser || undefined}
            permissions={permissions}
            availableRoles={availableRoles}
            labId={labId}
            onSave={reloadUsers}
          />
        )
      }

      {/* Edit User Modal (for editing existing users - no auth changes) */}
      {
        showEditUserModal && selectedUser && labId && (
          <EditUserModal
            user={selectedUser}
            onClose={() => { setShowEditUserModal(false); setSelectedUser(null); }}
            onSuccess={reloadUsers}
            isAdmin={authUser?.user_metadata?.role === 'Admin'}
          />
        )
      }
    </div >
  );
};

export default Settings;
