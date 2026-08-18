-- Add analyzer_name to analyzer_raw_messages
-- 2026-08-11
--
-- Purpose: tell at a glance WHICH machine each raw message came from, so a
-- machine that has stopped sending results can be spotted without joining
-- analyzer_connections (and without guessing from raw_content).
--
-- The name is captured at insert time and denormalised on purpose: it is a
-- snapshot of what the machine was called when the message arrived. Renaming a
-- connection later does not rewrite history.

ALTER TABLE public.analyzer_raw_messages
  ADD COLUMN IF NOT EXISTS analyzer_name text;

COMMENT ON COLUMN public.analyzer_raw_messages.analyzer_name IS
  'Machine label captured at insert: analyzer_connections.name when the message carries a connection id, else the sending application parsed from HL7 MSH-3/MSH-4 or the ASTM H record. "Unknown" when neither is available.';


-- Helper: pull the sending application / analyzer name out of a raw message.
-- Handles HL7 v2 (MSH) and ASTM E1394 (H record); returns NULL if neither parses.
CREATE OR REPLACE FUNCTION public.analyzer_message_sender_name(p_raw text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $fn$
DECLARE
  v_clean  text;
  v_line   text;
  v_fields text[];
  v_name   text;
BEGIN
  IF p_raw IS NULL OR btrim(p_raw) = '' THEN
    RETURN NULL;
  END IF;

  -- Strip MLLP / ASTM framing control characters so segment lines start cleanly.
  v_clean := regexp_replace(p_raw, '[\x02\x03\x04\x05\x06\x0b\x0c\x17\x1c]', '', 'g');

  -- HL7 v2:  MSH|^~\&|<sending app>|<sending facility>|...
  v_line := (regexp_match(v_clean, '(^|[\r\n])(MSH\|[^\r\n]*)'))[2];
  IF v_line IS NOT NULL THEN
    v_fields := string_to_array(v_line, '|');
    v_name := NULLIF(btrim(COALESCE(v_fields[3], '')), '');
    IF v_name IS NULL THEN
      v_name := NULLIF(btrim(COALESCE(v_fields[4], '')), '');
    END IF;
  ELSE
    -- ASTM E1394:  H|\^&|||<sender name>^<version>|...
    v_line := (regexp_match(v_clean, '(^|[\r\n])[0-9]?(H\|[^\r\n]*)'))[2];
    IF v_line IS NOT NULL THEN
      v_fields := string_to_array(v_line, '|');
      v_name := NULLIF(btrim(COALESCE(v_fields[5], '')), '');
      IF v_name IS NULL THEN
        v_name := NULLIF(btrim(COALESCE(v_fields[4], '')), '');
      END IF;
    END IF;
  END IF;

  IF v_name IS NULL THEN
    RETURN NULL;
  END IF;

  -- Keep the first component only: "Maglumi X8^1.0" -> "Maglumi X8".
  RETURN NULLIF(btrim(split_part(v_name, '^', 1)), '');
END;
$fn$;


CREATE OR REPLACE FUNCTION public.set_analyzer_raw_message_name()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_name text;
BEGIN
  IF NEW.analyzer_connection_id IS NOT NULL THEN
    SELECT c.name INTO v_name
    FROM public.analyzer_connections c
    WHERE c.id = NEW.analyzer_connection_id;
  END IF;

  IF NULLIF(btrim(COALESCE(v_name, '')), '') IS NULL THEN
    v_name := public.analyzer_message_sender_name(NEW.raw_content);
  END IF;

  NEW.analyzer_name := COALESCE(NULLIF(btrim(COALESCE(v_name, '')), ''), 'Unknown');
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_analyzer_raw_messages_name ON public.analyzer_raw_messages;
CREATE TRIGGER trg_analyzer_raw_messages_name
  BEFORE INSERT OR UPDATE OF analyzer_connection_id, raw_content
  ON public.analyzer_raw_messages
  FOR EACH ROW
  EXECUTE FUNCTION public.set_analyzer_raw_message_name();


-- Backfill existing rows (run in batches by the deploy script for large tables).
UPDATE public.analyzer_raw_messages m
SET analyzer_name = COALESCE(
      NULLIF(btrim((SELECT c.name
                    FROM public.analyzer_connections c
                    WHERE c.id = m.analyzer_connection_id)), ''),
      public.analyzer_message_sender_name(m.raw_content),
      'Unknown')
WHERE m.analyzer_name IS NULL;


CREATE INDEX IF NOT EXISTS idx_analyzer_msg_name_created
  ON public.analyzer_raw_messages (lab_id, analyzer_name, created_at DESC);


-- "Which machine has gone quiet?" - one row per analyzer, matched by connection
-- and by the name seen on the wire, so a bridge that posts without an
-- analyzer_connection_id still shows up instead of looking dead.
DROP VIEW IF EXISTS public.v_analyzer_message_health;
CREATE VIEW public.v_analyzer_message_health
WITH (security_invoker = on) AS
WITH msg AS (
  SELECT
    lab_id,
    COALESCE(NULLIF(btrim(analyzer_name), ''), 'Unknown') AS analyzer_name,
    max(created_at)                                                              AS last_message_at,
    count(*) FILTER (WHERE created_at > now() - interval '1 hour')                AS messages_1h,
    count(*) FILTER (WHERE created_at > now() - interval '24 hours')              AS messages_24h,
    count(*) FILTER (WHERE created_at > now() - interval '24 hours'
                       AND ai_status IN ('failed', 'review_needed'))              AS problem_24h
  FROM public.analyzer_raw_messages
  WHERE direction = 'INBOUND'
  GROUP BY 1, 2
)
SELECT
  COALESCE(c.lab_id, msg.lab_id)          AS lab_id,
  COALESCE(c.name, msg.analyzer_name)     AS analyzer_name,
  c.id                                    AS analyzer_connection_id,
  c.status                                AS connection_status,
  msg.last_message_at,
  now() - msg.last_message_at             AS silent_for,
  COALESCE(msg.messages_1h, 0)            AS messages_1h,
  COALESCE(msg.messages_24h, 0)           AS messages_24h,
  COALESCE(msg.problem_24h, 0)            AS problem_24h
FROM public.analyzer_connections c
FULL JOIN msg
  ON msg.lab_id = c.lab_id
 AND msg.analyzer_name = c.name;

COMMENT ON VIEW public.v_analyzer_message_health IS
  'Per-analyzer inbound message health: last message time, how long it has been silent, and 1h/24h volumes. NULL last_message_at = configured machine that has never sent.';
