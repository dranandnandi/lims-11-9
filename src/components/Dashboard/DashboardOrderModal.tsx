import React, { useState, useEffect, useRef } from "react";
import ReactDOM from "react-dom";
import {
  X,
  User,
  Calendar,
  Clock,
  FileText,
  CreditCard,
  DollarSign,
  Printer,
  QrCode,
  CheckCircle,
  Phone,
  Mail,
  TestTube,
  Download,
  Building,
  Sparkles,
  Upload,
  Loader,
  Edit2,
  Save,
  Truck,
  Send,
  MapPin,
  File,
  Plus,
  Trash2,
  Search,
  Ban,
  RotateCcw,
  Lock,
  Tag,
  Camera,
} from "lucide-react";
import QRCodeLib from "qrcode";
import { database, supabase, formatAge } from "../../utils/supabase";
import { SampleTypeIndicator } from "../Common/SampleTypeIndicator";
import { generateAndDownloadReport, getLabTemplate, type ReportData } from "../../utils/pdfGenerator";
import { generateInvoicePDF } from "../../utils/invoicePdfService";
import { useAuth } from "../../contexts/AuthContext";
import { useOrderStatusCentral } from "../../hooks/useOrderStatusCentral";
import QuickStatusButtons from "../Orders/QuickStatusButtons";
import { OrderStatusDisplay } from "../Orders/OrderStatusDisplay";
import CreateInvoiceModal from "../Billing/CreateInvoiceModal";
import PaymentCapture from "../Billing/PaymentCapture";
import InvoiceDeliveryTracker from "../Billing/InvoiceDeliveryTracker";
import InvoiceGenerationModal from "../Billing/InvoiceGenerationModal";
import SampleCollectionTracker from "../Samples/SampleCollectionTracker";
import ReportDesignStudio from "../ReportStudio/ReportDesignStudio";
import { ThermalPrintButton } from "../Invoices/ThermalPrintButton";
import { SendReportModal } from "./SendReportModal";
import {
  processTRFImage,
  trfToOrderFormData,
  validatePatientData,
  autoCreatePatientFromTRF,
  findDoctorByName,
  type TRFExtractionResult,
  type TRFProcessingProgress
} from '../../utils/trfProcessor';

// Define the order shape expected by this modal (matching Dashboard's CardOrder)
export interface DashboardOrder {
  id: string;
  patient_name: string;
  patient_id: string;
  patient_phone?: string | null;
  status: string;
  priority: string;
  order_date: string;
  expected_date: string;
  total_amount: number;
  doctor: string | null;
  doctor_phone?: string | null;
  doctor_email?: string | null;

  sample_id: string | null;
  color_code: string | null;
  color_name: string | null;
  sample_collected_at: string | null;
  sample_collected_by: string | null;
  qr_code_data?: string;

  // Billing fields
  billing_status?: 'pending' | 'partial' | 'billed' | null;
  is_billed?: boolean | null;
  invoice_id?: string | null;
  paid_amount?: number;
  due_amount?: number;
  payment_status?: 'unpaid' | 'partial' | 'paid' | null;
  discount_amount?: number;
  discount_source?: 'manual' | 'doctor' | 'location' | 'account' | null;

  patient?: { name?: string | null; age?: string | null; gender?: string | null; phone?: string | null; mobile?: string | null; email?: string | null } | null;
  tests: {
    id: string;
    test_name: string;
    outsourced_lab_id?: string | null;
    outsourced_labs?: { name?: string | null } | null;
    is_canceled?: boolean;
    is_billed?: boolean;
    invoice_id?: string | null;
  }[];

  // Report info
  report_url?: string | null;

  // Location and transit fields
  location_id?: string | null;
  location?: string | null;
  transit_status?: string | null;
  collected_at_location_id?: string | null;

  // B2B Account fields
  account_name?: string | null;
  account_billing_mode?: 'standard' | 'monthly' | null;

  panels?: {
    name: string;
    expected: number;
    entered: number;
    verified: boolean;
    status: any;
    sample_type?: string;
    sample_color?: string;
  }[];

  // B2B Account
  // account_name is already defined above
}

interface DashboardOrderModalProps {
  order: DashboardOrder;
  onClose: () => void;
  onUpdateStatus: (orderId: string, newStatus: string) => Promise<void>;
}

const DashboardOrderModal: React.FC<DashboardOrderModalProps> = ({
  order,
  onClose,
  onUpdateStatus,
}) => {
  const { user } = useAuth();
  const [qrCodeUrl, setQrCodeUrl] = useState<string | null>(null);
  const [labId, setLabId] = useState<string | null>(null);

  // Billing Modals
  const [showInvoiceModal, setShowInvoiceModal] = useState(false);
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [showPdfModal, setShowPdfModal] = useState(false);
  const [invoiceRefreshTrigger, setInvoiceRefreshTrigger] = useState(0);

  // Outsource Modal
  const [showOutsourceModal, setShowOutsourceModal] = useState(false);
  const [outsourcedLabs, setOutsourcedLabs] = useState<any[]>([]);
  const [selectedOutsourceLab, setSelectedOutsourceLab] = useState<string>("");

  // Sample Collection
  const { markSampleCollected: markCollectedCentral } = useOrderStatusCentral();
  const [updatingCollection, setUpdatingCollection] = useState(false);
  const [showPhlebotomistSelector, setShowPhlebotomistSelector] = useState(false);
  const [selectedPhlebotomistId, setSelectedPhlebotomistId] = useState<string>('');
  const [selectedPhlebotomistName, setSelectedPhlebotomistName] = useState<string>('');
  const [doctors, setDoctors] = useState<any[]>([]);

  // TRF Processing
  const [processingTRF, setProcessingTRF] = useState<boolean>(false);
  const [trfProgress, setTrfProgress] = useState<TRFProcessingProgress | null>(null);
  const [trfExtraction, setTrfExtraction] = useState<TRFExtractionResult | null>(null);
  const [showTRFReview, setShowTRFReview] = useState<boolean>(false);
  const [testRequestFile, setTestRequestFile] = useState<File | null>(null);
  const [enableTRFOptimization, setEnableTRFOptimization] = useState<boolean>(true);

  // Editing
  const [isEditingPatient, setIsEditingPatient] = useState(false);
  const [isEditingDoctor, setIsEditingDoctor] = useState(false);
  const [isEditingAccount, setIsEditingAccount] = useState(false);
  const [editPatientName, setEditPatientName] = useState(order.patient_name);
  const [editPatientPhone, setEditPatientPhone] = useState(order.patient_phone || '');
  const [accounts, setAccounts] = useState<any[]>([]);
  const [editAccountId, setEditAccountId] = useState<string>('');
  const [editDoctorId, setEditDoctorId] = useState<string>('');
  const [tests, setTests] = useState(order.tests);
  const [viewInvoiceLoading, setViewInvoiceLoading] = useState(false);
  const [showDiscountEdit, setShowDiscountEdit] = useState(false);
  const [discountInput, setDiscountInput] = useState('');
  const [discountReason, setDiscountReason] = useState('');
  const [savingDiscount, setSavingDiscount] = useState(false);

  // Transit/Dispatch
  const [showDispatchModal, setShowDispatchModal] = useState(false);
  const [dispatchLocations, setDispatchLocations] = useState<{ id: string; name: string; type: string; is_processing_center: boolean }[]>([]);
  const [dispatchDestination, setDispatchDestination] = useState<string>('');
  const [dispatchNotes, setDispatchNotes] = useState('');
  const [dispatchPriority, setDispatchPriority] = useState<'normal' | 'urgent' | 'high' | 'low'>('normal');
  const [dispatching, setDispatching] = useState(false);

  // Add/Remove Tests Logic
  const [currentTotal, setCurrentTotal] = useState(order.total_amount);
  const [currentDue, setCurrentDue] = useState(order.due_amount || 0);
  const [showAddTestModal, setShowAddTestModal] = useState(false);
  const [availableTests, setAvailableTests] = useState<any[]>([]);
  const [testSearch, setTestSearch] = useState('');
  const [isAddingTest, setIsAddingTest] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Report Actions
  const [showReportStudio, setShowReportStudio] = useState(false);
  const [showSendReport, setShowSendReport] = useState(false);
  const [lastGeneratedPdf, setLastGeneratedPdf] = useState<string | null>(order.report_url || null);

  // Extra Charges (Lab Billing Items)
  const [orderBillingItems, setOrderBillingItems] = useState<Array<{
    id: string;
    name: string;
    amount: number;
    notes: string | null;
    is_shareable_with_doctor: boolean;
    is_shareable_with_phlebotomist: boolean;
    is_invoiced: boolean;
    lab_billing_item_type_id: string | null;
  }>>([]);
  const [billingItemTypes, setBillingItemTypes] = useState<Array<{ id: string; name: string; default_amount: number; is_shareable_with_doctor: boolean; is_shareable_with_phlebotomist: boolean }>>([]);
  const [showAddChargeDropdown, setShowAddChargeDropdown] = useState(false);
  const [addingCharge, setAddingCharge] = useState(false);
  const [customChargeName, setCustomChargeName] = useState('');
  const [customChargeAmount, setCustomChargeAmount] = useState('');
  const [selectedChargeTypeId, setSelectedChargeTypeId] = useState<string>('');

  // Collection Charge
  const [collectionCharge, setCollectionCharge] = useState<number>(0);
  const [editingCollectionCharge, setEditingCollectionCharge] = useState(false);
  const [collectionChargeInput, setCollectionChargeInput] = useState('');
  const [savingCollectionCharge, setSavingCollectionCharge] = useState(false);

  // Discount State
  const [invoiceDiscount, setInvoiceDiscount] = useState<{
    total_discount: number;
    subtotal: number;
    total_after_discount: number;
    items: Array<{
      test_name: string;
      price: number;
      discount_type: string | null;
      discount_value: number | null;
      discount_amount: number;
      discount_reason: string | null;
      total: number;
    }>;
  } | null>(null);

  // Fetch invoice discount info when order has invoice
  useEffect(() => {
    const fetchInvoiceDiscount = async () => {
      if (!order.invoice_id) {
        setInvoiceDiscount(null);
        return;
      }

      try {
        // Fetch invoice totals
        const { data: invoice } = await supabase
          .from('invoices')
          .select('subtotal, total_discount, total_after_discount')
          .eq('id', order.invoice_id)
          .single();

        // Fetch invoice items with discount details
        const { data: items } = await supabase
          .from('invoice_items')
          .select('test_name, price, discount_type, discount_value, discount_amount, discount_reason, total')
          .eq('invoice_id', order.invoice_id);

        if (invoice) {
          setInvoiceDiscount({
            total_discount: invoice.total_discount || 0,
            subtotal: invoice.subtotal || 0,
            total_after_discount: invoice.total_after_discount || 0,
            items: (items || []).map((item: any) => ({
              test_name: item.test_name,
              price: item.price || 0,
              discount_type: item.discount_type,
              discount_value: item.discount_value,
              discount_amount: item.discount_amount || 0,
              discount_reason: item.discount_reason,
              total: item.total || 0
            }))
          });
        }
      } catch (err) {
        console.error('Error fetching invoice discount:', err);
      }
    };

    fetchInvoiceDiscount();
  }, [order.invoice_id, invoiceRefreshTrigger]);

  // Keep due based on the live order total so newly added, uninvoiced tests are included.
  useEffect(() => {
    if (invoiceDiscount && invoiceDiscount.total_discount > 0) {
      setCurrentDue(Math.max(0, currentTotal - invoiceDiscount.total_discount - (order.paid_amount || 0)));
    }
  }, [invoiceDiscount, currentTotal, order.paid_amount]);

  const billingItemsTotal = orderBillingItems.reduce((sum, item) => sum + (item.amount || 0), 0);
  const testsSubtotalDisplay = Math.max(0, currentTotal - billingItemsTotal - collectionCharge);

  // Load order billing items (extra charges) and item type catalog.
  // order.total_amount = tests + collection ONLY (charges are always separate in order_billing_items).
  // currentTotal = order.total_amount + sum(all billing items).
  // currentDue   = currentTotal - paid_amount (when no invoice), or invoice-based due otherwise.
  useEffect(() => {
    if (!labId) return;
    const load = async () => {
      const [{ data: items }, { data: types }, { data: orderData }] = await Promise.all([
        supabase
          .from('order_billing_items')
          .select('id, name, amount, notes, is_shareable_with_doctor, is_shareable_with_phlebotomist, is_invoiced, lab_billing_item_type_id')
          .eq('order_id', order.id)
          .order('created_at'),
        supabase
          .from('lab_billing_item_types')
          .select('id, name, default_amount, is_shareable_with_doctor, is_shareable_with_phlebotomist')
          .eq('lab_id', labId)
          .eq('is_active', true)
          .order('name'),
        supabase
          .from('orders')
          .select('collection_charge')
          .eq('id', order.id)
          .single(),
      ]);
      const chargesList = items || [];
      const cc = (orderData as any)?.collection_charge || 0;
      setOrderBillingItems(chargesList);
      setBillingItemTypes(types || []);
      setCollectionCharge(cc);

      // Recalculate totals: order.total_amount includes collection_charge; extra billing items are additive
      const chargesTotal = chargesList.reduce((s: number, i: any) => s + (i.amount || 0), 0);
      setCurrentTotal((order.total_amount || 0) + chargesTotal);
      setCurrentDue(Math.max(0, (order.total_amount || 0) + chargesTotal - (order.paid_amount || 0)));
    };
    load();
  }, [labId, order.id, invoiceRefreshTrigger]);

  // Helper: recompute and persist totals after charges change
  const recomputeTotalsFromItems = (items: typeof orderBillingItems) => {
    const chargesTotal = items.reduce((s, i) => s + (i.amount || 0), 0);
    const newTotal = (order.total_amount || 0) + chargesTotal;
    const newDue = Math.max(0, newTotal - (order.paid_amount || 0));
    setCurrentTotal(newTotal);
    setCurrentDue(newDue);
  };

  const handleSelectChargeType = (typeId: string) => {
    const t = billingItemTypes.find(x => x.id === typeId);
    if (!t) return;
    setSelectedChargeTypeId(typeId);
    setCustomChargeName(t.name);
    setCustomChargeAmount(String(t.default_amount));
  };

  const handleAddCharge = async () => {
    if (!labId || !customChargeName.trim() || !customChargeAmount) return;
    setAddingCharge(true);
    const chosenType = billingItemTypes.find(x => x.id === selectedChargeTypeId);
    await supabase.from('order_billing_items').insert({
      lab_id: labId,
      order_id: order.id,
      lab_billing_item_type_id: selectedChargeTypeId || null,
      name: customChargeName.trim(),
      amount: Number(customChargeAmount) || 0,
      is_shareable_with_doctor: chosenType?.is_shareable_with_doctor ?? false,
      is_shareable_with_phlebotomist: chosenType?.is_shareable_with_phlebotomist ?? false,
      is_invoiced: false,
    });
    // Reload from DB to get accurate list (including existing items)
    const { data: items } = await supabase
      .from('order_billing_items')
      .select('id, name, amount, notes, is_shareable_with_doctor, is_shareable_with_phlebotomist, is_invoiced, lab_billing_item_type_id')
      .eq('order_id', order.id)
      .order('created_at');
    const chargesList = items || [];
    setOrderBillingItems(chargesList);
    recomputeTotalsFromItems(chargesList);
    setCustomChargeName('');
    setCustomChargeAmount('');
    setSelectedChargeTypeId('');
    setShowAddChargeDropdown(false);
    setAddingCharge(false);
  };

  const handleRemoveCharge = async (chargeId: string) => {
    await supabase.from('order_billing_items').delete().eq('id', chargeId);
    const remaining = orderBillingItems.filter(i => i.id !== chargeId);
    setOrderBillingItems(remaining);
    recomputeTotalsFromItems(remaining);
  };

  const handleSaveCollectionCharge = async () => {
    const newCC = Math.max(0, Number(collectionChargeInput) || 0);
    setSavingCollectionCharge(true);
    // total_amount = tests_only + collection_charge; update both fields
    const testsOnly = (order.total_amount || 0) - collectionCharge;
    const newTotalAmount = testsOnly + newCC;
    await supabase.from('orders').update({
      collection_charge: newCC > 0 ? newCC : null,
      total_amount: newTotalAmount,
    }).eq('id', order.id);
    setCollectionCharge(newCC);
    setEditingCollectionCharge(false);
    setCollectionChargeInput('');
    const chargesTotal = orderBillingItems.reduce((s, i) => s + i.amount, 0);
    setCurrentTotal(newTotalAmount + chargesTotal);
    setCurrentDue(Math.max(0, newTotalAmount + chargesTotal - (order.paid_amount || 0)));
    setSavingCollectionCharge(false);
  };

  // Fetch available tests when modal opens
  useEffect(() => {
    if (showAddTestModal && availableTests.length === 0 && labId) {
      const fetchTests = async () => {
        // Fetch individual tests
        const { data: testsData } = await supabase
          .from('test_groups')
          .select('*')
          .eq('is_active', true)
          .eq('lab_id', labId)
          .order('name');

        // Fetch packages
        const { data: packagesData } = await supabase
          .from('packages')
          .select('*')
          .eq('is_active', true)
          .eq('lab_id', labId)
          .order('name');

        const combined = [
          ...(testsData || []).map((t: any) => ({ ...t, type: 'test' })),
          ...(packagesData || []).map((p: any) => ({ ...p, type: 'package' }))
        ];
        // Sort combined by name
        combined.sort((a, b) => a.name.localeCompare(b.name));

        setAvailableTests(combined);
      };
      fetchTests();
    }
  }, [showAddTestModal, labId, availableTests.length]);

  const handleAddTest = async (item: any) => {
    if (!labId) return;
    try {
      // Check for duplicate
      if (tests.some(t => t.test_name === item.name)) {
        alert('This item is already in the order.');
        return;
      }

      setIsAddingTest(true);
      const addedOrderTests: any[] = [];
      let addedCollectionCharge = Number(item.collection_charge) || 0;

      if (item.type === 'package') {
        // --- PACKAGE ADD LOGIC ---
        const { data: pkgRows, error: pkgError } = await supabase
          .from('package_test_groups')
          .select('test_group_id, test_groups(*)')
          .eq('package_id', item.id);

        if (pkgError) throw pkgError;

        // Skip test groups deactivated after they were linked to the package
        const pkgGroups = (pkgRows || []).filter(
          (pg: any) => pg.test_groups && pg.test_groups.is_active !== false
        );

        // 1. Insert Package Header (Billed Item)
        const { data: headerTest, error: headerError } = await supabase
          .from('order_tests')
          .insert({
            order_id: order.id,
            test_name: item.name,
            package_id: item.id,
            price: item.price,
            lab_id: labId,
            is_billed: false
            // test_group_id is null for package header
          })
          .select()
          .single();
        if (headerError) throw headerError;

        // 2. Insert Component Tests (Non-billed items linked to package)
        // Note: We use source_package_id to link them, and price 0
        if (pkgGroups && pkgGroups.length > 0) {
          addedCollectionCharge = pkgGroups.reduce(
            (sum: number, pg: any) => sum + (Number(pg.test_groups?.collection_charge) || 0),
            0
          );
          const components = pkgGroups.map((pg: any) => ({
            order_id: order.id,
            test_group_id: pg.test_group_id,
            test_name: pg.test_groups?.name || 'Unknown Test',
            price: 0,
            lab_id: labId,
            source_package_id: item.id,
            is_billed: false
          }));

          const { data: componentTests, error: compError } = await supabase
            .from('order_tests')
            .insert(components)
            .select();
          if (compError) throw compError;
          addedOrderTests.push(...(componentTests || []));
        }

        setTests(prev => [...prev, {
          id: headerTest.id,
          test_name: headerTest.test_name,
          outsourced_lab_id: null
        }]);
        console.log(`Added package ${item.name}`);

      } else {
        // --- INDIVIDUAL TEST LOGIC ---
        const { data: newTest, error } = await supabase
          .from('order_tests')
          .insert({
            order_id: order.id,
            test_group_id: item.id,
            test_name: item.name,
            price: item.price,
            lab_id: labId,
            is_billed: false
          })
          .select()
          .single();

        if (error) throw error;
        addedOrderTests.push(newTest);

        setTests(prev => [...prev, {
          id: newTest.id,
          test_name: newTest.test_name,
          outsourced_lab_id: null
        }]);
        console.log(`Added ${item.name} successfully.`);
      }

      // Use fresh persisted values. currentTotal also contains extra billing items and must
      // never be written back to orders.total_amount.
      const { data: freshOrder, error: freshOrderError } = await supabase
        .from('orders')
        .select('total_amount, collection_charge, billing_status, patient_id')
        .eq('id', order.id)
        .single();
      if (freshOrderError) throw freshOrderError;

      const newOrderTotal = (Number(freshOrder.total_amount) || 0)
        + (Number(item.price) || 0)
        + addedCollectionCharge;
      const newCollectionCharge = (Number(freshOrder.collection_charge) || 0) + addedCollectionCharge;
      const newBillingStatus = freshOrder.billing_status === 'billed'
        ? 'partial'
        : freshOrder.billing_status;

      const { error: orderError } = await supabase
        .from('orders')
        .update({
          total_amount: newOrderTotal,
          collection_charge: newCollectionCharge > 0 ? newCollectionCharge : null,
          billing_status: newBillingStatus
        })
        .eq('id', order.id);
      if (orderError) throw orderError;

      // Reuse a compatible sample only while it is still awaiting collection.
      // Otherwise create an additional sample and link the newly added tests to it.
      if (addedOrderTests.length > 0) {
        const testGroupIds = addedOrderTests
          .map(test => test.test_group_id)
          .filter(Boolean);
        const { data: groupRows, error: groupError } = await supabase
          .from('test_groups')
          .select('id, sample_type, sample_color')
          .in('id', testGroupIds);
        if (groupError) throw groupError;

        const groupById = new Map((groupRows || []).map(group => [group.id, group]));
        const testsBySampleType = new Map<string, any[]>();
        for (const addedTest of addedOrderTests) {
          const group = groupById.get(addedTest.test_group_id) as any;
          const sampleType = group?.sample_type || 'Blood';
          const matchingTests = testsBySampleType.get(sampleType) || [];
          matchingTests.push({ addedTest, group, sampleType });
          testsBySampleType.set(sampleType, matchingTests);
        }

        const { data: existingSamples, error: samplesError } = await supabase
          .from('samples')
          .select('id, sample_type, status')
          .eq('order_id', order.id);
        if (samplesError) throw samplesError;

        for (const [sampleType, matchingTests] of testsBySampleType) {
          const reusableSample = (existingSamples || []).find(sample =>
            sample.sample_type?.toLowerCase() === sampleType.toLowerCase()
            && sample.status === 'created'
          );

          if (reusableSample) {
            const { error: linkError } = await supabase
              .from('order_tests')
              .update({ sample_id: reusableSample.id })
              .in('id', matchingTests.map(({ addedTest }) => addedTest.id));
            if (linkError) throw linkError;
          } else {
            const { createSamplesForOrder } = await import('../../services/sampleService');
            const samples = await createSamplesForOrder(
              order.id,
              matchingTests.map(({ addedTest, group }) => ({
                id: addedTest.id,
                order_id: order.id,
                test_group_id: addedTest.test_group_id,
                test_name: addedTest.test_name,
                test_group: {
                  sample_type: group?.sample_type || 'Blood',
                  sample_color: group?.sample_color
                }
              })),
              labId,
              freshOrder.patient_id || order.patient_id
            );
            if (samples.length === 0) {
              throw new Error(`Could not create the required ${sampleType} sample`);
            }
          }
        }
      }

      const newCurrentTotal = newOrderTotal + billingItemsTotal;
      setCollectionCharge(newCollectionCharge);
      setCurrentTotal(newCurrentTotal);
      setCurrentDue(Math.max(
        0,
        newCurrentTotal
          - (invoiceDiscount?.total_discount || 0)
          - (order.paid_amount || 0)
      ));
      await onUpdateStatus(order.id, order.status);

      setTestSearch('');
      setTimeout(() => {
        if (searchInputRef.current) {
          searchInputRef.current.focus();
        }
      }, 0);

    } catch (err: any) {
      console.error('Add test error:', err);
      alert('Failed to add test: ' + err.message);
    } finally {
      setIsAddingTest(false);
    }
  };

  const handleRemoveTest = async (testId: string, testName: string) => {
    if (!confirm(`Are you sure you want to remove ${testName}?`)) return;

    try {
      // 1. Check if invoiced/billed - fetch fresh data from DB
      const { data: testData, error: fetchError } = await supabase
        .from('order_tests')
        .select('invoice_id, price, is_billed')
        .eq('id', testId)
        .single();

      if (fetchError) throw fetchError;

      if (!testData) {
        alert('Test not found. It may have already been removed.');
        return;
      }

      if (testData.invoice_id || testData.is_billed) {
        alert('Cannot delete this test because an invoice has been generated. Use the Cancel button instead to exclude it from reports while preserving billing records.');
        // Update local state to reflect the billed status
        setTests(prev => prev.map(t =>
          t.id === testId ? { ...t, is_billed: true, invoice_id: testData.invoice_id } : t
        ));
        return;
      }

      // Also check if there's an invoice_item for this test (belt and suspenders)
      const { data: invoiceItem } = await supabase
        .from('invoice_items')
        .select('id')
        .eq('order_test_id', testId)
        .maybeSingle();

      if (invoiceItem) {
        alert('Cannot delete this test because it has been invoiced. Use the Cancel button instead.');
        setTests(prev => prev.map(t =>
          t.id === testId ? { ...t, is_billed: true } : t
        ));
        return;
      }

      // 2. Delete
      const { error: deleteError } = await supabase
        .from('order_tests')
        .delete()
        .eq('id', testId);

      if (deleteError) throw deleteError;

      // 3. Update Order Totals
      const priceToRemove = testData.price || 0;
      const newTotal = Math.max(0, (currentTotal || 0) - priceToRemove);
      const newDue = Math.max(0, (currentDue || 0) - priceToRemove);

      const { error: updateError } = await supabase
        .from('orders')
        .update({
          total_amount: newTotal
          // due_amount removed
        })
        .eq('id', order.id);

      if (updateError) throw updateError;

      // 4. Update Local State
      setTests(prev => prev.filter(t => t.id !== testId));
      setCurrentTotal(newTotal);
      setCurrentDue(newDue);

      // Refresh parent dashboard
      await onUpdateStatus(order.id, order.status);

    } catch (err: any) {
      console.error('Remove test error:', err);
      // Check if it's a foreign key constraint error (results exist)
      if (err.code === '23503' || err.message?.includes('violates foreign key constraint')) {
        alert('Cannot delete this test because results have been entered.\n\nUse the Cancel button (🚫) to exclude it from the final report instead.');
      } else {
        alert('Failed to remove test: ' + err.message);
      }
    }
  };

  // Cancel test (exclude from PDF but keep for billing/refund)
  const handleCancelTest = async (testId: string, testName: string) => {
    const reason = prompt(`Cancel "${testName}"?\n\nThis will exclude it from the final report PDF.\nThe test will remain in billing records for refund purposes.\n\nEnter cancellation reason (optional):`);
    if (reason === null) return; // User clicked Cancel on prompt

    try {
      const { data: userData } = await supabase.auth.getUser();

      const { error } = await supabase
        .from('order_tests')
        .update({
          is_canceled: true,
          canceled_at: new Date().toISOString(),
          canceled_by: userData?.user?.id || null,
          cancellation_reason: reason || null
        })
        .eq('id', testId);

      if (error) throw error;

      // Update local state
      setTests(prev => prev.map(t =>
        t.id === testId ? { ...t, is_canceled: true } : t
      ));

      alert(`"${testName}" has been canceled and will not appear in reports.\nYou can process a refund for this test.`);

      // Refresh parent dashboard
      await onUpdateStatus(order.id, order.status);

    } catch (err: any) {
      console.error('Cancel test error:', err);
      alert('Failed to cancel test: ' + err.message);
    }
  };

  // Restore canceled test
  const handleRestoreTest = async (testId: string, testName: string) => {
    if (!confirm(`Restore "${testName}"?\n\nThis will include it back in the final report PDF.`)) return;

    try {
      const { error } = await supabase
        .from('order_tests')
        .update({
          is_canceled: false,
          canceled_at: null,
          canceled_by: null,
          cancellation_reason: null
        })
        .eq('id', testId);

      if (error) throw error;

      // Update local state
      setTests(prev => prev.map(t =>
        t.id === testId ? { ...t, is_canceled: false } : t
      ));

      alert(`"${testName}" has been restored and will appear in reports.`);

      // Refresh parent dashboard
      await onUpdateStatus(order.id, order.status);

    } catch (err: any) {
      console.error('Restore test error:', err);
      alert('Failed to restore test: ' + err.message);
    }
  };


  // Init
  useEffect(() => {
    const init = async () => {
      const id = await database.getCurrentUserLabId();
      setLabId(id);
      console.log('[DashboardOrderModal] Lab ID:', id);
      console.log('[DashboardOrderModal] Order location:', order.location, 'location_id:', order.location_id);
      console.log('[DashboardOrderModal] Sample collected:', order.sample_collected_at);
      console.log('[DashboardOrderModal] Transit status:', order.transit_status);

      if (id) {
        const { data } = await supabase
          .from('outsourced_labs')
          .select('*')
          .eq('lab_id', id)
          .eq('is_active', true)
          .order('name');
        setOutsourcedLabs(data || []);

        const { data: doctorsData } = await (database as any).doctors.getAll();
        setDoctors(doctorsData || []);

        const { data: accountsData } = await (database as any).accounts.getAll();
        setAccounts(accountsData || []);

        // Fetch all locations (filtered by user access if restricted)
        const filterCheck = await database.shouldFilterByLocation();

        let query = supabase
          .from('locations')
          .select('id, name, type, is_processing_center')
          .eq('lab_id', id)
          .eq('is_active', true)
          .order('name');

        if (filterCheck.shouldFilter && !filterCheck.canViewAll && filterCheck.locationIds.length > 0) {
          query = query.in('id', filterCheck.locationIds);
        }

        const { data: locations, error: locationsError } = await query;

        if (locationsError) {
          console.error('[DashboardOrderModal] Error fetching locations:', locationsError);
        }
        setDispatchLocations(locations || []);

        // Default to a processing center if available, otherwise first location
        if (locations && locations.length > 0) {
          // Try to find a processing center first
          const defaultLoc = locations.find((l: any) => l.is_processing_center) || locations[0];
          setDispatchDestination(defaultLoc.id);
        }
      }
    };
    init();
  }, []);

  // Reload invoice delivery status and notify parent dashboard when invoice delivery is tracked
  useEffect(() => {
    if (invoiceRefreshTrigger > 0 && order.invoice_id) {
      // Notify parent to refresh dashboard
      onUpdateStatus(order.id, order.status);
      console.log('[DashboardOrderModal] Invoice delivery tracked, refreshing dashboard');
    }
  }, [invoiceRefreshTrigger]);

  // Pre-select doctor when editing starts
  useEffect(() => {
    if (isEditingDoctor && doctors.length > 0) {
      const match = doctors.find(d => d.name === order.doctor);
      if (match) setEditDoctorId(match.id);
      else setEditDoctorId('');
    }
  }, [isEditingDoctor, doctors, order.doctor]);

  // Generate QR Code on mount
  useEffect(() => {
    if (order.sample_id || order.id) {
      const qrData = order.qr_code_data || JSON.stringify({
        id: order.id,
        sid: order.sample_id,
        p: order.patient_name,
        d: order.order_date
      });

      QRCodeLib.toDataURL(qrData, { width: 200, margin: 1 })
        .then(setQrCodeUrl)
        .catch(err => console.error("QR Gen Error:", err));
    }
  }, [order]);

  // Handlers
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    if (!file) return;

    if (file.size > 10 * 1024 * 1024) {
      alert('File size must be less than 10MB');
      return;
    }

    setTestRequestFile(file);

    // Auto-process TRF with AI
    if (file.type.startsWith('image/') || file.type === 'application/pdf') {
      setProcessingTRF(true);
      setTrfExtraction(null);
      setTrfProgress(null);

      try {
        const result = await processTRFImage(file, (progress) => {
          setTrfProgress(progress);
        }, {
          enableOptimization: enableTRFOptimization
        });

        if (result.success) {
          setTrfExtraction(result);
          // Here we could auto-update order details if needed, or just show success
          // For now, we just store the result and file

          // Upload file to attachments
          // TODO: Use database.attachments.uploadForOrder when available
          // For now, we can't easily upload without that helper or direct storage access
          console.log('TRF Processed:', result);
        }
      } catch (error) {
        console.error('TRF Processing failed:', error);
      } finally {
        setProcessingTRF(false);
      }
    }
  };

  const handleViewInvoice = async () => {
    console.log('[DashboardOrderModal] View Invoice clicked. Order:', order);

    if (!order.invoice_id) {
      console.error('[DashboardOrderModal] Invoice ID is missing despite billing status:', order.billing_status);
      alert('Invoice record not found. Please contact support or try regenerating the invoice.');
      return;
    }

    setViewInvoiceLoading(true);

    try {
      // 1. Get invoice data with PDF URL
      const { data: invoice, error } = await supabase
        .from('invoices')
        .select('id, pdf_url, template_id, invoice_number')
        .eq('id', order.invoice_id)
        .single();

      if (error || !invoice) {
        throw error || new Error('Invoice not found');
      }

      // 2. Generate PDF if not already generated
      let pdfUrl = invoice.pdf_url;

      if (!pdfUrl) {
        console.log('PDF not found, generating invoice PDF...');

        // Get default template if not specified
        let templateId = invoice.template_id;

        if (!templateId) {
          const { data: templates } = await database.invoiceTemplates.getAll();
          const defaultTemplate = templates?.find((t: any) => t.is_default) || templates?.[0];

          if (!defaultTemplate) {
            throw new Error('No invoice template found. Please configure templates in Settings.');
          }

          templateId = defaultTemplate.id;
        }

        // Generate PDF using the proper invoice PDF service
        pdfUrl = await generateInvoicePDF(invoice.id, templateId, { triggerNotification: false });

        if (!pdfUrl) {
          throw new Error('Failed to generate invoice PDF');
        }
      }

      // 3. Open PDF in new tab
      window.open(pdfUrl, '_blank');

    } catch (err) {
      console.error('Failed to view invoice', err);
      alert(`Failed to view invoice: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setViewInvoiceLoading(false);
    }
  };

  const handleSaveDiscount = async () => {
    if (!order.invoice_id) return;
    const discountAmt = parseFloat(discountInput) || 0;
    setSavingDiscount(true);
    try {
      // Fetch all invoices for this order to get combined totals.
      // Completed refunds reduce the money the lab actually keeps, so they
      // raise the discount ceiling (net paid = amount_paid - total_refunded_amount).
      const { data: allInvoices } = await supabase
        .from('invoices')
        .select('id, subtotal, discount, total, amount_paid, total_refunded_amount')
        .eq('order_id', order.id);

      const combinedSubtotal  = (allInvoices || []).reduce((s: number, inv: any) => s + (parseFloat(inv.subtotal) || 0), 0);
      const combinedRefunded  = (allInvoices || []).reduce((s: number, inv: any) => s + (parseFloat(inv.total_refunded_amount) || 0), 0);
      const combinedNetPaid   = (allInvoices || []).reduce(
        (s: number, inv: any) => s + Math.max(0, (parseFloat(inv.amount_paid) || 0) - (parseFloat(inv.total_refunded_amount) || 0)),
        0
      );
      const newTotal          = combinedSubtotal - discountAmt;

      if (newTotal < combinedNetPaid) {
        const refundNote = combinedRefunded > 0 ? ` (₹${combinedNetPaid} = paid minus ₹${combinedRefunded} refunded)` : '';
        alert(`Discount of ₹${discountAmt} would make total ₹${newTotal} less than the amount already collected ₹${combinedNetPaid}${refundNote}.\nMaximum discount allowed: ₹${combinedSubtotal - combinedNetPaid}`);
        return;
      }

      const primaryInvoice = (allInvoices || []).find((inv: any) => inv.id === order.invoice_id);
      const primarySubtotal = parseFloat(primaryInvoice?.subtotal || '0') || 0;
      const primaryNetPaid = Math.max(0,
        (parseFloat(primaryInvoice?.amount_paid || '0') || 0) - (parseFloat(primaryInvoice?.total_refunded_amount || '0') || 0)
      );
      const primaryTotalAfterDiscount = Math.max(0, primarySubtotal - discountAmt);

      if (primaryTotalAfterDiscount < primaryNetPaid) {
        alert(`Discount of ₹${discountAmt} would make this invoice total ₹${primaryTotalAfterDiscount} less than the amount collected on it ₹${primaryNetPaid} (net of refunds).`);
        return;
      }

      // Apply entire discount to the primary invoice using the same fields
      // the dashboard and billing views read back.
      const { error } = await supabase
        .from('invoices')
        .update({
          discount: discountAmt,
          total_discount: discountAmt,
          total_before_discount: primarySubtotal,
          total_after_discount: primaryTotalAfterDiscount,
          total: primaryTotalAfterDiscount,
          notes: discountReason.trim() || null,
          discount_source: 'lab',
        })
        .eq('id', order.invoice_id);

      if (error) throw error;

      setShowDiscountEdit(false);
      setDiscountInput('');
      setDiscountReason('');
      setInvoiceRefreshTrigger(t => t + 1);
      setCurrentDue(Math.max(0, newTotal - (combinedNetPaid + combinedRefunded)));
      await onUpdateStatus(order.id, order.status);
      alert('Discount saved. Please regenerate the PDF to reflect the change.');
    } catch (err: any) {
      alert(`Failed to save discount: ${err.message}`);
    } finally {
      setSavingDiscount(false);
    }
  };

  const handleTestOutsourceChange = async (testId: string, labId: string | 'inhouse') => {
    try {
      const updateData = labId === 'inhouse'
        ? { outsourced_lab_id: null }
        : { outsourced_lab_id: labId };

      const { error } = await supabase
        .from('order_tests')
        .update(updateData)
        .eq('id', testId);

      if (error) throw error;

      // Update local state so the dropdown reflects the change without closing the modal
      setTests((prev) => prev.map((t) => t.id === testId ? { ...t, outsourced_lab_id: updateData.outsourced_lab_id || null } : t));
    } catch (err) {
      console.error(err);
      alert('Failed to update test outsourcing');
    }
  };

  const handleSavePatient = async () => {
    try {
      if (order.patient_id) {
        const { error } = await supabase
          .from('patients')
          .update({
            name: editPatientName,
            phone: editPatientPhone
          })
          .eq('id', order.patient_id);

        if (error) throw error;
        setIsEditingPatient(false);
        onUpdateStatus(order.id, order.status);
      }
    } catch (e) {
      console.error(e);
      alert('Failed to update patient');
    }
  };

  const handleSaveDoctor = async () => {
    try {
      if (!editDoctorId) {
        alert('Please select a doctor');
        return;
      }

      const selectedDoc = doctors.find(d => d.id === editDoctorId);
      if (!selectedDoc) return;

      // Update both referring_doctor_id (the foreign key) and doctor name (denormalized)
      const { error } = await supabase
        .from('orders')
        .update({
          referring_doctor_id: selectedDoc.id,
          doctor: selectedDoc.name,
        })
        .eq('id', order.id);

      if (error) {
        console.error('Error updating doctor:', error);
        throw error;
      }

      setIsEditingDoctor(false);
      await onUpdateStatus(order.id, order.status); // Use await if promise
    } catch (e: any) {
      console.error(e);
      alert('Failed to update doctor: ' + (e.message || 'Unknown error'));
    }
  };

  const handleSaveAccount = async () => {
    try {
      const selectedAcc = editAccountId ? accounts.find(a => a.id === editAccountId) : null;

      const { error } = await supabase
        .from('orders')
        .update({ account_id: selectedAcc?.id || null })
        .eq('id', order.id);

      if (error) throw error;

      setIsEditingAccount(false);
      await onUpdateStatus(order.id, order.status);
    } catch (e: any) {
      console.error(e);
      alert('Failed to update account: ' + (e.message || 'Unknown error'));
    }
  };

  // Handle dispatch to main lab/processing center
  const handleDispatchToLab = async () => {
    if (!dispatchDestination) {
      alert('Please select a destination');
      return;
    }

    const fromLocationId = order.collected_at_location_id || order.location_id;
    if (!fromLocationId) {
      alert('Order does not have a source location');
      return;
    }

    setDispatching(true);
    try {
      // Generate batch ID for tracking (must be UUID to match DB schema)
      const batchId = crypto.randomUUID();

      // Get current user info
      const { data: { user: authUser } } = await supabase.auth.getUser();
      const { data: userData } = await supabase
        .from('users')
        .select('id')
        .eq('email', authUser?.email)
        .single();

      // Create transit record
      const trackingBarcode = `TRN-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

      const { error: transitError } = await supabase
        .from('sample_transits')
        .insert({
          lab_id: labId,
          order_id: order.id,
          from_location_id: fromLocationId,
          to_location_id: dispatchDestination,
          status: 'in_transit',
          priority: dispatchPriority,
          dispatch_notes: dispatchNotes,
          tracking_barcode: trackingBarcode,
          batch_id: batchId,
          dispatched_at: new Date().toISOString(),
          dispatched_by: userData?.id
        });

      if (transitError) throw transitError;

      // Update order transit status
      const { error: orderError } = await supabase
        .from('orders')
        .update({ transit_status: 'in_transit' })
        .eq('id', order.id);

      if (orderError) throw orderError;

      setShowDispatchModal(false);
      setDispatchNotes('');
      alert(`Order dispatched successfully!\nTracking: ${trackingBarcode}`);
      onUpdateStatus(order.id, order.status); // Refresh parent
    } catch (e: any) {
      console.error('Dispatch error:', e);
      alert('Failed to dispatch: ' + (e.message || 'Unknown error'));
    } finally {
      setDispatching(false);
    }
  };

  const handleMarkSampleCollected = async () => {
    if (!order.sample_collected_at && !showPhlebotomistSelector) {
      setShowPhlebotomistSelector(true);
      return;
    }

    try {
      setUpdatingCollection(true);
      const { error } = await database.orders.markSampleCollected(
        order.id,
        selectedPhlebotomistName || undefined,
        selectedPhlebotomistId || undefined
      );
      if (error) {
        alert('Failed to mark sample collected');
        return;
      }
      await database.orders.checkAndUpdateStatus(order.id);
      await onUpdateStatus(order.id, "Sample Collection");
      setShowPhlebotomistSelector(false);
    } catch (e) {
      console.error("Error marking sample collected:", e);
      alert("Failed to mark sample collected");
    } finally {
      setUpdatingCollection(false);
    }
  };

  const handlePrintBarcode = () => {
    const printWindow = window.open('', '_blank');
    if (!printWindow) return;

    printWindow.document.write(`
      <html>
        <head>
          <title>Sample Label - ${order.sample_id}</title>
          <style>
            body { font-family: sans-serif; text-align: center; padding: 10px; }
            .label { border: 1px dashed #ccc; padding: 10px; display: inline-block; }
            .sid { font-size: 18px; font-weight: bold; margin: 5px 0; }
            .meta { font-size: 12px; }
          </style>
        </head>
        <body>
          <div class="label">
            <img src="${qrCodeUrl}" width="100" height="100" />
            <div class="sid">${order.sample_id || 'NO ID'}</div>
            <div class="meta">${order.patient_name}</div>
            <div class="meta">${new Date(order.order_date).toLocaleDateString()}</div>
            <div class="meta">${order.color_name || 'Tube'}</div>
          </div>
          <script>window.print();</script>
        </body>
      </html>
    `);
    printWindow.document.close();
  };

  const handlePrintTRF = () => {
    // Placeholder for TRF printing logic
    alert("TRF Printing feature coming soon!");
  };

  const handleDownloadReport = () => {
    if (order.report_url) {
      window.open(order.report_url, '_blank');
    } else {
      alert("Report not generated yet.");
    }
  };

  const handleOutsource = async () => {
    if (!selectedOutsourceLab) return;

    try {
      const { error } = await supabase
        .from('orders')
        .update({
          outsourced_lab_id: selectedOutsourceLab,
          outsourced_status: 'pending_send',
          status: 'In Progress' // Ensure it's not stuck
        })
        .eq('id', order.id);

      if (error) throw error;

      alert('Order outsourced successfully');
      setShowOutsourceModal(false);
      onUpdateStatus(order.id, 'In Progress');
      onClose();
    } catch (err) {
      console.error(err);
      alert('Failed to outsource');
    }
  };

  return ReactDOM.createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-2 sm:p-4 animate-in fade-in duration-200">
      <div className="bg-gray-50/50 rounded-2xl shadow-2xl w-full max-w-5xl max-h-[96vh] sm:max-h-[90vh] overflow-hidden flex flex-col border border-white/20">

        {/* Header - Premium Gradient */}
        <div className="sticky top-0 z-10 border-b border-gray-100 bg-white px-4 py-4 sm:px-6 sm:py-5">
          <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex items-start gap-3 sm:gap-5">
            <div className="flex items-center justify-center w-11 h-11 sm:w-12 sm:h-12 bg-blue-600 text-white rounded-xl font-bold text-lg shadow-lg shadow-blue-200 shrink-0">
              {order.patient_name.charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
                <h2 className="truncate text-xl sm:text-2xl font-bold text-gray-900 tracking-tight">{order.patient_name}</h2>
                <div className="flex flex-wrap items-center gap-2">
                <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-gray-100 text-gray-600 border border-gray-200">
                  #{order.id.slice(-6).toUpperCase()}
                </span>
                <OrderStatusDisplay order={order} compact={true} />
                </div>
              </div>
              <div className="text-sm text-gray-500 mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-medium">{formatAge(order.patient?.age, (order.patient as any)?.age_unit)}</span>
                <span>•</span>
                <span className="font-medium">{order.patient?.gender || 'N/A'}</span>
                {order.patient_phone && (
                  <>
                    <span>•</span>
                    <span className="flex items-center gap-1"><Phone className="h-3 w-3" /> {order.patient_phone}</span>
                  </>
                )}
                {order.account_name && (
                  <>
                    <span className="w-1 h-1 bg-gray-300 rounded-full mx-1"></span>
                    <span className="flex items-center gap-1 text-indigo-600 font-medium bg-indigo-50 px-2 py-0.5 rounded-full text-xs border border-indigo-100">
                      <Building className="h-3 w-3" />
                      {order.account_name}
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2 self-start">
            <div className="hidden sm:flex items-center gap-3">
              <OrderStatusDisplay order={order as any} />
            </div>
            <div className="hidden sm:flex items-center gap-1">
              <button
                onClick={() => setShowSendReport(true)}
                className="flex items-center gap-1 px-3 py-1.5 bg-green-100 text-green-700 rounded-lg hover:bg-green-200 text-xs font-medium transition-colors"
              >
                <Send className="h-3.5 w-3.5" />
                Send
              </button>
            </div>
            <button
              onClick={onClose}
              aria-label="Close order view"
              className="flex h-10 w-10 items-center justify-center rounded-xl border border-gray-200 bg-white text-gray-600 shadow-sm transition-colors hover:bg-gray-100"
            >
              <X className="h-5 w-5 text-gray-500" />
            </button>
          </div>
          </div>
          <div className="mt-3 flex sm:hidden items-center gap-2">
            <OrderStatusDisplay order={order as any} />
            <button
              onClick={() => setShowSendReport(true)}
              className="inline-flex items-center gap-1 rounded-lg bg-green-100 px-3 py-1.5 text-xs font-medium text-green-700"
            >
              <Send className="h-3.5 w-3.5" />
              Send
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-3 sm:p-6 space-y-4 sm:space-y-6">

          {/* TRF Upload Section */}
          <section className="space-y-3 bg-gradient-to-r from-purple-50 to-blue-50 p-3 sm:p-4 rounded-lg border-2 border-dashed border-purple-300">
            <div className="flex items-center gap-2 mb-2">
              <Sparkles className="h-5 w-5 text-purple-600" />
              <h3 className="text-lg font-medium text-gray-900">AI-Powered TRF Extraction</h3>
              <span className="text-xs text-purple-500 bg-purple-100 px-2 py-0.5 rounded-full">Quick Start</span>
            </div>
            <p className="text-sm text-gray-600 -mt-1">
              Upload a Test Request Form to automatically extract patient info, doctor details, and test selections
            </p>
            <div className="space-y-3">
              {/* Hidden file input for gallery/file picker */}
              <input
                type="file"
                id="trf-upload-modal"
                accept="image/*,.pdf"
                onChange={handleFileChange}
                className="hidden"
              />
              {/* Hidden file input for camera capture (mobile) */}
              <input
                type="file"
                id="trf-camera-modal"
                accept="image/*"
                capture="environment"
                onChange={handleFileChange}
                className="hidden"
              />
              <label
                htmlFor="trf-upload-modal"
                className="block cursor-pointer border-2 border-dashed border-purple-300 bg-white rounded-lg p-4 sm:p-6 text-center hover:border-purple-400 hover:bg-purple-50 transition-colors"
              >
                {processingTRF ? (
                  <div className="flex flex-col items-center">
                    <Loader className="w-8 h-8 text-purple-600 mb-2 animate-spin" />
                    <span className="text-sm font-medium text-purple-700">Processing...</span>
                  </div>
                ) : trfExtraction?.success ? (
                  <div className="flex flex-col items-center">
                    <CheckCircle className="w-8 h-8 text-green-600 mb-2" />
                    <span className="text-sm font-medium text-green-700">Processed Successfully!</span>
                  </div>
                ) : (
                  <div className="flex flex-col items-center">
                    <Upload className="w-8 h-8 text-purple-500 mb-2" />
                    <span className="text-sm font-medium text-gray-700">Click to Upload TRF or Drag & Drop</span>
                    <span className="text-xs text-gray-500 mt-1">Supports: JPG, PNG, PDF (Max 10MB)</span>
                    <span className="text-xs text-yellow-600 mt-1 flex items-center gap-1">
                      <Sparkles className="w-3 h-3" /> Auto-extracts patient, doctor, and test details
                    </span>
                  </div>
                )}
              </label>
              {/* Camera button for mobile - shown separately */}
              {!processingTRF && !trfExtraction?.success && (
                <label
                  htmlFor="trf-camera-modal"
                  className="flex items-center justify-center gap-2 cursor-pointer border-2 border-purple-200 bg-purple-50 rounded-lg p-3 text-center hover:border-purple-400 hover:bg-purple-100 transition-colors"
                >
                  <Camera className="w-5 h-5 text-purple-600" />
                  <span className="text-sm font-medium text-purple-700">Take Photo with Camera</span>
                </label>
              )}
            </div>
          </section>

          {/* Top Grid: Doctor, Sample, Location, Account */}
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 sm:gap-5">

            {/* Doctor Info */}
            <div className="p-3 sm:p-4 bg-white rounded-xl border border-purple-100 shadow-sm hover:shadow-md transition-shadow relative overflow-hidden group">
              <div className="absolute top-0 right-0 w-24 h-24 bg-purple-50 rounded-bl-full -mr-10 -mt-10 transition-transform group-hover:scale-110"></div>
              <div className="relative z-10">
                <div className="flex justify-between items-start mb-3">
                  <div className="text-xs font-bold text-purple-600 uppercase tracking-wider flex items-center gap-1.5">
                    <User className="h-3.5 w-3.5" /> Referring Doctor
                  </div>
                  {!isEditingDoctor && (
                    <button onClick={() => setIsEditingDoctor(true)} className="text-gray-400 hover:text-purple-600 transition-colors bg-white/50 rounded-full p-1 hover:bg-white">
                      <Edit2 className="h-3 w-3" />
                    </button>
                  )}
                </div>

                {isEditingDoctor ? (
                  <div className="space-y-3 bg-white/80 backdrop-blur-sm rounded-lg">
                    <select
                      value={editDoctorId}
                      onChange={(e) => setEditDoctorId(e.target.value)}
                      className="w-full text-sm border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
                    >
                      <option value="">Select Doctor</option>
                      {doctors.map(d => (
                        <option key={d.id} value={d.id}>{d.name}</option>
                      ))}
                    </select>
                    <div className="flex gap-2 justify-end">
                      <button onClick={handleSaveDoctor} className="text-xs bg-purple-600 text-white px-3 py-1.5 rounded-lg hover:bg-purple-700 font-medium">Save</button>
                      <button onClick={() => setIsEditingDoctor(false)} className="text-xs bg-gray-100 text-gray-700 px-3 py-1.5 rounded-lg hover:bg-gray-200">Cancel</button>
                    </div>
                  </div>
                ) : (
                  <div>
                    <div className="font-bold text-gray-900 text-base">{order.doctor || 'Self'}</div>
                    {order.doctor_phone ? (
                      <div className="text-sm text-gray-500 mt-1 flex items-center gap-1.5">
                        <Phone className="h-3.5 w-3.5 text-purple-400" />
                        <span className="font-medium text-gray-600">{order.doctor_phone}</span>
                      </div>
                    ) : (
                      <div className="text-xs text-gray-400 italic mt-1">No contact info</div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Sample Info */}
            <div className="p-3 sm:p-4 bg-white rounded-xl border border-blue-100 shadow-sm hover:shadow-md transition-shadow relative overflow-hidden group">
              <div className="absolute top-0 right-0 w-24 h-24 bg-blue-50 rounded-bl-full -mr-10 -mt-10 transition-transform group-hover:scale-110"></div>
              <div className="relative z-10">
                <div className="text-xs font-bold text-blue-600 uppercase tracking-wider mb-3 flex items-center gap-1.5">
                  <TestTube className="h-3.5 w-3.5" /> Sample Details
                </div>
                {order.sample_id ? (
                  <>
                    <div className="flex items-center gap-3">
                      <div className="font-mono font-bold text-gray-900 text-lg tracking-tight bg-blue-50/50 px-2.5 py-1 rounded-lg border border-blue-100">
                        {order.sample_id}
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {order.panels && order.panels.length > 0 ? (
                        Array.from(
                          new Map(
                            order.panels.map(p => [p.sample_type || 'Blood', p])
                          ).values()
                        ).map((p, idx) => (
                          <div key={idx} className="transform hover:scale-105 transition-transform">
                            <SampleTypeIndicator
                              sampleType={p.sample_type || 'Blood'}
                              sampleColor={p.sample_color || order.color_code || undefined}
                              showLabel={true}
                              size="sm"
                            />
                          </div>
                        ))
                      ) : (
                        <div className="flex items-center gap-2 bg-gray-50 px-2 py-1 rounded-lg border border-gray-100">
                          <span className="w-3 h-3 rounded-full shadow-sm ring-1 ring-black/5" style={{ backgroundColor: order.color_code || '#ccc' }}></span>
                          <span className="text-sm text-gray-700 font-medium">{order.color_name || 'Tube'}</span>
                        </div>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="flex flex-col items-center justify-center p-3 text-gray-400 bg-gray-50/50 rounded-lg border border-dashed border-gray-200">
                    <span className="text-sm italic">No sample assigned</span>
                  </div>
                )}
              </div>
            </div>

            {/* Location & Transit */}
            <div className="p-3 sm:p-4 bg-white rounded-xl border border-amber-100 shadow-sm hover:shadow-md transition-shadow relative overflow-hidden group">
              <div className="absolute top-0 right-0 w-24 h-24 bg-amber-50 rounded-bl-full -mr-10 -mt-10 transition-transform group-hover:scale-110"></div>
              <div className="relative z-10">
                <div className="text-xs font-bold text-amber-600 uppercase tracking-wider mb-3 flex items-center gap-1.5">
                  <MapPin className="h-3.5 w-3.5" /> Collection Point
                </div>
                <div className="font-bold text-gray-900 text-base mb-2">{order.location || 'Main Lab'}</div>

                <div className="flex flex-wrap gap-2 mb-2">
                  {order.transit_status && (
                    <div className={`text-xs px-2.5 py-1 rounded-full inline-flex items-center gap-1.5 font-bold shadow-sm ${order.transit_status === 'in_transit' ? 'bg-amber-100 text-amber-800 border border-amber-200' :
                      order.transit_status === 'received_at_lab' ? 'bg-green-100 text-green-800 border border-green-200' :
                        'bg-gray-100 text-gray-700 border border-gray-200'
                      }`}>
                      <Truck className="h-3 w-3" />
                      {order.transit_status === 'in_transit' ? 'In Transit' :
                        order.transit_status === 'received_at_lab' ? 'Received' :
                          order.transit_status === 'at_collection_point' ? 'At Collection' :
                            order.transit_status}
                    </div>
                  )}
                </div>

                {/* Send Sample button */}
                {order.sample_collected_at &&
                  (!order.transit_status || order.transit_status === 'at_collection_point') &&
                  dispatchLocations.length > 0 && (
                    <button
                      onClick={() => setShowDispatchModal(true)}
                      className="mt-2 w-full flex items-center justify-center gap-2 text-xs font-bold bg-gradient-to-r from-amber-500 to-amber-600 text-white px-3 py-2 rounded-lg hover:from-amber-600 hover:to-amber-700 transition-all shadow-md hover:shadow-lg transform active:scale-95"
                    >
                      <Send className="h-3.5 w-3.5" />
                      Dispatch
                    </button>
                  )}

                {/* Status Helpers */}
                {!order.sample_collected_at && (
                  <div className="text-xs text-orange-600 font-medium mt-2 bg-orange-50 px-2 py-1 rounded-md border border-orange-100 inline-block">
                    Pending Collection
                  </div>
                )}
                {order.sample_collected_at && dispatchLocations.length === 0 && (
                  <div className="text-xs text-gray-400 mt-2 italic">No routes configured</div>
                )}
              </div>
            </div>

            {/* B2B Account / Billing */}
            <div className="p-3 sm:p-4 bg-white rounded-xl border border-indigo-100 shadow-sm hover:shadow-md transition-shadow relative overflow-hidden group">
              <div className="absolute top-0 right-0 w-24 h-24 bg-indigo-50 rounded-bl-full -mr-10 -mt-10 transition-transform group-hover:scale-110"></div>
              <div className="relative z-10">
                <div className="flex justify-between items-start mb-3">
                  <div className="text-xs font-bold text-indigo-600 uppercase tracking-wider flex items-center gap-1.5">
                    <Building className="h-3.5 w-3.5" /> Billing Account
                  </div>
                  {!isEditingAccount && (
                    order.invoice_id || order.is_billed ? (
                      <span title="Invoice already generated — account cannot be changed" className="text-gray-300 cursor-not-allowed bg-white/50 rounded-full p-1">
                        <Lock className="h-3 w-3" />
                      </span>
                    ) : (
                      <button onClick={() => { setEditAccountId(''); setIsEditingAccount(true); }} className="text-gray-400 hover:text-indigo-600 transition-colors bg-white/50 rounded-full p-1 hover:bg-white">
                        <Edit2 className="h-3 w-3" />
                      </button>
                    )
                  )}
                </div>

                {isEditingAccount ? (
                  <div className="space-y-3 bg-white/80 backdrop-blur-sm rounded-lg">
                    <select
                      value={editAccountId}
                      onChange={(e) => setEditAccountId(e.target.value)}
                      className="w-full text-sm border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                    >
                      <option value="">No Account (Self-Pay)</option>
                      {accounts.map(a => (
                        <option key={a.id} value={a.id}>{a.name}</option>
                      ))}
                    </select>
                    <div className="flex gap-2 justify-end">
                      <button onClick={handleSaveAccount} className="text-xs bg-indigo-600 text-white px-3 py-1.5 rounded-lg hover:bg-indigo-700 font-medium">Save</button>
                      <button onClick={() => setIsEditingAccount(false)} className="text-xs bg-gray-100 text-gray-700 px-3 py-1.5 rounded-lg hover:bg-gray-200">Cancel</button>
                    </div>
                  </div>
                ) : order.account_name ? (
                  <div>
                    <div className="font-bold text-gray-900 text-base">{order.account_name}</div>
                    {order.account_billing_mode && (
                      <div className={`text-xs mt-2 inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-medium ${
                        order.account_billing_mode === 'monthly'
                          ? 'bg-indigo-100 text-indigo-700 border border-indigo-200'
                          : 'bg-gray-100 text-gray-600 border border-gray-200'
                      }`}>
                        {order.account_billing_mode === 'monthly' ? 'Monthly Billing' : 'Standard Billing'}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="text-xs text-gray-400 italic mt-1">No account assigned</div>
                )}
              </div>
            </div>
          </div>

          {/* Patient Info (Editable) */}
          <div className="bg-white border border-gray-200 rounded-xl p-3 sm:p-4 shadow-sm">
            <div className="flex flex-wrap gap-2 justify-between items-center mb-3 sm:mb-4">
              <h3 className="font-bold text-gray-900 flex items-center gap-2 text-sm uppercase tracking-wider">
                <User className="h-4 w-4 text-blue-600" />
                Patient Details
              </h3>
              {!isEditingPatient && (
                <button
                  onClick={() => setIsEditingPatient(true)}
                  className="text-xs font-medium text-blue-600 hover:text-blue-700 hover:bg-blue-50 px-2 py-1 rounded transition-colors flex items-center gap-1"
                >
                  <Edit2 className="h-3 w-3" /> Edit Details
                </button>
              )}
            </div>

            {isEditingPatient ? (
              <div className="bg-gray-50 p-3 sm:p-4 rounded-lg border border-gray-200 animate-in fade-in slide-in-from-top-2">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 sm:gap-4">
                  <div>
                    <label className="text-xs font-semibold text-gray-500 mb-1 block">Patient Name</label>
                    <input
                      type="text"
                      value={editPatientName}
                      onChange={(e) => setEditPatientName(e.target.value)}
                      className="w-full border-gray-300 rounded-lg p-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-semibold text-gray-500 mb-1 block">Phone Number</label>
                    <input
                      type="text"
                      value={editPatientPhone}
                      onChange={(e) => setEditPatientPhone(e.target.value)}
                      className="w-full border-gray-300 rounded-lg p-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    />
                  </div>
                  <div className="md:col-span-2 flex flex-col-reverse sm:flex-row gap-2 sm:gap-3 justify-end mt-2">
                    <button onClick={() => setIsEditingPatient(false)} className="text-sm bg-white border border-gray-300 text-gray-700 px-4 py-2 rounded-lg hover:bg-gray-50 font-medium">Cancel</button>
                    <button onClick={handleSavePatient} className="text-sm bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 font-medium shadow-sm">Save Changes</button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 sm:gap-4">
                <div className="bg-gray-50 p-3 rounded-lg border border-gray-100">
                  <span className="text-gray-500 block text-xs font-medium mb-1">Full Name</span>
                  <span className="font-bold text-gray-900 break-words">{order.patient_name}</span>
                </div>
                <div className="bg-gray-50 p-3 rounded-lg border border-gray-100">
                  <span className="text-gray-500 block text-xs font-medium mb-1">Phone Number</span>
                  <span className="font-bold text-gray-900">{order.patient_phone || 'N/A'}</span>
                </div>
                <div className="bg-gray-50 p-3 rounded-lg border border-gray-100">
                  <span className="text-gray-500 block text-xs font-medium mb-1">Age / Gender</span>
                  <span className="font-bold text-gray-900">{order.patient?.age || '-'} / {order.patient?.gender || '-'}</span>
                </div>
                <div className="bg-gray-50 p-3 rounded-lg border border-gray-100">
                  <span className="text-gray-500 block text-xs font-medium mb-1">Patient ID</span>
                  <span className="font-bold text-gray-900 font-mono tracking-tight">{order.patient_id}</span>
                </div>
              </div>
            )}
          </div>

          {/* Middle Row: Tests & Billing */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6">

            {/* Tests List */}
            <div className="lg:col-span-2 border border-gray-200 rounded-xl overflow-hidden shadow-sm flex flex-col h-full bg-white">
              <div className="bg-gray-50/80 px-5 py-4 border-b border-gray-200 flex justify-between items-center backdrop-blur-sm">
                <h3 className="font-bold text-gray-900 flex items-center gap-2 text-base">
                  <TestTube className="h-4 w-4 text-blue-600" />
                  Prescribed Tests
                </h3>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold bg-blue-100 text-blue-700 px-2.5 py-1 rounded-full border border-blue-200 shadow-sm">
                    {tests.length} Items
                  </span>
                  <button
                    onClick={() => setShowAddTestModal(true)}
                    className="p-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors shadow-sm"
                    title="Add Test"
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                </div>
              </div>
              <div className="divide-y divide-gray-100 flex-1">
                {tests.map((test, i) => (
                  <div key={i} className={`px-5 py-4 flex items-center justify-between transition-colors group ${test.is_canceled
                      ? 'bg-gray-100 opacity-60'
                      : 'hover:bg-gray-50'
                    }`}>
                    <div className="flex-1">
                      <span className={`text-sm font-semibold block mb-0.5 transition-colors ${test.is_canceled
                          ? 'text-gray-500 line-through'
                          : 'text-gray-900 group-hover:text-blue-700'
                        }`}>
                        {test.test_name}
                        {test.is_canceled && (
                          <span className="ml-2 text-xs bg-red-100 text-red-600 px-2 py-0.5 rounded-full font-medium no-underline inline-block">
                            CANCELED
                          </span>
                        )}
                      </span>
                      <span className="text-xs text-gray-400 font-medium">Test Code: {test.id.slice(0, 8)}</span>
                    </div>

                    {/* Outsourcing Dropdown & Actions */}
                    <div className="relative flex items-center gap-2">
                      {!test.is_canceled && (
                        <>
                          <select
                            value={test.outsourced_lab_id || 'inhouse'}
                            onChange={(e) => handleTestOutsourceChange(test.id, e.target.value)}
                            className={`text-xs border rounded-lg px-3 py-1.5 focus:ring-2 focus:ring-blue-500 outline-none appearance-none cursor-pointer pr-8 font-medium transition-all ${test.outsourced_lab_id
                              ? 'bg-purple-50 text-purple-700 border-purple-200 hover:bg-purple-100'
                              : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
                              }`}
                          >
                            <option value="inhouse">In-House</option>
                            {outsourcedLabs.map(lab => (
                              <option key={lab.id} value={lab.id}>
                                Outsource to {lab.name}
                              </option>
                            ))}
                          </select>
                          <div className="absolute right-24 top-1/2 -translate-y-1/2 pointer-events-none">
                            <Building className={`h-3 w-3 ${test.outsourced_lab_id ? 'text-purple-400' : 'text-gray-400'}`} />
                          </div>
                        </>
                      )}

                      {/* Action Buttons */}
                      {test.is_canceled ? (
                        <button
                          onClick={() => handleRestoreTest(test.id, test.test_name)}
                          className="text-gray-500 hover:text-green-600 p-1.5 hover:bg-green-50 rounded-lg transition-colors flex items-center gap-1 text-xs font-medium"
                          title="Restore Test"
                        >
                          <RotateCcw className="h-4 w-4" />
                          <span>Restore</span>
                        </button>
                      ) : (
                        <>
                          {/* Cancel button - always available to exclude test from report */}
                          <button
                            onClick={() => handleCancelTest(test.id, test.test_name)}
                            className="text-gray-400 hover:text-orange-500 p-1.5 hover:bg-orange-50 rounded-lg transition-colors"
                            title="Cancel Test (exclude from report)"
                          >
                            <Ban className="h-4 w-4" />
                          </button>
                          {/* Delete button - ONLY for non-billed tests */}
                          {!(test.is_billed || test.invoice_id) && (
                            <button
                              onClick={() => handleRemoveTest(test.id, test.test_name)}
                              className="text-gray-400 hover:text-red-500 p-1.5 hover:bg-red-50 rounded-lg transition-colors"
                              title="Remove Test"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          )}
                          {/* Show locked indicator for billed tests */}
                          {(test.is_billed || test.invoice_id) && (
                            <span className="text-xs text-green-600 bg-green-50 px-2 py-1 rounded-full font-medium">
                              Invoiced
                            </span>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Billing & Actions Column */}
            <div className="space-y-5">

              {/* Financial Summary Card */}
              <div className="bg-white border rounded-xl shadow-sm overflow-hidden relative">
                <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-blue-500 to-indigo-600"></div>
                <div className="p-4 sm:p-5">
                  <h3 className="font-bold text-gray-900 mb-4 flex items-center gap-2 text-sm uppercase tracking-wide">
                    <CreditCard className="h-4 w-4 text-indigo-600" />
                    Billing Status
                  </h3>

                  <div className="space-y-3 mb-5">
                    {/* Subtotal row — show tests-only amount (total_amount minus collection charge) */}
                    <div className="flex justify-between items-center p-2 rounded hover:bg-gray-50 transition-colors">
                      <span className="text-sm text-gray-600 font-medium">
                        Tests Subtotal
                      </span>
                      <span className="font-bold text-gray-900 text-base">
                        ₹{testsSubtotalDisplay.toLocaleString()}
                      </span>
                    </div>

                    {/* Collection Charge Row */}
                    <div className="flex justify-between items-center p-2 rounded hover:bg-gray-50 transition-colors">
                      <span className="text-sm text-gray-600 font-medium flex items-center gap-1">
                        Collection Charge
                        {!editingCollectionCharge && !order.invoice_id && (
                          <button
                            onClick={() => { setEditingCollectionCharge(true); setCollectionChargeInput(collectionCharge > 0 ? String(collectionCharge) : ''); }}
                            className="ml-1 text-gray-400 hover:text-blue-500 transition-colors"
                            title="Edit collection charge"
                          >
                            <Edit2 className="h-3 w-3" />
                          </button>
                        )}
                      </span>
                      {editingCollectionCharge ? (
                        <div className="flex items-center gap-1">
                          <span className="text-xs text-gray-500">₹</span>
                          <input
                            type="number"
                            min="0"
                            value={collectionChargeInput}
                            onChange={e => setCollectionChargeInput(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') handleSaveCollectionCharge(); if (e.key === 'Escape') setEditingCollectionCharge(false); }}
                            className="w-20 px-1.5 py-0.5 text-xs border border-blue-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-400"
                            autoFocus
                          />
                          <button
                            onClick={handleSaveCollectionCharge}
                            disabled={savingCollectionCharge}
                            className="text-green-600 hover:text-green-700 transition-colors"
                            title="Save"
                          >
                            {savingCollectionCharge ? <Loader className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                          </button>
                          <button
                            onClick={() => setEditingCollectionCharge(false)}
                            className="text-gray-400 hover:text-gray-600 transition-colors"
                            title="Cancel"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ) : (
                        <span className={`font-semibold text-sm ${collectionCharge > 0 ? 'text-orange-600' : 'text-gray-400'}`}>
                          {collectionCharge > 0 ? `+₹${collectionCharge.toLocaleString()}` : '—'}
                        </span>
                      )}
                    </div>

                    {/* Extra Charges Section */}
                    {orderBillingItems.length > 0 && (
                      <div className="bg-amber-50 border border-amber-100 rounded-lg p-3 space-y-1.5">
                        <div className="flex justify-between items-center mb-1">
                          <span className="text-xs font-semibold text-amber-800 uppercase tracking-wide">Extra Charges</span>
                          <span className="text-xs font-bold text-amber-800">+₹{orderBillingItems.reduce((s, c) => s + c.amount, 0).toLocaleString()}</span>
                        </div>
                        {orderBillingItems.map(charge => (
                          <div key={charge.id} className="flex items-center justify-between text-xs">
                            <div className="flex items-center gap-1.5 min-w-0">
                              <span className="text-amber-700 truncate">{charge.name}</span>
                              {charge.is_invoiced && (
                                <span className="text-green-600 bg-green-50 px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0">Invoiced</span>
                              )}
                              {charge.is_shareable_with_doctor && (
                                <span title="Shared with doctor" className="text-blue-500 flex-shrink-0">👨‍⚕️</span>
                              )}
                              {charge.is_shareable_with_phlebotomist && (
                                <span title="Shared with phlebotomist" className="text-orange-500 flex-shrink-0">🚴</span>
                              )}
                            </div>
                            <div className="flex items-center gap-1 flex-shrink-0">
                              <span className="font-medium text-amber-800">₹{charge.amount.toLocaleString()}</span>
                              {!charge.is_invoiced && (
                                <button
                                  onClick={() => handleRemoveCharge(charge.id)}
                                  className="text-red-400 hover:text-red-600 transition-colors ml-1"
                                  title="Remove charge"
                                >
                                  <X className="h-3 w-3" />
                                </button>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Add Charge button — always available */}
                    <div className="relative">
                        {!showAddChargeDropdown ? (
                          <button
                            onClick={() => setShowAddChargeDropdown(true)}
                            className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs text-amber-700 bg-amber-50 border border-dashed border-amber-300 rounded-lg hover:bg-amber-100 transition-colors"
                          >
                            <Plus className="h-3.5 w-3.5" />
                            Add Billing Item
                          </button>
                        ) : (
                          <div className="border border-amber-200 bg-amber-50 rounded-lg p-3 space-y-2">
                            <div>
                              <label className="block text-xs text-gray-600 mb-1">Select type or enter custom</label>
                              <select
                                value={selectedChargeTypeId}
                                onChange={e => handleSelectChargeType(e.target.value)}
                                className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-amber-400"
                              >
                                <option value="">— Custom charge —</option>
                                {billingItemTypes.map(t => (
                                  <option key={t.id} value={t.id}>{t.name} (₹{t.default_amount})</option>
                                ))}
                              </select>
                            </div>
                            <div className="flex gap-2">
                              <input
                                type="text"
                                placeholder="Charge name"
                                value={customChargeName}
                                onChange={e => setCustomChargeName(e.target.value)}
                                className="flex-1 px-2 py-1.5 text-xs border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-amber-400"
                              />
                              <input
                                type="number"
                                placeholder="₹ Amount"
                                value={customChargeAmount}
                                onChange={e => setCustomChargeAmount(e.target.value)}
                                className="w-24 px-2 py-1.5 text-xs border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-amber-400"
                              />
                            </div>
                            <div className="flex gap-2">
                              <button
                                onClick={handleAddCharge}
                                disabled={addingCharge || !customChargeName.trim() || !customChargeAmount}
                                className="flex-1 flex items-center justify-center gap-1 px-3 py-1.5 bg-amber-600 text-white text-xs font-medium rounded hover:bg-amber-700 disabled:opacity-50 transition-colors"
                              >
                                {addingCharge ? <Loader className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
                                Add
                              </button>
                              <button
                                onClick={() => { setShowAddChargeDropdown(false); setCustomChargeName(''); setCustomChargeAmount(''); setSelectedChargeTypeId(''); }}
                                className="px-3 py-1.5 text-xs text-gray-600 bg-white border border-gray-300 rounded hover:bg-gray-50 transition-colors"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        )}
                      </div>

                    {/* Discount Section - Show if invoice has discount */}
                    {invoiceDiscount && invoiceDiscount.total_discount > 0 && (
                      <div className="bg-green-50 border border-green-100 rounded-lg p-3 space-y-2">
                        <div className="flex justify-between items-center">
                          <span className="text-sm text-green-700 font-medium flex items-center gap-1">
                            <span className="text-green-500">🏷️</span> Discount Applied
                          </span>
                          <span className="font-bold text-green-600 text-base">
                            -₹{invoiceDiscount.total_discount.toLocaleString()}
                          </span>
                        </div>

                        {/* Show discount breakdown per item */}
                        {invoiceDiscount.items.filter(i => i.discount_amount > 0).length > 0 && (
                          <div className="border-t border-green-200 pt-2 mt-2 space-y-1">
                            {invoiceDiscount.items
                              .filter(item => item.discount_amount > 0)
                              .map((item, idx) => (
                                <div key={idx} className="flex justify-between items-center text-xs">
                                  <span className="text-green-700 truncate max-w-[150px]" title={item.test_name}>
                                    {item.test_name}
                                  </span>
                                  <span className="text-green-600 font-medium">
                                    {item.discount_type === 'percent'
                                      ? `-${item.discount_value}%`
                                      : `-₹${item.discount_amount}`}
                                    {item.discount_reason && (
                                      <span className="text-green-500 ml-1">({item.discount_reason})</span>
                                    )}
                                  </span>
                                </div>
                              ))}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Net Amount (after discount) */}
                    {invoiceDiscount && invoiceDiscount.total_discount > 0 && (
                      <div className="flex justify-between items-center p-2 rounded bg-blue-50 border border-blue-100">
                        <span className="text-sm text-blue-700 font-medium">Net Amount</span>
                        <span className="font-bold text-blue-700 text-base">
                          ₹{invoiceDiscount.total_after_discount.toLocaleString()}
                        </span>
                      </div>
                    )}

                    {/* Paid Amount */}
                    <div className="flex justify-between items-center p-2 rounded hover:bg-gray-50 transition-colors">
                      <span className="text-sm text-gray-600 font-medium">Paid</span>
                      <span className="font-bold text-green-600 text-base">₹{(order.paid_amount || 0).toLocaleString()}</span>
                    </div>

                    {/* Due Amount */}
                    {!order.account_name && (
                      <div className="pt-3 border-t border-gray-100 flex justify-between items-center">
                        <span className="text-sm font-bold text-gray-900 uppercase tracking-tight">Due Amount</span>
                        <span className={`text-xl font-extrabold tracking-tight ${(currentDue || 0) > 0 ? 'text-red-500' : 'text-green-600'}`}>
                          ₹{(currentDue || 0).toLocaleString()}
                        </span>
                      </div>
                    )}

                    {/* B2B Badge if applicable */}
                    {order.account_name && (
                      <div className={`border text-xs px-3 py-2 rounded-lg text-center font-medium mt-2 ${order.account_billing_mode === 'monthly'
                        ? 'bg-purple-50 border-purple-200 text-purple-800'
                        : 'bg-indigo-50 border-indigo-200 text-indigo-800'
                        }`}>
                        {order.account_billing_mode === 'monthly' ? (
                          <>
                            <div className="flex items-center justify-center gap-1 mb-1">
                              <Building className="h-3 w-3" />
                              <span className="font-bold">Monthly Billing Account</span>
                            </div>
                            <div className="text-[10px] text-purple-600">
                              Billed to: {order.account_name}
                            </div>
                          </>
                        ) : (
                          <>
                            Billed to Account: <span className="font-bold">{order.account_name}</span>
                          </>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="grid grid-cols-1 gap-3">
                    {order.billing_status !== 'billed' && (
                      <>
                        {order.account_billing_mode === 'monthly' ? (
                          <div className="w-full flex items-center justify-center gap-2 bg-gray-100 text-gray-600 py-2.5 px-4 rounded-lg border border-gray-200 text-sm font-semibold">
                            <Building className="h-4 w-4" />
                            Monthly Consolidated Billing
                          </div>
                        ) : (
                          <>
                            <button
                              onClick={() => setShowInvoiceModal(true)}
                              className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-blue-600 to-blue-700 text-white py-2.5 rounded-lg hover:from-blue-700 hover:to-blue-800 transition-all text-sm font-bold shadow-md hover:shadow-lg active:scale-95 transform duration-150"
                            >
                              <DollarSign className="h-4 w-4" />
                              Create Invoice
                            </button>
                            <p className="text-xs text-gray-500 text-center">
                              💡 Discounts from Doctor, Location, or Account will be auto-applied during invoice creation
                            </p>
                          </>
                        )}
                      </>
                    )}

                    {/* Always show Pay button - will prompt to create invoice if needed */}
                    {(order.due_amount || 0) > 0 && !(order.account_name && order.account_billing_mode === 'monthly') && (
                      <button
                        onClick={() => {
                          if (!order.invoice_id && order.billing_status !== 'billed' && order.billing_status !== 'partial') {
                            // No invoice - ask to create first
                            const createFirst = window.confirm(
                              "No invoice found for this order.\n\nWould you like to create an invoice first?\n\nClick OK to create invoice, Cancel to go back."
                            );
                            if (createFirst) {
                              setShowInvoiceModal(true);
                            }
                          } else {
                            setShowPaymentModal(true);
                          }
                        }}
                        className={`w-full flex items-center justify-center gap-2 py-2.5 rounded-lg transition-all text-sm font-bold shadow-md hover:shadow-lg active:scale-95 transform duration-150 ${
                          order.billing_status === 'billed' || order.billing_status === 'partial'
                            ? 'bg-gradient-to-r from-green-600 to-green-700 text-white hover:from-green-700 hover:to-green-800'
                            : 'bg-purple-100 text-purple-700 hover:bg-purple-200 border border-purple-300'
                        }`}
                        title={order.billing_status !== 'billed' && order.billing_status !== 'partial' ? 'Will create invoice first' : 'Record payment'}
                      >
                        <CreditCard className="h-4 w-4" />
                        {order.billing_status !== 'billed' && order.billing_status !== 'partial' ? 'Pay (Create Invoice)' : 'Record Payment'}
                      </button>
                    )}

                    {order.billing_status === 'billed' && (
                      <>
                        {/* Post-creation discount edit */}
                        {order.invoice_id && (
                          <div className="w-full">
                            {!showDiscountEdit ? (
                              <button
                                onClick={() => setShowDiscountEdit(true)}
                                className="w-full flex items-center justify-center gap-2 bg-amber-50 border border-amber-200 text-amber-700 py-2 rounded-lg hover:bg-amber-100 transition-all text-sm font-medium"
                              >
                                <Tag className="h-3.5 w-3.5" />
                                Edit Discount
                              </button>
                            ) : (
                              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 space-y-2">
                                <p className="text-xs font-semibold text-amber-800">Edit Invoice Discount</p>
                                <input
                                  type="number"
                                  min={0}
                                  placeholder="Discount amount (₹)"
                                  value={discountInput}
                                  onChange={e => setDiscountInput(e.target.value)}
                                  className="w-full border border-amber-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-amber-500"
                                />
                                <input
                                  type="text"
                                  placeholder="Reason (optional)"
                                  value={discountReason}
                                  onChange={e => setDiscountReason(e.target.value)}
                                  className="w-full border border-amber-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-amber-500"
                                />
                                <p className="text-xs text-amber-600">
                                  ⚠ If payment already recorded, discount cannot exceed balance due.
                                </p>
                                <div className="flex gap-2">
                                  <button
                                    onClick={handleSaveDiscount}
                                    disabled={savingDiscount || !discountInput}
                                    className="flex-1 bg-amber-600 text-white text-xs py-1.5 rounded hover:bg-amber-700 disabled:opacity-50"
                                  >
                                    {savingDiscount ? 'Saving…' : 'Save & Regenerate'}
                                  </button>
                                  <button
                                    onClick={() => { setShowDiscountEdit(false); setDiscountInput(''); setDiscountReason(''); }}
                                    className="px-3 text-xs border border-amber-300 rounded hover:bg-amber-100"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        )}

                        {/* View PDF (if exists) */}
                        {order.invoice_id && (
                          <button
                            onClick={async () => {
                              try {
                                const { data: invoice } = await supabase
                                  .from('invoices')
                                  .select('pdf_url, pdf_generated_at')
                                  .eq('id', order.invoice_id)
                                  .single();

                                if (invoice?.pdf_url) {
                                  const cacheBuster = invoice.pdf_generated_at ? new Date(invoice.pdf_generated_at).getTime() : Date.now();
                                  window.open(`${invoice.pdf_url}?t=${cacheBuster}`, '_blank');
                                } else {
                                  alert('PDF not generated yet. Use Generate PDF button.');
                                }
                              } catch (err) {
                                console.error('Error checking PDF:', err);
                                alert('Failed to view PDF');
                              }
                            }}
                            className="w-full flex items-center justify-center gap-2 bg-indigo-600 text-white py-2.5 rounded-lg hover:bg-indigo-700 transition-all text-sm font-bold shadow-md hover:shadow-lg"
                          >
                            <FileText className="h-4 w-4" />
                            View PDF
                          </button>
                        )}

                        {/* Generate/Regenerate PDF */}
                        <button
                          onClick={() => {
                            if (order.invoice_id) {
                              setShowPdfModal(true);
                            } else {
                              alert('Please create an invoice first');
                            }
                          }}
                          className="w-full flex items-center justify-center gap-2 bg-white border-2 border-gray-200 text-gray-700 py-2.5 rounded-lg hover:bg-gray-50 hover:border-gray-300 transition-all text-sm font-bold group"
                        >
                          <File className="h-4 w-4 group-hover:text-green-600 transition-colors" />
                          Generate PDF
                        </button>

                        {/* Thermal Print Button */}
                        {order.invoice_id && (
                          <div className="w-full">
                            <ThermalPrintButton
                              invoiceId={order.invoice_id}
                              format="thermal_80mm"
                              variant="secondary"
                              size="md"
                              label="Print Thermal Slip"
                            />
                          </div>
                        )}

                        {/* Invoice Delivery Tracker */}
                        {order.invoice_id && (
                          <div className="w-full flex justify-center pt-2">
                            <InvoiceDeliveryTracker
                              invoiceId={order.invoice_id}
                              invoiceNumber={`INV-${order.id.slice(-6).toUpperCase()}`}
                              customerPhone={order.patient_phone || undefined}
                              customerEmail={order.patient?.email || undefined}
                              onDeliveryTracked={() => {
                                setInvoiceRefreshTrigger(prev => prev + 1);
                              }}
                            />
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </div>

            </div>
          </div>

          {/* Bottom Row: Status & Sample Collection */}
          <div className="border-t border-gray-100 pt-4 sm:pt-6">
            <h3 className="font-bold text-gray-900 mb-3 sm:mb-4 text-sm uppercase tracking-wide flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-blue-500" />
              Order Workflow
            </h3>

            <div className="flex flex-col md:flex-row gap-4 sm:gap-6">
              {/* Status Buttons */}
              <div className="flex-1 bg-gray-50 rounded-xl p-3 sm:p-4 border border-gray-200">
                <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3 block">Update Order Status</span>
                <QuickStatusButtons
                  orderId={order.id}
                  currentStatus={order.status}
                  onStatusChanged={() => onUpdateStatus(order.id, order.status)}
                />
              </div>

              {/* Sample Collection */}
              <div className="md:w-1/3">
                <div className="bg-white border border-gray-200 rounded-xl p-3 sm:p-4 shadow-sm h-full">
                  <h4 className="font-bold text-gray-900 mb-3 flex items-center gap-2 text-sm">
                    <TestTube className="h-4 w-4 text-purple-600" />
                    Sample Collection
                  </h4>
                  <SampleCollectionTracker
                    orderId={order.id}
                    showTitle={false}
                  />
                </div>
              </div>
            </div>
          </div>

        </div>
      </div>

      {showReportStudio && (
        <ReportDesignStudio
          orderId={order.id}
          onClose={() => setShowReportStudio(false)}
          onSuccess={(url) => {
            setLastGeneratedPdf(url);
            alert('Report Generated!');
            onUpdateStatus(order.id, 'Completed'); // Optimistic update
          }}
        />
      )}

      {showSendReport && (
        <SendReportModal
          orderId={order.id}
          patientName={order.patient_name}
          doctorName={order.doctor}
          doctorPhone={order.doctor_phone || ''}
          clinicalSummary={(order as any).ai_clinical_summary || undefined}
          reportUrl={lastGeneratedPdf || order.report_url}
          onClose={() => setShowSendReport(false)}
        />
      )}
      {/* Modals */}
      {showInvoiceModal && (
        <CreateInvoiceModal
          orderId={order.id}
          onClose={() => setShowInvoiceModal(false)}
          onSuccess={async () => {
            setShowInvoiceModal(false);
            // Refresh tests state to reflect billed status
            const { data: updatedTests } = await supabase
              .from('order_tests')
              .select('id, test_name, outsourced_lab_id, is_canceled, is_billed, invoice_id, outsourced_labs(name)')
              .eq('order_id', order.id);
            if (updatedTests) {
              setTests(updatedTests.map((t: any) => ({
                id: t.id,
                test_name: t.test_name,
                outsourced_lab_id: t.outsourced_lab_id,
                outsourced_labs: t.outsourced_labs,
                is_canceled: t.is_canceled,
                is_billed: t.is_billed,
                invoice_id: t.invoice_id
              })));
            }
            // Trigger a refresh in parent to update billing status
            onUpdateStatus(order.id, order.status);
          }}
        />
      )}

      {showPaymentModal && (
        <PaymentCapture
          orderId={order.id}
          onClose={() => setShowPaymentModal(false)}
          onSuccess={() => {
            setShowPaymentModal(false);
            // Trigger a refresh in parent to update payment status
            onUpdateStatus(order.id, order.status);
          }}
        />
      )}

      {/* Dispatch Modal */}
      {showDispatchModal && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md">
            <div className="flex items-center justify-between px-6 py-4 border-b">
              <h3 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
                <Truck className="h-5 w-5 text-amber-600" />
                Send Sample
              </h3>
              <button onClick={() => setShowDispatchModal(false)} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div className="bg-amber-50 border border-amber-100 rounded-lg p-3">
                <div className="text-sm text-amber-800">
                  <strong>From:</strong> {order.location || 'Collection Center'}
                </div>
                <div className="text-sm text-amber-800 mt-1">
                  <strong>Order:</strong> #{order.id.slice(-6)} - {order.patient_name}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Destination Location
                </label>
                <select
                  value={dispatchDestination}
                  onChange={(e) => setDispatchDestination(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-amber-500"
                >
                  {dispatchLocations.map(loc => (
                    <option key={loc.id} value={loc.id}>
                      {loc.name} {loc.is_processing_center ? '(Processing Center)' : ''}
                    </option>
                  ))}
                  {dispatchLocations.length === 0 && (
                    <option value="">No locations configured</option>
                  )}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Priority
                </label>
                <select
                  value={dispatchPriority}
                  onChange={(e) => setDispatchPriority(e.target.value as any)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                >
                  <option value="normal">Normal</option>
                  <option value="high">High</option>
                  <option value="urgent">Urgent</option>
                  <option value="low">Low</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Notes (optional)
                </label>
                <textarea
                  value={dispatchNotes}
                  onChange={(e) => setDispatchNotes(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                  rows={2}
                  placeholder="Any special instructions..."
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t bg-gray-50">
              <button
                onClick={() => setShowDispatchModal(false)}
                className="px-4 py-2 text-gray-700 hover:text-gray-900"
              >
                Cancel
              </button>
              <button
                onClick={handleDispatchToLab}
                disabled={dispatching || !dispatchDestination}
                className="flex items-center gap-2 px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-50"
              >
                {dispatching ? <Loader className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                Dispatch Now
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Outsource Modal */}
      {showOutsourceModal && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
            <h3 className="text-lg font-bold text-gray-900 mb-4 flex items-center gap-2">
              <Building className="h-5 w-5 text-purple-600" />
              Outsource Order
            </h3>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Select Lab</label>
                <select
                  value={selectedOutsourceLab}
                  onChange={(e) => setSelectedOutsourceLab(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
                >
                  <option value="">-- Select Lab --</option>
                  {outsourcedLabs.map(lab => (
                    <option key={lab.id} value={lab.id}>{lab.name}</option>
                  ))}
                </select>
              </div>

              <div className="bg-yellow-50 border border-yellow-100 rounded-lg p-3 text-sm text-yellow-800">
                <p>This will mark the order as outsourced and update its status.</p>
              </div>

              <div className="flex gap-3 pt-2">
                <button
                  onClick={handleOutsource}
                  disabled={!selectedOutsourceLab}
                  className="flex-1 bg-purple-600 text-white px-4 py-2 rounded-lg font-medium hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Confirm Outsource
                </button>
                <button
                  onClick={() => setShowOutsourceModal(false)}
                  className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 font-medium"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Add Test Modal */}
      {showAddTestModal && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg flex flex-col max-h-[80vh]">
            <div className="flex items-center justify-between px-6 py-4 border-b">
              <h3 className="text-lg font-bold text-gray-900 flex items-center gap-2">
                <Plus className="h-5 w-5 text-blue-600" />
                Add Test to Order
              </h3>
              <button
                onClick={() => setShowAddTestModal(false)}
                className="text-gray-400 hover:text-gray-600 p-1 rounded-full hover:bg-gray-100"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4 border-b bg-gray-50">
              <div className="relative">
                <Search className="w-4 h-4 text-gray-400 absolute left-3 top-3" />
                <input
                  ref={searchInputRef}
                  type="text"
                  placeholder="Search tests... (Press Enter to add)"
                  value={testSearch}
                  onChange={(e) => setTestSearch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && testSearch) {
                      const term = testSearch.toLowerCase();
                      const match = availableTests.find(t =>
                        t.name.toLowerCase().includes(term) ||
                        (t.code && t.code.toLowerCase().includes(term))
                      );
                      if (match) handleAddTest(match);
                    }
                  }}
                  className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                  autoFocus
                />
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-2">
              {availableTests.length === 0 ? (
                <div className="p-8 text-center text-gray-500">Loading tests...</div>
              ) : (
                <div className="space-y-1">
                  {availableTests
                    .filter(t => t.name.toLowerCase().includes(testSearch.toLowerCase()) || (t.code && t.code.toLowerCase().includes(testSearch.toLowerCase())))
                    .map(test => {
                      const isAdded = tests.some(t => t.test_name === test.name);
                      return (
                        <div
                          key={test.id}
                          className={`flex items-center justify-between p-3 rounded-lg border ${isAdded ? 'bg-blue-50 border-blue-200' : 'border-gray-100 hover:bg-gray-50'
                            }`}
                        >
                          <div>
                            <div className="font-semibold text-gray-900 text-sm">{test.name}</div>
                            <div className="text-xs text-gray-500">
                              {test.code ? `Code: ${test.code} • ` : ''}
                              {test.category || 'General'}
                            </div>
                            {test.type === 'package' && (
                              <span className="ml-2 px-1.5 py-0.5 rounded text-[10px] font-bold bg-purple-100 text-purple-700">PACKAGE</span>
                            )}
                          </div>
                          <div className="flex items-center gap-3">
                            <span className="font-bold text-gray-900 text-sm">₹{test.price}</span>
                            <button
                              onClick={() => !isAdded && handleAddTest(test)}
                              disabled={isAdded || isAddingTest}
                              className={`px-3 py-1.5 rounded-md text-xs font-bold transition-all ${isAdded
                                ? 'bg-blue-200 text-blue-800 cursor-default'
                                : 'bg-blue-600 text-white hover:bg-blue-700 shadow-sm'
                                }`}
                            >
                              {isAdded ? 'Added' : 'Add'}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  {availableTests.filter(t => t.name.toLowerCase().includes(testSearch.toLowerCase())).length === 0 && (
                    <div className="p-8 text-center text-gray-500">No tests found matching "{testSearch}"</div>
                  )}
                </div>
              )}
            </div>

            <div className="p-4 border-t bg-gray-50 flex justify-end">
              <button
                onClick={() => setShowAddTestModal(false)}
                className="px-4 py-2 bg-white border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 font-medium text-sm"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Invoice PDF Generation Modal */}
      {showPdfModal && order.invoice_id && (
        <InvoiceGenerationModal
          invoiceId={order.invoice_id}
          onClose={() => setShowPdfModal(false)}
          onSuccess={(pdfUrl) => {
            setShowPdfModal(false);
            // Refresh invoice data to show new PDF
            setInvoiceRefreshTrigger(prev => prev + 1);
            // Optionally open the PDF
            if (pdfUrl) {
              window.open(pdfUrl, '_blank');
            }
          }}
        />
      )}
    </div>,
    document.body
  );
};

export default DashboardOrderModal;

