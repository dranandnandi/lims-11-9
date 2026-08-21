-- Per-location WhatsApp sender accounts.
--
-- Until now a lab had exactly one WhatsApp sender: labs.whatsapp_user_id, set
-- from Settings -> Lab Settings -> "WhatsApp Sender Account". Labs running
-- several branches want each branch to message patients from its own number.
--
-- The WhatsApp backend already keys sessions by LIMS users.id (see the
-- sync-user-to-whatsapp edge function, which posts `id: user.id`), so multiple
-- connected numbers per lab already work. Only the routing was missing.
--
-- NULL on a location means "inherit the lab default", so existing labs keep
-- their current behaviour with no backfill.

ALTER TABLE public.locations
  ADD COLUMN IF NOT EXISTS whatsapp_user_id uuid,
  ADD COLUMN IF NOT EXISTS whatsapp_country_code varchar(8);

COMMENT ON COLUMN public.locations.whatsapp_user_id IS
  'LIMS users.id whose connected WhatsApp session sends for this location. NULL = inherit labs.whatsapp_user_id.';
COMMENT ON COLUMN public.locations.whatsapp_country_code IS
  'Dialling code used to format recipient numbers for this location. NULL = inherit labs.country_code.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'locations_whatsapp_user_id_fkey'
  ) THEN
    ALTER TABLE public.locations
      ADD CONSTRAINT locations_whatsapp_user_id_fkey
      FOREIGN KEY (whatsapp_user_id) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_locations_whatsapp_user_id
  ON public.locations(whatsapp_user_id)
  WHERE whatsapp_user_id IS NOT NULL;

-- notification_queue is drained asynchronously by process-notification-queue,
-- which only had lab_id to work with. Without the originating location the
-- worker cannot know which branch's number should send.
ALTER TABLE public.notification_queue
  ADD COLUMN IF NOT EXISTS location_id uuid;

COMMENT ON COLUMN public.notification_queue.location_id IS
  'Location this notification originated from; picks the branch WhatsApp sender at drain time. NULL = lab default.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'notification_queue_location_id_fkey'
  ) THEN
    ALTER TABLE public.notification_queue
      ADD CONSTRAINT notification_queue_location_id_fkey
      FOREIGN KEY (location_id) REFERENCES public.locations(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_notification_queue_location_id
  ON public.notification_queue(location_id)
  WHERE location_id IS NOT NULL;

-- Backfill pending/failed rows from their order so nothing already queued is
-- stranded on the lab default once branch senders are configured.
UPDATE public.notification_queue nq
SET location_id = o.location_id
FROM public.orders o
WHERE nq.order_id = o.id
  AND nq.location_id IS NULL
  AND o.location_id IS NOT NULL
  AND nq.status IN ('pending', 'failed');
