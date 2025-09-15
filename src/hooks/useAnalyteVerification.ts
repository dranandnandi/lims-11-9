import { useEffect, useMemo, useState } from "react";
import { supabase } from "../utils/supabase";

export type AnalyteRow = {
  rv_id: string;
  result_id: string;
  order_id: string;
  test_group_id: string | null;
  test_name: string;
  parameter: string;
  value: string | null;
  unit: string;
  reference_range: string;
  flag: string | null;
  verify_status: "pending" | "approved" | "rejected";
  verify_note: string | null;
  verified_by: string | null;
  verified_at: string | null;
  patient_name: string;
  patient_id: string;
  order_date: string;
};

export function useAnalyteVerification(opts: { fromISO: string; toISO: string; q?: string }) {
  const { fromISO, toISO, q = "" } = opts;
  const [rows, setRows] = useState<AnalyteRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setErr(null);
    // Pull analytes with parent context
    const { data, error } = await supabase
      .from("result_values")
      .select(`
        id, result_id, parameter, value, unit, reference_range, flag, verify_status, verify_note, verified_by, verified_at,
        results!inner (
          id, order_id, test_group_id, test_name,
          patient_id, patient_name, entered_date
        )
      `)
      .gte("results.entered_date", fromISO)
      .lte("results.entered_date", toISO);
    if (error) { setErr(error.message); setLoading(false); return; }

    const mapped: AnalyteRow[] = (data || []).map((rv: any) => ({
      rv_id: rv.id,
      result_id: rv.result_id,
      order_id: rv.results.order_id,
      test_group_id: rv.results.test_group_id,
      test_name: rv.results.test_name,
      parameter: rv.parameter,
      value: rv.value,
      unit: rv.unit,
      reference_range: rv.reference_range,
      flag: rv.flag,
      verify_status: rv.verify_status,
      verify_note: rv.verify_note,
      verified_by: rv.verified_by,
      verified_at: rv.verified_at,
      patient_name: rv.results.patient_name,
      patient_id: rv.results.patient_id,
      order_date: rv.results.entered_date
    }));

    const fq = q.trim().toLowerCase();
    setRows(
      fq
        ? mapped.filter(r =>
            r.test_name.toLowerCase().includes(fq) ||
            r.parameter.toLowerCase().includes(fq) ||
            r.patient_name.toLowerCase().includes(fq) ||
            (r.order_id || "").toLowerCase().includes(fq)
          )
        : mapped
    );
    setLoading(false);
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [fromISO, toISO, q]);

  const approve = async (rv_id: string, note?: string) => {
    const { error } = await supabase
      .from("result_values")
      .update({ verify_status: "approved", verify_note: note ?? null, verified_at: new Date().toISOString() })
      .eq("id", rv_id);
    if (!error) await load();
    return !error;
  };

  const reject = async (rv_id: string, note: string) => {
    const { error } = await supabase
      .from("result_values")
      .update({ verify_status: "rejected", verify_note: note, verified_at: new Date().toISOString() })
      .eq("id", rv_id);
    if (!error) await load();
    return !error;
  };

  const bulkApprove = async (ids: string[], note?: string) => {
    const { error } = await supabase
      .from("result_values")
      .update({ verify_status: "approved", verify_note: note ?? null, verified_at: new Date().toISOString() })
      .in("id", ids);
    if (!error) await load();
    return !error;
  };

  return { rows, loading, err, approve, reject, bulkApprove, refresh: load };
}
