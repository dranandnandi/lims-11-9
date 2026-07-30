-- ============================================================================
-- Fix order deletion: FK constraints referencing orders(id) left as NO ACTION
-- ============================================================================
-- Deleting an order failed with 23503 "Key is still referenced from table
-- analyzer_comm_log". Sixteen FKs on orders(id) were created without an
-- ON DELETE action, so each one blocks deletion in turn.
--
-- Two policies applied:
--   CASCADE  - rows that belong to the order and are meaningless without it
--   SET NULL - audit / financial / cross-entity rows that must survive the
--              order being deleted (matches the existing treatment of
--              invoices, invoice_items, analyzer_order_queue, print_jobs)
--
-- Deliberately NOT changed: consolidated_invoice_items.order_id. It is NOT NULL
-- and represents a line on an issued billing document, so it must keep blocking
-- deletion of an order that has already been consolidated-invoiced.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- CASCADE: order-owned operational data
-- ---------------------------------------------------------------------------

ALTER TABLE public.result_values
  DROP CONSTRAINT IF EXISTS result_values_order_id_fkey,
  ADD CONSTRAINT result_values_order_id_fkey
    FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;

ALTER TABLE public.reports
  DROP CONSTRAINT IF EXISTS reports_order_id_fkey,
  ADD CONSTRAINT reports_order_id_fkey
    FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;

ALTER TABLE public.outsourced_reports
  DROP CONSTRAINT IF EXISTS outsourced_reports_order_id_fkey,
  ADD CONSTRAINT outsourced_reports_order_id_fkey
    FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;

ALTER TABLE public.workflow_results
  DROP CONSTRAINT IF EXISTS workflow_results_order_id_fkey,
  ADD CONSTRAINT workflow_results_order_id_fkey
    FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;

ALTER TABLE public.sample_transits
  DROP CONSTRAINT IF EXISTS sample_transits_order_id_fkey,
  ADD CONSTRAINT sample_transits_order_id_fkey
    FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;

ALTER TABLE public.attachment_batches
  DROP CONSTRAINT IF EXISTS attachment_batches_order_id_fkey,
  ADD CONSTRAINT attachment_batches_order_id_fkey
    FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;

ALTER TABLE public.ai_protocol_sessions
  DROP CONSTRAINT IF EXISTS ai_protocol_sessions_order_id_fkey,
  ADD CONSTRAINT ai_protocol_sessions_order_id_fkey
    FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- SET NULL: audit trails, financial records, cross-entity links
-- ---------------------------------------------------------------------------

-- The constraint that triggered the reported 409.
ALTER TABLE public.analyzer_comm_log
  DROP CONSTRAINT IF EXISTS analyzer_comm_log_order_id_fkey,
  ADD CONSTRAINT analyzer_comm_log_order_id_fkey
    FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE SET NULL;

ALTER TABLE public.analyzer_raw_messages
  DROP CONSTRAINT IF EXISTS analyzer_raw_messages_order_id_fkey,
  ADD CONSTRAINT analyzer_raw_messages_order_id_fkey
    FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE SET NULL;

ALTER TABLE public.inventory_transactions
  DROP CONSTRAINT IF EXISTS inventory_transactions_order_id_fkey,
  ADD CONSTRAINT inventory_transactions_order_id_fkey
    FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE SET NULL;

ALTER TABLE public.refund_requests
  DROP CONSTRAINT IF EXISTS refund_requests_order_id_fkey,
  ADD CONSTRAINT refund_requests_order_id_fkey
    FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE SET NULL;

ALTER TABLE public.bookings
  DROP CONSTRAINT IF EXISTS bookings_converted_order_id_fkey,
  ADD CONSTRAINT bookings_converted_order_id_fkey
    FOREIGN KEY (converted_order_id) REFERENCES public.orders(id) ON DELETE SET NULL;

ALTER TABLE public.b2b_pending_orders
  DROP CONSTRAINT IF EXISTS b2b_pending_orders_created_order_id_fkey,
  ADD CONSTRAINT b2b_pending_orders_created_order_id_fkey
    FOREIGN KEY (created_order_id) REFERENCES public.orders(id) ON DELETE SET NULL;

ALTER TABLE public.b2b_payment_attempts
  DROP CONSTRAINT IF EXISTS b2b_payment_attempts_pending_order_id_fkey,
  ADD CONSTRAINT b2b_payment_attempts_pending_order_id_fkey
    FOREIGN KEY (pending_order_id) REFERENCES public.orders(id) ON DELETE SET NULL;

-- Self-reference: re-run / child orders keep existing when the parent is deleted.
ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_parent_order_id_fkey,
  ADD CONSTRAINT orders_parent_order_id_fkey
    FOREIGN KEY (parent_order_id) REFERENCES public.orders(id) ON DELETE SET NULL;
