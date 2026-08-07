import React, { useState, useEffect } from 'react';
import { database, InventoryItem } from '../../utils/supabase';
import { X, Save, Package, Beaker, Thermometer, MapPin, DollarSign, User } from 'lucide-react';

interface InventoryItemFormProps {
  item: InventoryItem | null;
  locationId?: string;
  onClose: () => void;
  onSave: () => void;
}

const InventoryItemForm: React.FC<InventoryItemFormProps> = ({ item, locationId, onClose, onSave }) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [formData, setFormData] = useState({
    name: '',
    code: '',
    type: 'consumable' as 'reagent' | 'consumable' | 'calibrator' | 'control' | 'general',
    current_stock: 0,
    unit: 'pcs',
    min_stock: 0,
    batch_number: '',
    expiry_date: '',
    storage_temp: '',
    storage_location: '',
    consumption_scope: 'manual' as 'per_test' | 'per_sample' | 'per_order' | 'qc_only' | 'general' | 'manual',
    consumption_per_use: 1,
    pack_contains: '' as string | number,
    unit_price: '' as string | number,
    supplier_name: '',
    supplier_contact: '',
    is_partner_orderable: false,
    notes: '',
  });

  // Load item data for editing
  useEffect(() => {
    if (item) {
      setFormData({
        name: item.name || '',
        code: item.code || '',
        type: item.type,
        current_stock: item.current_stock,
        unit: item.unit || 'pcs',
        min_stock: item.min_stock || 0,
        batch_number: item.batch_number || '',
        expiry_date: item.expiry_date ? item.expiry_date.split('T')[0] : '',
        storage_temp: item.storage_temp || '',
        storage_location: item.storage_location || '',
        consumption_scope: item.consumption_scope,
        consumption_per_use: item.consumption_per_use || 1,
        pack_contains: item.pack_contains || '',
        unit_price: item.unit_price || '',
        supplier_name: item.supplier_name || '',
        supplier_contact: item.supplier_contact || '',
        is_partner_orderable: item.is_partner_orderable ?? false,
        notes: item.notes || '',
      });
    }
  }, [item]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value, type } = e.target;
    if (type === 'checkbox') {
      const { checked } = e.target as HTMLInputElement;
      setFormData(prev => ({ ...prev, [name]: checked }));
      return;
    }
    setFormData(prev => ({
      ...prev,
      [name]: type === 'number' ? (value === '' ? '' : Number(value)) : value,
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const payload = {
        ...formData,
        pack_contains: formData.pack_contains === '' ? null : Number(formData.pack_contains),
        unit_price: formData.unit_price === '' ? null : Number(formData.unit_price),
        expiry_date: formData.expiry_date || null,
      };

      if (item) {
        // Update existing item
        const { error: updateError } = await database.inventory.updateItem(item.id, payload);
        if (updateError) throw updateError;
      } else {
        // Create new item
        const { error: createError } = await database.inventory.createItem({
          ...payload,
          location_id: locationId || undefined,
        });
        if (createError) throw createError;
      }

      onSave();
    } catch (err: any) {
      setError(err.message || 'Failed to save item');
    } finally {
      setLoading(false);
    }
  };

  const requiresPerUse = formData.consumption_scope !== 'manual' && formData.consumption_scope !== 'general';
  const showPackContainsHint = formData.consumption_scope === 'per_test' || formData.consumption_scope === 'qc_only';

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 bg-white border-b border-gray-100 px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-100 rounded-lg">
              <Package className="h-5 w-5 text-blue-600" />
            </div>
            <h2 className="text-lg font-semibold text-gray-900">
              {item ? 'Edit Item' : 'Add New Item'}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
          >
            <X className="h-5 w-5 text-gray-500" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-6 space-y-6">
          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg">
              {error}
            </div>
          )}

          {/* Basic Info */}
          <div className="space-y-4">
            <h3 className="font-medium text-gray-900 flex items-center gap-2">
              <Package className="h-4 w-4 text-gray-400" />
              Basic Information
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Item Name *
                </label>
                <input
                  type="text"
                  name="name"
                  value={formData.name}
                  onChange={handleChange}
                  required
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  placeholder="e.g., CBC Reagent Kit"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Item Code
                </label>
                <input
                  type="text"
                  name="code"
                  value={formData.code}
                  onChange={handleChange}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  placeholder="e.g., CBC-001"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Type *
                </label>
                <select
                  name="type"
                  value={formData.type}
                  onChange={handleChange}
                  required
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                >
                  <option value="reagent">Reagent</option>
                  <option value="consumable">Consumable</option>
                  <option value="calibrator">Calibrator</option>
                  <option value="control">Control</option>
                  <option value="general">General</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Unit *
                </label>
                <select
                  name="unit"
                  value={formData.unit}
                  onChange={handleChange}
                  required
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                >
                  <option value="pcs">Pieces (pcs)</option>
                  <option value="box">Box</option>
                  <option value="kit">Kit</option>
                  <option value="bottle">Bottle</option>
                  <option value="ml">Milliliters (ml)</option>
                  <option value="L">Liters (L)</option>
                  <option value="g">Grams (g)</option>
                  <option value="test">Tests</option>
                </select>
              </div>
            </div>
          </div>

          {/* Stock Management */}
          <div className="space-y-4">
            <h3 className="font-medium text-gray-900 flex items-center gap-2">
              <Beaker className="h-4 w-4 text-gray-400" />
              Stock Management
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Current Stock *
                </label>
                <input
                  type="number"
                  name="current_stock"
                  value={formData.current_stock}
                  onChange={handleChange}
                  required
                  min="0"
                  step="0.01"
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Minimum Stock (Alert)
                </label>
                <input
                  type="number"
                  name="min_stock"
                  value={formData.min_stock}
                  onChange={handleChange}
                  min="0"
                  step="0.01"
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Pack Contains
                </label>
                <input
                  type="number"
                  name="pack_contains"
                  value={formData.pack_contains}
                  onChange={handleChange}
                  min="0"
                  placeholder="e.g., 20 tests"
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
                <p className="text-xs text-gray-500 mt-1">Tests per pack (e.g., 20 for TSH kit)</p>
              </div>
            </div>
          </div>

          {/* Consumption Rules */}
          <div className="space-y-4">
            <h3 className="font-medium text-gray-900">Consumption Rules</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Consumption Scope
                </label>
                <select
                  name="consumption_scope"
                  value={formData.consumption_scope}
                  onChange={handleChange}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                >
                  <option value="manual">Manual (No auto-consumption)</option>
                  <option value="per_test">Per Test (mapped or universal test use)</option>
                  <option value="per_sample">Per Sample (e.g., vacutainer)</option>
                  <option value="per_order">Per Order (e.g., report folder)</option>
                  <option value="qc_only">QC Only (control/calibrator run)</option>
                  <option value="general">General Lab Use (tracking only)</option>
                </select>
                <p className="text-xs text-gray-500 mt-1">
                  Choose the workflow stage where this item should auto-consume.
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Consumption Per Use
                </label>
                <input
                  type="number"
                  name="consumption_per_use"
                  value={formData.consumption_per_use}
                  onChange={handleChange}
                  min="0"
                  step="0.01"
                  disabled={!requiresPerUse}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
                <p className="text-xs text-gray-500 mt-1">
                  {requiresPerUse
                    ? 'Amount consumed per event before pack conversion.'
                    : 'Not used for manual or tracking-only items.'}
                </p>
              </div>
            </div>
            {showPackContainsHint && (
              <div className="rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-700">
                For kits, boxes, or bottles, keep stock in the pack unit and use `Pack Contains` to convert each test or QC run into the correct stock deduction.
              </div>
            )}
          </div>

          {/* Batch & Expiry */}
          <div className="space-y-4">
            <h3 className="font-medium text-gray-900 flex items-center gap-2">
              <Thermometer className="h-4 w-4 text-gray-400" />
              Batch & Storage
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Batch Number
                </label>
                <input
                  type="text"
                  name="batch_number"
                  value={formData.batch_number}
                  onChange={handleChange}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  placeholder="e.g., LOT-2024-001"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Expiry Date
                </label>
                <input
                  type="date"
                  name="expiry_date"
                  value={formData.expiry_date}
                  onChange={handleChange}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Storage Temperature
                </label>
                <select
                  name="storage_temp"
                  value={formData.storage_temp}
                  onChange={handleChange}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                >
                  <option value="">Not specified</option>
                  <option value="Room Temp">Room Temperature</option>
                  <option value="2-8°C">Refrigerated (2-8°C)</option>
                  <option value="-20°C">Frozen (-20°C)</option>
                  <option value="-80°C">Deep Frozen (-80°C)</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Storage Location
                </label>
                <input
                  type="text"
                  name="storage_location"
                  value={formData.storage_location}
                  onChange={handleChange}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  placeholder="e.g., Fridge A, Shelf B2"
                />
              </div>
            </div>
          </div>

          {/* Supplier & Pricing */}
          <div className="space-y-4">
            <h3 className="font-medium text-gray-900 flex items-center gap-2">
              <DollarSign className="h-4 w-4 text-gray-400" />
              Supplier & Pricing
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Unit Price
                </label>
                <input
                  type="number"
                  name="unit_price"
                  value={formData.unit_price}
                  onChange={handleChange}
                  min="0"
                  step="0.01"
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  placeholder="0.00"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Supplier Name
                </label>
                <input
                  type="text"
                  name="supplier_name"
                  value={formData.supplier_name}
                  onChange={handleChange}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  placeholder="e.g., ABC Diagnostics"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Supplier Contact
                </label>
                <input
                  type="text"
                  name="supplier_contact"
                  value={formData.supplier_contact}
                  onChange={handleChange}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  placeholder="Phone or email"
                />
              </div>
            </div>
          </div>

          {/* Partner catalog */}
          <div className="rounded-lg border border-gray-200 p-4">
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                name="is_partner_orderable"
                checked={formData.is_partner_orderable}
                onChange={handleChange}
                className="mt-0.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              <span>
                <span className="block text-sm font-medium text-gray-700">
                  Available to partners
                </span>
                <span className="block text-xs text-gray-500">
                  Franchise / B2B accounts can request this item from their portal
                </span>
              </span>
            </label>
          </div>

          {/* Notes */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Notes
            </label>
            <textarea
              name="notes"
              value={formData.notes}
              onChange={handleChange}
              rows={3}
              className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              placeholder="Additional notes about this item..."
            />
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-4 border-t border-gray-100">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
            >
              <Save className="h-4 w-4 mr-2" />
              {loading ? 'Saving...' : (item ? 'Update Item' : 'Create Item')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default InventoryItemForm;
