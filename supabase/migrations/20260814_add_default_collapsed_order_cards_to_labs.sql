-- Lab-wide default for how the dashboard Test Orders list opens.
-- Staff can still toggle Collapse/Expand on the page; this only sets the landing state.
ALTER TABLE public.labs
  ADD COLUMN IF NOT EXISTS default_collapsed_order_cards boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.labs.default_collapsed_order_cards IS
  'When true, the dashboard order list opens in collapsed (one compact row per order) view.';
