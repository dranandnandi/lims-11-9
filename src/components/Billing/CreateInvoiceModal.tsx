import React, { useState, useEffect } from 'react';
import { X, Info, Briefcase, ChevronDown, ChevronRight } from 'lucide-react';
import {
  calcDiscountAmount,
  calcInvoiceTotals,
  createInvoiceFromDraft,
  getBillableTests,
  loadOrderInvoiceDraft,
  money,
  toNum,
  type ChargeDiscountInfo,
  type DiscountInfo,
  type OrderBillingItem,
  type OrderInvoiceDraft,
  type OrderTest,
} from '../../utils/orderInvoicing';

interface CreateInvoiceModalProps {
  orderId: string;
  onClose: () => void;
  onSuccess: () => void;
}

const CreateInvoiceModal: React.FC<CreateInvoiceModalProps> = ({ orderId, onClose, onSuccess }) => {
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<OrderInvoiceDraft | null>(null);
  const [order, setOrder] = useState<any>(null);
  const [tests, setTests] = useState<OrderTest[]>([]);
  const [selectedTests, setSelectedTests] = useState<string[]>([]);
  const [discounts, setDiscounts] = useState<Record<string, DiscountInfo>>({});
  const [notes, setNotes] = useState('');
  const [creating, setCreating] = useState(false);

  // NEW: Dual invoice system state
  const [invoiceType, setInvoiceType] = useState<'patient' | 'account'>('patient');
  const [billingPeriod, setBillingPeriod] = useState('');

  // Package display state - track which packages are expanded
  const [expandedPackages, setExpandedPackages] = useState<Set<string>>(new Set());

  // Extra charges (lab billing items)
  const [orderBillingItems, setOrderBillingItems] = useState<OrderBillingItem[]>([]);
  const [selectedChargeIds, setSelectedChargeIds] = useState<string[]>([]);
  const [chargeDiscounts, setChargeDiscounts] = useState<Record<string, ChargeDiscountInfo>>({});

  useEffect(() => { loadOrderDetails(); }, [orderId]);

  useEffect(() => {
    // Auto-set invoice type based on order properties
    if (order) {
      if (order.account_id) {
        setInvoiceType('account');
        // Set default billing period to current month
        const now = new Date();
        setBillingPeriod(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`);
      } else {
        setInvoiceType('patient');
      }
    }
  }, [order]);

  const loadOrderDetails = async () => {
    try {
      setLoading(true);
      const loaded = await loadOrderInvoiceDraft(orderId);

      setDraft(loaded);
      setOrder(loaded.order);
      setTests(loaded.tests); // Keep all for reference
      setSelectedTests(getBillableTests(loaded.tests).map(t => t.id)); // Only select billable items
      // Default discounts (Account > Location > Doctor) — manual always wins when user applies
      setDiscounts(loaded.discounts);
      setOrderBillingItems(loaded.billingItems);
      setSelectedChargeIds(loaded.billingItems.map(c => c.id));
    } catch (error) {
      console.error('Error loading order details:', error);
    } finally {
      setLoading(false);
    }
  };

  const calcLineTotal = (test: OrderTest) => {
    const discountAmount = calcDiscountAmount(toNum(test.price), discounts[test.id]);
    return Math.max(0, toNum(test.price) - discountAmount);
  };

  const calcChargeLineTotal = (charge: { id: string; amount: number }) => {
    const discountAmount = calcDiscountAmount(toNum(charge.amount), chargeDiscounts[charge.id]);
    return Math.max(0, toNum(charge.amount) - discountAmount);
  };

  const calcTotals = () => {
    if (!draft) return { subtotal: 0, testSubtotal: 0, chargesSubtotal: 0, totalDiscount: 0, total: 0 };
    return calcInvoiceTotals(draft, {
      selectedTestIds: selectedTests,
      selectedChargeIds,
      discounts,
      chargeDiscounts,
    });
  };

  const handleDiscountChange = (testId: string, type: 'percent' | 'flat', value: number, reason: string) => {
    setDiscounts(prev => {
      const next = { ...prev };
      const normalizedValue = Math.max(0, toNum(value));
      if (normalizedValue <= 0) {
        delete next[testId];
      } else {
        next[testId] = {
          type,
          value: normalizedValue,
          reason: reason.trim() || 'Manual discount',
          source: 'manual'
        };
      }
      return next;
    });
  };

  const handleChargeDiscountChange = (chargeId: string, type: 'percent' | 'flat', value: number, reason: string) => {
    setChargeDiscounts(prev => {
      const next = { ...prev };
      const normalizedValue = Math.max(0, toNum(value));
      if (normalizedValue <= 0) {
        delete next[chargeId];
      } else {
        next[chargeId] = {
          type,
          value: normalizedValue,
          reason: reason.trim() || 'Manual discount'
        };
      }
      return next;
    });
  };

  const handleCreate = async () => {
    if (!draft) return;
    if (selectedTests.length === 0 && selectedChargeIds.length === 0) {
      alert('Please select at least one test or billing item');
      return;
    }

    // Validation for account invoices
    if (invoiceType === 'account') {
      if (!order.account_id) {
        alert('Account invoice type requires an account to be selected on the order');
        return;
      }
      if (!billingPeriod) {
        alert('Please specify a billing period for account invoices');
        return;
      }
    }

    setCreating(true);
    try {
      await createInvoiceFromDraft(draft, {
        selectedTestIds: selectedTests,
        selectedChargeIds,
        discounts,
        chargeDiscounts,
        invoiceType,
        billingPeriod,
        notes,
      });
      onSuccess();
    } catch (error) {
      console.error('Error creating invoice:', error);
      alert('Failed to create invoice. Please try again.');
    } finally {
      setCreating(false);
    }
  };

  if (loading) {
    return (
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
        <div className="bg-white rounded-lg p-6">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
        </div>
      </div>
    );
  }

  const totals = calcTotals();

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 w-full max-w-4xl max-h-[90vh] overflow-y-auto">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-2xl font-bold text-gray-900">Create Invoice</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="w-6 h-6" />
          </button>
        </div>

        {/* Order Info */}
        <div className="bg-gray-50 p-4 rounded-lg mb-6">
          <div className="grid grid-cols-3 gap-4 text-sm">
            <div><span className="text-gray-600">Order ID:</span><div className="font-medium">{order?.id.slice(0, 8)}</div></div>
            <div><span className="text-gray-600">Patient:</span><div className="font-medium">{order?.patient_name}</div></div>
            <div><span className="text-gray-600">Payment Type:</span><div className="font-medium capitalize">{order?.payment_type || 'Self'}</div></div>
            {!!order?.referring_doctor_id && <div><span className="text-gray-600">Doctor:</span><div className="font-medium">{order?.doctor}</div></div>}
            {!!order?.location_id && <div><span className="text-gray-600">Location:</span><div className="font-medium">{order?.location?.name || ''}</div></div>}
            {!!order?.account_id && <div className="col-span-3"><span className="text-gray-600">Bill-to Account:</span><div className="font-medium flex items-center gap-2"><Briefcase className="w-4 h-4" /> {order?.account?.name || '(selected)'}</div></div>}
          </div>
        </div>

        {/* NEW: Invoice Type Selector */}
        <div className="bg-blue-50 border border-blue-200 p-4 rounded-lg mb-6">
          <h3 className="font-medium text-blue-900 mb-3">Invoice Type</h3>
          <div className="space-y-3">
            <div className="flex gap-4">
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  value="patient"
                  checked={invoiceType === 'patient'}
                  onChange={(e) => setInvoiceType(e.target.value as 'patient')}
                  className="text-blue-600"
                />
                <span className="font-medium">Patient Invoice</span>
                <span className="text-sm text-gray-600">(Direct bill to patient)</span>
              </label>

              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  value="account"
                  checked={invoiceType === 'account'}
                  onChange={(e) => setInvoiceType(e.target.value as 'account')}
                  disabled={!order?.account_id}
                  className="text-blue-600"
                />
                <span className={`font-medium ${!order?.account_id ? 'text-gray-400' : ''}`}>
                  B2B Credit Invoice
                </span>
                <span className="text-sm text-gray-600">(Post to account ledger)</span>
              </label>
            </div>

            {invoiceType === 'account' && (
              <div className="mt-3 p-3 bg-white rounded border">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Billing Period
                </label>
                <input
                  type="month"
                  value={billingPeriod}
                  onChange={(e) => setBillingPeriod(e.target.value)}
                  className="w-40 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Credit invoices will be grouped by this period for monthly consolidation
                </p>
              </div>
            )}

            {!order?.account_id && invoiceType === 'account' && (
              <div className="text-sm text-amber-700 bg-amber-100 p-2 rounded">
                <Info className="w-4 h-4 inline mr-1" />
                Account invoice requires an account to be selected on the order
              </div>
            )}
          </div>
        </div>

        {/* Test Selection Table */}
        <div className="border rounded-lg mb-6">
          <div className="bg-gray-50 px-4 py-2 border-b">
            <div className="flex items-center justify-between">
              <h3 className="font-medium">Unbilled Tests</h3>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    // Select all billable items (not tests inside packages)
                    const billableIds = tests.filter(t => !t.isTestInPackage).map(t => t.id);
                    setSelectedTests(billableIds);
                  }}
                  className="text-sm text-blue-600 hover:text-blue-800"
                >
                  Select All
                </button>
                <span className="text-gray-300">|</span>
                <button
                  onClick={() => setSelectedTests([])}
                  className="text-sm text-blue-600 hover:text-blue-800"
                >
                  Clear All
                </button>
              </div>
            </div>
          </div>

          <div className="max-h-64 overflow-y-auto">
            {/* Charges added after an order was fully billed leave nothing here to pick. */}
            {tests.filter(t => !t.isTestInPackage).length === 0 && (
              <div className="p-4 text-sm text-gray-500 border-b">
                All tests on this order are already billed — this invoice will cover the pending billing items below.
              </div>
            )}
            {/* Only show billable items (packages and standalone tests) */}
            {tests.filter(t => !t.isTestInPackage).map((test) => {
              const isSelected = selectedTests.includes(test.id);
              const isPackage = test.isPackageEntry;

              // Get tests included in this package
              const includedTests = isPackage
                ? tests.filter(t => t.package_id === test.package_id && t.isTestInPackage)
                : [];
              const isExpanded = expandedPackages.has(test.id);
              const discount = discounts[test.id];
              const lineTotal = calcLineTotal(test);
              const discountAmount = calcDiscountAmount(toNum(test.price), discount);

              return (
                <div key={test.id} className="border-b">
                  <div className={`p-4 ${isSelected ? 'bg-blue-50' : 'bg-white'} hover:bg-gray-50`}>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setSelectedTests(prev => [...prev, test.id]);
                            } else {
                              setSelectedTests(prev => prev.filter(id => id !== test.id));
                            }
                          }}
                          className="rounded"
                        />
                        <div>
                          <div className="font-medium flex items-center gap-2">
                            {isPackage && (
                              <span className="px-1.5 py-0.5 bg-purple-100 text-purple-800 text-xs rounded">Package</span>
                            )}
                            {test.test_name.replace('📦 ', '')}
                          </div>
                          <div className="text-sm text-gray-500">Test ID: {test.id.slice(0, 8)}</div>
                        </div>
                      </div>

                      <div className="flex items-center gap-4">
                        {/* Show included tests toggle for packages */}
                        {isPackage && includedTests.length > 0 && (
                          <button
                            type="button"
                            onClick={() => {
                              setExpandedPackages(prev => {
                                const next = new Set(prev);
                                if (next.has(test.id)) {
                                  next.delete(test.id);
                                } else {
                                  next.add(test.id);
                                }
                                return next;
                              });
                            }}
                            className="flex items-center gap-1 text-sm text-purple-600 hover:text-purple-800"
                          >
                            {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                            {includedTests.length} tests included
                          </button>
                        )}

                        <div className="text-right">
                          <div className="font-bold text-lg">₹{money(lineTotal)}</div>
                          {discountAmount > 0 && discount && (
                            <div className="text-sm text-green-600">
                              -{discount.type === 'percent' ? `${discount.value}%` : `₹${discount.value}`} ({discount.source})
                            </div>
                          )}
                          {discount && <div className="text-sm text-gray-500">Original: ₹{money(test.price)}</div>}
                        </div>
                      </div>
                    </div>

                    {/* Expanded: Show included tests */}
                    {isPackage && isExpanded && includedTests.length > 0 && (
                      <div className="mt-3 ml-8 p-3 bg-purple-50 rounded-lg border border-purple-100">
                        <div className="text-xs font-medium text-purple-700 mb-2">Included in this package:</div>
                        <div className="space-y-1">
                          {includedTests.map((incTest) => (
                            <div key={incTest.id} className="flex items-center justify-between text-sm">
                              <span className="text-gray-700">• {incTest.test_name}</span>
                              <span className="text-purple-600 font-medium">Included</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Discount Controls */}
                    {isSelected && (
                      <div className="mt-3 pt-3 border-t bg-gray-50 rounded p-3">
                        <div className="grid grid-cols-4 gap-3 items-end">
                          <div>
                            <label className="block text-xs text-gray-600 mb-1">Discount Type</label>
                            <select
                              value={discount?.type || 'percent'}
                              onChange={(e) => {
                                const type = e.target.value as 'percent' | 'flat';
                                handleDiscountChange(test.id, type, discount?.value || 0, discount?.reason || '');
                              }}
                              className="w-full px-2 py-1 text-sm border rounded"
                            >
                              <option value="percent">Percentage</option>
                              <option value="flat">Fixed Amount</option>
                            </select>
                          </div>
                          <div>
                            <label className="block text-xs text-gray-600 mb-1">Value</label>
                            <input
                              type="number"
                              min="0"
                              max={discount?.type === 'percent' ? 100 : test.price}
                              step={discount?.type === 'percent' ? 1 : 0.01}
                              value={discount?.value ?? ''}
                              onChange={(e) => {
                                const value = parseFloat(e.target.value) || 0;
                                handleDiscountChange(test.id, discount?.type || 'percent', value, discount?.reason || '');
                              }}
                              className="w-full px-2 py-1 text-sm border rounded"
                            />
                          </div>
                          <div className="col-span-2">
                            <label className="block text-xs text-gray-600 mb-1">Reason</label>
                            <input
                              type="text"
                              value={discount?.reason || ''}
                              onChange={(e) => {
                                handleDiscountChange(test.id, discount?.type || 'percent', discount?.value || 0, e.target.value);
                              }}
                              className="w-full px-2 py-1 text-sm border rounded"
                              placeholder="Discount reason"
                            />
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Extra Charges (lab billing items) */}
        {orderBillingItems.length > 0 && (
          <div className="border rounded-lg mb-6">
            <div className="bg-amber-50 px-4 py-2 border-b border-amber-200">
              <h3 className="font-medium text-amber-800 flex items-center gap-2">
                Billing Items
                <span className="text-xs text-amber-600 font-normal">({orderBillingItems.length} pending)</span>
              </h3>
            </div>
            <div className="divide-y">
              {orderBillingItems.map(charge => {
                const isSelected = selectedChargeIds.includes(charge.id);
                const cd = chargeDiscounts[charge.id];
                const lineTotal = calcChargeLineTotal(charge);
                const chargeDiscountAmount = calcDiscountAmount(toNum(charge.amount), cd);
                return (
                  <div key={charge.id} className={`p-4 ${isSelected ? 'bg-amber-50/40' : 'bg-white'} hover:bg-gray-50`}>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={e => setSelectedChargeIds(prev =>
                            e.target.checked ? [...prev, charge.id] : prev.filter(id => id !== charge.id)
                          )}
                          className="rounded"
                        />
                        <div>
                          <div className="font-medium flex items-center gap-2">
                            {charge.name}
                            {charge.is_shareable_with_doctor && (
                              <span className="text-xs text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded">Doctor</span>
                            )}
                            {charge.is_shareable_with_phlebotomist && (
                              <span className="text-xs text-orange-600 bg-orange-50 px-1.5 py-0.5 rounded">Phlebotomist</span>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="font-bold text-lg">₹{money(lineTotal)}</div>
                        {chargeDiscountAmount > 0 && cd && <div className="text-sm text-green-600">
                          -{cd.type === 'percent' ? `${cd.value}%` : `₹${cd.value}`}
                        </div>}
                        {cd && <div className="text-sm text-gray-500">Original: ₹{money(charge.amount)}</div>}
                      </div>
                    </div>
                    {/* Discount Controls for charge */}
                    {isSelected && (
                      <div className="mt-3 pt-3 border-t bg-gray-50 rounded p-3">
                        <div className="grid grid-cols-4 gap-3 items-end">
                          <div>
                            <label className="block text-xs text-gray-600 mb-1">Discount Type</label>
                            <select
                              value={cd?.type || 'percent'}
                              onChange={e => handleChargeDiscountChange(charge.id, e.target.value as 'percent' | 'flat', cd?.value || 0, cd?.reason || '')}
                              className="w-full px-2 py-1 text-sm border rounded"
                            >
                              <option value="percent">Percentage</option>
                              <option value="flat">Fixed Amount</option>
                            </select>
                          </div>
                          <div>
                            <label className="block text-xs text-gray-600 mb-1">Value</label>
                            <input
                              type="number"
                              min="0"
                              value={cd?.value ?? ''}
                              onChange={e => handleChargeDiscountChange(charge.id, cd?.type || 'percent', parseFloat(e.target.value) || 0, cd?.reason || '')}
                              className="w-full px-2 py-1 text-sm border rounded"
                            />
                          </div>
                          <div className="col-span-2">
                            <label className="block text-xs text-gray-600 mb-1">Reason</label>
                            <input
                              type="text"
                              value={cd?.reason || ''}
                              onChange={e => handleChargeDiscountChange(charge.id, cd?.type || 'percent', cd?.value || 0, e.target.value)}
                              className="w-full px-2 py-1 text-sm border rounded"
                              placeholder="Discount reason"
                            />
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Totals */}
        <div className="border-t pt-4">
          <div className="space-y-2 max-w-md ml-auto">
            <div className="flex justify-between text-sm">
              <span>Tests Subtotal:</span>
              <span>₹{money(totals.testSubtotal)}</span>
            </div>
            {totals.chargesSubtotal > 0 && (
              <div className="flex justify-between text-sm text-amber-700">
                <span>Billing Items:</span>
                <span>+₹{money(totals.chargesSubtotal)}</span>
              </div>
            )}
            <div className="flex justify-between text-sm font-medium border-t pt-1">
              <span>Subtotal:</span>
              <span>₹{money(totals.subtotal)}</span>
            </div>
            <div className="flex justify-between text-sm text-green-600">
              <span>Total Discount:</span>
              <span>-₹{money(totals.totalDiscount)}</span>
            </div>
            <div className="flex justify-between text-lg font-bold">
              <span>Total Amount:</span>
              <span>₹{money(totals.total)}</span>
            </div>
          </div>
        </div>

        {/* Notes */}
        <div className="mt-6">
          <label className="block text-sm font-medium text-gray-700 mb-1">Notes (Optional)</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="Add any notes for this invoice..."
          />
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-3 mt-6 pt-4 border-t">
          <button
            onClick={onClose}
            className="px-4 py-2 text-gray-700 bg-gray-100 rounded-md hover:bg-gray-200"
            disabled={creating}
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
            disabled={creating || (selectedTests.length === 0 && selectedChargeIds.length === 0)}
          >
            {creating ? 'Creating...' : `Create ${invoiceType === 'account' ? 'B2B Credit' : 'Patient'} Invoice`}
          </button>
        </div>
      </div>
    </div>
  );
};

export default CreateInvoiceModal;
