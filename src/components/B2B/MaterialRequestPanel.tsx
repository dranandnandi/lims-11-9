import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    AlertCircle,
    Check,
    ChevronDown,
    Loader2,
    Package,
    Plus,
    RefreshCw,
    Search,
    Send,
    Trash2,
    X,
} from 'lucide-react';
import {
    CatalogItem,
    MATERIAL_REQUEST_STATUS_LABELS,
    MaterialRequest,
    MaterialRequestItem,
    MaterialRequestStatus,
    PartnerViewer,
    cancelMaterialRequest,
    createMaterialRequest,
    fetchMaterialRequests,
    fetchPartnerCatalog,
    getPartnerViewer,
    updateMaterialRequestStatus,
} from '../../utils/partnerCommsService';

interface MaterialRequestPanelProps {
    accountId: string;
    labId: string;
    /** 'account' shows the request builder, 'lab' shows the fulfilment controls */
    mode: 'account' | 'lab';
}

interface DraftLine extends MaterialRequestItem {
    key: string;
}

const STATUS_STYLES: Record<MaterialRequestStatus, string> = {
    requested: 'bg-amber-100 text-amber-800',
    approved: 'bg-blue-100 text-blue-800',
    dispatched: 'bg-indigo-100 text-indigo-800',
    delivered: 'bg-green-100 text-green-800',
    rejected: 'bg-red-100 text-red-800',
    cancelled: 'bg-gray-100 text-gray-700',
};

const LAB_NEXT_STATUSES: MaterialRequestStatus[] = ['approved', 'dispatched', 'delivered', 'rejected'];

const formatDate = (value?: string | null) => {
    if (!value) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '-';
    return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

const MaterialRequestPanel: React.FC<MaterialRequestPanelProps> = ({ accountId, labId, mode }) => {
    const [viewer, setViewer] = useState<PartnerViewer | null>(null);
    const [catalog, setCatalog] = useState<CatalogItem[]>([]);
    const [requests, setRequests] = useState<MaterialRequest[]>([]);
    const [loading, setLoading] = useState(true);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);

    // Request builder (partner side)
    const [showBuilder, setShowBuilder] = useState(false);
    const [catalogSearch, setCatalogSearch] = useState('');
    const [lines, setLines] = useState<DraftLine[]>([]);
    const [notes, setNotes] = useState('');
    const [neededBy, setNeededBy] = useState('');

    // Fulfilment (lab side)
    const [remarksDraft, setRemarksDraft] = useState<Record<string, string>>({});
    const [updatingId, setUpdatingId] = useState<string | null>(null);

    const customLineCounter = useRef(0);

    const loadData = useCallback(async () => {
        if (!accountId) return;
        setLoading(true);
        try {
            const [catalogItems, requestRows] = await Promise.all([
                // Only the partner side builds requests, so only it needs the catalog
                labId && mode === 'account'
                    ? fetchPartnerCatalog(labId, { allowFallback: false })
                    : Promise.resolve([]),
                fetchMaterialRequests({ accountId }),
            ]);
            setCatalog(catalogItems);
            setRequests(requestRows);
            setError(null);
        } catch (err: any) {
            console.error('Error loading material requests:', err);
            setError(err.message || 'Could not load material requests');
        } finally {
            setLoading(false);
        }
    }, [accountId, labId, mode]);

    useEffect(() => {
        let active = true;
        getPartnerViewer().then((result) => {
            if (active) setViewer(result);
        });
        return () => {
            active = false;
        };
    }, []);

    useEffect(() => {
        loadData();
    }, [loadData]);

    const filteredCatalog = useMemo(() => {
        const search = catalogSearch.trim().toLowerCase();
        if (!search) return catalog;
        return catalog.filter(
            (item) =>
                item.name.toLowerCase().includes(search) ||
                (item.code || '').toLowerCase().includes(search)
        );
    }, [catalog, catalogSearch]);

    const selectedItemIds = useMemo(
        () => new Set(lines.map((line) => line.item_id).filter(Boolean) as string[]),
        [lines]
    );

    const toggleCatalogItem = (item: CatalogItem) => {
        setLines((current) => {
            const existing = current.find((line) => line.item_id === item.id);
            if (existing) return current.filter((line) => line.item_id !== item.id);
            return [
                ...current,
                {
                    key: item.id,
                    item_id: item.id,
                    name: item.name,
                    quantity: 1,
                    unit: item.unit || 'pcs',
                    notes: '',
                },
            ];
        });
    };

    const updateLine = (key: string, patch: Partial<DraftLine>) => {
        setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
    };

    const removeLine = (key: string) => {
        setLines((current) => current.filter((line) => line.key !== key));
    };

    const addCustomLine = () => {
        customLineCounter.current += 1;
        setLines((current) => [
            ...current,
            { key: `custom-${customLineCounter.current}`, item_id: null, name: '', quantity: 1, unit: 'pcs', notes: '' },
        ]);
    };

    const resetBuilder = () => {
        setLines([]);
        setNotes('');
        setNeededBy('');
        setCatalogSearch('');
    };

    const handleSubmit = async () => {
        if (!viewer || !labId) return;
        setSubmitting(true);
        setError(null);
        setSuccess(null);
        try {
            const created = await createMaterialRequest({
                labId,
                accountId,
                viewer,
                items: lines,
                notes,
                neededBy: neededBy || undefined,
            });
            setRequests((current) => [created, ...current]);
            resetBuilder();
            setShowBuilder(false);
            setSuccess(`Request ${created.request_number || ''} sent to the lab`.trim());
        } catch (err: any) {
            console.error('Error creating material request:', err);
            setError(err.message || 'Could not send the request');
        } finally {
            setSubmitting(false);
        }
    };

    const handleStatusChange = async (request: MaterialRequest, status: MaterialRequestStatus) => {
        setUpdatingId(request.id);
        setError(null);
        try {
            await updateMaterialRequestStatus({
                id: request.id,
                status,
                remarks: remarksDraft[request.id] ?? request.lab_remarks ?? '',
                handledBy: viewer?.userId || null,
            });
            await loadData();
        } catch (err: any) {
            console.error('Error updating material request:', err);
            setError(err.message || 'Could not update the request');
        } finally {
            setUpdatingId(null);
        }
    };

    const handleCancel = async (request: MaterialRequest) => {
        if (!window.confirm(`Cancel request ${request.request_number || ''}?`)) return;
        setUpdatingId(request.id);
        try {
            await cancelMaterialRequest(request.id);
            await loadData();
        } catch (err: any) {
            setError(err.message || 'Could not cancel the request');
        } finally {
            setUpdatingId(null);
        }
    };

    const validLines = lines.filter((line) => line.name.trim() && Number(line.quantity) > 0);

    return (
        <div className="space-y-4">
            {error && (
                <div className="flex items-start gap-2 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-sm text-red-700">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span className="flex-1">{error}</span>
                    <button type="button" onClick={() => setError(null)}>
                        <X className="h-4 w-4" />
                    </button>
                </div>
            )}
            {success && (
                <div className="flex items-start gap-2 rounded-lg border border-green-100 bg-green-50 px-3 py-2 text-sm text-green-700">
                    <Check className="mt-0.5 h-4 w-4 shrink-0" />
                    <span className="flex-1">{success}</span>
                    <button type="button" onClick={() => setSuccess(null)}>
                        <X className="h-4 w-4" />
                    </button>
                </div>
            )}

            {mode === 'account' && (
                <div className="rounded-lg border border-gray-200 bg-white">
                    <button
                        type="button"
                        onClick={() => setShowBuilder((current) => !current)}
                        className="flex w-full items-center justify-between px-4 py-3 text-left"
                    >
                        <span className="flex items-center gap-2 text-sm font-semibold text-gray-900">
                            <Plus className="h-4 w-4 text-blue-600" />
                            New material request
                        </span>
                        <ChevronDown
                            className={`h-4 w-4 text-gray-400 transition-transform ${showBuilder ? 'rotate-180' : ''}`}
                        />
                    </button>

                    {showBuilder && (
                        <div className="space-y-4 border-t border-gray-100 p-4">
                            {catalog.length === 0 ? (
                                <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
                                    The lab has not published a material catalog yet. You can still add items manually below.
                                </p>
                            ) : (
                                <div>
                                    <div className="relative mb-2">
                                        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                                        <input
                                            type="text"
                                            value={catalogSearch}
                                            onChange={(e) => setCatalogSearch(e.target.value)}
                                            placeholder="Search items..."
                                            className="w-full rounded-lg border border-gray-300 py-2 pl-10 pr-3 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500"
                                        />
                                    </div>
                                    <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-gray-200 p-2">
                                        {filteredCatalog.length === 0 ? (
                                            <p className="py-4 text-center text-sm text-gray-500">No items match your search</p>
                                        ) : (
                                            filteredCatalog.map((item) => {
                                                const selected = selectedItemIds.has(item.id);
                                                return (
                                                    <button
                                                        key={item.id}
                                                        type="button"
                                                        onClick={() => toggleCatalogItem(item)}
                                                        className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                                                            selected ? 'bg-blue-50 text-blue-800' : 'hover:bg-gray-50'
                                                        }`}
                                                    >
                                                        <span className="min-w-0 flex-1 truncate">
                                                            <span className="font-medium">{item.name}</span>
                                                            {item.code && (
                                                                <span className="ml-2 text-xs text-gray-500">{item.code}</span>
                                                            )}
                                                        </span>
                                                        <span className="ml-3 flex items-center gap-2 text-xs text-gray-500">
                                                            {item.unit}
                                                            {selected && <Check className="h-4 w-4 text-blue-600" />}
                                                        </span>
                                                    </button>
                                                );
                                            })
                                        )}
                                    </div>
                                </div>
                            )}

                            <div className="overflow-hidden rounded-lg border border-gray-200">
                                <table className="w-full">
                                    <thead className="border-b border-gray-200 bg-gray-50">
                                        <tr>
                                            <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500">Item</th>
                                            <th className="w-24 px-3 py-2 text-right text-xs font-semibold text-gray-500">Qty</th>
                                            <th className="w-24 px-3 py-2 text-left text-xs font-semibold text-gray-500">Unit</th>
                                            <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500">Note</th>
                                            <th className="w-10 px-3 py-2" />
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {lines.length === 0 ? (
                                            <tr>
                                                <td colSpan={5} className="px-3 py-6 text-center text-sm text-gray-500">
                                                    Pick items from the list above or add a manual line
                                                </td>
                                            </tr>
                                        ) : (
                                            lines.map((line) => (
                                                <tr key={line.key} className="border-b border-gray-100 last:border-0">
                                                    <td className="px-3 py-2">
                                                        <input
                                                            type="text"
                                                            value={line.name}
                                                            onChange={(e) => updateLine(line.key, { name: e.target.value })}
                                                            placeholder="Item name"
                                                            className="w-full rounded border border-gray-200 px-2 py-1 text-sm"
                                                        />
                                                    </td>
                                                    <td className="px-3 py-2">
                                                        <input
                                                            type="number"
                                                            min="0"
                                                            step="1"
                                                            value={line.quantity}
                                                            onChange={(e) =>
                                                                updateLine(line.key, { quantity: Number(e.target.value || 0) })
                                                            }
                                                            className="w-full rounded border border-gray-200 px-2 py-1 text-right text-sm"
                                                        />
                                                    </td>
                                                    <td className="px-3 py-2">
                                                        <input
                                                            type="text"
                                                            value={line.unit || ''}
                                                            onChange={(e) => updateLine(line.key, { unit: e.target.value })}
                                                            className="w-full rounded border border-gray-200 px-2 py-1 text-sm"
                                                        />
                                                    </td>
                                                    <td className="px-3 py-2">
                                                        <input
                                                            type="text"
                                                            value={line.notes || ''}
                                                            onChange={(e) => updateLine(line.key, { notes: e.target.value })}
                                                            placeholder="Optional"
                                                            className="w-full rounded border border-gray-200 px-2 py-1 text-sm"
                                                        />
                                                    </td>
                                                    <td className="px-3 py-2 text-right">
                                                        <button
                                                            type="button"
                                                            onClick={() => removeLine(line.key)}
                                                            className="rounded p-1 hover:bg-red-50"
                                                            aria-label={`Remove ${line.name || 'line'}`}
                                                        >
                                                            <Trash2 className="h-4 w-4 text-red-500" />
                                                        </button>
                                                    </td>
                                                </tr>
                                            ))
                                        )}
                                    </tbody>
                                </table>
                            </div>

                            <button
                                type="button"
                                onClick={addCustomLine}
                                className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm hover:bg-gray-50"
                            >
                                <Plus className="h-4 w-4" />
                                Add manual line
                            </button>

                            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                <div>
                                    <label className="mb-1 block text-xs font-medium text-gray-600">Needed by</label>
                                    <input
                                        type="date"
                                        value={neededBy}
                                        onChange={(e) => setNeededBy(e.target.value)}
                                        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500"
                                    />
                                </div>
                                <div>
                                    <label className="mb-1 block text-xs font-medium text-gray-600">Notes for the lab</label>
                                    <input
                                        type="text"
                                        value={notes}
                                        onChange={(e) => setNotes(e.target.value)}
                                        placeholder="Optional"
                                        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500"
                                    />
                                </div>
                            </div>

                            <div className="flex justify-end gap-3">
                                <button
                                    type="button"
                                    onClick={() => {
                                        resetBuilder();
                                        setShowBuilder(false);
                                    }}
                                    className="rounded-lg border border-gray-200 px-4 py-2 text-sm hover:bg-gray-50"
                                >
                                    Cancel
                                </button>
                                <button
                                    type="button"
                                    onClick={handleSubmit}
                                    disabled={submitting || validLines.length === 0}
                                    className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-300"
                                >
                                    {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                                    Send request ({validLines.length})
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            )}

            <div className="rounded-lg border border-gray-200 bg-white">
                <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
                    <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-900">
                        <Package className="h-4 w-4 text-gray-500" />
                        {mode === 'lab' ? 'Requests from this partner' : 'My requests'}
                        <span className="text-xs font-normal text-gray-500">({requests.length})</span>
                    </h3>
                    <button
                        type="button"
                        onClick={loadData}
                        className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-gray-500 hover:bg-gray-100"
                    >
                        <RefreshCw className="h-3.5 w-3.5" />
                        Refresh
                    </button>
                </div>

                {loading ? (
                    <div className="flex items-center justify-center gap-2 py-10 text-sm text-gray-500">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Loading requests...
                    </div>
                ) : requests.length === 0 ? (
                    <p className="py-10 text-center text-sm text-gray-500">No material requests yet</p>
                ) : (
                    <div className="divide-y divide-gray-100">
                        {requests.map((request) => (
                            <div key={request.id} className="p-4">
                                <div className="flex flex-wrap items-start justify-between gap-3">
                                    <div className="min-w-0">
                                        <div className="flex items-center gap-2">
                                            <span className="font-mono text-sm font-semibold text-gray-900">
                                                {request.request_number || request.id.slice(0, 8)}
                                            </span>
                                            <span
                                                className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[request.status]}`}
                                            >
                                                {MATERIAL_REQUEST_STATUS_LABELS[request.status]}
                                            </span>
                                        </div>
                                        <p className="mt-0.5 text-xs text-gray-500">
                                            Raised {formatDate(request.created_at)}
                                            {request.requested_by_name ? ` by ${request.requested_by_name}` : ''}
                                            {request.needed_by ? ` - needed by ${formatDate(request.needed_by)}` : ''}
                                        </p>
                                    </div>

                                    {mode === 'account' && request.status === 'requested' && (
                                        <button
                                            type="button"
                                            onClick={() => handleCancel(request)}
                                            disabled={updatingId === request.id}
                                            className="inline-flex items-center gap-1.5 rounded-lg bg-red-50 px-2.5 py-1.5 text-xs font-medium text-red-600 hover:bg-red-100 disabled:opacity-50"
                                        >
                                            <Trash2 className="h-3.5 w-3.5" />
                                            Cancel
                                        </button>
                                    )}
                                </div>

                                <ul className="mt-3 space-y-1">
                                    {request.items.map((item, index) => (
                                        <li
                                            key={`${request.id}-${index}`}
                                            className="flex items-center justify-between rounded bg-gray-50 px-3 py-1.5 text-sm"
                                        >
                                            <span className="min-w-0 flex-1 truncate text-gray-800">
                                                {item.name}
                                                {item.notes && <span className="ml-2 text-xs text-gray-500">{item.notes}</span>}
                                            </span>
                                            <span className="ml-3 shrink-0 font-medium text-gray-700">
                                                {item.quantity} {item.unit || ''}
                                            </span>
                                        </li>
                                    ))}
                                </ul>

                                {request.notes && (
                                    <p className="mt-2 text-xs text-gray-600">
                                        <span className="font-medium">Note:</span> {request.notes}
                                    </p>
                                )}
                                {request.lab_remarks && (
                                    <p className="mt-1 text-xs text-blue-700">
                                        <span className="font-medium">Lab remarks:</span> {request.lab_remarks}
                                    </p>
                                )}

                                {mode === 'lab' && !['cancelled', 'delivered', 'rejected'].includes(request.status) && (
                                    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-gray-100 pt-3">
                                        <input
                                            type="text"
                                            value={remarksDraft[request.id] ?? request.lab_remarks ?? ''}
                                            onChange={(e) =>
                                                setRemarksDraft((current) => ({ ...current, [request.id]: e.target.value }))
                                            }
                                            placeholder="Remarks for the partner (optional)"
                                            className="min-w-[200px] flex-1 rounded-lg border border-gray-200 px-3 py-1.5 text-sm"
                                        />
                                        {LAB_NEXT_STATUSES.filter((status) => status !== request.status).map((status) => (
                                            <button
                                                key={status}
                                                type="button"
                                                onClick={() => handleStatusChange(request, status)}
                                                disabled={updatingId === request.id}
                                                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
                                                    status === 'rejected'
                                                        ? 'bg-red-50 text-red-700 hover:bg-red-100'
                                                        : 'bg-blue-50 text-blue-700 hover:bg-blue-100'
                                                }`}
                                            >
                                                {updatingId === request.id ? '...' : `Mark ${MATERIAL_REQUEST_STATUS_LABELS[status]}`}
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};

export default MaterialRequestPanel;
