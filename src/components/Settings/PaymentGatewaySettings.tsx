import React, { useState, useEffect } from 'react';
import {
  CreditCard,
  Plus,
  Trash2,
  Edit2,
  Eye,
  EyeOff,
  CheckCircle,
  XCircle,
  AlertCircle,
  Save,
  X,
  ExternalLink,
  Shield
} from 'lucide-react';
import { supabase } from '../../utils/supabase';
import type {
  LabPaymentGateway,
  PaymentProvider,
  PaymentEnvironment
} from '../../types/payment';

interface PaymentGatewaySettingsProps {
  labId: string;
}

interface GatewayFormData {
  provider: PaymentProvider;
  display_name: string;
  environment: PaymentEnvironment;
  redirect_url: string;
  cancel_url: string;
  is_active: boolean;
  is_default: boolean;
  allow_patient_payments: boolean;
  payment_link_expiry_minutes: number;
  // CCAvenue
  merchant_id?: string;
  access_code?: string;
  working_key?: string;
  callback_access_code?: string;
  callback_working_key?: string;
  webhook_access_code?: string;
  webhook_working_key?: string;
  // Razorpay
  key_id?: string;
  key_secret?: string;
  webhook_secret?: string;
}

const PROVIDER_INFO: Record<PaymentProvider, { name: string; logo: string; color: string }> = {
  ccavenue: { name: 'CCAvenue', logo: '🏦', color: 'bg-blue-500' },
  razorpay: { name: 'Razorpay', logo: '💳', color: 'bg-blue-600' },
  paytm: { name: 'Paytm', logo: '📱', color: 'bg-sky-500' },
  phonepe: { name: 'PhonePe', logo: '📲', color: 'bg-purple-600' },
  stripe: { name: 'Stripe', logo: '💰', color: 'bg-violet-600' },
  paypal: { name: 'PayPal', logo: '🅿️', color: 'bg-blue-700' },
};

const PaymentGatewaySettings: React.FC<PaymentGatewaySettingsProps> = ({ labId }) => {
  const paymentFunctionsBaseUrl =
    import.meta.env.VITE_PAYMENT_FUNCTIONS_BASE_URL ||
    (window.location.hostname === 'app.limsapp.in'
      ? 'https://api.limsapp.in'
      : import.meta.env.VITE_SUPABASE_URL);
  const ccavenueCallbackUrl =
    import.meta.env.VITE_CCAVENUE_CALLBACK_URL ||
    `${paymentFunctionsBaseUrl}/functions/v1/payment-callback?provider=ccavenue`;
  const ccavenueWebhookUrl =
    import.meta.env.VITE_CCAVENUE_WEBHOOK_URL ||
    `${paymentFunctionsBaseUrl}/functions/v1/payment-webhook?provider=ccavenue`;
  // Must match PAYMENT_APP_BASE_URL on the edge functions, which build the link itself.
  const payLinkBaseUrl = (import.meta.env.VITE_PAYMENT_APP_BASE_URL || window.location.origin).replace(/\/+$/, '');

  const [gateways, setGateways] = useState<LabPaymentGateway[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [formData, setFormData] = useState<GatewayFormData>({
    provider: 'ccavenue',
    display_name: '',
    environment: 'test',
    redirect_url: '',
    cancel_url: '',
    is_active: true,
    is_default: false,
    allow_patient_payments: false,
    payment_link_expiry_minutes: 1440,
  });

  useEffect(() => {
    fetchGateways();
  }, [labId]);

  const fetchGateways = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('lab_payment_gateways')
        .select('*')
        .eq('lab_id', labId)
        .order('created_at', { ascending: false });

      if (error) throw error;
      setGateways(data || []);
    } catch (err) {
      console.error('Error fetching gateways:', err);
      setError('Failed to load payment gateways');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);

    try {
      // Build credentials object based on provider
      let credentials: Record<string, string> = {};

      if (formData.provider === 'ccavenue') {
        if (!formData.merchant_id || !formData.access_code || !formData.working_key) {
          throw new Error('All CCAvenue credentials are required');
        }
        credentials = {
          merchant_id: formData.merchant_id,
          access_code: formData.access_code,
          working_key: formData.working_key,
          callback_access_code: formData.callback_access_code || '',
          callback_working_key: formData.callback_working_key || '',
          webhook_access_code: formData.webhook_access_code || '',
          webhook_working_key: formData.webhook_working_key || '',
        };
      } else if (formData.provider === 'razorpay') {
        if (!formData.key_id || !formData.key_secret) {
          throw new Error('Razorpay Key ID and Secret are required');
        }
        credentials = {
          key_id: formData.key_id,
          key_secret: formData.key_secret,
          webhook_secret: formData.webhook_secret || '',
        };
      }

      const gatewayData = {
        lab_id: labId,
        provider: formData.provider,
        display_name: formData.display_name || PROVIDER_INFO[formData.provider].name,
        environment: formData.environment,
        redirect_url: formData.redirect_url,
        cancel_url: formData.cancel_url,
        is_active: formData.is_active,
        is_default: formData.is_default,
        allow_patient_payments: formData.allow_patient_payments,
        payment_link_expiry_minutes: formData.payment_link_expiry_minutes || 1440,
        credentials_encrypted: credentials,
      };

      if (editingId) {
        const { error } = await supabase
          .from('lab_payment_gateways')
          .update(gatewayData)
          .eq('id', editingId);

        if (error) throw error;
      } else {
        // If setting as default, unset other defaults first
        if (formData.is_default) {
          await supabase
            .from('lab_payment_gateways')
            .update({ is_default: false })
            .eq('lab_id', labId);
        }

        const { error } = await supabase
          .from('lab_payment_gateways')
          .insert(gatewayData);

        if (error) throw error;
      }

      await fetchGateways();
      resetForm();
    } catch (err: any) {
      console.error('Error saving gateway:', err);
      setError(err.message || 'Failed to save payment gateway');
    } finally {
      setSaving(false);
    }
  };

  const handleEdit = (gateway: LabPaymentGateway) => {
    const creds = gateway.credentials_encrypted as Record<string, string>;
    setFormData({
      provider: gateway.provider,
      display_name: gateway.display_name || '',
      environment: gateway.environment,
      redirect_url: gateway.redirect_url || '',
      cancel_url: gateway.cancel_url || '',
      is_active: gateway.is_active,
      is_default: gateway.is_default,
      allow_patient_payments: (gateway as any).allow_patient_payments ?? false,
      payment_link_expiry_minutes: (gateway as any).payment_link_expiry_minutes ?? 1440,
      merchant_id: creds?.merchant_id,
      access_code: creds?.access_code,
      working_key: creds?.working_key,
      callback_access_code: creds?.callback_access_code,
      callback_working_key: creds?.callback_working_key,
      webhook_access_code: creds?.webhook_access_code,
      webhook_working_key: creds?.webhook_working_key,
      key_id: creds?.key_id,
      key_secret: creds?.key_secret,
      webhook_secret: creds?.webhook_secret,
    });
    setEditingId(gateway.id);
    setShowForm(true);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this payment gateway?')) return;

    try {
      const { error } = await supabase
        .from('lab_payment_gateways')
        .delete()
        .eq('id', id);

      if (error) throw error;
      await fetchGateways();
    } catch (err) {
      console.error('Error deleting gateway:', err);
      setError('Failed to delete payment gateway');
    }
  };

  const toggleDefault = async (id: string) => {
    try {
      // Unset all defaults
      await supabase
        .from('lab_payment_gateways')
        .update({ is_default: false })
        .eq('lab_id', labId);

      // Set this one as default
      await supabase
        .from('lab_payment_gateways')
        .update({ is_default: true })
        .eq('id', id);

      await fetchGateways();
    } catch (err) {
      console.error('Error setting default:', err);
    }
  };

  const resetForm = () => {
    setFormData({
      provider: 'ccavenue',
      display_name: '',
      environment: 'test',
      redirect_url: '',
      cancel_url: '',
      is_active: true,
      is_default: false,
      allow_patient_payments: false,
      payment_link_expiry_minutes: 1440,
    });
    setEditingId(null);
    setShowForm(false);
  };

  const toggleSecret = (field: string) => {
    setShowSecrets((prev) => ({ ...prev, [field]: !prev[field] }));
  };

  const maskValue = (value?: string) => {
    if (!value) return '';
    if (value.length <= 8) return '••••••••';
    return value.substring(0, 4) + '••••' + value.substring(value.length - 4);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-gray-900 flex items-center gap-2">
            <CreditCard className="h-6 w-6" />
            Payment Gateway Settings
          </h2>
          <p className="text-sm text-gray-500 mt-1">
            Configure payment gateways for B2B client credit payments
          </p>
        </div>
        {!showForm && (
          <button
            onClick={() => setShowForm(true)}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
            <Plus className="h-4 w-4" />
            Add Gateway
          </button>
        )}
      </div>

      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg flex items-center gap-2 text-red-700">
          <AlertCircle className="h-5 w-5" />
          {error}
          <button onClick={() => setError(null)} className="ml-auto">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Add/Edit Form */}
      {showForm && (
        <div className="bg-white border border-gray-200 rounded-lg p-6 shadow-sm">
          <h3 className="text-lg font-medium mb-4">
            {editingId ? 'Edit Payment Gateway' : 'Add Payment Gateway'}
          </h3>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Provider */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Payment Provider
                </label>
                <select
                  value={formData.provider}
                  onChange={(e) =>
                    setFormData({ ...formData, provider: e.target.value as PaymentProvider })
                  }
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                  disabled={!!editingId}
                >
                  <option value="ccavenue">CCAvenue</option>
                  <option value="razorpay">Razorpay</option>
                  <option value="paytm">Paytm</option>
                  <option value="phonepe">PhonePe</option>
                </select>
              </div>

              {/* Display Name */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Display Name (Optional)
                </label>
                <input
                  type="text"
                  value={formData.display_name}
                  onChange={(e) => setFormData({ ...formData, display_name: e.target.value })}
                  placeholder={PROVIDER_INFO[formData.provider].name}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                />
              </div>

              {/* Environment */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Environment
                </label>
                <select
                  value={formData.environment}
                  onChange={(e) =>
                    setFormData({ ...formData, environment: e.target.value as PaymentEnvironment })
                  }
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                >
                  <option value="test">Test / Sandbox</option>
                  <option value="production">Production</option>
                </select>
              </div>

              {/* Status */}
              <div className="flex items-center gap-4 pt-6">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={formData.is_active}
                    onChange={(e) => setFormData({ ...formData, is_active: e.target.checked })}
                    className="rounded border-gray-300"
                  />
                  <span className="text-sm">Active</span>
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={formData.is_default}
                    onChange={(e) => setFormData({ ...formData, is_default: e.target.checked })}
                    className="rounded border-gray-300"
                  />
                  <span className="text-sm">Set as Default</span>
                </label>
              </div>
            </div>

            {/* Patient payments — off by default so enabling it is a deliberate act */}
            <div className="border-t pt-4 mt-4">
              <h4 className="text-sm font-medium text-gray-700 mb-3 flex items-center gap-2">
                <Shield className="h-4 w-4" />
                Patient Payments
              </h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={formData.allow_patient_payments}
                    onChange={(e) => setFormData({ ...formData, allow_patient_payments: e.target.checked })}
                    className="rounded border-gray-300 mt-0.5"
                  />
                  <span className="text-sm">
                    Allow patient payments
                    <span className="block text-xs text-gray-500 mt-0.5">
                      Lets staff raise a QR / WhatsApp pay link for a patient invoice, and lets patients
                      pay outstanding bills from the patient portal.
                    </span>
                  </span>
                </label>
                <div>
                  <label className="block text-sm text-gray-600 mb-1">Payment link validity (minutes)</label>
                  <input
                    type="number"
                    min={5}
                    max={43200}
                    value={formData.payment_link_expiry_minutes}
                    onChange={(e) =>
                      setFormData({ ...formData, payment_link_expiry_minutes: Number(e.target.value) })
                    }
                    className="w-full border border-gray-300 rounded-lg px-3 py-2"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    How long a pay link stays usable. Default 1440 (24 hours).
                  </p>
                </div>
              </div>
            </div>

            {/* Provider-specific credentials */}
            {formData.provider === 'ccavenue' && (
              <div className="border-t pt-4 mt-4">
                <h4 className="text-sm font-medium text-gray-700 mb-3 flex items-center gap-2">
                  <Shield className="h-4 w-4" />
                  CCAvenue Credentials
                </h4>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-sm text-gray-600 mb-1">Merchant ID *</label>
                    <input
                      type="text"
                      value={formData.merchant_id || ''}
                      onChange={(e) => setFormData({ ...formData, merchant_id: e.target.value })}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-sm text-gray-600 mb-1">Access Code *</label>
                    <div className="relative">
                      <input
                        type={showSecrets.access_code ? 'text' : 'password'}
                        value={formData.access_code || ''}
                        onChange={(e) => setFormData({ ...formData, access_code: e.target.value })}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 pr-10"
                        required
                      />
                      <button
                        type="button"
                        onClick={() => toggleSecret('access_code')}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                      >
                        {showSecrets.access_code ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm text-gray-600 mb-1">Working Key *</label>
                    <div className="relative">
                      <input
                        type={showSecrets.working_key ? 'text' : 'password'}
                        value={formData.working_key || ''}
                        onChange={(e) => setFormData({ ...formData, working_key: e.target.value })}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 pr-10"
                        required
                      />
                      <button
                        type="button"
                        onClick={() => toggleSecret('working_key')}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                      >
                        {showSecrets.working_key ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                  </div>
                </div>
                <div className="mt-4">
                  <h5 className="text-sm font-medium text-gray-700 mb-2">Optional CCAvenue Response Keys</h5>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm text-gray-600 mb-1">Callback Access Code</label>
                      <div className="relative">
                        <input
                          type={showSecrets.callback_access_code ? 'text' : 'password'}
                          value={formData.callback_access_code || ''}
                          onChange={(e) => setFormData({ ...formData, callback_access_code: e.target.value })}
                          className="w-full border border-gray-300 rounded-lg px-3 py-2 pr-10"
                          placeholder="Uses main access code if empty"
                        />
                        <button
                          type="button"
                          onClick={() => toggleSecret('callback_access_code')}
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                        >
                          {showSecrets.callback_access_code ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </button>
                      </div>
                    </div>
                    <div>
                      <label className="block text-sm text-gray-600 mb-1">Callback Working Key</label>
                      <div className="relative">
                        <input
                          type={showSecrets.callback_working_key ? 'text' : 'password'}
                          value={formData.callback_working_key || ''}
                          onChange={(e) => setFormData({ ...formData, callback_working_key: e.target.value })}
                          className="w-full border border-gray-300 rounded-lg px-3 py-2 pr-10"
                          placeholder="Uses main working key if empty"
                        />
                        <button
                          type="button"
                          onClick={() => toggleSecret('callback_working_key')}
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                        >
                          {showSecrets.callback_working_key ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </button>
                      </div>
                    </div>
                    <div>
                      <label className="block text-sm text-gray-600 mb-1">Webhook Access Code</label>
                      <div className="relative">
                        <input
                          type={showSecrets.webhook_access_code ? 'text' : 'password'}
                          value={formData.webhook_access_code || ''}
                          onChange={(e) => setFormData({ ...formData, webhook_access_code: e.target.value })}
                          className="w-full border border-gray-300 rounded-lg px-3 py-2 pr-10"
                          placeholder="Uses callback/main access code if empty"
                        />
                        <button
                          type="button"
                          onClick={() => toggleSecret('webhook_access_code')}
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                        >
                          {showSecrets.webhook_access_code ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </button>
                      </div>
                    </div>
                    <div>
                      <label className="block text-sm text-gray-600 mb-1">Webhook Working Key</label>
                      <div className="relative">
                        <input
                          type={showSecrets.webhook_working_key ? 'text' : 'password'}
                          value={formData.webhook_working_key || ''}
                          onChange={(e) => setFormData({ ...formData, webhook_working_key: e.target.value })}
                          className="w-full border border-gray-300 rounded-lg px-3 py-2 pr-10"
                          placeholder="Uses callback/main working key if empty"
                        />
                        <button
                          type="button"
                          onClick={() => toggleSecret('webhook_working_key')}
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                        >
                          {showSecrets.webhook_working_key ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {formData.provider === 'razorpay' && (
              <div className="border-t pt-4 mt-4">
                <h4 className="text-sm font-medium text-gray-700 mb-3 flex items-center gap-2">
                  <Shield className="h-4 w-4" />
                  Razorpay Credentials
                </h4>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-sm text-gray-600 mb-1">Key ID *</label>
                    <input
                      type="text"
                      value={formData.key_id || ''}
                      onChange={(e) => setFormData({ ...formData, key_id: e.target.value })}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2"
                      placeholder="rzp_test_..."
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-sm text-gray-600 mb-1">Key Secret *</label>
                    <div className="relative">
                      <input
                        type={showSecrets.key_secret ? 'text' : 'password'}
                        value={formData.key_secret || ''}
                        onChange={(e) => setFormData({ ...formData, key_secret: e.target.value })}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 pr-10"
                        required
                      />
                      <button
                        type="button"
                        onClick={() => toggleSecret('key_secret')}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                      >
                        {showSecrets.key_secret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm text-gray-600 mb-1">Webhook Secret</label>
                    <div className="relative">
                      <input
                        type={showSecrets.webhook_secret ? 'text' : 'password'}
                        value={formData.webhook_secret || ''}
                        onChange={(e) => setFormData({ ...formData, webhook_secret: e.target.value })}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 pr-10"
                        placeholder="Optional"
                      />
                      <button
                        type="button"
                        onClick={() => toggleSecret('webhook_secret')}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                      >
                        {showSecrets.webhook_secret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* URLs */}
            <div className="border-t pt-4 mt-4">
              <h4 className="text-sm font-medium text-gray-700 mb-3">Redirect URLs</h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm text-gray-600 mb-1">Success Redirect URL</label>
                  <input
                    type="url"
                    value={formData.redirect_url}
                    onChange={(e) => setFormData({ ...formData, redirect_url: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2"
                    placeholder="https://yourdomain.com/payment/success"
                  />
                </div>
                <div>
                  <label className="block text-sm text-gray-600 mb-1">Cancel/Failure URL</label>
                  <input
                    type="url"
                    value={formData.cancel_url}
                    onChange={(e) => setFormData({ ...formData, cancel_url: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2"
                    placeholder="https://yourdomain.com/payment/cancelled"
                  />
                </div>
              </div>
            </div>

            {/* Actions */}
            <div className="flex justify-end gap-3 pt-4 border-t">
              <button
                type="button"
                onClick={resetForm}
                className="px-4 py-2 text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
              >
                {saving ? (
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                {editingId ? 'Update' : 'Save'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Gateways List */}
      <div className="space-y-4">
        {gateways.length === 0 && !showForm ? (
          <div className="text-center py-12 bg-gray-50 rounded-lg border-2 border-dashed border-gray-200">
            <CreditCard className="h-12 w-12 text-gray-400 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-gray-900 mb-2">No Payment Gateways Configured</h3>
            <p className="text-gray-500 mb-4">
              Add a payment gateway to enable online credit payments for B2B clients
            </p>
            <button
              onClick={() => setShowForm(true)}
              className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
            >
              <Plus className="h-4 w-4" />
              Add Your First Gateway
            </button>
          </div>
        ) : (
          gateways.map((gateway) => {
            const info = PROVIDER_INFO[gateway.provider];
            const creds = gateway.credentials_encrypted as Record<string, string>;

            return (
              <div
                key={gateway.id}
                className={`bg-white border rounded-lg p-4 ${
                  gateway.is_default ? 'border-blue-300 ring-1 ring-blue-200' : 'border-gray-200'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div className={`w-12 h-12 ${info.color} rounded-lg flex items-center justify-center text-2xl`}>
                      {info.logo}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h4 className="font-medium text-gray-900">
                          {gateway.display_name || info.name}
                        </h4>
                        {gateway.is_default && (
                          <span className="px-2 py-0.5 text-xs bg-blue-100 text-blue-700 rounded-full">
                            Default
                          </span>
                        )}
                        <span
                          className={`px-2 py-0.5 text-xs rounded-full ${
                            gateway.environment === 'production'
                              ? 'bg-green-100 text-green-700'
                              : 'bg-yellow-100 text-yellow-700'
                          }`}
                        >
                          {gateway.environment}
                        </span>
                      </div>
                      <div className="text-sm text-gray-500 flex items-center gap-4 mt-1">
                        {gateway.provider === 'ccavenue' && (
                          <span>Merchant: {creds?.merchant_id || 'Not set'}</span>
                        )}
                        {gateway.provider === 'razorpay' && (
                          <span>Key: {maskValue(creds?.key_id)}</span>
                        )}
                        <span className="flex items-center gap-1">
                          {gateway.is_active ? (
                            <>
                              <CheckCircle className="h-3 w-3 text-green-500" />
                              Active
                            </>
                          ) : (
                            <>
                              <XCircle className="h-3 w-3 text-red-500" />
                              Inactive
                            </>
                          )}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    {!gateway.is_default && gateway.is_active && (
                      <button
                        onClick={() => toggleDefault(gateway.id)}
                        className="px-3 py-1 text-sm text-blue-600 hover:bg-blue-50 rounded-lg"
                      >
                        Set Default
                      </button>
                    )}
                    <button
                      onClick={() => handleEdit(gateway)}
                      className="p-2 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg"
                    >
                      <Edit2 className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => handleDelete(gateway.id)}
                      className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Info Section */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <h4 className="font-medium text-blue-800 mb-2 flex items-center gap-2">
          <AlertCircle className="h-4 w-4" />
          Important Notes
        </h4>
        <ul className="text-sm text-blue-700 space-y-1 list-disc list-inside">
          <li>Credentials are encrypted and stored securely</li>
          <li>Use Test/Sandbox environment for development and testing</li>
          <li>Switch to Production only after thorough testing</li>
          <li>Configure webhook URLs in your payment gateway dashboard</li>
          <li>
	            Callback endpoint:{' '}
	            <code className="bg-blue-100 px-1 rounded">
	              {ccavenueCallbackUrl}
	            </code>
	          </li>
	          <li>
	            Webhook endpoint:{' '}
	            <code className="bg-blue-100 px-1 rounded">
	              {ccavenueWebhookUrl}
	            </code>
	          </li>
	          <li>
	            Patient pay links are issued under:{' '}
	            <code className="bg-blue-100 px-1 rounded">{payLinkBaseUrl}/pay/&lt;token&gt;</code>
	          </li>
        </ul>
      </div>
    </div>
  );
};

export default PaymentGatewaySettings;
