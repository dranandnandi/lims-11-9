import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle, ChevronDown, Filter, Loader, Printer, RefreshCcw, Search, TestTube, X } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { collectSample, createReplacementSampleForRejected, rejectSample } from '../services/sampleService';
import { database, supabase } from '../utils/supabase';
import { useQZTray } from '../contexts/QZTrayContext';
import * as qzTrayService from '../utils/qzTrayService';
import type { AccessionCollectionConfig, AccessionFlowItem } from '../components/Settings/AccessionSettings';

type AccessionSample = {
  id: string;
  order_id: string;
  barcode: string | null;
  sample_type: string | null;
  status: string;
  created_at: string;
  collected_at?: string | null;
  received_at?: string | null;
  rejected_at?: string | null;
  rejection_reason?: string | null;
  pre_barcoded?: boolean | null;
  patient_name?: string | null;
  patient_gender?: string | null;
  patient_age?: string | number | null;
  order_display?: string | null;
  order_number?: number | null;
  doctor?: string | null;
  tests: string[];
};

type SampleConditionRow = {
  id: string;
  sample_id: string;
  test_name: string;
  options: string[];
  selected: string;
};

type CollectionModalState = {
  samples: AccessionSample[];
  index: number;
  action: 'collect' | 'reject';
  responses: Record<string, Record<string, string | boolean>>;
  conditions: Record<string, string>;
  rejectionReason: string;
  customRejectionReason: string;
};

type TestRow = {
  id: string;
  order_id: string;
  sample_id: string | null;
  test_name: string;
  sample_condition?: string | null;
  test_groups?: {
    sample_type?: string | null;
    sample_condition_options?: unknown;
    default_sample_condition?: string | null;
  } | null;
};

const collectableStatuses = new Set(['created']);
const visibleStatuses = ['created', 'collected', 'received', 'rejected'];
const rejectionReasons = [
  'Hemolyzed sample',
  'Insufficient quantity',
  'Clotted sample',
  'Leaking container',
  'Wrong container',
  'Unlabeled or mislabeled sample',
  'Sample too old',
  'Improper storage or transport',
  'Contaminated sample',
  'Other',
];

const Accession: React.FC = () => {
  const { user } = useAuth();
  const { settings, refreshSettings, connect } = useQZTray();
  const [samples, setSamples] = useState<AccessionSample[]>([]);
  const [accessionConfig, setAccessionConfig] = useState<AccessionCollectionConfig>({ sample_type_flows: {} });
  const [conditionRowsBySample, setConditionRowsBySample] = useState<Map<string, SampleConditionRow[]>>(new Map());
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'created' | 'collected' | 'received' | 'rejected'>('all');
  const [sampleTypeFilter, setSampleTypeFilter] = useState('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [collecting, setCollecting] = useState(false);
  const [printingId, setPrintingId] = useState<string | null>(null);
  const [collectionModal, setCollectionModal] = useState<CollectionModalState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const fetchSamples = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      setNotice(null);
      const labId = await database.getCurrentUserLabId();
      if (!labId) throw new Error('Lab context unavailable');

      const { data: sampleRows, error: sampleError } = await supabase
        .from('samples')
        .select('id, order_id, barcode, sample_type, status, created_at, collected_at, received_at, rejected_at, rejection_reason, pre_barcoded')
        .eq('lab_id', labId)
        .in('status', visibleStatuses)
        .order('created_at', { ascending: false })
        .limit(200);

      if (sampleError) throw sampleError;

      const orderIds = Array.from(new Set((sampleRows || []).map((sample: any) => sample.order_id).filter(Boolean)));
      const [ordersResult, groupTestsResult, orderTestsResult] = await Promise.all([
        orderIds.length
          ? supabase
              .from('orders')
              .select('id, patient_name, order_display, order_number, doctor, patients(age, gender)')
              .in('id', orderIds)
          : Promise.resolve({ data: [], error: null } as any),
        orderIds.length
          ? supabase
              .from('order_test_groups')
              .select('id, order_id, sample_id, test_name, sample_condition, test_groups(sample_type, sample_condition_options, default_sample_condition)')
              .in('order_id', orderIds)
          : Promise.resolve({ data: [], error: null } as any),
        orderIds.length
          ? supabase
              .from('order_tests')
              .select('id, order_id, sample_id, test_name, test_groups(sample_type)')
              .in('order_id', orderIds)
              .eq('is_canceled', false)
          : Promise.resolve({ data: [], error: null } as any),
      ]);

      if (ordersResult.error) throw ordersResult.error;
      if (groupTestsResult.error) throw groupTestsResult.error;
      if (orderTestsResult.error) throw orderTestsResult.error;

      const ordersById = new Map((ordersResult.data || []).map((order: any) => [order.id, order]));
      const sampleRowsById = new Map((sampleRows || []).map((sample: any) => [sample.id, sample]));
      const testsBySampleId = new Map<string, string[]>();
      const conditionRows = new Map<string, SampleConditionRow[]>();
      const addTestToSample = (sampleId: string, testName: string) => {
        if (!sampleId || !testName) return;
        const existing = testsBySampleId.get(sampleId) || [];
        if (existing.includes(testName)) return;
        existing.push(testName);
        testsBySampleId.set(sampleId, existing);
      };
      const findMatchingSamples = (row: TestRow) => {
        const rowSampleType = String(row.test_groups?.sample_type || '').trim().toLowerCase();
        return (sampleRows || []).filter((sample: any) => {
          if (sample.order_id !== row.order_id) return false;
          if (!rowSampleType) return true;
          return String(sample.sample_type || '').trim().toLowerCase() === rowSampleType;
        });
      };
      const groupRows: TestRow[] = groupTestsResult.data || [];
      const orderRows: TestRow[] = orderTestsResult.data || [];

      groupRows.forEach((row) => {
        const directSampleId = row.sample_id && sampleRowsById.has(row.sample_id) ? row.sample_id : null;
        const targetSamples = directSampleId ? [{ id: directSampleId }] : findMatchingSamples(row);
        targetSamples.forEach((sample: any) => addTestToSample(sample.id, row.test_name));

        if (!directSampleId) return;

        const options = Array.isArray(row.test_groups?.sample_condition_options)
          ? row.test_groups.sample_condition_options.map((value: unknown) => String(value || '').trim()).filter(Boolean)
          : [];
        if (options.length > 0) {
          const defaultCondition = String(row.test_groups?.default_sample_condition || '').trim();
          const selected = String(row.sample_condition || '').trim()
            || (options.includes(defaultCondition) ? defaultCondition : options[0]);
          const rows = conditionRows.get(directSampleId) || [];
          rows.push({
            id: row.id,
            sample_id: directSampleId,
            test_name: row.test_name || 'Test',
            options,
            selected,
          });
          conditionRows.set(directSampleId, rows);
        }
      });

      orderRows.forEach((row) => {
        const directSampleId = row.sample_id && sampleRowsById.has(row.sample_id) ? row.sample_id : null;
        const targetSamples = directSampleId ? [{ id: directSampleId }] : findMatchingSamples(row);
        targetSamples.forEach((sample: any) => addTestToSample(sample.id, row.test_name));
      });
      setConditionRowsBySample(conditionRows);

      const { data: labSettings } = await supabase
        .from('labs')
        .select('accession_collection_config')
        .eq('id', labId)
        .single();
      setAccessionConfig((labSettings as any)?.accession_collection_config || { sample_type_flows: {} });

      setSamples((sampleRows || []).map((sample: any) => {
        const order = ordersById.get(sample.order_id) as any;
        return {
          ...sample,
          patient_name: order?.patient_name || null,
          patient_gender: order?.patients?.gender || null,
          patient_age: order?.patients?.age ?? null,
          order_display: order?.order_display || null,
          order_number: order?.order_number || null,
          doctor: order?.doctor || null,
          tests: testsBySampleId.get(sample.id) || [],
        };
      }));
    } catch (err: any) {
      setError(err.message || 'Failed to load accession samples');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSamples();
  }, [fetchSamples]);

  const sampleTypeOptions = useMemo(() => {
    return Array.from(new Set(samples.map((sample) => sample.sample_type || 'Sample'))).sort();
  }, [samples]);

  const hasActiveFilters =
    query.trim() !== '' ||
    statusFilter !== 'all' ||
    sampleTypeFilter !== 'all' ||
    dateFrom !== '' ||
    dateTo !== '';

  const filteredSamples = useMemo(() => {
    const term = query.trim().toLowerCase();
    return samples.filter((sample) => {
      if (statusFilter !== 'all' && sample.status !== statusFilter) return false;
      if (sampleTypeFilter !== 'all' && (sample.sample_type || 'Sample') !== sampleTypeFilter) return false;

      const createdDate = sample.created_at ? new Date(sample.created_at) : null;
      if (dateFrom && createdDate && createdDate < new Date(`${dateFrom}T00:00:00`)) return false;
      if (dateTo && createdDate && createdDate > new Date(`${dateTo}T23:59:59`)) return false;

      if (!term) return true;
      const haystack = [
        sample.id,
        sample.barcode,
        sample.patient_name,
        sample.order_display,
        sample.order_number,
        sample.sample_type,
        sample.status,
        sample.doctor,
        ...sample.tests,
      ].join(' ').toLowerCase();
      return haystack.includes(term);
    });
  }, [dateFrom, dateTo, query, sampleTypeFilter, samples, statusFilter]);

  const clearFilters = () => {
    setQuery('');
    setStatusFilter('all');
    setSampleTypeFilter('all');
    setDateFrom('');
    setDateTo('');
  };

  const getFlowItems = (sample: AccessionSample): AccessionFlowItem[] => {
    const sampleType = sample.sample_type || 'Sample';
    return accessionConfig.sample_type_flows?.[sampleType]?.items || [];
  };

  const getSampleResponse = (sampleId: string, fieldId: string) =>
    collectionModal?.responses[sampleId]?.[fieldId];

  const setSampleResponse = (sampleId: string, fieldId: string, value: string | boolean) => {
    setCollectionModal((current) => current ? {
      ...current,
      responses: {
        ...current.responses,
        [sampleId]: {
          ...(current.responses[sampleId] || {}),
          [fieldId]: value,
        },
      },
    } : current);
  };

  const setModalCondition = (conditionRowId: string, value: string) => {
    setCollectionModal((current) => current ? {
      ...current,
      conditions: {
        ...current.conditions,
        [conditionRowId]: value,
      },
    } : current);
  };

  const setAllBooleanChecksForCurrentSample = () => {
    if (!collectionModal) return;
    const sample = collectionModal.samples[collectionModal.index];
    if (!sample) return;
    const updates = Object.fromEntries(
      getFlowItems(sample)
        .filter((item) => item.type === 'boolean')
        .map((item) => [item.id, item.passValue === 'no' ? false : true]),
    );
    setCollectionModal({
      ...collectionModal,
      responses: {
        ...collectionModal.responses,
        [sample.id]: {
          ...(collectionModal.responses[sample.id] || {}),
          ...updates,
        },
      },
    });
  };

  const selectedSamples = filteredSamples.filter((sample) => selectedIds.has(sample.id));
  const selectedPendingSamples = selectedSamples.filter((sample) => collectableStatuses.has(sample.status));
  const canCollectSelected = selectedPendingSamples.length > 0;

  const openCollectionModal = (pending: AccessionSample[], action: 'collect' | 'reject' = 'collect') => {
    if (pending.length === 0) return;

    const conditionDefaults: Record<string, string> = {};
    pending.forEach((sample) => {
      (conditionRowsBySample.get(sample.id) || []).forEach((row) => {
        conditionDefaults[row.id] = row.selected;
      });
    });

    setCollectionModal({
      samples: pending,
      index: 0,
      action,
      responses: {},
      conditions: conditionDefaults,
      rejectionReason: rejectionReasons[0],
      customRejectionReason: '',
    });
  };

  const toggleSample = (sampleId: string) => {
    const sample = samples.find((item) => item.id === sampleId);
    if (sample && !collectableStatuses.has(sample.status)) return;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(sampleId)) next.delete(sampleId);
      else next.add(sampleId);
      return next;
    });
  };

  const printSampleLabel = async (sample: AccessionSample) => {
    const label = {
      sampleId: sample.barcode || sample.id,
      labelId: sample.id,
      patientName: sample.patient_name || 'Sample',
      sampleType: sample.sample_type || 'Sample',
      date: new Date(sample.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }).replace(/ /g, '-'),
      gender: sample.patient_gender || undefined,
      age: sample.patient_age != null && String(sample.patient_age).trim() !== '' ? String(sample.patient_age) : undefined,
      referredBy: sample.doctor && sample.doctor !== 'Self' ? sample.doctor : undefined,
    };

    try {
      setPrintingId(sample.id);
      setError(null);
      setNotice(null);
      let printerName = settings.barcodePrinterName;
      let browserPrint = settings.barcodeBrowserPrintEnabled;
      if (!printerName) {
        const refreshed = await refreshSettings();
        printerName = refreshed.barcodePrinterName;
        browserPrint = refreshed.barcodeBrowserPrintEnabled;
      }

      if (!printerName || browserPrint) {
        qzTrayService.printBarcodeLabelsInBrowser([label], printerName);
        return;
      }

      if (!qzTrayService.isConnected()) await connect();
      await qzTrayService.printBarcodeLabel(printerName, label);
    } catch (err: any) {
      setError(err.message || 'Failed to print barcode label');
    } finally {
      setPrintingId(null);
    }
  };

  const collectSelected = async () => {
    const collectorId = user?.id;
    if (!collectorId) {
      setError('User not authenticated');
      return;
    }

    const pending = samples.filter((sample) => selectedIds.has(sample.id) && collectableStatuses.has(sample.status));
    if (pending.length === 0) return;

    openCollectionModal(pending, 'collect');
  };

  const currentModalSample = collectionModal?.samples[collectionModal.index] || null;

  const validateCurrentSample = () => {
    if (!collectionModal || !currentModalSample) return 'No sample selected';
    if (collectionModal.action === 'reject') {
      const reason = collectionModal.rejectionReason === 'Other'
        ? collectionModal.customRejectionReason.trim()
        : collectionModal.rejectionReason.trim();
      return reason ? null : 'Please enter a rejection reason.';
    }
    const responses = collectionModal.responses[currentModalSample.id] || {};
    const missing = getFlowItems(currentModalSample).filter((item) => {
      if (item.required === false) return false;
      const value = responses[item.id];
      if (item.type === 'boolean') return value !== (item.passValue === 'no' ? false : true);
      return String(value || '').trim() === '';
    });
    if (missing.length > 0) return `Please complete: ${missing.map((item) => item.label).join(', ')}`;
    return null;
  };

  const collectCurrentModalSample = async () => {
    const collectorId = user?.id;
    if (!collectorId || !collectionModal || !currentModalSample) return;

    const validation = validateCurrentSample();
    if (validation) {
      setError(validation);
      return;
    }

    try {
      setCollecting(true);
      setError(null);
      setNotice(null);

      const conditionRows = conditionRowsBySample.get(currentModalSample.id) || [];
      if (conditionRows.length > 0) {
        await Promise.all(conditionRows.map((row) => supabase
          .from('order_test_groups')
          .update({ sample_condition: collectionModal.conditions[row.id] || null })
          .eq('id', row.id)));

        const selectedConditions = conditionRows
          .map((row) => collectionModal.conditions[row.id])
          .filter(Boolean);
        const uniqueConditions = Array.from(new Set(selectedConditions));
        await supabase
          .from('samples')
          .update({ sample_condition: uniqueConditions.length === 1 ? uniqueConditions[0] : null })
          .eq('id', currentModalSample.id);
      }

      const flowItems = getFlowItems(currentModalSample);
      const response = collectionModal.responses[currentModalSample.id] || {};
      const rejectReason = collectionModal.rejectionReason === 'Other'
        ? collectionModal.customRejectionReason.trim()
        : collectionModal.rejectionReason.trim();
      const checklistCompleted = Object.fromEntries(
        flowItems
          .filter((item) => item.type === 'boolean')
          .map((item) => [item.label, response[item.id] === true]),
      );

      const { error: sampleUpdateError } = await supabase
        .from('samples')
        .update({
          checklist_completed: checklistCompleted,
          collection_form_response: {
            sample_type: currentModalSample.sample_type || 'Sample',
            accession_action: collectionModal.action,
            responses: flowItems.map((item) => ({
              id: item.id,
              label: item.label,
              type: item.type,
              value: response[item.id] ?? null,
            })),
            sample_conditions: conditionRows.map((row) => ({
              order_test_group_id: row.id,
              test_name: row.test_name,
              value: collectionModal.conditions[row.id] || null,
            })),
            rejection_reason: collectionModal.action === 'reject' ? rejectReason : null,
          },
        })
        .eq('id', currentModalSample.id);
      if (sampleUpdateError) throw sampleUpdateError;

      if (collectionModal.action === 'reject') {
        await rejectSample(currentModalSample.id, rejectReason, collectorId);
      } else {
        await collectSample(currentModalSample.id, collectorId);
      }

      const nextIndex = collectionModal.index + 1;
      if (nextIndex < collectionModal.samples.length) {
        setCollectionModal({
          ...collectionModal,
          index: nextIndex,
          action: 'collect',
          rejectionReason: rejectionReasons[0],
          customRejectionReason: '',
        });
      } else {
        setCollectionModal(null);
        setSelectedIds(new Set());
        await fetchSamples();
      }
    } catch (err: any) {
      setError(err.message || 'Failed to mark sample collected');
    } finally {
      setCollecting(false);
    }
  };

  const receiveFreshSample = async (sample: AccessionSample) => {
    const collectorId = user?.id;
    if (!collectorId) {
      setError('User not authenticated');
      return;
    }

    try {
      setCollecting(true);
      setError(null);
      setNotice(null);
      const newSample = await createReplacementSampleForRejected(sample.id, collectorId);
      const { data: newConditionRows } = await supabase
        .from('order_test_groups')
        .select('id, sample_id, test_name, sample_condition, test_groups(sample_condition_options, default_sample_condition)')
        .eq('sample_id', newSample.id);
      const modalConditionRows: SampleConditionRow[] = [];
      const modalConditionDefaults: Record<string, string> = {};
      (newConditionRows || []).forEach((row: any) => {
        const options = Array.isArray(row.test_groups?.sample_condition_options)
          ? row.test_groups.sample_condition_options.map((value: unknown) => String(value || '').trim()).filter(Boolean)
          : [];
        if (options.length === 0) return;
        const defaultCondition = String(row.test_groups?.default_sample_condition || '').trim();
        const selected = String(row.sample_condition || '').trim()
          || (options.includes(defaultCondition) ? defaultCondition : options[0]);
        modalConditionRows.push({
          id: row.id,
          sample_id: row.sample_id,
          test_name: row.test_name || 'Test',
          options,
          selected,
        });
        modalConditionDefaults[row.id] = selected;
      });
      if (modalConditionRows.length > 0) {
        setConditionRowsBySample((current) => {
          const next = new Map(current);
          next.set(newSample.id, modalConditionRows);
          return next;
        });
      }

      const modalSample: AccessionSample = {
        ...sample,
        id: newSample.id,
        barcode: newSample.barcode,
        status: 'created',
        created_at: newSample.created_at,
        collected_at: null,
        received_at: null,
        rejected_at: null,
        rejection_reason: null,
        pre_barcoded: false,
      };
      setSelectedIds(new Set([newSample.id]));
      await fetchSamples();
      setCollectionModal({
        samples: [modalSample],
        index: 0,
        action: 'collect',
        responses: {},
        conditions: modalConditionDefaults,
        rejectionReason: rejectionReasons[0],
        customRejectionReason: '',
      });
      setNotice(`Fresh sample created with barcode ${newSample.barcode || newSample.id}.`);
    } catch (err: any) {
      setError(err.message || 'Failed to receive fresh sample');
    } finally {
      setCollecting(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Accession</h1>
          <p className="text-sm text-gray-500">Scan pre-barcoded tubes, verify order details, and mark samples collected.</p>
        </div>
        <button
          type="button"
          onClick={fetchSamples}
          disabled={loading}
          className="inline-flex items-center justify-center gap-2 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
        >
          <RefreshCcw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              autoFocus
              placeholder="Scan barcode or search patient, order, sample..."
              className="w-full rounded-md border border-gray-300 py-2 pl-9 pr-9 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={collectSelected}
            disabled={collecting || !canCollectSelected}
            className="inline-flex items-center justify-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {collecting ? <Loader className="h-4 w-4 animate-spin" /> : <CheckCircle className="h-4 w-4" />}
            Mark Collected ({selectedPendingSamples.length})
          </button>
          <button
            type="button"
            onClick={() => openCollectionModal(selectedPendingSamples, 'reject')}
            disabled={collecting || !canCollectSelected}
            className="inline-flex items-center justify-center rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Reject Selected ({selectedPendingSamples.length})
          </button>
        </div>
        <div className="mt-3 grid gap-3 border-t border-gray-100 pt-3 md:grid-cols-5">
          <label className="block text-xs font-medium uppercase tracking-wide text-gray-500">
            Status
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as 'all' | 'created' | 'collected' | 'received' | 'rejected')}
              className="mt-1 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm normal-case text-gray-700 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="all">All statuses</option>
              <option value="created">Pending</option>
              <option value="collected">Collected</option>
              <option value="received">Received</option>
              <option value="rejected">Rejected</option>
            </select>
          </label>
          <label className="block text-xs font-medium uppercase tracking-wide text-gray-500">
            Sample
            <select
              value={sampleTypeFilter}
              onChange={(event) => setSampleTypeFilter(event.target.value)}
              className="mt-1 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm normal-case text-gray-700 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="all">All samples</option>
              {sampleTypeOptions.map((sampleType) => (
                <option key={sampleType} value={sampleType}>{sampleType}</option>
              ))}
            </select>
          </label>
          <label className="block text-xs font-medium uppercase tracking-wide text-gray-500">
            From
            <input
              type="date"
              value={dateFrom}
              onChange={(event) => setDateFrom(event.target.value)}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm normal-case text-gray-700 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </label>
          <label className="block text-xs font-medium uppercase tracking-wide text-gray-500">
            To
            <input
              type="date"
              value={dateTo}
              onChange={(event) => setDateTo(event.target.value)}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm normal-case text-gray-700 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </label>
          <div className="flex items-end">
            <button
              type="button"
              onClick={clearFilters}
              disabled={!hasActiveFilters}
              className="inline-flex w-full items-center justify-center gap-2 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Filter className="h-4 w-4" />
              Clear Filters
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}
      {notice && (
        <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">{notice}</div>
      )}

      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
        <div className="border-b border-gray-200 px-4 py-3 text-sm text-gray-600">
          Showing {filteredSamples.length} samples. Select pending rows and mark collected or rejected.
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="w-10 px-4 py-3"></th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">Barcode</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">Patient</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">Sample</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">Tests</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">Status</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-sm text-gray-500">
                    <Loader className="mx-auto mb-2 h-5 w-5 animate-spin text-blue-600" />
                    Loading samples...
                  </td>
                </tr>
              ) : filteredSamples.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-sm text-gray-500">No samples found.</td>
                </tr>
              ) : (
                filteredSamples.map((sample) => {
                  const isCollectable = collectableStatuses.has(sample.status);
                  return (
                  <tr key={sample.id} className={selectedIds.has(sample.id) ? 'bg-blue-50' : 'hover:bg-gray-50'}>
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(sample.id)}
                        disabled={!isCollectable}
                        onChange={() => toggleSample(sample.id)}
                        className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
                      />
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-mono text-sm font-medium text-gray-900">{sample.barcode || sample.id}</div>
                      {sample.pre_barcoded && <div className="text-xs text-blue-600">Pre-barcoded</div>}
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-sm font-medium text-gray-900">{sample.patient_name || 'Unknown patient'}</div>
                      <div className="text-xs text-gray-500">{sample.order_display || (sample.order_number ? `Order #${sample.order_number}` : sample.order_id)}</div>
                      {sample.doctor && sample.doctor !== 'Self' && <div className="text-xs text-gray-500">Dr. {sample.doctor}</div>}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2 text-sm text-gray-700">
                        <TestTube className="h-4 w-4 text-gray-400" />
                        {sample.sample_type || 'Sample'}
                      </div>
                      <div className="font-mono text-xs text-gray-400">{sample.id}</div>
                    </td>
                    <td className="max-w-sm px-4 py-3 text-sm text-gray-600">
                      {sample.tests.length > 0 ? sample.tests.join(', ') : 'No linked tests'}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${
                        sample.status === 'rejected'
                          ? 'bg-red-100 text-red-700'
                          : sample.status === 'received'
                            ? 'bg-blue-100 text-blue-700'
                            : sample.status === 'collected'
                          ? 'bg-green-100 text-green-700'
                          : 'bg-amber-100 text-amber-700'
                      }`}>
                        {sample.status === 'rejected'
                          ? 'Rejected'
                          : sample.status === 'received'
                            ? 'Received'
                            : sample.status === 'collected'
                              ? 'Collected'
                              : 'Pending'}
                      </span>
                      {sample.rejection_reason && (
                        <div className="mt-1 max-w-[220px] text-xs text-red-600">{sample.rejection_reason}</div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {isCollectable && (
                          <>
                            <button
                              type="button"
                              onClick={() => openCollectionModal([sample], 'collect')}
                              disabled={collecting}
                              className="rounded-md border border-green-200 bg-green-50 px-2.5 py-1.5 text-xs font-medium text-green-700 hover:bg-green-100 disabled:opacity-60"
                            >
                              Collect
                            </button>
                            <button
                              type="button"
                              onClick={() => openCollectionModal([sample], 'reject')}
                              disabled={collecting}
                              className="rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-60"
                            >
                              Reject
                            </button>
                          </>
                        )}
                        <button
                          type="button"
                          onClick={() => printSampleLabel(sample)}
                          disabled={printingId === sample.id || !sample.barcode}
                          className="inline-flex items-center justify-center rounded-md border border-gray-300 bg-white p-2 text-gray-600 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                          title="Print barcode label"
                        >
                          {printingId === sample.id ? <Loader className="h-4 w-4 animate-spin" /> : <Printer className="h-4 w-4" />}
                        </button>
                        {sample.status === 'rejected' && (
                          <button
                            type="button"
                            onClick={() => receiveFreshSample(sample)}
                            disabled={collecting}
                            className="rounded-md border border-green-200 bg-green-50 px-2.5 py-1.5 text-xs font-medium text-green-700 hover:bg-green-100 disabled:opacity-60"
                          >
                            Fresh Sample
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {collectionModal && currentModalSample && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg bg-white shadow-xl">
            <div className="flex items-start justify-between border-b border-gray-200 px-5 py-4">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Collect Sample</h2>
                <p className="mt-1 text-sm text-gray-500">
                  {collectionModal.index + 1} of {collectionModal.samples.length} · {currentModalSample.patient_name || 'Unknown patient'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setCollectionModal(null)}
                className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
              <div className="rounded-md border border-gray-200 bg-gray-50 p-3">
                <div className="font-mono text-sm font-semibold text-gray-900">{currentModalSample.barcode || currentModalSample.id}</div>
                <div className="mt-1 text-sm text-gray-600">
                  {currentModalSample.sample_type || 'Sample'} · {currentModalSample.tests.length > 0 ? currentModalSample.tests.join(', ') : 'No linked tests'}
                </div>
              </div>

              <div className="rounded-md border border-gray-200 bg-white p-3">
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setCollectionModal((current) => current ? { ...current, action: 'collect' } : current)}
                    className={`rounded-md px-3 py-2 text-sm font-medium ${
                      collectionModal.action === 'collect'
                        ? 'bg-green-600 text-white'
                        : 'border border-gray-300 text-gray-700 hover:bg-gray-50'
                    }`}
                  >
                    Collected
                  </button>
                  <button
                    type="button"
                    onClick={() => setCollectionModal((current) => current ? { ...current, action: 'reject' } : current)}
                    className={`rounded-md px-3 py-2 text-sm font-medium ${
                      collectionModal.action === 'reject'
                        ? 'bg-red-600 text-white'
                        : 'border border-gray-300 text-gray-700 hover:bg-gray-50'
                    }`}
                  >
                    Rejected
                  </button>
                </div>
              </div>

              {(conditionRowsBySample.get(currentModalSample.id) || []).length > 0 && (
                <div className="rounded-md border border-blue-200 bg-blue-50 p-3">
                  <h3 className="text-sm font-semibold text-blue-900">Sample condition</h3>
                  <div className="mt-3 space-y-2">
                    {(conditionRowsBySample.get(currentModalSample.id) || []).map((row) => (
                      <label key={row.id} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_220px] sm:items-center">
                        <span className="truncate text-sm text-blue-900">{row.test_name}</span>
                        <span className="relative">
                          <select
                            value={collectionModal.conditions[row.id] || row.selected}
                            onChange={(event) => setModalCondition(row.id, event.target.value)}
                            className="w-full appearance-none rounded-md border border-blue-200 bg-white px-3 py-2 pr-8 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                          >
                            {row.options.map((option) => (
                              <option key={option} value={option}>{option}</option>
                            ))}
                          </select>
                          <ChevronDown className="pointer-events-none absolute right-2 top-2.5 h-4 w-4 text-blue-400" />
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {getFlowItems(currentModalSample).length > 0 ? (
                <div className="rounded-md border border-amber-200 bg-amber-50 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-sm font-semibold text-amber-900">Collection checks</h3>
                    <button
                      type="button"
                      onClick={setAllBooleanChecksForCurrentSample}
                      className="rounded-md border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-100"
                    >
                      Select All
                    </button>
                  </div>
                  <div className="mt-3 space-y-3">
                    {getFlowItems(currentModalSample).map((item) => {
                      const value = getSampleResponse(currentModalSample.id, item.id);
                      if (item.type === 'select') {
                        return (
                          <label key={item.id} className="block">
                            <span className="text-sm font-medium text-amber-950">{item.label}</span>
                            <select
                              value={String(value || '')}
                              onChange={(event) => setSampleResponse(currentModalSample.id, item.id, event.target.value)}
                              className="mt-1 w-full rounded-md border border-amber-200 bg-white px-3 py-2 text-sm focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-500"
                            >
                              <option value="">Select...</option>
                              {(item.options || []).map((option) => (
                                <option key={option} value={option}>{option}</option>
                              ))}
                            </select>
                          </label>
                        );
                      }
                      if (item.type === 'text') {
                        return (
                          <label key={item.id} className="block">
                            <span className="text-sm font-medium text-amber-950">{item.label}</span>
                            <input
                              value={String(value || '')}
                              onChange={(event) => setSampleResponse(currentModalSample.id, item.id, event.target.value)}
                              className="mt-1 w-full rounded-md border border-amber-200 bg-white px-3 py-2 text-sm focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-500"
                            />
                          </label>
                        );
                      }
                      const checked = value === true;
                      return (
                        <label key={item.id} className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(event) => setSampleResponse(currentModalSample.id, item.id, event.target.checked)}
                            className="h-4 w-4 rounded border-gray-300 text-green-600 focus:ring-green-500"
                          />
                          <span className="text-sm text-amber-950">{item.label}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div className="rounded-md border border-gray-200 bg-gray-50 p-3 text-sm text-gray-500">
                  No sample-type checks configured for {currentModalSample.sample_type || 'Sample'}.
                </div>
              )}

              {collectionModal.action === 'reject' && (
                <div className="rounded-md border border-red-200 bg-red-50 p-3">
                  <h3 className="text-sm font-semibold text-red-900">Rejection reason</h3>
                  <div className="mt-3 space-y-3">
                    <select
                      value={collectionModal.rejectionReason}
                      onChange={(event) => setCollectionModal((current) => current ? {
                        ...current,
                        rejectionReason: event.target.value,
                      } : current)}
                      className="w-full rounded-md border border-red-200 bg-white px-3 py-2 text-sm focus:border-red-500 focus:outline-none focus:ring-2 focus:ring-red-500"
                    >
                      {rejectionReasons.map((reason) => (
                        <option key={reason} value={reason}>{reason}</option>
                      ))}
                    </select>
                    <textarea
                      value={collectionModal.customRejectionReason}
                      onChange={(event) => setCollectionModal((current) => current ? {
                        ...current,
                        customRejectionReason: event.target.value,
                      } : current)}
                      placeholder={collectionModal.rejectionReason === 'Other' ? 'Enter rejection reason' : 'Additional notes, optional'}
                      rows={3}
                      className="w-full rounded-md border border-red-200 bg-white px-3 py-2 text-sm focus:border-red-500 focus:outline-none focus:ring-2 focus:ring-red-500"
                    />
                  </div>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between gap-3 border-t border-gray-200 bg-gray-50 px-5 py-3">
              <button
                type="button"
                onClick={() => setCollectionModal(null)}
                className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={collectCurrentModalSample}
                disabled={collecting}
                className={`inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium text-white disabled:opacity-60 ${
                  collectionModal.action === 'reject' ? 'bg-red-600 hover:bg-red-700' : 'bg-green-600 hover:bg-green-700'
                }`}
              >
                {collecting ? <Loader className="h-4 w-4 animate-spin" /> : <CheckCircle className="h-4 w-4" />}
                {collectionModal.action === 'reject'
                  ? (collectionModal.index + 1 < collectionModal.samples.length ? 'Reject & Next' : 'Reject')
                  : (collectionModal.index + 1 < collectionModal.samples.length ? 'Collect & Next' : 'Collect')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Accession;
