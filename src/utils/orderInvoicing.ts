import { database, supabase } from './supabase';

/**
 * Shared order → invoice logic.
 *
 * Both the interactive CreateInvoiceModal and the bulk "Unbilled Orders" screen
 * run through this module so pricing, default discounts, extra charges,
 * location receivables and credit posting stay identical everywhere.
 */

export type DiscountSource = 'manual' | 'doctor' | 'location' | 'account' | 'account_fixed';

export interface DiscountInfo {
  type: 'percent' | 'flat';
  value: number;
  reason: string;
  source: DiscountSource;
}

export interface ChargeDiscountInfo {
  type: 'percent' | 'flat';
  value: number;
  reason: string;
}

export interface OrderTest {
  id: string;
  test_group_id: string;
  test_name: string;
  price: number;
  is_billed: boolean;
  invoice_id?: string;
  package_id?: string; // If this test is part of a package
  isPackageEntry?: boolean; // True if this is a package line item (📦)
  isTestInPackage?: boolean; // True if this is an individual test inside a package
  outsourced_lab_id?: string | null; // If test is outsourced
}

export interface OrderBillingItem {
  id: string;
  name: string;
  amount: number;
  is_shareable_with_doctor: boolean;
  is_shareable_with_phlebotomist: boolean;
  is_invoiced: boolean;
  lab_billing_item_type_id: string | null;
  _is_collection_charge?: boolean;
}

export interface OrderInvoiceDraft {
  order: any;
  tests: OrderTest[];
  billingItems: OrderBillingItem[];
  discounts: Record<string, DiscountInfo>;
}

export interface CreateInvoiceOptions {
  selectedTestIds: string[];
  selectedChargeIds: string[];
  discounts: Record<string, DiscountInfo>;
  chargeDiscounts?: Record<string, ChargeDiscountInfo>;
  invoiceType: 'patient' | 'account';
  billingPeriod?: string | null;
  notes?: string;
}

// Helpers: numeric coercion and currency formatting (null-safe)
export const toNum = (v: any, fallback = 0): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export const money = (v: any): string => toNum(v).toFixed(2);

export const calcDiscountAmount = (
  baseAmount: number,
  discount?: Pick<DiscountInfo, 'type' | 'value'> | null
) => {
  if (!discount) return 0;
  const base = Math.max(0, toNum(baseAmount));
  const rawValue = Math.max(0, toNum(discount.value));
  const amount = discount.type === 'percent'
    ? base * Math.min(rawValue, 100) / 100
    : Math.min(rawValue, base);
  return Math.max(0, amount);
};

/**
 * Billable rows = packages and standalone tests. Tests *inside* a package are
 * priced at 0 and shown nested under their parent, never billed on their own.
 */
export const getBillableTests = (tests: OrderTest[]) => tests.filter(t => !t.isTestInPackage);

export const calcInvoiceTotals = (
  draft: OrderInvoiceDraft,
  options: Pick<CreateInvoiceOptions, 'selectedTestIds' | 'selectedChargeIds' | 'discounts' | 'chargeDiscounts'>
) => {
  const rows = draft.tests.filter(t => options.selectedTestIds.includes(t.id));
  const testSubtotal = rows.reduce((s, t) => s + toNum(t.price), 0);
  let totalDiscount = 0;
  rows.forEach(t => {
    const d = options.discounts[t.id];
    if (!d) return;
    totalDiscount += calcDiscountAmount(toNum(t.price), d);
  });

  // Extra charges
  const selectedCharges = draft.billingItems.filter(c => options.selectedChargeIds.includes(c.id));
  const chargesSubtotal = selectedCharges.reduce((s, c) => s + toNum(c.amount), 0);
  selectedCharges.forEach(c => {
    const d = options.chargeDiscounts?.[c.id];
    if (!d) return;
    totalDiscount += calcDiscountAmount(toNum(c.amount), d);
  });

  const subtotal = testSubtotal + chargesSubtotal;
  const total = Math.max(0, subtotal - totalDiscount);
  return { subtotal, testSubtotal, chargesSubtotal, totalDiscount, total };
};

/**
 * Default discounts, best per test: account fixed price > account % > location % > doctor %.
 * A manual discount applied in the UI always overrides these.
 */
const buildDefaultDiscounts = async (ord: any, tList: OrderTest[]) => {
  const newDiscounts: Record<string, DiscountInfo> = {};

  // Doctor %
  let doctorPct: number | undefined;
  if (ord.referring_doctor_id) {
    const { data: doctor } = await (database as any).doctors?.getById?.(ord.referring_doctor_id) || { data: null };
    if (doctor?.default_discount_percent) doctorPct = doctor.default_discount_percent;
  }

  // Location %
  let locationPct: number | undefined;
  if (ord.location_id) {
    const { data: location } = await (database as any).locations?.getById?.(ord.location_id) || { data: null };
    if (location?.default_discount_percent) locationPct = location.default_discount_percent;
  }

  // Account %
  let accountPct: number | undefined;
  if (ord.account_id) {
    const { data: account } = await (database as any).accounts?.getById?.(ord.account_id) || { data: null };
    if (account?.default_discount_percent) accountPct = account.default_discount_percent;
  }

  // Account Fixed Prices (B2B)
  const accountPricesMap = new Map<string, number>();
  if (ord.account_id) {
    const { data: account } = await supabase
      .from('accounts')
      .select('price_master_id')
      .eq('id', ord.account_id)
      .maybeSingle();

    if (account?.price_master_id) {
      const { data: planPrices } = await supabase
        .from('price_master_items')
        .select('test_group_id, price')
        .eq('price_master_id', account.price_master_id);

      if (planPrices) {
        planPrices.forEach((ap: any) => accountPricesMap.set(ap.test_group_id, parseFloat(ap.price)));
      }
    }

    const { data: prices } = await supabase
      .from('account_prices')
      .select('test_group_id, price')
      .eq('account_id', ord.account_id);

    if (prices) {
      prices.forEach((ap: any) => accountPricesMap.set(ap.test_group_id, parseFloat(ap.price)));
    }
  }

  tList.forEach(test => {
    // Check for fixed price override first
    if (test.test_group_id && accountPricesMap.has(test.test_group_id)) {
      const fixedPrice = accountPricesMap.get(test.test_group_id)!;
      const originalPrice = toNum(test.price);
      const discountAmount = Math.max(0, originalPrice - fixedPrice);

      if (discountAmount > 0) {
        newDiscounts[test.id] = {
          type: 'flat',
          value: discountAmount,
          reason: `Account Fixed Price (₹${fixedPrice})`,
          source: 'account_fixed'
        };
        return; // Stop processing other discounts
      }
    }

    if (accountPct) {
      newDiscounts[test.id] = { type: 'percent', value: accountPct!, reason: 'Account default discount', source: 'account' };
    } else if (locationPct) {
      newDiscounts[test.id] = { type: 'percent', value: locationPct!, reason: 'Location default discount', source: 'location' };
    } else if (doctorPct) {
      newDiscounts[test.id] = { type: 'percent', value: doctorPct!, reason: 'Doctor default discount', source: 'doctor' };
    }
  });

  return newDiscounts;
};

/**
 * Loads everything needed to bill an order: the order, its unbilled tests with
 * location-adjusted prices, the default discounts, and any uninvoiced extra charges.
 */
export const loadOrderInvoiceDraft = async (orderId: string): Promise<OrderInvoiceDraft> => {
  const { data: orderData, error: orderError } = await database.orders.getById(orderId);
  if (orderError) throw orderError;

  // Unbilled tests
  const { data: orderTests, error: testsError } = await supabase
    .from('order_tests')
    .select('id, test_group_id, test_name, price, is_billed, invoice_id, package_id, outsourced_lab_id')
    .eq('order_id', orderId)
    .eq('is_billed', false);

  if (testsError) throw testsError;

  // Fetch location-specific prices if order has a location
  const locationPricesMap: Record<string, number> = {};
  if (orderData?.location_id) {
    const testGroupIds = (orderTests || [])
      .filter((t: any) => t.test_group_id)
      .map((t: any) => t.test_group_id);

    if (testGroupIds.length > 0) {
      const { data: locPrices } = await supabase
        .from('location_test_prices')
        .select('test_group_id, patient_price')
        .eq('location_id', orderData.location_id)
        .eq('is_active', true)
        .in('test_group_id', testGroupIds);

      if (locPrices) {
        locPrices.forEach((lp: any) => {
          if (lp.patient_price !== null && lp.patient_price !== undefined) {
            locationPricesMap[lp.test_group_id] = Number(lp.patient_price);
          }
        });
      }
    }
  }

  // Normalize tests and handle package pricing.
  // Tests that belong to a package (have package_id) but are NOT the package entry
  // (have test_group_id) get price = 0 since they're included in the package price.
  const normalizedTests: OrderTest[] = (orderTests || []).map((t: any) => {
    const isPackageEntry = t.test_name?.startsWith('📦') || (t.package_id && !t.test_group_id);
    const isTestInPackage = t.package_id && t.test_group_id;

    // Use location price if available, otherwise use stored price
    let effectivePrice = toNum(t.price);
    if (t.test_group_id && locationPricesMap[t.test_group_id] !== undefined) {
      effectivePrice = locationPricesMap[t.test_group_id];
    }

    return {
      ...t,
      price: isTestInPackage ? 0 : effectivePrice,
      isPackageEntry,
      isTestInPackage,
    };
  });

  const discounts = await buildDefaultDiscounts(orderData, normalizedTests);

  // Load uninvoiced extra charges for this order
  const { data: charges } = await supabase
    .from('order_billing_items')
    .select('id, name, amount, is_shareable_with_doctor, is_shareable_with_phlebotomist, is_invoiced, lab_billing_item_type_id')
    .eq('order_id', orderId)
    .eq('is_invoiced', false)
    .order('created_at');
  const chargeList: OrderBillingItem[] = charges || [];

  // Inject only the collection charge that has not already been invoiced.
  // This matters when a later-added test increases orders.collection_charge.
  const collectionCharge = parseFloat(orderData?.collection_charge || 0);
  if (collectionCharge > 0) {
    const { data: existingCollectionItems } = await supabase
      .from('invoice_items')
      .select('price, quantity')
      .eq('order_id', orderId)
      .eq('test_name', 'Sample Collection Charge');
    const invoicedCollectionCharge = (existingCollectionItems || []).reduce(
      (sum: number, existing: any) =>
        sum + (toNum(existing.price) * Math.max(1, toNum(existing.quantity))),
      0
    );
    const outstandingCollectionCharge = Math.max(0, collectionCharge - invoicedCollectionCharge);

    if (outstandingCollectionCharge > 0) {
      chargeList.unshift({
        id: `collection-charge-${orderId}`,
        name: 'Sample Collection Charge',
        amount: outstandingCollectionCharge,
        is_shareable_with_doctor: false,
        is_shareable_with_phlebotomist: false,
        is_invoiced: false,
        lab_billing_item_type_id: null,
        _is_collection_charge: true,
      });
    }
  }

  return { order: orderData, tests: normalizedTests, billingItems: chargeList, discounts };
};

/**
 * Creates the invoice, its items, marks the order tests / charges as billed and
 * posts a credit transaction for credit-style payment types.
 */
export const createInvoiceFromDraft = async (
  draft: OrderInvoiceDraft,
  options: CreateInvoiceOptions
) => {
  const { order, tests, billingItems } = draft;
  const orderId = order.id;
  const chargeDiscounts = options.chargeDiscounts || {};

  const totals = calcInvoiceTotals(draft, options);
  const rows = tests.filter(t => options.selectedTestIds.includes(t.id));
  const lab_id = await database.getCurrentUserLabId();

  // Compare against billable rows only — tests nested inside a package are priced
  // at 0 and never billed on their own, so counting them marks every package
  // order partial.
  const billableTests = getBillableTests(tests);

  const invoiceData = {
    lab_id,
    patient_id: order.patient_id,
    order_id: orderId,
    patient_name: order.patient_name,
    subtotal: totals.subtotal,
    total_before_discount: totals.subtotal,
    total_discount: totals.totalDiscount,
    total_after_discount: totals.total,
    discount: totals.totalDiscount,
    tax: 0,
    total: totals.total,
    status: options.invoiceType === 'account' ? 'Sent' : 'Unpaid', // Account invoices auto-sent for credit
    invoice_date: new Date().toISOString(),
    due_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    payment_type: order.payment_type || 'self',
    location_id: order.location_id || null,
    referring_doctor_id: order.referring_doctor_id || null,
    account_id: order.account_id || null,

    // Dual invoice system fields
    invoice_type: options.invoiceType,
    billing_period: options.invoiceType === 'account' ? options.billingPeriod : null,
    consolidated_invoice_id: null, // Will be set later during monthly consolidation

    notes: options.notes || '',
    is_partial: rows.length < billableTests.length,
  };

  const { data: invoice, error: invoiceError } = await database.invoices.create(invoiceData);
  if (invoiceError) throw invoiceError;

  // Items + mark billed. First fetch location details if we have a location.
  let locationDetails: { collection_percentage?: number; receivable_type?: string } | null = null;
  if (order.location_id) {
    const { data: loc } = await (database as any).locations?.getById?.(order.location_id) || { data: null };
    if (loc) {
      locationDetails = {
        collection_percentage: loc.collection_percentage,
        receivable_type: loc.receivable_type
      };
    }
  }

  for (const test of rows) {
    const d = options.discounts[test.id];
    const discountAmount = calcDiscountAmount(toNum(test.price), d);
    const lineTotal = Math.max(0, toNum(test.price) - discountAmount);

    // Get outsourced cost if applicable
    let outsourcedCost: number | null = null;
    if (test.outsourced_lab_id) {
      const { data: costData } = await database.outsourcedLabPrices.getCost(test.outsourced_lab_id, test.test_group_id);
      outsourcedCost = costData?.cost || null;
    }

    // Calculate location_receivable if location is set
    let locationReceivable: number | null = null;
    if (order.location_id && locationDetails) {
      // Check for test-specific lab_receivable in location_test_prices
      const { data: locPrice } = await supabase
        .from('location_test_prices')
        .select('lab_receivable')
        .eq('location_id', order.location_id)
        .eq('test_group_id', test.test_group_id)
        .eq('is_active', true)
        .maybeSingle();

      if (locPrice?.lab_receivable !== null && locPrice?.lab_receivable !== undefined) {
        // Use explicitly set test-wise price
        locationReceivable = locPrice.lab_receivable;
      } else if (locationDetails.receivable_type === 'own_center') {
        // Own center: lab gets 100%
        locationReceivable = toNum(test.price);
      } else if (locationDetails.collection_percentage) {
        // Calculate from percentage
        locationReceivable = toNum(test.price) * (locationDetails.collection_percentage / 100);
      }
    }

    await supabase.from('invoice_items').insert({
      lab_id,
      invoice_id: invoice.id,
      order_test_id: test.id,
      test_name: test.test_name,
      price: toNum(test.price),
      quantity: 1,
      total: lineTotal,
      discount_type: discountAmount > 0 ? d?.type || null : null,
      discount_value: discountAmount > 0 ? d?.value || null : null,
      discount_amount: discountAmount,
      discount_reason: discountAmount > 0 ? d?.reason || null : null,
      outsourced_lab_id: test.outsourced_lab_id || null,
      outsourced_cost: outsourcedCost,
      location_receivable: locationReceivable,
      order_id: orderId,
    });

    await supabase
      .from('order_tests')
      .update({
        is_billed: true,
        invoice_id: invoice.id,
        billed_at: new Date().toISOString(),
        billed_amount: lineTotal,
      })
      .eq('id', test.id);
  }

  // Extra charges → insert as lab_charge invoice_items and mark invoiced
  const selectedCharges = billingItems.filter(c => options.selectedChargeIds.includes(c.id));
  for (const charge of selectedCharges) {
    const isCollectionCharge = charge._is_collection_charge === true;
    const d = chargeDiscounts[charge.id];
    const discountAmount = calcDiscountAmount(toNum(charge.amount), d);
    const lineTotal = Math.max(0, toNum(charge.amount) - discountAmount);
    const { data: chargeItem } = await supabase.from('invoice_items').insert({
      lab_id,
      invoice_id: invoice.id,
      order_billing_item_id: isCollectionCharge ? null : charge.id,
      test_name: charge.name,
      price: toNum(charge.amount),
      quantity: 1,
      total: lineTotal,
      item_type: 'lab_charge',
      discount_type: discountAmount > 0 ? d?.type || null : null,
      discount_value: discountAmount > 0 ? d?.value || null : null,
      discount_amount: discountAmount,
      discount_reason: discountAmount > 0 ? d?.reason || null : null,
      is_shareable_with_doctor: charge.is_shareable_with_doctor,
      is_shareable_with_phlebotomist: charge.is_shareable_with_phlebotomist,
      order_id: orderId,
    }).select('id').single();

    // Only update order_billing_items for real (non-synthetic) charges
    if (chargeItem?.id && !isCollectionCharge) {
      await supabase.from('order_billing_items')
        .update({ is_invoiced: true, invoice_item_id: chargeItem.id, updated_at: new Date().toISOString() })
        .eq('id', charge.id);
    }
  }

  // Order billing flags. Charges left off this invoice keep the order open too —
  // a 'billed' order hides every "Create Invoice" entry point, so an uninvoiced charge
  // would be stranded with no way to ever reach an invoice.
  const remainingUnbilled = billableTests.length - rows.length;
  const remainingCharges = billingItems.filter(
    c => !c._is_collection_charge && !options.selectedChargeIds.includes(c.id)
  ).length;
  const billingStatus = remainingUnbilled === 0 && remainingCharges === 0 ? 'billed' : 'partial';
  await database.orders.update(orderId, { billing_status: billingStatus, is_billed: billingStatus === 'billed' });

  // Credit posting:
  // If the order is credit/corporate/insurance, post a credit transaction.
  // Prefer Account if present; else Location.
  if (['credit', 'corporate', 'insurance'].includes(order.payment_type)) {
    const creditPayload: any = {
      lab_id,
      patient_id: order.patient_id,
      invoice_id: invoice.id,
      amount: totals.total,
      transaction_type: 'credit',
      notes: `Invoice ${invoice.id} for Order ${orderId}`,
    };
    if (order.account_id) creditPayload.account_id = order.account_id;
    else if (order.location_id) creditPayload.location_id = order.location_id;

    await (database as any).creditTransactions?.create?.(creditPayload);
  }

  return invoice;
};

/**
 * Re-derives orders.billing_status from what is genuinely left to bill: unbilled
 * billable tests plus uninvoiced extra charges.
 *
 * Needed because an extra charge can be added *after* the order was fully invoiced.
 * Without this the order stays 'billed', which hides the "Create Invoice" button and
 * drops it from the Unbilled Orders screen, so the charge shows up in the due amount
 * but can never be put on an invoice.
 *
 * Orders that have never been invoiced (null / 'pending') are left alone so they are
 * not mislabelled as "Partially Billed". Returns the effective status; writes only
 * when it actually changed.
 */
export const syncOrderBillingStatus = async (orderId: string): Promise<string | null> => {
  const { data: orderRow } = await supabase
    .from('orders')
    .select('billing_status')
    .eq('id', orderId)
    .single();

  const current = (orderRow as any)?.billing_status ?? null;
  if (current !== 'billed' && current !== 'partial') return current;

  const [{ data: pendingTests }, { data: pendingCharges }] = await Promise.all([
    supabase
      .from('order_tests')
      .select('id, package_id, test_group_id')
      .eq('order_id', orderId)
      .eq('is_billed', false),
    supabase
      .from('order_billing_items')
      .select('id')
      .eq('order_id', orderId)
      .eq('is_invoiced', false),
  ]);

  // Tests nested inside a package are priced at 0 and never billed on their own.
  const billableRemaining = (pendingTests || []).filter(
    (t: any) => !(t.package_id && t.test_group_id)
  ).length;
  const hasPending = billableRemaining > 0 || (pendingCharges || []).length > 0;
  const next = hasPending ? 'partial' : 'billed';
  if (next === current) return current;

  await supabase
    .from('orders')
    .update({ billing_status: next, is_billed: !hasPending })
    .eq('id', orderId);

  return next;
};

/**
 * One-shot billing for a single order using every unbilled billable test and
 * every pending charge, with the system default discounts. Used by bulk billing.
 */
export const createInvoiceForOrder = async (
  orderId: string,
  overrides?: { notes?: string; billingPeriod?: string }
) => {
  const draft = await loadOrderInvoiceDraft(orderId);
  const billableTests = getBillableTests(draft.tests);

  if (billableTests.length === 0 && draft.billingItems.length === 0) {
    throw new Error('Nothing left to bill on this order');
  }

  const isAccountOrder = !!draft.order?.account_id;
  const now = new Date();
  const defaultPeriod = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  return createInvoiceFromDraft(draft, {
    selectedTestIds: billableTests.map(t => t.id),
    selectedChargeIds: draft.billingItems.map(c => c.id),
    discounts: draft.discounts,
    invoiceType: isAccountOrder ? 'account' : 'patient',
    billingPeriod: isAccountOrder ? (overrides?.billingPeriod || defaultPeriod) : null,
    notes: overrides?.notes || '',
  });
};
