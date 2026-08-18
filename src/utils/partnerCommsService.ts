import { supabase } from './supabase';

/**
 * Partner (franchise / B2B account) communication services.
 *
 * Backs two features shared by the lab side (Account Master > Partner Desk) and
 * the client side (B2B portal):
 *   1. a two-way chat thread per account, with file attachments
 *   2. material requests raised by the partner against the lab's catalog
 *
 * Both sides call the same functions; RLS decides what is visible.
 */

export const PARTNER_CHAT_BUCKET = 'partner-chat';

export type PartnerSide = 'lab' | 'account';

export interface MessageAttachment {
    path: string;
    name: string;
    size?: number;
    mime?: string;
}

export interface AccountMessage {
    id: string;
    lab_id: string;
    account_id: string;
    sender_type: PartnerSide;
    sender_user_id?: string | null;
    sender_name?: string | null;
    body?: string | null;
    attachments: MessageAttachment[];
    read_by_lab_at?: string | null;
    read_by_account_at?: string | null;
    created_at: string;
}

export type MaterialRequestStatus =
    | 'requested'
    | 'approved'
    | 'dispatched'
    | 'delivered'
    | 'rejected'
    | 'cancelled';

export interface MaterialRequestItem {
    item_id?: string | null;
    name: string;
    quantity: number;
    unit?: string | null;
    notes?: string | null;
}

export interface MaterialRequest {
    id: string;
    lab_id: string;
    account_id: string;
    request_number?: string | null;
    status: MaterialRequestStatus;
    items: MaterialRequestItem[];
    notes?: string | null;
    needed_by?: string | null;
    requested_by_name?: string | null;
    requested_by_user_id?: string | null;
    lab_remarks?: string | null;
    handled_by?: string | null;
    handled_at?: string | null;
    created_at: string;
    updated_at: string;
    account?: { id: string; name: string; code: string | null } | null;
}

export interface CatalogItem {
    id: string;
    name: string;
    code?: string | null;
    unit: string;
    type?: string | null;
}

export const MATERIAL_REQUEST_STATUS_LABELS: Record<MaterialRequestStatus, string> = {
    requested: 'Requested',
    approved: 'Approved',
    dispatched: 'Dispatched',
    delivered: 'Delivered',
    rejected: 'Rejected',
    cancelled: 'Cancelled',
};

const normalizeAttachments = (raw: any): MessageAttachment[] => {
    if (!Array.isArray(raw)) return [];
    return raw
        .map((entry: any) => ({
            path: String(entry?.path || '').trim(),
            name: String(entry?.name || 'attachment').trim(),
            size: Number.isFinite(Number(entry?.size)) ? Number(entry.size) : undefined,
            mime: entry?.mime ? String(entry.mime) : undefined,
        }))
        .filter((entry) => entry.path);
};

const normalizeMessage = (row: any): AccountMessage => ({
    ...row,
    attachments: normalizeAttachments(row?.attachments),
});

const normalizeItems = (raw: any): MaterialRequestItem[] => {
    if (!Array.isArray(raw)) return [];
    return raw
        .map((entry: any) => ({
            item_id: entry?.item_id || null,
            name: String(entry?.name || '').trim(),
            quantity: Number(entry?.quantity) || 0,
            unit: entry?.unit ? String(entry.unit) : null,
            notes: entry?.notes ? String(entry.notes) : null,
        }))
        .filter((entry) => entry.name);
};

const normalizeRequest = (row: any): MaterialRequest => ({
    ...row,
    items: normalizeItems(row?.items),
});

/** Identity of whoever is currently signed in, from either app. */
export interface PartnerViewer {
    side: PartnerSide;
    userId: string | null;
    displayName: string;
    labId: string | null;
    accountId: string | null;
}

export async function getPartnerViewer(): Promise<PartnerViewer | null> {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return null;

    const metadata = user.user_metadata || {};

    if (metadata.role === 'b2b_account') {
        return {
            side: 'account',
            userId: user.id,
            displayName: metadata.account_name || metadata.name || user.email || 'Partner',
            labId: metadata.lab_id || null,
            accountId: metadata.account_id || null,
        };
    }

    const { data: staff } = await supabase
        .from('users')
        .select('name, email, lab_id')
        .eq('id', user.id)
        .maybeSingle();

    return {
        side: 'lab',
        userId: user.id,
        displayName: staff?.name || staff?.email || user.email || 'Lab',
        labId: staff?.lab_id || null,
        accountId: null,
    };
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export async function fetchAccountMessages(accountId: string, limit = 200): Promise<AccountMessage[]> {
    const { data, error } = await supabase
        .from('account_messages')
        .select('*')
        .eq('account_id', accountId)
        .order('created_at', { ascending: false })
        .limit(limit);

    if (error) throw error;
    // Newest first from the DB (so the limit keeps the latest), oldest first for display
    return (data || []).map(normalizeMessage).reverse();
}

/**
 * Uploads one chat attachment into the private partner-chat bucket and returns
 * the stored path. Storage policies keep partners inside their own folder.
 */
export async function uploadChatAttachment(accountId: string, file: File): Promise<MessageAttachment> {
    const safeName = file.name.replace(/[^\w.\-]+/g, '_').slice(-120);
    const path = `accounts/${accountId}/${Date.now()}-${safeName}`;

    const { error } = await supabase.storage
        .from(PARTNER_CHAT_BUCKET)
        .upload(path, file, { cacheControl: '3600', upsert: false });

    if (error) throw error;

    return {
        path,
        name: file.name,
        size: file.size,
        mime: file.type || undefined,
    };
}

/** Signed URL for a private attachment; valid for an hour. */
export async function getAttachmentUrl(path: string): Promise<string | null> {
    const { data, error } = await supabase.storage
        .from(PARTNER_CHAT_BUCKET)
        .createSignedUrl(path, 3600);

    if (error) {
        console.error('Could not sign attachment URL:', error);
        return null;
    }
    return data?.signedUrl || null;
}

export async function sendAccountMessage(params: {
    labId: string;
    accountId: string;
    viewer: PartnerViewer;
    body: string;
    attachments?: MessageAttachment[];
}): Promise<AccountMessage> {
    const attachments = params.attachments || [];
    const body = params.body.trim();

    if (!body && attachments.length === 0) {
        throw new Error('Type a message or attach a file');
    }

    const { data, error } = await supabase
        .from('account_messages')
        .insert({
            lab_id: params.labId,
            account_id: params.accountId,
            sender_type: params.viewer.side,
            sender_user_id: params.viewer.userId,
            sender_name: params.viewer.displayName,
            body: body || null,
            attachments,
        })
        .select('*')
        .single();

    if (error) throw error;
    return normalizeMessage(data);
}

/** Marks the other side's messages in this thread as read for the caller. */
export async function markThreadRead(accountId: string): Promise<void> {
    const { error } = await supabase.rpc('mark_account_thread_read', { p_account_id: accountId });
    if (error) console.warn('Could not mark thread as read:', error.message);
}

export function isUnreadFor(message: AccountMessage, side: PartnerSide): boolean {
    if (message.sender_type === side) return false;
    return side === 'lab' ? !message.read_by_lab_at : !message.read_by_account_at;
}

/** Per-account unread counts for the lab side inbox badges. */
export async function fetchLabUnreadCounts(labId: string): Promise<Record<string, number>> {
    const { data, error } = await supabase
        .from('account_messages')
        .select('account_id')
        .eq('lab_id', labId)
        .eq('sender_type', 'account')
        .is('read_by_lab_at', null);

    if (error) {
        console.warn('Could not load unread message counts:', error.message);
        return {};
    }

    return (data || []).reduce<Record<string, number>>((counts, row: any) => {
        counts[row.account_id] = (counts[row.account_id] || 0) + 1;
        return counts;
    }, {});
}

export async function fetchAccountUnreadCount(accountId: string): Promise<number> {
    const { count, error } = await supabase
        .from('account_messages')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', accountId)
        .eq('sender_type', 'lab')
        .is('read_by_account_at', null);

    if (error) {
        console.warn('Could not load unread message count:', error.message);
        return 0;
    }
    return count || 0;
}

/** One row of the lab-side unified partner inbox. */
export interface PartnerThreadSummary {
    accountId: string;
    lastMessageAt: string | null;
    lastMessagePreview: string;
    lastMessageFrom: PartnerSide | null;
    unreadCount: number;
}

const previewOf = (row: any): string => {
    const body = String(row?.body || '').trim();
    if (body) return body.replace(/\s+/g, ' ').slice(0, 140);
    const attachments = normalizeAttachments(row?.attachments);
    if (attachments.length === 1) return attachments[0].name;
    if (attachments.length > 1) return `${attachments.length} attachments`;
    return '';
};

/**
 * Last message + unread count per account, for the unified inbox in Account
 * Master. The preview comes from a recent window of messages (enough to cover
 * every account that has talked lately); unread counts come from the exact
 * count query so a long backlog is never under-reported.
 */
export async function fetchLabThreadSummaries(
    labId: string,
    recentWindow = 500
): Promise<Record<string, PartnerThreadSummary>> {
    const [recent, unreadCounts] = await Promise.all([
        supabase
            .from('account_messages')
            .select('account_id, sender_type, body, attachments, created_at')
            .eq('lab_id', labId)
            .order('created_at', { ascending: false })
            .limit(recentWindow),
        fetchLabUnreadCounts(labId),
    ]);

    if (recent.error) {
        console.warn('Could not load partner threads:', recent.error.message);
    }

    const summaries: Record<string, PartnerThreadSummary> = {};

    // Newest first, so the first row seen for an account is its latest message
    (recent.data || []).forEach((row: any) => {
        if (summaries[row.account_id]) return;
        summaries[row.account_id] = {
            accountId: row.account_id,
            lastMessageAt: row.created_at,
            lastMessagePreview: previewOf(row),
            lastMessageFrom: row.sender_type === 'account' ? 'account' : 'lab',
            unreadCount: unreadCounts[row.account_id] || 0,
        };
    });

    // An account whose only unread messages fall outside the window still belongs in the inbox
    Object.entries(unreadCounts).forEach(([accountId, count]) => {
        if (summaries[accountId]) return;
        summaries[accountId] = {
            accountId,
            lastMessageAt: null,
            lastMessagePreview: '',
            lastMessageFrom: 'account',
            unreadCount: count,
        };
    });

    return summaries;
}

/** Live updates for one thread. Returns an unsubscribe function. */
export function subscribeToAccountThread(accountId: string, onChange: () => void): () => void {
    const channel = supabase
        .channel(`account-messages-${accountId}`)
        .on(
            'postgres_changes',
            {
                event: '*',
                schema: 'public',
                table: 'account_messages',
                filter: `account_id=eq.${accountId}`,
            },
            () => onChange()
        )
        .subscribe();

    return () => {
        supabase.removeChannel(channel);
    };
}

// Two screens can watch the same lab at once (the inbox on top of Account
// Master), and one socket cannot join the same topic twice
let labActivityChannelSeq = 0;

/**
 * Live updates across every partner thread and material request of a lab, for
 * the unified inbox badges. Returns an unsubscribe function.
 */
export function subscribeToLabPartnerActivity(labId: string, onChange: () => void): () => void {
    labActivityChannelSeq += 1;
    const channel = supabase
        .channel(`lab-partner-activity-${labId}-${labActivityChannelSeq}`)
        .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'account_messages', filter: `lab_id=eq.${labId}` },
            () => onChange()
        )
        .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'account_material_requests', filter: `lab_id=eq.${labId}` },
            () => onChange()
        )
        .subscribe();

    return () => {
        supabase.removeChannel(channel);
    };
}

// ---------------------------------------------------------------------------
// Material requests
// ---------------------------------------------------------------------------

/**
 * Catalog offered to partners. Labs curate it with the "partner orderable" flag
 * on inventory items; when nothing is flagged yet the lab side falls back to its
 * consumables so the feature is usable straight away.
 */
export async function fetchPartnerCatalog(labId: string, options?: { allowFallback?: boolean }): Promise<CatalogItem[]> {
    const { data, error } = await supabase
        .from('inventory_items')
        .select('id, name, code, unit, type')
        .eq('lab_id', labId)
        .eq('is_active', true)
        .eq('is_partner_orderable', true)
        .order('name');

    if (error) throw error;
    if ((data || []).length > 0 || options?.allowFallback === false) return data || [];

    const { data: fallback, error: fallbackError } = await supabase
        .from('inventory_items')
        .select('id, name, code, unit, type')
        .eq('lab_id', labId)
        .eq('is_active', true)
        .in('type', ['consumable', 'general'])
        .order('name')
        .limit(200);

    // Portal users cannot read unflagged items — an empty list here is expected
    if (fallbackError) return [];
    return fallback || [];
}

export async function fetchMaterialRequests(params: {
    accountId?: string;
    labId?: string;
    limit?: number;
}): Promise<MaterialRequest[]> {
    let query = supabase
        .from('account_material_requests')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(params.limit || 50);

    if (params.accountId) query = query.eq('account_id', params.accountId);
    if (params.labId) query = query.eq('lab_id', params.labId);

    const { data, error } = await query;
    if (error) throw error;
    return (data || []).map(normalizeRequest);
}

export async function createMaterialRequest(params: {
    labId: string;
    accountId: string;
    viewer: PartnerViewer;
    items: MaterialRequestItem[];
    notes?: string;
    neededBy?: string;
}): Promise<MaterialRequest> {
    const items = params.items
        .map((item) => ({
            item_id: item.item_id || null,
            name: item.name.trim(),
            quantity: Number(item.quantity) || 0,
            unit: item.unit || null,
            notes: item.notes?.trim() || null,
        }))
        .filter((item) => item.name && item.quantity > 0);

    if (items.length === 0) {
        throw new Error('Add at least one item with a quantity');
    }

    const { data, error } = await supabase
        .from('account_material_requests')
        .insert({
            lab_id: params.labId,
            account_id: params.accountId,
            status: 'requested',
            items,
            notes: params.notes?.trim() || null,
            needed_by: params.neededBy || null,
            requested_by_name: params.viewer.displayName,
            requested_by_user_id: params.viewer.userId,
        })
        .select('*')
        .single();

    if (error) throw error;
    return normalizeRequest(data);
}

export async function updateMaterialRequestStatus(params: {
    id: string;
    status: MaterialRequestStatus;
    remarks?: string;
    handledBy?: string | null;
}): Promise<void> {
    const payload: Record<string, any> = { status: params.status };
    if (params.remarks !== undefined) payload.lab_remarks = params.remarks.trim() || null;
    if (params.handledBy !== undefined) payload.handled_by = params.handledBy;

    const { error } = await supabase
        .from('account_material_requests')
        .update(payload)
        .eq('id', params.id);

    if (error) throw error;
}

export async function cancelMaterialRequest(id: string): Promise<void> {
    const { error } = await supabase
        .from('account_material_requests')
        .update({ status: 'cancelled' })
        .eq('id', id);

    if (error) throw error;
}

export async function fetchOpenMaterialRequestCounts(labId: string): Promise<Record<string, number>> {
    const { data, error } = await supabase
        .from('account_material_requests')
        .select('account_id')
        .eq('lab_id', labId)
        .eq('status', 'requested');

    if (error) {
        console.warn('Could not load open material request counts:', error.message);
        return {};
    }

    return (data || []).reduce<Record<string, number>>((counts, row: any) => {
        counts[row.account_id] = (counts[row.account_id] || 0) + 1;
        return counts;
    }, {});
}
