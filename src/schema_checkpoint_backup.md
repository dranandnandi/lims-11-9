<!-- CHECKPOINT BACKUP - Created before implementing workflow security changes -->
<!-- Date: Current timestamp -->
<!-- Purpose: Backup of existing schema before adding workflow security, audit trails, and result locking -->

-- WARNING: This schema is for context only and is not meant to be run.
-- Table order and constraints may not be valid for execution.

CREATE TABLE public.ai_captures (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  session_id uuid,
  step_id uuid,
  capture_type character varying NOT NULL,
  file_path character varying,
  file_size_bytes bigint,
  mime_type character varying,
  capture_metadata jsonb DEFAULT '{}'::jsonb,
  analysis_status character varying DEFAULT 'pending'::character varying,
  analysis_results jsonb DEFAULT '{}'::jsonb,
  confidence_score numeric,
  processed_at timestamp with time zone,
  processing_duration_ms integer,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT ai_captures_pkey PRIMARY KEY (id),
  CONSTRAINT ai_captures_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.ai_protocol_sessions(id),
  CONSTRAINT ai_captures_step_id_fkey FOREIGN KEY (step_id) REFERENCES public.ai_protocol_steps(id)
);
CREATE TABLE public.ai_prompts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  test_id uuid,
  analyte_id uuid,
  lab_id uuid,
  ai_processing_type character varying NOT NULL,
  prompt text NOT NULL,
  default boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT ai_prompts_pkey PRIMARY KEY (id),
  CONSTRAINT fk_ai_prompts_test_group FOREIGN KEY (test_id) REFERENCES public.test_groups(id),
  CONSTRAINT fk_ai_prompts_lab FOREIGN KEY (lab_id) REFERENCES public.labs(id),
  CONSTRAINT fk_ai_prompts_analyte FOREIGN KEY (analyte_id) REFERENCES public.analytes(id)
);
CREATE TABLE public.ai_protocol_sessions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  protocol_id uuid,
  order_id uuid,
  patient_id uuid,
  test_id uuid,
  status character varying DEFAULT 'started'::character varying,
  current_step_id uuid,
  current_step_order integer DEFAULT 1,
  session_data jsonb DEFAULT '{}'::jsonb,
  results jsonb DEFAULT '{}'::jsonb,
  started_at timestamp with time zone DEFAULT now(),
  completed_at timestamp with time zone,
  duration_seconds integer,
  user_id uuid,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT ai_protocol_sessions_pkey PRIMARY KEY (id),
  CONSTRAINT ai_protocol_sessions_protocol_id_fkey FOREIGN KEY (protocol_id) REFERENCES public.ai_protocols(id),
  CONSTRAINT ai_protocol_sessions_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id),
  CONSTRAINT ai_protocol_sessions_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id),
  CONSTRAINT ai_protocol_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id),
  CONSTRAINT ai_protocol_sessions_current_step_id_fkey FOREIGN KEY (current_step_id) REFERENCES public.ai_protocol_steps(id)
);
CREATE TABLE public.ai_protocol_steps (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  protocol_id uuid,
  step_order integer NOT NULL,
  step_type character varying NOT NULL,
  title character varying NOT NULL,
  description text,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_required boolean DEFAULT true,
  validation_rules jsonb DEFAULT '{}'::jsonb,
  estimated_duration_seconds integer,
  max_duration_seconds integer,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT ai_protocol_steps_pkey PRIMARY KEY (id),
  CONSTRAINT ai_protocol_steps_protocol_id_fkey FOREIGN KEY (protocol_id) REFERENCES public.ai_protocols(id)
);
CREATE TABLE public.ai_protocols (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name character varying NOT NULL,
  description text,
  category character varying NOT NULL,
  version character varying DEFAULT '1.0'::character varying,
  is_active boolean DEFAULT true,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  requires_lims_integration boolean DEFAULT false,
  target_table character varying,
  result_mapping jsonb DEFAULT '{}'::jsonb,
  ui_config jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now(),
  updated_by uuid,
  CONSTRAINT ai_protocols_pkey PRIMARY KEY (id),
  CONSTRAINT ai_protocols_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id),
  CONSTRAINT ai_protocols_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth.users(id)
);
CREATE TABLE public.ai_usage_logs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid,
  lab_id uuid,
  processing_type character varying NOT NULL,
  input_data jsonb,
  confidence numeric,
  tokens_used integer,
  processing_time_ms integer,
  error_message text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT ai_usage_logs_pkey PRIMARY KEY (id),
  CONSTRAINT ai_usage_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id),
  CONSTRAINT ai_usage_logs_lab_id_fkey FOREIGN KEY (lab_id) REFERENCES public.labs(id)
);

-- Continue with rest of existing schema...
-- [Additional tables would be here in full implementation]